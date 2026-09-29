"""Labo Jev : une fiche en cases a remplir, lisible par un novice, remplie avec un LLM et ajustee par l'humain.

La fiche decrit un automate Jev en langage courant :
- l'entree (ce que l'automate recoit) et un exemple ;
- les questions posees a Jev, avec pour chacune ses reglages visibles : tranches de pourcentage qui font un
  OUI ou un NON, mots attendus pour un choix, niveaux d'un score, confiance minimale ;
- les resultats possibles et ce que l'agent doit faire pour chacun ;
- les regles « si ... alors ... » ecrites avec les verdicts (oui, non, a verifier, un mot, un niveau) ;
- des cas de test avec le resultat attendu, pour calibrer.

Chaque case garde son origine (ia, humain, calibrage) et, quand le LLM l'a remplie, sa justification :
l'humain voit ce que le LLM a prevu et corrige ce qu'il veut. A l'execution, aucun LLM : Jev et du code.
"""

from __future__ import annotations

import copy
import json
import re
from typing import Any

from . import providers as P
from .spec import ID_RE, ROUTE_RE, SpecError, slug, validate

FORMAT = 1
OPS = {"est": "==", "n_est_pas": "!=", "au_moins": ">=", "au_plus": "<=", "contient": "contains",
       "ne_contient_pas": "not_contains"}
OP_LABELS = {"est": "est", "n_est_pas": "n'est pas", "au_moins": "au moins", "au_plus": "au plus",
             "contient": "contient", "ne_contient_pas": "ne contient pas"}
TYPES = {
    "noul": "Oui / non",
    "choice": "Choix parmi des mots attendus",
    "score": "Score sur une échelle",
    "liste": "Choix dans une liste reçue en entrée",
    "etiquettes": "Étiquettes multiples",
    "pour_chaque": "Même question pour chaque élément d'une liste",
}
MAX_TESTS = 100
KINDS = ("auto", "humain", "blocage")


class FicheError(ValueError):
    def __init__(self, errors: list[str]):
        super().__init__("; ".join(errors))
        self.errors = errors


def _s(v: Any, limit: int = 2000) -> str:
    return v.strip()[:limit] if isinstance(v, str) else ""


def _pct(v: Any, default: int) -> int:
    try:
        return max(0, min(100, int(round(float(v)))))
    except (TypeError, ValueError):
        return default


