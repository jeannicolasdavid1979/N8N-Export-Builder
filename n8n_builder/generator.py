"""Specification validee vers workflow n8n importable.

Chaine produite :
  Declencheur -> [Source] -> [Donnees exemple] -> Preparer les donnees -> [Jev (TypeSafe)]
  -> Decision deterministe -> Aiguillage -> Route : x -> [LLM de secours -> Fusion LLM] -> [Repondre]

Seuls des noeuds du coeur de n8n sont utilises (Code, HTTP Request, Switch, Webhook, Schedule,
Respond to Webhook) : aucun noeud communautaire a installer. Jev est appele par HTTP, le LLM de secours
par l'API compatible OpenAI du fournisseur choisi. Toute la logique de decision est dans un noeud Code
lisible, sans appel a un modele : a entree egale, sortie egale.
"""

from __future__ import annotations

import json
import uuid
from typing import Any

from .providers import BY_ID
from .spec import question_vars, routes_of, slug, uses_jev

NS = uuid.UUID("6f1c9a52-8b0e-4d59-9a57-2f3e1c0b7d41")

N_TRIGGER = "Déclencheur"
N_SOURCE = "Source"
N_SAMPLE = "Données exemple"
N_PREP = "Préparer les données"
N_JEV = "Jev (TypeSafe)"
N_DECIDE = "Décision déterministe"
N_SWITCH = "Aiguillage"
N_LLM = "LLM de secours"
N_MERGE = "Fusion LLM"
N_RESPOND = "Répondre"
N_NOTE = "Note"
N_LLM_IN = "LLM d'entrée (agent)"
N_STATE_IN = "État depuis le LLM"

JS_HEADER = "// Généré par N8N Export Builder. Modifiable : la logique est lisible et sans appel à un modèle.\n"


def _id(wf: str, name: str) -> str:
    return str(uuid.uuid5(NS, f"{wf}/{name}"))


def js(v: Any) -> str:
    return json.dumps(v, ensure_ascii=False, indent=2)


def _indent(code: str, n: int = 4) -> str:
    pad = " " * n
    return "\n".join(pad + line if line.strip() else line for line in code.strip("\n").splitlines())


def prep_code(s: dict[str, Any]) -> str:
    st = s["state"]
    if st["mode"] == "field":
        state_expr = f"input[{js(st['field'])}]"
    elif st["mode"] == "fields":
        state_expr = "{ " + ", ".join(f"{js(f)}: input[{js(f)}]" for f in st["fields"]) + " }"
    else:
        state_expr = "input"
    user = s["prepare_js"].strip()
    user_block = (
        "  // Préparation propre à ce workflow : calculs déterministes, variables pour les règles.\n"
        "  const override = (function (input, vars, questions) {\n"
        f"{_indent(user)}\n"
        "  })(input, vars, questions);\n"
        "  if (override !== undefined) state = override;\n"
    ) if user else ""
    return (
        JS_HEADER
        + f"const MODEL = {js(s['model'])};\n"
        + f"const QUESTIONS = {js(s['questions'])};\n\n"
        + "function prepare(input) {\n"
        + "  const vars = {};\n"
        + "  const questions = JSON.parse(JSON.stringify(QUESTIONS));\n"
        + f"  let state = {state_expr};\n"
        + user_block
        + "  if (state === undefined || state === null || state === '') state = '(vide)';\n"
        + "  return { input, state, questions, model: MODEL, vars };\n"
        + "}\n\n"
        + ("// Le webhook n8n range le corps de la requête dans body.\n"
           "return $input.all().map(item => ({ json: prepare(item.json && item.json.body !== undefined ? item.json.body : item.json) }));\n"
           if s["trigger"]["type"] == "webhook" else
           "return $input.all().map(item => ({ json: prepare(item.json) }));\n")
    )


