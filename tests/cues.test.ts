import { describe, test, expect } from 'bun:test';
import {
  SqliteCueResolver,
  attachResolverToBus,
  intentionSaillance,
  parseCron,
  cronMatches,
  cronDueSince,
  eventTriggerMatches,
  CRON_CATCHUP_MINUTES,
} from '../src/core/cues.js';
import { InMemoryEventBus } from '../src/core/event-bus.js';
import { freshStore } from './helpers/store.js';
import { fakeClock, T0 } from './helpers/clock.js';
import { seedIntentions } from './helpers/fixtures.js';
import type { Intention, TriggerSpec } from '../src/core/types.js';

/**
 * Phase 5.2 — cue resolver (story S5-02).
 * Tout est piloté par la FakeClock et l'InMemoryEventBus : aucune attente réelle,
 * aucun accès FS, aucun appel git.
 */

function setup() {
  const clock = fakeClock();
  const store = freshStore({ clock });
  const resolver = new SqliteCueResolver(store, { clock });
  return { clock, store, resolver };
}

describe('Cron — parsing', () => {
  test('accepte les formes usuelles', () => {
    expect(parseCron('0 9 * * 1')).not.toBeNull(); // lundi 9h
    expect(parseCron('*/15 * * * *')).not.toBeNull();
    expect(parseCron('0 0-6/2 1,15 * *')).not.toBeNull();
  });

  test('rejette les expressions invalides sans lever', () => {
    expect(parseCron('0 9 * *')).toBeNull(); // 4 champs
    expect(parseCron('60 * * * *')).toBeNull(); // minute hors bornes
    expect(parseCron('0 9 * * 9')).toBeNull(); // jour de semaine hors bornes
    expect(parseCron('abc * * * *')).toBeNull();
    expect(parseCron('*/0 * * * *')).toBeNull(); // pas de step nul
  });

  test('un cron invalide n\'est jamais dû, plutôt que de planter', () => {
    expect(cronDueSince('pas du cron', T0, new Date(T0.getTime() + 86_400_000))).toBe(false);
  });
});

describe('Cron — matching', () => {
  const lundi9h = parseCron('0 9 * * 1')!;

  test('matche la minute exacte', () => {
    // 2026-01-05 est un lundi.
    expect(cronMatches(lundi9h, new Date('2026-01-05T09:00:00Z'))).toBe(true);
    expect(cronMatches(lundi9h, new Date('2026-01-05T09:01:00Z'))).toBe(false);
    expect(cronMatches(lundi9h, new Date('2026-01-06T09:00:00Z'))).toBe(false); // mardi
  });

  test('jour-du-mois et jour-de-semaine se combinent en OU (cron standard)', () => {
    const parsed = parseCron('0 9 1 * 1')!; // le 1er du mois OU le lundi
    expect(cronMatches(parsed, new Date('2026-01-01T09:00:00Z'))).toBe(true); // jeudi 1er
    expect(cronMatches(parsed, new Date('2026-01-05T09:00:00Z'))).toBe(true); // lundi 5
    expect(cronMatches(parsed, new Date('2026-01-06T09:00:00Z'))).toBe(false);
  });

  test('cronDueSince rattrape une occurrence manquée entre deux sessions', () => {
    const since = new Date('2026-01-04T00:00:00Z'); // dimanche
    const now = new Date('2026-01-05T18:00:00Z'); // lundi soir, 9h est passé
    expect(cronDueSince('0 9 * * 1', since, now)).toBe(true);
  });

  test('mais ne remonte pas au-delà de la fenêtre de rattrapage', () => {
    const since = new Date('2025-01-01T00:00:00Z');
    const now = new Date('2026-01-05T18:00:00Z');
    // L'occurrence de lundi dernier reste dans la fenêtre → due.
    expect(cronDueSince('0 9 * * 1', since, now)).toBe(true);

    // Une occurrence annuelle, elle, tombe hors fenêtre.
    expect(cronDueSince('0 9 1 7 *', since, now)).toBe(false);
    expect(CRON_CATCHUP_MINUTES).toBe(7 * 24 * 60);
  });

  test('rien n\'est dû si la référence est postérieure à l\'occurrence', () => {
    const since = new Date('2026-01-05T12:00:00Z'); // après 9h
    const now = new Date('2026-01-05T18:00:00Z');
    expect(cronDueSince('0 9 * * 1', since, now)).toBe(false);
  });
});

