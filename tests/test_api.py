import base64
import json

import httpx
import pytest
import respx
from cryptography.fernet import Fernet
from fastapi.testclient import TestClient

from n8n_builder import templates
from n8n_builder.app import create_app
from n8n_builder.providers import extract_json, normalize_models

N8N = "http://n8n.test:5678"


@pytest.fixture
def mock():
    with respx.mock(assert_all_called=False) as r:
        yield r


def make(tmp_path, mock, password=""):
    app = create_app(str(tmp_path), Fernet.generate_key().decode(), password=password)
    return TestClient(app), app


def test_state_lists_providers_in_order(tmp_path, mock):
    c, _ = make(tmp_path, mock)
    ids = [p["id"] for p in c.get("/api/state").json()["providers"]]
    assert ids[:4] == ["openrouter", "ollama_cloud", "ollama_local", "typesafe"]


def test_keys_are_encrypted_and_never_returned(tmp_path, mock):
    c, _ = make(tmp_path, mock)
    r = c.put("/api/providers/openrouter", json={"key": "sk-or-v1-secret-1234"})
    assert r.json()["key_hint"] == "…1234"
    body = c.get("/api/state").text
    assert "secret" not in body
    assert "secret" not in (tmp_path / "builder.json").read_text()


def test_refresh_openrouter_models_live_format(tmp_path, mock):
    mock.get("https://openrouter.ai/api/v1/models").respond(json={"data": [
        {"id": "typesafe/jev-router", "name": "TypeSafe: Jev Router", "created": 20, "pricing": {"prompt": "-1", "completion": "-1"}},
        {"id": "anthropic/claude-sonnet-5", "name": "Claude Sonnet 5", "created": 10, "context_length": 1000000,
         "pricing": {"prompt": "0.000002", "completion": "0.00001"}},
        {"id": "qwen/qwen3.8-27b:free", "created": 5, "pricing": {"prompt": "0", "completion": "0"}}]})
    c, _ = make(tmp_path, mock)
    r = c.post("/api/providers/openrouter/refresh").json()
    assert [m["id"] for m in r["models"]][0] == "typesafe/jev-router"
    sonnet = next(m for m in r["models"] if m["id"] == "anthropic/claude-sonnet-5")
    assert sonnet["input"] == 2 and sonnet["output"] == 10 and sonnet["context"] == 1000000
    assert next(m for m in r["models"] if m["id"].endswith(":free"))["free"]
    assert c.get("/api/providers/openrouter/models?q=sonnet").json()["models"][0]["id"] == "anthropic/claude-sonnet-5"


def test_ollama_local_reads_api_tags(tmp_path, mock):
    route = mock.get("http://gpu.lan:11434/api/tags").respond(json={"models": [{"name": "qwen3:8b", "size": 5_200_000_000}]})
    c, _ = make(tmp_path, mock)
    c.put("/api/providers/ollama_local", json={"base_url": "http://gpu.lan:11434/v1"})
    r = c.post("/api/providers/ollama_local/refresh").json()
    assert route.called and r["models"][0] == {"id": "qwen3:8b", "name": "qwen3:8b", "created": None, "size_gb": 5.2}


def test_fixed_provider_url_cannot_be_redirected(tmp_path, mock):
    c, _ = make(tmp_path, mock)
    assert c.put("/api/providers/openrouter", json={"base_url": "https://evil.example"}).status_code == 400


def test_build_returns_workflow_and_warnings(tmp_path, mock):
    c, _ = make(tmp_path, mock)
    r = c.post("/api/build", json={"spec": templates.get("hub-support-triage")["spec"]}).json()
    assert r["routes"][-2:] == ["humain", "a_revoir"]
    assert any("anglais" in w for w in r["warnings"])
    assert r["curl"].startswith("curl")


def test_build_rejects_invalid_spec_with_details(tmp_path, mock):
    c, _ = make(tmp_path, mock)
    r = c.post("/api/build", json={"spec": {"name": "x", "questions": {"q": {"type": "maybe"}}}})
    assert r.status_code == 422 and r.json()["errors"]


def test_jev_ask_always_uses_official_url(tmp_path, mock):
    route = mock.post("https://api.typesafe.ai/v1/systemone").respond(json={"model": "jev-1.13.0", "answers": {
        "u": {"type": "noul", "noul": 0.9}}, "usage": {"input_tokens": 12, "output_tokens": 3}})
    c, _ = make(tmp_path, mock)
    c.put("/api/providers/typesafe", json={"key": "ts-key-abcdef"})
    r = c.post("/api/jev/ask", json={"state": "Au secours", "questions": {"u": {"type": "noul", "instructions": "?"}},
                                     "url": "https://evil.example/steal"})
    assert r.status_code == 200 and route.called
    sent = route.calls[0].request
    assert sent.headers["authorization"] == "Bearer ts-key-abcdef"
    assert json.loads(sent.content)["model"] == "jev-latest"


