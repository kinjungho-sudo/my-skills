// 외부 라이브러리는 vendor.js에 묶어 함께 배포한다 (외부 CDN 의존 없음, build-vendor.sh 참고)
import { createClient, marked, DOMPurify, forceSimulation, forceLink, forceManyBody, forceCenter, forceCollide } from './vendor.js';
import { SUPABASE_URL, SUPABASE_KEY } from './config.js';

// 공개 키(publishable)만 사용한다. 실제 접근 통제는 DB의 RLS가 담당한다.
const sb = createClient(SUPABASE_URL, SUPABASE_KEY, { auth: { flowType: 'pkce' } });

const $ = (id) => document.getElementById(id);
const SAVE_DELAY_MS = 1000;
const PREF_ALWAYS_UPDATE = 'sb.alwaysUpdateLinks';

const state = {
  user: null,
  members: new Map(),   // user_id -> display_name
  notes: [],            // 목록용: id, title, updated_at, updated_by, link_keys
  current: null,        // 열려 있는 노트 전체
  dirty: false,
  saveTimer: null,
  saving: false,
  mode: 'edit',
  pendingRevision: null,
  conflict: null,
};

// ---------- 공통 ----------
function show(view) {
  for (const id of ['view-login', 'view-denied', 'view-app']) $(id).hidden = id !== view;
}

function toast(msg, ms = 2500) {
  const el = $('toast');
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(toast.t);
  toast.t = setTimeout(() => { el.hidden = true; }, ms);
}

function nameOf(userId) {
  return state.members.get(userId) || '알 수 없음';
}

