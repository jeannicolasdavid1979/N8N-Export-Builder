"""Bibliotheque, suite : 34 modeles de plus, de puissance et de complexite variees.

Niveau 1 : du code seul ou une question. Niveau 2 : plusieurs questions, verdicts et regles.
Niveau 3 : questions construites depuis l'entree, memoire, sources, LLM sur une route.
Les modeles repris d'un patron publie le citent dans « source » ; chacun a ete reecrit en deterministe
et verifie dans n8n.
"""

from __future__ import annotations

from typing import Any

PLUS: list[dict[str, Any]] = []


def _t(tid: str, family: str, niveau: int, spec: dict[str, Any], source: str = "") -> None:
    PLUS.append({"id": tid, "family": family, "niveau": niveau, "source": source, "spec": spec})


def noul(text: str, oui: str = "", non: str = "") -> dict[str, Any]:
    q: dict[str, Any] = {"type": "noul", "instructions": text}
    crit = {k: v for k, v in (("true", oui), ("false", non)) if v}
    if crit:
        q["criteria"] = crit
    return q


def choice(text: Any, options: dict[str, Any]) -> dict[str, Any]:
    return {"type": "choice", "instructions": text, "criteria": options}


def score(text: Any, levels: list[str]) -> dict[str, Any]:
    return {"type": "score", "instructions": text, "criteria": levels}


def rule(route: str, *conds: tuple[Any, ...], label: str = "") -> dict[str, Any]:
    """Condition (champ, operateur, valeur) ; pour exists et missing, (champ, operateur) suffit."""
    return {"when": [{"field": c[0], "op": c[1], "value": c[2] if len(c) > 2 else None} for c in conds],
            "route": route, "label": label}


# ---------------------------------------------------------------------------------------------------
# Niveau 1 : du code, ou une seule question
# ---------------------------------------------------------------------------------------------------

_t("code-sla-tickets", "Métiers", 1, {
    "name": "SLA des tickets : dans les temps ou en retard",
    "description": "Calcule, sans modèle, où en est chaque ticket par rapport à son engagement de réponse et de résolution "
                   "selon sa priorité. Alerte avant le dépassement, pas après.",
    "trigger": {"type": "webhook", "path": "sla-tickets"},
    "state": {"mode": "json"},
    "prepare_js": r"""const SLA = { P1: [1, 4], P2: [4, 24], P3: [8, 72], P4: [24, 120] }; // heures : réponse, résolution
const h = 3600000;
const now = Date.now();
const sla = SLA[String(input.priorite || '').toUpperCase()];
vars.priorite_connue = Boolean(sla);
const ouvert = Date.parse(input.ouvert_le);
vars.date_valide = !Number.isNaN(ouvert);
vars.resolu = Boolean(input.resolu_le);
if (sla && vars.date_valide) {
  const age = (now - ouvert) / h;
  vars.age_heures = Math.round(age * 10) / 10;
  const repondu = input.premiere_reponse_le ? (Date.parse(input.premiere_reponse_le) - ouvert) / h : null;
  vars.reponse_en_retard = repondu === null ? age > sla[0] : repondu > sla[0];
  vars.resolution_en_retard = age > sla[1];
  vars.part_consommee = Math.round((age / sla[1]) * 100) / 100;
  vars.heures_restantes = Math.round((sla[1] - age) * 10) / 10;
}""",
    "questions": {},
    "decision": {"mode": "rules", "routes": ["dans_les_temps", "bientot_en_retard", "reponse_en_retard", "en_retard", "clos", "a_revoir"],
                 "rules": [rule("a_revoir", ("priorite_connue", "==", False), label="Priorité inconnue (P1 à P4)"),
                           rule("a_revoir", ("date_valide", "==", False), label="Date d'ouverture illisible"),
                           rule("clos", ("resolu", "==", True)),
                           rule("en_retard", ("resolution_en_retard", "==", True), label="Délai de résolution dépassé"),
                           rule("reponse_en_retard", ("reponse_en_retard", "==", True), label="Première réponse hors délai"),
                           rule("bientot_en_retard", ("part_consommee", ">=", 0.75), label="Plus de 75 % du délai consommé")],
                 "default_route": "dans_les_temps"},
    "route_notes": {"en_retard": "Escalade au responsable du support avec le ticket et son âge.",
                    "bientot_en_retard": "Prends le ticket en priorité et préviens le client.",
                    "reponse_en_retard": "Réponds au client immédiatement, même brièvement."},
    "sample": {"id": "T-1042", "priorite": "P2", "ouvert_le": "2026-09-28T06:00:00Z", "premiere_reponse_le": None},
    "hub": {"playlist": "Support client, Support informatique", "allege": "l'agent ne calcule plus de délais : il agit sur les tickets à risque."},
})

_t("code-metriques-serveur", "Playlists du Hub", 1, {
    "name": "Serveurs : seuils des métriques",
    "description": "Classe un relevé de métriques (CPU, mémoire, disque, latence, erreurs) en normal, alerte ou critique, "
                   "par des seuils écrits. Indique la métrique la plus dégradée.",
    "trigger": {"type": "webhook", "path": "metriques-serveur"},
    "state": {"mode": "json"},
    "prepare_js": r"""const SEUILS = { cpu: [85, 95], memoire: [85, 95], disque: [85, 95], latence_ms: [800, 2000], erreurs_5xx_pct: [1, 5] };
let pire = null, niveau = 0;
for (const [k, [alerte, critique]] of Object.entries(SEUILS)) {
  const v = Number(input[k]);
  if (Number.isNaN(v) || input[k] === undefined) continue;
  const n = v >= critique ? 2 : (v >= alerte ? 1 : 0);
  vars[k + '_niveau'] = ['ok', 'alerte', 'critique'][n];
  if (n > niveau) { niveau = n; pire = k + ' = ' + v; }
}
vars.niveau = niveau;
vars.pire = pire;
vars.metriques_lues = Object.keys(vars).filter(k => k.endsWith('_niveau')).length;""",
    "questions": {},
    "decision": {"mode": "rules", "routes": ["normal", "alerte", "critique", "a_revoir"],
                 "rules": [rule("a_revoir", ("metriques_lues", "==", 0), label="Aucune métrique reconnue"),
                           rule("critique", ("niveau", ">=", 2)), rule("alerte", ("niveau", ">=", 1))],
                 "default_route": "normal"},
    "route_notes": {"critique": "Préviens l'astreinte sur le bot Telegram des opérations avec la métrique la plus dégradée.",
                    "alerte": "Note l'alerte au journal et surveille le prochain relevé."},
    "sample": {"hote": "api-prod-2", "cpu": 91, "memoire": 62, "disque": 78, "latence_ms": 420, "erreurs_5xx_pct": 0.2},
    "hub": {"playlist": "Surveillance des serveurs", "allege": "l'agent n'examine que les relevés en alerte."},
})

_t("code-iban-siren", "Playlists du Hub", 1, {
    "name": "Fournisseur : IBAN, SIREN et SIRET valides",
    "description": "Vérifie par calcul (clé IBAN modulo 97, formule de Luhn du SIREN et du SIRET) les identifiants d'un "
                   "fournisseur avant tout paiement. Aucun modèle, aucune erreur de lecture.",
    "trigger": {"type": "webhook", "path": "iban-siren"},
    "state": {"mode": "json"},
    "prepare_js": r"""function ibanValide(iban) {
  const s = String(iban || '').replace(/\s+/g, '').toUpperCase();
  if (!/^[A-Z]{2}\d{2}[A-Z0-9]{10,30}$/.test(s)) return false;
  if (s.startsWith('FR') && s.length !== 27) return false;
  let mod = 0;
  for (const ch of s.slice(4) + s.slice(0, 4)) {
    const v = /[A-Z]/.test(ch) ? String(ch.charCodeAt(0) - 55) : ch;
    for (const d of v) mod = (mod * 10 + Number(d)) % 97;
  }
  return mod === 1;
}
function luhn(n) {
  const s = String(n || '').replace(/\s+/g, '');
  if (!/^\d+$/.test(s)) return false;
  let t = 0;
  for (let i = 0; i < s.length; i++) { let d = Number(s[s.length - 1 - i]); if (i % 2) { d *= 2; if (d > 9) d -= 9; } t += d; }
  return t % 10 === 0;
}
const siren = String(input.siren || '').replace(/\s+/g, '');
const siret = String(input.siret || '').replace(/\s+/g, '');
vars.iban_valide = ibanValide(input.iban);
vars.siren_valide = /^\d{9}$/.test(siren) && luhn(siren);
vars.siret_present = siret.length > 0;
vars.siret_coherent = !vars.siret_present || (/^\d{14}$/.test(siret) && siret.startsWith(siren) && (luhn(siret) || siren === '356000000'));""",
    "questions": {},
    "decision": {"mode": "rules", "routes": ["valide", "iban_invalide", "siren_invalide", "siret_incoherent"],
                 "rules": [rule("iban_invalide", ("iban_valide", "==", False), label="Clé de contrôle de l'IBAN fausse"),
                           rule("siren_invalide", ("siren_valide", "==", False), label="SIREN invalide"),
                           rule("siret_incoherent", ("siret_coherent", "==", False), label="SIRET invalide ou d'une autre entreprise")],
                 "default_route": "valide"},
    "route_notes": {"iban_invalide": "Bloque le paiement et demande au fournisseur un RIB, par un canal connu.",
                    "valide": "Poursuis la vérification (registre, coordonnées connues)."},
    "sample": {"fournisseur": "Bureau Plus", "iban": "FR76 3000 6000 0112 3456 7890 189", "siren": "552 100 554", "siret": "55210055400005"},
    "hub": {"playlist": "Vérification des fournisseurs", "allege": "l'agent ne vérifie plus de clés à la main et ne se trompe plus de chiffre."},
})

