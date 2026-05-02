#!/usr/bin/env node
import { Command } from 'commander';
import { SQLiteStore } from '../store/sqlite.js';
import { calculateDecayLevel } from '../core/decay.js';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Store partagé
const DB_PATH = join(__dirname, '../../data/humemory.db');
let store: SQLiteStore;

function getStore(): SQLiteStore {
  if (!store) {
    store = new SQLiteStore(DB_PATH);
  }
  return store;
}

const program = new Command();

program
  .name('humemory')
  .description('Palais de mémoire — Système de traces mnésiques avec dégradation progressive')
  .version('0.1.0');

// === ADD ===
program
  .command('encode <content>')
  .alias('add')
  .description('Encoder une nouvelle trace mnésique')
  .option('-d, --directory <dir>', 'Lieu mental (projet)', process.cwd())
  .option('-s, --session <id>', 'Contexte d\'encodage', 'default')
  .option('-k, --keywords <tags>', 'Indices de récupération (comma-separated)', '')
  .option('-l1, --level1 <summary>', 'Résumé pour consolidation N1')
  .option('-l2, --level2 <essential>', 'Essentiel pour consolidation N2')
  .option('-l3, --level3 <keywords>', 'Trace pour recherche rapide N3')
  .option('-t, --type <type>', 'Type de mémoire (episodic/semantic/procedural)', 'semantic')
  .action(async (content, options) => {
    const s = getStore();
    
    const validTypes = ['episodic', 'semantic', 'procedural'];
    const memoryType = validTypes.includes(options.type) ? options.type : 'semantic';
    
    const memory = await s.add({
      content,
      directory: options.directory,
      day: new Date().toISOString().split('T')[0],
      keywords: options.keywords ? options.keywords.split(',').map((k: string) => k.trim()).filter(Boolean) : [],
      sessionId: options.session,
      level1Summary: options.level1,
      level2Essential: options.level2,
      level3Keywords: options.level3,
      memoryType: memoryType as 'episodic' | 'semantic' | 'procedural',
    });

    const typeLabels = { episodic: 'Épisodique', semantic: 'Sémantique', procedural: 'Procédurale' };
    const states = ['Encodage', 'Consolidation', 'Stable', 'Fragile', 'Sommeil'];
    console.log(`✓ Trace encodée: ${memory.id}`);
    console.log(`  Type: ${typeLabels[memory.memoryType]}`);
    console.log(`  État: ${states[memory.currentLevel]}`);
    console.log(`  Force mnésique: ${memory.saillance}/100`);
  });

// === SEARCH ===
program
  .command('search <query>')
  .alias('find')
  .description('Rechercher par indices de récupération (recherche inversée)')
  .option('-d, --directory <dir>', 'Filtrer par lieu mental')
  .option('-s, --session <id>', 'Filtrer par contexte')
  .option('-l, --level <max>', 'État max de consolidation (0-4)', '4')
  .option('-n, --limit <n>', 'Nombre de traces', '10')
  .action(async (query, options) => {
    const s = getStore();
    
    const results = await s.search({
      query,
      directory: options.directory,
      sessionId: options.session,
      maxLevel: parseInt(options.level) as 0 | 1 | 2 | 3 | 4,
      limit: parseInt(options.limit),
    });

    if (results.length === 0) {
      console.log('Aucune trace trouvée.');
      return;
    }

    const states = ['Encodage', 'Consolidation', 'Stable', 'Fragile', 'Sommeil'];
    console.log(`\n🧠 ${results.length} trace(s) retrouvée(s):\n`);
    
    for (const result of results) {
      console.log(`🔍 [${states[result.matchLevel]}] Score: ${Math.round(result.score)}`);
      console.log(`   ID: ${result.memory.id}`);
      console.log(`   Lieu: ${result.memory.directory}`);
      console.log(`   Contexte: ${result.memory.sessionId}`);
      console.log(`   Encodage: ${new Date(result.memory.createdAt).toLocaleDateString('fr-FR')}`);
      console.log(`   Réactivations: ${result.memory.recallCount}`);
      
      // Afficher le contenu selon le niveau de match
      let displayContent = result.memory.content;
      if (result.matchLevel === 4 && result.memory.level3Keywords) {
        displayContent = `Trace: ${result.memory.level3Keywords}`;
      } else if (result.matchLevel === 3 && result.memory.level3Keywords) {
        displayContent = `Mots-clés: ${result.memory.level3Keywords}`;
      } else if (result.matchLevel === 2 && result.memory.level2Essential) {
        displayContent = result.memory.level2Essential;
      } else if (result.matchLevel === 1 && result.memory.level1Summary) {
        displayContent = result.memory.level1Summary;
      }
      
      console.log(`   Contenu: ${displayContent.slice(0, 200)}${displayContent.length > 200 ? '...' : ''}`);
      console.log();
    }
  });

