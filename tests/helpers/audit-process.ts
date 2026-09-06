import { SQLiteStore, AdvisoryLock } from '../../src/store/sqlite.js';
import { FakeClock } from '../../src/core/clock.js';

const [mode, path] = process.argv.slice(2);
if (mode === 'lock') {
  const lock = new AdvisoryLock(path);
  await lock.acquire();
  console.log('ready');
  await Bun.stdin.text();
  lock.release();
} else {
  const store = new SQLiteStore(path, { clock: new FakeClock(new Date('2026-01-01T00:00:00Z')) });
  console.log('ready');
  await Bun.stdin.text();
  console.log(JSON.stringify((await store.search({ query: 'quasar' })).map(r => r.memory.content)));
  store.close();
}
