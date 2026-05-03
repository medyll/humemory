# humemory — BMAD Status
> Last updated: 2026-05-03 | Phase: **development** | Progress: **60%**

## Chain
- **Next:** Implémenter auto-génération niveaux N1/N2/N3 via LLM
- **Command:** `bmad-dev-story S2-01`
- **Role:** dev

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

### Sprint 2 — LLM Integration 🚧 UPCOMING
| Story | Titre | Status |
|-------|-------|--------|
| S2-01 | Auto-génération N1/N2/N3 via LLM | ⏳ pending |
| S2-02 | Détection et fusion souvenirs similaires (L4) | ⏳ pending |
| S2-03 | Hook agent Claude Code: parse sessions | ⏳ pending |
| S2-04 | Search enrichie: type/période/associations | ⏳ pending |
| S2-05 | Photographic mode (désactiver dégradation) | ⏳ pending |

---

## Bugs connus

| # | Bug | Impact |
|---|-----|--------|
| 1 | **N1/N2/N3 non auto-générés** — saisie manuelle via CLI uniquement | Bloque utilité réelle |
| 2 | **Fusion L4 absente** — pas de détection/merge de souvenirs similaires | Feature manquante |
| 3 | **SQLite sans verrou** — race condition si multi-process simultané | Risque données |
| 4 | **tsc global** écrase tsc local — `pnpm build` nécessite tsc 5.9.3 local | Build fragile |

---

## Dimensions

### Marketing
- Système mémoire humain-like: dégradation progressive en 5 niveaux
- Recherche inversée: trouve avec indices flous, remonte au détail si match
- Dashboard web 'Palais de Mémoire' avec visualisation consolidation
- API HTTP + CLI + lib importable — intègre dans tout projet

### Product
- Core complet: decay, search inversée, bun:sqlite, CLI, API, dashboard
- 12 tests passent, build OK avec tsc local 5.9.3 + bun:sqlite
- Blockers: N1/N2/N3 non auto-générés, fusion L4 absente, no DB lock multi-process
- Next: LLM auto-génération → fusion similaires → hook agent Claude Code

### Far Vision
- Hook temps réel Claude Code/OpenCode: parse sessions, extrait apprentissages auto
- Photographic mode: désactiver dégradation pour traces critiques
- Search enrichie: type, période, associations sémantiques
- DB partagée multi-projet avec verrou concurrence
