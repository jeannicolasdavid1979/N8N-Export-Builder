"""Application web : API /api et interface statique.

Lancement : n8n-export-builder --host 127.0.0.1 --port 8790
Variables : N8NB_DATA (dossier de donnees, ./data par defaut), N8NB_SECRET_KEY (cle Fernet facultative),
N8NB_PASSWORD (mot de passe de l'interface ; obligatoire des qu'on ecoute ailleurs qu'en local).
"""

from __future__ import annotations

import argparse
import base64
import hashlib
import os
import secrets
import time
from pathlib import Path
from typing import Any

import httpx
from fastapi import Body, FastAPI, HTTPException, Request
from fastapi.responses import FileResponse, JSONResponse, Response
from fastapi.staticfiles import StaticFiles

from . import __version__, assist, economy, fiches, generator, hubexport, importer, jev, jevlab, skills, synthese, templates
from . import providers as P
from .n8n_client import KINDS, N8nClient, N8nError, normalize_url
from .spec import JEV_MODELS, JEV_PROVIDERS, JEV_URL, SpecError, question_vars, routes_of, uses_jev, validate
from .store import Store

STATIC = Path(__file__).parent / "static"


def warnings_for(s: dict[str, Any]) -> list[str]:
    w = []
    if s["trigger"]["type"] == "webhook" and s["trigger"]["auth"] == "none":
        w.append("Webhook sans authentification : activez « Clé d'en-tête » avant de l'exposer sur Internet.")
    if uses_jev(s):
        w.append("Jev est entraîné surtout en anglais : testez les seuils sur une vingtaine de vrais cas français avant la production.")
        if s["model"] in ("jev-latest", "~typesafe/jev-latest"):
            w.append("jev-latest suit la dernière version : figez jev-1.13.0 si vos seuils sont calibrés sur cette version.")
    if s["llm"] and s["llm"]["model"] == "openrouter/auto":
        w.append("LLM de secours sur openrouter/auto : coût et comportement variables, choisissez un modèle précis pour la production.")
    return w


