# Audit de humemory — corrections, améliorations et portabilité

Date de finalisation : 6 septembre 2026. Base examinée : commit `09f9f69`, **avec les modifications locales présentes au début de l’audit**, notamment les intégrations Kimi/OpenCode. Environnement d’exécution : Windows x64, Bun 1.3.14.

> **Statut de remédiation — 7 septembre 2026 : les 12 constats A01–A12 sont traités.**
>
> | Constat | Correction | Preuve exécutable |
> | --- | --- | --- |
> | A01 | L'index se rafraîchit sur `PRAGMA data_version` : un commit externe force une reconstruction avant la recherche suivante | `tests/audit-regressions.test.ts` — « A01/A02 », « A01/A05 » |
> | A02 | Le verrou applicatif est un verrou SQLite tenu par l'OS (`AdvisoryLock`), libéré à la mort du processus, sans expiration horloge | `tests/audit-regressions.test.ts`, `tests/advisory-lock-basic.test.ts` |
> | A03 | Une intention récurrente déjà déclenchée mais non close redevient éligible ; une occurrence ne se déclenche pas deux fois | `tests/audit-regressions.test.ts` — « A03 » |
> | A04 | `src` distribué, points d'entrée auxiliaires cohérents, et vérification d'archive installée hors du dépôt | `pnpm verify:package` (CI Linux/macOS/Windows), `humemory doctor` |
> | A05 | `src/core/paths.ts` : résolution unique data/base/file/cache, profil utilisateur séparé de l'installation, parent créé au besoin | `tests/audit-regressions.test.ts` — « A01/A05 », `tests/doctor.test.ts` |
> | A06 | Score non plafonné, tri de tous les candidats avant troncature, égalités déterministes, bonus favorisant réellement les niveaux dégradés | `tests/audit-regressions.test.ts` — « A06 » |
> | A07 | Les cues au-delà des 500 premières restent atteignables en un nombre borné de passages | `tests/audit-regressions.test.ts` — « A07 » |
> | A08 | Plus de bail à cinq minutes : propriété OS, aucun `mtime` interrogé, option morte `lockStaleMs` supprimée | `tests/maintenance-queue.test.ts` |
> | A09 | Temporaire unique par écriture et remplacement laissant une version récupérable | `tests/audit-regressions.test.ts` — « A09 » |
> | A10 | Typecheck backend **et** frontend verts, suite complète (555 tests, `.tsx` compris) verte, CI sur les trois OS avec typechecks, build et archive | `pnpm test`, `pnpm build`, `.github/workflows/ci.yml` |
> | A11 | `humemory remap-project` avec aperçu, sauvegarde et transaction ; cache de modèles centralisé ; minimum bun relevé à la version réellement validée | `tests/audit-regressions.test.ts` — « A11 » |
> | A12 | Fusion MCP écrite dans un temporaire unique, original sauvegardé, remplacement par renommage ; refus maintenu sur les formats non pris en charge | `tests/mcp-client-setup.test.ts` |
>
> Des améliorations listées plus bas, **#1 (mesure de la qualité cognitive, `pnpm measure:recall`)**, **#3 (migrations explicites)**, **#4 (diagnostic d'installation, `humemory doctor`)** et **#5 (garanties produit, `docs/PORTABILITY.md`)** sont faites. **#2 (mesure du coût à l'échelle)** reste ouverte.
>
> **A13 — P1, découvert par la mesure #1 et corrigé le 8 septembre 2026.** FlexSearch exige que **tous** les termes d'une requête se trouvent dans **un même champ**. Les niveaux de dégradation étant indexés en champs séparés (`level3Keywords`, `level2Essential`, `level1Summary`, `content`), une requête dont les termes se répartissent entre la ligne de mots-clés L3 et le contenu ne renvoie **rien du tout**.
>
> Reproduit : `sqlite lock` → 1 résultat, `sqlite concurrent write lock` → **0** ; `decay thresholds` → 1, `decay thresholds levels hours` → **0**. Le mode d'échec est contre-intuitif et frappe l'usage réel de plein fouet : plus l'utilisateur précise sa requête, plus il risque le vide. Il touche d'abord les traces dégradées, dont le texte interrogeable est justement éclaté entre les champs de niveau. Mesuré à 2 requêtes sur 13 à 0 % de rappel.
>
> **Correction appliquée :** deux passes dans `src/core/search.ts`. La première est stricte et répond à presque tout. La seconde ne s'exécute que si la première n'a **rien** trouvé, à aucun niveau : elle interroge terme à terme et retient les traces auxquelles il manque au plus un terme, avec une pénalité de score fixe pour qu'une correspondance exacte, à n'importe quel niveau, prime toujours sur une approximative. Le `suggest: true` natif de FlexSearch a été écarté après mesure : il accepte un terme sur cinq, ce qui remplace un rappel manqué par un voisin faux affirmé — concrètement, il plaçait la course de jetons d'authentification en tête de « sqlite concurrent write lock ».
>
> **Résultat mesuré :** rappel moyen 0,846 → **1,000** sur 18 requêtes répondables, MRR **1,000**, la requête sans réponse reste vide. Les planchers de `tests/relevance.test.ts` ont été relevés en conséquence.
>
> **A14 — arbitrage d'encodeur, mesuré et assumé, 8 septembre 2026.** L'index utilise `charset: 'latin:advanced'`, un encodeur phonétique qui confond `lock`, `log`, `local` : `lock` et `log` renvoient exactement le même ensemble, là où `latin:default` et `latin:simple` les séparent. C'est ce qui produit l'unique faux positif restant du corpus — « sqlite concurrent write lock » satisfait bel et bien trois de ses quatre termes contre la trace d'authentification, qui contient « logging ».
>
> Passer à `latin:default` supprime ce faux positif. Mesure de ce que ça coûte : la tolérance aux fautes de frappe sur une requête d'**un seul mot** disparaît entièrement (`sqlyte` → 3 traces avec `advanced`, **0** avec `default` ; `checkpont` → 1 puis **0**). Le repli terme à terme d'A13 ne peut pas compenser : il exige au moins deux termes. `latin:advanced` est donc conservé délibérément — dans une mémoire qu'on interroge à partir de souvenirs partiels, la tolérance vaut mieux qu'un voisin classé en dessous. Le corpus protège maintenant les deux côtés : `q-typo-single-term` et `q-typo-single-rare` échouent si quelqu'un change d'encodeur pour faire tomber le faux positif à zéro.
>
> La CI configure les contrôles « archive seule », « profil neuf » et « chemins avec espaces et accents » sur Linux, macOS et Windows. Sa configuration ne prouve pas à elle seule la réussite des trois plateformes. Le mode hors ligne et les modèles ONNX réels ne sont toujours pas certifiés.