describe('resolveTimeCues', () => {
  test('un cue daté ne remonte qu\'une fois l\'échéance atteinte', async () => {
    const { clock, store, resolver } = setup();
    const at = new Date(T0.getTime() + 24 * 3600_000).toISOString();
    await store.addIntention({ content: 'demain', directory: '/src' }, [{ kind: 'time', at }]);

    expect(await resolver.resolveTimeCues()).toEqual([]);

    clock.advanceHours(24);
    const due = await resolver.resolveTimeCues();
    expect(due.length).toBe(1);
    store.close();
  });

  test('un cue dont l\'intention n\'est plus armed ne remonte pas', async () => {
    const { clock, store, resolver } = setup();
    const i = await store.addIntention({ content: 'x', directory: '/src' }, [
      { kind: 'time', at: T0.toISOString() },
    ]);
    await store.updateIntentionStatus(i.id, 'closed');

    clock.advanceDays(2);
    expect(await resolver.resolveTimeCues()).toEqual([]);
    store.close();
  });

  test('une date invalide n\'est jamais due', async () => {
    const { clock, store, resolver } = setup();
    await store.addIntention({ content: 'x', directory: '/src' }, [
      { kind: 'time', at: 'pas une date' },
    ]);

    clock.advanceDays(365);
    expect(await resolver.resolveTimeCues()).toEqual([]);
    store.close();
  });

  test('les cues événementiels ne sortent pas par la voie temporelle', async () => {
    const { clock, store, resolver } = setup();
    await store.addIntention({ content: 'x', directory: '/src' }, [
      { kind: 'event', type: 'branch_switch', branch: 'main' },
    ]);

    clock.advanceDays(30);
    expect(await resolver.resolveTimeCues()).toEqual([]);
    store.close();
  });
});

describe('resolveEventCues', () => {
  test('branch_switch matche à l\'identique', async () => {
    const { store, resolver } = setup();
    await store.addIntention({ content: 'doc', directory: '/src' }, [
      { kind: 'event', type: 'branch_switch', branch: 'feature/x' },
    ]);

    expect(
      (await resolver.resolveEventCues({ type: 'branch_switch', branch: 'feature/x', directory: '/src' }))
        .length
    ).toBe(1);
    expect(
      (await resolver.resolveEventCues({ type: 'branch_switch', branch: 'main', directory: '/src' })).length
    ).toBe(0);
    store.close();
  });

  test('file_open matche le chemin exact ou en suffixe', async () => {
    const { store, resolver } = setup();
    await store.addIntention({ content: 'refactor', directory: '/src/auth' }, [
      { kind: 'event', type: 'file_open', path: 'src/auth/service.ts' },
    ]);

    const exact = await resolver.resolveEventCues({
      type: 'file_open',
      path: 'src/auth/service.ts',
      directory: '/src/auth',
    });
    const absolu = await resolver.resolveEventCues({
      type: 'file_open',
      path: '/home/dev/projet/src/auth/service.ts',
      directory: '/src/auth',
    });
    const autre = await resolver.resolveEventCues({
      type: 'file_open',
      path: 'src/auth/other.ts',
      directory: '/src/auth',
    });

    expect(exact.length).toBe(1);
    expect(absolu.length).toBe(1);
    expect(autre.length).toBe(0);
    store.close();
  });

  test('les séparateurs Windows matchent comme les POSIX', async () => {
    const { store, resolver } = setup();
    await store.addIntention({ content: 'x', directory: '/src/auth' }, [
      { kind: 'event', type: 'file_open', path: 'src/auth/service.ts' },
    ]);

    const found = await resolver.resolveEventCues({
      type: 'file_open',
      path: 'D:\\projet\\src\\auth\\service.ts',
      directory: '/src/auth',
    });
    expect(found.length).toBe(1);
    store.close();
  });

  test('error_pattern accepte une regex, et retombe en littéral si elle est invalide', async () => {
    const { store, resolver } = setup();
    await store.addIntention({ content: 'regex', directory: '/src' }, [
      { kind: 'event', type: 'error_pattern', pattern: 'SQLITE_(BUSY|LOCKED)' },
    ]);
    await store.addIntention({ content: 'littéral', directory: '/src' }, [
      { kind: 'event', type: 'error_pattern', pattern: 'segfault((' },
    ]);

    const regex = await resolver.resolveEventCues({
      type: 'error_pattern',
      text: 'Error: SQLITE_BUSY: database is locked',
      directory: '/src',
    });
    const litteral = await resolver.resolveEventCues({
      type: 'error_pattern',
      text: 'boom: segfault(( at 0x0',
      directory: '/src',
    });

    expect(regex.length).toBe(1);
    expect(litteral.length).toBe(1); // pattern invalide → recherche littérale, pas de crash
    store.close();
  });

  test('un event venu d\'un autre lieu mental ne réveille rien', async () => {
    const { store, resolver } = setup();
    await store.addIntention({ content: 'auth', directory: '/src/auth' }, [
      { kind: 'event', type: 'branch_switch', branch: 'main' },
    ]);

    const ailleurs = await resolver.resolveEventCues({
      type: 'branch_switch',
      branch: 'main',
      directory: '/autre/projet',
    });
    const sousDossier = await resolver.resolveEventCues({
      type: 'branch_switch',
      branch: 'main',
      directory: '/src/auth/middleware',
    });

    expect(ailleurs.length).toBe(0); // DB partagée entre projets : pas de fuite
    expect(sousDossier.length).toBe(1);
    store.close();
  });

  test('un commit ne réveille aucune intention — il les ferme (S5-03b)', async () => {
    const { store, resolver } = setup();
    await store.addIntention({ content: 'x', directory: '/src' }, [
      { kind: 'event', type: 'file_open', path: 'src/a.ts' },
    ]);

    const found = await resolver.resolveEventCues({
      type: 'commit',
      sha: 'deadbee',
      message: 'fix: x',
      files: ['src/a.ts'],
      directory: '/src',
    });
    expect(found).toEqual([]);
    store.close();
  });
});

