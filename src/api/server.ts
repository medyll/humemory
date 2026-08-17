/**
 * API HTTP pour humemory
 * 
 * Endpoints:
 * POST   /memories          - Add a memory
 * GET    /memories          - List memories
 * GET    /memories/:id      - Fetch one memory
 * POST   /memories/:id/recall - Recall a memory
 * DELETE /memories/:id      - Delete a memory
 * GET    /search            - Search
 * POST   /decay             - Run the decay sweep
 * GET    /status            - Memory state
 *
 * Fronts :
 * GET    /                  - React app (explicit 503 when the bundle is missing)
 * GET    /app               - Same app, historical URL
 * GET    /session           - Mnemonic context composer (standalone page)
 *
 * Prospective memory (src/api/intentions-routes.ts):
 * POST   /intentions        - Arm a loop (and its cues)
 * GET    /intentions        - List (status, directory filters)
 * GET    /intentions/:id    - Detail plus cues
 * POST   /intentions/:id/close - Close (cancels remaining cues)
 * POST   /intentions/:id/fire  - Force-fire (debug/dashboard)
 * DELETE /intentions/:id    - Delete (cues cascade)
 * POST   /cues              - Attach a cue
 * GET    /cues              - List (intentionId, status, kind filters)
 * POST   /events            - Push an event, waking the loops that match
 * POST   /cues/resolve      - Sweep: expire overdue loops, fire due deadlines
 */

import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { serve } from '@hono/node-server';
import { SQLiteStore } from '../store/sqlite.js';
import { createIntentionRoutes } from './intentions-routes.js';
import { createMemoryRoutes } from './memory-routes.js';
import { createDreamRoutes } from './dream-routes.js';
import { createScriptRoutes } from './scripts-routes.js';
import { join, dirname, resolve, sep } from 'path';
import { fileURLToPath } from 'url';
import { readFileSync } from 'fs';
import { timingSafeEqual } from 'crypto';

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

// HUMEMORY_DB: same convention as the CLI and the hooks. Without it, the API
// cannot be pointed at a demo database without writing to production.
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

// === AUTH (SECURITY_AUDIT.md H-01) ===
// HUMEMORY_API_TOKEN, when set, is required (Bearer or x-humemory-token) on every
// data/mutation route. Static dashboard assets and /health stay open so the front
// end can load; the front end then attaches the token to its own API calls.
const API_TOKEN = process.env.HUMEMORY_API_TOKEN;
const PUBLIC_PATHS = new Set(['/health']);

function isPublicPath(path: string): boolean {
  return PUBLIC_PATHS.has(path) || path === '/' || path === '/app' || path === '/session' || path.startsWith('/app/');
}

function tokenMatches(supplied: string | undefined, expected: string): boolean {
  if (!supplied) return false;
  const a = Buffer.from(supplied);
  const b = Buffer.from(expected);
  // Constant-time compare requires equal length; a length check alone leaks
  // little (token lengths aren't secret), and avoids throwing on mismatch.
  return a.length === b.length && timingSafeEqual(a, b);
}

app.use('*', async (c, next) => {
  if (!API_TOKEN || isPublicPath(c.req.path)) return next();

  const header = c.req.header('authorization');
  const bearer = header?.startsWith('Bearer ') ? header.slice(7) : undefined;
  const supplied = bearer ?? c.req.header('x-humemory-token');

  if (!tokenMatches(supplied, API_TOKEN)) {
    return c.json({ error: 'Unauthorized' }, 401);
  }
  return next();
});

// Static files (dashboard)
const APP_DIR = join(PUBLIC_DIR, 'app');

/**
 * The React app page, served at `/` as well as `/app`.
 *
 * bun emits relative references (`./index-abc.js`). Served anywhere other than
 * `/app/`, the browser resolves them against the root and finds nothing — so they
 * are absolutised to `/app/`.
 */
function reactAppHtml(): string {
  const html = readFileSync(join(APP_DIR, 'index.html'), 'utf-8');
  return html.replace(/(src|href)="\.\//g, '$1="/app/');
}

app.get('/', (c) => {
  try {
    return c.html(reactAppHtml());
  } catch {
    // Missing bundle: say what to run rather than serve a dead page.
    return c.text('Front non construit. Lance `pnpm build:web`.', 503);
  }
});

app.get('/session', (c) => {
  const html = readFileSync(join(PUBLIC_DIR, 'session.html'), 'utf-8');
  return c.html(html);
});

// React front end (web/ → public/app/ through `pnpm build:web`), served at / and /app.
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
    // Missing bundle: say what to run rather than a silent 404.
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

// === RETROSPECTIVE MEMORY ===
// Testable sub-router (src/api/memory-routes.ts), mounted here.
app.route('/', createMemoryRoutes(store));

// === PROSPECTIVE MEMORY (Phase 5.4) ===
// Isolated sub-router: it takes the store as a parameter, so it is testable
// without opening the production database (see tests/api-intentions.test.ts).
app.route('/', createIntentionRoutes(store));

// === DREAMING (Phase 6.1) ===
app.route('/', createDreamRoutes(store));

// === COGNITIVE SCRIPTS (Phase 8.3) ===
app.route('/', createScriptRoutes(store));

// === HEALTH ===
app.get('/health', (c) => {
  return c.json({ status: 'ok', timestamp: new Date().toISOString() });
});

export { app };

// Only starts when run directly: importing this module (a test, a tool) must not
// raise a server or seize the port.
if (import.meta.main) {
  const port = parseInt(process.env.PORT || '3456');
  // Default loopback-only (SECURITY_AUDIT.md H-01): the previous code passed no
  // hostname, which node-server forwards straight to server.listen(), binding
  // every interface while the log line still claimed "localhost".
  const hostname = process.env.HUMEMORY_HOST || '127.0.0.1';
  const isLoopback = hostname === '127.0.0.1' || hostname === 'localhost' || hostname === '::1';

  if (!isLoopback && !API_TOKEN) {
    console.error(
      `Refusing to start: HUMEMORY_HOST=${hostname} exposes the API beyond loopback ` +
      `without HUMEMORY_API_TOKEN set. Set a token or unset HUMEMORY_HOST.`
    );
    process.exit(1);
  }

  console.log(`🧠 humemory API running on http://${hostname}:${port}`);
  console.log(`📊 Dashboard: http://${hostname}:${port}/`);
  if (!API_TOKEN) {
    console.warn('⚠️  HUMEMORY_API_TOKEN not set — data routes are unauthenticated (loopback only).');
  }

  serve({ fetch: app.fetch, port, hostname });
}
