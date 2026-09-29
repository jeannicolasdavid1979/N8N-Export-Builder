import json

import httpx
import pytest
import respx
from cryptography.fernet import Fernet
from fastapi.testclient import TestClient

from n8n_builder import fiches, generator, importer, jevlab, templates
from n8n_builder.app import create_app
from n8n_builder.spec import validate

N8N = "http://n8n.test:5678"

# Un workflow fait à la main : un classeur LLM, un LLM suivi d'une condition, une condition sur les données, une action.
HANDMADE = {
    "name": "Tri SAV (fait main)", "active": True,
    "nodes": [
        {"name": "Webhook", "type": "n8n-nodes-base.webhook", "parameters": {"path": "sav"}},
        {"name": "Classer", "type": "@n8n/n8n-nodes-langchain.textClassifier", "parameters": {
            "inputText": "={{ $json.body.message }}",
            "categories": {"categories": [{"category": "remboursement", "description": "demande d'argent"}, {"category": "livraison"}]}}},
        {"name": "Urgent ?", "type": "@n8n/n8n-nodes-langchain.chainLlm", "parameters": {"text": "Le client est-il furieux ? Réponds oui ou non."}},
        {"name": "Si oui", "type": "n8n-nodes-base.if", "parameters": {"conditions": {"string": [{"value1": "={{$json.text}}", "value2": "oui"}]}}},
        {"name": "Montant > 100", "type": "n8n-nodes-base.if", "parameters": {"conditions": {"number": [{"value1": "={{$json.montant}}", "value2": 100}]}}},
        {"name": "Slack", "type": "n8n-nodes-base.slack", "parameters": {"operation": "post"}},
        {"name": "Note", "type": "n8n-nodes-base.stickyNote", "parameters": {"content": "à revoir"}},
    ],
    "connections": {"Webhook": {"main": [[{"node": "Classer", "type": "main", "index": 0}, {"node": "Urgent ?", "type": "main", "index": 0}]]},
                    "Urgent ?": {"main": [[{"node": "Si oui", "type": "main", "index": 0}]]},
                    "Si oui": {"main": [[{"node": "Slack", "type": "main", "index": 0}], []]}},
}


@pytest.fixture
def mock():
    with respx.mock(assert_all_called=False) as r:
        yield r


def make(tmp_path):
    return TestClient(create_app(str(tmp_path), Fernet.generate_key().decode(), password=""))


@pytest.mark.parametrize("tid", [t["id"] for t in templates.TEMPLATES])
def test_builder_workflows_come_back_identical(tid):
    s = validate(templates.get(tid)["spec"])
    wf = json.loads(json.dumps(generator.build(s)))  # comme après un aller-retour par n8n
    o = importer.origin(wf)
    assert o["spec"] == s and o["fiche"] is None and o["modifications"] == []


@pytest.mark.parametrize("fid", [f["id"] for f in fiches.FICHES])
def test_fiche_comes_back_without_test_cases(fid):
    f, s = jevlab.to_spec_or_error(fiches.get(fid)["fiche"])
    o = importer.origin(generator.build(s, fiche=f))
    assert o["fiche"] == {**f, "tests": []} and o["spec"] == s


def test_changes_made_in_n8n_are_reported():
    s = validate(templates.get("hub-support-triage")["spec"])
    wf = generator.build(s)
    code = next(n for n in wf["nodes"] if n["name"] == "Décision déterministe")
    code["parameters"]["jsCode"] += "\n// ajout manuel"
    code["position"] = [0, 0]
    wf["nodes"].append({"name": "Gmail", "type": "n8n-nodes-base.gmail", "parameters": {}})
    mods = importer.modifications(wf, s)
    assert mods == ["Nœud ajouté dans n8n : « Gmail » (gmail)", "Nœud modifié dans n8n : « Décision déterministe »"]


def test_damaged_origin_card_falls_back_to_analysis():
    wf = generator.build(validate(templates.get("hub-support-triage")["spec"]))
    note = next(n for n in wf["nodes"] if n["name"] == generator.N_ORIGIN)
    note["parameters"]["content"] = note["parameters"]["content"].replace('"spec"', '"spek"')
    assert "illisible" in importer.origin(wf)["erreur"]


