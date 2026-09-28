import io
import re
import sys
import zipfile
from pathlib import Path

import pytest
from cryptography.fernet import Fernet
from fastapi.testclient import TestClient

from n8n_builder import skills
from n8n_builder.app import create_app

HUB = Path("/tmp/claude-0/hubsrc")


def client(tmp_path):
    return TestClient(create_app(str(tmp_path), Fernet.generate_key().decode(), password=""))


def test_bank_lists_five_skills():
    names = {s["name"] for s in skills.all_skills()}
    assert names == {"jev-typesafe", "n8n-essentiel", "n8n-export-builder", "labo-jev-fiches", "export-vers-le-hub"}
    assert all(s["description"] for s in skills.all_skills())


def test_every_documented_route_exists(tmp_path):
    """Le skill du builder ne cite que des routes qui existent : il ne doit pas dériver du code."""
    app = create_app(str(tmp_path), Fernet.generate_key().decode(), password="")
    real = {(m, r.path) for r in app.routes for m in getattr(r, "methods", set())}
    text = skills.get("n8n-export-builder")
    cited = re.findall(r"`(GET|POST|PUT|DELETE) (/api/[^` ]+)", text)
    assert len(cited) >= 12
    for method, path in cited:
        path = path.replace("{id}", "{tid}") if path.startswith("/api/templates") else path
        path = path.replace("{id}", "{fid}").replace("{instance}", "{iid}").replace("{nom}", "{name}")
        assert (method, path) in real, f"{method} {path} cité dans le skill mais absent de l'API"


def test_api_serves_skills(tmp_path):
    c = client(tmp_path)
    assert len(c.get("/api/skills").json()["skills"]) == 5
    r = c.get("/api/skills/jev-typesafe")
    assert r.status_code == 200 and "api.typesafe.ai/v1/systemone" in r.text
    assert c.get("/api/skills/..%2Fapp").status_code == 404
    names = zipfile.ZipFile(io.BytesIO(c.get("/api/skills.zip").content)).namelist()
    assert "labo-jev-fiches/SKILL.md" in names and len(names) == 5


@pytest.mark.skipif(not (HUB / "agent_hub").exists(), reason="sources du Hub absentes")
def test_hub_reads_every_skill():
    sys.path.insert(0, str(HUB))
    from agent_hub.studio.skills import parse_skill_md
    for s in skills.all_skills():
        parsed = parse_skill_md(skills.get(s["name"]))
        assert parsed["name"] == s["name"] and parsed["description"] and parsed["instructions"]
