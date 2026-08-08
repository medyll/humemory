/**
 * Embedders — Phase 7.1.
 *
 * The test seam (same pattern as `LLMClient`): tests use the deterministic,
 * offline `HashEmbedder`; production uses `OnnxEmbedder` (e5-small, local,
 * loaded lazily — absent model ⇒ disabled, never a crash).
 *
 * e5 models expect `query:`/`passage:` prefixes; the Embedder owns them so
 * callers never think about it.
 */

import { createHash } from 'crypto';

export interface Embedder {
  readonly modelId: string;
  readonly dims: number;
  /** L2-normalized embeddings, one per input text. `kind` selects the e5 prefix. */
  embed(texts: string[], kind?: 'query' | 'passage'): Promise<Float32Array[]>;
}

/** The text actually embedded for a trace (A5: L3 FIRST — e5 truncates at
 *  512 tokens, and the keywords are what keeps a decayed trace findable). */
export function embeddableText(input: { content: string; level3Keywords?: string; keywords?: string[] }): string {
  const head = input.level3Keywords ?? input.keywords?.join(' ') ?? '';
  return head ? `${head}\n${input.content}` : input.content;
}

export const HASH_DIMS = 384;

/**
 * Deterministic, offline embedder for tests. Hashes each token into a sparse
 * 384-dim space — semantically meaningless, but reproducible, and texts that
 * share tokens get high cosine, so pipeline behavior (clustering shape,
 * thresholds, storage) is fully testable without a model.
 */
export class HashEmbedder implements Embedder {
  readonly modelId = 'hash-v1';
  readonly dims = HASH_DIMS;

  async embed(texts: string[]): Promise<Float32Array[]> {
    return texts.map((text) => {
      const vec = new Float32Array(this.dims);
      for (const token of text.toLowerCase().split(/[^a-z0-9àâäéèêëîïôöùûüç_-]+/i).filter((t) => t.length > 2)) {
        const h = createHash('sha1').update(token).digest();
        const idx = h.readUInt32LE(0) % this.dims;
        const sign = h[4] % 2 === 0 ? 1 : -1;
        vec[idx] += sign;
      }
      const norm = Math.sqrt(vec.reduce((s, x) => s + x * x, 0));
      if (norm > 0) for (let i = 0; i < this.dims; i++) vec[i] /= norm;
      return vec;
    });
  }
}

export function cosine(a: Float32Array, b: Float32Array): number {
  let dot = 0;
  for (let i = 0; i < a.length; i++) dot += a[i] * b[i];
  return dot; // inputs are L2-normalized
}

export const E5_MODEL_ID = 'Xenova/multilingual-e5-small';
export const E5_BASE_MODEL_ID = 'Xenova/multilingual-e5-base';
export const BGE_M3_MODEL_ID = 'Xenova/bge-m3';

/** Known output dims per model — e5-small 384, e5-base 768, bge-m3 1024. */
export const MODEL_DIMS: Record<string, number> = {
  [E5_MODEL_ID]: 384,
  [E5_BASE_MODEL_ID]: 768,
  [BGE_M3_MODEL_ID]: 1024,
};

/**
 * Calibrated cluster thresholds per model (7.5, 52 labelled pairs incl. hard
 * negatives, scripts/calibrate-embeddings.ts). Thresholds are MODEL-SPECIFIC:
 * bge-m3's cosine space sits lower than e5's. No model reaches a P=1.0
 * corroboration gate — see DREAM_CONFIG.vectorCorroborateThreshold.
 */
export const CLUSTER_THRESHOLDS: Record<string, number> = {
  [E5_MODEL_ID]: 0.855, // round 1: F1 0.84 (P 0.76 / R 0.93)
  [E5_BASE_MODEL_ID]: 0.825, // round 3: F1 0.80 (P 0.71 / R 0.92)
  [BGE_M3_MODEL_ID]: 0.74, // round 4: F1 0.89 (P 0.83 / R 0.96) — best
};

export interface OnnxEmbedderOptions {
  /** q8 (default) or fp32. fp16 is accepted but BROKEN on win32/onnxruntime-node
   *  (graph-fusion error at load, 7.5 calibration) — do not use it there. */
  dtype?: 'q8' | 'fp16' | 'fp32';
  /** Model to load; defaults to bge-m3 (7.5 round-4 calibration: best cluster
   *  F1 0.89 vs 0.80 for e5-base; no model reaches a P=1.0 corroborate gate). */
  model?: string;
  cacheDir?: string;
  /** Pre-flight probe: pass false to disable instead of throwing on load failure. */
  onLoadError?: (err: unknown) => void;
}

/**
 * Production embedder: Transformers.js + bge-m3 (default; e5-base / e5-small
 * via `model` option), fully local after the one-time download into
 * `data/models/`. Loaded lazily on first use and reused across calls.
 */
export class OnnxEmbedder implements Embedder {
  readonly modelId: string;
  readonly dims: number;
  /** Calibrated cluster threshold for this model (see CLUSTER_THRESHOLDS). */
  readonly suggestedClusterThreshold: number;
  private extractor: any = null;
  private loading: Promise<any> | null = null;

  constructor(private options: OnnxEmbedderOptions = {}) {
    const model = options.model ?? BGE_M3_MODEL_ID;
    this.modelId = `${model}@${options.dtype ?? 'q8'}`;
    const dims = MODEL_DIMS[model];
    if (!dims) throw new Error(`unknown model dims for ${model} — extend MODEL_DIMS`);
    this.dims = dims;
    const threshold = CLUSTER_THRESHOLDS[model];
    if (!threshold) throw new Error(`no calibrated cluster threshold for ${model} — calibrate first`);
    this.suggestedClusterThreshold = threshold;
  }

  private async load() {
    if (this.extractor) return this.extractor;
    this.loading ??= (async () => {
      const { pipeline, env } = await import('@huggingface/transformers');
      env.cacheDir = this.options.cacheDir ?? './data/models';
      env.allowLocalModels = true;
      const model = this.options.model ?? BGE_M3_MODEL_ID;
      return pipeline('feature-extraction', model, { dtype: this.options.dtype ?? 'q8' });
    })();
    try {
      this.extractor = await this.loading;
    } catch (err) {
      this.loading = null;
      this.options.onLoadError?.(err);
      throw err;
    }
    return this.extractor;
  }

  /** `kind` picks the e5 prefix: queries for search, passages for storage. */
  /** e5 models require `query:`/`passage:` prefixes; bge models must NOT get them. */
  private get usesE5Prefix(): boolean {
    return (this.options.model ?? E5_BASE_MODEL_ID).includes('e5');
  }

  async embed(texts: string[], kind: 'query' | 'passage' = 'passage'): Promise<Float32Array[]> {
    const extractor = await this.load();
    const prefixed = this.usesE5Prefix ? texts.map((t) => `${kind}: ${t}`) : texts;
    const out = await extractor(prefixed, { pooling: 'mean', normalize: true });
    const dims = this.dims;
    const flat = out.data as Float32Array;
    const rows: Float32Array[] = [];
    for (let i = 0; i < texts.length; i++) rows.push(flat.slice(i * dims, (i + 1) * dims));
    return rows;
  }
}
