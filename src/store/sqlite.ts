import { Database } from 'bun:sqlite';
import { join, resolve } from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';
import { openSync, closeSync, unlinkSync, existsSync } from 'fs';
import { hostname } from 'os';
import type {
  Memory, SearchQuery, SearchResult, DecayLevel, MemoryStore, MemoryType, MergeResult,
  Intention, IntentionStatus, IntentionStore, NewIntention,
  Cue, CueKind, CueStatus, NewCue, TriggerSpec,
  VerificationReason, Contradiction, ContradictResult,
  DreamProposal, DreamKind, DreamStatus,
} from '../core/types.js';
import { calculateDecayLevel, calculateSaillance, calculateDecayRate, updateAllDecay, DECAY_CONFIG } from '../core/decay.js';
import { createHash } from 'crypto';
import { InverseSearchEngine } from '../core/search.js';
import { generateMemoryLevels, type LLMClient } from '../core/llm-generator.js';
import { systemClock, type Clock } from '../core/clock.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const DEFAULT_DB_PATH = join(__dirname, '../../data/humemory.db');

export interface StoreOptions {
  /** Time source. Defaults to `systemClock`; tests pass a `FakeClock`. */
  clock?: Clock;
  /**
   * Encoding device id (Phase 6.0.1). Defaults to `$HUMEMORY_DEVICE`, then
   * `os.hostname()`. Localization now; multi-device sync later.
   */
  device?: string;
}

/** The only reasons a trace may be verified for — validated, never cast. */
export const VERIFICATION_REASONS: VerificationReason[] = ['corroborated', 'grounded', 'reused', 'human'];

export interface RecallOptions {
  /**
   * True when the caller's agent identity comes from the process rather than
   * from the request — MCP stdio (one server per client, id from the env) or
   * the CLI (a human at a terminal). The HTTP API must leave this false:
   * `X-Humemory-Agent` is a header, and a header is a claim, not a fact.
   * Only trusted identities can earn the `reused` verification.
   */
  identityTrusted?: boolean;
}

/** Resolves the encoding device id once per process. */
function resolveDevice(override?: string): string {
  return override ?? process.env.HUMEMORY_DEVICE ?? hostname();
}

/**
 * Guard: under NODE_ENV=test, opening the production database is a bug, not an
 * option. Suites must pass ':memory:' or a temporary file (see docs/TESTING.md).
 */
function assertNotProdDbUnderTest(dbPath: string): void {
  if (process.env.NODE_ENV !== 'test') return;
  if (dbPath === ':memory:') return;
  const resolved = resolve(dbPath);
  if (resolved === resolve(DEFAULT_DB_PATH)) {
    throw new Error(
      `Refusing to open the production database (${resolved}) under NODE_ENV=test. ` +
        `Use freshStore() / ':memory:' — see docs/TESTING.md.`
    );
  }
}

// Advisory lock for cross-process synchronization
class AdvisoryLock {
  private lockFile: string;
  private lockFd: number | null = null;
  private maxRetries: number;
  private retryDelay: number;

  constructor(lockFile: string, maxRetries: number = 10, retryDelay: number = 100) {
    this.lockFile = lockFile;
    this.maxRetries = maxRetries;
    this.retryDelay = retryDelay;
  }

  acquire(): Promise<void> {
    return new Promise((resolve, reject) => {
      let attempts = 0;
      const tryAcquire = () => {
        try {
          // Use exclusive lock (LOCK_EX) with non-blocking (LOCK_NB)
          // On Windows, we'll simulate this with file operations
          if (existsSync(this.lockFile)) {
            // Lock file exists, wait and retry
            attempts++;
            if (attempts >= this.maxRetries) {
              reject(new Error(`Failed to acquire lock after ${attempts} attempts`));
              return;
            }
            setTimeout(tryAcquire, this.retryDelay);
          } else {
            // Create the lock file
            this.lockFd = openSync(this.lockFile, 'wx'); // wx = create file exclusively
            resolve();
          }
        } catch (error) {
          attempts++;
          if (attempts >= this.maxRetries) {
            const errorMessage = error instanceof Error ? error.message : String(error);
            reject(new Error(`Failed to acquire lock: ${errorMessage}`));
            return;
          }
          setTimeout(tryAcquire, this.retryDelay);
        }
      };
      tryAcquire();
    });
  }

  release(): void {
    if (this.lockFd !== null) {
      try {
        closeSync(this.lockFd);
        this.lockFd = null;
        unlinkSync(this.lockFile);
      } catch (error) {
        console.error('Failed to release lock:', error);
      }
    }
  }

  async withLock<T>(fn: () => Promise<T>): Promise<T> {
    await this.acquire();
    try {
      return await fn();
    } finally {
      this.release();
    }
  }
}

/**
 * Inert lock for a process-private database (`:memory:`): there is no other
 * process to synchronise with, and `':memory:' + '.lock'` is not a valid file
 * name on Windows anyway. Intra-process serialisation still runs through
 * `enqueueWrite`.
 */
class NoopLock {
  async withLock<T>(fn: () => Promise<T>): Promise<T> {
    return fn();
  }
}

type Lock = Pick<AdvisoryLock, 'withLock'>;

export class SQLiteStore implements MemoryStore, IntentionStore {
  private db: Database;
  private searchEngine: InverseSearchEngine;
  private writeQueue: Promise<any> = Promise.resolve();
  private advisoryLock: Lock;
  private clock: Clock;
  /** Phase 6.0.1 — stamped on every trace/intention written by this process. */
  readonly deviceId: string;

  private enqueueWrite<T>(fn: () => T | Promise<T>): Promise<T> {
    this.writeQueue = this.writeQueue.then(() => fn(), () => fn());
    return this.writeQueue as Promise<T>;
  }

  private async withAdvisoryLock<T>(fn: () => Promise<T>): Promise<T> {
    return this.advisoryLock.withLock(fn);
  }

  private async enqueueWriteWithLock<T>(fn: () => Promise<T>): Promise<T> {
    return this.enqueueWrite(() => this.withAdvisoryLock(fn));
  }

