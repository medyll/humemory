#!/usr/bin/env node
import { Command } from 'commander';
import { SQLiteStore } from '../store/sqlite.js';
import { calculateDecayLevel } from '../core/decay.js';
import { SqliteCueResolver, loopId, matchIntentionByShortId } from '../core/cues.js';
import { parseCueArg, formatTriggerSpec } from '../core/cue-arg.js';
import type { IntentionStatus, TriggerSpec } from '../core/types.js';
import { join, dirname, resolve } from 'path';
import { fileURLToPath } from 'url';
import { readFileSync } from 'fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Shared store. HUMEMORY_DB points at another database — same convention as the
// hooks, and required to exercise the CLI without touching production.
const DB_PATH = process.env.HUMEMORY_DB ?? join(__dirname, '../../data/humemory.db');
let store: SQLiteStore;

function getStore(): SQLiteStore {
  if (!store) {
    store = new SQLiteStore(DB_PATH);
  }
  return store;
}

const program = new Command();

// Version read from the package: hard-coded, it drifted at every release.
const { version } = JSON.parse(readFileSync(join(__dirname, '../../package.json'), 'utf-8')) as {
  version: string;
};

program
  .name('humemory')
  .description('Memory palace — mnemonic traces with progressive decay')
  .version(version);

// === ADD ===
program
  .command('encode <content>')
  .alias('add')
  .description('Encode a new mnemonic trace')
  .option('-d, --directory <dir>', 'Mental place (project)', process.cwd())
  .option('-s, --session <id>', 'Contexte d\'encodage', 'default')
  .option('-k, --keywords <tags>', 'Retrieval cues (comma-separated)', '')
  .option('-l1, --level1 <summary>', 'Summary for consolidation level 1')
  .option('-l2, --level2 <essential>', 'Gist for consolidation level 2')
  .option('-l3, --level3 <keywords>', 'Keywords for fast level 3 retrieval')
  .option('-t, --type <type>', 'Memory type (episodic/semantic/procedural)', 'semantic')
  .option('--auto', 'Auto-generate levels 1-3 through the LLM (needs ANTHROPIC_API_KEY)')
  .option('--photographic', 'Photographic mode — disable decay')
  .option('--agent <name>', 'Who is encoding (claude/codex/kimi/…)', 'cli')
  .action(async (content, options) => {
    const s = getStore();

    const validTypes = ['episodic', 'semantic', 'procedural'];
    const memoryType = validTypes.includes(options.type) ? options.type : 'semantic';

    if (options.auto) {
      console.log('⏳ Generating consolidation levels through the LLM…');
    }

    const memory = await s.add({
      content,
      // Resolved to absolute, as for intentions: the SessionStart hook filters by
      // `process.cwd()`, and a relative path would never match.
      directory: resolve(options.directory),
      day: new Date().toISOString().split('T')[0],
      keywords: options.keywords ? options.keywords.split(',').map((k: string) => k.trim()).filter(Boolean) : [],
      sessionId: options.session,
      level1Summary: options.level1,
      level2Essential: options.level2,
      level3Keywords: options.level3,
      memoryType: memoryType as 'episodic' | 'semantic' | 'procedural',
      photographic: options.photographic ?? false,
      agent: options.agent,
    }, { autoGenerate: options.auto });

    const typeLabels = { episodic: 'Episodic', semantic: 'Semantic', procedural: 'Procedural' };
    const states = ['Encoding', 'Consolidation', 'Stable', 'Fragile', 'Dormant'];
    console.log(`✓ Trace encoded: ${memory.id}`);
    console.log(`  Type: ${typeLabels[memory.memoryType]}`);
    console.log(`  State: ${states[memory.currentLevel]}`);
    console.log(`  Mnemonic strength: ${memory.saillance}/100`);
  });