def decision_code(s: dict[str, Any]) -> str:
    d = s["decision"]
    cfg = {
        "uses_jev": uses_jev(s),
        "mode": d["mode"],
        "routes": routes_of(s),
        "error_route": d["error_route"],
        "default_route": d.get("default_route"),
        "question": d.get("question"),
        "min_confidence": d.get("min_confidence"),
        "review_route": d.get("review_route"),
        "rules": d.get("rules", []),
        "composite": d.get("composite"),
        "verdicts": d.get("verdicts") or {},
    }
    post = d["post_js"].strip()
    post_block = (
        "  // Règles propres à ce workflow (ctx.route, ctx.reason, ctx.vars, ctx.extra modifiables).\n"
        "  // Ignorées si Jev n'a pas répondu : la route d'erreur l'emporte.\n"
        "  if (!CFG.uses_jev || answers) (function (ctx, vars, answers, input) {\n"
        f"{_indent(post)}\n"
        "  })(ctx, ctx.vars, answers || {}, prep.input);\n"
    ) if post else ""
    return JS_HEADER + f"const CFG = {js(cfg)};\n" + r"""
function flatten(answers) {
  const v = {};
  for (const [id, a] of Object.entries(answers || {})) {
    if (!a || typeof a !== 'object') continue;
    if (a.type === 'noul') v[id] = a.noul;
    else if (a.type === 'choice') { v[id] = a.choice; v[id + '_confiance'] = a.confidence; }
    else if (a.type === 'score') {
      const levels = Object.keys(a.legend || a.probabilities || {}).length || 2;
      v[id] = a.score; v[id + '_norme'] = a.score / Math.max(1, levels - 1); v[id + '_confiance'] = a.confidence;
    }
  }
  return v;
}

function lookup(path, vars, input) {
  if (Object.prototype.hasOwnProperty.call(vars, path)) return vars[path];
  let cur = input;
  if (path.startsWith('vars.')) cur = vars;
  for (const k of path.replace(/^(input|vars)\./, '').split('.')) {
    if (cur === null || cur === undefined) return undefined;
    cur = cur[k];
  }
  return cur;
}

function test(v, op, x) {
  const list = Array.isArray(x) ? x : String(x ?? '').split(',').map(t => t.trim());
  switch (op) {
    case '>=': return Number(v) >= Number(x);
    case '>': return Number(v) > Number(x);
    case '<=': return Number(v) <= Number(x);
    case '<': return Number(v) < Number(x);
    case '==': return String(v) === String(x);
    case '!=': return String(v) !== String(x);
    case 'in': return list.includes(String(v));
    case 'not_in': return !list.includes(String(v));
    case 'not_contains': return !(Array.isArray(v) ? v : String(v ?? '').split(',')).map(t => String(t).trim()).includes(String(x));
    case 'contains': return (Array.isArray(v) ? v : String(v ?? '').split(',')).map(t => String(t).trim()).includes(String(x));
    case 'exists': return v !== undefined && v !== null && v !== '' && !(Array.isArray(v) && v.length === 0);
    case 'missing': return v === undefined || v === null || v === '' || (Array.isArray(v) && v.length === 0);
  }
  return false;
}

function fmt(n) { return typeof n === 'number' ? Math.round(n * 1000) / 1000 : n; }

function decide(prep, res) {
  const vars = Object.assign({}, prep.vars || {});
  const answers = res && res.answers ? res.answers : null;
  let route = null, reason = '';
  if (CFG.uses_jev && !answers) {
    route = CFG.error_route;
    const err = res && (res.error || res.detail);
    reason = 'Jev indisponible ou réponse invalide : ' + String((err && (err.message || err.description)) || JSON.stringify(err || res || null)).slice(0, 200);
  } else {
    Object.assign(vars, flatten(answers));
    // Verdicts : la réponse de Jev devient un mot lisible par les règles et par un humain.
    for (const [id, v] of Object.entries(CFG.verdicts)) {
      const a = answers[id];
      if (v.kind === 'noul' && a) vars[id + '_verdict'] = a.noul >= v.oui ? 'oui' : (a.noul <= v.non ? 'non' : 'a_verifier');
      else if ((v.kind === 'choice' || v.kind === 'liste_choix') && a) {
        const items = v.kind === 'liste_choix' ? ((prep.vars || {})['__' + id] || []) : null;
        const label = k => items ? (items[Number(String(k).replace(/^c/, ''))] ?? k) : k;
        const ranked = Object.entries(a.probabilities || {}).sort((x, y) => y[1] - x[1]);
        vars[id + '_classement'] = ranked.map(([k, p]) => ({ valeur: label(k), probabilite: fmt(p) }));
        if (!(a.confidence >= v.min)) vars[id + '_verdict'] = 'incertain';
        else if (v.marge !== undefined && ranked.length > 1 && ranked[0][1] - ranked[1][1] < v.marge) vars[id + '_verdict'] = 'hesitation';
        else vars[id + '_verdict'] = label(a.choice);
      } else if (v.kind === 'liste_choix') {
        const items = (prep.vars || {})['__' + id] || [];
        vars[id + '_verdict'] = items.length === 1 ? items[0] : 'aucun';
        vars[id + '_classement'] = items.map(x => ({ valeur: x, probabilite: 1 }));
      } else if (v.kind === 'score' && a) {
        if (!(a.confidence >= v.min)) vars[id + '_verdict'] = 'incertain';
        else if (v.cuts) { const c = v.cuts.find(c => a.score <= c.max); vars[id + '_verdict'] = c ? c.label : v.else; }
        else vars[id + '_verdict'] = String(Math.round(a.score));
      } else if (v.kind === 'etiquettes') {
        const kept = v.labels.filter(l => answers[id + '__' + l] && answers[id + '__' + l].noul >= v.seuil);
        vars[id + '_verdict'] = kept; vars[id + '_nombre'] = kept.length;
      } else if (v.kind === 'pour_chaque') {
        const items = (prep.vars || {})['__' + id] || [];
        const kept = items.filter((it, i) => answers[id + '__' + i] && answers[id + '__' + i].noul >= v.seuil);
        vars[id + '_retenus'] = kept;
        vars[id + '_verdict'] = kept.length === 0 ? 'aucun' : (kept.length === items.length ? 'tous' : 'certains');
      }
    }
    for (const k of Object.keys(vars)) if (k.startsWith('__')) delete vars[k];
    if (CFG.composite) {
      let tot = 0, w = 0;
      for (const [k, p] of Object.entries(CFG.composite.weights)) {
        const x = Number(lookup(k, vars, prep.input));
        if (!Number.isNaN(x)) { tot += x * p; w += p; }
      }
      vars[CFG.composite.name] = w ? tot / w : null;
    }
    if (CFG.mode === 'choice') {
      const a = answers[CFG.question] || {};
      if (typeof a.confidence === 'number' && a.confidence >= CFG.min_confidence) {
        route = a.choice; reason = `${CFG.question} = ${a.choice} (confiance ${fmt(a.confidence)})`;
      } else {
        route = CFG.review_route;
        reason = `Confiance insuffisante sur ${CFG.question} : ${fmt(a.confidence)} < ${CFG.min_confidence}`;
      }
    } else if (CFG.mode === 'rules') {
      for (const r of CFG.rules) {
        if (r.when.every(c => test(lookup(c.field, vars, prep.input), c.op, c.value))) {
          route = r.route.startsWith('=') ? String(lookup(r.route.slice(1), vars, prep.input)) : r.route;
          reason = r.label || r.when.map(c => `${c.field} ${c.op} ${c.value ?? ''}`.trim() + ` (valeur ${fmt(lookup(c.field, vars, prep.input))})`).join(' et ');
          break;
        }
      }
      if (route === null) { route = CFG.default_route; reason = 'Aucune règle déclenchée : route par défaut'; }
    } else {
      route = CFG.default_route; reason = 'Sortie unique';
    }
  }
  const ctx = { route, reason, vars, extra: {} };
""" + post_block + r"""  if (!CFG.routes.includes(ctx.route)) {
    ctx.reason = `Route inconnue « ${ctx.route} » : ${ctx.reason}`;
    ctx.route = CFG.error_route;
  }
  for (const k of Object.keys(ctx.vars)) ctx.vars[k] = fmt(ctx.vars[k]);
  return {
    route: ctx.route,
    reason: ctx.reason,
    vars: ctx.vars,
    extra: ctx.extra,
    input: prep.input,
    jev: answers ? { model: res.model, usage: res.usage, answers } : null,
  };
}

""" + (
        f"const prepItems = $({js(N_PREP)}).all();\n"
        "return $input.all().map((item, i) => ({\n"
        "  json: decide(prepItems[i] ? prepItems[i].json : item.json, CFG.uses_jev ? item.json : null),\n"
        "}));\n"
    )


