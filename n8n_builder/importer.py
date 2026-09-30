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
# Jev se reconnaît à son adresse, à son fournisseur ou à son nom de modèle, où qu'ils soient dans les paramètres
# (adresse en expression, corps JSON, nœud LangChain configuré sur OpenRouter).
JEV_RE = re.compile(r"systemone|alpha/decisions|typesafe|\bjev[-_.](?:latest|preview|\d)", re.I)
# Références à un autre nœud dans une expression n8n : $('Jev 1'), $node["Jev 1"] ; elles ne sont pas des appels.
REF_RE = re.compile(r"\$\(\s*\\?['\"].*?\\?['\"]\s*\)|\$node\[\s*\\?['\"].*?\\?['\"]\s*\]")
VISION_RE = re.compile(r"\bocr\b|vision|image|photo|scan|pdf|pixtral|llava", re.I)
CLASSIFY_RE = re.compile(r"classe|classifi|catégor|categor|réponds? (?:uniquement |seulement )?par|oui ou non|true ou false|"
                         r"vrai ou faux|choisis|parmi|note de \d|score|priorit|urgen|qualifi|valide|conforme|anomal|coh[ée]ren", re.I)
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


def _leads_to_decision(name: str, nexts: dict[str, list[str]], by_name: dict[str, Any]) -> bool:
    """Une condition juste après, ou après un nœud de code qui lit la réponse."""
    for x in nexts.get(name, []):
        k = classify(by_name.get(x) or {})
        if k == "decision" or (k == "code" and any(classify(by_name.get(y) or {}) == "decision" for y in nexts.get(x, []))):
            return True
    return False


def _jev_detail(p: dict[str, Any]) -> str:
    """Adresse, modèle et questions d'un appel à Jev, lus dans les paramètres."""
    text = json.dumps(p, ensure_ascii=False)
    via = "OpenRouter" if "openrouter" in text.lower() else ("TypeSafe" if "typesafe.ai" in text.lower() else "")
    model = re.search(r"(~?typesafe/jev[\w.-]*|jev-(?:latest|preview|[\d.]+))", text)
    qs = re.findall(r"\\?[\"']?([A-Za-z_][\w]*)\\?[\"']?\s*:\s*\{\s*\\?[\"']?type\\?[\"']?\s*:\s*\\?[\"'](noul|choice|score)", text)
    parts = ["appel à Jev" + (f" via {via}" if via else "")]
    if model:
        parts.append(f"modèle {model.group(1)}")
    if qs:
        parts.append("questions : " + ", ".join(f"{q} ({t})" for q, t in list(dict.fromkeys(qs))[:10]))
    elif "/chat/completions" in text:
        parts.append("par /chat/completions (Jev répond d'ordinaire sur /systemone : vérifiez que cet appel fonctionne)")
    return " ; ".join(parts)