## Vérification complémentaire — 8 septembre 2026

Reprise sur `74a380e`, après intégration des corrections précédentes dans `main`.
La suite courante a d'abord révélé un test dépendant de l'heure réelle : les
traces du 8 août sortaient désormais de la fenêtre de 30 jours du dreamer.
Les deux scénarios de corroboration vectorielle passent maintenant la même
horloge fixe au store et au dreamer. Aucun seuil de confiance n'a été modifié.

- **555 tests réussis, 0 échec, 1 884 assertions**, sur les 47 fichiers backend
  et frontend, sous Windows avec Bun 1.3.14.
- Typechecks backend/frontend et bundle de production réussis ; les deux
  scripts de vérification et de maintenance ont aussi été contrôlés par TypeScript.
- Le paquet 0.2.8 a été construit puis installé hors du dépôt dans un chemin
  contenant espace et accent, avec un profil de données neuf : **17 contrôles
  réussis sur 17**. Le contrôle couvre
  désormais le traitement effectif d'un job synthétique, les hooks SessionStart
  et post-commit (chargement hors dépôt Git), ainsi que la consolidation.
- `maintenance-worker.ts --skip-imports` désactive les trois importeurs pour
  traiter uniquement la file existante. Le contrôle du paquet désactive également
  la maintenance périodique de l'API, utilise un autre répertoire courant et attend
  la sortie de ses processus avant de nettoyer son répertoire temporaire.

