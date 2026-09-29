"""Import de workflows n8n existants.

Deux cas :
- un workflow envoyé par le builder porte sa carte d'origine (note « Source du builder ») : on retrouve la
  spécification, et la fiche du Labo Jev s'il y en avait une, puis on signale ce qui a été modifié dans n8n ;
- tout autre workflow est analysé nœud par nœud (déclencheurs, LLM, décisions, code, actions) : ce qui peut
  devenir une question Jev est repéré, et le résumé sert à l'IA pour proposer une fiche du Labo Jev.
"""
from __future__ import annotations

import json
import re
from typing import Any

from . import generator, jevlab
from .spec import SpecError, validate

LLM_HOSTS = ("openai.com", "anthropic.com", "openrouter.ai", "mistral.ai", "generativelanguage.googleapis.com",
             "groq.com", "deepseek.com", "x.ai", "together.xyz", "cerebras.ai", "ollama")
JEV_HINT = "systemone"
DECISION_TYPES = ("n8n-nodes-base.if", "n8n-nodes-base.switch", "n8n-nodes-base.filter")
CODE_TYPES = ("n8n-nodes-base.code", "n8n-nodes-base.function", "n8n-nodes-base.functionItem", "n8n-nodes-base.set")
LLM_CLASSIFY = ("textClassifier", "sentimentAnalysis")
LLM_EXTRACT = ("informationExtractor",)


class ImportErreur(ValueError):
    pass


def parse(raw: Any) -> list[dict[str, Any]]:
    """Accepte un workflow, une liste de workflows, la réponse de l'API n8n ({data: [...]}) ou le texte JSON."""
    if isinstance(raw, str):
        try:
            raw = json.loads(raw)
        except ValueError as e:
            raise ImportErreur("Ce n'est pas du JSON : exportez le workflow depuis n8n (menu ⋯, Télécharger).") from e
    if isinstance(raw, dict) and isinstance(raw.get("data"), list):
        raw = raw["data"]
    items = raw if isinstance(raw, list) else [raw]
    out = [w for w in items if isinstance(w, dict) and isinstance(w.get("nodes"), list)]
    if not out:
        raise ImportErreur("Aucun workflow trouvé : le fichier doit contenir des nœuds n8n (champ « nodes »).")
    return out[:50]


def _short(t: str) -> str:
    return t.split(".")[-1]


def _txt(v: Any, limit: int = 300) -> str:
    s = v if isinstance(v, str) else json.dumps(v, ensure_ascii=False)
    s = re.sub(r"\s+", " ", s or "").strip()
    return s[:limit] + ("…" if len(s) > limit else "")


def has_origin(wf: dict[str, Any]) -> bool:
    return any(n.get("type") == "n8n-nodes-base.stickyNote" and generator.ORIGIN_MARK in str((n.get("parameters") or {}).get("content", ""))
               for n in wf.get("nodes") or [])


def origin(wf: dict[str, Any]) -> dict[str, Any] | None:
    """Spécification (et fiche) de la carte d'origine, validées, et liste des modifications faites dans n8n."""
    for n in wf.get("nodes") or []:
        content = str((n.get("parameters") or {}).get("content", ""))
        if n.get("type") != "n8n-nodes-base.stickyNote" or generator.ORIGIN_MARK not in content:
            continue
        m = re.search(r"```json\s*(\{.*\})\s*```", content, re.S)
        if not m:
            return {"erreur": "Carte d'origine illisible : elle a été modifiée dans n8n."}
        try:
            data = json.loads(m.group(1))
            spec = validate(data.get("spec"))
        except (ValueError, SpecError) as e:
            return {"erreur": f"Carte d'origine illisible ou incompatible : {str(e)[:200]}"}
        fiche = None
        if isinstance(data.get("fiche"), dict):
            try:
                fiche = jevlab.validate_fiche(data["fiche"])
            except jevlab.FicheError:
                fiche = None
        return {"spec": spec, "fiche": fiche, "modifications": modifications(wf, spec)}
    return None


def _fingerprint(n: dict[str, Any]) -> str:
    p = n.get("parameters") or {}
    keep = {k: p.get(k) for k in ("jsCode", "url", "jsonBody", "rules", "path") if k in p}
    return n.get("type", "") + json.dumps(keep, sort_keys=True, ensure_ascii=False)


