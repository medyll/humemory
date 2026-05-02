# AGENTS.md — humemory

**Human-like memory system with progressive degradation**

---

## 🎯 Vision

Système de mémoire qui **dégrade comme un cerveau humain** :
- **5 niveaux** : détail complet → résumé → essentiel → mots-clés → perdu
- **Recherche inversée** : on cherche d'abord dans les versions dégradées (rapide) puis on remonte vers le détail si match
- **Renforcement** : rappeler un souvenir le préserve
- **Persistance partagée** : une DB SQLite unique accessible par tous les projets

---

## 📦 Structure

```
humemory/
├── src/
│   ├── core/
│   │   ├── types.ts       # Types Memory, DecayLevel, etc.
│   │   ├── decay.ts       # Logique de dégradation
│   │   └── search.ts      # Moteur de recherche inversée (BM25)
│   ├── store/
│   │   └── sqlite.ts      # Store SQLite + index en mémoire
│   ├── cli/
│   │   └── index.ts       # CLI commander
│   ├── api/
│   │   └── server.ts      # API HTTP (Hono)
│   └── index.ts           # Exports library
├── tests/
│   └── humemory.test.ts   # Tests Vitest
├── data/
│   └── humemory.db        # DB partagée (créée au premier run)
├── bin/
│   └── humemory           # CLI executable
├── package.json
└── AGENTS.md
```

---

## 🔧 Setup

```bash
cd /mnt/d/development/humemory
pnpm install
```

---

## 🚀 Usage

### Dashboard Web — Palais de Mémoire

```bash
# Démarrer le serveur (API + Dashboard)
pnpm start:api
# → http://localhost:3456
```

**Fonctionnalités du dashboard :**
- 🧠 **Zones temporelles subjectives** : Encodage récent, En consolidation, Consolidé, Fragile, En sommeil
- 📍 **Regroupement par lieu mental** (projet/contexte)
- 📊 Stats en temps réel (répartition par état de consolidation)
- 🔍 Recherche par indices de récupération
- 🏷️ Filtres par contexte, tri par force mnésique/réactivations
- 👁️ Détail d'une trace (état de consolidation, force mnésique, contexte d'encodage)
- ➕ Encoder une nouvelle trace depuis l'UI
- 🔄 Réactiver/oublier en un clic
- 📈 Barre de consolidation visuelle (5 états)

### 🧠 Session Mnésique

**Nouveau :** `/session` — Interface pour interagir avec les LLM via la mémoire

**Concept :** Au lieu d'une conversation avec transcript, tu exprimes une **intention** et humemory construit un **contexte mnésique** pertinent à envoyer au LLM.

**Fonctionnalités :**
- 💭 Exprime ton intention (pas une conversation)
- 🔍 Recherche automatique des traces pertinentes
- 📝 Contexte pré-construit avec les mémoires les plus relevantes
- ✏️ Édition du contexte avant envoi
- 📋 Copie ou export vers l'agent LLM
- 💾 Sauvegarde de la session comme nouvelle trace

**Accès :**
- Bouton "🧠 Session Mnésique" dans le header du dashboard
- URL directe : http://localhost:3456/session

### CLI

```bash
# Encoder une nouvelle trace mnésique
pnpm cli encode "J'ai implémenté le système d'auth avec OAuth2" \
  -d "/mnt/d/development/sive" \
  -s "auth-session-001" \
  -k "auth,oauth,security" \
  -l3 "auth oauth security implementation" \
  -t semantic

# Types: episodic (événement), semantic (fait), procedural (geste)
# Alias: pnpm cli add ... (compatible)

# Rechercher par indices de récupération (recherche inversée)
pnpm cli search "t'as pas un truc sur l'auth ?"
pnpm cli find "oauth"   # alias

# Réactiver une trace (renforcement mnésique)
pnpm cli recall <id>
pnpm cli reactivate <id>   # alias

# Lister les traces mnésiques
pnpm cli list
pnpm cli traces            # alias
pnpm cli list -l 0         # Seulement en encodage
pnpm cli list -t procedural # Seulement les mémoires procédurales

# Mettre à jour la consolidation
pnpm cli decay
pnpm cli consolidate       # alias

# État du palais de mémoire
pnpm cli status

# Oublier une trace
pnpm cli delete <id>
pnpm cli forget <id>       # alias
```

