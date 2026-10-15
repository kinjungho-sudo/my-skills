// 읽기 화면용 마크다운 렌더러: [[링크]], ![[임베드]], ==형광펜==, #태그, 콜아웃, 체크박스
import { marked, DOMPurify } from './vendor.js';

export const WIKILINK_RE = /(!?)\[\[([^\]|#^\n]+)([#^][^\]|\n]*)?(?:\|([^\]\n]*))?\]\]/g;
// 태그: 공백(또는 줄 처음) 뒤의 #, 숫자만으로 된 것은 제외 (Obsidian 규칙)
export const TAG_RE = /(^|[\s(])#([\p{L}\p{N}_\-/]*[\p{L}_\-/][\p{L}\p{N}_\-/]*)/gu;
const TAG_AT_START = /^#([\p{L}\p{N}_\-/]*[\p{L}_\-/][\p{L}\p{N}_\-/]*)/u;
const LINK_AT_START = /^(!?)\[\[([^\]|#^\n]+)([#^][^\]|\n]*)?(?:\|([^\]\n]*))?\]\]/;

export const escapeHtml = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function firstIndex(src, re) {
  const m = re.exec(src);
  return m ? m.index + (m[1]?.length || 0) : undefined;
}

marked.use({
  gfm: true,
  breaks: true,
  extensions: [
    {
      name: 'wikilink',
      level: 'inline',
      start: (src) => { const i = src.indexOf('[['); if (i < 0) return undefined; return i > 0 && src[i - 1] === '!' ? i - 1 : i; },
      tokenizer(src) {
        const m = LINK_AT_START.exec(src);
        if (!m) return undefined;
        return { type: 'wikilink', raw: m[0], embed: !!m[1], target: m[2].trim(), sub: (m[3] || '').slice(1).trim(), alias: m[4]?.trim() };
      },
      renderer(t) {
        const attrs = `data-target="${escapeHtml(t.target)}" data-sub="${escapeHtml(t.sub)}"`;
        if (t.embed) return `<span class="internal-embed" ${attrs}></span>`;
        const label = t.alias || (t.sub ? `${t.target} > ${t.sub}` : t.target);
        return `<a class="internal-link" ${attrs}>${escapeHtml(label)}</a>`;
      },
    },
    {
      name: 'highlight',
      level: 'inline',
      start: (src) => { const i = src.indexOf('=='); return i < 0 ? undefined : i; },
      tokenizer(src) {
        const m = /^==(?=\S)([^\n]*?\S)==/.exec(src);
        if (!m) return undefined;
        return { type: 'highlight', raw: m[0], tokens: this.lexer.inlineTokens(m[1]) };
      },
      renderer(t) { return `<mark>${this.parser.parseInline(t.tokens)}</mark>`; },
    },
    {
      name: 'tag',
      level: 'inline',
      start: (src) => firstIndex(src, /(^|\s)#[^\s#]/),
      tokenizer(src) {
        const m = TAG_AT_START.exec(src);
        if (!m) return undefined;
        return { type: 'tag', raw: m[0], tag: m[1] };
      },
      renderer(t) { return `<a class="tag" data-tag="${escapeHtml(t.tag)}">#${escapeHtml(t.tag)}</a>`; },
    },
  ],
  renderer: {
    heading(text, level, raw) {
      return `<h${level} data-heading="${escapeHtml(raw.trim())}">${text}</h${level}>\n`;
    },
  },
});

// ---------- 소스 분석 ----------
export function headingsOf(src) {
  const out = [];
  let fence = null;
  src.split('\n').forEach((line, i) => {
    const f = /^\s*(```|~~~)/.exec(line);
    if (f) { fence = fence === f[1] ? null : fence || f[1]; return; }
    if (fence) return;
    const m = /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line);
    if (m) out.push({ level: m[1].length, text: m[2], line: i });
  });
  return out;
}

export function tagsOf(src) {
  const out = new Set();
  for (const line of stripCode(src).split('\n')) {
    for (const m of line.matchAll(TAG_RE)) out.add(m[2]);
  }
  // YAML 앞머리의 tags: [a, b] 도 인식
  const fm = /^---\n([\s\S]*?)\n---/.exec(src);
  if (fm) {
    const t = /^tags:\s*(.*)$/m.exec(fm[1]);
    if (t) t[1].replace(/[[\]]/g, '').split(/[,\s]+/).filter(Boolean).forEach((x) => out.add(x.replace(/^#/, '')));
  }
  return [...out];
}

export function stripCode(src) {
  let fence = null;
  return src.split('\n').map((line) => {
    const f = /^\s*(```|~~~)/.exec(line);
    if (f) { fence = fence === f[1] ? null : fence || f[1]; return ''; }
    return fence ? '' : line.replace(/`[^`\n]*`/g, '');
  }).join('\n');
}

export function taskLines(src) {
  const out = [];
  let fence = null;
  src.split('\n').forEach((line, i) => {
    const f = /^\s*(```|~~~)/.exec(line);
    if (f) { fence = fence === f[1] ? null : fence || f[1]; return; }
    if (!fence && /^\s*(?:[-*+]|\d+[.)])\s+\[[ xX]\]/.test(line)) out.push(i);
  });
  return out;
}

export function toggleTask(src, index, checked) {
  const lines = src.split('\n');
  const li = taskLines(src)[index];
  if (li === undefined) return src;
  lines[li] = lines[li].replace(/^(\s*(?:[-*+]|\d+[.)])\s+\[)[ xX](\])/, `$1${checked ? 'x' : ' '}$2`);
  return lines.join('\n');
}

// [[노트#소제목]] 임베드용: 해당 소제목 아래 내용만 꺼낸다
export function sectionOf(src, heading) {
  if (!heading) return src;
  const lines = src.split('\n');
  const hs = headingsOf(src);
  const h = hs.find((x) => x.text.toLowerCase() === heading.toLowerCase());
  if (!h) return src;
  const next = hs.find((x) => x.line > h.line && x.level <= h.level);
  return lines.slice(h.line, next ? next.line : lines.length).join('\n');
}

function stripFrontmatter(src) {
  return src.replace(/^---\n[\s\S]*?\n---\n?/, '');
}

// ---------- 렌더 ----------
const CALLOUT_ICONS = {
  note: '✎', info: 'ℹ', tip: '💡', hint: '💡', important: '❗', success: '✓', check: '✓', done: '✓',
  question: '?', help: '?', faq: '?', warning: '⚠', caution: '⚠', attention: '⚠', failure: '✗', fail: '✗',
  missing: '✗', danger: '⚡', error: '⚡', bug: '🐞', example: '☰', quote: '❝', cite: '❝', abstract: '☰', summary: '☰', todo: '☐',
};

/**
 * ctx: { resolve(title) -> note|null, onToggleTask(index, checked), depth }
 */
export function renderInto(el, src, ctx) {
  const html = marked.parse(stripFrontmatter(src || ''));
  el.innerHTML = DOMPurify.sanitize(html, { ADD_ATTR: ['data-target', 'data-sub', 'data-tag', 'data-heading'] });
  hydrate(el, ctx);
}

function hydrate(el, ctx) {
  for (const a of el.querySelectorAll('a.internal-link')) {
    a.href = '#';
    if (!ctx.resolve(a.dataset.target)) a.classList.add('is-unresolved');
  }
  for (const a of el.querySelectorAll('a[href]:not(.internal-link):not(.tag)')) {
    a.classList.add('external-link');
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
  }
  for (const a of el.querySelectorAll('a.tag')) a.href = '#';

  // 콜아웃: > [!type] 제목
  for (const bq of el.querySelectorAll('blockquote')) {
    const p = bq.firstElementChild;
    if (!p || p.tagName !== 'P') continue;
    const m = /^\[!([\w-]+)\]([+-]?)[ \t]*/.exec(p.textContent);
    if (!m) continue;
    const type = m[1].toLowerCase();
    // 첫 줄(<br> 전까지)을 제목으로
    const titleNodes = [];
    while (p.firstChild && p.firstChild.nodeName !== 'BR') titleNodes.push(p.removeChild(p.firstChild));
    if (p.firstChild?.nodeName === 'BR') p.removeChild(p.firstChild);
    const titleWrap = document.createElement('span');
    titleNodes.forEach((n) => titleWrap.append(n));
    const first = titleWrap.firstChild;
    if (first?.nodeType === 3) first.textContent = first.textContent.replace(/^\[![\w-]+\][+-]?[ \t]*/, '');
    if (!titleWrap.textContent.trim()) titleWrap.textContent = type.charAt(0).toUpperCase() + type.slice(1);
    if (!p.textContent.trim() && !p.children.length) p.remove();

    const box = document.createElement('div');
    box.className = 'callout';
    box.dataset.callout = type;
    const title = document.createElement('div');
    title.className = 'callout-title';
    const icon = document.createElement('span');
    icon.className = 'callout-icon';
    icon.textContent = CALLOUT_ICONS[type] || '✎';
    title.append(icon, titleWrap);
    const content = document.createElement('div');
    content.className = 'callout-content';
    while (bq.firstChild) content.append(bq.firstChild);
    box.append(title, content);
    if (m[2]) {
      box.classList.add('is-collapsible');
      if (m[2] === '-') box.classList.add('is-collapsed');
      title.onclick = () => box.classList.toggle('is-collapsed');
    }
    bq.replaceWith(box);
  }

  // 체크박스: 클릭하면 원문을 고친다
  el.querySelectorAll('input[type="checkbox"]').forEach((cb, i) => {
    cb.disabled = !ctx.onToggleTask;
    cb.classList.add('task-checkbox');
    cb.closest('li')?.classList.add('task-list-item');
    if (cb.checked) cb.closest('li')?.classList.add('is-checked');
    cb.onclick = (e) => { e.stopPropagation(); ctx.onToggleTask?.(i, cb.checked); };
  });

  // 임베드 ![[노트]]
  const depth = ctx.depth || 0;
  for (const span of el.querySelectorAll('span.internal-embed')) {
    const note = ctx.resolve(span.dataset.target);
    const box = document.createElement('div');
    box.className = 'markdown-embed';
    if (!note) {
      box.classList.add('is-unresolved');
      box.textContent = `"${span.dataset.target}" 노트가 아직 없습니다`;
    } else if (depth >= 2) {
      box.innerHTML = `<a class="internal-link" href="#" data-target="${escapeHtml(note.title)}">${escapeHtml(note.title)}</a>`;
    } else {
      const head = document.createElement('div');
      head.className = 'markdown-embed-title';
      head.innerHTML = `<a class="internal-link" href="#" data-target="${escapeHtml(note.title)}" data-sub="${escapeHtml(span.dataset.sub)}">${escapeHtml(note.title)}${span.dataset.sub ? ' › ' + escapeHtml(span.dataset.sub) : ''}</a>`;
      const body = document.createElement('div');
      body.className = 'markdown-embed-content markdown-rendered';
      renderInto(body, sectionOf(note.content || '', span.dataset.sub), { ...ctx, onToggleTask: null, depth: depth + 1 });
      box.append(head, body);
    }
    // 단락 안에 블록이 들어가지 않도록 단락 하나만 있으면 단락을 교체
    const p = span.parentElement;
    if (p?.tagName === 'P' && p.childNodes.length === 1) p.replaceWith(box);
    else span.replaceWith(box);
  }
}
