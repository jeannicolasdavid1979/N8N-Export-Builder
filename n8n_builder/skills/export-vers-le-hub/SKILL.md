---
name: export-vers-le-hub
description: "Donner un automate du builder à une playlist du Hub d'agents : les quatre pièces exportées (OpenAPI, SKILL.md, kit, workflow), où les déposer dans le Hub, droits à donner, et comment l'agent de la playlist doit utiliser l'automate."
license: "Documentation interne"
---

# Export vers une playlist du Hub

`POST /api/export/hub` (ou le bouton « Exporter vers le Hub ») produit quatre pièces, dans des formats que le Hub lit déjà :

| Pièce | Où dans le Hub | Effet |
|---|---|---|
| `openapi.json` | Connecteurs, Ajouter un connecteur, API par sa description OpenAPI | l'automate devient un outil ; la clé `X-Builder-Key` va au coffre |
| `SKILL.md` | Catalogue, Skills, importer, puis « Ajouter à une playlist » | l'agent sait quand appeler l'automate et que faire pour chaque route |
| `kit.json` | Studio, installer un kit | crée une playlist complète : mission, source demandée, épreuves tirées des cas de test |
| `workflow-n8n.json` | n8n, importer | inutile si l'automate a été envoyé par le builder |

## Réglages dans la playlist

- Droit **Écriture** sur l'API de l'automate : l'appel est un POST. Poser un plafond d'écritures sur 24 h.
- L'adresse du serveur doit être l'adresse **publique** de n8n (à l'export, choisir l'instance ou saisir l'adresse).

## Ce que l'agent doit faire

1. Passer l'entrée brute à l'outil de l'automate, sans la reformuler.
2. Lire `route`, puis appliquer la consigne de cette route (elle figure dans le skill et dans la mission du kit).
3. Ne jamais refaire le tri ni contredire la route. Une route de revue veut dire : transmettre à un humain.
4. Si l'outil ne répond pas : transmettre, ne pas deviner.

## Pourquoi c'est rentable

L'agent ne lit plus les critères et ne raisonne plus dessus : il lit un verdict court. La décision coûte l'entrée de Jev (0,042 $ par million de tokens) au lieu d'un raisonnement de LLM, et elle est identique à chaque passage. `POST /api/economy` estime l'économie pour 1 000 décisions.