_t("code-controle-tva", "Métiers", 1, {
    "name": "Facture : cohérence HT, TVA, TTC",
    "description": "Contrôle qu'une facture tient debout : HT + TVA = TTC au centime près et taux de TVA français existant "
                   "(20 %, 10 %, 5,5 %, 2,1 %, 0 %).",
    "trigger": {"type": "webhook", "path": "controle-tva"},
    "state": {"mode": "json"},
    "prepare_js": r"""const TAUX = [20, 10, 5.5, 2.1, 0];
const ht = Number(input.ht), tva = Number(input.tva), ttc = Number(input.ttc);
vars.montants_lisibles = [ht, tva, ttc].every(x => !Number.isNaN(x));
if (vars.montants_lisibles) {
  vars.ecart_total = Math.round((ht + tva - ttc) * 100) / 100;
  vars.somme_ok = Math.abs(vars.ecart_total) <= 0.02;
  vars.taux_calcule = ht ? Math.round((tva / ht) * 10000) / 100 : null;
  const proche = TAUX.reduce((a, b) => Math.abs(b - vars.taux_calcule) < Math.abs(a - vars.taux_calcule) ? b : a);
  vars.taux_retenu = proche;
  vars.taux_ok = vars.taux_calcule !== null && Math.abs(proche - vars.taux_calcule) <= 0.06;
}""",
    "questions": {},
    "decision": {"mode": "rules", "routes": ["conforme", "incoherente", "taux_inconnu", "a_revoir"],
                 "rules": [rule("a_revoir", ("montants_lisibles", "==", False), label="Montants illisibles"),
                           rule("incoherente", ("somme_ok", "==", False), label="HT + TVA ne donne pas le TTC"),
                           rule("taux_inconnu", ("taux_ok", "==", False), label="Taux de TVA inexistant en France")],
                 "default_route": "conforme"},
    "sample": {"numero": "F-2231", "ht": 1250, "tva": 250, "ttc": 1500},
    "hub": {"playlist": "Rapprochement bancaire, Contrôle des notes de frais", "allege": "aucune facture incohérente n'arrive jusqu'à l'agent."},
})

_t("code-doublon-facture", "Métiers", 2, {
    "name": "Factures fournisseurs : doublons exacts et probables",
    "description": "Garde en mémoire les factures déjà vues. Même fournisseur et même numéro : doublon exact. Même fournisseur "
                   "et même montant sous 30 jours : doublon probable. Évite de payer deux fois.",
    "trigger": {"type": "webhook", "path": "doublon-facture"},
    "state": {"mode": "json"},
    "prepare_js": r"""const memoire = typeof $getWorkflowStaticData === 'function' ? $getWorkflowStaticData('global') : {};
memoire.factures = memoire.factures || {};
const f = String(input.fournisseur || '').trim().toLowerCase().replace(/\s+/g, ' ');
const num = String(input.numero || '').replace(/[\s-]/g, '').toUpperCase();
const montant = Math.round(Number(input.montant) * 100) / 100;
const date = Date.parse(input.date) || Date.now();
const vues = memoire.factures[f] = memoire.factures[f] || [];
vars.doublon_exact = vues.some(v => v.num === num);
const proche = vues.find(v => v.num !== num && v.montant === montant && Math.abs(v.date - date) <= 30 * 86400000);
vars.doublon_probable = Boolean(proche);
vars.facture_proche = proche ? proche.num : null;
if (!vars.doublon_exact) { vues.push({ num, montant, date }); if (vues.length > 500) vues.shift(); }""",
    "questions": {},
    "decision": {"mode": "rules", "routes": ["nouvelle", "doublon_probable", "doublon_exact"],
                 "rules": [rule("doublon_exact", ("doublon_exact", "==", True), label="Numéro déjà reçu de ce fournisseur"),
                           rule("doublon_probable", ("doublon_probable", "==", True), label="Même montant sous 30 jours")],
                 "default_route": "nouvelle"},
    "route_notes": {"doublon_exact": "Ne paie pas : signale le doublon au comptable.",
                    "doublon_probable": "Demande confirmation au comptable avant paiement."},
    "sample": {"fournisseur": "Bureau Plus", "numero": "F-2026-118", "montant": 348.2, "date": "2026-09-20"},
    "hub": {"playlist": "Rapprochement bancaire", "allege": "la mémoire des factures est tenue par l'automate, pas par le contexte de l'agent."},
})

_t("code-contact-normalisation", "Métiers", 1, {
    "name": "Contact : normalisation et validité",
    "description": "Met en forme e-mail, téléphone français (format +33) et code postal, et dit ce qui manque ou est faux "
                   "avant l'entrée dans le CRM.",
    "trigger": {"type": "webhook", "path": "contact-normalisation"},
    "state": {"mode": "json"},
    "prepare_js": r"""const email = String(input.email || '').trim().toLowerCase();
let tel = String(input.telephone || '').replace(/[\s.\-()]/g, '');
if (tel.startsWith('0033')) tel = '+33' + tel.slice(4);
if (/^0\d{9}$/.test(tel)) tel = '+33' + tel.slice(1);
const cp = String(input.code_postal || '').trim();
vars.email_present = email.length > 0;
vars.email_ok = /^[^\s@]+@[^\s@]+\.[a-z]{2,}$/.test(email);
vars.tel_present = tel.length > 0;
vars.tel_ok = /^\+33[1-9]\d{8}$/.test(tel);
vars.cp_ok = /^(0[1-9]|[1-8]\d|9[0-8])\d{3}$/.test(cp);
vars.normalise = { email: vars.email_ok ? email : null, telephone: vars.tel_ok ? tel : null, code_postal: vars.cp_ok ? cp : null };
vars.invalides = [vars.email_present && !vars.email_ok && 'email', vars.tel_present && !vars.tel_ok && 'telephone', cp && !vars.cp_ok && 'code_postal'].filter(Boolean);""",
    "questions": {},
    "decision": {"mode": "rules", "routes": ["complet", "incomplet", "invalide"],
                 "rules": [rule("invalide", ("invalides", "exists"), label="Donnée présente mais mal formée"),
                           rule("incomplet", ("email_ok", "==", False), ("tel_ok", "==", False), label="Ni e-mail ni téléphone valides")],
                 "default_route": "complet"},
    "sample": {"nom": "Claire Martin", "email": " Claire.Martin@Exemple.FR ", "telephone": "06 12 34 56 78", "code_postal": "69003"},
    "hub": {"playlist": "Qualification et prospection commerciale", "allege": "le CRM ne reçoit que des contacts propres."},
})

_t("code-declinaison-formats", "Playlists du Hub", 1, {
    "name": "Vidéo : déclinaison en 9:16, 1:1 et 16:9",
    "description": "Pour une vidéo validée, calcule les dimensions, les marges de sécurité du texte et la taille de police de "
                   "chaque format, et vérifie que le texte à l'écran tient. Consigne « déclinaison-3-formats » du Video-bot.",
    "trigger": {"type": "webhook", "path": "declinaison-formats"},
    "state": {"mode": "json"},
    "prepare_js": r"""const FORMATS = { '9:16': [1080, 1920], '1:1': [1080, 1080], '16:9': [1920, 1080] };
const texte = String(input.texte_ecran || '');
const demandes = Array.isArray(input.formats) && input.formats.length ? input.formats : Object.keys(FORMATS);
vars.inconnus = demandes.filter(f => !FORMATS[f]);
vars.plans = demandes.filter(f => FORMATS[f]).map(f => {
  const [w, hh] = FORMATS[f];
  const marge = Math.round(Math.min(w, hh) * 0.08);
  const police = Math.round(Math.min(w, hh) / 18);
  const caracteres_par_ligne = Math.floor((w - 2 * marge) / (police * 0.55));
  const lignes = Math.ceil(texte.length / Math.max(1, caracteres_par_ligne));
  return { format: f, largeur: w, hauteur: hh, marge_px: marge, police_px: police, lignes_texte: lignes, texte_tient: lignes <= 3 };
});
vars.texte_trop_long = vars.plans.filter(p => !p.texte_tient).map(p => p.format);""",
    "questions": {},
    "decision": {"mode": "rules", "routes": ["pret", "raccourcir_texte", "corriger"],
                 "rules": [rule("corriger", ("inconnus", "exists"), label="Format inconnu"),
                           rule("raccourcir_texte", ("texte_trop_long", "exists"), label="Le texte dépasse trois lignes")],
                 "default_route": "pret"},
    "route_notes": {"pret": "Lance les trois recadrages avec les dimensions de variables.plans.",
                    "raccourcir_texte": "Propose un texte plus court au propriétaire."},
    "sample": {"titre": "Organiseur", "texte_ecran": "Avant : chaos. Après : 15 secondes.", "formats": ["9:16", "1:1", "16:9"]},
    "hub": {"playlist": "Générateur Vidéo Réseaux Sociaux", "agent": "Video-bot",
            "allege": "Video-bot reçoit les dimensions prêtes au lieu de les calculer à chaque déclinaison."},
})

_t("jev-spam-formulaire", "Métiers", 1, {
    "name": "Formulaire de contact : spam ou vraie demande",
    "description": "Écarte le spam d'un formulaire : pot de miel et nombre de liens contrôlés par le code, puis un seul oui/non "
                   "à Jev pour le reste.",
    "trigger": {"type": "webhook", "path": "spam-formulaire"},
    "state": {"mode": "field", "field": "message"},
    "prepare_js": r"""vars.pot_de_miel = String(input.site_web_cache || '').trim() !== '';
vars.nb_liens = (String(input.message || '').match(/https?:\/\//g) || []).length;""",
    "questions": {"spam": noul("Le message est-il une sollicitation non demandée, une publicité, une arnaque ou un texte sans rapport avec une demande adressée à notre entreprise ?")},
    "decision": {"mode": "rules", "verdicts": {"spam": {"oui": 0.75, "non": 0.35}},
                 "routes": ["legitime", "spam", "a_revoir"],
                 "rules": [rule("spam", ("pot_de_miel", "==", True), label="Champ caché rempli : robot"),
                           rule("spam", ("nb_liens", ">=", 3), label="Trois liens ou plus"),
                           rule("spam", ("spam_verdict", "==", "oui")), rule("a_revoir", ("spam_verdict", "==", "a_verifier"))],
                 "default_route": "legitime"},
    "sample": {"nom": "Paul", "message": "Bonjour, je souhaite un devis pour 20 postes.", "site_web_cache": ""},
    "hub": {"playlist": "Qualification et prospection commerciale, Support client", "allege": "l'agent ne lit jamais le spam."},
}, source="Classique des modèles communautaires n8n (filtre anti-spam de formulaire), réécrit avec Jev")

_t("jev-langue", "Primitives Jev", 1, {
    "name": "Langue du message",
    "description": "Reconnaît la langue d'un message pour l'envoyer au bon traitement ou à la traduction. Sous le seuil de "
                   "confiance, le message part en revue.",
    "trigger": {"type": "webhook", "path": "langue"},
    "state": {"mode": "field", "field": "message"},
    "questions": {"langue": choice("Dans quelle langue le message est-il principalement écrit ?",
                                   {"fr": "français", "en": "anglais", "es": "espagnol", "de": "allemand", "it": "italien", "autre": None})},
    "decision": {"mode": "choice", "question": "langue", "min_confidence": 0.7, "review_route": "a_revoir"},
    "route_notes": {"fr": "Traite directement.", "en": "Traduis en français avec DeepL avant de traiter.",
                    "autre": "Traduis puis transmets à un humain."},
    "sample": {"message": "Hello, I would like to know if you ship to Canada."},
    "hub": {"playlist": "Veille concurrentielle, Support client", "allege": "la traduction n'est lancée que quand il le faut."},
})

