"""Fiches types du Labo Jev : des points de depart remplis, qui montrent chacun une facon d'exploiter Jev.

Chaque fiche porte ses cas de test (resultat attendu et verdicts attendus) : ils servent au banc d'essai et
au calibrage automatique des seuils.
"""

from __future__ import annotations

import copy
from typing import Any

FICHES: list[dict[str, Any]] = []


def _f(fid: str, niveau: int, montre: str, fiche: dict[str, Any]) -> None:
    FICHES.append({"id": fid, "niveau": niveau, "montre": montre, "fiche": fiche})


_f("tri-emails", 1, "Choix, oui/non et score en tranches", {
    "name": "Tri des e-mails entrants",
    "objectif": "Ranger chaque e-mail reçu : à traiter vite, à traiter, à classer, ou à relire par un humain.",
    "entree": {"mode": "field", "field": "message"},
    "exemple": {"message": "Bonjour, notre site de commande ne répond plus depuis ce matin, nos clients ne peuvent plus payer."},
    "questions": [
        {"id": "sujet", "type": "choice", "question": "De quoi parle principalement cet e-mail ?",
         "aide": "Le sujet choisit la file de traitement.",
         "options": [{"mot": "incident", "description": "Panne, bug, service indisponible"},
                     {"mot": "facturation", "description": "Facture, paiement, avoir"},
                     {"mot": "commercial", "description": "Devis, tarif, nouvelle demande"},
                     {"mot": "information", "description": "Newsletter, notification automatique, pour information"}],
         "confiance_min": 60, "marge": 10},
        {"id": "action", "type": "noul", "question": "L'expéditeur attend-il une action ou une réponse de notre part ?",
         "oui_signifie": "Une demande explicite ou implicite", "non_signifie": "Simple information",
         "seuil_oui": 65, "seuil_non": 35},
        {"id": "impact", "type": "score", "question": "Quel est l'impact décrit pour l'expéditeur ?",
         "niveaux": ["Aucun", "Gêne légère", "Activité perturbée", "Activité bloquée"], "confiance_min": 50,
         "tranches": [{"jusqu_a": 1.4, "mot": "faible"}, {"jusqu_a": 2.3, "mot": "moyen"}], "au_dela": "fort"},
    ],
    "resultats": [
        {"id": "traiter_vite", "label": "À traiter dans l'heure", "consigne": "Préviens l'équipe concernée et accuse réception."},
        {"id": "traiter", "label": "À traiter", "consigne": "Ajoute à la file du service correspondant au sujet."},
        {"id": "classer", "label": "À classer", "consigne": "Archive sans répondre."},
        {"id": "a_relire", "label": "À relire par un humain", "consigne": "Pose la question à l'équipe avec hub_ask_human."},
    ],
    "regles": [
        {"si": [{"question": "sujet", "op": "est", "valeur": "incertain"}], "alors": "a_relire", "pourquoi": "Jev n'est pas sûr du sujet"},
        {"si": [{"question": "sujet", "op": "est", "valeur": "hesitation"}], "alors": "a_relire", "pourquoi": "Deux sujets presque à égalité"},
        {"si": [{"question": "action", "op": "est", "valeur": "oui"}, {"question": "impact", "op": "est", "valeur": "fort"}],
         "alors": "traiter_vite", "pourquoi": "Action attendue et activité bloquée"},
        {"si": [{"question": "action", "op": "est", "valeur": "oui"}], "alors": "traiter"},
        {"si": [{"question": "action", "op": "est", "valeur": "a_verifier"}], "alors": "a_relire"},
    ],
    "par_defaut": "classer",
    "si_jev_indisponible": "a_relire",
    "tests": [
        {"entree": "Notre site de commande ne répond plus depuis ce matin, nos clients ne peuvent plus payer.", "attendu": "traiter_vite",
         "attendus": {"sujet": "incident", "action": "oui", "impact": "fort"}},
        {"entree": "Pouvez-vous m'envoyer un devis pour 3 licences supplémentaires ?", "attendu": "traiter",
         "attendus": {"sujet": "commercial", "action": "oui"}},
        {"entree": "Votre facture de septembre est disponible dans votre espace client.", "attendu": "classer",
         "attendus": {"sujet": "information", "action": "non"}},
        {"entree": "La facture F-2231 comporte une erreur de TVA, merci de nous envoyer un avoir.", "attendu": "traiter",
         "attendus": {"sujet": "facturation", "action": "oui"}},
        {"entree": "Découvrez nos nouveautés du mois d'octobre !", "attendu": "classer", "attendus": {"action": "non"}},
        {"entree": "L'export PDF plante parfois, ce n'est pas urgent mais c'est pénible.", "attendu": "traiter",
         "attendus": {"sujet": "incident", "action": "oui", "impact": "faible"}},
    ],
    "hub": {"playlist": "Support client, assistant Gmail"},
})

