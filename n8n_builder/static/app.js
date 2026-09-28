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
    const e = new Error((data && (typeof data.detail === 'string' ? data.detail : JSON.stringify(data.detail))) || `Erreur ${r.status}`);
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

const PAGES = { jev: renderJevLab, atelier: renderAtelier, modeles: renderModels, n8n: renderN8n, guide: renderGuide };
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
  s.llm = s.llm || null;
  s.model = s.model || 'jev-latest';
  return s;
}

async function loadTemplate(tid) {
  const t = await api('GET', `/api/templates/${tid}`);
  S.spec = emptySpec(t.spec); S.tplId = tid; S.savedId = null; S.test = null; S.manual = null;
  applyDefaultLlm();
  renderAtelier($('#main'));
}

function applyDefaultLlm() {
  const l = S.spec.llm;
  if (!l) return;
  const p = provider(l.provider);
  if (l.model === 'openrouter/auto' && p && p.default_model) l.model = p.default_model;
}

async function loadSaved(wid) {
  const w = await api('GET', `/api/workflows/${wid}`);
  S.spec = emptySpec(w.spec); S.savedId = wid; S.tplId = null; S.test = null; S.manual = null;
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
}, 350);
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
        h('button', { onclick: saveSpec, text: 'Enregistrer' }),
        h('button', { onclick: () => S.build && download(slug(S.spec.name) + '.json', S.build.workflow), text: 'Télécharger le JSON' }),
        h('button', { onclick: () => S.build && openHubExport({ spec: S.spec }), text: 'Exporter vers le Hub' }),
        h('button', { class: 'primary', onclick: () => openPush(), text: 'Envoyer vers n8n' }))),
    h('div', { class: 'workbench' },
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
  put(ed, assistantCard());
  put(ed, h('div', { class: 'card stack' },
    field('Nom du workflow', inputEl(s.name, v => { s.name = v; changed(); })),
    field('Description', textArea(s.description, v => { s.description = v; changed(); }, { rows: 2 })),
    s.hub && s.hub.playlist ? h('div', { class: 'notice info' },
      h('b', { text: 'Hub d\'agents : ' }), `playlist ${s.hub.playlist}${s.hub.agent ? ', agent ' + s.hub.agent : ''}. `,
      s.hub.allege ? 'Allège l\'agent : ' + s.hub.allege : '') : null));
  const tpl = S.data.templates.find(t => t.id === S.tplId);
  if (tpl && tpl.source) put(ed, h('p', { class: 'small faint', text: 'Inspiré de : ' + tpl.source + '. Réécrit en déterministe et vérifié dans n8n.' }));
  put(ed, triggerCard(), dataCard(), questionsCard(), decisionCard(), llmCard(), sampleCard());
}