def create_app(data_dir: str | None = None, secret_key: str | None = None, password: str | None = None,
               transport: httpx.AsyncBaseTransport | None = None) -> FastAPI:
    store = Store(data_dir or os.environ.get("N8NB_DATA", "data"), secret_key)
    password = password if password is not None else os.environ.get("N8NB_PASSWORD") or None
    app = FastAPI(title="N8N Export Builder", version=__version__, docs_url=None, redoc_url=None)
    app.state.store = store

    def http() -> httpx.AsyncClient:
        return httpx.AsyncClient(timeout=120, transport=transport)

    def n8n(inst: dict[str, Any]) -> N8nClient:
        return N8nClient(inst["url"], inst.get("key") or "", transport=transport)

    @app.middleware("http")
    async def guard(request: Request, call_next: Any) -> Response:
        if password and request.url.path != "/api/health":
            ok = False
            auth = request.headers.get("authorization", "")
            if auth.lower().startswith("basic "):
                try:
                    _, _, pw = base64.b64decode(auth[6:]).decode().partition(":")
                    ok = secrets.compare_digest(pw, password)
                except ValueError:
                    ok = False
            if not ok:
                return Response("Authentification requise", 401, {"WWW-Authenticate": 'Basic realm="N8N Export Builder"'})
        resp = await call_next(request)
        if request.url.path.startswith("/static/"):
            # Toujours revalider : une mise à jour se voit sans vider le cache du navigateur.
            resp.headers["Cache-Control"] = "no-cache"
        resp.headers["X-Content-Type-Options"] = "nosniff"
        resp.headers["X-Frame-Options"] = "DENY"
        resp.headers["Referrer-Policy"] = "no-referrer"
        return resp

    @app.exception_handler(SpecError)
    async def spec_error(_: Request, e: SpecError) -> JSONResponse:
        return JSONResponse({"detail": "Spécification invalide", "errors": e.errors}, 422)

    @app.exception_handler(jevlab.FicheError)
    async def fiche_error(_: Request, e: jevlab.FicheError) -> JSONResponse:
        return JSONResponse({"detail": "Fiche à compléter", "errors": e.errors}, 422)

    @app.exception_handler(P.ProviderError)
    async def provider_error(_: Request, e: P.ProviderError) -> JSONResponse:
        return JSONResponse({"detail": str(e)}, 502)

    @app.exception_handler(N8nError)
    async def n8n_error(_: Request, e: N8nError) -> JSONResponse:
        msg = str(e)
        if e.status == 409:
            msg += " Un workflow actif utilise déjà ce chemin de webhook : changez le chemin ou mettez à jour l'existant."
        return JSONResponse({"detail": msg}, 502)

    @app.exception_handler(jev.JevError)
    async def jev_error(_: Request, e: jev.JevError) -> JSONResponse:
        return JSONResponse({"detail": str(e)}, 502)

    # Fournisseurs ---------------------------------------------------------------------------------

    def provider_view(p: P.Provider) -> dict[str, Any]:
        cfg = store.provider(p.id)
        key = store.provider_key(p.id)
        return {**p.public(), "configured": bool(key) or p.key_optional, "key_hint": Store.hint(key),
                "base_url": cfg.get("base_url") or p.base_url, "default_model": cfg.get("default_model"),
                "favorites": cfg.get("favorites") or [], "jev_via": cfg.get("jev_via") or "typesafe",
                "models_count": len(cfg.get("models") or []), "refreshed_at": cfg.get("refreshed_at"),
                "error": cfg.get("error")}

    @app.get("/api/health")
    async def health() -> dict[str, Any]:
        return {"ok": True, "version": __version__}

    @app.get("/api/skills")
    async def skills_list() -> dict[str, Any]:
        return {"skills": skills.all_skills()}

    @app.get("/api/skills.zip")
    async def skills_zip() -> Response:
        return Response(skills.zip_bytes(), media_type="application/zip",
                        headers={"Content-Disposition": 'attachment; filename="banque-skills.zip"'})

    @app.get("/api/skills/{name}")
    async def skill_get(name: str) -> Response:
        text = skills.get(name)
        if text is None:
            raise HTTPException(404, "Skill inconnu")
        return Response(text, media_type="text/markdown; charset=utf-8")

    @app.get("/api/state")
    async def state() -> dict[str, Any]:
        return {"version": __version__, "providers": [provider_view(p) for p in P.PROVIDERS],
                "instances": store.instances(), "kinds": KINDS, "templates": templates.catalog(),
                "workflows": [{"id": w["id"], "name": w["spec"].get("name"), "updated": w["updated"],
                               "pushes": w.get("pushes", [])[:3]} for w in store.workflows()],
                "jev_models": list(JEV_MODELS),
                "jev_providers": {k: {kk: v[kk] for kk in ("label", "models", "default", "key")} for k, v in JEV_PROVIDERS.items()},
                "fiches": fiches.catalog(),
                "qcm_leviers": {"questions": synthese.QCM, "leviers": synthese.LEVIERS},
                "mes_fiches": [{"id": f["id"], "name": f["fiche"].get("name"), "updated": f["updated"]} for f in store.fiches()]}

    def provider_or_404(pid: str) -> P.Provider:
        p = P.BY_ID.get(pid)
        if not p:
            raise HTTPException(404, "Fournisseur inconnu")
        return p

    def clean_favorites(v: Any) -> list[str] | None:
        """Modeles preselectionnes d'un fournisseur : proposes en premier dans chaque case LLM."""
        if v is None:
            return None
        if not isinstance(v, list):
            raise HTTPException(400, "Favoris : liste d'identifiants attendue.")
        out = []
        for m in v:
            if isinstance(m, str) and m.strip() and len(m) <= 120 and m.strip() not in out:
                out.append(m.strip())
        return out[:40]

    @app.put("/api/providers/{pid}")
    async def set_provider(pid: str, body: dict[str, Any] = Body(...)) -> dict[str, Any]:
        p = provider_or_404(pid)
        base = body.get("base_url")
        if base is not None:
            base = str(base).strip().rstrip("/")
            if not p.base_editable and base != p.base_url:
                raise HTTPException(400, "L'adresse de ce fournisseur n'est pas modifiable.")
            if not base.startswith(("http://", "https://")):
                raise HTTPException(400, "Adresse invalide.")
        store.set_provider(pid, key=body.get("key") or None, clear_key=bool(body.get("clear_key")),
                           base_url=base, default_model=body.get("default_model"),
                           favorites=clean_favorites(body.get("favorites")),
                           jev_via=body.get("jev_via") if body.get("jev_via") in JEV_PROVIDERS and p.kind == "decision" else None)
        return provider_view(p)

    @app.post("/api/providers/{pid}/refresh")
    async def refresh(pid: str) -> dict[str, Any]:
        p = provider_or_404(pid)
        cfg = store.provider(pid)
        try:
            async with http() as c:
                models = await P.list_models(p, store.provider_key(pid), cfg.get("base_url"), client=c)
        except P.ProviderError as e:
            store.set_provider(pid, error=str(e))
            raise
        store.set_provider(pid, models=models, refreshed_at=time.time(), error="")
        return {**provider_view(p), "models": models}

    @app.get("/api/providers/{pid}/models")
    async def models(pid: str, q: str = "") -> dict[str, Any]:
        provider_or_404(pid)
        ms = store.provider(pid).get("models") or []
        if q:
            ql = q.lower()
            ms = [m for m in ms if ql in m["id"].lower() or ql in str(m.get("name", "")).lower()]
        return {"models": ms, "refreshed_at": store.provider(pid).get("refreshed_at")}

    @app.post("/api/providers/{pid}/test")
    async def test_provider(pid: str, body: dict[str, Any] = Body(default={})) -> dict[str, Any]:
        p = provider_or_404(pid)
        key = store.provider_key(pid)
        if p.kind == "decision":
            async with http() as c:
                t0 = time.monotonic()
                res = await jev.ask(key or "", "Help! My payouts have been failing for 3 days.",
                                    {"is_urgent": {"type": "noul", "instructions": "Does this convey urgency?"}}, client=c)
            return {"ok": True, "latency_ms": int((time.monotonic() - t0) * 1000), "answer": res}
        model = body.get("model") or store.provider(pid).get("default_model")
        if not model:
            raise HTTPException(400, "Choisissez un modèle à tester.")
        async with http() as c:
            t0 = time.monotonic()
            text = await P.chat(p, key, model, "Réponds en un mot.", "Dis bonjour.", store.provider(pid).get("base_url"),
                                client=c, max_tokens=20)
        return {"ok": True, "latency_ms": int((time.monotonic() - t0) * 1000), "text": text[:200]}

    # Modeles et generation ------------------------------------------------------------------------

    @app.get("/api/templates/{tid}")
    async def template(tid: str) -> dict[str, Any]:
        t = templates.get(tid)
        if not t:
            raise HTTPException(404, "Modèle inconnu")
        return t

    def build_response(s: dict[str, Any], n8n_base: str | None = None, fiche: dict[str, Any] | None = None) -> dict[str, Any]:
        wf = generator.build(s, fiche=fiche)
        return {"spec": s, "workflow": wf, "routes": routes_of(s), "uses_jev": uses_jev(s), "variables": question_vars(s["questions"], s["decision"].get("verdicts")),
                "curl": generator.curl_example(s, n8n_base or "https://VOTRE-N8N"), "warnings": warnings_for(s)}

    @app.post("/api/build")
    async def build(body: dict[str, Any] = Body(...)) -> dict[str, Any]:
        return build_response(validate(body.get("spec")), body.get("n8n_base"))

    def resolve(body: dict[str, Any]) -> tuple[dict[str, Any], dict[str, Any] | None]:
        """Specification a partir d'une spec du Labo n8n ou d'une fiche du Labo Jev."""
        if body.get("fiche") is not None:
            f, s = jevlab.to_spec_or_error(body["fiche"])
            return s, f
        return validate(body.get("spec")), None

    def reference_price() -> tuple[float, float, str]:
        pid = "openrouter"
        cfg = store.provider(pid)
        want = cfg.get("default_model") or "anthropic/claude-sonnet-5"
        for m in cfg.get("models") or []:
            if m["id"] == want and m.get("input") is not None and m.get("output") is not None and m["input"] >= 0:
                return float(m["input"]), float(m["output"]), want
        return 3.0, 15.0, "modèle de référence à 3 $ / 15 $ par million"

    @app.post("/api/economy")
    async def economy_route(body: dict[str, Any] = Body(...)) -> dict[str, Any]:
        s, _ = resolve(body)
        pin, pout, label = reference_price()
        if body.get("price_in") not in (None, ""):
            pin, pout, label = float(body["price_in"]), float(body.get("price_out") or 0), body.get("model_label") or "prix saisis"
        calls = max(1, min(int(body.get("calls") or 1000), 10_000_000))
        return {**economy.estimate(s, pin, pout, calls), "modele": label, "prix": {"entree": pin, "sortie": pout}}

    @app.post("/api/export/hub")
    async def export_hub(body: dict[str, Any] = Body(...)) -> Any:
        s, f = resolve(body)
        base = body.get("base_url") or ""
        if body.get("instance_id"):
            inst = store.instance(body["instance_id"])
            if inst:
                base = inst["url"]
        base = base or "https://VOTRE-N8N"
        tests = (f or {}).get("tests") or []
        parts = hubexport.bundle(s, base, tests, f)
        if body.get("format") == "zip":
            return Response(hubexport.zip_bytes(parts), media_type="application/zip", headers={
                "Content-Disposition": f'attachment; filename="{generator.slug(s["name"])}-hub.zip"'})
        return {"parts": parts, "base_url": base}

    # Labo Jev ---------------------------------------------------------------------------------------

    @app.get("/api/jevlab/fiches/{fid}")
    async def fiche_type(fid: str) -> dict[str, Any]:
        f = fiches.get(fid)
        if not f:
            raise HTTPException(404, "Fiche inconnue")
        return f

    @app.post("/api/jevlab/compile")
    async def jev_compile(body: dict[str, Any] = Body(...)) -> dict[str, Any]:
        f, s = jevlab.to_spec_or_error(body.get("fiche"))
        qmap = {q["id"]: {"valeurs": jevlab.allowed_values(q), "ops": jevlab.ops_for(q)} for q in f["questions"]}
        return {"fiche": f, "reponses": qmap, **build_response(s, body.get("n8n_base"), f)}

    def assistant_model(body: dict[str, Any]) -> tuple[str, P.Provider, str]:
        pid = body.get("provider") or "openrouter"
        p = provider_or_404(pid)
        model = body.get("model") or store.provider(pid).get("default_model")
        if not model:
            raise HTTPException(400, "Choisissez un modèle pour l'assistant.")
        return pid, p, model

    @app.post("/api/jevlab/fill")
    async def jev_fill(body: dict[str, Any] = Body(...)) -> dict[str, Any]:
        pid, p, model = assistant_model(body)
        if not (body.get("description") or "").strip() and not body.get("fiche"):
            raise HTTPException(400, "Décrivez ce que l'automate doit décider.")
        return await jevlab.llm_fill(pid, store.provider_key(pid), model, body.get("description") or "",
                                     body.get("context") or "", body.get("fiche"),
                                     store.provider(pid).get("base_url") if p.base_editable else None)

    @app.post("/api/jevlab/field")
    async def jev_field(body: dict[str, Any] = Body(...)) -> dict[str, Any]:
        pid, p, model = assistant_model(body)
        return await jevlab.llm_field(pid, store.provider_key(pid), model, body.get("fiche") or {}, str(body.get("path") or ""),
                                      body.get("consigne") or "", store.provider(pid).get("base_url") if p.base_editable else None)

    @app.post("/api/jevlab/synthese")
    async def jev_synthese(body: dict[str, Any] = Body(...)) -> dict[str, Any]:
        pid, p, model = assistant_model(body)
        if not isinstance(body.get("dossier"), dict):
            raise HTTPException(400, "Faites passer les wagons d'essai avant de demander une synthèse.")
        return await synthese.llm_synthese(pid, store.provider_key(pid), model, body["dossier"],
                                           store.provider(pid).get("base_url") if p.base_editable else None)

    @app.post("/api/jevlab/qcm")
    async def jev_qcm(body: dict[str, Any] = Body(...)) -> dict[str, Any]:
        return {"classement": synthese.classer(body.get("reponses"), body.get("leviers"))}

    @app.get("/api/jevlab/saved/{fid}")
    async def get_saved_fiche(fid: str) -> dict[str, Any]:
        f = store.fiche(fid)
        if not f:
            raise HTTPException(404, "Fiche inconnue")
        return f

    @app.post("/api/jevlab/saved")
    async def save_fiche(body: dict[str, Any] = Body(...)) -> dict[str, Any]:
        f = jevlab.validate_fiche(body.get("fiche"))
        return {"id": store.save_fiche(body.get("id"), f)}

    @app.delete("/api/jevlab/saved/{fid}")
    async def delete_saved_fiche(fid: str) -> dict[str, Any]:
        return {"deleted": store.delete_fiche(fid)}

    @app.post("/api/jev/ask")
    async def jev_ask(body: dict[str, Any] = Body(...)) -> dict[str, Any]:
        # Adresse officielle du fournisseur choisi, ou celle fixee par l'administrateur (N8NB_JEV_URL) :
        # jamais une adresse venue de l'interface.
        jp = JEV_PROVIDERS.get(body.get("provider") or "typesafe")
        if not jp:
            raise HTTPException(400, "Fournisseur de Jev inconnu.")
        key = store.provider_key(jp["key"]) or ""
        if not key:
            raise jev.JevError(f"Clé {P.BY_ID[jp['key']].label} manquante : renseignez-la dans Modèles LLM.")
        async with http() as c:
            return await jev.ask(key, body.get("state"), body.get("questions") or {},
                                 body.get("model") or jp["default"], os.environ.get("N8NB_JEV_URL") or jp["url"], client=c)

    @app.post("/api/assist")
    async def assist_route(body: dict[str, Any] = Body(...)) -> dict[str, Any]:
        pid = body.get("provider") or "openrouter"
        p = provider_or_404(pid)
        model = body.get("model") or store.provider(pid).get("default_model")
        if not model:
            raise HTTPException(400, "Choisissez un modèle pour l'assistant.")
        if not (body.get("description") or "").strip():
            raise HTTPException(400, "Décrivez le workflow voulu.")
        llm_default = {"provider": pid, "model": model}
        res = await assist.propose(pid, store.provider_key(pid), model, body["description"], body.get("context") or "",
                                   body.get("base"), store.provider(pid).get("base_url") if p.base_editable else None,
                                   llm_default=llm_default)
        return {**build_response(res["spec"]), "attempts": res["attempts"]}

    # Workflows enregistres ------------------------------------------------------------------------

    @app.get("/api/workflows/{wid}")
    async def get_wf(wid: str) -> dict[str, Any]:
        w = store.workflow(wid)
        if not w:
            raise HTTPException(404, "Workflow inconnu")
        return w

    @app.post("/api/workflows")
    async def save_wf(body: dict[str, Any] = Body(...)) -> dict[str, Any]:
        s = validate(body.get("spec"))
        return {"id": store.save_workflow(body.get("id"), s)}

    @app.delete("/api/workflows/{wid}")
    async def delete_wf(wid: str) -> dict[str, Any]:
        return {"deleted": store.delete_workflow(wid)}

    # Instances n8n --------------------------------------------------------------------------------

    def instance_or_404(iid: str) -> dict[str, Any]:
        inst = store.instance(iid)
        if not inst:
            raise HTTPException(404, "Instance inconnue")
        return inst

    @app.post("/api/n8n")
    async def add_instance(body: dict[str, Any] = Body(...)) -> dict[str, Any]:
        kind = body.get("kind") if body.get("kind") in KINDS else "vps"
        url = normalize_url(body.get("url") or "")
        label = (body.get("label") or "").strip()[:60] or KINDS[kind]["label"]
        if not body.get("id") and not body.get("key"):
            raise HTTPException(400, "Clé d'API n8n requise.")
        iid = store.save_instance(body.get("id"), label, kind, url, body.get("key"))
        return {"id": iid, "instances": store.instances()}

    @app.delete("/api/n8n/{iid}")
    async def delete_instance(iid: str) -> dict[str, Any]:
        return {"deleted": store.delete_instance(iid), "instances": store.instances()}

    @app.post("/api/n8n/{iid}/test")
    async def test_instance(iid: str) -> dict[str, Any]:
        inst = instance_or_404(iid)
        async with n8n(inst) as c:
            try:
                res = await c.test()
            except N8nError as e:
                store.update_instance(iid, status="erreur", status_detail=str(e), checked_at=time.time())
                raise
        store.update_instance(iid, status="ok", status_detail="", checked_at=time.time())
        return res

    @app.get("/api/n8n/{iid}/workflows")
    async def list_instance_workflows(iid: str) -> dict[str, Any]:
        inst = instance_or_404(iid)
        async with n8n(inst) as c:
            return {"workflows": await c.workflows(), "base": c.url}

    @app.get("/api/n8n/{iid}/workflows/{wid}/import")
    async def import_from_instance(iid: str, wid: str) -> dict[str, Any]:
        inst = instance_or_404(iid)
        async with n8n(inst) as c:
            wf = await c.get_workflow(wid)
        return {**importer.entry(wf, wid), "instance": iid}

    @app.post("/api/import/analyse")
    async def import_analyse(body: dict[str, Any] = Body(...)) -> dict[str, Any]:
        try:
            wfs = importer.parse(body.get("workflow") if body.get("workflow") is not None else body.get("texte") or "")
        except importer.ImportErreur as e:
            raise HTTPException(400, str(e)) from e
        return {"workflows": [importer.entry(w) for w in wfs]}

    async def import_source(body: dict[str, Any]) -> dict[str, Any]:
        """Le workflow à convertir : lu dans l'instance, ou dans le fichier envoyé (avec son rang)."""
        if body.get("instance") and body.get("id"):
            async with n8n(instance_or_404(str(body["instance"]))) as c:
                return await c.get_workflow(str(body["id"]))
        try:
            wfs = importer.parse(body.get("workflow") if body.get("workflow") is not None else body.get("texte") or "")
            return wfs[int(body.get("index") or 0)]
        except importer.ImportErreur as e:
            raise HTTPException(400, str(e)) from e
        except (IndexError, ValueError, TypeError) as e:
            raise HTTPException(400, "Workflow introuvable dans le fichier.") from e

    @app.post("/api/import/fiche")
    async def import_fiche(body: dict[str, Any] = Body(...)) -> dict[str, Any]:
        """Sans IA : les questions Jev du workflow, telles quelles, dans une fiche du Labo Jev."""
        wf = await import_source(body)
        qs = importer.jev_questions(wf)
        if not qs:
            raise HTTPException(400, "Aucune question Jev lisible dans ce workflow.")
        return {"fiche": jevlab.validate_fiche(importer.fiche_from_questions(wf.get("name") or "Workflow importé", qs)),
                "questions": len(qs)}

    @app.post("/api/import/convertir")
    async def import_convertir(body: dict[str, Any] = Body(...)) -> dict[str, Any]:
        pid, p, model = assistant_model(body)
        wf = await import_source(body)
        a = importer.analyse(wf)
        qs = importer.jev_questions(wf)
        # Questions déjà écrites : reprises telles quelles et verrouillées, l'IA ne propose que résultats et règles.
        draft = jevlab.validate_fiche(importer.fiche_from_questions(a["nom"], qs)) if qs else None
        r = await jevlab.llm_fill(pid, store.provider_key(pid), model, f"{importer.CONVERT_BRIEF} Nom : « {a['nom']} ».",
                                  importer.summary(a), draft, store.provider(pid).get("base_url") if p.base_editable else None)
        return {**r, "analyse": a}

    async def ensure_credential(c: N8nClient, iid: str, slot: str, name: str, ctype: str, data: dict[str, Any],
                                fingerprint: str) -> dict[str, str]:
        cur = store.n8n_credential(iid, slot)
        if cur and cur.get("fp") == fingerprint:
            return {"id": cur["id"], "name": cur["name"]}
        cred = await c.create_credential(name, ctype, data)
        store.set_n8n_credential(iid, slot, {**cred, "fp": fingerprint})
        return cred

    @app.post("/api/n8n/{iid}/push")
    async def push(iid: str, body: dict[str, Any] = Body(...)) -> dict[str, Any]:
        inst = instance_or_404(iid)
        s, fiche = resolve(body)
        creds: dict[str, dict[str, str]] = {}
        secret = None
        notes: list[str] = []
        async with n8n(inst) as c:
            if body.get("create_credentials", True):
                def fp(v: str) -> str:
                    return hashlib.sha256(v.encode()).hexdigest()[:16]

                if uses_jev(s):
                    jp = JEV_PROVIDERS[s["jev_provider"]]
                    key = store.provider_key(jp["key"])
                    label = P.BY_ID[jp["key"]].label
                    if s["jev_url"] != jp["url"]:
                        notes.append(f"Adresse Jev personnalisée : la clé {label} enregistrée n'y est pas envoyée, "
                                     "choisissez l'identifiant dans n8n.")
                    elif key and s["jev_provider"] == "openrouter":
                        # Meme cle que les LLM OpenRouter : un seul identifiant n8n pour les deux usages.
                        creds["llm:openrouter"] = await ensure_credential(c, iid, "llm:openrouter", "LLM OpenRouter (builder)",
                                                                          "httpBearerAuth", {"token": key}, fp(key))
                        creds["jev"] = creds["llm:openrouter"]
                    elif key:
                        creds["jev"] = await ensure_credential(c, iid, "jev", "TypeSafe Jev (builder)", "httpBearerAuth",
                                                               {"token": key}, fp(key))
                    else:
                        notes.append(f"Clé {label} absente : choisissez l'identifiant de Jev dans n8n après l'envoi.")
                used = [l for l in (s["llms"] + ([s["entree_llm"]] if s.get("entree_llm") else []))]
                for l in used:
                    pid = l["provider"]
                    p = P.BY_ID.get(pid)
                    key = store.provider_key(pid)
                    if not p or p.auth == "none" or "llm:" + pid in creds:
                        continue
                    if l["base_url"] and not p.base_editable and l["base_url"].rstrip("/") != p.base_url:
                        notes.append(f"Adresse du LLM personnalisée : la clé {p.label} enregistrée n'y est pas envoyée.")
                    elif key:
                        creds["llm:" + pid] = await ensure_credential(c, iid, "llm:" + pid, f"LLM {p.label} (builder)",
                                                                      "httpBearerAuth", {"token": key}, fp(key))
                    else:
                        notes.append(f"Clé {p.label} absente : choisissez l'identifiant du LLM dans n8n après l'envoi.")
                if s["trigger"]["type"] == "webhook" and s["trigger"]["auth"] == "header":
                    secret = secrets.token_urlsafe(24)
                    creds["webhook"] = await c.create_credential(f"Clé webhook {s['trigger']['path']} (builder)",
                                                                 "httpHeaderAuth", {"name": "X-Builder-Key", "value": secret})
            wf = generator.build(s, creds, fiche)
            payload = generator.api_payload(wf)
            target = body.get("update_id")
            if target:
                res = await c.update_workflow(str(target), payload)
            else:
                res = await c.create_workflow(payload)
            wid = str(res.get("id") or target)
            activated, activation_error = False, None
            if body.get("activate") and s["trigger"]["type"] != "manual":
                try:
                    await c.activate(wid)
                    activated = True
                except N8nError as e:
                    activation_error = str(e) + (" Chemin de webhook déjà pris par un workflow actif." if e.status == 409 else "")
            out = {"id": wid, "editor_url": c.editor_url(wid), "activated": activated, "activation_error": activation_error,
                   "webhook_url": c.webhook_url(s["trigger"]["path"]) if s["trigger"]["type"] == "webhook" else None,
                   "secret": secret, "credentials": {k: v["name"] for k, v in creds.items()}, "notes": notes,
                   "curl": generator.curl_example(s, c.url)}
            if secret and out["curl"]:
                out["curl"] = out["curl"].replace("VOTRE_CLE", secret)
        if body.get("saved_id"):
            store.record_push(body["saved_id"], {"instance": iid, "label": inst["label"], "n8n_id": wid,
                                                 "at": time.time(), "activated": activated})
        return out

    # Interface ------------------------------------------------------------------------------------

    app.mount("/static", StaticFiles(directory=STATIC), name="static")

    @app.get("/")
    async def index() -> FileResponse:
        return FileResponse(STATIC / "index.html", headers={"Cache-Control": "no-store"})

    return app


def main() -> None:
    ap = argparse.ArgumentParser(description="N8N Export Builder : workflows n8n déterministes avec Jev")
    ap.add_argument("--host", default=os.environ.get("N8NB_HOST", "127.0.0.1"))
    ap.add_argument("--port", type=int, default=int(os.environ.get("N8NB_PORT", "8790")))
    ap.add_argument("--data", default=os.environ.get("N8NB_DATA", "data"))
    args = ap.parse_args()
    if args.host not in ("127.0.0.1", "localhost", "::1") and not os.environ.get("N8NB_PASSWORD"):
        raise SystemExit("Écoute hors de la machine locale : définissez N8NB_PASSWORD pour protéger les clés enregistrées.")
    import uvicorn

    uvicorn.run(create_app(args.data), host=args.host, port=args.port, log_level="info")


if __name__ == "__main__":
    main()
