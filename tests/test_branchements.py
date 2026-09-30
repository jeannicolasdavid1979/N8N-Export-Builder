import json

import httpx
import pytest
import respx
from cryptography.fernet import Fernet
from fastapi.testclient import TestClient

from n8n_builder import branchements as B
from n8n_builder.app import create_app
from test_import import COMPTA, HANDMADE

N8N = "http://n8n.test:5678"


@pytest.fixture
def mock():
    with respx.mock(assert_all_called=False) as r:
        yield r


def prises(wf):
    return {p["id"]: p for p in B.lister(wf)}


def test_prises_of_a_workflow_with_jev_bodies_built_in_code():
    ps = prises(COMPTA)
    code = ps["Build State::code::typesafe/jev-1.13"]
    assert code["appels"] == ["Jev 1 Qualification", "Jev 2 Anomalie", "Jev 3 Gravité"] and code["occurrences"] == 3
    assert ps["OCR Vision::corps"]["modele"] == "openai/gpt-4o-mini" and ps["OCR Vision::corps"]["fournisseur_modifiable"]
    assert ps["Webhook Upload::path"]["valeur"] == "upload"
    assert ps["Jev 1 Qualification::aucun"]["via_code"]


def test_only_the_chosen_values_change():
    out, done, notes = B.appliquer(COMPTA, [{"id": "Build State::code::typesafe/jev-1.13", "modele": "~typesafe/jev-latest"},
                                            {"id": "Webhook Status::path", "valeur": "statut"}])
    changed = [n["name"] for n, m in zip(COMPTA["nodes"], out["nodes"]) if n != m]
    assert changed == ["Webhook Status", "Build State"] and len(done) == 2 and not notes
    code = next(n for n in out["nodes"] if n["name"] == "Build State")["parameters"]["jsCode"]
    assert code.count("'~typesafe/jev-latest'") == 3 and "jev-1.13" not in code
    assert code.replace("~typesafe/jev-latest", "typesafe/jev-1.13") == next(
        n for n in COMPTA["nodes"] if n["name"] == "Build State")["parameters"]["jsCode"]


def test_langchain_model_and_resource_locator():
    wf = {"name": "x", "nodes": [
        {"name": "Chat", "type": "@n8n/n8n-nodes-langchain.lmChatOpenRouter", "parameters": {"model": "openai/gpt-4o"}},
        {"name": "GPT", "type": "@n8n/n8n-nodes-langchain.lmChatOpenAi", "parameters": {"model": {"__rl": True, "value": "gpt-4o-mini", "mode": "list"}}},
    ], "connections": {}}
    ps = prises(wf)
    assert ps["Chat::param"]["fournisseur"] == "openrouter" and not ps["Chat::param"]["fournisseur_modifiable"]
    out, _, _ = B.appliquer(wf, [{"id": "Chat::param", "modele": "xiaomi/mimo-v2.6-flash"}, {"id": "GPT::param", "modele": "gpt-5-mini"}])
    assert out["nodes"][0]["parameters"]["model"] == "xiaomi/mimo-v2.6-flash"
    assert out["nodes"][1]["parameters"]["model"] == {"__rl": True, "value": "gpt-5-mini", "mode": "id"}
    with pytest.raises(B.BranchementErreur):
        B.appliquer(wf, [{"id": "Chat::param", "fournisseur": "mistral"}])


