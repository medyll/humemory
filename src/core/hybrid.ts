/**
 * Hybrid search — Phase 7.4.
 *
 * Reciprocal Rank Fusion of the BM25 lane (exact identifiers: loop-ab12, file
 * paths) and the vector lane (paraphrases). Additive by design: with no
 * embeddings in the store, the vector lane contributes nothing and the result
 * is exactly the BM25 ranking — no regression on bare installs.
 *
 * Exclusion filters are inherited from the lanes themselves: the vector lane
 * reads `memory_embeddings`, whose rows are deleted on merge (A4), so merged
 * traces contribute no vector rank; contradicted losers stay searchable per
 * the 6.0.2 rule ("ghosted, not deleted") in BOTH lanes.
 */

import type { MemoryStore, SearchResult } from './types.js';
import { cosine, embeddableText, type Embedder } from './embeddings.js';

export const RRF_K = 60;

export interface EmbeddingLister {
  listEmbeddings(options?: { modelId?: string }): Promise<{ memoryId: string; embedding: Float32Array }[]>;
  getById(id: string): Promise<SearchResult['memory'] | null>;
}

/**
 * RRF fusion: score(d) = Σ 1/(k + rank_lane(d)). The query is embedded with
 * the `query:` prefix (e5 convention, owned by the Embedder).
 */
export async function hybridSearch(
  store: MemoryStore & EmbeddingLister,
  embedder: Embedder,
  query: string,
  options: { directory?: string; limit?: number } = {}
): Promise<SearchResult[]> {
  const limit = options.limit ?? 10;

  // BM25 lane — the existing inverse search, widened for fusion.
  const bm25 = await store.search({ query, directory: options.directory, limit: limit * 3 });

  // Vector lane — absent embeddings ⇒ empty lane ⇒ pure BM25 result.
  const stored = await store.listEmbeddings({ modelId: embedder.modelId });
  const byId = new Map<string, number>();
  if (stored.length) {
    const [q] = await embedder.embed([query], 'query');
    const ranked = stored
      .map((row) => ({ memoryId: row.memoryId, cos: cosine(q, row.embedding) }))
      .sort((a, b) => b.cos - a.cos)
      .slice(0, limit * 3);
    ranked.forEach((r, rank) => byId.set(r.memoryId, rank));
  }

  const bm25Rank = new Map<string, number>();
  bm25.forEach((r, i) => bm25Rank.set(r.memory.id, i));

  const candidateIds = new Set([...bm25Rank.keys(), ...byId.keys()]);
  const fused: { id: string; rrf: number }[] = [];
  for (const id of candidateIds) {
    let rrf = 0;
    if (bm25Rank.has(id)) rrf += 1 / (RRF_K + bm25Rank.get(id)!);
    if (byId.has(id)) rrf += 1 / (RRF_K + byId.get(id)!);
    fused.push({ id, rrf });
  }
  fused.sort((a, b) => b.rrf - a.rrf);

  const results: SearchResult[] = [];
  for (const { id, rrf } of fused.slice(0, limit)) {
    const fromBm25 = bm25.find((r) => r.memory.id === id);
    const memory = fromBm25?.memory ?? (await store.getById(id));
    if (!memory) continue;
    if (options.directory && memory.directory !== options.directory) continue;
    results.push({
      memory,
      matchLevel: fromBm25?.matchLevel ?? memory.currentLevel,
      score: Math.round(rrf * 10_000) / 100, // readable, deterministic
    });
  }
  return results;
}
