// N8N Export Builder : interface. Aucune dépendance. Tout texte externe passe par textContent.

const S = {
  data: null,            // /api/state
  spec: null,            // spécification en cours d'édition (forme brute)
  savedId: null,
  tplId: null,
  build: null,           // dernière génération valide
  errors: null,          // erreurs de validation
  test: null,            // résultat du dernier test
  manual: null,          // réponses manuelles en cours
  models: {},            // cache des modèles par fournisseur
  openModels: {},
  instWorkflows: {},
};
const NODE_PREP = 'Préparer les données';
const NODE_DECIDE = 'Décision déterministe';
const JEV_PRICE_PER_TOKEN = 0.042 / 1e6;

// Outils ----------------------------------------------------------------------------------------------

function h(tag, attrs, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === null || v === undefined || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'text') el.textContent = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'value') el.value = v;
    else if (k === 'checked') el.checked = !!v;
    else if (k === 'dataset') Object.assign(el.dataset, v);
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const kid of kids.flat(Infinity)) {
    if (kid === null || kid === undefined || kid === false) continue;
    put(el, kid instanceof Node ? kid : document.createTextNode(String(kid)));
  }
  return el;
}
const $ = sel => document.querySelector(sel);
function clear(el) { while (el.firstChild) el.firstChild.remove(); return el; }
function put(el, ...kids) { for (const k of kids.flat(Infinity)) if (k !== null && k !== undefined && k !== false) el.append(k); return el; }
function debounce(fn, ms) { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; }
function clone(o) { return JSON.parse(JSON.stringify(o)); }
function fmtDate(ts) { if (!ts) return 'jamais'; return new Date(ts * 1000).toLocaleString('fr-FR', { dateStyle: 'short', timeStyle: 'short' }); }
function fmtNum(n, d = 3) { return typeof n === 'number' ? String(Math.round(n * 10 ** d) / 10 ** d).replace('.', ',') : (n === null || n === undefined ? '' : String(n)); }
function price(v) { return v === null || v === undefined ? '' : (v === 0 ? 'gratuit' : fmtNum(v, 3) + ' $'); }

function toast(msg, err = false) {
  const t = h('div', { class: 'toast' + (err ? ' err' : ''), text: msg });
  $('#toasts').append(t);
  setTimeout(() => t.remove(), err ? 7000 : 3500);
}

async function api(method, path, body) {
  const r = await fetch(path, { method, headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
  let data = null;
  try { data = await r.json(); } catch { data = null; }
  if (!r.ok) {
    const gateway = !data && [502, 503, 504].includes(r.status);
    const e = new Error((data && (typeof data.detail === 'string' ? data.detail : JSON.stringify(data.detail)))
      || (gateway ? `Le builder n'a pas répondu à temps (erreur ${r.status} de la passerelle, Coolify ou proxy). Il redémarre peut-être : réessayez dans quelques secondes. Si ça se répète, regardez les journaux du conteneur.` : `Erreur ${r.status}`));
    e.errors = data && data.errors; e.status = r.status;
    throw e;
  }
  return data;
}

async function loadState() { S.data = await api('GET', '/api/state'); $('#side-foot').textContent = `Version ${S.data.version}`; }
function provider(pid) { return S.data.providers.find(p => p.id === pid); }
function chatProviders() { return S.data.providers.filter(p => p.kind === 'chat'); }

function download(name, obj) {
  const a = h('a', { href: URL.createObjectURL(new Blob([JSON.stringify(obj, null, 2)], { type: 'application/json' })), download: name });
  document.body.append(a); a.click(); a.remove();
}
function slug(s) { return (s || 'workflow').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'workflow'; }

function field(label, input, cls = '') { return h('div', { class: 'field ' + cls }, h('label', { text: label }), input); }
function inputEl(value, oninput, attrs = {}) { return h('input', { value: value ?? '', oninput: e => oninput(e.target.value), ...attrs }); }
function selectEl(options, value, onchange, attrs = {}) {
  const s = h('select', { onchange: e => onchange(e.target.value), ...attrs },
    options.map(o => { const [v, l] = Array.isArray(o) ? o : [o, o]; return h('option', { value: v, text: l }); }));
  s.value = value ?? '';
  return s;
}
function textArea(value, oninput, attrs = {}) { const t = h('textarea', { oninput: e => oninput(e.target.value), ...attrs }); t.value = value ?? ''; return t; }
function parseValue(v) {
  const t = String(v).trim();
  if (t === 'true') return true; if (t === 'false') return false;
  if (t !== '' && !Number.isNaN(Number(t.replace(',', '.'))) && !t.includes(',')) return Number(t);
  if (/^-?\d+,\d+$/.test(t)) return Number(t.replace(',', '.'));
  return t;
}

// Navigation ------------------------------------------------------------------------------------------

const PAGES = { jev: renderJevLab, atelier: renderAtelier, modeles: renderModels, n8n: renderN8n, skills: renderSkills, guide: renderGuide };
function currentPage() { const p = location.hash.replace('#', '').split('/')[0]; return PAGES[p] ? p : 'jev'; }
async function route() {
  const page = currentPage();
  document.querySelectorAll('.side a').forEach(a => a.classList.toggle('active', a.dataset.page === page));
  clear($('#main'));
  try { await PAGES[page]($('#main')); } catch (e) { put($('#main'), h('div', { class: 'notice err', text: e.message })); }
}
window.addEventListener('hashchange', route);

// Atelier ---------------------------------------------------------------------------------------------

function emptySpec(raw) {
  const s = clone(raw);
  s.trigger = s.trigger || { type: 'webhook', path: slug(s.name) };
  s.state = s.state || { mode: 'field', field: 'message' };
  s.questions = s.questions || {};
  s.decision = s.decision || { mode: 'none' };
  s.decision.rules = s.decision.rules || [];
  s.decision.routes = s.decision.routes || [];
  s.sample = s.sample ?? {};
  s.llms = [...(s.llm ? [s.llm] : []), ...(s.llms || [])];
  delete s.llm;
  s.entree_llm = s.entree_llm || null;
  if (!s.jev_provider) {
    s.jev_provider = defaultJevProvider();
    const d = (S.data.jev_providers || {})[s.jev_provider];
    if (d && !d.models.includes(s.model)) s.model = d.default;
  }
  s.model = s.model || 'jev-latest';
  return s;
}

async function loadTemplate(tid) {
  const t = await api('GET', `/api/templates/${tid}`);
  S.spec = emptySpec(t.spec); S.tplId = tid; S.savedId = null; S.test = null; S.manual = null; S.target = null;
  applyDefaultLlm();
  renderAtelier($('#main'));
}

function applyDefaultLlm() {
  const l = (S.spec.llms || [])[0];
  if (!l) return;
  const p = provider(l.provider);
  if (l.model === 'openrouter/auto' && p && p.default_model) l.model = p.default_model;
  S.spec.llms = [l, ...(S.spec.llms || []).filter(x => x !== l)];
}

async function loadSaved(wid) {
  const w = await api('GET', `/api/workflows/${wid}`);
  S.spec = emptySpec(w.spec); S.savedId = wid; S.tplId = null; S.test = null; S.manual = null; S.target = null;
  renderAtelier($('#main'));
}

const rebuild = debounce(async () => {
  try {
    const res = await api('POST', '/api/build', { spec: S.spec });
    S.build = res; S.errors = null;
  } catch (e) {
    S.errors = e.errors || [e.message];
  }
  renderPreview();
  nGraph();
}, 350);
function nGraph() {
  const host = document.getElementById('ngraph');
  if (!host || S.view !== 'graph') return;
  if (!S.scene || S.scene.forSpec !== S.spec) S.scene = { st: {}, forSpec: S.spec };
  Object.assign(S.scene, { host, build: S.errors ? null : S.build, redraw: () => renderScene(S.scene) });
  sceneReplay(S.scene);
  renderScene(S.scene);
}

function changed(structural = false) { S.test = null; if (structural) renderEditor(); rebuild(); }

async function renderAtelier(main) {
  if (!S.spec) {
    const first = S.data.templates.find(t => t.id === 'hub-support-triage') || S.data.templates[0];
    const t = await api('GET', `/api/templates/${first.id}`);
    S.spec = emptySpec(t.spec); S.tplId = first.id;
    applyDefaultLlm();
  }
  clear(main);
  put(main, 
    h('div', { class: 'page-head' },
      h('div', {}, h('h1', { text: 'Labo n8n' }),
        h('p', { class: 'muted', text: "L'IA conçoit une fois, le code et Jev exécutent mille fois : mêmes entrées, même décision." })),
      h('div', { class: 'row' },
        viewToggle(S.view || 'form', v => { S.view = v; renderAtelier($('#main')); }),
        h('button', { onclick: openImport, text: 'Importer depuis n8n', title: 'Reprendre un workflow de votre n8n' }),
        h('button', { onclick: saveSpec, text: 'Enregistrer' }),
        h('button', { onclick: () => S.build && download(slug(S.spec.name) + '.json', S.build.workflow), text: 'Télécharger le JSON' }),
        h('button', { onclick: () => S.build && openHubExport({ spec: S.spec }), text: 'Exporter vers le Hub' }),
        h('button', { class: 'primary', onclick: () => openPush(), text: 'Envoyer vers n8n' }))),
    h('div', { id: 'ngraph' }),
    h('div', { class: 'workbench', style: S.view === 'graph' ? 'display:none' : null },
      h('aside', { class: 'library', id: 'library' }),
      h('section', { id: 'editor' }),
      h('aside', { class: 'preview', id: 'preview' })));
  renderLibrary(); renderEditor(); rebuild();
}

function renderLibrary() {
  const lib = clear($('#library'));
  const fams = {};
  for (const t of S.data.templates) (fams[t.family] = fams[t.family] || []).push(t);
  if (S.data.workflows.length) {
    put(lib, h('h3', { text: 'Mes workflows' }));
    for (const w of S.data.workflows) {
      put(lib, h('div', { class: 'row', style: 'margin-bottom:6px;flex-wrap:nowrap' },
        h('button', { class: 'tpl' + (S.savedId === w.id ? ' active' : ''), style: 'margin:0', onclick: () => loadSaved(w.id) },
          h('b', { text: w.name || w.id }), h('span', { class: 'small', text: 'Modifié le ' + fmtDate(w.updated) + (w.pushes.length ? ` · envoyé ${w.pushes.length} fois` : '') })),
        h('button', { class: 'ghost danger', title: 'Supprimer', text: '×', onclick: async () => {
          if (!confirm('Supprimer ce workflow enregistré ?')) return;
          await api('DELETE', `/api/workflows/${w.id}`); await loadState(); if (S.savedId === w.id) S.savedId = null; renderLibrary();
        } })));
    }
  }
  const NIV = { 1: 'Simple', 2: 'Intermédiaire', 3: 'Avancé' };
  put(lib, h('div', { class: 'row', style: 'margin:10px 0 4px' }, [0, 1, 2, 3].map(n => h('button', {
    class: 'small' + ((S.niveau || 0) === n ? ' primary' : ''), text: n ? NIV[n] : 'Tous', onclick: () => { S.niveau = n; renderLibrary(); } }))));
  for (const fam of ['Playlists du Hub', 'Métiers', 'Primitives Jev', 'Départ']) {
    if (!fams[fam]) continue;
    put(lib, h('h3', { text: fam, style: 'margin-top:14px' }));
    for (const t of fams[fam]) {
      if (S.niveau && t.niveau !== S.niveau) continue;
      put(lib, h('button', { class: 'tpl' + (S.tplId === t.id ? ' active' : ''), title: t.source ? 'Inspiré de : ' + t.source : '', onclick: () => loadTemplate(t.id) },
        h('b', { text: t.name }),
        h('span', { class: 'small', text: t.hub && t.hub.playlist ? 'Playlist : ' + t.hub.playlist : t.description.slice(0, 110) }),
        h('span', { class: 'tags' },
          h('span', { class: 'badge', text: 'Niveau ' + t.niveau }),
          t.uses_jev ? h('span', { class: 'badge accent', text: 'Jev' }) : h('span', { class: 'badge ok', text: '100 % code' }),
          t.llm ? h('span', { class: 'badge warn', text: 'LLM sur une route' }) : null,
          h('span', { class: 'badge', text: { webhook: 'Webhook', schedule: 'Planifié', manual: 'Manuel' }[t.trigger] }))));
    }
  }
}

function renderEditor() {
  const ed = $('#editor');
  if (!ed) return;
  clear(ed);
  const s = S.spec;
  put(ed, tuto('n8n', 'le Labo n8n en 5 étapes', [
    ['Choisissez un modèle à gauche (filtre Simple, Intermédiaire, Avancé) ou décrivez votre besoin à l\'assistant.'],
    ['Lisez le schéma à droite : ', h('b', { text: 'Préparer' }), ' (code), ', h('b', { text: 'Jev' }), ' (répond aux questions), ', h('b', { text: 'Décision' }), ' (règles), puis une ', h('b', { text: 'route' }), '.'],
    ['Ajustez les questions (section 3) et les seuils des règles (section 4). Chaque (i) explique la notion.'],
    ['Testez avec l\'exemple : « Réponses manuelles » permet d\'essayer sans clé Jev.'],
    ['Envoyez vers n8n, puis « Exporter vers le Hub » pour donner l\'automate à une playlist.'],
  ]));
  put(ed, assistantCard());
  put(ed, h('div', { class: 'card stack' },
    field('Nom du workflow', inputEl(s.name, v => { s.name = v; changed(); })),
    field('Description', textArea(s.description, v => { s.description = v; changed(); }, { rows: 2 })),
    s.hub && s.hub.playlist ? h('div', { class: 'notice info' },
      h('b', { text: 'Hub d\'agents : ' }), `playlist ${s.hub.playlist}${s.hub.agent ? ', agent ' + s.hub.agent : ''}. `,
      s.hub.allege ? 'Allège l\'agent : ' + s.hub.allege : '') : null));
  const tpl = S.data.templates.find(t => t.id === S.tplId);
  if (tpl && tpl.source) put(ed, h('p', { class: 'small faint', text: 'Inspiré de : ' + tpl.source + '. Réécrit en déterministe et vérifié dans n8n.' }));
  put(ed, triggerCard(), dataCard(), questionsCard(), decisionCard(),
    llmSetup(() => ({ entree: s.entree_llm, routes: s.llms }), v => { if ('entree' in v) s.entree_llm = v.entree; if ('routes' in v) s.llms = v.routes; }, currentRoutes(), st => changed(st)),
    sampleCard());
}

function assistantCard() {
  const chat = chatProviders().filter(p => p.configured);
  const st = S.assist = S.assist || { provider: (chat.find(x => !x.key_optional) || chat[0] || {}).id || 'openrouter', model: '', description: '', context: '' };
  if (!st.model) st.model = (provider(st.provider) || {}).default_model || '';
  const status = h('div', { class: 'small muted' });
  const run = async improve => {
    if (!st.description.trim()) return toast('Décrivez le workflow voulu.', true);
    status.textContent = 'Le modèle conçoit la spécification…';
    try {
      const res = await api('POST', '/api/assist', { provider: st.provider, model: st.model, description: st.description, context: st.context, base: improve ? S.spec : null });
      S.spec = emptySpec(res.spec); S.tplId = null; S.savedId = improve ? S.savedId : null;
      status.textContent = `Spécification proposée en ${res.attempts} essai(s). Relisez les questions et les seuils avant d'envoyer.`;
      renderLibrary(); renderEditor(); rebuild();
    } catch (e) { status.textContent = ''; toast(e.message + (e.errors ? ' : ' + e.errors.join(' ; ') : ''), true); }
  };
  return h('details', { class: 'card' },
    h('summary', { text: 'Assistant de conception (LLM)' }),
    chat.length ? h('div', { class: 'stack' },
      h('p', { class: 'small muted', text: 'Décrivez le besoin : le modèle propose les questions Jev, les règles et les routes. Il ne sert qu\'à la conception, jamais à l\'exécution.' }),
      h('div', { class: 'row' },
        field('Fournisseur', selectEl(chat.map(p => [p.id, p.label]), st.provider, v => { st.provider = v; st.model = (provider(v) || {}).default_model || ''; renderEditor(); }), 'w180'),
        field('Modèle', modelInput(st.provider, st.model, v => { st.model = v; }), 'grow')),
      field('Besoin', textArea(st.description, v => { st.description = v; }, { rows: 3, placeholder: 'Exemple : trier les candidatures reçues par e-mail selon le poste, écarter celles sans CV, alerter pour les profils seniors.' })),
      field('Contexte facultatif (mission de la playlist du hub, politique interne…)', textArea(st.context, v => { st.context = v; }, { rows: 2 })),
      h('div', { class: 'row' }, h('button', { class: 'primary', onclick: () => run(false), text: 'Proposer un workflow' }),
        h('button', { onclick: () => run(true), text: 'Améliorer le workflow actuel' }), status))
      : h('p', { class: 'small' }, 'Aucun fournisseur de discussion configuré. ', h('a', { href: '#modeles', text: 'Ajouter une clé OpenRouter ou brancher Ollama' }), '.'));
}

function modelInput(pid, value, oninput) {
  const listId = 'dl-' + pid;
  const inp = h('input', { value: value || '', list: listId, placeholder: 'identifiant du modèle', oninput: e => oninput(e.target.value),
    onfocus: () => ensureModels(pid) });
  const dl = h('datalist', { id: listId });
  const fill = () => {
    clear(dl);
    const favs = new Set((provider(pid) || {}).favorites || []);
    const ms = [...(S.models[pid] || [])].sort((a, b) => (favs.has(b.id) ? 1 : 0) - (favs.has(a.id) ? 1 : 0));
    for (const m of ms.slice(0, 600)) dl.append(h('option', { value: m.id, label: (favs.has(m.id) ? '★ ' : '') + (m.name !== m.id ? m.name : '') }));
  };
  fill(); ensureModels(pid).then(fill);
  const pick = h('button', { type: 'button', class: 'small', text: '☰ Liste', title: 'Parcourir les modèles de ce fournisseur',
    onclick: () => openModelPicker(pid, m => { inp.value = m; oninput(m); }) });
  const favs = (provider(pid) || {}).favorites || [];
  const favSel = favs.length ? selectEl([['', '★ Mes favoris…'], ...favs.map(f => [f, f])], favs.includes(value) ? value : '', v => { if (v) { inp.value = v; oninput(v); } }, { class: 'fav-select', title: 'Modèles mis en favoris dans Modèles LLM' }) : null;
  return h('div', { class: 'model-in' }, favSel, inp, pick, dl);
}
async function ensureModels(pid) {
  if (S.models[pid] && S.models[pid].length) return S.models[pid];
  try {
    let ms = (await api('GET', `/api/providers/${pid}/models`)).models;
    const p = provider(pid);
    if (!ms.length && p && (p.models_public || p.configured)) ms = (await api('POST', `/api/providers/${pid}/refresh`)).models;
    S.models[pid] = ms;
  } catch { S.models[pid] = []; }
  return S.models[pid];
}

async function openModelPicker(pid, onPick) {
  const dlg = $('#dialog');
  const p = provider(pid) || { label: pid };
  const body = h('div', { class: 'dlg stack' }, h('h2', { text: 'Modèles ' + p.label }), h('p', { class: 'muted small', text: 'Chargement de la liste…' }));
  put(clear(dlg), body);
  dlg.showModal();
  const ms = await ensureModels(pid);
  const search = h('input', { placeholder: 'Filtrer : claude, mimo, :free, gpt…', oninput: () => draw() });
  const tbody = h('tbody');
  const hasPrice = ms.some(m => m.input !== undefined);
  const draw = () => {
    clear(tbody);
    const q = search.value.toLowerCase();
    for (const m of ms.filter(m => !q || m.id.toLowerCase().includes(q) || String(m.name || '').toLowerCase().includes(q)).slice(0, 200)) {
      put(tbody, h('tr', { class: 'pick-row', onclick: () => { onPick(m.id); dlg.close(); } },
        h('td', {}, h('div', { class: 'mono', text: m.id }), m.name && m.name !== m.id ? h('div', { class: 'small faint', text: m.name }) : null),
        hasPrice ? h('td', { class: 'small', text: m.input === undefined ? '' : price(m.input) + ' / ' + price(m.output) }) : null,
        h('td', { class: 'small', text: m.context ? Math.round(m.context / 1000) + ' k' : (m.size_gb ? m.size_gb + ' Go' : '') })));
    }
  };
  put(clear(body), h('h2', { text: 'Modèles ' + p.label }),
    ms.length ? h('p', { class: 'small muted', text: `${ms.length} modèles, lus en direct. Cliquez une ligne pour la choisir.` + (hasPrice ? ' Prix : entrée / sortie par million de tokens.' : '') })
      : h('div', { class: 'notice warn small' }, 'Aucune liste : ', h('a', { href: '#modeles', onclick: () => dlg.close(), text: 'renseignez la clé ou l\'adresse du fournisseur' }), '.'),
    search, h('div', { class: 'models', style: 'max-height:420px' }, h('table', {}, tbody)),
    h('div', { class: 'row end' }, h('button', { text: 'Fermer', onclick: () => dlg.close() })));
  draw(); search.focus();
}

// Jev : en direct chez TypeSafe ou par OpenRouter, avec la liste des modèles de chacun ------------------

function jevKeyReady(jp) { const d = (S.data.jev_providers || {})[jp || 'typesafe']; return !!(d && (provider(d.key) || {}).configured); }
function defaultJevProvider() {
  const pref = (provider('typesafe') || {}).jev_via;
  if (pref && jevKeyReady(pref)) return pref;
  return jevKeyReady('typesafe') ? 'typesafe' : (jevKeyReady('openrouter') ? 'openrouter' : (pref || 'typesafe'));
}
function jevVia(jp, model, onChange) {
  const P = S.data.jev_providers || {};
  const cur = P[jp] ? jp : 'typesafe';
  const models = (P[cur] || {}).models || [];
  return h('div', { class: 'row' },
    h('div', { class: 'field w180' }, lab('Jev via', 'Jev s\'appelle en direct chez TypeSafe (clé TypeSafe) ou par OpenRouter (votre clé OpenRouter suffit). Même modèle, même format de réponse.'),
      selectEl(Object.entries(P).map(([k, d]) => [k, d.label + (jevKeyReady(k) ? '' : ' (clé manquante)')]), cur, v => onChange(v, P[v].default))),
    h('div', { class: 'field w180' }, lab('Modèle Jev', 'La version qui suit les nouveautés (latest) ou une version figée, à préférer quand vos seuils sont calibrés.'),
      selectEl(models.includes(model) ? models : [model, ...models].filter(Boolean), model, v => onChange(cur, v))));
}

function triggerCard() {
  const s = S.spec, t = s.trigger;
  const body = h('div', { class: 'row' },
    field('Déclencheur', selectEl([['webhook', 'Webhook (appel HTTP)'], ['schedule', 'Planifié'], ['manual', 'Manuel (test)']], t.type,
      v => { s.trigger = { type: v, path: t.path || slug(s.name) }; changed(true); }), 'w240'));
  if (t.type === 'webhook') {
    put(body, field('Chemin', inputEl(t.path, v => { t.path = v; changed(); }), 'grow'),
      field('Authentification', selectEl([['none', 'Aucune'], ['header', "Clé d'en-tête X-Builder-Key"]], t.auth || 'none', v => { t.auth = v; changed(); }), 'w240'));
  } else if (t.type === 'schedule') {
    put(body, field('Toutes les', inputEl(t.interval || 1, v => { t.interval = Number(v) || 1; changed(); }, { type: 'number', min: 1 }), 'w120'),
      field('Unité', selectEl([['minutes', 'minutes'], ['hours', 'heures'], ['days', 'jours']], t.every || 'hours', v => { t.every = v; changed(true); }), 'w120'),
      t.every === 'days' ? field('À (heure)', inputEl(t.at_hour ?? 8, v => { t.at_hour = Number(v); changed(); }, { type: 'number', min: 0, max: 23 }), 'w120') : null);
  }
  const src = s.source || { type: '' };
  return h('div', { class: 'card stack' }, h('h2', { text: '1. Déclencheur et source' }), body,
    h('div', { class: 'row' },
      field('Source de données', selectEl([['', 'Aucune (données du déclencheur)'], ['rss', 'Flux RSS'], ['http', 'Requête HTTP GET']], src.type,
        v => { s.source = v ? { type: v, url: src.url || '' } : null; changed(true); }), 'w240'),
      s.source ? field('Adresse', inputEl(s.source.url, v => { s.source.url = v; changed(); }, { placeholder: 'https://…' }), 'grow') : null));
}

function dataCard() {
  const s = S.spec, st = s.state;
  return h('div', { class: 'card stack' }, h('h2', { text: '2. Données envoyées à Jev' }),
    h('div', { class: 'row' },
      field('État (state)', selectEl([['field', 'Un champ'], ['fields', 'Plusieurs champs'], ['json', 'Toute l\'entrée JSON']], st.mode,
        v => { s.state = { mode: v, field: st.field || 'message', fields: st.fields || [] }; changed(true); }), 'w240'),
      st.mode === 'field' ? field('Champ', inputEl(st.field, v => { st.field = v; changed(); }), 'grow') : null,
      st.mode === 'fields' ? field('Champs, séparés par des virgules', inputEl((st.fields || []).join(', '), v => { st.fields = v.split(',').map(x => x.trim()).filter(Boolean); changed(); }), 'grow') : null),
    h('details', { open: s.prepare_js ? true : null },
      h('summary', { text: 'Préparation déterministe (JavaScript)' }),
      h('p', { class: 'small muted', text: 'Reçoit input, vars et questions. Remplissez vars.x pour les règles (dates, montants, doublons). Renvoyez un objet pour remplacer l\'état.' }),
      textArea(s.prepare_js, v => { s.prepare_js = v; changed(); }, { class: 'code', spellcheck: 'false', rows: 8 })));
}

function questionsCard() {
  const s = S.spec;
  const ids = Object.keys(s.questions);
  const card = h('div', { class: 'card' },
    h('div', { class: 'section-title' }, h('h2', { text: `3. Questions à Jev (${ids.length})` }),
      h('div', { class: 'row' },
        jevVia(s.jev_provider, s.model, (jp, m) => { s.jev_provider = jp; s.model = m; changed(true); }),
        h('button', { class: 'small', onclick: () => addQuestion('noul'), text: '+ Oui/non' }),
        h('button', { class: 'small', onclick: () => addQuestion('choice'), text: '+ Choix' }),
        h('button', { class: 'small', onclick: () => addQuestion('score'), text: '+ Score' }))));
  if (!ids.length) put(card, h('p', { class: 'muted small', text: 'Aucune question : le workflow est 100 % code, sans appel à Jev.' }));
  ids.forEach((id, i) => put(card, questionEl(id, s.questions[id], i, ids.length)));
  put(card, h('details', {}, h('summary', { text: 'Adresse de l\'API Jev' }),
    inputEl(s.jev_url || 'https://api.typesafe.ai/v1/systemone', v => { s.jev_url = v; changed(); })));
  return card;
}

function addQuestion(type) {
  const s = S.spec;
  let n = 1; while (s.questions['question_' + n]) n++;
  const q = { type, instructions: '' };
  if (type === 'choice') q.criteria = { option_a: '', option_b: '' };
  if (type === 'score') q.criteria = ['Faible', 'Moyen', 'Élevé'];
  s.questions['question_' + n] = q;
  changed(true);
}
function renameQuestion(oldId, newId) {
  const s = S.spec; const out = {};
  for (const [k, v] of Object.entries(s.questions)) out[k === oldId ? newId : k] = v;
  s.questions = out;
}
function moveQuestion(id, delta) {
  const s = S.spec; const e = Object.entries(s.questions); const i = e.findIndex(x => x[0] === id); const j = i + delta;
  if (j < 0 || j >= e.length) return; [e[i], e[j]] = [e[j], e[i]]; s.questions = Object.fromEntries(e); changed(true);
}

function questionEl(id, q, i, n) {
  const s = S.spec;
  let curId = id;
  const structured = typeof q.instructions !== 'string';
  const instr = structured
    ? textArea(JSON.stringify(q.instructions, null, 2), v => { try { q.instructions = JSON.parse(v); instrErr.textContent = ''; changed(); } catch { instrErr.textContent = 'JSON invalide'; } }, { class: 'code', rows: 5 })
    : textArea(q.instructions, v => { q.instructions = v; changed(); }, { rows: 2, placeholder: 'La question, précise et fermée. Citez un champ de l\'état entre accents graves : `montant`.' });
  const instrErr = h('span', { class: 'small', style: 'color:var(--critical)' });
  const el = h('div', { class: 'qcard' },
    h('div', { class: 'row' },
      field('Identifiant', inputEl(id, v => { if (/^[a-z][a-z0-9_]*$/.test(v) && !s.questions[v]) { renameQuestion(curId, v); curId = v; changed(); } }), 'w180'),
      field('Type', selectEl([['noul', 'Oui/non (noul)'], ['choice', 'Choix (choice)'], ['score', 'Score (score)']], q.type, v => {
        q.type = v; delete q.criteria;
        if (v === 'choice') q.criteria = { option_a: '', option_b: '' };
        if (v === 'score') q.criteria = ['Faible', 'Moyen', 'Élevé'];
        changed(true);
      }), 'w180'),
      h('span', { class: 'spacer' }),
      h('button', { class: 'ghost', title: 'Monter', disabled: i === 0, onclick: () => moveQuestion(curId, -1), text: '↑' }),
      h('button', { class: 'ghost', title: 'Descendre', disabled: i === n - 1, onclick: () => moveQuestion(curId, 1), text: '↓' }),
      h('button', { class: 'ghost danger', onclick: () => { delete s.questions[curId]; changed(true); }, text: 'Supprimer' })),
    field(structured ? 'Instructions structurées (JSON)' : 'Instructions', instr), instrErr);
  if (q.type === 'choice') {
    const rows = h('div');
    const draw = () => {
      clear(rows);
      Object.entries(q.criteria || {}).forEach(([k, v]) => {
        let key = k;
        put(rows, h('div', { class: 'crit' },
          inputEl(k, nv => { if (/^[a-z][a-z0-9_]*$/.test(nv) && !(nv in q.criteria)) { q.criteria = Object.fromEntries(Object.entries(q.criteria).map(([a, b]) => [a === key ? nv : a, b])); key = nv; changed(); } }, { placeholder: 'option' }),
          inputEl(v ?? '', nv => { q.criteria[key] = nv || null; changed(); }, { placeholder: 'description (facultative)' }),
          h('button', { class: 'ghost danger', text: '×', onclick: () => { delete q.criteria[key]; changed(); draw(); } })));
      });
    };
    draw();
    put(el, h('label', { text: 'Options (identifiant et description)', style: 'margin-top:8px' }), rows,
      h('button', { class: 'small', style: 'margin-top:6px', text: '+ Option', onclick: () => { let n = 1; while (('option_' + n) in q.criteria) n++; q.criteria['option_' + n] = null; changed(); draw(); } }));
  } else if (q.type === 'score') {
    put(el, field('Niveaux, du plus bas au plus haut (un par ligne, 2 à 10)',
      textArea((q.criteria || []).map(c => typeof c === 'string' ? c : JSON.stringify(c)).join('\n'), v => { q.criteria = v.split('\n').map(x => x.trim()).filter(Boolean); changed(); }, { rows: 4 })));
  } else {
    const c = q.criteria || {};
    put(el, h('details', { open: q.criteria ? true : null }, h('summary', { text: 'Préciser ce que veulent dire oui et non' }),
      h('div', { class: 'row' },
        field('Oui signifie', inputEl(c.true, v => { q.criteria = { ...(q.criteria || {}), true: v }; if (!v) delete q.criteria.true; changed(); }), 'grow'),
        field('Non signifie', inputEl(c.false, v => { q.criteria = { ...(q.criteria || {}), false: v }; if (!v) delete q.criteria.false; changed(); }), 'grow'))));
  }
  return el;
}

function knownVars() {
  const out = [];
  for (const [id, q] of Object.entries(S.spec.questions)) {
    out.push(id);
    if (q.type !== 'noul') out.push(id + '_confiance');
    if (q.type === 'score') out.push(id + '_norme');
  }
  const d = S.spec.decision;
  if (d.composite && d.composite.name) out.push(d.composite.name);
  for (const m of (S.spec.prepare_js || '').matchAll(/vars\.([a-z_][a-z0-9_]*)\s*=/gi)) if (!out.includes(m[1])) out.push(m[1]);
  return out;
}
function currentRoutes() {
  if (S.build) return S.build.routes;
  const d = S.spec.decision;
  if (d.mode === 'choice') { const q = S.spec.questions[d.question]; return [...Object.keys((q && q.criteria) || {}), d.review_route || 'a_revoir']; }
  return d.routes || [];
}

function decisionCard() {
  const s = S.spec, d = s.decision;
  const choiceQs = Object.entries(s.questions).filter(([, q]) => q.type === 'choice').map(([k]) => k);
  const card = h('div', { class: 'card stack' }, h('h2', { text: '4. Décision déterministe' }),
    h('div', { class: 'row' },
      field('Mode', selectEl([['rules', 'Règles à seuils'], ['choice', 'Un choix Jev, avec seuil de confiance'], ['none', 'Sortie unique']], d.mode, v => {
        s.decision = { ...d, mode: v };
        if (v === 'choice') { s.decision.question = d.question || choiceQs[0]; s.decision.min_confidence = d.min_confidence ?? 0.65; s.decision.review_route = d.review_route || 'a_revoir'; }
        if (v === 'rules') { s.decision.routes = d.routes && d.routes.length ? d.routes : ['traiter', 'a_revoir']; s.decision.default_route = d.default_route || s.decision.routes[s.decision.routes.length - 1]; }
        changed(true);
      }), 'w240')));
  const dl = h('datalist', { id: 'dl-vars' }, knownVars().map(v => h('option', { value: v })));
  put(card, dl);
  if (d.mode === 'choice') {
    put(card, h('div', { class: 'row' },
      field('Question', selectEl(choiceQs, d.question, v => { d.question = v; changed(); }), 'w180'),
      field('Confiance minimale', inputEl(d.min_confidence, v => { d.min_confidence = Number(v.replace(',', '.')); changed(); }, { type: 'number', step: 0.05, min: 0, max: 1 }), 'w120'),
      field('Route sous le seuil', inputEl(d.review_route, v => { d.review_route = v; changed(); }), 'w180')),
      h('p', { class: 'small muted', text: 'Au-dessus du seuil, la route est l\'option choisie ; en dessous, la demande part en revue. Si Jev ne répond pas, même route de revue.' }));
  }
  if (d.mode === 'rules') {
    put(card, field('Routes, séparées par des virgules', inputEl((d.routes || []).join(', '), v => { d.routes = v.split(',').map(x => x.trim()).filter(Boolean); changed(); })),
    h('div', { class: 'row' },
      field('Route par défaut', inputEl(d.default_route, v => { d.default_route = v; changed(); }, { list: 'dl-routes' }), 'w180'),
      field('Si Jev échoue', inputEl(d.error_route, v => { d.error_route = v || undefined; changed(); }, { list: 'dl-routes', placeholder: 'a_revoir' }), 'w180')),
    h('datalist', { id: 'dl-routes' }, (d.routes || []).map(r => h('option', { value: r }))));
    const rules = h('div');
    (d.rules || []).forEach((r, i) => rules.append(ruleEl(r, i)));
    put(card, h('div', { class: 'section-title' }, h('h3', { text: 'Règles, évaluées dans l\'ordre, la première qui s\'applique décide' }),
      h('button', { class: 'small', text: '+ Règle', onclick: () => { d.rules.push({ when: [{ field: knownVars()[0] || '', op: '>=', value: 0.5 }], route: (d.routes || [])[0] || '' }); changed(true); } })), rules);
    put(card, h('p', { class: 'small muted', text: 'Une route « =variable » prend la valeur d\'un choix Jev (ses options doivent figurer dans les routes).' }));
  }
  if (d.mode !== 'none') {
    const comp = d.composite;
    put(card, h('details', { open: comp ? true : null }, h('summary', { text: 'Score composite pondéré' }),
      h('div', { class: 'row' },
        h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: !!comp, onchange: e => { d.composite = e.target.checked ? { name: 'score_global', weights: {} } : undefined; changed(true); } }), 'Activer'),
        comp ? field('Nom de la variable', inputEl(comp.name, v => { comp.name = v; changed(); }), 'w180') : null),
      comp ? field('Poids (variable = poids, une par ligne ; utilisez les versions _norme des scores)', textArea(
        Object.entries(comp.weights || {}).map(([k, w]) => `${k} = ${w}`).join('\n'),
        v => { comp.weights = Object.fromEntries(v.split('\n').map(l => l.split('=').map(x => x.trim())).filter(p => p[0] && p[1] !== undefined).map(([k, w]) => [k, Number(w.replace(',', '.'))])); changed(); }, { class: 'code', rows: 4 })) : null));
    put(card, h('details', { open: d.post_js ? true : null }, h('summary', { text: 'Règles avancées (JavaScript, après les règles)' }),
      h('p', { class: 'small muted', text: 'Reçoit ctx (route, reason, vars, extra), vars, answers et input. Modifiez ctx.route pour trancher un cas que les règles simples ne couvrent pas.' }),
      textArea(d.post_js, v => { d.post_js = v; changed(); }, { class: 'code', spellcheck: 'false', rows: 6 })));
  }
  return card;
}

