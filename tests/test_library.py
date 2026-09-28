"""Chaque modele de la bibliotheque rend la bonne route sur des cas choisis : le code genere est execute sous Node."""

import json
import shutil
import subprocess

import pytest

from n8n_builder import templates
from n8n_builder.generator import build
from n8n_builder.spec import validate

NODE = shutil.which("node")
pytestmark = pytest.mark.skipif(not NODE, reason="node absent")

RUNNER = r"""
const { wf, inputs, answers, webhook } = JSON.parse(require('fs').readFileSync(0, 'utf8'));
const code = n => wf.nodes.find(x => x.name === n).parameters.jsCode;
const statics = {};
const out = [];
for (const input of inputs) {
  const refs = {};
  const run = (n, items) => { const o = new Function('$input', '$', '$getWorkflowStaticData', code(n))(
    { all: () => items }, m => ({ all: () => refs[m] }), () => statics); refs[n] = o; return o; };
  const prep = run('Préparer les données', [{ json: webhook ? { body: input } : input }]);
  const q = prep[0].json.questions;
  const a = {};
  for (const [id, x] of Object.entries(q)) {
    const want = answers[id] !== undefined ? answers[id] : (answers['*' + x.type] !== undefined ? answers['*' + x.type] : null);
    if (x.type === 'noul') a[id] = { type: 'noul', noul: want ?? 0.1 };
    else if (x.type === 'choice') { const k = Object.keys(x.criteria); const c = want ?? k[0]; a[id] = { type: 'choice', choice: c, confidence: 0.9, probabilities: Object.fromEntries(k.map(o => [o, o === c ? 0.9 : 0.1 / (k.length - 1)])) }; }
    else a[id] = { type: 'score', score: want ?? 0, confidence: 0.9, legend: {} };
  }
  const usesJev = wf.nodes.some(n => n.name === 'Jev (TypeSafe)');
  const d = run('Décision déterministe', usesJev ? [{ json: { model: 't', answers: a } }] : prep)[0].json;
  out.push({ route: d.route, reason: d.reason, vars: d.vars, extra: d.extra, questions: Object.keys(q) });
}
process.stdout.write(JSON.stringify(out));
"""


def run(tid, inputs, answers=None):
    s = validate(templates.get(tid)["spec"])
    payload = {"wf": build(s), "inputs": inputs, "answers": answers or {}, "webhook": s["trigger"]["type"] == "webhook"}
    res = subprocess.run([NODE, "-e", RUNNER], input=json.dumps(payload), capture_output=True, text=True)
    assert res.returncode == 0, res.stderr[-800:]
    return json.loads(res.stdout)


def route(tid, inp, answers=None):
    return run(tid, [inp], answers)[0]


def test_library_has_fifty_templates_of_three_levels():
    assert len(templates.TEMPLATES) == 50
    assert {t["niveau"] for t in templates.TEMPLATES} == {1, 2, 3}
    assert len({t["id"] for t in templates.TEMPLATES}) == 50


@pytest.mark.parametrize("tid", [t["id"] for t in templates.TEMPLATES if t["spec"]["trigger"]["type"] != "schedule"])
def test_every_template_runs_on_its_sample(tid):
    s = validate(templates.get(tid)["spec"])
    sample = s["sample"][0] if isinstance(s["sample"], list) else s["sample"]
    r = route(tid, sample)
    assert r["route"], r


def test_iban_siren():
    ok = {"iban": "FR76 3000 6000 0112 3456 7890 189", "siren": "552100554", "siret": "55210055400005"}
    assert route("code-iban-siren", ok)["route"] == "valide"
    assert route("code-iban-siren", {**ok, "iban": "FR76 3000 6000 0112 3456 7890 188"})["route"] == "iban_invalide"
    assert route("code-iban-siren", {**ok, "siren": "552100555"})["route"] == "siren_invalide"
    assert route("code-iban-siren", {**ok, "siret": "44306184100010"})["route"] == "siret_incoherent"


def test_sla():
    assert route("code-sla-tickets", {"priorite": "P1", "ouvert_le": "2020-01-01T00:00:00Z"})["route"] == "en_retard"
    assert route("code-sla-tickets", {"priorite": "P9", "ouvert_le": "2020-01-01"})["route"] == "a_revoir"
    assert route("code-sla-tickets", {"priorite": "P4", "ouvert_le": "2099-01-01T00:00:00Z"})["route"] == "dans_les_temps"
    assert route("code-sla-tickets", {"priorite": "P1", "ouvert_le": "2020-01-01", "resolu_le": "2020-01-01"})["route"] == "clos"