_f("moderation-commentaires", 2, "Étiquettes multiples et données de référence", {
    "name": "Modération des commentaires",
    "objectif": "Décider pour chaque commentaire publié sous nos vidéos : le laisser, y répondre, le masquer ou le signaler.",
    "entree": {"mode": "field", "field": "commentaire"},
    "exemple": {"commentaire": "Super vidéo ! Vous livrez en Belgique ?"},
    "questions": [
        {"id": "problemes", "type": "etiquettes",
         "question": "Le commentaire relève-t-il de l'`etiquette` décrite par `definition` ?",
         "aide": "Chaque étiquette est jugée séparément : un commentaire peut en cumuler plusieurs.",
         "options": [{"mot": "insulte", "description": "Insulte ou attaque personnelle"},
                     {"mot": "haine", "description": "Propos haineux visant un groupe"},
                     {"mot": "spam", "description": "Publicité, lien promotionnel, arnaque"},
                     {"mot": "donnees_perso", "description": "Numéro de téléphone, adresse, e-mail d'une personne"}],
         "seuil": 60},
        {"id": "question_client", "type": "noul", "question": "Le commentaire pose-t-il une question sur nos `produits` ou nos services ?",
         "donnees": {"produits": ["organiseur de bureau", "lampe d'appoint", "livraison", "retours"]},
         "seuil_oui": 60, "seuil_non": 30},
    ],
    "resultats": [
        {"id": "signaler", "label": "Signaler et masquer", "consigne": "Masque le commentaire et préviens l'équipe."},
        {"id": "masquer", "label": "Masquer", "consigne": "Masque le commentaire sans répondre."},
        {"id": "repondre", "label": "Répondre", "consigne": "Rédige une réponse courte et aimable."},
        {"id": "laisser", "label": "Laisser", "consigne": "Ne rien faire."},
    ],
    "regles": [
        {"si": [{"question": "problemes", "op": "contient", "valeur": "haine"}], "alors": "signaler"},
        {"si": [{"question": "problemes", "op": "contient", "valeur": "insulte"}], "alors": "masquer"},
        {"si": [{"question": "problemes", "op": "contient", "valeur": "spam"}], "alors": "masquer"},
        {"si": [{"question": "problemes", "op": "contient", "valeur": "donnees_perso"}], "alors": "masquer",
         "pourquoi": "Protéger la personne dont les coordonnées sont publiées"},
        {"si": [{"question": "question_client", "op": "est", "valeur": "oui"}], "alors": "repondre"},
    ],
    "par_defaut": "laisser",
    "si_jev_indisponible": "laisser",
    "tests": [
        {"entree": "Super vidéo ! Vous livrez en Belgique ?", "attendu": "repondre", "attendus": {"question_client": "oui"}},
        {"entree": "Gagnez 500 € par jour, cliquez sur mon profil !!!", "attendu": "masquer"},
        {"entree": "T'es vraiment un incapable, ta vidéo est nulle.", "attendu": "masquer"},
        {"entree": "Trop bien, j'adore ce format.", "attendu": "laisser", "attendus": {"question_client": "non"}},
        {"entree": "Appelez Julie au 06 12 34 56 78, elle vend les mêmes moins cher.", "attendu": "masquer"},
    ],
    "hub": {"playlist": "Générateur Vidéo Réseaux Sociaux", "agent": "Video-bot"},
})