function ruleEl(r, i) {
  const d = S.spec.decision;
  const OPS = [['>=', '≥'], ['>', '>'], ['<=', '≤'], ['<', '<'], ['==', '='], ['!=', '≠'], ['in', 'parmi'], ['not_in', 'hors de'], ['exists', 'renseigné'], ['missing', 'absent']];
  const conds = h('div');
  r.when.forEach((c, j) => put(conds, h('div', { class: 'cond' },
    inputEl(c.field, v => { c.field = v; changed(); }, { list: 'dl-vars', placeholder: 'variable' }),
    selectEl(OPS, c.op, v => { c.op = v; changed(true); }),
    ['exists', 'missing'].includes(c.op) ? h('span') : inputEl(c.value === undefined || c.value === null ? '' : String(c.value), v => { c.value = parseValue(v); changed(); }, { placeholder: 'valeur' }),
    h('button', { class: 'ghost danger', text: '×', disabled: r.when.length === 1, onclick: () => { r.when.splice(j, 1); changed(true); } }))));
  return h('div', { class: 'rule' },
    h('div', { class: 'rule-head' }, h('span', { class: 'num', text: i + 1 }),
      inputEl(r.route, v => { r.route = v; changed(); }, { list: 'dl-routes', placeholder: 'route' }),
      inputEl(r.label, v => { r.label = v; changed(); }, { placeholder: 'raison affichée (facultative)' }),
      h('span', { class: 'row', style: 'gap:2px;flex-wrap:nowrap' },
        h('button', { class: 'ghost', text: '↑', disabled: i === 0, onclick: () => { [d.rules[i - 1], d.rules[i]] = [d.rules[i], d.rules[i - 1]]; changed(true); } }),
        h('button', { class: 'ghost', text: '+ Et', onclick: () => { r.when.push({ field: '', op: '>=', value: 0.5 }); changed(true); } }),
        h('button', { class: 'ghost danger', text: '×', onclick: () => { d.rules.splice(i, 1); changed(true); } }))),
    conds);
}

function sampleCard() {
  const s = S.spec;
  const err = h('span', { class: 'small', style: 'color:var(--critical)' });
  return h('div', { class: 'card stack' }, h('h2', { text: '6. Exemple d\'entrée' }),
    h('p', { class: 'small muted', text: 'Sert au test ci-contre et au déclencheur manuel. Un tableau donne plusieurs éléments ; le test utilise le premier.' }),
    textArea(JSON.stringify(s.sample, null, 2), v => { try { s.sample = JSON.parse(v); err.textContent = ''; changed(); } catch { err.textContent = 'JSON invalide'; } }, { class: 'code', rows: 8, spellcheck: 'false' }), err);
}

// Aperçu, test et export ------------------------------------------------------------------------------

function renderPreview() {
  const pv = $('#preview');
  if (!pv) return;
  clear(pv);
  if (S.errors) {
    put(pv, h('div', { class: 'card' }, h('div', { class: 'notice err' }, h('b', { text: 'À corriger avant de générer' }), h('ul', {}, S.errors.map(e => h('li', { text: e }))))));
    return;
  }
  const b = S.build;
  if (!b) { put(pv, h('div', { class: 'card empty', text: 'Génération…' })); return; }
  const wf = b.workflow, spec = b.spec;
  const main = wf.nodes.filter(n => n.type !== 'n8n-nodes-base.stickyNote' && !n.name.startsWith('Route : ') && !n.name.startsWith('LLM : ') && !n.name.startsWith('Fusion LLM') && ![ 'LLM de secours', 'Répondre' ].includes(n.name)).sort((a, c) => a.position[0] - c.position[0]);
  const kind = n => n.name.startsWith('Jev') ? 'jev' : (n.name.startsWith('LLM') ? 'llm' : (n.type.endsWith('.code') ? 'code' : ''));
  const flow = h('div', { class: 'flow' });
  main.forEach((n, i) => { if (i) put(flow, h('div', { class: 'farrow', text: '↓' })); put(flow, h('div', { class: 'fnode ' + kind(n) }, h('span', { text: n.name }), h('span', { class: 'faint', text: n.type.split('.').pop() }))); });
  const hit = S.test && S.test.decision && S.test.decision.route;
  put(flow, h('div', { class: 'farrow', text: '↓' }), h('div', { class: 'routes' }, b.routes.map(r => h('span', { class: 'route' + (r === hit ? ' hit' : '') + ((spec.llms || []).some(l => l.route === r) ? ' llm' : ''), text: r }))));
  if (spec.trigger.type === 'webhook') put(flow, h('div', { class: 'farrow', text: '↓' }), h('div', { class: 'fnode' }, h('span', { text: 'Répondre' }), h('span', { class: 'faint', text: 'JSON : route, raison, variables' })));

  put(pv, h('div', { class: 'card' }, h('h2', { text: 'Schéma généré' }), flow,
    h('p', { class: 'small muted', style: 'margin-top:10px', text: `${wf.nodes.length - 1} nœuds, tous du cœur de n8n : aucun nœud communautaire à installer.` })));
  if (b.warnings.length) put(pv, h('div', { class: 'card' }, h('div', { class: 'notice warn' }, h('b', { text: 'Points d\'attention' }), h('ul', {}, b.warnings.map(w => h('li', { text: w }))))));
  put(pv, testCard());
  put(pv, ecoCard(() => ({ spec: S.spec })));
  if (Object.keys(b.variables).length) {
    put(pv, h('div', { class: 'card' }, h('h2', { text: 'Variables disponibles pour les règles' }),
      h('table', {}, h('tbody', {}, Object.entries(b.variables).map(([k, v]) => h('tr', {}, h('td', { class: 'mono', text: k }), h('td', { class: 'small muted', text: v })))))));
  }
  if (b.curl) {
    put(pv, h('div', { class: 'card stack' }, h('h2', { text: 'Brancher dans le Hub d\'agents' }),
      h('p', { class: 'small muted', text: 'Hub, Catalogue, Ajouter une API : collez cet exemple. L\'agent de la playlist appellera le workflow comme un outil, sans jamais voir la clé.' }),
      h('pre', { class: 'json', text: b.curl }),
      h('button', { class: 'small', text: 'Copier', onclick: () => navigator.clipboard.writeText(b.curl).then(() => toast('Copié')) })));
  }
  put(pv, h('details', { class: 'card' }, h('summary', { text: 'JSON du workflow n8n' }),
    h('div', { class: 'row', style: 'margin-bottom:8px' },
      h('button', { class: 'small', text: 'Copier (coller dans n8n avec Ctrl+V)', onclick: () => navigator.clipboard.writeText(JSON.stringify(wf, null, 2)).then(() => toast('Workflow copié : collez-le dans l\'éditeur n8n')) }),
      h('button', { class: 'small', text: 'Télécharger', onclick: () => download(slug(spec.name) + '.json', wf) })),
    h('pre', { class: 'json', text: JSON.stringify(wf, null, 2) })));
}

function testCard() {
  const b = S.build, spec = b.spec;
  const usesJev = b.uses_jev;
  const jevReady = jevKeyReady(spec.jev_provider);
  const card = h('div', { class: 'card stack' }, h('h2', { text: 'Tester avec l\'exemple' }),
    h('p', { class: 'small muted', text: 'Le test exécute ici le code exact des nœuds n8n générés. ' + (usesJev ? 'Jev est appelé avec votre clé, ou remplacé par des réponses saisies à la main.' : 'Aucun appel à Jev : tout est calculé.') }),
    h('div', { class: 'row' },
      usesJev ? h('button', { class: 'primary', disabled: !jevReady, title: jevReady ? '' : 'Clé de Jev (TypeSafe ou OpenRouter) à renseigner dans Modèles LLM', text: 'Tester avec Jev', onclick: () => runTest('jev') }) : h('button', { class: 'primary', text: 'Exécuter', onclick: () => runTest('code') }),
      usesJev ? h('button', { text: 'Réponses manuelles', onclick: () => runTest('manual') }) : null,
      usesJev && !jevReady ? h('a', { class: 'small', href: '#modeles', text: 'Ajouter une clé TypeSafe ou OpenRouter' }) : null));
  if (S.manual) put(card, manualForm());
  const t = S.test;
  if (t && t.error) put(card, h('div', { class: 'notice err', text: t.error }), t.fallback ? h('p', { class: 'small', text: `En production, ce cas partirait sur la route « ${t.fallback} ».` }) : null);
  if (t && t.decision) {
    const d = t.decision;
    put(card, h('div', { class: 'notice ok' }, h('div', {}, 'Route : ', h('b', { class: 'mono', text: d.route })), h('div', { class: 'small', text: d.reason })));
    if (t.jev && t.jev.answers) {
      const rows = Object.entries(t.jev.answers).map(([id, a]) => {
        const val = a.type === 'noul' ? a.noul : (a.type === 'choice' ? a.choice : a.score);
        const p = a.type === 'noul' ? a.noul : a.confidence;
        return h('tr', {}, h('td', { class: 'mono', text: id }), h('td', { class: 'mono', text: fmtNum(val) }),
          h('td', {}, h('div', { class: 'bar', title: a.type === 'noul' ? 'probabilité du oui' : 'confiance' }, h('span', { style: `width:${Math.round((p || 0) * 100)}%` }))),
          h('td', { class: 'small faint', text: a.type === 'noul' ? 'oui' : 'conf. ' + fmtNum(a.confidence, 2) }));
      });
      put(card, h('table', {}, h('thead', {}, h('tr', {}, h('th', { text: 'Question' }), h('th', { text: 'Réponse' }), h('th', { text: '' }), h('th', { text: '' }))), h('tbody', {}, rows)));
      if (t.jev.usage) put(card, h('p', { class: 'small muted', text: `${t.jev.model} · ${t.jev.usage.input_tokens} tokens en entrée · coût estimé ${(t.jev.usage.input_tokens * JEV_PRICE_PER_TOKEN).toFixed(6).replace('.', ',')} $ (${t.ms} ms)` }));
    }
    put(card, h('details', {}, h('summary', { text: 'Variables et sortie complète' }), h('pre', { class: 'json', text: JSON.stringify({ route: d.route, raison: d.reason, variables: d.vars, extra: d.extra, etat_envoye: t.prep && t.prep.state }, null, 2) })));
  }
  return card;
}

function runCode(code, items, refs, statics) {
  const f = new Function('$input', '$', '$getWorkflowStaticData', code);
  return f({ all: () => items }, name => ({ all: () => refs[name] || [] }), () => statics);
}

function prepare() {
  const b = S.build, spec = b.spec;
  const code = name => (b.workflow.nodes.find(n => n.name === name) || {}).parameters.jsCode;
  const samples = Array.isArray(spec.sample) ? spec.sample : [spec.sample];
  const first = samples[0] || {};
  const items = spec.trigger.type === 'webhook' ? [{ json: { body: first } }] : [{ json: first }];
  const refs = {};
  const prep = runCode(code(NODE_PREP), items, refs, {});
  refs[NODE_PREP] = prep;
  return { refs, prep, decideCode: code(NODE_DECIDE) };
}

async function runTest(mode) {
  const spec = S.build.spec;
  S.test = null;
  let ctx;
  try { ctx = prepare(); } catch (e) { S.test = { error: 'Erreur dans la préparation : ' + e.message }; return renderPreview(); }
  const p = ctx.prep[0].json;
  if (mode === 'manual') {
    S.manual = { ctx, answers: defaultAnswers(p.questions) };
    return renderPreview();
  }
  S.manual = null;
  let res = null, t0 = performance.now();
  if (mode === 'jev') {
    if (!Object.keys(p.questions).length) res = { model: 'aucune question pour cette entrée', answers: {} };
    else try { res = await api('POST', '/api/jev/ask', { state: p.state, questions: p.questions, model: spec.model, provider: spec.jev_provider }); }
    catch (e) { S.test = { error: e.message, fallback: spec.decision.error_route, prep: p }; return renderPreview(); }
  }
  finishTest(ctx, res, Math.round(performance.now() - t0));
}

function finishTest(ctx, res, ms) {
  try {
    const input = res ? [{ json: res }] : ctx.prep;
    const dec = runCode(ctx.decideCode, input, ctx.refs, {});
    S.test = { decision: dec[0].json, jev: res, prep: ctx.prep[0].json, ms };
  } catch (e) { S.test = { error: 'Erreur dans la décision : ' + e.message }; }
  renderPreview();
}

function defaultAnswers(questions) {
  const a = {};
  for (const [id, q] of Object.entries(questions)) {
    if (q.type === 'noul') a[id] = { type: 'noul', noul: 0.5 };
    else if (q.type === 'choice') { const k = Object.keys(q.criteria); a[id] = { type: 'choice', choice: k[0], confidence: 0.8, probabilities: {} }; }
    else { const legend = {}; q.criteria.forEach((c, i) => { legend[i] = typeof c === 'string' ? c : JSON.stringify(c); }); a[id] = { type: 'score', score: 1, confidence: 0.8, legend, probabilities: {} }; }
  }
  return a;
}

function manualForm() {
  const m = S.manual;
  const qs = m.ctx.prep[0].json.questions;
  const rows = Object.entries(m.answers).map(([id, a]) => {
    const q = qs[id];
    let ctl;
    if (a.type === 'noul') ctl = h('div', { class: 'row' }, inputEl(a.noul, v => { a.noul = Number(v); out.textContent = fmtNum(a.noul, 2); }, { type: 'range', min: 0, max: 1, step: 0.05, style: 'flex:1' }), 'oui ', null);
    else if (a.type === 'choice') ctl = h('div', { class: 'row' }, selectEl(Object.entries(q.criteria).map(([k, d]) => [k, d && typeof d === 'string' && /^c\d+$/.test(k) ? d.slice(0, 70) : k]), a.choice, v => { a.choice = v; }, { style: 'flex:1' }),
      inputEl(a.confidence, v => { a.confidence = Number(v); }, { type: 'number', step: 0.05, min: 0, max: 1, style: 'width:80px', title: 'confiance' }));
    else ctl = h('div', { class: 'row' }, inputEl(a.score, v => { a.score = Number(v); }, { type: 'number', step: 0.1, min: 0, max: q.criteria.length - 1, style: 'width:80px', title: `0 à ${q.criteria.length - 1}` }),
      h('span', { class: 'small faint', text: `0 = ${q.criteria[0]}, ${q.criteria.length - 1} = ${q.criteria[q.criteria.length - 1]}` }));
    const out = h('span', { class: 'small mono', text: a.type === 'noul' ? fmtNum(a.noul, 2) : '' });
    if (a.type === 'noul') put(ctl, out);
    return h('tr', {}, h('td', { class: 'mono', text: id }), h('td', {}, ctl));
  });
  return h('div', { class: 'stack' }, h('table', {}, h('tbody', {}, rows)),
    h('div', { class: 'row' }, h('button', { class: 'primary', text: 'Décider', onclick: () => finishTest(m.ctx, { model: 'réponses manuelles', answers: clone(m.answers) }, 0) }),
      h('button', { class: 'ghost', text: 'Fermer', onclick: () => { S.manual = null; renderPreview(); } })));
}

async function saveSpec() {
  try {
    const r = await api('POST', '/api/workflows', { id: S.savedId, spec: S.spec });
    S.savedId = r.id; await loadState(); renderLibrary(); toast('Workflow enregistré');
  } catch (e) { toast(e.message + (e.errors ? ' : ' + e.errors.join(' ; ') : ''), true); }
}

// Envoi vers n8n --------------------------------------------------------------------------------------

function atelierPushCtx() {
  if (!S.build || S.errors) return null;
  return {
    payload: () => ({ spec: S.spec }), trigger: S.build.spec.trigger.type, target: S.target,
    save: async () => { if (!S.savedId) { const r = await api('POST', '/api/workflows', { spec: S.spec }); S.savedId = r.id; } return S.savedId; },
    after: () => renderLibrary(),
  };
}

async function openPush(ctx = atelierPushCtx()) {
  if (!ctx) return toast('Corrigez la spécification avant l\'envoi.', true);
  const dlg = $('#dialog');
  const insts = S.data.instances;
  const spec = { trigger: { type: ctx.trigger } };
  const tg = ctx.target && insts.some(i => i.id === ctx.target.iid) ? ctx.target : null;
  const st = { iid: tg ? tg.iid : (insts[0] || {}).id, activate: spec.trigger.type !== 'manual', creds: true, update: tg ? String(tg.wid) : '' };
  const body = h('div', { class: 'dlg stack' });
  const draw = async () => {
    clear(body);
    put(body, h('h2', { text: 'Envoyer vers n8n' }));
    if (!insts.length) {
      put(body, h('p', {}, 'Aucune instance n8n. ', h('a', { href: '#n8n', onclick: () => dlg.close(), text: 'Relier une instance' }), ' (locale, VPS ou n8n Cloud).'),
        h('div', { class: 'row end' }, h('button', { text: 'Fermer', onclick: () => dlg.close() })));
      return;
    }
    let existing = S.instWorkflows[st.iid];
    const upd = selectEl([['', 'Créer un nouveau workflow'], ...((existing || []).map(w => [w.id, `Remplacer : ${w.name}${w.active ? ' (actif)' : ''}`]))], st.update, v => { st.update = v; });
    put(body, 
      field('Instance', selectEl(insts.map(i => [i.id, `${i.label} · ${i.url}`]), st.iid, v => { st.iid = v; st.update = ''; draw(); })),
      field('Destination', upd),
      h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: st.activate, disabled: spec.trigger.type === 'manual', onchange: e => { st.activate = e.target.checked; } }), 'Activer le workflow après l\'envoi'),
      h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: st.creds, onchange: e => { st.creds = e.target.checked; } }), 'Créer les identifiants dans n8n avec les clés enregistrées (Jev, LLM, clé du webhook)'),
      h('p', { class: 'small muted', text: 'Sans cette case, le workflow arrive sans identifiants : vous les choisissez dans n8n. Les clés partent uniquement vers cette instance n8n.' }));
    const result = h('div');
    put(body, result, h('div', { class: 'row end' }, h('button', { text: 'Fermer', onclick: () => dlg.close() }),
      h('button', { class: 'primary', text: 'Envoyer', onclick: async e => {
        e.target.disabled = true; put(clear(result), h('p', { class: 'muted', text: 'Envoi…' }));
        try {
          const savedId = ctx.save ? await ctx.save() : null;
          const r = await api('POST', `/api/n8n/${st.iid}/push`, { ...ctx.payload(), activate: st.activate, create_credentials: st.creds, update_id: st.update || null, saved_id: savedId });
          put(clear(result), pushResult(r));
          delete S.instWorkflows[st.iid];
          await loadState(); if (ctx.after) ctx.after();
        } catch (err) { put(clear(result), h('div', { class: 'notice err', text: err.message })); }
        e.target.disabled = false;
      } })));
    if (!existing) {
      try { S.instWorkflows[st.iid] = (await api('GET', `/api/n8n/${st.iid}/workflows`)).workflows; draw(); }
      catch (e) { S.instWorkflows[st.iid] = []; body.prepend(h('div', { class: 'notice warn', text: 'Instance injoignable : ' + e.message })); }
    }
  };
  put(clear(dlg), body);
  dlg.showModal();
  draw();
}

function pushResult(r) {
  return h('div', { class: 'stack' },
    h('div', { class: 'notice ' + (r.activation_error ? 'warn' : 'ok') },
      h('div', {}, 'Workflow envoyé. ', h('a', { href: r.editor_url, target: '_blank', rel: 'noopener', text: 'Ouvrir dans n8n' })),
      r.activated ? h('div', { text: 'Actif.' }) : null,
      r.activation_error ? h('div', { text: 'Activation impossible : ' + r.activation_error }) : null),
    r.notes.length ? h('div', { class: 'notice info' }, h('ul', {}, r.notes.map(n => h('li', { text: n })))) : null,
    r.webhook_url ? field('Adresse du webhook', h('input', { value: r.webhook_url, readonly: true })) : null,
    r.secret ? h('div', { class: 'notice warn' }, h('b', { text: 'Clé du webhook, affichée une seule fois : ' }), h('span', { class: 'mono', text: r.secret })) : null,
    r.curl ? h('pre', { class: 'json', text: r.curl }) : null);
}

// Importer depuis n8n --------------------------------------------------------------------------------------
// Un workflow du builder revient à l'identique grâce à sa carte d'origine ; tout autre workflow est analysé,
// et l'IA peut le convertir en fiche du Labo Jev. Le workflow d'origine n'est jamais modifié dans n8n.

const IMPORT_GROUPS = [['declencheur', '🚉', 'Déclencheurs', 'déclencheur', 'déclencheurs'], ['llm', '✍', 'LLM', 'LLM', 'LLM'],
  ['jev', '🧠', 'Jev', 'appel à Jev', 'appels à Jev'], ['decision', '🔀', 'Décisions', 'décision', 'décisions'],
  ['code', '🛠', 'Code', 'nœud de code', 'nœuds de code'], ['action', '📦', 'Actions', 'action', 'actions']];