### API HTTP

```bash
# Démarrer le serveur
pnpm start:api
# → http://localhost:3456
```

**Endpoints :**

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/memories` | Ajouter un souvenir |
| GET | `/memories` | Lister les souvenirs |
| GET | `/memories/:id` | Récupérer un souvenir |
| POST | `/memories/:id/recall` | Rappeler (renforcer) |
| DELETE | `/memories/:id` | Supprimer |
| GET | `/search?q=...` | Rechercher |
| POST | `/decay` | Mettre à jour dégradation |
| GET | `/status` | État de la mémoire |
| GET | `/health` | Health check |

**Exemple :**

```bash
curl -X POST http://localhost:3456/memories \
  -H "Content-Type: application/json" \
  -d '{
    "content": "Test memory",
    "directory": "/test",
    "keywords": ["test"],
    "sessionId": "s1"
  }'
```

### Library (import dans d'autres projets)

```typescript
import { SQLiteStore, calculateDecayLevel } from 'humemory';

const store = new SQLiteStore('/path/to/humemory.db');

// Ajouter
const memory = await store.add({
  content: '...',
  directory: '/project',
  day: '2026-04-25',
  keywords: ['tag1', 'tag2'],
  sessionId: 'session-123',
});

// Rechercher
const results = await store.search({
  query: 'auth',
  maxLevel: 3,
  limit: 10,
});

// Rappeler
await store.recall(memory.id);
```

---

## 🧠 Concepts (Neuroscience Cognitive)

**Terminologie humaine :**

| Technique | Humain | Description |
|-----------|--------|-------------|
| `createdAt` | **Encodage** | Moment de formation de la trace |
| `lastRecalled` | **Dernière réactivation** | Dernière récupération consciente |
| `recallCount` | **Réactivations** | Nombre de rappels (renforce) |
| `saillance` | **Force mnésique** | Intensité de la trace (0-100) |
| `decayRate` | **Taux d'oubli** | Vitesse de dégradation |
| `sessionId` | **Contexte d'encodage** | État mental + activité |
| `directory` | **Lieu mental** | Espace conceptuel (projet) |
| `currentLevel` | **État de consolidation** | Stade de stabilisation |
| `keywords` | **Indices de récupération** | Déclencheurs de rappel |
| `memoryType` | **Type de mémoire** | Episodic (événement), Semantic (fait), Procedural (geste) |

**Types de mémoire :**

- **Episodic** — Souvenirs d'événements vécus (contexte temporel/spatial). Ex: "J'ai débogué tel bug hier"
- **Semantic** — Connaissances factuelles, concepts. Ex: "Les tokens CSS sont des variables"
- **Procedural** — Savoir-faire, gestes, routines. Ex: "Raccourci VSCode: Ctrl+D"

**Zones temporelles subjectives :**

- **Encodage récent** (< 24h) — Mémoire fraîche, détails vivaces
- **En consolidation** (< 7j) — Stabilisation en cours
- **Consolidé** (< 30j) — Mémoire stable
- **Fragile** (< 90j) — Risque d'oubli accru
- **En sommeil** (> 90j) — Mémoire lointaine, difficile d'accès

**États de consolidation :**
1. **Encodage** — Formation initiale
2. **Consolidation** — Stabilisation progressive
3. **Stable** — Mémoire consolidée
4. **Fragile** — Dégradation avancée
5. **Sommeil** — Trace dormante (quasi-oubli)

---

## 🕐 Consolidation Automatique (Cron)

Un job cron exécute la consolidation toutes les nuits à **3h du matin**.

**Schedule:** `0 3 * * *` (tous les jours à 03:00)

**Manuellement :**
```bash
# Via le script dédié
pnpm consolidate