// === SEARCH ===
program
  .command('search <query>')
  .alias('find')
  .description('Search by retrieval cues (inverse search)')
  .option('-d, --directory <dir>', 'Filter by mental place')
  .option('-s, --session <id>', 'Filter by context')
  .option('-l, --level <max>', 'Maximum consolidation state (0-4)', '4')
  .option('-n, --limit <n>', 'Number of traces', '10')
  .option('-t, --type <type>', 'Filter by type (episodic/semantic/procedural)')
  .option('--from <date>', 'Start date YYYY-MM-DD')
  .option('--to <date>', 'End date YYYY-MM-DD')
  .option('--min-saillance <n>', 'Minimum mnemonic strength (0-100)')
  .option('--min-recalls <n>', 'Minimum recall count')
  .option('--semantic', 'Hybrid search: fuse BM25 with vector similarity (Phase 7.4, needs the model)')
  .action(async (query, options) => {
    const s = getStore();

    let results;
    if (options.semantic) {
      const { OnnxEmbedder } = await import('../core/embeddings.js');
      const { hybridSearch } = await import('../core/hybrid.js');
      const embedder = new OnnxEmbedder();
      results = await hybridSearch(s, embedder, query, {
        directory: options.directory ? resolve(options.directory) : undefined,
        limit: parseInt(options.limit),
      });
    } else {
      results = await s.search({
        query,
        directory: options.directory ? resolve(options.directory) : undefined,
        sessionId: options.session,
        maxLevel: parseInt(options.level) as 0 | 1 | 2 | 3 | 4,
        limit: parseInt(options.limit),
        memoryType: options.type as any,
        dateFrom: options.from ? new Date(options.from) : undefined,
        dateTo: options.to ? new Date(options.to) : undefined,
        minSaillance: options.minSaillance ? parseInt(options.minSaillance) : undefined,
        minRecalls: options.minRecalls ? parseInt(options.minRecalls) : undefined,
      });
    }

    if (results.length === 0) {
      console.log('No trace found.');
      return;
    }

    const states = ['Encoding', 'Consolidation', 'Stable', 'Fragile', 'Dormant'];
    console.log(`\n🧠 ${results.length} trace(s) found:\n`);
    
    for (const result of results) {
      console.log(`🔍 [${states[result.matchLevel]}] Score: ${Math.round(result.score)}`);
      console.log(`   ID: ${result.memory.id}`);
      console.log(`   Place: ${result.memory.directory}`);
      console.log(`   Context: ${result.memory.sessionId}`);
      console.log(`   Encoded: ${new Date(result.memory.createdAt).toLocaleDateString()}`);
      console.log(`   Recalls: ${result.memory.recallCount}`);
      
      // Show the content at the level where the match happened
      let displayContent = result.memory.content;
      if (result.matchLevel === 4 && result.memory.level3Keywords) {
        displayContent = `Trace: ${result.memory.level3Keywords}`;
      } else if (result.matchLevel === 3 && result.memory.level3Keywords) {
        displayContent = `Keywords: ${result.memory.level3Keywords}`;
      } else if (result.matchLevel === 2 && result.memory.level2Essential) {
        displayContent = result.memory.level2Essential;
      } else if (result.matchLevel === 1 && result.memory.level1Summary) {
        displayContent = result.memory.level1Summary;
      }
      
      console.log(`   Content: ${displayContent.slice(0, 200)}${displayContent.length > 200 ? '...' : ''}`);
      console.log();
    }
  });

// === RECALL ===
program
  .command('recall <id>')
  .alias('reactivate')
  .description('Recall a trace (mnemonic reinforcement)')
  .option('--agent <name>', 'Who is recalling (earns `reused` verification across agents)')
  .action(async (id, options) => {
    const s = getStore();

    // A human at a terminal chose this `--agent`; that is a process-level
    // identity, not a request claiming one. It may earn `reused`.
    const memory = await s.recall(id, options.agent, { identityTrusted: true });
    const states = ['Encoding', 'Consolidation', 'Stable', 'Fragile', 'Dormant'];
    console.log(`✓ Trace recalled: ${memory.id}`);
    console.log(`  Total recalls: ${memory.recallCount}`);
    console.log(`  Mnemonic strength: ${memory.saillance}/100`);
    console.log(`  State: ${states[memory.currentLevel]}`);
    if (memory.verified && memory.verificationReason === 'reused') {
      console.log(`  Verified: earned by cross-agent reuse ✓`);
    }
  });

