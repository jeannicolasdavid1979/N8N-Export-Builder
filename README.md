# N8N Export Builder

**Des workflows n8n déterministes qui allègent les agents IA.** Un atelier pour concevoir, tester et envoyer dans n8n des workflows qui trient, calculent et décident à la place de l'agent : même entrée, même décision, pour une fraction du coût d'un LLM.

Le moteur de décision est **Jev** (TypeSafe AI, sorti le 15 septembre 2026) : un modèle qui ne génère pas de texte mais rend des réponses typées et des probabilités calibrées. Le reste est du code JavaScript lisible, dans des nœuds du cœur de n8n.

Conçu pour le [Hub d'agents](https://github.com/jeannicolasdavid1979/hub-d-agents) : chaque playlist du hub a son workflow prêt à l'emploi.

## Ce que fait l'outil

| Espace | Rôle |
|---|---|
| **Atelier** | Bibliothèque de 16 modèles, éditeur de spécification (déclencheur, préparation, questions Jev, règles, routes, LLM de secours), aperçu du schéma, test avec Jev ou avec des réponses saisies, export JSON |
| **Assistant de conception** | Un LLM transforme une description en spécification, qui passe par la même validation que la saisie manuelle. Il sert à la conception, jamais à l'exécution |
| **Modèles LLM** | OpenRouter en tête, puis Ollama Cloud, Ollama local, TypeSafe Jev, Anthropic, OpenAI, Gemini, Mistral, DeepSeek, Groq, xAI, Together, Cerebras. Listes de modèles lues en direct chez chaque fournisseur (prix et contexte pour OpenRouter, taille pour Ollama local). Clés chiffrées, jamais renvoyées à l'interface |
| **Instances n8n** | Local, VPS ou n8n Cloud par l'API publique. Envoi, remplacement d'un workflow existant, création des identifiants (Jev, LLM, clé du webhook), activation |

## Démarrer

```bash
pip install -e .
n8n-export-builder            # http://127.0.0.1:8790
```

Avec Docker, à côté de n8n :

```bash
docker compose up -d          # builder sur :8790, mot de passe dans .env
```

| Variable | Rôle |
|---|---|
| `N8NB_DATA` | dossier des données (défaut `./data`) |
| `N8NB_SECRET_KEY` | clé Fernet de chiffrement des clés d'API ; générée dans `<données>/.secret` si absente |
| `N8NB_PASSWORD` | mot de passe de l'interface (authentification HTTP Basic). **Obligatoire** dès que le builder écoute hors de la machine locale : il refuse de démarrer sinon |
| `N8NB_HOST`, `N8NB_PORT` | adresse d'écoute (défaut `127.0.0.1:8790`) |

## Parcours type

1. **Modèles LLM** : collez la clé TypeSafe (console.typesafe.ai) et, pour l'assistant et le LLM de secours, une clé OpenRouter ou l'adresse de votre Ollama.
2. **Instances n8n** : reliez votre n8n (Paramètres, API n8n, Créer une clé).
3. **Atelier** : choisissez un modèle ou décrivez le besoin à l'assistant. Testez avec l'exemple, ajustez les seuils.
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
- Le test de l'Atelier exécute dans le navigateur le code exact des nœuds générés.

## Bibliothèque

| Modèle | Playlist du hub | Ce que l'agent n'a plus à faire |
|---|---|---|
| Support client : triage des tickets | Support client (support-bot) | classer, repérer urgence, frustration, remboursement |
| Relance factures : niveau de relance | Relance des factures impayées | calculer les retards, choisir le niveau, éviter la double relance (100 % code) |
| Relance factures : classer la réponse | Relance des factures impayées | interpréter la réponse, isoler les demandes de changement de RIB |
| Notes de frais : contrôle | Contrôle des notes de frais | plafonds, justificatif, doublons |
| Prospection : qualification et score | Prospection commerciale | appliquer la grille, rédiger seulement pour les prospects chauds |
| Alertes sécurité et serveurs : triage | Triage des alertes, Surveillance des serveurs | trier le bruit, décider de réveiller l'astreinte |
| Veille concurrentielle : tri des articles | Veille concurrentielle (veille-bot) | écarter les doublons et le hors sujet, ne résumer que l'utile |
| Vidéo réseaux sociaux : contrôle du brief | Générateur Vidéo Réseaux Sociaux (Video-bot) | refuser personne réelle et voix clonée, vérifier durée, lisibilité sans son, formats |
| Choix de la consigne réutilisable | Générateur Vidéo Réseaux Sociaux | parcourir son catalogue de consignes |
| KYC : complétude du dossier | Pré-analyse de dossiers KYC | lister pièces manquantes et expirées (100 % code) |
| Routage par intention, Garde-fou, Score composite, Vérification de citation, Filtre RAG | toutes | patrons de la documentation TypeSafe |

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

Validé contre n8n 2.40.7 : les 16 modèles sont acceptés par l'API publique, activés, et répondent correctement par webhook (Jev simulé), y compris l'authentification par en-tête, la branche LLM et la panne de Jev.

Sources : [API TypeSafe](https://docs.typesafe.ai/api), [modèles et tarifs Jev](https://docs.typesafe.ai/models), [annonce de Jev](https://typesafe.ai/blog/introducing-system-one-models-and-jev), [API publique n8n](https://docs.n8n.io/api/).
