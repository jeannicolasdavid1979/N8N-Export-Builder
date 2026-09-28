"""Stockage local : fournisseurs, instances n8n, workflows enregistres.

Un seul fichier JSON dans le dossier de donnees. Les cles d'API sont chiffrees (Fernet) avec une cle
maitresse lue dans N8NB_SECRET_KEY ou generee au premier lancement dans <donnees>/.secret (droits 600).
Aucune cle n'est jamais renvoyee a l'interface : seulement ses quatre derniers caracteres.
"""

from __future__ import annotations

import json
import os
import secrets
import threading
import time
from pathlib import Path
from typing import Any

from cryptography.fernet import Fernet, InvalidToken


class Store:
    def __init__(self, data_dir: str | os.PathLike[str], secret_key: str | None = None):
        self.dir = Path(data_dir)
        self.dir.mkdir(parents=True, exist_ok=True)
        self.path = self.dir / "builder.json"
        self._lock = threading.RLock()
        self._fernet = Fernet(secret_key or self._load_secret())
        self._data: dict[str, Any] = {"providers": {}, "n8n": {}, "workflows": {}, "n8n_credentials": {}}
        if self.path.exists():
            self._data.update(json.loads(self.path.read_text(encoding="utf-8")))

    def _load_secret(self) -> bytes:
        env = os.environ.get("N8NB_SECRET_KEY")
        if env:
            return env.encode()
        f = self.dir / ".secret"
        if not f.exists():
            f.write_bytes(Fernet.generate_key())
            os.chmod(f, 0o600)
        return f.read_bytes().strip()

    def _save(self) -> None:
        tmp = self.path.with_suffix(".tmp")
        tmp.write_text(json.dumps(self._data, ensure_ascii=False, indent=1), encoding="utf-8")
        os.chmod(tmp, 0o600)
        tmp.replace(self.path)

    # Secrets --------------------------------------------------------------------------------------

    def _enc(self, value: str) -> str:
        return self._fernet.encrypt(value.encode()).decode()

    def _dec(self, value: str | None) -> str | None:
        if not value:
            return None
        try:
            return self._fernet.decrypt(value.encode()).decode()
        except InvalidToken:
            return None

    @staticmethod
    def hint(key: str | None) -> str | None:
        return f"…{key[-4:]}" if key and len(key) > 8 else ("définie" if key else None)

    # Fournisseurs ---------------------------------------------------------------------------------

    def provider(self, pid: str) -> dict[str, Any]:
        with self._lock:
            return dict(self._data["providers"].get(pid, {}))

    def provider_key(self, pid: str) -> str | None:
        return self._dec(self.provider(pid).get("key"))

    def set_provider(self, pid: str, *, key: str | None = None, clear_key: bool = False, **fields: Any) -> None:
        with self._lock:
            p = self._data["providers"].setdefault(pid, {})
            if key:
                p["key"] = self._enc(key.strip())
            if clear_key:
                p.pop("key", None)
            for k, v in fields.items():
                if v is None:
                    continue
                p[k] = v
            self._save()

    # Instances n8n --------------------------------------------------------------------------------

    def instances(self) -> list[dict[str, Any]]:
        with self._lock:
            out = []
            for iid, i in self._data["n8n"].items():
                pub = {k: v for k, v in i.items() if k != "key"}
                pub["id"] = iid
                pub["key_hint"] = self.hint(self._dec(i.get("key")))
                out.append(pub)
            return sorted(out, key=lambda x: x.get("created", 0))

    def instance(self, iid: str) -> dict[str, Any] | None:
        with self._lock:
            i = self._data["n8n"].get(iid)
            if not i:
                return None
            out = dict(i)
            out["id"] = iid
            out["key"] = self._dec(i.get("key"))
            return out

    def save_instance(self, iid: str | None, label: str, kind: str, url: str, key: str | None) -> str:
        with self._lock:
            iid = iid or "n8n_" + secrets.token_hex(4)
            cur = self._data["n8n"].get(iid, {"created": time.time()})
            cur.update({"label": label, "kind": kind, "url": url})
            if key:
                cur["key"] = self._enc(key.strip())
                self._data["n8n_credentials"].pop(iid, None)
            self._data["n8n"][iid] = cur
            self._save()
            return iid

    def update_instance(self, iid: str, **fields: Any) -> None:
        with self._lock:
            if iid in self._data["n8n"]:
                self._data["n8n"][iid].update(fields)
                self._save()

    def delete_instance(self, iid: str) -> bool:
        with self._lock:
            ok = self._data["n8n"].pop(iid, None) is not None
            self._data["n8n_credentials"].pop(iid, None)
            self._save()
            return ok

    def n8n_credential(self, iid: str, slot: str) -> dict[str, Any] | None:
        with self._lock:
            return self._data["n8n_credentials"].get(iid, {}).get(slot)

    def set_n8n_credential(self, iid: str, slot: str, value: dict[str, Any] | None) -> None:
        with self._lock:
            creds = self._data["n8n_credentials"].setdefault(iid, {})
            if value is None:
                creds.pop(slot, None)
            else:
                creds[slot] = value
            self._save()

    # Workflows enregistres ------------------------------------------------------------------------

    def workflows(self) -> list[dict[str, Any]]:
        with self._lock:
            return sorted(({"id": k, **v} for k, v in self._data["workflows"].items()),
                          key=lambda w: -w.get("updated", 0))

    def workflow(self, wid: str) -> dict[str, Any] | None:
        with self._lock:
            w = self._data["workflows"].get(wid)
            return {"id": wid, **w} if w else None

    def save_workflow(self, wid: str | None, spec: dict[str, Any]) -> str:
        with self._lock:
            wid = wid or "wf_" + secrets.token_hex(4)
            prev = self._data["workflows"].get(wid, {})
            self._data["workflows"][wid] = {"spec": spec, "updated": time.time(), "pushes": prev.get("pushes", [])}
            self._save()
            return wid

    def record_push(self, wid: str, push: dict[str, Any]) -> None:
        with self._lock:
            w = self._data["workflows"].get(wid)
            if w is not None:
                w.setdefault("pushes", []).insert(0, push)
                del w["pushes"][20:]
                self._save()

    def delete_workflow(self, wid: str) -> bool:
        with self._lock:
            ok = self._data["workflows"].pop(wid, None) is not None
            self._save()
            return ok