def validate_fiche(raw: Any) -> dict[str, Any]:
    """Controle et normalise une fiche. Leve FicheError avec la liste des problemes, en langage courant."""
    err: list[str] = []
    if not isinstance(raw, dict):
        raise FicheError(["La fiche doit être un objet JSON."])
    f: dict[str, Any] = {"fiche": FORMAT}
    f["name"] = _s(raw.get("name"), 120)
    if not f["name"]:
        err.append("Donnez un nom à l'automate.")
    f["objectif"] = _s(raw.get("objectif"), 2000)
    e = raw.get("entree") if isinstance(raw.get("entree"), dict) else {}
    mode = e.get("mode") if e.get("mode") in ("field", "fields", "json") else "field"
    f["entree"] = {"mode": mode, "field": _s(e.get("field"), 60) or "message",
                   "fields": [x.strip() for x in e.get("fields") or [] if isinstance(x, str) and x.strip()][:20]}
    if mode == "fields" and not f["entree"]["fields"]:
        err.append("Entrée : indiquez au moins un champ.")
    f["exemple"] = raw.get("exemple") if isinstance(raw.get("exemple"), (dict, list, str)) else {}

    qs = []
    ids: set[str] = set()
    for i, q in enumerate(raw.get("questions") or [], 1):
        where = f"Question {i}"
        if not isinstance(q, dict):
            err.append(f"{where} : objet attendu.")
            continue
        qid = _s(q.get("id"), 48)
        if not ID_RE.match(qid) or qid in ids:
            err.append(f"{where} : identifiant « {qid} » invalide ou en double (minuscules, chiffres, _).")
            continue
        ids.add(qid)
        qtype = q.get("type")
        text = _s(q.get("question"), 3000)
        if qtype not in TYPES:
            err.append(f"{where} ({qid}) : type parmi {', '.join(TYPES)}.")
            continue
        if not text:
            err.append(f"{where} ({qid}) : écrivez la question posée à Jev.")
            continue
        item: dict[str, Any] = {"id": qid, "type": qtype, "question": text, "aide": _s(q.get("aide"), 500)}
        donnees = q.get("donnees")
        if isinstance(donnees, dict) and donnees:
            if len(json.dumps(donnees, ensure_ascii=False)) > 20000:
                err.append(f"{qid} : données de référence trop longues (20 000 caractères au plus).")
            item["donnees"] = donnees
        if qtype == "noul":
            oui, non = _pct(q.get("seuil_oui"), 70), _pct(q.get("seuil_non"), 30)
            if non > oui:
                err.append(f"{qid} : le seuil du NON ({non} %) doit rester sous celui du OUI ({oui} %).")
            item.update(seuil_oui=oui, seuil_non=non, oui_signifie=_s(q.get("oui_signifie"), 500),
                        non_signifie=_s(q.get("non_signifie"), 500))
        elif qtype in ("choice", "etiquettes"):
            opts = []
            for o in q.get("options") or []:
                if not isinstance(o, dict):
                    continue
                mot = _s(o.get("mot"), 30)
                if not ROUTE_RE.match(mot):
                    err.append(f"{qid} : mot attendu « {mot} » invalide (minuscules, chiffres, _).")
                    continue
                opts.append({"mot": mot, "description": _s(o.get("description"), 500)})
            need = 2 if qtype == "choice" else 1
            if len(opts) < need or len({o["mot"] for o in opts}) != len(opts):
                err.append(f"{qid} : au moins {need} mot(s) attendu(s), tous différents.")
            if len(opts) > (255 if qtype == "choice" else 40):
                err.append(f"{qid} : trop de mots attendus.")
            item["options"] = opts
            if qtype == "choice":
                item.update(confiance_min=_pct(q.get("confiance_min"), 60), marge=_pct(q.get("marge"), 0))
            else:
                item["seuil"] = _pct(q.get("seuil"), 60)
        elif qtype == "score":
            lv = [x.strip() for x in q.get("niveaux") or [] if isinstance(x, str) and x.strip()]
            if not 2 <= len(lv) <= 10:
                err.append(f"{qid} : de 2 à 10 niveaux, du plus bas au plus haut.")
            item.update(niveaux=lv, confiance_min=_pct(q.get("confiance_min"), 50))
            tr = []
            for t in q.get("tranches") or []:
                if isinstance(t, dict) and ROUTE_RE.match(_s(t.get("mot"), 30)):
                    try:
                        tr.append({"jusqu_a": round(float(t.get("jusqu_a")), 2), "mot": _s(t.get("mot"), 30)})
                    except (TypeError, ValueError):
                        err.append(f"{qid} : borne de tranche invalide.")
            if tr:
                au_dela = _s(q.get("au_dela"), 30)
                if not ROUTE_RE.match(au_dela):
                    err.append(f"{qid} : nommez la tranche au-delà de la dernière borne.")
                tr.sort(key=lambda t: t["jusqu_a"])
                item.update(tranches=tr, au_dela=au_dela)
        else:
            champ = _s(q.get("champ_liste"), 60)
            if not champ:
                err.append(f"{qid} : indiquez le champ de l'entrée qui contient la liste.")
            item.update(champ_liste=champ, champ_texte=_s(q.get("champ_texte"), 60))
            if qtype == "liste":
                item.update(confiance_min=_pct(q.get("confiance_min"), 60), marge=_pct(q.get("marge"), 0))
            else:
                item["seuil"] = _pct(q.get("seuil"), 60)
        qs.append(item)
    if not qs:
        err.append("Ajoutez au moins une question pour Jev.")
    f["questions"] = qs

    res = []
    for r in raw.get("resultats") or []:
        if not isinstance(r, dict):
            continue
        rid = _s(r.get("id"), 40)
        if not ROUTE_RE.match(rid):
            err.append(f"Résultat « {rid} » : identifiant invalide (minuscules, chiffres, _).")
            continue
        if any(x["id"] == rid for x in res):
            err.append(f"Résultat « {rid} » en double.")
            continue
        res.append({"id": rid, "label": _s(r.get("label"), 120) or rid, "consigne": _s(r.get("consigne"), 1000)})
    if len(res) < 2:
        err.append("Prévoyez au moins deux résultats possibles.")
    f["resultats"] = res
    rids = {r["id"] for r in res}

    qmap = {q["id"]: q for q in qs}
    rules = []
    for i, r in enumerate(raw.get("regles") or [], 1):
        if not isinstance(r, dict):
            continue
        alors = _s(r.get("alors"), 40)
        if alors not in rids:
            err.append(f"Règle {i} : le résultat « {alors} » n'existe pas.")
            continue
        conds = []
        for c in r.get("si") or []:
            if not isinstance(c, dict):
                continue
            q = qmap.get(c.get("question"))
            op = c.get("op") or "est"
            val = c.get("valeur")
            val = "" if val is None else str(val).strip()
            if not q or op not in OPS:
                err.append(f"Règle {i} : condition sur une question inconnue ou opérateur invalide.")
                continue
            if op not in ops_for(q):
                err.append(f"Règle {i} : l'opérateur « {OP_LABELS[op]} » ne s'applique pas à {q['id']}.")
                continue
            ok = allowed_values(q)
            if ok and val not in ok:
                err.append(f"Règle {i} : « {val} » n'est pas une réponse possible de {q['id']} ({', '.join(ok)}).")
                continue
            if not val:
                err.append(f"Règle {i} : valeur manquante pour {q['id']}.")
                continue
            conds.append({"question": q["id"], "op": op, "valeur": val})
        if not conds:
            err.append(f"Règle {i} : au moins une condition.")
            continue
        rules.append({"si": conds, "alors": alors, "pourquoi": _s(r.get("pourquoi"), 300)})
    f["regles"] = rules
    f["par_defaut"] = _s(raw.get("par_defaut"), 40)
    if f["par_defaut"] not in rids:
        err.append("Choisissez le résultat par défaut, quand aucune règle ne s'applique.")
    f["si_jev_indisponible"] = _s(raw.get("si_jev_indisponible"), 40) or ""
    if f["si_jev_indisponible"] and f["si_jev_indisponible"] not in rids:
        err.append("Le résultat en cas de panne de Jev doit faire partie des résultats.")

    tests = []
    for t in (raw.get("tests") or [])[:MAX_TESTS]:
        if not isinstance(t, dict) or t.get("entree") in (None, ""):
            continue
        attendus = {k: str(v) for k, v in (t.get("attendus") or {}).items() if k in qmap and v not in (None, "")}
        tests.append({"entree": t["entree"], "attendu": _s(t.get("attendu"), 40), "attendus": attendus,
                      "note": _s(t.get("note"), 300), "source": "ia" if t.get("source") == "ia" else "reel"})
    f["tests"] = tests
    # Salle de réglage : ce que coûte une erreur, ce que coûte un passage humain, et la nature de chaque voie.
    rg = raw.get("reglage") if isinstance(raw.get("reglage"), dict) else {}

    def _eur(v: Any, default: float) -> float:
        try:
            x = float(v)
        except (TypeError, ValueError):
            return default
        return min(max(x, 0.0), 1_000_000.0) if x == x else default
    voies = rg.get("voies") if isinstance(rg.get("voies"), dict) else {}
    f["reglage"] = {"cout_erreur": _eur(rg.get("cout_erreur"), 50.0), "cout_revue": _eur(rg.get("cout_revue"), 2.0),
                    "voies": {k: v for k, v in voies.items() if k in rids and v in KINDS}}
    f["jev_fournisseur"] = raw.get("jev_fournisseur") if raw.get("jev_fournisseur") in ("typesafe", "openrouter") else "typesafe"
    f["modele"] = _s(raw.get("modele"), 80) or ("~typesafe/jev-latest" if f["jev_fournisseur"] == "openrouter" else "jev-latest")
    f["declencheur"] = raw.get("declencheur") if raw.get("declencheur") in ("webhook", "manual") else "webhook"
    f["chemin"] = _s(raw.get("chemin"), 80)
    ia = raw.get("ia") if isinstance(raw.get("ia"), dict) else {}
    f["ia"] = {k: {"origine": v.get("origine") if v.get("origine") in ("ia", "humain", "calibrage") else "humain",
                   "pourquoi": _s(v.get("pourquoi"), 800)}
               for k, v in ia.items() if isinstance(k, str) and isinstance(v, dict)}
    # LLM facultatifs : un en entree (agentique), un par resultat ; valides a la compilation.
    f["llm_entree"] = raw.get("llm_entree") if isinstance(raw.get("llm_entree"), dict) else None
    f["llms"] = [x for x in raw.get("llms") or [] if isinstance(x, dict)][:10]
    hub = raw.get("hub") if isinstance(raw.get("hub"), dict) else {}
    f["hub"] = {k: _s(hub.get(k), 200) for k in ("playlist", "agent") if _s(hub.get(k))}
    if err:
        raise FicheError(err)
    return f


