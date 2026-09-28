import json
import shutil
import subprocess

import pytest

from n8n_builder import generator as G
from n8n_builder import templates
from n8n_builder.spec import SpecError, routes_of, validate

NODE = shutil.which("node")


def built(tid, creds=None):
    s = validate(templates.get(tid)["spec"])
    return s, G.build(s, creds)


@pytest.mark.parametrize("tid", [t["id"] for t in templates.TEMPLATES])
def test_every_template_builds_a_consistent_graph(tid):
    s, wf = built(tid)
    names = [n["name"] for n in wf["nodes"]]
    assert len(names) == len(set(names))
    assert len({n["id"] for n in wf["nodes"]}) == len(names)
    for src, outs in wf["connections"].items():
        assert src in names
        for branch in outs["main"]:
            for link in branch:
                assert link["node"] in names
    # chaque noeud (hors note) est atteignable depuis le declencheur
    reach, todo = set(), ["Déclencheur"]
    while todo:
        n = todo.pop()
        if n in reach:
            continue
        reach.add(n)
        for branch in wf["connections"].get(n, {}).get("main", []):
            todo += [l["node"] for l in branch]
    assert reach == {n for n in names if n != "Note"}
    routes = routes_of(s)
    if len(routes) > 1:
        sw = next(n for n in wf["nodes"] if n["name"] == "Aiguillage")
        assert [v["outputKey"] for v in sw["parameters"]["rules"]["values"]] == routes
        assert len(wf["connections"]["Aiguillage"]["main"]) == len(routes)
    if s["trigger"]["type"] == "webhook":
        assert any(n["type"] == "n8n-nodes-base.respondToWebhook" for n in wf["nodes"])


def test_api_payload_only_has_fields_accepted_by_n8n():
    _, wf = built("hub-support-triage")
    assert set(G.api_payload(wf)) == {"name", "nodes", "connections", "settings"}


def test_nodes_use_only_keys_known_by_n8n():
    allowed = {"id", "name", "type", "typeVersion", "position", "parameters", "credentials", "webhookId", "notes",
               "notesInFlow", "retryOnFail", "maxTries", "waitBetweenTries", "onError"}
    for t in templates.TEMPLATES:
        _, wf = built(t["id"])
        for n in wf["nodes"]:
            assert set(n) <= allowed, (t["id"], set(n) - allowed)


def test_credentials_are_attached_when_given():
    creds = {"jev": {"id": "1", "name": "Jev"}, "llm": {"id": "2", "name": "LLM"}, "webhook": {"id": "3", "name": "Hook"}}
    raw = templates.get("hub-prospection-score")["spec"]
    raw["trigger"]["auth"] = "header"
    wf = G.build(validate(raw), creds)
    by = {n["name"]: n for n in wf["nodes"]}
    assert by["Jev (TypeSafe)"]["credentials"] == {"httpBearerAuth": creds["jev"]}
    assert by["LLM de secours"]["credentials"] == {"httpBearerAuth": creds["llm"]}
    assert by["Déclencheur"]["credentials"] == {"httpHeaderAuth": creds["webhook"]}
    assert by["Déclencheur"]["parameters"]["authentication"] == "headerAuth"


def test_ids_are_stable_between_builds():
    assert built("jev-garde-fou")[1] == built("jev-garde-fou")[1]


def test_ollama_local_llm_targets_docker_host_without_auth():
    raw = templates.get("jev-routage-intention")["spec"]
    raw["llm"] = {"route": "complexe", "provider": "ollama_local", "model": "qwen3:8b"}
    wf = G.build(validate(raw))
    llm = next(n for n in wf["nodes"] if n["name"] == "LLM de secours")
    assert llm["parameters"]["url"] == "http://host.docker.internal:11434/v1/chat/completions"
    assert "authentication" not in llm["parameters"]


def test_validation_reports_every_problem():
    with pytest.raises(SpecError) as e:
        validate({"name": "", "questions": {"Bad Id": {"type": "noul", "instructions": "x"},
                                            "c": {"type": "choice", "instructions": "x", "criteria": {"seule": None}},
                                            "s": {"type": "score", "instructions": "x", "criteria": ["un"]}},
                  "decision": {"mode": "rules", "routes": ["OK"]}})
    text = " ".join(e.value.errors)
    for needle in ("Nom", "identifiant invalide", "deux options", "2 à 10 niveaux", "Routes invalides"):
        assert needle in text


def test_jev_outage_never_lands_on_an_action_route():
    s = validate({"name": "x", "questions": {"q": {"type": "noul", "instructions": "?"}},
                  "decision": {"mode": "rules", "routes": ["traiter", "ignorer"], "default_route": "ignorer",
                               "rules": [{"when": [{"field": "q", "op": ">=", "value": 0.5}], "route": "traiter"}]}})
    assert s["decision"]["error_route"] == "a_revoir"
    assert "a_revoir" in routes_of(s)


def test_llm_route_must_exist():
    raw = templates.get("jev-routage-intention")["spec"]
    raw["llm"]["route"] = "inexistante"
    with pytest.raises(SpecError):
        validate(raw)


def test_curl_example_for_hub():
    s = validate(templates.get("hub-video-brief")["spec"])
    c = G.curl_example(s, "https://n8n.exemple.fr/")
    assert c.startswith("curl -X POST 'https://n8n.exemple.fr/webhook/video-brief'")


# Execution du JavaScript genere, comme dans n8n -------------------------------------------------------

