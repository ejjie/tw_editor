// Module "pen". Quad pen: a vector stroke (points + bezier handles) that is turned into a ribbon of quads.
// Each segment becomes one quad whose short edges stand across the line; on curves the shared edges follow the
// angle bisector, so the quads become trapezoids. A straight segment is always one quad, a curved one uses the
// "subdivisions" of its start point (or the path default).
// The quads are ordinary DDNet quads. The paths themselves are editor-only data: they live on the layer as
// L._pen (so undo/redo restores them), are never written into the .map file and are stored in the browser.
import { h, prop, num, rgba, btn, popup, item } from './ui.js';
import { makeQuad, fixCornerOrder } from './map.js';
import { iconEl } from './icons.js';
import { getStored, putStored } from './session.js';
import { registerLayerExtra } from './history.js';
import { FEATURES } from './features.js';

// EXPERIMENTAL fill (pen-fill.js): optional, the pen works the same without that file
const penFill = FEATURES.penFill ? await import('./pen-fill.js').catch(() => null) : null;
const fillStroke = penFill ? penFill.fillStroke : null;

const FX = 1024;
const q = (v) => Math.round(v * FX) / FX; // positions as the .map file stores them, so saved quads still match
const MITER_LIMIT = 4; // corners sharper than this become a bevel quad (may be tuned later)
const HIT = 7; // px

export function newPath(defaults) {
  return { id: Math.random().toString(36).slice(2, 10), width: defaults.width, color: [...defaults.color], subdiv: defaults.subdiv, closed: false, fill: false, pts: [], fps: [] };
}

// ---------------------------------------------------------------- geometry

function bez(a, c1, c2, b, t) {
  const u = 1 - t;
  return [
    u * u * u * a[0] + 3 * u * u * t * c1[0] + 3 * u * t * t * c2[0] + t * t * t * b[0],
    u * u * u * a[1] + 3 * u * u * t * c1[1] + 3 * u * t * t * c2[1] + t * t * t * b[1],
  ];
}

// centre line of the path as a polyline; for a closed path the first point is not repeated
export function centerLine(path) {
  const P = path.pts, n = P.length;
  if (!n) return [];
  const out = [[P[0].x, P[0].y]];
  const segs = path.closed && n > 2 ? n : n - 1;
  for (let i = 0; i < segs; i++) {
    const a = P[i], b = P[(i + 1) % n];
    const last = path.closed && i === n - 1;
    if (!a.ho && !b.hi) { if (!last) out.push([b.x, b.y]); continue; }
    const c1 = a.ho ? [a.x + a.ho[0], a.y + a.ho[1]] : [a.x, a.y];
    const c2 = b.hi ? [b.x + b.hi[0], b.y + b.hi[1]] : [b.x, b.y];
    const steps = Math.max(1, Math.round(a.sub ?? path.subdiv));
    for (let k = 1; k <= steps; k++) { if (last && k === steps) break; out.push(bez([a.x, a.y], c1, c2, [b.x, b.y], k / steps)); }
  }
  // drop repeated points, they have no direction
  return out.filter((p, i) => i === 0 || Math.hypot(p[0] - out[i - 1][0], p[1] - out[i - 1][1]) > 0.01);
}

