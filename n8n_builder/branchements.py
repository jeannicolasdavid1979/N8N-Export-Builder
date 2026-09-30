"""Branchements d'un workflow n8n gardé tel quel.

Le workflow reste la référence : on n'en change que ce que la personne choisit, là où c'est écrit.
- une prise par appel à un LLM ou à Jev : son fournisseur et son modèle, lus dans les paramètres du nœud, dans le corps
  de la requête, ou dans le nœud de code qui prépare ce corps (le cas des appels à Jev « {{ $json.jev1_body }} ») ;
- une prise par webhook : son chemin.
Les remplacements sont exacts (l'ancien identifiant de modèle, entre guillemets, après « model: ») : rien d'autre ne bouge.
Changer de fournisseur change aussi l'identifiant de connexion : une clé ne part jamais vers un autre fournisseur.
"""
from __future__ import annotations

import copy
import json
import re
from typing import Any

from . import importer
from . import providers as P
from .spec import JEV_PROVIDERS

LANGCHAIN_PROVIDER = {"lmChatOpenRouter": "openrouter", "lmChatOpenAi": "openai", "lmChatAnthropic": "anthropic",
                      "lmChatMistralCloud": "mistral", "lmChatOllama": "ollama_local", "lmChatGroq": "groq",
                      "lmChatDeepSeek": "deepseek", "lmChatGoogleGemini": "gemini", "lmChatXAiGrok": "xai",
                      "openAi": "openai"}
MODEL_KEYS = ("model", "modelId", "modelName")
MODEL_LIT = r"""((?:\bmodel\b|["']model["'])\s*:\s*)(["'])({old})\2"""
SETTINGS_KEYS = ("executionOrder", "saveDataErrorExecution", "saveDataSuccessExecution", "saveManualExecutions",
                 "saveExecutionProgress", "executionTimeout", "errorWorkflow", "timezone", "callerPolicy", "binaryMode")


class BranchementErreur(ValueError):
    pass


def _provider_of_url(url: str) -> str | None:
    u = url.lower()
    if "openrouter.ai" in u:
        return "openrouter"
    if "typesafe.ai" in u:
        return "typesafe"
    for p in P.PROVIDERS:
        if p.base_url.lower().rstrip("/") in u:
            return p.id
    if ":11434" in u or "ollama" in u:
        return "ollama_local"
    return None


def _param_model(p: dict[str, Any]) -> tuple[str, str] | None:
    for k in MODEL_KEYS:
        v = p.get(k)
        if isinstance(v, str) and v and not v.startswith("="):
            return k, v
        if isinstance(v, dict) and isinstance(v.get("value"), str) and v["value"] and not v["value"].startswith("="):
            return k, v["value"]
    return None


def _body_model(p: dict[str, Any]) -> tuple[str, str] | None:
    for k in ("jsonBody", "body"):
        v = p.get(k)
        if isinstance(v, str):
            m = re.search(MODEL_LIT.format(old=r"[^'\"\s]+"), v)
            if m:
                return k, m.group(3)
    for prm in ((p.get("bodyParameters") or {}).get("parameters") or []):
        if isinstance(prm, dict) and prm.get("name") == "model" and isinstance(prm.get("value"), str) and not prm["value"].startswith("="):
            return "bodyParameters", prm["value"]
    return None


def lister(wf: dict[str, Any]) -> list[dict[str, Any]]:
    nodes = [n for n in wf.get("nodes") or [] if isinstance(n, dict)]
    out: list[dict[str, Any]] = []
    orphans: dict[str, list[str]] = {"llm": [], "jev": []}
    for n in nodes:
        kind = importer.classify(n)
        name, t, p = n.get("name", "?"), n.get("type", ""), n.get("parameters") or {}
        if kind == "declencheur" and t == "n8n-nodes-base.webhook":
            out.append({"id": f"{name}::path", "noeud": name, "type": "webhook", "valeur": p.get("path") or "", "ou": "param"})
            continue
        if kind not in ("llm", "jev"):
            continue
        url = str(p.get("url") or "")
        short = t.split(".")[-1]
        prov = LANGCHAIN_PROVIDER.get(short) if "langchain" in t or t == "n8n-nodes-base.openAi" else _provider_of_url(url)
        found = _param_model(p)
        where = "param" if found else None
        if not found:
            found = _body_model(p)
            where = "corps" if found else None
        http_chat = t == "n8n-nodes-base.httpRequest" and url.rstrip("/").endswith("/chat/completions") and not url.startswith("=")
        prise = {"id": f"{name}::{where or 'aucun'}", "noeud": name, "type": kind, "fournisseur": prov,
                 "modele": found[1] if found else None, "ou": where, "cle": found[0] if found else None,
                 "fournisseur_modifiable": bool(kind == "llm" and http_chat and prov in P.BY_ID and P.BY_ID[prov].auth != "anthropic"),
                 "identifiant": next(iter((n.get("credentials") or {}).values()), {}).get("name")}
        if not found:
            orphans[kind].append(name)
        out.append(prise)
    # Modèles écrits dans un nœud de code qui prépare les corps (« model: 'typesafe/jev-1.13' »)
    for kind, names in orphans.items():
        if not names:
            continue
        for n in nodes:
            if importer.classify(n) != "code":
                continue
            code = str((n.get("parameters") or {}).get("jsCode") or "")
            lits = [m.group(3) for m in re.finditer(MODEL_LIT.format(old=r"[^'\"\s]+"), code)]
            lits = [x for x in lits if bool(importer.JEV_RE.search(x)) == (kind == "jev")]
            for model in dict.fromkeys(lits):
                prov = next((p["fournisseur"] for p in out if p["noeud"] in names), None)
                out.append({"id": f"{n.get('name')}::code::{model}", "noeud": n.get("name"), "type": kind, "fournisseur": prov,
                            "modele": model, "ou": "code", "cle": None, "fournisseur_modifiable": False,
                            "appels": names, "occurrences": sum(1 for _ in re.finditer(MODEL_LIT.format(old=re.escape(model)), code)),
                            "identifiant": None})
        for p in out:
            if p["noeud"] in names and p["ou"] is None and any(q.get("appels") and p["noeud"] in q["appels"] for q in out):
                p["via_code"] = True
    return out


