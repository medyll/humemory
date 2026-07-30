import { describe, test, expect } from 'bun:test';
import {
  buildSessionContext,
  humanizeAge,
  DEFAULT_SESSION_BUDGET,
  DEFAULT_SAILLANCE_THRESHOLD,
} from '../src/agent/session-context.js';
import { SqliteCueResolver, loopId, extractLoopIds, matchIntentionByShortId } from '../src/core/cues.js';
import { freshStore } from './helpers/store.js';
import { fakeClock, T0 } from './helpers/clock.js';
import { seedIntentions } from './helpers/fixtures.js';
import type { Intention } from '../src/core/types.js';

/**
 * Phase 5.3.1 — bloc de contexte injecté au SessionStart (story S5-03a).
 * On teste le builder, pas le script : `scripts/hook-session-start.ts` n'est
 * qu'une coquille qui lit l'env et écrit sur stdout.
 */

function setup(directory = '/src/auth') {
  const clock = fakeClock();
  const store = freshStore({ clock });
  const resolver = new SqliteCueResolver(store, { clock });
  return { clock, store, resolver, directory };
}

describe('Identité courte des boucles', () => {
  test('loopId produit un identifiant recopiable à la main', () => {
    expect(loopId('a1b2c3d4-e5f6-7890-abcd-ef1234567890')).toBe('loop-a1b2c3d4');
  });

  test('extractLoopIds lit les mentions d\'un message de commit', () => {
    const message = 'fix(auth): token expiry\n\nCloses loop-a1b2c3d4 et loop-deadbeef';
    expect(extractLoopIds(message).sort()).toEqual(['a1b2c3d4', 'deadbeef']);
  });

  test('extractLoopIds ne trouve rien dans un message ordinaire', () => {
    expect(extractLoopIds('chore: bump deps')).toEqual([]);
  });

  test('un préfixe ambigu ne désigne aucune boucle', () => {
    const a = { id: 'abc11111-0000-0000-0000-000000000000' } as Intention;
    const b = { id: 'abc22222-0000-0000-0000-000000000000' } as Intention;

    expect(matchIntentionByShortId([a, b], 'abc')).toBeNull(); // ambigu → on ne ferme rien
    expect(matchIntentionByShortId([a, b], 'abc11111')?.id).toBe(a.id);
    expect(matchIntentionByShortId([a, b], 'zzz')).toBeNull();
  });
});

describe('humanizeAge', () => {
  test('rend des durées lisibles', () => {
    const base = new Date(T0);
    expect(humanizeAge(base, base)).toBe("à l'instant");
    expect(humanizeAge(base, new Date(T0.getTime() + 30 * 60_000))).toBe('il y a 30min');
    expect(humanizeAge(base, new Date(T0.getTime() + 5 * 3600_000))).toBe('il y a 5h');
    expect(humanizeAge(base, new Date(T0.getTime() + 2 * 86_400_000))).toBe('il y a 2j');
    expect(humanizeAge(base, new Date(T0.getTime() + 90 * 86_400_000))).toBe('il y a 3 mois');
  });
});

describe('Composition du contexte', () => {
  test('sans rien à dire, le bloc est vide — pas de pollution du prompt', async () => {
    const { store, resolver, directory } = setup();
    const ctx = await buildSessionContext({ store, resolver, directory, clock: fakeClock() });

    expect(ctx.markdown).toBe('');
    expect(ctx.openLoops).toEqual([]);
    store.close();
  });

  test('les boucles ouvertes du répertoire courant sont listées', async () => {
    const { clock, store, resolver, directory } = setup();
    await store.addIntention({ content: 'refactor la validation de token', directory });

    clock.advanceDays(2);
    const ctx = await buildSessionContext({ store, resolver, directory, clock });

    expect(ctx.openLoops.length).toBe(1);
    expect(ctx.markdown).toContain('## 🧠 Contexte mnésique (humemory)');
    expect(ctx.markdown).toContain('### Boucles ouvertes (Zeigarnik)');
    expect(ctx.markdown).toContain('refactor la validation de token');
    expect(ctx.markdown).toContain('armée il y a 2j');
    store.close();
  });

  test('les boucles des autres projets ne fuitent pas', async () => {
    const { store, resolver, directory } = setup();
    await store.addIntention({ content: 'ici', directory });
    await store.addIntention({ content: 'ailleurs', directory: '/autre/projet' });

    const ctx = await buildSessionContext({ store, resolver, directory, clock: fakeClock() });

    expect(ctx.openLoops.length).toBe(1);
    expect(ctx.markdown).not.toContain('ailleurs');
    store.close();
  });

  test('le bloc rappelle comment fermer une boucle', async () => {
    const { store, resolver, directory } = setup();
    const i = await store.addIntention({ content: 'x', directory });

    const ctx = await buildSessionContext({ store, resolver, directory, clock: fakeClock() });
    expect(ctx.markdown).toContain(`Closes ${loopId(i.id)}`);
    store.close();
  });

  test('la branche courante apparaît en en-tête', async () => {
    const { store, resolver, directory } = setup();
    await store.addIntention({ content: 'x', directory });

    const ctx = await buildSessionContext({
      store,
      resolver,
      directory,
      branch: 'feature/prospective',
      clock: fakeClock(),
    });
    expect(ctx.markdown).toContain('`feature/prospective`');
    store.close();
  });

  test('une échéance atteinte remonte dans sa propre section', async () => {
    const { clock, store, resolver, directory } = setup();
    await store.addIntention({ content: 'bench decay', directory }, [
      { kind: 'time', at: new Date(T0.getTime() + 3600_000).toISOString() },
    ]);

    clock.advanceHours(2);
    const ctx = await buildSessionContext({ store, resolver, directory, clock });

    expect(ctx.firedNow.length).toBe(1);
    expect(ctx.markdown).toContain('### ⏰ Échéances atteintes');
    expect(ctx.markdown).toContain('bench decay');
    // Elle n'est plus « armée » : elle a été tirée pendant la composition.
    expect(ctx.openLoops.length).toBe(0);
    store.close();
  });

  test('les boucles périmées sont expirées au passage, pas affichées', async () => {
    const { clock, store, resolver, directory } = setup();
    const i = await store.addIntention({
      content: 'trop tard',
      directory,
      expiresAt: new Date(T0.getTime() + 3600_000),
    });

    clock.advanceHours(2);
    const ctx = await buildSessionContext({ store, resolver, directory, clock });

    expect(ctx.markdown).toBe('');
    expect((await store.getIntention(i.id))!.status).toBe('expired');
    store.close();
  });

  test('sans resolver, aucun effet de bord — composition en lecture seule', async () => {
    const { clock, store, directory } = setup();
    const i = await store.addIntention({
      content: 'périmée mais intouchée',
      directory,
      expiresAt: new Date(T0.getTime() + 3600_000),
    });

    clock.advanceHours(2);
    await buildSessionContext({ store, directory, clock });

    expect((await store.getIntention(i.id))!.status).toBe('armed');
    store.close();
  });
});