Les tests utilisent des données synthétiques et aucune clé LLM. L'installation
des dépendances du paquet utilise le réseau ; elle est distincte des tests
hermétiques. Les requêtes HTTP du contrôle runtime visent le serveur de test local.
Cette reprise ne certifie pas Linux/macOS, les modèles ONNX natifs, les permissions
d'installation forcées en lecture seule, ni une restauration complète base + file.
Les garanties et limites de reprise sont décrites dans [docs/PORTABILITY.md](docs/PORTABILITY.md).

## Verdict

Le projet possède une base sérieuse : horloge injectable, SQLite isolé dans les tests, protection des contenus réinjectés, attribution des agents et file de maintenance avec reprise. Les **478 tests backend exécutés passent**. Cela ne couvre toutefois pas plusieurs défauts qui touchent directement sa promesse : partager une mémoire entre agents et faire revenir les intentions au bon moment.

Les corrections prioritaires sont la cohérence des index entre processus, la récupération des verrous après crash, les rappels récurrents et l’installation indépendante du dépôt. Une réécriture générale n’est pas justifiée par les constats. L’origine supposée du code n’est pas un critère d’évaluation : les conclusions ci-dessous reposent sur son comportement et sur les sources.

**La portabilité n’est pas certifiée.** Des vérifications ont été exécutées sous Windows ; Linux et macOS n’ont pas été exécutés. Le paquet distribué et le premier démarrage présentent des incohérences identifiables dans le code. Ce document est un audit et un plan de correction ; il ne prétend pas que ces corrections ont été appliquées.

## Méthode et résultats de vérification

Lecture du README, des règles du dépôt et de `docs/TESTING.md`, puis examen ciblé du stockage, de la recherche, des cues, de la maintenance, du packaging, des lanceurs et des workflows. Les reproductions utilisent des contenus synthétiques, une horloge fixe quand nécessaire, des bases en mémoire ou temporaires. La base réelle n’a pas été ouverte par les reproductions ; aucun import de conversations réelles ni appel LLM n’a été lancé.

Les tests ont été exécutés avec `NODE_ENV=test`, `ANTHROPIC_API_KEY` vide et `HUMEMORY_DB=:memory:`. Cela ne constitue pas une mesure exhaustive de l’absence de trafic réseau : aucun contrôle réseau indépendant n’a été instrumenté.

| Vérification | Résultat | Limite |
|---|---|---|
| TypeScript backend : `node node_modules/typescript/bin/tsc -p tsconfig.json --noEmit` | Réussite, code 0 | Ne compile pas le frontend |
| TypeScript frontend : `node node_modules/typescript/bin/tsc -p web/tsconfig.json --noEmit` | Échec, code 2, TS2591 dans `src/core/llm-generator.ts:53` | Ne démontre pas à lui seul une panne navigateur |
| Tests backend : `bun test` avec la liste explicite des 41 fichiers `tests/*.test.ts` | **478 pass, 0 fail, 1 662 assertions** | Exclut les quatre fichiers `.test.tsx` |
| Suite complète : `bun test` | Interrompue après saturation du tampon de capture de 8 Mio | Pas de bilan global final |
| Deuxième essai : `bun test tests`, capture en flux | Échec observé dans `TracesTab > lists traces and counts the zones`, puis nombreuses erreurs React ; arrêt à 45 s | Ce filtre inclut aussi les tests React ; il ne sélectionne pas seulement le backend |
| Reproductions ciblées stockage/recherche/cues | Cinq comportements incorrects confirmés, détaillés ci-dessous | Connexions multiples dans un même processus pour la preuve d’index, pas deux processus OS |
| Compilation du bundle, installation d’une archive npm, matrice OS | Non exécutées | À intégrer aux critères de livraison |

