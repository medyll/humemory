# Audit de sécurité — humemory

Date : 17 août 2026  
Révision auditée : `61328bf`  
Mode : revue statique du code et des configurations, audit du lockfile, exécution de la suite hermétique. Aucun exploit n’a été lancé contre `data/humemory.db`.

> **Statut de remédiation — 18 août 2026 : les 9 constats sont corrigés.**
>
> | Constat | Correction | Commit |
> | --- | --- | --- |
> | H-01 | Écoute `127.0.0.1` par défaut, refus de démarrer hors loopback sans jeton, `HUMEMORY_API_TOKEN` sur les routes de données (comparaison à temps constant), jeton câblé dans le tableau de bord | `f4226cd` |
> | H-02 | Infobulle `river` reconstruite en `createElement`/`textContent` ; test de régression montant la vraie visualisation | `f4226cd` |
> | H-03 | Frontière non fiable uniformisée (intentions, descriptions de scripts, rêves, sorties MCP) | `f4226cd` |
> | H-04 | hono 4.13.2, `@hono/node-server` 2.1.1, js-yaml 5.3.0, tsx 4.23.12, overrides `sharp>=0.35.0` / `adm-zip>=0.6.0` — `pnpm audit` : 0 avis | `f4226cd`, `702ad4f` |
> | M-01 | `isDangerousPattern` refuse les quantificateurs imbriqués, repli en recherche littérale, pattern et texte bornés | `12fe784` |
> | M-02 | `bodyLimit` 1 Mo + `src/api/limits.ts` (contenu, mots-clés, étapes, cues, paramètres numériques bornés) | `9a4e962` |
> | M-03 | Outil de release épinglé en devDependency exacte et lancé via `pnpm exec`, actions épinglées par SHA, bun fixé, `id-token: write` retiré, barrière `pnpm audit` en CI | `702ad4f` |
> | M-04 | Comparaison d’origines exacte via `new URL().origin`, plus jamais `*` avec credentials, CSP à nonce + `frame-ancestors`, `nosniff`, `no-referrer` | `90051cb` |
> | L-01 | Détail journalisé côté serveur sous un identifiant de corrélation, réponse générique au client | `770abf2` |
>
> Le test de chaîne complète demandé en conclusion existe : `tests/security-chain.test.ts` (`8a53fdc`). Suite : 470 tests, 0 échec.
>
> **Restent à faire hors code**, car ce sont des réglages GitHub et non des fichiers du dépôt : protéger l’environnement de publication par une approbation obligatoire, et passer à npm Trusted Publishing pour supprimer le `NPM_TOKEN` longue durée (M-03). L’exposition LAN reste déconseillée sans TLS ni filtrage réseau (H-01).

## Résumé exécutif

Le projet possède de bonnes fondations sur les requêtes SQL, la traçabilité des agents et l’échappement des marqueurs de contexte. Sa principale faiblesse est toutefois située avant ces protections : l’API écoute par défaut sur toutes les interfaces et n’a aucune authentification. Un client réseau peut donc lire, altérer ou supprimer la mémoire partagée, puis créer du contenu qui sera affiché dans le navigateur ou réinjecté dans le contexte d’un agent.

Le chaînage le plus dangereux est :

1. accès anonyme à l’API depuis le réseau local ;
2. création d’une mémoire ou d’une intention malveillante ;
3. XSS stockée dans le tableau de bord, ou injection de consignes dans une future session d’agent.

| Niveau | Nombre |
| --- | ---: |
| Critique | 0 |
| Élevé | 4 |
| Moyen | 4 |
| Faible | 1 |

La priorité immédiate est de forcer l’écoute sur `127.0.0.1`, d’ajouter une authentification aux routes de données, de remplacer le `innerHTML` vulnérable et d’unifier le traitement de tout contenu non humain avant son entrée dans un contexte agent.

## Périmètre et vérifications