def modifications(wf: dict[str, Any], spec: dict[str, Any]) -> list[str]:
    """Ce qui diffère entre le workflow reçu et celui que le builder génère : nœuds ajoutés, retirés, code changé.
    On ne compare que ce qui compte (code, adresses, corps, règles), pas les positions ni les valeurs par défaut."""
    ref = {n["name"]: n for n in generator.build(spec)["nodes"] if n["type"] != "n8n-nodes-base.stickyNote"}
    got = {n.get("name"): n for n in wf.get("nodes") or [] if n.get("type") != "n8n-nodes-base.stickyNote"}
    out = [f"Nœud ajouté dans n8n : « {k} » ({_short(got[k].get('type', ''))})" for k in got if k not in ref]
    out += [f"Nœud retiré dans n8n : « {k} »" for k in ref if k not in got]
    out += [f"Nœud modifié dans n8n : « {k} »" for k in ref if k in got and _fingerprint(ref[k]) != _fingerprint(got[k])]
    return out


def _llm_prompt(p: dict[str, Any]) -> str:
    parts = []
    for k in ("text", "prompt", "inputText", "systemMessage"):
        if isinstance(p.get(k), str):
            parts.append(p[k])
    opts = p.get("options") or {}
    if isinstance(opts, dict) and isinstance(opts.get("systemMessage"), str):
        parts.append(opts["systemMessage"])
    msgs = ((p.get("messages") or {}).get("values") if isinstance(p.get("messages"), dict) else None) or []
    parts += [m.get("content", "") for m in msgs if isinstance(m, dict)]
    body = p.get("jsonBody") or p.get("body")
    if isinstance(body, str) and "messages" in body:
        parts.append(body)
    return _txt(" | ".join(x for x in parts if x), 400)


def _categories(p: dict[str, Any]) -> list[str]:
    cats = ((p.get("categories") or {}).get("categories") if isinstance(p.get("categories"), dict) else None) or []
    return [_txt(f"{c.get('category')}" + (f" ({c.get('description')})" if c.get("description") else ""), 120)
            for c in cats if isinstance(c, dict) and c.get("category")]


def classify(n: dict[str, Any]) -> str:
    t = n.get("type", "")
    p = n.get("parameters") or {}
    url = str(p.get("url", ""))
    if t == "n8n-nodes-base.stickyNote":
        return "note"
    if t == "n8n-nodes-base.webhook" or "trigger" in t.lower():
        return "declencheur"
    if t == "n8n-nodes-base.httpRequest" and JEV_HINT in url:
        return "jev"
    if "langchain" in t or t == "n8n-nodes-base.openAi" or (t == "n8n-nodes-base.httpRequest" and any(h in url for h in LLM_HOSTS)):
        return "llm"
    if t in DECISION_TYPES:
        return "decision"
    if t in CODE_TYPES:
        return "code"
    return "action"


def analyse(wf: dict[str, Any]) -> dict[str, Any]:
    nodes = [n for n in wf.get("nodes") or [] if isinstance(n, dict)]
    conns = wf.get("connections") or {}
    nexts: dict[str, list[str]] = {}
    for src, outs in conns.items() if isinstance(conns, dict) else []:
        for branch in (outs or {}).get("main") or []:
            nexts.setdefault(src, []).extend(l.get("node") for l in branch or [] if isinstance(l, dict))
    by_name = {n.get("name"): n for n in nodes}
    groups: dict[str, list[dict[str, Any]]] = {k: [] for k in ("declencheur", "llm", "jev", "decision", "code", "action")}
    candidats: list[str] = []
    for n in nodes:
        kind = classify(n)
        if kind == "note":
            continue
        name, t, p = n.get("name", "?"), n.get("type", ""), n.get("parameters") or {}
        item: dict[str, Any] = {"nom": name, "type": _short(t)}
        if kind == "declencheur" and p.get("path"):
            item["detail"] = f"webhook /{p['path']}"
        elif kind == "llm":
            item["detail"] = _llm_prompt(p) or (f"modèle {_txt(p.get('model'), 60)}" if p.get("model") else "")
            short = _short(t)
            cats = _categories(p)
            if short in LLM_CLASSIFY:
                candidats.append(f"« {name} » classe par LLM ({', '.join(cats) or short}) : une question Jev « choix parmi des mots » "
                                 "fait le même tri, sans texte généré.")
            elif short in LLM_EXTRACT:
                candidats.append(f"« {name} » extrait des valeurs par LLM : si elles sont dans le texte, du code les trouve et une "
                                 "question « choix dans une liste » choisit la bonne.")
            elif any(classify(by_name.get(x) or {}) == "decision" for x in nexts.get(name, [])):
                candidats.append(f"« {name} » produit ce que teste une condition juste après : c'est une décision, "
                                 "Jev la rend en probabilités avec des seuils réglables.")
            else:
                candidats.append(f"« {name} » rédige ou transforme du texte : il reste un LLM (LLM de route dans le builder).")
            if cats:
                item["categories"] = cats
        elif kind == "decision":
            item["detail"] = _txt(p.get("conditions") or p.get("rules") or p, 300)
            candidats.append(f"« {name} » est déjà une règle déterministe : elle devient une règle de la fiche, ou du code de préparation.")
        elif kind == "code":
            item["detail"] = _txt(p.get("jsCode") or p.get("functionCode") or p.get("assignments") or p.get("values") or "", 300)
        elif kind == "jev":
            item["detail"] = "appel à Jev"
        elif kind == "action":
            item["detail"] = _txt(p.get("url") or p.get("operation") or p.get("resource") or "", 120)
        groups[kind].append(item)
    return {"nom": wf.get("name") or "Workflow sans nom", "noeuds": sum(len(v) for v in groups.values()), **groups,
            "candidats": candidats[:30], "actif": bool(wf.get("active"))}