// quads (TL, TR, BL, BR) of the stroke
export function strokeQuads(path) {
  const V = centerLine(path);
  const closed = path.closed && V.length > 2;
  const n = V.length;
  if (n < 2) return [];
  const half = path.width / 2;
  const segCount = closed ? n : n - 1;
  const nor = [];
  for (let i = 0; i < segCount; i++) {
    const a = V[i], b = V[(i + 1) % n];
    const dx = b[0] - a[0], dy = b[1] - a[1], l = Math.hypot(dx, dy) || 1;
    nor.push([-dy / l, dx / l]);
  }
  // per vertex: the edge where the incoming segment ends and the one where the outgoing segment starts
  const ends = [], starts = [], bevels = [];
  const pair = (p, m, s) => [[p[0] + m[0] * s, p[1] + m[1] * s], [p[0] - m[0] * s, p[1] - m[1] * s]];
  for (let j = 0; j < n; j++) {
    const p = V[j];
    const nin = j > 0 ? nor[j - 1] : closed ? nor[segCount - 1] : null;
    const nout = j < segCount ? nor[j] : null;
    if (!nin || !nout) { const m = nin || nout; ends[j] = starts[j] = pair(p, m, half); continue; }
    let m = [nin[0] + nout[0], nin[1] + nout[1]];
    const ml = Math.hypot(m[0], m[1]);
    const cos = ml > 1e-6 ? (m[0] * nout[0] + m[1] * nout[1]) / ml : 0;
    if (cos < 1 / MITER_LIMIT) {
      // too sharp: square ends on both sides and a bevel quad that fills the outer gap
      ends[j] = pair(p, nin, half);
      starts[j] = pair(p, nout, half);
      bevels.push(j);
    } else {
      m = [m[0] / ml, m[1] / ml];
      ends[j] = starts[j] = pair(p, m, half / cos);
    }
  }
  // EXPERIMENTAL fill: the inner corners go into the shape, so the stroke quads cover the inside
  if (closed && path.fill && fillStroke) { const f = fillStroke(V, ends, starts, bevels, half); if (f) return f; }
  const quads = [];
  for (let i = 0; i < segCount; i++) {
    const s = starts[i], e = ends[(i + 1) % n];
    quads.push([s[0], e[0], s[1], e[1]]);
  }
  // sharp turns can make a stroke quad concave; its corners are ordered so DDNet's split stays inside it
  return [...quads, ...bevels.map((j) => [ends[j][0], starts[j][0], ends[j][1], starts[j][1]])].map(fixCornerOrder);
}

const fp = (qd) => qd.points.slice(0, 4).flat();
// does quad qd have fingerprint f (corners within 0.01)? No arrays are built per quad: regenerate runs on every
// mouse move and searches layers of thousands of quads
const quadIs = (qd, f) => {
  if (f.length !== 8) return false;
  const P = qd.points;
  for (let k = 0; k < 4; k++) if (Math.abs(P[k][0] - f[2 * k]) >= 0.01 || Math.abs(P[k][1] - f[2 * k + 1]) >= 0.01) return false;
  return true;
};

// ---------------------------------------------------------------- tool

export class QuadPen {
  constructor(ed) {
    this.ed = ed;
    this.on = false;
    this.pathId = null;     // active path
    this.drawing = false;   // clicks on empty space add points to the end of the active path
    this.sel = new Set();   // selected point indices of the active path
    this.anchor = null;     // start of a Shift+click range
    this.drag = null;
    this.defaults = { width: 32, color: [255, 255, 255, 255], subdiv: 8 };
    try { Object.assign(this.defaults, JSON.parse(localStorage.getItem('twe-pen') || '{}')); } catch { /* storage blocked */ }
    this.storeTimer = 0;
    this.loadedFor = null;
    ed.on('map', () => { if (this.loadedFor !== ed.map) { this.loadedFor = ed.map; this.reset(); this.load(); } });
    ed.on('history', () => this.persist());
  }

  get layer() { const L = this.ed.layer; return L && L.type === 'quads' ? L : null; }
  paths(L = this.layer) { if (!L) return []; if (!L._pen) L._pen = []; return L._pen; }
  get path() { return this.paths().find((p) => p.id === this.pathId) || null; }

  reset() { this.fromStart = false; this.pathId = null; this.drawing = false; this.sel.clear(); this.anchor = null; this.drag = null; }

  setOn(v) {
    this.on = v && !!this.layer;
    if (!this.on) this.reset();
    this.ed.emit('pen');
  }

  saveDefaults() { try { localStorage.setItem('twe-pen', JSON.stringify(this.defaults)); } catch { /* ignore */ } }

  // ------------------------------------------------ quads of a path

  regenerate(L, path) {
    const taken = new Set();
    for (const f of path.fps || []) {
      const i = L.quads.findIndex((qd, k) => quadIs(qd, f) && !taken.has(k));
      if (i >= 0) taken.add(i);
    }
    const shapes = strokeQuads(path);
    const made = shapes.map((s) => makeQuad(s.map(([x, y]) => [q(x), q(y)]), path.color));
    for (const m of made) m.points[4] = [q(m.points[4][0]), q(m.points[4][1])];
    const idx = [...taken].sort((a, b) => b - a);
    const at = idx.length ? idx[idx.length - 1] : L.quads.length;
    for (const i of idx) L.quads.splice(i, 1);
    L.quads.splice(Math.min(at, L.quads.length), 0, ...made);
    path.fps = made.map(fp);
    this.ed.quadSel.clear();
    this.ed.pointSel.clear();
    this.ed.touch(L);
  }