RUNNER = r"""
const { wf, sample, answers, webhook } = JSON.parse(require('fs').readFileSync(0, 'utf8'));
const code = n => wf.nodes.find(x => x.name === n).parameters.jsCode;
const refs = {}, statics = {};
const run = (n, items) => { const out = new Function('$input', '$', '$getWorkflowStaticData', code(n))(
  { all: () => items }, m => ({ all: () => refs[m] }), () => statics); refs[n] = out; return out; };
const prep = run('Préparer les données', [{ json: webhook ? { body: sample } : sample }]);
const input = answers === undefined ? prep : [{ json: answers === null ? { error: { message: 'down' } } : { model: 'jev-test', answers } }];
const d = run('Décision déterministe', input)[0].json;
process.stdout.write(JSON.stringify({ prep: prep[0].json, d }));
"""


def execute(tid, answers=..., sample=None):
    s, wf = built(tid)
    payload = {"wf": wf, "sample": sample if sample is not None else s["sample"],
               "webhook": s["trigger"]["type"] == "webhook"}
    if answers is not ...:
        payload["answers"] = answers
    out = subprocess.run([NODE, "-e", RUNNER], input=json.dumps(payload), capture_output=True, text=True, check=True)
    return json.loads(out.stdout)


needs_node = pytest.mark.skipif(not NODE, reason="node absent")


@needs_node
def test_support_refund_goes_to_a_human():
    r = execute("hub-support-triage", {
        "service": {"type": "choice", "choice": "facturation", "confidence": 0.9, "probabilities": {}},
        "urgence": {"type": "noul", "noul": 0.2},
        "frustration": {"type": "score", "score": 0.4, "legend": {"0": "", "1": "", "2": ""}, "confidence": 0.8},
        "remboursement": {"type": "noul", "noul": 0.93}})
    assert r["d"]["route"] == "humain"
    assert "Remboursement" in r["d"]["reason"]
    assert r["prep"]["state"].startswith("Ça fait trois fois")


@needs_node
def test_support_dynamic_route_takes_the_choice():
    r = execute("hub-support-triage", {
        "service": {"type": "choice", "choice": "livraison", "confidence": 0.9, "probabilities": {}},
        "urgence": {"type": "noul", "noul": 0.1},
        "frustration": {"type": "score", "score": 0.2, "legend": {"0": "", "1": "", "2": ""}, "confidence": 0.8},
        "remboursement": {"type": "noul", "noul": 0.1}})
    assert r["d"]["route"] == "livraison"


@needs_node
def test_jev_outage_routes_to_review():
    assert execute("hub-support-triage", None)["d"]["route"] == "a_revoir"
    assert execute("jev-filtre-rag", None)["d"]["route"] == "revoir"


@needs_node
def test_invoice_level_is_pure_code():
    r = execute("hub-relance-niveau", sample={"montant": 9000, "echeance": "2020-01-01", "derniere_relance": None})
    assert r["d"]["route"] == "humain" and r["d"]["jev"] is None
    r = execute("hub-relance-niveau", sample={"montant": 90, "echeance": "2099-01-01"})
    assert r["d"]["route"] == "a_jour"


@needs_node
def test_video_brief_refuses_real_people():
    ans = {"accroche": {"type": "score", "score": 3, "legend": {"0": "", "1": "", "2": "", "3": ""}, "confidence": 0.9},
           "personne_reelle": {"type": "noul", "noul": 0.97}, "marque_tiers": {"type": "noul", "noul": 0.1},
           "sans_son": {"type": "noul", "noul": 0.9}}
    r = execute("hub-video-brief", ans)
    assert r["d"]["route"] == "refuser"
    ans["personne_reelle"]["noul"] = 0.02
    r = execute("hub-video-brief", ans)
    assert r["d"]["route"] == "generer"
    assert r["d"]["vars"]["dimensions"] == ["9:16 = 1080x1920", "1:1 = 1080x1080"]


@needs_node
def test_expense_ceiling_is_applied_after_rules():
    ans = {"categorie": {"type": "choice", "choice": "repas", "confidence": 0.9, "probabilities": {}},
           "invitation": {"type": "noul", "noul": 0.1}}
    r = execute("hub-notes-de-frais", ans)
    assert r["d"]["route"] == "hors_politique" and r["d"]["extra"]["plafond"] == 25


@needs_node
def test_kyc_lists_missing_documents():
    r = execute("hub-kyc-completude")
    assert r["d"]["route"] == "incomplet"
    assert r["d"]["vars"]["manquantes"] == ["liste_beneficiaires"]
    assert r["d"]["vars"]["beneficiaires_sans_piece"] == ["B. Roux"]


@needs_node
def test_rag_filter_builds_one_question_per_passage():
    r = execute("jev-filtre-rag", {"repondable": {"type": "noul", "noul": 0.9}, "p0": {"type": "noul", "noul": 0.2},
                                   "p1": {"type": "noul", "noul": 0.95}, "p2": {"type": "noul", "noul": 0.1}})
    assert set(r["prep"]["questions"]) == {"repondable", "p0", "p1", "p2"}
    assert r["d"]["route"] == "transmettre"
    assert r["d"]["extra"]["passages_retenus"] == ["Chaque salarié peut télétravailler jusqu'à deux jours par semaine."]


@needs_node
def test_choice_mode_uses_confidence_gate():
    low = {"consigne": {"type": "choice", "choice": "carrousel_instagram", "confidence": 0.4, "probabilities": {}}}
    assert execute("hub-choix-consigne", low)["d"]["route"] == "agent_decide"
    low["consigne"]["confidence"] = 0.8
    assert execute("hub-choix-consigne", low)["d"]["route"] == "carrousel_instagram"