// === VERIFY / REFUTE (Phase 6.0.1) ===
program
  .command('verify <id>')
  .description('Mark a trace as human-verified (prints content first — no blind stamp)')
  .action(async (id) => {
    const s = getStore();

    const memory = await s.getById(id);
    if (!memory) {
      console.error(`✗ Trace ${id} not found`);
      process.exit(1);
    }
    // Trust-theatre guard (PHASE6_PLAN risks): the human must actually read
    // the trace before stamping it — verify prints the content, always.
    console.log(`\n🧠 ${memory.id}\n\n${memory.content}\n`);
    const updated = await s.verify(id, 'human');
    console.log(`✓ Trace verified (reason: human). Trust will reflect it.`);
    void updated;
  });

program
  .command('refute <id>')
  .description('Record a negative signal against a trace (refuted_count +1, verification revoked)')
  .option('-r, --reason <text>', 'Why the trace does not hold')
  .action(async (id, options) => {
    const s = getStore();

    const memory = await s.refute(id, options.reason);
    console.log(`✓ Trace refuted: ${memory.id}`);
    console.log(`  Refuted count: ${memory.refutedCount}`);
    console.log(`  Verification: revoked (must be re-earned)`);
  });

// === CONTRADICT (Phase 6.0.2) ===
program
  .command('contradict <winnerId> <loserId>')
  .description('Winner trace contradicts loser trace — loser collapses (never deleted)')
  .option('-r, --reason <text>', 'Why the loser no longer holds')
  .option('--agent <name>', 'Who files the contradiction', 'cli')
  .action(async (winnerId, loserId, options) => {
    const s = getStore();

    const result = await s.contradict!(winnerId, loserId, {
      reason: options.reason,
      createdBy: options.agent === 'cli' ? 'human' : 'agent',
      agent: options.agent,
    });
    if (result.proposalFiled) {
      console.log(`⏳ Loser is human/grounded-verified — contradiction filed as a dream proposal for review.`);
      return;
    }
    if (result.retargetedTo) {
      console.log(`⚠ Loser was already merged — the collapse hit the merge target ${result.retargetedTo.slice(0, 8)}…`);
    }
    console.log(`✓ Contradiction recorded: ${result.contradiction!.id}`);
    console.log(`  Loser saillance: ${result.loser.saillance}/100 (collapsed, still searchable)`);
  });

// === LIST ===
program
  .command('list')
  .alias('traces')
  .description('List mnemonic traces')
  .option('-n, --limit <n>', 'Number of traces', '20')
  .option('-l, --level <level>', 'Filter by state (0-4)')
  .option('-t, --type <type>', 'Filter by type (episodic/semantic/procedural)')
  .action(async (options) => {
    const s = getStore();
    
    const memories = await s.list({
      limit: parseInt(options.limit),
      level: options.level !== undefined ? parseInt(options.level) as any : undefined,
      type: options.type as 'episodic' | 'semantic' | 'procedural' | undefined,
    });

    if (memories.length === 0) {
      console.log('No trace.');
      return;
    }

    const states = ['Encoding', 'Consolidation', 'Stable', 'Fragile', 'Dormant'];
    console.log(`\n📋 ${memories.length} trace(s):\n`);
    
    for (const m of memories) {
      console.log(`🧠 ${m.id.slice(0, 8)}... | ${states[m.currentLevel]} | ${m.directory}`);
      console.log(`   ${m.content.slice(0, 100)}${m.content.length > 100 ? '...' : ''}`);
      console.log(`   Recalls: ${m.recallCount} | Strength: ${m.saillance}`);
      console.log();
    }
  });

// === DECAY ===
program
  .command('decay')
  .alias('consolidate')
  .description('Update consolidation for every trace')
  .action(async () => {
    const s = getStore();
    
    await s.updateDecay();
    console.log('✓ Consolidation updated');
    
    // Print a summary
    const all = await s.list({ limit: 1000 });
    const byLevel = [0, 0, 0, 0, 0];
    for (const m of all) {
      byLevel[m.currentLevel]++;
    }
    
    const states = ['Encoding', 'Consolidation', 'Stable', 'Fragile', 'Dormant'];
    console.log('\nDistribution:');
    console.log(`  🟢 ${states[0]}: ${byLevel[0]}`);
    console.log(`  🟡 ${states[1]}: ${byLevel[1]}`);
    console.log(`  🟠 ${states[2]}: ${byLevel[2]}`);
    console.log(`  🔴 ${states[3]}: ${byLevel[3]}`);
    console.log(`  ⚫ ${states[4]}: ${byLevel[4]}`);
  });