Le premier essai de reproduction ciblée utilisait par erreur le nom de l’interface `CueResolver` comme export exécutable. Il a été corrigé en `SqliteCueResolver` ; les résultats retenus proviennent de l’exécution corrigée, terminée avec le code 0.

## Priorités

P1 : comportement central incorrect, indisponibilité ou installation cassée dans un scénario courant. P2 : fiabilité, qualité des résultats ou preuve de compatibilité insuffisante. « Reproduit » signifie exécuté pendant cet audit ; « statique » signifie établi par lecture ; « risque » désigne un scénario restant à provoquer.

| ID | Priorité | Sujet | Niveau de preuve |
|---|---|---|---|
| A01 | P1 | Index de recherche périmé entre connexions | Reproduit |
| A02 | P1 | Verrou SQLite abandonné sans récupération | Reproduit par fichier orphelin |
| A03 | P1 | Intention cron non récurrente après le premier déclenchement | Reproduit |
| A04 | P1 | Scripts distribués dépendant de sources non distribuées | Statique |
| A05 | P1 | Premier démarrage et données couplés à l’installation | Reproduit + statique |
| A06 | P2 | Score de recherche saturé à 100 | Reproduit |
| A07 | P2 | Cues au-delà de 500 ignorées par résolution | Statique |
| A08 | P2 | Bail de maintenance expirant pendant un traitement vivant | Risque étayé |
| A09 | P2 | Écriture de file insuffisamment sûre en concurrence | Risque étayé |
| A10 | P2 | Vérification frontend et CI incomplètes | Exécuté + statique |
| A11 | P2 | Chemins, cache de modèles et identité des projets peu transportables | Statique |
| A12 | P2 | Réécriture des configurations MCP non atomique | Statique, incident non provoqué |

## A01 — La recherche ne voit pas les écritures d’une autre connexion

**Sources :** `src/store/sqlite.ts:188`, `:195`, `:496`, `:626` ; `src/core/search.ts:15`.

Chaque instance crée son propre index et le remplit au démarrage. `search()` interroge cet index sans vérifier si une autre connexion a modifié SQLite.

**Reproduction :** ouvrir A et B sur une même base temporaire, puis ajouter une trace contenant « quasar » via A. Résultat : recherche A = 1 ; lecture de la trace par identifiant via B = présente ; recherche B = 0. Le contenu est bien partagé en base, mais pas dans l’index. Le même mécanisme concerne les serveurs MCP et l’API résidents.

**Correction proposée :** invalider ou synchroniser l’index lorsque la base change. Une première correction peut détecter les commits externes avec `PRAGMA data_version`, puis reconstruire l’index en le vidant préalablement. Mesurer ce coût avant de passer à un journal de changements ou à un index transactionnel en base. Traiter aussi suppressions, contradictions, recalls et consolidation.

**Acceptation :** deux processus ouvrent la base avant une écriture ; le lecteur trouve ensuite la trace sans redémarrage. Une trace supprimée ne revient plus et ses métadonnées modifiées ne restent pas périmées.

## A02 — Un crash peut laisser les écritures bloquées

**Source :** `src/store/sqlite.ts:72`, acquisition `:84`, libération `:118`.

Le verrou est un fichier créé avec `wx`. Sa récupération repose exclusivement sur `release()`. Il n’enregistre ni propriétaire vérifiable ni mécanisme de récupération après arrêt brutal. Le délai d’attente ne répare pas ce verrou.

**Reproduction :** créer `<base-temporaire>.lock`, puis appeler `add()`. Résultat : `Failed to acquire lock after 10 attempts`. Le verrou reste en place. Cette reproduction simule le reliquat d’un crash ; aucun processus réel n’a été tué pour la produire.

**Correction proposée :** formaliser propriété et reprise du verrou, ou réduire le besoin de verrou applicatif en utilisant des transactions SQLite pour les opérations concernées. Une reprise doit vérifier le propriétaire et éviter de supprimer un verrou vivant. Ne pas considérer l’âge seul comme une preuve de décès.

**Acceptation :** reprise après crash, exclusion effective de deux écrivains vivants et erreur d’infrastructure correctement classée par la maintenance.

