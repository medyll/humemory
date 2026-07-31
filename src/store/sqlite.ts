import { Database } from 'bun:sqlite';
import { join, resolve } from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';
import { openSync, closeSync, unlinkSync, existsSync } from 'fs';
import type {
  Memory, SearchQuery, SearchResult, DecayLevel, MemoryStore, MemoryType, MergeResult,
  Intention, IntentionStatus, IntentionStore, NewIntention,
  Cue, CueKind, CueStatus, NewCue, TriggerSpec,
} from '../core/types.js';
import { calculateDecayLevel, calculateSaillance, calculateDecayRate, updateAllDecay } from '../core/decay.js';
import { InverseSearchEngine } from '../core/search.js';
import { generateMemoryLevels, type LLMClient } from '../core/llm-generator.js';
import { systemClock, type Clock } from '../core/clock.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const DEFAULT_DB_PATH = join(__dirname, '../../data/humemory.db');

export interface StoreOptions {
  /** Time source. Defaults to `systemClock`; tests pass a `FakeClock`. */
  clock?: Clock;
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

    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_directory ON memories(directory);
      CREATE INDEX IF NOT EXISTS idx_session ON memories(session_id);
      CREATE INDEX IF NOT EXISTS idx_level ON memories(current_level);
      CREATE INDEX IF NOT EXISTS idx_day ON memories(day);
      CREATE INDEX IF NOT EXISTS idx_type ON memories(memory_type);
    `);

    this.initProspectiveSchema();
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
    };

    const row = this.memoryToRow(fullMemory);
    await this.enqueueWriteWithLock(async () => {
      this.db.query(`
        INSERT INTO memories (
          id, content, level1_summary, level2_essential, level3_keywords,
          directory, day, keywords, session_id, memory_type, created_at, last_recalled,
          recall_count, decay_rate, current_level, saillance, merged_into_id, photographic
        ) VALUES (
          $id, $content, $level1_summary, $level2_essential, $level3_keywords,
          $directory, $day, $keywords, $session_id, $memory_type, $created_at, $last_recalled,
          $recall_count, $decay_rate, $current_level, $saillance, $merged_into_id, $photographic
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

  async recall(id: string): Promise<Memory> {
    const now = this.clock.now();
    await this.enqueueWriteWithLock(async () => {
      this.db.query(`
        UPDATE memories
        SET last_recalled = $last_recalled,
            recall_count = recall_count + 1,
            saillance = $saillance
        WHERE id = $id
      `).run({ $id: id, $last_recalled: now.getTime(), $saillance: 100 });
    });
    const memory = await this.getById(id);
    if (!memory) throw new Error(`Memory ${id} not found`);
    this.searchEngine.update(memory);
    return memory;
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
    };

    await this.enqueueWriteWithLock(async () => {
      this.db
        .query(
          `INSERT INTO intentions (id, content, directory, created_at, expires_at, status, saillance, related_memory_id)
           VALUES ($id, $content, $directory, $created_at, $expires_at, $status, $saillance, $related_memory_id)`
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