_t("jev-desabonnement", "Métiers", 1, {
    "name": "Désinscription et opposition",
    "description": "Repère dans une réponse à une campagne une demande d'arrêt des messages ou d'effacement des données, pour "
                   "l'appliquer sans délai. Obligation légale, pas une option.",
    "trigger": {"type": "webhook", "path": "desabonnement"},
    "state": {"mode": "field", "field": "reponse"},
    "questions": {"arret": noul("La personne demande-t-elle, même poliment ou indirectement, à ne plus recevoir de messages ?"),
                  "effacement": noul("La personne demande-t-elle la suppression de ses données personnelles ?")},
    "decision": {"mode": "rules", "verdicts": {"arret": {"oui": 0.6, "non": 0.25}, "effacement": {"oui": 0.6, "non": 0.25}},
                 "routes": ["effacement_rgpd", "desinscrire", "continuer", "a_revoir"],
                 "rules": [rule("effacement_rgpd", ("effacement_verdict", "==", "oui")),
                           rule("desinscrire", ("arret_verdict", "==", "oui")),
                           rule("a_revoir", ("arret_verdict", "==", "a_verifier")),
                           rule("a_revoir", ("effacement_verdict", "==", "a_verifier"))],
                 "default_route": "continuer"},
    "route_notes": {"desinscrire": "Désinscris le contact de toutes les séquences, aujourd'hui.",
                    "effacement_rgpd": "Transmets au responsable RGPD : réponse sous un mois."},
    "sample": {"reponse": "Merci mais ce n'est plus d'actualité, retirez-moi de votre liste svp."},
    "hub": {"playlist": "Qualification et prospection commerciale, Relance des factures impayées",
            "allege": "l'agent ne peut plus rater une opposition : le code l'applique."},
})

_t("jev-telegram-routage", "Playlists du Hub", 1, {
    "name": "Bot Telegram : à qui va le message",
    "description": "Trie les messages reçus par un bot Telegram du hub : l'agent répond, un humain répond, ou le message est "
                   "ignoré. Vérification gratuite avant de réveiller l'agent.",
    "trigger": {"type": "webhook", "path": "telegram-routage"},
    "state": {"mode": "field", "field": "texte"},
    "questions": {"intention": choice("Que veut l'auteur du message ?", {
        "question": "Une question à laquelle l'agent peut répondre", "demande_action": "Une action à réaliser",
        "reclamation": "Un mécontentement ou un litige", "conversation": "Salutation, remerciement, bavardage", "spam": None}),
        "urgent": noul("L'auteur signale-t-il un blocage ou une urgence ?")},
    "decision": {"mode": "rules", "verdicts": {"intention": {"min": 0.6}, "urgent": {"oui": 0.7, "non": 0.3}},
                 "routes": ["agent", "humain", "ignorer", "a_revoir"],
                 "rules": [rule("humain", ("urgent_verdict", "==", "oui")),
                           rule("humain", ("intention_verdict", "==", "reclamation")),
                           rule("ignorer", ("intention_verdict", "in", "spam,conversation")),
                           rule("a_revoir", ("intention_verdict", "==", "incertain"))],
                 "default_route": "agent"},
    "sample": {"texte": "Bonjour, comment je modifie mon adresse de livraison ?"},
    "hub": {"playlist": "Toute playlist avec un bot Telegram", "allege": "l'agent n'est lancé que pour les messages qui le concernent."},
})

# ---------------------------------------------------------------------------------------------------
# Primitives Jev avancées
# ---------------------------------------------------------------------------------------------------

_t("jev-auto-coherence", "Primitives Jev", 2, {
    "name": "Vote de cohérence sur une décision sensible",
    "description": "La même question posée sous trois formulations dans un seul appel. Moyenne et écart décident : si les "
                   "formulations divergent, le cas va en revue. Pour les décisions qu'on ne veut pas voir basculer sur un mot.",
    "trigger": {"type": "webhook", "path": "auto-coherence"},
    "state": {"mode": "field", "field": "texte"},
    "questions": {"v1": noul("Le texte contient-il une réclamation du client ?"),
                  "v2": noul("Le client exprime-t-il un reproche sur un produit ou un service reçu ?"),
                  "v3": noul("Faut-il traiter ce texte comme une plainte ?")},
    "decision": {"mode": "rules", "routes": ["oui", "non", "desaccord"],
                 "rules": [], "default_route": "desaccord", "error_route": "desaccord",
                 "post_js": r"""const p = [vars.v1, vars.v2, vars.v3].map(Number);
const moyenne = p.reduce((a, b) => a + b, 0) / p.length;
const ecart = Math.max(...p) - Math.min(...p);
ctx.vars.moyenne = moyenne; ctx.vars.ecart = ecart;
if (ecart >= 0.35) { ctx.route = 'desaccord'; ctx.reason = `Formulations en désaccord (écart ${Math.round(ecart * 100)} points)`; }
else if (moyenne >= 0.7) { ctx.route = 'oui'; ctx.reason = `Accord sur oui (${Math.round(moyenne * 100)} %)`; }
else if (moyenne <= 0.3) { ctx.route = 'non'; ctx.reason = `Accord sur non (${Math.round(moyenne * 100)} %)`; }
else { ctx.route = 'desaccord'; ctx.reason = `Zone grise (${Math.round(moyenne * 100)} %)`; }"""},
    "sample": {"texte": "Le colis est arrivé ouvert et il manquait un article, c'est la deuxième fois."},
    "hub": {"playlist": "Toutes, pour les décisions à fort enjeu", "allege": "une décision fragile ne passe plus en silence."},
}, source="Cookbook TypeSafe « Self-consistency » et patron « Parallelization, voting » de « Building effective agents » (Anthropic)")

_t("jev-classification-hierarchique", "Primitives Jev", 3, {
    "name": "Classement à deux niveaux, en un appel",
    "description": "Famille et sous-catégorie demandées en même temps (les sous-questions de chaque famille partent en "
                   "spéculation). Si la sous-catégorie est incertaine, on garde la famille : jamais une étiquette fausse et précise.",
    "trigger": {"type": "webhook", "path": "classement-hierarchique"},
    "state": {"mode": "field", "field": "message"},
    "questions": {
        "famille": choice("À quelle famille appartient la demande ?", {"compte": "Accès, identifiants, profil",
                                                                       "paiement": "Facturation, prélèvements, remboursements",
                                                                       "produit": "Fonctionnement du produit", "commande": "Livraison et commandes"}),
        "sous_compte": choice("Quel est le problème de compte ?", {"mot_de_passe": None, "double_authentification": None, "suppression": None, "autre": None}),
        "sous_paiement": choice("Quel est le sujet de paiement ?", {"facture": None, "prelevement_refuse": None, "remboursement": None, "autre": None}),
        "sous_produit": choice("Quel est le problème de produit ?", {"bug": None, "question_usage": None, "suggestion": None, "autre": None}),
        "sous_commande": choice("Quel est le sujet de commande ?", {"retard": None, "colis_abime": None, "adresse": None, "autre": None}),
    },
    "decision": {"mode": "rules", "routes": ["precis", "famille_seule", "a_revoir"], "rules": [], "default_route": "a_revoir",
                 "post_js": r"""const f = answers.famille || {};
if (!(f.confidence >= 0.6)) { ctx.route = 'a_revoir'; ctx.reason = 'Famille incertaine'; return; }
const s = answers['sous_' + f.choice] || {};
ctx.extra.famille = f.choice;
if (s.confidence >= 0.6 && s.choice !== 'autre') { ctx.route = 'precis'; ctx.extra.categorie = f.choice + '/' + s.choice; ctx.reason = ctx.extra.categorie; }
else { ctx.route = 'famille_seule'; ctx.extra.categorie = f.choice; ctx.reason = 'Sous-catégorie incertaine : famille seule'; }"""},
    "sample": {"message": "On m'a prélevé deux fois ce mois-ci et le second prélèvement a été rejeté."},
    "hub": {"playlist": "Support client, Support informatique", "allege": "le classement est fait sans que l'agent lise tout le catalogue."},
}, source="Cookbooks TypeSafe « Hierarchical classification » et « Classification using confidence »")

_t("jev-extraction-date", "Primitives Jev", 3, {
    "name": "Extraction fiable d'une date d'échéance",
    "description": "Le code trouve toutes les dates du texte et les met au format ISO ; Jev choisit seulement laquelle est "
                   "l'échéance. Aucune date inventée : la valeur rendue est toujours une date présente dans le texte.",
    "trigger": {"type": "webhook", "path": "extraction-date"},
    "state": {"mode": "json"},
    "prepare_js": r"""const MOIS = { janvier: 1, fevrier: 2, février: 2, mars: 3, avril: 4, mai: 5, juin: 6, juillet: 7, aout: 8, août: 8, septembre: 9, octobre: 10, novembre: 11, decembre: 12, décembre: 12 };
const t = String(input.texte || '');
const trouvees = [];
const iso = (y, m, d) => `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
for (const m of t.matchAll(/\b(\d{1,2})[\/.](\d{1,2})[\/.](\d{4})\b/g)) trouvees.push({ texte: m[0], iso: iso(m[3], m[2], m[1]) });
for (const m of t.matchAll(/\b(\d{4})-(\d{2})-(\d{2})\b/g)) trouvees.push({ texte: m[0], iso: m[0] });
for (const m of t.matchAll(/\b(\d{1,2})(?:er)?\s+(janvier|f[ée]vrier|mars|avril|mai|juin|juillet|ao[uû]t|septembre|octobre|novembre|d[ée]cembre)\s+(\d{4})\b/gi)) trouvees.push({ texte: m[0], iso: iso(m[3], MOIS[m[2].toLowerCase()], m[1]) });
const uniques = trouvees.filter((x, i) => trouvees.findIndex(y => y.iso === x.iso) === i).slice(0, 30);
vars.candidates = uniques;
vars.__echeance = uniques.map(u => u.texte);
if (uniques.length >= 2) questions.echeance = { type: 'choice', instructions: { texte: t, question: 'Laquelle de ces dates est la date limite de paiement mentionnée dans le `texte` ?' },
  criteria: Object.fromEntries(uniques.map((u, i) => ['c' + i, u.texte])) };
return t;""",
    "questions": {"paiement_mentionne": noul("Le texte parle-t-il d'une échéance ou d'une date limite de paiement ?")},
    "decision": {"mode": "rules", "verdicts": {"echeance": {"kind": "liste_choix", "min": 0.6, "marge": 0.15},
                                                "paiement_mentionne": {"oui": 0.6, "non": 0.3}},
                 "routes": ["date_trouvee", "incertaine", "aucune"],
                 "rules": [rule("aucune", ("paiement_mentionne_verdict", "==", "non"), label="Pas d'échéance dans le texte"),
                           rule("aucune", ("echeance_verdict", "==", "aucun"), label="Aucune date dans le texte"),
                           rule("incertaine", ("echeance_verdict", "in", "incertain,hesitation"))],
                 "default_route": "date_trouvee",
                 "post_js": r"""const c = (vars.candidates || []).find(x => x.texte === vars.echeance_verdict);
ctx.extra.date_iso = ctx.route === 'date_trouvee' && c ? c.iso : null;"""},
    "sample": {"texte": "Suite à notre échange du 12/09/2026, merci de régler la facture avant le 15 octobre 2026. Livraison prévue le 2026-10-20."},
    "hub": {"playlist": "Relance des factures impayées, Rapprochement bancaire", "allege": "l'agent reçoit une date ISO sûre au lieu de lire le courrier."},
}, source="Cookbooks TypeSafe « Date extraction » et « Pre-parsed value extraction »")

