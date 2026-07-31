import { describe, test, expect } from 'bun:test';
import {
  applyCommitToLoops,
  renderCommitReport,
  tokenize,
  tokenizePath,
  scoreOverlap,
  MAX_SUGGESTIONS,
  type CommitInfo,
} from '../src/agent/commit-closer.js';
import { loopId } from '../src/core/cues.js';
import { freshStore } from './helpers/store.js';
import { fakeClock } from './helpers/clock.js';
import type { Intention } from '../src/core/types.js';

/**
 * Phase 5.3.2 — fermeture des boucles par commit (story S5-03b).
 * Aucun appel à git ici : on injecte un CommitInfo. Le script se charge de
 * l'interroger, ce module ne fait que décider.
 */

const DIR = '/repo/projet';

function setup() {
  const clock = fakeClock();
  const store = freshStore({ clock });
  return { clock, store };
}

function commit(overrides: Partial<CommitInfo> = {}): CommitInfo {
  return {
    sha: 'deadbee',
    message: 'chore: rien de spécial',
    files: [],
    directory: DIR,
    ...overrides,
  };
}

describe('Tokenisation', () => {
  test('ignore la casse, les accents et les mots trop courts', () => {
    expect(tokenize('Refactorer la VALIDATION dé token')).toEqual(['refactorer', 'validation', 'token']);
  });

  test('écarte les mots trop fréquents pour signaler quoi que ce soit', () => {
    // 'src', 'index', 'test' apparaissent partout : les garder ferait matcher tout avec tout.
    expect(tokenize('src index test middleware')).toEqual(['middleware']);
  });

  test('un chemin donne ses segments, sans extension', () => {
    expect(tokenizePath('src/auth/service.ts')).toEqual(['auth', 'service']);
    expect(tokenizePath('D:\\repo\\src\\auth\\middleware.ts')).toContain('middleware');
  });
});

describe('Score de recoupement', () => {
  test('recoupe le contenu de la boucle et les fichiers touchés', () => {
    const intention = { content: 'Refactorer le middleware auth' } as Intention;
    expect(scoreOverlap(intention, ['src/auth/middleware.ts']).sort()).toEqual(['auth', 'middleware']);
  });

  test('aucun recoupement sur des fichiers étrangers', () => {
    const intention = { content: 'Refactorer le middleware auth' } as Intention;
    expect(scoreOverlap(intention, ['docs/readme.md'])).toEqual([]);
  });
});

describe('Fermeture explicite', () => {
  test('"Closes loop-<id>" ferme la boucle et enregistre le SHA', async () => {
    const { store } = setup();
    const i = await store.addIntention({ content: 'refactor auth', directory: DIR });

    const result = await applyCommitToLoops(
      store,
      commit({ sha: 'cafe123', message: `fix(auth): expiry\n\nCloses ${loopId(i.id)}` })
    );

    expect(result.closed.length).toBe(1);
    const closed = await store.getIntention(i.id);
    expect(closed!.status).toBe('closed');
    expect(closed!.closedByCommit).toBe('cafe123');
  });

  test('les cues restants sont annulés — pas de réveil fantôme', async () => {
    const { store } = setup();
    const i = await store.addIntention({ content: 'x', directory: DIR }, [
      { kind: 'event', type: 'file_open', path: 'src/a.ts' },
      { kind: 'time', at: '2026-12-01T00:00:00Z' },
    ]);

    await applyCommitToLoops(store, commit({ message: `feat: x\n\nCloses ${loopId(i.id)}` }));

    const cues = await store.listCues({ intentionId: i.id });
    expect(cues.every((c) => c.status === 'cancelled')).toBe(true);
  });

  test('plusieurs boucles peuvent être fermées d\'un coup', async () => {
    const { store } = setup();
    const a = await store.addIntention({ content: 'a', directory: DIR });
    const b = await store.addIntention({ content: 'b', directory: DIR });

    const result = await applyCommitToLoops(
      store,
      commit({ message: `feat: gros morceau\n\nCloses ${loopId(a.id)}\nCloses ${loopId(b.id)}` })
    );

    expect(result.closed.length).toBe(2);
    expect((await store.listIntentions({ status: 'armed' })).length).toBe(0);
  });

  test('un marqueur explicite traverse les projets — l\'auteur sait ce qu\'il ferme', async () => {
    const { store } = setup();
    const i = await store.addIntention({ content: 'ailleurs', directory: '/autre/projet' });

    const result = await applyCommitToLoops(store, commit({ message: `fix\n\nCloses ${loopId(i.id)}` }));
    expect(result.closed.length).toBe(1);
  });

  test('un identifiant inconnu est signalé, rien n\'est fermé au hasard', async () => {
    const { store } = setup();
    await store.addIntention({ content: 'intacte', directory: DIR });

    const result = await applyCommitToLoops(store, commit({ message: 'fix\n\nCloses loop-deadbeef' }));

    expect(result.closed).toEqual([]);
    expect(result.unresolved).toEqual(['deadbeef']);
    expect((await store.listIntentions({ status: 'armed' })).length).toBe(1);
  });

  test('une suite non hexadécimale n\'est pas une référence de boucle', async () => {
    const { store } = setup();
    await store.addIntention({ content: 'intacte', directory: DIR });

    // Les ids sont des préfixes d'UUID : 'loop-zzzzzzzz' ne peut désigner aucune boucle.
    const result = await applyCommitToLoops(store, commit({ message: 'fix\n\nCloses loop-zzzzzzzz' }));
    expect(result.unresolved).toEqual([]);
    expect(result.closed).toEqual([]);
  });

  test('une boucle déjà fermée n\'est pas re-fermée', async () => {
    const { store } = setup();
    const i = await store.addIntention({ content: 'x', directory: DIR });
    await store.updateIntentionStatus(i.id, 'closed');

    const result = await applyCommitToLoops(store, commit({ message: `fix\n\nCloses ${loopId(i.id)}` }));
    expect(result.closed).toEqual([]);
    expect(result.unresolved).toEqual([i.id.slice(0, 8)]);
  });
});