  // one undoable change of the active path
  edit(label, fn, path = this.path) {
    const L = this.layer;
    if (!L || !path) return;
    this.ed.history.edit(this.ed.map, 'layer', label, L, () => { fn(path); this.regenerate(L, path); });
    this.ed.emit('pen');
  }

  removePath(keepQuads) {
    const L = this.layer, path = this.path;
    if (!L || !path) return;
    this.ed.history.edit(this.ed.map, 'layer', keepQuads ? 'Pen: forget path' : 'Pen: delete path', L, () => {
      if (!keepQuads) { path.pts = []; this.regenerate(L, path); }
      L._pen = L._pen.filter((p) => p !== path);
    });
    this.reset();
    this.ed.emit('pen');
  }

  // ------------------------------------------------ mouse

  world() {
    let [x, y] = this.ed.screenToWorld(this.ed.mouse.sx, this.ed.mouse.sy);
    return [this.ed.snap(x), this.ed.snap(y)];
  }

  hitPoint(L) {
    const r = HIT / this.ed.gzoom();
    const [x, y] = this.ed.screenToWorld(this.ed.mouse.sx, this.ed.mouse.sy);
    const list = this.paths(L);
    const order = [...list].sort((a, b) => (b.id === this.pathId) - (a.id === this.pathId));
    for (const p of order) for (let i = p.pts.length - 1; i >= 0; i--) if (Math.hypot(p.pts[i].x - x, p.pts[i].y - y) <= r) return [p, i];
    return null;
  }

  hitHandle() {
    const path = this.path;
    if (!path) return null;
    const r = HIT / this.ed.gzoom();
    const [x, y] = this.ed.screenToWorld(this.ed.mouse.sx, this.ed.mouse.sy);
    for (const i of this.handleOwners(path)) {
      const p = path.pts[i];
      for (const w of ['hi', 'ho']) if (p[w] && Math.hypot(p.x + p[w][0] - x, p.y + p[w][1] - y) <= r) return [i, w];
    }
    return null;
  }

  // points whose handles are shown: the selected ones and their neighbours
  handleOwners(path) {
    const s = new Set();
    for (const i of this.sel) for (const k of [i - 1, i, i + 1]) if (k >= 0 && k < path.pts.length) s.add(k);
    if (this.drawing) s.add(this.fromStart ? 0 : path.pts.length - 1);
    return s;
  }

