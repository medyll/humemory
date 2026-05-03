/**
 * API HTTP pour humemory
 * 
 * Endpoints:
 * POST   /memories          - Ajouter un souvenir
 * GET    /memories          - Lister les souvenirs
 * GET    /memories/:id      - Récupérer un souvenir
 * POST   /memories/:id/recall - Rappeler un souvenir
 * DELETE /memories/:id      - Supprimer un souvenir
 * GET    /search            - Rechercher
 * POST   /decay             - Mettre à jour la dégradation
 * GET    /status            - État de la mémoire
 */

import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { SQLiteStore } from '../store/sqlite.js';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { readFileSync } from 'fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const DB_PATH = join(__dirname, '../../data/humemory.db');
const store = new SQLiteStore(DB_PATH);
const PUBLIC_DIR = join(__dirname, '../../public');

const app = new Hono();
app.use('*', cors());

// Static files (dashboard)
app.get('/', (c) => {
  const html = readFileSync(join(PUBLIC_DIR, 'index.html'), 'utf-8');
  return c.html(html);
});

app.get('/session', (c) => {
  const html = readFileSync(join(PUBLIC_DIR, 'session.html'), 'utf-8');
  return c.html(html);
});

app.get('/assets/*', (c) => {
  const filePath = c.req.path.replace('/assets/', '');
  const fullPath = join(PUBLIC_DIR, filePath);
  try {
    const content = readFileSync(fullPath, 'utf-8');
    const ext = filePath.split('.').pop();
    const mimeTypes: Record<string, string> = {
      css: 'text/css',
      js: 'application/javascript',
      json: 'application/json',
      png: 'image/png',
      jpg: 'image/jpeg',
      svg: 'image/svg+xml',
    };
    return c.body(content, 200, { 'Content-Type': mimeTypes[ext || 'text/plain'] });
  } catch {
    return c.notFound();
  }
});

// === MEMORIES ===
app.post('/memories', async (c) => {
  const body = await c.req.json();
  
  try {
    const validTypes = ['episodic', 'semantic', 'procedural'];
    const memoryType = validTypes.includes(body.memoryType) ? body.memoryType : 'semantic';
    
    const memory = await store.add({
      content: body.content,
      directory: body.directory || process.cwd(),
      day: body.day || new Date().toISOString().split('T')[0],
      keywords: body.keywords || [],
      sessionId: body.sessionId || 'default',
      level1Summary: body.level1Summary,
      level2Essential: body.level2Essential,
      level3Keywords: body.level3Keywords,
      memoryType: memoryType as 'episodic' | 'semantic' | 'procedural',
    });

    return c.json({ success: true, memory }, 201);
  } catch (error) {
    return c.json({ success: false, error: String(error) }, 500);
  }
});

app.get('/memories', async (c) => {
  const limit = parseInt(c.req.query('limit') || '50');
  const level = c.req.query('level');
  
  const memories = await store.list({
    limit,
    level: level !== undefined ? parseInt(level) as any : undefined,
  });

  return c.json({ success: true, memories });
});

app.get('/memories/:id', async (c) => {
  const memory = await store.getById(c.req.param('id'));
  
  if (!memory) {
    return c.json({ success: false, error: 'Not found' }, 404);
  }

  return c.json({ success: true, memory });
});

app.post('/memories/:id/recall', async (c) => {
  try {
    const memory = await store.recall(c.req.param('id'));
    return c.json({ success: true, memory });
  } catch (error) {
    return c.json({ success: false, error: String(error) }, 500);
  }
});

app.delete('/memories/:id', async (c) => {
  await store.delete(c.req.param('id'));
  return c.json({ success: true });
});

// === SEARCH ===
app.get('/search', async (c) => {
  const query = c.req.query('q');
  
  if (!query) {
    return c.json({ success: false, error: 'Missing query parameter "q"' }, 400);
  }

  const results = await store.search({
    query,
    directory: c.req.query('directory'),
    sessionId: c.req.query('sessionId'),
    maxLevel: parseInt(c.req.query('maxLevel') || '3') as any,
    limit: parseInt(c.req.query('limit') || '10'),
  });

  return c.json({ success: true, results });
});

// === SIMILAR ===
app.get('/memories/:id/similar', async (c) => {
  try {
    const limit = parseInt(c.req.query('limit') || '5');
    const threshold = parseInt(c.req.query('threshold') || '50');
    const results = await store.findSimilar(c.req.param('id'), { limit, threshold });
    return c.json({ success: true, results });
  } catch (error) {
    return c.json({ success: false, error: String(error) }, 500);
  }
});

// === MERGE ===
app.post('/memories/:id/merge', async (c) => {
  try {
    const body = await c.req.json();
    if (!body.targetId) {
      return c.json({ success: false, error: 'Missing targetId' }, 400);
    }
    const result = await store.merge(c.req.param('id'), body.targetId, {
      autoMergeContent: body.autoMergeContent ?? false,
    });
    return c.json({ success: true, result });
  } catch (error) {
    return c.json({ success: false, error: String(error) }, 500);
  }
});

// === DECAY ===
app.post('/decay', async (c) => {
  await store.updateDecay();
  return c.json({ success: true });
});

// === STATUS ===
app.get('/status', async (c) => {
  const memories = await store.list({ limit: 1000 });
  
  const byLevel = [0, 0, 0, 0, 0];
  for (const m of memories) {
    byLevel[m.currentLevel]++;
  }

  const avgSaillance = memories.reduce((sum, m) => sum + m.saillance, 0) / (memories.length || 1);
  const avgRecalls = memories.reduce((sum, m) => sum + m.recallCount, 0) / (memories.length || 1);

  return c.json({
    success: true,
    status: {
      total: memories.length,
      byLevel: {
        level0: byLevel[0],
        level1: byLevel[1],
        level2: byLevel[2],
        level3: byLevel[3],
        level4: byLevel[4],
      },
      averages: {
        saillance: Math.round(avgSaillance),
        recalls: parseFloat(avgRecalls.toFixed(1)),
      },
    },
  });
});

// === HEALTH ===
app.get('/health', (c) => {
  return c.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Start server
const port = parseInt(process.env.PORT || '3456');

console.log(`🧠 humemory API running on http://localhost:${port}`);
console.log(`📊 Dashboard: http://localhost:${port}/`);

// Start Hono server for Node.js
import { serve } from '@hono/node-server';

serve({
  fetch: app.fetch,
  port,
});