_f("meilleure-reponse", 2, "Choix dans une liste reçue en entrée (reclassement)", {
    "name": "Choisir la meilleure réponse parmi des brouillons",
    "objectif": "Parmi plusieurs brouillons écrits par l'agent, garder celui qui répond le mieux à la demande du client.",
    "entree": {"mode": "fields", "fields": ["demande", "brouillons"]},
    "exemple": {"demande": "Puis-je changer l'adresse de livraison de ma commande 5521 ?",
                "brouillons": ["Oui, c'est possible tant que la commande n'est pas expédiée : répondez-nous avec la nouvelle adresse.",
                               "Merci pour votre message, nous revenons vers vous rapidement.",
                               "Nos délais de livraison sont de 3 à 5 jours ouvrés."]},
    "questions": [
        {"id": "meilleur", "type": "liste", "question": "Quel brouillon répond le plus exactement à la `demande` du client ?",
         "champ_liste": "brouillons", "confiance_min": 55, "marge": 15},
        {"id": "sensible", "type": "noul", "question": "La demande porte-t-elle sur un litige, un remboursement ou une menace ?",
         "seuil_oui": 60, "seuil_non": 30},
    ],
    "resultats": [
        {"id": "envoyer", "label": "Envoyer le brouillon choisi", "consigne": "Envoie le brouillon indiqué dans meilleur_verdict."},
        {"id": "reecrire", "label": "Réécrire", "consigne": "Aucun brouillon ne se détache : écris-en un nouveau."},
        {"id": "humain", "label": "Faire valider", "consigne": "Soumets le brouillon choisi à un humain avant envoi."},
    ],
    "regles": [
        {"si": [{"question": "sensible", "op": "n_est_pas", "valeur": "non"}], "alors": "humain"},
        {"si": [{"question": "meilleur", "op": "est", "valeur": "incertain"}], "alors": "reecrire"},
        {"si": [{"question": "meilleur", "op": "est", "valeur": "hesitation"}], "alors": "reecrire"},
        {"si": [{"question": "meilleur", "op": "est", "valeur": "aucun"}], "alors": "reecrire"},
    ],
    "par_defaut": "envoyer",
    "si_jev_indisponible": "humain",
    "tests": [
        {"entree": {"demande": "Puis-je changer l'adresse de livraison de ma commande 5521 ?",
                    "brouillons": ["Oui, tant que la commande n'est pas expédiée : envoyez-nous la nouvelle adresse.",
                                   "Nos délais de livraison sont de 3 à 5 jours ouvrés."]},
         "attendu": "envoyer", "attendus": {"sensible": "non"}},
        {"entree": {"demande": "Je veux être remboursé, sinon je porte plainte.",
                    "brouillons": ["Nous comprenons votre mécontentement.", "Le remboursement est possible sous 14 jours."]},
         "attendu": "humain", "attendus": {"sensible": "oui"}},
    ],
    "hub": {"playlist": "Support client", "agent": "support-bot"},
})

_f("lignes-facture", 3, "Même question pour chaque élément d'une liste", {
    "name": "Contrôle des lignes d'une facture fournisseur",
    "objectif": "Vérifier que chaque ligne d'une facture correspond à une `categorie` autorisée par la politique d'achat.",
    "entree": {"mode": "json"},
    "exemple": {"fournisseur": "Bureau Plus", "lignes": ["Ramettes papier A4 x10", "Casque audio sans fil", "Abonnement streaming vidéo"]},
    "questions": [
        {"id": "conformes", "type": "pour_chaque",
         "question": "L'`element` (ligne de facture) entre-t-il dans l'une des `categories_autorisees` ?",
         "donnees": {"categories_autorisees": ["fournitures de bureau", "matériel informatique", "logiciels professionnels"]},
         "champ_liste": "lignes", "seuil": 60},
    ],
    "resultats": [
        {"id": "valider", "label": "Toutes les lignes sont conformes", "consigne": "Transmets la facture au paiement."},
        {"id": "a_justifier", "label": "Certaines lignes à justifier",
         "consigne": "Demande un justificatif pour les lignes absentes de conformes_retenus."},
        {"id": "refuser", "label": "Aucune ligne conforme", "consigne": "Transmets au responsable des achats."},
    ],
    "regles": [
        {"si": [{"question": "conformes", "op": "est", "valeur": "tous"}], "alors": "valider"},
        {"si": [{"question": "conformes", "op": "est", "valeur": "aucun"}], "alors": "refuser"},
    ],
    "par_defaut": "a_justifier",
    "si_jev_indisponible": "a_justifier",
    "tests": [
        {"entree": {"lignes": ["Ramettes papier A4 x10", "Stylos bille x50"]}, "attendu": "valider"},
        {"entree": {"lignes": ["Ramettes papier A4 x10", "Abonnement streaming vidéo"]}, "attendu": "a_justifier"},
        {"entree": {"lignes": ["Voyage en Grèce", "Abonnement streaming vidéo"]}, "attendu": "refuser"},
    ],
    "hub": {"playlist": "Contrôle des notes de frais, Rapprochement bancaire"},
})

