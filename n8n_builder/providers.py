"""Fournisseurs de modeles : liste ordonnee, lecture des modeles a jour, appel de discussion.

OpenRouter en tete (une cle, des centaines de modeles), puis Ollama Cloud et Ollama local, puis Jev
(TypeSafe, modele de decision), puis les principaux fournisseurs. Tous sauf Jev parlent le format
OpenAI /v1/chat/completions, ce qui permet au workflow n8n de les appeler avec un seul type de noeud.
"""

from __future__ import annotations

import json
import re
import time
from dataclasses import asdict, dataclass
from typing import Any

import httpx


@dataclass(frozen=True)
class Provider:
    id: str
    label: str
    base_url: str             # base compatible OpenAI, avec /v1
    kind: str = "chat"        # chat ou decision (Jev)
    auth: str = "bearer"      # bearer, none, anthropic
    key_url: str = ""
    offer: str = ""
    key_optional: bool = False
    models_public: bool = False
    base_editable: bool = False

    def public(self) -> dict[str, Any]:
        return asdict(self)


PROVIDERS: list[Provider] = [
    Provider("openrouter", "OpenRouter", "https://openrouter.ai/api/v1", key_url="https://openrouter.ai/keys",
             offer="Des centaines de modèles d'une seule clé, prix affichés, modèles gratuits (suffixe :free). Donne aussi accès à Jev.",
             models_public=True),
    Provider("ollama_cloud", "Ollama Cloud", "https://ollama.com/v1", key_url="https://ollama.com/settings/keys",
             offer="Grands modèles ouverts hébergés par Ollama (GLM, Kimi, DeepSeek, gpt-oss…).", models_public=True),
    Provider("ollama_local", "Ollama local", "http://localhost:11434/v1", auth="none", key_optional=True,
             offer="Vos modèles installés sur la machine ou le VPS. Aucune clé, aucune donnée ne sort.",
             base_editable=True),
    Provider("typesafe", "TypeSafe Jev", "https://api.typesafe.ai/v1", kind="decision",
             key_url="https://console.typesafe.ai",
             offer="Jev, modèle de décision System One : réponses typées et probabilités, sans texte généré. "
                   "0,042 $ par million de tokens en entrée, sortie gratuite. Aussi accessible avec une clé OpenRouter : "
                   "choisissez « Jev via OpenRouter » dans l'automate."),
    Provider("anthropic", "Anthropic (Claude)", "https://api.anthropic.com/v1", auth="anthropic",
             key_url="https://console.anthropic.com/settings/keys", offer="Claude : Fable, Opus, Sonnet, Haiku."),
    Provider("openai", "OpenAI", "https://api.openai.com/v1", key_url="https://platform.openai.com/api-keys",
             offer="GPT et modèles de raisonnement."),
    Provider("gemini", "Google Gemini", "https://generativelanguage.googleapis.com/v1beta/openai",
             key_url="https://aistudio.google.com/apikey", offer="Gemini, offre gratuite avec limites de débit."),
    Provider("mistral", "Mistral AI", "https://api.mistral.ai/v1", key_url="https://console.mistral.ai/api-keys",
             offer="Modèles européens."),
    Provider("deepseek", "DeepSeek", "https://api.deepseek.com/v1", key_url="https://platform.deepseek.com/api_keys",
             offer="Modèles très économiques."),
    Provider("groq", "Groq", "https://api.groq.com/openai/v1", key_url="https://console.groq.com/keys",
             offer="Inférence très rapide de modèles ouverts."),
    Provider("xai", "xAI (Grok)", "https://api.x.ai/v1", key_url="https://console.x.ai", offer="Modèles Grok."),
    Provider("together", "Together AI", "https://api.together.xyz/v1",
             key_url="https://api.together.ai/settings/api-keys", offer="Modèles ouverts (Llama, Qwen, DeepSeek…)."),
    Provider("cerebras", "Cerebras", "https://api.cerebras.ai/v1", key_url="https://cloud.cerebras.ai",
             offer="Inférence ultra rapide de modèles ouverts."),
]
BY_ID = {p.id: p for p in PROVIDERS}


class ProviderError(RuntimeError):
    pass


def _headers(p: Provider, key: str | None) -> dict[str, str]:
    h = {"Accept": "application/json", "User-Agent": "n8n-export-builder"}
    if p.auth == "anthropic":
        if key:
            h["x-api-key"] = key
        h["anthropic-version"] = "2023-06-01"
    elif key:
        h["Authorization"] = f"Bearer {key}"
    return h


def _price(v: Any) -> float | None:
    """Prix OpenRouter par token (texte) vers USD par million de tokens."""
    try:
        f = float(v)
    except (TypeError, ValueError):
        return None
    return None if f < 0 else round(f * 1_000_000, 4)