Périmètre examiné : API Hono, tableau de bord React/D3/Three, serveur MCP stdio, stockage SQLite, résolveur de cues, hooks de session, file de maintenance, workflows GitHub Actions et dépendances npm/pnpm.

Vérifications réalisées :

- recherche des primitives d’exécution, des lectures/écritures de fichiers, des constructions SQL dynamiques et des sorties HTML ;
- examen des limites de requêtes, de la validation, de CORS, des en-têtes HTTP et des frontières de confiance agent ;
- `pnpm audit --json` sur le lockfile ;
- `pnpm test` : **404 tests réussis, 0 échec, 1 401 assertions**.

Limites : l’infrastructure de déploiement, le pare-feu de la machine, les permissions réelles du répertoire de données et les éventuels reverse proxies ne figurent pas dans le dépôt. Ils n’ont donc pas été audités.

## Constats

### H-01 — API sensible anonyme et exposée sur toutes les interfaces

**Sévérité : élevée** — confidentialité, intégrité et disponibilité de toute la mémoire.

Le serveur est démarré avec `serve({ fetch: app.fetch, port })` sans `hostname` (`src/api/server.ts:167-173`). `@hono/node-server` transmet cette valeur absente à `server.listen`; Node écoute alors sur l’adresse non spécifiée, donc toutes les interfaces disponibles. Les messages de démarrage indiquent pourtant `localhost`, ce qui donne une fausse impression de confinement.

Aucun middleware d’authentification n’est monté. Les routes anonymes permettent notamment de :

- lister, créer, réfuter, fusionner et supprimer des mémoires (`src/api/memory-routes.ts:16-120`) ;
- déclencher la consolidation et lire les sessions (`src/api/memory-routes.ts:192-260`) ;
- créer, fermer, déclencher et supprimer des intentions (`src/api/intentions-routes.ts:155-247`) ;
- activer, archiver ou déclencher un script (`src/api/scripts-routes.ts:126-149`).

CORS ne constitue pas une authentification et n’arrête ni un client natif, ni `curl`, ni un processus compromis sur le réseau local.

**Scénario :** une machine du même LAN contacte le port 3456, récupère `/memories` et `/intentions`, découvre les répertoires de travail, supprime les traces ou ajoute une intention ciblant le répertoire actif. Aucune interaction ni aucun secret n’est requis.

**Correction recommandée :**

1. écouter par défaut sur `127.0.0.1` et exiger une option explicite pour toute exposition externe ;
2. exiger un jeton fort sur toutes les routes de données et de mutation, y compris les opérations dites « humaines » comme l’activation d’un script ;
3. conserver éventuellement `/health` et les fichiers statiques publics, mais séparer clairement leur middleware ;
4. documenter que l’exposition LAN nécessite TLS, authentification et filtrage réseau.

### H-02 — XSS stockée dans l’infobulle « river »

**Sévérité : élevée** — exécution JavaScript dans l’origine du tableau de bord.

La visualisation charge jusqu’à 500 mémoires depuis l’API (`web/viz/river.ts:24-27`), puis place directement `d.content` dans `tooltip.innerHTML` (`web/viz/river.ts:96-109`). Le contenu d’une mémoire est contrôlable via l’API et n’est pas échappé pour HTML.

Une charge de démonstration telle que `<img src=x onerror=alert(document.domain)>` est stockable comme contenu. Elle s’exécute lorsque la victime ouvre la visualisation et survole la trace correspondante. L’absence de Content Security Policy rend l’impact plus direct. Le script peut lire les mémoires accessibles dans la même origine, effectuer des mutations et exfiltrer les données vers un serveur externe.

Les autres usages de `innerHTML` observés dans les visualisations servent principalement à vider un conteneur ou à insérer du markup constant. Le sink confirmé avec une donnée métier est celui de `river.ts:101-103`.

