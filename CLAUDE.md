# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
pnpm build          # TypeScript → dist/
pnpm dev            # Watch mode (src/cli/index.ts)
pnpm start:api      # HTTP API server on port 3456
pnpm test           # Vitest single pass
pnpm test:watch     # Vitest watch mode
pnpm cli <cmd>      # Run CLI directly
pnpm consolidate    # Manual decay consolidation (cron-friendly)
```

Run single test file: `pnpm vitest run tests/humemory.test.ts`

## Architecture

**humemory** models human memory consolidation — memories progressively decay from full detail → summary → essentials → keywords → lost, with recall events resisting decay.

### Stack
- **Storage:** `better-sqlite3` — rows persisted in `./data/humemory.db`
- **Search:** `flexsearch` — in-memory index rebuilt from SQLite on startup
- **CLI:** `commander` — `src/cli/index.ts`
- **API:** `hono` — `src/api/server.ts` port 3456, serves `public/index.html` dashboard

### Core Data Flow

```
encode("content") → SQLiteStore.add() → SQLite row + FlexSearch index entry
                                              ↓
                              hourly/manual decay.updateDecay()
                                              ↓
search("query") → L3 keywords → L2 essential → L1 summary → L0 full content
                                              ↓
                              recall(id) → recallCount++, saillance↑, decay timer reset
```

### Decay System (`src/core/decay.ts`)

Decay levels 0–4 (0=fresh, 4=lost/merged). Level thresholds:
- L1 summary: ~1 day
- L2 essential: ~1 week  
- L3 keywords: ~1 month
- L4 lost/merged: beyond threshold

Factors slowing decay: `recallCount * 0.3` multiplier, saillance >70 → 1.5× slower, content length >500 chars, keywords >5 tags.

### Memory Types
`episodic` (events), `semantic` (facts), `procedural` (skills) — each tagged by `directory` and `session_id` for project-level isolation.

### Key Interfaces (`src/core/types.ts`)
`Memory`, `DecayLevel` (0–4), `SearchQuery`, `MemoryStore` — the `MemoryStore` interface is what `SQLiteStore` implements.

### Inverse Search (`src/core/search.ts`)
Queries hit degraded representations first (L3 keywords), escalating toward full content (L0) only when needed. This is the core "human-like" recall pattern.

## API Endpoints

| Method | Path | Description |
|--------|------|-------------|
| POST | `/memories` | Add memory |
| GET | `/memories` | List (params: limit, level, type) |
| GET | `/memories/:id` | Fetch single |
| POST | `/memories/:id/recall` | Bump recallCount + saillance |
| DELETE | `/memories/:id` | Forget |
| GET | `/search?query=X` | Inverse search |
| POST | `/decay` | Trigger consolidation |
| GET | `/status` | Pool statistics |

## Database Schema

Table `memories` key columns: `content`, `level1_summary`, `level2_essential`, `level3_keywords`, `current_level` (0–4), `saillance` (0–100), `recall_count`, `decay_rate`, `memory_type`, `directory`, `session_id`, `merged_into_id`.