  mouseDown(e, L) {
    const ed = this.ed;
    this.sanitize();
    if (e.button === 2) {
      const hit = this.hitPoint(L);
      if (hit) { this.selectPoint(hit[0], hit[1], e); this.pointMenu(e.clientX, e.clientY); return; }
      this.finish();
      return;
    }
    if (e.button !== 0) return;
    const hh = this.hitHandle();
    if (hh) {
      ed.history.begin(ed.map, 'layer', 'Pen: handle', L);
      // Alt+drag moves one handle on its own, Alt+click removes it (a sharp corner on that side only)
      this.drag = { type: 'handle', idx: hh[0], which: hh[1], free: e.altKey, sx: ed.mouse.sx, sy: ed.mouse.sy, moved: !e.altKey };
      return;
    }
    const hit = this.hitPoint(L);
    if (hit) {
      const [path, i] = hit;
      // closing: while drawing, a click on the other end of the path; otherwise Shift+click on an end of the path
      // while only the other end is selected
      const n = path.pts.length, end = (k) => k === 0 || k === n - 1, other = i === 0 ? n - 1 : 0;
      const drawEnd = this.fromStart ? 0 : n - 1;
      const closing = !path.closed && n > 2 && end(i) && path.id === this.pathId &&
        (this.drawing ? i !== drawEnd : e.shiftKey && this.sel.size === 1 && this.sel.has(other));
      if (closing) {
        this.drawing = false;
        this.fromStart = false;
        this.sel = new Set([i]);
        this.anchor = i;
        this.edit('Pen: close path', (p) => { p.closed = true; });
        return;
      }
      this.selectPoint(path, i, e);
      // clicking an end of the path continues drawing from there (from the start: the path is turned around
      // when the next point is actually added, so a plain drag of the first point does not change anything)
      if (!e.shiftKey && !e.ctrlKey && !path.closed && (i === n - 1 || i === 0)) { this.drawing = true; this.fromStart = i === 0 && n > 1; } else this.drawing = false;
      ed.history.begin(ed.map, 'layer', 'Pen: move points', L);
      this.drag = { type: 'move', start: ed.screenToWorld(ed.mouse.sx, ed.mouse.sy), sx: ed.mouse.sx, sy: ed.mouse.sy, orig: [...this.sel].map((k) => [k, path.pts[k].x, path.pts[k].y]) };
      ed.emit('pen');
      return;
    }
    // empty space: add a point (a new path when nothing is being drawn)
    const [x, y] = this.world();
    ed.history.begin(ed.map, 'layer', 'Pen: add point', L);
    let path = this.drawing ? this.path : null;
    if (path && this.fromStart) {
      path.pts.reverse();
      for (const p of path.pts) [p.hi, p.ho] = [p.ho, p.hi];
    }
    this.fromStart = false;
    if (!path) {
      path = newPath(this.defaults);
      this.paths(L).push(path);
      this.pathId = path.id;
      this.drawing = true;
    }
    path.pts.push({ x, y, hi: null, ho: null, sub: null });
    const idx = path.pts.length - 1;
    this.sel = new Set([idx]);
    this.anchor = idx;
    this.drag = { type: 'new', idx, sx: ed.mouse.sx, sy: ed.mouse.sy };
    this.regenerate(L, path);
    ed.emit('pen');
  }

  selectPoint(path, i, e) {
    if (this.pathId !== path.id) { this.pathId = path.id; this.sel.clear(); this.anchor = null; }
    if (e.shiftKey && this.anchor !== null) {
      // Shift+click selects the whole range from the previous click
      const a = Math.min(this.anchor, i), b = Math.max(this.anchor, i);
      this.sel = new Set(Array.from({ length: b - a + 1 }, (_, k) => a + k));
    } else if (e.ctrlKey || e.metaKey) {
      if (this.sel.has(i)) this.sel.delete(i); else this.sel.add(i);
      this.anchor = i;
    } else {
      if (!this.sel.has(i)) this.sel = new Set([i]);
      this.anchor = i;
    }
  }

  mouseMove(e) {
    const d = this.drag, path = this.path, L = this.layer;
    if (!d || !path || !L) return false;
    const ed = this.ed;
    const [wx, wy] = ed.screenToWorld(ed.mouse.sx, ed.mouse.sy);
    if (d.type === 'new') {
      if (!d.moved && Math.hypot(ed.mouse.sx - d.sx, ed.mouse.sy - d.sy) < 4) return true;
      d.moved = true;
      // dragging while placing a point pulls out symmetric handles: a smooth curve point
      const p = path.pts[d.idx];
      p.ho = [wx - p.x, wy - p.y];
      p.hi = [-p.ho[0], -p.ho[1]];
    } else if (d.type === 'handle') {
      if (!d.moved && Math.hypot(ed.mouse.sx - d.sx, ed.mouse.sy - d.sy) < 4) return true;
      d.moved = true;
      const p = path.pts[d.idx];
      const v = [wx - p.x, wy - p.y];
      p[d.which] = v;
      const other = d.which === 'hi' ? 'ho' : 'hi';
      // smooth points keep both handles on one line (Alt breaks them apart)
      if (!d.free && !e.altKey && p[other]) {
        const l = Math.hypot(...p[other]), vl = Math.hypot(...v) || 1;
        p[other] = [-v[0] / vl * l, -v[1] / vl * l];
      }
    } else if (d.type === 'move') {
      let dx = wx - d.start[0], dy = wy - d.start[1];
      if (e.shiftKey) { if (Math.abs(dx) >= Math.abs(dy)) dy = 0; else dx = 0; }
      if (ed.opts.grid && d.orig.length) {
        const [, ox, oy] = d.orig[0];
        dx = ed.snap(ox + dx) - ox; dy = ed.snap(oy + dy) - oy;
      }
      for (const [k, ox, oy] of d.orig) { path.pts[k].x = ox + dx; path.pts[k].y = oy + dy; }
    }
    this.regenerate(L, path);
    ed.emit('quadmove');
    return true;
  }

