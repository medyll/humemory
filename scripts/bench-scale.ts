#!/usr/bin/env bun
/**
 * Scale benchmark — audit improvement #2.
 *
 * `loadIntoMemory()` reads every trace and rebuilds the whole FlexSearch index.
 * It runs in the store's constructor, so every process pays it at startup: the
 * API, the MCP server, the maintenance worker, and — the ones that hurt — the
 * CLI on every command and the SessionStart and post-commit hooks on every
 * session and every commit. It runs a second time inside `search()` whenever
 * another process has committed since the last load (the A01 fix), which on a
 * machine running the API next to an MCP server means a rebuild per search.
 *
 * Nobody had measured what that costs, so nobody could say at what size it
 * stops being free. The audit is explicit that this measurement comes BEFORE
 * choosing a different architecture. This script produces the numbers; it
 * deliberately proposes nothing.
 *
 * Hermetic: temp databases, synthetic traces, no model, no network. Timings are
 * wall-clock on the machine that runs it — compare rows within a run, not
 * across machines.
 *
 * Run: `pnpm bench:scale` — `--sizes 250,1000,5000` to choose, `--json` for raw.
 */
import { Database } from 'bun:sqlite';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { SQLiteStore } from '../src/store/sqlite.js';
import { SqliteCueResolver } from '../src/core/cues.js';
import { FakeClock } from '../src/core/clock.js';
import { T0 } from '../tests/helpers/clock.js';

const asJson = process.argv.includes('--json');
const sizesArg = process.argv.find((a) => a.startsWith('--sizes='))?.split('=')[1];
const SIZES = (sizesArg ?? '250,1000,5000').split(',').map((n) => parseInt(n, 10)).filter((n) => n > 0);

interface Row {
  size: number;
  seedMs: number;
  openMs: number;
  heapMb: number;
  searchWarmMs: number;
  searchAfterExternalWriteMs: number;
  decayMs: number;
  cueResolveMs: number;
}

/**
 * Synthetic traces with enough shared vocabulary to make the index work, and
 * enough variety that every query is not a full-table match. The seed is fixed
 * so two runs on the same machine are comparable.
 */
const SUBJECTS = ['auth', 'sqlite', 'decay', 'cue', 'api', 'index', 'queue', 'lock', 'cache', 'token'];
const VERBS = ['failed', 'stalled', 'raced', 'leaked', 'blocked', 'recovered', 'expired', 'retried'];
const OBJECTS = ['on the write path', 'under concurrency', 'after a restart', 'during a migration', 'in the worker'];

function syntheticTrace(i: number) {
  const subject = SUBJECTS[i % SUBJECTS.length];
  const verb = VERBS[(i * 7) % VERBS.length];
  const object = OBJECTS[(i * 13) % OBJECTS.length];
  const keywords = [subject, verb, `id${i % 97}`, SUBJECTS[(i * 3) % SUBJECTS.length]];
  return {
    content: `Trace ${i}: the ${subject} path ${verb} ${object}, and the fix was recorded against id${i % 97}.`,
    directory: `/synthetic/project-${i % 8}`,
    day: '2026-01-01',
    keywords,
    sessionId: `session-${i % 40}`,
    memoryType: 'semantic' as const,
    level1Summary: `The ${subject} path ${verb} ${object}.`,
    level2Essential: `${subject} ${verb}`,
    level3Keywords: keywords.join(' '),
  };
}

function heapMb(): number {
  // Bun exposes an explicit collection; without it the figure is noise. RSS
  // rather than heapUsed: much of the index lives outside the JS heap, and
  // heapUsed reported a flat 0.0 MB delta for it.
  if (typeof Bun !== 'undefined' && typeof Bun.gc === 'function') Bun.gc(true);
  return process.memoryUsage().rss / 1024 / 1024;
}

async function time<T>(fn: () => Promise<T> | T): Promise<[T, number]> {
  const start = performance.now();
  const value = await fn();
  return [value, performance.now() - start];
}

/**
 * Median of `runs` timed repetitions after `warmup` untimed ones. The first
 * call through any of these paths is dominated by JIT compilation — an early
 * draft of this script reported a warm search getting *faster* as the corpus
 * grew, which was the compiler warming up, not the engine scaling.
 */
async function timeRepeated(fn: () => Promise<unknown> | unknown, runs = 7, warmup = 3): Promise<number> {
  for (let i = 0; i < warmup; i++) await fn();
  const samples: number[] = [];
  for (let i = 0; i < runs; i++) {
    const [, ms] = await time(fn);
    samples.push(ms);
  }
  samples.sort((a, b) => a - b);
  return samples[Math.floor(samples.length / 2)];
}