  constructor(dbPath: string = DEFAULT_DB_PATH, options: StoreOptions = {}) {
    assertNotProdDbUnderTest(dbPath);
    this.clock = options.clock ?? systemClock;
    this.deviceId = resolveDevice(options.device);
    this.db = new Database(dbPath);
    this.db.exec('PRAGMA journal_mode=WAL');
    this.db.exec('PRAGMA busy_timeout=5000');
    this.db.exec('PRAGMA synchronous=NORMAL');
    this.db.exec('PRAGMA cache_size=-16000');
    // Without this pragma (off by default in SQLite), the ON DELETE CASCADE from
    // `cues` to `intentions` would be decorative and leave orphans behind.
    this.db.exec('PRAGMA foreign_keys=ON');
    this.searchEngine = new InverseSearchEngine({ clock: this.clock });
    
    // Initialize advisory lock for cross-process synchronization.
    // A :memory: database is shared with nobody, so the lock is inert.
    this.advisoryLock = dbPath === ':memory:' ? new NoopLock() : new AdvisoryLock(dbPath + '.lock');
    
    this.initSchema();
    this.loadIntoMemory();
  }

  private initSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS memories (
        id TEXT PRIMARY KEY,
        content TEXT NOT NULL,
        level1_summary TEXT,
        level2_essential TEXT,
        level3_keywords TEXT,
        directory TEXT NOT NULL,
        day TEXT NOT NULL,
        keywords TEXT NOT NULL,
        session_id TEXT NOT NULL,
        memory_type TEXT NOT NULL DEFAULT 'semantic',
        created_at INTEGER NOT NULL,
        last_recalled INTEGER,
        recall_count INTEGER DEFAULT 0,
        decay_rate REAL DEFAULT 0.5,
        current_level INTEGER DEFAULT 0,
        saillance INTEGER DEFAULT 50,
        merged_into_id TEXT,
        photographic INTEGER DEFAULT 0
      )
    `);

    try {
      this.db.exec("ALTER TABLE memories ADD COLUMN memory_type TEXT NOT NULL DEFAULT 'semantic'");
    } catch {
      // column already exists
    }
    try {
      this.db.exec("ALTER TABLE memories ADD COLUMN photographic INTEGER DEFAULT 0");
    } catch {
      // column already exists
    }

    // Phase 6.0.1 — provenance & trust (additive, defaults on every column;
    // pre-Phase-6 rows keep NULL agent/device — silence is not endorsement).
    const memoryTrustColumns = [
      "ALTER TABLE memories ADD COLUMN source TEXT NOT NULL DEFAULT 'agent'",
      "ALTER TABLE memories ADD COLUMN agent TEXT",
      "ALTER TABLE memories ADD COLUMN verified INTEGER NOT NULL DEFAULT 0",
      "ALTER TABLE memories ADD COLUMN verification_reason TEXT",
      "ALTER TABLE memories ADD COLUMN device TEXT",
      "ALTER TABLE memories ADD COLUMN refuted_count INTEGER NOT NULL DEFAULT 0",
    ];
    for (const stmt of memoryTrustColumns) {
      try {
        this.db.exec(stmt);
      } catch {
        // column already exists
      }
    }

    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_directory ON memories(directory);
      CREATE INDEX IF NOT EXISTS idx_session ON memories(session_id);
      CREATE INDEX IF NOT EXISTS idx_level ON memories(current_level);
      CREATE INDEX IF NOT EXISTS idx_day ON memories(day);
      CREATE INDEX IF NOT EXISTS idx_type ON memories(memory_type);
    `);

    this.initProspectiveSchema();

    // Phase 6.0.4 — derived levels are versioned before any overwrite, so a
    // bad merge is auditable and revertible (`unmerge`). Retention: last 5
    // revisions per memory — unbounded history is its own form of hoarding.
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS level_revisions (
        id TEXT PRIMARY KEY,
        memory_id TEXT NOT NULL REFERENCES memories(id),
        level1_summary TEXT,
        level2_essential TEXT,
        level3_keywords TEXT,
        replaced_at INTEGER NOT NULL,
        replaced_by TEXT NOT NULL
      )
    `);
    this.db.exec('CREATE INDEX IF NOT EXISTS idx_level_revisions_memory ON level_revisions(memory_id)');

    // Phase 6.0.2 — contradictions: the loser collapses but is never deleted.
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS contradictions (
        id TEXT PRIMARY KEY,
        winner_id TEXT NOT NULL REFERENCES memories(id),
        loser_id TEXT NOT NULL REFERENCES memories(id),
        reason TEXT,
        created_at INTEGER NOT NULL,
        created_by TEXT NOT NULL DEFAULT 'agent',
        agent TEXT,
        status TEXT NOT NULL DEFAULT 'active'
      )
    `);
    this.db.exec('CREATE INDEX IF NOT EXISTS idx_contradictions_loser ON contradictions(loser_id)');

    // Phase 6.1 — dream proposals (created here so 6.0.2's asymmetric-authority
    // path can already file contradiction proposals; the dreamer pipeline
    // arrives in 6.1).
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS dream_proposals (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        payload TEXT NOT NULL,
        payload_hash TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        confidence REAL NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        expires_at INTEGER,
        resolved_at INTEGER,
        resolved_by TEXT
      )
    `);
    this.db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_dream_dedup ON dream_proposals(kind, payload_hash)');
  }

  /** Snapshot the current derived levels before overwriting them (6.0.4). */
  private revisionSnapshot(memoryId: string, replacedBy: 'merge' | 'dream' | 'manual'): void {
    const row = this.db
      .query('SELECT level1_summary, level2_essential, level3_keywords FROM memories WHERE id = $id')
      .get({ $id: memoryId }) as any;
    if (!row) return;
    // Nothing to preserve: never wrote levels yet.
    if (!row.level1_summary && !row.level2_essential && !row.level3_keywords) return;

    this.db
      .query(
        `INSERT INTO level_revisions (id, memory_id, level1_summary, level2_essential, level3_keywords, replaced_at, replaced_by)
         VALUES ($id, $memory_id, $l1, $l2, $l3, $at, $by)`
      )
      .run({
        $id: crypto.randomUUID(),
        $memory_id: memoryId,
        $l1: row.level1_summary,
        $l2: row.level2_essential,
        $l3: row.level3_keywords,
        $at: this.clock.now().getTime(),
        $by: replacedBy,
      });

    // Retention: last 5 per memory.
    this.db
      .query(
        `DELETE FROM level_revisions WHERE memory_id = $id AND id NOT IN (
           SELECT id FROM level_revisions WHERE memory_id = $id ORDER BY replaced_at DESC LIMIT 5
         )`
      )
      .run({ $id: memoryId });
  }

  /**
   * Prospective memory schema (Phase 5.1). Idempotent: CREATE ... IF NOT EXISTS,
   * so it replays on an existing database without a manual migration.
   */
  private initProspectiveSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS intentions (
        id TEXT PRIMARY KEY,
        content TEXT NOT NULL,
        directory TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        expires_at INTEGER,
        status TEXT NOT NULL DEFAULT 'armed',
        fired_at INTEGER,
        closed_at INTEGER,
        closed_by_commit TEXT,
        saillance INTEGER DEFAULT 100,
        related_memory_id TEXT
      )
    `);

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS cues (
        id TEXT PRIMARY KEY,
        intention_id TEXT NOT NULL REFERENCES intentions(id) ON DELETE CASCADE,
        kind TEXT NOT NULL,
        trigger_spec TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'armed',
        armed_at INTEGER NOT NULL,
        fired_at INTEGER
      )
    `);

    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_intentions_status ON intentions(status);
      CREATE INDEX IF NOT EXISTS idx_intentions_directory ON intentions(directory);
      CREATE INDEX IF NOT EXISTS idx_intentions_expires ON intentions(expires_at);
      CREATE INDEX IF NOT EXISTS idx_cues_intention ON cues(intention_id);
      CREATE INDEX IF NOT EXISTS idx_cues_status ON cues(status);
      CREATE INDEX IF NOT EXISTS idx_cues_kind ON cues(kind);
    `);

    // Phase 6.0.1 — same provenance columns on intentions (gap 8).
    const intentionTrustColumns = [
      "ALTER TABLE intentions ADD COLUMN source TEXT NOT NULL DEFAULT 'agent'",
      "ALTER TABLE intentions ADD COLUMN agent TEXT",
      "ALTER TABLE intentions ADD COLUMN verified INTEGER NOT NULL DEFAULT 0",
      "ALTER TABLE intentions ADD COLUMN verification_reason TEXT",
      "ALTER TABLE intentions ADD COLUMN device TEXT",
    ];
    for (const stmt of intentionTrustColumns) {
      try {
        this.db.exec(stmt);
      } catch {
        // column already exists
      }
    }
  }

  private loadIntoMemory(): void {
    const rows = this.db.query('SELECT * FROM memories').all() as any[];
    for (const row of rows) {
      this.searchEngine.add(this.rowToMemory(row));
    }
  }

  private rowToMemory(row: any): Memory {
    return {
      id: row.id,
      content: row.content,
      level1Summary: row.level1_summary || undefined,
      level2Essential: row.level2_essential || undefined,
      level3Keywords: row.level3_keywords || undefined,
      directory: row.directory,
      day: row.day,
      keywords: JSON.parse(row.keywords),
      sessionId: row.session_id,
      memoryType: (row.memory_type || 'semantic') as MemoryType,
      createdAt: new Date(row.created_at),
      lastRecalled: row.last_recalled ? new Date(row.last_recalled) : undefined,
      recallCount: row.recall_count,
      decayRate: row.decay_rate,
      currentLevel: row.current_level as DecayLevel,
      saillance: row.saillance,
      mergedIntoId: row.merged_into_id || undefined,
      photographic: Boolean(row.photographic),
      // Phase 6.0.1 — trust layer
      source: row.source || undefined,
      agent: row.agent || undefined,
      verified: Boolean(row.verified),
      verificationReason: (row.verification_reason || undefined) as VerificationReason | undefined,
      device: row.device || undefined,
      refutedCount: row.refuted_count ?? 0,
    };
  }

  private memoryToRow(memory: Memory): any {
    return {
      $id: memory.id,
      $content: memory.content,
      $level1_summary: memory.level1Summary || null,
      $level2_essential: memory.level2Essential || null,
      $level3_keywords: memory.level3Keywords || null,
      $directory: memory.directory,
      $day: memory.day,
      $keywords: JSON.stringify(memory.keywords),
      $session_id: memory.sessionId,
      $memory_type: memory.memoryType,
      $created_at: memory.createdAt.getTime(),
      $last_recalled: memory.lastRecalled?.getTime() || null,
      $recall_count: memory.recallCount,
      $decay_rate: memory.decayRate,
      $current_level: memory.currentLevel,
      $saillance: memory.saillance,
      $merged_into_id: memory.mergedIntoId || null,
      $photographic: memory.photographic ? 1 : 0,
      $source: memory.source ?? 'agent',
      $agent: memory.agent || null,
      $verified: memory.verified ? 1 : 0,
      $verification_reason: memory.verificationReason || null,
      $device: memory.device || null,
      $refuted_count: memory.refutedCount ?? 0,
    };
  }

  async add(
    memory: Omit<Memory, 'id' | 'createdAt' | 'recallCount' | 'decayRate' | 'currentLevel' | 'saillance'>,
    options: { autoGenerate?: boolean } = {}
  ): Promise<Memory> {
    const id = crypto.randomUUID();
    const now = this.clock.now();

    let generatedLevels = {};
    if (options.autoGenerate && !memory.level1Summary) {
      const memType = (memory.memoryType || 'semantic') as MemoryType;
      generatedLevels = await generateMemoryLevels(memory.content, memType);
    }

    const fullMemory: Memory = {
      ...{ memoryType: 'semantic' as MemoryType, photographic: false },
      ...memory,
      ...generatedLevels,
      id,
      createdAt: now,
      recallCount: 0,
      decayRate: calculateDecayRate(memory.content, memory.keywords),
      currentLevel: 0,
      saillance: calculateSaillance({ ...memory, id, createdAt: now, recallCount: 0, decayRate: 0.5 } as Memory, now),
      // Phase 6.0.1 — provenance defaults
      source: memory.source ?? 'agent',
      verified: memory.verified ?? false,
      refutedCount: memory.refutedCount ?? 0,
      device: memory.device ?? this.deviceId,
    };

    const row = this.memoryToRow(fullMemory);
    await this.enqueueWriteWithLock(async () => {
      this.db.query(`
        INSERT INTO memories (
          id, content, level1_summary, level2_essential, level3_keywords,
          directory, day, keywords, session_id, memory_type, created_at, last_recalled,
          recall_count, decay_rate, current_level, saillance, merged_into_id, photographic,
          source, agent, verified, verification_reason, device, refuted_count
        ) VALUES (
          $id, $content, $level1_summary, $level2_essential, $level3_keywords,
          $directory, $day, $keywords, $session_id, $memory_type, $created_at, $last_recalled,
          $recall_count, $decay_rate, $current_level, $saillance, $merged_into_id, $photographic,
          $source, $agent, $verified, $verification_reason, $device, $refuted_count
        )
      `).run(row);
      this.searchEngine.add(fullMemory);
    });
    return fullMemory;
  }

  async getById(id: string): Promise<Memory | null> {
    const row = this.db.query('SELECT * FROM memories WHERE id = $id').get({ $id: id }) as any;
    if (!row) return null;
    return this.rowToMemory(row);
  }

  async search(query: SearchQuery): Promise<SearchResult[]> {
    return this.searchEngine.search(query);
  }

  async recall(id: string, agent?: string, options: RecallOptions = {}): Promise<Memory> {
    const now = this.clock.now();
    const before = await this.getById(id);
    if (!before) throw new Error(`Memory ${id} not found`);

    // Phase 6.0.1 — cross-agent reuse earns verification: a trace written by
    // agent X recalled by agent Y proved useful across the boundary.
    //
    // This only holds if `agent` is a *fact*, not a claim. Attribution and
    // authentication are different things: a caller that names itself cannot
    // also vouch for itself, or verification is self-service. So earning
    // requires `identityTrusted` — set by callers whose identity comes from
    // the process (MCP stdio: one server per client, agent id from the
    // environment; CLI: a human at a terminal), and NOT by the HTTP API,
    // where `X-Humemory-Agent` is an unauthenticated header anyone may send.
    // Untrusted callers still get attribution and reinforcement, just no trust.
    const reused =
      options.identityTrusted === true &&
      agent !== undefined &&
      before.agent !== undefined &&
      agent !== before.agent;

    await this.enqueueWriteWithLock(async () => {
      this.db.query(`
        UPDATE memories
        SET last_recalled = $last_recalled,
            recall_count = recall_count + 1,
            saillance = $saillance
        WHERE id = $id
      `).run({ $id: id, $last_recalled: now.getTime(), $saillance: 100 });
      if (reused && !before.verified) {
        this.db.query(`
          UPDATE memories SET verified = 1, verification_reason = 'reused' WHERE id = $id
        `).run({ $id: id });
      }
    });
    const memory = await this.getById(id);
    if (!memory) throw new Error(`Memory ${id} not found`);
    this.searchEngine.update(memory);
    return memory;
  }

  /**
   * Phase 6.0.1 — human override verification (`pnpm cli verify <id>`).
   * Automatic paths (reused/grounded/corroborated) set the flag directly.
   */
  async verify(id: string, by: string = 'human'): Promise<Memory> {
    const memory = await this.getById(id);
    if (!memory) throw new Error(`Memory ${id} not found`);
    // Validate rather than cast: the reason decides the trust bonus (+8 to
    // +25) and whether the trace renders bare in the context block, so an
    // unchecked string here would let a caller pick its own weight.
    if (!VERIFICATION_REASONS.includes(by as VerificationReason)) {
      throw new Error(
        `Invalid verification reason "${by}" — expected one of: ${VERIFICATION_REASONS.join(', ')}`
      );
    }
    const reason = by as VerificationReason;
    await this.enqueueWriteWithLock(async () => {
      this.db.query(`
        UPDATE memories SET verified = 1, verification_reason = $reason WHERE id = $id
      `).run({ $id: id, $reason: reason });
    });
    const updated = await this.getById(id);
    this.searchEngine.update(updated!);
    return updated!;
  }

  /**
   * Phase 6.0.1 — negative signal without a full contradiction (6.0.2):
   * increments refuted_count (feeds the trust score) and revokes any earned
   * verification — a refuted trace must be re-earned, not remembered.
   */
  async refute(id: string, _reason?: string): Promise<Memory> {
    const memory = await this.getById(id);
    if (!memory) throw new Error(`Memory ${id} not found`);
    await this.enqueueWriteWithLock(async () => {
      this.db.query(`
        UPDATE memories
        SET refuted_count = refuted_count + 1,
            verified = 0,
            verification_reason = NULL
        WHERE id = $id
      `).run({ $id: id });
    });
    const updated = await this.getById(id);
    this.searchEngine.update(updated!);
    return updated!;
  }

  async updateDecay(): Promise<void> {
    const memories = this.searchEngine.getAll();
    const updated = updateAllDecay(memories, this.clock.now());

    const updateStmt = this.db.query(`
      UPDATE memories
      SET current_level = $current_level, saillance = $saillance
      WHERE id = $id
    `);

    const updateMany = this.db.transaction((memories: Memory[]) => {
      for (const memory of memories) {
        updateStmt.run({ $id: memory.id, $current_level: memory.currentLevel, $saillance: memory.saillance });
      }
    });

    await this.enqueueWriteWithLock(async () => {
      updateMany(updated);
      this.searchEngine.clear();
      for (const memory of updated) {
        this.searchEngine.add(memory);
      }
    });
  }

  async delete(id: string): Promise<void> {
    await this.enqueueWriteWithLock(async () => {
      this.db.query('DELETE FROM memories WHERE id = $id').run({ $id: id });
      this.searchEngine.remove(id);
    });
  }

  async list(options?: {
    limit?: number;
    level?: DecayLevel;
    levels?: DecayLevel[];
    type?: MemoryType;
    directory?: string;
    minSaillance?: number;
  }): Promise<Memory[]> {
    const { limit = 50, level, levels, type, directory, minSaillance } = options || {};

    let sql = 'SELECT * FROM memories';
    const conditions: string[] = [];
    const params: any = {};

    if (level !== undefined) {
      conditions.push('current_level = $level');
      params.$level = level;
    }

    if (levels !== undefined && levels.length > 0) {
      // Placeholders generated from the index, values bound — no concatenated SQL.
      const keys = levels.map((l, i) => {
        params[`$level_in${i}`] = l;
        return `$level_in${i}`;
      });
      conditions.push(`current_level IN (${keys.join(', ')})`);
    }

    if (type !== undefined) {
      conditions.push('memory_type = $type');
      params.$type = type;
    }

    if (directory !== undefined) {
      conditions.push('directory = $directory');
      params.$directory = directory;
    }

    if (minSaillance !== undefined) {
      conditions.push('saillance >= $min_saillance');
      params.$min_saillance = minSaillance;
    }

    if (conditions.length > 0) {
      sql += ' WHERE ' + conditions.join(' AND ');
    }

    sql += ' ORDER BY created_at DESC LIMIT $limit';
    params.$limit = limit;

    const rows = this.db.query(sql).all(params) as any[];
    return rows.map(row => this.rowToMemory(row));
  }

  async setPhotographic(id: string, value: boolean): Promise<Memory> {
    await this.enqueueWriteWithLock(async () => {
      this.db.query('UPDATE memories SET photographic = $val WHERE id = $id')
        .run({ $val: value ? 1 : 0, $id: id });
    });
    const memory = await this.getById(id);
    if (!memory) throw new Error(`Memory ${id} not found`);
    this.searchEngine.update(memory);
    return memory;
  }

  async findSimilar(id: string, options: { limit?: number; threshold?: number } = {}): Promise<SearchResult[]> {
    const { limit = 5, threshold = 50 } = options;
    const memory = await this.getById(id);
    if (!memory) throw new Error(`Memory ${id} not found`);

    // Use first keyword for FlexSearch (multi-word AND would be too restrictive)
    const kwSource = memory.level3Keywords || memory.keywords.join(' ') || memory.content;
    const query = kwSource.split(/\s+/)[0] || kwSource.slice(0, 50);
    const results = await this.search({
      query,
      directory: memory.directory,
      limit: limit + 1,
    });

    return results
      .filter(r => r.memory.id !== id && r.score >= threshold)
      .slice(0, limit);
  }

  async merge(
    sourceId: string,
    targetId: string,
    options: { autoMergeContent?: boolean; client?: LLMClient } = {}
  ): Promise<MergeResult> {
    const source = await this.getById(sourceId);
    const target = await this.getById(targetId);
    if (!source) throw new Error(`Source memory ${sourceId} not found`);
    if (!target) throw new Error(`Target memory ${targetId} not found`);

    let mergedContent: string | undefined;

    if (options.autoMergeContent) {
      const combinedContent = `[Trace 1]\n${source.content}\n\n[Trace 2]\n${target.content}`;
      const levels = await generateMemoryLevels(combinedContent, target.memoryType, options.client);
      mergedContent = levels.level1Summary;

      await this.enqueueWriteWithLock(async () => {
        this.revisionSnapshot(targetId, 'merge');
        this.db.query(`
          UPDATE memories
          SET level1_summary = $level1_summary,
              level2_essential = $level2_essential,
              level3_keywords = $level3_keywords,
              saillance = MIN(100, saillance + $bonus),
              recall_count = recall_count + $source_recalls
          WHERE id = $id
        `).run({
          $id: targetId,
          $level1_summary: levels.level1Summary,
          $level2_essential: levels.level2Essential,
          $level3_keywords: levels.level3Keywords,
          $bonus: Math.floor(source.saillance * 0.3),
          $source_recalls: source.recallCount,
        });
        this.db.query(`
          UPDATE memories SET current_level = 4, merged_into_id = $target_id WHERE id = $id
        `).run({ $id: sourceId, $target_id: targetId });
        this.searchEngine.remove(sourceId);
      });
    } else {
      await this.enqueueWriteWithLock(async () => {
        this.db.query(`
          UPDATE memories
          SET saillance = MIN(100, saillance + $bonus),
              recall_count = recall_count + $source_recalls
          WHERE id = $id
        `).run({
          $id: targetId,
          $bonus: Math.floor(source.saillance * 0.3),
          $source_recalls: source.recallCount,
        });
        this.db.query(`
          UPDATE memories SET current_level = 4, merged_into_id = $target_id WHERE id = $id
        `).run({ $id: sourceId, $target_id: targetId });
        this.searchEngine.remove(sourceId);
      });
    }

    const updatedTarget = await this.getById(targetId);
    if (updatedTarget) this.searchEngine.update(updatedTarget);

    const updatedSource = await this.getById(sourceId);
    return {
      source: updatedSource!,
      target: updatedTarget!,
      mergedContent,
    };
  }

  /**
   * Phase 6.0.4 — revert a merge: the source trace is resurrected (level and
   * saillance recomputed, not literally restored — decayed time does not come
   * back), and the target gets its last revised levels back when a revision
   * exists.
   */
  async unmerge(sourceId: string): Promise<{ source: Memory; target: Memory }> {
    const source = await this.getById(sourceId);
    if (!source) throw new Error(`Source memory ${sourceId} not found`);
    if (!source.mergedIntoId) throw new Error(`Memory ${sourceId} is not merged`);
    const targetId = source.mergedIntoId;
    const target = await this.getById(targetId);
    if (!target) throw new Error(`Merge target ${targetId} not found`);

    const now = this.clock.now();
    await this.enqueueWriteWithLock(async () => {
      // Resurrect the source: recompute from its own content and age.
      const resurrected: Memory = { ...source, currentLevel: 0, mergedIntoId: undefined };
      const level = calculateDecayLevel(resurrected, now);
      const saillance = calculateSaillance(resurrected, now);
      this.db
        .query(
          `UPDATE memories SET current_level = $level, saillance = $saillance, merged_into_id = NULL
           WHERE id = $id`
        )
        .run({ $id: sourceId, $level: level, $saillance: saillance });

      // Restore the target's pre-merge derived levels, if we have them.
      const revision = this.db
        .query(
          `SELECT * FROM level_revisions WHERE memory_id = $id ORDER BY replaced_at DESC LIMIT 1`
        )
        .get({ $id: targetId }) as any;
      if (revision) {
        this.db
          .query(
            `UPDATE memories SET level1_summary = $l1, level2_essential = $l2, level3_keywords = $l3
             WHERE id = $id`
          )
          .run({
            $id: targetId,
            $l1: revision.level1_summary,
            $l2: revision.level2_essential,
            $l3: revision.level3_keywords,
          });
        this.db.query('DELETE FROM level_revisions WHERE id = $id').run({ $id: revision.id });
      }
    });

    const finalSource = await this.getById(sourceId);
    const finalTarget = await this.getById(targetId);
    this.searchEngine.add(finalSource!);
    this.searchEngine.update(finalTarget!);
    return { source: finalSource!, target: finalTarget! };
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Trust layer (Phase 6.0.2) — contradictions
  // ───────────────────────────────────────────────────────────────────────────

  /**
   * `winnerId` contradicts `loserId`. The loser collapses (÷4, floor 5; ÷2 on
   * further refutations, cap 3) and loses any earned verification — but is
   * never deleted. Cycles are allowed: last write wins, no transitivity is
   * ever inferred.
   */
  async contradict(
    winnerId: string,
    loserId: string,
    options: { reason?: string; createdBy?: 'agent' | 'human' | 'dreamer'; agent?: string } = {}
  ): Promise<ContradictResult> {
    const winner = await this.getById(winnerId);
    if (!winner) throw new Error(`Winner memory ${winnerId} not found`);
    let loser = await this.getById(loserId);
    if (!loser) throw new Error(`Loser memory ${loserId} not found`);

    // Merged loser: the collapse targets the merge target, and the caller warns.
    let retargetedTo: string | undefined;
    if (loser.mergedIntoId) {
      retargetedTo = loser.mergedIntoId;
      loserId = loser.mergedIntoId;
      loser = (await this.getById(loserId))!;
      if (!loser) throw new Error(`Merge target ${retargetedTo} not found`);
    }

    // Asymmetric authority (Claude R2): an unverified winner cannot contradict
    // a human/grounded-verified loser outright — it files a proposal instead.
    // Traces verified only by corroborated/reused stay directly contradictable.
    const winnerStrong = winner.verified && (winner.verificationReason === 'human' || winner.verificationReason === 'grounded');
    const loserProtected = loser.verified && (loser.verificationReason === 'human' || loser.verificationReason === 'grounded');
    if (loserProtected && !winnerStrong && options.createdBy !== 'human') {
      const hash = createHash('sha1')
        .update(['contradiction', winnerId, loserId].sort().join('|'))
        .digest('hex');
      await this.enqueueWriteWithLock(async () => {
        this.db
          .query(
            `INSERT OR IGNORE INTO dream_proposals (id, kind, payload, payload_hash, status, confidence, created_at)
             VALUES ($id, 'contradiction', $payload, $hash, 'pending', 0, $at)`
          )
          .run({
            $id: crypto.randomUUID(),
            $payload: JSON.stringify({ winnerId, loserId, reason: options.reason, filedBy: options.agent }),
            $hash: hash,
            $at: this.clock.now().getTime(),
          });
      });
      return { proposalFiled: true, retargetedTo, loser };
    }

    const now = this.clock.now();
    const refutations = Math.min((loser.refutedCount ?? 0) + 1, DECAY_CONFIG.refuteCap);
    const divisor = (loser.refutedCount ?? 0) === 0 ? DECAY_CONFIG.contradictionDivisor : DECAY_CONFIG.refuteDivisor;
    const newSaillance = Math.max(DECAY_CONFIG.contradictionFloor, Math.floor(loser.saillance / divisor));

    const contradiction: Contradiction = {
      id: crypto.randomUUID(),
      winnerId,
      loserId,
      reason: options.reason,
      createdAt: now,
      createdBy: options.createdBy ?? 'agent',
      agent: options.agent,
      status: 'active',
    };

    await this.enqueueWriteWithLock(async () => {
      this.db
        .query(
          `INSERT INTO contradictions (id, winner_id, loser_id, reason, created_at, created_by, agent, status)
           VALUES ($id, $winner, $loser, $reason, $at, $by, $agent, 'active')`
        )
        .run({
          $id: contradiction.id,
          $winner: winnerId,
          $loser: loserId,
          $reason: options.reason ?? null,
          $at: now.getTime(),
          $by: contradiction.createdBy,
          $agent: options.agent ?? null,
        });
      this.db
        .query(
          `UPDATE memories
           SET saillance = $saillance, refuted_count = $refuted, verified = 0, verification_reason = NULL
           WHERE id = $id`
        )
        .run({ $id: loserId, $saillance: newSaillance, $refuted: refutations });
    });

    const updatedLoser = await this.getById(loserId);
    this.searchEngine.update(updatedLoser!);
    return { contradiction, retargetedTo, loser: updatedLoser! };
  }

  /** Revocation recomputes the loser's saillance — decayed time does not come back. */
  async revokeContradiction(id: string): Promise<Contradiction> {
    const row = this.db.query('SELECT * FROM contradictions WHERE id = $id').get({ $id: id }) as any;
    if (!row) throw new Error(`Contradiction ${id} not found`);

    const loser = await this.getById(row.loser_id);
    await this.enqueueWriteWithLock(async () => {
      this.db.query(`UPDATE contradictions SET status = 'revoked' WHERE id = $id`).run({ $id: id });
      if (loser) {
        const recomputed = calculateSaillance(loser, this.clock.now());
        this.db.query('UPDATE memories SET saillance = $s WHERE id = $id').run({ $id: loser.id, $s: recomputed });
      }
    });
    if (loser) this.searchEngine.update((await this.getById(loser.id))!);

    const updated = this.db.query('SELECT * FROM contradictions WHERE id = $id').get({ $id: id }) as any;
    return this.rowToContradiction(updated);
  }

  async listContradictions(options: { loserId?: string; status?: 'active' | 'revoked' } = {}): Promise<Contradiction[]> {
    const conditions: string[] = [];
    const params: any = {};
    if (options.loserId) {
      conditions.push('loser_id = $loser');
      params.$loser = options.loserId;
    }
    if (options.status) {
      conditions.push('status = $status');
      params.$status = options.status;
    }
    const sql = 'SELECT * FROM contradictions' + (conditions.length ? ` WHERE ${conditions.join(' AND ')}` : '');
    const rows = this.db.query(sql).all(params) as any[];
    return rows.map((r) => this.rowToContradiction(r));
  }

  private rowToContradiction(row: any): Contradiction {
    return {
      id: row.id,
      winnerId: row.winner_id,
      loserId: row.loser_id,
      reason: row.reason || undefined,
      createdAt: new Date(row.created_at),
      createdBy: row.created_by,
      agent: row.agent || undefined,
      status: row.status,
    };
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Dreaming (Phase 6.1) — proposals
  // ───────────────────────────────────────────────────────────────────────────

  private rowToDream(row: any): DreamProposal {
    return {
      id: row.id,
      kind: row.kind,
      payload: row.payload,
      payloadHash: row.payload_hash,
      status: row.status,
      confidence: row.confidence,
      createdAt: new Date(row.created_at),
      expiresAt: row.expires_at ? new Date(row.expires_at) : undefined,
      resolvedAt: row.resolved_at ? new Date(row.resolved_at) : undefined,
      resolvedBy: row.resolved_by || undefined,
    };
  }

  async fileDreamProposal(p: {
    kind: DreamKind;
    payload: string;
    payloadHash: string;
    confidence?: number;
    expiresAt?: Date;
  }): Promise<boolean> {
    let inserted = false;
    await this.enqueueWriteWithLock(async () => {
      const res = this.db
        .query(
          `INSERT OR IGNORE INTO dream_proposals (id, kind, payload, payload_hash, status, confidence, created_at, expires_at)
           VALUES ($id, $kind, $payload, $hash, 'pending', $conf, $at, $exp)`
        )
        .run({
          $id: crypto.randomUUID(),
          $kind: p.kind,
          $payload: p.payload,
          $hash: p.payloadHash,
          $conf: p.confidence ?? 0,
          $at: this.clock.now().getTime(),
          $exp: p.expiresAt?.getTime() ?? null,
        });
      inserted = res.changes > 0;
    });
    return inserted;
  }

  async listDreamProposals(options: { status?: DreamStatus; includeExpired?: boolean } = {}): Promise<DreamProposal[]> {
    const conditions: string[] = [];
    const params: any = {};
    if (options.status) {
      conditions.push('status = $status');
      params.$status = options.status;
    }
    if (!options.includeExpired) {
      conditions.push("(expires_at IS NULL OR expires_at > $now OR status != 'pending')");
      params.$now = this.clock.now().getTime();
    }
    const sql =
      'SELECT * FROM dream_proposals' + (conditions.length ? ` WHERE ${conditions.join(' AND ')}` : '') +
      ' ORDER BY confidence DESC, created_at DESC';
    return (this.db.query(sql).all(params) as any[]).map((r) => this.rowToDream(r));
  }

  async resolveDreamProposal(id: string, status: 'approved' | 'rejected', resolvedBy?: string): Promise<DreamProposal> {
    const row = this.db.query('SELECT * FROM dream_proposals WHERE id = $id').get({ $id: id }) as any;
    if (!row) throw new Error(`Dream proposal ${id} not found`);
    if (row.status !== 'pending') throw new Error(`Dream proposal ${id} is ${row.status}, not pending`);
    await this.enqueueWriteWithLock(async () => {
      this.db
        .query('UPDATE dream_proposals SET status = $s, resolved_at = $at, resolved_by = $by WHERE id = $id')
        .run({ $s: status, $at: this.clock.now().getTime(), $by: resolvedBy ?? 'cli', $id: id });
    });
    return this.rowToDream(this.db.query('SELECT * FROM dream_proposals WHERE id = $id').get({ $id: id }));
  }

  async expireDreamProposals(): Promise<number> {
    let count = 0;
    await this.enqueueWriteWithLock(async () => {
      const res = this.db
        .query(
          `UPDATE dream_proposals SET status = 'expired'
           WHERE status = 'pending' AND expires_at IS NOT NULL AND expires_at <= $now`
        )
        .run({ $now: this.clock.now().getTime() });
      count = res.changes;
    });
    return count;
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Prospective memory (Phase 5.1) — intentions and cues
  // Data layer only: arm, list, change status. The firing logic
  // (resolveTimeCues / resolveEventCues / expireStale) is Phase 5.2, in
  // src/core/cues.ts.
  // ───────────────────────────────────────────────────────────────────────────

  private rowToIntention(row: any): Intention {
    return {
      id: row.id,
      content: row.content,
      directory: row.directory,
      createdAt: new Date(row.created_at),
      expiresAt: row.expires_at ? new Date(row.expires_at) : undefined,
      status: row.status as IntentionStatus,
      firedAt: row.fired_at ? new Date(row.fired_at) : undefined,
      closedAt: row.closed_at ? new Date(row.closed_at) : undefined,
      closedByCommit: row.closed_by_commit || undefined,
      saillance: row.saillance,
      relatedMemoryId: row.related_memory_id || undefined,
      // Phase 6.0.1 — trust layer
      source: row.source || undefined,
      agent: row.agent || undefined,
      verified: Boolean(row.verified),
      verificationReason: (row.verification_reason || undefined) as VerificationReason | undefined,
      device: row.device || undefined,
    };
  }

  private rowToCue(row: any): Cue {
    return {
      id: row.id,
      intentionId: row.intention_id,
      kind: row.kind as CueKind,
      triggerSpec: JSON.parse(row.trigger_spec) as TriggerSpec,
      status: row.status as CueStatus,
      armedAt: new Date(row.armed_at),
      firedAt: row.fired_at ? new Date(row.fired_at) : undefined,
    };
  }

  /**
   * Arms an intention, and optionally its cues in the same breath — both writes
   * go through the same lock, so an intention can never be observed without the
   * cues meant to wake it.
   */
  async addIntention(intention: NewIntention, cues: TriggerSpec[] = []): Promise<Intention> {
    const id = crypto.randomUUID();
    const now = this.clock.now();

    const full: Intention = {
      id,
      content: intention.content,
      directory: intention.directory,
      createdAt: now,
      expiresAt: intention.expiresAt,
      status: intention.status ?? 'armed',
      saillance: intention.saillance ?? 100,
      relatedMemoryId: intention.relatedMemoryId,
      // Phase 6.0.1 — provenance defaults
      source: intention.source ?? 'agent',
      agent: intention.agent,
      verified: intention.verified ?? false,
      device: intention.device ?? this.deviceId,
    };

    await this.enqueueWriteWithLock(async () => {
      this.db
        .query(
          `INSERT INTO intentions (id, content, directory, created_at, expires_at, status, saillance, related_memory_id,
                                   source, agent, verified, verification_reason, device)
           VALUES ($id, $content, $directory, $created_at, $expires_at, $status, $saillance, $related_memory_id,
                   $source, $agent, $verified, $verification_reason, $device)`
        )
        .run({
          $id: full.id,
          $content: full.content,
          $directory: full.directory,
          $created_at: now.getTime(),
          $expires_at: full.expiresAt?.getTime() ?? null,
          $status: full.status,
          $saillance: full.saillance,
          $related_memory_id: full.relatedMemoryId ?? null,
          $source: full.source ?? 'agent',
          $agent: full.agent ?? null,
          $verified: full.verified ? 1 : 0,
          $verification_reason: full.verificationReason ?? null,
          $device: full.device ?? null,
        });

      for (const spec of cues) {
        this.insertCueRow(crypto.randomUUID(), full.id, spec, 'armed', now);
      }
    });

    return full;
  }

  private insertCueRow(
    id: string,
    intentionId: string,
    spec: TriggerSpec,
    status: CueStatus,
    armedAt: Date
  ): void {
    this.db
      .query(
        `INSERT INTO cues (id, intention_id, kind, trigger_spec, status, armed_at)
         VALUES ($id, $intention_id, $kind, $trigger_spec, $status, $armed_at)`
      )
      .run({
        $id: id,
        $intention_id: intentionId,
        $kind: spec.kind,
        $trigger_spec: JSON.stringify(spec),
        $status: status,
        $armed_at: armedAt.getTime(),
      });
  }

  async getIntention(id: string): Promise<Intention | null> {
    const row = this.db.query('SELECT * FROM intentions WHERE id = $id').get({ $id: id }) as any;
    return row ? this.rowToIntention(row) : null;
  }

  async listIntentions(
    options: { status?: IntentionStatus | IntentionStatus[]; directory?: string; limit?: number } = {}
  ): Promise<Intention[]> {
    const { status, directory, limit = 50 } = options;
    const conditions: string[] = [];
    const params: any = {};

    if (status !== undefined) {
      const statuses = Array.isArray(status) ? status : [status];
      // Named placeholders generated from the index, never from the value — the
      // status stays a bound value, not concatenated SQL.
      const keys = statuses.map((s, i) => {
        params[`$status${i}`] = s;
        return `$status${i}`;
      });
      conditions.push(`status IN (${keys.join(', ')})`);
    }

    if (directory !== undefined) {
      conditions.push('directory = $directory');
      params.$directory = directory;
    }

    let sql = 'SELECT * FROM intentions';
    if (conditions.length) sql += ` WHERE ${conditions.join(' AND ')}`;
    sql += ' ORDER BY created_at DESC LIMIT $limit';
    params.$limit = limit;

    const rows = this.db.query(sql).all(params) as any[];
    return rows.map((r) => this.rowToIntention(r));
  }

  /**
   * Status transitions. Timestamps come from the injected clock: `fired` sets
   * `fired_at`, `closed` sets `closed_at` (plus the SHA when given). `expired` is
   * a soft delete — the row stays, for the record.
   */
  async updateIntentionStatus(
    id: string,
    status: IntentionStatus,
    options: { closedByCommit?: string } = {}
  ): Promise<Intention> {
    const now = this.clock.now();

    await this.enqueueWriteWithLock(async () => {
      this.db
        .query(
          `UPDATE intentions
              SET status = $status,
                  fired_at = CASE WHEN $status = 'fired' AND fired_at IS NULL THEN $now ELSE fired_at END,
                  closed_at = CASE WHEN $status = 'closed' THEN $now ELSE closed_at END,
                  closed_by_commit = COALESCE($commit, closed_by_commit)
            WHERE id = $id`
        )
        .run({ $id: id, $status: status, $now: now.getTime(), $commit: options.closedByCommit ?? null });
    });

    const intention = await this.getIntention(id);
    if (!intention) throw new Error(`Intention ${id} not found`);
    return intention;
  }

  /** Deletes the intention; its cues go with it (PRAGMA foreign_keys=ON). */
  async deleteIntention(id: string): Promise<void> {
    await this.enqueueWriteWithLock(async () => {
      this.db.query('DELETE FROM intentions WHERE id = $id').run({ $id: id });
    });
  }

  async addCue(cue: NewCue): Promise<Cue> {
    const intention = await this.getIntention(cue.intentionId);
    if (!intention) throw new Error(`Intention ${cue.intentionId} not found`);

    const id = crypto.randomUUID();
    const now = this.clock.now();
    const status = cue.status ?? 'armed';

    await this.enqueueWriteWithLock(async () => {
      this.insertCueRow(id, cue.intentionId, cue.triggerSpec, status, now);
    });

    return {
      id,
      intentionId: cue.intentionId,
      kind: cue.triggerSpec.kind,
      triggerSpec: cue.triggerSpec,
      status,
      armedAt: now,
    };
  }

  async getCue(id: string): Promise<Cue | null> {
    const row = this.db.query('SELECT * FROM cues WHERE id = $id').get({ $id: id }) as any;
    return row ? this.rowToCue(row) : null;
  }

  async listCues(
    options: { intentionId?: string; status?: CueStatus | CueStatus[]; kind?: CueKind; limit?: number } = {}
  ): Promise<Cue[]> {
    const { intentionId, status, kind, limit = 50 } = options;
    const conditions: string[] = [];
    const params: any = {};

    if (intentionId !== undefined) {
      conditions.push('intention_id = $intention_id');
      params.$intention_id = intentionId;
    }

    if (status !== undefined) {
      const statuses = Array.isArray(status) ? status : [status];
      const keys = statuses.map((s, i) => {
        params[`$status${i}`] = s;
        return `$status${i}`;
      });
      conditions.push(`status IN (${keys.join(', ')})`);
    }

    if (kind !== undefined) {
      conditions.push('kind = $kind');
      params.$kind = kind;
    }

    let sql = 'SELECT * FROM cues';
    if (conditions.length) sql += ` WHERE ${conditions.join(' AND ')}`;
    sql += ' ORDER BY armed_at ASC LIMIT $limit';
    params.$limit = limit;

    const rows = this.db.query(sql).all(params) as any[];
    return rows.map((r) => this.rowToCue(r));
  }

  /**
   * Marks a cue as fired. `rearm: true` leaves it `armed` while still recording
   * `fired_at` — what a recurring (cron) cue needs: without it, a recurrence would
   * be a one-shot in disguise.
   */
  async markCueFired(id: string, options: { rearm?: boolean } = {}): Promise<Cue> {
    const now = this.clock.now();
    const status: CueStatus = options.rearm ? 'armed' : 'fired';

    await this.enqueueWriteWithLock(async () => {
      this.db
        .query('UPDATE cues SET status = $status, fired_at = $now WHERE id = $id')
        .run({ $id: id, $status: status, $now: now.getTime() });
    });

    const cue = await this.getCue(id);
    if (!cue) throw new Error(`Cue ${id} not found`);
    return cue;
  }

  async updateCueStatus(id: string, status: CueStatus): Promise<Cue> {
    const now = this.clock.now();

    await this.enqueueWriteWithLock(async () => {
      this.db
        .query(
          `UPDATE cues
              SET status = $status,
                  fired_at = CASE WHEN $status = 'fired' AND fired_at IS NULL THEN $now ELSE fired_at END
            WHERE id = $id`
        )
        .run({ $id: id, $status: status, $now: now.getTime() });
    });

    const cue = await this.getCue(id);
    if (!cue) throw new Error(`Cue ${id} not found`);
    return cue;
  }

  close(): void {
    this.db.close();
  }
}