function assistantCard() {
  const chat = chatProviders().filter(p => p.configured);
  const st = S.assist = S.assist || { provider: (chat[0] || {}).id || 'openrouter', model: '', description: '', context: '' };
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
  const fill = () => { clear(dl); for (const m of (S.models[pid] || []).slice(0, 600)) dl.append(h('option', { value: m.id, label: m.name !== m.id ? m.name : '' })); };
  fill(); ensureModels(pid).then(fill);
  return h('div', {}, inp, dl);
}
async function ensureModels(pid) {
  if (S.models[pid]) return S.models[pid];
  try { S.models[pid] = (await api('GET', `/api/providers/${pid}/models`)).models; } catch { S.models[pid] = []; }
  return S.models[pid];
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
        field('Modèle Jev', selectEl(S.data.jev_models, s.model, v => { s.model = v; changed(); }), 'w180'),
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

function llmCard() {
  const s = S.spec, l = s.llm;
  const chat = chatProviders();
  const card = h('div', { class: 'card stack' }, h('div', { class: 'section-title' }, h('h2', { text: '5. LLM de secours sur une route' }),
    h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: !!l, onchange: e => {
      const p = chat.find(x => x.configured) || chat[0];
      s.llm = e.target.checked ? { route: currentRoutes()[0], provider: p.id, model: p.default_model || '', system: 'Tu traites les cas que les règles déterministes n\'ont pas su trancher. Réponds brièvement, en français.' } : null;
      changed(true);
    } }), 'Activer')));
  if (!l) { put(card, h('p', { class: 'small muted', text: 'Facultatif. Un LLM n\'est appelé que pour la route choisie (rédiger un brouillon, résumer) : les autres routes restent sans modèle génératif.' })); return card; }
  put(card, h('div', { class: 'row' },
    field('Route', selectEl(currentRoutes(), l.route, v => { l.route = v; changed(); }), 'w180'),
    field('Fournisseur', selectEl(chat.map(p => [p.id, p.label + (p.configured ? '' : ' (non configuré)')]), l.provider, v => { l.provider = v; l.model = (provider(v) || {}).default_model || ''; changed(true); }), 'w240'),
    field('Modèle', modelInput(l.provider, l.model, v => { l.model = v; changed(); }), 'grow')),
  field('Consigne système', textArea(l.system, v => { l.system = v; changed(); }, { rows: 3 })),
  l.provider === 'ollama_local' ? h('p', { class: 'small muted', text: 'Ollama local : dans n8n sous Docker, l\'adresse par défaut est http://host.docker.internal:11434/v1. Modifiable ci-dessous.' }) : null,
  h('details', { open: l.base_url ? true : null }, h('summary', { text: 'Adresse de l\'API (compatible OpenAI)' }),
    inputEl(l.base_url, v => { l.base_url = v; changed(); }, { placeholder: (provider(l.provider) || {}).base_url })));
  return card;
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
  const main = wf.nodes.filter(n => n.type !== 'n8n-nodes-base.stickyNote' && !n.name.startsWith('Route : ') && ![ 'LLM de secours', 'Fusion LLM', 'Répondre' ].includes(n.name)).sort((a, c) => a.position[0] - c.position[0]);
  const kind = n => n.name.startsWith('Jev') ? 'jev' : (n.type.endsWith('.code') ? 'code' : '');
  const flow = h('div', { class: 'flow' });
  main.forEach((n, i) => { if (i) put(flow, h('div', { class: 'farrow', text: '↓' })); put(flow, h('div', { class: 'fnode ' + kind(n) }, h('span', { text: n.name }), h('span', { class: 'faint', text: n.type.split('.').pop() }))); });
  const hit = S.test && S.test.decision && S.test.decision.route;
  put(flow, h('div', { class: 'farrow', text: '↓' }), h('div', { class: 'routes' }, b.routes.map(r => h('span', { class: 'route' + (r === hit ? ' hit' : '') + (spec.llm && spec.llm.route === r ? ' llm' : ''), text: r }))));
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
  const jevReady = (provider('typesafe') || {}).configured;
  const card = h('div', { class: 'card stack' }, h('h2', { text: 'Tester avec l\'exemple' }),
    h('p', { class: 'small muted', text: 'Le test exécute ici le code exact des nœuds n8n générés. ' + (usesJev ? 'Jev est appelé avec votre clé, ou remplacé par des réponses saisies à la main.' : 'Aucun appel à Jev : tout est calculé.') }),
    h('div', { class: 'row' },
      usesJev ? h('button', { class: 'primary', disabled: !jevReady, title: jevReady ? '' : 'Clé TypeSafe à renseigner dans Modèles LLM', text: 'Tester avec Jev', onclick: () => runTest('jev') }) : h('button', { class: 'primary', text: 'Exécuter', onclick: () => runTest('code') }),
      usesJev ? h('button', { text: 'Réponses manuelles', onclick: () => runTest('manual') }) : null,
      usesJev && !jevReady ? h('a', { class: 'small', href: '#modeles', text: 'Ajouter la clé TypeSafe' }) : null));
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
    else try { res = await api('POST', '/api/jev/ask', { state: p.state, questions: p.questions, model: spec.model }); }
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
    payload: () => ({ spec: S.spec }), trigger: S.build.spec.trigger.type,
    save: async () => { if (!S.savedId) { const r = await api('POST', '/api/workflows', { spec: S.spec }); S.savedId = r.id; } return S.savedId; },
    after: () => renderLibrary(),
  };
}

async function openPush(ctx = atelierPushCtx()) {
  if (!ctx) return toast('Corrigez la spécification avant l\'envoi.', true);
  const dlg = $('#dialog');
  const insts = S.data.instances;
  const spec = { trigger: { type: ctx.trigger } };
  const st = { iid: (insts[0] || {}).id, activate: spec.trigger.type !== 'manual', creds: true, update: '' };
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

// Modèles LLM -----------------------------------------------------------------------------------------

async function renderModels(main) {
  put(main, h('div', { class: 'page-head' }, h('div', {}, h('h1', { text: 'Modèles LLM' }),
    h('p', { class: 'muted', text: 'Clés chiffrées sur ce serveur, jamais renvoyées à l\'interface. Listes de modèles lues en direct chez chaque fournisseur.' }))));
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
    p.error ? h('div', { class: 'notice err small', text: p.error }) : null,
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
        h('td', {}, m.id === p.default_model ? h('span', { class: 'badge accent', text: 'par défaut' }) : h('button', { class: 'small ghost', text: 'Par défaut', onclick: async () => {
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
            h('td', {}, h('span', { class: 'badge ' + (w.active ? 'ok' : ''), text: w.active ? 'actif' : 'inactif' })))))) : h('p', { class: 'small muted', text: 'Aucun workflow.' }));
        } catch (e) { put(clear(wfBox), h('div', { class: 'notice err small', text: e.message })); }
      } }),
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
  const st = J.assist = J.assist || { provider: (chat[0] || {}).id, model: '', description: '', context: '' };
  if (!st.model && st.provider) st.model = (provider(st.provider) || {}).default_model || '';
  return st;
}