// === PHOTOGRAPHIC ===
program
  .command('photo <id>')
  .description('Toggle photographic mode (disables decay)')
  .option('--off', 'Turn photographic mode off')
  .action(async (id, options) => {
    const s = getStore();
    const memory = await s.setPhotographic(id, !options.off);
    console.log(`✓ Photographic mode: ${memory.photographic ? '🔒 ON' : '🔓 off'}`);
    console.log(`  ID: ${memory.id}`);
  });

// === SIMILAR ===
program
  .command('similar <id>')
  .description('Find similar traces to merge')
  .option('-n, --limit <n>', 'Number of results', '5')
  .option('-t, --threshold <n>', 'Score minimum (0-100)', '50')
  .action(async (id, options) => {
    const s = getStore();
    const results = await s.findSimilar(id, {
      limit: parseInt(options.limit),
      threshold: parseInt(options.threshold),
    });

    if (results.length === 0) {
      console.log('No similar trace found.');
      return;
    }

    console.log(`\n🔍 ${results.length} trace(s) similaire(s):\n`);
    for (const r of results) {
      console.log(`  ID: ${r.memory.id}`);
      console.log(`  Score: ${Math.round(r.score)} | Lieu: ${r.memory.directory}`);
      console.log(`  ${r.memory.content.slice(0, 120)}...`);
      console.log();
    }
  });

// === MERGE ===
program
  .command('merge <sourceId> <targetId>')
  .description('Fusionner deux traces (source → target, source passe en niveau 4)')
  .option('--auto', 'Fusionner le contenu via LLM')
  .action(async (sourceId, targetId, options) => {
    const s = getStore();

    if (options.auto) {
      console.log('⏳ Fusion via LLM...');
    }

    const result = await s.merge(sourceId, targetId, { autoMergeContent: options.auto });

    console.log(`✓ Merge done`);
    console.log(`  Source ${sourceId.slice(0, 8)}… → level 4 (merged)`);
    console.log(`  Target ${targetId.slice(0, 8)}… absorbed it`);
    if (result.mergedContent) {
      console.log(`  Merged content: ${result.mergedContent.slice(0, 150)}…`);
    }
  });

// === UNMERGE (Phase 6.0.4) ===
program
  .command('unmerge <sourceId>')
  .description('Revert a merge: resurrect the source trace, restore the target\u2019s revised levels')
  .action(async (sourceId) => {
    const s = getStore();

    const result = await s.unmerge!(sourceId);
    console.log(`✓ Unmerge done`);
    console.log(`  Source ${result.source.id.slice(0, 8)}… resurrected at level ${result.source.currentLevel}`);
    console.log(`  Target ${result.target.id.slice(0, 8)}… levels restored from the last revision`);
  });

// === DELETE ===
program
  .command('delete <id>')
  .alias('forget')
  .description('Forget a mnemonic trace')
  .action(async (id) => {
    const s = getStore();
    await s.delete(id);
    console.log(`✓ Trace forgotten: ${id}`);
  });

// === STATUS ===
program
  .command('status')
  .description('Show the state of the memory palace')
  .action(async () => {
    const s = getStore();
    const all = await s.list({ limit: 1000 });
    
    console.log('\n🧠 État de humemory:\n');
    console.log(`Total traces: ${all.length}`);
    
    const byLevel = [0, 0, 0, 0, 0];
    for (const m of all) {
      byLevel[m.currentLevel]++;
    }
    
    const states = ['Encoding', 'Consolidation', 'Stable', 'Fragile', 'Dormant'];
    console.log('\nBy consolidation state:');
    console.log(`  🟢 ${states[0]}: ${byLevel[0]}`);
    console.log(`  🟡 ${states[1]}: ${byLevel[1]}`);
    console.log(`  🟠 ${states[2]}: ${byLevel[2]}`);
    console.log(`  🔴 ${states[3]}: ${byLevel[3]}`);
    console.log(`  ⚫ ${states[4]}: ${byLevel[4]}`);
    
    const avgSaillance = all.reduce((sum, m) => sum + m.saillance, 0) / (all.length || 1);
    const avgRecalls = all.reduce((sum, m) => sum + m.recallCount, 0) / (all.length || 1);
    
    console.log(`\nMoyennes:`);
    console.log(`  Mnemonic strength: ${Math.round(avgSaillance)}/100`);
    console.log(`  Recalls per trace: ${avgRecalls.toFixed(1)}`);
  });

