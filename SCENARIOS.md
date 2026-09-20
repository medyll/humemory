# SCENARIOS.md — La narrativisation des rêves (Phase 9, conception)

> **Statut :** document de réflexion, pas un plan approuvé. Né d'une conversation
> du 2026-09-12. Rien n'est implémenté ici — chaque section marque ce qui
> existe déjà dans le code et ce qui est entièrement nouveau.

---

## 1. L'idée

Le dreamer actuel (Phase 6.1 + 8.5) est un **rêve analytique** : il clusterise
des traces récurrentes, détecte corroborations, contradictions et boucles
obsolètes, et produit des **propositions** (`promote_semantic`,
`merge_cluster`, `close_stale_loop`, `script_candidate`). C'est de la
consolidation *par catégorisation* — le tri, pas la répétition.

Le rêve humain, lui, ne trie pas : il **rejoue**. On se raconte une histoire
où l'on progresse, où il nous arrive des choses positives ou négatives, avec
des gens, des situations, des choses à résoudre. Souvent transposée — un
projet informatique devient une maison, un bug qui revient devient un renard
qui passe — parfois étrange, mais qui **résume une situation** : quelque chose
qu'on a vécu, qui nous a impacté, ou qu'on doit résoudre, et qu'on rejoue sous
forme de récit.

Le degré qui manque à humemory est donc **l'historisation des rêves** : une
étape où, à partir de toute la donnée présente, le système **crée des
histoires** à partir des situations rencontrées — pas nécessairement avec les
mêmes mots, mais avec la même dynamique (cause, tension, issue).

---

## 2. Troisième mode de consolidation

| Mode | Existe | Opère sur | Produit |
|------|--------|-----------|---------|
| Dégradation L0→L3 | ✅ Sprint 1 | une trace seule | compression (perte de détail) |
| Dreamer analytique | ✅ Phase 6.1 / 8.5 | des traces entre elles | catégorisation (clusters, propositions) |
| **Narrativisation** | ❌ Phase 9 | la **structure** d'une situation | un récit (dynamique conservée, détails jetés) |

Une histoire est une forme de compression : elle garde la dynamique — cause,
conflit, résolution ou chute — et jette le contingent. C'est ce que fait le
cerveau pendant le sommeil paradoxal : une **simulation**, pas un résumé.

---

## 3. À quoi ça sert opérationnellement — la reconnaissance de situation

Le vrai enjeu n'est pas de produire de jolies histoires. C'est ceci :

> **humemory, au milieu d'une situation en train de se dérouler, la reconnaît
> comme le début d'une histoire déjà vécue — et sait alors dans quelle
> direction aller, s'il faut agir fortement ou non, et quel type d'action
> convient.**

Mécanisme envisagé :

1. **Au rêve** (consolidation, hors session) : un cluster qualifié, une
   contradiction résolue ou une boucle longtemps ouverte est transformée en
   **récit** — une trace `episodic` de haute saillance, transposée, liée à ses
   traces sources, avec une **issue connue** (comment la situation s'est
   terminée, ou qu'elle est restée ouverte).
2. **En session** (temps réel) : la situation courante — les dernières actions,
   erreurs, fichiers, intentions actives — est résumée et **comparée
   vectoriellement** aux récits stockés. C'est la base vectorielle (Phase 7,
   `src/core/embeddings.ts` / `hybrid.ts`) qui interroge : *« est-ce que ce qui
   se passe ressemble au début d'une histoire connue ? »*
3. **Si correspondance** : le récit est injecté au contexte non pas comme un
   fait mais comme une **anticipation** — « la dernière fois que ça a commencé
   comme ça, voici comment ça s'est passé ». Et avec le récit viennent ses
   attaches : le script actif qui a marché (Phase 8), la contradiction qui a
   tranché (6.0.2), la boucle qui était restée ouverte.

C'est le passage du rétrospectif et du prospectif au **prophétique** : la
mémoire ne répond plus seulement à une requête, elle **reconnaît** une
situation et propose une direction.

### Ce qui n'existe pas encore (à construire)