## A03 — Le cron est réarmé mais l’intention ne peut plus être réveillée

**Source :** `src/core/cues.ts:358`, `:367`, `:419`.

`fire()` réarme la cue cron, puis passe l’intention à `fired`. La résolution suivante exige une intention `armed` dans `liveTargetDirectoryOf()`. Ces deux règles rendent la récurrence inopérante pour cette intention.

**Reproduction :** intention avec `0 9 * * *`, déclenchement puis résolution au lendemain à 09:00 UTC. Résultat : cue = `armed`, intention = `fired`, nombre de cues dues = **0**.

**Correction proposée :** rendre les intentions récurrentes déjà déclenchées mais non closes éligibles, ou définir explicitement un réarmement de l’intention. Préserver les règles Zeigarnik : ne pas remettre aveuglément à 100 une intention dont la saillance doit décroître après déclenchement.

**Acceptation :** deux occurrences successives fonctionnent ; la même occurrence ne se déclenche pas deux fois ; fermeture et expiration empêchent les occurrences suivantes. Tester les scripts séparément, leur statut `active` suit une autre règle.

## A04 — Le paquet et ses points d’entrée ne sont pas cohérents

**Sources :** `package.json:11`, `:59`, `:66` ; `scripts/hook-session.ts:20` ; `scripts/maintenance-worker.ts:10` ; `src/agent/mcp-client-setup.ts:61`.

La liste `files` distribue `dist`, les hooks TypeScript et certains scripts, mais pas `src`. Pourtant les hooks importent `../src/...`, les commandes API/MCP ciblent `src`, et l’enregistrement MCP construit `src/mcp/server.ts`. La CLI `bin/humemory.js:19` cible correctement `dist/cli/index.js` : cette incohérence concerne surtout les points d’entrée auxiliaires.

**Impact attendu :** un checkout complet masque le problème ; l’installation du paquet peut produire des hooks ou une configuration MCP pointant vers des fichiers absents. L’archive réellement publiée n’a pas été téléchargée ni testée dans cet audit.

**Correction proposée :** compiler les points d’entrée auxiliaires et les faire cibler `dist`, ou distribuer délibérément toutes les sources requises. Choisir une stratégie unique ; aligner setup MCP, documentation et scripts npm. Ne pas simplement ajouter quelques fichiers au hasard à `files`.

**Acceptation :** construire une archive, l’installer dans un dossier temporaire extérieur au dépôt, puis tester CLI, MCP, API, hooks et maintenance avec des données synthétiques et des chemins comprenant espaces et accents. Aucun accès au checkout d’origine ne doit être nécessaire.

## A05 — Le premier démarrage suppose un répertoire de données déjà présent

**Sources :** `src/store/sqlite.ts:24`, `:176` ; `src/api/server.ts:75` environ, constante `DB_PATH` ; `src/agent/maintenance-runner.ts:73`, `:77`.

Le constructeur ouvre SQLite sans créer le répertoire parent. Par défaut, plusieurs points d’entrée placent la base sous `data` à côté du code. Ce répertoire n’est pas inclus dans la liste des fichiers distribués. Une installation en lecture seule pose également problème, même si la base a été précréée.

**Reproduction :** ouvrir une base temporaire sous un sous-dossier inexistant. Résultat : `unable to open database file`.

**Correction proposée :** centraliser la résolution des données, séparer installation et état utilisateur, créer le parent de la base avec une gestion explicite des erreurs de permissions. Préserver `HUMEMORY_DB` et `HUMEMORY_QUEUE`, et prévoir une migration non destructive de l’emplacement historique.

**Acceptation :** démarrage avec profil vierge ; code installé en lecture seule ; base et file explicitement déplacées ; même résolution depuis CLI, API, MCP et hooks. Ne jamais migrer ni écraser une base existante implicitement.

## A06 — Les bonus de pertinence sont neutralisés

**Source :** `src/core/search.ts:139`.