// === IMPORT SESSION ===
program
  .command('import-session <file>')
  .description('Importer une session Claude Code et extraire les apprentissages')
  .option('-d, --directory <dir>', 'Lieu mental du projet', process.cwd())
  .option('-n, --max <n>', 'Maximum learnings to extract', '5')
  .action(async (file, options) => {
    const { readFileSync } = await import('fs');
    const { processSession } = await import('../agent/claude-hook.js');

    const raw = readFileSync(file, 'utf-8');
    console.log('⏳ Analyse de la session et extraction des apprentissages...');

    const result = await processSession(raw, {
      dbPath: DB_PATH,
      directory: options.directory ? resolve(options.directory) : undefined,
      maxLearnings: parseInt(options.max),
    });

    if (result.memoriesStored === 0) {
      console.log('No learning found in this session.');
      return;
    }

    console.log(`\n✓ ${result.memoriesStored} learning(s) stored:\n`);
    for (const l of result.learnings) {
      console.log(`  • ${l}`);
    }
  });

// === INTENT (prospective memory) ===
const intent = program
  .command('intent')
  .description('Open loops (prospective memory) — arm, list, close');

intent
  .command('add <content>')
  .description('Arm an open loop')
  .option('-d, --directory <dir>', 'Mental place (defaults to cwd)')
  .option('-c, --cue <cue...>', "Trigger — 'time:2026-12-01', 'cron:0 9 * * 1', 'event:file_open:src/a.ts'")
  .option('-e, --expires <date>', 'Deadline (ISO) past which the loop expires')
  .action(async (content: string, options) => {
    const s = getStore();

    let cues: TriggerSpec[] = [];
    try {
      cues = (options.cue ?? []).map((raw: string) => parseCueArg(raw));
    } catch (err) {
      console.error(`✗ ${err instanceof Error ? err.message : err}`);
      process.exitCode = 1;
      return;
    }

    let expiresAt: Date | undefined;
    if (options.expires) {
      expiresAt = new Date(options.expires);
      if (Number.isNaN(expiresAt.getTime())) {
        console.error(`x invalid deadline: ${options.expires}`);
        process.exitCode = 1;
        return;
      }
    }

    // The mental place is resolved to absolute: the SessionStart hook looks up by
    // `process.cwd()`, so a loop armed on './src/auth' would never surface — a
    // perfectly silent failure.
    const intention = await s.addIntention(
      {
        content,
        directory: resolve(options.directory ?? process.cwd()),
        expiresAt,
      },
      cues
    );

    console.log(`\n🔁 Loop armed — ${loopId(intention.id)}`);
    console.log(`   ${intention.content}`);
    console.log(`   Place: ${intention.directory}`);
    if (expiresAt) console.log(`   Due: ${expiresAt.toISOString()}`);
    for (const spec of cues) console.log(`   Cue: ${formatTriggerSpec(spec)}`);
    console.log(`\n   To close: mention "Closes ${loopId(intention.id)}" in a commit\n`);
  });