def summary(a: dict[str, Any]) -> str:
    """Résumé compact d'un workflow, donné à l'IA comme contexte (données, pas consignes)."""
    lines = [f"Workflow n8n « {a['nom']} » : {a['noeuds']} nœuds."]
    labels = {"declencheur": "Déclencheurs", "llm": "Nœuds LLM", "jev": "Appels à Jev", "decision": "Décisions (IF, Switch, Filtre)",
              "code": "Code et transformations", "action": "Actions"}
    for k, label in labels.items():
        if a[k]:
            lines.append(f"\n{label} :")
            for it in a[k][:25]:
                extra = f" ; catégories : {', '.join(it['categories'])}" if it.get("categories") else ""
                lines.append(f"- {it['nom']} ({it['type']}) : {it.get('detail', '')}{extra}")
    if a["candidats"]:
        lines.append("\nPistes repérées :")
        lines += [f"- {c}" for c in a["candidats"]]
    return "\n".join(lines)[:6000]


def entry(wf: dict[str, Any], wid: str | None = None) -> dict[str, Any]:
    o = origin(wf) or reconstruct(wf)
    return {"id": wid or (str(wf["id"]) if wf.get("id") else None), "nom": wf.get("name") or "Workflow sans nom",
            "origine": o, "analyse": analyse(wf)}


CONVERT_BRIEF = ("Transformer ce workflow n8n existant en automate Jev déterministe. Reprendre ses décisions (classements, tris, "
                 "conditions) sous forme de questions Jev, de verdicts et de règles ; les résultats correspondent à ses branches "
                 "de sortie ; garder toujours une voie de revue humaine. Ce qui rédige du texte reste un LLM de route. "
                 "Proposer des cas de test réalistes, avec le résultat attendu.")


# Workflows envoyés par une version du builder antérieure à la carte d'origine -------------------------------
# Le code généré contient en clair le modèle, les questions et la configuration de l'aiguillage : on reconstruit
# la spécification, puis on la régénère pour vérifier que le code obtenu est identique.

def _json_after(code: str, head: str, stop: str) -> Any:
    m = re.search(re.escape(head) + r"([\s\S]*?);\n" + stop, code)
    return json.loads(m.group(1)) if m else None


def _dedent_block(code: str, start: str, end: str) -> str:
    i = code.find(start)
    if i < 0:
        return ""
    j = code.find(end, i + len(start))
    block = code[i + len(start): j] if j >= 0 else ""
    return "\n".join(line[4:] if line.startswith("    ") else line for line in block.splitlines()).strip("\n")


def _llm_from(node: dict[str, Any], route: str | None) -> dict[str, Any] | None:
    from . import providers as P
    p = node.get("parameters") or {}
    body, url = str(p.get("jsonBody") or ""), str(p.get("url") or "")
    mm = re.search(r"model: (\"(?:[^\"\\]|\\.)*\")", body)
    ms = re.search(r"role: 'system', content: (\"(?:[^\"\\]|\\.)*\")", body)
    if not mm:
        return None
    base = url.removesuffix("/chat/completions").rstrip("/")
    pid, base_url = None, ""
    for prov in P.PROVIDERS:
        if prov.kind == "chat" and prov.base_url.rstrip("/") == base:
            pid = prov.id
            break
    if not pid:
        pid = "ollama_local"
        base_url = "" if base == "http://host.docker.internal:11434/v1" else base
    out = {"provider": pid, "model": json.loads(mm.group(1)), "system": json.loads(ms.group(1)) if ms else "", "base_url": base_url}
    if route is not None:
        out["route"] = route
    return out