function fmtTime(iso) {
  const d = new Date(iso);
  return d.toLocaleString('ko-KR', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

const keyOf = (title) => title.trim().toLowerCase();
const escapeHtml = (s) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function noteByKey(key) {
  return state.notes.find((n) => keyOf(n.title) === key);
}

// ---------- 인증 ----------
async function boot() {
  const { data: { session } } = await sb.auth.getSession();
  await onSession(session);
  sb.auth.onAuthStateChange((_event, s) => {
    if ((s?.user?.id || null) !== (state.user?.id || null)) onSession(s);
  });
}

async function onSession(session) {
  state.user = session?.user || null;
  if (!state.user) return show('view-login');

  // 초대 목록 + Google 인증 계정이면 회원으로 등록된다 (DB 함수가 판단)
  const { data: ok, error } = await sb.rpc('sb_claim_membership');
  if (error || !ok) {
    $('denied-email').textContent = state.user.email || '';
    return show('view-denied');
  }
  show('view-app');
  await loadMembers();
  $('me-name').textContent = nameOf(state.user.id);
  await loadNotes();
  subscribeRealtime();
  const hashId = decodeURIComponent(location.hash.slice(1));
  if (hashId && state.notes.some((n) => n.id === hashId)) openNote(hashId);
}

$('btn-login').onclick = () =>
  sb.auth.signInWithOAuth({ provider: 'google', options: { redirectTo: location.origin + location.pathname } });
$('btn-logout').onclick = $('btn-logout-denied').onclick = async () => {
  await flushSave();
  await sb.auth.signOut();
  location.hash = '';
  show('view-login');
};

// ---------- 데이터 ----------
async function loadMembers() {
  const { data } = await sb.from('sb_members').select('user_id, display_name');
  state.members = new Map((data || []).map((m) => [m.user_id, m.display_name]));
}

async function loadNotes() {
  const { data, error } = await sb
    .from('sb_notes')
    .select('id, title, updated_at, updated_by, link_keys')
    .is('archived_at', null)
    .order('updated_at', { ascending: false });
  if (error) return toast('노트 목록을 불러오지 못했습니다');
  state.notes = data;
  renderList();
  if (state.current) renderLinks();
}

async function fetchNote(id) {
  const { data, error } = await sb.from('sb_notes').select('*').eq('id', id).single();
  if (error) throw error;
  return data;
}

// ---------- 목록 / 검색 ----------
function renderList(items = null) {
  const ul = $('note-list');
  ul.replaceChildren();
  const rows = items || state.notes.map((n) => ({ id: n.id, title: n.title, sub: `${nameOf(n.updated_by)} · ${fmtTime(n.updated_at)}` }));
  for (const r of rows) {
    const li = document.createElement('li');
    li.className = state.current?.id === r.id ? 'active' : '';
    li.innerHTML = `<div class="t">${escapeHtml(r.title)}</div><div class="s">${escapeHtml(r.sub || '')}</div>`;
    li.onclick = () => openNote(r.id);
    ul.append(li);
  }
  if (!rows.length) ul.innerHTML = '<li class="muted">노트가 없습니다</li>';
}

let searchTimer;
$('search').oninput = () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(async () => {
    const q = $('search').value.trim();
    if (!q) return renderList();
    const { data } = await sb.rpc('sb_search', { p_query: q });
    renderList((data || []).map((r) => ({ id: r.id, title: r.title, sub: r.snippet.replace(/\s+/g, ' ') })));
  }, 250);
};

// ---------- 노트 열기 / 만들기 ----------
async function openNote(id) {
  await flushSave();
  try {
    state.current = await fetchNote(id);
  } catch {
    return toast('노트를 열 수 없습니다');
  }
  state.dirty = false;
  state.conflict = null;
  $('conflict-banner').hidden = true;
  $('empty-state').hidden = true;
  $('editor').hidden = false;
  $('note-title').value = state.current.title;
  $('note-content').value = state.current.content;
  location.hash = id;
  renderMeta();
  setMode(state.mode);
  renderList();
  renderLinks();
  loadRevisions();
  if (window.matchMedia('(max-width: 800px)').matches) document.body.classList.remove('sidebar-open');
}

async function createNote(title) {
  let base = (title || '').trim() || '제목 없음';
  let t = base;
  for (let i = 2; noteByKey(keyOf(t)); i++) t = `${base} ${i}`;
  const { data, error } = await sb.from('sb_notes').insert({ title: t, content: '' }).select('id').single();
  if (error) return toast('노트를 만들지 못했습니다');
  await loadNotes();
  await openNote(data.id);
  if (!title) { $('note-title').focus(); $('note-title').select(); }
  else setMode('edit');
}
$('btn-new').onclick = () => createNote('');

function renderMeta() {
  const n = state.current;
  $('note-meta').textContent =
    `만든 사람 ${nameOf(n.created_by)} · 마지막 수정 ${nameOf(n.updated_by)} ${fmtTime(n.updated_at)} · v${n.version}`;
}

// ---------- 편집 / 저장 (버전 비교로 동시 편집 충돌 감지) ----------
$('note-content').addEventListener('input', () => {
  state.dirty = true;
  $('save-status').textContent = '입력 중…';
  clearTimeout(state.saveTimer);
  state.saveTimer = setTimeout(save, SAVE_DELAY_MS);
  updateSuggest();
});

async function save({ force = false } = {}) {
  clearTimeout(state.saveTimer);
  const n = state.current;
  if (!n || !state.dirty || state.saving || state.conflict) return;
  state.saving = true;
  const content = $('note-content').value;
  $('save-status').textContent = '저장 중…';
  let q = sb.from('sb_notes').update({ content }).eq('id', n.id);
  if (!force) q = q.eq('version', n.version);
  const { data, error } = await q.select('*');
  state.saving = false;
  if (error) { $('save-status').textContent = '저장 실패 — 잠시 후 다시 시도합니다'; state.saveTimer = setTimeout(save, 3000); return; }
  if (!data.length) return showConflict();
  state.current = data[0];
  if ($('note-content').value === content) state.dirty = false;
  else state.saveTimer = setTimeout(save, SAVE_DELAY_MS);
  $('save-status').textContent = `저장됨 ${fmtTime(state.current.updated_at)}`;
  renderMeta();
  if (state.mode === 'preview') renderPreview();
  syncListEntry(state.current);
  loadRevisions();
}

async function flushSave() {
  if (state.current && state.dirty && !state.conflict) await save();
}

async function showConflict() {
  const latest = await fetchNote(state.current.id);
  state.conflict = latest;
  $('conflict-text').textContent = `${nameOf(latest.updated_by)}님이 이 노트를 먼저 수정했습니다 (v${latest.version}).`;
  $('conflict-banner').hidden = false;
  $('save-status').textContent = '충돌 — 어떤 내용을 남길지 골라 주세요';
}

$('btn-conflict-theirs').onclick = async () => {
  const latest = state.conflict;
  state.conflict = null;
  $('conflict-banner').hidden = true;
  await openNote(latest.id);
};
$('btn-conflict-mine').onclick = async () => {
  state.current = state.conflict;
  state.conflict = null;
  $('conflict-banner').hidden = true;
  state.dirty = true;
  await save({ force: true });
};

function syncListEntry(n) {
  const i = state.notes.findIndex((x) => x.id === n.id);
  const entry = { id: n.id, title: n.title, updated_at: n.updated_at, updated_by: n.updated_by, link_keys: n.link_keys };
  if (i >= 0) state.notes.splice(i, 1);
  state.notes.unshift(entry);
  if (!$('search').value.trim()) renderList();
  renderLinks();
}

window.addEventListener('beforeunload', (e) => {
  if (state.dirty) { save(); e.preventDefault(); }
});

// ---------- 이름 변경 (Obsidian 방식: 영향 미리보기 → 항상/이번만/안 함) ----------
$('note-title').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { e.preventDefault(); $('note-title').blur(); }
  if (e.key === 'Escape') { $('note-title').value = state.current.title; $('note-title').blur(); }
});
$('note-title').addEventListener('blur', renameCurrent);

