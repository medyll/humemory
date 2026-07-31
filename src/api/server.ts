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
 *
 * Fronts :
 * GET    /                  - App React (repli sur le dashboard vanilla si non construite)
 * GET    /app               - Même app, URL historique
 * GET    /legacy            - Ancien dashboard vanilla
 *
 * Mémoire prospective (src/api/intentions-routes.ts):
 * POST   /intentions        - Armer une boucle (+ ses cues)
 * GET    /intentions        - Lister (filtres status, directory)
 * GET    /intentions/:id    - Détail + cues
 * POST   /intentions/:id/close - Fermer (annule les cues restants)
 * POST   /intentions/:id/fire  - Force-fire (debug/dashboard)
 * DELETE /intentions/:id    - Supprimer (cues en cascade)
 * POST   /cues              - Attacher un cue
 * GET    /cues              - Lister (filtres intentionId, status, kind)
 * POST   /events            - Pousser un event → réveille les boucles qui matchent
 * POST   /cues/resolve      - Ménage : expire les périmées, tire les échéances
 */

import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { serve } from '@hono/node-server';
import { SQLiteStore } from '../store/sqlite.js';
import { createIntentionRoutes } from './intentions-routes.js';
import { createMemoryRoutes } from './memory-routes.js';
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

// HUMEMORY_DB : même convention que la CLI et les hooks. Sans ça, impossible de
// lancer l'API sur une base de démo sans écrire dans celle de production.
const DB_PATH = process.env.HUMEMORY_DB ?? join(__dirname, '../../data/humemory.db');
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
const APP_DIR = join(PUBLIC_DIR, 'app');

/**
 * Page de l'app React, servie à `/` comme à `/app`.
 *
 * bun émet des références relatives (`./index-abc.js`). Servies ailleurs qu'à
 * `/app/`, le navigateur les résout contre la racine et ne trouve rien — il faut
 * donc les absolutiser vers `/app/`.
 */
function reactAppHtml(): string {
  const html = readFileSync(join(APP_DIR, 'index.html'), 'utf-8');
  return html.replace(/(src|href)="\.\//g, '$1="/app/');
}

app.get('/', (c) => {
  try {
    return c.html(reactAppHtml());
  } catch {
    // Bundle absent : on retombe sur l'ancien dashboard plutôt que sur une page morte.
    return c.html(readFileSync(join(PUBLIC_DIR, 'index.html'), 'utf-8'));
  }
});

/** Ancien dashboard vanilla — conservé le temps que le front React fasse ses preuves. */
app.get('/legacy', (c) => {
  return c.html(readFileSync(join(PUBLIC_DIR, 'index.html'), 'utf-8'));
});

app.get('/session', (c) => {
  const html = readFileSync(join(PUBLIC_DIR, 'session.html'), 'utf-8');
  return c.html(html);
});

// Front React (web/ → public/app/ via `pnpm build:web`), servi à / et /app.
// L'ancien dashboard reste joignable sur /legacy.
const APP_MIME: Record<string, string> = {
  js: 'application/javascript',
  css: 'text/css',
  html: 'text/html',
  json: 'application/json',
  svg: 'image/svg+xml',
  png: 'image/png',
  woff2: 'font/woff2',
};

app.get('/app', (c) => {
  try {
    return c.html(reactAppHtml());
  } catch {
    // Bundle absent : dire quoi faire plutôt qu'un 404 muet.
    return c.text('Front non construit. Lance `pnpm build:web`.', 503);
  }
});

app.get('/app/*', (c) => {
  const filePath = c.req.path.replace('/app/', '');
  const fullPath = safeJoin(APP_DIR, filePath);
  if (!fullPath) return c.notFound();

  try {
    const ext = filePath.split('.').pop() ?? '';
    const content = readFileSync(fullPath);
    return c.body(content, 200, { 'Content-Type': APP_MIME[ext] ?? 'application/octet-stream' });
  } catch {
    return c.notFound();
  }
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

// === MÉMOIRE RÉTROSPECTIVE ===
// Sous-routeur testable (src/api/memory-routes.ts), monté ici.
app.route('/', createMemoryRoutes(store));

// === MÉMOIRE PROSPECTIVE (Phase 5.4) ===
// Sous-routeur isolé : il reçoit le store en paramètre, donc il est testable
// sans ouvrir la DB de production (voir tests/api-intentions.test.ts).
app.route('/', createIntentionRoutes(store));

// === HEALTH ===
app.get('/health', (c) => {
  return c.json({ status: 'ok', timestamp: new Date().toISOString() });
});

export { app };

// Démarrage seulement en exécution directe : importer ce module (test, outil)
// ne doit pas lever un serveur ni saisir le port.
if (import.meta.main) {
  const port = parseInt(process.env.PORT || '3456');

  console.log(`🧠 humemory API running on http://localhost:${port}`);
  console.log(`📊 Dashboard: http://localhost:${port}/`);

  serve({ fetch: app.fetch, port });
}
