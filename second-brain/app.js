// Second Brain: Obsidian의 구조(볼트·링크 색인·백링크·그래프·탭 작업공간)를 Supabase 위에 재구성
import { createClient } from './vendor.js';
import { SUPABASE_URL, SUPABASE_KEY } from './config.js';
import { createEditor } from './editor.js';
import { renderInto, headingsOf, tagsOf, stripCode, toggleTask, escapeHtml, WIKILINK_RE } from './render.js';
import { createGraph } from './graph.js';
import { icon } from './icons.js';

// 공개 키(publishable)만 사용한다. 실제 접근 통제는 DB의 RLS가 담당한다.
const sb = createClient(SUPABASE_URL, SUPABASE_KEY, { auth: { flowType: 'pkce' } });

const COLS = 'id,title,folder,content,link_keys,version,created_by,updated_by,created_at,updated_at,archived_at';
const SAVE_DELAY_MS = 800;
const $ = (id) => document.getElementById(id);
const keyOf = (title) => String(title || '').trim().toLowerCase();
const isMobile = () => window.matchMedia('(max-width: 800px)').matches;

// ---------- 설정 ----------
const DEFAULT_SETTINGS = {
  theme: 'dark',              // dark | light | system
  readableWidth: true,
  fontSize: 16,
  defaultMode: 'source',      // source(라이브 프리뷰) | preview(읽기)
  newNoteLocation: 'root',    // root | current
  alwaysUpdateLinks: 'ask',   // ask | always | never
  dailyFolder: 'Daily',
  sort: 'name-asc',
  graph: { tags: false, orphans: true, unresolved: true, authorColors: false, filter: '' },
  localDepth: 1,
  localTags: false,
  leftWidth: 280,
  rightWidth: 300,
};
let settings = loadPref('sb.settings', DEFAULT_SETTINGS);
settings = { ...DEFAULT_SETTINGS, ...settings, graph: { ...DEFAULT_SETTINGS.graph, ...(settings.graph || {}) } };

function loadPref(key, fallback) {
  try { return JSON.parse(localStorage.getItem(key)) ?? fallback; } catch { return fallback; }
}
function savePref(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* 저장 불가 환경 */ }
}
function saveSettings() { savePref('sb.settings', settings); }

// ---------- 상태 ----------
const store = {
  user: null,
  members: new Map(),      // user_id -> display_name
  notes: new Map(),        // id -> row
  byKey: new Map(),        // 소문자 제목 -> row
  folders: new Set(),      // sb_folders
  recent: loadPref('sb.recent', []),
};
const edits = new Map();   // note id -> { text, dirty, timer, saving, lastSent, conflict }
const metaCache = new Map();
let tabs = [];
let activeTab = null;
let expanded = new Set(loadPref('sb.expanded', []));
let others = [];           // presence: [{ user_id, name, note }]

const nameOf = (uid) => store.members.get(uid) || '알 수 없음';
const me = () => store.user?.id;

function textOf(id) {
  const e = edits.get(id);
  return e ? e.text : store.notes.get(id)?.content ?? '';
}

function resolveNote(title) {
  const n = store.byKey.get(keyOf(title));
  return n ? { id: n.id, title: n.title, folder: n.folder, version: n.version, content: textOf(n.id) } : null;
}

function rebuildIndex() {
  store.byKey = new Map([...store.notes.values()].map((n) => [keyOf(n.title), n]));
}

function metaOf(id) {
  const text = textOf(id);
  const c = metaCache.get(id);
  if (c && c.text === text) return c;
  const plain = stripCode(text);
  const links = [...plain.matchAll(WIKILINK_RE)].map((m) => ({ embed: !!m[1], target: m[2].trim(), sub: (m[3] || '').slice(1).trim() }));
  const meta = { text, links, keys: new Set(links.map((l) => keyOf(l.target))), tags: tagsOf(text), headings: headingsOf(text) };
  metaCache.set(id, meta);
  return meta;
}

function allTags() {
  const m = new Map();
  for (const n of store.notes.values()) {
    for (const t of metaOf(n.id).tags) {
      const k = t.toLowerCase();
      const cur = m.get(k) || { name: t, count: 0 };
      cur.count++;
      m.set(k, cur);
    }
  }
  return [...m.values()].sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
}

function touchRecent(id) {
  store.recent = [id, ...store.recent.filter((x) => x !== id)].slice(0, 30);
  savePref('sb.recent', store.recent);
}

// ---------- DOM 도우미 ----------
function el(tag, props = {}, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v == null || v === false) continue;
    if (k === 'class') e.className = v;
    else if (k === 'html') e.innerHTML = v;
    else if (k === 'text') e.textContent = v;
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else if (k === 'dataset') Object.assign(e.dataset, v);
    else e.setAttribute(k, v === true ? '' : v);
  }
  for (const c of kids.flat()) if (c != null && c !== false) e.append(c.nodeType ? c : document.createTextNode(String(c)));
  return e;
}

function iconBtn(name, label, onclick, cls = '') {
  return el('button', { class: `clickable-icon ${cls}`, 'aria-label': label, title: label, html: icon(name), onclick });
}

function notice(msg, ms = 3000) {
  const n = el('div', { class: 'notice', text: msg, onclick: () => n.remove() });
  $('notice-container').append(n);
  setTimeout(() => n.remove(), ms);
}

function fmtTime(iso) {
  return new Date(iso).toLocaleString('ko-KR', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

function relTime(iso) {
  const s = (Date.now() - new Date(iso).getTime()) / 1000;
  if (s < 60) return '방금';
  if (s < 3600) return `${Math.floor(s / 60)}분 전`;
  if (s < 86400) return `${Math.floor(s / 3600)}시간 전`;
  if (s < 86400 * 7) return `${Math.floor(s / 86400)}일 전`;
  return fmtTime(iso);
}

// 퍼지 매칭: 연속으로 맞을수록, 앞에서 맞을수록 점수가 높다
function fuzzy(query, text) {
  const q = query.trim().toLowerCase();
  if (!q) return { score: 0, idx: [] };
  const t = text.toLowerCase();
  const at = t.indexOf(q);
  if (at >= 0) return { score: 1000 - at * 2 + (at === 0 ? 200 : 0) - t.length, idx: [...Array(q.length)].map((_, i) => at + i) };
  let ti = 0, prev = -2, score = 0;
  const idx = [];
  for (const ch of q) {
    if (ch === ' ') continue;
    const f = t.indexOf(ch, ti);
    if (f < 0) return null;
    score += f === prev + 1 ? 8 : 1;
    idx.push(f);
    prev = f;
    ti = f + 1;
  }
  return { score: score - t.length * 0.5, idx };
}

function highlighted(text, idx) {
  const set = new Set(idx);
  const frag = document.createDocumentFragment();
  let buf = '', on = false;
  const flush = () => {
    if (!buf) return;
    frag.append(on ? el('span', { class: 'suggestion-highlight', text: buf }) : document.createTextNode(buf));
    buf = '';
  };
  [...text].forEach((ch, i) => {
    const h = set.has(i);
    if (h !== on) { flush(); on = h; }
    buf += ch;
  });
  flush();
  return frag;
}

// ---------- 모달 / 메뉴 / 팝오버 ----------
let openModalCount = 0;
function openModal({ title, cls = '', content, buttons = [], onClose }) {
  const close = () => {
    container.remove();
    openModalCount--;
    document.removeEventListener('keydown', onKey, true);
    onClose?.();
  };
  const onKey = (e) => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); } };
  const btnRow = buttons.length
    ? el('div', { class: 'modal-button-container' }, buttons.map((b) => el('button', { class: b.cls || '', text: b.text, onclick: () => b.onClick(close) })))
    : null;
  const modal = el('div', { class: `modal ${cls}` },
    el('button', { class: 'modal-close-button clickable-icon', 'aria-label': '닫기', html: icon('x'), onclick: close }),
    title ? el('div', { class: 'modal-title', text: title }) : null,
    el('div', { class: 'modal-content' }, content),
    btnRow);
  const container = el('div', { class: 'modal-container' }, el('div', { class: 'modal-bg', onclick: close }), modal);
  document.body.append(container);
  openModalCount++;
  document.addEventListener('keydown', onKey, true);
  return { close, modal };
}

function promptText({ title, value = '', placeholder = '', okText = '확인' }) {
  return new Promise((resolve) => {
    let done = false;
    const input = el('input', { type: 'text', class: 'modal-input', value, placeholder });
    const finish = (v, close) => { done = true; close(); resolve(v); };
    const m = openModal({
      title,
      content: input,
      buttons: [
        { text: okText, cls: 'mod-cta', onClick: (close) => finish(input.value.trim(), close) },
        { text: '취소', onClick: (close) => finish(null, close) },
      ],
      onClose: () => { if (!done) resolve(null); },
    });
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); finish(input.value.trim(), m.close); } });
    setTimeout(() => { input.focus(); input.select(); }, 0);
  });
}

function confirmModal({ title, text, okText = '확인', danger = false }) {
  return new Promise((resolve) => {
    let done = false;
    openModal({
      title,
      content: el('p', { text }),
      buttons: [
        { text: okText, cls: danger ? 'mod-warning' : 'mod-cta', onClick: (close) => { done = true; close(); resolve(true); } },
        { text: '취소', onClick: (close) => { done = true; close(); resolve(false); } },
      ],
      onClose: () => { if (!done) resolve(false); },
    });
  });
}

function showMenu(e, items) {
  e.preventDefault();
  e.stopPropagation();
  document.querySelector('.menu')?.remove();
  const menu = el('div', { class: 'menu' });
  for (const it of items) {
    if (it === '-') { menu.append(el('div', { class: 'menu-separator' })); continue; }
    menu.append(el('div', {
      class: 'menu-item' + (it.danger ? ' is-warning' : ''),
      onclick: () => { menu.remove(); it.action(); },
    }, el('span', { class: 'menu-item-icon', html: icon(it.icon || 'file', 16) }), el('span', { text: it.label })));
  }
  document.body.append(menu);
  const r = menu.getBoundingClientRect();
  const x = Math.min(e.clientX, window.innerWidth - r.width - 8);
  const y = Math.min(e.clientY, window.innerHeight - r.height - 8);
  menu.style.left = `${Math.max(8, x)}px`;
  menu.style.top = `${Math.max(8, y)}px`;
  const off = (ev) => {
    if (menu.contains(ev.target)) return;
    menu.remove();
    document.removeEventListener('pointerdown', off, true);
  };
  setTimeout(() => document.addEventListener('pointerdown', off, true), 0);
}

// 링크 위에 마우스를 올리면 노트 미리보기 (Obsidian의 Page preview)
const hover = { timer: 0, hideTimer: 0, el: null, anchor: null };
function hoverPreview(anchor, target, sub) {
  if (isMobile() || hover.anchor === anchor) return;
  clearTimeout(hover.timer);
  hover.timer = setTimeout(() => showPopover(anchor, target, sub), 450);
  const leave = () => {
    clearTimeout(hover.timer);
    scheduleHideHover();
    anchor.removeEventListener('mouseleave', leave);
  };
  anchor.addEventListener('mouseleave', leave);
}
function scheduleHideHover() {
  clearTimeout(hover.hideTimer);
  hover.hideTimer = setTimeout(() => { hover.el?.remove(); hover.el = null; hover.anchor = null; }, 300);
}
function showPopover(anchor, target, sub) {
  if (!anchor.isConnected) return;
  const note = resolveNote(target);
  if (!note) return;
  hover.el?.remove();
  const body = el('div', { class: 'markdown-rendered' });
  const pop = el('div', { class: 'popover hover-popover' },
    el('div', { class: 'popover-title' }, el('span', { text: note.title }), note.folder ? el('span', { class: 'muted', text: ` · ${note.folder}` }) : null),
    body);
  renderInto(body, note.content || '*(빈 노트)*', { resolve: resolveNote, depth: 1 });
  pop.addEventListener('mouseenter', () => clearTimeout(hover.hideTimer));
  pop.addEventListener('mouseleave', scheduleHideHover);
  pop.addEventListener('click', (e) => onRenderedClick(e, null));
  document.body.append(pop);
  hover.el = pop;
  hover.anchor = anchor;
  const r = anchor.getBoundingClientRect();
  const pr = pop.getBoundingClientRect();
  let top = r.bottom + 6;
  if (top + pr.height > window.innerHeight - 8) top = Math.max(8, r.top - pr.height - 6);
  pop.style.top = `${top}px`;
  pop.style.left = `${Math.max(8, Math.min(r.left, window.innerWidth - pr.width - 8))}px`;
  if (sub) {
    const h = [...body.querySelectorAll('[data-heading]')].find((x) => x.dataset.heading.toLowerCase() === sub.toLowerCase());
    h?.scrollIntoView({ block: 'start' });
  }
}