def test_jev_errors_are_readable(tmp_path, mock):
    mock.post("https://api.typesafe.ai/v1/systemone").respond(429, json={"detail": "slow down"})
    c, _ = make(tmp_path, mock)
    c.put("/api/providers/typesafe", json={"key": "ts-key-abcdef"})
    r = c.post("/api/jev/ask", json={"state": "x", "questions": {"u": {"type": "noul", "instructions": "?"}}})
    assert r.status_code == 502 and "débit" in r.json()["detail"]


def test_push_creates_credentials_workflow_and_activates(tmp_path, mock):
    creds = mock.post(f"{N8N}/api/v1/credentials").mock(side_effect=lambda req: httpx.Response(
        200, json={"id": "c" + str(len(creds.calls)), "name": json.loads(req.content)["name"]}))
    create = mock.post(f"{N8N}/api/v1/workflows").respond(json={"id": "wf42"})
    activate = mock.post(f"{N8N}/api/v1/workflows/wf42/activate").respond(json={"id": "wf42", "active": True})
    mock.get(f"{N8N}/api/v1/workflows").respond(json={"data": []})
    c, _ = make(tmp_path, mock)
    c.put("/api/providers/typesafe", json={"key": "ts-key-abcdef"})
    c.put("/api/providers/openrouter", json={"key": "sk-or-123456789"})
    iid = c.post("/api/n8n", json={"kind": "vps", "url": N8N + "/home/workflows", "key": "n8n-api-key"}).json()["id"]
    assert c.post(f"/api/n8n/{iid}/test").json()["ok"]
    spec = templates.get("hub-prospection-score")["spec"]
    spec["trigger"]["auth"] = "header"
    r = c.post(f"/api/n8n/{iid}/push", json={"spec": spec, "activate": True}).json()
    assert r["activated"] and r["editor_url"] == f"{N8N}/workflow/wf42"
    assert r["webhook_url"] == f"{N8N}/webhook/prospection-score"
    assert r["secret"] and r["secret"] in r["curl"]
    types = [json.loads(call.request.content)["type"] for call in creds.calls]
    assert types == ["httpBearerAuth", "httpBearerAuth", "httpHeaderAuth"]
    assert json.loads(creds.calls[0].request.content)["data"] == {"token": "ts-key-abcdef"}
    body = json.loads(create.calls[0].request.content)
    assert set(body) == {"name", "nodes", "connections", "settings"}
    assert create.calls[0].request.headers["x-n8n-api-key"] == "n8n-api-key"
    assert activate.called
    # second envoi : identifiants Jev et LLM reutilises, seule la cle du webhook est nouvelle
    c.post(f"/api/n8n/{iid}/push", json={"spec": spec, "activate": False})
    assert len(creds.calls) == 4


def test_push_reports_webhook_conflict(tmp_path, mock):
    mock.post(f"{N8N}/api/v1/workflows").respond(json={"id": "w1"})
    mock.post(f"{N8N}/api/v1/workflows/w1/activate").respond(409, json={"message": "There is a conflict with one of the webhooks."})
    c, _ = make(tmp_path, mock)
    iid = c.post("/api/n8n", json={"kind": "local", "url": N8N, "key": "k"}).json()["id"]
    r = c.post(f"/api/n8n/{iid}/push", json={"spec": templates.get("hub-relance-niveau")["spec"], "activate": True,
                                              "create_credentials": False}).json()
    assert not r["activated"] and "déjà pris" in r["activation_error"]


def test_custom_jev_url_never_receives_stored_key(tmp_path, mock):
    creds = mock.post(f"{N8N}/api/v1/credentials").respond(json={"id": "c1", "name": "x"})
    mock.post(f"{N8N}/api/v1/workflows").respond(json={"id": "w1"})
    c, _ = make(tmp_path, mock)
    c.put("/api/providers/typesafe", json={"key": "ts-key-abcdef"})
    iid = c.post("/api/n8n", json={"kind": "local", "url": N8N, "key": "k"}).json()["id"]
    spec = templates.get("jev-garde-fou")["spec"]
    spec["jev_url"] = "https://proxy.example/v1/systemone"
    r = c.post(f"/api/n8n/{iid}/push", json={"spec": spec}).json()
    sent = [json.loads(c.request.content) for c in creds.calls]
    assert all(c["type"] != "httpBearerAuth" and "ts-key" not in json.dumps(c) for c in sent)
    assert any("personnalisée" in n for n in r["notes"])


