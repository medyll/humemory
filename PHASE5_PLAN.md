# Phase 5 — Prospective memory (plan corrigé)

> Révision du plan Phase 5 après audit du code existant (`src/core/types.ts`,
> `src/store/sqlite.ts`, `docs/TESTING.md`, `bmad/status.md`). Ce fichier est la
> source de vérité du plan ; README.md / AGENTS.md le résument.

---

## 🩹 Erreurs / ambiguïtés corrigées vs. plan d'origine

| # | Problème du plan v1 | Correction |
|---|---------------------|------------|
| 1 | "`intention` memory type" ajouté à `MemoryType` | Table **dédiée** `intentions` — un intention n'est pas une trace rétrospective, elle a un trigger futur, un statut, pas la même courbe de décay |
| 2 | `cue.trigger` non typé | Schéma typé par `kind` : `TimeTriggerSpec` (cron/datetime/recurrence) vs `EventTriggerSpec` (`file_open`, `branch_switch`, `error_pattern`…) |
| 3 | Cue sans `status` / `firedAt` / `expiresAt` | Ajoutés — sinon cues passés restent armés indéfiniment |
| 4 | Cardinalité cue ↔ intention floue | Explicite : **1 intention → N cues** (ex. "mercredi matin" ET "Paulo arrive") |
| 5 | Hook `SessionStart` sans contrat de sortie | Spec : stdout markdown structuré, budget configurable, résolution `cwd` + `git branch --show-current` |
| 6 | "git commit ferme les loops" sans mécanisme | Choix explicite : git `post-commit` hook + matching `Closes loop-<id>` dans le message (+ heuristique fichiers/branche en fallback) |
| 7 | Interaction décay × intention non définie | Règle : `armed` → saillance figée à 100, pas de décay ; `fired` non `closed` → décay normal (Zeigarnik faiblit) ; `closed` → archive |
| 8 | Env de test : seulement clock injectable | Extension : **event bus injectable** (Phase 5 est event-driven, pas que time-driven) |
| 9 | Bug #3 (SQLite multi-process) ignoré | **Précondition bloquante** : advisory lock avant Phase 5 — plus de writers concurrents (cue resolver background + hooks + dashboard) |
| 10 | "Cognitive scripts" non spécifiés | **Reportés en Phase 6** — pas implémentables sans spec |
| 11 | Pas de séquençage interne | Phases 5.0 → 5.4 ordonnées par dépendances |
| 12 | Doc : README/AGENTS disent que `CLAUDE.md` a été supprimé | Faux, il existe — corriger les deux fichiers |

---

## 🧱 Phase 5.0 — Préconditions (bloquantes)

### 5.0.1 — Advisory lock SQLite multi-process
- Cible : `src/store/sqlite.ts`
- Pattern : table `_lock` + `BEGIN IMMEDIATE` avec retry exponentiel, OU `flock(2)` sur fichier sentinelle.
- Test : 2 processus concurrents écrivant 100 intentions chacun → 200 lignes, aucune perte.
- **Clôt Bug #3** de `bmad/status.md`.

### 5.0.2 — Event bus injectable dans le test env
- Extension de `docs/TESTING.md` : `EventBus` interface, `InMemoryEventBus` pour tests, `FileSystemEventBus` pour prod (chokidar/fs.watch).
- Permet de fast-forward des events `file_open`/`branch_switch`/`commit` en test sans toucher le FS.

---

## 🧬 Phase 5.1 — Modèle de données

### Table `intentions`
```sql
CREATE TABLE intentions (
  id TEXT PRIMARY KEY,
  content TEXT NOT NULL,            -- "demain refactor fn X"
  directory TEXT NOT NULL,          -- lieu mental
  created_at INTEGER NOT NULL,
  expires_at INTEGER,               -- nullable : intention sans deadline
  status TEXT NOT NULL              -- armed | fired | closed | expired
    DEFAULT 'armed',
  fired_at INTEGER,
  closed_at INTEGER,
  closed_by_commit TEXT,            -- SHA du commit qui a fermé la loop
  saillance INTEGER DEFAULT 100,    -- figée à 100 tant que armed
  related_memory_id TEXT            -- lien optionnel vers trace rétrospective
);
CREATE INDEX idx_intentions_status ON intentions(status);
CREATE INDEX idx_intentions_directory ON intentions(directory);
```