// ---------- 인증 ----------
async function boot() {
  applySettings();
  hydrateIcons(document);
  const { data: { session } } = await sb.auth.getSession();
  await onSession(session);
  sb.auth.onAuthStateChange((_event, s) => {
    if ((s?.user?.id || null) !== (store.user?.id || null)) onSession(s);
  });
}

function showView(id) {
  for (const v of ['view-login', 'view-denied', 'view-app']) $(v).hidden = v !== id;
}

let initialized = false;
async function onSession(session) {
  store.user = session?.user || null;
  if (!store.user) return showView('view-login');
  // 초대 목록 + Google 인증 계정이면 회원으로 등록된다 (DB 함수가 판단)
  const { data: ok, error } = await sb.rpc('sb_claim_membership');
  if (error || !ok) {
    $('denied-email').textContent = store.user.email || '';
    return showView('view-denied');
  }
  showView('view-app');
  if (initialized) return;
  initialized = true;
  setupStaticUI();
  await Promise.all([loadMembers(), loadAll()]);
  subscribeRealtime();
  setupPresence();
  restoreWorkspace();
}

$('btn-login').onclick = () =>
  sb.auth.signInWithOAuth({ provider: 'google', options: { redirectTo: location.origin + location.pathname } });
$('btn-logout-denied').onclick = () => logout();

async function logout() {
  await flushAll();
  await sb.auth.signOut();
  location.hash = '';
  location.reload();
}

// ---------- 데이터 ----------
async function loadMembers() {
  const { data } = await sb.from('sb_members').select('user_id, display_name');
  store.members = new Map((data || []).map((m) => [m.user_id, m.display_name]));
}

async function loadAll() {
  const [notesRes, foldersRes] = await Promise.all([
    sb.from('sb_notes').select(COLS).is('archived_at', null),
    sb.from('sb_folders').select('path').is('hidden_at', null),
  ]);
  if (notesRes.error) { notice('노트를 불러오지 못했습니다'); return; }
  const seen = new Set();
  for (const row of notesRes.data) { seen.add(row.id); applyRow(row, { quiet: true }); }
  for (const id of [...store.notes.keys()]) if (!seen.has(id)) removeNote(id);
  store.folders = new Set((foldersRes.data || []).map((f) => f.path));
  rebuildIndex();
  scheduleRefresh(true);
}

function applyRow(row, { quiet = false, own = false } = {}) {
  if (row.archived_at) { removeNote(row.id); return; }
  const old = store.notes.get(row.id);
  if (old && old.version > row.version) return;
  store.notes.set(row.id, row);
  if (!old || old.title !== row.title) rebuildIndex();
  if (!own) syncOpenEditors(row, old);
  updateTabTitles();
  if (!quiet) scheduleRefresh();
}

function removeNote(id) {
  if (!store.notes.has(id)) return;
  store.notes.delete(id);
  edits.delete(id);
  rebuildIndex();
  for (const tab of tabs.filter((t) => t.kind === 'note' && t.noteId === id)) {
    notice(`"${tab.titleText}" 노트가 보관되어 탭을 닫았습니다`);
    closeTab(tab, { skipSave: true });
  }
  scheduleRefresh();
}

// 다른 사람(또는 이름 변경으로 인한 링크 재작성)의 변경을 열린 편집기에 반영
function syncOpenEditors(row, old) {
  const e = edits.get(row.id);
  if (!e) return;
  if (row.content === e.text || row.content === e.lastSent) return;
  if (e.dirty) {
    if (!old || row.version > old.version) showConflict(row);
    return;
  }
  e.text = row.content;
  for (const tab of tabs) {
    if (tab.kind !== 'note' || tab.noteId !== row.id) continue;
    tab.editor?.setText(row.content);
    if (tab.mode === 'preview') renderReading(tab);
  }
  if (row.updated_by !== me()) notice(`${nameOf(row.updated_by)}님이 "${row.title}"을(를) 수정했습니다`, 2000);
}

// ---------- 저장 (version 비교로 동시 편집 충돌 감지) ----------
function onEditorChange(id, text) {
  let e = edits.get(id);
  if (!e) { e = { text, dirty: false }; edits.set(id, e); }
  e.text = text;
  e.dirty = true;
  setSaveStatus('입력 중…');
  clearTimeout(e.timer);
  e.timer = setTimeout(() => save(id), SAVE_DELAY_MS);
  scheduleRefresh();
}

async function save(id, { force = false } = {}) {
  const e = edits.get(id);
  const n = store.notes.get(id);
  if (!e || !n) return;
  clearTimeout(e.timer);
  if (!e.dirty || e.saving || e.conflict) return;
  e.saving = true;
  const text = e.text;
  e.lastSent = text;
  setSaveStatus('저장 중…');
  let q = sb.from('sb_notes').update({ content: text }).eq('id', id);
  if (!force) q = q.eq('version', n.version);
  const { data, error } = await q.select(COLS);
  e.saving = false;
  if (error) {
    setSaveStatus('저장 실패 — 다시 시도합니다');
    e.timer = setTimeout(() => save(id), 3000);
    return;
  }
  if (!data.length) {
    const { data: latest } = await sb.from('sb_notes').select(COLS).eq('id', id).single();
    if (latest) showConflict(latest);
    return;
  }
  applyRow(data[0], { own: true });
  if (e.text === text) e.dirty = false;
  else e.timer = setTimeout(() => save(id), SAVE_DELAY_MS);
  setSaveStatus(e.dirty ? '입력 중…' : '저장됨');
  if (activeNoteId() === id && activePane('right') === 'history') scheduleHistory();
}

async function flushAll() {
  await Promise.all([...edits.entries()].filter(([, e]) => e.dirty && !e.conflict).map(([id]) => save(id)));
}

function showConflict(row) {
  const e = edits.get(row.id);
  if (!e) return;
  e.conflict = row;
  setSaveStatus('충돌');
  for (const tab of tabs) if (tab.kind === 'note' && tab.noteId === row.id) renderConflict(tab);
}

function renderConflict(tab) {
  const e = edits.get(tab.noteId);
  const b = tab.banner;
  if (!e?.conflict) { b.hidden = true; return; }
  const row = e.conflict;
  b.replaceChildren(
    el('span', { text: `${nameOf(row.updated_by)}님이 이 노트를 먼저 수정했습니다 (v${row.version}). 어떤 내용을 남길까요?` }),
    el('button', {
      text: '상대 버전 불러오기',
      onclick: () => {
        e.conflict = null;
        e.dirty = false;
        e.text = row.content;
        store.notes.set(row.id, row);
        for (const t of tabs) if (t.noteId === row.id) { t.editor?.setText(row.content); renderConflict(t); }
        setSaveStatus('상대 버전을 불러왔습니다');
        scheduleRefresh();
      },
    }),
    el('button', {
      class: 'mod-cta',
      text: '내 내용으로 덮어쓰기',
      onclick: () => {
        e.conflict = null;
        store.notes.set(row.id, row);
        for (const t of tabs) if (t.noteId === row.id) renderConflict(t);
        save(row.id, { force: true });
      },
    }),
  );
  b.hidden = false;
}

window.addEventListener('beforeunload', (ev) => {
  if ([...edits.values()].some((e) => e.dirty)) { flushAll(); ev.preventDefault(); }
});

// 편집기가 열려 있으면 편집기를 통해, 아니면 DB에 직접 반영
async function updateNoteContent(id, text) {
  const tab = tabs.find((t) => t.kind === 'note' && t.noteId === id && t.editor);
  if (tab) {
    tab.editor.setText(text);
    onEditorChange(id, text);
    if (tab.mode === 'preview') renderReading(tab);
    return true;
  }
  const n = store.notes.get(id);
  const { data } = await sb.from('sb_notes').update({ content: text }).eq('id', id).eq('version', n.version).select(COLS);
  if (!data?.length) { notice('다른 사람이 먼저 수정해서 반영하지 못했습니다. 다시 시도해 주세요.'); return false; }
  applyRow(data[0]);
  return true;
}

// ---------- 노트 만들기 / 이름 변경 / 이동 / 보관 ----------
function validTitle(t) {
  if (!t) return '제목을 입력해 주세요';
  if (/[[\]|#^\\/:]/.test(t)) return '제목에는 [ ] | # ^ / \\ : 를 쓸 수 없습니다';
  return null;
}

function uniqueTitle(base) {
  let t = base;
  for (let i = 1; store.byKey.has(keyOf(t)); i++) t = `${base} ${i}`;
  return t;
}

function defaultFolder() {
  if (settings.newNoteLocation !== 'current') return '';
  const id = activeNoteId();
  return id ? store.notes.get(id)?.folder || '' : '';
}

async function createNote({ title = '', folder = defaultFolder(), content = '', newTab = false, focusTitle = !title } = {}) {
  const t = uniqueTitle(title.trim() || '제목 없음');
  const { data, error } = await sb.from('sb_notes').insert({ title: t, folder, content }).select(COLS).single();
  if (error) { notice('노트를 만들지 못했습니다'); return null; }
  applyRow(data);
  if (folder) revealFolder(folder);
  await openNote(data.id, { newTab, mode: 'source' });
  const tab = activeTab;
  if (focusTitle && tab?.titleEl) {
    tab.titleEl.focus();
    const range = document.createRange();
    range.selectNodeContents(tab.titleEl);
    const s = getSelection();
    s.removeAllRanges();
    s.addRange(range);
  } else tab?.editor?.focus();
  return data;
}

async function renameNote(id, newTitle) {
  const n = store.notes.get(id);
  if (!n) return false;
  newTitle = newTitle.trim();
  if (newTitle === n.title) return true;
  const err = validTitle(newTitle);
  if (err) { notice(err); return false; }
  const dup = store.byKey.get(keyOf(newTitle));
  if (dup && dup.id !== id) { notice('같은 제목의 노트가 이미 있습니다'); return false; }
  await flushAll();

  // 볼트 전체가 메모리에 있으니, 이 노트를 가리키는 링크가 없으면 서버에 묻지 않는다
  const oldKey = keyOf(n.title);
  const linked = [...store.notes.values()].some((o) => o.id !== id && metaOf(o.id).keys.has(oldKey));
  let links = 0, files = 0;
  if (linked) {
    const { data: impact } = await sb.rpc('sb_rename_preview', { p_note: id });
    links = impact?.[0]?.link_count || 0;
    files = impact?.[0]?.note_count || 0;
  }
  let updateLinks = false;
  if (links > 0) {
    if (settings.alwaysUpdateLinks === 'always') updateLinks = true;
    else if (settings.alwaysUpdateLinks === 'never') updateLinks = false;
    else updateLinks = await askRenameChoice(n.title, newTitle, links, files);
  }
  const { data, error } = await sb.rpc('sb_rename_note', { p_note: id, p_new_title: newTitle, p_update_links: updateLinks });
  if (error) { notice('이름을 바꾸지 못했습니다'); return false; }
  if (data?.links) notice(`노트 ${data.notes}개의 링크 ${data.links}개를 업데이트했습니다`);
  await loadAll();
  return true;
}

function askRenameChoice(oldTitle, newTitle, links, files) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (v, close) => { done = true; close(); resolve(v); };
    openModal({
      title: '링크 업데이트',
      content: el('div', {},
        el('p', { text: `"${oldTitle}" → "${newTitle}"` }),
        el('p', { class: 'muted', text: `노트 ${files}개에 있는 링크 ${links}개가 영향을 받습니다. 링크도 함께 고칠까요?` })),
      buttons: [
        { text: '항상 업데이트', cls: 'mod-cta', onClick: (close) => { settings.alwaysUpdateLinks = 'always'; saveSettings(); finish(true, close); } },
        { text: '이번만 업데이트', onClick: (close) => finish(true, close) },
        { text: '업데이트 안 함', onClick: (close) => finish(false, close) },
      ],
      onClose: () => { if (!done) resolve(false); },
    });
  });
}

async function moveNote(id, folder) {
  const n = store.notes.get(id);
  if (!n || n.folder === folder) return;
  await flushAll();
  const { data, error } = await sb.from('sb_notes').update({ folder }).eq('id', id).select(COLS);
  if (error || !data?.length) { notice('이동하지 못했습니다'); return; }
  applyRow(data[0], { own: true });
  if (folder) { revealFolder(folder); if (!store.folders.has(folder)) ensureFolder(folder); }
  notice(`"${n.title}"을(를) ${folder || '최상위'}(으)로 옮겼습니다`, 2000);
}