Le calcul commence à 100, ajoute un bonus de niveau entre 10 et 40, puis les bonus de récence, de réactivation et de saillance. La seule pénalité visible est de 10 pour un contenu long. `Math.min(100, score)` ramène donc les scores des traces ordinaires valides à 100. De plus, la formule de bonus accorde davantage au niveau détaillé malgré un commentaire annonçant un avantage aux niveaux dégradés.

**Reproduction :** deux traces correspondantes, l’une ancienne avec saillance 0 et aucun rappel, l’autre récente avec saillance 100 et 50 rappels. Résultat : **100 et 100**.

**Correction proposée :** fixer une plage utile ou conserver un score non plafonné jusqu’à la présentation. Définir séparément l’ordre de parcours des niveaux et le classement des candidats. Le retour anticipé dès `limit` résultats doit également être évalué : trier un préfixe ne garantit pas de retenir les meilleurs candidats.

**Acceptation :** jeux de pertinence avec ordre attendu, sensibilité aux bonus, égalités déterministes et qualité mesurée sous filtres. Vérifier aussi l’affirmation « BM25 » du README : le calcul visible est un score heuristique, sans formule BM25 explicite dans cette méthode.

## A07 — La limite de 500 cues peut affamer une partie du stock

**Source :** `src/core/cues.ts:368`, `:397`.

Les résolutions temporelle et événementielle ne lisent que 500 cues armées, sans pagination. Si les premières restent armées mais ne correspondent pas au contexte ou à l’échéance, les suivantes peuvent rester invisibles à chaque passage.

**Correction proposée :** pagination stable par curseur ou sélection des candidates en base avec un budget de travail et un curseur persistant. Distinguer « limiter le coût d’un passage » de « ignorer définitivement la fin du stock ».

**Acceptation :** 500 cues non correspondantes suivies d’une cue correspondante ; cette dernière doit être résolue dans un nombre borné de passages. Tester les deux types de cues.

## A08 — Le verrou de maintenance expire sans preuve que le worker est mort

**Source :** `src/agent/maintenance-queue.ts:72`, `:238`, `:249`.

Le verrou est considéré périmé après cinq minutes en fonction de son `mtime`. Aucun renouvellement n’apparaît dans le module. Un traitement vivant de plus de cinq minutes peut donc être pris pour un worker mort par un second processus. Le risque concerne ensuite la récupération des fichiers `.processing` encore utilisés. Ce scénario n’a pas été exécuté pendant l’audit.

**Correction proposée :** renouveler un bail propriétaire, vérifier les conditions de reprise, et rendre le traitement idempotent même en cas de reprise concurrente. Le renommage du verrou ne dispense pas de vérifier qu’il s’agit toujours du verrou inspecté.

**Acceptation :** worker A ralenti artificiellement, worker B après expiration simulée, puis scénario de vrai crash. Ne pas attendre cinq minutes réelles dans les tests : injecter temps et opérations de verrouillage.

## A09 — L’écriture dite atomique présente deux risques distincts

**Source :** `src/agent/maintenance-queue.ts:182`.

Le fichier temporaire est nommé uniquement avec le chemin cible et le PID. Deux écritures simultanées de la même session dans un processus peuvent donc partager le temporaire. Par ailleurs, le fallback `EEXIST`/`EPERM` supprime la destination avant le second renommage : si celui-ci échoue ou si le processus tombe entre les deux, l’ancienne destination est perdue. L’incident n’a pas été provoqué ici.

**Correction proposée :** temporaire unique par écriture, sérialisation par session et stratégie de remplacement qui conserve une version récupérable. Documenter la garantie face à un crash et distinguer remplacement atomique et persistance après coupure électrique.

**Acceptation :** écritures concurrentes d’une même session, erreur forcée sur remplacement Windows et arrêt entre étapes. Une version complète doit rester récupérable ; une transcription plus courte ne doit pas remplacer silencieusement une version plus récente.

## A10 — Les contrôles de livraison laissent passer le frontend

**Sources :** `src/core/llm-generator.ts:53` ; `web/tsconfig.json:8` ; `tests/web-traces.test.tsx:187` ; `.github/workflows/ci.yml:17`, `:42` ; `package.json:56`, `:69`.

