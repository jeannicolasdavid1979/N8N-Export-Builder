# Règles pour les sessions de développement de ce dépôt

## Langue et style

Interface, documentation et messages de commit en français. Pas de tiret cadratin ni demi-cadratin dans les textes destinés aux utilisateurs.

## Architecture

- `n8n_builder/spec.py` : forme et validation d'une spécification. Toute nouvelle option passe ici d'abord.
- `n8n_builder/generator.py` : spécification vers workflow n8n. Uniquement des nœuds du cœur de n8n. Le JavaScript des nœuds Code doit rester lisible et exécutable tel quel dans le navigateur (test de l'Atelier) : il n'utilise que `$input`, `$(nom).all()` et `$getWorkflowStaticData`.
- `n8n_builder/templates.py` : bibliothèque. Chaque modèle a un exemple d'entrée réaliste et, s'il sert une playlist du Hub d'agents, le bloc `hub`.
- `n8n_builder/providers.py` : fournisseurs dans l'ordre d'affichage (OpenRouter, Ollama Cloud, Ollama local, Jev, puis les autres).
- `n8n_builder/app.py` : API FastAPI. Aucune clé ne sort vers l'interface ; la clé TypeSafe ne part que vers l'adresse officielle de Jev ou vers une instance n8n choisie.

## Vérifier avant de pousser

- `pytest` (avec `node` dans le PATH pour les tests d'exécution du JavaScript généré).
- Un changement du générateur se vérifie aussi contre un vrai n8n : l'API publique refuse toute clé de nœud inconnue.

## Labo Jev et export

- `n8n_builder/jevlab.py` : fiche du Labo Jev (six types de questions), validation en langage courant, compilation vers une spécification, remplissage par LLM global ou case par case. Une case marquée `humain` dans `ia` n'est jamais écrasée par l'IA.
- `n8n_builder/fiches.py` : fiches types, chacune avec des cas de test.
- `n8n_builder/hubexport.py` : OpenAPI, SKILL.md, kit (format 1) et workflow. Tout changement se vérifie avec les lecteurs du Hub (`agent_hub.studio.apis.preview`, `kitformat.parse_kit`, `skills.parse_skill_md`), voir `tests/test_jevlab.py`.

## Banque de skills : à jour à chaque poussée

`n8n_builder/skills/*/SKILL.md` est ce que les agents savent de Jev, de n8n et de l'outil. Toute modification qui change ce qu'un agent peut faire (route d'API, type de question, format de fiche, export) met à jour le skill concerné dans le même commit. `tests/test_skills.py` échoue si le skill du builder cite une route qui n'existe pas, ou si le Hub ne sait pas lire un skill.

## Pédagogie des interfaces

Toute nouvelle fonction s'accompagne de sa lecture par un novice : métaphore visuelle concrète (la voie ferrée, le wagon et son chargement), manipulation directe avec effet immédiat (bouger un seuil rejoue la décision), pas à pas qui montre ce que chaque étape change, divulgation progressive (bulles (i), tutoriels repliables, réglages experts en retrait). Proposer ce traitement à chaque ajout d'écran.
