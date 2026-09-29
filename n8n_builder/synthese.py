"""Synthèse IA de la salle de réglage et QCM des priorités.

Le classement des leviers vient du QCM, par un calcul de points relisible : l'IA ne le décide pas.
L'IA rédige seulement les explications, à partir des chiffres calculés par l'outil, qu'elle n'a pas le droit d'inventer.
"""
from __future__ import annotations

import json
import re
from typing import Any

from . import providers as P

LEVIERS = {
    "econome": "Dépenser le moins",
    "prudent": "Ne rien laisser passer",
    "autonome": "Le moins de travail humain",
    "rapide": "Ultra rapide, sans LLM de rédaction",
}

QCM: list[dict[str, Any]] = [
    {"id": "gravite", "question": "Si l'automate envoie un message sur la mauvaise voie, que se passe-t-il ?", "choix": [
        {"id": "a", "texte": "Pas grand-chose, on corrige après coup", "points": {"autonome": 2, "econome": 1}},
        {"id": "b", "texte": "Un client est mécontent", "points": {"econome": 2, "prudent": 1}},
        {"id": "c", "texte": "Une perte d'argent ou un risque juridique", "points": {"prudent": 3}}]},
    {"id": "temps", "question": "Combien de temps un humain peut-il consacrer aux vérifications ?", "choix": [
        {"id": "a", "texte": "Presque pas", "points": {"autonome": 3}},
        {"id": "b", "texte": "Un peu chaque jour", "points": {"econome": 2}},
        {"id": "c", "texte": "Autant qu'il faut", "points": {"prudent": 2}}]},
    {"id": "volume", "question": "Combien de messages l'automate traitera-t-il ?", "choix": [
        {"id": "a", "texte": "Quelques-uns par jour", "points": {"prudent": 1, "econome": 1}},
        {"id": "b", "texte": "Des dizaines par jour", "points": {"econome": 2}},
        {"id": "c", "texte": "Des centaines ou plus", "points": {"autonome": 2, "rapide": 1}}]},
    {"id": "vitesse", "question": "La vitesse de réponse compte-t-elle ?", "choix": [
        {"id": "a", "texte": "Non, dans la journée suffit", "points": {"econome": 1}},
        {"id": "b", "texte": "Oui, dans l'heure", "points": {"econome": 1, "autonome": 1}},
        {"id": "c", "texte": "Oui, en quelques secondes", "points": {"rapide": 3, "autonome": 1}}]},
    {"id": "maturite", "question": "Où en est l'automate ?", "choix": [
        {"id": "a", "texte": "Pas encore en service", "points": {"prudent": 2}},
        {"id": "b", "texte": "En service depuis quelques semaines", "points": {"econome": 2}},
        {"id": "c", "texte": "En service depuis des mois, sans surprise", "points": {"autonome": 2}}]},
]
QCM_IDS = {q["id"]: {c["id"] for c in q["choix"]} for q in QCM}


def clean_qcm(v: Any) -> dict[str, str]:
    v = v if isinstance(v, dict) else {}
    return {k: c for k, c in v.items() if k in QCM_IDS and c in QCM_IDS[k]}


def classer(reponses: Any, disponibles: list[str] | None = None) -> list[dict[str, Any]]:
    """Leviers par ordre de priorité d'après le QCM ; à égalité, l'ordre de LEVIERS. Chaque point est justifié."""
    rep = clean_qcm(reponses)
    ids = [i for i in LEVIERS if disponibles is None or i in disponibles]
    score = {i: 0 for i in ids}
    raisons: dict[str, list[str]] = {i: [] for i in ids}
    for q in QCM:
        c = next((c for c in q["choix"] if c["id"] == rep.get(q["id"])), None)
        if not c:
            continue
        for lid, pts in c["points"].items():
            if lid in score:
                score[lid] += pts
                raisons[lid].append(f"+{pts} : « {c['texte']} »")
    order = sorted(ids, key=lambda i: (-score[i], ids.index(i)))
    return [{"id": i, "nom": LEVIERS[i], "points": score[i], "raisons": raisons[i]} for i in order]


