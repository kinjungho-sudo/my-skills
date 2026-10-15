// CodeMirror 6 편집기 + Obsidian식 Live Preview
// 커서가 닿지 않은 곳의 마크다운 기호를 숨기고 링크·체크박스·임베드를 위젯으로 보여준다.
import {
  EditorState, StateEffect, Compartment, Prec,
  EditorView, keymap, Decoration, ViewPlugin, WidgetType, placeholder, drawSelection, dropCursor,
  defaultKeymap, history, historyKeymap, indentWithTab,
  syntaxTree, syntaxHighlighting, HighlightStyle, indentOnInput, bracketMatching,
  markdown, markdownLanguage,
  autocompletion, completionKeymap, closeBrackets, closeBracketsKeymap,
  search, searchKeymap, highlightSelectionMatches,
  tags as t,
} from './vendor.js';
import { renderInto, sectionOf } from './render.js';

const refreshEffect = StateEffect.define();

// ---------- 위젯 ----------
class LinkWidget extends WidgetType {
  constructor(target, sub, label, resolved, embed) {
    super();
    Object.assign(this, { target, sub, label, resolved, embed });
  }
  eq(o) { return o.target === this.target && o.sub === this.sub && o.label === this.label && o.resolved === this.resolved; }
  toDOM() {
    const a = document.createElement('span');
    a.className = 'cm-wikilink' + (this.resolved ? '' : ' is-unresolved');
    a.dataset.target = this.target;
    a.dataset.sub = this.sub;
    a.textContent = this.label;
    return a;
  }
  ignoreEvent(e) { return e.type === 'mousedown' || e.type === 'click'; }
}

class EmbedWidget extends WidgetType {
  constructor(target, sub, ctx, version) {
    super();
    Object.assign(this, { target, sub, ctx, version });
  }
  eq(o) { return o.target === this.target && o.sub === this.sub && o.version === this.version; }
  toDOM() {
    const box = document.createElement('div');
    box.className = 'markdown-embed cm-embed';
    const note = this.ctx.resolve(this.target);
    if (!note) {
      box.classList.add('is-unresolved');
      box.textContent = `"${this.target}" 노트가 아직 없습니다`;
      return box;
    }
    const head = document.createElement('div');
    head.className = 'markdown-embed-title';
    const a = document.createElement('span');
    a.className = 'cm-wikilink';
    a.dataset.target = note.title;
    a.dataset.sub = this.sub;
    a.textContent = note.title + (this.sub ? ' › ' + this.sub : '');
    head.append(a);
    const body = document.createElement('div');
    body.className = 'markdown-embed-content markdown-rendered';
    renderInto(body, sectionOf(note.content || '', this.sub), { resolve: this.ctx.resolve, depth: 1 });
    box.append(head, body);
    return box;
  }
  ignoreEvent() { return true; }
}

class CheckboxWidget extends WidgetType {
  constructor(checked) { super(); this.checked = checked; }
  eq(o) { return o.checked === this.checked; }
  toDOM() {
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.className = 'task-checkbox';
    cb.checked = this.checked;
    return cb;
  }
  ignoreEvent() { return false; }
}

class BulletWidget extends WidgetType {
  eq() { return true; }
  toDOM() {
    const s = document.createElement('span');
    s.className = 'cm-bullet';
    s.textContent = '•';
    return s;
  }
}

class HrWidget extends WidgetType {
  eq() { return true; }
  toDOM() { const s = document.createElement('span'); s.className = 'cm-hr-line'; return s; }
}

class ImageWidget extends WidgetType {
  constructor(url, alt) { super(); this.url = url; this.alt = alt; }
  eq(o) { return o.url === this.url; }
  toDOM() {
    const img = document.createElement('img');
    img.className = 'cm-image';
    img.src = this.url;
    img.alt = this.alt;
    return img;
  }
}