def test_update_existing_workflow(tmp_path, mock):
    put = mock.put(f"{N8N}/api/v1/workflows/old1").respond(json={"id": "old1"})
    c, _ = make(tmp_path, mock)
    iid = c.post("/api/n8n", json={"kind": "cloud", "url": "http://n8n.test:5678", "key": "k"}).json()["id"]
    r = c.post(f"/api/n8n/{iid}/push", json={"spec": templates.get("hub-kyc-completude")["spec"], "update_id": "old1",
                                              "create_credentials": False}).json()
    assert put.called and r["id"] == "old1"


def test_assistant_retries_once_with_errors(tmp_path, mock):
    good = {"name": "Tri CV", "questions": {"senior": {"type": "noul", "instructions": "Profil senior ?"}},
            "decision": {"mode": "rules", "routes": ["alerter", "classer"], "default_route": "classer",
                         "rules": [{"when": [{"field": "senior", "op": ">=", "value": 0.7}], "route": "alerter"}]},
            "sample": {"message": "CV"}}
    answers = iter(["```json\n{\"name\": \"\"}\n```", json.dumps(good)])
    chat = mock.post("https://openrouter.ai/api/v1/chat/completions").mock(side_effect=lambda req: httpx.Response(
        200, json={"choices": [{"message": {"content": next(answers)}}]}))
    c, _ = make(tmp_path, mock)
    c.put("/api/providers/openrouter", json={"key": "sk-or-123456789"})
    r = c.post("/api/assist", json={"provider": "openrouter", "model": "anthropic/claude-sonnet-5", "description": "Trier des CV"})
    assert r.status_code == 200, r.text
    assert r.json()["attempts"] == 2 and r.json()["routes"] == ["alerter", "classer", "a_revoir"]
    assert "Nom du workflow manquant" in json.loads(chat.calls[1].request.content)["messages"][1]["content"]


def test_saved_workflows_roundtrip(tmp_path, mock):
    c, _ = make(tmp_path, mock)
    wid = c.post("/api/workflows", json={"spec": templates.get("vierge")["spec"]}).json()["id"]
    assert c.get(f"/api/workflows/{wid}").json()["spec"]["name"] == "Nouveau workflow"
    assert c.get("/api/state").json()["workflows"][0]["id"] == wid
    assert c.delete(f"/api/workflows/{wid}").json()["deleted"]


def test_password_guard(tmp_path, mock):
    c, _ = make(tmp_path, mock, password="motdepasse")
    assert c.get("/api/state").status_code == 401
    ok = base64.b64encode(b"x:motdepasse").decode()
    assert c.get("/api/state", headers={"Authorization": "Basic " + ok}).status_code == 200


def test_index_served(tmp_path, mock):
    c, _ = make(tmp_path, mock)
    r = c.get("/")
    assert r.status_code == 200 and "N8N Export Builder" in r.text


def test_normalize_models_formats():
    assert normalize_models("gemini", {"data": [{"id": "models/gemini-3.8-flash"}]})[0]["id"] == "gemini-3.8-flash"
    assert normalize_models("typesafe", [{"id": "jev-latest", "description": "flagship"}])[0]["description"] == "flagship"
    assert normalize_models("ollama_cloud", {"object": "list", "data": [{"id": "glm-5.3", "created": 1}]})[0]["id"] == "glm-5.3"


def test_extract_json_handles_fences_and_prose():
    assert extract_json("Voici :\n```json\n{\"a\": 1}\n```") == {"a": 1}
    assert extract_json("Bien sûr {\"a\": {\"b\": 2}} voilà") == {"a": {"b": 2}}


# Labo Jev -------------------------------------------------------------------------------------------------

def _fiche():
    from n8n_builder import fiches
    return fiches.get("tri-emails")["fiche"]


def test_jevlab_compile_returns_possible_answers(tmp_path, mock):
    c, _ = make(tmp_path, mock)
    r = c.post("/api/jevlab/compile", json={"fiche": _fiche()}).json()
    assert r["reponses"]["action"]["valeurs"] == ["oui", "non", "a_verifier"]
    assert r["reponses"]["impact"]["valeurs"] == ["faible", "moyen", "fort", "incertain"]
    assert r["routes"] == ["traiter_vite", "traiter", "classer", "a_relire"]
    assert "action_verdict" in r["variables"]


