import Database from 'better-sqlite3';
import { join } from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';
import type { Memory, SearchQuery, SearchResult, DecayLevel, MemoryStore, MemoryType } from '../core/types.js';
import { calculateDecayLevel, calculateSaillance, calculateDecayRate, updateAllDecay } from '../core/decay.js';
import { InverseSearchEngine } from '../core/search.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/**
 * Store SQLite pour la persistance des souvenirs
 */
export class SQLiteStore implements MemoryStore {
  private db: Database.Database;
  private searchEngine: InverseSearchEngine;

  constructor(dbPath: string = join(__dirname, '../../data/humemory.db')) {
    this.db = new Database(dbPath);
    this.searchEngine = new InverseSearchEngine();
    this.initSchema();
    this.loadIntoMemory();
  }

  /**
   * Initialise le schema SQLite
   */
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
        merged_into_id TEXT
      )
    `);

    // Migration: ajouter memory_type si la colonne n'existe pas
    try {
      this.db.exec("ALTER TABLE memories ADD COLUMN memory_type TEXT NOT NULL DEFAULT 'semantic'");
    } catch (e) {
      // La colonne existe déjà, ignorer
    }

    // Index pour les recherches
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_directory ON memories(directory);
      CREATE INDEX IF NOT EXISTS idx_session ON memories(session_id);
      CREATE INDEX IF NOT EXISTS idx_level ON memories(current_level);
      CREATE INDEX IF NOT EXISTS idx_day ON memories(day);
      CREATE INDEX IF NOT EXISTS idx_type ON memories(memory_type);
    `);
  }

  /**
   * Charge les souvenirs en mémoire pour le search engine
   */
  private loadIntoMemory(): void {
    const rows = this.db.prepare('SELECT * FROM memories').all() as any[];
    for (const row of rows) {
      const memory = this.rowToMemory(row);
      this.searchEngine.add(memory);
    }
  }

  /**
   * Convertit une row SQLite en Memory
   */
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
    };
  }

  /**
   * Convertit Memory en objet pour SQLite
   */
  private memoryToRow(memory: Memory): any {
    return {
      id: memory.id,
      content: memory.content,
      level1_summary: memory.level1Summary || null,
      level2_essential: memory.level2Essential || null,
      level3_keywords: memory.level3Keywords || null,
      directory: memory.directory,
      day: memory.day,
      keywords: JSON.stringify(memory.keywords),
      session_id: memory.sessionId,
      memory_type: memory.memoryType,
      created_at: memory.createdAt.getTime(),
      last_recalled: memory.lastRecalled?.getTime() || null,
      recall_count: memory.recallCount,
      decay_rate: memory.decayRate,
      current_level: memory.currentLevel,
      saillance: memory.saillance,
      merged_into_id: memory.mergedIntoId || null,
    };
  }

  /**
   * Ajoute un nouveau souvenir
   */
  async add(memory: Omit<Memory, 'id' | 'createdAt' | 'recallCount' | 'decayRate' | 'currentLevel' | 'saillance'>): Promise<Memory> {
    const id = crypto.randomUUID();
    const now = new Date();
    
    const fullMemory: Memory = {
      ...memory,
      id,
      createdAt: now,
      recallCount: 0,
      decayRate: calculateDecayRate(memory.content, memory.keywords),
      currentLevel: 0,
      saillance: calculateSaillance({ ...memory, id, createdAt: now, recallCount: 0, decayRate: 0.5 } as Memory, now),
    };

    const row = this.memoryToRow(fullMemory);
    this.db.prepare(`
      INSERT INTO memories (
        id, content, level1_summary, level2_essential, level3_keywords,
        directory, day, keywords, session_id, memory_type, created_at, last_recalled,
        recall_count, decay_rate, current_level, saillance, merged_into_id
      ) VALUES (
        @id, @content, @level1_summary, @level2_essential, @level3_keywords,
        @directory, @day, @keywords, @session_id, @memory_type, @created_at, @last_recalled,
        @recall_count, @decay_rate, @current_level, @saillance, @merged_into_id
      )
    `).run(row);

    this.searchEngine.add(fullMemory);
    return fullMemory;
  }

  /**
   * Récupère un souvenir par ID
   */
  async getById(id: string): Promise<Memory | null> {
    const row = this.db.prepare('SELECT * FROM memories WHERE id = ?').get(id) as any;
    if (!row) return null;
    return this.rowToMemory(row);
  }

  /**
   * Recherche avec le moteur inversé
   */
  async search(query: SearchQuery): Promise<SearchResult[]> {
    return this.searchEngine.search(query);
  }

  /**
   * Rappelle un souvenir (renforcement)
   */
  async recall(id: string): Promise<Memory> {
    const now = new Date();
    
    this.db.prepare(`
      UPDATE memories 
      SET last_recalled = @last_recalled, 
          recall_count = recall_count + 1,
          saillance = @saillance
      WHERE id = @id
    `).run({
      id,
      last_recalled: now.getTime(),
      saillance: 100, // Boost max de saillance
    });

    const memory = await this.getById(id);
    if (!memory) throw new Error(`Memory ${id} not found`);

    // Mettre à jour l'index
    this.searchEngine.update(memory);
    return memory;
  }

  /**
   * Met à jour la dégradation de tous les souvenirs
   */
  async updateDecay(): Promise<void> {
    const memories = this.searchEngine.getAll();
    const updated = updateAllDecay(memories);

    const updateStmt = this.db.prepare(`
      UPDATE memories 
      SET current_level = @current_level, saillance = @saillance
      WHERE id = @id
    `);

    const updateMany = this.db.transaction((memories: Memory[]) => {
      for (const memory of memories) {
        updateStmt.run({
          id: memory.id,
          current_level: memory.currentLevel,
          saillance: memory.saillance,
        });
      }
    });

    updateMany(updated);

    // Recharger dans le search engine
    this.searchEngine.clear();
    for (const memory of updated) {
      this.searchEngine.add(memory);
    }
  }

  /**
   * Supprime un souvenir
   */
  async delete(id: string): Promise<void> {
    this.db.prepare('DELETE FROM memories WHERE id = ?').run(id);
    this.searchEngine.remove(id);
  }

  /**
   * Liste les souvenirs
   */
  async list(options?: { limit?: number; level?: DecayLevel; type?: MemoryType }): Promise<Memory[]> {
    const { limit = 50, level, type } = options || {};
    
    let query = 'SELECT * FROM memories';
    const params: any[] = [];
    const conditions: string[] = [];
    
    if (level !== undefined) {
      conditions.push('current_level = ?');
      params.push(level);
    }
    
    if (type !== undefined) {
      conditions.push('memory_type = ?');
      params.push(type);
    }
    
    if (conditions.length > 0) {
      query += ' WHERE ' + conditions.join(' AND ');
    }
    
    query += ' ORDER BY created_at DESC LIMIT ?';
    params.push(limit);

    const rows = this.db.prepare(query).all(...params) as any[];
    return rows.map(row => this.rowToMemory(row));
  }

  /**
   * Ferme la connexion
   */
  close(): void {
    this.db.close();
  }
}