Le contrôle frontend échoue sur `process`, rencontré via le graphe d’imports partagé. La CI PR exécute les tests et un audit des dépendances, mais pas les deux vérifications TypeScript ni le build complet. Le build compile le backend puis bundle le frontend ; il n’appelle pas `typecheck:web`. La CI visible ne tourne que sur Ubuntu.

La suite React a aussi montré un échec de comptage des zones et un flot d’erreurs. L’audit n’attribue pas ce flot à une cause précise : contamination DOM, attentes obsolètes et incompatibilité d’environnement restent à départager.

**Correction proposée :** rendre les modules partagés avec le navigateur indépendants de la configuration serveur lorsque possible, plutôt que d’ajouter aveuglément les types Node. Exécuter les suites React isolément puis ensemble ; corriger les premiers échecs et vérifier le nettoyage des globals. Ajouter typechecks et bundle à la CI PR.

**Acceptation :** suite complète terminée avec bilan, aucun test ignoré pour obtenir le vert, typechecks backend/frontend et build réussis sur les plateformes annoncées.

## A11 — La portabilité des données dépasse la compatibilité du runtime

**Sources :** `src/core/search.ts:113` ; `src/core/cues.ts:180` ; `src/core/embeddings.ts:125` ; `src/agent/mcp-client-setup.ts:60` ; `scripts/windows/humemory-api.vbs:24`, `:39`.

Les traces sont associées à des chemins de répertoires, la recherche compare ces chemins strictement, et les configurations MCP enregistrent des chemins absolus. Changer de machine ou déplacer un projet ne remappe pas ces identités. Le cache d’embeddings utilise par défaut `./data/models`, relatif au répertoire courant, alors que les emplacements de base sont plutôt relatifs au module.

**Correction proposée :** fournir d’abord une commande explicite de remappage des racines de projets, avec aperçu, sauvegarde et transaction. Normaliser les chemins selon la plateforme sans convertir globalement en minuscules sur les systèmes sensibles à la casse. Centraliser aussi le cache des modèles. Un identifiant stable de projet peut venir ensuite si la synchronisation multi-machine est réellement engagée.

La dépendance à Bun est explicite et cohérente avec `bun:sqlite` : il n’est pas nécessaire de promettre une compatibilité Node. En revanche, le minimum `bun >=1.0.0` de `package.json:51` n’est pas démontré par une CI fixée à 1.3.14. Tester le minimum annoncé ou le relever au minimum effectivement validé.

**Acceptation :** déplacement d’un projet, utilisateur différent, espace/accent dans les chemins, lancement depuis un autre répertoire courant et même cache partagé. Les modèles ONNX réels doivent être validés séparément par OS/architecture ; les tests avec embedder simulé ne suffisent pas à les certifier.

## A12 — Le setup MCP peut perdre une configuration lors d’un incident

**Source :** `src/agent/mcp-client-setup.ts:33`, `:43`, `:54`.

Le refus de réécrire un JSON invalide ou commenté est une bonne protection. Mais la sauvegarde utilise directement `writeFile` sur la configuration existante, sans sauvegarde ni remplacement préparé. Un arrêt pendant l’écriture ou une modification concurrente par le client peut tronquer ou écraser une configuration valable.

**Correction proposée :** valider la forme des objets avant fusion, conserver une sauvegarde, écrire un temporaire unique et vérifier que le contenu initial n’a pas changé avant remplacement. Maintenir le comportement de refus sur les formats non pris en charge.

**Acceptation :** serveurs tiers conservés, répétition sans changement, interruption d’écriture récupérable et conflit détecté si le client modifie son fichier pendant le setup.

## Matrice de portabilité à rendre obligatoire

Cette matrice est un plan de validation, pas une liste de compatibilités déjà acquises.