- La génération de récits à partir de clusters / contradictions / boucles.
- Le résumé de la situation courante en cours de session et son matching
  vectoriel contre les récits (la Phase 7 matche des mémoires à une *query* ;
  ici la query serait la *situation elle-même* — nouveau).
- La remontée de la **direction d'action** attachée à un récit (issue,
  intensité, type d'action) — aucun champ ni mécanisme n'existe pour ça.

---

## 4. Insertion dans l'architecture existante

Tout le squelette est déjà là :

- **Clusterer** — le dreamer produit déjà des clusters scorés
  (`src/core/dreamer.ts`, interface `Clusterer`, keyword par défaut, vector
  opt-in depuis la Phase 7).
- **Gate humaine** — une nouvelle `DreamKind`, disons `dream_narrative`, passe
  par le même pipeline : proposition idempotente (`payload_hash`), TTL 14
  jours, `pnpm cli dream review` / `approve` / `reject`. Jamais d'application
  silencieuse.
- **Auditable et réfutable** — le récit garde un mapping explicite vers ses
   traces sources (comme `level_revisions` garde la trace avant merge), et une
  contradiction peut le cibler, comme elle cible déjà un script depuis la
  Phase 8 (`loser_kind`).
- **LLM injectable** — c'est la première fonctionnalité où le déterminisme ne
  suffit pas : écrire une histoire à partir de traces hétérogènes est
  précisément ce qu'un modèle de langage fait. L'architecture est prête :
  `LLMClient` est déjà une interface injectée, mockée en tests, et
  `DREAM_CONFIG.maxDraftsPerRun` plafonne déjà les coûts. Les tests restent
  hermétiques (stub LLM, fixtures — cf. `docs/TESTING.md`).
- **Indice de récupération** — un récit transposé est plus générique que ses
  sources : il devient un cue de rappel bien plus puissant. C'est le palais de
  mémoire, en interne.

---

## 5. Les questions de design ouvertes

- **Qu'est-ce qui déclenche un récit ?** Un cluster corroboré (fort, mais déjà
  « compris ») ? Ou plutôt les boucles ouvertes et les contradictions actives —
  le Zeigarnik du rêve : on rêve de ce qui n'est pas résolu. Instinct actuel :
  contradictions et boucles longtemps ouvertes, parce que c'est là que la
  simulation a une fonction.
- **Fidélité vs transposition.** Trop littéral, le récit n'apporte rien ; trop
  libre, il devient du bruit. Le mapping récit ↔ sources doit rester explicite
  pour que le récit soit auditable et réfutable.
- **La « situation courante ».** Quel est le bon résumé de ce qui est en train
  de se passer pour en faire une query vectorielle — les N dernières actions ?
  les erreurs récentes ? les intentions armées ? À définir.
- **Le seuil de correspondance.** La Phase 7.5 a montré qu'aucun embedder local
  n'atteint une gate P=1.0 pour la *corroboration* — c'est pourquoi
  l'auto-corroboration vectorielle est définitivement désactivée. Ici la
  correspondance ne *vérifierait* rien, elle *suggérerait* une histoire ;
  le risque de faux positif est donc moindre, mais le seuil devra être
  calibré avec le même sérieux (fixture de paires labellisées, comme en 7.5).
- **L'issue comme donnée.** Pour qu'un récit propose une direction, il faut
  que son dénouement soit structuré (résolu comment ? resté ouvert ? action
  qui a marché ?). Aujourd'hui cette information est éclatée entre boucles
  closes, contradictions et scripts — il faudra la consolider au moment de la
  narrativisation.

---

## 6. Position dans la roadmap

Candidat naturel pour une **Phase 9**, après les Phases 5 (prospectif),
6 (confiance + rêve analytique), 7 (vecteurs) et 8 (scripts cognitifs) —
toutes livrées au 2026-08-08. La narrativisation réunit les trois : les
clusters du dreamer, les embeddings de la Phase 7, et la logique
situation → action des scripts de la Phase 8, qu'elle généralise du « quand
ce cue, fais ce drill » au « cette situation ressemble à cette histoire,
voici comment elle finit ».