function openImport() {
  const dlg = $('#dialog');
  dlg.classList.add('wide');
  const st = { tab: S.data.instances.length ? 'instance' : 'fichier', iid: (S.data.instances[0] || {}).id, list: null, text: '', results: null };
  const body = h('div', { class: 'dlg stack' });
  const out = h('div', { class: 'stack' });
  const show = (entries, srcOf) => { put(clear(out), entries.map((e, i) => importResult(e, srcOf(i), dlg))); };
  const loadList = async () => {
    st.list = null; draw();
    try { st.list = (await api('GET', `/api/n8n/${st.iid}/workflows`)).workflows; } catch (e) { st.list = { error: e.message }; }
    draw();
  };
  const draw = () => {
    clear(body);
    put(body, h('div', { class: 'row between' }, h('h2', { style: 'margin:0', text: 'Importer depuis n8n' }), h('button', { class: 'small', text: 'Fermer', onclick: () => dlg.close() })),
      tuto('import', 'reprendre vos workflows', [
        ['Un workflow ', h('b', { text: 'envoyé par le builder' }), ' revient à l\'identique : il porte une carte d\'origine (une note « Source du builder » dans n8n). Les cas de test ne voyagent pas : ils restent dans « Mes fiches ».'],
        ['Un workflow ', h('b', { text: 'fait à la main' }), ' est analysé nœud par nœud : l\'outil repère ce qui peut devenir une question Jev (un LLM qui classe, une condition sur une réponse d\'IA).'],
        ['L\'IA peut alors le ', h('b', { text: 'convertir en fiche du Labo Jev' }), ', que vous réglez et testez. Votre workflow d\'origine n\'est jamais modifié : l\'automate converti part comme un nouveau workflow.'],
      ]),
      h('div', { class: 'seg' },
        h('button', { class: st.tab === 'instance' ? 'on' : '', text: 'Depuis une instance', onclick: () => { st.tab = 'instance'; draw(); } }),
        h('button', { class: st.tab === 'fichier' ? 'on' : '', text: 'Depuis un fichier', onclick: () => { st.tab = 'fichier'; draw(); } })));
    if (st.tab === 'instance') {
      if (!S.data.instances.length) put(body, h('p', {}, 'Aucune instance reliée. ', h('a', { href: '#n8n', onclick: () => dlg.close(), text: 'Relier une instance n8n' }), ', ou importez un fichier.'));
      else {
        put(body, field('Instance', selectEl(S.data.instances.map(i => [i.id, `${i.label} · ${i.url}`]), st.iid, v => { st.iid = v; loadList(); })));
        if (!st.list) put(body, h('p', { class: 'small muted', text: 'Lecture des workflows…' }));
        else if (st.list.error) put(body, h('div', { class: 'notice err small', text: st.list.error }));
        else put(body, h('div', { class: 'models', style: 'max-height:260px' }, h('table', {}, h('tbody', {}, st.list.map(w => h('tr', {},
          h('td', {}, h('b', { text: w.name })),
          h('td', {}, w.builder ? h('span', { class: 'badge accent', text: w.builder === 'ancien' ? 'builder, ancienne version' : 'fait par le builder' }) : h('span', { class: 'badge', text: 'fait dans n8n' })),
          h('td', {}, h('span', { class: 'badge ' + (w.active ? 'ok' : ''), text: w.active ? 'actif' : 'inactif' })),
          h('td', { style: 'text-align:right' }, h('button', { class: 'small', text: 'Importer', onclick: async ev => {
            ev.target.disabled = true;
            try { show([await api('GET', `/api/n8n/${st.iid}/workflows/${w.id}/import`)], () => ({ iid: st.iid, wid: w.id })); }
            catch (e) { put(clear(out), h('div', { class: 'notice err', text: e.message })); }
            ev.target.disabled = false;
          } }))))))));
      }
    } else {
      const file = h('input', { type: 'file', accept: '.json,application/json', onchange: async e => { const f = e.target.files[0]; if (f) { st.text = await f.text(); ta.value = st.text; } } });
      const ta = textArea(st.text, v => { st.text = v; }, { rows: 5, class: 'code', placeholder: 'Ou collez ici le JSON du workflow (n8n : menu ⋯ du workflow, Télécharger).' });
      put(body, h('p', { class: 'small muted', text: 'Dans n8n, ouvrez le workflow, menu ⋯ en haut à droite, « Télécharger ». Un fichier peut contenir un ou plusieurs workflows.' }),
        file, ta, h('div', {}, h('button', { class: 'primary', text: 'Analyser', onclick: async () => {
          try { const text = st.text; show((await api('POST', '/api/import/analyse', { texte: text })).workflows, i => ({ texte: text, index: i })); }
          catch (e) { put(clear(out), h('div', { class: 'notice err', text: e.message })); }
        } })));
    }
    put(body, out);
  };
  put(clear(dlg), body);
  dlg.addEventListener('close', () => dlg.classList.remove('wide'), { once: true });
  dlg.showModal();
  draw();
  if (st.tab === 'instance' && st.iid) loadList();
}

function importResult(e, src, dlg) {
  const o = e.origine, a = e.analyse;
  const card = h('div', { class: 'card stack' }, h('div', { class: 'row between' }, h('h3', { style: 'margin:0', text: e.nom }),
    o && !o.erreur ? h('span', { class: 'badge accent', text: o.reconstruit ? 'builder, ancienne version' : 'fait par le builder' }) : h('span', { class: 'badge', text: `${a.noeuds} nœuds` })));
  if (o && !o.erreur) {
    const openJev = () => {
      J.fiche = clone(o.fiche); J.fid = null; J.savedId = null; J.bench = null; J.calib = null; J.essai = null; J.scene = null; J.preview = null; J.lab = null; J.leviers = null;
      J.target = src.iid ? src : null; dlg.close(); location.hash = '#jev'; route();
    };
    const openN8n = () => { S.spec = emptySpec(o.spec); S.savedId = null; S.tplId = null; S.test = null; S.target = src.iid ? src : null; dlg.close(); location.hash = '#atelier'; route(); };
    const mine = o.fiche && S.data.mes_fiches.find(f => f.name === o.fiche.name);
    put(card, h('div', { class: 'notice ok small', text: (o.reconstruit
        ? 'Envoyé par une ancienne version du builder, sans carte d\'origine : l\'automate est reconstruit depuis son code (modèle, questions, seuils, règles, LLM), et le code régénéré est vérifié. Non récupérables : l\'exemple d\'entrée et les consignes des voies, à reprendre dans le Labo n8n.'
        : 'Carte d\'origine trouvée : l\'automate revient tel que le builder l\'a envoyé.') + (src.iid ? ' Au prochain envoi, « Remplacer » ce workflow est présélectionné, et il recevra sa carte d\'origine.' : '') }),
      o.modifications.length ? h('div', { class: 'notice warn small stack' }, h('b', { text: 'Modifié dans n8n depuis l\'envoi :' }), h('ul', {}, o.modifications.map(m => h('li', { text: m }))),
        h('div', { text: 'Ces changements ne sont pas dans la carte d\'origine : un nouvel envoi depuis le builder les écraserait. Reportez-les dans le builder, ou gardez ce workflow tel quel dans n8n.' })) : null,
      o.fiche ? h('p', { class: 'small muted', text: mine ? `Les cas de test ne voyagent pas dans n8n : ils sont dans « Mes fiches : ${mine.name} ».` : 'Les cas de test ne voyagent pas dans n8n : ajoutez-en dans le banc d\'essai.' }) : null,
      h('div', { class: 'row' }, o.fiche ? h('button', { class: 'primary', text: 'Ouvrir dans le Labo Jev', onclick: openJev }) : null,
        h('button', { class: o.fiche ? '' : 'primary', text: 'Ouvrir dans le Labo n8n', onclick: openN8n })));
    return card;
  }
  if (o && o.erreur) put(card, h('div', { class: 'notice warn small', text: o.erreur + ' Le workflow est analysé comme un workflow fait à la main.' }));
  put(card, h('div', { class: 'chips' }, IMPORT_GROUPS.map(([k, icon, , one, many]) => a[k].length ? chip(icon, `${a[k].length} ${a[k].length > 1 ? many : one}`) : null)));
  put(card, a.candidats.length
    ? h('div', { class: 'stack' }, h('b', { class: 'small', text: 'Ce que Jev peut reprendre :' }), h('ul', { class: 'small' }, a.candidats.map(c => h('li', { text: c }))))
    : h('p', { class: 'small muted', text: 'Aucun LLM ni aucune condition : ce workflow ne prend pas de décision que Jev pourrait reprendre.' }));
  put(card, h('details', {}, h('summary', { class: 'small', text: 'Détail des nœuds' }),
    IMPORT_GROUPS.map(([k, icon, label]) => a[k].length ? h('div', { class: 'stack', style: 'margin-top:6px' }, h('b', { class: 'small', text: `${icon} ${label}` }),
      a[k].map(it => h('div', { class: 'small' }, h('b', { text: it.nom }), h('span', { class: 'faint', text: ` (${it.type}) ` }), it.detail || ''))) : null)));
  const chat = chatProviders().filter(p => p.configured);
  if (!a.llm.length && !a.decision.length && !a.jev.length) return card;
  if (!chat.length) return put(card, h('p', { class: 'small' }, 'Conversion par l\'IA : ', h('a', { href: '#modeles', onclick: () => dlg.close(), text: 'ajoutez une clé OpenRouter ou branchez Ollama' }), '.'));
  const st = jAssist();
  const status = h('span', { class: 'small muted' });
  put(card, h('div', { class: 'row' },
    field('Fournisseur', selectEl(chat.map(p => [p.id, p.label]), st.provider, v => { st.provider = v; st.model = (provider(v) || {}).default_model || ''; }), 'w180'),
    field('Modèle', modelInput(st.provider, st.model, v => { st.model = v; }), 'grow')),
    h('div', { class: 'row' }, h('button', { class: 'primary', text: '✦ Convertir en fiche Labo Jev', onclick: async ev => {
      ev.target.disabled = true; status.textContent = 'L\'IA lit le workflow et remplit la fiche…';
      try {
        const from = src.iid ? { instance: src.iid, id: src.wid } : { texte: src.texte, index: src.index };
        const r = await api('POST', '/api/import/convertir', { provider: st.provider, model: st.model, ...from });
        J.fiche = r.fiche; J.fid = null; J.savedId = null; J.bench = null; J.calib = null; J.essai = null; J.scene = null; J.preview = null; J.lab = null; J.leviers = null; J.target = null;
        Object.keys(J.fiche.ia || {}).forEach(k => { J.openWhy[k] = false; });
        dlg.close(); location.hash = '#jev'; route();
        toast('Fiche proposée par l\'IA : chaque case dit pourquoi. Réglez, puis faites passer les wagons d\'essai.');
      } catch (err) { status.textContent = ''; toast(err.message + (err.errors ? ' : ' + err.errors.join(' ; ') : ''), true); ev.target.disabled = false; }
    } }), status),
    h('p', { class: 'small faint', text: 'Votre workflow d\'origine n\'est pas modifié : l\'automate converti sera envoyé comme un nouveau workflow.' }));
  return card;
}

// Modèles LLM -----------------------------------------------------------------------------------------

async function renderModels(main) {
  put(main, h('div', { class: 'page-head' }, h('div', {}, h('h1', { text: 'Modèles LLM' }),
    h('p', { class: 'muted', text: 'Clés chiffrées sur ce serveur, jamais renvoyées à l\'interface. Listes de modèles lues en direct chez chaque fournisseur.' }))));
  put(main, tuto('modeles', 'brancher des modèles', [
    ['Une clé OpenRouter suffit pour des centaines de modèles (Claude, GPT, Mimo, DeepSeek…). Collez-la dans la carte OpenRouter.'],
    ['« Voir les modèles », filtrez, puis ☆ Favori sur les modèles que vous voulez avoir sous la main : ils apparaissent dans « ★ Mes favoris » de chaque case LLM. « Par défaut » choisit celui proposé d\'office.'],
    ['Chaque workflow garde son propre modèle : un Mimo pour l\'entrée de l\'un, un Claude pour la rédaction de l\'autre.'],
    ['Jev peut passer par votre clé OpenRouter : carte TypeSafe Jev, « Accès à Jev par défaut ».'],
    ['Collez la clé TypeSafe dans la carte Jev pour tester vos automates en vrai.'],
    ['Ollama local : aucune clé, indiquez seulement l\'adresse de votre machine.'],
  ]));
  const list = h('div', { class: 'prov' });
  put(main, list);
  S.data.providers.forEach((p, i) => put(list, providerCard(p, i + 1)));
  for (const p of S.data.providers) {
    if (p.models_public && !p.models_count && !p.error) refreshProvider(p.id, true);
  }
}

function providerCard(p, rank) {
  const card = h('div', { class: 'card', id: 'prov-' + p.id });
  const st = { key: '', base: p.base_url };
  const badges = [
    p.kind === 'decision' ? h('span', { class: 'badge accent', text: 'Modèle de décision' }) : null,
    p.id === 'ollama_local' ? h('span', { class: 'badge info', text: 'Local, sans clé' }) : null,
    p.id === 'ollama_local' ? null : (p.configured ? h('span', { class: 'badge ok', text: 'Clé ' + (p.key_hint || 'enregistrée') }) : h('span', { class: 'badge', text: 'Non configuré' })),
    p.default_model ? h('span', { class: 'badge', text: 'Par défaut : ' + p.default_model }) : null,
    (p.favorites || []).length ? h('span', { class: 'badge accent', text: `★ ${p.favorites.length} favori(s)` }) : null,
  ];
  const models = S.models[p.id];
  const openKey = 'open-' + p.id;
  put(card, 
    h('div', { class: 'head' },
      h('div', {}, h('h2', {}, h('span', { class: 'rank', text: rank }), p.label, ' ', badges), h('p', { class: 'small muted', text: p.offer })),
      h('div', { class: 'row' },
        h('button', { class: 'small', text: 'Actualiser les modèles', onclick: () => refreshProvider(p.id) }),
        h('button', { class: 'small', text: 'Tester', onclick: () => testProvider(p) }))),
    h('div', { class: 'row' },
      p.id !== 'ollama_local' ? field('Clé d\'API', h('input', { type: 'password', autocomplete: 'off', placeholder: p.key_hint ? 'Remplacer la clé ' + p.key_hint : 'Coller la clé', oninput: e => { st.key = e.target.value; } }), 'grow') : null,
      p.base_editable ? field('Adresse', inputEl(p.base_url, v => { st.base = v; }), 'grow') : null,
      h('div', { class: 'field' }, h('label', { text: '\u00a0' }), h('div', { class: 'row' },
        h('button', { class: 'primary small', text: 'Enregistrer', onclick: async () => {
          try {
            const body = {};
            if (st.key) body.key = st.key;
            if (p.base_editable) body.base_url = st.base;
            await api('PUT', `/api/providers/${p.id}`, body); await loadState(); toast('Enregistré');
            delete S.models[p.id]; refreshProvider(p.id, true);
          } catch (e) { toast(e.message, true); }
        } }),
        p.key_hint ? h('button', { class: 'small danger', text: 'Retirer la clé', onclick: async () => { await api('PUT', `/api/providers/${p.id}`, { clear_key: true }); await loadState(); rerenderProvider(p.id); } }) : null))),
    p.key_url ? h('p', { class: 'small' }, h('a', { href: p.key_url, target: '_blank', rel: 'noopener', text: 'Obtenir une clé' })) : null,
    p.kind === 'decision' ? h('div', { class: 'row' },
      h('div', { class: 'field w240' }, lab('Accès à Jev par défaut', 'Pour les nouveaux automates. Chaque automate garde ensuite son propre choix (« Jev via », dans le Labo Jev ou le Labo n8n).'),
        selectEl(Object.entries(S.data.jev_providers || {}).map(([k, d]) => [k, d.label + (jevKeyReady(k) ? '' : ' (clé manquante)')]), p.jev_via || 'typesafe', async v => {
          await api('PUT', `/api/providers/${p.id}`, { jev_via: v }); await loadState(); rerenderProvider(p.id); toast('Accès à Jev par défaut : ' + S.data.jev_providers[v].label);
        })),
      p.jev_via === 'openrouter' ? (jevKeyReady('openrouter')
        ? h('div', { class: 'notice ok small', text: 'Jev passe par votre clé OpenRouter : aucune clé TypeSafe n\'est nécessaire.' })
        : h('div', { class: 'notice warn small', text: 'Enregistrez une clé OpenRouter (carte 1) : sans elle, Jev ne peut pas passer par OpenRouter.' })) : null) : null,
    p.error && !(p.kind === 'decision' && p.jev_via === 'openrouter') ? h('div', { class: 'notice err small', text: p.error }) : null,
    h('p', { class: 'small faint', text: `${p.models_count} modèle(s) · liste lue ${fmtDate(p.refreshed_at)}` }),
    p.models_count ? modelsTable(p, openKey) : null);
  return card;
}

function modelsTable(p, openKey) {
  const wrap = h('details', { open: S.openModels[p.id] ? true : null, ontoggle: e => { S.openModels[p.id] = e.target.open; if (e.target.open) fill(); } },
    h('summary', { text: 'Voir les modèles' }));
  const search = h('input', { placeholder: 'Filtrer (nom, :free, famille…)', oninput: () => draw(), style: 'margin-bottom:8px' });
  const tbody = h('tbody');
  const hasPrice = p.id === 'openrouter';
  const table = h('div', { class: 'models' }, h('table', {},
    h('thead', {}, h('tr', {}, h('th', { text: 'Modèle' }), h('th', { text: p.id === 'ollama_local' ? 'Taille' : 'Contexte' }),
      hasPrice ? h('th', { text: 'Entrée / M' }) : null, hasPrice ? h('th', { text: 'Sortie / M' }) : null, h('th', { text: '' }))), tbody));
  put(wrap, search, table);
  const draw = () => {
    clear(tbody);
    const q = search.value.toLowerCase();
    const ms = (S.models[p.id] || []).filter(m => !q || m.id.toLowerCase().includes(q) || String(m.name || '').toLowerCase().includes(q)).slice(0, 300);
    for (const m of ms) {
      put(tbody, h('tr', { class: m.id === p.default_model ? 'default' : '' },
        h('td', {}, h('div', { class: 'mono', text: m.id }), m.name && m.name !== m.id ? h('div', { class: 'small faint', text: m.name }) : null),
        h('td', { class: 'small', text: p.id === 'ollama_local' ? (m.size_gb ? m.size_gb + ' Go' : '') : (m.context ? Math.round(m.context / 1000) + ' k' : '') }),
        hasPrice ? h('td', { class: 'small', text: price(m.input) }) : null,
        hasPrice ? h('td', { class: 'small', text: price(m.output) }) : null,
        h('td', { class: 'fav-cell' },
          h('button', { class: 'small ghost star' + ((p.favorites || []).includes(m.id) ? ' on' : ''), title: 'Favori : proposé en premier dans chaque case LLM',
            text: (p.favorites || []).includes(m.id) ? '★ Favori' : '☆ Favori', onclick: async () => {
              const fav = new Set(p.favorites || []);
              if (fav.has(m.id)) fav.delete(m.id); else fav.add(m.id);
              await api('PUT', `/api/providers/${p.id}`, { favorites: [...fav] }); await loadState(); S.openModels[p.id] = true; rerenderProvider(p.id);
            } }),
          m.id === p.default_model ? h('span', { class: 'badge accent', text: 'par défaut' }) : h('button', { class: 'small ghost', text: 'Par défaut', onclick: async () => {
            await api('PUT', `/api/providers/${p.id}`, { default_model: m.id }); await loadState(); rerenderProvider(p.id);
          } }))));
    }
  };
  const fill = async () => { await ensureModels(p.id); draw(); };
  if (S.openModels[p.id]) fill();
  return wrap;
}

function rerenderProvider(pid) {
  const old = document.getElementById('prov-' + pid);
  const i = S.data.providers.findIndex(p => p.id === pid);
  if (old) old.replaceWith(providerCard(S.data.providers[i], i + 1));
}

async function refreshProvider(pid, quiet = false) {
  try {
    const r = await api('POST', `/api/providers/${pid}/refresh`);
    S.models[pid] = r.models;
    if (!quiet) toast(`${r.models.length} modèles lus`);
  } catch (e) { if (!quiet) toast(e.message, true); }
  await loadState();
  if (currentPage() === 'modeles') rerenderProvider(pid);
}

async function testProvider(p) {
  try {
    const r = await api('POST', `/api/providers/${p.id}/test`, {});
    toast(p.kind === 'decision' ? `Jev répond en ${r.latency_ms} ms (${r.answer.model})` : `Réponse en ${r.latency_ms} ms : ${r.text}`);
  } catch (e) { toast(e.message, true); }
}

// Instances n8n ---------------------------------------------------------------------------------------

async function renderN8n(main) {
  put(main, h('div', { class: 'page-head' }, h('div', {}, h('h1', { text: 'Instances n8n' }),
    h('p', { class: 'muted', text: 'Reliez un n8n local, sur VPS ou n8n Cloud par son API publique. Le builder y envoie les workflows, les identifiants et les active.' }))));
  put(main, tuto('n8n', 'relier n8n', [
    ['Dans n8n : Paramètres, API n8n, Créer une clé. Copiez-la.'],
    ['Ici : choisissez Local, VPS ou Cloud, collez l\'adresse de n8n et la clé, puis « Relier et tester ».'],
    ['Depuis un labo, « Envoyer vers n8n » crée le workflow, ses identifiants et l\'active.'],
  ]));
  const list = h('div', { class: 'grid two' });
  for (const i of S.data.instances) put(list, instanceCard(i));
  put(main, list.childNodes.length ? list : h('div', { class: 'card empty', text: 'Aucune instance reliée.' }));
  put(main, addInstanceCard());
}

function instanceCard(i) {
  const k = S.data.kinds[i.kind] || { label: i.kind };
  const wfBox = h('div');
  return h('div', { class: 'card stack' },
    h('div', { class: 'row between' }, h('h2', { style: 'margin:0' }, i.label, ' ', h('span', { class: 'badge accent', text: k.label })),
      i.status ? h('span', { class: 'badge ' + (i.status === 'ok' ? 'ok' : 'err'), text: i.status === 'ok' ? 'Connectée' : 'Erreur' }) : null),
    h('div', { class: 'mono small', text: i.url }),
    h('div', { class: 'small muted', text: `Clé ${i.key_hint || 'absente'} · vérifiée ${fmtDate(i.checked_at)}` }),
    i.status_detail ? h('div', { class: 'notice err small', text: i.status_detail }) : null,
    h('div', { class: 'row' },
      h('button', { class: 'small', text: 'Tester', onclick: async () => { try { await api('POST', `/api/n8n/${i.id}/test`); toast('Connexion réussie'); } catch (e) { toast(e.message, true); } await loadState(); route(); } }),
      h('button', { class: 'small', text: 'Voir les workflows', onclick: async () => {
        put(clear(wfBox), h('p', { class: 'muted small', text: 'Lecture…' }));
        try {
          const r = await api('GET', `/api/n8n/${i.id}/workflows`);
          put(clear(wfBox), r.workflows.length ? h('table', {}, h('tbody', {}, r.workflows.map(w => h('tr', {},
            h('td', {}, h('a', { href: `${r.base}/workflow/${w.id}`, target: '_blank', rel: 'noopener', text: w.name })),
            h('td', {}, w.builder ? h('span', { class: 'badge accent', text: w.builder === 'ancien' ? 'builder, ancienne version' : 'fait par le builder' }) : null),
            h('td', {}, h('span', { class: 'badge ' + (w.active ? 'ok' : ''), text: w.active ? 'actif' : 'inactif' })))))) : h('p', { class: 'small muted', text: 'Aucun workflow.' }));
        } catch (e) { put(clear(wfBox), h('div', { class: 'notice err small', text: e.message })); }
      } }),
      h('button', { class: 'small', text: 'Importer un workflow', onclick: openImport }),
      h('a', { class: 'btn small', href: i.url, target: '_blank', rel: 'noopener', text: 'Ouvrir n8n' }),
      h('span', { class: 'spacer' }),
      h('button', { class: 'small danger', text: 'Retirer', onclick: async () => { if (!confirm('Retirer cette instance du builder ? (rien n\'est supprimé dans n8n)')) return; await api('DELETE', `/api/n8n/${i.id}`); await loadState(); route(); } })),
    wfBox);
}

function addInstanceCard() {
  const st = { kind: 'local', label: '', url: '', key: '' };
  const card = h('div', { class: 'card stack', style: 'margin-top:14px' });
  const draw = () => {
    clear(card);
    const k = S.data.kinds[st.kind];
    put(card, h('h2', { text: 'Relier une instance' }),
      h('div', { class: 'kinds' }, Object.entries(S.data.kinds).map(([id, kk]) => h('button', { class: 'kind' + (st.kind === id ? ' active' : ''), onclick: () => { st.kind = id; draw(); } },
        h('b', { text: kk.label }), h('span', { class: 'small muted', text: kk.hint })))),
      h('p', { class: 'small muted', text: k.help }),
      h('div', { class: 'row' },
        field('Nom', inputEl(st.label, v => { st.label = v; }, { placeholder: k.label }), 'w180'),
        field('Adresse', inputEl(st.url, v => { st.url = v; }, { placeholder: k.hint }), 'grow')),
      field('Clé d\'API n8n (Paramètres, API n8n)', h('input', { type: 'password', autocomplete: 'off', oninput: e => { st.key = e.target.value; } })),
      h('div', { class: 'row end' }, h('button', { class: 'primary', text: 'Relier et tester', onclick: async () => {
        try {
          const r = await api('POST', '/api/n8n', st);
          try { await api('POST', `/api/n8n/${r.id}/test`); toast('Instance reliée et joignable'); }
          catch (e) { toast('Instance enregistrée, mais : ' + e.message, true); }
          await loadState(); route();
        } catch (e) { toast(e.message, true); }
      } })));
  };
  draw();
  return card;
}

// Guide -----------------------------------------------------------------------------------------------

function renderGuide(main) {
  const P = (...t) => h('p', {}, ...t);
  put(main, h('div', { class: 'card guide' },
    h('h1', { text: 'Guide' }),
    h('h2', { text: 'Pourquoi des workflows déterministes' }),
    P('Un agent IA qui trie, calcule, vérifie des seuils et choisit une procédure brûle des tokens, varie d\'une exécution à l\'autre et peut être manipulé par le texte qu\'il lit. Le builder sort ce travail de l\'agent : un workflow n8n fait le tri et le calcul, l\'agent ne reçoit que ce qui demande du jugement ou de la rédaction.'),
    h('h2', { text: 'Jev, le modèle de décision de TypeSafe' }),
    P('Jev (sorti le 15 septembre 2026) ne génère pas de texte. On lui envoie un état et des questions typées, il rend des valeurs et des probabilités calibrées : oui/non (noul), choix parmi des options (choice), score sur des niveaux ordonnés (score). Plusieurs questions partent en un seul appel. Prix : 0,042 $ par million de tokens en entrée, sortie gratuite, contexte de 64 k tokens.'),
    P('Les réponses sont typées, donc la décision finale est écrite en code : mêmes probabilités, même route. La confiance de Jev sert de second axe : en dessous du seuil, le cas part en revue au lieu d\'être tranché au hasard.'),
    h('h2', { text: 'Limites à connaître' }),
    h('ul', {},
      h('li', { text: 'Jev est entraîné surtout en anglais. Le français fonctionne mais moins bien : calibrez vos seuils sur une vingtaine de cas réels avant la production.' }),
      h('li', { text: 'Déterministe ne veut pas dire exact : Jev peut se tromper avec une confiance élevée. Le gain est la stabilité et la traçabilité, pas l\'infaillibilité.' }),
      h('li', { text: 'jev-latest suit les nouvelles versions : figez jev-1.13.0 quand vos seuils sont calibrés.' }),
      h('li', { text: 'Texte seulement : une image, un PDF ou un son doivent être convertis en texte avant Jev.' }),
      h('li', { text: 'Les limites de débit de TypeSafe changent souvent en ce moment : le nœud Jev réessaie trois fois, puis envoie le cas sur la route d\'erreur.' })),
    h('h2', { text: 'Du builder au Hub d\'agents' }),
    h('ol', {},
      h('li', { text: 'Labo Jev : partez d\'une fiche type ou faites remplir les cases par l\'IA, lisez ses « Pourquoi ? », ajustez. Labo n8n : partez d\'un des 50 modèles.' }),
      h('li', { text: 'Testez, lancez le banc d\'essai, appliquez le calibrage proposé, enregistrez.' }),
      h('li', { text: 'Envoyez vers votre instance n8n (clé d\'en-tête activée par défaut). Notez la clé affichée une fois.' }),
      h('li', { text: 'Exporter vers le Hub : déposez openapi.json (Connecteurs, API par sa description OpenAPI, clé au coffre), importez SKILL.md dans les skills et ajoutez-le à la playlist ; ou installez kit.json dans le Studio pour une playlist complète.' }),
      h('li', { text: 'L\'agent appelle le workflow comme un outil et reçoit route, raison et variables. Il agit selon la route, sans refaire le tri.' })),
    h('h2', { text: 'Ce que produit chaque workflow' }),
    P('Déclencheur, préparation en JavaScript lisible, un appel HTTP à Jev avec trois essais, un nœud de décision en JavaScript sans modèle, un aiguillage par route, un nœud vide par route où brancher vos actions, un LLM facultatif sur une seule route, et une réponse JSON pour les webhooks. Uniquement des nœuds du cœur de n8n.'),
    h('h2', { text: 'Sources' }),
    h('ul', {},
      h('li', {}, h('a', { href: 'https://docs.typesafe.ai/api', target: '_blank', rel: 'noopener', text: 'Référence de l\'API TypeSafe' })),
      h('li', {}, h('a', { href: 'https://typesafe.ai/blog/introducing-system-one-models-and-jev', target: '_blank', rel: 'noopener', text: 'Annonce de Jev et des modèles System One' })),
      h('li', {}, h('a', { href: 'https://docs.n8n.io/api/', target: '_blank', rel: 'noopener', text: 'API publique de n8n' })))));
}

// Labo Jev --------------------------------------------------------------------------------------------
// Une fiche en cases : chaque case dit qui l'a remplie (IA, vous, calibrage) et pourquoi.

const J = { fiche: null, fid: null, savedId: null, compiled: null, errors: null, essai: null, bench: null, calib: null, eco: null, openWhy: {} };
const QTYPES = {
  noul: ['Oui / non', 'Une question fermée. Jev rend une probabilité ; vos seuils la changent en OUI, NON ou À VÉRIFIER.'],
  choice: ['Choix parmi des mots', 'Jev choisit un mot parmi ceux que vous attendez, avec la probabilité de chacun.'],
  score: ['Score sur une échelle', 'Jev place l\'entrée sur une échelle continue ; vos tranches lui donnent un nom.'],
  liste: ['Choix dans une liste reçue', 'Jev choisit le meilleur élément d\'une liste venue de l\'entrée (brouillons, candidats, valeurs trouvées).'],
  etiquettes: ['Étiquettes multiples', 'Chaque étiquette est jugée séparément : toutes celles qui s\'appliquent sont gardées.'],
  pour_chaque: ['Pour chaque élément', 'La même question oui/non posée à chaque élément d\'une liste de l\'entrée.'],
};
const OP_LABEL = { est: 'est', n_est_pas: 'n\'est pas', au_moins: 'au moins', au_plus: 'au plus', contient: 'contient', ne_contient_pas: 'ne contient pas' };

