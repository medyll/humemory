# humemory — Status

> Phase: **development** | Progress: [████████▌░] 84%
> Last updated: 2026-07-30 | Active role: scrum
> Stories: 21/25 complete · Tests: 78 pass / 0 fail / 167 expect (6 fichiers, bun 1.3.14)

## Chain Protocol

- **Next action:** Sprint 5 — Phase 5.2 : Cue resolver (resolveTimeCues, resolveEventCues, expireStale)
- **Next command:** `bmad-sprint-story`
- **Next role:** architect

## Phases

  ✅ planning
  🔨 development
  🔨 testing
  ⬚ release

## Sprints

  ✅ Sprint 1: Foundation — core architecture, store, CLI, API, tests (5/5 stories)
      ✅ S1-01: Core decay algorithm + types
      ✅ S1-02: SQLite store (migré bun:sqlite)
      ✅ S1-03: CLI commander (encode/search/recall/list/decay/status/delete) — non couvert par tests
      ✅ S1-04: API HTTP Hono + dashboard web — non couvert par tests
      ✅ S1-05: Cron consolidation + session mnésique — non couvert par tests
  ✅ Sprint 2: LLM integration — auto-génération niveaux, fusion, hook agent (5/5 stories)
      ✅ S2-01: Auto-génération N1/N2/N3 via LLM (résumé, essentiel, mots-clés)
      ✅ S2-02: Détection et fusion de souvenirs similaires (niveau 4)
      ✅ S2-03: Hook agent Claude Code: parse sessions, extraction apprentissages
      ✅ S2-04: Search enrichie: filtres type/période/associations
      ✅ S2-05: Photographic mode: désactiver dégradation pour traces critiques
  ✅ Sprint 3: Dashboard UX + visualisations roadmap (5/5 stories) — reconstruit depuis git le 2026-07-30
      ✅ S3-01: Photographic badge 🔒 + toggle inline par trace (ab814f3)
      ✅ S3-02: Merge UI : panel similaires + confirmMerge → POST /memories/:id/merge (ab814f3)
      ✅ S3-03: Filtres avancés : dates, minSaillance, minRecalls, photo-only (ab814f3)
      ✅ S3-04: Visualisations roadmap : river, galaxy, replay, promenade, decay-curve (6df0cac)
      ✅ S3-05: Fix path traversal SEC-01 : safeJoin() containment (6df0cac)
  ✅ Sprint 4: Concurrence SQLite + build stability (3/3 stories)
      ✅ S4-01: SQLite WAL mode + busy_timeout + PRAGMA optimizations
      ✅ S4-02: Write serialization layer (enqueueWrite promise queue)
      ✅ S4-03: Fix flaky list test + CLAUDE.md tsc/test doc update
  🔨 Sprint 5: Mémoire prospective — intentions, cues, hooks SessionStart/post-commit (Phase 5, voir PHASE5_PLAN.md) (3/7 stories)
      ✅ S5-00a: Phase 5.0 — Advisory lock SQLite cross-process (closes Bug #3) — 8118e54
      ✅ S5-00b: Phase 5.0 — Env de test autonome : clock seam, event bus, helpers, fixtures, garde prod-DB
      ✅ S5-01: Phase 5.1 — Tables intentions + cues, CRUD, cascade, fixtures loops.open.json
      ⬚ S5-02: Phase 5.2 — Cue resolver : resolveTimeCues + resolveEventCues + expireStale, règles décay × intention (armed/fired/closed)
      ⬚ S5-03a: Phase 5.3 — Hook scripts/hook-session-start.ts : résout cues du cwd/branch, markdown sur stdout, budget HUMEMORY_SESSION_BUDGET
      ⬚ S5-03b: Phase 5.3 — Hook .githooks/post-commit : ferme intentions via 'Closes loop-<id>' + heuristique fichiers
      ⬚ S5-04: Phase 5.4 — CLI 'intent {add,list,close,fire}' + API POST /intentions, POST /cues, POST /events

## Bugs ouverts

  - **BUG-05** [minor, partiel] fondation fixtures/helpers livrée en S5-00b ; reste à migrer les 3 suites héritées
  - **BUG-06** [minor] vitest.config.ts orphelin — toute la suite tourne sous bun test
  - **BUG-04** [minor] tsc global peut shadow le tsc local — toujours passer par pnpm build

## Backlog

  - **B-PHASE6** [low] Phase 6 — Cognitive scripts : écrire spec avant implémentation (template vs intentions chaînées vs prompt vs tool bundle)
  - ✅ B-VIZ-01 — clos 2026-07-30, tracké comme S3-04 (reste à marquer ROADMAP.md done)
  - ✅ B-DOC-01 — clos 2026-07-30, fausse alerte : 2026-05-03 = date du commit initial

## Marketing

  - Système mémoire humain-like: dégradation progressive en 5 niveaux
  - Recherche inversée: trouve avec indices flous, remonte au détail si match
  - Dashboard web 'Palais de Mémoire' avec visualisation consolidation
  - API HTTP + CLI + lib importable — intègre dans tout projet

## Product

  - Core rétrospectif complet : decay 5 niveaux, search inversée, SQLite WAL + advisory lock, CLI, API, dashboard
  - Sprints 1+2+3+4 livrés. Suite : 78 pass / 0 fail / 167 expect sur 6 fichiers (bun 1.3.14, vérifié 2026-07-30)
  - 5 visualisations dashboard implémentées (river, galaxy, replay, promenade, decay curve) — B-VIZ-01 clos
  - PHASE5_PLAN.md écrit (2026-06-24) — plan Phase 5 corrigé : table intentions dédiée, cues typés, hooks SessionStart + post-commit
  - Sprint 5 en cours (3/7) : préconditions 5.0 closes + data model 5.1 livré (tables intentions/cues, CRUD, cascade)

## Far Vision

  - Mémoire prospective : intentions + cues + hook SessionStart → l'agent reçoit ses boucles ouvertes avant de chercher
  - Zeigarnik effect : git commit ferme les loops via marker explicite ou heuristique fichiers
  - DB partagée multi-projet avec advisory lock (Phase 5.0)
  - Cognitive scripts (Phase 6) : routines pré-chargées sur cue — spec à écrire

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  bmad continue   — execute next step
  bmad test       — run tests
  bmad audit      — code quality
  bmad doc        — generate docs
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
