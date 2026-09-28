import json
import shutil
import subprocess
import sys
from pathlib import Path

import pytest

from n8n_builder import economy, fiches, hubexport, jevlab
from n8n_builder.generator import build

NODE = shutil.which("node")
needs_node = pytest.mark.skipif(not NODE, reason="node absent")

RUNNER = r"""
const { wf, input, answers } = JSON.parse(require('fs').readFileSync(0, 'utf8'));
const code = n => wf.nodes.find(x => x.name === n).parameters.jsCode;
const refs = {};
const run = (n, items) => { const o = new Function('$input', '$', '$getWorkflowStaticData', code(n))(
  { all: () => items }, m => ({ all: () => refs[m] }), () => ({})); refs[n] = o; return o; };
const prep = run('Préparer les données', [{ json: { body: input } }]);
const d = run('Décision déterministe', [{ json: answers === null ? { error: { message: 'down' } } : { model: 't', answers } }])[0].json;
process.stdout.write(JSON.stringify({ questions: prep[0].json.questions, d }));
"""


def run(fid, input_, answers):
    f, s = jevlab.to_spec_or_error(fiches.get(fid)["fiche"])
    out = subprocess.run([NODE, "-e", RUNNER], input=json.dumps({"wf": build(s), "input": input_, "answers": answers}),
                         capture_output=True, text=True, check=True)
    return json.loads(out.stdout)


@pytest.mark.parametrize("fid", [f["id"] for f in fiches.FICHES])
def test_every_fiche_type_compiles(fid):
    f, s = jevlab.to_spec_or_error(fiches.get(fid)["fiche"])
    assert s["decision"]["verdicts"]
    build(s)


def test_fiche_errors_are_plain_language():
    with pytest.raises(jevlab.FicheError) as e:
        jevlab.validate_fiche({"name": "", "questions": [{"id": "q", "type": "noul", "question": "?", "seuil_oui": 20, "seuil_non": 60}],
                               "resultats": [{"id": "a"}], "regles": [{"si": [{"question": "q", "valeur": "peut_etre"}], "alors": "b"}]})
    text = " ".join(e.value.errors)
    for needle in ("Donnez un nom", "seuil du NON", "au moins deux résultats", "n'existe pas", "résultat par défaut"):
        assert needle in text


def test_rule_value_must_be_a_possible_answer():
    raw = fiches.get("tri-emails")["fiche"]
    raw["regles"][0]["si"][0]["valeur"] = "urgent"
    with pytest.raises(jevlab.FicheError) as e:
        jevlab.validate_fiche(raw)
    assert "n'est pas une réponse possible" in " ".join(e.value.errors)


def test_set_and_get_threshold_paths():
    f = jevlab.validate_fiche(fiches.get("tri-emails")["fiche"])
    assert jevlab.get_path(f, "questions.action.seuils") == {"seuil_oui": 65, "seuil_non": 35}
    g = jevlab.set_path(f, "questions.sujet.seuils", {"confiance_min": 80, "marge": 5})
    q = next(q for q in g["questions"] if q["id"] == "sujet")
    assert q["confiance_min"] == 80 and q["marge"] == 5


@needs_node
def test_noul_bands_and_score_tranches():
    ans = {"sujet": {"type": "choice", "choice": "incident", "confidence": 0.9, "probabilities": {"incident": 0.9, "facturation": 0.1}},
           "action": {"type": "noul", "noul": 0.66},
           "impact": {"type": "score", "score": 2.6, "confidence": 0.8, "legend": {}}}
    r = run("tri-emails", {"message": "x"}, ans)["d"]
    assert r["vars"]["action_verdict"] == "oui" and r["vars"]["impact_verdict"] == "fort" and r["route"] == "traiter_vite"
    ans["action"]["noul"] = 0.5
    assert run("tri-emails", {"message": "x"}, ans)["d"]["route"] == "a_relire"  # zone à vérifier


@needs_node
def test_choice_hesitation_uses_distribution():
    ans = {"sujet": {"type": "choice", "choice": "incident", "confidence": 0.7, "probabilities": {"incident": 0.48, "facturation": 0.44}},
           "action": {"type": "noul", "noul": 0.9}, "impact": {"type": "score", "score": 1, "confidence": 0.8, "legend": {}}}
    r = run("tri-emails", {"message": "x"}, ans)["d"]
    assert r["vars"]["sujet_verdict"] == "hesitation" and r["route"] == "a_relire"
    assert r["vars"]["sujet_classement"][0] == {"valeur": "incident", "probabilite": 0.48}