def allowed_values(q: dict[str, Any]) -> list[str]:
    """Reponses possibles d'une question, telles que les regles les ecrivent. Vide : valeur libre."""
    t = q["type"]
    if t == "noul":
        return ["oui", "non", "a_verifier"]
    if t == "choice":
        return [o["mot"] for o in q.get("options", [])] + ["incertain"] + (["hesitation"] if q.get("marge") else [])
    if t == "score":
        if q.get("tranches"):
            return [x["mot"] for x in q["tranches"]] + [q["au_dela"], "incertain"]
        return [str(i) for i in range(len(q.get("niveaux", [])))] + ["incertain"]
    if t == "etiquettes":
        return [o["mot"] for o in q.get("options", [])]
    if t == "pour_chaque":
        return ["tous", "certains", "aucun"]
    return []  # liste : valeur venue de l'entree, ou incertain, hesitation, aucun


def ops_for(q: dict[str, Any]) -> list[str]:
    t = q["type"]
    if t == "etiquettes":
        return ["contient", "ne_contient_pas"]
    if t == "score" and not q.get("tranches"):
        return ["est", "n_est_pas", "au_moins", "au_plus"]
    return ["est", "n_est_pas"]


def _instructions(q: dict[str, Any], extra: dict[str, Any] | None = None) -> Any:
    data = {**(q.get("donnees") or {}), **(extra or {})}
    return {**data, "question": q["question"]} if data else q["question"]