def test_tva():
    assert route("code-controle-tva", {"ht": 100, "tva": 20, "ttc": 120})["route"] == "conforme"
    assert route("code-controle-tva", {"ht": 100, "tva": 5.5, "ttc": 105.5})["route"] == "conforme"
    assert route("code-controle-tva", {"ht": 100, "tva": 20, "ttc": 125})["route"] == "incoherente"
    assert route("code-controle-tva", {"ht": 100, "tva": 15, "ttc": 115})["route"] == "taux_inconnu"


def test_duplicate_invoices_use_memory():
    a = {"fournisseur": "Bureau Plus", "numero": "F-1", "montant": 100, "date": "2026-09-01"}
    b = {"fournisseur": "bureau  plus", "numero": "F 1", "montant": 100, "date": "2026-09-02"}
    c = {"fournisseur": "Bureau Plus", "numero": "F-2", "montant": 100, "date": "2026-09-10"}
    d = {"fournisseur": "Bureau Plus", "numero": "F-3", "montant": 55, "date": "2026-09-11"}
    assert [r["route"] for r in run("code-doublon-facture", [a, b, c, d])] == ["nouvelle", "doublon_exact", "doublon_probable", "nouvelle"]


def test_contact_normalisation():
    r = route("code-contact-normalisation", {"email": " A@B.FR ", "telephone": "06 12 34 56 78", "code_postal": "69003"})
    assert r["route"] == "complet" and r["vars"]["normalise"] == {"email": "a@b.fr", "telephone": "+33612345678", "code_postal": "69003"}
    assert route("code-contact-normalisation", {"email": "pas-un-email", "telephone": "0612345678"})["route"] == "invalide"


def test_metrics_and_formats():
    assert route("code-metriques-serveur", {"cpu": 97, "disque": 50})["route"] == "critique"
    assert route("code-metriques-serveur", {"cpu": 10, "latence_ms": 900})["route"] == "alerte"
    assert route("code-metriques-serveur", {"autre": 1})["route"] == "a_revoir"
    r = route("code-declinaison-formats", {"texte_ecran": "Court", "formats": ["9:16", "4:3"]})
    assert r["route"] == "corriger"
    r = route("code-declinaison-formats", {"texte_ecran": "Court"})
    assert r["route"] == "pret" and [p["format"] for p in r["vars"]["plans"]] == ["9:16", "1:1", "16:9"]


def test_spam_form():
    assert route("jev-spam-formulaire", {"message": "x", "site_web_cache": "http://bot"})["route"] == "spam"
    assert route("jev-spam-formulaire", {"message": "a https://1 https://2 https://3"})["route"] == "spam"
    assert route("jev-spam-formulaire", {"message": "Devis ?"}, {"spam": 0.1})["route"] == "legitime"
    assert route("jev-spam-formulaire", {"message": "Hmm"}, {"spam": 0.5})["route"] == "a_revoir"


def test_self_consistency_vote():
    assert route("jev-auto-coherence", {"texte": "x"}, {"*noul": 0.9})["route"] == "oui"
    assert route("jev-auto-coherence", {"texte": "x"}, {"v1": 0.9, "v2": 0.2, "v3": 0.8})["route"] == "desaccord"


def test_hierarchical_classification():
    r = route("jev-classification-hierarchique", {"message": "x"}, {"famille": "paiement", "sous_paiement": "prelevement_refuse"})
    assert r["route"] == "precis" and r["extra"]["categorie"] == "paiement/prelevement_refuse"
    r = route("jev-classification-hierarchique", {"message": "x"}, {"famille": "paiement", "sous_paiement": "autre"})
    assert r["route"] == "famille_seule"


def test_date_extraction_only_returns_dates_from_text():
    r = route("jev-extraction-date", templates.get("jev-extraction-date")["spec"]["sample"], {"paiement_mentionne": 0.9, "echeance": "c2"})
    assert [c["iso"] for c in r["vars"]["candidates"]] == ["2026-09-12", "2026-10-20", "2026-10-15"]
    assert r["route"] == "date_trouvee" and r["extra"]["date_iso"] == "2026-10-15"
    r = route("jev-extraction-date", {"texte": "Merci pour votre message."}, {"paiement_mentionne": 0.9})
    assert r["route"] == "aucune"


