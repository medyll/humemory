# humemory — BMAD Status
> Last updated: 2026-05-03 | Phase: **development** | Progress: **95%**

## Chain
- **Next:** Sprint 2 terminé — décider direction Sprint 3
- **Command:** `bmad-sprint`
- **Role:** scrum

---

## Sprints

### Sprint 1 — Foundation ✅ COMPLETED
| Story | Titre | Status |
|-------|-------|--------|
| S1-01 | Core decay algorithm + types | ✅ complete |
| S1-02 | SQLite store (migré bun:sqlite) | ✅ complete |
| S1-03 | CLI commander | ✅ complete |
| S1-04 | API HTTP Hono + dashboard web | ✅ complete |
| S1-05 | Cron consolidation + session mnésique | ✅ complete |

### Sprint 2 — LLM Integration ✅ COMPLETED
| Story | Titre | Tests |
|-------|-------|-------|
| S2-01 | Auto-génération N1/N2/N3 via LLM | 18/18 ✅ |
| S2-02 | Détection et fusion souvenirs similaires (L4) | 22/22 ✅ |
| S2-03 | Hook agent Claude Code: parse sessions | 31/31 ✅ |
| S2-04 | Search enrichie: type/période/saillance/recalls | 34/34 ✅ |
| S2-05 | Photographic mode (désactiver dégradation) | 37/37 ✅ |

---

## Résumé Sprint 2

**37 tests passent | Build TypeScript clean**

Livré:
- `src/core/llm-generator.ts` — génère N1/N2/N3 via Claude Haiku + prompt caching
- `src/store/sqlite.ts` — `findSimilar()`, `merge()`, `setPhotographic()`
- `src/agent/` — `session-parser.ts`, `learning-extractor.ts`, `claude-hook.ts`
- `scripts/hook-session.ts` — script Bun pour hook `Stop` Claude Code
- CLI: `--auto`, `--photographic`, `similar`, `merge`, `photo`, `import-session`
- API: `/memories/:id/similar`, `/memories/:id/merge`, `/memories/:id/photo`
- Search: filtres `memoryType`, `dateFrom`, `dateTo`, `minSaillance`, `minRecalls`

---

## Bugs résiduels

| # | Bug | Impact |
|---|-----|--------|
| 3 | **SQLite sans verrou** — race condition si multi-process simultané | Risque données |
| 4 | **tsc global** écrase tsc local — `pnpm build` = `tsc -p tsconfig.json` | Build fragile |

---

## Dimensions

### Marketing
- Système mémoire humain-like: dégradation progressive en 5 niveaux
- Hook Claude Code: auto-mémorise apprentissages de chaque session de dev
- Mode photographique: traces critiques jamais oubliées
- API HTTP + CLI + lib — intègre dans tout projet

### Product
- Sprint 2 terminé: 5 stories, 37 tests, build clean
- Photographic mode + fusion + search enrichie opérationnels
- Seul bug bloquant restant: SQLite multi-process lock
- Décision: Sprint 3 ou release candidat

### Far Vision
- DB partagée multi-projet avec verrou concurrence (SQLite WAL + advisory lock)
- Intégration OpenCode + autres agents LLM
- Export/import de mémoires entre projets