def test_provider_change_never_keeps_the_old_key():
    wf = {"name": "x", "nodes": [{"name": "LLM", "type": "n8n-nodes-base.httpRequest", "credentials": {"httpHeaderAuth": {"id": "7", "name": "Clé OpenRouter"}},
                                  "parameters": {"url": "https://openrouter.ai/api/v1/chat/completions", "authentication": "genericCredentialType",
                                                 "genericAuthType": "httpHeaderAuth", "jsonBody": '={{ {"model": "openai/gpt-4o-mini"} }}'}}], "connections": {}}
    out, done, notes = B.appliquer(wf, [{"id": "LLM::corps", "fournisseur": "mistral", "modele": "mistral-small-latest"}])
    n = out["nodes"][0]
    assert n["parameters"]["url"] == "https://api.mistral.ai/v1/chat/completions" and "credentials" not in n
    assert '"model": "mistral-small-latest"' in n["parameters"]["jsonBody"] and "choisissez l'identifiant Mistral AI" in notes[0]
    out, _, notes = B.appliquer(wf, [{"id": "LLM::corps", "fournisseur": "mistral"}], {"mistral": {"id": "c9", "name": "LLM Mistral AI (builder)"}})
    assert out["nodes"][0]["credentials"] == {"httpBearerAuth": {"id": "c9", "name": "LLM Mistral AI (builder)"}} and not notes
    for bad in ({"id": "LLM::corps", "modele": "x; rm -rf"}, {"id": "inconnu"}, {"id": "LLM::corps", "fournisseur": "anthropic"}):
        with pytest.raises(B.BranchementErreur):
            B.appliquer(wf, [bad])


def test_payload_keeps_only_settings_n8n_accepts():
    p = B.payload({**COMPTA, "settings": {"executionOrder": "v1", "binaryMode": "separate", "inconnu": 1}, "id": "9", "active": True})
    assert set(p) == {"name", "nodes", "connections", "settings"} and p["settings"] == {"executionOrder": "v1", "binaryMode": "separate"}


def test_routes_update_in_place_and_copy_with_builder_key(tmp_path, mock):
    c = TestClient(create_app(str(tmp_path), Fernet.generate_key().decode(), password=""))
    src = {**HANDMADE, "id": "b2", "nodes": HANDMADE["nodes"] + [
        {"name": "LLM HTTP", "type": "n8n-nodes-base.httpRequest", "parameters": {"url": "https://openrouter.ai/api/v1/chat/completions", "jsonBody": "{\"model\": \"openai/gpt-4o-mini\"}"}}]}
    mock.get(f"{N8N}/api/v1/workflows/b2").respond(json=src)
    put = mock.put(f"{N8N}/api/v1/workflows/b2").respond(json={"id": "b2"})
    post = mock.post(f"{N8N}/api/v1/workflows").respond(json={"id": "n1"})
    creds = mock.post(f"{N8N}/api/v1/credentials").respond(json={"id": "c1", "name": "LLM Mistral AI (builder)"})
    iid = c.post("/api/n8n", json={"kind": "vps", "url": N8N, "key": "k"}).json()["id"]
    r = c.post("/api/import/branchements", json={"instance": iid, "id": "b2"}).json()
    assert "LLM HTTP::corps" in {p["id"] for p in r["branchements"]} and r["modeles_jev"]["openrouter"]
    ch = [{"id": "LLM HTTP::corps", "modele": "openai/gpt-5-mini"}]
    r = c.post(f"/api/n8n/{iid}/adopter", json={"instance": iid, "id": "b2", "changements": ch, "update_id": "b2"}).json()
    assert r["remplace"] and r["id"] == "b2" and put.called and not post.called
    sent = json.loads(put.calls[0].request.content)
    assert set(sent) == {"name", "nodes", "connections", "settings"} and "gpt-5-mini" in json.dumps(sent)
    c.put("/api/providers/mistral", json={"key": "mk-123456"})
    r = c.post(f"/api/n8n/{iid}/adopter", json={"instance": iid, "id": "b2", "changements": [{"id": "LLM HTTP::corps", "fournisseur": "mistral"}]}).json()
    assert not r["remplace"] and r["id"] == "n1" and creds.called
    sent = json.loads(post.calls[0].request.content)
    assert sent["name"] == "Tri SAV (fait main) (branchements)"
    assert "mk-123456" not in json.dumps(sent)  # la clé va dans l'identifiant n8n, jamais dans le workflow
    r = c.post("/api/import/appliquer", json={"texte": json.dumps(COMPTA), "changements": [{"id": "Build State::code::typesafe/jev-1.13", "modele": "jev-latest"}]}).json()
    assert "jev-latest" in json.dumps(r["workflow"]) and r["changements"]
    assert c.post("/api/import/appliquer", json={"texte": json.dumps(COMPTA), "changements": [{"id": "x"}]}).status_code == 400