  mouseUp() {
    const d = this.drag;
    if (!d) return false;
    this.drag = null;
    if (d.type === 'handle' && !d.moved && this.path && this.layer) {
      this.path.pts[d.idx][d.which] = null;
      this.regenerate(this.layer, this.path);
    }
    this.ed.history.commit();
    this.ed.emit('pen');
    return true;
  }

  // ------------------------------------------------ keys and menu

  finish() {
    this.drawing = false;
    this.fromStart = false;
    this.ed.redraw();
    this.ed.emit('pen');
  }

  sanitize() {
    const path = this.path;
    if (!path) { this.pathId = null; this.sel.clear(); this.drawing = false; return; }
    for (const i of [...this.sel]) if (i >= path.pts.length) this.sel.delete(i);
  }

  deleteSelected() {
    const path = this.path;
    if (!path || !this.sel.size) return;
    if (path.pts.length - this.sel.size < 2) { this.removePath(false); return; }
    this.edit('Pen: delete points', (p) => { p.pts = p.pts.filter((_, i) => !this.sel.has(i)); });
    this.sel.clear();
    this.anchor = null;
  }

  setSmooth(smooth) {
    this.edit(smooth ? 'Pen: smooth points' : 'Pen: corner points', (p) => {
      for (const i of this.sel) {
        const pt = p.pts[i];
        if (!smooth) { pt.hi = pt.ho = null; continue; }
        const a = p.pts[i - 1] || pt, b = p.pts[i + 1] || pt;
        let dx = b.x - a.x, dy = b.y - a.y;
        const l = Math.hypot(dx, dy) || 1;
        const len = Math.max(16, Math.min(Math.hypot(pt.x - a.x, pt.y - a.y), Math.hypot(b.x - pt.x, b.y - pt.y)) / 3);
        dx = dx / l * len; dy = dy / l * len;
        pt.ho = [dx, dy]; pt.hi = [-dx, -dy];
      }
    });
  }

  setSubdiv(v) {
    if (this.sel.size) this.edit('Pen: subdivisions', (p) => { for (const i of this.sel) p.pts[i].sub = v; });
  }

  pointMenu(x, y) {
    const path = this.path;
    if (!path) return;
    const n = this.sel.size;
    popup(x, y, (el) => el.append(
      item('Smooth (curve)', () => this.setSmooth(true)),
      item('Corner (sharp)', () => this.setSmooth(false)),
      h('hr'),
      item('Delete', () => this.deleteSelected(), { danger: true }),
    ), { title: n > 1 ? `${n} points` : `Point ${[...this.sel][0] + 1} of ${path.pts.length}` });
  }

  onKey(e) {
    if (!this.on) return false;
    if (e.key === 'Enter') { this.finish(); return true; }
    if (e.key === 'Escape') {
      if (this.drawing) this.finish();
      else if (this.sel.size) { this.sel.clear(); this.ed.emit('pen'); }
      else this.setOn(false);
      return true;
    }
    if (e.key === 'Delete' || e.key === 'Backspace') { this.deleteSelected(); return true; }
    if ((e.ctrlKey || e.metaKey) && (e.code === 'KeyA' || e.key.toLowerCase() === 'a') && this.path) {
      e.preventDefault();
      this.sel = new Set(this.path.pts.map((_, i) => i));
      this.ed.emit('pen');
      return true;
    }
    return false;
  }

  // ------------------------------------------------ overlay

