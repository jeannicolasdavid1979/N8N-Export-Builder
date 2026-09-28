"""Export d'un automate vers une playlist du Hub d'agents.

Quatre pieces, chacune dans un format que le Hub lit deja :
- openapi.json : Connecteurs, Ajouter une API par sa description OpenAPI. L'automate devient un outil de la
  playlist ; la cle du webhook (en-tete X-Builder-Key) va au coffre.
- SKILL.md : Catalogue, Skills, importer. Explique a l'agent quand appeler l'automate et que faire pour
  chaque resultat ; « Ajouter a une playlist » le remet a l'agent.
- kit.json : Studio, installer un kit (format 1). Cree une playlist complete : mission, source demandee,
  epreuves tirees des cas de test.
- workflow-n8n.json : le workflow lui-meme, a importer dans n8n si ce n'est pas deja fait.
"""

from __future__ import annotations

import io
import json
import re
import zipfile
from typing import Any

from .generator import build
from .spec import routes_of, slug


def _snake(text: str) -> str:
    return re.sub(r"[^a-z0-9]+", "_", slug(text)).strip("_")[:48] or "automate"


def _schema(v: Any, depth: int = 0) -> dict[str, Any]:
    if isinstance(v, bool):
        return {"type": "boolean"}
    if isinstance(v, int):
        return {"type": "integer"}
    if isinstance(v, float):
        return {"type": "number"}
    if isinstance(v, list):
        return {"type": "array", "items": _schema(v[0], depth + 1) if v and depth < 4 else {}}
    if isinstance(v, dict) and depth < 4:
        return {"type": "object", "properties": {k: _schema(x, depth + 1) for k, x in v.items()}}
    return {"type": "string"}


def route_lines(s: dict[str, Any]) -> list[str]:
    notes = s.get("route_notes") or {}
    return [f"- `{r}` : {notes.get(r) or 'à préciser : ce que fait l’agent dans ce cas'}" for r in routes_of(s)]


def openapi(s: dict[str, Any], base_url: str) -> dict[str, Any]:
    t = s["trigger"]
    if t["type"] != "webhook":
        raise ValueError("Seul un automate déclenché par webhook peut devenir un outil du hub.")
    sample = s["sample"][0] if isinstance(s["sample"], list) and s["sample"] else s["sample"]
    body = _schema(sample if isinstance(sample, dict) else {})
    if s["state"]["mode"] == "field":
        body["required"] = [s["state"]["field"]]
    elif s["state"]["mode"] == "fields":
        body["required"] = list(s["state"]["fields"])
    routes = routes_of(s)
    desc = (s["description"] + "\n\n" if s["description"] else "") + \
        "Décision déterministe : même entrée, même route. Routes possibles :\n" + "\n".join(route_lines(s))
    op: dict[str, Any] = {
        "operationId": _snake(s["name"]),
        "summary": s["name"][:120],
        "description": desc[:900],
        "requestBody": {"required": True, "content": {"application/json": {"schema": body}}},
        "responses": {"200": {"description": "Décision de l'automate", "content": {"application/json": {"schema": {
            "type": "object", "properties": {
                "route": {"type": "string", "enum": routes, "description": "Résultat à suivre"},
                "raison": {"type": "string", "description": "Règle qui a décidé"},
                "variables": {"type": "object", "description": "Verdicts et valeurs calculées"},
                "extra": {"type": "object"}, "jev_modele": {"type": "string"}}}}}}},
    }
    doc: dict[str, Any] = {
        "openapi": "3.0.3",
        "info": {"title": s["name"][:120], "version": "1.0.0", "description": (s["description"] or s["name"])[:1000]},
        "servers": [{"url": base_url.rstrip("/") + "/webhook"}],
        "paths": {"/" + t["path"]: {"post": op}},
    }
    if t["auth"] == "header":
        doc["components"] = {"securitySchemes": {"cle_automate": {"type": "apiKey", "in": "header", "name": "X-Builder-Key"}}}
        op["security"] = [{"cle_automate": []}]
    return doc


def skill_md(s: dict[str, Any]) -> str:
    name = slug(s["name"])[:48].strip("-")
    if not re.match(r"^[a-z]", name):
        name = "automate-" + name
    tool = _snake(s["name"])
    desc = (f"Utiliser l'automate « {s['name']} » pour décider sans raisonner soi-même : "
            f"{s['description'] or 'décision déterministe par Jev et des règles'}").replace("\n", " ")[:900]
    body = [
        "---", f"name: {name}", f"description: {json.dumps(desc, ensure_ascii=False)}", "---", "",
        f"# {s['name']}", "",
        "Cet automate prend la décision à ta place, de façon déterministe : même entrée, même résultat. "
        "Tu n'as pas à relire les critères ni à raisonner dessus : c'est ce qui économise tes tokens.", "",
        "## Quand l'appeler", "",
        f"Dès que tu dois traiter un cas que décrit l'objectif : {s['description'] or s['name']}", "",
        "## Comment", "",
        f"1. Appelle l'outil dont le nom contient `{tool}` (ou l'outil de l'API « {s['name']} ») avec l'entrée brute, sans la reformuler.",
        "2. Lis `route`, puis `raison` si tu dois expliquer.",
        "3. Applique la consigne de la route ci-dessous. Ne refais pas le tri toi-même.", "",
        "## Que faire selon la route", "", *route_lines(s), "",
        "## Règles", "",
        "- Ne contredis jamais la route rendue : si elle te paraît fausse, signale le cas à un humain avec la raison.",
        "- Une route de revue (a_revoir, a_relire, humain…) veut dire : ne décide pas, transmets.",
        "- Si l'outil ne répond pas, ne devine pas : transmets à un humain.",
    ]
    return "\n".join(body) + "\n"


