"""Estimation des tokens et du cout epargnes a un agent par un automate.

Deux facons de prendre la meme decision :
- l'agent seul : il lit l'entree et les criteres, raisonne sur chacun, puis ecrit sa decision ;
- l'automate : Jev lit l'entree et les questions (entree a 0,042 $ par million de tokens, sortie gratuite),
  le code tranche, et l'agent ne lit que le verdict court puis agit.

Ce sont des ordres de grandeur (environ 3,5 caracteres par token en francais), pas une mesure : l'ecart
reel depend de la longueur des entrees et de la verbosite du modele. Le gain qui ne se chiffre pas ici :
la meme entree donne toujours la meme decision.
"""

from __future__ import annotations

import json
from typing import Any

from .spec import uses_jev

JEV_INPUT_PER_TOKEN = 0.042 / 1_000_000
CHARS_PER_TOKEN = 3.5


def _tok(obj: Any) -> int:
    text = obj if isinstance(obj, str) else json.dumps(obj, ensure_ascii=False)
    return max(1, round(len(text) / CHARS_PER_TOKEN))


def estimate(spec: dict[str, Any], price_in: float, price_out: float, calls: int = 1000) -> dict[str, Any]:
    """price_in et price_out en dollars par million de tokens pour le modele de l'agent."""
    sample = spec["sample"][0] if isinstance(spec["sample"], list) and spec["sample"] else spec["sample"]
    nq = max(1, len(spec["questions"]) + sum(1 for v in spec["decision"].get("verdicts", {}).values()
                                              if v.get("kind") in ("liste_choix", "pour_chaque")))
    state_t = _tok(sample or "")
    crit_t = _tok(spec["questions"]) + _tok(spec["decision"].get("rules", [])) + _tok(spec.get("prepare_js", "")) // 2
    pin, pout = price_in / 1_000_000, price_out / 1_000_000

    agent_in = state_t + crit_t + 250          # entree, criteres et consigne de decision
    agent_out = 90 * nq + 80                   # raisonnement critere par critere, puis decision
    jev_in = (state_t + _tok(spec["questions"]) + 25 * nq) if uses_jev(spec) else 0
    nvars = 3 * nq + 3
    auto_in = 60 + 14 * nvars                  # l'agent lit route, raison et variables
    auto_out = 45                              # appel de l'outil

    cost_agent = agent_in * pin + agent_out * pout
    cost_auto = jev_in * JEV_INPUT_PER_TOKEN + auto_in * pin + auto_out * pout
    saved_tokens = (agent_in + agent_out) - (auto_in + auto_out)
    return {
        "calls": calls,
        "agent_seul": {"entree": agent_in, "sortie": agent_out, "cout": round(cost_agent * calls, 4)},
        "automate": {"jev": jev_in, "agent_entree": auto_in, "agent_sortie": auto_out, "cout": round(cost_auto * calls, 4)},
        "tokens_agent_epargnes": saved_tokens * calls,
        "economie": round((cost_agent - cost_auto) * calls, 4),
        "ratio": round(cost_agent / cost_auto, 1) if cost_auto else None,
        "hypotheses": "Environ 3,5 caractères par token ; l'agent seul raisonne critère par critère ; "
                      "avec l'automate il ne lit que le verdict. Ordres de grandeur, à confirmer sur vos journaux.",
    }