def merge_code() -> str:
    return JS_HEADER + (
        f"const decisions = $({js(N_DECIDE)}).all();\n"
        "return $input.all().map((item, i) => {\n"
        "  const d = Object.assign({}, decisions[i] ? decisions[i].json : {});\n"
        "  const r = item.json || {};\n"
        "  const text = (r.choices && r.choices[0] && r.choices[0].message && r.choices[0].message.content) || null;\n"
        "  d.extra = Object.assign({}, d.extra, { llm: text, llm_model: r.model || null, llm_erreur: text ? null : (r.error || 'réponse vide') });\n"
        "  return { json: d };\n"
        "});\n"
    )


def sample_code(sample: Any) -> str:
    items = sample if isinstance(sample, list) else [sample or {}]
    return JS_HEADER + f"const EXEMPLES = {js(items)};\nreturn EXEMPLES.map(json => ({{ json }}));\n"


def entry_code() -> str:
    return JS_HEADER + (
        "// Le LLM d'entrée a réécrit la demande : sa réponse devient l'état envoyé à Jev.\n"
        f"const preps = $({js(N_PREP)}).all();\n"
        "return $input.all().map((item, i) => {\n"
        "  const p = Object.assign({}, preps[i] ? preps[i].json : {});\n"
        "  const r = item.json || {};\n"
        "  const text = r.choices && r.choices[0] && r.choices[0].message && r.choices[0].message.content;\n"
        "  if (text) { try { p.state = JSON.parse(text); } catch (e) { p.state = text; } }\n"
        "  p.vars = Object.assign({}, p.vars, { llm_entree: text ? 'ok' : 'échec : état d\\'origine gardé' });\n"
        "  return { json: p };\n"
        "});\n"
    )