_t("jev-appel-fonction", "Primitives Jev", 3, {
    "name": "Demande en langage naturel vers appel d'outil",
    "description": "Transforme une demande en appel de fonction typé : fonction choisie et arguments pris dans des ensembles "
                   "fermés. L'agent exécute sans raisonner ; s'il manque un argument, il demande une précision.",
    "trigger": {"type": "webhook", "path": "appel-fonction"},
    "state": {"mode": "field", "field": "demande"},
    "questions": {
        "fonction": choice("Quelle action la personne demande-t-elle ?", {"creer_rdv": "Prendre un rendez-vous", "deplacer_rdv": "Changer un rendez-vous existant",
                                                                          "annuler_rdv": "Annuler un rendez-vous", "horaires": "Connaître les horaires", "autre": None}),
        "jour": choice("Quel jour est demandé ?", {"lundi": None, "mardi": None, "mercredi": None, "jeudi": None, "vendredi": None,
                                                   "samedi": None, "non_precise": "Aucun jour indiqué"}),
        "moment": choice("À quel moment de la journée ?", {"matin": None, "apres_midi": None, "soir": None, "non_precise": "Aucun moment indiqué"}),
    },
    "decision": {"mode": "rules", "verdicts": {"fonction": {"min": 0.65, "marge": 0.2}, "jour": {"min": 0.6}, "moment": {"min": 0.6}},
                 "routes": ["executer", "demander_precision", "humain"],
                 "rules": [rule("humain", ("fonction_verdict", "in", "autre,incertain,hesitation")),
                           rule("executer", ("fonction_verdict", "==", "horaires")),
                           rule("demander_precision", ("jour_verdict", "in", "non_precise,incertain"), label="Jour manquant"),
                           rule("demander_precision", ("fonction_verdict", "!=", "annuler_rdv"), ("moment_verdict", "in", "non_precise,incertain"), label="Moment manquant")],
                 "default_route": "executer",
                 "post_js": r"""ctx.extra.appel = { fonction: vars.fonction_verdict, arguments: { jour: vars.jour_verdict, moment: vars.moment_verdict } };"""},
    "route_notes": {"executer": "Appelle l'outil extra.appel.fonction avec extra.appel.arguments, sans autre raisonnement.",
                    "demander_precision": "Demande seulement l'argument manquant indiqué dans la raison."},
    "sample": {"demande": "Est-ce que je peux décaler mon rendez-vous à jeudi matin ?"},
    "hub": {"playlist": "Toutes, en tête de l'agent", "allege": "le choix d'outil et d'arguments coûte un appel Jev au lieu d'un raisonnement."},
}, source="Cookbook TypeSafe « Function calling »")

# ---------------------------------------------------------------------------------------------------
# Niveau 2 et 3 : métiers et playlists du Hub
# ---------------------------------------------------------------------------------------------------

_t("jev-moderation-commentaires", "Playlists du Hub", 2, {
    "name": "Réseaux sociaux : modération des commentaires",
    "description": "Chaque problème est une étiquette jugée séparément (insulte, haine, spam, arnaque, données personnelles) ; "
                   "une question client détectée appelle une réponse. Les règles décident masquer, signaler ou répondre.",
    "trigger": {"type": "webhook", "path": "moderation-commentaires"},
    "state": {"mode": "field", "field": "commentaire"},
    "questions": {
        "probleme__insulte": noul({"etiquette": "insulte", "question": "Le commentaire contient-il une insulte ou une attaque personnelle ?"}),
        "probleme__haine": noul({"etiquette": "haine", "question": "Le commentaire contient-il des propos haineux visant un groupe de personnes ?"}),
        "probleme__spam": noul({"etiquette": "spam", "question": "Le commentaire est-il une publicité ou un lien promotionnel ?"}),
        "probleme__arnaque": noul({"etiquette": "arnaque", "question": "Le commentaire propose-t-il un gain facile, un faux concours ou demande des coordonnées ?"}),
        "probleme__donnees_perso": noul({"etiquette": "données personnelles", "question": "Le commentaire publie-t-il le téléphone, l'adresse ou l'e-mail de quelqu'un ?"}),
        "question_client": noul("Le commentaire pose-t-il une question sur un produit, une commande ou un service ?"),
    },
    "decision": {"mode": "rules", "verdicts": {"probleme": {"kind": "etiquettes", "seuil": 0.6, "labels": ["insulte", "haine", "spam", "arnaque", "donnees_perso"]},
                                                "question_client": {"oui": 0.6, "non": 0.3}},
                 "routes": ["signaler", "masquer", "repondre", "laisser"],
                 "rules": [rule("signaler", ("probleme_verdict", "contains", "haine")),
                           rule("signaler", ("probleme_verdict", "contains", "arnaque")),
                           rule("masquer", ("probleme_nombre", ">=", 1), label="Au moins un problème détecté"),
                           rule("repondre", ("question_client_verdict", "==", "oui"))],
                 "default_route": "laisser", "error_route": "laisser"},
    "route_notes": {"signaler": "Masque et préviens l'équipe avec le commentaire.", "masquer": "Masque sans répondre.",
                    "repondre": "Rédige une réponse courte et aimable."},
    "sample": {"commentaire": "Trop bien ! Vous livrez en Belgique ?"},
    "hub": {"playlist": "Générateur Vidéo Réseaux Sociaux", "agent": "Video-bot", "allege": "l'agent ne lit que les commentaires qui appellent une réponse."},
}, source="Recette « content moderation » du cookbook Anthropic, réécrite en étiquettes Jev")

_t("jev-avis-clients", "Métiers", 2, {
    "name": "Avis clients : remercier, répondre ou alerter",
    "description": "Croise la note laissée (code) avec le ton et la présence d'un problème précis (Jev). Un LLM ne rédige que "
                   "les réponses aux avis négatifs ; les avis positifs reçoivent un remerciement type.",
    "trigger": {"type": "webhook", "path": "avis-clients"},
    "state": {"mode": "field", "field": "texte"},
    "prepare_js": "vars.note = Number(input.note) || null;",
    "questions": {"ton": score("Quel est le ton de l'avis ?", ["Très négatif", "Négatif", "Neutre", "Positif", "Très positif"]),
                  "probleme": noul("L'avis décrit-il un problème précis (produit défectueux, retard, erreur, mauvais accueil) ?"),
                  "menace": noul("L'avis évoque-t-il une action en justice, un signalement ou un média ?")},
    "decision": {"mode": "rules", "verdicts": {"ton": {"min": 0.5, "cuts": [{"max": 1.3, "label": "negatif"}, {"max": 2.6, "label": "neutre"}], "else": "positif"},
                                                "probleme": {"oui": 0.6, "non": 0.3}, "menace": {"oui": 0.5, "non": 0.2}},
                 "routes": ["alerter", "repondre", "remercier", "a_revoir"],
                 "rules": [rule("alerter", ("menace_verdict", "==", "oui")),
                           rule("repondre", ("note", "<=", 2)), rule("repondre", ("ton_verdict", "==", "negatif")),
                           rule("repondre", ("probleme_verdict", "==", "oui")),
                           rule("a_revoir", ("ton_verdict", "==", "incertain"))],
                 "default_route": "remercier"},
    "llm": {"route": "repondre", "provider": "openrouter", "model": "openrouter/auto",
            "system": "Rédige une réponse publique à cet avis client, en français, cinq phrases au plus : remercie, reconnais le problème précis "
                      "sans te justifier, propose un contact direct. Aucune promesse de remboursement ni de geste commercial."},
    "sample": {"note": 2, "texte": "Livraison avec une semaine de retard et personne pour répondre au téléphone."},
    "hub": {"playlist": "Support client", "allege": "un seul avis sur cinq passe par un LLM ; les autres suivent un modèle."},
})

_t("jev-gmail-etiquettes", "Playlists du Hub", 2, {
    "name": "Gmail : étiquettes et priorité",
    "description": "Attribue à chaque e-mail toutes les étiquettes Gmail qui s'appliquent (plusieurs possibles) et une priorité. "
                   "Complète le modèle n8n « assistant Gmail » du hub.",
    "trigger": {"type": "webhook", "path": "gmail-etiquettes"},
    "state": {"mode": "fields", "fields": ["expediteur", "objet", "corps"]},
    "questions": {
        "etiquette__client": noul("L'e-mail vient-il d'un client ou concerne-t-il un client ?"),
        "etiquette__facture": noul("L'e-mail contient-il ou réclame-t-il une facture ou un paiement ?"),
        "etiquette__rendez_vous": noul("L'e-mail propose-t-il ou modifie-t-il un rendez-vous ?"),
        "etiquette__newsletter": noul("L'e-mail est-il une lettre d'information ou une notification automatique ?"),
        "etiquette__recrutement": noul("L'e-mail concerne-t-il une candidature ou un recrutement ?"),
        "priorite": score("Quelle priorité de lecture mérite cet e-mail ?", ["Peut attendre", "Cette semaine", "Aujourd'hui", "Dans l'heure"]),
    },
    "decision": {"mode": "rules", "verdicts": {
        "etiquette": {"kind": "etiquettes", "seuil": 0.6, "labels": ["client", "facture", "rendez_vous", "newsletter", "recrutement"]},
        "priorite": {"min": 0.5, "cuts": [{"max": 1.5, "label": "basse"}, {"max": 2.4, "label": "normale"}], "else": "haute"}},
        "routes": ["lire_maintenant", "boite_de_reception", "archiver", "a_revoir"],
        "rules": [rule("lire_maintenant", ("priorite_verdict", "==", "haute")),
                  rule("archiver", ("etiquette_verdict", "contains", "newsletter"), ("priorite_verdict", "==", "basse")),
                  rule("a_revoir", ("priorite_verdict", "==", "incertain"))],
        "default_route": "boite_de_reception",
        "post_js": "ctx.extra.etiquettes_gmail = vars.etiquette_verdict;"},
    "route_notes": {"lire_maintenant": "Applique les étiquettes et préviens le propriétaire.",
                    "boite_de_reception": "Applique les étiquettes de extra.etiquettes_gmail.", "archiver": "Applique les étiquettes et archive."},
    "sample": {"expediteur": "compta@client-lemoine.fr", "objet": "Facture de septembre et rendez-vous", "corps": "Pouvez-vous renvoyer la facture et confirmer notre point jeudi ?"},
    "hub": {"playlist": "Assistant Gmail (modèle n8n du hub)", "allege": "l'agent n'ouvre plus chaque e-mail pour le ranger."},
}, source="Tri d'e-mails, classique des modèles communautaires n8n, en étiquettes multiples")