def kit(s: dict[str, Any], tests: list[dict[str, Any]] | None = None) -> dict[str, Any]:
    kid = slug(s["name"])[:60]
    if len(kid) < 2:
        kid = "automate-" + kid
    agent = (s.get("hub") or {}).get("agent") or kid.replace("-", "_")
    agent = re.sub(r"[^A-Za-z0-9_-]", "_", agent)[:64]
    arg = s["state"]["field"] if s["state"]["mode"] == "field" else "entree"
    trials = []
    for i, t in enumerate(tests or [], 1):
        if not t.get("attendu"):
            continue
        entree = t["entree"] if isinstance(t["entree"], str) else json.dumps(t["entree"], ensure_ascii=False)
        trials.append({"name": f"Cas {i} : {t.get('note') or t['attendu']}"[:120], "input": entree[:4000],
                       "expect": {"include_any": [t["attendu"]]}})
    procedures = ("1. Pour chaque cas à traiter, appelle l'outil de l'automate avec l'entrée brute.\n"
                  "2. Lis la route rendue et applique sa consigne :\n" + "\n".join(route_lines(s)) +
                  "\n3. Cite la route dans ta réponse.")
    return {
        "kit": 1, "id": kid, "version": "1.0.0", "title": s["name"][:120],
        "summary": (s["description"] or s["name"])[:300], "metier": "Automates déterministes",
        "tags": ["automate", "jev", "n8n"] + [t for t in s.get("tags", []) if re.match(r"^.{1,80}$", t)][:5],
        "language": "fr", "author": {"name": "N8N Export Builder", "url": ""}, "agent": agent,
        "mission": {
            "role": f"Tu traites les cas « {s['name']} » en t'appuyant sur un automate déterministe : "
                    "il décide, tu exécutes la suite.",
            "goals": "Chaque cas reçoit la route de l'automate et l'action qui correspond, sans réinterprétation. "
                     "Les cas de revue arrivent à un humain avec la raison.",
            "procedures": procedures[:8000],
            "never": "Ne jamais refaire le tri de l'automate ni contredire sa route.\n"
                     "Ne jamais décider seul un cas routé vers une revue humaine.",
            "style": "Français, bref. Toujours citer la route.",
            "prompts": [{"name": _snake(s["name"]).replace("_", "-")[:48], "title": f"Passer un cas à l'automate",
                         "description": s["name"][:300],
                         "text": f"Passe ce cas à l'automate « {s['name']} » puis applique la consigne de la route : {{{{{arg}}}}}"}],
        },
        "requirements": [{
            "id": "automate", "kind": "http", "label": f"Automate : {s['name']}"[:120],
            "why": "Workflow n8n déterministe. Ajoutez l'API avec le fichier openapi.json fourni, clé X-Builder-Key au coffre. "
                   "Écriture nécessaire : l'appel est un POST.",
            "rights": {"write": True}, "optional": False,
        }],
        "settings": {"per_day_max": None},
        "trials": trials[:20],
        "changelog": "Version initiale générée par N8N Export Builder.",
    }


def readme(s: dict[str, Any], base_url: str) -> str:
    return "\n".join([
        f"# {s['name']} : export vers le Hub d'agents", "",
        "1. Importez `workflow-n8n.json` dans n8n (sauf s'il y a déjà été envoyé par le builder), avec la clé d'en-tête activée.",
        f"2. Hub, Connecteurs, Ajouter un connecteur, API par sa description OpenAPI : déposez `openapi.json` "
        f"(adresse du serveur : {base_url.rstrip('/')}/webhook). Collez la clé X-Builder-Key : le hub la range au coffre.",
        "3. Ajoutez l'API à la playlist de l'agent (droit Écriture : l'appel est un POST ; plafond d'écritures conseillé).",
        "4. Hub, Catalogue, Skills, importer `SKILL.md`, puis « Ajouter à une playlist ».",
        "5. Ou bien : Studio, installer `kit.json` pour créer une playlist complète autour de l'automate.", "",
        "Routes :", *route_lines(s), "",
    ])


def bundle(s: dict[str, Any], base_url: str, tests: list[dict[str, Any]] | None = None,
           fiche: dict[str, Any] | None = None) -> dict[str, Any]:
    parts: dict[str, Any] = {"workflow-n8n.json": build(s), "SKILL.md": skill_md(s), "kit.json": kit(s, tests),
                             "LISEZMOI.md": readme(s, base_url)}
    if s["trigger"]["type"] == "webhook":
        parts["openapi.json"] = openapi(s, base_url)
    if fiche:
        parts["fiche-jev.json"] = fiche
    return parts


def zip_bytes(parts: dict[str, Any]) -> bytes:
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as z:
        for name, content in parts.items():
            z.writestr(name, content if isinstance(content, str) else json.dumps(content, ensure_ascii=False, indent=2))
    return buf.getvalue()
