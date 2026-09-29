---
name: n8n-export-builder
description: "Mode d'emploi de N8N Export Builder pour un agent : ce que fait chaque page, les routes d'API pour construire, tester, envoyer et exporter un automate déterministe sans l'interface, et la marche à suivre."
license: "Documentation interne"
---

# N8N Export Builder

Outil qui fabrique des **automates déterministes** : un workflow n8n où Jev juge et du code décide. Un automate épargne à l'agent de relire des critères et de raisonner : il reçoit une route, une raison et des variables.

## Pages

- **Labo Jev** : un automate en cases (fiche). L'IA remplit et explique chaque case, l'humain ajuste ; essai, banc d'essai, calibrage des seuils.
- **Labo n8n** : 50 modèles en trois niveaux, et tous les réglages (préparation en JavaScript, règles sur les valeurs brutes, sources, LLM).
- **Modèles LLM** : clés chiffrées et modèles lus en direct (OpenRouter en tête, Ollama, Jev…). Chaque fournisseur a ses favoris (★), proposés en tête dans chaque case LLM ; chaque automate garde son propre modèle. La carte de Jev fixe l'accès par défaut des nouveaux automates (TypeSafe direct ou OpenRouter).
- **Instances n8n** : n8n local, VPS ou Cloud.
- **Banque de skills** : ces fichiers, à donner aux agents.
- **Vue graphique** (bouton dans les deux labos) : l'automate en voie ferrée. Gare (entrée), ateliers (préparation, LLM d'entrée), cabine de l'aiguilleur (Jev, une jauge par question), aiguillage (règles), voies colorées vers chaque route (verte automatique, orange humain, rouge blocage). Une carte par module, et une console de test où le wagon roule jusqu'à sa voie. En « Pas à pas », le wagon s'arrête à chaque station et l'encart « Chargement du wagon » montre le contenu réel du message et ce que le nœud a ajouté (+), retiré (−) ou changé (~) ; la dernière étape montre ce que l'agent reçoit vraiment. Dans le Labo Jev, l'onglet **Salle de réglage** du panneau de droite propose des manettes (dépenser le moins, ne rien laisser passer, le moins de travail humain, ultra rapide, curseur autonomie et prudence) calculées sur les cas du banc d'essai, avec le prix d'une erreur et d'un passage humain ; l'aperçu affiche sur chaque voie le nombre de wagons et d'erreurs, rien n'est gardé sans validation. Plus bas, un QCM de cinq questions classe les manettes selon les priorités de la personne, et le bouton **Synthèse IA** rédige un rapport pas à pas (ce qui a été fait, ce que Jev a conclu, les manettes et quand choisir chacune, la recommandation, un conseil), à copier ou télécharger en Markdown.

## Chaîne d'un automate

Déclencheur → Préparer les données (code) → [LLM d'entrée, facultatif] → Jev → Décision (code, sans modèle) → Aiguillage → Route → [LLM de route, facultatif] → Réponse JSON `{route, raison, variables, extra, jev_modele}`.
Si Jev ne répond pas, le cas part sur la route d'erreur (revue humaine), jamais sur une route d'action.
Jev s'appelle en direct chez TypeSafe ou par OpenRouter : champ `jev_provider` d'une spécification (`typesafe` ou `openrouter`), `jev_fournisseur` d'une fiche. Avec OpenRouter, un seul identifiant n8n sert à Jev et aux LLM.

## API pour un agent

Authentification HTTP Basic si l'outil est protégé (mot de passe `N8NB_PASSWORD`, identifiant libre). Corps JSON.

| Route | Rôle |
|---|---|
| `GET /api/state` | fournisseurs, instances, modèles (`templates`), fiches types, workflows enregistrés |
| `GET /api/templates/{id}` | un modèle : `{"spec": ...}` |
| `POST /api/build` `{"spec"}` | valide et génère : `workflow`, `routes`, `variables`, `warnings` ; 422 avec `errors` lisibles sinon |
| `GET /api/jevlab/fiches/{id}` | une fiche type du Labo Jev |
| `POST /api/jevlab/compile` `{"fiche"}` | fiche vers workflow ; `reponses` donne les valeurs possibles de chaque question |
| `POST /api/jevlab/fill` `{"provider","model","description","fiche"?}` | l'IA remplit la fiche ; les cases `humain` sont gardées |
| `POST /api/jevlab/field` `{"provider","model","fiche","path","consigne"?}` | l'IA propose une seule case (`questions.<id>.seuils`, `regles`, `tests`…) |
| `PUT /api/providers/{pid}` `{"key"?,"default_model"?,"favorites"?,"jev_via"?}` | règle un fournisseur : `favorites` (liste de modèles préférés), `jev_via` (`typesafe` ou `openrouter`, sur la carte `typesafe` seulement) ; la clé n'est jamais renvoyée |
| `POST /api/jev/ask` `{"state","questions","model"?,"provider"?}` | appel direct à Jev avec la clé enregistrée ; `provider` : `typesafe` (défaut) ou `openrouter` |
| `POST /api/jevlab/qcm` `{"reponses","leviers"?}` | classe les leviers (`econome`, `prudent`, `autonome`, `rapide`) d'après le QCM des priorités ; chaque point est justifié. Questions et barème dans `GET /api/state`, champ `qcm_leviers` |
| `POST /api/jevlab/synthese` `{"provider","model","dossier"}` | rapport pédagogique de la salle de réglage : `fait`, `jev` (lecture par question), `leviers` (quand choisir, attention), `recommandation`, `conseil`, `etapes`, plus `classement` du QCM. Le dossier porte les chiffres calculés par l'outil ; l'IA n'en invente aucun |
| `POST /api/economy` `{"spec"|"fiche","calls"?}` | tokens et coût épargnés estimés |
| `POST /api/n8n/{instance}/push` `{"spec"|"fiche","activate","create_credentials","update_id"?}` | envoi dans n8n : identifiants créés, workflow activé, adresse du webhook et clé X-Builder-Key (affichée une fois) |
| `POST /api/export/hub` `{"spec"|"fiche","instance_id"|"base_url","format":"zip"?}` | OpenAPI, SKILL.md, kit et workflow pour une playlist du Hub |
| `GET /api/skills`, `GET /api/skills/{nom}` | la banque de skills |

## Marche à suivre

1. Partir d'un modèle proche (`/api/state`, champ `templates`, filtrer par `hub.playlist` ou `niveau`) ou d'une fiche type.
2. Adapter questions, seuils et routes ; appeler `/api/build` ou `/api/jevlab/compile` jusqu'à zéro erreur.
3. Vérifier sur des exemples avec `/api/jev/ask` puis la route obtenue.
4. Envoyer vers n8n (`push`), noter l'adresse du webhook et la clé.
5. Exporter vers le Hub (`/api/export/hub`) et suivre `LISEZMOI.md`.

Ne jamais envoyer la clé TypeSafe vers une autre adresse que celle de Jev ou l'instance n8n choisie. Ne jamais activer un webhook sans clé d'en-tête s'il est exposé sur Internet.