  drawOverlay(ctx) {
    const L = this.layer;
    if (!this.on || !L) return;
    const ed = this.ed;
    const S = (x, y) => ed.worldToScreen(x, y);
    ctx.save();
    for (const path of this.paths(L)) {
      const active = path.id === this.pathId;
      const V = centerLine(path);
      if (V.length > 1) {
        ctx.beginPath();
        V.forEach(([x, y], i) => { const [sx, sy] = S(x, y); if (i) ctx.lineTo(sx, sy); else ctx.moveTo(sx, sy); });
        if (path.closed) ctx.closePath();
        ctx.lineWidth = active ? 1.5 : 1;
        ctx.strokeStyle = active ? '#4d8dff' : 'rgba(255,255,255,0.55)';
        ctx.stroke();
      }
      if (active) {
        // handles
        for (const i of this.handleOwners(path)) {
          const p = path.pts[i];
          const [px, py] = S(p.x, p.y);
          for (const w of ['hi', 'ho']) {
            if (!p[w]) continue;
            const [hx, hy] = S(p.x + p[w][0], p.y + p[w][1]);
            ctx.beginPath(); ctx.moveTo(px, py); ctx.lineTo(hx, hy); ctx.strokeStyle = 'rgba(255,255,255,0.7)'; ctx.lineWidth = 1; ctx.stroke();
            ctx.beginPath(); ctx.arc(hx, hy, 4, 0, Math.PI * 2); ctx.fillStyle = '#fff'; ctx.fill(); ctx.strokeStyle = '#4d8dff'; ctx.stroke();
          }
        }
        // next segment preview while drawing
        if (this.drawing && path.pts.length && ed.mouse.inside && !this.drag) {
          const last = path.pts[this.fromStart ? 0 : path.pts.length - 1];
          const [a, b] = S(last.x, last.y), [c, d] = S(...this.world());
          ctx.setLineDash([5, 4]); ctx.beginPath(); ctx.moveTo(a, b); ctx.lineTo(c, d); ctx.strokeStyle = 'rgba(77,141,255,0.9)'; ctx.stroke(); ctx.setLineDash([]);
        }
      }
      path.pts.forEach((p, i) => {
        const [sx, sy] = S(p.x, p.y);
        const sel = active && this.sel.has(i);
        const s = sel ? 8 : 7;
        ctx.fillStyle = sel ? '#4d8dff' : active ? '#fff' : 'rgba(255,255,255,0.7)';
        ctx.strokeStyle = '#0b1220';
        ctx.lineWidth = 1;
        if (p.hi || p.ho) { ctx.beginPath(); ctx.arc(sx, sy, s / 2 + 0.5, 0, Math.PI * 2); ctx.fill(); ctx.stroke(); } else { ctx.fillRect(sx - s / 2, sy - s / 2, s, s); ctx.strokeRect(sx - s / 2, sy - s / 2, s, s); }
        if (active && this.drawing && i === (this.fromStart ? 0 : path.pts.length - 1)) { ctx.strokeStyle = '#4d8dff'; ctx.lineWidth = 2; ctx.strokeRect(sx - 7, sy - 7, 14, 14); }
      });
    }
    ctx.restore();
  }

  // ------------------------------------------------ right panel