describe('fire', () => {
  test('marque cue et intention comme firés', async () => {
    const { clock, store, resolver } = setup();
    const i = await store.addIntention({ content: 'x', directory: '/src' }, [
      { kind: 'time', at: T0.toISOString() },
    ]);
    const [cue] = await store.listCues({ intentionId: i.id });

    clock.advanceHours(3);
    const fired = await resolver.fire(cue.id);

    expect(fired.status).toBe('fired');
    expect(fired.firedAt!.getTime()).toBe(T0.getTime() + 3 * 3600_000);
    expect((await store.getCue(cue.id))!.status).toBe('fired');
    store.close();
  });

  test('un cue cron est ré-armé après tir — sinon la récurrence est un one-shot', async () => {
    const { clock, store, resolver } = setup();
    const i = await store.addIntention({ content: 'hebdo', directory: '/src' }, [
      { kind: 'time', cron: '0 9 * * 1' },
    ]);
    const [cue] = await store.listCues({ intentionId: i.id });

    clock.set('2026-01-05T09:00:00Z');
    await resolver.fire(cue.id);

    const after = await store.getCue(cue.id);
    expect(after!.status).toBe('armed'); // toujours armé pour la semaine suivante
    expect(after!.firedAt).not.toBeUndefined(); // mais le tir est enregistré
    store.close();
  });

  test('un cron ne re-remonte pas dans la même minute, mais remonte la semaine d\'après', async () => {
    const { clock, store, resolver } = setup();
    const i = await store.addIntention({ content: 'hebdo', directory: '/src' }, [
      { kind: 'time', cron: '0 9 * * 1' },
    ]);
    const [cue] = await store.listCues({ intentionId: i.id });

    clock.set('2026-01-05T09:00:00Z');
    expect((await resolver.resolveTimeCues()).length).toBe(1);
    await resolver.fire(cue.id);
    // L'intention est passée à fired → plus de réveil tant qu'elle n'est pas re-armée.
    expect((await resolver.resolveTimeCues()).length).toBe(0);

    await store.updateIntentionStatus(i.id, 'armed');
    expect((await resolver.resolveTimeCues()).length).toBe(0); // même minute, déjà tiré

    clock.set('2026-01-12T09:00:00Z'); // lundi suivant
    expect((await resolver.resolveTimeCues()).length).toBe(1);
    store.close();
  });

  test('firer un cue inconnu lève', async () => {
    const { store, resolver } = setup();
    await expect(resolver.fire('inexistant')).rejects.toThrow(/not found/);
    store.close();
  });
});

describe('expireStale', () => {
  test('passe en expired les intentions dont la deadline est dépassée, et annule leurs cues', async () => {
    const { clock, store, resolver } = setup();
    const seeded = await seedIntentions(store, { now: clock.now() });

    expect(await resolver.expireStale()).toBe(0); // rien n'est encore périmé

    clock.advanceHours(2); // expired-loop expire à +1h
    expect(await resolver.expireStale()).toBe(1);

    const expiree = await store.getIntention(seeded['expired-loop'].id);
    expect(expiree!.status).toBe('expired');

    const cues = await store.listCues({ intentionId: expiree!.id });
    expect(cues.every((c) => c.status === 'cancelled')).toBe(true); // pas de réveil fantôme
    store.close();
  });

  test('une intention sans deadline n\'expire jamais', async () => {
    const { clock, store, resolver } = setup();
    await store.addIntention({ content: 'sans deadline', directory: '/src' });

    clock.advanceDays(3650);
    expect(await resolver.expireStale()).toBe(0);
    store.close();
  });

  test('expireStale est idempotent', async () => {
    const { clock, store, resolver } = setup();
    await store.addIntention({
      content: 'périmée',
      directory: '/src',
      expiresAt: new Date(T0.getTime() + 3600_000),
    });

    clock.advanceHours(2);
    expect(await resolver.expireStale()).toBe(1);
    expect(await resolver.expireStale()).toBe(0); // second passage : plus rien à faire
    store.close();
  });

  test('un cue expiré ne remonte plus', async () => {
    const { clock, store, resolver } = setup();
    await store.addIntention(
      { content: 'x', directory: '/src', expiresAt: new Date(T0.getTime() + 3600_000) },
      [{ kind: 'time', at: T0.toISOString() }]
    );

    clock.advanceHours(2);
    await resolver.expireStale();
    expect(await resolver.resolveTimeCues()).toEqual([]);
    store.close();
  });
});

