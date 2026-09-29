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
  "tests": [{"entree": "…", "attendu": "traiter_vite", "attendus": {"action": "oui"}, "note": "…"}],
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
- 6 à 10 cas de test variés, dont des cas limites, avec `attendus` par question : le calibrage s'en sert.
- LLM d'entrée seulement si l'entrée est brouillonne ; LLM de route seulement pour rédiger.

## Collaboration avec l'humain

Le champ `ia` garde l'origine de chaque case (`ia`, `humain`, `calibrage`) et la justification. Une case `humain` n'est jamais réécrite par l'IA. En proposant une case, toujours expliquer le choix en une phrase simple.
