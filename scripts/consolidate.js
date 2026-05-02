#!/usr/bin/env node
/**
 * Script de consolidation automatique humemory
 * Exécuté par cron chaque nuit à 3h
 */

import { execSync } from 'child_process';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const HUMEMORY_DIR = join(__dirname, '..');

console.log('🧠 humemory — Consolidation automatique');
console.log('='.repeat(50));
console.log(`Date: ${new Date().toISOString()}`);
console.log(`Répertoire: ${HUMEMORY_DIR}`);
console.log();

try {
  // Mise à jour de la consolidation
  console.log('📊 Mise à jour de la consolidation...');
  const decayOutput = execSync('pnpm cli decay', {
    cwd: HUMEMORY_DIR,
    encoding: 'utf-8',
  });
  console.log(decayOutput);

  // État du palais de mémoire
  console.log('📋 État de humemory:');
  const statusOutput = execSync('pnpm cli status', {
    cwd: HUMEMORY_DIR,
    encoding: 'utf-8',
  });
  console.log(statusOutput);

  console.log('✅ Consolidation terminée avec succès');
  process.exit(0);
} catch (error) {
  console.error('❌ Erreur lors de la consolidation:');
  console.error(error.message);
  if (error.stdout) console.error(error.stdout.toString());
  if (error.stderr) console.error(error.stderr.toString());
  process.exit(1);
}
