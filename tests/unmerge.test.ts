/**
 * Phase 6.0.4 — level_revisions + unmerge.
 */
import { describe, test, expect } from 'bun:test';
import { freshStore } from './helpers/store.js';
import { stubLLMClient } from './helpers/llm.js';

const base = {
  directory: '/tmp/p', day: '2026-08-08', keywords: [] as string[],
  sessionId: 's1', memoryType: 'semantic' as const,
};

describe('level revisions', () => {
  test('merge(autoMergeContent) versions the target levels before overwriting', async () => {
    const store = freshStore();
    const client = stubLLMClient();

    const target = await store.add({ ...base, content: 'target', level1Summary: 'old L1', level2Essential: 'old L2', level3Keywords: 'old L3' });
    const source = await store.add({ ...base, content: 'source' });

    await store.merge(source.id, target.id, { autoMergeContent: true, client });

    const after = await store.getById(target.id);
    expect(after!.level1Summary).not.toBe('old L1'); // overwritten by the LLM merge

    const { source: resurrected, target: restored } = await store.unmerge!(target.id === source.id ? '' : source.id);
    expect(resurrected.mergedIntoId).toBeUndefined();
    expect(resurrected.currentLevel).not.toBe(4);
    expect(restored.level1Summary).toBe('old L1');
    expect(restored.level2Essential).toBe('old L2');
    expect(restored.level3Keywords).toBe('old L3');
  });

  test('unmerge refuses a trace that is not merged', async () => {
    const store = freshStore();
    const m = await store.add({ ...base, content: 'solo' });
    await expect(store.unmerge!(m.id)).rejects.toThrow('not merged');
  });

  test('retention: only the last 5 revisions are kept', async () => {
    const store = freshStore();
    const client = stubLLMClient();
    const target = await store.add({ ...base, content: 'target', level1Summary: 'L1 v0' });

    for (let i = 1; i <= 7; i++) {
      const src = await store.add({ ...base, content: `source ${i}` });
      // set distinct previous levels so each snapshot has content
      await store.merge(src.id, target.id, { autoMergeContent: true, client });
      // unmerge resurrects the source and consumes the last revision
      if (i % 2 === 0) await store.unmerge!(src.id);
    }

    // Count remaining revisions for the target — cap is 5
    const count = (store as any).db
      .query('SELECT COUNT(*) AS n FROM level_revisions WHERE memory_id = $id')
      .get({ $id: target.id }).n;
    expect(count).toBeLessThanOrEqual(5);
  });
});