_f("qualification-prospect", 2, "Scores découpés en tranches nommées", {
    "name": "Qualification d'un prospect",
    "objectif": "Classer un prospect entrant en chaud, tiède ou froid, selon son besoin, sa taille et son délai.",
    "entree": {"mode": "json"},
    "exemple": {"entreprise": "Transports Lemoine", "effectif": 85, "message": "Nous voulons automatiser nos rapprochements avant décembre."},
    "questions": [
        {"id": "besoin", "type": "score", "question": "Le prospect exprime-t-il un besoin précis qui correspond à notre `offre` ?",
         "donnees": {"offre": "Automatisation de la comptabilité fournisseurs pour les PME"},
         "niveaux": ["Aucun besoin", "Vague", "Précis", "Précis et urgent"], "confiance_min": 50,
         "tranches": [{"jusqu_a": 1.2, "mot": "faible"}, {"jusqu_a": 2.2, "mot": "reel"}], "au_dela": "fort"},
        {"id": "delai", "type": "score", "question": "Dans quel délai le projet doit-il aboutir ?",
         "niveaux": ["Aucun délai", "Plus de 6 mois", "3 à 6 mois", "Moins de 3 mois"], "confiance_min": 50,
         "tranches": [{"jusqu_a": 1.5, "mot": "lointain"}], "au_dela": "proche"},
        {"id": "decideur", "type": "noul", "question": "L'interlocuteur décide-t-il ou prescrit-il directement l'achat ?",
         "seuil_oui": 60, "seuil_non": 30},
    ],
    "resultats": [
        {"id": "chaud", "label": "Chaud", "consigne": "Prépare un brouillon de premier message et assigne un commercial."},
        {"id": "tiede", "label": "Tiède", "consigne": "Ajoute à la séquence de nurturing."},
        {"id": "froid", "label": "Froid", "consigne": "Enregistre dans le CRM sans relance."},
    ],
    "regles": [
        {"si": [{"question": "besoin", "op": "est", "valeur": "fort"}, {"question": "delai", "op": "est", "valeur": "proche"}], "alors": "chaud"},
        {"si": [{"question": "besoin", "op": "est", "valeur": "fort"}, {"question": "decideur", "op": "est", "valeur": "oui"}], "alors": "chaud"},
        {"si": [{"question": "besoin", "op": "n_est_pas", "valeur": "faible"}], "alors": "tiede"},
    ],
    "par_defaut": "froid",
    "si_jev_indisponible": "tiede",
    "tests": [
        {"entree": {"message": "Nous devons automatiser nos rapprochements avant la clôture de décembre, je suis la DAF."},
         "attendu": "chaud", "attendus": {"besoin": "fort", "delai": "proche", "decideur": "oui"}},
        {"entree": {"message": "Je me renseigne pour un projet l'an prochain peut-être."}, "attendu": "froid",
         "attendus": {"delai": "lointain"}},
        {"entree": {"message": "Nos saisies de factures prennent trop de temps, on étudie des solutions."}, "attendu": "tiede"},
    ],
    "hub": {"playlist": "Qualification et prospection commerciale", "agent": "prospection"},
})