def _list_js(q: dict[str, Any], limit: int) -> str:
    champ, texte = json.dumps(q["champ_liste"]), json.dumps(q.get("champ_texte") or "")
    return (f"  const raw_{q['id']} = input[{champ}];\n"
            f"  const items_{q['id']} = (Array.isArray(raw_{q['id']}) ? raw_{q['id']} : []).slice(0, {limit}).map(it =>\n"
            f"    it !== null && typeof it === 'object' ? String(({texte} ? it[{texte}] : undefined) ?? JSON.stringify(it)) : String(it));\n"
            f"  vars['__{q['id']}'] = items_{q['id']};\n")


def compile_fiche(f: dict[str, Any]) -> dict[str, Any]:
    """Fiche validee vers specification du generateur (meme moteur que le Labo n8n)."""
    questions: dict[str, Any] = {}
    verdicts: dict[str, Any] = {}
    prep: list[str] = []
    for q in f["questions"]:
        qid = q["id"]
        if q["type"] == "noul":
            item: dict[str, Any] = {"type": "noul", "instructions": _instructions(q)}
            crit = {k: v for k, v in (("true", q.get("oui_signifie")), ("false", q.get("non_signifie"))) if v}
            if crit:
                item["criteria"] = crit
            questions[qid] = item
            verdicts[qid] = {"kind": "noul", "oui": q["seuil_oui"] / 100, "non": q["seuil_non"] / 100}
        elif q["type"] == "choice":
            questions[qid] = {"type": "choice", "instructions": _instructions(q),
                              "criteria": {o["mot"]: o["description"] or None for o in q["options"]}}
            verdicts[qid] = {"kind": "choice", "min": q["confiance_min"] / 100}
            if q.get("marge"):
                verdicts[qid]["marge"] = q["marge"] / 100
        elif q["type"] == "score":
            questions[qid] = {"type": "score", "instructions": _instructions(q), "criteria": q["niveaux"]}
            verdicts[qid] = {"kind": "score", "min": q["confiance_min"] / 100}
            if q.get("tranches"):
                verdicts[qid].update(cuts=[{"max": t["jusqu_a"], "label": t["mot"]} for t in q["tranches"]],
                                     **{"else": q["au_dela"]})
        elif q["type"] == "etiquettes":
            for o in q["options"]:
                questions[f"{qid}__{o['mot']}"] = {"type": "noul", "instructions": _instructions(
                    q, {"etiquette": o["mot"], "definition": o["description"] or o["mot"]})}
            verdicts[qid] = {"kind": "etiquettes", "seuil": q["seuil"] / 100, "labels": [o["mot"] for o in q["options"]]}
        elif q["type"] == "liste":
            instr = json.dumps(_instructions(q), ensure_ascii=False)
            prep.append(_list_js(q, 255) +
                        f"  if (items_{qid}.length >= 2) questions[{json.dumps(qid)}] = {{ type: 'choice', instructions: {instr},\n"
                        f"    criteria: Object.fromEntries(items_{qid}.map((t, i) => ['c' + i, t])) }};\n")
            verdicts[qid] = {"kind": "liste_choix", "min": q["confiance_min"] / 100}
            if q.get("marge"):
                verdicts[qid]["marge"] = q["marge"] / 100
        else:  # pour_chaque
            base = json.dumps(q.get("donnees") or {}, ensure_ascii=False)
            prep.append(_list_js(q, 200) +
                        f"  items_{qid}.forEach((t, i) => {{ questions['{qid}__' + i] = {{ type: 'noul',\n"
                        f"    instructions: Object.assign({{}}, {base}, {{ element: t, question: {json.dumps(q['question'], ensure_ascii=False)} }}) }}; }});\n")
            verdicts[qid] = {"kind": "pour_chaque", "seuil": q["seuil"] / 100}
    routes = [r["id"] for r in f["resultats"]]
    rules = []
    for r in f["regles"]:
        rules.append({"when": [{"field": c["question"] + "_verdict", "op": OPS[c["op"]], "value": c["valeur"]} for c in r["si"]],
                      "route": r["alors"], "label": r["pourquoi"] or describe_rule(r, f)})
    decision: dict[str, Any] = {"mode": "rules", "routes": routes, "rules": rules, "default_route": f["par_defaut"],
                                "verdicts": verdicts}
    if f["si_jev_indisponible"]:
        decision["error_route"] = f["si_jev_indisponible"]
    e = f["entree"]
    state = {"mode": e["mode"], "field": e["field"], "fields": e["fields"]}
    raw = {
        "name": f["name"], "description": f["objectif"],
        "trigger": {"type": f["declencheur"], "path": f["chemin"] or slug(f["name"]), "auth": "header"},
        "state": state, "model": f["modele"], "jev_provider": f["jev_fournisseur"], "questions": questions, "decision": decision,
        "prepare_js": "// Listes reçues en entrée : une question Jev construite pour chaque liste.\n" + "".join(prep) if prep else "",
        "sample": f["exemple"] if not isinstance(f["exemple"], str) else {e["field"]: f["exemple"]},
        "hub": f["hub"], "route_notes": {r["id"]: r["consigne"] for r in f["resultats"] if r["consigne"]},
        "tags": ["labo-jev"],
        "entree_llm": f.get("llm_entree"), "llms": f.get("llms") or [],
    }
    return validate(raw)