# Ou via la CLI
pnpm cli decay
pnpm cli consolidate   # alias
```

**Ce que fait la consolidation :**
- Calcule le nouveau niveau de dégradation pour chaque trace
- Met à jour la force mnésique (saillance)
- Applique les seuils temporels :
  - Encodage → Consolidation : 24h
  - Consolidation → Stable : 7 jours
  - Stable → Fragile : 30 jours
  - Fragile → Sommeil : 90 jours

**Job cron :** `humemory-consolidation` (ID: `6e690888ce33`)

---

## 🧪 Tests

```bash
# Run tests
pnpm test

# Watch mode
pnpm test:watch
```

---

## 🔌 Intégration Agent LLM

Pour intégrer humemory dans un agent (OpenCode, Claude, etc.) :

```typescript
import { SQLiteStore } from 'humemory';

const store = new SQLiteStore('/mnt/d/development/humemory/data/humemory.db');

// Avant de répondre à une question, chercher dans la mémoire
async function getContextForQuestion(question: string, projectDir: string) {
  const results = await store.search({
    query: question,
    directory: projectDir,
    maxLevel: 2, // Remonter jusqu'au résumé
    limit: 5,
  });
  
  return results.map(r => ({
    content: r.memory.content,
    relevance: r.score,
    recalled: r.memory.lastRecalled,
  }));
}

// Après une réponse importante, stocker le souvenir
async function rememberInteraction(question: string, answer: string, projectDir: string) {
  await store.add({
    content: `Q: ${question}\nA: ${answer}`,
    directory: projectDir,
    day: new Date().toISOString().split('T')[0],
    keywords: extractKeywords(question),
    sessionId: generateSessionId(),
  });
}
```

---

## 📊 Roadmap

### ✅ Terminé

- [x] **Core** : dégradation + recherche inversée
- [x] **Store** : SQLite + index BM25 (FlexSearch)
- [x] **CLI** : encode/search/recall/list/decay + aliases
- [x] **API** : Endpoints HTTP + Dashboard web
- [x] **Tests** : Vitest (12 tests)
- [x] **Types de mémoire** : episodic / semantic / procedural
- [x] **Dashboard** : zones temporelles, filtres, type, search
- [x] **Cron** : consolidation auto toutes les nuits à 3h
- [x] **Session Mnésique** : interface intention → contexte → LLM

### 🚧 À venir

- [ ] **LLM** : auto-génération des niveaux (N0 → N1/N2/N3)
- [ ] **Fusion** : détection et fusion de souvenirs similaires
- [ ] **Agent hook** : intégration OpenCode/Claude Code
  - [ ] Parser les sessions existantes
  - [ ] Extraire les apprentissages (décisions, bugs, solutions)
  - [ ] Hook temps réel pendant les sessions
  - [ ] Encodage auto avec validation optionnelle
- [ ] **Search enrichie** : par type, par période, par associations
- [ ] **Photographic mode** : désactiver dégradation pour traces critiques

---

### 🛣️ Phases futures

**Phase 4 — Intégration Agents LLM** (à venir)
- Parser les sessions OpenCode/Claude Code existantes
- Extraire automatiquement les apprentissages
- Hook temps réel pendant les sessions
- Encodage auto avec validation optionnelle

---

## 🐛 Known Issues

- Les niveaux N1/N2/N3 ne sont pas auto-générés (à faire manuellement via CLI options)
- Pas de détection de fusion automatique (niveau 4)
- La DB est partagée mais pas verrouillée (risque de race condition si multi-process)

---

## 📝 Notes

- **DB partagée** : `/mnt/d/development/humemory/data/humemory.db`
- **Port API** : 3456 (configurable via `PORT` env var)
- **Stack** : TypeScript, better-sqlite3, flexsearch, Hono, Commander