function jfield(path) { return (J.fiche.ia || {})[path]; }
function touch(path) {
  J.fiche.ia = J.fiche.ia || {};
  const prev = J.fiche.ia[path] || {};
  J.fiche.ia[path] = { origine: 'humain', pourquoi: prev.pourquoi || '' };
  jChanged();
}
const jRecompile = debounce(async () => {
  try {
    const r = await api('POST', '/api/jevlab/compile', { fiche: J.fiche });
    J.compiled = r; J.errors = null;
  } catch (e) { J.errors = e.errors || [e.message]; }
  renderJevSide();
  refreshRuleSelects();
  jGraph();
}, 400);
function jChanged(structural = false) { J.essai = null; if (structural) renderJevEditor(); jRecompile(); }

function originBadge(path) {
  const m = jfield(path);
  const why = m && m.pourquoi;
  const label = !m ? null : ({ ia: 'Proposé par l\'IA', humain: 'Réglé par vous', calibrage: 'Calibré sur les tests' })[m.origine];
  const box = h('span', { class: 'row', style: 'gap:6px' });
  if (label) put(box, h('span', { class: 'badge ' + ({ ia: 'accent', humain: 'ok', calibrage: 'info' })[m.origine], text: label }));
  if (why) put(box, h('button', { class: 'ghost small', text: J.openWhy[path] ? 'Masquer pourquoi' : 'Pourquoi ?', onclick: () => { J.openWhy[path] = !J.openWhy[path]; renderJevEditor(); } }));
  put(box, h('button', { class: 'ghost small', title: 'Demander à l\'IA de proposer cette case', text: '✦ Proposer', onclick: () => proposeField(path) }));
  return box;
}
function whyBox(path) { const m = jfield(path); return m && m.pourquoi && J.openWhy[path] ? h('div', { class: 'notice info small', text: m.pourquoi }) : null; }

async function proposeField(path) {
  const st = jAssist();
  if (!st.provider) return toast('Configurez un fournisseur de discussion dans Modèles LLM.', true);
  const consigne = prompt('Une précision pour l\'IA ? (facultatif)', '') ?? null;
  if (consigne === null) return;
  toast('L\'IA réfléchit à cette case…');
  try {
    const r = await api('POST', '/api/jevlab/field', { provider: st.provider, model: st.model, fiche: J.fiche, path, consigne });
    J.fiche = r.fiche; J.openWhy[path] = true; jChanged(true); toast('Proposition appliquée : relisez-la, le pourquoi est affiché.');
  } catch (e) { toast(e.message + (e.errors ? ' : ' + e.errors.join(' ; ') : ''), true); }
}

function jAssist() {
  const chat = chatProviders().filter(p => p.configured);
  const st = J.assist = J.assist || { provider: (chat.find(x => !x.key_optional) || chat[0] || {}).id, model: '', description: '', context: '' };
  if (!st.model && st.provider) st.model = (provider(st.provider) || {}).default_model || '';
  return st;
}

async function loadFicheType(fid) {
  const f = await api('GET', `/api/jevlab/fiches/${fid}`);
  J.fiche = f.fiche; J.fid = fid; J.savedId = null; J.bench = null; J.calib = null; J.essai = null; J.scene = null; J.preview = null; J.lab = null; J.leviers = null; J.target = null;
  renderJevLab($('#main'));
}
async function loadSavedFiche(id) {
  const f = await api('GET', `/api/jevlab/saved/${id}`);
  J.fiche = f.fiche; J.savedId = id; J.fid = null; J.bench = null; J.calib = null; J.essai = null; J.scene = null; J.preview = null; J.lab = null; J.leviers = null; J.target = null;
  renderJevLab($('#main'));
}

async function renderJevLab(main) {
  if (!J.fiche) { const f = await api('GET', '/api/jevlab/fiches/tri-emails'); J.fiche = f.fiche; J.fid = 'tri-emails'; }
  if (!J.fiche.jev_fournisseur) {
    J.fiche.jev_fournisseur = defaultJevProvider();
    J.fiche.modele = ((S.data.jev_providers || {})[J.fiche.jev_fournisseur] || {}).default || J.fiche.modele;
  }
  clear(main);
  put(main,
    h('div', { class: 'page-head' },
      h('div', {}, h('h1', { text: 'Labo Jev' }),
        h('p', { class: 'muted', text: 'Réglez un automate de décision case par case. L\'IA propose et explique, vous ajustez, le banc d\'essai vérifie. À l\'exécution, aucun LLM : Jev et des règles.' })),
      h('div', { class: 'row' },
        viewToggle(J.view || 'form', v => { J.view = v; renderJevLab($('#main')); }),
        h('button', { text: 'Importer depuis n8n', title: 'Reprendre un workflow de votre n8n', onclick: openImport }),
        h('button', { text: 'Enregistrer', onclick: saveFiche }),
        h('button', { text: 'Ouvrir dans le Labo n8n', title: 'Mode expert : la même logique, tous les réglages', onclick: openInN8nLab }),
        h('button', { text: 'Exporter vers le Hub', onclick: () => openHubExport({ fiche: J.fiche }) }),
        h('button', { class: 'primary', text: 'Envoyer vers n8n', onclick: () => openPush(jevPushCtx()) }))),
    h('div', { class: 'workbench', style: J.view === 'graph' ? 'display:none' : null },
      h('aside', { class: 'library', id: 'jlib' }), h('section', { id: 'jed' }), h('aside', { class: 'preview', id: 'jside' })),
    h('div', { id: 'jgraph' }));
  renderJevLibrary(); renderJevEditor(); jRecompile();
}

function jGraph() {
  const host = document.getElementById('jgraph');
  if (!host || J.view !== 'graph') return;
  J.scene = J.scene || { st: {} };
  Object.assign(J.scene, {
    host, build: J.errors ? null : J.compiled,
    notes: Object.fromEntries((J.fiche.resultats || []).map(r => [r.id, (r.label ? r.label + ' : ' : '') + (r.consigne || '')])),
    onThreshold: (qid, key, val) => {
      const q = J.fiche.questions.find(x => x.id === qid);
      if (!q) return;
      q[key] = val;
      if (q.seuil_non > q.seuil_oui) { if (key === 'seuil_non') q.seuil_oui = val; else q.seuil_non = val; }
      touch(`questions.${qid}.seuils`);
    },
    redraw: () => renderScene(J.scene),
    kindOf: voieKind,
    fleet: sceneFleet(),
    salle: salleCard,
  });
  sceneReplay(J.scene);
  renderScene(J.scene);
}

function jevPushCtx() {
  if (!J.compiled || J.errors) return null;
  return { payload: () => ({ fiche: J.fiche }), trigger: J.compiled.spec.trigger.type, save: async () => null, target: J.target };
}

async function openInN8nLab() {
  if (!J.compiled) return toast('Complétez la fiche d\'abord.', true);
  S.spec = emptySpec(J.compiled.spec); S.savedId = null; S.tplId = null; S.test = null;
  location.hash = '#atelier';
}

async function saveFiche() {
  try {
    const r = await api('POST', '/api/jevlab/saved', { id: J.savedId, fiche: J.fiche });
    J.savedId = r.id; await loadState(); renderJevLibrary(); toast('Fiche enregistrée');
  } catch (e) { toast(e.message + (e.errors ? ' : ' + e.errors.join(' ; ') : ''), true); }
}

function renderJevLibrary() {
  const lib = clear($('#jlib'));
  if (S.data.mes_fiches.length) {
    put(lib, h('h3', { text: 'Mes fiches' }));
    for (const f of S.data.mes_fiches) {
      put(lib, h('div', { class: 'row', style: 'margin-bottom:6px;flex-wrap:nowrap' },
        h('button', { class: 'tpl' + (J.savedId === f.id ? ' active' : ''), style: 'margin:0', onclick: () => loadSavedFiche(f.id) },
          h('b', { text: f.name }), h('span', { class: 'small', text: 'Modifiée le ' + fmtDate(f.updated) })),
        h('button', { class: 'ghost danger', text: '×', title: 'Supprimer', onclick: async () => {
          if (!confirm('Supprimer cette fiche ?')) return;
          await api('DELETE', `/api/jevlab/saved/${f.id}`); await loadState(); renderJevLibrary();
        } })));
    }
  }
  put(lib, h('h3', { text: 'Fiches types', style: 'margin-top:14px' }));
  for (const f of S.data.fiches) {
    put(lib, h('button', { class: 'tpl' + (J.fid === f.id ? ' active' : ''), onclick: () => loadFicheType(f.id) },
      h('b', { text: f.name }), h('span', { class: 'small', text: f.montre }),
      h('span', { class: 'tags' }, h('span', { class: 'badge', text: 'Niveau ' + f.niveau }),
        f.types.map(t => h('span', { class: 'badge accent', text: QTYPES[t][0] })))));
  }
}

function renderJevEditor() {
  const ed = $('#jed');
  if (!ed) return;
  clear(ed);
  const f = J.fiche;
  put(ed, tuto('jev', 'régler un automate Jev', [
    ['Jev ne rédige pas : il ', h('b', { text: 'juge' }), '. Il répond à vos questions par des probabilités (oui à 82 %, « facture » à 91 %…).'],
    ['Faites remplir les cases par l\'IA, ou partez d\'une fiche type à gauche. Chaque case dit qui l\'a remplie ; « Pourquoi ? » montre le raisonnement de l\'IA.'],
    ['Les ', h('b', { text: 'tranches' }), ' transforment une probabilité en mot : sous le seuil du NON, c\'est non ; au-dessus du seuil du OUI, c\'est oui ; entre les deux, « à vérifier ».'],
    ['Les ', h('b', { text: 'règles' }), ' lisent ces mots dans l\'ordre : la première qui s\'applique choisit le résultat.'],
    ['Essayez à droite, puis lancez le banc d\'essai : le calibrage propose des seuils qui respectent vos cas.'],
    ['Facultatif : ajoutez des LLM (un en entrée, un par résultat) dans la section dédiée.'],
  ]),
  jAssistCard(),
    h('div', { class: 'card stack' },
      field('Nom de l\'automate', inputEl(f.name, v => { f.name = v; jChanged(); })),
      h('div', { class: 'row between' }, h('label', { text: 'Ce que l\'automate décide', style: 'margin:0' }), originBadge('objectif')),
      textArea(f.objectif, v => { f.objectif = v; touch('objectif'); }, { rows: 2 }), whyBox('objectif')),
    jEntreeCard(), jQuestionsCard(), jResultatsCard(), jReglesCard(),
    llmSetup(() => ({ entree: f.llm_entree, routes: f.llms || [] }), v => { if ('entree' in v) f.llm_entree = v.entree; if ('routes' in v) f.llms = v.routes; },
      f.resultats.map(r => r.id), st => jChanged(st)),
    jTestsCard());
}

function jAssistCard() {
  const st = jAssist();
  const chat = chatProviders().filter(p => p.configured);
  const status = h('div', { class: 'small muted' });
  const run = async improve => {
    status.textContent = 'L\'IA remplit les cases et explique ses choix…';
    try {
      const r = await api('POST', '/api/jevlab/fill', { provider: st.provider, model: st.model, description: st.description, context: st.context, fiche: improve ? J.fiche : null });
      J.fiche = r.fiche; J.fid = null; J.savedId = improve ? J.savedId : null; J.target = improve ? J.target : null; J.bench = null; J.calib = null; J.preview = null; J.lab = null; J.leviers = null;
      Object.keys(J.fiche.ia || {}).forEach(k => { J.openWhy[k] = false; });
      status.textContent = 'Fiche remplie. Chaque case porte le badge « Proposé par l\'IA » : cliquez « Pourquoi ? » pour lire son raisonnement.';
      renderJevLibrary(); jChanged(true);
    } catch (e) { status.textContent = ''; toast(e.message + (e.errors ? ' : ' + e.errors.join(' ; ') : ''), true); }
  };
  if (!chat.length) return h('div', { class: 'card small' }, 'Assistant IA : ', h('a', { href: '#modeles', text: 'ajoutez une clé OpenRouter ou branchez Ollama' }), ' pour faire remplir les cases.');
  return h('details', { class: 'card', open: true },
    h('summary', { text: 'Remplir avec l\'IA' }),
    h('div', { class: 'stack' },
      h('div', { class: 'row' },
        field('Fournisseur', selectEl(chat.map(p => [p.id, p.label]), st.provider, v => { st.provider = v; st.model = (provider(v) || {}).default_model || ''; renderJevEditor(); }), 'w180'),
        field('Modèle', modelInput(st.provider, st.model, v => { st.model = v; }), 'grow')),
      field('Décrivez la décision à automatiser', textArea(st.description, v => { st.description = v; }, { rows: 3, placeholder: 'Exemple : pour chaque avis client, décider s\'il faut remercier, répondre sur un problème, ou alerter le responsable.' })),
      field('Contexte facultatif (mission de la playlist du hub, politique interne…)', textArea(st.context, v => { st.context = v; }, { rows: 2 })),
      h('div', { class: 'row' }, h('button', { class: 'primary', text: 'Remplir toutes les cases', onclick: () => run(false) }),
        h('button', { text: 'Améliorer en gardant mes réglages', onclick: () => run(true) }), status)));
}

function jEntreeCard() {
  const e = J.fiche.entree;
  const err = h('span', { class: 'small', style: 'color:var(--critical)' });
  return h('div', { class: 'card stack' }, h('h2', { text: '1. Ce que reçoit l\'automate' }),
    h('div', { class: 'row' },
      field('Entrée', selectEl([['field', 'Un texte (un champ)'], ['fields', 'Plusieurs champs'], ['json', 'Un objet JSON complet']], e.mode, v => { e.mode = v; jChanged(true); }), 'w240'),
      e.mode === 'field' ? field('Nom du champ', inputEl(e.field, v => { e.field = v; jChanged(); }), 'grow') : null,
      e.mode === 'fields' ? field('Champs, séparés par des virgules', inputEl((e.fields || []).join(', '), v => { e.fields = v.split(',').map(x => x.trim()).filter(Boolean); jChanged(); }), 'grow') : null),
    field('Exemple d\'entrée (JSON)', textArea(JSON.stringify(J.fiche.exemple, null, 2), v => { try { J.fiche.exemple = JSON.parse(v); err.textContent = ''; jChanged(); } catch { err.textContent = 'JSON invalide'; } }, { class: 'code', rows: 4 })), err);
}

function jQuestionsCard() {
  const f = J.fiche;
  const card = h('div', { class: 'card' },
    h('div', { class: 'section-title' }, h('h2', { text: `2. Questions posées à Jev (${f.questions.length})` }),
      selectEl([['', '+ Ajouter une question…'], ...Object.entries(QTYPES).map(([k, v]) => [k, v[0]])], '', v => { if (v) addJQuestion(v); })),
    jevVia(f.jev_fournisseur, f.modele, (jp, m) => { f.jev_fournisseur = jp; f.modele = m; jChanged(true); }),
    h('p', { class: 'small muted' }, 'Toutes les questions partent en un seul appel à Jev. Une question = un seul jugement. ', info('Six types : oui/non, choix parmi des mots, score, choix dans une liste reçue, étiquettes multiples, question pour chaque élément. Le menu « Ajouter une question » les propose tous.')));
  f.questions.forEach((q, i) => put(card, jQuestionEl(q, i)));
  return card;
}

function addJQuestion(type) {
  const f = J.fiche;
  let n = 1; while (f.questions.some(q => q.id === 'question_' + n)) n++;
  const q = { id: 'question_' + n, type, question: '' };
  if (type === 'noul') Object.assign(q, { seuil_oui: 70, seuil_non: 30 });
  if (type === 'choice') Object.assign(q, { options: [{ mot: 'option_a', description: '' }, { mot: 'option_b', description: '' }], confiance_min: 60, marge: 0 });
  if (type === 'score') Object.assign(q, { niveaux: ['Bas', 'Moyen', 'Haut'], confiance_min: 50 });
  if (type === 'etiquettes') Object.assign(q, { question: 'Le texte relève-t-il de l\'`etiquette` décrite par `definition` ?', options: [{ mot: 'etiquette_a', description: '' }], seuil: 60 });
  if (type === 'liste') Object.assign(q, { champ_liste: 'candidats', confiance_min: 60, marge: 10 });
  if (type === 'pour_chaque') Object.assign(q, { question: 'L\'`element` … ?', champ_liste: 'lignes', seuil: 60 });
  f.questions.push(q); jChanged(true);
}

function bandBar(non, oui, marker) {
  const bar = h('div', { class: 'bands' },
    h('span', { class: 'band no', style: `width:${non}%`, text: non >= 12 ? 'NON' : '' }),
    h('span', { class: 'band mid', style: `width:${Math.max(0, oui - non)}%`, text: oui - non >= 16 ? 'À VÉRIFIER' : '' }),
    h('span', { class: 'band yes', style: `width:${100 - oui}%`, text: 100 - oui >= 10 ? 'OUI' : '' }));
  if (marker !== undefined && marker !== null) put(bar, h('i', { class: 'marker', style: `left:${Math.round(marker * 100)}%`, title: Math.round(marker * 100) + ' %' }));
  return bar;
}

function pctInput(value, oninput, label) {
  const out = h('b', { text: value + ' %' });
  return h('div', { class: 'field grow' }, h('label', {}, label, ' ', out),
    h('input', { type: 'range', min: 0, max: 100, step: 1, value, oninput: e => { out.textContent = e.target.value + ' %'; oninput(Number(e.target.value)); } }));
}

function jQuestionEl(q, i) {
  const f = J.fiche;
  const base = `questions.${q.id}`;
  let curId = q.id;
  const el = h('div', { class: 'qcard stack' },
    h('div', { class: 'row' },
      h('span', { class: 'badge accent', text: QTYPES[q.type][0] }),
      field('Identifiant', inputEl(q.id, v => {
        if (/^[a-z][a-z0-9_]*$/.test(v) && !f.questions.some(x => x.id === v)) {
          f.regles.forEach(r => r.si.forEach(c => { if (c.question === curId) c.question = v; }));
          q.id = v; curId = v; jChanged();
        }
      }), 'w180'),
      h('span', { class: 'spacer' }),
      h('button', { class: 'ghost', text: '↑', disabled: i === 0, onclick: () => { [f.questions[i - 1], f.questions[i]] = [f.questions[i], f.questions[i - 1]]; jChanged(true); } }),
      h('button', { class: 'ghost danger', text: 'Supprimer', onclick: () => { f.questions.splice(i, 1); jChanged(true); } })),
    h('p', { class: 'small muted', text: QTYPES[q.type][1] }),
    h('div', { class: 'row between' }, h('label', { text: 'Question posée à Jev', style: 'margin:0' }), originBadge(base)),
    textArea(q.question, v => { q.question = v; touch(base); }, { rows: 2 }), whyBox(base),
    q.aide ? h('p', { class: 'small faint', text: q.aide }) : null);

  const seuils = `${base}.seuils`;
  const seuilHead = label => h('div', { class: 'row between' }, h('label', { text: label, style: 'margin:0' }), originBadge(seuils));
  if (q.type === 'noul') {
    const bars = h('div');
    const redraw = () => put(clear(bars), bandBar(q.seuil_non, q.seuil_oui));
    redraw();
    put(el, seuilHead('Tranches de pourcentage'), h('p', { class: 'small muted' }, info('Jev rend la probabilité du oui. Sous le seuil du NON, verdict « non » ; au-dessus du seuil du OUI, « oui » ; entre les deux, « à vérifier ». Plus une erreur coûte cher, plus on écarte les seuils.'), ' Glissez les curseurs : la barre montre les trois zones.'), bars,
      h('div', { class: 'row' },
        pctInput(q.seuil_non, v => { q.seuil_non = Math.min(v, q.seuil_oui); redraw(); touch(seuils); }, 'NON jusqu\'à'),
        pctInput(q.seuil_oui, v => { q.seuil_oui = Math.max(v, q.seuil_non); redraw(); touch(seuils); }, 'OUI à partir de')),
      whyBox(seuils),
      h('div', { class: 'row' },
        field('OUI signifie', inputEl(q.oui_signifie, v => { q.oui_signifie = v; touch(base); }), 'grow'),
        field('NON signifie', inputEl(q.non_signifie, v => { q.non_signifie = v; touch(base); }), 'grow')));
  }
  if (q.type === 'choice' || q.type === 'etiquettes') {
    const opts = `${base}.options`;
    const rows = h('div');
    const draw = () => {
      clear(rows);
      q.options.forEach((o, j) => put(rows, h('div', { class: 'crit' },
        inputEl(o.mot, v => { if (/^[a-z][a-z0-9_]*$/.test(v)) { o.mot = v; touch(opts); } }, { placeholder: 'mot attendu' }),
        inputEl(o.description, v => { o.description = v; touch(opts); }, { placeholder: 'ce que ce mot veut dire' }),
        h('button', { class: 'ghost danger', text: '×', onclick: () => { q.options.splice(j, 1); touch(opts); draw(); } }))));
    };
    draw();
    put(el, h('div', { class: 'row between' }, h('label', { text: q.type === 'choice' ? 'Mots attendus' : 'Étiquettes', style: 'margin:0' }), originBadge(opts)),
      rows, whyBox(opts), h('button', { class: 'small', text: '+ Mot', onclick: () => { let n = 1; while (q.options.some(o => o.mot === 'mot_' + n)) n++; q.options.push({ mot: 'mot_' + n, description: '' }); touch(opts); draw(); } }));
  }
  if (q.type === 'choice' || q.type === 'liste') {
    put(el, seuilHead('Quand Jev n\'est pas sûr'),
      h('div', { class: 'row' },
        pctInput(q.confiance_min, v => { q.confiance_min = v; touch(seuils); }, 'Confiance minimale'),
        pctInput(q.marge || 0, v => { q.marge = v; touch(seuils); }, 'Hésitation si les deux premiers sont à moins de')),
      h('p', { class: 'small faint', text: 'Sous la confiance minimale : « incertain ». Écart trop faible entre les deux premiers : « hesitation » (0 % : désactivé).' }),
      whyBox(seuils));
  }
  if (q.type === 'etiquettes' || q.type === 'pour_chaque') {
    put(el, seuilHead('Seuil pour garder'), h('div', { class: 'row' }, pctInput(q.seuil, v => { q.seuil = v; touch(seuils); }, 'Garder à partir de')), whyBox(seuils));
  }
  if (q.type === 'liste' || q.type === 'pour_chaque') {
    put(el, h('div', { class: 'row' },
      field('Champ de l\'entrée qui contient la liste', inputEl(q.champ_liste, v => { q.champ_liste = v; touch(base); }), 'grow'),
      field('Si les éléments sont des objets, champ du texte', inputEl(q.champ_texte, v => { q.champ_texte = v; touch(base); }, { placeholder: 'facultatif' }), 'grow')));
  }
  if (q.type === 'score') {
    const nv = `${base}.niveaux`;
    put(el, h('div', { class: 'row between' }, h('label', { text: 'Niveaux, du plus bas au plus haut (un par ligne)', style: 'margin:0' }), originBadge(nv)),
      textArea((q.niveaux || []).join('\n'), v => { q.niveaux = v.split('\n').map(x => x.trim()).filter(Boolean); touch(nv); }, { rows: 4 }), whyBox(nv));
    const tr = h('div');
    const drawTr = () => {
      clear(tr);
      (q.tranches || []).forEach((t, j) => put(tr, h('div', { class: 'crit' },
        inputEl(t.jusqu_a, v => { t.jusqu_a = Number(String(v).replace(',', '.')); touch(seuils); }, { type: 'number', step: 0.1, min: 0, max: (q.niveaux || []).length - 1, title: 'score jusqu\'à' }),
        inputEl(t.mot, v => { t.mot = v; touch(seuils); }, { placeholder: 'nom de la tranche' }),
        h('button', { class: 'ghost danger', text: '×', onclick: () => { q.tranches.splice(j, 1); if (!q.tranches.length) { delete q.tranches; delete q.au_dela; } touch(seuils); drawTr(); } }))));
      if (q.tranches && q.tranches.length) put(tr, h('div', { class: 'crit' }, h('span', { class: 'small muted', text: 'au-delà' }), inputEl(q.au_dela, v => { q.au_dela = v; touch(seuils); }, { placeholder: 'nom de la dernière tranche' }), h('span')));
    };
    drawTr();
    put(el, seuilHead(`Tranches du score (0 = ${(q.niveaux || [])[0] || '?'}, ${(q.niveaux || []).length - 1} = ${(q.niveaux || []).slice(-1)[0] || '?'})`),
      h('p', { class: 'small faint', text: 'Le score est continu : 1,7 est entre le 2e et le 3e niveau. Nommez des tranches pour écrire des règles lisibles ; sans tranche, les règles utilisent le numéro du niveau.' }),
      tr, whyBox(seuils),
      h('div', { class: 'row' },
        h('button', { class: 'small', text: '+ Tranche', onclick: () => { q.tranches = q.tranches || []; q.tranches.push({ jusqu_a: q.tranches.length + 0.5, mot: 'tranche_' + (q.tranches.length + 1) }); q.au_dela = q.au_dela || 'haut'; touch(seuils); drawTr(); } }),
        pctInput(q.confiance_min, v => { q.confiance_min = v; touch(seuils); }, 'Confiance minimale')));
  }
  const err = h('span', { class: 'small', style: 'color:var(--critical)' });
  put(el, h('details', { open: q.donnees ? true : null }, h('summary', { text: 'Données de référence (facultatif)' }),
    h('p', { class: 'small muted', text: 'Un objet JSON joint à la question, citable entre accents graves : {"concurrents": ["A", "B"]} puis `concurrents` dans la question.' }),
    textArea(q.donnees ? JSON.stringify(q.donnees, null, 2) : '', v => { try { const d = v.trim() ? JSON.parse(v) : null; if (d) q.donnees = d; else delete q.donnees; err.textContent = ''; touch(base); } catch { err.textContent = 'JSON invalide'; } }, { class: 'code', rows: 3 }), err));
  return el;
}

function jResultatsCard() {
  const f = J.fiche;
  const rows = h('div', { class: 'stack' });
  f.resultats.forEach((r, i) => put(rows, h('div', { class: 'crit', style: 'grid-template-columns: 150px 180px 1fr auto' },
    inputEl(r.id, v => { if (/^[a-z][a-z0-9_]*$/.test(v)) { const old = r.id; r.id = v; f.regles.forEach(x => { if (x.alors === old) x.alors = v; }); if (f.par_defaut === old) f.par_defaut = v; if (f.si_jev_indisponible === old) f.si_jev_indisponible = v; touch('resultats'); } }, { placeholder: 'identifiant' }),
    inputEl(r.label, v => { r.label = v; touch('resultats'); }, { placeholder: 'libellé' }),
    inputEl(r.consigne, v => { r.consigne = v; touch('resultats'); }, { placeholder: 'ce que fait l\'agent dans ce cas' }),
    h('button', { class: 'ghost danger', text: '×', onclick: () => { f.resultats.splice(i, 1); jChanged(true); } }))));
  return h('div', { class: 'card stack' },
    h('div', { class: 'section-title' }, h('h2', { text: '3. Résultats possibles' }), originBadge('resultats')), whyBox('resultats'),
    h('p', { class: 'small muted', text: 'Chaque résultat devient une route de l\'automate. La consigne est ce que l\'agent du hub fera : elle part dans le skill et le kit exportés.' }),
    rows, h('button', { class: 'small', text: '+ Résultat', onclick: () => { let n = 1; while (f.resultats.some(r => r.id === 'resultat_' + n)) n++; f.resultats.push({ id: 'resultat_' + n, label: '', consigne: '' }); jChanged(true); } }));
}

function answersOf(qid) { return (J.compiled && J.compiled.reponses[qid]) || null; }
function refreshRuleSelects() { if (J.compiled && document.querySelector('.rule-pending')) renderJevEditor(); }

