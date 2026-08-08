/**
 * VectorClusterer — Phase 7.3.
 *
 * Same union-find shape as KeywordClusterer, on cosine similarity over stored
 * embeddings instead of Jaccard over tokens. Missing embeddings are embedded
 * on the spot BY THE BATCH JOB (A3 — this class only ever runs inside
 * `pnpm dream` / backfill, never on the add() path).
 *
 * Implements `ScoredClusterer`: the dreamer needs the cluster's minimum
 * pairwise similarity to gate `corroborated` verification on the STRICTER
 * threshold (A1). Grouping tolerates noise — a human reviews proposals;
 * verification does not — nobody reviews it.
 */

import type { Memory } from './types.js';
import { DREAM_CONFIG, type Clusterer } from './dreamer.js';
import { cosine, embeddableText, type Embedder } from './embeddings.js';

export interface ScoredCluster {
  members: Memory[];
  /** Weakest link that holds the cluster together. */
  minPairwiseSimilarity: number;
}

export interface ScoredClusterer extends Clusterer {
  clusterWithScores(memories: Memory[]): Promise<ScoredCluster[]>;
}

/** Type guard — the dreamer uses scores when the clusterer provides them. */
export function hasScores(c: Clusterer): c is ScoredClusterer {
  return typeof (c as ScoredClusterer).clusterWithScores === 'function';
}

export interface EmbeddingStore {
  getEmbedding(memoryId: string): Promise<{ modelId: string; embedding: Float32Array } | null>;
  setEmbedding(memoryId: string, modelId: string, embedding: Float32Array): Promise<void>;
}

export class VectorClusterer implements ScoredClusterer {
  constructor(
    private embedder: Embedder,
    private store: EmbeddingStore,
    /**
     * Default: the embedder's calibrated per-model threshold
     * (OnnxEmbedder.suggestedClusterThreshold — 7.5 round 4), falling back to
     * DREAM_CONFIG for embedders without calibration (e.g. HashEmbedder in tests).
     */
    private threshold: number = (embedder as { suggestedClusterThreshold?: number })
      .suggestedClusterThreshold ?? DREAM_CONFIG.vectorClusterThreshold
  ) {}

  private async embeddingsFor(memories: Memory[]): Promise<Float32Array[]> {
    const missing: { index: number; text: string }[] = [];
    const out: (Float32Array | null)[] = [];

    for (let i = 0; i < memories.length; i++) {
      const row = await this.store.getEmbedding(memories[i].id);
      if (row && row.modelId === this.embedder.modelId) {
        out.push(row.embedding);
      } else {
        out.push(null);
        missing.push({ index: i, text: embeddableText(memories[i]) });
      }
    }

    if (missing.length) {
      // One batched model call for everything missing (A3: we are in a batch job).
      const fresh = await this.embedder.embed(missing.map((m) => m.text));
      for (let k = 0; k < missing.length; k++) {
        out[missing[k].index] = fresh[k];
        await this.store.setEmbedding(memories[missing[k].index].id, this.embedder.modelId, fresh[k]);
      }
    }

    return out as Float32Array[];
  }

  async clusterWithScores(memories: Memory[]): Promise<ScoredCluster[]> {
    if (memories.length < 2) return [];
    const vectors = await this.embeddingsFor(memories);

    const parent = memories.map((_, i) => i);
    const find = (i: number): number => {
      while (parent[i] !== i) {
        parent[i] = parent[parent[i]];
        i = parent[i];
      }
      return i;
    };
    // Track the weakest accepted link per union — that is the cluster's
    // minPairwiseSimilarity once grouping settles.
    const sims = new Map<string, number>();
    for (let i = 0; i < memories.length; i++) {
      for (let j = i + 1; j < memories.length; j++) {
        const s = cosine(vectors[i], vectors[j]);
        if (s >= this.threshold) {
          sims.set(`${i}:${j}`, s);
          const ri = find(i);
          const rj = find(j);
          if (ri !== rj) parent[rj] = ri;
        }
      }
    }

    const groups = new Map<number, number[]>();
    memories.forEach((_, i) => {
      const root = find(i);
      if (!groups.has(root)) groups.set(root, []);
      groups.get(root)!.push(i);
    });

    const clusters: ScoredCluster[] = [];
    for (const idxs of groups.values()) {
      if (idxs.length < 2) continue;
      let min = 1;
      for (let a = 0; a < idxs.length; a++) {
        for (let b = a + 1; b < idxs.length; b++) {
          const key = `${Math.min(idxs[a], idxs[b])}:${Math.max(idxs[a], idxs[b])}`;
          const s = sims.get(key) ?? cosine(vectors[idxs[a]], vectors[idxs[b]]);
          if (s < min) min = s;
        }
      }
      clusters.push({ members: idxs.map((i) => memories[i]), minPairwiseSimilarity: min });
    }
    return clusters;
  }

  async cluster(memories: Memory[]): Promise<Memory[][]> {
    return (await this.clusterWithScores(memories)).map((c) => c.members);
  }
}