_t("jev-candidatures", "Playlists du Hub", 2, {
    "name": "Candidatures : préqualification sur les compétences",
    "description": "Évalue l'adéquation aux exigences du poste, fournies comme données de référence. Aucun refus automatique : "
                   "le recrutement est un usage à haut risque, un humain décide toujours. Critères limités aux compétences.",
    "trigger": {"type": "webhook", "path": "candidatures"},
    "state": {"mode": "field", "field": "cv"},
    "questions": {
        "adequation": score({"exigences": ["3 ans d'expérience en comptabilité fournisseurs", "maîtrise d'un ERP", "anglais écrit"],
                             "question": "Dans quelle mesure le CV démontre-t-il les `exigences` du poste ?"},
                            ["Aucune exigence", "Quelques-unes", "La plupart", "Toutes"]),
        "experience": noul({"exigence": "3 ans d'expérience en comptabilité fournisseurs",
                            "question": "Le CV montre-t-il l'`exigence` d'expérience ?"}),
        "incomplet": noul("Le document est-il illisible, vide, ou n'est-il pas un CV ?"),
    },
    "decision": {"mode": "rules", "verdicts": {"adequation": {"min": 0.5, "cuts": [{"max": 1.2, "label": "faible"}, {"max": 2.3, "label": "partielle"}], "else": "forte"},
                                                "experience": {"oui": 0.65, "non": 0.3}, "incomplet": {"oui": 0.6, "non": 0.3}},
                 "routes": ["entretien_propose", "a_examiner", "peu_adapte_a_valider", "document_a_demander"],
                 "rules": [rule("document_a_demander", ("incomplet_verdict", "==", "oui")),
                           rule("entretien_propose", ("adequation_verdict", "==", "forte"), ("experience_verdict", "==", "oui")),
                           rule("peu_adapte_a_valider", ("adequation_verdict", "==", "faible"))],
                 "default_route": "a_examiner"},
    "route_notes": {"entretien_propose": "Propose le profil au recruteur, qui décide de l'entretien.",
                    "peu_adapte_a_valider": "Le recruteur relit avant toute réponse : aucun refus sans humain."},
    "sample": {"cv": "Comptable fournisseurs chez Transports Lemoine depuis 2021, SAP au quotidien, rapprochements, anglais courant."},
    "hub": {"playlist": "Assistant RH des salariés", "allege": "le recruteur reçoit les candidatures triées et motivées, jamais un refus fait par une machine."},
})

_t("jev-rgpd-demande", "Métiers", 2, {
    "name": "RGPD : demande d'exercice de droits",
    "description": "Reconnaît le droit exercé (accès, rectification, effacement, opposition, portabilité, limitation), calcule "
                   "l'échéance légale d'un mois et vérifie que la personne est identifiable.",
    "trigger": {"type": "webhook", "path": "rgpd-demande"},
    "state": {"mode": "field", "field": "message"},
    "prepare_js": r"""const recu = Date.parse(input.recu_le) || Date.now();
const d = new Date(recu); d.setMonth(d.getMonth() + 1);
vars.echeance = d.toISOString().slice(0, 10);""",
    "questions": {"droit": choice("Quel droit la personne exerce-t-elle ?", {
        "acces": "Obtenir ses données", "rectification": "Corriger ses données", "effacement": "Supprimer ses données",
        "opposition": "Refuser un traitement, la prospection", "portabilite": "Récupérer ses données dans un format réutilisable",
        "limitation": "Geler un traitement", "aucun": "Pas une demande RGPD"}),
        "identifiable": noul("Le message contient-il assez d'éléments pour retrouver la personne (nom, e-mail du compte, numéro client) ?")},
    "decision": {"mode": "rules", "verdicts": {"droit": {"min": 0.6}, "identifiable": {"oui": 0.6, "non": 0.3}},
                 "routes": ["acces", "rectification", "effacement", "opposition", "portabilite", "limitation", "verifier_identite", "pas_rgpd", "a_revoir"],
                 "rules": [rule("pas_rgpd", ("droit_verdict", "==", "aucun")), rule("a_revoir", ("droit_verdict", "==", "incertain")),
                           rule("verifier_identite", ("identifiable_verdict", "!=", "oui"), label="Identité à confirmer avant de répondre"),
                           rule("=droit_verdict", ("droit_verdict", "exists"))],
                 "default_route": "a_revoir", "post_js": "ctx.extra.echeance_legale = vars.echeance;"},
    "route_notes": {"verifier_identite": "Demande une preuve d'identité proportionnée, sans pièce d'identité par défaut.",
                    "effacement": "Transmets au responsable RGPD avec l'échéance.", "acces": "Prépare l'extraction des données pour le responsable RGPD."},
    "sample": {"message": "Je suis cliente (compte claire.martin@exemple.fr), merci de supprimer toutes mes données.", "recu_le": "2026-09-28"},
    "hub": {"playlist": "Support client", "allege": "aucune demande légale n'est oubliée, et son échéance est calculée."},
})

_t("jev-clauses-contrat", "Playlists du Hub", 3, {
    "name": "Contrats : repérage des clauses à risque",
    "description": "Découpe le contrat en clauses (code), puis pose à Jev une question de choix par clause, toutes dans un seul "
                   "appel. Le rapport liste les clauses à négocier, avec leur type de risque.",
    "trigger": {"type": "webhook", "path": "clauses-contrat"},
    "state": {"mode": "json"},
    "prepare_js": r"""const texte = String(input.texte || '');
const clauses = texte.split(/\n(?=\s*(?:Article|ARTICLE|Clause|\d+\s*[.)-]))/).map(c => c.trim()).filter(c => c.length > 20).slice(0, 60);
vars.nb_clauses = clauses.length;
vars.__clauses = clauses;
const RISQUES = { aucun: 'Aucun risque particulier', responsabilite_illimitee: 'Responsabilité non plafonnée ou garanties sans limite',
  penalites: 'Pénalités ou indemnités élevées', reconduction_tacite: 'Reconduction automatique difficile à dénoncer',
  exclusivite: "Exclusivité ou non-concurrence", resiliation_desequilibree: 'Conditions de résiliation déséquilibrées',
  donnees: 'Traitement de données sans garanties' };
clauses.forEach((c, i) => { questions['clause_' + i] = { type: 'choice', instructions: { clause: c.slice(0, 3000), question: 'Quel est le principal risque de cette `clause` pour nous ?' }, criteria: RISQUES }; });
return { contrat: input.titre || 'Contrat', clauses: clauses.length };""",
    "questions": {},
    "decision": {"mode": "rules", "verdicts": {"clauses": {"kind": "pour_chaque", "seuil": 0.5}},
                 "routes": ["risques_majeurs", "a_negocier", "sans_alerte", "a_revoir"], "rules": [], "default_route": "sans_alerte",
                 "post_js": r"""const MAJEURS = ['responsabilite_illimitee', 'exclusivite'];
const alertes = [];
for (let i = 0; i < 60; i++) {
  const a = answers['clause_' + i];
  if (!a) continue;
  if (a.choice !== 'aucun' && a.confidence >= 0.5) alertes.push({ clause: i + 1, risque: a.choice, confiance: Math.round(a.confidence * 100) / 100 });
}
for (const k of Object.keys(ctx.vars)) if (k.startsWith('clause_')) delete ctx.vars[k];
ctx.extra.alertes = alertes;
if (!vars.nb_clauses) { ctx.route = 'a_revoir'; ctx.reason = 'Aucune clause reconnue dans le texte'; }
else if (alertes.some(a => MAJEURS.includes(a.risque))) { ctx.route = 'risques_majeurs'; ctx.reason = alertes.length + ' clause(s) à risque dont au moins une majeure'; }
else if (alertes.length) { ctx.route = 'a_negocier'; ctx.reason = alertes.length + ' clause(s) à négocier'; }
else ctx.reason = vars.nb_clauses + ' clauses sans alerte';"""},
    "route_notes": {"risques_majeurs": "Transmets au juriste avec extra.alertes, sans avis juridique de ta part.",
                    "a_negocier": "Prépare la liste des points à négocier à partir de extra.alertes."},
    "sample": {"titre": "Contrat de prestation", "texte": "Article 1 - Objet. Le prestataire réalise la maintenance du parc informatique.\nArticle 2 - Responsabilité. Le client garantit le prestataire contre toute réclamation, sans limitation de montant.\nArticle 3 - Durée. Le contrat est reconduit tacitement par périodes de trois ans sauf dénonciation six mois avant l'échéance."},
    "hub": {"playlist": "Revue de contrats", "allege": "le juriste reçoit les clauses à risque déjà repérées et classées."},
})