def reconstruct(wf: dict[str, Any]) -> dict[str, Any] | None:
    """Spécification d'un workflow généré par une ancienne version du builder, ou None si ce n'en est pas un."""
    nodes = {n.get("name"): n for n in wf.get("nodes") or [] if isinstance(n, dict)}
    prep = str(((nodes.get(generator.N_PREP) or {}).get("parameters") or {}).get("jsCode") or "")
    dec = str(((nodes.get(generator.N_DECIDE) or {}).get("parameters") or {}).get("jsCode") or "")
    if "Généré par N8N Export Builder" not in prep or "const CFG = " not in dec:
        return None
    try:
        model = _json_after(prep, "const MODEL = ", "")
        questions = _json_after(prep, "const QUESTIONS = ", r"\nfunction prepare")
        cfg = _json_after(dec, "const CFG = ", r"\s*function flatten")
    except ValueError:
        return {"erreur": "Code du builder illisible : il a été modifié dans n8n."}
    if cfg is None or questions is None:
        return {"erreur": "Code du builder illisible : il a été modifié dans n8n."}
    sm = re.search(r"let state = (.*);\n", prep)
    expr = sm.group(1) if sm else "input"
    if expr == "input":
        state = {"mode": "json"}
    elif expr.startswith("{"):
        state = {"mode": "fields", "fields": [json.loads(x) for x in re.findall(r"(\"(?:[^\"\\]|\\.)*\"): input\[", expr)]}
    else:
        fm = re.match(r"input\[(\".*\")\]$", expr)
        state = {"mode": "field", "field": json.loads(fm.group(1)) if fm else "message"}
    trig_node = nodes.get(generator.N_TRIGGER) or {}
    tp = trig_node.get("parameters") or {}
    ttype = trig_node.get("type", "")
    if ttype.endswith(".webhook"):
        trigger = {"type": "webhook", "path": tp.get("path") or "", "auth": "header" if tp.get("authentication") == "headerAuth" else "none"}
    elif ttype.endswith(".scheduleTrigger"):
        rule = ((tp.get("rule") or {}).get("interval") or [{}])[0]
        every = rule.get("field", "hours")
        trigger = {"type": "schedule", "every": every, "interval": rule.get(f"{every}Interval", 1), "at_hour": rule.get("triggerAtHour", 8)}
    else:
        trigger = {"type": "manual"}
    source = None
    src = nodes.get(generator.N_SOURCE)
    if src:
        source = {"type": "rss" if src.get("type", "").endswith("rssFeedRead") else "http", "url": (src.get("parameters") or {}).get("url", "")}
    jev_node = nodes.get(generator.N_JEV)
    jev_url = str((jev_node.get("parameters") or {}).get("url") or "") if jev_node else ""
    # LLM de route : le nœud « Route : x » qui le précède donne la route
    preds: dict[str, list[str]] = {}
    for a, outs in (wf.get("connections") or {}).items():
        for branch in (outs or {}).get("main") or []:
            for link in branch or []:
                preds.setdefault(link.get("node"), []).append(a)
    llms = []
    for name, n in nodes.items():
        if name == generator.N_LLM or str(name).startswith("LLM : "):
            route = next((p[len("Route : "):] for p in preds.get(name, []) if str(p).startswith("Route : ")), None)
            lm = _llm_from(n, route)
            if lm and route:
                llms.append(lm)
    entree = _llm_from(nodes[generator.N_LLM_IN], None) if generator.N_LLM_IN in nodes else None
    note = str(((nodes.get(generator.N_NOTE) or {}).get("parameters") or {}).get("content") or "")
    lines = note.splitlines()
    description = lines[1] if len(lines) > 1 and lines[1] and not lines[1].startswith("**") else ""
    decision = {k: cfg.get(k) for k in ("mode", "routes", "error_route", "default_route", "question", "min_confidence",
                                        "review_route", "rules", "composite", "verdicts") if cfg.get(k) not in (None, [], {})}
    decision["post_js"] = _dedent_block(dec, "(function (ctx, vars, answers, input) {\n", "\n  })(ctx, ctx.vars")
    raw = {"name": wf.get("name") or "Workflow importé", "description": description, "trigger": trigger, "state": state,
           "model": model, "questions": questions, "decision": decision, "source": source,
           "prepare_js": _dedent_block(prep, "const override = (function (input, vars, questions) {\n", "\n  })(input, vars, questions);"),
           "llms": llms, "entree_llm": entree, "tags": ["importe"]}
    if jev_url:
        raw["jev_url"] = jev_url
        raw["jev_provider"] = "openrouter" if "openrouter.ai" in jev_url else "typesafe"
    try:
        spec = validate(raw)
    except SpecError as e:
        return {"erreur": f"Reconstruction impossible : {str(e)[:200]}"}
    return {"spec": spec, "fiche": None, "reconstruit": True, "modifications": modifications(wf, spec)}