def describe_rule(r: dict[str, Any], f: dict[str, Any]) -> str:
    qmap = {q["id"]: q for q in f["questions"]}
    parts = []
    for c in r["si"]:
        q = qmap[c["question"]]
        v = c["valeur"]
        if q["type"] == "score" and not q.get("tranches") and v.isdigit():
            v = q["niveaux"][int(v)]
        parts.append(f"{c['question']} {OP_LABELS[c['op']]} {v}")
    return "Si " + " et ".join(parts)


def test_state(f: dict[str, Any], entree: Any) -> Any:
    """Transforme l'entree d'un cas de test en objet d'entree du workflow."""
    if isinstance(entree, str) and f["entree"]["mode"] == "field":
        return {f["entree"]["field"]: entree}
    if isinstance(entree, str):
        try:
            return json.loads(entree)
        except json.JSONDecodeError:
            return {f["entree"]["field"]: entree}
    return entree


# Remplissage par le LLM ------------------------------------------------------------------------------

FICHE_DOC = """Format de la fiche (JSON) :
{
  "name": "Nom court de l'automate",
  "objectif": "Ce que décide l'automate, en une ou deux phrases simples",
  "entree": {"mode": "field", "field": "message"}   (ou {"mode":"fields","fields":["a","b"]} ou {"mode":"json"}),
  "exemple": { exemple réaliste d'entrée },
  "questions": [ ... voir les six types ci-dessous ... ],
  "resultats": [{"id": "repondre_vite", "label": "Répondre dans l'heure", "consigne": "Ce que l'agent fait dans ce cas"}],
  "regles": [{"si": [{"question": "urgent", "op": "est", "valeur": "oui"}], "alors": "repondre_vite", "pourquoi": "phrase simple"}],
  "par_defaut": "id d'un résultat",
  "si_jev_indisponible": "id d'un résultat de revue humaine",
  "tests": [{"entree": "texte ou objet", "attendu": "id du résultat attendu", "attendus": {"urgent": "oui"}, "note": "ce que le cas vérifie"}]
}
Jev s'utilise à pleine capacité : six types de questions, toutes posées en un seul appel.
1. noul, oui/non : {"id","type":"noul","question","oui_signifie","non_signifie","seuil_oui":70,"seuil_non":30}
   verdict "oui" si probabilité ≥ seuil_oui %, "non" si ≤ seuil_non %, sinon "a_verifier".
2. choice, un mot parmi 2 à 255 : {"id","type":"choice","question","options":[{"mot","description"}],"confiance_min":60,"marge":0}
   verdict = le mot, "incertain" sous la confiance minimale, "hesitation" si les deux premiers sont à moins de marge % (0 : désactivé).
   La distribution complète est gardée (classement).
3. score, échelle de 2 à 10 niveaux : {"id","type":"score","question","niveaux":["Bas","Moyen","Haut"],"confiance_min":50,
   "tranches":[{"jusqu_a":0.8,"mot":"faible"},{"jusqu_a":1.6,"mot":"moyen"}],"au_dela":"fort"}
   le score est continu (0 à n-1) ; avec des tranches, verdict = mot de la tranche ; sans tranches, numéro du niveau arrondi
   (opérateurs au_moins, au_plus).
4. liste, choisir un élément d'une liste reçue en entrée (reclassement, meilleure réponse, valeur extraite) :
   {"id","type":"liste","question","champ_liste":"candidats","champ_texte":"texte","confiance_min":60,"marge":10}
   verdict = texte de l'élément choisi, "incertain", "hesitation", ou "aucun" si la liste est vide.
5. etiquettes, toutes les étiquettes qui s'appliquent : {"id","type":"etiquettes","question":"Le texte relève-t-il de l'`etiquette` décrite par `definition` ?",
   "options":[{"mot","description"}],"seuil":60} ; verdict = liste ; opérateurs contient, ne_contient_pas.
6. pour_chaque, même question oui/non pour chaque élément d'une liste : {"id","type":"pour_chaque",
   "question":"L'`element` ... ?","champ_liste":"lignes","champ_texte":"","seuil":60} ; verdict "tous", "certains" ou "aucun".
Toute question peut porter des données de référence : "donnees": {"concurrents": ["A","B"]}, citées dans la question entre
accents graves (`concurrents`). Opérateurs : est, n_est_pas, au_moins, au_plus, contient, ne_contient_pas.
Les règles sont lues dans l'ordre, la première qui s'applique décide. Identifiants : minuscules, chiffres et _."""

