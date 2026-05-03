import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { SQLiteStore } from '../src/store/sqlite.js';
import { calculateDecayLevel, calculateSaillance, calculateDecayRate } from '../src/core/decay.js';
import type { Memory, DecayLevel } from '../src/core/types.js';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { rmSync } from 'fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// DB de test temporaire
const TEST_DB = join(__dirname, 'test-humemory.db');

describe('humemory', () => {
  let store: SQLiteStore;

  beforeEach(() => {
    // Nettoyer la DB de test
    try {
      rmSync(TEST_DB);
    } catch {}
    
    store = new SQLiteStore(TEST_DB);
  });

  afterEach(() => {
    store.close();
    try {
      rmSync(TEST_DB);
    } catch {}
  });

  describe('add & get', () => {
    it('ajoute et récupère un souvenir', async () => {
      const memory = await store.add({
        content: 'Test memory content',
        directory: '/test/project',
        day: '2026-04-25',
        keywords: ['test', 'demo'],
        sessionId: 'test-session',
      });

      expect(memory.id).toBeDefined();
      expect(memory.content).toBe('Test memory content');
      expect(memory.currentLevel).toBe(0);
      expect(memory.saillance).toBeGreaterThan(0);

      const retrieved = await store.getById(memory.id);
      expect(retrieved?.id).toBe(memory.id);
      expect(retrieved?.content).toBe('Test memory content');
    });

    it('crée les niveaux de dégradation', async () => {
      const memory = await store.add({
        content: 'Long content for testing degradation levels',
        directory: '/test',
        day: '2026-04-25',
        keywords: ['test'],
        sessionId: 's1',
        level1Summary: 'Résumé du test',
        level2Essential: 'Essentiel',
        level3Keywords: 'test keywords',
      });

      expect(memory.level1Summary).toBe('Résumé du test');
      expect(memory.level2Essential).toBe('Essentiel');
      expect(memory.level3Keywords).toBe('test keywords');
    });
  });

  describe('search', () => {
    it('trouve un souvenir par contenu', async () => {
      const memory = await store.add({
        content: 'Implementation of the authentication system with OAuth2',
        directory: '/project-a',
        day: '2026-04-25',
        keywords: ['auth', 'oauth', 'security'],
        sessionId: 's1',
        level3Keywords: 'auth oauth security implementation',
      });

      // Recherche directe sur le contenu
      const results = await store.search({
        query: 'OAuth2',
        maxLevel: 0,
        limit: 10,
      });

      expect(results.length).toBeGreaterThan(0);
      expect(results[0].memory.id).toBe(memory.id);
    });

    it('recherche inversée : match sur niveau dégradé', async () => {
      const memory = await store.add({
        content: 'Detailed notes about the CSS grid system and flexbox layouts',
        directory: '/css-project',
        day: '2026-04-20',
        keywords: ['css', 'grid', 'flexbox'],
        sessionId: 's1',
        level3Keywords: 'css grid flexbox layout',
      });

      // Recherche sur les mots-clés (niveau 3)
      const results = await store.search({
        query: 'css',
        maxLevel: 3,
        limit: 10,
      });

      expect(results.length).toBeGreaterThan(0);
      expect(results[0].memory.id).toBe(memory.id);
    });

    it('filtre par directory', async () => {
      const memoryA = await store.add({
        content: 'Project A memory about testing',
        directory: '/project-a',
        day: '2026-04-25',
        keywords: ['test'],
        sessionId: 's1',
      });

      await store.add({
        content: 'Project B memory about testing',
        directory: '/project-b',
        day: '2026-04-25',
        keywords: ['test'],
        sessionId: 's1',
      });

      const results = await store.search({
        query: 'testing',
        directory: '/project-a',
        limit: 10,
      });

      expect(results.length).toBeGreaterThan(0);
      expect(results[0].memory.directory).toBe('/project-a');
    });
  });

  describe('recall', () => {
    it('renforce un souvenir', async () => {
      const memory = await store.add({
        content: 'Important memory to reinforce',
        directory: '/test',
        day: '2026-04-25',
        keywords: ['important'],
        sessionId: 's1',
      });

      expect(memory.recallCount).toBe(0);

      const recalled = await store.recall(memory.id);
      expect(recalled.recallCount).toBe(1);
      expect(recalled.saillance).toBe(100); // Boost max

      const recalled2 = await store.recall(memory.id);
      expect(recalled2.recallCount).toBe(2);
    });
  });

  describe('decay', () => {
    it('calcule le niveau de dégradation', () => {
      const now = new Date();
      
      // Souvenir frais (créé maintenant)
      const fresh: Memory = {
        id: '1',
        content: 'test',
        directory: '/test',
        day: now.toISOString().split('T')[0],
        keywords: [],
        sessionId: 's1',
        createdAt: now,
        recallCount: 0,
        decayRate: 0.5,
        currentLevel: 0 as DecayLevel,
        saillance: 50,
      };

      expect(calculateDecayLevel(fresh, now)).toBe(0);
    });

    it('calcule la saillance', () => {
      const memory: Memory = {
        id: '1',
        content: 'This is IMPORTANT and urgent!',
        directory: '/test',
        day: '2026-04-25',
        keywords: ['test', 'important', 'urgent'],
        sessionId: 's1',
        createdAt: new Date(),
        lastRecalled: new Date(),
        recallCount: 5,
        decayRate: 0.5,
        currentLevel: 0 as DecayLevel,
        saillance: 50,
      };

      const saillance = calculateSaillance(memory);
      expect(saillance).toBeGreaterThan(50); // Bonus pour rappels + émotion
    });

    it('calcule le decay rate', () => {
      // Contenu long = decay plus lent
      const longRate = calculateDecayRate('x'.repeat(600), ['a', 'b', 'c', 'd', 'e', 'f']);
      expect(longRate).toBeLessThan(0.5);

      // Contenu court = decay plus rapide
      const shortRate = calculateDecayRate('short', []);
      expect(shortRate).toBeGreaterThan(0.5);
    });
  });

  describe('list', () => {
    it('liste les souvenirs', async () => {
      await store.add({
        content: 'Memory 1',
        directory: '/test',
        day: '2026-04-25',
        keywords: ['test'],
        sessionId: 's1',
      });

      await store.add({
        content: 'Memory 2',
        directory: '/test',
        day: '2026-04-24',
        keywords: ['test'],
        sessionId: 's1',
      });

      const memories = await store.list({ limit: 10 });
      expect(memories.length).toBe(2);
      // Tri par created_at DESC
      expect(memories[0].content).toContain('Memory 2');
    });

    it('filtre par niveau', async () => {
      await store.add({
        content: 'Fresh memory',
        directory: '/test',
        day: '2026-04-25',
        keywords: ['test'],
        sessionId: 's1',
      });

      const level0 = await store.list({ level: 0 });
      expect(level0.length).toBe(1);

      const level1 = await store.list({ level: 1 });
      expect(level1.length).toBe(0);
    });
  });

  describe('delete', () => {
    it('supprime un souvenir', async () => {
      const memory = await store.add({
        content: 'To delete',
        directory: '/test',
        day: '2026-04-25',
        keywords: ['test'],
        sessionId: 's1',
      });

      await store.delete(memory.id);

      const retrieved = await store.getById(memory.id);
      expect(retrieved).toBeNull();
    });
  });

  describe('photographic mode', () => {
    it('encode --photographic désactive la dégradation', async () => {
      const memory = await store.add({
        content: 'Critical architecture decision: use event sourcing',
        directory: '/arch',
        day: '2026-05-01',
        keywords: ['architecture', 'event-sourcing'],
        sessionId: 's1',
        photographic: true,
      });

      expect(memory.photographic).toBe(true);
      // calculateDecayLevel doit retourner 0 même si ancienne
      const { calculateDecayLevel } = await import('../src/core/decay.js');
      const futureDate = new Date('2030-01-01');
      expect(calculateDecayLevel(memory, futureDate)).toBe(0);
    });

    it('setPhotographic bascule le flag', async () => {
      const memory = await store.add({
        content: 'Important note about DB schema',
        directory: '/test',
        day: '2026-05-01',
        keywords: ['db'],
        sessionId: 's1',
      });

      expect(memory.photographic).toBe(false);
      const updated = await store.setPhotographic(memory.id, true);
      expect(updated.photographic).toBe(true);

      const disabled = await store.setPhotographic(memory.id, false);
      expect(disabled.photographic).toBe(false);
    });

    it('mode photographic protège contre updateDecay', async () => {
      const memory = await store.add({
        content: 'Photographic memory must never decay',
        directory: '/test',
        day: '2020-01-01', // very old
        keywords: ['critical'],
        sessionId: 's1',
        photographic: true,
      });

      await store.updateDecay();
      const after = await store.getById(memory.id);
      expect(after!.currentLevel).toBe(0);
    });
  });

  describe('search enrichie', () => {
    it('filtre par memoryType', async () => {
      await store.add({ content: 'Event: fixed bug', directory: '/p', day: '2026-05-01', keywords: ['bug'], sessionId: 's1', memoryType: 'episodic' });
      await store.add({ content: 'Fact about CSS grid', directory: '/p', day: '2026-05-01', keywords: ['css'], sessionId: 's1', memoryType: 'semantic' });

      const results = await store.search({ query: 'css', memoryType: 'semantic', limit: 10 });
      expect(results.every(r => r.memory.memoryType === 'semantic')).toBe(true);
    });

    it('filtre par dateFrom / dateTo', async () => {
      const old = await store.add({ content: 'Old memory about auth', directory: '/p', day: '2026-01-01', keywords: ['auth'], sessionId: 's1' });
      const recent = await store.add({ content: 'Recent memory about auth', directory: '/p', day: '2026-05-01', keywords: ['auth'], sessionId: 's1' });

      const results = await store.search({
        query: 'auth',
        dateFrom: new Date('2026-03-01'),
        limit: 10,
      });

      const ids = results.map(r => r.memory.id);
      expect(ids).toContain(recent.id);
      expect(ids).not.toContain(old.id);
    });

    it('filtre par minSaillance', async () => {
      const m = await store.add({ content: 'High saillance memory about React', directory: '/p', day: '2026-05-01', keywords: ['react'], sessionId: 's1' });
      await store.recall(m.id); // boost saillance to 100

      const results = await store.search({ query: 'React', minSaillance: 90, limit: 10 });
      expect(results.some(r => r.memory.id === m.id)).toBe(true);

      const strictResults = await store.search({ query: 'React', minSaillance: 101, limit: 10 });
      expect(strictResults.some(r => r.memory.id === m.id)).toBe(false);
    });
  });

  describe('findSimilar + merge', () => {
    it('trouve des souvenirs similaires', async () => {
      const m1 = await store.add({
        content: 'OAuth2 authentication implementation with JWT tokens',
        directory: '/auth-project',
        day: '2026-04-25',
        keywords: ['oauth', 'jwt', 'auth'],
        sessionId: 's1',
        level3Keywords: 'oauth jwt authentication tokens',
      });

      await store.add({
        content: 'JWT token validation and refresh flow for OAuth2',
        directory: '/auth-project',
        day: '2026-04-25',
        keywords: ['jwt', 'oauth', 'refresh'],
        sessionId: 's1',
        level3Keywords: 'jwt oauth refresh validation',
      });

      const similar = await store.findSimilar(m1.id, { limit: 5, threshold: 0 });
      expect(similar.length).toBeGreaterThan(0);
      expect(similar[0].memory.id).not.toBe(m1.id);
    });

    it('merge: source passe en niveau 4 avec mergedIntoId', async () => {
      const source = await store.add({
        content: 'Old note about React hooks useState useEffect',
        directory: '/react-project',
        day: '2026-04-20',
        keywords: ['react', 'hooks'],
        sessionId: 's1',
        level3Keywords: 'react hooks state effect',
      });

      const target = await store.add({
        content: 'React hooks guide: useState, useEffect, useCallback patterns',
        directory: '/react-project',
        day: '2026-04-25',
        keywords: ['react', 'hooks', 'patterns'],
        sessionId: 's1',
        level3Keywords: 'react hooks patterns callback',
      });

      const result = await store.merge(source.id, target.id);

      expect(result.source.currentLevel).toBe(4);
      expect(result.source.mergedIntoId).toBe(target.id);
      expect(result.target.id).toBe(target.id);
    });

    it('merge: target absorbe le recallCount de la source', async () => {
      const source = await store.add({
        content: 'CSS grid system documentation',
        directory: '/css',
        day: '2026-04-20',
        keywords: ['css', 'grid'],
        sessionId: 's1',
      });
      // Simulate recalls on source
      await store.recall(source.id);
      await store.recall(source.id);

      const target = await store.add({
        content: 'CSS grid and flexbox layout guide',
        directory: '/css',
        day: '2026-04-25',
        keywords: ['css', 'grid', 'flex'],
        sessionId: 's1',
      });

      const beforeRecalls = target.recallCount;
      await store.merge(source.id, target.id);
      const updatedTarget = await store.getById(target.id);

      expect(updatedTarget!.recallCount).toBeGreaterThan(beforeRecalls);
    });

    it('findSimilar exclut la trace source', async () => {
      const m = await store.add({
        content: 'TypeScript generics and type inference',
        directory: '/ts',
        day: '2026-04-25',
        keywords: ['typescript', 'generics'],
        sessionId: 's1',
        level3Keywords: 'typescript generics inference types',
      });

      const similar = await store.findSimilar(m.id, { limit: 10, threshold: 0 });
      expect(similar.every(r => r.memory.id !== m.id)).toBe(true);
    });
  });
});