def _replace_lit(text: str, old: str, new: str) -> tuple[str, int]:
    return re.subn(MODEL_LIT.format(old=re.escape(old)), lambda m: m.group(1) + m.group(2) + new + m.group(2), text)


def appliquer(wf: dict[str, Any], changes: list[dict[str, Any]], creds: dict[str, dict[str, str]] | None = None
              ) -> tuple[dict[str, Any], list[str], list[str]]:
    """Applique les choix. creds : {fournisseur: {"id", "name"}} créés par le builder pour les changements de fournisseur.
    Rend le workflow modifié, la liste lisible des changements et les notes (identifiant à choisir dans n8n…)."""
    wf = copy.deepcopy(wf)
    prises = {p["id"]: p for p in lister(wf)}
    nodes = {n.get("name"): n for n in wf.get("nodes") or []}
    done, notes = [], []
    for ch in changes or []:
        p = prises.get(ch.get("id"))
        if not p:
            raise BranchementErreur(f"Branchement inconnu : {ch.get('id')}")
        node = nodes[p["noeud"]]
        prm = node.setdefault("parameters", {})
        if p["type"] == "webhook":
            path = str(ch.get("valeur") or "").strip().strip("/")
            if not re.fullmatch(r"[A-Za-z0-9_\-/:.]{1,200}", path):
                raise BranchementErreur(f"Chemin de webhook invalide pour « {p['noeud']} ».")
            if path != p["valeur"]:
                prm["path"] = path
                done.append(f"« {p['noeud']} » : chemin /{p['valeur']} devient /{path}")
            continue
        new_model = str(ch.get("modele") or "").strip()
        if new_model and not re.fullmatch(r"[~A-Za-z0-9][A-Za-z0-9._/:~@-]{0,120}", new_model):
            raise BranchementErreur(f"Identifiant de modèle invalide pour « {p['noeud']} ».")
        new_prov = ch.get("fournisseur")
        if new_prov and new_prov != p["fournisseur"]:
            if not p["fournisseur_modifiable"] or new_prov not in P.BY_ID or P.BY_ID[new_prov].kind != "chat" or P.BY_ID[new_prov].auth == "anthropic":
                raise BranchementErreur(f"Le fournisseur de « {p['noeud']} » ne peut pas être changé ici.")
            prov = P.BY_ID[new_prov]
            base = prov.base_url if new_prov != "ollama_local" else "http://host.docker.internal:11434/v1"
            prm["url"] = base.rstrip("/") + "/chat/completions"
            # une clé ne suit jamais un changement de fournisseur : nouvel identifiant, ou aucun
            node.pop("credentials", None)
            if prov.auth == "none":
                prm["authentication"] = "none"
            else:
                prm.update(authentication="genericCredentialType", genericAuthType="httpBearerAuth")
                c = (creds or {}).get(new_prov)
                if c:
                    node["credentials"] = {"httpBearerAuth": c}
                else:
                    notes.append(f"« {p['noeud']} » : choisissez l'identifiant {prov.label} dans n8n (aucune clé {prov.label} enregistrée dans le builder).")
            done.append(f"« {p['noeud']} » : fournisseur {P.BY_ID[p['fournisseur']].label if p['fournisseur'] in P.BY_ID else '?'} devient {prov.label}")
        if new_model and new_model != p["modele"]:
            if p["ou"] == "param":
                v = prm[p["cle"]]
                if isinstance(v, dict):
                    v["value"] = new_model
                    if v.get("mode") == "list":
                        v["mode"] = "id"
                else:
                    prm[p["cle"]] = new_model
            elif p["ou"] == "corps":
                if p["cle"] == "bodyParameters":
                    for x in prm["bodyParameters"]["parameters"]:
                        if x.get("name") == "model":
                            x["value"] = new_model
                else:
                    prm[p["cle"]], _ = _replace_lit(prm[p["cle"]], p["modele"], new_model)
            elif p["ou"] == "code":
                prm["jsCode"], k = _replace_lit(prm["jsCode"], p["modele"], new_model)
                done.append(f"« {p['noeud']} » : modèle {p['modele']} devient {new_model} ({k} endroit(s), pour {', '.join(p['appels'])})")
                continue
            else:
                raise BranchementErreur(f"Le modèle de « {p['noeud']} » n'est écrit nulle part où le builder peut le changer.")
            done.append(f"« {p['noeud']} » : modèle {p['modele']} devient {new_model}")
    return wf, done, notes


def payload(wf: dict[str, Any]) -> dict[str, Any]:
    """Champs acceptés par l'API publique de n8n."""
    settings = {k: v for k, v in (wf.get("settings") or {}).items() if k in SETTINGS_KEYS}
    return {"name": wf.get("name") or "Workflow", "nodes": wf.get("nodes") or [], "connections": wf.get("connections") or {},
            "settings": settings or {"executionOrder": "v1"}}


def modeles_jev(fournisseur: str | None) -> list[str]:
    return list((JEV_PROVIDERS.get(fournisseur or "") or {}).get("models") or [])
