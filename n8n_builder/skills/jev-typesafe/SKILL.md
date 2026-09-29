---
name: jev-typesafe
description: "Tout savoir pour utiliser Jev (TypeSafe AI), modèle de décision System One : API, six façons de poser les questions, lecture des probabilités et de la confiance, patrons, prix, limites. À lire avant de concevoir ou de régler un automate de décision."
license: "Documentation interne, sources docs.typesafe.ai"
---

# Jev (TypeSafe AI)

Jev est un modèle de décision, sorti le 15 septembre 2026. **Il ne rédige rien** : il reçoit un état et des questions typées, et rend pour chacune une valeur et des probabilités calibrées. Le code qui l'entoure décide. C'est ce qui rend un automate déterministe : même entrée, même route.

## API

Deux accès, même format de requête et de réponse :

- **TypeSafe direct** : `POST https://api.typesafe.ai/v1/systemone`, clé TypeSafe, modèles `jev-latest`, `jev-preview`, `jev-1.13.0` ;
- **OpenRouter** : `POST https://openrouter.ai/api/v1/systemone`, clé OpenRouter, modèles `~typesafe/jev-latest`, `typesafe/jev-1.13`. Pas de compte TypeSafe à ouvrir ; la réponse indique aussi `usage.cost`.

```
POST https://api.typesafe.ai/v1/systemone
Authorization: Bearer <clé>
{"model": "jev-latest", "state": <texte, objet ou tableau>, "questions": {"<id>": <question>, ...}}
```

Réponse : `{"model": "jev-1.13.0", "answers": {"<id>": <réponse>}, "usage": {"input_tokens", "output_tokens"}}`.
Modèles : `jev-latest` (suit les versions), `jev-preview`, `jev-1.13.0` (à figer quand les seuils sont calibrés).
Erreurs : 401 clé, 422 requête mal formée, 429 débit, 529 surcharge (réessayer avec attente).

## Les trois types de question

| Type | Question | Réponse |
|---|---|---|
| `noul` | `{"type":"noul","instructions":"…?","criteria":{"true":"…","false":"…"}}` (critères facultatifs) | `{"noul": 0.82}` probabilité du oui |
| `choice` | `{"type":"choice","instructions":"…","criteria":{"option":"description ou null"}}`, 2 à 255 options | `{"choice","probabilities":{option: p},"confidence"}` |
| `score` | `{"type":"score","instructions":"…","criteria":["bas","moyen","haut"]}`, 2 à 10 niveaux ordonnés | `{"score": 1.7, "legend", "probabilities", "confidence"}` score continu de 0 à n-1 |

`instructions` et `criteria` acceptent un objet : on y met des données de référence et on les cite entre accents graves (`{"concurrents": ["A","B"], "question": "L'article parle-t-il d'un des `concurrents` ?"}`). Les champs de l'état se citent de la même façon.

## Exploiter Jev à pleine capacité

1. **Oui/non par tranches** : probabilité ≥ seuil du oui : « oui » ; ≤ seuil du non : « non » ; entre les deux : « à vérifier ». Plus une erreur coûte cher, plus la zone intermédiaire est large.
2. **Choix avec distribution** : garder tout `probabilities` pour classer ; « incertain » sous la confiance minimale ; « hésitation » si les deux premiers sont trop proches.
3. **Score en tranches nommées** : le score est continu (1,7 est entre le 2e et le 3e niveau) ; découper en tranches (faible, moyen, fort) rend les règles lisibles.
4. **Choix dans une liste reçue** : construire une question `choice` dont les options sont les éléments d'une liste d'entrée (brouillons, factures candidates, outils). Reclassement et sélection sans génération.
5. **Étiquettes multiples** : un `noul` par étiquette ; toutes celles au-dessus du seuil s'appliquent.
6. **Pour chaque élément** : la même question `noul` posée à chaque élément d'une liste (clauses, lignes, termes de recherche).

Toutes les questions partent **en un seul appel** : c'est jusqu'à 12 fois moins cher et 10 fois plus rapide que des appels séparés.

## Patrons éprouvés

- **Routage par intention** : un `choice`, puis confiance ≥ seuil → route, sinon revue.
- **Garde-fou** : plusieurs `noul` de danger et un `score` de gravité, seuils écrits dans le code.
- **Score composite** : scores atomiques combinés par des poids fixés en code.
- **Extraction fiable** : le code trouve les candidats (regex de dates, montants) ; Jev choisit lequel est le bon. Aucune valeur inventée.
- **Appel de fonction** : fonction et arguments choisis dans des ensembles fermés.
- **Auto-cohérence** : la même question sous trois formulations ; écart fort → revue.
- **Évaluateur** : juger le brouillon d'un LLM (répond-il, invente-t-il, promet-il) avant envoi.

## Limites

- Entraîné surtout en anglais : en français, calibrer les seuils sur 20 vrais cas.
- Contexte : 64k tokens par requête, 32k pour l'état plus la plus longue question.
- Texte seulement : convertir images, PDF et sons avant.
- Déterministe ne veut pas dire exact : Jev peut se tromper avec aplomb ; les routes de revue sont là pour ça.
- Débits actuels annoncés 1 200 requêtes par minute, ajustés sans préavis.

## Prix

0,042 $ par million de tokens en entrée, sortie gratuite. Une décision typique coûte quelques millionièmes de dollar, contre plusieurs millièmes pour un LLM qui raisonne.
