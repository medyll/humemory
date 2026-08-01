import { describe, test, expect } from 'bun:test';
import {
  applyCommitToLoops,
  renderCommitReport,
  tokenize,
  tokenizePath,
  scoreOverlap,
  MAX_SUGGESTIONS,
  type CommitInfo,
} from '../src/agent/commit-closer.js';
import { loopId } from '../src/core/cues.js';
import { freshStore } from './helpers/store.js';
import { fakeClock } from './helpers/clock.js';
import type { Intention } from '../src/core/types.js';

/**
 * Phase 5.3.2 — fermeture des boucles par commit (story S5-03b).
 * No git call here: a CommitInfo is injected. The script queries git; this module
 * only decides.
 */

const DIR = '/repo/projet';

function setup() {
  const clock = fakeClock();
  const store = freshStore({ clock });
  return { clock, store };
}

function commit(overrides: Partial<CommitInfo> = {}): CommitInfo {
  return {
    sha: 'deadbee',
    message: 'chore: nothing special',
    files: [],
    directory: DIR,
    ...overrides,
  };
}

describe('Tokenisation', () => {
  test('ignores case, accents and words that are too short', () => {
    expect(tokenize('Refactor the token VALIDATION layer')).toEqual(['refactor', 'token', 'validation', 'layer']);
  });

  test('drops words too common to signal anything', () => {
    // 'src', 'index', 'test' appear everywhere: keeping them would match everything with everything.
    expect(tokenize('src index test middleware')).toEqual(['middleware']);
  });

  test('a path yields its segments, without the extension', () => {
    expect(tokenizePath('src/auth/service.ts')).toEqual(['auth', 'service']);
    expect(tokenizePath('D:\\repo\\src\\auth\\middleware.ts')).toContain('middleware');
  });
});

describe('Overlap score', () => {
  test('overlaps the loop content with the files touched', () => {
    const intention = { content: 'Refactor the auth middleware' } as Intention;
    expect(scoreOverlap(intention, ['src/auth/middleware.ts']).sort()).toEqual(['auth', 'middleware']);
  });

  test('no overlap on unrelated files', () => {
    const intention = { content: 'Refactor the auth middleware' } as Intention;
    expect(scoreOverlap(intention, ['docs/readme.md'])).toEqual([]);
  });
});

describe('Explicit closing', () => {
  test('"Closes loop-<id>" closes the loop and records the SHA', async () => {
    const { store } = setup();
    const i = await store.addIntention({ content: 'refactor auth', directory: DIR });

    const result = await applyCommitToLoops(
      store,
      commit({ sha: 'cafe123', message: `fix(auth): expiry\n\nCloses ${loopId(i.id)}` })
    );

    expect(result.closed.length).toBe(1);
    const closed = await store.getIntention(i.id);
    expect(closed!.status).toBe('closed');
    expect(closed!.closedByCommit).toBe('cafe123');
  });

  test('remaining cues are cancelled — no ghost wake-up', async () => {
    const { store } = setup();
    const i = await store.addIntention({ content: 'x', directory: DIR }, [
      { kind: 'event', type: 'file_open', path: 'src/a.ts' },
      { kind: 'time', at: '2026-12-01T00:00:00Z' },
    ]);

    await applyCommitToLoops(store, commit({ message: `feat: x\n\nCloses ${loopId(i.id)}` }));

    const cues = await store.listCues({ intentionId: i.id });
    expect(cues.every((c) => c.status === 'cancelled')).toBe(true);
  });

  test('several loops can be closed at once', async () => {
    const { store } = setup();
    const a = await store.addIntention({ content: 'a', directory: DIR });
    const b = await store.addIntention({ content: 'b', directory: DIR });

    const result = await applyCommitToLoops(
      store,
      commit({ message: `feat: big one\n\nCloses ${loopId(a.id)}\nCloses ${loopId(b.id)}` })
    );

    expect(result.closed.length).toBe(2);
    expect((await store.listIntentions({ status: 'armed' })).length).toBe(0);
  });

  test('an explicit marker crosses projects — the author knows what they are closing', async () => {
    const { store } = setup();
    const i = await store.addIntention({ content: 'elsewhere', directory: '/other/project' });

    const result = await applyCommitToLoops(store, commit({ message: `fix\n\nCloses ${loopId(i.id)}` }));
    expect(result.closed.length).toBe(1);
  });

  test('an unknown id is reported, nothing is closed at random', async () => {
    const { store } = setup();
    await store.addIntention({ content: 'untouched', directory: DIR });

    const result = await applyCommitToLoops(store, commit({ message: 'fix\n\nCloses loop-deadbeef' }));

    expect(result.closed).toEqual([]);
    expect(result.unresolved).toEqual(['deadbeef']);
    expect((await store.listIntentions({ status: 'armed' })).length).toBe(1);
  });

  test('a non-hexadecimal string is not a loop reference', async () => {
    const { store } = setup();
    await store.addIntention({ content: 'untouched', directory: DIR });

    // Ids are UUID prefixes: 'loop-zzzzzzzz' cannot point at any loop.
    const result = await applyCommitToLoops(store, commit({ message: 'fix\n\nCloses loop-zzzzzzzz' }));
    expect(result.unresolved).toEqual([]);
    expect(result.closed).toEqual([]);
  });

  test('an already closed loop is not closed again', async () => {
    const { store } = setup();
    const i = await store.addIntention({ content: 'x', directory: DIR });
    await store.updateIntentionStatus(i.id, 'closed');

    const result = await applyCommitToLoops(store, commit({ message: `fix\n\nCloses ${loopId(i.id)}` }));
    expect(result.closed).toEqual([]);
    expect(result.unresolved).toEqual([i.id.slice(0, 8)]);
  });
});