### Table `cues`
```sql
CREATE TABLE cues (
  id TEXT PRIMARY KEY,
  intention_id TEXT NOT NULL REFERENCES intentions(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,               -- time | event
  trigger_spec TEXT NOT NULL,       -- JSON typé par kind
  status TEXT NOT NULL              -- armed | fired | cancelled
    DEFAULT 'armed',
  armed_at INTEGER NOT NULL,
  fired_at INTEGER
);
CREATE INDEX idx_cues_intention ON cues(intention_id);
CREATE INDEX idx_cues_status ON cues(status);
CREATE INDEX idx_cues_kind ON cues(kind);
```

### Types TS
```ts
// src/core/types.ts (additions)
export type IntentionStatus = 'armed' | 'fired' | 'closed' | 'expired';
export type CueStatus = 'armed' | 'fired' | 'cancelled';
export type CueKind = 'time' | 'event';

export interface TimeTriggerSpec {
  kind: 'time';
  // soit une date one-shot, soit une expression cron
  at?: string;      // ISO datetime
  cron?: string;    // cron expression (5 fields)
}

export type EventTriggerSpec =
  | { kind: 'event'; type: 'file_open'; path: string }
  | { kind: 'event'; type: 'branch_switch'; branch: string }
  | { kind: 'event'; type: 'error_pattern'; pattern: string };

export type TriggerSpec = TimeTriggerSpec | EventTriggerSpec;

export interface Intention {
  id: string;
  content: string;
  directory: string;
  createdAt: Date;
  expiresAt?: Date;
  status: IntentionStatus;
  firedAt?: Date;
  closedAt?: Date;
  closedByCommit?: string;
  saillance: number;
  relatedMemoryId?: string;
}

export interface Cue {
  id: string;
  intentionId: string;
  kind: CueKind;
  triggerSpec: TriggerSpec;
  status: CueStatus;
  armedAt: Date;
  firedAt?: Date;
}
```

### Migrations
- Pattern existant (`ALTER TABLE ... ADD COLUMN` dans try/catch) déjà en place
  dans `sqlite.ts` ; nouvelles tables via `CREATE TABLE IF NOT EXISTS`.

---

## 🔄 Phase 5.2 — Cue resolver

### Interfaces
```ts
// src/core/cues.ts (nouveau)
export interface CueResolver {
  resolveTimeCues(now: Date): Promise<Cue[]>;     // cues à firer maintenant
  resolveEventCues(event: AppEvent): Promise<Cue[]>;
  fire(cueId: string): Promise<Intention>;        // marque cue+intention fired
  expireStale(now: Date): Promise<number>;        // expires_at dépassé
}

export type AppEvent =
  | { type: 'file_open'; path: string; directory: string }
  | { type: 'branch_switch'; branch: string; directory: string }
  | { type: 'error_pattern'; text: string; directory: string }
  | { type: 'commit'; sha: string; message: string; files: string[]; directory: string };
```

### Règles de décay × intention
- `armed` → saillance figée à 100, pas de décay (boucle ouverte saillante)
- `fired` non `closed` → décay normal s'applique (Zeigarnik faiblit avec le temps)
- `closed` → archive : `currentLevel = 4` équivalent, gardée pour historique
- `expired` → soft-delete (purge après N jours configurable)

### Tests
- Clock injectable : forward 24h, vérifier que time cue armé pour J+1 → `fired`
- Event bus injectable : push `branch_switch` → cues matchant → `fired`
- Cue armé sur `expires_at` passé sans avoir fire → `expired`

---

## 🪝 Phase 5.3 — Hooks Claude Code & git

### 5.3.1 — `scripts/hook-session-start.ts`
Hook Claude Code `SessionStart` (existant dans Claude Code, écho de la doc agent hooks).