def test_function_calling():
    r = route("jev-appel-fonction", {"demande": "x"}, {"fonction": "deplacer_rdv", "jour": "jeudi", "moment": "matin"})
    assert r["route"] == "executer" and r["extra"]["appel"] == {"fonction": "deplacer_rdv", "arguments": {"jour": "jeudi", "moment": "matin"}}
    r = route("jev-appel-fonction", {"demande": "x"}, {"fonction": "creer_rdv", "jour": "non_precise", "moment": "matin"})
    assert r["route"] == "demander_precision"


def test_itil_matrix():
    assert route("jev-priorite-itil", {"ticket": "x"}, {"impact": 3, "urgence": 3})["route"] == "p1"
    assert route("jev-priorite-itil", {"ticket": "x"}, {"impact": 0, "urgence": 0})["route"] == "p4"
    assert route("jev-priorite-itil", {"ticket": "x"}, {"impact": 2.2, "urgence": 1})["route"] == "p2"


def test_contract_clauses_fan_out():
    sample = templates.get("jev-clauses-contrat")["spec"]["sample"]
    r = route("jev-clauses-contrat", sample, {"clause_1": "responsabilite_illimitee"})
    assert r["questions"] == ["clause_0", "clause_1", "clause_2"]
    assert r["route"] == "risques_majeurs" and r["extra"]["alertes"][0]["risque"] == "responsabilite_illimitee"
    assert route("jev-clauses-contrat", sample, {"*choice": "aucun"})["route"] == "sans_alerte"


def test_supplier_iban_fraud_memory():
    first = {"fournisseur": "Bureau Plus", "iban": "FR7630006000011234567890189", "message": "Facture jointe."}
    changed = {**first, "iban": "FR1420041010050500013M02606", "message": "Nouveau RIB, urgent et confidentiel."}
    r = run("jev-fraude-fournisseur", [first, changed], {"pression": 0.9})
    assert [x["route"] for x in r] == ["normal", "bloquer"]


def test_google_ads_negatives():
    sample = templates.get("jev-google-ads-termes")["spec"]["sample"]
    r = route("jev-google-ads-termes", sample, {"termes__0": 0.9, "termes__1": 0.1, "termes__2": 0.2, "termes__3": 0.8})
    assert r["route"] == "proposer_negatifs"
    assert r["extra"]["negatifs_proposes"] == ["comptable freelance paris", "formation comptabilité gratuite"]


def test_bank_reconciliation_by_label():
    sample = templates.get("jev-rapprochement-libelle")["spec"]["sample"]
    r = route("jev-rapprochement-libelle", sample, {"facture": "c0"})
    assert r["questions"] == ["facture"] and r["route"] == "rapproche" and r["extra"]["facture"] == "F-2026-0412"


def test_moderation_labels():
    r = route("jev-moderation-commentaires", {"commentaire": "x"}, {"probleme__arnaque": 0.9})
    assert r["route"] == "signaler" and r["vars"]["probleme_verdict"] == ["arnaque"]
    assert route("jev-moderation-commentaires", {"commentaire": "x"}, {"question_client": 0.8})["route"] == "repondre"


def test_credit_ratios():
    base = {"revenus_mensuels": 3000, "charges_mensuelles": 300, "mensualite_demandee": 600, "commentaire": "x"}
    assert route("jev-credit-synthese", base)["route"] == "standard"
    assert route("jev-credit-synthese", {**base, "mensualite_demandee": 900})["route"] == "hors_norme"
    assert route("jev-credit-synthese", {**base, "revenus_mensuels": 0})["route"] == "a_revoir"


def test_returns_policy():
    assert route("jev-retour-produit", {"livre_le": "2099-01-01", "montant": 50, "message": "x"}, {"motif": "changement_avis"})["route"] == "retour_standard"
    assert route("jev-retour-produit", {"livre_le": "2020-01-01", "montant": 50, "message": "x"}, {"motif": "defaut"})["route"] == "garantie"
    assert route("jev-retour-produit", {"livre_le": "2020-01-01", "montant": 50, "message": "x"}, {"motif": "changement_avis"})["route"] == "hors_delai"


def test_candidates_are_never_rejected_automatically():
    s = validate(templates.get("jev-candidatures")["spec"])
    assert not any("refus" in r for r in s["decision"]["routes"])
    assert route("jev-candidatures", {"cv": "x"}, {"adequation": 0.2})["route"] == "peu_adapte_a_valider"