def test_handmade_workflow_analysis():
    a = importer.analyse(HANDMADE)
    assert a["noeuds"] == 6 and [x["nom"] for x in a["llm"]] == ["Classer", "Urgent ?"] and len(a["decision"]) == 2
    assert a["declencheur"][0]["detail"] == "webhook /sav" and a["action"][0]["nom"] == "Slack"
    c = " ".join(a["candidats"])
    assert "remboursement (demande d'argent), livraison" in c and "« Urgent ? » produit ce que teste une condition" in c
    assert "« Montant > 100 » est déjà une règle déterministe" in c
    assert "Le client est-il furieux" in importer.summary(a)


def test_parse_accepts_n8n_formats():
    assert len(importer.parse({"data": [HANDMADE, HANDMADE]})) == 2
    assert importer.parse(json.dumps([HANDMADE]))[0]["name"] == HANDMADE["name"]
    for bad in ("pas du json", {"name": "x"}, []):
        with pytest.raises(importer.ImportErreur):
            importer.parse(bad)


def test_import_routes(tmp_path, mock):
    c = make(tmp_path)
    s = validate(templates.get("hub-support-triage")["spec"])
    mine = generator.build(s)
    mock.get(f"{N8N}/api/v1/workflows").respond(json={"data": [{**mine, "id": "a1"}, {**HANDMADE, "id": "b2"}]})
    mock.get(f"{N8N}/api/v1/workflows/a1").respond(json={**mine, "id": "a1"})
    mock.get(f"{N8N}/api/v1/workflows/b2").respond(json={**HANDMADE, "id": "b2"})
    iid = c.post("/api/n8n", json={"kind": "vps", "url": N8N, "key": "k"}).json()["id"]
    assert [w["builder"] for w in c.get(f"/api/n8n/{iid}/workflows").json()["workflows"]] == ["carte", False]
    r = c.get(f"/api/n8n/{iid}/workflows/a1/import").json()
    assert r["id"] == "a1" and r["origine"]["spec"] == s and r["instance"] == iid
    r = c.post("/api/import/analyse", json={"texte": json.dumps(HANDMADE)}).json()["workflows"][0]
    assert r["origine"] is None and r["analyse"]["nom"] == "Tri SAV (fait main)"
    assert c.post("/api/import/analyse", json={"texte": "{}"}).status_code == 400

    fiche = fiches.get("tri-emails")["fiche"]
    calls = []
    mock.post("https://openrouter.ai/api/v1/chat/completions").mock(side_effect=lambda req: calls.append(json.loads(req.content)) or httpx.Response(
        200, json={"choices": [{"message": {"content": json.dumps({"fiche": {**fiche, "name": "Tri SAV"}, "pourquoi": {}})}}]}))
    c.put("/api/providers/openrouter", json={"key": "sk-or-v1-test"})
    r = c.post("/api/import/convertir", json={"provider": "openrouter", "model": "m", "instance": iid, "id": "b2"})
    assert r.status_code == 200, r.text
    assert r.json()["fiche"]["name"] == "Tri SAV" and r.json()["analyse"]["noeuds"] == 6
    assert "Le client est-il furieux" in calls[0]["messages"][1]["content"]
    r = c.post("/api/import/convertir", json={"provider": "openrouter", "model": "m", "texte": json.dumps([HANDMADE]), "index": 3})
    assert r.status_code == 400


@pytest.mark.parametrize("tid", [t["id"] for t in templates.TEMPLATES])
def test_old_builder_workflows_are_rebuilt_from_their_code(tid):
    """Workflows envoyés avant la carte d'origine : la spécification revient du code, et le code régénéré est identique."""
    s = validate(templates.get(tid)["spec"])
    wf = generator.build(s)
    wf["nodes"] = [n for n in wf["nodes"] if n["name"] != generator.N_ORIGIN]
    assert not importer.has_origin(wf)
    e = importer.entry(wf)
    o = e["origine"]
    assert o["reconstruit"] and o["modifications"] == []
    lost = {"sample", "route_notes", "hub", "tags", "description"}
    assert {k: v for k, v in o["spec"].items() if k not in lost} == {k: v for k, v in s.items() if k not in lost}