def normalize_models(provider_id: str, payload: Any) -> list[dict[str, Any]]:
    """Ramene les formats de liste des fournisseurs a {id, name, context, input, output, created, free}."""
    items: list[Any]
    if isinstance(payload, list):
        items = payload
    elif isinstance(payload, dict):
        items = payload.get("data") or payload.get("models") or []
    else:
        items = []
    out = []
    for m in items:
        if isinstance(m, str):
            m = {"id": m}
        if not isinstance(m, dict):
            continue
        mid = m.get("id") or m.get("model") or m.get("name")
        if not isinstance(mid, str) or not mid:
            continue
        if provider_id == "gemini":
            mid = mid.removeprefix("models/")
        row: dict[str, Any] = {"id": mid, "name": m.get("display_name") or m.get("name") or mid,
                               "created": m.get("created") or m.get("created_at") or m.get("modified_at")}
        if isinstance(row["created"], str):
            row["created"] = row["created"][:10]
        pricing = m.get("pricing") or {}
        if pricing:
            row["input"], row["output"] = _price(pricing.get("prompt")), _price(pricing.get("completion"))
            row["free"] = mid.endswith(":free") or (row["input"] == 0 and row["output"] == 0)
        ctx = m.get("context_length") or m.get("context_window")
        if ctx:
            row["context"] = ctx
        if m.get("description"):
            row["description"] = str(m["description"])[:300]
        size = m.get("size")
        if isinstance(size, int) and size > 0:
            row["size_gb"] = round(size / 1e9, 1)
        out.append(row)
    if provider_id == "openrouter":
        out.sort(key=lambda r: -(r.get("created") or 0) if isinstance(r.get("created"), int) else 0)
    else:
        out.sort(key=lambda r: str(r["id"]))
    return out


def models_url(p: Provider, base_url: str | None) -> str:
    base = (base_url or p.base_url).rstrip("/")
    if p.id == "ollama_local":
        return re.sub(r"/v1$", "", base) + "/api/tags"
    return base + "/models"


async def list_models(p: Provider, key: str | None, base_url: str | None = None,
                      client: httpx.AsyncClient | None = None) -> list[dict[str, Any]]:
    if not key and not p.key_optional and not p.models_public:
        raise ProviderError("Clé API requise pour lire les modèles de ce fournisseur.")
    url = models_url(p, base_url)
    own = client is None
    client = client or httpx.AsyncClient(timeout=20)
    try:
        r = await client.get(url, headers=_headers(p, key))
    except httpx.HTTPError as e:
        raise ProviderError(f"Fournisseur injoignable ({url}) : {e.__class__.__name__}") from e
    finally:
        if own:
            await client.aclose()
    if r.status_code in (401, 403):
        raise ProviderError("Clé refusée par le fournisseur.")
    if r.status_code >= 400:
        raise ProviderError(f"Le fournisseur répond {r.status_code}.")
    try:
        return normalize_models(p.id, r.json())
    except json.JSONDecodeError as e:
        raise ProviderError("Réponse illisible du fournisseur.") from e


def extract_json(text: str) -> Any:
    """Premier objet JSON d'une reponse de LLM, avec ou sans bloc de code."""
    m = re.search(r"```(?:json)?\s*(\{.*?\})\s*```", text, re.S)
    raw = m.group(1) if m else text[text.find("{"): text.rfind("}") + 1]
    return json.loads(raw)


async def chat(p: Provider, key: str | None, model: str, system: str, user: str, base_url: str | None = None,
               client: httpx.AsyncClient | None = None, max_tokens: int = 4000) -> str:
    if p.kind != "chat":
        raise ProviderError("Ce fournisseur ne fait pas de discussion (Jev rend des décisions, pas du texte).")
    if not key and not p.key_optional:
        raise ProviderError("Clé API manquante pour ce fournisseur.")
    base = (base_url or p.base_url).rstrip("/")
    own = client is None
    client = client or httpx.AsyncClient(timeout=120)
    t0 = time.monotonic()
    try:
        if p.auth == "anthropic":
            r = await client.post(base + "/messages", headers=_headers(p, key), json={
                "model": model, "max_tokens": max_tokens, "system": system,
                "messages": [{"role": "user", "content": user}]})
        else:
            r = await client.post(base + "/chat/completions", headers=_headers(p, key), json={
                "model": model, "temperature": 0, "max_tokens": max_tokens,
                "messages": [{"role": "system", "content": system}, {"role": "user", "content": user}]})
    except httpx.HTTPError as e:
        raise ProviderError(f"Fournisseur injoignable : {e.__class__.__name__}") from e
    finally:
        if own:
            await client.aclose()
    if r.status_code >= 400:
        raise ProviderError(f"Le fournisseur répond {r.status_code} : {r.text[:300]}")
    data = r.json()
    if p.auth == "anthropic":
        text = "".join(b.get("text", "") for b in data.get("content", []) if b.get("type") == "text")
    else:
        text = ((data.get("choices") or [{}])[0].get("message") or {}).get("content") or ""
    if not text:
        raise ProviderError(f"Réponse vide du modèle ({int((time.monotonic() - t0) * 1000)} ms).")
    return text
