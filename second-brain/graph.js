// Obsidian식 그래프: 마우스를 올리면 이웃만 강조, 확대하면 이름이 나타난다.
import { forceSimulation, forceLink, forceManyBody, forceCollide, forceX, forceY } from './vendor.js';

/**
 * opts: { onOpen(node, newTab), colorOf(node) -> css var name, labelZoom, local }
 */
export function createGraph(canvas, opts) {
  const ctx = canvas.getContext('2d');
  const view = { x: 0, y: 0, k: 1 };
  let nodes = [], links = [], neighbors = new Map();
  let sim = null, hover = null, drag = null, W = 0, H = 0, dpr = 1, raf = 0, fitted = false, needFit = false;
  let colors = readColors();

  function readColors() {
    const css = getComputedStyle(canvas);
    const v = (n) => css.getPropertyValue(n).trim();
    return {
      node: v('--graph-node'), unresolved: v('--graph-node-unresolved'), tag: v('--graph-node-tag'),
      focused: v('--graph-node-focused'), line: v('--graph-line'), lineHi: v('--graph-line-highlight'),
      text: v('--graph-text'), me: v('--graph-node-me'), other: v('--graph-node-other'), bg: v('--graph-bg'),
    };
  }

  const radius = (n) => (n.tag ? 3.5 : 5) + Math.min(10, Math.sqrt(n.deg || 0) * 2);

  function setData(data, { keepPositions = true } = {}) {
    const old = new Map(nodes.map((n) => [n.id, n]));
    nodes = data.nodes.map((n) => {
      const o = keepPositions && old.get(n.id);
      return o ? Object.assign(o, n, { x: o.x, y: o.y, vx: o.vx, vy: o.vy }) : { ...n };
    });
    const ids = new Set(nodes.map((n) => n.id));
    links = data.links.filter((l) => ids.has(l.source) && ids.has(l.target)).map((l) => ({ ...l }));
    neighbors = new Map(nodes.map((n) => [n.id, new Set()]));
    for (const n of nodes) n.deg = 0;
    const byId = new Map(nodes.map((n) => [n.id, n]));
    for (const l of links) {
      neighbors.get(l.source).add(l.target);
      neighbors.get(l.target).add(l.source);
      byId.get(l.source).deg++;
      byId.get(l.target).deg++;
    }
    sim?.stop();
    const warm = !(keepPositions && old.size);
    sim = forceSimulation(nodes)
      .force('link', forceLink(links).id((d) => d.id).distance(opts.local ? 60 : 80).strength(0.5))
      .force('charge', forceManyBody().strength(opts.local ? -200 : -260).distanceMax(700))
      .force('x', forceX(0).strength(0.05))
      .force('y', forceY(0).strength(0.05))
      .force('collide', forceCollide().radius((d) => radius(d) + 4))
      .on('tick', schedule);
    if (warm) {
      // 처음에는 배치를 미리 계산해 두고 화면에 맞춘 뒤 살짝만 움직인다
      sim.stop();
      sim.tick(220);
      fitted = false;
      if (W) fit(); else needFit = true;
      sim.alpha(0.05).restart();
    } else {
      sim.alpha(0.3).restart();
    }
    schedule();
  }

  function resize() {
    const r = canvas.getBoundingClientRect();
    if (!r.width || !r.height) return;
    dpr = window.devicePixelRatio || 1;
    const first = !W;
    W = r.width; H = r.height;
    canvas.width = W * dpr;
    canvas.height = H * dpr;
    if (first) { view.x = W / 2; view.y = H / 2; }
    if (needFit) { needFit = false; fit(); }
    colors = readColors();
    schedule();
  }

  function fit() {
    if (!nodes.length || !W) return;
    fitted = true;
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const n of nodes) { x0 = Math.min(x0, n.x); y0 = Math.min(y0, n.y); x1 = Math.max(x1, n.x); y1 = Math.max(y1, n.y); }
    const pad = 60;
    const k = Math.min(1.5, Math.max(0.2, Math.min((W - pad) / (x1 - x0 || 1), (H - pad) / (y1 - y0 || 1))));
    view.k = k;
    view.x = W / 2 - ((x0 + x1) / 2) * k;
    view.y = H / 2 - ((y0 + y1) / 2) * k;
    schedule();
  }

  function schedule() {
    if (!raf) raf = requestAnimationFrame(() => { raf = 0; draw(); });
  }

  function draw() {
    if (!W) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);
    ctx.translate(view.x, view.y);
    ctx.scale(view.k, view.k);

    const focus = hover || drag?.node || null;
    const near = focus ? neighbors.get(focus.id) : null;
    const dim = (n) => focus && n !== focus && !near.has(n.id);

    ctx.lineWidth = 1 / view.k;
    for (const l of links) {
      const hi = focus && (l.source === focus || l.target === focus);
      ctx.strokeStyle = hi ? colors.lineHi : colors.line;
      ctx.globalAlpha = focus && !hi ? 0.15 : hi ? 1 : 0.6;
      ctx.lineWidth = (hi ? 1.6 : 1) / view.k;
      ctx.beginPath();
      ctx.moveTo(l.source.x, l.source.y);
      ctx.lineTo(l.target.x, l.target.y);
      ctx.stroke();
    }

    const labelAlpha = Math.max(0, Math.min(1, (view.k - (opts.labelZoom ?? 0.45)) / 0.35));
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    for (const n of nodes) {
      const r = radius(n);
      ctx.globalAlpha = dim(n) ? 0.2 : 1;
      ctx.beginPath();
      ctx.arc(n.x, n.y, r, 0, Math.PI * 2);
      ctx.fillStyle = n === focus ? colors.focused : n.current ? colors.focused : colors[opts.colorOf?.(n) || (n.tag ? 'tag' : n.unresolved ? 'unresolved' : 'node')];
      ctx.fill();
      if (n.current) {
        ctx.lineWidth = 2 / view.k;
        ctx.strokeStyle = colors.focused;
        ctx.beginPath();
        ctx.arc(n.x, n.y, r + 3 / view.k, 0, Math.PI * 2);
        ctx.stroke();
      }
      const show = n === focus || (near && near.has(n.id)) ? 1 : dim(n) ? 0 : labelAlpha;
      if (show > 0 || n.current) {
        ctx.globalAlpha = Math.max(show, n.current ? 1 : 0) * (dim(n) ? 0.3 : 1);
        ctx.fillStyle = colors.text;
        ctx.font = `${(n === focus ? 13 : 12) / Math.max(view.k, 0.6)}px system-ui, -apple-system, "Apple SD Gothic Neo", "Noto Sans KR", sans-serif`;
        ctx.fillText(n.label, n.x, n.y + r + 3 / view.k);
      }
    }
    ctx.globalAlpha = 1;
  }

  const toWorld = (e) => {
    const r = canvas.getBoundingClientRect();
    return { x: (e.clientX - r.left - view.x) / view.k, y: (e.clientY - r.top - view.y) / view.k };
  };
  const hit = (p) => {
    let best = null, bd = Infinity;
    for (const n of nodes) {
      const d = (n.x - p.x) ** 2 + (n.y - p.y) ** 2;
      const rr = (radius(n) + 5 / view.k) ** 2;
      if (d <= rr && d < bd) { best = n; bd = d; }
    }
    return best;
  };

  canvas.addEventListener('pointerdown', (e) => {
    const n = hit(toWorld(e));
    drag = n
      ? { node: n, moved: false, sx: e.clientX, sy: e.clientY }
      : { pan: true, sx: e.clientX - view.x, sy: e.clientY - view.y, moved: false, ox: e.clientX, oy: e.clientY };
    if (n) { n.fx = n.x; n.fy = n.y; sim?.alphaTarget(0.2).restart(); }
    canvas.setPointerCapture(e.pointerId);
    canvas.style.cursor = 'grabbing';
  });
  canvas.addEventListener('pointermove', (e) => {
    if (!drag) {
      const n = hit(toWorld(e));
      if (n !== hover) { hover = n; canvas.style.cursor = n ? 'pointer' : 'grab'; schedule(); }
      return;
    }
    if (drag.node) {
      if (Math.abs(e.clientX - drag.sx) + Math.abs(e.clientY - drag.sy) > 3) drag.moved = true;
      const p = toWorld(e);
      drag.node.fx = p.x; drag.node.fy = p.y;
    } else {
      if (Math.abs(e.clientX - drag.ox) + Math.abs(e.clientY - drag.oy) > 3) drag.moved = true;
      view.x = e.clientX - drag.sx; view.y = e.clientY - drag.sy;
      schedule();
    }
  });
  canvas.addEventListener('pointerup', (e) => {
    if (drag?.node) {
      const n = drag.node;
      n.fx = n.fy = null;
      sim?.alphaTarget(0);
      if (!drag.moved) opts.onOpen?.(n, e.metaKey || e.ctrlKey);
    }
    drag = null;
    canvas.style.cursor = hover ? 'pointer' : 'grab';
  });
  canvas.addEventListener('pointerleave', () => { if (!drag && hover) { hover = null; schedule(); } });
  canvas.addEventListener('wheel', (e) => {
    e.preventDefault();
    const r = canvas.getBoundingClientRect();
    const mx = e.clientX - r.left, my = e.clientY - r.top;
    const k = Math.min(6, Math.max(0.1, view.k * Math.exp(-e.deltaY * 0.0015)));
    view.x = mx - ((mx - view.x) * k) / view.k;
    view.y = my - ((my - view.y) * k) / view.k;
    view.k = k;
    schedule();
  }, { passive: false });

  const ro = new ResizeObserver(resize);
  ro.observe(canvas);
  resize();

  return {
    setData,
    fit,
    redraw() { colors = readColors(); schedule(); },
    destroy() { sim?.stop(); ro.disconnect(); cancelAnimationFrame(raf); },
  };
}
