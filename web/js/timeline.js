// Module "timeline". Timeline: keyframe animation of quads on top of DDNet's own envelopes, so every map stays a normal DDNet map.
// K (or the Key button) keys position, rotation and colour of the selected quads at the playhead; with the
// timeline open, moving (drag) or turning (R) an animated quad is an unkeyed change shown in orange until K
// writes it into the keys. Keys can be dragged in time, deleted, given a curve and edited by value here.
import { h, btn, num, select, popup, item } from './ui.js';
import { iconEl } from './icons.js';
import { evalEnvelope, CURVE, CURVE_NAMES } from './envelope.js';
import { curvePreview } from './previews.js';

const RULER = 24, ROW = 28, PAD = 12;
const CURVES = [0, 1, 2, 3, 4]; // Step … Smooth; Bezier needs tangents, which the timeline does not edit yet
const CH = { 1: ['V'], 3: ['X', 'Y', 'Rot'], 4: ['R', 'G', 'B', 'A'] };

// the envelopes shown: those of the selected quads, else of the layer, else all of them
function rowsFor(ed) {
  const map = ed.map, L = ed.layer, rows = [], seen = new Set();
  const add = (i, what, owner) => {
    const e = map.envelopes[i];
    if (!e || seen.has(i)) return;
    seen.add(i);
    rows.push({ env: e, index: i, what, owner });
  };
  if (L && L.type === 'quads') {
    const qs = ed.quadSel.size ? [...ed.quadSel].map((i) => L.quads[i]).filter(Boolean) : L.quads;
    for (const q of qs) { add(q.posEnv, 'Position'); add(q.colorEnv, 'Colour'); }
    if (ed.quadSel.size || rows.length) return { rows, scope: ed.quadSel.size ? `${ed.quadSel.size} selected quad${ed.quadSel.size > 1 ? 's' : ''}` : `layer ${L.name || 'Quads'}` };
  }
  if (L && L.type === 'tiles' && L.colorEnv >= 0) { add(L.colorEnv, 'Colour'); return { rows, scope: `layer ${L.name || 'Tiles'}` }; }
  map.envelopes.forEach((e, i) => add(i, e.channels === 3 ? 'Position' : e.channels === 4 ? 'Colour' : 'Sound'));
  return { rows, scope: 'all envelopes' };
}

const duration = (e) => (e.points.length ? e.points[e.points.length - 1].time : 0);

// put a key (values as floats: units, degrees or 0..1 colour) at time t into an envelope; a key at the same
// time is replaced. The first key of an envelope that starts later also gets a copy at 0, so the quad holds
// still until the animation starts (DDNet shows the last key before the first one otherwise).
export function putKey(env, t, values, curve = CURVE.LINEAR) {
  t = Math.max(0, Math.round(t));
  const v = [0, 1, 2, 3].map((c) => Math.round((values[c] ?? 0) * 1024));
  const at = env.points.findIndex((p) => Math.abs(p.time - t) < 1);
  if (at >= 0) { env.points[at].values = v; return env.points[at]; }
  const p = { time: t, curve, values: v };
  if (!env.points.length && t > 0) env.points.push({ time: 0, curve, values: [...v] });
  env.points.push(p);
  env.points.sort((a, b) => a.time - b.time);
  return p;
}