describe('Traces dégradées rappelées', () => {
  async function seedTrace(
    store: ReturnType<typeof freshStore>,
    directory: string,
    overrides: { content: string; level: number; saillance: number }
  ) {
    const m = await store.add({
      content: overrides.content,
      directory,
      day: '2026-01-01',
      keywords: ['k'],
      sessionId: 's',
    });
    // On force niveau et saillance : ici on teste la sélection, pas la courbe de decay.
    (store as any).db
      .query('UPDATE memories SET current_level = $l, saillance = $s, level2_essential = $e WHERE id = $id')
      .run({ $l: overrides.level, $s: overrides.saillance, $e: `essentiel: ${overrides.content}`, $id: m.id });
    return m;
  }

  test('seules les traces dégradées et encore saillantes remontent', async () => {
    const { store, resolver, directory } = setup();

    await seedTrace(store, directory, { content: 'utile et saillante', level: 2, saillance: 90 });
    await seedTrace(store, directory, { content: 'oubliée', level: 2, saillance: 10 });
    await seedTrace(store, directory, { content: 'encore fraîche', level: 0, saillance: 95 });

    const ctx = await buildSessionContext({ store, resolver, directory, clock: fakeClock() });

    expect(ctx.traces.length).toBe(1);
    expect(ctx.markdown).toContain('utile et saillante');
    expect(ctx.markdown).not.toContain('oubliée');
    expect(ctx.markdown).not.toContain('encore fraîche'); // L0 : l'agent l'a encore en tête
    store.close();
  });

  test('la trace est rendue au niveau où elle est tombée', async () => {
    const { store, resolver, directory } = setup();
    await seedTrace(store, directory, { content: 'race condition résolue par mutex', level: 2, saillance: 80 });

    const ctx = await buildSessionContext({ store, resolver, directory, clock: fakeClock() });

    expect(ctx.markdown).toContain('[L2]');
    expect(ctx.markdown).toContain('essentiel: race condition résolue par mutex');
    store.close();
  });

  test('le budget plafonne le nombre de traces', async () => {
    const { store, resolver, directory } = setup();
    for (let i = 0; i < 8; i++) {
      await seedTrace(store, directory, { content: `trace ${i}`, level: 3, saillance: 70 + i });
    }

    const ctx = await buildSessionContext({ store, resolver, directory, budget: 3, clock: fakeClock() });

    expect(ctx.traces.length).toBe(3);
    store.close();
  });

  test('les constantes par défaut sont celles annoncées', () => {
    expect(DEFAULT_SESSION_BUDGET).toBe(10);
    expect(DEFAULT_SAILLANCE_THRESHOLD).toBe(60);
  });
});

describe('Bout-en-bout — fixtures', () => {
  test('les boucles de fixtures composent un bloc complet', async () => {
    const clock = fakeClock();
    const store = freshStore({ clock });
    const resolver = new SqliteCueResolver(store, { clock });

    await seedIntentions(store, { now: clock.now() });
    const ctx = await buildSessionContext({
      store,
      resolver,
      directory: '/src/auth',
      branch: 'main',
      clock,
    });

    // Seule refactor-auth vit dans /src/auth.
    expect(ctx.openLoops.length).toBe(1);
    expect(ctx.markdown).toContain('Refactorer la validation de token');
    expect(ctx.markdown).toContain('échéance dans 7j');
    store.close();
  });
});