describe('Règles décay × intention', () => {
  test('armed → saillance figée à 100, quel que soit le temps écoulé', async () => {
    const { store } = setup();
    const i = await store.addIntention({ content: 'boucle ouverte', directory: '/src' });

    expect(intentionSaillance(i, new Date(T0.getTime() + 365 * 86_400_000))).toBe(100);
    store.close();
  });

  test('fired non closed → décline avec le temps (Zeigarnik qui faiblit)', async () => {
    const { clock, store, resolver } = setup();
    const i = await store.addIntention({ content: 'x', directory: '/src' }, [
      { kind: 'time', at: T0.toISOString() },
    ]);
    const [cue] = await store.listCues({ intentionId: i.id });
    const fired = await resolver.fire(cue.id);

    expect(intentionSaillance(fired, clock.now())).toBe(100);
    expect(intentionSaillance(fired, new Date(T0.getTime() + 2 * 86_400_000))).toBe(80);
    expect(intentionSaillance(fired, new Date(T0.getTime() + 20 * 86_400_000))).toBe(0);
    store.close();
  });

  test('closed et expired → 0, archivées', async () => {
    const { store } = setup();
    const base = await store.addIntention({ content: 'x', directory: '/src' });

    const closed: Intention = { ...base, status: 'closed' };
    const expired: Intention = { ...base, status: 'expired' };

    expect(intentionSaillance(closed, T0)).toBe(0);
    expect(intentionSaillance(expired, T0)).toBe(0);
    store.close();
  });
});

describe('Branchement sur l\'event bus', () => {
  test('publier un event réveille les intentions qui matchent', async () => {
    const { store, resolver } = setup();
    const bus = new InMemoryEventBus();
    const reveillees: string[] = [];

    const detach = attachResolverToBus(bus, resolver, {
      onFired: (intention) => {
        reveillees.push(intention.content);
      },
    });

    await store.addIntention({ content: 'documenter le resolver', directory: '/src' }, [
      { kind: 'event', type: 'branch_switch', branch: 'feature/prospective-memory' },
    ]);

    await bus.publish({
      type: 'branch_switch',
      branch: 'feature/prospective-memory',
      directory: '/src',
    });

    // publish() attend ses handlers : l'effet est observable ici, sans setTimeout.
    expect(reveillees).toEqual(['documenter le resolver']);
    expect((await store.listIntentions({ status: 'fired' })).length).toBe(1);

    detach();
    store.close();
  });

  test('après détachement, plus rien ne se réveille', async () => {
    const { store, resolver } = setup();
    const bus = new InMemoryEventBus();
    const detach = attachResolverToBus(bus, resolver);

    await store.addIntention({ content: 'x', directory: '/src' }, [
      { kind: 'event', type: 'branch_switch', branch: 'main' },
    ]);

    detach();
    await bus.publish({ type: 'branch_switch', branch: 'main', directory: '/src' });

    expect((await store.listIntentions({ status: 'fired' })).length).toBe(0);
    store.close();
  });

  test('bout-en-bout : boucle ouverte sur fixture, réveillée par un file_open', async () => {
    const { store, resolver } = setup();
    const bus = new InMemoryEventBus();
    attachResolverToBus(bus, resolver);

    const seeded = await seedIntentions(store);

    await bus.publish({
      type: 'file_open',
      path: 'src/auth/service.ts',
      directory: '/src/auth',
    });

    const reveillee = await store.getIntention(seeded['refactor-auth'].id);
    expect(reveillee!.status).toBe('fired');
    expect(reveillee!.firedAt).not.toBeUndefined();

    // Les autres boucles dorment toujours.
    expect((await store.listIntentions({ status: 'armed' })).length).toBe(3);
    store.close();
  });
});