| Axe | Scénarios requis | État actuel de l’audit |
|---|---|---|
| Windows x64 | Backend, frontend, paquet isolé, hooks, redémarrage, chemins avec espaces | Backend validé ; frontend en échec ; autres scénarios partiels/non exécutés |
| Linux x64 | Mêmes contrôles, permissions restrictives, installation hors checkout | Workflow Ubuntu présent ; aucune exécution Linux dans cet audit |
| macOS, notamment ARM64 | Mêmes contrôles, backend natif ONNX distinct | Non exécuté |
| Runtime | Version Bun minimale annoncée et version de référence verrouillée | Bun 1.3.14 exécuté uniquement |
| Distribution | Archive seule, aucun `src` implicite, code en lecture seule | Incohérences A04/A05 |
| Mode hors ligne | Tests sans réseau ; runtime déterministe ; modèle absent et modèle préinstallé | Pas de certification réseau ou ONNX réel |
| État utilisateur | Profil neuf, overrides, base/file/cache déplacés | Échec parent manquant reproduit |
| Concurrence | API + MCP + maintenance, crash et reprise | Défauts A01/A02 ; risques A08/A09 |
| Horaires | UTC documenté, échéances explicites, changement de fuseau | Matcher UTC observé ; pas de validation complète des usages |
| Sauvegarde/restauration | Snapshot cohérent de SQLite en WAL, file, checkpoints et remappage | Procédure de bout en bout non validée |

Éviter de présenter une copie du seul fichier `.db` pendant des écritures comme une sauvegarde validée. Prévoir une procédure de snapshot cohérent, une vérification d’intégrité à la restauration et une politique distincte pour les transcriptions en attente. Ne pas synchroniser naïvement les fichiers SQLite/WAL via un dossier partagé.

## Améliorations utiles après les corrections

1. **Mesurer la qualité cognitive.** Constituer un corpus figé de requêtes, traces attendues, intentions dues et faux positifs ; mesurer rappel, classement et pertinence du contexte injecté. Les tests de structure ne prouvent pas que la bonne mémoire revient.
2. **Mesurer le coût à l’échelle.** Benchmarks synthétiques à plusieurs tailles pour le démarrage, l’index RAM, la recherche et la résolution des cues. `loadIntoMemory()` charge toutes les traces dans chaque processus : mesurer avant de choisir une nouvelle architecture.
3. **Rendre les migrations explicites.** Dans `src/store/sqlite.ts:487`, un `catch` interprète toute erreur d’ajout de colonne comme « déjà présente ». Vérifier le schéma ou filtrer précisément cette erreur ; faire remonter les erreurs d’I/O/permissions. Préparer des tests de migration depuis des bases anciennes et d’interruption de migration.
4. **Ajouter un diagnostic d’installation.** Afficher runtime, chemins résolus, droits d’écriture, version de schéma, état des verrous et présence des modèles, sans contenu de conversations ni secrets. Vérifier tous les points d’entrée depuis ce même résolveur de configuration.
5. **Clarifier les garanties produit.** Différencier découverte d’une source, import disponible, client MCP configuré et mémoire effectivement encodée. Documenter cron UTC, préchargement nécessaire des modèles et comportement de reprise après crash.

## Ordre de travail recommandé

- **Lot 1 — Fiabilité centrale :** A01, A02, A03, avec tests de régression exécutables sans réseau. Ne pas ajouter de fonctionnalités cognitives avant de sécuriser ces comportements.
- **Lot 2 — Installation transportable :** A04, A05 et résolution commune des chemins d’A11 ; test de l’archive hors dépôt, profil vierge et installation en lecture seule.
- **Lot 3 — Livraison vérifiable :** A10, matrice Windows/Linux/macOS et minimum Bun démontré. Les contrôles doivent s’exécuter avant publication.
- **Lot 4 — Qualité et résistance aux incidents :** A06 à A09, A12, migrations et restauration ; mesurer pertinence et charge.

La livraison pourra être déclarée portable sur une plateforme seulement lorsque l’archive installée seule y passe les scénarios retenus. Un checkout qui fonctionne sur la machine de développement et une suite backend verte sont des preuves utiles, mais insuffisantes pour cette déclaration.
