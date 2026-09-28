"""Appel direct de Jev (TypeSafe AI) pour tester une specification avant de l'envoyer dans n8n.

POST https://api.typesafe.ai/v1/systemone, Authorization: Bearer <cle>
Corps : {"model", "state", "questions"} ; reponse : {"model", "answers", "usage"}.
"""

from __future__ import annotations

import json
from typing import Any

import httpx

from .spec import JEV_URL


class JevError(RuntimeError):
    def __init__(self, message: str, status: int | None = None):
        super().__init__(message)
        self.status = status


MESSAGES = {
    401: "Clé TypeSafe refusée.",
    422: "Requête refusée par Jev (question mal formée ou état trop long)",
    429: "Limite de débit Jev atteinte : réessayez dans quelques secondes.",
    529: "Jev est surchargé : réessayez dans quelques secondes.",
}


async def ask(key: str, state: Any, questions: dict[str, Any], model: str = "jev-latest", url: str = JEV_URL,
              client: httpx.AsyncClient | None = None) -> dict[str, Any]:
    if not key:
        raise JevError("Clé TypeSafe manquante : renseignez-la dans Modèles LLM, TypeSafe Jev.")
    if not questions:
        raise JevError("Aucune question à poser à Jev.")
    own = client is None
    client = client or httpx.AsyncClient(timeout=45)
    try:
        r = await client.post(url, headers={"Authorization": f"Bearer {key}", "Content-Type": "application/json"},
                              json={"model": model, "state": state, "questions": questions})
    except httpx.HTTPError as e:
        raise JevError(f"Jev injoignable : {e.__class__.__name__}") from e
    finally:
        if own:
            await client.aclose()
    if r.status_code >= 400:
        detail = ""
        try:
            detail = json.dumps(r.json(), ensure_ascii=False)[:500]
        except ValueError:
            detail = r.text[:300]
        base = MESSAGES.get(r.status_code, f"Jev répond {r.status_code}")
        raise JevError(f"{base} {detail}".strip(), r.status_code)
    return r.json()