class CodeLangWidget extends WidgetType {
  constructor(lang) { super(); this.lang = lang; }
  eq(o) { return o.lang === this.lang; }
  toDOM() {
    const s = document.createElement('span');
    s.className = 'cm-code-lang';
    s.textContent = this.lang;
    return s;
  }
}

class CalloutLabel extends WidgetType {
  constructor(type) { super(); this.type = type; }
  eq(o) { return o.type === this.type; }
  toDOM() {
    const s = document.createElement('span');
    s.className = 'cm-callout-label';
    s.textContent = this.type.charAt(0).toUpperCase() + this.type.slice(1);
    return s;
  }
}

// ---------- Live Preview 데코레이션 ----------
const hide = Decoration.replace({});
const mark = (cls, attrs) => Decoration.mark({ class: cls, attributes: attrs });
const line = (cls) => Decoration.line({ class: cls });

function buildDecorations(view, ctx) {
  const { state } = view;
  const sel = state.selection.ranges;
  const focused = view.hasFocus;
  const touched = (from, to) => focused && sel.some((r) => r.from <= to && r.to >= from);
  const lineTouched = (pos) => {
    const l = state.doc.lineAt(pos);
    return touched(l.from, l.to);
  };
  const decos = [];
  const codeRanges = [];
  const tree = syntaxTree(state);

  for (const { from, to } of view.visibleRanges) {
    tree.iterate({
      from, to,
      enter: (node) => {
        const name = node.name;
        const nf = node.from, nt = node.to;
        const hm = /^ATXHeading(\d)$/.exec(name);
        if (hm) {
          decos.push(line(`cm-heading cm-h${hm[1]}`).range(state.doc.lineAt(nf).from));
          return;
        }
        if (name === 'HeaderMark') {
          const parent = node.node.parent?.name || '';
          if (/^ATXHeading/.test(parent) && !lineTouched(nf)) {
            const end = state.doc.sliceString(nt, nt + 1) === ' ' ? nt + 1 : nt;
            decos.push(hide.range(nf, end));
          }
          return;
        }
        if (name === 'FencedCode' || name === 'CodeBlock') {
          codeRanges.push([nf, nt]);
          const first = state.doc.lineAt(nf).number, last = state.doc.lineAt(nt).number;
          const open = touched(nf, nt);
          for (let i = first; i <= last; i++) {
            const l = state.doc.line(i);
            const isFence = name === 'FencedCode' && (i === first || (i === last && /^\s*(```|~~~)/.test(l.text)));
            decos.push(line('cm-codeblock' + (isFence ? ' cm-codeblock-fence' : '') + (i === first ? ' cm-codeblock-first' : '') + (i === last ? ' cm-codeblock-last' : '')).range(l.from));
            // 커서가 밖에 있으면 ``` 줄은 언어 이름만 작게 보여준다
            if (isFence && !open && l.to > l.from) {
              const lang = i === first ? l.text.replace(/^\s*(```|~~~)\s*/, '').trim() : '';
              decos.push(Decoration.replace({ widget: new CodeLangWidget(lang) }).range(l.from, l.to));
            }
          }
          return false;
        }
        if (name === 'InlineCode') {
          codeRanges.push([nf, nt]);
          decos.push(mark('cm-inline-code').range(nf, nt));
          if (!touched(nf, nt)) {
            const n = node.node;
            for (let c = n.firstChild; c; c = c.nextSibling) if (c.name === 'CodeMark') decos.push(hide.range(c.from, c.to));
          }
          return false;
        }
        if (name === 'EmphasisMark' || name === 'StrikethroughMark') {
          const p = node.node.parent;
          if (p && !touched(p.from, p.to)) decos.push(hide.range(nf, nt));
          return;
        }
        if (name === 'Link') {
          if (touched(nf, nt)) return;
          const n = node.node;
          const marks = [];
          let url = null;
          for (let c = n.firstChild; c; c = c.nextSibling) {
            if (c.name === 'LinkMark') marks.push(c);
            if (c.name === 'URL') url = state.doc.sliceString(c.from, c.to);
          }
          if (marks.length >= 2 && url) {
            const textFrom = marks[0].to, textTo = marks[1].from;
            decos.push(hide.range(nf, textFrom));
            decos.push(mark('cm-external-link', { 'data-href': url }).range(textFrom, textTo));
            decos.push(hide.range(textTo, nt));
          }
          return false;
        }
        if (name === 'Image') {
          if (touched(nf, nt)) return;
          const text = state.doc.sliceString(nf, nt);
          const m = /^!\[([^\]]*)\]\((https?:\/\/[^\s)]+)/.exec(text);
          if (m) decos.push(Decoration.replace({ widget: new ImageWidget(m[2], m[1]) }).range(nf, nt));
          return false;
        }
        if (name === 'Blockquote') {
          const first = state.doc.lineAt(nf).number, last = state.doc.lineAt(nt).number;
          const firstText = state.doc.line(first).text;
          const cm = /^\s*>\s*\[!([\w-]+)\][+-]?/.exec(firstText);
          for (let i = first; i <= last; i++) {
            const l = state.doc.line(i);
            const cls = cm ? `cm-callout cm-callout-${cm[1].toLowerCase()}` : 'cm-quote';
            decos.push(line(cls + (i === first ? ' cm-block-first' : '') + (i === last ? ' cm-block-last' : '')).range(l.from));
          }
          if (cm && !lineTouched(nf)) {
            const l = state.doc.line(first);
            const at = l.from + firstText.indexOf('[!');
            const end = l.from + cm.index + cm[0].length;
            decos.push(Decoration.replace({ widget: new CalloutLabel(cm[1]) }).range(at, end));
          }
          return;
        }
        if (name === 'QuoteMark') {
          if (!lineTouched(nf)) {
            const end = state.doc.sliceString(nt, nt + 1) === ' ' ? nt + 1 : nt;
            decos.push(hide.range(nf, end));
          }
          return;
        }
        if (name === 'ListMark') {
          const parent = node.node.parent;
          const text = state.doc.sliceString(nf, nt);
          const isTask = parent?.getChild('Task');
          if (/^[-*+]$/.test(text) && !isTask && !touched(nf, nt + 1)) {
            decos.push(Decoration.replace({ widget: new BulletWidget() }).range(nf, nt));
          }
          if (isTask && !lineTouched(nf)) decos.push(hide.range(nf, nt + 1));
          return;
        }
        if (name === 'TaskMarker') {
          const checked = /x/i.test(state.doc.sliceString(nf, nt));
          if (checked) {
            const l = state.doc.lineAt(nf);
            decos.push(mark('cm-task-done').range(nt, l.to));
          }
          if (!touched(nf, nt)) decos.push(Decoration.replace({ widget: new CheckboxWidget(checked) }).range(nf, nt));
          return;
        }
        if (name === 'HorizontalRule') {
          if (!lineTouched(nf)) {
            decos.push(Decoration.replace({ widget: new HrWidget() }).range(nf, nt));
          }
          return;
        }
        return undefined;
      },
    });

    // 정규식으로 찾는 Obsidian 문법: [[링크]], ![[임베드]], ==형광펜==, #태그
    const text = state.doc.sliceString(from, to);
    const inCode = (pos) => codeRanges.some(([a, b]) => pos >= a && pos < b);

    for (const m of text.matchAll(/(!?)\[\[([^\]|#^\n]+)([#^][^\]|\n]*)?(?:\|([^\]\n]*))?\]\]/g)) {
      const s = from + m.index, e = s + m[0].length;
      if (inCode(s)) continue;
      const target = m[2].trim();
      const sub = (m[3] || '').slice(1).trim();
      const resolved = !!ctx.resolve(target);
      if (m[1] && !touched(s, e)) {
        const l = state.doc.lineAt(s);
        const whole = l.text.trim() === m[0];
        if (whole) {
          decos.push(Decoration.replace({ widget: new EmbedWidget(target, sub, ctx, ctx.resolve(target)?.version ?? -1) }).range(s, e));
          continue;
        }
      }
      if (touched(s, e)) {
        decos.push(mark('cm-wikilink-source' + (resolved ? '' : ' is-unresolved'), { 'data-target': target, 'data-sub': sub }).range(s, e));
      } else {
        const label = m[4]?.trim() || (sub ? `${target} > ${sub}` : target);
        decos.push(Decoration.replace({ widget: new LinkWidget(target, sub, label, resolved, !!m[1]) }).range(s, e));
      }
    }

    for (const m of text.matchAll(/==(?=\S)([^\n]*?\S)==/g)) {
      const s = from + m.index, e = s + m[0].length;
      if (inCode(s)) continue;
      decos.push(mark('cm-highlight').range(s, e));
      if (!touched(s, e)) { decos.push(hide.range(s, s + 2)); decos.push(hide.range(e - 2, e)); }
    }

    for (const m of text.matchAll(/(^|[\s(])#([\p{L}\p{N}_\-/]*[\p{L}_\-/][\p{L}\p{N}_\-/]*)/gu)) {
      const s = from + m.index + m[1].length, e = s + m[2].length + 1;
      if (inCode(s)) continue;
      const lt = state.doc.lineAt(s);
      if (/^#{1,6}\s/.test(lt.text) && s === lt.from) continue;
      decos.push(mark('cm-tag', { 'data-tag': m[2] }).range(s, e));
    }
  }
  return Decoration.set(decos, true);
}

function livePreview(ctx) {
  return ViewPlugin.fromClass(class {
    constructor(view) { this.decorations = safeBuild(view, ctx); }
    update(u) {
      if (u.docChanged || u.viewportChanged || u.selectionSet || u.focusChanged ||
          syntaxTree(u.startState) !== syntaxTree(u.state) ||
          u.transactions.some((tr) => tr.effects.some((e) => e.is(refreshEffect)))) {
        this.decorations = safeBuild(u.view, ctx);
      }
    }
  }, { decorations: (v) => v.decorations });
}

function safeBuild(view, ctx) {
  try { return buildDecorations(view, ctx); } catch (e) { console.error(e); return Decoration.none; }
}

// ---------- 서식 강조 (커서가 있는 줄에서 보이는 기호는 흐리게) ----------
const mdHighlight = HighlightStyle.define([
  { tag: t.processingInstruction, color: 'var(--text-faint)' },
  { tag: t.meta, color: 'var(--text-faint)' },
  { tag: t.url, color: 'var(--text-faint)' },
  { tag: t.strong, fontWeight: '700' },
  { tag: t.emphasis, fontStyle: 'italic' },
  { tag: t.strikethrough, textDecoration: 'line-through', color: 'var(--text-muted)' },
  { tag: t.link, color: 'var(--link)' },
  { tag: t.heading, fontWeight: '700', color: 'var(--text-heading)' },
  { tag: t.quote, color: 'var(--text-normal)' },
  { tag: t.monospace, fontFamily: 'var(--font-mono)' },
  { tag: t.keyword, color: 'var(--code-keyword)' },
  { tag: t.string, color: 'var(--code-string)' },
  { tag: t.comment, color: 'var(--text-faint)', fontStyle: 'italic' },
]);

// ---------- 자동완성: [[노트]], [[노트#소제목]], #태그 ----------
function completions(ctx) {
  return (context) => {
    const link = context.matchBefore(/\[\[[^\]\n|]*$/);
    if (link) {
      const q = link.text.slice(2);
      const hashAt = q.indexOf('#');
      const after = context.state.doc.sliceString(context.pos, context.pos + 2);
      const closeLen = after === ']]' ? 2 : 0;
      const finish = (insert) => (view, _c, from, to) => {
        view.dispatch({
          changes: { from, to: to + closeLen, insert: insert + ']]' },
          selection: { anchor: from + insert.length + 2 },
        });
      };
      if (hashAt >= 0) {
        const note = ctx.resolve(q.slice(0, hashAt));
        if (!note) return null;
        const from = link.from + 2 + hashAt + 1;
        return {
          from,
          options: ctx.headings(note).map((h) => ({ label: h.text, detail: 'H' + h.level, apply: finish(h.text) })),
          validFor: /^[^\]\n|#]*$/,
        };
      }
      const options = ctx.notes().map((n) => ({
        label: n.title,
        detail: n.folder || '',
        apply: finish(n.title),
        boost: n.recent || 0,
      }));
      return { from: link.from + 2, options, validFor: /^[^\]\n|#]*$/ };
    }
    const tag = context.matchBefore(/(?:^|\s)#[\p{L}\p{N}_\-/]*$/u);
    if (tag && (tag.text.length > 1 || context.explicit)) {
      const from = tag.from + tag.text.indexOf('#') + 1;
      return { from, options: ctx.tags().map(([name, count]) => ({ label: name, detail: String(count), type: 'keyword' })), validFor: /^[\p{L}\p{N}_\-/]*$/u };
    }
    return null;
  };
}

// ---------- 서식 단축키 ----------
function wrapWith(marker) {
  return (view) => {
    const changes = view.state.changeByRange((r) => {
      const text = view.state.sliceDoc(r.from, r.to);
      const ml = marker.length;
      if (text.startsWith(marker) && text.endsWith(marker) && text.length >= ml * 2) {
        return { changes: { from: r.from, to: r.to, insert: text.slice(ml, -ml) }, range: { anchor: r.from, head: r.to - ml * 2 } };
      }
      return {
        changes: [{ from: r.from, insert: marker }, { from: r.to, insert: marker }],
        range: r.empty ? { anchor: r.from + ml } : { anchor: r.from + ml, head: r.to + ml },
      };
    });
    view.dispatch(view.state.update(changes, { scrollIntoView: true, userEvent: 'input' }));
    return true;
  };
}

function toggleCheckbox(view) {
  const changes = [];
  for (const r of view.state.selection.ranges) {
    const l = view.state.doc.lineAt(r.head);
    const m = /^(\s*)([-*+]\s+)?(\[[ xX]\]\s+)?/.exec(l.text);
    if (m[3]) {
      const at = l.from + m[1].length + (m[2]?.length || 0) + 1;
      changes.push({ from: at, to: at + 1, insert: /x/i.test(m[3]) ? ' ' : 'x' });
    } else {
      const at = l.from + m[1].length + (m[2]?.length || 0);
      changes.push({ from: at, insert: (m[2] ? '' : '- ') + '[ ] ' });
    }
  }
  view.dispatch({ changes, userEvent: 'input' });
  return true;
}

// ---------- 편집기 생성 ----------
/**
 * ctx: { resolve(title), notes(), tags(), headings(note), version(), onChange(text),
 *        onOpenLink(target, sub, newTab), onTag(tag), onHover(el, target, sub) }
 */
export function createEditor(parent, doc, ctx) {
  const editable = new Compartment();
  let silent = false;

  const clickHandler = EditorView.domEventHandlers({
    mousedown(e, view) {
      const el = e.target;
      const link = el.closest?.('.cm-wikilink');
      if (link && e.button === 0) {
        e.preventDefault();
        ctx.onOpenLink(link.dataset.target, link.dataset.sub, e.metaKey || e.ctrlKey);
        return true;
      }
      const src = el.closest?.('.cm-wikilink-source');
      if (src && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        ctx.onOpenLink(src.dataset.target, src.dataset.sub, true);
        return true;
      }
      const ext = el.closest?.('.cm-external-link');
      if (ext && e.button === 0) {
        e.preventDefault();
        window.open(ext.dataset.href, '_blank', 'noopener,noreferrer');
        return true;
      }
      const tag = el.closest?.('.cm-tag');
      if (tag && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        ctx.onTag(tag.dataset.tag);
        return true;
      }
      if (el.classList?.contains('task-checkbox')) {
        e.preventDefault();
        const pos = view.posAtDOM(el);
        const l = view.state.doc.lineAt(pos);
        const m = /\[([ xX])\]/.exec(view.state.doc.sliceString(pos, l.to));
        if (m) {
          const at = pos + m.index + 1;
          view.dispatch({ changes: { from: at, to: at + 1, insert: m[1] === ' ' ? 'x' : ' ' }, userEvent: 'input' });
        }
        return true;
      }
      return false;
    },
    mouseover(e) {
      const el = e.target.closest?.('.cm-wikilink, .cm-wikilink-source');
      if (el) ctx.onHover(el, el.dataset.target, el.dataset.sub, e);
      return false;
    },
  });

  const state = EditorState.create({
    doc,
    extensions: [
      history(),
      drawSelection(),
      dropCursor(),
      indentOnInput(),
      bracketMatching(),
      closeBrackets(),
      highlightSelectionMatches(),
      search({ top: true }),
      EditorView.lineWrapping,
      markdown({ base: markdownLanguage, addKeymap: true }),
      syntaxHighlighting(mdHighlight),
      autocompletion({ override: [completions(ctx)], icons: false, activateOnTyping: true }),
      placeholder('내용을 입력하세요. [[ 를 입력하면 다른 노트를 연결합니다.'),
      editable.of(EditorView.editable.of(true)),
      livePreview(ctx),
      clickHandler,
      Prec.high(keymap.of([
        { key: 'Mod-b', run: wrapWith('**') },
        { key: 'Mod-i', run: wrapWith('*') },
        { key: 'Mod-Shift-h', run: wrapWith('==') },
        { key: 'Mod-l', run: toggleCheckbox },
      ])),
      keymap.of([...closeBracketsKeymap, ...completionKeymap, ...searchKeymap, ...historyKeymap, ...defaultKeymap, indentWithTab]),
      EditorView.updateListener.of((u) => {
        if (u.docChanged && !silent) ctx.onChange(u.state.doc.toString());
      }),
    ],
  });

  const view = new EditorView({ state, parent });

  return {
    view,
    getText: () => view.state.doc.toString(),
    // 원격 변경 반영: 커서 위치를 최대한 유지
    setText(text) {
      const cur = view.state.doc.toString();
      if (cur === text) return;
      let start = 0;
      while (start < cur.length && start < text.length && cur[start] === text[start]) start++;
      let endA = cur.length, endB = text.length;
      while (endA > start && endB > start && cur[endA - 1] === text[endB - 1]) { endA--; endB--; }
      silent = true;
      view.dispatch({ changes: { from: start, to: endA, insert: text.slice(start, endB) } });
      silent = false;
    },
    refresh() { view.dispatch({ effects: refreshEffect.of(null) }); },
    focus() { view.focus(); },
    setEditable(on) { view.dispatch({ effects: editable.reconfigure(EditorView.editable.of(on)) }); },
    scrollToLine(n) {
      const l = view.state.doc.line(Math.min(Math.max(1, n + 1), view.state.doc.lines));
      view.dispatch({ selection: { anchor: l.from }, effects: EditorView.scrollIntoView(l.from, { y: 'start', yMargin: 40 }) });
      view.focus();
    },
    selectRange(from, to) {
      view.dispatch({ selection: { anchor: from, head: to }, effects: EditorView.scrollIntoView(from, { y: 'center' }) });
      view.focus();
    },
    insertAtCursor(text) {
      const r = view.state.selection.main;
      view.dispatch({ changes: { from: r.from, to: r.to, insert: text }, selection: { anchor: r.from + text.length } });
      view.focus();
    },
    destroy() { view.destroy(); },
  };
}