**Comportement :**
1. Lit `cwd` (≈ `directory`) et `git branch --show-current` (≈ contexte).
2. Liste les intentions `armed` du `directory`.
3. Liste les traces rétrospectives décayées-mais-pertinentes (saillance > seuil, niveau 2-3, du `directory`).
4. Sort sur stdout un bloc markdown structuré, à injecter dans le system prompt par Claude Code :
   ```markdown
   ## 🧠 Contexte mnésique (humemory)
   ### Boucles ouvertes (Zeigarnik)
   - **[loop-abc123]** Demain refactor fn X dans authService (armée il y a 2j)
   - …
   ### Traces pertinentes décayées
   - [L2] La race condition dans le worker avait été résolue par mutex async
   - …
   ```
5. Budget configurable via env : `HUMEMORY_SESSION_BUDGET=10` (N traces max).

### 5.3.2 — `scripts/hook-post-commit.ts` (git hook)
Installation suggérée : `git config core.hooksPath .githooks/` + `.githooks/post-commit`
qui shell-out vers `bun run scripts/hook-post-commit.ts`.

**Détection de fermeture de loop :**
1. **Explicite** (prioritaire) : regex `/Closes loop-([a-z0-9]+)/i` dans le message → ferme cette intention.
2. **Heuristique fichiers** (fallback) : pour chaque intention `armed`, scorer overlap entre fichiers touchés par le commit et keywords de l'intention ; au-dessus d'un seuil → propose fermeture (mais ne ferme pas auto, on sort sur stdout pour validation user).

**Effet :** `intention.status = 'closed'`, `closed_by_commit = SHA`,
tous les cues liés → `cancelled`.

---

## 📝 Phase 5.4 — CLI / API additions

### CLI
- `pnpm cli intent add "demain refactor fn X" -d ./src/auth --cue 'event:file_open:src/auth/service.ts' --expires 2026-12-31`
- `pnpm cli intent list [--status armed]`
- `pnpm cli intent close <id>`
- `pnpm cli intent fire <id>` (debug, force-fire)

### API
- `POST /intentions` — créer
- `GET /intentions` — list (filter status, directory)
- `POST /intentions/:id/close` — fermer manuellement
- `POST /cues` — attacher un cue
- `POST /events` — pousser un event (déclenche resolver) — utile pour tests/dashboard

---

## ⏭️ Phase 6 *(reportée)* — Cognitive scripts

À spécifier avant de coder. Question ouverte : un script est-il
- un template markdown chargé sur cue,
- une séquence d'intentions chaînées,
- un prompt système pré-fait,
- un bundle d'appels d'outil ?

Trop flou aujourd'hui pour entrer dans Phase 5. Ré-ouvrir après livraison 5.1–5.4.

---

## 🧪 Critères d'acceptation Phase 5

- [ ] 2 processus concurrents → 0 perte (lock OK)
- [ ] Intention `armed` ne décaye pas (saillance reste 100 après 30j simulés)
- [ ] Time cue se déclenche au tick attendu (clock injectable)
- [ ] Event cue se déclenche sur push d'event matchant (event bus mock)
- [ ] `expires_at` passé sans fire → `expired`
- [ ] Hook `SessionStart` produit markdown valide, respecte budget
- [ ] `post-commit` avec `Closes loop-xxx` ferme l'intention + cancel ses cues
- [ ] Tous les tests passent sans `ANTHROPIC_API_KEY` et sans toucher
      `data/humemory.db`

---

## 🛠️ Corrections doc connexes (à pousser dans le même PR)

- [ ] `README.md` : retirer "`CLAUDE.md` was removed from the tree" — faux, le fichier existe.
- [ ] `AGENTS.md` : même correction (note `CLAUDE.md` ligne 167-168).
- [ ] `bmad/status.md` : vérifier la date `2026-05-03` (semble future / mauvais système).
- [ ] `AGENTS.md` Phase 5 : remplacer la puce-liste actuelle par un renvoi vers ce `PHASE5_PLAN.md`.
- [ ] `README.md` Phase 5 : idem.