function jReglesCard() {
  const f = J.fiche;
  const resOpts = f.resultats.map(r => [r.id, r.label || r.id]);
  const rules = h('div');
  f.regles.forEach((r, i) => {
    const conds = h('div');
    r.si.forEach((c, j) => {
      const q = f.questions.find(x => x.id === c.question);
      const meta = answersOf(c.question);
      const ops = meta ? meta.ops : ['est', 'n_est_pas'];
      const vals = meta ? meta.valeurs : null;
      const label = v => { if (q && q.type === 'score' && !q.tranches && /^\d+$/.test(v)) return `${v} : ${(q.niveaux || [])[Number(v)]}`; return v; };
      put(conds, h('div', { class: 'cond' + (meta ? '' : ' rule-pending') },
        selectEl(f.questions.map(x => [x.id, x.id]), c.question, v => { c.question = v; c.valeur = ''; touch('regles'); jChanged(true); }),
        selectEl(ops.map(o => [o, OP_LABEL[o]]), c.op, v => { c.op = v; touch('regles'); }),
        vals && vals.length ? selectEl(['', ...vals].map(v => [v, v ? label(v) : 'choisir…']), c.valeur, v => { c.valeur = v; touch('regles'); })
          : inputEl(c.valeur, v => { c.valeur = v; touch('regles'); }, { placeholder: 'valeur (incertain, hesitation, aucun…)' }),
        h('button', { class: 'ghost danger', text: '×', disabled: r.si.length === 1, onclick: () => { r.si.splice(j, 1); touch('regles'); jChanged(true); } })));
    });
    put(rules, h('div', { class: 'rule' },
      h('div', { class: 'row' }, h('span', { class: 'num', text: i + 1 }), h('b', { text: 'Si' }), h('span', { class: 'spacer' }),
        h('button', { class: 'ghost', text: '↑', disabled: i === 0, onclick: () => { [f.regles[i - 1], f.regles[i]] = [f.regles[i], f.regles[i - 1]]; touch('regles'); jChanged(true); } }),
        h('button', { class: 'ghost', text: '+ Et', onclick: () => { r.si.push({ question: f.questions[0].id, op: 'est', valeur: '' }); touch('regles'); jChanged(true); } }),
        h('button', { class: 'ghost danger', text: '×', onclick: () => { f.regles.splice(i, 1); touch('regles'); jChanged(true); } })),
      conds,
      h('div', { class: 'row', style: 'margin-top:6px' }, h('b', { text: 'alors' }), selectEl(resOpts, r.alors, v => { r.alors = v; touch('regles'); }, { style: 'max-width:260px' }),
        inputEl(r.pourquoi, v => { r.pourquoi = v; touch('regles'); }, { placeholder: 'raison affichée (facultative)', style: 'flex:1' })),
      whyBox(`regles.${i}`)));
  });
  return h('div', { class: 'card stack' },
    h('div', { class: 'section-title' }, h('h2', { text: '4. Règles, lues dans l\'ordre' }), originBadge('regles')), whyBox('regles'),
    rules,
    h('button', { class: 'small', text: '+ Règle', onclick: () => { f.regles.push({ si: [{ question: (f.questions[0] || {}).id, op: 'est', valeur: '' }], alors: (f.resultats[0] || {}).id }); touch('regles'); jChanged(true); } }),
    h('div', { class: 'row' },
      field('Sinon (aucune règle)', selectEl(resOpts, f.par_defaut, v => { f.par_defaut = v; touch('par_defaut'); }), 'grow'),
      field('Si Jev ne répond pas', selectEl([['', 'à revoir (automatique)'], ...resOpts], f.si_jev_indisponible, v => { f.si_jev_indisponible = v; touch('par_defaut'); }), 'grow')));
}

function jTestsCard() {
  const f = J.fiche;
  f.tests = f.tests || [];
  const list = h('div', { class: 'stack' });
  f.tests.forEach((t, i) => {
    const res = J.bench && J.bench.rows[i];
    const txt = typeof t.entree === 'string' ? t.entree : JSON.stringify(t.entree);
    put(list, h('div', { class: 'rule' },
      h('div', { class: 'row' }, h('span', { class: 'num', text: i + 1 }),
        res ? h('span', { class: 'badge ' + (res.ok ? 'ok' : 'err'), text: res.ok ? 'Conforme' : (res.error ? 'Erreur' : `Obtenu : ${res.route}`) }) : null,
        t.source === 'ia' ? h('span', { class: 'badge accent', title: 'Cas inventé par l\'IA : relisez son résultat attendu', text: 'inventé par l\'IA' }) : null,
        h('span', { class: 'spacer' }),
        h('button', { class: 'ghost small', text: 'Essayer', onclick: () => { J.essaiInput = txt; runEssai('jev'); } }),
        h('button', { class: 'ghost danger', text: '×', onclick: () => { f.tests.splice(i, 1); touch('tests'); jChanged(true); } })),
      textArea(txt, v => { let val = v; try { if (v.trim().startsWith('{')) val = JSON.parse(v); } catch { /* texte */ } t.entree = val; touch('tests'); }, { rows: 2 }),
      h('div', { class: 'row' },
        field('Résultat attendu', selectEl([['', '(non précisé)'], ...f.resultats.map(r => [r.id, r.label || r.id])], t.attendu, v => { t.attendu = v; touch('tests'); }), 'w240'),
        t.note ? h('span', { class: 'small faint', text: t.note }) : null),
      res && res.details ? h('div', { class: 'small muted', text: res.details }) : null));
  });
  const status = h('span', { class: 'small muted' });
  return h('div', { class: 'card stack' },
    h('div', { class: 'section-title' }, h('h2', { text: `5. Banc d'essai (${f.tests.length} cas)` }), originBadge('tests')), whyBox('tests'),
    h('p', { class: 'small muted', text: 'Des cas avec le résultat attendu. Lancez-les tous sur Jev : le calibrage propose ensuite des seuils qui les respectent.' }),
    list,
    h('div', { class: 'row' },
      h('button', { class: 'small', text: '+ Cas', onclick: () => { f.tests.push({ entree: '', attendu: '' }); touch('tests'); jChanged(true); } }),
      h('button', { class: 'primary small', text: 'Tout tester avec Jev', disabled: !jevKeyReady(f.jev_fournisseur) || !f.tests.length, onclick: () => runBench(status) }),
      status,
      J.bench ? h('b', { text: `${J.bench.ok} / ${J.bench.rows.length} conformes` }) : null),
    h('div', { class: 'notice info small' }, '🎛 La ', h('b', { text: 'salle de réglage' }), ' (vue graphique) calcule sur ces cas des manettes toutes prêtes : dépenser le moins, ne rien laisser passer, le moins de travail humain. ',
      h('button', { class: 'small', text: 'Ouvrir la salle de réglage', onclick: () => { J.view = 'graph'; J.scene = J.scene || { st: {} }; J.scene.st.panel = 'reglage'; renderJevLab($('#main')); } })));
}

// Exécution : le code exact des nœuds générés, dans le navigateur --------------------------------------

function jevInputOf(entree) {
  const e = J.compiled.fiche.entree;
  if (typeof entree === 'string') {
    const t = entree.trim();
    if (t.startsWith('{')) { try { return JSON.parse(t); } catch { /* texte */ } }
    return { [e.mode === 'field' ? e.field : (e.fields[0] || 'message')]: entree };
  }
  return entree;
}

function runPrep(input) {
  const wf = J.compiled.workflow;
  const code = name => (wf.nodes.find(n => n.name === name) || {}).parameters.jsCode;
  const refs = {};
  const prep = runCode(code(NODE_PREP), [{ json: { body: input } }], refs, {});
  refs[NODE_PREP] = prep;
  return { refs, prep, decideCode: code(NODE_DECIDE) };
}

async function jevDecide(input, manualAnswers) {
  const ctx = runPrep(input);
  const p = ctx.prep[0].json;
  let res;
  if (manualAnswers) res = { model: 'réponses manuelles', answers: manualAnswers };
  else if (Object.keys(p.questions).length) res = await api('POST', '/api/jev/ask', { state: p.state, questions: p.questions, model: J.compiled.spec.model, provider: J.compiled.spec.jev_provider });
  else res = { model: 'aucune question', answers: {} };
  const dec = runCode(ctx.decideCode, [{ json: res }], ctx.refs, {})[0].json;
  return { prep: p, jev: res, decision: dec };
}

async function runEssai(mode) {
  if (!J.compiled) return toast('Complétez la fiche d\'abord.', true);
  const raw = J.essaiInput ?? JSON.stringify(J.fiche.exemple);
  const input = jevInputOf(raw);
  try {
    if (mode === 'manual') {
      const ctx = runPrep(input);
      J.essai = { manual: defaultAnswers(ctx.prep[0].json.questions), input };
    } else {
      const t0 = performance.now();
      J.essai = { ...(await jevDecide(input)), ms: Math.round(performance.now() - t0), input };
    }
  } catch (e) { J.essai = { error: e.message }; }
  renderJevSide();
}

async function runBench(status) {
  const f = J.fiche;
  const rows = [];
  let ok = 0;
  for (let i = 0; i < f.tests.length; i++) {
    status.textContent = `Cas ${i + 1} / ${f.tests.length}…`;
    const t = f.tests[i];
    try {
      const r = await jevDecide(jevInputOf(t.entree));
      const good = !t.attendu || r.decision.route === t.attendu;
      if (good) ok++;
      const verdicts = Object.entries(r.decision.vars).filter(([k]) => k.endsWith('_verdict')).map(([k, v]) => `${k.replace('_verdict', '')} = ${Array.isArray(v) ? v.join(', ') || '(aucune)' : v}`).join(' · ');
      rows.push({ ok: good, route: r.decision.route, details: verdicts, answers: r.jev.answers, test: t });
    } catch (e) { rows.push({ ok: false, error: e.message, details: e.message, test: t }); }
  }
  J.bench = { rows, ok, sig: benchSig() };
  J.calib = calibrate(rows);
  J.lab = null; J.leviers = null;
  status.textContent = '';
  renderJevEditor(); renderJevSide(); jGraph();
}

// Calibrage : des seuils qui respectent les cas de test ---------------------------------------------------

function calibrate(rows) {
  const out = [];
  for (const q of J.fiche.questions) {
    if (q.type === 'noul') {
      const yes = [], no = [];
      rows.forEach(r => { const a = r.answers && r.answers[q.id]; const exp = r.test.attendus && r.test.attendus[q.id]; if (!a) return; if (exp === 'oui') yes.push(a.noul); if (exp === 'non') no.push(a.noul); });
      if (!yes.length && !no.length) continue;
      const hi = yes.length ? Math.min(...yes) : null, lo = no.length ? Math.max(...no) : null;
      let oui = q.seuil_oui, non = q.seuil_non, note;
      if (hi !== null && lo !== null && lo >= hi) {
        non = Math.max(1, Math.floor(hi * 100) - 1); oui = Math.min(99, Math.ceil(lo * 100) + 1);
        note = `Chevauchement : un cas NON à ${Math.round(lo * 100)} % dépasse un cas OUI à ${Math.round(hi * 100)} %. Les cas ambigus iront en « à vérifier » ; reformulez la question pour mieux séparer.`;
      } else {
        if (hi !== null) oui = Math.max(Math.min(99, Math.floor(hi * 100) - 2), (lo !== null ? Math.ceil(lo * 100) + 1 : 1));
        if (lo !== null) non = Math.min(Math.max(1, Math.ceil(lo * 100) + 2), oui - 1);
        note = `Cas OUI dès ${hi !== null ? Math.round(hi * 100) + ' %' : '?'}, cas NON jusqu'à ${lo !== null ? Math.round(lo * 100) + ' %' : '?'}.`;
      }
      if (oui !== q.seuil_oui || non !== q.seuil_non) out.push({ q: q.id, path: `questions.${q.id}.seuils`, texte: `${q.id} : NON jusqu'à ${q.seuil_non} % → ${non} %, OUI dès ${q.seuil_oui} % → ${oui} %`, note, apply: () => { q.seuil_oui = oui; q.seuil_non = non; } });
      else out.push({ q: q.id, texte: `${q.id} : seuils déjà cohérents avec les cas.`, note });
    }
    if (q.type === 'choice') {
      const good = [], bad = [];
      rows.forEach(r => { const a = r.answers && r.answers[q.id]; const exp = r.test.attendus && r.test.attendus[q.id]; if (!a || !exp || exp === 'incertain') return; (a.choice === exp ? good : bad).push(a.confidence); });
      if (!good.length) continue;
      const min = Math.max(0, Math.floor(Math.min(...good) * 100) - 3);
      const risky = bad.filter(c => c * 100 >= min).length;
      const note = risky ? `${risky} erreur(s) de Jev passeraient au-dessus de ce seuil : ajoutez des descriptions aux mots attendus.` : 'Les erreurs de Jev resteraient sous le seuil : elles iraient en « incertain ».';
      if (min !== q.confiance_min) out.push({ q: q.id, path: `questions.${q.id}.seuils`, texte: `${q.id} : confiance minimale ${q.confiance_min} % → ${min} %`, note, apply: () => { q.confiance_min = min; } });
    }
  }
  return out;
}

// Colonne de droite : essai, calibrage, économie, export ------------------------------------------------

function renderJevSide() {
  const side = $('#jside');
  if (!side) return;
  clear(side);
  if (J.errors) put(side, h('div', { class: 'card' }, h('div', { class: 'notice warn' }, h('b', { text: 'À compléter' }), h('ul', {}, J.errors.map(e => h('li', { text: e }))))));
  put(side, essaiCard());
  if (J.calib && J.calib.length) put(side, calibCard());
  if (J.compiled) put(side, ecoCard(() => ({ fiche: J.fiche })));
  if (J.compiled && J.compiled.warnings.length) put(side, h('div', { class: 'card' }, h('div', { class: 'notice warn' }, h('ul', {}, J.compiled.warnings.map(w => h('li', { text: w }))))));
}

function essaiCard() {
  const jevReady = jevKeyReady(J.fiche.jev_fournisseur);
  const input = textArea(J.essaiInput ?? JSON.stringify(J.fiche.exemple, null, 2), v => { J.essaiInput = v; }, { rows: 4, class: 'code' });
  const card = h('div', { class: 'card stack' }, h('h2', { text: 'Essai direct' }),
    h('p', { class: 'small muted', text: 'Un texte, ou un objet JSON. Le test exécute le code exact de l\'automate.' }), input,
    h('div', { class: 'row' },
      h('button', { class: 'primary', disabled: !jevReady || !J.compiled, text: 'Tester avec Jev', onclick: () => runEssai('jev') }),
      h('button', { disabled: !J.compiled, text: 'Simuler les réponses', onclick: () => runEssai('manual') }),
      !jevReady ? h('a', { class: 'small', href: '#modeles', text: 'Ajouter une clé TypeSafe ou OpenRouter' }) : null));
  const e = J.essai;
  if (!e) return card;
  if (e.error) return put(card, h('div', { class: 'notice err', text: e.error }), h('p', { class: 'small', text: `En production, ce cas irait vers « ${J.fiche.si_jev_indisponible || 'a_revoir'} ».` }));
  if (e.manual) return put(card, manualEditor(e));
  const d = e.decision;
  const res = J.fiche.resultats.find(r => r.id === d.route);
  put(card, h('div', { class: 'notice ok' }, h('div', {}, 'Résultat : ', h('b', { text: res ? res.label || res.id : d.route })), h('div', { class: 'small', text: d.reason }),
    res && res.consigne ? h('div', { class: 'small', text: 'Consigne de l\'agent : ' + res.consigne }) : null));
  put(card, verdictView(e));
  if (e.jev && e.jev.usage) put(card, h('p', { class: 'small muted', text: `${e.jev.model} · ${e.jev.usage.input_tokens} tokens · ${(e.jev.usage.input_tokens * JEV_PRICE_PER_TOKEN).toFixed(6).replace('.', ',')} $ · ${e.ms} ms` }));
  return card;
}

function verdictView(e) {
  const box = h('div', { class: 'stack' });
  const answers = e.jev.answers || {};
  const vars = e.decision.vars;
  for (const q of J.fiche.questions) {
    const v = vars[q.id + '_verdict'];
    const shown = Array.isArray(v) ? (v.join(', ') || '(aucune)') : v;
    const block = h('div', { class: 'qcard' }, h('div', { class: 'row between' }, h('b', { class: 'mono', text: q.id }), h('span', { class: 'badge accent', text: shown ?? '(pas de réponse)' })));
    const a = answers[q.id];
    if (q.type === 'noul' && a) put(block, bandBar(q.seuil_non, q.seuil_oui, a.noul), h('div', { class: 'small faint', text: `Probabilité du oui : ${Math.round(a.noul * 100)} %` }));
    if ((q.type === 'choice' || q.type === 'liste') && vars[q.id + '_classement']) {
      put(block, h('table', {}, h('tbody', {}, vars[q.id + '_classement'].slice(0, 6).map(c => h('tr', {},
        h('td', { class: 'small', text: String(c.valeur).slice(0, 80) }),
        h('td', { style: 'width:45%' }, h('div', { class: 'bar' }, h('span', { style: `width:${Math.round(c.probabilite * 100)}%` }))),
        h('td', { class: 'small faint', text: Math.round(c.probabilite * 100) + ' %' }))))),
      a ? h('div', { class: 'small faint', text: `Confiance ${Math.round(a.confidence * 100)} % (minimum ${q.confiance_min} %)` }) : null);
    }
    if (q.type === 'score' && a) {
      const n = (q.niveaux || []).length - 1;
      put(block, h('div', { class: 'scale' }, h('i', { class: 'marker', style: `left:${Math.round(a.score / Math.max(1, n) * 100)}%` }),
        (q.tranches || []).map(t => h('span', { class: 'cut', style: `left:${Math.round(t.jusqu_a / Math.max(1, n) * 100)}%`, title: t.mot }))),
        h('div', { class: 'small faint', text: `Score ${fmtNum(a.score, 2)} sur ${n} (${q.niveaux[Math.round(a.score)]}) · confiance ${Math.round(a.confidence * 100)} %` }));
    }
    if (q.type === 'etiquettes') {
      put(block, h('table', {}, h('tbody', {}, q.options.map(o => { const x = answers[`${q.id}__${o.mot}`]; return h('tr', {}, h('td', { class: 'small', text: o.mot }), h('td', { style: 'width:55%' }, x ? bandBar(q.seuil, q.seuil, x.noul) : null), h('td', { class: 'small faint', text: x ? Math.round(x.noul * 100) + ' %' : '' })); }))));
    }
    if (q.type === 'pour_chaque') {
      const items = Object.keys(answers).filter(k => k.startsWith(q.id + '__'));
      put(block, h('div', { class: 'small faint', text: `${(vars[q.id + '_retenus'] || []).length} élément(s) gardé(s) sur ${items.length}` }));
    }
    put(box, block);
  }
  return box;
}

function manualEditor(e) {
  const answers = e.manual;
  const rows = Object.entries(answers).map(([id, a]) => {
    let ctl;
    if (a.type === 'noul') { const out = h('span', { class: 'small mono', text: Math.round(a.noul * 100) + ' %' }); ctl = h('div', { class: 'row' }, h('input', { type: 'range', min: 0, max: 1, step: 0.01, value: a.noul, style: 'flex:1', oninput: ev => { a.noul = Number(ev.target.value); out.textContent = Math.round(a.noul * 100) + ' %'; } }), out); }
    else if (a.type === 'choice') ctl = h('div', { class: 'row' }, selectEl(Object.entries(runPrep(e.input).prep[0].json.questions[id].criteria).map(([k, d]) => [k, /^c\d+$/.test(k) && typeof d === 'string' ? d.slice(0, 70) : k]), a.choice, v => { a.choice = v; }, { style: 'flex:1' }),
      inputEl(a.confidence, v => { a.confidence = Number(v); }, { type: 'number', step: 0.05, min: 0, max: 1, style: 'width:80px', title: 'confiance' }));
    else ctl = inputEl(a.score, v => { a.score = Number(v); }, { type: 'number', step: 0.1, min: 0, style: 'width:90px' });
    return h('tr', {}, h('td', { class: 'mono small', text: id }), h('td', {}, ctl));
  });
  return h('div', { class: 'stack' }, h('p', { class: 'small muted', text: 'Réglez ce que Jev pourrait répondre, et voyez comment vos seuils et vos règles tranchent.' }),
    h('table', {}, h('tbody', {}, rows)),
    h('button', { class: 'primary', text: 'Décider', onclick: async () => {
      const probs = {};
      for (const [id, a] of Object.entries(answers)) if (a.type === 'choice') { a.probabilities = { [a.choice]: a.confidence }; probs[id] = true; }
      try { J.essai = { ...(await jevDecide(e.input, clone(answers))), input: e.input, ms: 0 }; } catch (err) { J.essai = { error: err.message }; }
      renderJevSide();
    } }));
}

function calibCard() {
  return h('div', { class: 'card stack' }, h('h2', { text: 'Calibrage proposé' }),
    h('p', { class: 'small muted', text: 'D\'après les verdicts attendus de vos cas de test. Appliquer une proposition la marque « Calibré sur les tests ».' }),
    J.calib.map(c => h('div', { class: 'qcard stack' }, h('div', { text: c.texte }), c.note ? h('div', { class: 'small muted', text: c.note }) : null,
      c.apply ? h('button', { class: 'small', text: 'Appliquer', onclick: () => {
        c.apply(); J.fiche.ia = J.fiche.ia || {}; J.fiche.ia[c.path] = { origine: 'calibrage', pourquoi: c.texte + '. ' + (c.note || '') };
        J.calib = J.calib.filter(x => x !== c); jChanged(true);
      } }) : null)));
}

// Salle de réglage : des manettes calculées sur les wagons d'essai déjà passés chez Jev ---------------------
// Jev répond une fois par cas ; chaque réglage se rejoue ensuite sur ces réponses, avec le code exact de
// l'aiguillage généré, sans nouvel appel. Rien ne s'applique sans l'accord de la personne.

const VOIE_KIND = { auto: 'auto', humain: 'review', blocage: 'block' };
const KIND_VOIE = { auto: 'auto', review: 'humain', block: 'blocage' };
const PCT = Array.from({ length: 19 }, (_, i) => 5 + i * 5);

function reglageOf() {
  const f = J.fiche;
  f.reglage = f.reglage || {};
  if (typeof f.reglage.cout_erreur !== 'number') f.reglage.cout_erreur = 50;
  if (typeof f.reglage.cout_revue !== 'number') f.reglage.cout_revue = 2;
  f.reglage.voies = f.reglage.voies || {};
  return f.reglage;
}
function voieKind(r) {
  const v = ((J.fiche && J.fiche.reglage) || {}).voies || {};
  return VOIE_KIND[v[r]] || routeKind(r);
}
function benchSig() { return J.compiled ? JSON.stringify([J.compiled.spec.questions, J.compiled.spec.prepare_js, J.compiled.spec.state]) : ''; }
function snippet(e) { const t = typeof e === 'string' ? e : JSON.stringify(e); return t.length > 90 ? t.slice(0, 89) + '…' : t; }

// Une manette par question : les seuils que l'outil a le droit de bouger.
function knobsOf() {
  const out = [];
  for (const q of J.fiche.questions) {
    if (q.type === 'noul') {
      const vals = [...new Set([...PCT, q.seuil_non, q.seuil_oui])].sort((a, b) => a - b);
      const cand = [];
      for (const a of vals) for (const b of vals) if (a <= b) cand.push([a, b]);
      out.push({ q, cand, get: () => [q.seuil_non, q.seuil_oui], set: v => { q.seuil_non = v[0]; q.seuil_oui = v[1]; },
        patch: (vd, v) => { vd.non = v[0] / 100; vd.oui = v[1] / 100; }, texte: v => `${q.id} : NON jusqu'à ${v[0]} %, OUI dès ${v[1]} %` });
    } else {
      const key = ['etiquettes', 'pour_chaque'].includes(q.type) ? 'seuil' : 'confiance_min';
      const cand = [...new Set([0, ...PCT, q[key]])].sort((a, b) => a - b);
      out.push({ q, cand, get: () => q[key], set: v => { q[key] = v; },
        patch: (vd, v) => { vd[key === 'seuil' ? 'seuil' : 'min'] = v / 100; },
        texte: v => `${q.id} : ${key === 'seuil' ? 'seuil' : 'confiance minimale'} ${v} %` });
    }
  }
  return out;
}

// Le banc rejouable : le code de l'aiguillage, dont seuls les seuils changent d'un essai à l'autre.
function reglageLab() {
  if (!J.bench || !J.compiled || J.errors) return null;
  const node = J.compiled.workflow.nodes.find(n => n.name === NODE_DECIDE);
  const code = node && node.parameters.jsCode;
  const m = code && code.match(/const CFG = ([\s\S]*?);\n(?=\s*function flatten)/);
  if (!m) return null;
  const cfg = JSON.parse(m[1]);
  const head = code.slice(0, m.index), tail = code.slice(m.index + m[0].length);
  const key = JSON.stringify([benchSig(), head, { ...cfg, verdicts: null }, tail, reglageOf().voies, J.fiche.questions.map(q => [q.id, q.type])]);
  if (J.lab && J.lab.key === key && J.lab.bench === J.bench) { J.lab.knobs = knobsOf(); return J.lab; }
  const knobs = knobsOf();
  const data = [];
  J.bench.rows.forEach(r => {
    if (!r.answers || r.error) return;
    try { const input = jevInputOf(r.test.entree); data.push({ input, test: r.test, prepItems: runPrep(input).prep, res: { model: 'banc d\'essai (réponses déjà reçues)', answers: r.answers } }); } catch { /* cas illisible */ }
  });
  const memo = new Map();
  const run = vals => {
    const k = JSON.stringify(vals);
    if (memo.has(k)) return memo.get(k);
    const c = clone(cfg);
    lab.knobs.forEach((kn, i) => { const vd = c.verdicts[kn.q.id]; if (vd) kn.patch(vd, vals[i]); });
    const fn = new Function('$input', '$', '$getWorkflowStaticData', head + 'const CFG = ' + JSON.stringify(c) + ';\n' + tail);
    const out = { routes: [], counts: {}, errors: 0, humains: 0, ok: 0, labeled: 0, n: data.length };
    for (const d of data) {
      let route;
      try { route = fn({ all: () => [{ json: d.res }] }, () => ({ all: () => d.prepItems }), () => ({}))[0].json.route; } catch { route = '?'; }
      out.routes.push(route);
      const cnt = out.counts[route] = out.counts[route] || { n: 0, err: 0 };
      cnt.n++;
      const exp = d.test.attendu;
      if (exp) { out.labeled++; if (route === exp) out.ok++; }
      if (voieKind(route) === 'review') out.humains++;
      else if (exp && route !== exp) { out.errors++; cnt.err++; }
    }
    memo.set(k, out);
    return out;
  };
  const lab = { key, bench: J.bench, knobs, data, run, labeled: data.filter(d => d.test.attendu).length };
  J.lab = lab; J.leviers = null;
  return lab;
}

// Prix d'une rédaction par LLM sur une voie : 1 500 tokens lus, 400 écrits, au tarif du modèle s'il est connu.
function llmUnitCosts(llms) {
  const out = {};
  for (const l of llms || []) {
    const m = (S.models[l.provider] || []).find(x => x.id === l.model);
    out[l.route] = m && m.input !== null && m.input !== undefined ? (1500 * m.input + 400 * (m.output || 0)) / 1e6 : 0.002;
  }
  return out;
}
function costOf(m, W, unit) {
  let llm = 0;
  for (const [r, c] of Object.entries(m.counts)) llm += (unit[r] || 0) * c.n;
  return m.errors * W.erreur + m.humains * W.revue + llm;
}

// Descente manette par manette : pour chacune, la meilleure valeur, les autres fixées. Entre valeurs
// équivalentes, celle du milieu : un seuil collé au dernier cas vu casse au premier cas nouveau.
function optimize(lab, W, unit, start) {
  const vals = start.map(v => clone(v));
  for (let pass = 0; pass < 3; pass++) {
    let moved = false;
    lab.knobs.forEach((kn, i) => {
      let best = Infinity, opt = [];
      for (const c of kn.cand) {
        const v = vals.slice(); v[i] = c;
        const s = costOf(lab.run(v), W, unit);
        if (s < best - 1e-9) { best = s; opt = [c]; } else if (s <= best + 1e-9) opt.push(c);
      }
      if (opt.length === kn.cand.length) return; // cette manette ne change rien sur ces cas : on n'y touche pas
      const pick = opt[Math.floor((opt.length - 1) / 2)];
      if (JSON.stringify(pick) !== JSON.stringify(vals[i])) { vals[i] = clone(pick); moved = true; }
    });
    if (!moved) break;
  }
  return vals;
}

function computeLevers(lab) {
  const rg = reglageOf();
  const baseVals = J.preview ? J.preview.backup.vals : lab.knobs.map(k => k.get());
  const llms = J.preview ? J.preview.backup.llms : (J.fiche.llms || []);
  const unit = llmUnitCosts(llms);
  const W = { erreur: rg.cout_erreur, revue: rg.cout_revue };
  const key = JSON.stringify([lab.key, baseVals, W, llms, Object.keys(unit).map(r => unit[r])]);
  if (J.leviers && J.leviers.key === key) return J.leviers;
  const mk = (id, icon, nom, texte, vals, extra = {}) => ({ id, icon, nom, texte, vals, m: lab.run(vals), ...extra });
  const eco = optimize(lab, W, unit, baseVals);
  const list = [
    mk('actuel', '📍', 'Réglage actuel', 'Vos seuils tels qu\'ils sont, pour comparer.', baseVals),
    mk('econome', '💶', 'Dépenser le moins', 'Le réglage qui coûte le moins au total avec vos prix, erreurs et temps humain compris.', eco),
    mk('prudent', '🛡', 'Ne rien laisser passer', 'Une erreur compte cent fois plus que son prix : davantage de wagons passent par un humain, le moins d\'erreurs possible.',
      optimize(lab, { erreur: W.erreur * 100, revue: W.revue }, unit, baseVals)),
    mk('autonome', '⚡', 'Le moins de travail humain', 'Un passage humain compte autant qu\'une erreur : l\'automate décide seul le plus souvent possible, au prix de quelques erreurs.',
      optimize(lab, { erreur: W.erreur, revue: Math.max(W.revue, W.erreur) }, unit, baseVals)),
  ];
  if (llms.length) list.push(mk('rapide', '🚄', 'Ultra rapide, sans LLM de rédaction',
    'Les seuils de « Dépenser le moins », sans LLM sur les voies : la réponse part en une fraction de seconde au lieu de plusieurs secondes, et l\'agent rédige lui-même.'
    + (J.fiche.llm_entree ? ' Le LLM d\'entrée reste : le retirer changerait ce que lit Jev, il faudrait refaire passer les wagons.' : ''), eco, { dropLlm: true }));
  list.forEach((l, i) => {
    l.cout = costOf(l.m, W, l.dropLlm ? {} : unit);
    const twin = list.slice(0, i).find(o => JSON.stringify(o.vals) === JSON.stringify(l.vals) && !!o.dropLlm === !!l.dropLlm);
    if (twin) l.same = twin.nom;
  });
  J.leviers = { key, list, base: lab.run(baseVals), baseVals, unit, W };
  return J.leviers;
}

