import { Database } from 'bun:sqlite';
import { join } from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';
import type { Memory, SearchQuery, SearchResult, DecayLevel, MemoryStore, MemoryType, MergeResult } from '../core/types.js';
import { calculateDecayLevel, calculateSaillance, calculateDecayRate, updateAllDecay } from '../core/decay.js';
import { InverseSearchEngine } from '../core/search.js';
import { generateMemoryLevels, type LLMClient } from '../core/llm-generator.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

export class SQLiteStore implements MemoryStore {
  private db: Database;
  private searchEngine: InverseSearchEngine;
  private writeQueue: Promise<any> = Promise.resolve();

  private enqueueWrite<T>(fn: () => T | Promise<T>): Promise<T> {
    this.writeQueue = this.writeQueue.then(() => fn(), () => fn());
    return this.writeQueue as Promise<T>;
  }

  constructor(dbPath: string = join(__dirname, '../../data/humemory.db')) {
    this.db = new Database(dbPath);
    this.db.exec('PRAGMA journal_mode=WAL');
    this.db.exec('PRAGMA busy_timeout=5000');
    this.db.exec('PRAGMA synchronous=NORMAL');
    this.db.exec('PRAGMA cache_size=-16000');
    this.searchEngine = new InverseSearchEngine();
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
    const now = new Date();

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
    await this.enqueueWrite(() => {
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
    const now = new Date();
    await this.enqueueWrite(() => {
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
    const updated = updateAllDecay(memories);

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

    await this.enqueueWrite(() => {
      updateMany(updated);
      this.searchEngine.clear();
      for (const memory of updated) {
        this.searchEngine.add(memory);
      }
    });
  }

  async delete(id: string): Promise<void> {
    await this.enqueueWrite(() => {
      this.db.query('DELETE FROM memories WHERE id = $id').run({ $id: id });
      this.searchEngine.remove(id);
    });
  }

  async list(options?: { limit?: number; level?: DecayLevel; type?: MemoryType }): Promise<Memory[]> {
    const { limit = 50, level, type } = options || {};

    let sql = 'SELECT * FROM memories';
    const conditions: string[] = [];
    const params: any = {};

    if (level !== undefined) {
      conditions.push('current_level = $level');
      params.$level = level;
    }

    if (type !== undefined) {
      conditions.push('memory_type = $type');
      params.$type = type;
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
    await this.enqueueWrite(() => {
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

      await this.enqueueWrite(() => {
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
      await this.enqueueWrite(() => {
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

  close(): void {
    this.db.close();
  }
}