// K: a key at the current time for position (x, y, rotation) and colour of the selected quads.
// Quads without envelopes get new ones (one position and one colour envelope shared by the quads keyed together).
export function setKeys(ed) {
  const L = ed.layer;
  if (!L || L.type !== 'quads' || !ed.quadSel.size) { ed.status('Select quads to set keys (K)'); return; }
  const map = ed.map, t = Math.max(0, Math.round(ed.opts.time));
  const qs = [...ed.quadSel].map((i) => L.quads[i]).filter(Boolean);
  let made = 0;
  ed.history.edit(map, 'anim', 'Set keys', L, () => {
    const newEnv = (channels, name) => { map.envelopes.push({ name, channels, synchronized: false, points: [] }); made++; return map.envelopes.length - 1; };
    const n = map.envelopes.length + 1;
    let posNew = -1, colNew = -1;
    for (const q of qs) {
      if (!(q.posEnv >= 0 && map.envelopes[q.posEnv])) { if (posNew < 0) posNew = newEnv(3, `pos ${n}`.slice(0, 31)); q.posEnv = posNew; q.posEnvOffset = 0; }
      if (!(q.colorEnv >= 0 && map.envelopes[q.colorEnv])) { if (colNew < 0) colNew = newEnv(4, `color ${n}`.slice(0, 31)); q.colorEnv = colNew; q.colorEnvOffset = 0; }
    }
    // one key per envelope, from the first selected quad that uses it
    const done = new Set();
    for (const q of qs) {
      const pe = map.envelopes[q.posEnv];
      if (!done.has(pe)) { done.add(pe); putKey(pe, t - (q.posEnvOffset | 0), ed.posOffset(q), ed.anim.curve); }
      const ce = map.envelopes[q.colorEnv];
      if (!done.has(ce)) {
        done.add(ce);
        const v = ce.points.length ? evalEnvelope(ce, t + (q.colorEnvOffset | 0)) : [1, 1, 1, 1];
        putKey(ce, t - (q.colorEnvOffset | 0), v, ed.anim.curve);
      }
    }
    for (const q of qs) delete q._pose;
  });
  ed.touch(L);
  ed.emit('envelopes');
  ed.status(`Keys at ${(t / 1000).toFixed(2)} s for ${qs.length} quad${qs.length > 1 ? 's' : ''}${made ? `, ${made} new envelope${made > 1 ? 's' : ''}` : ''}`);
}

// the path of the pivot over one loop of the position envelope, with a dot on every key
function drawMotionPath(ed, ctx, q, S) {
  const e = ed.map.envelopes[q.posEnv], end = e.points.length ? e.points[e.points.length - 1].time : 0;
  if (!end) return;
  const [cx, cy] = q.points[4];
  const at = (t) => { const v = evalEnvelope(e, t); return S(cx + v[0], cy + v[1]); };
  ctx.save();
  ctx.strokeStyle = 'rgba(240,178,50,0.8)'; ctx.setLineDash([4, 4]); ctx.lineWidth = 1.5;
  ctx.beginPath();
  const n = Math.min(400, Math.max(24, e.points.length * 24));
  for (let k = 0; k <= n; k++) { const [x, y] = at((end * k) / n); if (k) ctx.lineTo(x, y); else ctx.moveTo(x, y); }
  ctx.stroke();
  ctx.setLineDash([]);
  for (const p of e.points) {
    const [x, y] = at(p.time || 0.0001);
    ctx.fillStyle = ed.anim.keySel.has(p) ? '#f0b232' : '#ffffff';
    ctx.beginPath(); ctx.moveTo(x, y - 4); ctx.lineTo(x + 4, y); ctx.lineTo(x, y + 4); ctx.lineTo(x - 4, y); ctx.closePath(); ctx.fill();
  }
  ctx.restore();
}

// plugs the timeline into the editor: its tab in the bottom panel (dock button with the keys icon), K, Delete for
// selected keys, and the motion paths of the selected quads on the map
export function setup(ed) {
  ed.setKeys = () => setKeys(ed);
  ed.ext.tabs.set('timeline', {
    title: 'Timeline',
    render: timelineTab,
    refreshOn: ['history', 'selection', 'envelopes'],
    // the timeline turns moves of animated quads into unkeyed changes; closing it drops those that were not keyed
    onShow(open) {
      if (ed.anim.on && !open) {
        let n = 0;
        for (const g of ed.map.groups) for (const l of g.layers) if (l.type === 'quads') n += ed.clearPoses(l);
        if (n) ed.status(`${n} unkeyed quad move${n > 1 ? 's' : ''} dropped (press K before closing the timeline to keep them)`);
      }
      ed.anim.on = open;
    },
  });
  ed.ext.keys.push((e, k, mod) => {
    if (mod) return false;
    if (k === 'k') {
      // keys at the playhead for the selected quads; the timeline opens so they can be seen
      if (!e.repeat) { if (!ed.anim.on) ed.openTab?.('timeline'); setKeys(ed); }
      return true;
    }
    if ((e.key === 'Delete' || e.key === 'Backspace') && ed.anim.on && ed.anim.focus && ed.anim.keySel.size && ed.anim.deleteKeys) {
      ed.anim.deleteKeys();
      return true;
    }
    return false;
  });
  ed.ext.quadOverlays.push((ctx, L, S) => {
    if (!ed.anim.on) return;
    for (const i of ed.quadSel) { const q = L.quads[i]; if (q && q.posEnv >= 0 && ed.map.envelopes[q.posEnv]) drawMotionPath(ed, ctx, q, S); }
  });
}

