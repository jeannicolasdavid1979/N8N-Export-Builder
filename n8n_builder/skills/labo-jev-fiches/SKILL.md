---
name: labo-jev-fiches
description: "Écrire et régler une fiche du Labo Jev : format complet, six types de questions, verdicts, règles, résultats, cas de test, calibrage, LLM d'entrée et de route. Pour remplir une fiche comme le ferait un expert, en expliquant chaque choix."
license: "Documentation interne"
---

# Fiches du Labo Jev

Une fiche décrit un automate en langage courant. Elle se compile en workflow n8n (`POST /api/jevlab/compile`).

## Format

```json
{
  "name": "Tri des e-mails entrants",
  "objectif": "Ce que décide l'automate, en une phrase",
  "entree": {"mode": "field", "field": "message"},
  "exemple": {"message": "…"},
  "questions": [ … ],
  "resultats": [{"id": "traiter_vite", "label": "À traiter dans l'heure", "consigne": "ce que fait l'agent"}],
  "regles": [{"si": [{"question": "action", "op": "est", "valeur": "oui"}], "alors": "traiter_vite", "pourquoi": "…"}],
  "par_defaut": "classer",
  "si_jev_indisponible": "a_relire",
  "tests": [{"entree": "…", "attendu": "traiter_vite", "attendus": {"action": "oui"}, "note": "…", "source": "reel"}],
  "reglage": {"cout_erreur": 50, "cout_revue": 2, "voies": {"a_relire": "humain", "classer": "auto"}, "qcm": {"gravite": "c", "temps": "b"}},
  "jev_fournisseur": "openrouter",
  "modele": "~typesafe/jev-latest",
  "llm_entree": {"provider": "openrouter", "model": "xiaomi/mimo-v2.6-flash", "system": "…"},
  "llms": [{"route": "traiter_vite", "provider": "openrouter", "model": "…", "system": "…"}],
  "ia": {"questions.action.seuils": {"origine": "humain", "pourquoi": ""}}
}
```

`entree.mode` : `field` (un texte), `fields` (plusieurs champs), `json` (tout l'objet). Identifiants : minuscules, chiffres et `_`.

## Les six types de questions et leurs verdicts

| Type | Réglages | Verdicts utilisables dans les règles |
|---|---|---|
| `noul` | `seuil_oui`, `seuil_non` (en %), `oui_signifie`, `non_signifie` | `oui`, `non`, `a_verifier` |
| `choice` | `options` [{mot, description}], `confiance_min`, `marge` | un mot, `incertain`, `hesitation` |
| `score` | `niveaux`, `confiance_min`, `tranches` [{jusqu_a, mot}], `au_dela` | le mot de la tranche (ou le numéro du niveau), `incertain` ; `au_moins`, `au_plus` sans tranches |
| `liste` | `champ_liste`, `champ_texte`, `confiance_min`, `marge` | le texte de l'élément choisi, `incertain`, `hesitation`, `aucun` |
| `etiquettes` | `options`, `seuil` ; question type « Le texte relève-t-il de l'`etiquette` décrite par `definition` ? » | opérateurs `contient`, `ne_contient_pas` |
| `pour_chaque` | `champ_liste`, `champ_texte`, `seuil` ; parler de l'`element` | `tous`, `certains`, `aucun` |

Toute question accepte `donnees` : un objet de référence cité entre accents graves.

## Règles de conception

- Une question, un seul jugement. Ce qui se calcule ne va jamais dans une question.
- Seuils : plus une erreur coûte cher, plus le seuil du oui est haut ; toujours une zone « à vérifier ».
- Toujours un résultat de revue humaine, et `si_jev_indisponible` pointé dessus.
- Règles lues dans l'ordre : les plus graves d'abord (refus, humain), le cas général en dernier.
- 6 à 10 cas de test variés, dont des cas limites, avec `attendus` par question : le calibrage s'en sert. Jusqu'à 100 cas ; `source` vaut `ia` pour un cas inventé par l'IA, `reel` sinon.
- Pour la salle de réglage, 30 cas étiquetés ou plus, de préférence de vrais messages : en dessous, un écart d'une ou deux erreurs ne prouve rien.
- LLM d'entrée seulement si l'entrée est brouillonne ; LLM de route seulement pour rédiger.

## Salle de réglage (vue graphique)

`reglage` donne le prix d'une erreur (`cout_erreur`, un wagon parti seul sur une autre voie que celle attendue), le prix d'un passage humain (`cout_revue`) et la nature de chaque voie (`auto`, `humain`, `blocage` ; sinon devinée d'après son nom). Une voie `humain` n'est jamais comptée comme erreur.

Déroulé : les cas passent une fois chez Jev, puis l'outil rejoue le code exact de l'aiguillage sur ces réponses, en ne changeant que les seuils, et calcule des manettes : Dépenser le moins (coût total minimal à vos prix), Ne rien laisser passer (une erreur compte cent fois plus), Le moins de travail humain (un passage humain compte autant qu'une erreur), Ultra rapide (sans LLM de route, si la fiche en a), et un curseur Autonomie / Prudence. Entre réglages équivalents, l'outil garde le seuil du milieu. « Essayer sur la voie » est un aperçu (compteur de wagons et d'erreurs sur chaque voie, liste des wagons qui changent de voie) ; « Garder ce réglage » l'adopte et marque les seuils `humain` avec le levier choisi dans `pourquoi`. Il faut au moins 5 cas avec `attendu`.

`reglage.qcm` garde les réponses au QCM des priorités (questions `gravite`, `temps`, `volume`, `vitesse`, `maturite`, réponses `a`, `b` ou `c`). Le classement des leviers en découle par des points fixes, pas par l'IA. La synthèse IA (`POST /api/jevlab/synthese`) explique les chiffres du banc et suit ce classement, ou dit pourquoi elle s'en écarte.

## Collaboration avec l'humain

Le champ `ia` garde l'origine de chaque case (`ia`, `humain`, `calibrage`) et la justification. Une case `humain` n'est jamais réécrite par l'IA. En proposant une case, toujours expliquer le choix en une phrase simple.
