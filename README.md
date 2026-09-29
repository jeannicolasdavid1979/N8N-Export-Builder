# N8N Export Builder

**Des workflows n8n déterministes qui allègent les agents IA.** Un atelier pour concevoir, tester et envoyer dans n8n des workflows qui trient, calculent et décident à la place de l'agent : même entrée, même décision, pour une fraction du coût d'un LLM.

Le moteur de décision est **Jev** (TypeSafe AI, sorti le 15 septembre 2026) : un modèle qui ne génère pas de texte mais rend des réponses typées et des probabilités calibrées. Le reste est du code JavaScript lisible, dans des nœuds du cœur de n8n.

Conçu pour le [Hub d'agents](https://github.com/jeannicolasdavid1979/hub-d-agents) : chaque playlist du hub a son workflow prêt à l'emploi.

## Deux labos, une sortie : une playlist du Hub

| Espace | Pour qui | Rôle |
|---|---|---|
| **Labo Jev** | novice comme pro | Un automate en cases à remplir. L'IA remplit chaque case et explique son choix (« Pourquoi ? ») ; vous ajustez ce que vous voulez, la case passe « Réglé par vous » et l'IA ne la touche plus. Essai direct, banc d'essai, calibrage automatique des seuils sur vos cas |
| **Vue graphique** | novice | Chaque labo bascule en voie ferrée : gare, ateliers, cabine de l'aiguilleur (Jev et ses jauges), aiguillage, voies colorées. Une carte par module, une console de test où le wagon roule jusqu'à sa voie ; en « Pas à pas », l'encart « Chargement du wagon » montre à chaque nœud ce qu'il ajoute (+), retire (−) ou change (~) ; dans le Labo Jev, bouger un seuil rejoue la décision sans rappeler Jev |
| **Salle de réglage** | novice comme pro | Dans la vue graphique du Labo Jev. Les cas du banc passent une fois chez Jev ; vous dites ce que coûte une erreur et un passage humain, en euros ; l'outil essaie des milliers de réglages sur ces réponses et propose des manettes : dépenser le moins, ne rien laisser passer, le moins de travail humain, ultra rapide sans LLM, et un curseur autonomie ou prudence. « Essayer sur la voie » montre le nombre de wagons et d'erreurs sur chaque voie et les wagons qui changent de voie ; rien n'est gardé sans votre accord. L'IA peut ajouter 20 cas inventés, marqués comme tels |
| **Plusieurs LLM** | tous | Dans un même automate : un LLM agentique en entrée (par exemple xiaomi/mimo-v2.6-flash via OpenRouter) qui met la demande au propre, Jev qui décide, et un LLM différent par route pour rédiger. Chaque case choisit son fournisseur et son modèle |
| **Labo n8n** | pro | Tous les réglages du générateur : préparation en JavaScript, règles sur les probabilités brutes, score composite, sources RSS ou HTTP, LLM de secours sur une route. Bibliothèque de modèles |
| **Modèles LLM** | tous | OpenRouter en tête, puis Ollama Cloud, Ollama local, TypeSafe Jev, Anthropic, OpenAI, Gemini, Mistral, DeepSeek, Groq, xAI, Together, Cerebras. Listes de modèles lues en direct (prix et contexte pour OpenRouter). Favoris (★) par fournisseur, proposés en tête dans chaque case LLM : un modèle par automate, pas un seul modèle global. Accès à Jev par défaut, TypeSafe direct ou OpenRouter. Clés chiffrées, jamais renvoyées à l'interface |
| **Instances n8n** | tous | Local, VPS ou n8n Cloud par l'API publique : envoi, remplacement, identifiants, activation |
| **Banque de skills** | agents | Cinq SKILL.md au format du Hub : Jev, n8n, le builder et son API, les fiches du Labo Jev, l'export vers une playlist. À importer dans le Hub ou à lire par API (`/api/skills`) |

Les deux labos exportent vers le Hub d'agents : **OpenAPI** (l'automate devient un outil de la playlist), **SKILL.md** (la consigne de l'agent, route par route), **kit** (une playlist complète avec épreuves tirées des cas de test) et le **workflow n8n**. Ces formats sont vérifiés avec le code d'import du Hub lui-même.

## Jev à pleine capacité

Jev n'est pas qu'un juge oui/non. Le Labo Jev en expose six usages, tous posés en un seul appel :

| Type de case | Ce que Jev rend | Ce que vous réglez |
|---|---|---|
| Oui / non | probabilité du oui | tranches en % : NON jusqu'à X, À VÉRIFIER, OUI à partir de Y |
| Choix parmi des mots (jusqu'à 255) | le mot et la probabilité de chacun | mots attendus et leur sens, confiance minimale, seuil d'hésitation entre les deux premiers |
| Score sur une échelle | un score continu entre deux niveaux | niveaux, tranches nommées (faible, moyen, fort…) |
| Choix dans une liste reçue | l'élément choisi et le classement complet | champ de la liste : reclassement de brouillons, choix d'outil, valeur extraite |
| Étiquettes multiples | toutes les étiquettes qui s'appliquent | étiquettes, seuil |
| Pour chaque élément | oui/non par élément d'une liste | question, seuil ; verdict tous, certains ou aucun |

Jev s'appelle **en direct chez TypeSafe ou par OpenRouter** (votre clé OpenRouter suffit) : le choix se fait dans chaque automate, avec la liste des modèles de chacun.

Chaque question peut porter des **données de référence** (liste de concurrents, catégories autorisées…), citées dans la question entre accents graves.

## Pourquoi des automates plutôt qu'un LLM qui interprète

Un automate réglé est déterministe : la même entrée donne toujours la même décision, relisible règle par règle. Il coûte l'entrée de Jev (0,042 $ par million de tokens) au lieu d'un raisonnement de LLM, et l'agent ne lit plus qu'un verdict court. Chaque labo affiche l'estimation des tokens et des dollars épargnés sur 1 000 décisions, au prix du modèle de référence choisi dans OpenRouter.

## Démarrer

```bash
pip install -e .
n8n-export-builder            # http://127.0.0.1:8790
```

Sur un VPS : [docs/installation-vps.md](docs/installation-vps.md) (Docker, Coolify, HTTPS par Caddy ou tunnel SSH).

| Variable | Rôle |
|---|---|
| `N8NB_DATA` | dossier des données (défaut `./data`) |
| `N8NB_SECRET_KEY` | clé Fernet de chiffrement des clés d'API ; générée dans `<données>/.secret` si absente |
| `N8NB_PASSWORD` | mot de passe de l'interface (authentification HTTP Basic). **Obligatoire** dès que le builder écoute hors de la machine locale : il refuse de démarrer sinon |
| `N8NB_HOST`, `N8NB_PORT` | adresse d'écoute (défaut `127.0.0.1:8790`) |
| `N8NB_JEV_URL` | adresse de Jev pour les essais du builder (proxy d'entreprise ou test) ; jamais modifiable depuis l'interface |

## Parcours type

1. **Modèles LLM** : collez la clé TypeSafe (console.typesafe.ai) et, pour l'assistant et le LLM de secours, une clé OpenRouter ou l'adresse de votre Ollama.
2. **Instances n8n** : reliez votre n8n (Paramètres, API n8n, Créer une clé).
3. **Labo Jev** (cases guidées, IA qui explique) ou **Labo n8n** (modèles et réglages complets) : partez d'une fiche ou d'un modèle, ou décrivez le besoin à l'IA. Testez, calibrez.
4. **Envoyer vers n8n** : le workflow arrive avec ses identifiants, activé. Si un workflow actif occupe déjà le chemin du webhook, choisissez « Remplacer ».
5. **Hub d'agents** : Catalogue, Ajouter une API, collez l'exemple curl fourni ; la clé du webhook va au coffre. Ajoutez l'API à la playlist de l'agent.

## Ce qui est généré

```
Déclencheur → [Source RSS/HTTP] → Préparer les données (JS) → Jev (HTTP, 3 essais)
  → Décision déterministe (JS, sans modèle) → Aiguillage → Route : x → [LLM de secours] → Répondre (JSON)
```

- Uniquement des nœuds du cœur de n8n : aucun nœud communautaire à installer.
- Les questions sont envoyées en un seul appel Jev. Le nœud Jev réessaie trois fois ; en cas d'échec, le cas part sur la route d'erreur (revue humaine), jamais sur une route d'action.
- Un nœud vide par route, où brancher vos actions (Slack, CRM, e-mail, agent).
- Le webhook répond `{route, raison, variables, extra, jev_modele}` : c'est ce que reçoit l'agent du hub.
- Le test des deux labos exécute dans le navigateur le code exact des nœuds générés.

## Bibliothèque : 50 modèles, trois niveaux

| Niveau | Nombre | Ce qu'il contient |
|---|---|---|
| 1, simple | 15 | du code seul (IBAN et SIREN, TVA, SLA, métriques serveur, normalisation de contact, déclinaison vidéo…) ou une seule question Jev |
| 2, intermédiaire | 23 | plusieurs questions, verdicts par tranches, étiquettes multiples, mémoire de l'automate |
| 3, avancé | 12 | questions construites depuis l'entrée (une par clause, par terme de recherche, par candidat), sources RSS, extraction fiable, appel de fonction, LLM sur une route |

Répartition : 26 modèles pour les playlists du Hub (support, relances, notes de frais, prospection, alertes, veille, Video-bot, KYC, contrats, crédit, fournisseurs, rapprochement, Gmail, LinkedIn, Google Ads, Telegram…), 12 modèles métiers (e-commerce, RGPD, SLA, CRM, veille réglementaire…), 11 primitives Jev, 1 modèle vierge. Neuf sont du pur code, les 41 autres appellent Jev.

Plusieurs modèles reprennent des patrons publiés, réécrits en déterministe et crédités dans leur fiche : cookbooks TypeSafe (routage par intention, garde-fou, score composite, citation, RAG, auto-cohérence, classement hiérarchique, extraction de dates, appel de fonction, alignement d'entités, reclassement), « Building effective agents » d'Anthropic (vote en parallèle, évaluateur), cookbook Anthropic (modération, routage de tickets), modèles communautaires n8n (tri d'e-mails, anti-spam de formulaire).

Chaque modèle est vérifié de trois façons : exécution de son code sur des cas choisis (`tests/test_library.py`), import, activation et appel dans un vrai n8n 2.40, et lecture de son export par le code du Hub.

## Limites, sans fard

- **Jev est entraîné surtout en anglais.** Les questions des modèles sont en français pour rester lisibles ; calibrez les seuils sur une vingtaine de vrais cas avant la production, ou traduisez les instructions si la précision baisse.
- **Déterministe ne veut pas dire exact.** Jev peut se tromper avec aplomb. Le gain est la stabilité, la traçabilité et le coût, pas l'infaillibilité ; les seuils de confiance et les routes de revue sont là pour ça.
- **`jev-latest` bouge** à chaque version : figez `jev-1.13.0` quand vos seuils sont calibrés.
- **Débits de TypeSafe instables** en ce moment (annoncés 1 200 requêtes par minute, ajustés sans préavis).
- **Texte seulement** : images, PDF et sons doivent être convertis avant Jev.
- L'API publique de n8n Cloud n'est pas disponible pendant l'essai gratuit.
- Le builder est mono-utilisateur : un mot de passe, pas de comptes. À placer derrière HTTPS s'il est exposé.

## Développement

```bash
pip install -e ".[dev]"
pytest            # les tests d'exécution du JavaScript généré demandent node dans le PATH
```

Validé contre n8n 2.40.7 : les 50 modèles et les 9 fiches du Labo Jev sont acceptés par l'API publique, activés, et répondent correctement par webhook (Jev simulé), y compris l'authentification par en-tête, la branche LLM et la panne de Jev. Juste après l'activation, n8n peut mettre une ou deux secondes à enregistrer le webhook.

Sources : [API TypeSafe](https://docs.typesafe.ai/api), [modèles et tarifs Jev](https://docs.typesafe.ai/models), [annonce de Jev](https://typesafe.ai/blog/introducing-system-one-models-and-jev), [API publique n8n](https://docs.n8n.io/api/).