_f("brief-video", 2, "Garde-fou oui/non, score en tranches et choix", {
    "name": "Contrôle d'un brief vidéo",
    "objectif": "Avant toute génération payante, décider si le brief peut partir, doit être retravaillé ou refusé.",
    "entree": {"mode": "fields", "fields": ["idee", "accroche", "texte_ecran"]},
    "exemple": {"idee": "Ranger son bureau en 15 secondes avec notre organiseur", "accroche": "Ton bureau, avant / après",
                "texte_ecran": "Avant : chaos. Après : 15 secondes."},
    "questions": [
        {"id": "personne_reelle", "type": "noul", "question": "Le brief demande-t-il de représenter ou d'imiter une personne réelle identifiable ou sa voix ?",
         "seuil_oui": 40, "seuil_non": 15, "aide": "Seuil du OUI volontairement bas : un faux négatif coûte cher."},
        {"id": "accroche", "type": "score", "question": "L'`accroche` retient-elle l'attention dans les deux premières secondes ?",
         "niveaux": ["Aucune", "Faible", "Correcte", "Forte"], "confiance_min": 50,
         "tranches": [{"jusqu_a": 1.5, "mot": "faible"}], "au_dela": "bonne"},
        {"id": "format", "type": "choice", "question": "Quel format convient le mieux à cette idée ?",
         "options": [{"mot": "video_15s", "description": "Vidéo verticale de 15 secondes"},
                     {"mot": "carrousel", "description": "Carrousel de 5 images"},
                     {"mot": "video_30s", "description": "Vidéo verticale de 30 secondes, démonstration"}],
         "confiance_min": 55},
    ],
    "resultats": [
        {"id": "generer", "label": "Générer", "consigne": "Annonce le coût estimé puis lance la génération au format indiqué."},
        {"id": "retravailler", "label": "Retravailler l'accroche", "consigne": "Propose trois accroches de huit mots au plus."},
        {"id": "refuser", "label": "Refuser", "consigne": "Explique que la mission interdit de représenter une personne réelle."},
        {"id": "a_revoir", "label": "À revoir", "consigne": "Demande au propriétaire de préciser le brief."},
    ],
    "regles": [
        {"si": [{"question": "personne_reelle", "op": "est", "valeur": "oui"}], "alors": "refuser"},
        {"si": [{"question": "personne_reelle", "op": "est", "valeur": "a_verifier"}], "alors": "a_revoir"},
        {"si": [{"question": "accroche", "op": "est", "valeur": "faible"}], "alors": "retravailler"},
        {"si": [{"question": "format", "op": "est", "valeur": "incertain"}], "alors": "a_revoir"},
    ],
    "par_defaut": "generer",
    "si_jev_indisponible": "a_revoir",
    "tests": [
        {"entree": {"idee": "Ranger son bureau en 15 secondes", "accroche": "Ton bureau, avant / après", "texte_ecran": "Avant : chaos."},
         "attendu": "generer", "attendus": {"personne_reelle": "non"}},
        {"entree": {"idee": "Un célèbre footballeur présente notre lampe", "accroche": "Il l'adore", "texte_ecran": "Comme lui."},
         "attendu": "refuser", "attendus": {"personne_reelle": "oui"}},
        {"entree": {"idee": "Présenter la lampe", "accroche": "Voici une lampe", "texte_ecran": "Lampe."},
         "attendu": "retravailler", "attendus": {"accroche": "faible"}},
    ],
    "hub": {"playlist": "Générateur Vidéo Réseaux Sociaux", "agent": "Video-bot"},
})

_f("choix-outil", 3, "Choix parmi beaucoup d'options, distribution et hésitation", {
    "name": "Choix de l'outil de l'agent",
    "objectif": "Indiquer à l'agent quel outil de sa playlist utiliser pour la demande, ou le laisser choisir si Jev hésite.",
    "entree": {"mode": "field", "field": "demande"},
    "exemple": {"demande": "Relance le client Atelier Martin pour la facture F-2026-0412."},
    "questions": [
        {"id": "outil", "type": "choice", "question": "Quel outil faut-il utiliser pour satisfaire la demande ?",
         "options": [{"mot": "crm_chercher_client", "description": "Retrouver la fiche d'un client"},
                     {"mot": "factures_lister_impayees", "description": "Lister les factures échues"},
                     {"mot": "email_brouillon_relance", "description": "Préparer un e-mail de relance"},
                     {"mot": "calendrier_proposer_rdv", "description": "Proposer un rendez-vous"},
                     {"mot": "humain_demander", "description": "Poser une question à l'équipe"}],
         "confiance_min": 65, "marge": 20},
    ],
    "resultats": [
        {"id": "utiliser_outil", "label": "Utiliser l'outil indiqué", "consigne": "Appelle directement l'outil de outil_verdict."},
        {"id": "agent_choisit", "label": "L'agent choisit", "consigne": "Choisis toi-même, en t'aidant de outil_classement."},
    ],
    "regles": [
        {"si": [{"question": "outil", "op": "est", "valeur": "incertain"}], "alors": "agent_choisit"},
        {"si": [{"question": "outil", "op": "est", "valeur": "hesitation"}], "alors": "agent_choisit"},
    ],
    "par_defaut": "utiliser_outil",
    "si_jev_indisponible": "agent_choisit",
    "tests": [
        {"entree": "Prépare un mail de relance pour la facture F-2026-0412.", "attendu": "utiliser_outil",
         "attendus": {"outil": "email_brouillon_relance"}},
        {"entree": "Quelles factures sont en retard ce mois-ci ?", "attendu": "utiliser_outil",
         "attendus": {"outil": "factures_lister_impayees"}},
    ],
    "hub": {"playlist": "Toutes : réduit le raisonnement de l'agent sur le choix d'outil"},
})