async function archiveNote(id) {
  const n = store.notes.get(id);
  if (!n) return;
  const ok = await confirmModal({ title: '노트 보관', text: `"${n.title}" 노트를 보관함으로 옮길까요? 보관함에서 언제든 되돌릴 수 있습니다.`, okText: '보관', danger: true });
  if (!ok) return;
  await flushAll();
  const { error } = await sb.from('sb_notes').update({ archived_at: new Date().toISOString() }).eq('id', id);
  if (error) return notice('보관하지 못했습니다');
  removeNote(id);
}

async function openArchiveList() {
  const { data } = await sb.from('sb_notes').select('id,title,folder,archived_at,updated_by').not('archived_at', 'is', null).order('archived_at', { ascending: false }).limit(200);
  const list = el('div', { class: 'archive-list' });
  if (!data?.length) list.append(el('div', { class: 'pane-empty', text: '보관된 노트가 없습니다' }));
  for (const r of data || []) {
    const row = el('div', { class: 'archive-item' },
      el('div', {}, el('div', { class: 'archive-title', text: r.title }), el('div', { class: 'muted small', text: `${r.folder || '최상위'} · ${fmtTime(r.archived_at)} 보관` })),
      el('button', {
        text: '되돌리기',
        onclick: async () => {
          let title = r.title;
          if (store.byKey.has(keyOf(title))) title = uniqueTitle(title);
          const { data: d, error } = await sb.from('sb_notes').update({ archived_at: null, title }).eq('id', r.id).select(COLS);
          if (error || !d?.length) return notice('되돌리지 못했습니다');
          applyRow(d[0]);
          row.remove();
          notice(`"${title}"을(를) 되돌렸습니다`);
        },
      }));
    list.append(row);
  }
  openModal({ title: '보관함', cls: 'mod-wide', content: list });
}

// ---------- 폴더 ----------
function allFolders() {
  const set = new Set(store.folders);
  for (const n of store.notes.values()) {
    if (!n.folder) continue;
    const parts = n.folder.split('/');
    for (let i = 1; i <= parts.length; i++) set.add(parts.slice(0, i).join('/'));
  }
  for (const f of [...set]) {
    const parts = f.split('/');
    for (let i = 1; i < parts.length; i++) set.add(parts.slice(0, i).join('/'));
  }
  return [...set].sort((a, b) => a.localeCompare(b));
}

async function ensureFolder(path) {
  if (!path || store.folders.has(path)) return true;
  const { error } = await sb.from('sb_folders').upsert({ path, hidden_at: null });
  if (error) { notice('폴더를 만들지 못했습니다'); return false; }
  store.folders.add(path);
  return true;
}