function previewLever(lab, l) {
  const f = J.fiche;
  if (!J.preview) J.preview = { backup: { vals: lab.knobs.map(k => clone(k.get())), llms: clone(f.llms || []) } };
  Object.assign(J.preview, { id: l.id, nom: l.nom, vals: clone(l.vals), dropLlm: !!l.dropLlm });
  lab.knobs.forEach((k, i) => k.set(clone(l.vals[i])));
  f.llms = l.dropLlm ? [] : clone(J.preview.backup.llms);
  J.scene = J.scene || { st: {} };
  J.scene.st.panel = 'reglage';
  jChanged(true);
}
function revertPreview(lab) {
  if (!J.preview) return;
  const b = J.preview.backup;
  lab.knobs.forEach((k, i) => k.set(clone(b.vals[i])));
  J.fiche.llms = clone(b.llms);
  J.preview = null;
  jChanged(true);
}
function keepPreview(lab) {
  const p = J.preview, b = p.backup;
  const before = lab.run(b.vals), after = lab.run(p.vals);
  const why = `Levier « ${p.nom} » choisi dans la salle de réglage, sur ${after.n} wagons d'essai : erreurs ${before.errors} puis ${after.errors}, passages humains ${before.humains} puis ${after.humains}.`;
  J.fiche.ia = J.fiche.ia || {};
  lab.knobs.forEach((k, i) => {
    if (JSON.stringify(b.vals[i]) !== JSON.stringify(p.vals[i])) J.fiche.ia[`questions.${k.q.id}.seuils`] = { origine: 'humain', pourquoi: `${why} ${k.texte(p.vals[i])}.` };
  });
  J.preview = null; J.leviers = null;
  jChanged(true);
  toast('Réglage gardé. Enregistrez la fiche pour le conserver.');
}

async function addIaCases(status) {
  const st = jAssist();
  if (!st.provider) return toast('Configurez un fournisseur de discussion dans Modèles LLM.', true);
  const f = J.fiche;
  const before = new Set((f.tests || []).map(t => JSON.stringify(t.entree)));
  status.textContent = 'L\'IA invente des cas, dont des cas limites…';
  try {
    const r = await api('POST', '/api/jevlab/field', { provider: st.provider, model: st.model, fiche: f, path: 'tests',
      consigne: 'Propose uniquement 20 cas nouveaux, différents des cas existants (ceux-ci seront gardés). Quelques cas nets, et surtout des cas limites, difficiles à trancher, écrits comme de vrais messages. Chaque cas indique son résultat attendu.' });
    const add = (r.fiche.tests || []).filter(t => !before.has(JSON.stringify(t.entree))).map(t => ({ ...t, source: 'ia' }));
    f.tests = [...(f.tests || []), ...add].slice(0, 100);
    J.bench = null; J.lab = null; J.leviers = null;
    status.textContent = '';
    toast(`${add.length} cas inventés par l'IA ajoutés au banc. Relisez leur résultat attendu, puis faites passer les wagons.`);
    jChanged(true);
  } catch (e) { status.textContent = ''; toast(e.message + (e.errors ? ' : ' + e.errors.join(' ; ') : ''), true); }
}

function chip(icon, text, cls = '') { return h('span', { class: 'chip ' + cls }, h('b', { text: icon }), ' ', text); }

function leverCard(lab, L, l) {
  const on = J.preview ? J.preview.id === l.id : l.id === 'actuel';
  const m = l.m;
  const moved = l.id === 'actuel' ? 0 : m.routes.filter((r, i) => r !== L.base.routes[i]).length;
  return h('div', { class: 'lever' + (on ? ' on' : '') },
    h('div', { class: 'row between' }, h('b', { text: l.icon + ' ' + l.nom }), on ? h('span', { class: 'badge accent', text: 'sur la voie' }) : null),
    h('div', { class: 'small muted', text: l.texte }),
    h('div', { class: 'chips' },
      chip('✓', `${m.ok} / ${m.labeled} conformes`), chip('✗', `${m.errors} erreur(s)`, m.errors ? 'bad' : 'good'),
      chip('👤', `${m.humains} passage(s) humain(s)`), chip('€', `≈ ${Math.round(l.cout / Math.max(1, m.n) * 1000).toLocaleString('fr-FR')} € pour 1 000 wagons`)),
    l.same ? h('div', { class: 'small faint', text: `Même réglage que « ${l.same} ».` })
      : (l.id !== 'actuel' ? h('div', { class: 'small faint', text: moved ? `${moved} wagon(s) changent de voie par rapport au réglage actuel.` : 'Aucun wagon ne change de voie.' }) : null),
    on ? null : h('button', { class: 'small' + (l.id === 'actuel' ? '' : ' primary'), text: l.id === 'actuel' ? '↩ Revenir au réglage actuel' : 'Essayer sur la voie',
      onclick: () => (l.id === 'actuel' ? revertPreview(lab) : previewLever(lab, l)) }));
}

function previewBox(lab, L) {
  const p = J.preview;
  const after = lab.run(p.vals), before = L.base;
  const changed = after.routes.map((r, i) => ({ r, b: before.routes[i], d: lab.data[i] })).filter(x => x.r !== x.b);
  return h('div', { class: 'notice info stack' },
    h('div', {}, 'Aperçu : ', h('b', { text: p.nom }), `. Les compteurs sur les voies montrent où iraient les ${after.n} wagons.`),
    changed.length ? h('div', { class: 'stack' }, h('b', { class: 'small', text: `${changed.length} wagon(s) changent de voie :` }),
      changed.slice(0, 5).map(x => {
        const exp = x.d.test.attendu;
        return h('div', { class: 'moved' },
          h('div', { class: 'small', text: '« ' + snippet(x.d.test.entree) + ' »' }),
          h('div', { class: 'small' }, `avant : ${x.b}, après : `, h('b', { text: x.r }), ' ',
            exp ? h('span', { class: 'badge ' + (x.r === exp ? 'ok' : 'err'), text: x.r === exp ? 'bonne voie' : `attendu : ${exp}` }) : null),
          h('button', { class: 'ghost small', text: '▶ Voir ce wagon rouler', onclick: () => scenePlay(J.scene, x.d.input, x.d.res) }));
      }),
      changed.length > 5 ? h('div', { class: 'small faint', text: `et ${changed.length - 5} autre(s).` }) : null)
      : h('div', { class: 'small', text: 'Aucun wagon ne change de voie avec ce réglage.' }),
    h('div', { class: 'row' },
      h('button', { class: 'primary small', text: '✓ Garder ce réglage', onclick: () => keepPreview(lab) }),
      h('button', { class: 'small', text: '↩ Revenir', onclick: () => revertPreview(lab) })));
}

function equilibreManette(lab, L) {
  const rg = reglageOf();
  const pos = J.equilibre ?? 50;
  const weights = p => ({ erreur: rg.cout_erreur * 10 ** ((p - 50) / 50), revue: rg.cout_revue });
  const out = h('div', { class: 'small muted' });
  const show = p => {
    const m = lab.run(optimize(lab, weights(p), L.unit, L.baseVals));
    out.textContent = `À cette position : ${m.errors} erreur(s), ${m.humains} passage(s) humain(s). Relâchez pour voir les wagons sur la voie.`;
  };
  const live = debounce(show, 120);
  return h('div', { class: 'lever' + (J.preview && J.preview.id === 'equilibre' ? ' on' : '') },
    h('b', { text: '🎚 Mon équilibre' }),
    h('div', { class: 'small muted', text: 'Entre les deux, à vous de placer le curseur : à gauche l\'automate décide davantage seul, à droite il envoie davantage à un humain.' }),
    h('div', { class: 'row' }, h('span', { class: 'small', text: 'Autonomie' }),
      h('input', { type: 'range', min: 0, max: 100, step: 5, value: pos, style: 'flex:1', 'aria-label': 'Équilibre entre autonomie et prudence',
        oninput: e => { J.equilibre = Number(e.target.value); live(J.equilibre); },
        onchange: e => {
          const p = Number(e.target.value);
          previewLever(lab, { id: 'equilibre', nom: `Mon équilibre (${p} sur 100)`, vals: optimize(lab, weights(p), L.unit, L.baseVals) });
        } }),
      h('span', { class: 'small', text: 'Prudence' })),
    out);
}

function salleCard() {
  const f = J.fiche, rg = reglageOf();
  const card = h('div', { class: 'mod-card stack salle' });
  put(card, h('h2', {}, '🎛 Salle de réglage ', info('L\'outil essaie des milliers de réglages sur vos wagons d\'essai et vous propose des manettes. Vous voyez leur effet sur la voie ferrée ; rien ne change sans votre accord.')),
    tuto('salle', 'trouver le bon réglage', [
      ['Faites passer les ', h('b', { text: 'wagons d\'essai' }), ' (les cas du banc d\'essai) : chacun passe une fois chez Jev. Ses réponses sont gardées, les réglages se rejouent ensuite gratuitement.'],
      ['Dites ce que coûte ', h('b', { text: 'une erreur' }), ' et ce que coûte ', h('b', { text: 'un passage par un humain' }), ', en euros. C\'est ainsi que l\'outil comprend ce qui compte pour vous.'],
      ['L\'outil propose des ', h('b', { text: 'manettes' }), '. « Essayer sur la voie » montre où vont les wagons : le compteur au-dessus de chaque voie, ✗ pour les erreurs.'],
      ['Rien ne change sans vous : « Garder ce réglage » l\'adopte, « Revenir » annule.'],
    ]));

  // 1. Les wagons d'essai
  const tests = f.tests || [];
  const labeled = tests.filter(t => t.attendu).length, byIa = tests.filter(t => t.source === 'ia').length;
  const status = h('div', { class: 'small muted' });
  const jevReady = jevKeyReady(f.jev_fournisseur);
  const chatReady = chatProviders().some(p => p.configured);
  const stale = J.bench && J.bench.sig !== benchSig();
  put(card, h('h3', { text: '1. Les wagons d\'essai' }),
    h('p', { class: 'small', text: `${tests.length} cas dans le banc d'essai, dont ${labeled} avec le résultat attendu${byIa ? ` et ${byIa} inventé${byIa > 1 ? 's' : ''} par l'IA` : ''}.` }),
    h('div', { class: 'row' },
      h('button', { class: 'small' + (J.bench && !stale ? '' : ' primary'), disabled: !jevReady || !tests.length || !J.compiled,
        text: `▶ Faire passer les ${tests.length} wagons chez Jev`, onclick: () => runBench(status) }),
      chatReady ? h('button', { class: 'small', text: '✦ 20 cas inventés par l\'IA', title: 'Pour couvrir les cas bizarres. Pour régler finement, rien ne vaut de vrais messages.', onclick: () => addIaCases(status) }) : null),
    !jevReady ? h('a', { class: 'small', href: '#modeles', text: 'Renseignez une clé de Jev (TypeSafe ou OpenRouter)' }) : null,
    status,
    J.bench ? h('p', { class: 'small muted', text: `${J.bench.rows.filter(r => r.answers).length} wagons passés. Chaque réglage se rejoue sur leurs réponses, sans nouvel appel à Jev.` }) : null,
    stale ? h('div', { class: 'notice warn small', text: 'Les questions ont changé depuis le passage des wagons : faites-les repasser.' }) : null,
    J.bench && labeled < 20 ? h('div', { class: 'notice warn small', text: `Avec ${labeled} cas étiquetés, le hasard pèse lourd : un écart d'une ou deux erreurs entre deux manettes ne prouve rien. Visez 30 cas ou plus, de préférence de vrais messages.` }) : null);

  // 2. Le prix des erreurs
  const eur = (val, on) => h('input', { type: 'number', min: 0, step: 'any', value: val, style: 'width:90px',
    onchange: e => { on(Math.max(0, Number(e.target.value) || 0)); J.leviers = null; jGraph(); } });
  put(card, h('h3', { text: '2. Combien coûte une erreur ?' }),
    h('div', { class: 'row' }, h('span', { class: 'small', style: 'flex:1', text: 'Un wagon envoyé seul sur la mauvaise voie' }), eur(rg.cout_erreur, v => { rg.cout_erreur = v; }), h('span', { text: '€' })),
    h('div', { class: 'row' }, h('span', { class: 'small', style: 'flex:1', text: 'Un wagon vérifié par un humain (son temps)' }), eur(rg.cout_revue, v => { rg.cout_revue = v; }), h('span', { text: '€' })),
    h('details', {}, h('summary', { class: 'small', text: 'Nature de chaque voie' }),
      h('p', { class: 'small muted', text: 'Une voie « Humain » n\'est jamais une erreur : un humain vérifie. Une erreur, c\'est un wagon parti seul sur une autre voie que celle attendue.' }),
      h('div', { class: 'stack' }, f.resultats.map(r => h('div', { class: 'row' }, h('span', { class: 'small', style: 'flex:1', text: r.label || r.id }),
        selectEl([['auto', 'Automatique'], ['humain', 'Humain'], ['blocage', 'Blocage']], KIND_VOIE[voieKind(r.id)], v => { rg.voies[r.id] = v; J.leviers = null; jGraph(); }))))));

  // 3. Les manettes
  put(card, h('h3', { text: '3. Les manettes proposées' }));
  const lab = J.bench && !stale ? reglageLab() : null;
  if (!J.bench || stale) return put(card, h('p', { class: 'small muted', text: 'Faites passer les wagons d\'abord : les manettes se calculent sur les réponses de Jev.' }));
  if (!lab || !lab.knobs.length) return put(card, h('p', { class: 'small muted', text: 'Rien à régler : cet automate n\'a pas de seuil.' }));
  if (lab.labeled < 5) return put(card, h('div', { class: 'notice warn small', text: 'Indiquez le résultat attendu d\'au moins 5 cas : sans lui, l\'outil ne peut pas compter les erreurs, et pousserait tout vers l\'automatique.' }));
  const L = computeLevers(lab);
  if (J.preview) put(card, previewBox(lab, L));
  L.list.forEach(l => put(card, leverCard(lab, L, l)));
  put(card, equilibreManette(lab, L),
    h('p', { class: 'small faint', text: 'Les manettes sont calculées sur vos wagons d\'essai, pas sur l\'avenir : gardez une voie humaine tant que les vrais messages n\'ont pas confirmé le réglage.' }),
    h('h3', { text: '4. Vos priorités (QCM)' }), qcmBlock(L),
    h('h3', { text: '5. Synthèse IA' }), syntheseBlock(lab, L));
  return card;
}

// QCM des priorités et synthèse IA ------------------------------------------------------------------------
// Le classement vient des réponses au QCM, par des points relisibles (même calcul que le serveur).
// L'IA ne fait qu'expliquer : les chiffres du rapport viennent du banc d'essai.

function classerQcm(rep, dispo) {
  const def = S.data.qcm_leviers || { questions: [], leviers: {} };
  const ids = Object.keys(def.leviers).filter(i => dispo.includes(i));
  const score = Object.fromEntries(ids.map(i => [i, 0])), raisons = Object.fromEntries(ids.map(i => [i, []]));
  for (const q of def.questions) {
    const c = q.choix.find(x => x.id === (rep || {})[q.id]);
    if (!c) continue;
    for (const [lid, pts] of Object.entries(c.points)) if (lid in score) { score[lid] += pts; raisons[lid].push(`+${pts} : « ${c.texte} »`); }
  }
  return ids.sort((a, b) => score[b] - score[a] || ids.indexOf(a) - ids.indexOf(b)).map(i => ({ id: i, nom: def.leviers[i], points: score[i], raisons: raisons[i] }));
}

function rankList(cl) {
  return h('ol', { class: 'rank' }, cl.map((c, i) => h('li', { class: i === 0 ? 'first' : '' },
    h('b', { text: c.nom }), ` · ${c.points} point${c.points > 1 ? 's' : ''}`,
    c.raisons.length ? h('div', { class: 'small faint', text: c.raisons.join(' ; ') }) : null)));
}

function qcmBlock(L) {
  const def = S.data.qcm_leviers || { questions: [] };
  const rg = reglageOf();
  rg.qcm = rg.qcm || {};
  const dispo = L ? L.list.map(l => l.id).filter(id => id !== 'actuel') : ['econome', 'prudent', 'autonome'];
  const rank = h('div');
  const draw = () => {
    const n = Object.keys(rg.qcm).length;
    put(clear(rank), n ? h('div', { class: 'stack' }, h('b', { class: 'small', text: `Votre ordre de priorité (${n} réponse${n > 1 ? 's' : ''} sur ${def.questions.length}) :` }), rankList(classerQcm(rg.qcm, dispo)))
      : h('p', { class: 'small faint', text: 'Répondez pour voir les manettes classées selon vos priorités.' }));
  };
  draw();
  return h('div', { class: 'stack' },
    h('p', { class: 'small muted', text: 'Cinq questions sur votre situation. Chaque réponse donne des points aux manettes ; le classement se met à jour tout de suite, et la synthèse IA en tient compte.' }),
    def.questions.map(q => h('div', { class: 'qcm-q' }, h('div', { class: 'small', style: 'font-weight:600', text: q.question }),
      q.choix.map(c => h('label', { class: 'check small' },
        h('input', { type: 'radio', name: 'qcm-' + q.id, checked: rg.qcm[q.id] === c.id, onchange: () => { rg.qcm[q.id] = c.id; draw(); } }), c.texte)))),
    rank);
}

// Ce que Jev a répondu, regroupé par voie attendue : la matière du chapitre « Ce que Jev a conclu ».
function jevStats(lab) {
  const MES = { noul: 'probabilité moyenne du oui', choice: 'confiance moyenne', liste: 'confiance moyenne', score: 'score moyen',
    etiquettes: 'nombre moyen d\'étiquettes retenues', pour_chaque: 'nombre moyen d\'éléments gardés' };
  return J.fiche.questions.map(q => {
    const by = {};
    for (const d of lab.data) {
      const ans = d.res.answers || {}, a = ans[q.id];
      const e = by[d.test.attendu || '(non précisé)'] = by[d.test.attendu || '(non précisé)'] || { cas: 0, somme: 0, mots: {} };
      if (q.type === 'noul' && a) { e.cas++; e.somme += a.noul; }
      else if ((q.type === 'choice' || q.type === 'liste') && a) { e.cas++; e.somme += a.confidence; const w = q.type === 'liste' ? 'élément ' + String(a.choice).replace(/^c/, '') : a.choice; e.mots[w] = (e.mots[w] || 0) + 1; }
      else if (q.type === 'score' && a) { e.cas++; e.somme += a.score; }
      else if (q.type === 'etiquettes' || q.type === 'pour_chaque') {
        const subs = Object.entries(ans).filter(([k]) => k.startsWith(q.id + '__'));
        if (subs.length) { e.cas++; e.somme += subs.filter(([, x]) => x.noul >= (q.seuil ?? 60) / 100).length; }
      }
    }
    return { id: q.id, type: q.type, question: q.question, mesure: MES[q.type], ...(q.type === 'score' ? { echelle: (q.niveaux || []).length - 1 } : {}),
      par_voie_attendue: Object.entries(by).filter(([, e]) => e.cas).map(([voie, e]) => ({ voie, cas: e.cas, moyenne: Math.round(e.somme / e.cas * 100) / 100, ...(Object.keys(e.mots).length ? { mots: e.mots } : {}) })) };
  });
}

function syntheseDossier(lab, L) {
  const f = J.fiche, rg = reglageOf();
  const lev = l => ({ id: l.id, nom: l.nom, seuils: lab.knobs.map((k, i) => k.texte(l.vals[i])), conformes: l.m.ok, etiquetes: l.m.labeled,
    erreurs: l.m.errors, passages_humains: l.m.humains, cout_pour_1000_wagons_eur: Math.round(l.cout / Math.max(1, l.m.n) * 1000),
    ...(l.same ? { identique_a: l.same } : {}), ...(l.dropLlm ? { sans_llm_de_route: true } : {}) });
  const tests = f.tests || [];
  return {
    automate: { nom: f.name, objectif: f.objectif, questions: f.questions.map(q => ({ id: q.id, type: q.type, question: q.question })),
      voies: f.resultats.map(r => ({ id: r.id, label: r.label, nature: KIND_VOIE[voieKind(r.id)] })), regles: f.regles.length,
      llm_entree: !!f.llm_entree, llm_de_route: (J.preview ? J.preview.backup.llms : (f.llms || [])).map(l => l.route) },
    banc: { cas: tests.length, avec_resultat_attendu: tests.filter(t => t.attendu).length, inventes_par_ia: tests.filter(t => t.source === 'ia').length, passes_chez_jev: lab.data.length },
    prix: { erreur_eur: rg.cout_erreur, passage_humain_eur: rg.cout_revue },
    jev: jevStats(lab),
    reglage_actuel: lev(L.list.find(l => l.id === 'actuel')),
    leviers: L.list.filter(l => l.id !== 'actuel').map(lev),
    qcm: { ...(rg.qcm || {}) },
  };
}

function syntheseBlock(lab, L) {
  const chat = chatProviders().filter(p => p.configured);
  if (!chat.length) return h('p', { class: 'small' }, 'Synthèse IA : ', h('a', { href: '#modeles', text: 'ajoutez une clé OpenRouter ou branchez Ollama' }), '.');
  const st = jAssist();
  const status = h('div', { class: 'small muted' });
  return h('div', { class: 'stack' },
    h('p', { class: 'small muted', text: 'Un rapport pas à pas : ce qui a été fait, ce que Jev a conclu, les manettes et quand choisir chacune, votre ordre de priorité, une recommandation et un conseil. Les chiffres viennent de l\'outil ; l\'IA les explique.' }),
    h('details', {}, h('summary', { class: 'small', text: `Rédigée par : ${st.model || 'modèle à choisir'}` }),
      h('div', { class: 'stack' },
        field('Fournisseur', selectEl(chat.map(p => [p.id, p.label]), st.provider, v => { st.provider = v; st.model = (provider(v) || {}).default_model || ''; jGraph(); })),
        field('Modèle', modelInput(st.provider, st.model, v => { st.model = v; })))),
    h('div', { class: 'row' },
      h('button', { class: 'primary', text: '✦ Synthèse IA', onclick: () => runSynthese(lab, L, status) }),
      J.synthese ? h('button', { class: 'small', text: 'Revoir la dernière', onclick: () => openSynthese(J.synthese) }) : null),
    status);
}

async function runSynthese(lab, L, status) {
  const st = jAssist();
  if (!st.provider) return toast('Configurez un fournisseur de discussion dans Modèles LLM.', true);
  const dossier = syntheseDossier(lab, L);
  status.textContent = 'L\'IA rédige la synthèse à partir des chiffres du banc…';
  try {
    const r = await api('POST', '/api/jevlab/synthese', { provider: st.provider, model: st.model, dossier });
    J.synthese = { ...r, dossier, date: Date.now() };
    status.textContent = '';
    openSynthese(J.synthese);
  } catch (e) { status.textContent = ''; toast(e.message, true); }
}

function statBars(q) {
  const scale = q.type === 'score' ? Math.max(1, q.echelle || 1) : 1;
  const unit = { noul: ' de oui', choice: ' de confiance', liste: ' de confiance' }[q.type];
  return h('div', { class: 'stack' }, q.par_voie_attendue.map(v => {
    const pct = unit ? Math.round(v.moyenne * 100) : null;
    const mots = v.mots ? ' · ' + Object.entries(v.mots).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([w, n]) => `${w} (${n})`).join(', ') : '';
    return h('div', { class: 'statbar' },
      h('div', { class: 'small', text: `Wagons attendus sur « ${v.voie} » (${v.cas}) : ` + (unit ? `${pct} %${unit} en moyenne` : `${fmtNum(v.moyenne, 2)} en moyenne${q.type === 'score' ? ' sur ' + scale : ''}`) + mots }),
      unit || q.type === 'score' ? h('div', { class: 'bar' }, h('span', { style: `width:${Math.round(Math.min(1, v.moyenne / scale) * 100)}%` })) : null);
  }));
}

function syntheseMarkdown(R) {
  const s = R.synthese, d = R.dossier;
  const all = [d.reglage_actuel, ...d.leviers];
  const L = [`# Synthèse : ${d.automate.nom}`, '', `Rédigée par ${R.modele} le ${new Date(R.date).toLocaleString('fr-FR')}. Les chiffres viennent du banc d'essai.`, '',
    '## 1. Ce qui a été fait', '', s.fait, '', `${d.banc.passes_chez_jev} wagons passés chez Jev, ${d.banc.avec_resultat_attendu} avec le résultat attendu, ${d.banc.inventes_par_ia} inventés par l'IA. Prix : erreur ${d.prix.erreur_eur} €, passage humain ${d.prix.passage_humain_eur} €.`, '',
    '## 2. Ce que Jev a conclu', ''];
  for (const q of d.jev) {
    L.push(`### ${q.id}`, '', q.question, '', ((s.jev.find(x => x.question === q.id) || {}).lecture || ''), '');
    q.par_voie_attendue.forEach(v => L.push(`- attendus sur « ${v.voie} » (${v.cas}) : ${q.mesure} ${v.moyenne}`));
    L.push('');
  }
  L.push('## 3. Les manettes', '', '| Manette | Conformes | Erreurs | Passages humains | Coût pour 1 000 wagons |', '|---|---|---|---|---|');
  all.forEach(l => L.push(`| ${l.nom} | ${l.conformes} / ${l.etiquetes} | ${l.erreurs} | ${l.passages_humains} | ${l.cout_pour_1000_wagons_eur.toLocaleString('fr-FR')} € |`));
  L.push('');
  s.leviers.forEach(x => { const l = all.find(y => y.id === x.id); if (l) L.push(`**${l.nom}.** Quand le choisir : ${x.quand} Attention : ${x.attention}`, ''); });
  L.push('## 4. Vos priorités (QCM)', '');
  if (Object.keys(d.qcm || {}).length) R.classement.forEach((c, i) => L.push(`${i + 1}. ${c.nom} (${c.points} points)${c.raisons.length ? ' : ' + c.raisons.join(' ; ') : ''}`));
  else L.push('QCM non rempli.');
  const rec = all.find(l => l.id === s.recommandation.levier);
  L.push('', '## 5. Recommandation', '', rec ? `**${rec.nom}.** ${s.recommandation.pourquoi}` : s.recommandation.pourquoi, '', '## 6. Conseil', '', s.conseil, '');
  s.etapes.forEach((e, i) => L.push(`${i + 1}. ${e}`));
  return L.join('\n');
}

function openSynthese(R) {
  const s = R.synthese, d = R.dossier;
  const all = [d.reglage_actuel, ...d.leviers];
  const dlg = h('dialog', { class: 'report' });
  const sec = (title, ...kids) => h('section', { class: 'rep-sec' }, h('h3', { text: title }), ...kids);
  const md = syntheseMarkdown(R);
  const rec = all.find(l => l.id === s.recommandation.levier);
  const tryLever = () => {
    const lab = reglageLab(); if (!lab) return;
    const l = computeLevers(lab).list.find(x => x.id === s.recommandation.levier);
    if (l) { dlg.close(); previewLever(lab, l); }
  };
  put(dlg, h('div', { class: 'rep' },
    h('div', { class: 'rep-head' },
      h('div', {}, h('h2', { text: '✦ Synthèse : ' + d.automate.nom }),
        h('div', { class: 'small muted', text: `Rédigée par ${R.modele} le ${new Date(R.date).toLocaleString('fr-FR')}. Les chiffres viennent du banc d'essai, l'IA les explique.` })),
      h('div', { class: 'row' },
        h('button', { class: 'small', text: 'Copier', onclick: async () => { try { await navigator.clipboard.writeText(md); toast('Synthèse copiée'); } catch { toast('Copie refusée par le navigateur', true); } } }),
        h('button', { class: 'small', text: 'Télécharger (.md)', onclick: () => { const a = h('a', { href: URL.createObjectURL(new Blob([md], { type: 'text/markdown' })), download: slug(d.automate.nom) + '-synthese.md' }); a.click(); } }),
        h('button', { class: 'small', text: 'Fermer', onclick: () => dlg.close() }))),
    sec('🚉 1. Ce qui a été fait', h('p', { text: s.fait }),
      h('div', { class: 'chips' }, chip('🚃', `${d.banc.passes_chez_jev} wagons passés chez Jev`), chip('🏷', `${d.banc.avec_resultat_attendu} avec le résultat attendu`),
        d.banc.inventes_par_ia ? chip('✦', `${d.banc.inventes_par_ia} inventé(s) par l'IA`) : null, chip('€', `erreur ${d.prix.erreur_eur} €, passage humain ${d.prix.passage_humain_eur} €`))),
    sec('🧠 2. Ce que Jev a conclu',
      h('p', { class: 'small muted', text: 'Pour chaque question, les wagons sont regroupés selon la voie où ils devaient aller. Une question utile donne des réponses bien différentes d\'une voie à l\'autre.' }),
      d.jev.map(q => h('div', { class: 'rep-q stack' }, h('div', {}, h('b', { class: 'mono', text: q.id }), h('span', { class: 'small muted', text: ' · ' + q.question })),
        (s.jev.find(x => x.question === q.id) || {}).lecture ? h('p', { text: s.jev.find(x => x.question === q.id).lecture }) : null, statBars(q)))),
    sec('🎛 3. Les manettes, et quand choisir chacune', all.map(l => {
      const x = s.leviers.find(y => y.id === l.id) || {};
      return h('div', { class: 'lever' + (rec === l ? ' on' : '') },
        h('div', { class: 'row between' }, h('b', { text: l.nom }), rec === l ? h('span', { class: 'badge accent', text: 'recommandée' }) : null),
        h('div', { class: 'chips' }, chip('✓', `${l.conformes} / ${l.etiquetes} conformes`), chip('✗', `${l.erreurs} erreur(s)`, l.erreurs ? 'bad' : 'good'),
          chip('👤', `${l.passages_humains} passage(s) humain(s)`), chip('€', `≈ ${l.cout_pour_1000_wagons_eur.toLocaleString('fr-FR')} € pour 1 000 wagons`)),
        l.identique_a ? h('div', { class: 'small faint', text: `Même réglage que « ${l.identique_a} ».` }) : null,
        x.quand ? h('div', { class: 'small' }, h('b', { text: 'Quand la choisir : ' }), x.quand) : null,
        x.attention ? h('div', { class: 'small' }, h('b', { text: 'Attention : ' }), x.attention) : null);
    })),
    sec('🧭 4. Vos priorités (QCM)', Object.keys(d.qcm || {}).length ? rankList(R.classement)
      : h('p', { class: 'small muted', text: 'QCM non rempli : la recommandation repose seulement sur les chiffres. Répondez au QCM dans la salle de réglage, puis relancez la synthèse.' })),
    sec('✅ 5. Notre recommandation', h('div', { class: 'notice ok stack' },
      rec ? h('div', {}, 'Manette conseillée : ', h('b', { text: rec.nom })) : null, h('p', { text: s.recommandation.pourquoi }),
      rec && rec.id !== 'actuel' ? h('div', {}, h('button', { class: 'primary small', text: 'Essayer cette manette sur la voie', onclick: tryLever })) : null)),
    sec('💡 6. Conseil', h('p', { text: s.conseil }), s.etapes.length ? h('div', {}, h('b', { class: 'small', text: 'Prochaines étapes' }), h('ol', {}, s.etapes.map(e => h('li', { text: e })))) : null)));
  document.body.append(dlg);
  dlg.addEventListener('close', () => dlg.remove());
  dlg.showModal();
}

// Les wagons du banc sur la voie : combien arrivent sur chaque voie avec le réglage affiché.
function sceneFleet() {
  const lab = J.bench && J.bench.sig === benchSig() ? reglageLab() : null;
  if (!lab || !lab.data.length) return null;
  const cur = lab.run(lab.knobs.map(k => k.get()));
  const base = J.preview ? lab.run(J.preview.backup.vals) : null;
  return { counts: cur.counts, base: base ? base.counts : null };
}

async function scenePlay(ctx, input, res) {
  if (!ctx) return;
  const st = ctx.st;
  st.inputObj = input; st.inputText = JSON.stringify(input, null, 2);
  try {
    const r = computeRun(ctx, input, res, null);
    st.steps = r.steps; st.result = { prep: r.p, jev: res, decision: r.dec };
  } catch (e) { toast(e.message, true); return; }
  st.lastJev = res; st.trace = null; st.stepIndex = 0;
  ctx.redraw();
  ctx.host.scrollIntoView({ behavior: 'smooth', block: 'start' });
  await stepTo(ctx, st.steps.length - 1);
}

function ecoCard(payload) {
  const card = h('div', { class: 'card stack' }, h('h2', { text: 'Tokens épargnés à l\'agent' }));
  const calls = h('input', { type: 'number', min: 1, value: J.ecoCalls || 1000, style: 'width:110px', onchange: e => { J.ecoCalls = Number(e.target.value); draw(); } });
  const body = h('div');
  const draw = async () => {
    try {
      const r = await api('POST', '/api/economy', { ...payload(), calls: J.ecoCalls || 1000 });
      put(clear(body),
        h('table', {}, h('tbody', {},
          h('tr', {}, h('td', { text: 'Agent seul, qui lit et décide' }), h('td', { class: 'mono', text: `${fmtNum(r.agent_seul.cout, 2)} $` })),
          h('tr', {}, h('td', { text: 'Avec l\'automate (Jev + verdict)' }), h('td', { class: 'mono', text: `${fmtNum(r.automate.cout, 2)} $` })),
          h('tr', {}, h('td', {}, h('b', { text: 'Économie' })), h('td', { class: 'mono' }, h('b', { text: `${fmtNum(r.economie, 2)} $` }), r.ratio ? ` (÷${fmtNum(r.ratio, 1)})` : '')),
          h('tr', {}, h('td', { text: 'Tokens de l\'agent épargnés' }), h('td', { class: 'mono', text: r.tokens_agent_epargnes.toLocaleString('fr-FR') })))),
        h('p', { class: 'small faint', text: `Référence : ${r.modele}. ${r.hypotheses}` }));
    } catch (e) { put(clear(body), h('p', { class: 'small muted', text: e.message })); }
  };
  put(card, h('div', { class: 'row' }, h('span', { class: 'small', text: 'Pour' }), calls, h('span', { class: 'small', text: 'décisions' })), body);
  draw();
  return card;
}

// Export vers le Hub (commun aux deux labos) ------------------------------------------------------------

async function openHubExport(payload) {
  const dlg = $('#dialog');
  const insts = S.data.instances;
  const st = { iid: (insts[0] || {}).id || '', base: '', tab: 'LISEZMOI.md' };
  const body = h('div', { class: 'dlg stack' });
  const draw = async () => {
    clear(body);
    put(body, h('h2', { text: 'Exporter vers une playlist du Hub' }),
      h('p', { class: 'small muted', text: 'Quatre pièces que le Hub lit déjà : l\'API (OpenAPI) pour l\'outil, le skill pour la consigne, le kit pour une playlist complète, et le workflow.' }),
      h('div', { class: 'row' },
        field('Adresse de n8n', insts.length ? selectEl([...insts.map(i => [i.id, `${i.label} · ${i.url}`]), ['', 'Autre adresse…']], st.iid, v => { st.iid = v; draw(); }) : h('span', { class: 'small', text: 'Aucune instance reliée' }), 'grow'),
        !st.iid ? field('Adresse publique de n8n', inputEl(st.base, v => { st.base = v; }, { placeholder: 'https://n8n.mondomaine.fr', onchange: () => draw() }), 'grow') : null));
    let r;
    try { r = await api('POST', '/api/export/hub', { ...payload, instance_id: st.iid || null, base_url: st.base || null }); }
    catch (e) { put(body, h('div', { class: 'notice err', text: e.message + (e.errors ? ' : ' + e.errors.join(' ; ') : '') }), h('div', { class: 'row end' }, h('button', { text: 'Fermer', onclick: () => dlg.close() }))); return; }
    const names = Object.keys(r.parts);
    if (!names.includes(st.tab)) st.tab = names[0];
    const content = p => (typeof r.parts[p] === 'string' ? r.parts[p] : JSON.stringify(r.parts[p], null, 2));
    put(body, h('div', { class: 'row' }, names.map(n => h('button', { class: 'small' + (n === st.tab ? ' primary' : ''), text: n, onclick: () => { st.tab = n; draw(); } }))),
      h('pre', { class: 'json', text: content(st.tab) }),
      h('div', { class: 'row end' },
        h('button', { text: 'Copier', onclick: () => navigator.clipboard.writeText(content(st.tab)).then(() => toast('Copié')) }),
        h('button', { text: 'Télécharger ' + st.tab, onclick: () => { const a = h('a', { href: URL.createObjectURL(new Blob([content(st.tab)])), download: st.tab }); document.body.append(a); a.click(); a.remove(); } }),
        h('button', { class: 'primary', text: 'Tout télécharger (.zip)', onclick: async () => {
          const res = await fetch('/api/export/hub', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...payload, instance_id: st.iid || null, base_url: st.base || null, format: 'zip' }) });
          const blob = await res.blob();
          const name = (res.headers.get('content-disposition') || '').match(/filename="([^"]+)"/);
          const a = h('a', { href: URL.createObjectURL(blob), download: name ? name[1] : 'export-hub.zip' }); document.body.append(a); a.click(); a.remove();
        } }),
        h('button', { text: 'Fermer', onclick: () => dlg.close() })));
  };
  put(clear(dlg), body);
  dlg.showModal();
  draw();
}

