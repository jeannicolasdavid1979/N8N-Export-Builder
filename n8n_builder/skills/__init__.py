"""Banque de skills : ce qu'un agent doit savoir de Jev, de n8n et du builder, au format SKILL.md du Hub."""

from __future__ import annotations

import io
import re
import zipfile
from pathlib import Path
from typing import Any

ROOT = Path(__file__).parent


def _meta(text: str) -> dict[str, str]:
    m = re.match(r"^---\n(.*?)\n---\n", text, re.S)
    out: dict[str, str] = {}
    for line in (m.group(1).splitlines() if m else []):
        k, _, v = line.partition(":")
        out[k.strip()] = v.strip().strip('"')
    return out


def all_skills() -> list[dict[str, Any]]:
    out = []
    for p in sorted(ROOT.glob("*/SKILL.md")):
        text = p.read_text(encoding="utf-8")
        meta = _meta(text)
        out.append({"name": p.parent.name, "title": meta.get("name", p.parent.name),
                    "description": meta.get("description", ""), "chars": len(text)})
    return out


def get(name: str) -> str | None:
    if not re.match(r"^[a-z0-9-]{2,60}$", name):
        return None
    p = ROOT / name / "SKILL.md"
    return p.read_text(encoding="utf-8") if p.exists() else None


def zip_bytes() -> bytes:
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as z:
        for s in all_skills():
            z.writestr(f"{s['name']}/SKILL.md", get(s["name"]) or "")
    return buf.getvalue()