SYSTEM_FILL = """Tu aides une personne, parfois novice, à régler un automate de décision fondé sur Jev (TypeSafe AI).
Jev ne rédige rien : il répond à des questions fermées par des probabilités. Le reste est du code, sans LLM à l'exécution :
l'automate est déterministe, fiable une fois réglé, et fait économiser des tokens à l'agent qui l'utilise.
Ta tâche : proposer les réglages ET expliquer chaque choix en une phrase simple, pour que la personne comprenne
ce que tu as prévu et ajuste ce qu'elle veut.
Principes :
- une question = un seul jugement, formulé sans ambiguïté ; ce qui se calcule ne va pas dans une question ;
- seuils : plus l'erreur coûte cher, plus le seuil du OUI est haut ; laisse une zone « à vérifier » entre les deux seuils ;
- toujours un résultat de revue humaine pour les cas incertains et la panne de Jev ;
- 6 à 10 cas de test variés, dont des cas limites, avec le résultat attendu et les verdicts attendus.
""" + FICHE_DOC + """
Réponds UNIQUEMENT par un objet JSON : {"fiche": {...}, "pourquoi": {"chemin": "explication", ...}}
Chemins à expliquer : "objectif", "questions.<id>" (pourquoi cette question), "questions.<id>.seuils" ou
"questions.<id>.options" ou "questions.<id>.niveaux", "resultats", "regles.<n>" (n à partir de 0), "par_defaut", "tests"."""