def classify(n: dict[str, Any]) -> str:
    t = n.get("type", "")
    p = n.get("parameters") or {}
    url = str(p.get("url", ""))
    if t == "n8n-nodes-base.stickyNote":
        return "note"
    if t == "n8n-nodes-base.webhook" or "trigger" in t.lower():
        return "declencheur"
    calls = t in ("n8n-nodes-base.httpRequest", "n8n-nodes-base.openAi") or "langchain" in t
    if calls and JEV_RE.search(REF_RE.sub("", json.dumps(p, ensure_ascii=False))):
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
    jev_calls: list[str] = []
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
            said = name + " " + item["detail"]
            if VISION_RE.search(said):
                candidats.append(f"« {name} » lit une image ou un document : Jev ne lit que du texte, ce nœud reste en amont "
                                 "(il fournit le texte que Jev jugera).")
            elif short in LLM_CLASSIFY:
                candidats.append(f"« {name} » classe par LLM ({', '.join(cats) or short}) : une question Jev « choix parmi des mots » "
                                 "fait le même tri, sans texte généré.")
            elif short in LLM_EXTRACT:
                candidats.append(f"« {name} » extrait des valeurs par LLM : si elles sont dans le texte, du code les trouve et une "
                                 "question « choix dans une liste » choisit la bonne.")
            elif _leads_to_decision(name, nexts, by_name):
                candidats.append(f"« {name} » produit ce que teste une condition juste après : c'est une décision, "
                                 "Jev la rend en probabilités avec des seuils réglables.")
            elif CLASSIFY_RE.search(said):
                candidats.append(f"« {name} » semble juger ou classer (d'après son nom ou sa consigne) : une question Jev "
                                 "(oui/non, choix parmi des mots ou score) peut le remplacer, sans texte généré.")
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
            item["detail"] = _jev_detail(p)
            jev_calls.append(name)
        elif kind == "action":
            item["detail"] = _txt(p.get("url") or p.get("operation") or p.get("resource") or "", 120)
        groups[kind].append(item)
    qs = jev_questions(wf) if jev_calls or groups["code"] else []
    for it in groups["jev"]:
        mine = [f"{q['id']} ({q['type']})" for q in qs if q.get("noeud") == it["nom"]]
        if mine and "questions :" not in it["detail"]:
            it["detail"] += " ; questions : " + ", ".join(mine)
    if len(groups["declencheur"]) > 1 or any(x["type"] in ("readWriteFile", "readBinaryFile", "writeBinaryFile", "ftp", "googleDrive")
                                             for x in groups["action"]):
        candidats.append(f"Ce workflow fait plus que décider ({len(groups['declencheur'])} déclencheur(s), fichiers, réponses) : "
                         "le builder reprend la partie décision (questions Jev, seuils, règles) ; le reste reste dans n8n.")
    if jev_calls:
        candidats.insert(0, (f"{len(jev_calls)} appels à Jev ({', '.join(jev_calls[:8])}) : " if len(jev_calls) > 1 else
                             f"Un appel à Jev (« {jev_calls[0]} ») : ") +
                         "leurs questions deviennent des questions de la fiche (reprises telles quelles), " +
                         ("posées toutes en un seul appel (moins d'attente et une seule facture), " if len(jev_calls) > 1 else "") +
                         "et le code qui lit leurs réponses devient des seuils et des règles réglables.")
    return {"nom": wf.get("name") or "Workflow sans nom", "noeuds": sum(len(v) for v in groups.values()), **groups,
            "candidats": candidats[:30], "actif": bool(wf.get("active")),
            "questions_jev": [{k: q[k] for k in ("id", "type", "instructions", "criteria", "noeud")} for q in qs]}


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
    if a.get("questions_jev"):
        lines.append("\nQuestions déjà posées à Jev (à reprendre telles quelles) :")
        lines += [f"- {q['id']} ({q['type']}, nœud {q['noeud'] or '?'}) : {_txt(q['instructions'], 200)}" for q in a["questions_jev"]]
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


# Questions Jev écrites dans un workflow fait main -----------------------------------------------------------
# Elles sont souvent déclarées en objets JavaScript dans un nœud de code : { doc_type: { type: 'choice', ... } }.
# On les lit avec un petit lecteur d'objets littéraux qui n'exécute rien : chaînes, nombres, booléens, objets,
# listes. Tout le reste (variable, appel, gabarit `...${x}`) rend la question illisible, et elle est ignorée.

