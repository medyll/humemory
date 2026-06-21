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
import { join, dirname, resolve, sep } from 'path';
import { fileURLToPath } from 'url';
import { readFileSync } from 'fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/**
 * Resolve a request-supplied path under a trusted base dir, refusing any
 * result that escapes the base (path traversal / CWE-22). Returns null if
 * the path would leave baseDir.
 */
function safeJoin(baseDir: string, ...segments: string[]): string | null {
  const base = resolve(baseDir);
  const full = resolve(base, ...segments);
  if (full !== base && !full.startsWith(base + sep)) return null;
  return full;
}

const DB_PATH = join(__dirname, '../../data/humemory.db');
const store = new SQLiteStore(DB_PATH);
const PUBLIC_DIR = join(__dirname, '../../public');

// Configure CORS securely (allow localhost for development, restrict in production)
const allowedOrigins = process.env.NODE_ENV === 'production'
  ? (process.env.CORS_ORIGINS || 'http://localhost:3456').split(',')
  : ['http://localhost:3456', 'http://localhost:3000', 'http://127.0.0.1:3456'];

const app = new Hono();
app.use('*', cors({
  origin: (origin) => {
    if (!origin) return '*'; // Allow requests without origin (like mobile apps, curl, etc)
    return allowedOrigins.some(allowed => origin.includes(allowed.trim())) ? origin : undefined;
  },
  credentials: true,
  maxAge: 600,
}));

// Static files (dashboard)
app.get('/', (c) => {
  const html = readFileSync(join(PUBLIC_DIR, 'index.html'), 'utf-8');
  return c.html(html);
});

app.get('/session', (c) => {
  const html = readFileSync(join(PUBLIC_DIR, 'session.html'), 'utf-8');
  return c.html(html);
});

app.get('/css/*', (c) => {
  const filePath = c.req.path.replace('/css/', '');
  const fullPath = safeJoin(PUBLIC_DIR, 'css', filePath);
  if (!fullPath) return c.notFound();
  try {
    const content = readFileSync(fullPath, 'utf-8');
    return c.body(content, 200, { 'Content-Type': 'text/css' });
  } catch {
    return c.notFound();
  }
});

app.get('/js/*', (c) => {
  const filePath = c.req.path.replace('/js/', '');
  const fullPath = safeJoin(PUBLIC_DIR, 'js', filePath);
  if (!fullPath) return c.notFound();
  try {
    const content = readFileSync(fullPath, 'utf-8');
    return c.body(content, 200, { 'Content-Type': 'application/javascript' });
  } catch {
    return c.notFound();
  }
});

app.get('/assets/*', (c) => {
  const filePath = c.req.path.replace('/assets/', '');
  const fullPath = safeJoin(PUBLIC_DIR, filePath);
  if (!fullPath) return c.notFound();
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

  const dateFrom = c.req.query('dateFrom') ? new Date(c.req.query('dateFrom')!) : undefined;
  const dateTo = c.req.query('dateTo') ? new Date(c.req.query('dateTo')!) : undefined;
  const minSaillance = c.req.query('minSaillance') ? parseInt(c.req.query('minSaillance')!) : undefined;
  const minRecalls = c.req.query('minRecalls') ? parseInt(c.req.query('minRecalls')!) : undefined;
  const memoryType = c.req.query('type') as any;

  const results = await store.search({
    query,
    directory: c.req.query('directory'),
    sessionId: c.req.query('sessionId'),
    maxLevel: parseInt(c.req.query('maxLevel') || '3') as any,
    limit: parseInt(c.req.query('limit') || '10'),
    memoryType,
    dateFrom,
    dateTo,
    minSaillance,
    minRecalls,
  });

  return c.json({ success: true, results });
});

// === PHOTOGRAPHIC ===
app.post('/memories/:id/photo', async (c) => {
  try {
    const body = await c.req.json().catch(() => ({}));
    const enable = body.enable !== false; // default true
    const memory = await store.setPhotographic(c.req.param('id'), enable);
    return c.json({ success: true, memory });
  } catch (error) {
    return c.json({ success: false, error: String(error) }, 500);
  }
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

// === SESSIONS (for Replay visualization) ===
app.get('/sessions', async (c) => {
  const memories = await store.list({ limit: 1000 });

  const sessionMap = new Map<string, { sessionId: string; count: number; firstEvent: Date; lastEvent: Date; directory: string }>();

  for (const m of memories) {
    const existing = sessionMap.get(m.sessionId);
    if (existing) {
      existing.count++;
      if (new Date(m.createdAt) < existing.firstEvent) existing.firstEvent = new Date(m.createdAt);
      if (new Date(m.createdAt) > existing.lastEvent) existing.lastEvent = new Date(m.createdAt);
    } else {
      sessionMap.set(m.sessionId, {
        sessionId: m.sessionId,
        count: 1,
        firstEvent: new Date(m.createdAt),
        lastEvent: new Date(m.createdAt),
        directory: m.directory,
      });
    }
  }

  const sessions = Array.from(sessionMap.values())
    .sort((a, b) => b.lastEvent.getTime() - a.lastEvent.getTime());

  return c.json({ success: true, sessions });
});

app.get('/sessions/:id', async (c) => {
  const sessionId = decodeURIComponent(c.req.param('id'));
  const memories = await store.list({ limit: 1000 });

  const sessionMemories = memories.filter(m => m.sessionId === sessionId);

  const events: Array<{
    type: 'encoded' | 'decayed' | 'recalled';
    timestamp: Date;
    content: string;
    memoryId: string;
    level?: number;
    saillance?: number;
  }> = [];

  for (const m of sessionMemories) {
    events.push({
      type: 'encoded',
      timestamp: new Date(m.createdAt),
      content: m.content,
      memoryId: m.id,
      level: m.currentLevel,
      saillance: m.saillance,
    });

    if (m.lastRecalled) {
      events.push({
        type: 'recalled',
        timestamp: new Date(m.lastRecalled),
        content: m.content,
        memoryId: m.id,
        level: m.currentLevel,
        saillance: m.saillance,
      });
    }

    if (m.currentLevel > 0) {
      const decayTime = new Date(new Date(m.createdAt).getTime() + 24 * 60 * 60 * 1000);
      events.push({
        type: 'decayed',
        timestamp: decayTime,
        content: m.content,
        memoryId: m.id,
        level: m.currentLevel,
        saillance: m.saillance,
      });
    }
  }

  events.sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());

  return c.json({
    success: true,
    sessionId,
    events,
    totalMemories: sessionMemories.length,
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