intent
  .command('list')
  .alias('ls')
  .description('List loops')
  .option('-s, --status <status>', 'armed | fired | closed | expired', 'armed')
  .option('-d, --directory <dir>', 'Filter by mental place')
  .option('-n, --limit <n>', 'Maximum count', '20')
  .option('-a, --all', 'Every status')
  .action(async (options) => {
    const s = getStore();

    const intentions = await s.listIntentions({
      status: options.all ? undefined : (options.status as IntentionStatus),
      directory: options.directory ? resolve(options.directory) : undefined,
      limit: parseInt(options.limit),
    });

    if (intentions.length === 0) {
      console.log('No loop.');
      return;
    }

    const icons: Record<IntentionStatus, string> = {
      armed: '🔁',
      fired: '⏰',
      closed: '✅',
      expired: '💤',
    };

    console.log(`\n${intentions.length} loop(s):\n`);
    for (const i of intentions) {
      const cues = await s.listCues({ intentionId: i.id });
      console.log(`${icons[i.status]} ${loopId(i.id)} | ${i.status} | ${i.directory}`);
      console.log(`   ${i.content}`);
      if (cues.length) {
        console.log(`   Cues: ${cues.map((c) => `${formatTriggerSpec(c.triggerSpec)} (${c.status})`).join(', ')}`);
      }
      if (i.expiresAt) console.log(`   Due: ${i.expiresAt.toISOString()}`);
      if (i.closedByCommit) console.log(`   Closed by: ${i.closedByCommit}`);
      console.log();
    }
  });

/** Resolves a short id (`loop-a1b2c3d4`, `a1b2c3d4`) to an intention. */
async function resolveIntentionArg(s: SQLiteStore, arg: string) {
  const short = arg.replace(/^loop-/i, '');
  const all = await s.listIntentions({ limit: 500 });
  const found = matchIntentionByShortId(all, short);

  if (!found) {
    // Ambiguous or unknown prefix: no guessing, closing the wrong loop is worse.
    console.error(`x no single loop matches "${arg}"`);
    process.exitCode = 1;
  }
  return found;
}

intent
  .command('close <id>')
  .description('Close a loop (accepts loop-abc12345 or the bare prefix)')
  .option('--commit <sha>', 'SHA of the commit that closed the loop')
  .action(async (id: string, options) => {
    const s = getStore();
    const found = await resolveIntentionArg(s, id);
    if (!found) return;

    const closed = await s.updateIntentionStatus(found.id, 'closed', { closedByCommit: options.commit });
    for (const cue of await s.listCues({ intentionId: found.id, status: 'armed' })) {
      await s.updateCueStatus(cue.id, 'cancelled');
    }

    console.log(`\n✅ ${loopId(closed.id)} closed — ${closed.content}\n`);
  });

intent
  .command('fire <id>')
  .description('Force a loop to wake (debug)')
  .action(async (id: string) => {
    const s = getStore();
    const found = await resolveIntentionArg(s, id);
    if (!found) return;

    const fired = await s.updateIntentionStatus(found.id, 'fired');
    console.log(`\n⏰ ${loopId(fired.id)} woken — ${fired.content}\n`);
  });

intent
  .command('resolve')
  .description('Sweep: expire overdue loops, fire deadlines that have come due')
  .action(async () => {
    const s = getStore();
    const resolver = new SqliteCueResolver(s);

    const expired = await resolver.expireStale();
    const fired = [];
    for (const cue of await resolver.resolveTimeCues()) {
      fired.push(await resolver.fire(cue.id));
    }

    console.log(`\n💤 ${expired} expired | ⏰ ${fired.length} woken`);
    for (const i of fired) console.log(`   ${loopId(i.id)} — ${i.content}`);
    console.log();
  });

// === EMBED (Phase 7.2) ===
const embed = program.command('embed').description('Vector index maintenance (Phase 7)');

embed
  .command('backfill')
  .description('Embed every trace missing a vector for the current model (idempotent)')
  .option('-n, --limit <n>', 'Max traces per run', '500')
  .option('--dtype <dtype>', 'Model quantization (q8|fp16)', 'q8')
  .action(async (options) => {
    const s = getStore();
    const { OnnxEmbedder, embeddableText } = await import('../core/embeddings.js');

    const embedder = new OnnxEmbedder({ dtype: options.dtype });
    console.log(`⏳ Model: ${embedder.modelId} (first run downloads ~120MB into data/models/)…`);

    const missing = await s.listMissingEmbeddings(embedder.modelId, parseInt(options.limit));
    if (!missing.length) {
      console.log('✓ Nothing to embed — the index is current.');
      return;
    }
    console.log(`⏳ Embedding ${missing.length} trace(s)…`);

    const BATCH = 32;
    let done = 0;
    for (let i = 0; i < missing.length; i += BATCH) {
      const batch = missing.slice(i, i + BATCH);
      const vectors = await embedder.embed(batch.map(embeddableText));
      for (let k = 0; k < batch.length; k++) {
        await s.setEmbedding(batch[k].id, embedder.modelId, vectors[k]);
      }
      done += batch.length;
      console.log(`   ${done}/${missing.length}`);
    }
    console.log(`✓ Backfill complete: ${done} trace(s) embedded.`);
  });