def test_jevlab_fill_keeps_human_settings(tmp_path, mock):
    human = _fiche()
    human["ia"] = {"questions.action.seuils": {"origine": "humain", "pourquoi": ""}}
    for q in human["questions"]:
        if q["id"] == "action":
            q["seuil_oui"], q["seuil_non"] = 90, 10
    proposal = _fiche()
    for q in proposal["questions"]:
        if q["id"] == "action":
            q["seuil_oui"], q["seuil_non"] = 55, 45
    mock.post("https://openrouter.ai/api/v1/chat/completions").respond(json={"choices": [{"message": {"content": json.dumps(
        {"fiche": proposal, "pourquoi": {"questions.action.seuils": "Zone grise large", "objectif": "Clair"}})}}]})
    c, _ = make(tmp_path, mock)
    c.put("/api/providers/openrouter", json={"key": "sk-or-123456789"})
    r = c.post("/api/jevlab/fill", json={"provider": "openrouter", "model": "m", "description": "trier", "fiche": human})
    assert r.status_code == 200, r.text
    f = r.json()["fiche"]
    action = next(q for q in f["questions"] if q["id"] == "action")
    assert (action["seuil_oui"], action["seuil_non"]) == (90, 10)
    assert f["ia"]["objectif"] == {"origine": "ia", "pourquoi": "Clair"}


def test_jevlab_field_proposes_one_case(tmp_path, mock):
    mock.post("https://openrouter.ai/api/v1/chat/completions").respond(json={"choices": [{"message": {"content":
        '{"valeur": {"seuil_oui": 80, "seuil_non": 20}, "pourquoi": "Une erreur coûte cher ici."}'}}]})
    c, _ = make(tmp_path, mock)
    c.put("/api/providers/openrouter", json={"key": "sk-or-123456789"})
    r = c.post("/api/jevlab/field", json={"provider": "openrouter", "model": "m", "fiche": _fiche(), "path": "questions.action.seuils"}).json()
    assert r["valeur"] == {"seuil_oui": 80, "seuil_non": 20}
    assert r["fiche"]["ia"]["questions.action.seuils"]["pourquoi"] == "Une erreur coûte cher ici."


def test_jevlab_field_rejects_unknown_path(tmp_path, mock):
    c, _ = make(tmp_path, mock)
    c.put("/api/providers/openrouter", json={"key": "sk-or-123456789"})
    r = c.post("/api/jevlab/field", json={"provider": "openrouter", "model": "m", "fiche": _fiche(), "path": "ia"})
    assert r.status_code == 422


def test_export_zip_and_economy(tmp_path, mock):
    import io
    import zipfile
    c, _ = make(tmp_path, mock)
    r = c.post("/api/export/hub", json={"fiche": _fiche(), "base_url": "https://n8n.exemple.fr", "format": "zip"})
    names = zipfile.ZipFile(io.BytesIO(r.content)).namelist()
    assert set(names) == {"workflow-n8n.json", "SKILL.md", "kit.json", "LISEZMOI.md", "openapi.json", "fiche-jev.json"}
    e = c.post("/api/economy", json={"fiche": _fiche(), "calls": 500}).json()
    assert e["calls"] == 500 and e["economie"] > 0


def test_push_a_fiche(tmp_path, mock):
    mock.post(f"{N8N}/api/v1/credentials").respond(json={"id": "c1", "name": "x"})
    create = mock.post(f"{N8N}/api/v1/workflows").respond(json={"id": "w9"})
    c, _ = make(tmp_path, mock)
    iid = c.post("/api/n8n", json={"kind": "vps", "url": N8N, "key": "k"}).json()["id"]
    r = c.post(f"/api/n8n/{iid}/push", json={"fiche": _fiche()}).json()
    assert r["id"] == "w9" and r["webhook_url"].endswith("/webhook/tri-des-e-mails-entrants")
    assert json.loads(create.calls[0].request.content)["name"] == "Tri des e-mails entrants"


def test_saved_fiches(tmp_path, mock):
    c, _ = make(tmp_path, mock)
    fid = c.post("/api/jevlab/saved", json={"fiche": _fiche()}).json()["id"]
    assert c.get("/api/state").json()["mes_fiches"][0]["id"] == fid
    assert c.get(f"/api/jevlab/saved/{fid}").json()["fiche"]["name"] == "Tri des e-mails entrants"
