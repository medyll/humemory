import { describe, test, expect } from 'bun:test';
import { freshStore } from './helpers/store.js';
import { fakeClock, T0 } from './helpers/clock.js';
import { seedIntentions, intentionFixtures } from './helpers/fixtures.js';
import type { TriggerSpec } from '../src/core/types.js';

/**
 * Phase 5.1 — modèle de données prospectif (story S5-01).
 * Couche données seulement : armer, lister, transitionner. Le déclenchement
 * (resolveTimeCues / resolveEventCues / expireStale) arrive en S5-02.
 */

const FILE_CUE: TriggerSpec = { kind: 'event', type: 'file_open', path: 'src/auth/service.ts' };
const TIME_CUE: TriggerSpec = { kind: 'time', at: '2026-01-08T09:00:00.000Z' };

describe('Schéma — migrations idempotentes', () => {
  test('rejouer initSchema sur une base existante ne perd rien', async () => {
    const { mkdtempSync, rmSync } = await import('fs');
    const { tmpdir } = await import('os');
    const { join } = await import('path');
    const { SQLiteStore } = await import('../src/store/sqlite.js');

    const dir = mkdtempSync(join(tmpdir(), 'humemory-mig-'));
    const dbPath = join(dir, 'mig.db');

    try {
      const first = new SQLiteStore(dbPath, { clock: fakeClock() });
      const intention = await first.addIntention(
        { content: 'survit à la réouverture', directory: '/src' },
        [FILE_CUE]
      );
      first.close();

      // Réouverture : CREATE TABLE IF NOT EXISTS rejoué sur des tables peuplées.
      const second = new SQLiteStore(dbPath, { clock: fakeClock() });
      const reloaded = await second.getIntention(intention.id);

      expect(reloaded).not.toBeNull();
      expect(reloaded!.content).toBe('survit à la réouverture');
      expect((await second.listCues({ intentionId: intention.id })).length).toBe(1);
      second.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('Intentions — écriture et lecture', () => {
  test('addIntention arme par défaut avec saillance 100', async () => {
    const store = freshStore();
    const i = await store.addIntention({ content: 'refactor fn X', directory: '/src/auth' });

    expect(i.status).toBe('armed');
    expect(i.saillance).toBe(100); // boucle ouverte = saillance figée au max
    expect(i.createdAt.toISOString()).toBe(T0.toISOString());
    expect(i.expiresAt).toBeUndefined(); // intention sans deadline
    store.close();
  });

  test('les horodatages viennent de l\'horloge injectée', async () => {
    const clock = fakeClock();
    const store = freshStore({ clock });

    clock.advanceHours(5);
    const i = await store.addIntention({ content: 'plus tard', directory: '/src' });

    expect(i.createdAt.getTime()).toBe(T0.getTime() + 5 * 3600_000);
    store.close();
  });

  test('addIntention arme ses cues dans la même écriture', async () => {
    const store = freshStore();
    const i = await store.addIntention(
      { content: 'refactor auth', directory: '/src/auth' },
      [FILE_CUE, TIME_CUE]
    );

    const cues = await store.listCues({ intentionId: i.id });
    expect(cues.length).toBe(2);
    expect(cues.map((c) => c.kind).sort()).toEqual(['event', 'time']);
    expect(cues.every((c) => c.status === 'armed')).toBe(true);
    store.close();
  });

  test('le triggerSpec fait l\'aller-retour JSON sans perdre son type', async () => {
    const store = freshStore();
    const i = await store.addIntention({ content: 'c', directory: '/d' }, [FILE_CUE]);

    const [cue] = await store.listCues({ intentionId: i.id });
    expect(cue.triggerSpec).toEqual(FILE_CUE);
    // Le discriminant survit — c'est lui que le resolver lira en 5.2.
    expect(cue.triggerSpec.kind).toBe('event');
    store.close();
  });

  test('getIntention renvoie null pour un id inconnu', async () => {
    const store = freshStore();
    expect(await store.getIntention('inexistant')).toBeNull();
    store.close();
  });
});

describe('Intentions — filtres de liste', () => {
  test('filtre par statut, simple ou multiple', async () => {
    const store = freshStore();
    const a = await store.addIntention({ content: 'a', directory: '/x' });
    const b = await store.addIntention({ content: 'b', directory: '/x' });
    await store.addIntention({ content: 'c', directory: '/x' });

    await store.updateIntentionStatus(a.id, 'fired');
    await store.updateIntentionStatus(b.id, 'closed');

    expect((await store.listIntentions({ status: 'armed' })).length).toBe(1);
    expect((await store.listIntentions({ status: ['fired', 'closed'] })).length).toBe(2);
    store.close();
  });

  test('filtre par lieu mental', async () => {
    const store = freshStore();
    await store.addIntention({ content: 'ici', directory: '/src/auth' });
    await store.addIntention({ content: 'ailleurs', directory: '/src/core' });

    const found = await store.listIntentions({ directory: '/src/auth' });
    expect(found.length).toBe(1);
    expect(found[0].content).toBe('ici');
    store.close();
  });

  test('un statut exotique ne casse pas la requête (valeur liée, pas de SQL concaténé)', async () => {
    const store = freshStore();
    await store.addIntention({ content: 'a', directory: '/x' });

    const hostile = "armed'; DROP TABLE intentions; --" as any;
    expect(await store.listIntentions({ status: hostile })).toEqual([]);
    // La table est toujours là.
    expect((await store.listIntentions()).length).toBe(1);
    store.close();
  });
});

describe('Intentions — transitions de statut', () => {
  test('fired pose fired_at une seule fois', async () => {
    const clock = fakeClock();
    const store = freshStore({ clock });
    const i = await store.addIntention({ content: 'x', directory: '/d' });

    clock.advanceHours(2);
    const fired = await store.updateIntentionStatus(i.id, 'fired');
    const firstFiredAt = fired.firedAt!.getTime();
    expect(firstFiredAt).toBe(T0.getTime() + 2 * 3600_000);

    // Re-firer ne doit pas réécrire l'horodatage d'origine.
    clock.advanceHours(3);
    const again = await store.updateIntentionStatus(i.id, 'fired');
    expect(again.firedAt!.getTime()).toBe(firstFiredAt);
    store.close();
  });

  test('closed pose closed_at et le SHA du commit qui a fermé la boucle', async () => {
    const clock = fakeClock();
    const store = freshStore({ clock });
    const i = await store.addIntention({ content: 'x', directory: '/d' });

    clock.advanceDays(1);
    const closed = await store.updateIntentionStatus(i.id, 'closed', { closedByCommit: 'deadbee' });

    expect(closed.status).toBe('closed');
    expect(closed.closedAt!.getTime()).toBe(T0.getTime() + 24 * 3600_000);
    expect(closed.closedByCommit).toBe('deadbee');
    store.close();
  });

  test('expired est un soft-delete : la ligne reste consultable', async () => {
    const store = freshStore();
    const i = await store.addIntention({ content: 'périmée', directory: '/d' });

    await store.updateIntentionStatus(i.id, 'expired');

    const still = await store.getIntention(i.id);
    expect(still).not.toBeNull();
    expect(still!.status).toBe('expired');
    store.close();
  });

  test('transitionner une intention inconnue lève', async () => {
    const store = freshStore();
    await expect(store.updateIntentionStatus('inexistant', 'fired')).rejects.toThrow(/not found/);
    store.close();
  });
});

describe('Cues', () => {
  test('addCue refuse une intention inexistante', async () => {
    const store = freshStore();
    await expect(store.addCue({ intentionId: 'inexistant', triggerSpec: TIME_CUE })).rejects.toThrow(
      /not found/
    );
    store.close();
  });

  test('fired pose fired_at, cancelled ne le pose pas', async () => {
    const clock = fakeClock();
    const store = freshStore({ clock });
    const i = await store.addIntention({ content: 'x', directory: '/d' }, [TIME_CUE, FILE_CUE]);
    const [timeCue, eventCue] = await store.listCues({ intentionId: i.id, kind: 'time' }).then(
      async (t) => [t[0], (await store.listCues({ intentionId: i.id, kind: 'event' }))[0]]
    );

    clock.advanceHours(4);
    const fired = await store.updateCueStatus(timeCue.id, 'fired');
    const cancelled = await store.updateCueStatus(eventCue.id, 'cancelled');

    expect(fired.firedAt!.getTime()).toBe(T0.getTime() + 4 * 3600_000);
    expect(cancelled.status).toBe('cancelled');
    expect(cancelled.firedAt).toBeUndefined();
    store.close();
  });

  test('filtre par kind', async () => {
    const store = freshStore();
    const i = await store.addIntention({ content: 'x', directory: '/d' }, [TIME_CUE, FILE_CUE]);

    expect((await store.listCues({ intentionId: i.id, kind: 'time' })).length).toBe(1);
    expect((await store.listCues({ intentionId: i.id, kind: 'event' })).length).toBe(1);
    store.close();
  });

  test('supprimer l\'intention emporte ses cues (ON DELETE CASCADE)', async () => {
    const store = freshStore();
    const i = await store.addIntention({ content: 'x', directory: '/d' }, [TIME_CUE, FILE_CUE]);
    expect((await store.listCues({ intentionId: i.id })).length).toBe(2);

    await store.deleteIntention(i.id);

    expect(await store.getIntention(i.id)).toBeNull();
    expect((await store.listCues({ intentionId: i.id })).length).toBe(0); // pas d'orphelins
    store.close();
  });
});

describe('Fixtures — boucles ouvertes', () => {
  test('seedIntentions arme les boucles et leurs cues depuis le fichier', async () => {
    const clock = fakeClock();
    const store = freshStore({ clock });
    const seeded = await seedIntentions(store, { now: clock.now() });

    expect(Object.keys(seeded).sort()).toEqual(
      intentionFixtures()
        .map((f) => f.key)
        .sort()
    );

    // doc-prospective porte deux cues : un event, un cron.
    const doc = seeded['doc-prospective'];
    const cues = await store.listCues({ intentionId: doc.id });
    expect(cues.length).toBe(2);
    expect(doc.expiresAt).toBeUndefined(); // pas de deadline déclarée

    store.close();
  });

  test('les deadlines sont relatives à l\'horloge, pas absolues', async () => {
    const clock = fakeClock();
    const store = freshStore({ clock });
    const seeded = await seedIntentions(store, { now: clock.now() });

    // refactor-auth déclare expiresInHours: 168
    expect(seeded['refactor-auth'].expiresAt!.getTime()).toBe(T0.getTime() + 168 * 3600_000);
    // expired-loop déclare 1h — déjà périmée après un saut d'un jour.
    expect(seeded['expired-loop'].expiresAt!.getTime()).toBeLessThan(
      clock.advanceDays(1).now().getTime()
    );

    store.close();
  });

  test('toutes les boucles seedées sont armées', async () => {
    const store = freshStore();
    const seeded = await seedIntentions(store);

    expect(Object.values(seeded).every((i) => i.status === 'armed')).toBe(true);
    expect((await store.listIntentions({ status: 'armed' })).length).toBe(
      intentionFixtures().length
    );
    store.close();
  });
});