async function createFolder(parent = '') {
  const name = await promptText({ title: parent ? `"${parent}" 안에 새 폴더` : '새 폴더', placeholder: '폴더 이름' });
  if (!name) return;
  if (/[[\]|#^\\/]/.test(name)) return notice('폴더 이름에는 [ ] | # ^ / \\ 를 쓸 수 없습니다');
  const path = parent ? `${parent}/${name}` : name;
  if (await ensureFolder(path)) { revealFolder(path); scheduleRefresh(); }
}

async function renameFolder(path, newPath) {
  if (newPath == null) {
    const parts = path.split('/');
    const name = await promptText({ title: '폴더 이름 바꾸기', value: parts.at(-1) });
    if (!name || name === parts.at(-1)) return;
    if (/[[\]|#^\\/]/.test(name)) return notice('폴더 이름에는 [ ] | # ^ / \\ 를 쓸 수 없습니다');
    newPath = [...parts.slice(0, -1), name].join('/');
  }
  if (allFolders().includes(newPath)) return notice('같은 이름의 폴더가 이미 있습니다');
  await flushAll();
  const { error } = await sb.rpc('sb_rename_folder', { p_old: path, p_new: newPath });
  if (error) return notice('폴더 이름을 바꾸지 못했습니다');
  if (expanded.has(path)) { expanded.delete(path); expanded.add(newPath); }
  await reloadFolders();
  await loadAll();
}

async function reloadFolders() {
  const { data } = await sb.from('sb_folders').select('path').is('hidden_at', null);
  store.folders = new Set((data || []).map((f) => f.path));
}

async function removeFolder(path) {
  const inside = [...store.notes.values()].some((n) => n.folder === path || n.folder.startsWith(path + '/'));
  if (inside) return notice('폴더 안에 노트가 있으면 지울 수 없습니다. 노트를 먼저 옮기거나 보관해 주세요.');
  const now = new Date().toISOString();
  const subs = allFolders().filter((f) => f === path || f.startsWith(path + '/'));
  const { error } = await sb.from('sb_folders').update({ hidden_at: now }).in('path', subs);
  if (error) return notice('폴더를 지우지 못했습니다');
  await reloadFolders();
  scheduleRefresh();
}

function revealFolder(path) {
  const parts = path.split('/');
  for (let i = 1; i <= parts.length; i++) expanded.add(parts.slice(0, i).join('/'));
  savePref('sb.expanded', [...expanded]);
}

// ---------- 링크 따라가기 ----------
async function followLink(target, sub, newTab) {
  const n = resolveNote(target);
  if (n) return openNote(n.id, { newTab, sub });
  // Obsidian처럼 없는 노트를 누르면 바로 만든다
  const err = validTitle(target.trim());
  if (err) return notice(err);
  await createNote({ title: target.trim(), newTab, focusTitle: false });
}

function onRenderedClick(e, tab) {
  const a = e.target.closest('a.internal-link');
  if (a) {
    e.preventDefault();
    followLink(a.dataset.target, a.dataset.sub, e.metaKey || e.ctrlKey);
    return;
  }
  const t = e.target.closest('a.tag');
  if (t) { e.preventDefault(); searchFor(`tag:#${t.dataset.tag}`); }
}

// ---------- 탭 작업공간 ----------
let tabSeq = 0;
function activeNoteId() { return activeTab?.kind === 'note' ? activeTab.noteId : null; }

function createTab(kind = 'empty', { activate = true } = {}) {
  const tab = { id: ++tabSeq, kind, noteId: null, mode: settings.defaultMode, back: [], fwd: [], leaf: el('div', { class: 'workspace-leaf', hidden: true }) };
  const idx = activeTab ? tabs.indexOf(activeTab) + 1 : tabs.length;
  tabs.splice(idx, 0, tab);
  $('leaf-container').append(tab.leaf);
  buildLeaf(tab);
  if (activate) setActiveTab(tab);
  return tab;
}

function buildLeaf(tab) {
  destroyLeafContent(tab);
  tab.leaf.replaceChildren();
  tab.leaf.dataset.kind = tab.kind;
  if (tab.kind === 'note') buildNoteLeaf(tab);
  else if (tab.kind === 'graph') buildGraphLeaf(tab);
  else buildEmptyLeaf(tab);
}

function destroyLeafContent(tab) {
  tab.editor?.destroy();
  tab.editor = null;
  tab.graph?.destroy();
  tab.graph = null;
}

function setActiveTab(tab) {
  activeTab = tab;
  for (const t of tabs) t.leaf.hidden = t !== tab;
  renderTabBar();
  if (tab.kind === 'note') {
    touchRecent(tab.noteId);
    history.replaceState(null, '', `#/n/${tab.noteId}`);
  } else history.replaceState(null, '', location.pathname);
  tab.graph?.redraw();
  updatePresence();
  scheduleRefresh();
  saveWorkspace();
}

function closeTab(tab, { skipSave = false } = {}) {
  if (!skipSave && tab.kind === 'note' && edits.get(tab.noteId)?.dirty) save(tab.noteId);
  const i = tabs.indexOf(tab);
  if (i < 0) return;
  destroyLeafContent(tab);
  tab.leaf.remove();
  tabs.splice(i, 1);
  if (tab.kind === 'note') releaseEdit(tab.noteId);
  if (!tabs.length) { activeTab = null; createTab('empty'); return; }
  if (activeTab === tab) { activeTab = null; setActiveTab(tabs[Math.min(i, tabs.length - 1)]); }
  else renderTabBar();
  saveWorkspace();
}

function releaseEdit(noteId) {
  if (tabs.some((t) => t.kind === 'note' && t.noteId === noteId)) return;
  const e = edits.get(noteId);
  if (e && !e.dirty && !e.saving) edits.delete(noteId);
}

function tabTitle(tab) {
  if (tab.kind === 'note') return store.notes.get(tab.noteId)?.title || '노트';
  if (tab.kind === 'graph') return '그래프 뷰';
  return '새 탭';
}

function renderTabBar() {
  const list = $('tab-list');
  list.replaceChildren();
  for (const tab of tabs) {
    const title = tabTitle(tab);
    tab.titleText = title;
    const viewer = tab.kind === 'note' ? others.find((o) => o.note === tab.noteId) : null;
    const head = el('div', {
      class: 'workspace-tab-header' + (tab === activeTab ? ' is-active' : ''),
      title,
      onclick: () => setActiveTab(tab),
      onauxclick: (e) => { if (e.button === 1) { e.preventDefault(); closeTab(tab); } },
      oncontextmenu: (e) => showMenu(e, [
        { label: '탭 닫기', icon: 'x', action: () => closeTab(tab) },
        { label: '다른 탭 모두 닫기', icon: 'x', action: () => tabs.filter((t) => t !== tab).forEach((t) => closeTab(t)) },
      ]),
    },
    el('span', { class: 'workspace-tab-header-inner-icon', html: icon(tab.kind === 'graph' ? 'graph' : 'file', 15) }),
    el('span', { class: 'workspace-tab-header-inner-title', text: title }),
    viewer ? el('span', { class: 'presence-dot', title: `${viewer.name}님도 보는 중`, text: viewer.name.slice(0, 1) }) : null,
    el('button', { class: 'workspace-tab-header-close clickable-icon', 'aria-label': '탭 닫기', html: icon('x', 14), onclick: (e) => { e.stopPropagation(); closeTab(tab); } }));
    list.append(head);
  }
  list.querySelector('.is-active')?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
}

function updateTabTitles() {
  let changed = false;
  for (const tab of tabs) {
    if (tab.kind !== 'note') continue;
    const n = store.notes.get(tab.noteId);
    if (!n) continue;
    if (tab.titleText !== n.title) changed = true;
    if (tab.titleEl && document.activeElement !== tab.titleEl && tab.titleEl.textContent !== n.title) tab.titleEl.textContent = n.title;
    renderCrumb(tab);
  }
  if (changed) renderTabBar();
}

function saveWorkspace() {
  savePref('sb.workspace', {
    tabs: tabs.map((t) => ({ kind: t.kind, noteId: t.noteId, mode: t.mode })),
    active: tabs.indexOf(activeTab),
  });
}

function restoreWorkspace() {
  const ws = loadPref('sb.workspace', null);
  const hashId = /^#\/n\/(.+)$/.exec(location.hash)?.[1] || location.hash.slice(1);
  for (const t of ws?.tabs || []) {
    if (t.kind === 'note' && !store.notes.has(t.noteId)) continue;
    const tab = createTab(t.kind === 'note' ? 'empty' : t.kind, { activate: false });
    if (t.kind === 'note') loadNoteIntoTab(tab, t.noteId, { mode: t.mode });
  }
  if (hashId && store.notes.has(hashId)) {
    const existing = tabs.find((t) => t.noteId === hashId);
    if (existing) setActiveTab(existing);
    else openNote(hashId, { newTab: true });
  } else if (tabs.length) {
    setActiveTab(tabs[Math.max(0, Math.min(ws?.active ?? 0, tabs.length - 1))]);
  }
  if (!tabs.length) createTab('empty');
}

async function openNote(id, { newTab = false, sub = '', line = null, select = null, mode = null, push = true } = {}) {
  if (!store.notes.has(id)) return;
  const existing = tabs.find((t) => t.kind === 'note' && t.noteId === id);
  let tab;
  if (existing) tab = existing;
  else if (newTab || !activeTab) tab = createTab('empty', { activate: false });
  else tab = activeTab;

  if (tab !== existing) {
    if (tab.kind === 'note' && tab.noteId && push) { tab.back.push(tab.noteId); tab.fwd = []; }
    loadNoteIntoTab(tab, id, { mode });
  } else if (mode && mode !== tab.mode) setMode(tab, mode);
  setActiveTab(tab);
  if (isMobile()) closeDrawers();
  revealFolder(store.notes.get(id).folder || '');
  requestAnimationFrame(() => {
    if (select) tab.editor?.selectRange(select.from, select.to);
    else if (sub) scrollToHeading(tab, sub);
    else if (line != null) tab.editor?.scrollToLine(line);
  });
}

function loadNoteIntoTab(tab, id, { mode = null } = {}) {
  const prev = tab.kind === 'note' ? tab.noteId : null;
  if (prev && prev !== id) {
    if (edits.get(prev)?.dirty) save(prev);
  }
  if (tab.kind !== 'note') { tab.kind = 'note'; tab.noteId = id; buildLeaf(tab); }
  tab.noteId = id;
  if (prev && prev !== id) releaseEdit(prev);
  if (mode) tab.mode = mode;
  mountNote(tab);
  saveWorkspace();
}

function goBack(tab) {
  const id = tab.back.pop();
  if (!id) return;
  if (!store.notes.has(id)) return goBack(tab);
  tab.fwd.push(tab.noteId);
  openNote(id, { push: false });
}
function goForward(tab) {
  const id = tab.fwd.pop();
  if (!id) return;
  if (!store.notes.has(id)) return goForward(tab);
  tab.back.push(tab.noteId);
  openNote(id, { push: false });
}

// ---------- 노트 화면 ----------
function buildNoteLeaf(tab) {
  tab.backBtn = iconBtn('arrow-left', '뒤로 (Ctrl+Alt+←)', () => goBack(tab));
  tab.fwdBtn = iconBtn('arrow-right', '앞으로 (Ctrl+Alt+→)', () => goForward(tab));
  tab.crumb = el('div', { class: 'view-header-title-container' });
  tab.modeBtn = iconBtn('book-open', '', () => toggleMode(tab));
  const more = iconBtn('more', '더 보기', (e) => showNoteMenu(e, tab));
  const header = el('div', { class: 'view-header' },
    el('div', { class: 'view-header-nav-buttons' }, tab.backBtn, tab.fwdBtn),
    tab.crumb,
    el('div', { class: 'view-actions' }, tab.modeBtn, more));
  tab.banner = el('div', { class: 'conflict-banner', hidden: true });
  tab.titleEl = el('div', { class: 'inline-title', contenteditable: 'true', spellcheck: 'false', autocapitalize: 'off' });
  tab.cmHost = el('div', { class: 'cm-host' });
  tab.reading = el('div', { class: 'markdown-rendered markdown-reading-view', hidden: true });
  tab.reading.addEventListener('click', (e) => onRenderedClick(e, tab));
  tab.reading.addEventListener('mouseover', (e) => {
    const a = e.target.closest('a.internal-link');
    if (a) hoverPreview(a, a.dataset.target, a.dataset.sub);
  });
  const footer = el('div', { class: 'note-footer' });
  tab.footer = footer;
  const sizer = el('div', { class: 'view-sizer' }, tab.titleEl, tab.cmHost, tab.reading, footer);
  tab.scroller = el('div', { class: 'view-content' }, sizer);
  // 본문 아래 빈 곳을 누르면 편집기 끝으로
  tab.scroller.addEventListener('mousedown', (e) => {
    if ((e.target === tab.scroller || e.target === sizer || e.target === footer) && tab.mode === 'source' && tab.editor) {
      e.preventDefault();
      const v = tab.editor.view;
      v.dispatch({ selection: { anchor: v.state.doc.length } });
      v.focus();
    }
  });
  tab.leaf.append(header, tab.banner, tab.scroller);

  tab.titleEl.addEventListener('keydown', (e) => {
    if (e.isComposing) return;
    if (e.key === 'Enter') { e.preventDefault(); tab.editor?.focus(); }
    if (e.key === 'Escape') { tab.titleEl.textContent = store.notes.get(tab.noteId)?.title || ''; tab.editor?.focus(); }
  });
  tab.titleEl.addEventListener('paste', (e) => {
    e.preventDefault();
    document.execCommand('insertText', false, e.clipboardData.getData('text/plain').replace(/\n/g, ' '));
  });
  tab.titleEl.addEventListener('blur', async () => {
    const n = store.notes.get(tab.noteId);
    if (!n) return;
    const v = tab.titleEl.textContent.replace(/\s+/g, ' ').trim();
    if (v === n.title) return;
    const ok = await renameNote(n.id, v);
    if (!ok) tab.titleEl.textContent = store.notes.get(n.id)?.title || n.title;
  });
}

function mountNote(tab) {
  const id = tab.noteId;
  const n = store.notes.get(id);
  tab.editor?.destroy();
  if (!edits.has(id)) edits.set(id, { text: n.content, dirty: false });
  tab.titleEl.textContent = n.title;
  tab.editor = createEditor(tab.cmHost, textOf(id), {
    resolve: resolveNote,
    notes: () => {
      const rec = new Map(store.recent.map((r, i) => [r, 30 - i]));
      return [...store.notes.values()].filter((x) => x.id !== id).map((x) => ({ title: x.title, folder: x.folder, recent: rec.get(x.id) || 0 }));
    },
    tags: () => allTags().map((t) => [t.name, t.count]),
    headings: (note) => headingsOf(textOf(note.id)),
    onChange: (text) => {
      onEditorChange(id, text);
      if (tab.mode === 'preview') renderReading(tab);
    },
    onOpenLink: (target, sub, newTab) => followLink(target, sub, newTab),
    onTag: (tag) => searchFor(`tag:#${tag}`),
    onHover: (anchor, target, sub) => hoverPreview(anchor, target, sub),
  });
  renderCrumb(tab);
  renderConflict(tab);
  setMode(tab, tab.mode, { force: true });
  tab.scroller.scrollTop = 0;
  renderTabBar();
}

function renderCrumb(tab) {
  if (!tab.crumb) return;
  const n = store.notes.get(tab.noteId);
  if (!n) return;
  const parts = n.folder ? n.folder.split('/') : [];
  tab.crumb.replaceChildren(
    ...parts.flatMap((p) => [el('span', { class: 'view-header-breadcrumb', text: p }), el('span', { class: 'view-header-breadcrumb-separator', text: '/' })]),
    el('span', { class: 'view-header-title', text: n.title }));
  tab.backBtn.disabled = !tab.back.length;
  tab.fwdBtn.disabled = !tab.fwd.length;
}

function setMode(tab, mode, { force = false } = {}) {
  if (tab.kind !== 'note') return;
  if (!force && tab.mode === mode) return;
  tab.mode = mode;
  const reading = mode === 'preview';
  tab.cmHost.hidden = reading;
  tab.reading.hidden = !reading;
  tab.titleEl.contentEditable = reading ? 'false' : 'true';
  tab.modeBtn.innerHTML = icon(reading ? 'pencil' : 'book-open');
  const label = reading ? '편집 보기로 전환 (Ctrl+E)' : '읽기 보기로 전환 (Ctrl+E)';
  tab.modeBtn.setAttribute('aria-label', label);
  tab.modeBtn.title = label;
  if (reading) renderReading(tab);
  saveWorkspace();
}

function toggleMode(tab = activeTab) {
  if (tab?.kind !== 'note') return;
  setMode(tab, tab.mode === 'preview' ? 'source' : 'preview');
  if (tab.mode === 'source') tab.editor?.focus();
}

function renderReading(tab) {
  const id = tab.noteId;
  renderInto(tab.reading, textOf(id), {
    resolve: resolveNote,
    onToggleTask: (i, checked) => updateNoteContent(id, toggleTask(textOf(id), i, checked)),
  });
}

function scrollToHeading(tab, sub) {
  const h = metaOf(tab.noteId).headings.find((x) => x.text.toLowerCase() === sub.toLowerCase());
  if (!h) return;
  if (tab.mode === 'preview') {
    const target = [...tab.reading.querySelectorAll('[data-heading]')].find((x) => x.dataset.heading.toLowerCase() === sub.toLowerCase());
    target?.scrollIntoView({ block: 'start', behavior: 'smooth' });
  } else tab.editor?.scrollToLine(h.line);
}

function showNoteMenu(e, tab) {
  const id = tab.noteId;
  showMenu(e, [
    { label: tab.mode === 'preview' ? '편집 보기' : '읽기 보기', icon: tab.mode === 'preview' ? 'pencil' : 'book-open', action: () => toggleMode(tab) },
    { label: '이름 바꾸기', icon: 'edit', action: () => focusTitle(tab) },
    { label: '다른 폴더로 이동…', icon: 'move', action: () => pickFolderAndMove(id) },
    { label: '[[링크]] 복사', icon: 'copy', action: () => copyText(`[[${store.notes.get(id).title}]]`) },
    { label: '로컬 그래프 열기', icon: 'graph', action: () => showRightPane('localgraph') },
    { label: '수정 이력', icon: 'history', action: () => showRightPane('history') },
    '-',
    { label: '보관', icon: 'archive', danger: true, action: () => archiveNote(id) },
  ]);
}

function focusTitle(tab = activeTab) {
  if (tab?.kind !== 'note') return;
  if (tab.mode === 'preview') setMode(tab, 'source');
  tab.titleEl.focus();
  const range = document.createRange();
  range.selectNodeContents(tab.titleEl);
  getSelection().removeAllRanges();
  getSelection().addRange(range);
}

async function copyText(text) {
  try { await navigator.clipboard.writeText(text); notice('복사했습니다', 1500); } catch { notice('복사하지 못했습니다'); }
}

// ---------- 빈 탭 ----------
function buildEmptyLeaf(tab) {
  tab.emptyBox = el('div', { class: 'empty-state' });
  tab.leaf.append(el('div', { class: 'view-header' }, el('div', { class: 'view-header-title-container' }, el('span', { class: 'view-header-title', text: '새 탭' }))), tab.emptyBox);
  renderEmpty(tab);
}

function renderEmpty(tab) {
  const box = tab.emptyBox;
  if (!box) return;
  const recent = store.recent.map((id) => store.notes.get(id)).filter(Boolean).slice(0, 8);
  box.replaceChildren(
    el('div', { class: 'empty-state-container' },
      el('div', { class: 'empty-state-title', text: '열린 노트가 없습니다' }),
      el('div', { class: 'empty-state-action-list' },
        el('div', { class: 'empty-state-action', text: '새 노트 만들기 (Alt+N)', onclick: () => createNote() }),
        el('div', { class: 'empty-state-action', text: '노트로 이동 (Ctrl+O)', onclick: () => openSwitcher() }),
        el('div', { class: 'empty-state-action', text: '오늘의 데일리 노트 (Alt+D)', onclick: () => openDaily() }),
        el('div', { class: 'empty-state-action', text: '그래프 뷰 (Ctrl+G)', onclick: () => openGraph() })),
      recent.length ? el('div', { class: 'empty-state-recent' },
        el('div', { class: 'empty-state-subtitle', text: '최근 노트' }),
        recent.map((n) => el('div', { class: 'empty-state-action', onclick: () => openNote(n.id) },
          el('span', { text: n.title }), el('span', { class: 'muted small', text: `  ${relTime(n.updated_at)}` })))) : null));
}

// ---------- 그래프 뷰 탭 ----------
function openGraph() {
  const existing = tabs.find((t) => t.kind === 'graph');
  if (existing) return setActiveTab(existing);
  const tab = activeTab?.kind === 'empty' ? activeTab : createTab('empty', { activate: false });
  tab.kind = 'graph';
  buildLeaf(tab);
  setActiveTab(tab);
  saveWorkspace();
}

function buildGraphLeaf(tab) {
  const canvas = el('canvas', { class: 'graph-canvas' });
  const g = settings.graph;
  const check = (key, label) => el('label', { class: 'graph-control-toggle' },
    el('input', { type: 'checkbox', checked: g[key] || null, onchange: (e) => { g[key] = e.target.checked; saveSettings(); refreshGraph(tab); } }),
    el('span', { text: label }));
  const filter = el('input', { type: 'search', placeholder: '노트 이름으로 거르기…', value: g.filter || '', oninput: (e) => { g.filter = e.target.value; saveSettings(); refreshGraph(tab); } });
  const legend = el('div', { class: 'graph-legend' });
  tab.graphLegend = legend;
  const controls = el('div', { class: 'graph-controls' },
    el('div', { class: 'graph-control-section-title', text: '필터' }),
    filter,
    check('tags', '태그 보기'),
    check('unresolved', '없는 노트 보기'),
    check('orphans', '연결 없는 노트 보기'),
    el('div', { class: 'graph-control-section-title', text: '표시' }),
    check('authorColors', '마지막 수정자별 색'),
    legend,
    el('button', { text: '화면에 맞추기', onclick: () => tab.graph?.fit() }));
  tab.leaf.append(
    el('div', { class: 'view-header' }, el('div', { class: 'view-header-title-container' }, el('span', { class: 'view-header-title', text: '그래프 뷰' }))),
    el('div', { class: 'graph-view' }, canvas, controls));
  tab.graph = createGraph(canvas, {
    onOpen: (node, newTab) => onGraphOpen(node, newTab || true),
    colorOf: (n) => (settings.graph.authorColors && !n.tag && !n.unresolved ? (n.mine ? 'me' : 'other') : null),
  });
  refreshGraph(tab, { keep: false });
}

function onGraphOpen(node, newTab) {
  if (node.tag) return searchFor(`tag:#${node.label.slice(1)}`);
  if (node.unresolved) return followLink(node.label, '', newTab);
  openNote(node.id, { newTab });
}

function graphData({ tags = false, orphans = true, unresolved = true, filter = '', center = null, depth = 1 }) {
  const nodes = new Map();
  const links = [];
  const seen = new Set();
  const cur = activeNoteId();
  for (const n of store.notes.values()) {
    nodes.set(n.id, { id: n.id, label: n.title, mine: n.updated_by === me(), current: n.id === cur });
  }
  const addLink = (a, b) => {
    if (a === b) return;
    const k = a < b ? `${a}|${b}` : `${b}|${a}`;
    if (seen.has(k)) return;
    seen.add(k);
    links.push({ source: a, target: b });
  };
  for (const n of store.notes.values()) {
    const meta = metaOf(n.id);
    for (const l of meta.links) {
      const t = store.byKey.get(keyOf(l.target));
      if (t) addLink(n.id, t.id);
      else if (unresolved) {
        const uid = `u:${keyOf(l.target)}`;
        if (!nodes.has(uid)) nodes.set(uid, { id: uid, label: l.target, unresolved: true });
        addLink(n.id, uid);
      }
    }
    if (tags) {
      for (const t of meta.tags) {
        const tid = `t:${t.toLowerCase()}`;
        if (!nodes.has(tid)) nodes.set(tid, { id: tid, label: `#${t}`, tag: true });
        addLink(n.id, tid);
      }
    }
  }
  let keep = new Set(nodes.keys());
  if (center && nodes.has(center)) {
    const adj = new Map([...nodes.keys()].map((k) => [k, []]));
    for (const l of links) { adj.get(l.source).push(l.target); adj.get(l.target).push(l.source); }
    keep = new Set([center]);
    let frontier = [center];
    for (let d = 0; d < depth; d++) {
      const next = [];
      for (const f of frontier) for (const x of adj.get(f)) if (!keep.has(x)) { keep.add(x); next.push(x); }
      frontier = next;
    }
  }
  if (filter.trim()) {
    const q = filter.trim().toLowerCase();
    keep = new Set([...keep].filter((k) => nodes.get(k).label.toLowerCase().includes(q) || k === center));
  }
  let fl = links.filter((l) => keep.has(l.source) && keep.has(l.target));
  if (!orphans) {
    const linked = new Set(fl.flatMap((l) => [l.source, l.target]));
    keep = new Set([...keep].filter((k) => linked.has(k) || k === center));
    fl = fl.filter((l) => keep.has(l.source) && keep.has(l.target));
  }
  return { nodes: [...keep].map((k) => nodes.get(k)), links: fl };
}

function refreshGraph(tab, { keep = true } = {}) {
  if (!tab.graph) return;
  tab.graph.setData(graphData(settings.graph), { keepPositions: keep });
  const other = [...store.members.entries()].find(([id]) => id !== me());
  tab.graphLegend.replaceChildren(...(settings.graph.authorColors ? [
    el('span', {}, el('i', { class: 'legend-dot me' }), `${nameOf(me())}`),
    el('span', {}, el('i', { class: 'legend-dot other' }), `${other?.[1] || '상대방'}`),
  ] : []));
}

// ---------- 오른쪽 사이드바 ----------
let localGraph = null;
function activePane(side) {
  return document.querySelector(`#${side === 'left' ? 'left' : 'right'}-dock .sidedock-tab.is-active`)?.dataset.pane;
}

function showPane(side, pane) {
  const dock = $(side === 'left' ? 'left-dock' : 'right-dock');
  for (const b of dock.querySelectorAll('.sidedock-tab')) b.classList.toggle('is-active', b.dataset.pane === pane);
  for (const p of dock.querySelectorAll(':scope > .pane')) p.hidden = p.id !== `pane-${pane}`;
  if (side === 'left') {
    document.body.classList.remove('left-collapsed');
    if (pane === 'search') setTimeout(() => $('search-input').focus(), 0);
    if (pane === 'tags') renderTagPane();
  } else {
    document.body.classList.remove('right-collapsed');
    renderRightPanel();
  }
  if (isMobile()) openDrawer(side);
}
const showRightPane = (pane) => showPane('right', pane);

function renderRightPanel() {
  const pane = activePane('right');
  const id = activeNoteId();
  if (pane === 'backlinks') renderBacklinks(id);
  else if (pane === 'outgoing') renderOutgoing(id);
  else if (pane === 'outline') renderOutline(id);
  else if (pane === 'localgraph') renderLocalGraph(id);
  else if (pane === 'history') scheduleHistory(0);
}

function paneEmpty(text) { return el('div', { class: 'pane-empty', text }); }

function linkLinesTo(sourceId, targetKey) {
  const lines = textOf(sourceId).split('\n');
  const out = [];
  lines.forEach((line, i) => {
    for (const m of line.matchAll(WIKILINK_RE)) {
      if (keyOf(m[2]) === targetKey) { out.push({ line: i, text: line.trim() }); break; }
    }
  });
  return out;
}

function mentionLines(sourceId, title) {
  const q = title.toLowerCase();
  const out = [];
  stripCode(textOf(sourceId)).split('\n').forEach((line, i) => {
    const plain = line.replace(WIKILINK_RE, '');
    if (plain.toLowerCase().includes(q)) out.push({ line: i, text: line.trim() });
  });
  return out;
}

function snippetEl(text, terms) {
  const s = el('div', { class: 'search-result-file-match' });
  const lower = text.toLowerCase();
  const ranges = [];
  for (const t of terms) {
    if (!t) continue;
    let i = 0;
    while ((i = lower.indexOf(t, i)) >= 0) { ranges.push([i, i + t.length]); i += t.length; }
  }
  ranges.sort((a, b) => a[0] - b[0]);
  let pos = 0;
  const start = ranges.length ? Math.max(0, ranges[0][0] - 60) : 0;
  if (start > 0) { s.append('…'); pos = start; }
  for (const [a, b] of ranges) {
    if (a < pos) continue;
    s.append(text.slice(pos, a), el('span', { class: 'search-result-file-matched-text', text: text.slice(a, b) }));
    pos = b;
  }
  const rest = text.slice(pos);
  s.append(rest.length > 160 ? rest.slice(0, 160) + '…' : rest);
  return s;
}

function collapsibleSection(title, count, body, open = true) {
  const wrap = el('div', { class: 'tree-section' + (open ? '' : ' is-collapsed') });
  const head = el('div', { class: 'tree-section-header', onclick: () => wrap.classList.toggle('is-collapsed') },
    el('span', { class: 'collapse-icon', html: icon('chevron-down', 14) }),
    el('span', { text: title }),
    el('span', { class: 'tree-section-count', text: String(count) }));
  wrap.append(head, el('div', { class: 'tree-section-body' }, body));
  return wrap;
}

function renderBacklinks(id) {
  const pane = $('pane-backlinks');
  if (!id) return pane.replaceChildren(paneEmpty('열린 노트가 없습니다'));
  const n = store.notes.get(id);
  const key = keyOf(n.title);
  const linked = [], unlinked = [];
  for (const o of store.notes.values()) {
    if (o.id === id) continue;
    if (metaOf(o.id).keys.has(key)) linked.push(o);
    else if (n.title.length >= 2 && stripCode(textOf(o.id)).toLowerCase().includes(n.title.toLowerCase())) {
      const lines = mentionLines(o.id, n.title);
      if (lines.length) unlinked.push([o, lines]);
    }
  }
  const linkedBody = el('div', {});
  if (!linked.length) linkedBody.append(paneEmpty('이 노트를 가리키는 노트가 없습니다'));
  for (const o of linked.sort((a, b) => a.title.localeCompare(b.title))) {
    const lines = linkLinesTo(o.id, key);
    linkedBody.append(el('div', { class: 'search-result' },
      el('div', { class: 'search-result-file-title', onclick: (e) => openNote(o.id, { newTab: e.metaKey || e.ctrlKey }) }, el('span', { html: icon('file', 14) }), el('span', { text: o.title })),
      el('div', { class: 'search-result-file-matches' }, lines.slice(0, 5).map((l) => {
        const s = snippetEl(l.text, [`[[${key}`, key]);
        s.onclick = () => openNote(o.id, { line: l.line });
        return s;
      }))));
  }
  const unlinkedBody = el('div', {});
  if (!unlinked.length) unlinkedBody.append(paneEmpty('링크되지 않은 언급이 없습니다'));
  for (const [o, lines] of unlinked) {
    unlinkedBody.append(el('div', { class: 'search-result' },
      el('div', { class: 'search-result-file-title' },
        el('span', { html: icon('file', 14) }),
        el('span', { text: o.title, onclick: () => openNote(o.id) }),
        el('button', { class: 'small-button', text: '링크로 만들기', onclick: (e) => { e.stopPropagation(); linkMention(o.id, n.title); } })),
      el('div', { class: 'search-result-file-matches' }, lines.slice(0, 3).map((l) => {
        const s = snippetEl(l.text, [n.title.toLowerCase()]);
        s.onclick = () => openNote(o.id, { line: l.line });
        return s;
      }))));
  }
  pane.replaceChildren(
    collapsibleSection('링크된 언급', linked.length, linkedBody),
    collapsibleSection('링크되지 않은 언급', unlinked.length, unlinkedBody, unlinked.length > 0));
}

async function linkMention(sourceId, title) {
  const text = textOf(sourceId);
  const re = new RegExp(title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
  // [[...]] 안이나 코드 안은 건너뛴다
  const protectedRanges = [];
  for (const m of text.matchAll(/\[\[[^\]\n]*\]\]|`[^`\n]*`/g)) protectedRanges.push([m.index, m.index + m[0].length]);
  let from = 0;
  while (from < text.length) {
    const m = re.exec(text.slice(from));
    if (!m) break;
    const at = from + m.index;
    if (!protectedRanges.some(([a, b]) => at >= a && at < b)) {
      const found = text.slice(at, at + m[0].length);
      const link = found === title ? `[[${title}]]` : `[[${title}|${found}]]`;
      const ok = await updateNoteContent(sourceId, text.slice(0, at) + link + text.slice(at + m[0].length));
      if (ok) notice('링크로 바꿨습니다', 1500);
      return;
    }
    from = at + m[0].length;
  }
}

function renderOutgoing(id) {
  const pane = $('pane-outgoing');
  if (!id) return pane.replaceChildren(paneEmpty('열린 노트가 없습니다'));
  const seen = new Set();
  const resolved = [], unresolved = [];
  for (const l of metaOf(id).links) {
    const k = keyOf(l.target);
    if (seen.has(k)) continue;
    seen.add(k);
    const t = store.byKey.get(k);
    if (t) resolved.push(t); else unresolved.push(l.target);
  }
  const body = el('div', { class: 'link-list' });
  if (!resolved.length) body.append(paneEmpty('[[링크]]가 없습니다'));
  for (const t of resolved) body.append(el('div', { class: 'tree-item-self is-clickable', onclick: (e) => openNote(t.id, { newTab: e.metaKey || e.ctrlKey }) }, el('span', { html: icon('file', 14) }), el('span', { text: t.title })));
  const ubody = el('div', { class: 'link-list' });
  if (!unresolved.length) ubody.append(paneEmpty('없음'));
  for (const t of unresolved) ubody.append(el('div', { class: 'tree-item-self is-clickable is-unresolved', title: '눌러서 만들기', onclick: () => followLink(t, '', false) }, el('span', { html: icon('file-plus', 14) }), el('span', { text: t })));
  pane.replaceChildren(collapsibleSection('링크', resolved.length, body), collapsibleSection('아직 없는 노트', unresolved.length, ubody));
}

function renderOutline(id) {
  const pane = $('pane-outline');
  if (!id) return pane.replaceChildren(paneEmpty('열린 노트가 없습니다'));
  const hs = metaOf(id).headings;
  if (!hs.length) return pane.replaceChildren(paneEmpty('소제목(#)이 없습니다'));
  const min = Math.min(...hs.map((h) => h.level));
  pane.replaceChildren(el('div', { class: 'outline' }, hs.map((h) => el('div', {
    class: 'outline-item',
    style: `padding-left:${(h.level - min) * 16 + 8}px`,
    onclick: () => { const tab = activeTab; if (tab?.kind === 'note') scrollToHeading(tab, h.text); },
  }, el('span', { text: h.text })))));
}

function renderLocalGraph(id) {
  const canvas = $('local-graph');
  if (!localGraph) {
    localGraph = createGraph(canvas, {
      local: true,
      labelZoom: 0.4,
      onOpen: (node, newTab) => onGraphOpen(node, newTab),
    });
  }
  if (!id) { localGraph.setData({ nodes: [], links: [] }); return; }
  localGraph.setData(graphData({ center: id, depth: settings.localDepth, tags: settings.localTags, unresolved: true, orphans: true }), { keepPositions: localGraph.lastCenter === id });
  if (localGraph.lastCenter !== id) setTimeout(() => localGraph.fit(), 600);
  localGraph.lastCenter = id;
}

let historyTimer = 0;
function scheduleHistory(delay = 1500) {
  clearTimeout(historyTimer);
  historyTimer = setTimeout(renderHistory, delay);
}

async function renderHistory() {
  const pane = $('pane-history');
  const id = activeNoteId();
  if (!id) return pane.replaceChildren(paneEmpty('열린 노트가 없습니다'));
  const { data } = await sb.from('sb_revisions').select('id,version,title,content,edited_by,edited_at').eq('note_id', id).order('edited_at', { ascending: false }).limit(50);
  if (activeNoteId() !== id) return;
  const n = store.notes.get(id);
  const list = el('div', { class: 'history-list' },
    el('div', { class: 'history-meta muted small', text: `만든 사람 ${nameOf(n.created_by)} · ${fmtTime(n.created_at)}` }));
  if (!data?.length) list.append(paneEmpty('이력이 없습니다'));
  for (const r of data || []) {
    list.append(el('div', { class: 'history-item', onclick: () => openRevision(r) },
      el('span', { class: 'history-author' + (r.edited_by === me() ? ' is-me' : ''), text: nameOf(r.edited_by) }),
      el('span', { class: 'history-time', text: relTime(r.edited_at) }),
      el('span', { class: 'history-version muted', text: `v${r.version}` })));
  }
  pane.replaceChildren(list);
}

function lineDiff(a, b) {
  const A = a.split('\n'), B = b.split('\n');
  if (A.length * B.length > 4e6) return null;
  const dp = Array.from({ length: A.length + 1 }, () => new Uint32Array(B.length + 1));
  for (let i = A.length - 1; i >= 0; i--) for (let j = B.length - 1; j >= 0; j--)
    dp[i][j] = A[i] === B[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  const out = [];
  let i = 0, j = 0;
  while (i < A.length && j < B.length) {
    if (A[i] === B[j]) { out.push([' ', A[i]]); i++; j++; }
    else if (dp[i + 1][j] >= dp[i][j + 1]) out.push(['-', A[i++]]);
    else out.push(['+', B[j++]]);
  }
  while (i < A.length) out.push(['-', A[i++]]);
  while (j < B.length) out.push(['+', B[j++]]);
  return out;
}

function openRevision(r) {
  const id = activeNoteId();
  const current = textOf(id);
  const diff = lineDiff(current, r.content || '');
  const diffEl = el('div', { class: 'diff-view' });
  if (!diff) diffEl.append(el('pre', { text: r.content }));
  else if (diff.every(([op]) => op === ' ')) diffEl.append(paneEmpty('지금 내용과 같습니다'));
  else {
    // 바뀐 줄 주변 2줄만 보여준다
    const show = new Set();
    diff.forEach(([op], i) => { if (op !== ' ') for (let k = i - 2; k <= i + 2; k++) show.add(k); });
    let gap = false;
    diff.forEach(([op, line], i) => {
      if (!show.has(i)) { if (!gap) diffEl.append(el('div', { class: 'diff-gap', text: '⋯' })); gap = true; return; }
      gap = false;
      diffEl.append(el('div', { class: `diff-line ${op === '+' ? 'is-added' : op === '-' ? 'is-removed' : ''}` }, el('span', { class: 'diff-op', text: op }), el('span', { text: line || ' ' })));
    });
  }
  const full = el('pre', { class: 'revision-content', hidden: true, text: r.content || '(빈 노트)' });
  const toggle = el('div', { class: 'revision-toggle' },
    el('button', { class: 'is-active', text: '지금과 비교', onclick: (e) => { full.hidden = true; diffEl.hidden = false; e.target.classList.add('is-active'); e.target.nextSibling.classList.remove('is-active'); } }),
    el('button', { text: '이 버전 전체', onclick: (e) => { full.hidden = false; diffEl.hidden = true; e.target.classList.add('is-active'); e.target.previousSibling.classList.remove('is-active'); } }));
  openModal({
    title: `v${r.version} · ${nameOf(r.edited_by)} · ${fmtTime(r.edited_at)}`,
    cls: 'mod-wide',
    content: el('div', {}, el('p', { class: 'muted small', text: '빨간 줄은 지금 내용에만 있고, 초록 줄은 이 버전에만 있습니다.' }), toggle, diffEl, full),
    buttons: [
      { text: '이 버전으로 되돌리기', cls: 'mod-cta', onClick: async (close) => { close(); if (await updateNoteContent(id, r.content)) notice(`v${r.version} 내용으로 되돌렸습니다`); } },
      { text: '닫기', onClick: (close) => close() },
    ],
  });
}

// ---------- 파일 탐색기 ----------
function sortNotes(list) {
  const s = settings.sort;
  const cmp = {
    'name-asc': (a, b) => a.title.localeCompare(b.title, 'ko'),
    'name-desc': (a, b) => b.title.localeCompare(a.title, 'ko'),
    'mtime-desc': (a, b) => b.updated_at.localeCompare(a.updated_at),
    'mtime-asc': (a, b) => a.updated_at.localeCompare(b.updated_at),
    'ctime-desc': (a, b) => b.created_at.localeCompare(a.created_at),
  }[s] || ((a, b) => a.title.localeCompare(b.title, 'ko'));
  return list.sort(cmp);
}

function renderFileTree() {
  const root = $('file-tree');
  const folders = allFolders();
  const children = new Map([['', []]]);
  for (const f of folders) {
    children.set(f, children.get(f) || []);
    const parent = f.includes('/') ? f.slice(0, f.lastIndexOf('/')) : '';
    if (!children.has(parent)) children.set(parent, []);
    children.get(parent).push(f);
  }
  const notesIn = new Map();
  for (const n of store.notes.values()) {
    if (!notesIn.has(n.folder)) notesIn.set(n.folder, []);
    notesIn.get(n.folder).push(n);
  }
  const cur = activeNoteId();
  const viewing = new Map(others.filter((o) => o.note).map((o) => [o.note, o.name]));

  const build = (path) => {
    const frag = document.createDocumentFragment();
    for (const f of (children.get(path) || []).sort((a, b) => a.localeCompare(b, 'ko'))) {
      const name = f.split('/').at(-1);
      const open = expanded.has(f);
      const self = el('div', {
        class: 'tree-item-self nav-folder-title is-clickable',
        draggable: 'true',
        dataset: { path: f },
        onclick: () => { if (open) expanded.delete(f); else expanded.add(f); savePref('sb.expanded', [...expanded]); renderFileTree(); },
        oncontextmenu: (e) => showMenu(e, [
          { label: '새 노트', icon: 'file-plus', action: () => createNote({ folder: f }) },
          { label: '새 폴더', icon: 'folder-plus', action: () => createFolder(f) },
          '-',
          { label: '이름 바꾸기', icon: 'edit', action: () => renameFolder(f) },
          { label: '폴더 지우기 (비어 있을 때만)', icon: 'x', danger: true, action: () => removeFolder(f) },
        ]),
      },
      el('span', { class: 'tree-item-icon collapse-icon' + (open ? '' : ' is-collapsed'), html: icon('chevron-down', 14) }),
      el('span', { class: 'tree-item-inner', text: name }));
      setupDrop(self, f);
      self.addEventListener('dragstart', (e) => { e.dataTransfer.setData('text/sb-folder', f); e.dataTransfer.effectAllowed = 'move'; });
      const item = el('div', { class: 'tree-item nav-folder' + (open ? '' : ' is-collapsed') }, self);
      if (open) item.append(el('div', { class: 'tree-item-children' }, build(f)));
      frag.append(item);
    }
    for (const n of sortNotes(notesIn.get(path) || [])) {
      const who = viewing.get(n.id);
      const self = el('div', {
        class: 'tree-item-self nav-file-title is-clickable' + (n.id === cur ? ' is-active' : ''),
        draggable: 'true',
        dataset: { id: n.id },
        title: `${n.title}\n마지막 수정: ${nameOf(n.updated_by)} · ${fmtTime(n.updated_at)}`,
        onclick: (e) => openNote(n.id, { newTab: e.metaKey || e.ctrlKey }),
        onauxclick: (e) => { if (e.button === 1) openNote(n.id, { newTab: true }); },
        oncontextmenu: (e) => showMenu(e, [
          { label: '새 탭에서 열기', icon: 'plus', action: () => openNote(n.id, { newTab: true }) },
          { label: '이름 바꾸기', icon: 'edit', action: async () => { await openNote(n.id); focusTitle(); } },
          { label: '다른 폴더로 이동…', icon: 'move', action: () => pickFolderAndMove(n.id) },
          { label: '[[링크]] 복사', icon: 'copy', action: () => copyText(`[[${n.title}]]`) },
          '-',
          { label: '보관', icon: 'archive', danger: true, action: () => archiveNote(n.id) },
        ]),
      },
      el('span', { class: 'tree-item-inner', text: n.title }),
      who ? el('span', { class: 'presence-dot', title: `${who}님이 보는 중`, text: who.slice(0, 1) }) : null,
      n.updated_by !== me() && Date.now() - new Date(n.updated_at).getTime() < 86400000
        ? el('span', { class: 'nav-file-tag', title: `${nameOf(n.updated_by)}님이 최근 수정`, text: nameOf(n.updated_by).slice(0, 1) }) : null);
      self.addEventListener('dragstart', (e) => {
        e.dataTransfer.setData('text/sb-note', n.id);
        e.dataTransfer.setData('text/plain', `[[${n.title}]]`);
        e.dataTransfer.effectAllowed = 'copyMove';
      });
      frag.append(el('div', { class: 'tree-item nav-file' }, self));
    }
    return frag;
  };
  const tree = el('div', { class: 'nav-files-container' }, build(''));
  if (!store.notes.size && !folders.length) tree.append(paneEmpty('노트가 없습니다. 위의 + 버튼으로 만들어 보세요.'));
  root.replaceChildren(tree);
}

function setupDrop(target, folder) {
  target.addEventListener('dragover', (e) => {
    const types = e.dataTransfer.types;
    if (!types.includes('text/sb-note') && !types.includes('text/sb-folder')) return;
    e.preventDefault();
    e.stopPropagation();
    target.classList.add('is-being-dragged-over');
  });
  target.addEventListener('dragleave', () => target.classList.remove('is-being-dragged-over'));
  target.addEventListener('drop', (e) => {
    target.classList.remove('is-being-dragged-over');
    const noteId = e.dataTransfer.getData('text/sb-note');
    const src = e.dataTransfer.getData('text/sb-folder');
    if (!noteId && !src) return;
    e.preventDefault();
    e.stopPropagation();
    if (noteId) moveNote(noteId, folder);
    else if (src && src !== folder && !folder.startsWith(src + '/')) {
      const name = src.split('/').at(-1);
      const dest = folder ? `${folder}/${name}` : name;
      if (dest !== src) renameFolder(src, dest);
    }
  });
}

function pickFolderAndMove(noteId) {
  const folders = ['', ...allFolders()];
  openSuggest({
    placeholder: '옮길 폴더를 고르거나 새 폴더 이름을 입력하세요',
    items: (q) => {
      const res = folders.map((f) => ({ f, m: fuzzy(q, f || '/') })).filter((x) => x.m).sort((a, b) => b.m.score - a.m.score)
        .map(({ f, m }) => ({ title: f || '/ (최상위)', idx: f ? m.idx : [], run: () => moveNote(noteId, f) }));
      const name = q.trim().replace(/^\/+|\/+$/g, '');
      if (name && !folders.includes(name) && !/[[\]|#^\\]/.test(name)) {
        res.push({ title: `새 폴더 "${name}" 만들고 이동`, run: async () => { if (await ensureFolder(name)) moveNote(noteId, name); } });
      }
      return res;
    },
  });
}

// ---------- 태그 창 ----------
function renderTagPane() {
  const pane = $('tag-list');
  const tags = allTags();
  if (!tags.length) return pane.replaceChildren(paneEmpty('#태그가 없습니다'));
  pane.replaceChildren(...tags.map((t) => el('div', { class: 'tag-pane-tag', onclick: () => searchFor(`tag:#${t.name}`) },
    el('span', { class: 'tag-pane-tag-text', text: `#${t.name}` }),
    el('span', { class: 'tag-pane-tag-count', text: String(t.count) }))));
}

// ---------- 검색 ----------
function parseQuery(q) {
  const terms = [];
  for (const m of q.matchAll(/(-?)(?:(tag|path|file|title):)?(?:"([^"]*)"|(\S+))/gi)) {
    let op = (m[2] || 'text').toLowerCase();
    let val = (m[3] ?? m[4] ?? '').toLowerCase();
    if (!val) continue;
    if (op === 'title') op = 'file';
    if (op === 'text' && /^#[^\s#]/.test(val)) { op = 'tag'; }
    if (op === 'tag') val = val.replace(/^#/, '');
    terms.push({ neg: m[1] === '-', op, val });
  }
  return terms;
}

function searchFor(q) {
  showPane('left', 'search');
  $('search-input').value = q;
  runSearch();
}

let searchTimer = 0;
function runSearch() {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => {
    const q = $('search-input').value.trim();
    const out = $('search-results');
    const info = $('search-info');
    if (!q) { out.replaceChildren(); info.textContent = ''; return; }
    const terms = parseQuery(q);
    const textTerms = terms.filter((t) => !t.neg && t.op === 'text').map((t) => t.val);
    const results = [];
    for (const n of store.notes.values()) {
      const text = textOf(n.id);
      const lower = text.toLowerCase();
      const title = n.title.toLowerCase();
      const tags = metaOf(n.id).tags.map((t) => t.toLowerCase());
      const ok = terms.every((t) => {
        let hit;
        if (t.op === 'text') hit = title.includes(t.val) || lower.includes(t.val);
        else if (t.op === 'file') hit = title.includes(t.val);
        else if (t.op === 'path') hit = (n.folder || '').toLowerCase().includes(t.val);
        else if (t.op === 'tag') hit = tags.some((x) => x === t.val || x.startsWith(t.val + '/'));
        return t.neg ? !hit : hit;
      });
      if (!ok) continue;
      const lines = [];
      const highlightTerms = [...textTerms, ...terms.filter((t) => t.op === 'tag' && !t.neg).map((t) => '#' + t.val)];
      let offset = 0;
      for (const line of text.split('\n')) {
        const ll = line.toLowerCase();
        const hitTerm = highlightTerms.find((t) => ll.includes(t));
        if (hitTerm && lines.length < 5) lines.push({ text: line.trim(), from: offset + ll.indexOf(hitTerm), len: hitTerm.length });
        offset += line.length + 1;
      }
      const score = (textTerms.some((t) => title.includes(t)) ? 100 : 0) + lines.length;
      results.push({ n, lines, score, highlightTerms });
    }
    results.sort((a, b) => b.score - a.score || b.n.updated_at.localeCompare(a.n.updated_at));
    info.textContent = `노트 ${results.length}개`;
    out.replaceChildren(...results.slice(0, 200).map(({ n, lines, highlightTerms }) => el('div', { class: 'search-result' },
      el('div', { class: 'search-result-file-title', onclick: (e) => openNote(n.id, { newTab: e.metaKey || e.ctrlKey }) },
        el('span', { html: icon('file', 14) }),
        el('span', { text: n.title }),
        n.folder ? el('span', { class: 'muted small', text: ` ${n.folder}` }) : null),
      el('div', { class: 'search-result-file-matches' }, lines.map((l) => {
        const s = snippetEl(l.text, highlightTerms);
        s.onclick = () => openNote(n.id, { select: { from: l.from, to: l.from + l.len } });
        return s;
      })))));
  }, 150);
}

// ---------- 빠른 이동 / 명령 팔레트 ----------
function openSuggest({ placeholder, items, instructions = [] }) {
  const input = el('input', { class: 'prompt-input', type: 'text', placeholder, spellcheck: 'false', autocomplete: 'off' });
  const list = el('div', { class: 'prompt-results' });
  const instr = el('div', { class: 'prompt-instructions' }, [
    ['↑↓', '이동'], ['↵', '열기'], ...instructions, ['esc', '닫기'],
  ].map(([k, v]) => el('span', { class: 'prompt-instruction' }, el('kbd', { text: k }), ` ${v}`)));
  let current = [], sel = 0;
  const m = openModal({ cls: 'prompt', content: el('div', {}, input, list, instr) });
  const render = () => {
    current = items(input.value);
    sel = Math.min(sel, Math.max(0, current.length - 1));
    list.replaceChildren(...current.slice(0, 50).map((it, i) => el('div', {
      class: 'suggestion-item' + (i === sel ? ' is-selected' : ''),
      onmousemove: () => { if (sel !== i) { sel = i; paint(); } },
      onclick: (e) => choose(i, e),
    },
    el('div', { class: 'suggestion-content' },
      el('div', { class: 'suggestion-title' }, it.idx ? highlighted(it.title, it.idx) : it.title),
      it.note ? el('div', { class: 'suggestion-note', text: it.note }) : null),
    it.aux ? el('div', { class: 'suggestion-aux' }, el('kbd', { text: it.aux })) : null)));
    if (!current.length) list.append(el('div', { class: 'suggestion-empty', text: '결과가 없습니다' }));
  };
  const paint = () => [...list.children].forEach((c, i) => c.classList.toggle('is-selected', i === sel));
  const choose = (i, e) => {
    const it = current[i];
    if (!it) return;
    m.close();
    it.run({ newTab: e?.metaKey || e?.ctrlKey });
  };
  input.addEventListener('input', () => { sel = 0; render(); });
  input.addEventListener('keydown', (e) => {
    if (e.isComposing) return;
    if (e.key === 'ArrowDown' || (e.ctrlKey && e.key === 'n')) { e.preventDefault(); sel = Math.min(sel + 1, current.length - 1); paint(); list.children[sel]?.scrollIntoView({ block: 'nearest' }); }
    else if (e.key === 'ArrowUp' || (e.ctrlKey && e.key === 'p')) { e.preventDefault(); sel = Math.max(sel - 1, 0); paint(); list.children[sel]?.scrollIntoView({ block: 'nearest' }); }
    else if (e.key === 'Enter') { e.preventDefault(); choose(sel, e); }
  });
  render();
  input.focus();
}

function openSwitcher() {
  openSuggest({
    placeholder: '노트 이름을 입력하세요…',
    instructions: [['ctrl ↵', '새 탭'], ['shift ↵', '만들기']],
    items: (q) => {
      const notes = [...store.notes.values()];
      let res;
      if (!q.trim()) {
        const rec = store.recent.map((id) => store.notes.get(id)).filter(Boolean);
        const rest = notes.filter((n) => !store.recent.includes(n.id)).sort((a, b) => b.updated_at.localeCompare(a.updated_at));
        res = [...rec, ...rest].map((n) => ({ n, idx: [] }));
      } else {
        res = notes.map((n) => ({ n, m: fuzzy(q, n.title) || (n.folder && fuzzy(q, `${n.folder}/${n.title}`)) }))
          .filter((x) => x.m).sort((a, b) => b.m.score - a.m.score).map((x) => ({ n: x.n, idx: x.m.idx.every((i) => i < x.n.title.length) ? x.m.idx : [] }));
      }
      const items = res.map(({ n, idx }) => ({
        title: n.title,
        idx,
        note: [n.folder, `${nameOf(n.updated_by)} · ${relTime(n.updated_at)}`].filter(Boolean).join(' · '),
        run: ({ newTab }) => openNote(n.id, { newTab }),
      }));
      const t = q.trim();
      if (t && !store.byKey.has(keyOf(t)) && !validTitle(t)) {
        items.push({ title: `"${t}" 새 노트 만들기`, aux: 'shift ↵', run: ({ newTab }) => createNote({ title: t, newTab, focusTitle: false }) });
      }
      return items;
    },
  });
}

const COMMANDS = [
  { id: 'new-note', name: '새 노트 만들기', hotkey: 'Alt+N', run: () => createNote() },
  { id: 'switcher', name: '노트로 이동 (빠른 전환)', hotkey: 'Ctrl+O', run: () => openSwitcher() },
  { id: 'palette', name: '명령 팔레트', hotkey: 'Ctrl+P', run: () => openPalette() },
  { id: 'search', name: '모든 노트에서 검색', hotkey: 'Ctrl+Shift+F', run: () => showPane('left', 'search') },
  { id: 'graph', name: '그래프 뷰 열기', hotkey: 'Ctrl+G', run: () => openGraph() },
  { id: 'daily', name: '오늘의 데일리 노트 열기', hotkey: 'Alt+D', run: () => openDaily() },
  { id: 'toggle-mode', name: '읽기 / 편집 보기 전환', hotkey: 'Ctrl+E', run: () => toggleMode() },
  { id: 'rename', name: '현재 노트 이름 바꾸기', hotkey: 'F2', run: () => focusTitle() },
  { id: 'move', name: '현재 노트를 다른 폴더로 이동', run: () => activeNoteId() && pickFolderAndMove(activeNoteId()) },
  { id: 'copy-link', name: '현재 노트의 [[링크]] 복사', run: () => activeNoteId() && copyText(`[[${store.notes.get(activeNoteId()).title}]]`) },
  { id: 'archive', name: '현재 노트 보관', run: () => activeNoteId() && archiveNote(activeNoteId()) },
  { id: 'archive-list', name: '보관함 열기', run: () => openArchiveList() },
  { id: 'new-folder', name: '새 폴더 만들기', run: () => createFolder('') },
  { id: 'back', name: '뒤로 가기', hotkey: 'Ctrl+Alt+←', run: () => activeTab?.kind === 'note' && goBack(activeTab) },
  { id: 'forward', name: '앞으로 가기', hotkey: 'Ctrl+Alt+→', run: () => activeTab?.kind === 'note' && goForward(activeTab) },
  { id: 'close-tab', name: '현재 탭 닫기', hotkey: 'Alt+W', run: () => activeTab && closeTab(activeTab) },
  { id: 'new-tab', name: '새 탭 열기', hotkey: 'Alt+T', run: () => createTab('empty') },
  { id: 'toggle-left', name: '왼쪽 사이드바 열기/닫기', run: () => toggleSide('left') },
  { id: 'toggle-right', name: '오른쪽 사이드바 열기/닫기', run: () => toggleSide('right') },
  { id: 'backlinks', name: '백링크 보기', run: () => showRightPane('backlinks') },
  { id: 'outline', name: '개요 보기', run: () => showRightPane('outline') },
  { id: 'localgraph', name: '로컬 그래프 보기', run: () => showRightPane('localgraph') },
  { id: 'history', name: '수정 이력 보기', run: () => showRightPane('history') },
  { id: 'tags', name: '태그 목록 보기', run: () => showPane('left', 'tags') },
  { id: 'theme', name: '어두운 / 밝은 테마 전환', run: () => toggleTheme() },
  { id: 'settings', name: '설정 열기', hotkey: 'Ctrl+,', run: () => openSettings() },
  { id: 'logout', name: '로그아웃', run: () => logout() },
];

function runCommand(id) { COMMANDS.find((c) => c.id === id)?.run(); }

function openPalette() {
  const usage = loadPref('sb.cmdUsage', {});
  openSuggest({
    placeholder: '명령을 입력하세요…',
    items: (q) => COMMANDS.filter((c) => c.id !== 'palette').map((c) => ({ c, m: fuzzy(q, c.name) })).filter((x) => x.m)
      .sort((a, b) => (q.trim() ? b.m.score - a.m.score : (usage[b.c.id] || 0) - (usage[a.c.id] || 0)))
      .map(({ c, m }) => ({
        title: c.name,
        idx: m.idx,
        aux: c.hotkey,
        run: () => { usage[c.id] = Date.now(); savePref('sb.cmdUsage', usage); c.run(); },
      })),
  });
}

// ---------- 데일리 노트 ----------
async function openDaily() {
  const d = new Date();
  const title = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const n = store.byKey.get(keyOf(title));
  if (n) return openNote(n.id);
  const folder = settings.dailyFolder.trim();
  if (folder) await ensureFolder(folder);
  const weekday = d.toLocaleDateString('ko-KR', { weekday: 'long' });
  await createNote({ title, folder, content: `# ${title} ${weekday}\n\n`, focusTitle: false });
}

// ---------- 설정 ----------
function applySettings() {
  const theme = settings.theme === 'system'
    ? (window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark')
    : settings.theme;
  document.body.classList.toggle('theme-dark', theme === 'dark');
  document.body.classList.toggle('theme-light', theme === 'light');
  document.body.classList.toggle('readable-line-width', settings.readableWidth);
  document.body.style.setProperty('--font-text-size', `${settings.fontSize}px`);
  document.body.style.setProperty('--left-width', `${settings.leftWidth}px`);
  document.body.style.setProperty('--right-width', `${settings.rightWidth}px`);
  const themeBtn = document.querySelector('[data-cmd="theme"]');
  if (themeBtn) themeBtn.innerHTML = icon(theme === 'dark' ? 'sun' : 'moon');
  for (const t of tabs) t.graph?.redraw();
  localGraph?.redraw();
}

function toggleTheme() {
  const cur = document.body.classList.contains('theme-dark') ? 'dark' : 'light';
  settings.theme = cur === 'dark' ? 'light' : 'dark';
  saveSettings();
  applySettings();
}

function openSettings() {
  const row = (name, desc, control) => el('div', { class: 'setting-item' },
    el('div', { class: 'setting-item-info' }, el('div', { class: 'setting-item-name', text: name }), desc ? el('div', { class: 'setting-item-description', text: desc }) : null),
    el('div', { class: 'setting-item-control' }, control));
  const select = (key, options) => {
    const s = el('select', { class: 'dropdown', onchange: (e) => { settings[key] = isNaN(+e.target.value) ? e.target.value : +e.target.value; saveSettings(); applySettings(); } },
      options.map(([v, label]) => el('option', { value: v, selected: String(settings[key]) === String(v) || null, text: label })));
    return s;
  };
  const toggle = (key) => el('input', { type: 'checkbox', class: 'toggle', checked: settings[key] || null, onchange: (e) => { settings[key] = e.target.checked; saveSettings(); applySettings(); } });
  const daily = el('input', { type: 'text', value: settings.dailyFolder, onchange: (e) => { settings.dailyFolder = e.target.value.trim(); saveSettings(); } });
  openModal({
    title: '설정',
    cls: 'mod-settings',
    content: el('div', {},
      el('h3', { text: '화면' }),
      row('테마', null, select('theme', [['dark', '어두운'], ['light', '밝은'], ['system', '시스템 설정 따르기']])),
      row('읽기 좋은 줄 너비', '본문 폭을 적당히 제한합니다', toggle('readableWidth')),
      row('글자 크기', null, select('fontSize', [14, 15, 16, 17, 18, 20].map((v) => [v, `${v}px`]))),
      el('h3', { text: '편집' }),
      row('새 탭 기본 보기', null, select('defaultMode', [['source', '편집 (라이브 프리뷰)'], ['preview', '읽기']])),
      row('새 노트 위치', null, select('newNoteLocation', [['root', '최상위'], ['current', '지금 노트와 같은 폴더']])),
      row('이름을 바꿀 때 링크 업데이트', 'Obsidian의 "내부 링크 자동 업데이트"', select('alwaysUpdateLinks', [['ask', '매번 묻기'], ['always', '항상 업데이트'], ['never', '업데이트 안 함']])),
      row('데일리 노트 폴더', null, daily),
      el('h3', { text: '단축키' }),
      el('div', { class: 'hotkey-list' }, COMMANDS.filter((c) => c.hotkey).map((c) => el('div', { class: 'hotkey-row' }, el('span', { text: c.name }), el('kbd', { text: c.hotkey })))),
      el('div', { class: 'hotkey-list' }, [
        ['굵게 / 기울임 / 형광펜', 'Ctrl+B / Ctrl+I / Ctrl+Shift+H'],
        ['체크박스 토글', 'Ctrl+L'],
        ['링크를 새 탭에서 열기', 'Ctrl+클릭'],
        ['노트 안에서 찾기', 'Ctrl+F'],
      ].map(([a, b]) => el('div', { class: 'hotkey-row' }, el('span', { text: a }), el('kbd', { text: b })))),
      el('h3', { text: '계정' }),
      row(nameOf(me()), store.user.email, el('button', { text: '로그아웃', onclick: () => logout() }))),
  });
}

// ---------- 사이드바 / 모바일 서랍 ----------
function toggleSide(side) {
  if (isMobile()) {
    if (document.body.classList.contains(`${side}-open`)) closeDrawers();
    else openDrawer(side);
    return;
  }
  document.body.classList.toggle(`${side}-collapsed`);
  if (side === 'right' && !document.body.classList.contains('right-collapsed')) renderRightPanel();
  setTimeout(() => { for (const t of tabs) t.graph?.redraw(); }, 50);
}
function openDrawer(side) {
  if (!isMobile()) return;
  document.body.classList.remove('left-open', 'right-open');
  document.body.classList.add(`${side}-open`);
  if (side === 'right') renderRightPanel();
}
function closeDrawers() { document.body.classList.remove('left-open', 'right-open'); }

function setupResize(handleId, side) {
  const handle = $(handleId);
  handle.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    handle.setPointerCapture(e.pointerId);
    const startX = e.clientX;
    const start = side === 'left' ? settings.leftWidth : settings.rightWidth;
    const move = (ev) => {
      const dx = ev.clientX - startX;
      const w = Math.max(180, Math.min(520, start + (side === 'left' ? dx : -dx)));
      if (side === 'left') settings.leftWidth = w; else settings.rightWidth = w;
      applySettings();
    };
    const up = () => {
      handle.removeEventListener('pointermove', move);
      handle.removeEventListener('pointerup', up);
      saveSettings();
      localGraph?.redraw();
    };
    handle.addEventListener('pointermove', move);
    handle.addEventListener('pointerup', up);
  });
}

// ---------- 상태 표시줄 ----------
function setSaveStatus(text) { $('status-save').textContent = text; }

function renderStatus() {
  const id = activeNoteId();
  if (!id) {
    for (const s of ['status-backlinks', 'status-words', 'status-chars']) $(s).textContent = '';
  } else {
    const text = textOf(id);
    const key = keyOf(store.notes.get(id).title);
    const back = [...store.notes.values()].filter((o) => o.id !== id && metaOf(o.id).keys.has(key)).length;
    const words = (text.match(/[^\s#*>\-[\]()`|=_~]+/g) || []).length;
    $('status-backlinks').textContent = `백링크 ${back}`;
    $('status-backlinks').onclick = () => showRightPane('backlinks');
    $('status-words').textContent = `${words.toLocaleString()} 단어`;
    $('status-chars').textContent = `${text.length.toLocaleString()} 글자`;
  }
  const p = $('status-presence');
  const online = others.filter((o) => o.user_id !== me());
  if (!online.length) {
    const other = [...store.members.entries()].find(([uid]) => uid !== me());
    p.replaceChildren(el('span', { class: 'presence-offline', text: other ? `${other[1]}님 오프라인` : '' }));
  } else {
    p.replaceChildren(...online.map((o) => {
      const n = o.note && store.notes.get(o.note);
      return el('span', {
        class: 'presence-online',
        title: n ? '눌러서 같은 노트 열기' : '',
        onclick: () => n && openNote(n.id),
      }, el('i', { class: 'presence-online-dot' }), `${o.name}${n ? ` · ${n.title}` : ' 접속 중'}`);
    }));
  }
}

// ---------- 화면 새로 그리기 (변경을 모아서 한 번에) ----------
let refreshTimer = 0;
function scheduleRefresh(now = false) {
  clearTimeout(refreshTimer);
  if (now) return refreshAll();
  refreshTimer = setTimeout(refreshAll, 200);
}

function refreshAll() {
  renderFileTree();
  if (activePane('left') === 'tags') renderTagPane();
  if (activePane('left') === 'search' && $('search-input').value.trim()) runSearch();
  if (!document.body.classList.contains('right-collapsed') || isMobile()) renderRightPanel();
  renderStatus();
  for (const t of tabs) {
    if (t.kind === 'note') { t.editor?.refresh(); if (t === activeTab && t.mode === 'preview') { /* 읽기 보기는 편집 시 갱신 */ } }
    if (t.kind === 'graph' && t === activeTab) refreshGraph(t);
    if (t.kind === 'empty') renderEmpty(t);
  }
}

// ---------- 실시간 / 접속 표시 ----------
function subscribeRealtime() {
  sb.channel('sb_changes')
    .on('postgres_changes', { event: '*', schema: 'public', table: 'sb_notes' }, (payload) => {
      if (payload.new?.id) applyRow(payload.new);
    })
    .on('postgres_changes', { event: '*', schema: 'public', table: 'sb_folders' }, async () => {
      await reloadFolders();
      scheduleRefresh();
    })
    .subscribe();
}

let presenceChannel = null;
function setupPresence() {
  presenceChannel = sb.channel('sb_presence', { config: { presence: { key: me() } } });
  presenceChannel
    .on('presence', { event: 'sync' }, () => {
      const st = presenceChannel.presenceState();
      others = Object.entries(st)
        .filter(([uid]) => uid !== me())
        .map(([uid, metas]) => ({ user_id: uid, name: nameOf(uid), note: metas.at(-1)?.note || null }));
      renderStatus();
      renderTabBar();
      renderFileTree();
    })
    .subscribe((status) => { if (status === 'SUBSCRIBED') updatePresence(); });
  document.addEventListener('visibilitychange', updatePresence);
}

let presenceTimer = 0;
function updatePresence() {
  clearTimeout(presenceTimer);
  presenceTimer = setTimeout(() => {
    if (!presenceChannel) return;
    presenceChannel.track({ note: document.hidden ? null : activeNoteId(), at: Date.now() });
  }, 300);
}

// ---------- 정적 UI 연결 ----------
function hydrateIcons(root) {
  for (const b of root.querySelectorAll('[data-icon]')) {
    b.innerHTML = icon(b.dataset.icon, b.classList.contains('card-logo') ? 40 : 18);
    if (b.getAttribute('aria-label') && !b.title) b.title = b.getAttribute('aria-label');
  }
}

function setupStaticUI() {
  hydrateIcons(document);
  applySettings();
  document.addEventListener('click', (e) => {
    const b = e.target.closest('[data-cmd]');
    if (b) {
      const cmd = b.dataset.cmd;
      if (cmd === 'sort') return showMenu(e, [
        ['name-asc', '이름 (가나다순)'], ['name-desc', '이름 (역순)'], ['mtime-desc', '수정 시간 (최신 먼저)'],
        ['mtime-asc', '수정 시간 (오래된 것 먼저)'], ['ctime-desc', '만든 시간 (최신 먼저)'],
      ].map(([v, label]) => ({ label: (settings.sort === v ? '✓ ' : '') + label, icon: 'sort', action: () => { settings.sort = v; saveSettings(); renderFileTree(); } })));
      if (cmd === 'collapse-all') { expanded.clear(); savePref('sb.expanded', []); return renderFileTree(); }
      if (cmd === 'new-folder') return createFolder('');
      return runCommand(cmd);
    }
    const tabBtn = e.target.closest('.sidedock-tab');
    if (tabBtn) showPane(tabBtn.closest('#left-dock') ? 'left' : 'right', tabBtn.dataset.pane);
  });
  $('drawer-backdrop').onclick = closeDrawers;
  $('search-input').addEventListener('input', runSearch);
  $('local-depth').value = String(settings.localDepth);
  $('local-depth').onchange = (e) => { settings.localDepth = +e.target.value; saveSettings(); localGraph && (localGraph.lastCenter = null); renderLocalGraph(activeNoteId()); };
  $('local-tags').checked = settings.localTags;
  $('local-tags').onchange = (e) => { settings.localTags = e.target.checked; saveSettings(); localGraph && (localGraph.lastCenter = null); renderLocalGraph(activeNoteId()); };
  setupDrop($('file-tree'), '');
  setupResize('resize-left', 'left');
  setupResize('resize-right', 'right');
  $('tab-list').addEventListener('dblclick', (e) => { if (e.target === $('tab-list')) createTab('empty'); });
  window.matchMedia('(prefers-color-scheme: light)').addEventListener('change', () => settings.theme === 'system' && applySettings());
  if (window.innerWidth < 1100 && !isMobile()) document.body.classList.add('right-collapsed');

  // 전역 단축키 (브라우저가 막는 Ctrl+N/T/W 대신 Alt 조합 사용)
  document.addEventListener('keydown', (e) => {
    if (openModalCount > 0) return;
    const mod = e.metaKey || e.ctrlKey;
    const k = e.key.toLowerCase();
    const run = (id) => { e.preventDefault(); e.stopPropagation(); runCommand(id); };
    if (mod && !e.shiftKey && !e.altKey && k === 'o') return run('switcher');
    if (mod && !e.shiftKey && !e.altKey && k === 'p') return run('palette');
    if (mod && e.shiftKey && k === 'f') return run('search');
    if (mod && !e.shiftKey && !e.altKey && k === 'e') return run('toggle-mode');
    if (mod && !e.shiftKey && !e.altKey && k === 'g') return run('graph');
    if (mod && k === ',') return run('settings');
    if (mod && e.altKey && e.key === 'ArrowLeft') return run('back');
    if (mod && e.altKey && e.key === 'ArrowRight') return run('forward');
    if (e.altKey && !mod && e.code === 'KeyN') return run('new-note');
    if (e.altKey && !mod && e.code === 'KeyW') return run('close-tab');
    if (e.altKey && !mod && e.code === 'KeyT') return run('new-tab');
    if (e.altKey && !mod && e.code === 'KeyD') return run('daily');
    if (e.key === 'F2') return run('rename');
    if (e.key === 'Escape') { document.querySelector('.menu')?.remove(); hover.el?.remove(); closeDrawers(); }
  }, true);
}
boot();
