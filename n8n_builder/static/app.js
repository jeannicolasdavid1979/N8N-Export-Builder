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

const PAGES = { atelier: renderAtelier, modeles: renderModels, n8n: renderN8n, guide: renderGuide };
function currentPage() { const p = location.hash.replace('#', '').split('/')[0]; return PAGES[p] ? p : 'atelier'; }
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
      h('div', {}, h('h1', { text: 'Atelier de workflows' }),
        h('p', { class: 'muted', text: "L'IA conçoit une fois, le code et Jev exécutent mille fois : mêmes entrées, même décision." })),
      h('div', { class: 'row' },
        h('button', { onclick: saveSpec, text: 'Enregistrer' }),
        h('button', { onclick: () => S.build && download(slug(S.spec.name) + '.json', S.build.workflow), text: 'Télécharger le JSON' }),
        h('button', { class: 'primary', onclick: openPush, text: 'Envoyer vers n8n' }))),
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
  for (const fam of ['Playlists du Hub', 'Primitives Jev', 'Départ']) {
    if (!fams[fam]) continue;
    put(lib, h('h3', { text: fam, style: 'margin-top:14px' }));
    for (const t of fams[fam]) {
      put(lib, h('button', { class: 'tpl' + (S.tplId === t.id ? ' active' : ''), onclick: () => loadTemplate(t.id) },
        h('b', { text: t.name }),
        h('span', { class: 'small', text: t.hub && t.hub.playlist ? 'Playlist : ' + t.hub.playlist : t.description.slice(0, 110) }),
        h('span', { class: 'tags' },
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
  const usesJev = Object.keys(spec.questions).length > 0;
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
    try { res = await api('POST', '/api/jev/ask', { state: p.state, questions: p.questions, model: spec.model }); }
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
    else if (a.type === 'choice') ctl = h('div', { class: 'row' }, selectEl(Object.keys(q.criteria), a.choice, v => { a.choice = v; }, { style: 'flex:1' }),
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

async function openPush() {
  if (!S.build || S.errors) return toast('Corrigez la spécification avant l\'envoi.', true);
  const dlg = $('#dialog');
  const insts = S.data.instances;
  const spec = S.build.spec;
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
          if (!S.savedId) { const r = await api('POST', '/api/workflows', { spec: S.spec }); S.savedId = r.id; }
          const r = await api('POST', `/api/n8n/${st.iid}/push`, { spec: S.spec, activate: st.activate, create_credentials: st.creds, update_id: st.update || null, saved_id: S.savedId });
          put(clear(result), pushResult(r));
          delete S.instWorkflows[st.iid];
          await loadState(); renderLibrary();
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
      h('li', { text: 'Choisissez un modèle de la famille « Playlists du Hub » ou décrivez votre besoin à l\'assistant.' }),
      h('li', { text: 'Testez avec l\'exemple, ajustez les seuils, enregistrez.' }),
      h('li', { text: 'Envoyez vers votre instance n8n avec la clé d\'en-tête activée. Notez la clé affichée une fois.' }),
      h('li', { text: 'Dans le Hub, Catalogue, Ajouter une API : collez l\'exemple curl et placez la clé au coffre. Ajoutez l\'API à la playlist de l\'agent, en lecture.' }),
      h('li', { text: 'L\'agent appelle le workflow comme un outil et reçoit route, raison et variables. Il agit selon la route, sans refaire le tri.' })),
    h('h2', { text: 'Ce que produit chaque workflow' }),
    P('Déclencheur, préparation en JavaScript lisible, un appel HTTP à Jev avec trois essais, un nœud de décision en JavaScript sans modèle, un aiguillage par route, un nœud vide par route où brancher vos actions, un LLM facultatif sur une seule route, et une réponse JSON pour les webhooks. Uniquement des nœuds du cœur de n8n.'),
    h('h2', { text: 'Sources' }),
    h('ul', {},
      h('li', {}, h('a', { href: 'https://docs.typesafe.ai/api', target: '_blank', rel: 'noopener', text: 'Référence de l\'API TypeSafe' })),
      h('li', {}, h('a', { href: 'https://typesafe.ai/blog/introducing-system-one-models-and-jev', target: '_blank', rel: 'noopener', text: 'Annonce de Jev et des modèles System One' })),
      h('li', {}, h('a', { href: 'https://docs.n8n.io/api/', target: '_blank', rel: 'noopener', text: 'API publique de n8n' })))));
}

// Démarrage -------------------------------------------------------------------------------------------

(async () => {
  try { await loadState(); } catch (e) { put($('#main'), h('div', { class: 'notice err', text: 'Serveur injoignable : ' + e.message })); return; }
  route();
})();