async function loadFicheType(fid) {
  const f = await api('GET', `/api/jevlab/fiches/${fid}`);
  J.fiche = f.fiche; J.fid = fid; J.savedId = null; J.bench = null; J.calib = null; J.essai = null;
  renderJevLab($('#main'));
}
async function loadSavedFiche(id) {
  const f = await api('GET', `/api/jevlab/saved/${id}`);
  J.fiche = f.fiche; J.savedId = id; J.fid = null; J.bench = null; J.calib = null; J.essai = null;
  renderJevLab($('#main'));
}

async function renderJevLab(main) {
  if (!J.fiche) { const f = await api('GET', '/api/jevlab/fiches/tri-emails'); J.fiche = f.fiche; J.fid = 'tri-emails'; }
  clear(main);
  put(main,
    h('div', { class: 'page-head' },
      h('div', {}, h('h1', { text: 'Labo Jev' }),
        h('p', { class: 'muted', text: 'Réglez un automate de décision case par case. L\'IA propose et explique, vous ajustez, le banc d\'essai vérifie. À l\'exécution, aucun LLM : Jev et des règles.' })),
      h('div', { class: 'row' },
        h('button', { text: 'Enregistrer', onclick: saveFiche }),
        h('button', { text: 'Ouvrir dans le Labo n8n', title: 'Mode expert : la même logique, tous les réglages', onclick: openInN8nLab }),
        h('button', { text: 'Exporter vers le Hub', onclick: () => openHubExport({ fiche: J.fiche }) }),
        h('button', { class: 'primary', text: 'Envoyer vers n8n', onclick: () => openPush(jevPushCtx()) }))),
    h('div', { class: 'workbench' },
      h('aside', { class: 'library', id: 'jlib' }), h('section', { id: 'jed' }), h('aside', { class: 'preview', id: 'jside' })));
  renderJevLibrary(); renderJevEditor(); jRecompile();
}

function jevPushCtx() {
  if (!J.compiled || J.errors) return null;
  return { payload: () => ({ fiche: J.fiche }), trigger: J.compiled.spec.trigger.type, save: async () => null };
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
  put(ed, jAssistCard(),
    h('div', { class: 'card stack' },
      field('Nom de l\'automate', inputEl(f.name, v => { f.name = v; jChanged(); })),
      h('div', { class: 'row between' }, h('label', { text: 'Ce que l\'automate décide', style: 'margin:0' }), originBadge('objectif')),
      textArea(f.objectif, v => { f.objectif = v; touch('objectif'); }, { rows: 2 }), whyBox('objectif')),
    jEntreeCard(), jQuestionsCard(), jResultatsCard(), jReglesCard(), jTestsCard());
}

function jAssistCard() {
  const st = jAssist();
  const chat = chatProviders().filter(p => p.configured);
  const status = h('div', { class: 'small muted' });
  const run = async improve => {
    status.textContent = 'L\'IA remplit les cases et explique ses choix…';
    try {
      const r = await api('POST', '/api/jevlab/fill', { provider: st.provider, model: st.model, description: st.description, context: st.context, fiche: improve ? J.fiche : null });
      J.fiche = r.fiche; J.fid = null; J.savedId = improve ? J.savedId : null; J.bench = null; J.calib = null;
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
    h('p', { class: 'small muted', text: 'Toutes les questions partent en un seul appel à Jev. Une question = un seul jugement.' }));
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
    put(el, seuilHead('Tranches de pourcentage'), bars,
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
      h('button', { class: 'primary small', text: 'Tout tester avec Jev', disabled: !(provider('typesafe') || {}).configured || !f.tests.length, onclick: () => runBench(status) }),
      status,
      J.bench ? h('b', { text: `${J.bench.ok} / ${J.bench.rows.length} conformes` }) : null));
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
  else if (Object.keys(p.questions).length) res = await api('POST', '/api/jev/ask', { state: p.state, questions: p.questions, model: J.compiled.spec.model });
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
  J.bench = { rows, ok };
  J.calib = calibrate(rows);
  status.textContent = '';
  renderJevEditor(); renderJevSide();
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
  const jevReady = (provider('typesafe') || {}).configured;
  const input = textArea(J.essaiInput ?? JSON.stringify(J.fiche.exemple, null, 2), v => { J.essaiInput = v; }, { rows: 4, class: 'code' });
  const card = h('div', { class: 'card stack' }, h('h2', { text: 'Essai direct' }),
    h('p', { class: 'small muted', text: 'Un texte, ou un objet JSON. Le test exécute le code exact de l\'automate.' }), input,
    h('div', { class: 'row' },
      h('button', { class: 'primary', disabled: !jevReady || !J.compiled, text: 'Tester avec Jev', onclick: () => runEssai('jev') }),
      h('button', { disabled: !J.compiled, text: 'Simuler les réponses', onclick: () => runEssai('manual') }),
      !jevReady ? h('a', { class: 'small', href: '#modeles', text: 'Ajouter la clé TypeSafe' }) : null));
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

// Démarrage -------------------------------------------------------------------------------------------

(async () => {
  try { await loadState(); } catch (e) { put($('#main'), h('div', { class: 'notice err', text: 'Serveur injoignable : ' + e.message })); return; }
  route();
})();