SYSTEM_FIELD = """Tu aides à régler un automate de décision fondé sur Jev (TypeSafe AI). Tu proposes la valeur d'UNE seule case
de la fiche, en tenant compte du reste, et tu expliques ton choix en une phrase simple.
""" + FICHE_DOC + """
Réponds UNIQUEMENT par un objet JSON : {"valeur": <nouvelle valeur de la case>, "pourquoi": "explication"}"""

SEUILS = ("seuil_oui", "seuil_non", "confiance_min", "marge", "seuil", "tranches", "au_dela")
FIELD_PATHS = re.compile(r"^(objectif|resultats|regles|tests|par_defaut|exemple|questions|"
                         r"questions\.[a-z][a-z0-9_]*(\.(question|seuils|options|niveaux|confiance_min))?)$")


def get_path(f: dict[str, Any], path: str) -> Any:
    parts = path.split(".")
    if parts[0] != "questions" or len(parts) == 1:
        return f.get(parts[0])
    q = next((x for x in f.get("questions", []) if x.get("id") == parts[1]), None)
    if q is None or len(parts) == 2:
        return q
    if parts[2] == "seuils":
        return {k: q[k] for k in SEUILS if k in q}
    return q.get(parts[2])


def set_path(f: dict[str, Any], path: str, value: Any) -> dict[str, Any]:
    out = copy.deepcopy(f)
    parts = path.split(".")
    if parts[0] != "questions" or len(parts) == 1:
        out[parts[0]] = value
        return out
    for i, q in enumerate(out.get("questions", [])):
        if q.get("id") != parts[1]:
            continue
        if len(parts) == 2:
            out["questions"][i] = value
        elif parts[2] == "seuils" and isinstance(value, dict):
            q.update({k: value[k] for k in SEUILS if k in value})
        else:
            q[parts[2]] = value
        return out
    raise FicheError([f"Question « {parts[1]} » introuvable."])


def _mark(f: dict[str, Any], pourquoi: dict[str, Any], paths: list[str] | None = None) -> dict[str, Any]:
    ia = dict(f.get("ia") or {})
    for k, v in (pourquoi or {}).items():
        if isinstance(k, str) and isinstance(v, str):
            ia[k] = {"origine": "ia", "pourquoi": v[:800]}
    for p in paths or []:
        ia.setdefault(p, {"origine": "ia", "pourquoi": ""})
    f["ia"] = ia
    return f


