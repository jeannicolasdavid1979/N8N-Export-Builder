"""Specification d'un workflow deterministe, et sa validation.

Une specification decrit tout le workflow : declencheur, preparation des donnees, questions posees a Jev,
regles de decision, aiguillage et LLM de secours. Le generateur en tire un workflow n8n ; l'interface
l'edite ; les modeles de la bibliotheque en sont des exemples remplis.

Jev (TypeSafe AI) ne produit pas de texte : il rend des valeurs typees et des probabilites. Trois types
de questions : noul (oui/non, probabilite), choice (une option parmi un ensemble), score (niveaux ordonnes).
"""

from __future__ import annotations

import copy
import re
from typing import Any

JEV_URL = "https://api.typesafe.ai/v1/systemone"
JEV_MODELS = ("jev-latest", "jev-preview", "jev-1.13.0")

ID_RE = re.compile(r"^[a-z][a-z0-9_]{0,47}$")
ROUTE_RE = re.compile(r"^[a-z][a-z0-9_]{0,39}$")
PATH_RE = re.compile(r"^[a-z0-9][a-z0-9_-]{0,79}$")
OPS = (">=", ">", "<=", "<", "==", "!=", "in", "not_in", "exists", "missing")
TRIGGERS = ("webhook", "schedule", "manual")
STATE_MODES = ("field", "fields", "json")
DECISION_MODES = ("choice", "rules", "none")
EVERY = ("minutes", "hours", "days")


class SpecError(ValueError):
    def __init__(self, errors: list[str]):
        super().__init__("; ".join(errors))
        self.errors = errors


def slug(text: str, maxlen: int = 60) -> str:
    table = str.maketrans("àâäáãåçéèêëíìîïñóòôöõúùûüýÿœæ", "aaaaaaceeeeiiiinooooouuuuyyoa")
    s = re.sub(r"[^a-z0-9]+", "-", text.lower().translate(table)).strip("-")
    return (s or "workflow")[:maxlen].strip("-")


def _str(v: Any, default: str = "") -> str:
    return v.strip() if isinstance(v, str) else default


def _num(v: Any, default: float) -> float:
    try:
        return float(v)
    except (TypeError, ValueError):
        return default


def _text_or_struct(v: Any) -> bool:
    """Jev accepte une chaine, un objet ou un tableau pour instructions et criteres."""
    if isinstance(v, str):
        return bool(v.strip())
    return isinstance(v, (dict, list)) and bool(v)


def validate_questions(questions: Any, errors: list[str]) -> dict[str, Any]:
    if questions in (None, ""):
        return {}
    if not isinstance(questions, dict):
        errors.append("Les questions doivent former un objet {identifiant: question}.")
        return {}
    out: dict[str, Any] = {}
    for qid, q in questions.items():
        where = f"Question « {qid} »"
        if not ID_RE.match(str(qid)):
            errors.append(f"{where} : identifiant invalide (minuscules, chiffres, _ ; commence par une lettre).")
            continue
        if not isinstance(q, dict):
            errors.append(f"{where} : doit être un objet.")
            continue
        qtype = q.get("type")
        if qtype not in ("noul", "choice", "score"):
            errors.append(f"{where} : type attendu noul, choice ou score.")
            continue
        if not _text_or_struct(q.get("instructions")):
            errors.append(f"{where} : instructions manquantes.")
            continue
        item: dict[str, Any] = {"type": qtype, "instructions": q["instructions"]}
        crit = q.get("criteria")
        if qtype == "choice":
            if not isinstance(crit, dict) or len(crit) < 2:
                errors.append(f"{where} : un choice demande au moins deux options.")
                continue
            if len(crit) > 255:
                errors.append(f"{where} : 255 options au plus.")
                continue
            bad = [k for k in crit if not ROUTE_RE.match(str(k))]
            if bad:
                errors.append(f"{where} : options invalides {bad} (minuscules, chiffres, _).")
                continue
            item["criteria"] = {k: (v if v not in ("",) else None) for k, v in crit.items()}
        elif qtype == "score":
            if not isinstance(crit, list) or not 2 <= len(crit) <= 10 or not all(_text_or_struct(c) for c in crit):
                errors.append(f"{where} : un score demande de 2 à 10 niveaux décrits, du plus bas au plus haut.")
                continue
            item["criteria"] = crit
        elif crit:
            if not isinstance(crit, dict) or set(crit) - {"true", "false"}:
                errors.append(f"{where} : les critères d'un noul sont {{\"true\": ..., \"false\": ...}}.")
                continue
            clean = {k: v for k, v in crit.items() if _text_or_struct(v)}
            if clean:
                item["criteria"] = clean
        out[qid] = item
    return out


