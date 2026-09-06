#!/usr/bin/env bun
/**
 * humemory automatic consolidation script.
 * Meant to run from cron, nightly.
 */

import { execFileSync } from 'child_process';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const HUMEMORY_DIR = join(__dirname, '..');

console.log('humemory - automatic consolidation');
console.log('='.repeat(50));
console.log(`Date: ${new Date().toISOString()}`);
console.log(`Directory: ${HUMEMORY_DIR}`);
console.log();

try {
  // Run the decay sweep
  console.log('Updating consolidation...');
  const decayOutput = execFileSync(process.execPath, [join(HUMEMORY_DIR, 'bin/humemory.js'), 'decay'], {
    cwd: HUMEMORY_DIR,
    encoding: 'utf-8',
  });
  console.log(decayOutput);

  // State of the memory palace
  console.log('humemory state:');
  const statusOutput = execFileSync(process.execPath, [join(HUMEMORY_DIR, 'bin/humemory.js'), 'status'], {
    cwd: HUMEMORY_DIR,
    encoding: 'utf-8',
  });
  console.log(statusOutput);

  console.log('Consolidation finished successfully');
  process.exit(0);
} catch (error) {
  console.error('Consolidation failed:');
  console.error(error.message);
  if (error.stdout) console.error(error.stdout.toString());
  if (error.stderr) console.error(error.stderr.toString());
  process.exit(1);
}