@needs_node
def test_multi_label_contains():
    ans = {"problemes__insulte": {"type": "noul", "noul": 0.2}, "problemes__haine": {"type": "noul", "noul": 0.1},
           "problemes__spam": {"type": "noul", "noul": 0.9}, "problemes__donnees_perso": {"type": "noul", "noul": 0.7},
           "question_client": {"type": "noul", "noul": 0.1}}
    r = run("moderation-commentaires", {"commentaire": "x"}, ans)["d"]
    assert r["vars"]["problemes_verdict"] == ["spam", "donnees_perso"] and r["route"] == "masquer"


@needs_node
def test_list_choice_maps_back_to_items():
    inp = {"demande": "?", "brouillons": ["A", "B", "C"]}
    out = run("meilleure-reponse", inp, {"meilleur": {"type": "choice", "choice": "c1", "confidence": 0.8,
                                                      "probabilities": {"c0": 0.1, "c1": 0.8, "c2": 0.1}},
                                         "sensible": {"type": "noul", "noul": 0.05}})
    assert out["questions"]["meilleur"]["criteria"] == {"c0": "A", "c1": "B", "c2": "C"}
    assert out["d"]["vars"]["meilleur_verdict"] == "B" and out["d"]["route"] == "envoyer"


@needs_node
def test_for_each_item():
    inp = {"lignes": ["Papier", "Voyage", "Stylos"]}
    ans = {"conformes__0": {"type": "noul", "noul": 0.9}, "conformes__1": {"type": "noul", "noul": 0.1},
           "conformes__2": {"type": "noul", "noul": 0.8}}
    out = run("lignes-facture", inp, ans)
    assert out["questions"]["conformes__1"]["instructions"]["element"] == "Voyage"
    assert "categories_autorisees" in out["questions"]["conformes__1"]["instructions"]
    assert out["d"]["vars"]["conformes_retenus"] == ["Papier", "Stylos"] and out["d"]["route"] == "a_justifier"


@needs_node
def test_jev_down_goes_to_configured_result():
    assert run("brief-video", {"idee": "x", "accroche": "y", "texte_ecran": "z"}, None)["d"]["route"] == "a_revoir"


def test_economy_favours_the_automaton():
    f, s = jevlab.to_spec_or_error(fiches.get("tri-emails")["fiche"])
    e = economy.estimate(s, 3.0, 15.0, 1000)
    assert e["economie"] > 0 and e["tokens_agent_epargnes"] > 0 and e["ratio"] > 1


HUB = Path("/tmp/claude-0/hubsrc")


@pytest.mark.skipif(not (HUB / "agent_hub").exists(), reason="sources du Hub absentes")
def test_exports_are_read_by_the_hub():
    sys.path.insert(0, str(HUB))
    from agent_hub.studio.apis import preview
    from agent_hub.studio.kitformat import parse_kit
    from agent_hub.studio.skills import parse_skill_md
    for item in fiches.FICHES:
        f, s = jevlab.to_spec_or_error(item["fiche"])
        parts = hubexport.bundle(s, "https://n8n.exemple.fr", f["tests"], f)
        kit = parse_kit(parts["kit.json"])
        assert len(kit["trials"]) == len([t for t in f["tests"] if t.get("attendu")])
        assert parse_skill_md(parts["SKILL.md"])["description"]
        op = preview(parts["openapi.json"], "auto", None)["operations"][0]
        assert op["unsupported"] is None and op["tool"]["input_schema"]["properties"]


def test_openapi_lists_routes_and_header_key():
    f, s = jevlab.to_spec_or_error(fiches.get("tri-emails")["fiche"])
    doc = hubexport.openapi(s, "https://n8n.exemple.fr/")
    op = doc["paths"]["/tri-des-e-mails-entrants"]["post"]
    assert doc["servers"][0]["url"] == "https://n8n.exemple.fr/webhook"
    assert op["responses"]["200"]["content"]["application/json"]["schema"]["properties"]["route"]["enum"] == \
        ["traiter_vite", "traiter", "classer", "a_relire"]
    assert doc["components"]["securitySchemes"]["cle_automate"]["name"] == "X-Builder-Key"
    assert "Préviens l'équipe" in op["description"]