_f("veille-pertinence", 1, "Oui/non avec liste de référence", {
    "name": "Pertinence d'un article de veille",
    "objectif": "Garder les articles qui parlent de nos concurrents, écarter le reste.",
    "entree": {"mode": "fields", "fields": ["titre", "extrait"]},
    "exemple": {"titre": "Qonto lance un module de rapprochement bancaire", "extrait": "La néobanque annonce..."},
    "questions": [
        {"id": "concurrent", "type": "noul", "question": "L'article parle-t-il de l'un des `concurrents` ?",
         "donnees": {"concurrents": ["Pennylane", "Qonto", "Libeo", "Agicap"]}, "seuil_oui": 70, "seuil_non": 30},
    ],
    "resultats": [
        {"id": "resumer", "label": "À résumer", "consigne": "Résume l'article en trois lignes."},
        {"id": "a_revoir", "label": "À revoir", "consigne": "Mets de côté pour la revue du vendredi."},
        {"id": "ignorer", "label": "Ignorer", "consigne": "Ne rien faire."},
    ],
    "regles": [
        {"si": [{"question": "concurrent", "op": "est", "valeur": "oui"}], "alors": "resumer"},
        {"si": [{"question": "concurrent", "op": "est", "valeur": "a_verifier"}], "alors": "a_revoir"},
    ],
    "par_defaut": "ignorer",
    "si_jev_indisponible": "a_revoir",
    "tests": [
        {"entree": {"titre": "Qonto lance un module de rapprochement bancaire", "extrait": "La néobanque..."},
         "attendu": "resumer", "attendus": {"concurrent": "oui"}},
        {"entree": {"titre": "La BCE maintient ses taux", "extrait": "Décision attendue..."}, "attendu": "ignorer",
         "attendus": {"concurrent": "non"}},
    ],
    "hub": {"playlist": "Veille concurrentielle", "agent": "veille-bot"},
})

_f("vierge", 1, "Point de départ vide", {
    "name": "Nouvel automate",
    "objectif": "",
    "entree": {"mode": "field", "field": "message"},
    "exemple": {"message": ""},
    "questions": [{"id": "pertinent", "type": "noul", "question": "Le message demande-t-il une action de notre part ?",
                   "seuil_oui": 70, "seuil_non": 30}],
    "resultats": [{"id": "traiter", "label": "Traiter", "consigne": ""}, {"id": "ignorer", "label": "Ignorer", "consigne": ""},
                  {"id": "a_revoir", "label": "À revoir", "consigne": "Demander à un humain."}],
    "regles": [{"si": [{"question": "pertinent", "op": "est", "valeur": "oui"}], "alors": "traiter"},
               {"si": [{"question": "pertinent", "op": "est", "valeur": "a_verifier"}], "alors": "a_revoir"}],
    "par_defaut": "ignorer",
    "si_jev_indisponible": "a_revoir",
    "tests": [],
})


def get(fid: str) -> dict[str, Any] | None:
    for f in FICHES:
        if f["id"] == fid:
            return copy.deepcopy(f)
    return None


def catalog() -> list[dict[str, Any]]:
    return [{"id": f["id"], "name": f["fiche"]["name"], "objectif": f["fiche"]["objectif"], "niveau": f["niveau"],
             "montre": f["montre"], "types": sorted({q["type"] for q in f["fiche"]["questions"]}),
             "hub": f["fiche"].get("hub", {})} for f in FICHES]
