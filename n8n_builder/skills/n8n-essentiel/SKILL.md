---
name: n8n-essentiel
description: "L'essentiel de n8n pour construire et déployer des automates : API publique, structure d'un workflow, nœuds utilisés par le builder, webhooks, identifiants, activation, pièges vérifiés sur n8n 2.40."
license: "Documentation interne"
---

# n8n, l'essentiel pour un agent

## API publique

- Adresse : `<n8n>/api/v1`, en-tête `X-N8N-API-KEY: <clé>` (Paramètres, API n8n, Créer une clé). Identique en local, sur VPS et sur n8n Cloud (hors période d'essai).
- `GET /workflows?limit=100` : liste ; `POST /workflows` : création ; `PUT /workflows/{id}` : remplacement ; `POST /workflows/{id}/activate` et `/deactivate` ; `DELETE /workflows/{id}`.
- `POST /credentials` `{"name","type","data"}` : identifiants. Types utilisés : `httpBearerAuth` `{"token"}`, `httpHeaderAuth` `{"name","value"}`.

## Structure d'un workflow

`{"name", "nodes": [...], "connections": {...}, "settings": {"executionOrder": "v1"}}`. L'API refuse toute autre clé à la racine et toute clé de nœud inconnue.
Un nœud : `id`, `name` (unique), `type`, `typeVersion`, `position`, `parameters`, et au besoin `credentials`, `webhookId`, `notes`, `notesInFlow`, `retryOnFail`, `maxTries`, `waitBetweenTries`, `onError`.
Les connexions relient des **noms** de nœuds : `{"A": {"main": [[{"node": "B", "type": "main", "index": 0}]]}}` ; une sortie par index (Switch : une par route).

## Nœuds du cœur utilisés par le builder

| Nœud | Type, version | Rôle |
|---|---|---|
| Webhook | `n8n-nodes-base.webhook` 2 | entrée HTTP ; `responseMode: responseNode` ; `authentication: headerAuth` |
| Planification | `n8n-nodes-base.scheduleTrigger` 1.2 | lancement régulier |
| Code | `n8n-nodes-base.code` 2 | JavaScript ; `$input.all()`, `$('Nom').all()`, `$getWorkflowStaticData('global')` (mémoire, en production seulement) |
| HTTP Request | `n8n-nodes-base.httpRequest` 4.2 | Jev et LLM ; `genericCredentialType` + `httpBearerAuth` |
| Switch | `n8n-nodes-base.switch` 3.2 | une sortie nommée par route |
| Respond to Webhook | `n8n-nodes-base.respondToWebhook` 1.1 | réponse JSON |
| RSS | `n8n-nodes-base.rssFeedRead` 1.1 | source de veille |

## Pièges vérifiés

- Le webhook range la requête dans `body` : lire `item.json.body`, pas `item.json`.
- `notesInFlow`, pas `notesInFlowchart` : une clé inconnue fait refuser tout le workflow (400).
- `responseMode: responseNode` exige un nœud Respond to Webhook **relié** au webhook, sinon 500 à l'appel.
- Activation refusée (409) si un workflow actif utilise déjà le même chemin de webhook : remplacer l'existant ou changer le chemin.
- Juste après l'activation, le webhook peut répondre 404 une ou deux secondes : réessayer.
- n8n 2.x demande Node 24 ; derrière Docker, l'hôte se joint par `http://host.docker.internal`.
- `onError: continueRegularOutput` sur un appel HTTP laisse passer l'erreur dans `json.error` : le nœud suivant doit la traiter (le builder envoie alors vers la route de revue).

## Workflows du builder dans n8n

Chaque workflow envoyé par le builder porte une note « Source du builder (ne pas modifier) » : sa spécification, et la fiche du Labo Jev sans les cas de test. Elle permet de le réimporter à l'identique. La supprimer ne casse rien dans n8n ; le builder reconstruit alors l'automate depuis le code des nœuds « Préparer les données » et « Décision déterministe ». Un nœud ajouté ou un code modifié dans n8n est signalé à l'import : un nouvel envoi depuis le builder l'écraserait.