**Correction recommandée :** construire l’infobulle avec `createElement` et `textContent`, ou rendre cette partie en JSX. Ne pas introduire une fonction d’échappement ad hoc si le DOM peut conserver la séparation entre structure et texte. Ajouter un test qui vérifie qu’un contenu contenant `<img onerror=...>` reste du texte inerte.

### H-03 — Frontière anti-injection incohérente pour intentions, descriptions de scripts et sorties MCP

**Sévérité : élevée** — injection stockée dans les futures invites d’agents.

Le projet applique correctement `sanitizeTrace` et `<humemory-untrusted>` aux traces non humaines. Cette règle n’est toutefois pas uniforme :

- les intentions déclenchées et les boucles ouvertes sont seulement passées dans `sanitizeTrace`, puis rendues nues dans le Markdown (`src/agent/session-context.ts:238-255`) ;
- la description d’un script agent est rendue nue à `src/agent/session-context.ts:212-230`, alors que ses étapes sont correctement enveloppées ;
- `humemory_intent_add` renvoie le contenu brut de l’intention (`src/mcp/server.ts:147`) ;
- `humemory_dreams` renvoie jusqu’à 400 caractères du payload brut (`src/mcp/server.ts:183-185`).

Le stockage classe bien une intention sans provenance explicite comme `source: agent` et `verified: false` (`src/store/sqlite.ts:1434-1475`). Le rendu ignore ensuite cette provenance. `sanitizeTrace` bloque quelques formulations connues et les fermetures de marqueurs, mais ce filtre heuristique ne peut pas reconnaître toutes les consignes malveillantes.

H-01 permet d’exploiter cette faille à distance : l’attaquant liste les intentions pour connaître le `directory`, ajoute une boucle armée dont le contenu formule une consigne indirecte, puis attend le prochain `SessionStart`. Le texte apparaît dans le contexte mnémonique de l’agent.

**Correction recommandée :** centraliser une fonction de rendu qui applique systématiquement la politique de provenance. Toute mémoire, intention, description, étape, proposition de rêve ou sortie MCP qui n’est pas explicitement `verified === true` avec `verificationReason === human` doit être nettoyée, bornée, étiquetée comme donnée et enveloppée dans `<humemory-untrusted>`. Ajouter des tests de non-régression pour chaque type de contenu, pas seulement pour `Memory`.

### H-04 — Dépendances avec avis de sécurité élevés

**Sévérité fournisseur : élevée** — exploitabilité variable selon le chemin réellement utilisé.

`pnpm audit` rapporte **29 avis : 4 élevés, 22 moyens, 3 faibles, 0 critique**.

Avis élevés :