// Pédagogie : tutoriels repliables et (i) -------------------------------------------------------------

function info(text) {
  const tip = h('span', { class: 'info-tip', text });
  const b = h('button', { class: 'ibtn', type: 'button', title: text, 'aria-label': 'Explication', text: 'i',
    onclick: e => { e.preventDefault(); e.stopPropagation(); tip.classList.toggle('open'); } });
  return h('span', { class: 'info-wrap' }, b, tip);
}
function lab(text, tip) { return h('label', {}, text, ' ', tip ? info(tip) : null); }
function tuto(key, title, steps) {
  let closed = false;
  try { closed = localStorage.getItem('tuto-' + key) === 'ferme'; } catch { /* stockage indisponible */ }
  const d = h('details', { class: 'card tuto', open: closed ? null : true,
    ontoggle: e => { try { localStorage.setItem('tuto-' + key, e.target.open ? 'ouvert' : 'ferme'); } catch { /* rien */ } } },
    h('summary', { text: 'Tutoriel : ' + title }), h('ol', {}, steps.map(s => h('li', {}, ...(Array.isArray(s) ? s : [s])))));
  return d;
}

// Plusieurs LLM dans un automate : un en entrée (agentique), un par route ------------------------------

function llmSetup(get, set, routes, onChange) {
  const chat = chatProviders();
  const def = () => { const p = chat.find(x => x.configured && !x.key_optional) || provider('openrouter') || chat[0]; return { provider: p.id, model: p.default_model || '', system: '' }; };
  const card = h('div', { class: 'card stack' },
    h('h2', {}, 'LLM de l\'automate (facultatif) ', info('Un automate peut combiner plusieurs modèles : un LLM agentique en entrée qui met la demande au propre, Jev qui décide, et un LLM par route qui rédige. Chaque case choisit son propre modèle, par exemple via OpenRouter.')),
    h('div', { class: 'notice info small' }, 'Schéma : ', h('b', { text: 'LLM d\'entrée' }), ' (reformule) → ', h('b', { text: 'Jev' }), ' (décide) → ', h('b', { text: 'LLM de route' }), ' (rédige la réponse de cette route). Sans LLM, l\'automate reste 100 % déterministe.'));
  const row = (l, onDel, withRoute) => h('div', { class: 'qcard stack' },
    h('div', { class: 'row' },
      withRoute ? field('Route', selectEl(routes, l.route, v => { l.route = v; onChange(); }), 'w180') : null,
      field('Fournisseur', selectEl(chat.map(p => [p.id, p.label + (p.configured ? '' : ' (non configuré)')]), l.provider, v => { l.provider = v; l.model = (provider(v) || {}).default_model || ''; onChange(true); }), 'w180'),
      h('div', { class: 'field grow' }, lab('Modèle', 'Tapez pour chercher parmi les modèles du fournisseur (liste lue en direct). Exemple OpenRouter : xiaomi/mimo-v2.6-flash.'), modelInput(l.provider, l.model, v => { l.model = v; onChange(); })),
      h('button', { class: 'ghost danger', text: 'Retirer', onclick: onDel })),
    h('div', {}, lab('Consigne', withRoute ? 'Ce que le LLM rédige pour cette route. Il reçoit l\'entrée et la décision (route, raison, variables).' : 'Ce que le LLM fait de la demande brute avant Jev. Sa réponse devient l\'état jugé par Jev.'),
      textArea(l.system, v => { l.system = v; onChange(); }, { rows: 2, placeholder: withRoute ? 'Rédige une réponse courte…' : 'Réécris la demande en texte court et factuel, sans y répondre.' })));
  const cur = get();
  put(card, h('h3', {}, 'LLM d\'entrée (agentique) ', info('Utile quand l\'entrée est brouillonne (e-mail long, conversation). Il nettoie ; Jev juge ensuite un texte clair. Coûte un appel LLM par passage.')));
  if (cur.entree) put(card, row(cur.entree, () => { set({ entree: null }); onChange(true); }, false));
  else put(card, h('button', { class: 'small', text: '+ Ajouter un LLM d\'entrée', onclick: () => { set({ entree: def() }); onChange(true); } }));
  put(card, h('h3', {}, 'LLM par route ', info('Un modèle différent peut servir chaque route : un petit modèle pour remercier, un gros pour un litige. Les routes sans LLM restent sans coût de LLM.')));
  (cur.routes || []).forEach((l, i) => put(card, row(l, () => { cur.routes.splice(i, 1); set({ routes: cur.routes }); onChange(true); }, true)));
  put(card, h('button', { class: 'small', text: '+ Ajouter un LLM sur une route', disabled: !routes.length, onclick: () => {
    const used = new Set((cur.routes || []).map(x => x.route));
    const r = routes.find(x => !used.has(x));
    if (!r) return toast('Toutes les routes ont déjà un LLM.', true);
    set({ routes: [...(cur.routes || []), { ...def(), route: r }] }); onChange(true);
  } }));
  return card;
}

// Banque de skills ------------------------------------------------------------------------------------

async function renderSkills(main) {
  const { skills } = await api('GET', '/api/skills');
  put(main, h('div', { class: 'page-head' },
    h('div', {}, h('h1', { text: 'Banque de skills' }),
      h('p', { class: 'muted', text: 'Ce qu\'un agent doit savoir de Jev, de n8n et de cet outil, au format SKILL.md du Hub d\'agents.' })),
    h('a', { class: 'btn primary', href: '/api/skills.zip', download: 'banque-skills.zip', text: 'Tout télécharger (.zip)' })),
    tuto('skills', 'donner ce savoir à un agent', [
      ['Un ', h('b', { text: 'skill' }), ' est une fiche d\'instructions que l\'agent lit avant d\'agir. ', info('Format SKILL.md : un en-tête (nom, description) puis les instructions. Le Hub d\'agents, Claude et d\'autres agents le lisent tel quel.')],
      ['Dans le Hub : Catalogue, Skills, importer le SKILL.md (ou le .zip), puis « Ajouter à une playlist ».'],
      ['Pour un agent qui pilote cet outil par API : il peut lire lui-même la banque sur /api/skills puis /api/skills/<nom>.'],
      ['Commencez par « n8n-export-builder » : il renvoie vers les autres.'],
    ]));
  const view = h('pre', { class: 'json', style: 'max-height:520px' });
  const list = h('div', { class: 'grid two' });
  for (const sk of skills) {
    put(list, h('div', { class: 'card stack' },
      h('h2', { class: 'mono', text: sk.name }), h('p', { class: 'small muted', text: sk.description }),
      h('div', { class: 'row' },
        h('button', { class: 'small', text: 'Lire', onclick: async () => { view.textContent = await (await fetch('/api/skills/' + sk.name)).text(); view.scrollIntoView({ behavior: 'smooth' }); } }),
        h('button', { class: 'small', text: 'Copier', onclick: async () => { await navigator.clipboard.writeText(await (await fetch('/api/skills/' + sk.name)).text()); toast('Skill copié'); } }),
        h('a', { class: 'btn small', href: '/api/skills/' + sk.name, download: sk.name + '-SKILL.md', text: 'Télécharger' }))));
  }
  put(main, list, h('div', { class: 'card', style: 'margin-top:14px' }, h('h2', { text: 'Contenu' }), view));
}

// Vue graphique : l'automate en voie ferrée ---------------------------------------------------------------
// Gare (entrée) → wagon (message) → ateliers (préparation, LLM d'entrée) → cabine de l'aiguilleur (Jev)
// → aiguillage (règles) → voies colorées vers chaque route. Construite depuis le workflow réellement généré.

const SVGNS = 'http://www.w3.org/2000/svg';
function sv(tag, attrs, ...kids) {
  const el = document.createElementNS(SVGNS, tag);
  for (const [k, v] of Object.entries(attrs || {})) if (v !== null && v !== undefined) el.setAttribute(k, v);
  for (const k of kids.flat()) if (k !== null && k !== undefined) el.append(k instanceof Node ? k : document.createTextNode(String(k)));
  return el;
}

const REVIEW_RE = /revoir|relire|humain|verifier|examiner|agent_decide|desaccord|valider|incertain|responsable|analyste|astreinte|appeler|telephone/;
const BLOCK_RE = /bloqu|refus|signal|rejet|spam|fraude|invent|incoher|invalide|masquer|hors_|doublon|critique|en_retard/;
function routeKind(r) { return BLOCK_RE.test(r) ? 'block' : (REVIEW_RE.test(r) ? 'review' : 'auto'); }
const KIND_LABEL = { auto: 'Automatique', review: 'Humain', block: 'Blocage' };

function sceneModules(build) {
  const spec = build.spec;
  const names = new Set(build.workflow.nodes.map(n => n.name));
  const t = spec.trigger;
  const mods = [{ id: 'gare', icon: '🚉', label: 'Gare de départ', sub: { webhook: 'Webhook /' + t.path, schedule: 'Planifié', manual: 'Manuel' }[t.type] }];
  if (spec.source) mods.push({ id: 'source', icon: '📡', label: 'Source', sub: spec.source.type.toUpperCase() });
  mods.push({ id: 'prep', icon: '🛠', label: 'Atelier de préparation', sub: 'code' });
  if (spec.entree_llm) mods.push({ id: 'llm_in', icon: '✍', label: 'LLM d\'entrée', sub: spec.entree_llm.model });
  if (build.uses_jev) mods.push({ id: 'jev', icon: '🧠', label: 'Cabine de l\'aiguilleur', sub: 'Jev ' + spec.model });
  mods.push({ id: 'decision', icon: '🔀', label: 'Aiguillage', sub: `${(spec.decision.rules || []).length} règle(s)` });
  return mods.filter(m => m.id !== 'llm_in' || names.has("LLM d'entrée (agent)"));
}

// Jauge circulaire : valeur 0..1, couleur selon le verdict
function gauge(label, value, verdict, sub) {
  const r = 30, c = 2 * Math.PI * r, v = value === null || value === undefined ? null : Math.max(0, Math.min(1, value));
  const tone = verdict === 'oui' ? 'var(--g-ok)' : verdict === 'non' ? 'var(--g-no)' : (verdict === 'a_verifier' || verdict === 'incertain' || verdict === 'hesitation') ? 'var(--g-mid)' : 'var(--g-acc)';
  const arc = sv('circle', { cx: 40, cy: 40, r, fill: 'none', stroke: tone, 'stroke-width': 8, 'stroke-linecap': 'round',
    'stroke-dasharray': `${v === null ? 0 : c * v} ${c}`, transform: 'rotate(-90 40 40)', class: 'g-arc' });
  return h('div', { class: 'gauge' },
    h('div', { class: 'g-label', text: label }),
    (() => { const s = sv('svg', { viewBox: '0 0 80 80', width: 80, height: 80 },
      sv('circle', { cx: 40, cy: 40, r, fill: 'none', stroke: 'var(--g-track)', 'stroke-width': 8 }), arc,
      sv('text', { x: 40, y: 45, 'text-anchor': 'middle', class: 'g-val' }, v === null ? '?' : Math.round(v * 100) + '%')); return s; })(),
    h('div', { class: 'g-sub', text: verdict ? String(Array.isArray(verdict) ? verdict.join(', ') || 'aucune' : verdict) : (sub || 'en attente') }));
}

function sceneGauges(ctx) {
  const res = ctx.st.result && shown(ctx, 'jev') ? ctx.st.result : null;
  const answers = (res && res.jev && res.jev.answers) || {};
  const vars = (res && res.decision && res.decision.vars) || {};
  const qs = Object.entries((res && res.prep && res.prep.questions) || ctx.build.spec.questions || {});
  const out = [];
  for (const [id, q] of qs.slice(0, 8)) {
    const a = answers[id];
    const base = id.split('__')[0];
    let val = null, verdict = vars[id + '_verdict'] ?? vars[base + '_verdict'];
    if (a) val = a.type === 'noul' ? a.noul : (a.type === 'choice' ? a.confidence : (a.score / Math.max(1, (q.criteria || []).length - 1)));
    if (a && a.type === 'noul' && id.includes('__')) verdict = a.noul >= 0.5 ? 'oui' : 'non';
    out.push(gauge(id.replace('__', ' · '), val, a ? verdict : null, { noul: 'oui / non', choice: 'choix', score: 'score' }[q.type]));
  }
  if (qs.length > 8) out.push(h('div', { class: 'g-more', text: `+ ${qs.length - 8} question(s)` }));
  if (!qs.length) out.push(h('div', { class: 'g-more', text: ctx.build.uses_jev ? 'Questions construites depuis l\'entrée : lancez le test.' : 'Automate 100 % code : pas de question à Jev.' }));
  return h('div', { class: 'gauges' }, h('div', { class: 'g-title' }, 'Jauges de l\'aiguilleur ', info('Une jauge par question posée à Jev. Oui/non : probabilité du oui. Choix : confiance dans le mot retenu. Score : position sur l\'échelle. La couleur suit le verdict : vert oui, rouge non, orange à vérifier.')), h('div', { class: 'g-row' }, out));
}

function sceneSvg(ctx) {
  const build = ctx.build, spec = build.spec;
  const mods = sceneModules(build);
  const routes = build.routes;
  const W = 1000, H = Math.max(380, 96 * routes.length + 70), mid = H / 2 + 20;
  const xSwitch = 640, xEnd = 820;
  const step = (xSwitch - 150) / Math.max(1, mods.length - 1);
  const pos = mods.map((m, i) => ({ ...m, x: 80 + i * step, y: mid }));
  ctx.geo = { mid, xSwitch, x: Object.fromEntries(pos.map(m => [m.id, m.x])) };
  const svg = sv('svg', { viewBox: `0 0 ${W} ${H}`, class: 'scene-svg', role: 'img', 'aria-label': 'Schéma du workflow en voie ferrée' });
  const defs = sv('defs', {}, sv('filter', { id: 'glow' }, sv('feGaussianBlur', { stdDeviation: 4, result: 'b' }), sv('feMerge', {}, sv('feMergeNode', { in: 'b' }), sv('feMergeNode', { in: 'SourceGraphic' }))));
  svg.append(defs);
  const res = ctx.st.result;
  const hit = res && res.decision && shown(ctx, 'decision') ? res.decision.route : null;
  // voie principale
  const main = `M 40 ${mid} L ${xSwitch} ${mid}`;
  svg.append(sv('path', { d: main, class: 'rail-bed' }), sv('path', { d: main, class: 'rail-ties' }), sv('path', { d: main, id: 'rail-main', class: 'rail-line' }));
  // voies de sortie
  const top = mid - (routes.length - 1) * 96 / 2;
  const llms = new Set((spec.llms || []).map(l => l.route));
  routes.forEach((r, i) => {
    const y = top + i * 96;
    const kind = (ctx.kindOf || routeKind)(r);
    const d = `M ${xSwitch} ${mid} C ${xSwitch + 120} ${mid}, ${xSwitch + 110} ${y}, ${xEnd - 40} ${y} L ${xEnd} ${y}`;
    const cls = `rail-out k-${kind}` + (hit ? (hit === r ? ' hit' : ' dim') : '');
    svg.append(sv('path', { d, class: 'rail-bed ' + cls }), sv('path', { d, class: 'rail-ties ' + cls }), sv('path', { d, id: 'rail-r-' + i, class: 'rail-line ' + cls }));
    const g = sv('g', { class: 'station dest ' + cls, tabindex: 0, 'data-mod': 'route:' + r });
    g.append(sv('rect', { x: xEnd, y: y - 30, width: 170, height: 60, rx: 10 }),
      sv('text', { x: xEnd + 85, y: y - 5, 'text-anchor': 'middle', class: 'st-t' }, r.length > 17 ? r.slice(0, 16) + '…' : r),
      sv('text', { x: xEnd + 85, y: y + 16, 'text-anchor': 'middle', class: 'st-s' }, KIND_LABEL[kind] + (llms.has(r) ? ' · LLM' : '') + (spec.decision.error_route === r ? ' · panne' : '')));
    g.addEventListener('click', () => { ctx.st.sel = 'route:' + r; ctx.st.panel = 'module'; ctx.redraw(); });
    svg.append(g);
    if (ctx.fleet) {
      const c = ctx.fleet.counts[r] || { n: 0, err: 0 };
      const b = ctx.fleet.base ? (ctx.fleet.base[r] || { n: 0 }).n : null;
      const delta = b === null || b === c.n ? '' : ` (${c.n > b ? '+' : '−'}${Math.abs(c.n - b)})`;
      const label = `🚃 ${c.n}${delta}` + (c.err ? ` · ✗ ${c.err}` : '');
      svg.append(sv('g', { class: 'fleet' + (c.err ? ' bad' : '') + (delta ? ' moved' : '') },
        sv('title', {}, `${c.n} wagon(s) d'essai sur cette voie` + (c.err ? `, dont ${c.err} erreur(s)` : '') + (delta ? `, ${delta.trim()} par rapport au réglage actuel` : '')),
        sv('rect', { x: xEnd, y: y - 56, width: 170, height: 22, rx: 11 }),
        sv('text', { x: xEnd + 85, y: y - 40, 'text-anchor': 'middle' }, label)));
    }
  });
  // stations de la voie principale
  pos.forEach(m => {
    const big = m.id === 'jev';
    const w = Math.max(big ? 150 : 112, Math.min(step - 12, 140)), hh = big ? 104 : 84;
    const g = sv('g', { class: 'station' + (big ? ' cabin' : '') + (ctx.st.sel === m.id ? ' sel' : '') + (res ? ' passed' : ''), tabindex: 0, 'data-mod': m.id });
    g.append(sv('rect', { x: m.x - w / 2, y: m.y - hh - 18, width: w, height: hh, rx: 12 }),
      sv('text', { x: m.x, y: m.y - hh + (big ? 20 : 14), 'text-anchor': 'middle', class: 'st-i' }, m.icon),
      sv('text', { x: m.x, y: m.y - (big ? 46 : 40), 'text-anchor': 'middle', class: 'st-t' }, ({ gare: 'Gare', source: 'Source', prep: 'Préparation', llm_in: 'LLM d\'entrée', jev: 'Aiguilleur (Jev)', decision: 'Aiguillage' })[m.id] || m.label),
      sv('text', { x: m.x, y: m.y - (big ? 28 : 24), 'text-anchor': 'middle', class: 'st-s' }, String(m.sub || '').slice(0, 20)),
      sv('circle', { cx: m.x, cy: m.y, r: 7, class: 'st-dot' }));
    g.addEventListener('click', () => { ctx.st.sel = m.id; ctx.st.panel = 'module'; ctx.redraw(); });
    svg.append(g);
  });
  // aiguillage
  svg.append(sv('circle', { cx: xSwitch, cy: mid, r: 11, class: 'switch-dot' + (hit ? ' on' : '') }));
  // wagon
  const wagon = sv('g', { id: 'wagon', class: 'wagon', transform: `translate(40 ${mid})` },
    sv('rect', { x: -24, y: -14, width: 48, height: 22, rx: 5 }), sv('text', { x: 0, y: 2, 'text-anchor': 'middle' }, '✉'),
    sv('circle', { cx: -13, cy: 10, r: 4 }), sv('circle', { cx: 13, cy: 10, r: 4 }));
  svg.append(wagon);
  return svg;
}