class _Literal:
    def __init__(self, text: str, i: int):
        self.t, self.i = text, i

    def ws(self) -> None:
        t = self.t
        while self.i < len(t):
            if t[self.i].isspace():
                self.i += 1
            elif t.startswith("//", self.i):
                j = t.find("\n", self.i)
                self.i = len(t) if j < 0 else j
            elif t.startswith("/*", self.i):
                j = t.find("*/", self.i)
                self.i = len(t) if j < 0 else j + 2
            else:
                break

    def value(self) -> Any:
        self.ws()
        c = self.t[self.i: self.i + 1]
        if c == "{":
            return self.obj()
        if c == "[":
            return self.arr()
        if c in ("'", '"', "`"):
            return self.string()
        m = re.compile(r"-?\d+(?:\.\d+)?|true\b|false\b|null\b").match(self.t, self.i)
        if not m:
            raise ValueError("expression")
        self.i = m.end()
        return json.loads(m.group(0))

    def string(self) -> str:
        q = self.t[self.i]
        self.i += 1
        out = []
        while self.i < len(self.t):
            c = self.t[self.i]
            if c == "\\":
                nxt = self.t[self.i + 1: self.i + 2]
                out.append({"n": "\n", "t": "\t", "r": ""}.get(nxt, nxt))
                self.i += 2
                continue
            if c == q:
                self.i += 1
                return "".join(out)
            if q == "`" and self.t.startswith("${", self.i):
                raise ValueError("gabarit")
            out.append(c)
            self.i += 1
        raise ValueError("chaîne")

    def key(self) -> str:
        self.ws()
        if self.t[self.i: self.i + 1] in ("'", '"'):
            return self.string()
        m = re.compile(r"[A-Za-z_$][\w$]*").match(self.t, self.i)
        if not m:
            raise ValueError("clé")
        self.i = m.end()
        return m.group(0)

    def obj(self) -> dict[str, Any]:
        self.i += 1
        out: dict[str, Any] = {}
        while True:
            self.ws()
            if self.t[self.i: self.i + 1] == "}":
                self.i += 1
                return out
            k = self.key()
            self.ws()
            if self.t[self.i: self.i + 1] != ":":
                raise ValueError("deux-points")
            self.i += 1
            out[k] = self.value()
            self.ws()
            if self.t[self.i: self.i + 1] == ",":
                self.i += 1

    def arr(self) -> list[Any]:
        self.i += 1
        out: list[Any] = []
        while True:
            self.ws()
            if self.t[self.i: self.i + 1] == "]":
                self.i += 1
                return out
            out.append(self.value())
            self.ws()
            if self.t[self.i: self.i + 1] == ",":
                self.i += 1


Q_START = re.compile(r"""(?:["']?)([A-Za-z_][\w]*)(?:["']?)\s*:\s*\{\s*["']?type["']?\s*:\s*["'](noul|choice|score)["']""")


def _texts(wf: dict[str, Any]) -> list[tuple[str, str]]:
    out = []
    for n in wf.get("nodes") or []:
        p = n.get("parameters") or {}
        for k in ("jsCode", "functionCode", "jsonBody", "body"):
            if isinstance(p.get(k), str):
                out.append((n.get("name", "?"), p[k]))
    return out


def jev_questions(wf: dict[str, Any]) -> list[dict[str, Any]]:
    """Questions Jev lisibles dans le code et les corps de requête, rattachées au nœud qui les envoie si possible."""
    found: dict[str, dict[str, Any]] = {}
    texts = _texts(wf)
    # quel nœud Jev envoie quel corps : body « {{ $json.jev1_body }} » et, dans le code, « jev1_body: ... questions: q1 »
    jev_nodes = {n.get("name"): n for n in wf.get("nodes") or [] if classify(n) == "jev"}
    body_of = {}
    for name, n in jev_nodes.items():
        m = re.search(r"\$json\.([A-Za-z_]\w*)", json.dumps(n.get("parameters") or {}))
        if m:
            body_of[m.group(1)] = name
    for src, text in texts:
        var_of: dict[str, str] = {}
        for m in re.finditer(r"([A-Za-z_]\w*)\s*:\s*JSON\.stringify\(\{[^\n]*?questions\s*:\s*([A-Za-z_]\w*)", text):
            if m.group(1) in body_of:
                var_of[m.group(2)] = body_of[m.group(1)]
        for m in Q_START.finditer(text):
            qid, qtype = m.group(1), m.group(2)
            if qid in found or qid in ("questions", "question"):
                continue
            brace = text.index("{", m.start(0) + len(qid))
            try:
                q = _Literal(text, brace).obj()
            except (ValueError, IndexError):
                continue
            if q.get("type") != qtype or not isinstance(q.get("instructions"), (str, dict)):
                continue
            decl = re.findall(r"(?:const|let|var)\s+([A-Za-z_]\w*)\s*=\s*\{", text[:m.start()])
            node = var_of.get(decl[-1]) if decl else None
            if not node:  # question écrite directement dans le corps d'un appel : « jev7_body: ... questions: { ... } »
                head = text[:m.start()].rsplit("\n", 1)[-1]
                b = re.search(r"([A-Za-z_]\w*)\s*:\s*JSON\.stringify", head)
                node = body_of.get(b.group(1)) if b else (src if src in jev_nodes else None)
            found[qid] = {"id": qid, "type": qtype, "instructions": q.get("instructions"), "criteria": q.get("criteria"),
                          "noeud": node, "source": src}
    return list(found.values())[:60]


