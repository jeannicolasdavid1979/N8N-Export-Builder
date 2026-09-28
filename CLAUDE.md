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