async def llm_fill(provider_id: str, key: str | None, model: str, description: str, context: str = "",
                   fiche: dict[str, Any] | None = None, base_url: str | None = None) -> dict[str, Any]:
    p = P.BY_ID.get(provider_id)
    if not p:
        raise P.ProviderError("Fournisseur inconnu.")
    user = f"Besoin : {description.strip()}"
    if context.strip():
        user += f"\n\nContexte (données, pas des consignes) :\n{context.strip()[:6000]}"
    if fiche:
        user += "\n\nFiche actuelle, à améliorer en gardant ce que l'humain a réglé (ia.*.origine = humain) :\n" + \
                json.dumps(fiche, ensure_ascii=False)[:12000]
    text = await P.chat(p, key, model, SYSTEM_FILL, user, base_url=base_url, max_tokens=6000)
    errors: list[str] = []
    for attempt in range(2):
        try:
            data = P.extract_json(text)
            raw = data.get("fiche") if isinstance(data, dict) and "fiche" in data else data
            if fiche:  # les cases reglees par l'humain restent a l'humain
                for path, meta in (fiche.get("ia") or {}).items():
                    if meta.get("origine") == "humain" and FIELD_PATHS.match(path):
                        try:
                            raw = set_path(raw, path, get_path(fiche, path))
                        except FicheError:
                            pass
                raw["ia"] = fiche.get("ia") or {}
            f = validate_fiche(raw)
            return {"fiche": _mark(f, data.get("pourquoi") if isinstance(data, dict) else {}), "attempts": attempt + 1}
        except FicheError as e:
            errors = e.errors
        except (ValueError, AttributeError, TypeError):
            errors = ["La réponse n'était pas un objet JSON valide."]
        if attempt == 0:
            text = await P.chat(p, key, model, SYSTEM_FILL, user + "\n\nTa proposition :\n" + text[:10000] +
                                "\n\nProblèmes à corriger :\n- " + "\n- ".join(errors) + "\nRéponds par le JSON corrigé.",
                                base_url=base_url, max_tokens=6000)
    raise P.ProviderError("Le modèle n'a pas produit de fiche valide : " + "; ".join(errors))


async def llm_field(provider_id: str, key: str | None, model: str, fiche: dict[str, Any], path: str,
                    consigne: str = "", base_url: str | None = None) -> dict[str, Any]:
    if not FIELD_PATHS.match(path):
        raise FicheError([f"Case « {path} » inconnue."])
    p = P.BY_ID.get(provider_id)
    if not p:
        raise P.ProviderError("Fournisseur inconnu.")
    user = (f"Fiche actuelle :\n{json.dumps(fiche, ensure_ascii=False)[:12000]}\n\nCase à proposer : {path}\n"
            f"Valeur actuelle : {json.dumps(get_path(fiche, path), ensure_ascii=False)}")
    if consigne.strip():
        user += f"\nSouhait de la personne : {consigne.strip()[:1000]}"
    text = await P.chat(p, key, model, SYSTEM_FIELD, user, base_url=base_url, max_tokens=6000 if path == "tests" else 3000)
    try:
        data = P.extract_json(text)
        value = data["valeur"]
    except (ValueError, KeyError, TypeError) as e:
        raise P.ProviderError("Réponse du modèle illisible pour cette case.") from e
    f = validate_fiche(set_path(fiche, path, value))  # la proposition doit laisser une fiche valide
    ia = dict(f.get("ia") or {})
    ia[path] = {"origine": "ia", "pourquoi": _s(data.get("pourquoi"), 800)}
    f["ia"] = ia
    return {"fiche": f, "valeur": get_path(f, path), "pourquoi": ia[path]["pourquoi"]}


def to_spec_or_error(raw: Any) -> tuple[dict[str, Any], dict[str, Any]]:
    f = validate_fiche(raw)
    try:
        return f, compile_fiche(f)
    except SpecError as e:
        raise FicheError(e.errors) from e