def llm_params(llm: dict[str, Any], user_expr: str) -> dict[str, Any]:
    base, needs_auth = llm_base(llm)
    body = ("={{ JSON.stringify({ model: " + js(llm["model"]) + ", temperature: 0, messages: ["
            "{ role: 'system', content: " + js(llm["system"]) + " }, "
            "{ role: 'user', content: " + user_expr + " }] }) }}")
    params: dict[str, Any] = {"method": "POST", "url": base + "/chat/completions"}
    if needs_auth:
        params.update(authentication="genericCredentialType", genericAuthType="httpBearerAuth")
    params.update(sendBody=True, specifyBody="json", jsonBody=body, options={"timeout": 120000})
    return params


def llm_extra(llm: dict[str, Any], creds: dict[str, Any]) -> dict[str, Any]:
    extra: dict[str, Any] = {"onError": "continueRegularOutput"}
    c = creds.get("llm:" + llm["provider"]) or creds.get("llm")
    if c and llm_base(llm)[1]:
        extra["credentials"] = {"httpBearerAuth": c}
    return extra


def llm_base(llm: dict[str, Any]) -> tuple[str, bool]:
    p = BY_ID.get(llm["provider"])
    base = llm.get("base_url") or (p.base_url if p else "https://openrouter.ai/api/v1")
    if p and p.id == "ollama_local" and not llm.get("base_url"):
        base = "http://host.docker.internal:11434/v1"
    needs_auth = not (p and p.auth == "none")
    return base.rstrip("/"), needs_auth


def note_text(s: dict[str, Any]) -> str:
    lines = [f"## {s['name']}"]
    if s["description"]:
        lines.append(s["description"])
    if s["hub"]:
        h = s["hub"]
        lines.append("")
        lines.append("**Hub d'agents** : " + " · ".join(x for x in (h.get("playlist"), h.get("agent") and f"agent {h['agent']}") if x))
        if h.get("allege"):
            lines.append("Allège l'agent : " + h["allege"])
    lines.append("")
    lines.append("**Routes** : " + ", ".join(routes_of(s)))
    if uses_jev(s):
        lines.append("**Variables Jev** : " + ", ".join(question_vars(s["questions"], s["decision"].get("verdicts"))))
        lines.append("Identifiant à créer : Bearer « TypeSafe Jev » (clé console.typesafe.ai).")
    return "\n".join(lines)


ORIGIN_MARK = "n8n-export-builder:source"
N_ORIGIN = "Source du builder (ne pas modifier)"


def origin_note(s: dict[str, Any], fiche: dict[str, Any] | None = None) -> str:
    """Carte d'origine : la spécification (et la fiche du Labo Jev) pour réimporter le workflow dans le builder.
    Les cas de test n'y sont pas : ils peuvent contenir de vrais messages et restent dans le builder."""
    data: dict[str, Any] = {"format": 1, "spec": s}
    if fiche:
        data["fiche"] = {**fiche, "tests": []}
    return ("### Source du N8N Export Builder\nSert à réimporter ce workflow dans le builder (Importer, depuis n8n). "
            f"Ne pas modifier.\n<!-- {ORIGIN_MARK} -->\n```json\n{json.dumps(data, ensure_ascii=False, separators=(',', ':'))}\n```")