- `hono` verrouillé en 4.12.15 : faille CORS avec credentials, corrigée en 4.12.25 ([GHSA-88fw-hqm2-52qc](https://github.com/advisories/GHSA-88fw-hqm2-52qc)). Hono et son middleware CORS sont utilisés par le serveur ;
- `adm-zip < 0.6.0`, via `@huggingface/transformers > onnxruntime-node` : allocation mémoire de 4 Go sur ZIP forgé ([GHSA-xcpc-8h2w-3j85](https://github.com/advisories/GHSA-xcpc-8h2w-3j85)) ;
- `sharp < 0.35.0`, via `@huggingface/transformers` : vulnérabilités libvips ([GHSA-f88m-g3jw-g9cj](https://github.com/advisories/GHSA-f88m-g3jw-g9cj)) ;
- `js-yaml <= 5.2.1`, dépendance de développement directe : temps de parsing exponentiel, corrigé en 5.2.2 ([GHSA-pm4m-ph32-ghv5](https://github.com/advisories/GHSA-pm4m-ph32-ghv5)).

Le risque `sharp`/`adm-zip` paraît moins directement atteignable dans le flux d’embeddings texte actuel, mais les paquets vulnérables sont installés. Plusieurs avis Hono moyens sont également corrigés seulement dans des versions ultérieures, jusqu’à 4.12.34 dans le résultat d’audit.

**Correction recommandée :** mettre à jour Hono vers au moins 4.12.34, `js-yaml` vers au moins 5.2.2, puis mettre à jour `@huggingface/transformers`/`onnxruntime-node` jusqu’à obtenir `adm-zip >= 0.6.0` et `sharp >= 0.35.0`. Régénérer le lockfile, exécuter les tests, puis exiger un audit sans avis élevé dans la CI.

### M-01 — Déni de service par expression régulière contrôlée

**Sévérité : moyenne** — blocage du thread serveur.

L’API accepte une chaîne arbitraire comme `error_pattern` (`src/api/intentions-routes.ts:77-89`) et un texte d’événement arbitraire (`src/api/intentions-routes.ts:96-124`). Le résolveur compile ensuite la chaîne avec le moteur RegExp natif et exécute `.test(text)` de manière synchrone (`src/core/cues.ts:187-193`).

Une expression à backtracking catastrophique, par exemple `^(a+)+$`, combinée à un texte suffisamment long qui échoue à la fin, peut monopoliser l’event loop. Le `catch` ne protège que des regex syntaxiquement invalides.

**Correction recommandée :** préférer une recherche littérale ou un moteur sans backtracking tel que RE2. À défaut, limiter fortement la taille du pattern et du texte, refuser les constructions dangereuses et déplacer l’évaluation dans un worker avec délai maximal. Les limites seules réduisent le risque sans prouver l’absence de ReDoS.

### M-02 — Corps, collections et paramètres de coût insuffisamment bornés

**Sévérité : moyenne** — épuisement mémoire, disque ou CPU.

Les routes de création appellent `c.req.json()` sans limite globale de corps. Le contenu de mémoire, le nombre et la longueur des mots-clés, les étapes d’un script, les cues et le texte d’un événement n’ont pas de plafond (`src/api/memory-routes.ts:16-36`, `src/api/intentions-routes.ts:155-183`, `src/api/scripts-routes.ts:63-91`).

Les intentions bornent correctement `limit` entre 1 et 500, mais les routes mémoire utilisent directement `parseInt` sans maximum ni contrôle de `NaN` (`src/api/memory-routes.ts:44-50`, `123-147`, `165-170`). En l’absence d’authentification et de limitation de débit, un client peut envoyer des objets massifs, remplir SQLite ou déclencher des recherches très coûteuses.

**Correction recommandée :** installer une limite de corps au niveau serveur, puis des limites métier explicites : contenu, mots-clés, étapes, cues, chaînes, tableaux et résultats. Valider tous les nombres avec des bornes finies et ajouter une limitation de débit par identité/IP. Comme la version Hono verrouillée possède aussi un avis sur le contournement de `bodyLimit` pour les requêtes chunked, effectuer d’abord la mise à jour H-04.

### M-03 — Chaîne de publication trop permissive et mutable

**Sévérité : moyenne** — compromission possible d’une publication npm et du dépôt.

Le workflow de release exécute `npx @medyll/idae-pnpm-release` sans version verrouillée alors que `GITHUB_TOKEN` et `NPM_TOKEN` sont présents (`.github/workflows/release.yml:57-61`). Le paquet n’est pas dans le lockfile : le code exécuté est donc choisi au moment de la release. Le job possède `contents: write` et `id-token: write` (`:16-18`), les actions sont référencées par tags mutables (`:21-37`) et Bun est installé avec `latest` (`:39`).

**Correction recommandée :** ajouter l’outil de release à une version exacte dans `devDependencies`, l’installer via le lockfile et l’exécuter avec `pnpm exec`. Verrouiller les actions par SHA, fixer la version de Bun, supprimer `id-token: write` s’il n’est pas utilisé, et protéger l’environnement de publication par approbation. Envisager npm Trusted Publishing pour éliminer le secret npm longue durée.

### M-04 — CORS fragile et absence d’en-têtes de défense navigateur

**Sévérité : moyenne** — mauvaise configuration et amplification de H-02.

La comparaison d’origine utilise `origin.includes(allowed)` (`src/api/server.ts:65-78`) au lieu d’une égalité sur une origine normalisée. Avec certaines valeurs personnalisées de `CORS_ORIGINS`, une origine dont le nom commence par le domaine autorisé peut passer. La branche sans `Origin` renvoie `*` tout en activant `credentials`, combinaison incohérente pour les navigateurs.

Aucun CSP, `frame-ancestors`/`X-Frame-Options`, `X-Content-Type-Options` ou `Referrer-Policy` n’a été trouvé. Ces en-têtes n’auraient pas supprimé la nécessité de corriger H-02, mais ils en réduisent l’impact et limitent le clickjacking.

**Correction recommandée :** parser et comparer exactement `new URL(origin).origin` à une `Set` d’origines normalisées, refuser par défaut, ne jamais répondre `*` avec credentials, puis ajouter `secureHeaders` avec une CSP adaptée aux bundles et visualisations.

### L-01 — Détails d’erreurs internes renvoyés au client

**Sévérité : faible** — aide à la reconnaissance.

Plusieurs handlers renvoient `String(error)` au client, par exemple `src/api/memory-routes.ts:39-41`, `97-99`, `112-114` et `187-189`. Les messages SQLite et chemins internes peuvent révéler le schéma, des identifiants ou des emplacements locaux.

**Correction recommandée :** journaliser l’erreur complète côté serveur avec un identifiant de corrélation, puis retourner un message générique et le statut approprié. Réserver les détails à un mode développement explicitement local.

## Contrôles satisfaisants observés

- Les valeurs SQL sont liées par paramètres. Les fragments dynamiques observés construisent des clauses et noms de placeholders à partir d’énumérations internes, sans concaténer les valeurs utilisateur.
- `safeJoin` empêche la traversée lexicale hors de `public/app` (`src/api/server.ts:47-57`).
- La confiance `reused` ne peut pas être gagnée via le header HTTP non authentifié ; le store distingue correctement attribution déclarée et identité de processus fiable (`src/store/sqlite.ts:632-646`).
- `sanitizeTrace`, l’échappement des attributs et la neutralisation des marqueurs réduisent bien le risque sur les traces déjà couvertes (`src/core/sanitize.ts`).
- Les fichiers de file de maintenance sont écrits atomiquement avec le mode `0600`, et l’identifiant de job est un SHA-256 du producteur et de la session (`src/agent/maintenance-queue.ts:69-134`).
- Le dépôt ignore les bases, données et fichiers `.env`; aucun secret codé en dur n’a été trouvé.
- La suite de tests est hermétique et passe intégralement.

## Plan de remédiation conseillé

1. **Immédiat :** forcer `127.0.0.1`, ajouter l’authentification et désactiver toute exposition réseau non intentionnelle.
2. **Immédiat :** éliminer le `innerHTML` contenant `d.content` et ajouter le test XSS.
3. **Immédiat :** appliquer la même frontière non fiable aux intentions, descriptions de scripts, rêves et sorties MCP.
4. **Court terme :** mettre à jour les dépendances jusqu’à zéro avis élevé et ajouter la barrière CI.
5. **Court terme :** remplacer/encadrer les regex, limiter corps et champs, borner les paramètres et limiter le débit.
6. **Court terme :** verrouiller la chaîne de release et réduire ses permissions.
7. **Défense en profondeur :** corriger CORS, ajouter les en-têtes navigateur et uniformiser les réponses d’erreur.

Après les trois premières corrections, effectuer un test d’intégration reproduisant la chaîne complète : tentative anonyme depuis une interface non loopback, stockage d’un contenu HTML, rendu de la visualisation, puis composition d’un contexte contenant une intention agent. Les assertions doivent prouver le refus réseau, l’inertie HTML et l’étiquetage non fiable du texte.