async function measure(size: number, workspace: string): Promise<Row> {
  const dbPath = join(workspace, `bench-${size}.db`);
  const clock = new FakeClock(T0);

  // --- seed -----------------------------------------------------------------
  const seedStore = new SQLiteStore(dbPath, { clock });
  const [, seedMs] = await time(async () => {
    for (let i = 0; i < size; i++) await seedStore.add(syntheticTrace(i));
  });
  // A cue per 10 traces: enough to make resolution measurable without turning
  // this into a cue benchmark.
  for (let i = 0; i < Math.ceil(size / 10); i++) {
    const intention = await seedStore.addIntention(
      { content: `Open loop ${i}`, directory: `/synthetic/project-${i % 8}` },
      [{ kind: 'time', at: new Date(T0.getTime() + (i + 1) * 3600_000).toISOString() } as any]
    );
    void intention;
  }
  seedStore.close();

  // --- cold open: schema + loadIntoMemory, what every process pays ----------
  const before = heapMb();
  const [store, openMs] = await time(() => new SQLiteStore(dbPath, { clock }));
  const loadedHeap = heapMb() - before;

  // --- warm search: index already current ----------------------------------
  const queries = ['sqlite', 'auth failed', 'id42', 'cache blocked', 'decay under concurrency'];
  const searchWarmMs = await timeRepeated(async () => {
    for (const query of queries) await store.search({ query, limit: 10 });
  });

  // --- search after an external commit: the A01 refresh path ---------------
  // A second connection writing is exactly the API-next-to-MCP situation. The
  // store notices through PRAGMA data_version and rebuilds the whole index.
  // The write has to change something: an UPDATE that sets a column to its own
  // value still commits, but making it a real change removes all doubt that
  // data_version moved.
  let externalTick = 0;
  const searchAfterExternalWriteMs = await timeRepeated(async () => {
    const outside = new Database(dbPath);
    outside.exec(
      `UPDATE memories SET session_id = 'external-${externalTick++}' WHERE id = (SELECT id FROM memories LIMIT 1)`
    );
    outside.close();
    await store.search({ query: 'sqlite', limit: 10 });
  });

  // --- maintenance sweeps ---------------------------------------------------
  const [, decayMs] = await time(() => store.updateDecay());
  const resolver = new SqliteCueResolver(store);
  const [, cueResolveMs] = await time(() =>
    resolver.resolveTimeCues(new Date(T0.getTime() + 24 * 3600_000))
  );

  store.close();
  return {
    size,
    seedMs,
    openMs,
    heapMb: loadedHeap,
    searchWarmMs: searchWarmMs / queries.length,
    searchAfterExternalWriteMs,
    decayMs,
    cueResolveMs,
  };
}

function pad(value: string | number, width: number): string {
  return String(value).padStart(width);
}

async function main() {
  const workspace = mkdtempSync(join(tmpdir(), 'humemory-bench-'));
  const rows: Row[] = [];

  try {
    for (const size of SIZES) rows.push(await measure(size, workspace));

    if (asJson) {
      console.log(JSON.stringify({ sizes: SIZES, rows }, null, 2));
      return;
    }

    console.log('\n📈 humemory — scale benchmark');
    console.log('   wall-clock on this machine; compare rows within a run, not across machines\n');
    console.log('  traces    seed    open    heap   search   search+ext    decay     cues');
    console.log('                      ms      MB       ms           ms       ms       ms');
    for (const row of rows) {
      console.log(
        `  ${pad(row.size, 6)}  ${pad(Math.round(row.seedMs), 6)}  ${pad(row.openMs.toFixed(1), 6)}  ` +
          `${pad(row.heapMb.toFixed(1), 6)}  ${pad(row.searchWarmMs.toFixed(2), 7)}  ` +
          `${pad(row.searchAfterExternalWriteMs.toFixed(1), 11)}  ${pad(row.decayMs.toFixed(1), 7)}  ` +
          `${pad(row.cueResolveMs.toFixed(1), 7)}`
      );
    }

    if (rows.length > 1) {
      const first = rows[0];
      const last = rows[rows.length - 1];
      const factor = last.size / first.size;
      const ratio = (a: number, b: number) => (b === 0 ? Infinity : a / b);
      console.log(`\n  Growth from ${first.size} to ${last.size} traces (${factor}× the data):`);
      console.log(`    cold open           ${ratio(last.openMs, first.openMs).toFixed(1)}×`);
      console.log(`    heap after load     ${ratio(last.heapMb, first.heapMb).toFixed(1)}×`);
      console.log(`    warm search         ${ratio(last.searchWarmMs, first.searchWarmMs).toFixed(1)}×`);
      console.log(`    search + rebuild    ${ratio(last.searchAfterExternalWriteMs, first.searchAfterExternalWriteMs).toFixed(1)}×`);
      console.log(
        `\n  A search that triggers a rebuild costs ${(
          last.searchAfterExternalWriteMs / last.searchWarmMs
        ).toFixed(0)}× a warm one at ${last.size} traces.`
      );
    }
    console.log();
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
}

await main();
