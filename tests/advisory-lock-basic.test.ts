import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { SQLiteStore } from '../src/store/sqlite.js';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { rmSync } from 'fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// DB de test temporaire
const TEST_DB = join(__dirname, 'test-advisory-lock-basic.db');

describe('Advisory Lock — basic functionality', () => {
  beforeEach(() => {
    // Nettoyer la DB de test
    try {
      rmSync(TEST_DB);
      rmSync(TEST_DB + '.lock');
    } catch {}
  });

  afterEach(() => {
    try {
      rmSync(TEST_DB);
      rmSync(TEST_DB + '.lock');
    } catch {}
  });

  test('multiple store instances can write to same database', async () => {
    // Create two store instances pointing to the same database
    const store1 = new SQLiteStore(TEST_DB);
    const store2 = new SQLiteStore(TEST_DB);

    // Add memories from both stores
    const mem1 = await store1.add({
      content: 'Memory from store 1',
      directory: '/test/lock',
      day: '2026-06-24',
      keywords: ['test', 'store1'],
      sessionId: 'session-1',
    });

    const mem2 = await store2.add({
      content: 'Memory from store 2',
      directory: '/test/lock',
      day: '2026-06-24',
      keywords: ['test', 'store2'],
      sessionId: 'session-2',
    });

    // Verify both memories exist
    const retrieved1 = await store1.getById(mem1.id);
    const retrieved2 = await store2.getById(mem2.id);

    expect(retrieved1).not.toBeNull();
    expect(retrieved2).not.toBeNull();
    expect(retrieved1?.content).toBe('Memory from store 1');
    expect(retrieved2?.content).toBe('Memory from store 2');

    // Verify we have exactly 2 memories
    const allMemories = await store1.list({ limit: 10 });
    expect(allMemories.length).toBe(2);

    store1.close();
    store2.close();
  });

  test('concurrent operations are serialized correctly', async () => {
    const store1 = new SQLiteStore(TEST_DB);
    const store2 = new SQLiteStore(TEST_DB);

    // Add initial memory
    const initialMemory = await store1.add({
      content: 'Memory to update',
      directory: '/test/update',
      day: '2026-06-24',
      keywords: ['update', 'test'],
      sessionId: 'session-1',
    });

    // Both stores recall the same memory concurrently
    const recallPromises = [
      store1.recall(initialMemory.id),
      store2.recall(initialMemory.id),
    ];

    await Promise.all(recallPromises);

    // Verify the memory was recalled exactly twice
    const updatedMemory = await store1.getById(initialMemory.id);
    expect(updatedMemory?.recallCount).toBe(2);

    store1.close();
    store2.close();
  });

  test('lock file is created and cleaned up', async () => {
    const store = new SQLiteStore(TEST_DB);
    
    // Add a memory to trigger the lock
    await store.add({
      content: 'Test memory',
      directory: '/test/lockfile',
      day: '2026-06-24',
      keywords: ['lockfile', 'test'],
      sessionId: 'session-1',
    });

    store.close();

    // Lock file should be cleaned up after operations complete
    const lockFileExists = await Bun.file(TEST_DB + '.lock').exists();
    expect(lockFileExists).toBeFalse();
  });
});