def build(s: dict[str, Any], credentials: dict[str, dict[str, str]] | None = None,
          fiche: dict[str, Any] | None = None) -> dict[str, Any]:
    """Construit le workflow n8n. credentials : {"jev"|"llm"|"webhook": {"id", "name"}} deja crees dans n8n.
    fiche : la fiche du Labo Jev d'origine, gardée dans la carte d'origine pour un réimport fidèle."""
    creds = credentials or {}
    wf = slug(s["name"])
    nodes: list[dict[str, Any]] = []
    conns: dict[str, dict[str, list[list[dict[str, Any]]]]] = {}

    def node(name: str, ntype: str, version: float, params: dict[str, Any], x: int, y: int, **extra: Any) -> str:
        n = {"id": _id(wf, name), "name": name, "type": ntype, "typeVersion": version, "position": [x, y],
             "parameters": params}
        n.update(extra)
        nodes.append(n)
        return name

    def link(a: str, b: str, out: int = 0) -> None:
        outs = conns.setdefault(a, {}).setdefault("main", [])
        while len(outs) <= out:
            outs.append([])
        outs[out].append({"node": b, "type": "main", "index": 0})

    X, Y, STEP = 0, 300, 240
    t = s["trigger"]
    if t["type"] == "webhook":
        params: dict[str, Any] = {"httpMethod": "POST", "path": t["path"], "responseMode": "responseNode", "options": {}}
        extra: dict[str, Any] = {"webhookId": _id(wf, "webhook")}
        if t["auth"] == "header":
            params["authentication"] = "headerAuth"
            if "webhook" in creds:
                extra["credentials"] = {"httpHeaderAuth": creds["webhook"]}
        prev = node(N_TRIGGER, "n8n-nodes-base.webhook", 2, params, X, Y, **extra)
    elif t["type"] == "schedule":
        every = t["every"]
        rule: dict[str, Any] = {"field": every, f"{every}Interval": t["interval"]}
        if every == "days":
            rule["triggerAtHour"] = t["at_hour"]
        prev = node(N_TRIGGER, "n8n-nodes-base.scheduleTrigger", 1.2, {"rule": {"interval": [rule]}}, X, Y)
    else:
        prev = node(N_TRIGGER, "n8n-nodes-base.manualTrigger", 1, {}, X, Y)
    x = X + STEP

    if s["source"]:
        src = s["source"]
        if src["type"] == "rss":
            cur = node(N_SOURCE, "n8n-nodes-base.rssFeedRead", 1.1, {"url": src["url"], "options": {}}, x, Y)
        else:
            cur = node(N_SOURCE, "n8n-nodes-base.httpRequest", 4.2, {"url": src["url"], "options": {}}, x, Y)
        link(prev, cur)
        prev, x = cur, x + STEP
    elif t["type"] == "manual":
        cur = node(N_SAMPLE, "n8n-nodes-base.code", 2, {"jsCode": sample_code(s["sample"])}, x, Y)
        link(prev, cur)
        prev, x = cur, x + STEP

    cur = node(N_PREP, "n8n-nodes-base.code", 2, {"jsCode": prep_code(s)}, x, Y)
    link(prev, cur)
    prev, x = cur, x + STEP

    ent = s.get("entree_llm")
    if ent:
        cur = node(N_LLM_IN, "n8n-nodes-base.httpRequest", 4.2, llm_params(ent, "JSON.stringify($json.state)"), x, Y,
                   **llm_extra(ent, creds))
        link(prev, cur)
        prev, x = cur, x + STEP
        cur = node(N_STATE_IN, "n8n-nodes-base.code", 2, {"jsCode": entry_code()}, x, Y)
        link(prev, cur)
        prev, x = cur, x + STEP

    if uses_jev(s):
        params = {
            "method": "POST",
            "url": s["jev_url"],
            "authentication": "genericCredentialType",
            "genericAuthType": "httpBearerAuth",
            "sendBody": True,
            "specifyBody": "json",
            "jsonBody": "={{ JSON.stringify({ model: $json.model, state: $json.state, questions: $json.questions }) }}",
            "options": {"timeout": 30000},
        }
        extra = {"retryOnFail": True, "maxTries": 3, "waitBetweenTries": 2000, "onError": "continueRegularOutput"}
        if "jev" in creds:
            extra["credentials"] = {"httpBearerAuth": creds["jev"]}
        cur = node(N_JEV, "n8n-nodes-base.httpRequest", 4.2, params, x, Y, **extra)
        link(prev, cur)
        prev, x = cur, x + STEP

    cur = node(N_DECIDE, "n8n-nodes-base.code", 2, {"jsCode": decision_code(s)}, x, Y)
    link(prev, cur)
    prev, x = cur, x + STEP

    routes = routes_of(s)
    if len(routes) > 1:
        values = []
        for r in routes:
            values.append({
                "conditions": {
                    "options": {"caseSensitive": True, "leftValue": "", "typeValidation": "strict", "version": 2},
                    "conditions": [{"id": _id(wf, "cond/" + r), "leftValue": "={{ $json.route }}", "rightValue": r,
                                    "operator": {"type": "string", "operation": "equals"}}],
                    "combinator": "and",
                },
                "renameOutput": True,
                "outputKey": r,
            })
        switch = node(N_SWITCH, "n8n-nodes-base.switch", 3.2, {"rules": {"values": values}, "options": {}}, x, Y)
        link(prev, switch)
        x += STEP
    else:
        switch = None

    respond = None
    if t["type"] == "webhook":
        respond = N_RESPOND
    llms = {l["route"]: l for l in s["llms"]}
    single = len(llms) == 1
    ends: list[str] = []
    span = 180
    top = Y - span * (len(routes) - 1) // 2
    for i, r in enumerate(routes):
        y = top + i * span
        name = f"Route : {r}"
        node(name, "n8n-nodes-base.noOp", 1, {}, x, y,
             notes="Branchez ici les actions de cette route (Slack, CRM, e-mail, agent du hub…).", notesInFlow=True)
        if switch:
            link(switch, name, i)
        else:
            link(prev, name)
        end = name
        if r in llms:
            l = llms[r]
            n_llm, n_merge = (N_LLM, N_MERGE) if single else (f"LLM : {r}", f"Fusion LLM : {r}")
            user = ("JSON.stringify({ entree: $json.input, decision: { route: $json.route, raison: $json.reason, "
                    "variables: $json.vars } })")
            node(n_llm, "n8n-nodes-base.httpRequest", 4.2, llm_params(l, user), x + STEP, y, **llm_extra(l, creds))
            node(n_merge, "n8n-nodes-base.code", 2, {"jsCode": merge_code()}, x + 2 * STEP, y)
            link(name, n_llm)
            link(n_llm, n_merge)
            end = n_merge
        ends.append(end)

    if respond:
        rx = x + (3 if llms else 1) * STEP
        body = ("={{ JSON.stringify({ route: $json.route, raison: $json.reason, variables: $json.vars, "
                "extra: $json.extra, jev_modele: $json.jev ? $json.jev.model : null }) }}")
        node(respond, "n8n-nodes-base.respondToWebhook", 1.1,
             {"respondWith": "json", "responseBody": body, "options": {}}, rx, Y)
        for e in ends:
            link(e, respond)

    height = max(200, 120 + 24 * note_text(s).count("\n"))
    top_y = min(n["position"][1] for n in nodes)
    node(N_NOTE, "n8n-nodes-base.stickyNote", 1,
         {"content": note_text(s), "height": height, "width": 560, "color": 5}, X - 40, top_y - height - 40)
    node(N_ORIGIN, "n8n-nodes-base.stickyNote", 1,
         {"content": origin_note(s, fiche), "height": 140, "width": 360, "color": 7}, X + 560, top_y - 180)

    return {
        "name": s["name"],
        "nodes": nodes,
        "connections": conns,
        "pinData": {},
        "settings": {"executionOrder": "v1"},
        "meta": {"templateCredsSetupCompleted": False, "generator": "n8n-export-builder"},
    }


def api_payload(workflow: dict[str, Any]) -> dict[str, Any]:
    """Champs acceptes par POST /api/v1/workflows : tout champ en plus est refuse par n8n."""
    return {"name": workflow["name"], "nodes": workflow["nodes"], "connections": workflow["connections"],
            "settings": {"executionOrder": workflow.get("settings", {}).get("executionOrder", "v1")}}


def curl_example(s: dict[str, Any], base_url: str = "https://VOTRE-N8N") -> str | None:
    """Exemple d'appel a coller dans le Hub d'agents (Catalogue, ajouter une API)."""
    t = s["trigger"]
    if t["type"] != "webhook":
        return None
    sample = s["sample"][0] if isinstance(s["sample"], list) and s["sample"] else s["sample"]
    auth = " \\\n  -H 'X-Builder-Key: VOTRE_CLE'" if t["auth"] == "header" else ""
    return (f"curl -X POST '{base_url.rstrip('/')}/webhook/{t['path']}'{auth} \\\n"
            f"  -H 'Content-Type: application/json' \\\n  -d '{json.dumps(sample, ensure_ascii=False)}'")