// === RECALL ===
program
  .command('recall <id>')
  .alias('reactivate')
  .description('Réactiver une trace (renforcement mnésique)')
  .action(async (id) => {
    const s = getStore();
    
    const memory = await s.recall(id);
    const states = ['Encodage', 'Consolidation', 'Stable', 'Fragile', 'Sommeil'];
    console.log(`✓ Trace réactivée: ${memory.id}`);
    console.log(`  Réactivations totales: ${memory.recallCount}`);
    console.log(`  Force mnésique: ${memory.saillance}/100`);
    console.log(`  État: ${states[memory.currentLevel]}`);
  });

// === LIST ===
program
  .command('list')
  .alias('traces')
  .description('Lister les traces mnésiques')
  .option('-n, --limit <n>', 'Nombre de traces', '20')
  .option('-l, --level <level>', 'Filtrer par état (0-4)')
  .option('-t, --type <type>', 'Filtrer par type (episodic/semantic/procedural)')
  .action(async (options) => {
    const s = getStore();
    
    const memories = await s.list({
      limit: parseInt(options.limit),
      level: options.level !== undefined ? parseInt(options.level) as any : undefined,
      type: options.type as 'episodic' | 'semantic' | 'procedural' | undefined,
    });

    if (memories.length === 0) {
      console.log('Aucune trace.');
      return;
    }

    const states = ['Encodage', 'Consolidation', 'Stable', 'Fragile', 'Sommeil'];
    console.log(`\n📋 ${memories.length} trace(s):\n`);
    
    for (const m of memories) {
      console.log(`🧠 ${m.id.slice(0, 8)}... | ${states[m.currentLevel]} | ${m.directory}`);
      console.log(`   ${m.content.slice(0, 100)}${m.content.length > 100 ? '...' : ''}`);
      console.log(`   Réactivations: ${m.recallCount} | Force: ${m.saillance}`);
      console.log();
    }
  });

// === DECAY ===
program
  .command('decay')
  .alias('consolidate')
  .description('Mettre à jour la consolidation de toutes les traces')
  .action(async () => {
    const s = getStore();
    
    await s.updateDecay();
    console.log('✓ Consolidation mise à jour');
    
    // Afficher un résumé
    const all = await s.list({ limit: 1000 });
    const byLevel = [0, 0, 0, 0, 0];
    for (const m of all) {
      byLevel[m.currentLevel]++;
    }
    
    const states = ['Encodage', 'Consolidation', 'Stable', 'Fragile', 'Sommeil'];
    console.log('\nRépartition:');
    console.log(`  🟢 ${states[0]}: ${byLevel[0]}`);
    console.log(`  🟡 ${states[1]}: ${byLevel[1]}`);
    console.log(`  🟠 ${states[2]}: ${byLevel[2]}`);
    console.log(`  🔴 ${states[3]}: ${byLevel[3]}`);
    console.log(`  ⚫ ${states[4]}: ${byLevel[4]}`);
  });

// === DELETE ===
program
  .command('delete <id>')
  .alias('forget')
  .description('Oublier une trace mnésique')
  .action(async (id) => {
    const s = getStore();
    await s.delete(id);
    console.log(`✓ Trace oubliée: ${id}`);
  });

// === STATUS ===
program
  .command('status')
  .description('Afficher l\'état du palais de mémoire')
  .action(async () => {
    const s = getStore();
    const all = await s.list({ limit: 1000 });
    
    console.log('\n🧠 État de humemory:\n');
    console.log(`Total traces: ${all.length}`);
    
    const byLevel = [0, 0, 0, 0, 0];
    for (const m of all) {
      byLevel[m.currentLevel]++;
    }
    
    const states = ['Encodage', 'Consolidation', 'Stable', 'Fragile', 'Sommeil'];
    console.log('\nPar état de consolidation:');
    console.log(`  🟢 ${states[0]}: ${byLevel[0]}`);
    console.log(`  🟡 ${states[1]}: ${byLevel[1]}`);
    console.log(`  🟠 ${states[2]}: ${byLevel[2]}`);
    console.log(`  🔴 ${states[3]}: ${byLevel[3]}`);
    console.log(`  ⚫ ${states[4]}: ${byLevel[4]}`);
    
    const avgSaillance = all.reduce((sum, m) => sum + m.saillance, 0) / (all.length || 1);
    const avgRecalls = all.reduce((sum, m) => sum + m.recallCount, 0) / (all.length || 1);
    
    console.log(`\nMoyennes:`);
    console.log(`  Force mnésique: ${Math.round(avgSaillance)}/100`);
    console.log(`  Réactivations par trace: ${avgRecalls.toFixed(1)}`);
  });

// Parse et exécution
program.parse();

// Cleanup
process.on('exit', () => {
  if (store) store.close();
});