_t("jev-fraude-fournisseur", "Playlists du Hub", 2, {
    "name": "Fraude au changement de RIB",
    "description": "Compare l'IBAN annoncé au dernier IBAN connu du fournisseur (mémoire de l'automate) et fait juger le message "
                   "par Jev : pression, secret, changement de coordonnées. Le scénario classique de la fraude au président.",
    "trigger": {"type": "webhook", "path": "fraude-fournisseur"},
    "state": {"mode": "field", "field": "message"},
    "prepare_js": r"""const memoire = typeof $getWorkflowStaticData === 'function' ? $getWorkflowStaticData('global') : {};
memoire.iban = memoire.iban || {};
const f = String(input.fournisseur || '').trim().toLowerCase();
const iban = String(input.iban || '').replace(/\s+/g, '').toUpperCase();
const connu = memoire.iban[f];
vars.iban_connu = Boolean(connu);
vars.iban_change = Boolean(connu && iban && connu !== iban);
if (!connu && iban) memoire.iban[f] = iban; // premier IBAN vu : devient la référence""",
    "questions": {"pression": noul("Le message presse-t-il d'agir vite, demande-t-il la discrétion ou de contourner la procédure habituelle ?"),
                  "changement": noul("Le message annonce-t-il un changement de coordonnées bancaires ?"),
                  "canal_inhabituel": noul("Le message demande-t-il de répondre ailleurs que d'habitude (autre adresse, téléphone personnel) ?")},
    "decision": {"mode": "rules", "verdicts": {"pression": {"oui": 0.6, "non": 0.3}, "changement": {"oui": 0.6, "non": 0.3}, "canal_inhabituel": {"oui": 0.6, "non": 0.3}},
                 "routes": ["bloquer", "verifier_par_telephone", "normal"],
                 "rules": [rule("bloquer", ("iban_change", "==", True), ("pression_verdict", "==", "oui"), label="IBAN changé et pression : fraude probable"),
                           rule("bloquer", ("canal_inhabituel_verdict", "==", "oui"), ("changement_verdict", "==", "oui")),
                           rule("verifier_par_telephone", ("iban_change", "==", True), label="IBAN différent du dernier connu"),
                           rule("verifier_par_telephone", ("changement_verdict", "!=", "non"))],
                 "default_route": "normal", "error_route": "verifier_par_telephone"},
    "route_notes": {"bloquer": "Ne paie pas, préviens la direction financière par un canal connu.",
                    "verifier_par_telephone": "Appelle le fournisseur au numéro déjà connu, jamais à celui du message."},
    "sample": {"fournisseur": "Bureau Plus", "iban": "FR1420041010050500013M02606", "message": "Suite à un changement de banque, merci d'utiliser désormais ce RIB. C'est urgent, nous comptons sur votre discrétion."},
    "hub": {"playlist": "Vérification des fournisseurs, Relance des factures impayées", "allege": "aucun paiement vers un nouvel IBAN ne dépend du jugement de l'agent."},
})

_t("jev-priorite-itil", "Playlists du Hub", 2, {
    "name": "Support informatique : priorité impact × urgence",
    "description": "Jev note l'impact et l'urgence sur des échelles ITIL ; la matrice de priorité P1 à P4 est dans le code, "
                   "identique pour tous les tickets.",
    "trigger": {"type": "webhook", "path": "priorite-itil"},
    "state": {"mode": "field", "field": "ticket"},
    "questions": {"impact": score("Combien de personnes le problème touche-t-il ?", ["Une personne", "Une équipe", "Un service", "Toute l'entreprise"]),
                  "urgence": score("À quelle vitesse la situation se dégrade-t-elle ?", ["Peut attendre", "Gêne le travail", "Bloque le travail", "Bloque une activité critique"])},
    "decision": {"mode": "rules", "routes": ["p1", "p2", "p3", "p4", "a_revoir"], "rules": [], "default_route": "a_revoir",
                 "post_js": r"""const MATRICE = [['p4', 'p4', 'p3', 'p3'], ['p4', 'p3', 'p2', 'p2'], ['p3', 'p2', 'p2', 'p1'], ['p3', 'p2', 'p1', 'p1']];
const i = answers.impact || {}, u = answers.urgence || {};
if (!(i.confidence >= 0.5 && u.confidence >= 0.5)) { ctx.route = 'a_revoir'; ctx.reason = 'Impact ou urgence incertain'; return; }
const ri = Math.round(i.score), ru = Math.round(u.score);
ctx.route = MATRICE[ri][ru];
ctx.reason = `Impact ${ri + 1}/4, urgence ${ru + 1}/4 : ${ctx.route.toUpperCase()}`;"""},
    "route_notes": {"p1": "Préviens l'astreinte immédiatement.", "p2": "Traite dans les 4 heures.", "p3": "File normale.", "p4": "À planifier."},
    "sample": {"ticket": "Plus personne au service comptable ne peut se connecter à l'ERP depuis 9 h, clôture ce soir."},
    "hub": {"playlist": "Support informatique", "allege": "la priorité ne dépend plus de l'humeur du modèle."},
})

_t("jev-credit-synthese", "Playlists du Hub", 2, {
    "name": "Crédit : ratios et points de vigilance",
    "description": "Calcule taux d'endettement et reste à vivre (code), repère un incident mentionné (Jev), et classe le dossier "
                   "pour l'analyste. Aucune décision d'octroi : l'automate prépare, l'analyste décide.",
    "trigger": {"type": "webhook", "path": "credit-synthese"},
    "state": {"mode": "field", "field": "commentaire"},
    "prepare_js": r"""const rev = Number(input.revenus_mensuels), ch = Number(input.charges_mensuelles || 0), m = Number(input.mensualite_demandee || 0);
vars.revenus_lus = rev > 0;
if (vars.revenus_lus) {
  vars.taux_endettement = Math.round(((ch + m) / rev) * 1000) / 1000;
  vars.reste_a_vivre = Math.round(rev - ch - m);
}""",
    "questions": {"incident": noul("Le commentaire mentionne-t-il un incident de paiement, un fichage bancaire, un découvert récurrent ou un litige ?"),
                  "revenus_instables": noul("Le commentaire indique-t-il des revenus irréguliers ou une situation professionnelle précaire ?")},
    "decision": {"mode": "rules", "verdicts": {"incident": {"oui": 0.6, "non": 0.3}, "revenus_instables": {"oui": 0.6, "non": 0.3}},
                 "routes": ["hors_norme", "vigilance", "standard", "a_revoir"],
                 "rules": [rule("a_revoir", ("revenus_lus", "==", False), label="Revenus absents"),
                           rule("hors_norme", ("taux_endettement", ">", 0.35), label="Endettement au-delà de 35 %"),
                           rule("vigilance", ("incident_verdict", "!=", "non")),
                           rule("vigilance", ("reste_a_vivre", "<", 800), label="Reste à vivre sous 800 €"),
                           rule("vigilance", ("revenus_instables_verdict", "==", "oui"))],
                 "default_route": "standard"},
    "route_notes": {"hors_norme": "Prépare la synthèse en signalant le dépassement ; l'analyste décide.",
                    "vigilance": "Liste les points de vigilance dans la synthèse."},
    "sample": {"revenus_mensuels": 3200, "charges_mensuelles": 650, "mensualite_demandee": 480, "commentaire": "CDI depuis 6 ans, aucun incident connu."},
    "hub": {"playlist": "Synthèse de dossiers de crédit", "allege": "les ratios sont calculés et vérifiés avant que l'agent rédige."},
})

_t("jev-retour-produit", "Métiers", 2, {
    "name": "E-commerce : demande de retour",
    "description": "Délai de rétractation de 14 jours calculé par le code, motif reconnu par Jev (défaut, erreur, colis abîmé "
                   "relèvent de la garantie). Gros montants et cas flous vont à un humain.",
    "trigger": {"type": "webhook", "path": "retour-produit"},
    "state": {"mode": "field", "field": "message"},
    "prepare_js": r"""const livre = Date.parse(input.livre_le);
vars.jours_depuis_livraison = Number.isNaN(livre) ? null : Math.floor((Date.now() - livre) / 86400000);
vars.dans_retractation = vars.jours_depuis_livraison !== null && vars.jours_depuis_livraison <= 14;
vars.montant = Number(input.montant) || 0;""",
    "questions": {"motif": choice("Pourquoi le client veut-il retourner l'article ?", {
        "defaut": "Produit défectueux ou ne fonctionne pas", "erreur_envoi": "Mauvais article ou mauvaise taille envoyée",
        "colis_abime": "Colis ou produit abîmé à la livraison", "ne_convient_pas": "Taille, couleur ou usage qui ne convient pas",
        "changement_avis": "Changement d'avis", "autre": None})},
    "decision": {"mode": "rules", "verdicts": {"motif": {"min": 0.6}},
                 "routes": ["garantie", "retour_standard", "humain", "hors_delai", "a_revoir"],
                 "rules": [rule("a_revoir", ("jours_depuis_livraison", "missing"), label="Date de livraison absente"),
                           rule("humain", ("montant", ">=", 300), label="Montant élevé"),
                           rule("garantie", ("motif_verdict", "in", "defaut,erreur_envoi,colis_abime")),
                           rule("a_revoir", ("motif_verdict", "==", "incertain")),
                           rule("retour_standard", ("dans_retractation", "==", True))],
                 "default_route": "hors_delai"},
    "route_notes": {"garantie": "Envoie l'étiquette de retour prépayée et propose échange ou remboursement.",
                    "retour_standard": "Envoie la procédure de retour, frais à la charge du client selon les CGV.",
                    "hors_delai": "Explique poliment que le délai de rétractation est dépassé."},
    "sample": {"commande": "C-88120", "montant": 59.9, "livre_le": "2026-09-22", "message": "La lampe ne s'allume pas du tout."},
    "hub": {"playlist": "Support client", "allege": "la politique de retour est appliquée par le code, pas réinterprétée."},
})

_t("jev-fraude-commande", "Métiers", 2, {
    "name": "E-commerce : risque de fraude d'une commande",
    "description": "Additionne des signaux calculés (montant, pays différents, client nouveau, e-mail jetable) et un jugement "
                   "de Jev sur la note du client. Bloquer, vérifier ou accepter, par des règles relisibles.",
    "trigger": {"type": "webhook", "path": "fraude-commande"},
    "state": {"mode": "field", "field": "note_client"},
    "prepare_js": r"""const JETABLES = ['yopmail.com', 'mailinator.com', 'guerrillamail.com', 'tempmail.com', '10minutemail.com'];
const domaine = String(input.email || '').split('@')[1] || '';
const signaux = [];
if (Number(input.montant) >= 500) signaux.push('montant élevé');
if (input.pays_facturation && input.pays_livraison && input.pays_facturation !== input.pays_livraison) signaux.push('pays différents');
if (input.client_nouveau === true || input.client_nouveau === 'true') signaux.push('client nouveau');
if (JETABLES.includes(domaine.toLowerCase())) signaux.push('e-mail jetable');
vars.signaux = signaux;
vars.nb_signaux = signaux.length;
return input.note_client || '(aucune note)';""",
    "questions": {"note_suspecte": noul("La note demande-t-elle une livraison inhabituelle, un changement d'adresse après paiement, ou invoque-t-elle une urgence injustifiée ?")},
    "decision": {"mode": "rules", "verdicts": {"note_suspecte": {"oui": 0.65, "non": 0.3}},
                 "routes": ["bloquer", "verifier", "accepter"],
                 "rules": [rule("bloquer", ("nb_signaux", ">=", 3)),
                           rule("bloquer", ("nb_signaux", ">=", 2), ("note_suspecte_verdict", "==", "oui")),
                           rule("verifier", ("nb_signaux", ">=", 2)), rule("verifier", ("note_suspecte_verdict", "!=", "non"))],
                 "default_route": "accepter", "error_route": "verifier"},
    "sample": {"commande": "C-99102", "montant": 740, "pays_facturation": "FR", "pays_livraison": "BE", "client_nouveau": True,
               "email": "achat@yopmail.com", "note_client": "Livrez vite svp, c'est un cadeau urgent, à une autre adresse que prévu."},
    "hub": {"playlist": "Support client, Finance", "allege": "l'agent ne décide jamais seul de bloquer une commande."},
})