def test_old_builder_workflow_with_edited_code_is_reported():
    s = validate(templates.get("jev-routage-intention")["spec"])
    wf = generator.build(s)
    wf["nodes"] = [n for n in wf["nodes"] if n["name"] != generator.N_ORIGIN]
    dec = next(n for n in wf["nodes"] if n["name"] == generator.N_DECIDE)
    dec["parameters"]["jsCode"] = dec["parameters"]["jsCode"].replace("const CFG = {", "const CFG = {{")
    assert "illisible" in importer.entry(wf)["origine"]["erreur"]
    assert importer.reconstruct(HANDMADE) is None


def test_jev_calls_are_recognised_however_they_are_made():
    body = "={{ JSON.stringify({ model: 'jev-latest', state: $json.facture, questions: { tva_ok: { type: 'noul', instructions: 'TVA correcte ?' }, compte: { type: 'choice', instructions: 'Compte ?' } } }) }}"
    wf = {"name": "Compta Routeur", "nodes": [
        {"name": "Webhook", "type": "n8n-nodes-base.webhook", "parameters": {"path": "compta"}},
        {"name": "OCR Vision Mistral", "type": "n8n-nodes-base.httpRequest", "parameters": {"url": "https://api.mistral.ai/v1/chat/completions", "jsonBody": "={{ { model: 'pixtral-large' } }}"}},
        {"name": "Jev 1 Qualification", "type": "n8n-nodes-base.httpRequest", "parameters": {"url": "https://openrouter.ai/api/v1/systemone", "jsonBody": body}},
        {"name": "Jev 2 Imputation", "type": "@n8n/n8n-nodes-langchain.lmChatOpenRouter", "parameters": {"model": "~typesafe/jev-latest"}},
        {"name": "Jev 3 Plan", "type": "n8n-nodes-base.httpRequest", "parameters": {"url": "={{ $env.JEV_URL }}", "jsonBody": '{"model": "jev-1.13.0"}'}},
        {"name": "Contrôle anomalie", "type": "@n8n/n8n-nodes-langchain.chainLlm", "parameters": {"text": "Réponds par oui ou non : la facture est-elle cohérente ?"}},
        {"name": "Résumé", "type": "@n8n/n8n-nodes-langchain.chainLlm", "parameters": {"text": "Écris un mail au client."}},
        {"name": "Si TVA", "type": "n8n-nodes-base.if", "parameters": {"conditions": "={{ $('Jev 1 Qualification').item.json.answers.tva_ok.noul > 0.7 }}"}},
        {"name": "Slack", "type": "n8n-nodes-base.httpRequest", "parameters": {"url": "https://hooks.slack.com/x", "jsonBody": "={{ $('Jev 2 Imputation').item.json }}"}},
    ], "connections": {}}
    a = importer.analyse(wf)
    assert [x["nom"] for x in a["jev"]] == ["Jev 1 Qualification", "Jev 2 Imputation", "Jev 3 Plan"]
    assert [x["nom"] for x in a["llm"]] == ["OCR Vision Mistral", "Contrôle anomalie", "Résumé"]
    assert [x["nom"] for x in a["decision"]] == ["Si TVA"] and [x["nom"] for x in a["action"]] == ["Slack"]
    d = a["jev"][0]["detail"]
    assert "via OpenRouter" in d and "modèle jev-latest" in d and "tva_ok (noul), compte (choice)" in d
    c = a["candidats"]
    assert c[0].startswith("3 appels à Jev") and "un seul appel" in c[0]
    assert any("« OCR Vision Mistral » lit une image" in x for x in c)
    assert any("« Contrôle anomalie » semble juger" in x for x in c)
    assert any("« Résumé » rédige" in x for x in c)
