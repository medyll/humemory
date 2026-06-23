# humemory — Status

> Phase: **development** | Progress: [████████░░] 75%
> Last updated: 2026-06-24 | Active role: scrum

## Chain Protocol

- **Next action:** Sprint 5 — Phase 5.0 préconditions : implémenter advisory lock SQLite cross-process (closes Bug #3) + event bus injectable dans test env
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
      ✅ S1-03: CLI commander (encode/search/recall/list/decay/status/delete)
      ✅ S1-04: API HTTP Hono + dashboard web
      ✅ S1-05: Cron consolidation + session mnésique
  ✅ Sprint 2: LLM integration — auto-génération niveaux, fusion, hook agent (5/5 stories)
      ✅ S2-01: Auto-génération N1/N2/N3 via LLM (résumé, essentiel, mots-clés)
      ✅ S2-02: Détection et fusion de souvenirs similaires (niveau 4)
      ✅ S2-03: Hook agent Claude Code: parse sessions, extraction apprentissages
      ✅ S2-04: Search enrichie: filtres type/période/associations
      ✅ S2-05: Photographic mode: désactiver dégradation pour traces critiques
  ✅ Sprint 4: Concurrence SQLite + build stability (3/3 stories)
      ✅ S4-01: SQLite WAL mode + busy_timeout + PRAGMA optimizations
      ✅ S4-02: Write serialization layer (enqueueWrite promise queue)
      ✅ S4-03: Fix flaky list test + CLAUDE.md tsc/test doc update
  🔨 Sprint 5: Mémoire prospective — intentions, cues, hooks SessionStart/post-commit (Phase 5, voir PHASE5_PLAN.md) (0/7 stories)
      ⬚ S5-00a: Phase 5.0 — Advisory lock SQLite cross-process (closes Bug #3)
      ⬚ S5-00b: Phase 5.0 — Event bus injectable dans test env (extension docs/TESTING.md)
      ⬚ S5-01: Phase 5.1 — Schéma data : tables intentions + cues (migrations idempotentes)
      ⬚ S5-02: Phase 5.2 — Cue resolver : resolveTimeCues + resolveEventCues + expireStale, règles décay × intention (armed/fired/closed)
      ⬚ S5-03a: Phase 5.3 — Hook scripts/hook-session-start.ts : résout cues du cwd/branch, markdown sur stdout, budget HUMEMORY_SESSION_BUDGET
      ⬚ S5-03b: Phase 5.3 — Hook .githooks/post-commit : ferme intentions via 'Closes loop-<id>' + heuristique fichiers
      ⬚ S5-04: Phase 5.4 — CLI 'intent {add,list,close,fire}' + API POST /intentions, POST /cues, POST /events

## Backlog

  - **B-VIZ-01** [low] Roadmap visualisation (ROADMAP.md options A-E) — 100% implémentée (river/galaxy/replay/promenade/decay-curve). Marquer ROADMAP.md comme done
  - **B-PHASE6** [low] Phase 6 — Cognitive scripts : écrire spec avant implémentation (template vs intentions chaînées vs prompt vs tool bundle)
  - **B-DOC-01** [low] Vérifier date 2026-05-03 dans config.yaml (date suspecte / future)

## Marketing

  - Système mémoire humain-like: dégradation progressive en 5 niveaux
  - Recherche inversée: trouve avec indices flous, remonte au détail si match
  - Dashboard web 'Palais de Mémoire' avec visualisation consolidation
  - API HTTP + CLI + lib importable — intègre dans tout projet

## Product

  - Core rétrospectif complet : decay 5 niveaux, search inversée, SQLite WAL, CLI, API, dashboard
  - Sprints 1+2+4 livrés (37/37 tests). 5 visualisations dashboard implémentées (river, galaxy, replay, promenade, decay curve)
  - PHASE5_PLAN.md écrit (2026-06-24) — plan Phase 5 corrigé : table intentions dédiée, cues typés, hooks SessionStart + post-commit
  - Sprint 5 ouvert : Phase 5.0 préconditions (advisory lock + event bus testable) avant data model intentions/cues

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