  props(root, cardTitle) {
    this.sanitize(); // undo may have removed selected points
    const ed = this.ed, path = this.path;
    const target = path || this.defaults;
    // a change to the path also becomes the setting for the next path (kept between sessions)
    const setPathOrDefault = (label, fn) => {
      fn(this.defaults); this.saveDefaults();
      if (path) this.edit(label, fn);
      else ed.emit('pen');
    };
    const tip = (el, t) => { el.title = t; return el; };
    root.append(cardTitle(path ? `Quad pen · ${path.pts.length} pts` : 'Quad pen'));
    root.append(prop('Width', tip(num(target.width, (v) => setPathOrDefault('Pen: width', (p) => (p.width = v)), { min: 1, max: 4096, step: 1 }), 'Stroke width')));
    root.append(prop('Colour', ...rgba(target.color, (c) => setPathOrDefault('Pen: colour', (p) => (p.color = c)))));
    root.append(prop('Subdiv', tip(num(target.subdiv, (v) => setPathOrDefault('Pen: subdivisions', (p) => (p.subdiv = Math.round(v))), { min: 1, max: 64, step: 1 }), 'Quads per curved segment')));
    if (!path) return;
    root.append(h('div', { class: 'btns' },
      btn(path.closed ? 'Open' : 'Close', () => this.edit(path.closed ? 'Pen: open path' : 'Pen: close path', (p) => { p.closed = !p.closed; if (!p.closed) p.fill = false; }),
        { class: 'toggle' + (path.closed ? ' on' : ''), title: path.closed ? 'Remove the closing segment' : 'Join the last point to the first (or click the first point while drawing)' }),
      fillStroke ? btn('Fill', () => this.edit('Pen: fill', (p) => { p.fill = !p.fill; if (p.fill) p.closed = true; }), // EXPERIMENTAL fill
        { class: 'toggle' + (path.fill ? ' on' : ''), title: 'Test feature: close the path and cover its inside with the same quads' }) : null,
      btn('Detach', () => this.removePath(true), { title: 'Keep the quads, drop the editable path' }),
      btn(iconEl('trash', 16), () => this.removePath(false), { class: 'danger', title: 'Delete the path and its quads' })));
    if (!this.sel.size) return;
    const subs = [...this.sel].map((i) => path.pts[i].sub ?? path.subdiv);
    const same = subs.every((v) => v === subs[0]);
    root.append(cardTitle(this.sel.size > 1 ? `Points · ${this.sel.size}` : `Point ${[...this.sel][0] + 1}`));
    root.append(prop('Subdiv', tip(num(same ? subs[0] : '', (v) => this.setSubdiv(Math.round(v)), { min: 1, max: 64, step: 1 }), 'Quads per curved segment after these points'),
      btn(iconEl('undo', 16), () => this.edit('Pen: subdivisions', (p) => { for (const i of this.sel) p.pts[i].sub = null; }), { class: 'ib', title: 'Use the path value' })));
    root.append(h('div', { class: 'btns' },
      btn('Smooth', () => this.setSmooth(true), { title: 'Curve through the points' }),
      btn('Corner', () => this.setSmooth(false), { title: 'Sharp corners' }),
      btn(iconEl('trash', 16), () => this.deleteSelected(), { class: 'danger', title: 'Delete points (Del)' })));
  }

  // ------------------------------------------------ storage (browser only, never in the .map)

  key() { return 'pen:' + this.ed.fileName; }

  persist() {
    clearTimeout(this.storeTimer);
    this.storeTimer = setTimeout(() => {
      const ed = this.ed;
      if (!ed.map) return;
      const entries = [];
      ed.map.groups.forEach((g, gi) => g.layers.forEach((L, li) => {
        if (L.type === 'quads' && L._pen && L._pen.length) entries.push({ g: gi, l: li, name: L.name, paths: L._pen });
      }));
      putStored(this.key(), entries).catch(() => {});
    }, 600);
  }

  async load() {
    const map = this.ed.map;
    let entries = null;
    try { entries = await getStored(this.key()); } catch { return; }
    if (!entries || map !== this.ed.map) return;
    for (const en of entries) {
      let L = map.groups[en.g] && map.groups[en.g].layers[en.l];
      if (!L || L.type !== 'quads' || L.name !== en.name) {
        L = null;
        for (const g of map.groups) for (const l of g.layers) if (!L && l.type === 'quads' && l.name === en.name && !(l._pen && l._pen.length)) L = l;
      }
      if (L) L._pen = en.paths;
    }
    this.ed.emit('pen');
  }
}

// plugs the pen into the editor: the Pen button and D, its keys while it is on, its panel (pen.props, called by the
// properties panel) and the mouse on quads layers (editor.js asks ed.pen first while it is on)
export function setup(ed) {
  const pen = ed.pen = new QuadPen(ed);
  registerLayerExtra('_pen', (l) => !!l.quads, (v) => structuredClone(v || [])); // the paths go with undo / redo
  const button = document.getElementById('btn-pen');
  ed.commands.pen = () => { pen.setOn(!pen.on); if (pen.on) { ed.clearQuadBrush(); ed.setPropsPanel?.(true); } };
  ed.on('pen', () => {
    button?.classList.toggle('on', pen.on);
    document.getElementById('view').classList.toggle('pen-mode', pen.on);
    ed.refreshProps?.();
  });
  ed.on('selection', () => { if (button) button.disabled = !(ed.layer && ed.layer.type === 'quads'); });
  ed.ext.keys.push((e, k, mod) => {
    if (pen.on && pen.onKey(e)) { e.preventDefault(); return true; }
    if (!mod && k === 'd' && ed.layer && ed.layer.type === 'quads') { ed.commands.pen(); return true; }
    return false;
  });
}