export function timelineTab(ed, root) {
  const A = ed.anim;
  A.view ||= { t0: -200, msPerPx: 5 };
  const V = A.view;
  const { rows, scope } = rowsFor(ed);
  const live = new Set(rows.flatMap((r) => r.env.points));
  for (const p of [...A.keySel]) if (!live.has(p)) A.keySel.delete(p); // keys gone after undo or another layer
  const maxLen = Math.max(0, ...rows.map((r) => duration(r.env)));
  const shownTime = () => (ed.opts.play && maxLen > 0 ? ed.opts.time % maxLen : ed.opts.time);

  // ---------------- edits (one undo step each; 'anim' keeps the envelopes)
  const editEnv = (label, fn) => { ed.history.edit(ed.map, 'anim', label, null, fn); ed.redraw(); ed.emit('envelopes'); };
  const selected = () => rows.flatMap((r) => r.env.points.filter((p) => A.keySel.has(p)).map((p) => [r, p]));
  const deleteKeys = () => {
    const sel = selected();
    if (!sel.length) return;
    editEnv(sel.length > 1 ? 'Delete keys' : 'Delete key', () => { for (const [r, p] of sel) r.env.points.splice(r.env.points.indexOf(p), 1); });
    A.keySel.clear();
  };
  A.deleteKeys = deleteKeys;
  const setCurve = (c) => {
    A.curve = c;
    const sel = selected();
    if (sel.length) editEnv('Curve', () => { for (const [, p] of sel) p.curve = c; });
    else draw();
  };

  // ---------------- toolbar
  const timeLabel = h('span', { class: 'tl-time' });
  const playBtn = h('button', { class: 'ib' + (ed.opts.play ? ' on' : ''), title: 'Play / pause the animation', onclick: () => { ed.opts.play = !ed.opts.play; ed.emit('toggles'); playBtn.classList.toggle('on', ed.opts.play); } }, iconEl('play'));
  const curveSel = select(CURVES.map((i) => [i, CURVE_NAMES[i]]), A.curve, (v) => setCurve(+v), { preview: curvePreview });
  curveSel.title = 'Curve from the selected keys to the next ones (also used for new keys)';
  const bar = h('div', { class: 'tl-bar' },
    h('button', { class: 'ib', title: 'Back to 0 (Home)', onclick: () => { ed.opts.time = 0; ed.redraw(); draw(); } }, iconEl('rotL')),
    playBtn, timeLabel,
    btn('Key (K)', () => setKeys(ed), { title: 'Key position, rotation and colour of the selected quads at the playhead' }),
    btn('Delete key', deleteKeys, { title: 'Delete the selected keys (Delete)' }),
    curveSel,
    btn('Fit', () => { fit(); draw(); }, { title: 'Show all keys' }),
    h('span', { class: 'tl-scope' }, `Showing: ${scope}`));

  // ---------------- tracks
  const labels = h('div', { class: 'tl-labels' }, h('div', { class: 'tl-lhead', style: { height: RULER + 'px' } }, 'Envelope'),
    ...rows.map((r) => h('div', { class: 'tl-lrow', style: { height: ROW + 'px' }, title: `#${r.index} ${r.env.name}: ${r.env.points.length} keys, loops every ${(duration(r.env) / 1000).toFixed(2)} s` },
      h('b', {}, r.what), ` #${r.index} ${r.env.name || ''}`)));
  const canvas = h('canvas', { class: 'tl-canvas' });
  const wrap = h('div', { class: 'tl-wrap' }, canvas);
  const inspector = h('div', { class: 'tl-insp' });
  const body = h('div', { class: 'tl-body' }, labels, wrap);
  const empty = !rows.length ? h('div', { class: 'tl-empty' }, 'No animation here yet. Select quads, put the playhead where the animation starts and press K. Then move the playhead, move or turn the quads (R) in the map and press K again.') : null;
  root.append(h('div', { class: 'tl' }, bar, empty || body, inspector));

  const tToX = (t) => PAD + (t - V.t0) / V.msPerPx;
  const xToT = (x) => (x - PAD) * V.msPerPx + V.t0;
  function fit() {
    const w = canvas.clientWidth || 600;
    const end = Math.max(1000, maxLen);
    V.msPerPx = (end * 1.1) / Math.max(100, w - 2 * PAD);
    V.t0 = -end * 0.03;
  }
  if (!A.fitted && maxLen) { A.fitted = true; requestAnimationFrame(() => { fit(); draw(); }); }

  // ---------------- drawing
  function draw() {
    timeLabel.textContent = `${(shownTime() / 1000).toFixed(2)} s`;
    if (!canvas.isConnected) return;
    const dpr = window.devicePixelRatio || 1;
    const W = canvas.clientWidth, H = RULER + rows.length * ROW + 4;
    canvas.style.height = H + 'px';
    if (canvas.width !== Math.round(W * dpr) || canvas.height !== Math.round(H * dpr)) { canvas.width = Math.round(W * dpr); canvas.height = Math.round(H * dpr); }
    const c = canvas.getContext('2d');
    c.setTransform(dpr, 0, 0, dpr, 0, 0);
    c.clearRect(0, 0, W, H);
    const css = getComputedStyle(document.documentElement);
    const col = (n) => css.getPropertyValue(n).trim();
    // ruler: a tick step that keeps labels about 70 px apart
    const steps = [10, 20, 50, 100, 200, 250, 500, 1000, 2000, 5000, 10000, 30000, 60000];
    const step = steps.find((s) => s / V.msPerPx >= 70) || 60000;
    c.fillStyle = col('--panel2'); c.fillRect(0, 0, W, RULER);
    c.font = '11px Helvetica, Arial, sans-serif'; c.textBaseline = 'middle';
    for (let t = Math.floor(V.t0 / step) * step; tToX(t) < W; t += step) {
      const x = Math.round(tToX(t)) + 0.5;
      if (x < 0) continue;
      c.strokeStyle = col('--line2'); c.beginPath(); c.moveTo(x, RULER - 7); c.lineTo(x, H); c.stroke();
      c.fillStyle = col('--faint'); c.fillText(t >= 1000 || step >= 1000 ? `${(t / 1000).toFixed(step < 1000 ? 2 : 0)}s` : `${t}ms`, x + 3, RULER / 2);
    }
    rows.forEach((r, i) => {
      const y = RULER + i * ROW, mid = y + ROW / 2, e = r.env, end = duration(e);
      c.fillStyle = i % 2 ? 'rgba(255,255,255,0.02)' : 'rgba(0,0,0,0.06)'; c.fillRect(0, y, W, ROW);
      if (e.points.length > 1) {
        // the part that repeats: DDNet loops every envelope over its last key
        c.fillStyle = 'rgba(88,101,242,0.10)';
        c.fillRect(tToX(0), y + 6, tToX(end) - tToX(0), ROW - 12);
        c.fillStyle = 'rgba(255,255,255,0.03)';
        c.fillRect(tToX(end), y + 6, W, ROW - 12);
      }
      e.points.forEach((p) => {
        const x = tToX(p.time), sel = A.keySel.has(p), s = 6;
        c.fillStyle = sel ? col('--accent2') : '#dbdee1';
        c.strokeStyle = '#111'; c.lineWidth = 1;
        c.beginPath();
        if (p.curve === 0) c.rect(x - s + 1, mid - s + 1, 2 * s - 2, 2 * s - 2); // step: square
        else { c.moveTo(x, mid - s); c.lineTo(x + s, mid); c.lineTo(x, mid + s); c.lineTo(x - s, mid); c.closePath(); }
        c.fill(); c.stroke();
      });
    });
    // playhead
    const px = Math.round(tToX(shownTime())) + 0.5;
    c.strokeStyle = col('--danger'); c.lineWidth = 1.5;
    c.beginPath(); c.moveTo(px, 0); c.lineTo(px, H); c.stroke();
    c.fillStyle = col('--danger'); c.beginPath(); c.moveTo(px - 5, 0); c.lineTo(px + 5, 0); c.lineTo(px, 7); c.closePath(); c.fill();
    if (box) {
      c.strokeStyle = col('--accent'); c.fillStyle = 'rgba(88,101,242,0.15)';
      const x = Math.min(box.x0, box.x1), yy = Math.min(box.y0, box.y1);
      c.fillRect(x, yy, Math.abs(box.x1 - box.x0), Math.abs(box.y1 - box.y0));
      c.strokeRect(x + 0.5, yy + 0.5, Math.abs(box.x1 - box.x0), Math.abs(box.y1 - box.y0));
    }
  }

  // ---------------- inspector: values of one selected key
  function inspect() {
    inspector.innerHTML = '';
    const sel = selected();
    if (sel.length !== 1) {
      inspector.append(h('span', { class: 'tl-hint' }, sel.length ? `${sel.length} keys selected: drag to move them in time, Delete removes them.` : 'Click a key to edit it. Drag keys to move them in time, Shift+click or drag a box to pick several, double click a row to add a key, right click for its curve. Wheel: zoom, Shift+wheel or middle drag: scroll.'));
      return;
    }
    const [r, p] = sel[0];
    const names = CH[r.env.channels] || ['V'];
    const colour = r.env.channels === 4;
    const set = (label, fn) => editEnv(label, () => { fn(); r.env.points.sort((a, b) => a.time - b.time); });
    inspector.append(h('span', { class: 'tl-hint' }, `${r.what} #${r.index}`),
      h('label', {}, 'Time ms ', num(p.time, (v) => set('Key time', () => (p.time = Math.max(0, Math.round(v)))), { min: 0, step: 10, width: 80 })),
      ...names.map((n, k) => h('label', {}, n + ' ', num(+(p.values[k] / 1024).toFixed(colour ? 3 : 2), (v) => set('Key value', () => (p.values[k] = Math.round(v * 1024))), { step: colour ? 0.05 : 1, width: 72, ...(colour ? { min: 0, max: 1 } : {}) }))));
  }

  // ---------------- mouse
  let drag = null, box = null;
  const hit = (x, y) => {
    const i = Math.floor((y - RULER) / ROW);
    const r = rows[i];
    if (!r || y < RULER) return null;
    let best = null, bd = 8;
    for (const p of r.env.points) { const d = Math.abs(tToX(p.time) - x); if (d <= bd) { bd = d; best = p; } }
    return best ? [r, best] : null;
  };
  const pos = (e) => { const b = canvas.getBoundingClientRect(); return [e.clientX - b.left, e.clientY - b.top]; };
  const scrubTo = (x) => { ed.opts.play = false; playBtn.classList.remove('on'); ed.opts.time = Math.max(0, Math.round(xToT(x) / 10) * 10); ed.emit('toggles'); ed.redraw(); draw(); };

  canvas.addEventListener('pointerdown', (e) => {
    A.focus = true;
    const [x, y] = pos(e);
    canvas.setPointerCapture(e.pointerId);
    if (e.button === 1) { drag = { type: 'pan', x, t0: V.t0 }; return; }
    const k = e.button === 0 || e.button === 2 ? hit(x, y) : null;
    if (e.button === 2) {
      if (!k) return;
      if (!A.keySel.has(k[1])) { A.keySel.clear(); A.keySel.add(k[1]); inspect(); draw(); }
      return;
    }
    if (e.button !== 0) return;
    if (k) {
      const [, p] = k;
      if (e.shiftKey) { if (A.keySel.has(p)) A.keySel.delete(p); else A.keySel.add(p); }
      else if (!A.keySel.has(p)) { A.keySel.clear(); A.keySel.add(p); }
      const sel = selected();
      ed.history.begin(ed.map, 'anim', 'Move keys', null);
      drag = { type: 'keys', x, moved: false, orig: sel.map(([r, q]) => [r, q, q.time]) };
      inspect(); draw();
      return;
    }
    if (y < RULER) { drag = { type: 'scrub' }; scrubTo(x); return; }
    if (!e.shiftKey) A.keySel.clear();
    drag = { type: 'box', x, y };
    box = null;
    scrubTo(x);
    inspect();
  });
  canvas.addEventListener('pointermove', (e) => {
    if (!drag) return;
    const [x, y] = pos(e);
    if (drag.type === 'pan') { V.t0 = drag.t0 - (x - drag.x) * V.msPerPx; draw(); return; }
    if (drag.type === 'scrub') { scrubTo(x); return; }
    if (drag.type === 'box') {
      if (Math.abs(x - drag.x) > 4 || Math.abs(y - drag.y) > 4) box = { x0: drag.x, y0: drag.y, x1: x, y1: y };
      if (box) {
        const t0 = xToT(Math.min(box.x0, box.x1)), t1 = xToT(Math.max(box.x0, box.x1));
        const r0 = Math.floor((Math.min(box.y0, box.y1) - RULER) / ROW), r1 = Math.floor((Math.max(box.y0, box.y1) - RULER) / ROW);
        if (!e.shiftKey) A.keySel.clear();
        rows.forEach((r, i) => { if (i >= r0 && i <= r1) for (const p of r.env.points) if (p.time >= t0 && p.time <= t1) A.keySel.add(p); });
        draw();
      } else scrubTo(x);
      return;
    }
    if (drag.type === 'keys') {
      // snap to 10 ms; Ctrl: to the ruler step's tenth (100 ms at the usual zoom); Alt: 1 ms
      let dt = (x - drag.x) * V.msPerPx;
      const grid = e.altKey ? 1 : e.ctrlKey || e.metaKey ? 100 : 10;
      dt = Math.round(dt / grid) * grid;
      if (!drag.moved && Math.abs(x - drag.x) < 3) return;
      drag.moved = true;
      const lo = Math.min(...drag.orig.map((o) => o[2]));
      dt = Math.max(-lo, dt);
      for (const [, p, t] of drag.orig) p.time = Math.round(t + dt);
      for (const r of new Set(drag.orig.map((o) => o[0]))) r.env.points.sort((a, b) => a.time - b.time);
      ed.redraw(); draw();
    }
  });
  const up = () => {
    if (!drag) return;
    if (drag.type === 'keys') {
      if (drag.moved) {
        // two keys of one envelope on the same time: the moved one wins
        for (const r of new Set(drag.orig.map((o) => o[0]))) {
          const pts = r.env.points;
          for (let i = pts.length - 1; i > 0; i--) if (pts[i].time === pts[i - 1].time) pts.splice(A.keySel.has(pts[i]) ? i - 1 : i, 1);
        }
        ed.history.commit(); ed.emit('envelopes');
      } else ed.history.cancel();
    }
    if (drag.type === 'box') { box = null; inspect(); draw(); }
    drag = null;
  };
  canvas.addEventListener('pointerup', up);
  canvas.addEventListener('pointercancel', up);
  canvas.addEventListener('dblclick', (e) => {
    const [x, y] = pos(e);
    const r = rows[Math.floor((y - RULER) / ROW)];
    if (!r || y < RULER || hit(x, y)) return;
    // a key in place: the value the envelope has there now
    const t = Math.max(0, Math.round(xToT(x) / 10) * 10);
    const v = r.env.points.length ? evalEnvelope(r.env, t) : r.env.channels === 4 ? [1, 1, 1, 1] : [0, 0, 0, 0];
    let added = null;
    editEnv('Add key', () => {
      added = { time: t, curve: A.curve, values: [0, 1, 2, 3].map((c) => Math.round((v[c] ?? 0) * 1024)) };
      r.env.points.push(added);
      r.env.points.sort((a, b) => a.time - b.time);
    });
    A.keySel.clear(); if (added) A.keySel.add(added);
  });
  canvas.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    const [x, y] = pos(e);
    const k = hit(x, y);
    if (!k) return;
    const sel = selected();
    popup(e.clientX, e.clientY, (el) => {
      el.append(...CURVES.map((ci) => item(CURVE_NAMES[ci], () => setCurve(ci), { on: sel.every(([, p]) => p.curve === ci) })),
        h('hr'), item(sel.length > 1 ? `Delete ${sel.length} keys` : 'Delete key', deleteKeys, { danger: true }));
    }, { title: sel.length > 1 ? `${sel.length} keys` : `Key at ${(k[1].time / 1000).toFixed(2)} s` });
  });
  canvas.addEventListener('wheel', (e) => {
    e.preventDefault();
    const [x] = pos(e);
    if (e.shiftKey || Math.abs(e.deltaX) > Math.abs(e.deltaY)) { V.t0 += (e.shiftKey ? e.deltaY : e.deltaX) * V.msPerPx; draw(); return; }
    const t = xToT(x);
    V.msPerPx = Math.max(0.2, Math.min(200, V.msPerPx * Math.exp(e.deltaY * 0.0015)));
    V.t0 = t - (x - PAD) * V.msPerPx;
    draw();
  }, { passive: false });

  inspect();
  draw();
  // redraw while the animation plays or the size changes
  let lastT = null, lastW = 0;
  const loop = () => {
    if (!canvas.isConnected) return;
    if (ed.opts.time !== lastT || canvas.clientWidth !== lastW) { lastT = ed.opts.time; lastW = canvas.clientWidth; draw(); }
    requestAnimationFrame(loop);
  };
  requestAnimationFrame(loop);
}