// === DREAM (Phase 6.1) ===
const dream = program.command('dream').description('Cross-session consolidation (dreaming)');

dream
  .command('run', { isDefault: true })
  .description('Detect recurring patterns across sessions/agents and file proposals')
  .option('--clusterer <kind>', 'keyword (default — 7.5 calibration kept it: vector F1 0.84/P 0.76) | vector (needs the model)', 'keyword')
  .action(async (options) => {
    const s = getStore();
    const { runDreamer, KeywordClusterer } = await import('../core/dreamer.js');

    let clusterer: import('../core/dreamer.js').Clusterer = new KeywordClusterer();
    if (options.clusterer === 'vector') {
      const { OnnxEmbedder } = await import('../core/embeddings.js');
      const { VectorClusterer } = await import('../core/vector-clusterer.js');
      clusterer = new VectorClusterer(new OnnxEmbedder(), s);
      console.log('⏳ Vector clustering (embeds missing traces in batch first)…');
    }

    const report = await runDreamer({ store: s, clusterer });
    console.log(`\n🌙 Dream report`);
    console.log(`  Traces considered: ${report.considered}`);
    console.log(`  Clusters found: ${report.clusters}`);
    console.log(`  Proposals filed: ${report.filed} (${report.expired} expired)`);
    if (report.staleLoopCandidates) console.log(`  Stale loops spotted: ${report.staleLoopCandidates}`);
    const pending = report.proposals.length;
    if (pending) console.log(`\n  ${pending} dream(s) pending — run \`pnpm cli dream review\`.`);
  });

dream
  .command('review')
  .description('List pending dream proposals')
  .action(async () => {
    const s = getStore();
    const pending = await s.listDreamProposals!({ status: 'pending' });

    if (!pending.length) {
      console.log('No dream pending.');
      return;
    }
    console.log(`\n🌙 ${pending.length} dream(s) pending:\n`);
    for (const p of pending) {
      const payload = JSON.parse(p.payload);
      console.log(`  [${p.kind}] ${p.id.slice(0, 8)}… — confidence ${p.confidence}`);
      if (payload.samples) for (const s2 of payload.samples) console.log(`      · ${s2}`);
      if (payload.content) console.log(`      · ${payload.content}`);
      if (payload.expiresAt || p.expiresAt) console.log(`      expires ${p.expiresAt?.toISOString().split('T')[0]}`);
      console.log();
    }
  });

for (const verb of ['approve', 'reject'] as const) {
  dream
    .command(`${verb} <id>`)
    .description(`${verb === 'approve' ? 'Apply' : 'Archive'} a dream proposal (human gate)`)
    .action(async (id) => {
      const s = getStore();

      const pending = await s.listDreamProposals!({ status: 'pending', includeExpired: true });
      const target = pending.find((p) => p.id === id || p.id.startsWith(id));
      if (!target) {
        console.error(`✗ No pending dream matches ${id}`);
        process.exit(1);
      }

      if (verb === 'approve') {
        const { applyDreamProposal } = await import('../core/dreamer.js');
        const effect = await applyDreamProposal(s, target);
        await s.resolveDreamProposal!(target.id, 'approved');
        console.log(`✓ Dream approved — ${effect}`);
      } else {
        await s.resolveDreamProposal!(target.id, 'rejected');
        console.log(`✓ Dream rejected — it will not resurface unless the pattern recurs.`);
      }
    });
}

// Parse and run
program.parse();

// Cleanup
process.on('exit', () => {
  if (store) store.close();
});