describe('Heuristique — suggère, ne ferme jamais', () => {
  test('propose la boucle dont le contenu recoupe les fichiers touchés', async () => {
    const { store } = setup();
    const i = await store.addIntention({ content: 'Refactorer le middleware auth', directory: DIR });

    const result = await applyCommitToLoops(store, commit({ files: ['src/auth/middleware.ts'] }));

    expect(result.suggestions.length).toBe(1);
    expect(result.suggestions[0].intention.id).toBe(i.id);
    // Rien n'a bougé en base : c'est une proposition, pas une décision.
    expect((await store.getIntention(i.id))!.status).toBe('armed');
    expect(result.closed).toEqual([]);
  });

  test('ne propose rien pour un commit sans rapport', async () => {
    const { store } = setup();
    await store.addIntention({ content: 'Refactorer le middleware auth', directory: DIR });

    const result = await applyCommitToLoops(store, commit({ files: ['docs/readme.md'] }));
    expect(result.suggestions).toEqual([]);
  });

  test('l\'heuristique reste bornée au projet du commit', async () => {
    const { store } = setup();
    await store.addIntention({ content: 'Refactorer le middleware auth', directory: '/autre/projet' });

    const result = await applyCommitToLoops(store, commit({ files: ['src/auth/middleware.ts'] }));
    expect(result.suggestions).toEqual([]);
  });

  test('les suggestions sont classées et plafonnées', async () => {
    const { store } = setup();
    for (let n = 0; n < 6; n++) {
      await store.addIntention({ content: `Refactorer middleware auth variante ${n}`, directory: DIR });
    }
    await store.addIntention({ content: 'Chantier middleware seul', directory: DIR });

    const result = await applyCommitToLoops(store, commit({ files: ['src/auth/middleware.ts'] }));

    expect(result.suggestions.length).toBe(MAX_SUGGESTIONS);
    // Deux jetons recoupés passent devant un seul.
    expect(result.suggestions[0].score).toBeGreaterThanOrEqual(result.suggestions[1].score);
    expect(result.suggestions[0].matched.sort()).toEqual(['auth', 'middleware']);
  });

  test('une boucle fermée explicitement ne réapparaît pas en suggestion', async () => {
    const { store } = setup();
    const i = await store.addIntention({ content: 'Refactorer middleware auth', directory: DIR });

    const result = await applyCommitToLoops(
      store,
      commit({ message: `fix\n\nCloses ${loopId(i.id)}`, files: ['src/auth/middleware.ts'] })
    );

    expect(result.closed.length).toBe(1);
    expect(result.suggestions).toEqual([]);
  });
});

describe('Compte rendu', () => {
  test('rien à dire, rien d\'écrit', async () => {
    const { store } = setup();
    const result = await applyCommitToLoops(store, commit());
    expect(renderCommitReport(result)).toBe('');
  });

  test('annonce les fermetures et propose une commande pour les suggestions', async () => {
    const { store } = setup();
    const closedLoop = await store.addIntention({ content: 'boucle fermée', directory: DIR });
    await store.addIntention({ content: 'Refactorer middleware auth', directory: DIR });

    const result = await applyCommitToLoops(
      store,
      commit({ message: `fix\n\nCloses ${loopId(closedLoop.id)}`, files: ['src/auth/middleware.ts'] })
    );
    const report = renderCommitReport(result);

    expect(report).toContain('✅');
    expect(report).toContain('boucle fermée');
    expect(report).toContain('💡');
    expect(report).toContain('pnpm cli intent close loop-');
  });

  test('signale un identifiant introuvable', async () => {
    const { store } = setup();
    const result = await applyCommitToLoops(store, commit({ message: 'fix\n\nCloses loop-deadbeef' }));

    expect(renderCommitReport(result)).toContain('⚠️');
  });
});