SYSTEM = """Tu rédiges la synthèse d'une salle de réglage, pour une personne qui découvre l'automatisation.
Contexte : un automate de décision fondé sur Jev (TypeSafe AI). Jev ne rédige rien : il répond à des questions par des
probabilités. Des seuils changent ces probabilités en mots (oui, non, à vérifier), des règles envoient chaque message
sur une voie. La personne voit l'automate comme une voie ferrée : chaque message est un wagon, Jev est l'aiguilleur,
chaque résultat est une voie (automatique, humaine ou blocage). Les cas du banc d'essai sont les wagons d'essai.
Les leviers sont des réglages de seuils calculés par l'outil à partir du prix d'une erreur et du prix d'un passage humain.

Règles d'écriture :
- Français simple, phrases courtes, comme un bon professeur. Explique chaque idée par la voie ferrée quand ça aide.
- N'invente AUCUN chiffre : cite seulement ceux du dossier. Si une information manque, dis-le.
- Sois honnête : peu de cas, cas inventés par l'IA, questions qui séparent mal, tout doit être signalé simplement.
- Le classement des priorités vient du QCM de la personne. Ta recommandation le suit ; si les chiffres du banc
  imposent un autre choix, dis-le franchement et explique pourquoi.
- Pas de tiret long ni de tiret moyen.

Réponds UNIQUEMENT par un objet JSON :
{"fait": "ce qui a été fait, 3 à 5 phrases",
 "jev": [{"question": "<id de question>", "lecture": "ce que Jev a conclu sur cette question, et si elle sépare bien les voies"}],
 "leviers": [{"id": "<id de levier>", "quand": "dans quelle situation le choisir", "attention": "son risque ou son prix"}],
 "recommandation": {"levier": "<id de levier>", "pourquoi": "2 à 4 phrases"},
 "conseil": "un conseil concret pour la suite, 2 à 4 phrases",
 "etapes": ["prochaine étape 1", "prochaine étape 2", "prochaine étape 3"]}"""

DASHES = re.compile(r"\s*[–—]\s*")


def _t(v: Any, limit: int = 1200) -> str:
    return DASHES.sub(", ", str(v if isinstance(v, (str, int, float)) else "")).strip()[:limit]


def clean(data: Any, questions: set[str], leviers: set[str]) -> dict[str, Any]:
    if not isinstance(data, dict) or not _t(data.get("fait")):
        raise ValueError("synthèse incomplète")
    rec = data.get("recommandation") if isinstance(data.get("recommandation"), dict) else {}
    lev = rec.get("levier") if rec.get("levier") in leviers else None
    return {
        "fait": _t(data.get("fait")),
        "jev": [{"question": x["question"], "lecture": _t(x.get("lecture"))} for x in data.get("jev") or []
                if isinstance(x, dict) and x.get("question") in questions and _t(x.get("lecture"))][:20],
        "leviers": [{"id": x["id"], "quand": _t(x.get("quand"), 600), "attention": _t(x.get("attention"), 600)}
                    for x in data.get("leviers") or [] if isinstance(x, dict) and x.get("id") in leviers][:10],
        "recommandation": {"levier": lev, "pourquoi": _t(rec.get("pourquoi"))},
        "conseil": _t(data.get("conseil")),
        "etapes": [_t(x, 400) for x in data.get("etapes") or [] if _t(x, 400)][:6],
    }


async def llm_synthese(provider_id: str, key: str | None, model: str, dossier: Any,
                       base_url: str | None = None) -> dict[str, Any]:
    if not isinstance(dossier, dict):
        raise ValueError("Dossier de synthèse manquant.")
    p = P.BY_ID.get(provider_id)
    if not p:
        raise P.ProviderError("Fournisseur inconnu.")
    questions = {q.get("id") for q in (dossier.get("automate") or {}).get("questions") or [] if isinstance(q, dict)}
    leviers = {lv.get("id") for lv in dossier.get("leviers") or [] if isinstance(lv, dict)} & set(LEVIERS)
    classement = classer(dossier.get("qcm"), sorted(leviers))
    user = ("Dossier calculé par l'outil :\n" + json.dumps(dossier, ensure_ascii=False)[:14000]
            + "\n\nOrdre de priorité issu du QCM de la personne :\n"
            + (json.dumps(classement, ensure_ascii=False) if clean_qcm(dossier.get("qcm")) else "QCM non rempli."))
    text = await P.chat(p, key, model, SYSTEM, user, base_url=base_url, max_tokens=4000)
    for attempt in range(2):
        try:
            return {"synthese": clean(P.extract_json(text), questions, leviers), "classement": classement, "modele": model}
        except (ValueError, TypeError, AttributeError):
            if attempt:
                break
            text = await P.chat(p, key, model, SYSTEM, user + "\n\nTa réponse précédente n'était pas un JSON valide au format "
                                "demandé. Réponds uniquement par l'objet JSON.", base_url=base_url, max_tokens=4000)
    raise P.ProviderError("Le modèle n'a pas produit de synthèse lisible. Réessayez, ou choisissez un autre modèle.")