describe('Heuristic — suggests, never closes', () => {
  test('suggests the loop whose content overlaps the files touched', async () => {
    const { store } = setup();
    const i = await store.addIntention({ content: 'Refactor the auth middleware', directory: DIR });

    const result = await applyCommitToLoops(store, commit({ files: ['src/auth/middleware.ts'] }));

    expect(result.suggestions.length).toBe(1);
    expect(result.suggestions[0].intention.id).toBe(i.id);
    // Nothing moved in the database: this is a proposal, not a decision.
    expect((await store.getIntention(i.id))!.status).toBe('armed');
    expect(result.closed).toEqual([]);
  });

  test('suggests nothing for an unrelated commit', async () => {
    const { store } = setup();
    await store.addIntention({ content: 'Refactor the auth middleware', directory: DIR });

    const result = await applyCommitToLoops(store, commit({ files: ['docs/readme.md'] }));
    expect(result.suggestions).toEqual([]);
  });

  test('the heuristic stays bounded to the commit project', async () => {
    const { store } = setup();
    await store.addIntention({ content: 'Refactor the auth middleware', directory: '/autre/projet' });

    const result = await applyCommitToLoops(store, commit({ files: ['src/auth/middleware.ts'] }));
    expect(result.suggestions).toEqual([]);
  });

  test('suggestions are ranked and capped', async () => {
    const { store } = setup();
    for (let n = 0; n < 6; n++) {
      await store.addIntention({ content: `Refactor auth middleware variant ${n}`, directory: DIR });
    }
    await store.addIntention({ content: 'Standalone middleware work', directory: DIR });

    const result = await applyCommitToLoops(store, commit({ files: ['src/auth/middleware.ts'] }));

    expect(result.suggestions.length).toBe(MAX_SUGGESTIONS);
    // Two overlapping tokens rank ahead of one.
    expect(result.suggestions[0].score).toBeGreaterThanOrEqual(result.suggestions[1].score);
    expect(result.suggestions[0].matched.sort()).toEqual(['auth', 'middleware']);
  });

  test('a loop closed explicitly does not come back as a suggestion', async () => {
    const { store } = setup();
    const i = await store.addIntention({ content: 'Refactor auth middleware', directory: DIR });

    const result = await applyCommitToLoops(
      store,
      commit({ message: `fix\n\nCloses ${loopId(i.id)}`, files: ['src/auth/middleware.ts'] })
    );

    expect(result.closed.length).toBe(1);
    expect(result.suggestions).toEqual([]);
  });
});

describe('Report', () => {
  test('nothing to say, nothing written', async () => {
    const { store } = setup();
    const result = await applyCommitToLoops(store, commit());
    expect(renderCommitReport(result)).toBe('');
  });

  test('announces the closures and offers a command for the suggestions', async () => {
    const { store } = setup();
    const closedLoop = await store.addIntention({ content: 'closed loop', directory: DIR });
    await store.addIntention({ content: 'Refactor auth middleware', directory: DIR });

    const result = await applyCommitToLoops(
      store,
      commit({ message: `fix\n\nCloses ${loopId(closedLoop.id)}`, files: ['src/auth/middleware.ts'] })
    );
    const report = renderCommitReport(result);

    expect(report).toContain('✅');
    expect(report).toContain('closed loop');
    expect(report).toContain('💡');
    expect(report).toContain('pnpm cli intent close loop-');
  });

  test('reports an id it cannot find', async () => {
    const { store } = setup();
    const result = await applyCommitToLoops(store, commit({ message: 'fix\n\nCloses loop-deadbeef' }));

    expect(renderCommitReport(result)).toContain('⚠️');
  });
});