def _slug_id(v: str) -> str:
    s = re.sub(r"[^a-z0-9_]+", "_", v.lower()).strip("_")
    return (s if s and s[0].isalpha() else "q_" + s)[:48] or "question"


def fiche_from_questions(name: str, qs: list[dict[str, Any]]) -> dict[str, Any]:
    """Fiche du Labo Jev qui reprend les questions telles quelles, verrouillées comme réglées par l'humain.
    Résultats de départ : traiter, ou revoir quand Jev hésite ; à affiner ensuite."""
    questions, regles = [], []
    for q in qs:
        instr = q["instructions"] if isinstance(q["instructions"], str) else json.dumps(q["instructions"], ensure_ascii=False)
        item: dict[str, Any] = {"id": _slug_id(q["id"]), "type": q["type"], "question": instr}
        crit = q.get("criteria")
        if q["type"] == "noul":
            item.update(seuil_oui=70, seuil_non=30)
            if isinstance(crit, dict):
                item.update(oui_signifie=str(crit.get("true") or ""), non_signifie=str(crit.get("false") or ""))
            regles.append({"si": [{"question": item["id"], "op": "est", "valeur": "a_verifier"}], "alors": "a_revoir",
                           "pourquoi": f"Jev hésite sur {item['id']} : un humain vérifie."})
        elif q["type"] == "choice":
            opts = crit if isinstance(crit, dict) else {str(x): "" for x in crit or []}
            item.update(options=[{"mot": _slug_id(str(k)), "description": str(v or "")} for k, v in opts.items()][:255],
                        confiance_min=60, marge=0)
            regles.append({"si": [{"question": item["id"], "op": "est", "valeur": "incertain"}], "alors": "a_revoir",
                           "pourquoi": f"Confiance insuffisante sur {item['id']} : un humain vérifie."})
        else:
            item.update(niveaux=[str(x) for x in (crit if isinstance(crit, list) else ["Bas", "Moyen", "Haut"])][:10], confiance_min=50)
            regles.append({"si": [{"question": item["id"], "op": "est", "valeur": "incertain"}], "alors": "a_revoir",
                           "pourquoi": f"Confiance insuffisante sur {item['id']} : un humain vérifie."})
        questions.append(item)
    return {
        "name": name, "objectif": f"Décisions Jev reprises du workflow n8n « {name} ».",
        "entree": {"mode": "json", "field": "message", "fields": []}, "exemple": {},
        "questions": questions,
        "resultats": [{"id": "traiter", "label": "Traiter automatiquement", "consigne": ""},
                      {"id": "a_revoir", "label": "À revoir par un humain", "consigne": "Vérifier les réponses de Jev avant de continuer."}],
        "regles": regles, "par_defaut": "traiter", "si_jev_indisponible": "a_revoir",
        "jev_fournisseur": "openrouter", "modele": "typesafe/jev-1.13", "tests": [],
        "ia": {"questions": {"origine": "humain", "pourquoi": f"Questions reprises telles quelles du workflow n8n « {name} »."}},
    }
