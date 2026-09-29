"""Client de l'API publique n8n (en-tete X-N8N-API-KEY), identique en local, sur VPS et sur n8n Cloud."""

from __future__ import annotations

import re
from typing import Any

import httpx

# Repère de la carte d'origine laissée par le builder (voir generator.ORIGIN_MARK).
ORIGIN_MARK = "n8n-export-builder:source"


def _made_by_builder(w: dict[str, Any]) -> str | bool:
    """« carte » : envoyé avec sa carte d'origine ; « ancien » : généré par une version du builder qui n'en avait pas."""
    text = str(w.get("nodes") or "")
    return "carte" if ORIGIN_MARK in text else ("ancien" if "Généré par N8N Export Builder" in text else False)

KINDS = {
    "local": {"label": "Local", "hint": "http://localhost:5678",
              "help": "n8n sur votre poste (npx n8n ou Docker). Si le builder tourne dans Docker, utilisez http://host.docker.internal:5678."},
    "vps": {"label": "VPS", "hint": "https://n8n.mondomaine.fr",
            "help": "n8n auto-hébergé derrière HTTPS. Clé : Paramètres, API n8n, Créer une clé."},
    "cloud": {"label": "n8n Cloud", "hint": "https://monespace.app.n8n.cloud",
              "help": "Espace n8n Cloud. L'API publique est disponible hors période d'essai. Clé : Paramètres, API n8n."},
}


class N8nError(RuntimeError):
    def __init__(self, message: str, status: int | None = None):
        super().__init__(message)
        self.status = status


def normalize_url(url: str) -> str:
    url = (url or "").strip().rstrip("/")
    url = re.sub(r"/api/v1$", "", url)
    url = re.sub(r"/(home/workflows|workflows|signin)$", "", url)
    if not re.match(r"^https?://[^\s/]+", url):
        raise N8nError("Adresse invalide : attendu http(s)://hôte[:port].")
    return url


class N8nClient:
    def __init__(self, url: str, key: str, transport: httpx.AsyncBaseTransport | None = None, timeout: float = 20):
        self.url = normalize_url(url)
        self._client = httpx.AsyncClient(base_url=self.url + "/api/v1", timeout=timeout, transport=transport,
                                         headers={"X-N8N-API-KEY": key, "Accept": "application/json"})

    async def __aenter__(self) -> "N8nClient":
        return self

    async def __aexit__(self, *exc: Any) -> None:
        await self._client.aclose()

    async def _req(self, method: str, path: str, **kw: Any) -> Any:
        try:
            r = await self._client.request(method, path, **kw)
        except httpx.HTTPError as e:
            raise N8nError(f"n8n injoignable à {self.url} ({e.__class__.__name__}).") from e
        if r.status_code == 401:
            raise N8nError("Clé d'API n8n refusée.", 401)
        if r.status_code == 403:
            raise N8nError("Accès refusé : la clé n'a pas le droit nécessaire (portée de la clé, ou API absente de l'offre).", 403)
        if r.status_code == 404 and path.startswith("/workflows") and method == "GET":
            raise N8nError("API publique introuvable : vérifiez l'adresse et que l'API n'est pas désactivée (N8N_PUBLIC_API_DISABLED).", 404)
        if r.status_code >= 400:
            try:
                msg = r.json().get("message") or r.text
            except ValueError:
                msg = r.text
            raise N8nError(f"n8n répond {r.status_code} : {str(msg)[:400]}", r.status_code)
        if not r.content:
            return {}
        return r.json()

    async def test(self) -> dict[str, Any]:
        data = await self._req("GET", "/workflows", params={"limit": 1})
        return {"ok": True, "has_workflows": bool(data.get("data"))}

    async def workflows(self, limit: int = 100) -> list[dict[str, Any]]:
        data = await self._req("GET", "/workflows", params={"limit": limit})
        return [{"id": w.get("id"), "name": w.get("name"), "active": w.get("active"), "updatedAt": w.get("updatedAt"),
                 "tags": [t.get("name") for t in w.get("tags") or []],
                 "builder": _made_by_builder(w)} for w in data.get("data", [])]

    async def get_workflow(self, wid: str) -> dict[str, Any]:
        return await self._req("GET", f"/workflows/{wid}")

    async def create_workflow(self, payload: dict[str, Any]) -> dict[str, Any]:
        return await self._req("POST", "/workflows", json=payload)

    async def update_workflow(self, wid: str, payload: dict[str, Any]) -> dict[str, Any]:
        return await self._req("PUT", f"/workflows/{wid}", json=payload)

    async def activate(self, wid: str) -> dict[str, Any]:
        return await self._req("POST", f"/workflows/{wid}/activate")

    async def create_credential(self, name: str, ctype: str, data: dict[str, Any]) -> dict[str, str]:
        res = await self._req("POST", "/credentials", json={"name": name, "type": ctype, "data": data})
        return {"id": str(res["id"]), "name": res.get("name", name)}

    def editor_url(self, wid: str) -> str:
        return f"{self.url}/workflow/{wid}"

    def webhook_url(self, path: str) -> str:
        return f"{self.url}/webhook/{path}"