// Carte détaillée du module choisi
function moduleCard(ctx) {
  const { build, st } = ctx;
  const spec = build.spec, res = st.result;
  const sel = st.sel || (build.uses_jev ? 'jev' : 'decision');
  const card = h('div', { class: 'mod-card stack' });
  const title = (t, tip) => h('h2', {}, t, ' ', tip ? info(tip) : null);
  if (sel === 'gare') {
    const t = spec.trigger;
    put(card, title('🚉 Gare de départ', 'Là où le message entre dans l\'automate : un appel HTTP (webhook), une horloge (planifié) ou un clic (manuel).'),
      h('p', {}, { webhook: `Un agent ou un service envoie un message en POST à /webhook/${t.path}.`, schedule: 'L\'automate part tout seul, à heure fixe.', manual: 'Vous lancez l\'automate à la main, avec l\'exemple.' }[t.type]),
      t.type === 'webhook' ? h('div', { class: 'notice ' + (t.auth === 'header' ? 'ok' : 'warn') + ' small', text: t.auth === 'header' ? '🔒 Protégé : il faut la clé X-Builder-Key pour entrer.' : '🔓 Ouvert : n\'importe qui peut envoyer un message. Activez la clé avant la production.' }) : null,
      h('label', { text: 'Wagon d\'exemple (ce qui arrive en gare)' }), h('pre', { class: 'json', text: JSON.stringify(st.inputObj ?? spec.sample, null, 2) }));
  } else if (sel === 'source') {
    put(card, title('📡 Source', 'L\'automate va chercher lui-même les données (flux RSS, adresse web), un wagon par élément.'), h('p', { class: 'mono small', text: spec.source.url }));
  } else if (sel === 'prep') {
    put(card, title('🛠 Atelier de préparation', 'Du code, sans IA : il calcule ce qui se calcule (dates, montants, doublons) et prépare le texte envoyé à Jev. Même entrée, même résultat.'),
      h('p', { class: 'small muted', text: { field: `Jev lira le champ « ${spec.state.field} ».`, fields: `Jev lira les champs ${(spec.state.fields || []).join(', ')}.`, json: 'Jev lira tout l\'objet reçu.' }[spec.state.mode] }),
      spec.prepare_js ? h('p', { class: 'small', text: 'Calculs propres à ce workflow : ' + ((spec.prepare_js.match(/vars\.([a-z_]+)\s*=/g) || []).map(x => x.slice(5, -1).trim()).filter((v, i, a) => a.indexOf(v) === i).join(', ') || 'questions construites depuis l\'entrée') }) : h('p', { class: 'small faint', text: 'Pas de calcul particulier.' }),
      res ? h('div', {}, h('label', { text: 'Ce que l\'atelier a produit' }), h('pre', { class: 'json', text: JSON.stringify({ etat_envoye_a_jev: res.prep.state, variables: res.prep.vars }, null, 2) })) : null);
  } else if (sel === 'llm_in') {
    const l = spec.entree_llm;
    put(card, title('✍ LLM d\'entrée (agentique)', 'Un LLM relit la demande brute et la réécrit en texte clair avant Jev. Sa réponse devient l\'état jugé par Jev.'),
      h('p', {}, h('b', { text: l.model }), ' · ', l.provider), h('p', { class: 'small muted', text: l.system }),
      h('div', { class: 'notice info small', text: 'Dans le test du builder, ce LLM n\'est pas appelé : Jev juge l\'état brut. Dans n8n, il est appelé à chaque passage.' }));
  } else if (sel === 'jev') {
    put(card, title('🧠 Cabine de l\'aiguilleur (Jev)', 'Jev ne rédige rien : il répond à chaque question par une probabilité. Toutes les questions partent en un seul appel.'));
    const answers = (res && shown(ctx, 'jev') && res.jev && res.jev.answers) || null;
    for (const [id, q] of Object.entries((res && res.prep.questions) || spec.questions).slice(0, 12)) {
      const a = answers && answers[id];
      const v = ((spec.decision.verdicts || {})[id]) || ((spec.decision.verdicts || {})[id.split('__')[0]]) || null;
      const block = h('div', { class: 'qcard stack' }, h('div', { class: 'row between' }, h('b', { class: 'mono', text: id }), h('span', { class: 'badge', text: q.type })),
        h('div', { class: 'small', text: typeof q.instructions === 'string' ? q.instructions : (q.instructions.question || JSON.stringify(q.instructions)).slice(0, 180) }));
      if (q.type === 'noul' && v && v.kind === 'noul') put(block, bandBar(Math.round(v.non * 100), Math.round(v.oui * 100), a ? a.noul : undefined));
      if (a) put(block, h('div', { class: 'small faint', text: a.type === 'noul' ? `Probabilité du oui : ${Math.round(a.noul * 100)} %` : a.type === 'choice' ? `Choix : ${String(q.criteria[a.choice] && /^c\d+$/.test(a.choice) ? q.criteria[a.choice] : a.choice).slice(0, 60)} · confiance ${Math.round(a.confidence * 100)} %` : `Score ${fmtNum(a.score, 2)} sur ${(q.criteria || []).length - 1}` }));
      if (ctx.onThreshold && q.type === 'noul' && v && v.kind === 'noul' && !id.includes('__')) {
        put(block, h('div', { class: 'row' },
          pctInput(Math.round(v.non * 100), x => ctx.onThreshold(id, 'seuil_non', x), 'NON jusqu\'à'),
          pctInput(Math.round(v.oui * 100), x => ctx.onThreshold(id, 'seuil_oui', x), 'OUI dès')));
      }
      if (st.simAnswers && st.simAnswers[id]) {
        const sa = st.simAnswers[id];
        let ctl;
        if (sa.type === 'noul') ctl = h('input', { type: 'range', min: 0, max: 1, step: 0.01, value: sa.noul, oninput: e => { sa.noul = Number(e.target.value); } });
        else if (sa.type === 'choice') ctl = selectEl(Object.entries(q.criteria).map(([k, d]) => [k, /^c\d+$/.test(k) && typeof d === 'string' ? d.slice(0, 50) : k]), sa.choice, x => { sa.choice = x; sa.probabilities = { [x]: sa.confidence }; });
        else ctl = h('input', { type: 'number', step: 0.1, min: 0, max: (q.criteria || []).length - 1, value: sa.score, oninput: e => { sa.score = Number(e.target.value); } });
        put(block, h('div', { class: 'sim' }, h('span', { class: 'small', text: 'Simulation : ' }), ctl));
      }
      put(card, block);
    }
  } else if (sel === 'decision') {
    const hitReason = res && shown(ctx, 'decision') ? res.decision.reason : null;
    put(card, title('🔀 Aiguillage', 'Des règles écrites, lues dans l\'ordre : la première qui s\'applique choisit la voie. Aucune IA ici, c\'est ce qui rend la décision identique à chaque passage.'));
    const rules = spec.decision.rules || [];
    if (spec.decision.mode === 'choice') put(card, h('p', {}, `Voie = mot choisi par Jev pour « ${spec.decision.question} », si sa confiance atteint ${Math.round(spec.decision.min_confidence * 100)} %. Sinon : ${spec.decision.review_route}.`));
    rules.forEach((r, i) => {
      const label = r.label || r.when.map(c => `${c.field} ${c.op} ${c.value ?? ''}`).join(' et ');
      const on = hitReason && (hitReason === r.label || hitReason.startsWith(r.when.map(c => `${c.field} ${c.op}`)[0]));
      put(card, h('div', { class: 'signal' + (on ? ' on' : '') }, h('span', { class: 'lamp k-' + (ctx.kindOf || routeKind)(r.route.startsWith('=') ? 'auto' : r.route) }), h('span', { class: 'small', text: `${i + 1}. ${label}` }), h('b', { class: 'mono small', text: ' → ' + r.route })));
    });
    put(card, h('div', { class: 'signal' }, h('span', { class: 'lamp' }), h('span', { class: 'small', text: 'Sinon' }), h('b', { class: 'mono small', text: ' → ' + (spec.decision.default_route || spec.decision.review_route || '') })),
      h('div', { class: 'notice warn small', text: `Si Jev ne répond pas : voie « ${spec.decision.error_route} ».` }));
    if (hitReason) put(card, h('div', { class: 'notice ok small' }, 'Règle appliquée : ', h('b', { text: hitReason })));
  } else if (sel.startsWith('route:')) {
    const r = sel.slice(6), kind = (ctx.kindOf || routeKind)(r);
    const l = (spec.llms || []).find(x => x.route === r);
    put(card, title(`🏁 Voie « ${r} »`, 'Une destination de l\'automate. Dans n8n, un nœud « Route : ' + r + ' » attend vos actions ; dans le Hub, l\'agent lit la consigne de cette voie.'),
      h('span', { class: 'badge k-' + kind, text: KIND_LABEL[kind] }),
      h('p', { text: (spec.route_notes || {})[r] || (ctx.notes || {})[r] || 'Consigne de l\'agent à préciser pour cette voie.' }),
      l ? h('div', { class: 'notice info small' }, '✍ Un LLM rédige sur cette voie : ', h('b', { text: l.model })) : h('p', { class: 'small faint', text: 'Pas de LLM sur cette voie : aucun coût de rédaction.' }),
      spec.decision.error_route === r ? h('div', { class: 'notice warn small', text: 'Voie de secours : c\'est ici qu\'arrive un message si Jev ne répond pas.' }) : null);
  }
  return card;
}

function sceneConsole(ctx) {
  const { st } = ctx;
  const jevReady = jevKeyReady(ctx.build.spec.jev_provider);
  const input = textArea(st.inputText ?? JSON.stringify(ctx.build.spec.sample && !Array.isArray(ctx.build.spec.sample) ? ctx.build.spec.sample : (ctx.build.spec.sample || [])[0] || {}, null, 2), v => { st.inputText = v; }, { class: 'code', rows: 6 });
  const lines = st.steps ? st.steps.slice(0, st.stepIndex + 1).flatMap(s => s.trace) : (st.trace || ['En attente d\'un wagon.']);
  const log = h('div', { class: 'trace' }, lines.map(l => h('div', { text: l })));
  const fin = st.steps && shown(ctx, 'final');
  const out = h('pre', { class: 'json', text: fin ? JSON.stringify({ route: st.result.decision.route, raison: st.result.decision.reason, variables: st.result.decision.vars, extra: st.result.decision.extra, jev_modele: st.result.jev && st.result.jev.model }, null, 2) : (st.steps ? '… le wagon n\'est pas encore arrivé.' : '{ }') });
  return h('div', { class: 'console card' },
    h('div', { class: 'row between' }, h('h2', { style: 'margin:0' }, 'Console de test ', info('Écrivez un message, lancez : le wagon part de la gare, passe la cabine de Jev et prend la voie choisie. En pas à pas, il s\'arrête à chaque station : l\'encart du chargement montre ce que le nœud a ajouté, retiré ou changé.')),
      h('div', { class: 'row' },
        h('label', { class: 'check', title: 'Le wagon s\'arrête à chaque station' }, h('input', { type: 'checkbox', checked: !!st.pas, onchange: e => { st.pas = e.target.checked; } }), 'Pas à pas'),
        h('button', { class: 'primary', disabled: !jevReady || !ctx.build, title: jevReady ? '' : 'Clé de Jev (TypeSafe ou OpenRouter) à renseigner dans Modèles LLM', text: '▶ Lancer avec Jev', onclick: () => sceneRun(ctx, false) }),
        h('button', { text: '▶ Lancer en simulation', title: 'Sans clé : les réponses de Jev viennent des curseurs de la cabine', onclick: () => sceneRun(ctx, true) }))),
    h('div', { class: 'console-grid' },
      h('div', {}, h('label', { text: 'Entrée (le wagon)' }), input),
      h('div', {}, h('label', { text: 'Trace' }), log),
      h('div', {}, h('label', { text: 'Sortie JSON (ce que reçoit l\'agent)' }), out)));
}

function toInput(ctx, text) {
  const spec = ctx.build.spec;
  const t = String(text ?? '').trim();
  if (t.startsWith('{') || t.startsWith('[')) { try { const v = JSON.parse(t); return Array.isArray(v) ? v[0] : v; } catch { /* texte */ } }
  return { [spec.state.mode === 'field' ? spec.state.field : ((spec.state.fields || [])[0] || 'message')]: text };
}

// Étapes : le chargement du wagon à chaque station, sa trace et son explication ---------------------------

function stepIdx(ctx, k) {
  const s = ctx.st.steps || [];
  if (k === 'final') return s.length - 1;
  return s.findIndex(x => x.mod === k);
}
function shown(ctx, k) {
  const st = ctx.st;
  if (!st.steps) return !!st.result;
  const i = stepIdx(ctx, k);
  return i < 0 ? st.stepIndex >= stepIdx(ctx, 'decision') : st.stepIndex >= i;
}
function publicVars(v) { return Object.fromEntries(Object.entries(v || {}).filter(([k]) => !k.startsWith('__'))); }
function answerText(a, q) {
  if (!a) return 'pas de réponse';
  if (a.type === 'noul') return `${Math.round(a.noul * 100)} % de oui`;
  if (a.type === 'choice') return `« ${String(/^c\d+$/.test(a.choice) && q ? (q.criteria[a.choice] || a.choice) : a.choice).slice(0, 50)} » à ${Math.round(a.confidence * 100)} %`;
  return `score ${fmtNum(a.score, 2)} sur ${q && q.criteria ? q.criteria.length - 1 : '?'}`;
}

function buildSteps(ctx, input, p, res, dec, err) {
  const spec = ctx.build.spec;
  const steps = [];
  const c0 = { message: input };
  steps.push({ mod: 'gare', titre: 'Gare de départ', cargo: c0,
    note: spec.trigger.type === 'webhook' ? 'Le message arrive par le webhook. Le wagon est chargé tel quel.' : 'Le wagon est chargé avec l\'exemple.',
    trace: [`🚉 Wagon reçu en gare (${spec.trigger.type === 'webhook' ? 'webhook /' + spec.trigger.path : spec.trigger.type}).`] });
  if (spec.source) steps.push({ mod: 'source', titre: 'Source', cargo: c0, note: 'En production, la source charge un wagon par élément lu (article RSS, réponse web). En test, l\'exemple le remplace.', trace: ['📡 Source : remplacée par l\'exemple en test.'] });
  if (!p) { steps.push({ mod: 'prep', titre: 'Atelier de préparation', cargo: c0, note: err, trace: ['⚠ ' + err] }); return steps; }
  const calc = publicVars(p.vars);
  const c1 = { message: input, etat_pour_jev: p.state };
  if (Object.keys(calc).length) c1.calculs = calc;
  if (ctx.build.uses_jev) c1.questions_pour_jev = Object.keys(p.questions);
  steps.push({ mod: 'prep', titre: 'Atelier de préparation', cargo: c1,
    note: 'L\'atelier ajoute ce que Jev va lire (etat_pour_jev), les calculs faits par le code et la liste des questions. Le message d\'origine reste à bord.',
    trace: [`🛠 Atelier : ${Object.keys(calc).length ? Object.keys(calc).length + ' valeur(s) calculée(s) (' + Object.keys(calc).slice(0, 4).join(', ') + ')' : 'rien à calculer'}, ${Object.keys(p.questions).length} question(s) préparée(s).`] });
  if (spec.entree_llm) steps.push({ mod: 'llm_in', titre: 'LLM d\'entrée', cargo: c1,
    note: `Dans n8n, ${spec.entree_llm.model} réécrit la demande et remplace etat_pour_jev par son texte. Il n'est pas appelé dans ce test : le chargement ne change pas ici.`,
    trace: [`✍ LLM d'entrée (${spec.entree_llm.model}) : non appelé en test, état conservé.`] });
  let c2 = c1;
  if (ctx.build.uses_jev) {
    if (err) {
      steps.push({ mod: 'jev', titre: 'Cabine de l\'aiguilleur', cargo: { ...c1, erreur_jev: err }, note: 'Jev n\'a pas répondu : le wagon partira sur la voie de secours.', trace: ['⚠ ' + err, `En production : voie de secours « ${spec.decision.error_route} ».`] });
      return steps;
    }
    const rep = Object.fromEntries(Object.entries(res.answers || {}).map(([id, a]) => [id, answerText(a, p.questions[id])]));
    c2 = { ...c1, reponses_jev: rep };
    steps.push({ mod: 'jev', titre: 'Cabine de l\'aiguilleur (Jev)', cargo: c2,
      note: 'Jev ajoute une réponse chiffrée par question, en un seul appel. Il ne réécrit pas le message : il le juge.',
      trace: [`🧠 Cabine : ${Object.keys(rep).length} question(s) en 1 appel (${res.model})${res.usage ? ' · ' + res.usage.input_tokens + ' tokens · ' + (res.usage.input_tokens * JEV_PRICE_PER_TOKEN).toFixed(6).replace('.', ',') + ' $' : ''}.`,
        ...Object.entries(rep).slice(0, 8).map(([k, v]) => `   • ${k} : ${v}`)] });
  }
  const verdicts = Object.fromEntries(Object.entries(dec.vars || {}).filter(([k]) => /_verdict$|_retenus$|_nombre$/.test(k)));
  const c3 = { ...c2 };
  if (Object.keys(verdicts).length) c3.verdicts = verdicts;
  const extraCalc = Object.fromEntries(Object.entries(dec.vars || {}).filter(([k]) => !(k in calc) && !/_verdict$|_retenus$|_nombre$|_classement$|_confiance$|_norme$/.test(k) && !(k in (res ? res.answers || {} : {}))));
  if (Object.keys(extraCalc).length) c3.calculs = { ...(c3.calculs || {}), ...extraCalc };
  c3.route = dec.route;
  c3.raison = dec.reason;
  if (dec.extra && Object.keys(dec.extra).length) c3.extra = dec.extra;
  steps.push({ mod: 'decision', titre: 'Aiguillage', cargo: c3,
    note: 'Le code traduit les probabilités en mots (verdicts) avec vos seuils, puis lit les règles dans l\'ordre. La première qui s\'applique écrit la route et la raison sur le wagon.',
    trace: [`🔀 Aiguillage : ${dec.reason} → voie « ${dec.route} ».`] });
  const l = (spec.llms || []).find(x => x.route === dec.route);
  const fin = { route: dec.route, raison: dec.reason, variables: publicVars(dec.vars) };
  if (dec.extra && Object.keys(dec.extra).length) fin.extra = dec.extra;
  if (l) fin.extra = { ...(fin.extra || {}), llm: `(texte rédigé par ${l.model} dans n8n)` };
  steps.push({ mod: 'route:' + dec.route, titre: `Voie « ${dec.route} »`, cargo: fin,
    note: 'Arrivée : voici exactement ce que reçoit l\'agent. Le message, l\'état et les réponses brutes restent dans l\'automate : l\'agent lit un verdict court, c\'est là que se font les économies de tokens.'
      + (l ? ` Sur cette voie, ${l.model} ajoute sa rédaction dans extra.llm.` : ''),
    trace: [`🏁 Arrivée voie « ${dec.route} » (${KIND_LABEL[routeKind(dec.route)]})${l ? ' · ' + l.model + ' y rédige la réponse' : ''}.`] });
  return steps;
}

function flatCargo(o, pre = '', out = {}, depth = 0) {
  for (const [k, v] of Object.entries(o || {})) {
    const path = pre ? pre + '.' + k : k;
    if (v && typeof v === 'object' && !Array.isArray(v) && depth < 2 && Object.keys(v).length) flatCargo(v, path, out, depth + 1);
    else out[path] = typeof v === 'string' ? v : JSON.stringify(v);
  }
  return out;
}
function cargoDiff(a, b) {
  const fa = flatCargo(a), fb = flatCargo(b);
  const lines = [];
  const goneTop = Object.keys(a || {}).filter(k => !(k in (b || {})));
  for (const k of goneTop) lines.push({ t: '-', path: k, to: 'retiré' + (a[k] && typeof a[k] === 'object' ? ' avec tout son contenu' : '') });
  for (const [k, v] of Object.entries(fb)) {
    if (!(k in fa)) lines.push({ t: '+', path: k, to: v });
    else if (fa[k] !== v) lines.push({ t: '~', path: k, from: fa[k], to: v });
  }
  for (const k of Object.keys(fa)) if (!(k in fb) && !goneTop.includes(k.split('.')[0])) lines.push({ t: '-', path: k, to: 'retiré' });
  return lines;
}

function cargoPanel(ctx) {
  const { st } = ctx;
  if (!st.steps) return h('div', { class: 'cargo empty-cargo' }, h('b', { text: 'Chargement du wagon' }), ' ', info('Le contenu du message à chaque station. En pas à pas, chaque nœud montre ce qu\'il ajoute (+), retire (−) ou change (~).'),
    h('span', { class: 'small', text: ' Lancez un test : le contenu du wagon s\'affichera ici, étape par étape.' }));
  const i = st.stepIndex, step = st.steps[i], prev = i > 0 ? st.steps[i - 1].cargo : null;
  const diff = prev ? cargoDiff(prev, step.cargo) : [{ t: '+', path: 'message', to: JSON.stringify(step.cargo.message) }];
  const shownDiff = diff.slice(0, 14);
  const val = v => String(v).length > 90 ? String(v).slice(0, 88) + '…' : String(v);
  return h('div', { class: 'cargo' },
    h('div', { class: 'cargo-head' },
      h('div', {}, h('b', { text: 'Chargement du wagon ' }), info('Le contenu réel du message à cette station, calculé en exécutant le code des nœuds. À droite : ce que ce nœud a changé.')),
      h('div', { class: 'row' },
        h('button', { class: 'small', text: '◀ Précédente', disabled: i === 0, onclick: () => stepTo(ctx, i - 1) }),
        h('span', { class: 'step-pill', text: `Étape ${i + 1} / ${st.steps.length} : ${step.titre}` }),
        h('button', { class: 'small primary', text: 'Suivante ▶', disabled: i >= st.steps.length - 1, onclick: () => stepTo(ctx, i + 1) }),
        i < st.steps.length - 1 ? h('button', { class: 'small ghost', text: 'Jusqu\'au bout ⏭', onclick: () => stepTo(ctx, st.steps.length - 1) }) : null)),
    h('div', { class: 'cargo-grid' },
      h('pre', { class: 'json cargo-json', text: JSON.stringify(step.cargo, null, 2) }),
      h('div', { class: 'stack' },
        h('div', { class: 'small muted', text: step.note }),
        diff.length ? h('div', { class: 'diff' }, shownDiff.map(d => h('div', { class: 'd d-' + ({ '+': 'add', '-': 'del', '~': 'chg' })[d.t] },
          h('span', { class: 'd-sign', text: d.t === '-' ? '−' : d.t }), h('span', { class: 'mono', text: d.path }),
          d.t === '~' ? h('span', {}, ' : ', h('s', { text: val(d.from) }), ' → ', h('b', { text: val(d.to) })) : h('span', { text: ' : ' + val(d.to) }))),
          diff.length > shownDiff.length ? h('div', { class: 'small faint', text: `… et ${diff.length - shownDiff.length} autre(s) changement(s)` }) : null)
          : h('div', { class: 'd d-same', text: '= Aucun changement : ce nœud laisse passer le wagon tel quel.' }))));
}

// Déplacements du wagon ----------------------------------------------------------------------------------

function wagonPoint(ctx, step) {
  const host = ctx.host;
  if (step.mod.startsWith('route:')) {
    const i = ctx.build.routes.indexOf(step.mod.slice(6));
    const path = host.querySelector('#rail-r-' + i);
    if (path) return path.getPointAtLength(path.getTotalLength());
  }
  const x = (ctx.geo.x || {})[step.mod];
  return { x: x ?? 40, y: ctx.geo.mid };
}
function lightUpTo(ctx, x) {
  ctx.host.querySelectorAll('.station:not(.dest)').forEach(s => { const c = s.querySelector('.st-dot'); s.classList.toggle('lit', !!c && Number(c.getAttribute('cx')) <= x + 2); });
}
function placeWagon(ctx) {
  const st = ctx.st;
  const wagon = ctx.host.querySelector('#wagon');
  if (!wagon || !st.steps) return;
  const step = st.steps[st.stepIndex];
  const pt = wagonPoint(ctx, step);
  wagon.setAttribute('transform', `translate(${pt.x} ${pt.y})`);
  lightUpTo(ctx, step.mod.startsWith('route:') ? 9999 : pt.x);
  if (step.mod.startsWith('route:')) ctx.host.querySelectorAll('.station.dest.hit').forEach(s => s.classList.add('arrived'));
}
function tween(dur, fn) {
  return new Promise(done => { const t0 = performance.now(); const tick = now => { const k = Math.min(1, (now - t0) / dur); fn(k < 0.5 ? 2 * k * k : 1 - Math.pow(-2 * k + 2, 2) / 2); if (k < 1) requestAnimationFrame(tick); else done(); }; requestAnimationFrame(tick); });
}
async function rollTo(ctx, fromStep, toStep) {
  const wagon = ctx.host.querySelector('#wagon');
  if (!wagon) return;
  const a = wagonPoint(ctx, fromStep);
  const toRoute = toStep.mod.startsWith('route:');
  const xEnd = toRoute ? ctx.geo.xSwitch : wagonPoint(ctx, toStep).x;
  await tween(Math.max(350, Math.abs(xEnd - a.x) * 2.2), e => { const x = a.x + (xEnd - a.x) * e; wagon.setAttribute('transform', `translate(${x} ${ctx.geo.mid})`); lightUpTo(ctx, x); });
  if (toRoute) {
    const path = ctx.host.querySelector('#rail-r-' + ctx.build.routes.indexOf(toStep.mod.slice(6)));
    if (path) { const len = path.getTotalLength(); await tween(1000, e => { const p = path.getPointAtLength(e * len); wagon.setAttribute('transform', `translate(${p.x} ${p.y})`); }); }
    ctx.host.querySelectorAll('.station.dest.hit').forEach(s => s.classList.add('arrived'));
  }
}
async function stepTo(ctx, i) {
  const st = ctx.st;
  if (!st.steps || i < 0 || i >= st.steps.length || st.animating) return;
  const from = st.steps[st.stepIndex];
  const forward = i > st.stepIndex;
  st.stepIndex = i;
  st.sel = st.steps[i].mod;
  st.animating = forward;
  const wagonBefore = forward ? wagonPoint(ctx, from) : null;
  ctx.redraw();
  if (forward) {
    const wagon = ctx.host.querySelector('#wagon');
    if (wagon) wagon.setAttribute('transform', `translate(${wagonBefore.x} ${wagonBefore.y})`);
    for (let k = st.steps.indexOf(from); k < i; k++) await rollTo(ctx, st.steps[k], st.steps[k + 1]);
    st.animating = false;
  }
}

function computeRun(ctx, input, res, err) {
  const { build } = ctx;
  const code = name => (build.workflow.nodes.find(n => n.name === name) || {}).parameters.jsCode;
  const refs = {};
  const items = build.spec.trigger.type === 'webhook' ? [{ json: { body: input } }] : [{ json: input }];
  const prep = runCode(code(NODE_PREP), items, refs, {});
  refs[NODE_PREP] = prep;
  const p = prep[0].json;
  if (err) return { p, steps: buildSteps(ctx, input, p, null, null, err) };
  const dec = runCode(code(NODE_DECIDE), build.uses_jev ? [{ json: res }] : prep, refs, {})[0].json;
  return { p, dec, steps: buildSteps(ctx, input, p, res, dec) };
}

async function sceneRun(ctx, simulate) {
  const { st, build } = ctx;
  const spec = build.spec;
  const input = toInput(ctx, st.inputText ?? JSON.stringify(spec.sample && !Array.isArray(spec.sample) ? spec.sample : (spec.sample || [])[0] || {}));
  st.inputObj = input;
  let res = null, err = null, p = null;
  try {
    const code = name => (build.workflow.nodes.find(n => n.name === name) || {}).parameters.jsCode;
    const items = spec.trigger.type === 'webhook' ? [{ json: { body: input } }] : [{ json: input }];
    p = runCode(code(NODE_PREP), items, {}, {})[0].json;
    if (build.uses_jev) {
      const qids = Object.keys(p.questions);
      if (simulate) {
        st.simAnswers = st.simAnswers && Object.keys(st.simAnswers).join() === qids.join() ? st.simAnswers : defaultAnswers(p.questions);
        res = { model: 'simulation', answers: clone(st.simAnswers) };
      } else if (!qids.length) res = { model: 'aucune question', answers: {} };
      else res = await api('POST', '/api/jev/ask', { state: p.state, questions: p.questions, model: spec.model, provider: spec.jev_provider });
    }
  } catch (e) { err = e.message; }
  try {
    const r = computeRun(ctx, input, res, err);
    st.steps = r.steps;
    st.result = r.dec ? { prep: r.p, jev: res || { answers: {} }, decision: r.dec } : null;
  } catch (e) {
    st.steps = [{ mod: 'gare', titre: 'Gare de départ', cargo: { message: input }, note: e.message, trace: ['⚠ ' + e.message] }];
    st.result = null;
  }
  st.lastJev = res;
  st.trace = null;
  if (st.pas) { st.stepIndex = 0; st.sel = 'gare'; ctx.redraw(); return; }
  const last = st.steps.length - 1;
  st.stepIndex = 0;
  ctx.redraw();
  await stepTo(ctx, last);
}

// Rejoue la décision sur le dernier wagon, avec les réponses de Jev déjà reçues : aucun nouvel appel.
function sceneReplay(ctx) {
  const { st, build } = ctx;
  if (!st.result || !st.inputObj || !build) return;
  try {
    const before = st.result.decision.route;
    const r = computeRun(ctx, st.inputObj, st.lastJev, null);
    st.result = { prep: r.p, jev: st.lastJev || { answers: {} }, decision: r.dec };
    const keep = st.stepIndex >= (st.steps || []).length - 1;
    st.steps = r.steps;
    st.stepIndex = keep ? st.steps.length - 1 : Math.min(st.stepIndex, st.steps.length - 1);
    const last = st.steps[st.steps.length - 1];
    last.trace = [...last.trace, `↻ Réglage modifié, décision rejouée sans nouvel appel : voie « ${r.dec.route} »${before !== r.dec.route ? ' (avant : « ' + before + ' »)' : ''}.`];
  } catch (e) { /* fiche en cours d'édition */ }
}

function sideTabs(ctx) {
  const pick = v => { ctx.st.panel = v; ctx.redraw(); };
  const on = ctx.st.panel === 'reglage';
  return h('div', { class: 'seg side-tabs' },
    h('button', { class: on ? '' : 'on', text: '🔎 Module choisi', onclick: () => pick('module') }),
    h('button', { class: on ? 'on' : '', text: '🎛 Salle de réglage', onclick: () => pick('reglage') }));
}

function renderScene(ctx) {
  const host = clear(ctx.host);
  if (!ctx.build) { put(host, h('div', { class: 'card empty', text: 'Complétez l\'automate : la vue graphique apparaîtra dès qu\'il est valide.' })); return; }
  put(host,
    tuto('graph', 'lire la voie ferrée', [
      ['La ', h('b', { text: 'gare' }), ' reçoit le message (le ', h('b', { text: 'wagon' }), '). Les ', h('b', { text: 'ateliers' }), ' le préparent.'],
      ['La ', h('b', { text: 'cabine de l\'aiguilleur' }), ' est Jev : il répond aux questions, les jauges montrent ses probabilités.'],
      ['L\'', h('b', { text: 'aiguillage' }), ' applique vos règles et envoie le wagon sur une voie : ', h('span', { class: 'badge k-auto', text: 'verte, automatique' }), ' ', h('span', { class: 'badge k-review', text: 'orange, humain' }), ' ', h('span', { class: 'badge k-block', text: 'rouge, blocage' }), '.'],
      ['Cochez « Pas à pas » en bas et lancez : le wagon s\'arrête à chaque station, l\'encart « Chargement du wagon » montre ce que le nœud a ajouté (+), retiré (−) ou changé (~).'],
    ]),
    h('div', { class: 'scene' },
      h('div', { class: 'scene-main' }, sceneGauges(ctx), h('div', { class: 'scene-track' }, sceneSvg(ctx)), cargoPanel(ctx)),
      h('aside', { class: 'scene-side' }, ctx.salle ? sideTabs(ctx) : null, ctx.salle && ctx.st.panel === 'reglage' ? ctx.salle(ctx) : moduleCard(ctx))),
    sceneConsole(ctx));
  if (ctx.st.steps && !ctx.st.animating) placeWagon(ctx);
}

function viewToggle(current, onPick) {
  return h('div', { class: 'seg', role: 'tablist' },
    h('button', { class: current === 'form' ? 'on' : '', text: 'Formulaire', onclick: () => onPick('form') }),
    h('button', { class: current === 'graph' ? 'on' : '', text: 'Vue graphique', onclick: () => onPick('graph') }));
}

// Démarrage -------------------------------------------------------------------------------------------

(async () => {
  try { await loadState(); } catch (e) { put($('#main'), h('div', { class: 'notice err', text: 'Serveur injoignable : ' + e.message })); return; }
  route();
})();