_t("jev-evaluateur-reponse", "Primitives Jev", 2, {
    "name": "Évaluateur de réponse avant envoi",
    "description": "Juge un brouillon d'agent avant qu'il parte : répond-il à la question, invente-t-il un fait absent de la "
                   "source, promet-il ce qu'il ne doit pas, le ton convient-il. Si non, un LLM réécrit avec les défauts nommés.",
    "trigger": {"type": "webhook", "path": "evaluateur-reponse"},
    "state": {"mode": "fields", "fields": ["question", "reponse", "source"]},
    "questions": {"repond": noul("La `reponse` répond-elle directement à la `question` ?"),
                  "invente": noul("La `reponse` affirme-t-elle un fait, un chiffre ou une date qui ne figure pas dans la `source` ?"),
                  "promesse": noul("La `reponse` promet-elle un remboursement, un délai, un prix ou un geste commercial ?"),
                  "ton": score("Le ton de la `reponse` convient-il à un client ?", ["Inadapté", "Maladroit", "Correct", "Excellent"])},
    "decision": {"mode": "rules", "verdicts": {"repond": {"oui": 0.65, "non": 0.35}, "invente": {"oui": 0.5, "non": 0.2},
                                                "promesse": {"oui": 0.5, "non": 0.2}, "ton": {"min": 0.5, "cuts": [{"max": 1.5, "label": "a_reprendre"}], "else": "bon"}},
                 "routes": ["envoyer", "reecrire", "humain"],
                 "rules": [rule("humain", ("promesse_verdict", "==", "oui"), label="Engagement commercial : validation humaine"),
                           rule("reecrire", ("invente_verdict", "!=", "non"), label="Fait absent de la source"),
                           rule("reecrire", ("repond_verdict", "!=", "oui"), label="Ne répond pas à la question"),
                           rule("reecrire", ("ton_verdict", "==", "a_reprendre"), label="Ton à reprendre")],
                 "default_route": "envoyer", "error_route": "humain"},
    "llm": {"route": "reecrire", "provider": "openrouter", "model": "openrouter/auto",
            "system": "Réécris la réponse au client en corrigeant exactement le défaut indiqué dans decision.raison. N'utilise que les faits "
                      "de la source. Aucune promesse commerciale. Français, bref."},
    "sample": {"question": "Quand ma commande 5521 sera-t-elle livrée ?", "reponse": "Elle arrivera demain avant midi, promis !",
               "source": "Commande 5521 : expédiée le 26/09, transporteur Colissimo, délai annoncé 48 à 72 h."},
    "hub": {"playlist": "Support client, et tout agent qui rédige", "allege": "l'agent n'a pas à se relire : l'évaluateur le fait pour quelques millièmes de centime."},
}, source="Patron « Evaluator-optimizer » de « Building effective agents » (Anthropic) et cookbook TypeSafe « Double-checking citations »")

_t("jev-post-linkedin", "Playlists du Hub", 2, {
    "name": "LinkedIn : contrôle avant publication",
    "description": "Longueur, hashtags et liens vérifiés par le code ; chiffres non sourcés, informations confidentielles et "
                   "ton jugés par Jev. Garde-fou avant le modèle n8n « LinkedIn publication » du hub.",
    "trigger": {"type": "webhook", "path": "post-linkedin"},
    "state": {"mode": "field", "field": "texte"},
    "prepare_js": r"""const t = String(input.texte || '');
vars.longueur = t.length;
vars.hashtags = (t.match(/#[\p{L}\d_]+/gu) || []).length;
vars.liens = (t.match(/https?:\/\//g) || []).length;""",
    "questions": {"chiffre_non_source": noul("Le texte avance-t-il un chiffre ou un résultat sans en citer la source ?"),
                  "confidentiel": noul("Le texte révèle-t-il un client, un contrat, un prix ou une information interne non publique ?"),
                  "ton": score("Le ton est-il professionnel ?", ["Déplacé", "Familier", "Professionnel", "Exemplaire"])},
    "decision": {"mode": "rules", "verdicts": {"chiffre_non_source": {"oui": 0.6, "non": 0.3}, "confidentiel": {"oui": 0.5, "non": 0.2},
                                                "ton": {"min": 0.5, "cuts": [{"max": 1.4, "label": "a_revoir"}], "else": "ok"}},
                 "routes": ["publier", "corriger", "humain"],
                 "rules": [rule("humain", ("confidentiel_verdict", "!=", "non"), label="Information possiblement confidentielle"),
                           rule("corriger", ("longueur", ">", 3000), label="Plus de 3 000 caractères"),
                           rule("corriger", ("hashtags", ">", 5), label="Plus de 5 hashtags"),
                           rule("corriger", ("chiffre_non_source_verdict", "==", "oui"), label="Chiffre sans source"),
                           rule("corriger", ("ton_verdict", "==", "a_revoir"))],
                 "default_route": "publier", "error_route": "humain"},
    "route_notes": {"publier": "Soumets au propriétaire pour la publication (outil linkedin_publier).",
                    "corriger": "Corrige exactement le point indiqué dans la raison, puis repasse le contrôle."},
    "sample": {"texte": "Nous avons réduit de 40 % le temps de clôture de nos clients grâce à l'automatisation. #finance #automatisation"},
    "hub": {"playlist": "LinkedIn publication (modèle n8n du hub)", "allege": "aucune publication publique ne part sans contrôle écrit."},
})

_t("jev-carrousel-instagram", "Playlists du Hub", 2, {
    "name": "Carrousel Instagram : contrôle des cinq images",
    "description": "Vérifie le nombre de diapositives et la longueur de chaque texte (code), puis demande à Jev, pour chaque "
                   "diapositive, si elle se comprend seule. Consigne « carrousel-instagram » du Video-bot.",
    "trigger": {"type": "webhook", "path": "carrousel-instagram"},
    "state": {"mode": "json"},
    "prepare_js": r"""const slides = Array.isArray(input.diapositives) ? input.diapositives.map(String) : [];
vars.nb = slides.length;
vars.trop_longues = slides.map((s, i) => [i + 1, s.split(/\s+/).filter(Boolean).length]).filter(([, n]) => n > 25).map(([i]) => i);
vars.__diapos = slides;
slides.forEach((s, i) => { questions['diapos__' + i] = { type: 'noul', instructions: { element: s, sujet: input.sujet || '', question: "L'`element` (texte d'une diapositive) se comprend-il seul et sert-il le `sujet` ?" } }; });
return { sujet: input.sujet, diapositives: slides };""",
    "questions": {"personne_reelle": noul("Le carrousel représente-t-il ou cite-t-il une personne réelle identifiable ?"),
                  "coherence": noul("Les diapositives racontent-elles une progression cohérente du début à la fin ?")},
    "decision": {"mode": "rules", "verdicts": {"diapos": {"kind": "pour_chaque", "seuil": 0.6},
                                                "personne_reelle": {"oui": 0.4, "non": 0.15}, "coherence": {"oui": 0.6, "non": 0.3}},
                 "routes": ["generer", "corriger", "refuser", "a_revoir"],
                 "rules": [rule("refuser", ("personne_reelle_verdict", "==", "oui"), label="Personne réelle : interdit de la mission"),
                           rule("corriger", ("nb", "!=", 5), label="Il faut exactement 5 diapositives"),
                           rule("corriger", ("trop_longues", "exists"), label="Diapositive de plus de 25 mots"),
                           rule("corriger", ("diapos_verdict", "!=", "tous"), label="Diapositive qui ne se comprend pas seule"),
                           rule("a_revoir", ("coherence_verdict", "!=", "oui"))],
                 "default_route": "generer"},
    "sample": {"sujet": "Ranger son bureau en 5 gestes", "diapositives": ["Ton bureau déborde ?", "1. Vide tout", "2. Trie en trois tas", "3. Un organiseur par usage", "4. Cinq minutes chaque soir"]},
    "hub": {"playlist": "Générateur Vidéo Réseaux Sociaux", "agent": "Video-bot", "allege": "la génération des 5 images ne part qu'avec un texte conforme."},
})

_t("jev-google-ads-termes", "Playlists du Hub", 3, {
    "name": "Google Ads : termes de recherche à exclure",
    "description": "Pour chaque terme de recherche du rapport, un oui/non de Jev : correspond-il à quelqu'un qui cherche notre "
                   "offre ? Les autres deviennent une liste de mots clés négatifs proposée, jamais appliquée seule.",
    "trigger": {"type": "webhook", "path": "google-ads-termes"},
    "state": {"mode": "json"},
    "prepare_js": r"""const termes = (Array.isArray(input.termes) ? input.termes : []).map(t => typeof t === 'object' ? String(t.terme || '') : String(t)).filter(Boolean).slice(0, 150);
vars.__termes = termes;
termes.forEach((t, i) => { questions['termes__' + i] = { type: 'noul', instructions: { element: t, offre: input.offre || '', question: "Une personne qui tape l'`element` cherche-t-elle quelque chose que propose notre `offre` ?" } }; });
return { offre: input.offre, nombre: termes.length };""",
    "questions": {},
    "decision": {"mode": "rules", "verdicts": {"termes": {"kind": "pour_chaque", "seuil": 0.5}},
                 "routes": ["proposer_negatifs", "rien_a_exclure", "a_revoir"],
                 "rules": [rule("rien_a_exclure", ("termes_verdict", "==", "tous"))],
                 "default_route": "proposer_negatifs",
                 "post_js": r"""const tous = (input.termes || []).map(t => typeof t === 'object' ? String(t.terme || '') : String(t)).filter(Boolean).slice(0, 150);
const gardes = new Set(vars.termes_retenus || []);
ctx.extra.negatifs_proposes = tous.filter(t => !gardes.has(t));
for (const k of Object.keys(ctx.vars)) if (k.startsWith('termes__')) delete ctx.vars[k];
if (!tous.length) { ctx.route = 'a_revoir'; ctx.reason = 'Aucun terme reçu'; }
else if (ctx.route === 'proposer_negatifs') ctx.reason = ctx.extra.negatifs_proposes.length + ' terme(s) hors cible sur ' + tous.length;"""},
    "route_notes": {"proposer_negatifs": "Présente extra.negatifs_proposes au propriétaire ; n'ajoute rien au compte sans son accord."},
    "sample": {"offre": "Logiciel de comptabilité fournisseurs pour PME", "termes": ["logiciel comptabilité fournisseurs", "comptable freelance paris", "formation comptabilité gratuite", "automatiser saisie factures fournisseurs"]},
    "hub": {"playlist": "Google Ads pilotage (modèle n8n du hub)", "allege": "l'agent ne lit plus le rapport de termes ligne à ligne."},
})