async function renameCurrent() {
  const n = state.current;
  if (!n) return;
  const newTitle = $('note-title').value.trim();
  if (!newTitle || newTitle === n.title) { $('note-title').value = n.title; return; }
  if (/[[\]|#^]/.test(newTitle)) { toast('제목에는 [ ] | # ^ 를 쓸 수 없습니다'); $('note-title').value = n.title; return; }
  const dup = noteByKey(keyOf(newTitle));
  if (dup && dup.id !== n.id) { toast('같은 제목의 노트가 이미 있습니다'); $('note-title').value = n.title; return; }
  await flushSave();

  const { data: impact } = await sb.rpc('sb_rename_preview', { p_note: n.id });
  const links = impact?.[0]?.link_count || 0;
  const files = impact?.[0]?.note_count || 0;

  let updateLinks = false;
  if (links > 0) {
    updateLinks = localStorage.getItem(PREF_ALWAYS_UPDATE) === '1' ? true : await askRenameChoice(links, files);
    if (updateLinks === null) updateLinks = false;
  }
  const { data, error } = await sb.rpc('sb_rename_note', { p_note: n.id, p_new_title: newTitle, p_update_links: updateLinks });
  if (error) { toast('이름을 바꾸지 못했습니다'); $('note-title').value = n.title; return; }
  if (data?.links) toast(`링크 ${data.links}개를 노트 ${data.notes}개에서 업데이트했습니다`);
  await loadNotes();
  await openNote(n.id);
}

function askRenameChoice(links, files) {
  const dlg = $('dlg-rename');
  $('rename-impact').textContent = `노트 ${files}개에 있는 링크 ${links}개가 영향을 받습니다.`;
  return new Promise((resolve) => {
    const done = (v) => { dlg.close(); resolve(v); };
    $('btn-rename-always').onclick = () => { localStorage.setItem(PREF_ALWAYS_UPDATE, '1'); done(true); };
    $('btn-rename-once').onclick = () => done(true);
    $('btn-rename-skip').onclick = () => done(false);
    dlg.oncancel = () => resolve(null);
    dlg.showModal();
  });
}

// ---------- 보관 ----------
$('btn-archive').onclick = async () => {
  const n = state.current;
  if (!n || !confirm(`"${n.title}" 노트를 목록에서 보관할까요? (DB에는 남습니다)`)) return;
  await flushSave();
  const { error } = await sb.from('sb_notes').update({ archived_at: new Date().toISOString() }).eq('id', n.id);
  if (error) return toast('보관하지 못했습니다');
  state.current = null;
  location.hash = '';
  $('editor').hidden = true;
  $('empty-state').hidden = false;
  await loadNotes();
};

// ---------- 미리보기 + [[위키링크]] ----------
const WIKILINK = /\[\[([^\]|#^\n]+)([#^][^\]|\n]*)?(?:\|([^\]\n]*))?\]\]/g;

function renderPreview() {
  const src = $('note-content').value.replace(WIKILINK, (_m, target, sub, alias) => {
    const t = target.trim();
    const exists = !!noteByKey(keyOf(t));
    const label = (alias || t + (sub || '')).trim();
    return `<a href="#" class="wikilink${exists ? '' : ' unresolved'}" data-target="${escapeHtml(t)}">${escapeHtml(label)}</a>`;
  });
  $('note-preview').innerHTML = DOMPurify.sanitize(marked.parse(src));
}

$('note-preview').addEventListener('click', (e) => {
  const a = e.target.closest('a');
  if (!a) return;
  if (a.classList.contains('wikilink')) {
    e.preventDefault();
    followLink(a.dataset.target);
  } else if (a.href) {
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
  }
});

async function followLink(title) {
  const n = noteByKey(keyOf(title));
  if (n) return openNote(n.id);
  if (confirm(`"${title}" 노트가 아직 없습니다. 만들까요?`)) createNote(title);
}

function setMode(mode) {
  state.mode = mode;
  $('btn-mode-edit').classList.toggle('active', mode === 'edit');
  $('btn-mode-preview').classList.toggle('active', mode === 'preview');
  $('editor-wrap').hidden = mode !== 'edit';
  $('note-preview').hidden = mode !== 'preview';
  hideSuggest();
  if (mode === 'preview') renderPreview();
}
$('btn-mode-edit').onclick = () => setMode('edit');
$('btn-mode-preview').onclick = () => setMode('preview');

// ---------- [[ 자동완성 ----------
let suggestIdx = 0;
function updateSuggest() {
  const ta = $('note-content');
  const before = ta.value.slice(0, ta.selectionStart);
  const m = before.match(/\[\[([^\]\n|#^]*)$/);
  if (!m) return hideSuggest();
  const q = keyOf(m[1]);
  const items = state.notes.filter((n) => keyOf(n.title).includes(q) && n.id !== state.current?.id).slice(0, 8);
  if (!items.length) return hideSuggest();
  const ul = $('suggest');
  ul.replaceChildren();
  suggestIdx = 0;
  items.forEach((n, i) => {
    const li = document.createElement('li');
    li.textContent = n.title;
    li.className = i === 0 ? 'active' : '';
    li.onmousedown = (e) => { e.preventDefault(); applySuggest(n.title); };
    ul.append(li);
  });
  ul.hidden = false;
}
function hideSuggest() { $('suggest').hidden = true; }
function applySuggest(title) {
  const ta = $('note-content');
  const pos = ta.selectionStart;
  const before = ta.value.slice(0, pos).replace(/\[\[([^\]\n|#^]*)$/, `[[${title}]]`);
  const after = ta.value.slice(pos).replace(/^\]\]/, '');
  ta.value = before + after;
  ta.selectionStart = ta.selectionEnd = before.length;
  hideSuggest();
  ta.dispatchEvent(new Event('input'));
}
$('note-content').addEventListener('keydown', (e) => {
  const ul = $('suggest');
  if (ul.hidden) return;
  const items = [...ul.children];
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault();
    suggestIdx = (suggestIdx + (e.key === 'ArrowDown' ? 1 : items.length - 1)) % items.length;
    items.forEach((li, i) => li.classList.toggle('active', i === suggestIdx));
  } else if (e.key === 'Enter' || e.key === 'Tab') {
    e.preventDefault();
    applySuggest(items[suggestIdx].textContent);
  } else if (e.key === 'Escape') hideSuggest();
});
$('note-content').addEventListener('blur', () => setTimeout(hideSuggest, 100));

// ---------- 백링크 / 나가는 링크 ----------
function renderLinks() {
  const n = state.current;
  if (!n) return;
  const me = state.notes.find((x) => x.id === n.id) || n;
  const myKey = keyOf(me.title);

  const back = state.notes.filter((x) => x.id !== n.id && (x.link_keys || []).includes(myKey));
  fillLinkList($('backlinks'), back.map((x) => ({ label: x.title, onClick: () => openNote(x.id) })), '이 노트를 가리키는 노트가 없습니다');

  const outs = (me.link_keys || []).map((k) => {
    const t = noteByKey(k);
    return t ? { label: t.title, onClick: () => openNote(t.id) } : { label: `${k} (없음)`, ghost: true, onClick: () => followLink(k) };
  });
  fillLinkList($('outlinks'), outs, '[[링크]]가 없습니다');
}

function fillLinkList(ul, items, emptyText) {
  ul.replaceChildren();
  if (!items.length) { ul.innerHTML = `<li class="muted">${emptyText}</li>`; return; }
  for (const it of items) {
    const li = document.createElement('li');
    li.textContent = it.label;
    if (it.ghost) li.classList.add('ghost');
    li.onclick = it.onClick;
    ul.append(li);
  }
}

// ---------- 수정 이력 ----------
async function loadRevisions() {
  const n = state.current;
  if (!n) return;
  const { data } = await sb
    .from('sb_revisions')
    .select('id, version, title, content, edited_by, edited_at')
    .eq('note_id', n.id)
    .order('edited_at', { ascending: false })
    .limit(30);
  fillLinkList($('revisions'), (data || []).map((r) => ({
    label: `${fmtTime(r.edited_at)} · ${nameOf(r.edited_by)} · v${r.version}`,
    onClick: () => openRevision(r),
  })), '이력이 없습니다');
}

function openRevision(r) {
  state.pendingRevision = r;
  $('revision-title').textContent = `${r.title} — v${r.version} (${nameOf(r.edited_by)}, ${fmtTime(r.edited_at)})`;
  $('revision-content').textContent = r.content || '(빈 노트)';
  $('dlg-revision').showModal();
}
$('btn-revision-close').onclick = () => $('dlg-revision').close();
$('btn-revision-restore').onclick = async () => {
  const r = state.pendingRevision;
  $('dlg-revision').close();
  if (!r || r.content === $('note-content').value) return;
  $('note-content').value = r.content;
  state.dirty = true;
  await save();
  if (state.mode === 'preview') renderPreview();
  toast(`v${r.version} 내용으로 되돌렸습니다`);
};

// ---------- 실시간: 상대방의 변경 반영 ----------
function subscribeRealtime() {
  sb.channel('sb_notes_changes')
    .on('postgres_changes', { event: '*', schema: 'public', table: 'sb_notes' }, async (payload) => {
      const row = payload.new;
      await loadNotes();
      if (!row || !state.current || row.id !== state.current.id) return;
      if (row.version <= state.current.version) return;
      if (row.archived_at) { toast(`${nameOf(row.updated_by)}님이 이 노트를 보관했습니다`); return; }
      if (row.updated_by === state.user.id) return;
      if (state.dirty) return showConflict();
      const pos = $('note-content').selectionStart;
      state.current = row;
      $('note-title').value = row.title;
      $('note-content').value = row.content;
      $('note-content').selectionStart = $('note-content').selectionEnd = pos;
      renderMeta();
      if (state.mode === 'preview') renderPreview();
      loadRevisions();
      toast(`${nameOf(row.updated_by)}님이 수정한 내용을 반영했습니다`);
    })
    .subscribe();
}

// ---------- 그래프 뷰 ----------
let graphSim = null;
$('btn-graph').onclick = openGraph;
$('btn-graph-close').onclick = () => { $('dlg-graph').close(); graphSim?.stop(); };

function openGraph() {
  const dlg = $('dlg-graph');
  dlg.showModal();
  const canvas = $('graph-canvas');
  const rect = canvas.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  canvas.width = rect.width * dpr;
  canvas.height = rect.height * dpr;
  const ctx = canvas.getContext('2d');

  const otherName = [...state.members.entries()].find(([id]) => id !== state.user.id)?.[1] || '상대방';
  $('legend-me').textContent = `${nameOf(state.user.id)}이 마지막 수정`;
  $('legend-other').textContent = `${otherName}이 마지막 수정`;

  const nodes = state.notes.map((n) => ({ id: n.id, key: keyOf(n.title), label: n.title, mine: n.updated_by === state.user.id, deg: 0 }));
  const byKey = new Map(nodes.map((n) => [n.key, n]));
  const links = [];
  for (const n of state.notes) {
    for (const k of n.link_keys || []) {
      let t = byKey.get(k);
      if (!t) { t = { id: `ghost:${k}`, key: k, label: k, ghost: true, deg: 0 }; nodes.push(t); byKey.set(k, t); }
      if (t.id === n.id) continue;
      links.push({ source: n.id, target: t.id });
    }
  }
  const byId = new Map(nodes.map((n) => [n.id, n]));
  for (const l of links) { byId.get(l.source).deg++; byId.get(l.target).deg++; }

  const view = { x: 0, y: 0, k: 1 };
  const W = rect.width, H = rect.height;
  const radius = (n) => 4 + Math.min(10, Math.sqrt(n.deg) * 2.5);
  const css = getComputedStyle(document.documentElement);
  const colors = {
    me: css.getPropertyValue('--node-me').trim(),
    other: css.getPropertyValue('--node-other').trim(),
    ghost: css.getPropertyValue('--node-ghost').trim(),
    edge: css.getPropertyValue('--edge').trim(),
    text: css.getPropertyValue('--text').trim(),
    current: css.getPropertyValue('--accent').trim(),
  };

  graphSim?.stop();
  graphSim = forceSimulation(nodes)
    .force('link', forceLink(links).id((d) => d.id).distance(110))
    .force('charge', forceManyBody().strength(-320))
    .force('center', forceCenter(W / 2, H / 2))
    .force('collide', forceCollide().radius((d) => radius(d) + 4))
    .on('tick', draw);

  function draw() {
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);
    ctx.translate(view.x, view.y);
    ctx.scale(view.k, view.k);
    ctx.strokeStyle = colors.edge;
    ctx.lineWidth = 1 / view.k;
    ctx.beginPath();
    for (const l of links) { ctx.moveTo(l.source.x, l.source.y); ctx.lineTo(l.target.x, l.target.y); }
    ctx.stroke();
    ctx.font = `${12 / view.k}px system-ui, sans-serif`;
    ctx.textAlign = 'center';
    for (const n of nodes) {
      ctx.beginPath();
      ctx.arc(n.x, n.y, radius(n), 0, Math.PI * 2);
      ctx.fillStyle = n.ghost ? colors.ghost : n.mine ? colors.me : colors.other;
      ctx.fill();
      if (state.current?.id === n.id) { ctx.strokeStyle = colors.current; ctx.lineWidth = 3 / view.k; ctx.stroke(); }
      ctx.fillStyle = colors.text;
      ctx.fillText(n.label, n.x, n.y + radius(n) + 13 / view.k);
    }
  }

  const toWorld = (e) => {
    const r = canvas.getBoundingClientRect();
    return { x: (e.clientX - r.left - view.x) / view.k, y: (e.clientY - r.top - view.y) / view.k };
  };
  const hit = (p) => nodes.find((n) => (n.x - p.x) ** 2 + (n.y - p.y) ** 2 <= (radius(n) + 4) ** 2);

  let drag = null;
  canvas.onpointerdown = (e) => {
    const p = toWorld(e);
    const n = hit(p);
    drag = n ? { node: n, moved: false } : { pan: true, sx: e.clientX - view.x, sy: e.clientY - view.y, moved: false };
    if (n) { n.fx = n.x; n.fy = n.y; graphSim.alphaTarget(0.2).restart(); }
    canvas.setPointerCapture(e.pointerId);
  };
  canvas.onpointermove = (e) => {
    if (!drag) return;
    drag.moved = true;
    if (drag.node) { const p = toWorld(e); drag.node.fx = p.x; drag.node.fy = p.y; }
    else { view.x = e.clientX - drag.sx; view.y = e.clientY - drag.sy; draw(); }
  };
  canvas.onpointerup = () => {
    if (drag?.node) {
      drag.node.fx = drag.node.fy = null;
      graphSim.alphaTarget(0);
      if (!drag.moved) {
        const n = drag.node;
        dlg.close();
        graphSim.stop();
        if (n.ghost) followLink(n.label); else openNote(n.id);
      }
    }
    drag = null;
  };
  canvas.onwheel = (e) => {
    e.preventDefault();
    const r = canvas.getBoundingClientRect();
    const mx = e.clientX - r.left, my = e.clientY - r.top;
    const k = Math.min(4, Math.max(0.2, view.k * (e.deltaY < 0 ? 1.1 : 0.9)));
    view.x = mx - ((mx - view.x) * k) / view.k;
    view.y = my - ((my - view.y) * k) / view.k;
    view.k = k;
    draw();
  };
}

// ---------- 모바일 사이드바 ----------
$('btn-toggle-sidebar').onclick = () => document.body.classList.toggle('sidebar-open');

boot();