def question_vars(questions: dict[str, Any]) -> dict[str, str]:
    """Variables que la decision expose pour chaque question, avec leur nature."""
    v: dict[str, str] = {}
    for qid, q in questions.items():
        if q["type"] == "noul":
            v[qid] = "probabilité du oui (0 à 1)"
        elif q["type"] == "choice":
            v[qid] = "option retenue"
            v[qid + "_confiance"] = "confiance (0 à 1)"
        else:
            v[qid] = f"score (0 à {len(q['criteria']) - 1})"
            v[qid + "_norme"] = "score ramené de 0 à 1"
            v[qid + "_confiance"] = "confiance (0 à 1)"
    return v


def routes_of(spec: dict[str, Any]) -> list[str]:
    d = spec["decision"]
    if d["mode"] == "choice":
        opts = list(spec["questions"][d["question"]]["criteria"])
        return opts + ([d["review_route"]] if d["review_route"] not in opts else [])
    return list(d["routes"])


def validate(raw: Any) -> dict[str, Any]:
    """Controle et normalise une specification. Leve SpecError avec la liste des problemes."""
    errors: list[str] = []
    if not isinstance(raw, dict):
        raise SpecError(["La spécification doit être un objet JSON."])
    spec = copy.deepcopy(raw)
    s: dict[str, Any] = {}

    s["name"] = _str(spec.get("name"))[:120]
    if not s["name"]:
        errors.append("Nom du workflow manquant.")
    s["description"] = _str(spec.get("description"))[:2000]

    t = spec.get("trigger") or {}
    ttype = t.get("type", "webhook")
    if ttype not in TRIGGERS:
        errors.append("Déclencheur attendu : webhook, schedule ou manual.")
        ttype = "webhook"
    trig: dict[str, Any] = {"type": ttype}
    if ttype == "webhook":
        trig["path"] = _str(t.get("path")) or slug(s["name"] or "workflow")
        if not PATH_RE.match(trig["path"]):
            errors.append("Chemin du webhook invalide (minuscules, chiffres, - et _).")
        trig["auth"] = t.get("auth", "none") if t.get("auth") in ("none", "header") else "none"
    elif ttype == "schedule":
        trig["every"] = t.get("every", "hours") if t.get("every") in EVERY else "hours"
        trig["interval"] = max(1, min(int(_num(t.get("interval"), 1)), 1000))
        trig["at_hour"] = max(0, min(int(_num(t.get("at_hour"), 8)), 23))
    s["trigger"] = trig

    src = spec.get("source")
    if src:
        if not isinstance(src, dict) or src.get("type") not in ("rss", "http") or not _str(src.get("url")).startswith(("http://", "https://")):
            errors.append("Source : type rss ou http avec une adresse http(s).")
            src = None
        else:
            src = {"type": src["type"], "url": _str(src["url"])}
    s["source"] = src or None

    st = spec.get("state") or {"mode": "field", "field": "message"}
    mode = st.get("mode", "field")
    if mode not in STATE_MODES:
        errors.append("État : mode field, fields ou json.")
        mode = "json"
    state: dict[str, Any] = {"mode": mode}
    if mode == "field":
        state["field"] = _str(st.get("field")) or "message"
    elif mode == "fields":
        fields = [f for f in (st.get("fields") or []) if isinstance(f, str) and f.strip()]
        if not fields:
            errors.append("État : indiquer au moins un champ.")
        state["fields"] = [f.strip() for f in fields]
    s["state"] = state
    s["prepare_js"] = spec.get("prepare_js") or ""
    if not isinstance(s["prepare_js"], str):
        errors.append("prepare_js doit être du texte (code JavaScript).")
        s["prepare_js"] = ""

    s["model"] = _str(spec.get("model")) or "jev-latest"
    if not re.match(r"^[a-z0-9][a-z0-9._-]{0,60}$", s["model"]):
        errors.append("Modèle Jev invalide.")
    s["jev_url"] = _str(spec.get("jev_url")) or JEV_URL
    if not s["jev_url"].startswith(("http://", "https://")):
        errors.append("Adresse de Jev invalide.")

    s["questions"] = validate_questions(spec.get("questions"), errors)

    d = spec.get("decision") or {}
    dmode = d.get("mode") or ("choice" if len(s["questions"]) == 1 else "none")
    if dmode not in DECISION_MODES:
        errors.append("Décision : mode choice, rules ou none.")
        dmode = "none"
    dec: dict[str, Any] = {"mode": dmode, "post_js": d.get("post_js") or ""}
    if not isinstance(dec["post_js"], str):
        errors.append("post_js doit être du texte (code JavaScript).")
        dec["post_js"] = ""
    comp = d.get("composite")
    if comp:
        weights = comp.get("weights") if isinstance(comp, dict) else None
        name = _str(comp.get("name")) if isinstance(comp, dict) else ""
        if not ID_RE.match(name) or not isinstance(weights, dict) or not weights:
            errors.append("Score composite : un nom et des poids {variable: poids}.")
        else:
            dec["composite"] = {"name": name, "weights": {k: _num(w, 0) for k, w in weights.items()}}
    if dmode == "choice":
        q = d.get("question") or next((k for k, v in s["questions"].items() if v["type"] == "choice"), None)
        if not q or q not in s["questions"] or s["questions"][q]["type"] != "choice":
            errors.append("Décision par choice : indiquer une question de type choice.")
        dec["question"] = q
        dec["min_confidence"] = max(0.0, min(_num(d.get("min_confidence"), 0.6), 1.0))
        dec["review_route"] = _str(d.get("review_route")) or "a_revoir"
        if not ROUTE_RE.match(dec["review_route"]):
            errors.append("Route de revue invalide.")
    elif dmode == "rules":
        routes = [r for r in (d.get("routes") or []) if isinstance(r, str)]
        rules = d.get("rules") or []
        dec["default_route"] = _str(d.get("default_route")) or (routes[-1] if routes else "")
        for r in rules:
            if isinstance(r, dict) and isinstance(r.get("route"), str) and not r["route"].startswith("=") and r["route"] not in routes:
                routes.append(r["route"])
        if dec["default_route"] and dec["default_route"] not in routes:
            routes.append(dec["default_route"])
        if not routes:
            errors.append("Décision par règles : au moins une route.")
        bad = [r for r in routes if not ROUTE_RE.match(r)]
        if bad:
            errors.append(f"Routes invalides {bad} (minuscules, chiffres, _).")
        clean_rules = []
        for i, r in enumerate(rules, 1):
            if not isinstance(r, dict) or not isinstance(r.get("route"), str):
                errors.append(f"Règle {i} : route manquante.")
                continue
            conds = r.get("when") or []
            if not isinstance(conds, list) or not conds:
                errors.append(f"Règle {i} : au moins une condition.")
                continue
            cc = []
            for c in conds:
                if not isinstance(c, dict) or not _str(c.get("field")) or c.get("op") not in OPS:
                    errors.append(f"Règle {i} : condition invalide (champ, opérateur parmi {', '.join(OPS)}).")
                    continue
                cc.append({"field": c["field"].strip(), "op": c["op"], "value": c.get("value")})
            clean_rules.append({"when": cc, "route": r["route"], "label": _str(r.get("label"))})
        dec["rules"] = clean_rules
        dec["routes"] = routes
    else:
        dec["default_route"] = _str(d.get("default_route")) or "sortie"
        dec["routes"] = [dec["default_route"]]
    s["decision"] = dec

    if not errors:
        routes = routes_of(s)
        er = _str(d.get("error_route"))
        if dmode == "choice":
            dec["error_route"] = dec["review_route"]
        elif er and er in routes:
            dec["error_route"] = er
        elif s["questions"]:
            # Jev en panne ne doit jamais tomber dans une route d'action : revue humaine par defaut.
            if "a_revoir" not in dec["routes"]:
                dec["routes"].append("a_revoir")
            dec["error_route"] = "a_revoir"
        else:
            dec["error_route"] = "a_revoir" if "a_revoir" in routes else dec["default_route"]

    llm = spec.get("llm")
    if llm:
        if not isinstance(llm, dict):
            errors.append("LLM de secours : objet attendu.")
        else:
            l = {"route": _str(llm.get("route")), "provider": _str(llm.get("provider")) or "openrouter",
                 "model": _str(llm.get("model")), "system": _str(llm.get("system")) or
                 "Tu traites les cas que les règles déterministes n'ont pas su trancher. Réponds brièvement, en français.",
                 "base_url": _str(llm.get("base_url"))}
            if not l["model"]:
                errors.append("LLM de secours : choisir un modèle.")
            if not errors and l["route"] not in routes_of(s):
                errors.append(f"LLM de secours : la route « {l['route']} » n'existe pas.")
            s["llm"] = l
    else:
        s["llm"] = None

    sample = spec.get("sample")
    s["sample"] = sample if isinstance(sample, (dict, list)) else {}
    hub = spec.get("hub") if isinstance(spec.get("hub"), dict) else {}
    s["hub"] = {k: _str(hub.get(k)) for k in ("playlist", "agent", "allege") if _str(hub.get(k))}
    s["tags"] = [t for t in (spec.get("tags") or []) if isinstance(t, str)][:10]

    if not s["questions"] and dmode == "choice":
        errors.append("Décision par choice sans question Jev.")
    if errors:
        raise SpecError(errors)
    return s