_t("jev-dedoublonnage-crm", "Métiers", 2, {
    "name": "CRM : deux fiches, une seule entreprise ?",
    "description": "Jev note la probabilité que deux fiches désignent la même entité et signale les champs qui divergent. "
                   "Fusion, revue ou fiches distinctes selon des tranches.",
    "trigger": {"type": "webhook", "path": "dedoublonnage-crm"},
    "state": {"mode": "fields", "fields": ["fiche_a", "fiche_b"]},
    "questions": {"meme": score("La `fiche_a` et la `fiche_b` désignent-elles la même entreprise ?", ["Certainement pas", "Probablement pas", "Probablement", "Certainement"]),
                  "nom_diverge": noul("Les noms de la `fiche_a` et de la `fiche_b` désignent-ils des entreprises différentes, au-delà des variantes d'écriture ?"),
                  "adresse_diverge": noul("Les adresses de la `fiche_a` et de la `fiche_b` sont-elles incompatibles ?")},
    "decision": {"mode": "rules", "verdicts": {"meme": {"min": 0.5, "cuts": [{"max": 1.0, "label": "distinctes"}, {"max": 2.4, "label": "douteux"}], "else": "identiques"},
                                                "nom_diverge": {"oui": 0.6, "non": 0.3}, "adresse_diverge": {"oui": 0.6, "non": 0.3}},
                 "routes": ["fusionner", "revoir", "distinctes"],
                 "rules": [rule("distinctes", ("meme_verdict", "==", "distinctes")),
                           rule("revoir", ("nom_diverge_verdict", "!=", "non")), rule("revoir", ("adresse_diverge_verdict", "==", "oui")),
                           rule("fusionner", ("meme_verdict", "==", "identiques"))],
                 "default_route": "revoir"},
    "sample": {"fiche_a": {"nom": "Transports Lemoine SAS", "ville": "Lyon", "site": "lemoine-transports.fr"},
               "fiche_b": {"nom": "Lemoine Transports", "ville": "Lyon 7e", "site": "www.lemoine-transports.fr"}},
    "hub": {"playlist": "Qualification et prospection commerciale", "allege": "le CRM reste propre sans que l'agent compare les fiches."},
}, source="Cookbook TypeSafe « Knowledge graph entity alignment »")

_t("jev-rapprochement-libelle", "Playlists du Hub", 3, {
    "name": "Rapprochement : quel encaissement pour quelle facture",
    "description": "Le code présélectionne les factures ouvertes du même montant ; Jev choisit celle que le libellé bancaire "
                   "désigne. Rapprochement proposé seulement si montant exact et choix net.",
    "trigger": {"type": "webhook", "path": "rapprochement-libelle"},
    "state": {"mode": "json"},
    "prepare_js": r"""const m = input.mouvement || {};
const montant = Math.round(Number(m.montant) * 100) / 100;
const ouvertes = Array.isArray(input.factures_ouvertes) ? input.factures_ouvertes : [];
let candidats = ouvertes.filter(f => Math.abs(Number(f.montant) - montant) < 0.01);
vars.montant_exact = candidats.length > 0;
if (!candidats.length) candidats = ouvertes.slice(0, 50);
vars.candidats = candidats.map(f => f.numero);
const libelles = candidats.map(f => `${f.numero} · ${f.client} · ${f.montant} €`);
vars.__facture = libelles;
if (libelles.length >= 2) questions.facture = { type: 'choice', instructions: { mouvement: m, question: 'Quelle facture le `mouvement` bancaire règle-t-il ?' },
  criteria: Object.fromEntries(libelles.map((l, i) => ['c' + i, l])) };
vars.nb_candidats = libelles.length;
return { mouvement: m };""",
    "questions": {},
    "decision": {"mode": "rules", "verdicts": {"facture": {"kind": "liste_choix", "min": 0.7, "marge": 0.2}},
                 "routes": ["rapproche", "a_verifier", "aucun_candidat"],
                 "rules": [rule("aucun_candidat", ("nb_candidats", "==", 0)),
                           rule("a_verifier", ("montant_exact", "==", False), label="Aucun montant identique : écart à expliquer"),
                           rule("a_verifier", ("facture_verdict", "in", "incertain,hesitation,aucun"))],
                 "default_route": "rapproche",
                 "post_js": "ctx.extra.facture = ctx.route === 'rapproche' ? String(vars.facture_verdict).split(' · ')[0] : null;"},
    "route_notes": {"rapproche": "Propose l'écriture de rapprochement pour extra.facture ; le comptable valide.",
                    "a_verifier": "Liste le mouvement dans les écarts avec les candidats."},
    "sample": {"mouvement": {"date": "2026-09-25", "montant": 1840, "libelle": "VIR ATELIER MARTIN FACT 0412"},
               "factures_ouvertes": [{"numero": "F-2026-0412", "client": "Atelier Martin", "montant": 1840},
                                     {"numero": "F-2026-0419", "client": "Boulangerie Roux", "montant": 1840},
                                     {"numero": "F-2026-0420", "client": "Atelier Martin", "montant": 320}]},
    "hub": {"playlist": "Rapprochement bancaire", "allege": "l'agent ne rapproche plus à la main : il ne traite que les écarts."},
}, source="Cookbook TypeSafe « Re-ranking » appliqué au rapprochement")

_t("jev-kyc-coherence", "Playlists du Hub", 2, {
    "name": "KYC : cohérence entre les pièces",
    "description": "Complète la complétude du dossier : Jev vérifie que noms et adresses concordent entre les pièces et repère "
                   "une activité listée comme sensible par votre procédure. Toujours transmis à l'analyste.",
    "trigger": {"type": "webhook", "path": "kyc-coherence"},
    "state": {"mode": "json"},
    "questions": {"noms": noul("Les noms figurant sur les différentes pièces désignent-ils la même personne ou la même société ?"),
                  "adresses": noul("Les adresses figurant sur les pièces sont-elles concordantes ?"),
                  "activite_sensible": noul({"activites_sensibles": ["change manuel", "cryptoactifs", "négoce d'œuvres d'art", "jeux d'argent", "à compléter selon votre procédure"],
                                             "question": "L'activité déclarée relève-t-elle de l'une des `activites_sensibles` ?"})},
    "decision": {"mode": "rules", "verdicts": {"noms": {"oui": 0.7, "non": 0.35}, "adresses": {"oui": 0.7, "non": 0.35}, "activite_sensible": {"oui": 0.5, "non": 0.2}},
                 "routes": ["incoherence", "vigilance_renforcee", "standard"],
                 "rules": [rule("incoherence", ("noms_verdict", "!=", "oui"), label="Noms discordants ou incertains"),
                           rule("incoherence", ("adresses_verdict", "==", "non"), label="Adresses discordantes"),
                           rule("vigilance_renforcee", ("activite_sensible_verdict", "!=", "non"))],
                 "default_route": "standard", "error_route": "vigilance_renforcee"},
    "route_notes": {"incoherence": "Liste les écarts pour l'analyste et la question à poser au client.",
                    "vigilance_renforcee": "Signale le motif à l'analyste ; ne conclus jamais sur l'acceptation."},
    "sample": {"identite": "Nom : LEMOINE Anne, née le 04/05/1980", "justificatif_domicile": "Mme Anne Lemoine, 12 rue des Lilas, 69003 Lyon",
               "kbis": "Transports Lemoine SAS, siège 12 rue des Lilas 69003 Lyon, présidente Anne Lemoine, activité : transport routier"},
    "hub": {"playlist": "Pré-analyse de dossiers KYC", "allege": "la comparaison des pièces est faite avant que l'agent rédige ses points de vigilance."},
})

_t("jev-veille-reglementaire", "Métiers", 3, {
    "name": "Veille réglementaire quotidienne",
    "description": "Chaque matin, lit un flux RSS réglementaire, écarte les articles déjà vus, juge s'ils concernent votre "
                   "secteur, note l'impact, classe le domaine, et fait résumer par un LLM les seuls textes à analyser.",
    "trigger": {"type": "schedule", "every": "days", "interval": 1, "at_hour": 7},
    "source": {"type": "rss", "url": "https://www.cnil.fr/fr/rss.xml"},
    "state": {"mode": "fields", "fields": ["title", "contentSnippet"]},
    "prepare_js": r"""const memoire = typeof $getWorkflowStaticData === 'function' ? $getWorkflowStaticData('global') : {};
memoire.vus = memoire.vus || {};
const cle = input.link || input.guid || input.title;
vars.deja_vu = Boolean(memoire.vus[cle]);
memoire.vus[cle] = new Date().toISOString().slice(0, 10);""",
    "questions": {"concerne": noul({"secteur": "Éditeur de logiciels B2B hébergeant des données de clients européens",
                                    "question": "Le texte crée-t-il une obligation ou un risque pour une entreprise du `secteur` ?"}),
                  "impact": score("Quel est l'impact pratique pour une entreprise concernée ?", ["Aucun", "Information", "Adaptation à prévoir", "Obligation à court terme"]),
                  "domaine": choice("Quel domaine juridique principal ?", {"donnees_personnelles": None, "fiscal": None, "social": None, "cybersecurite": None, "autre": None})},
    "decision": {"mode": "rules", "verdicts": {"concerne": {"oui": 0.65, "non": 0.3},
                                                "impact": {"min": 0.5, "cuts": [{"max": 1.5, "label": "faible"}], "else": "fort"}, "domaine": {"min": 0.5}},
                 "routes": ["a_analyser", "pour_information", "ignorer"],
                 "rules": [rule("ignorer", ("deja_vu", "==", True), label="Déjà traité"),
                           rule("a_analyser", ("concerne_verdict", "==", "oui"), ("impact_verdict", "==", "fort")),
                           rule("pour_information", ("concerne_verdict", "!=", "non"))],
                 "default_route": "ignorer", "error_route": "pour_information"},
    "llm": {"route": "a_analyser", "provider": "openrouter", "model": "openrouter/auto",
            "system": "Résume le texte réglementaire en français : ce qui change, pour qui, à partir de quand, et la première action à mener. "
                      "Cinq lignes au plus, sans rien inventer au-delà de l'extrait."},
    "sample": [{"title": "Nouvelles recommandations sur la sécurité des sauvegardes", "contentSnippet": "La CNIL publie...", "link": "https://exemple.fr/r1"}],
    "hub": {"playlist": "Veille concurrentielle (déclinaison réglementaire)", "allege": "seuls les textes à fort impact arrivent, déjà résumés."},
})
