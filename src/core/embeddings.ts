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

export interface OnnxEmbedderOptions {
  /** q8 (default, ~120MB) or fp16 — 7.5 calibration decides. */
  dtype?: 'q8' | 'fp16';
  cacheDir?: string;
  /** Pre-flight probe: pass false to disable instead of throwing on load failure. */
  onLoadError?: (err: unknown) => void;
}

/**
 * Production embedder: Transformers.js + e5-small, fully local after the
 * one-time download into `data/models/`. Loaded lazily on first use and
 * reused across calls (the dreamer embeds in batches).
 */
export class OnnxEmbedder implements Embedder {
  readonly modelId: string;
  readonly dims = 384;
  private extractor: any = null;
  private loading: Promise<any> | null = null;

  constructor(private options: OnnxEmbedderOptions = {}) {
    this.modelId = `${E5_MODEL_ID}@${options.dtype ?? 'q8'}`;
  }

  private async load() {
    if (this.extractor) return this.extractor;
    this.loading ??= (async () => {
      const { pipeline, env } = await import('@huggingface/transformers');
      env.cacheDir = this.options.cacheDir ?? './data/models';
      env.allowLocalModels = true;
      return pipeline('feature-extraction', E5_MODEL_ID, { dtype: this.options.dtype ?? 'q8' });
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
  async embed(texts: string[], kind: 'query' | 'passage' = 'passage'): Promise<Float32Array[]> {
    const extractor = await this.load();
    const prefixed = texts.map((t) => `${kind}: ${t}`);
    const out = await extractor(prefixed, { pooling: 'mean', normalize: true });
    const dims = this.dims;
    const flat = out.data as Float32Array;
    const rows: Float32Array[] = [];
    for (let i = 0; i < texts.length; i++) rows.push(flat.slice(i * dims, (i + 1) * dims));
    return rows;
  }
}
