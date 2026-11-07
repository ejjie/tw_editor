// Module "palette". Colour palette, pinned at the top of the right panel, kept in the browser (not in the map), at most two rows.
// A swatch is one colour or a gradient: the four corner colours of a quad (TL, TR, BL, BR), so a quad's
// gradient can be copied and put on other quads. A fresh palette holds five standard colours.
//   any copied colour is added on its own: the pipette (Ctrl+Shift+C), Shift+right click on a colour
//               field, Ctrl+C of a hex code in a text field
//   +           saves the colours of the selection: each selected quad (a gradient when its corners differ),
//               the selected corners, the tile layer colour, or the last pipette colour
//   click       puts it on the selected quads / corners, the tile layer, or into an open colour picker
//   drag        moves a swatch
//   right click menu: apply, copy as hex, remove, restore the standard colours
// Every change is one step in the editor's undo history (Ctrl+Z / Ctrl+Y); it never marks the map unsaved.
// New swatches go to the end; when the two rows are full the oldest added swatch makes room
// (the standard colours only go when removed by hand).
import { h, item, popup, hex8, activePicker, parseColor } from './ui.js';
import { iconEl } from './icons.js';

const KEY = 'twe-palette', SIZE = 24, GAP = 4;
const STANDARD = [[245, 233, 226, 255], [227, 181, 164, 255], [212, 77, 92, 255], [119, 51, 68, 255], [22, 0, 41, 255]];
const standard = () => STANDARD.map((c) => ({ c: [...c], std: true, t: 0 }));
const valid = (e) => e && (Array.isArray(e.c) || Array.isArray(e.g));

// stored as { v: 2, items: [...] } in display order; the first version was a plain array of saved swatches
function load() {
  let raw = null;
  try { raw = JSON.parse(localStorage.getItem(KEY) || 'null'); } catch { raw = null; }
  if (raw && raw.v === 2 && Array.isArray(raw.items)) return raw.items.filter(valid);
  const old = Array.isArray(raw) ? raw.filter(valid) : [];
  const keys = new Set(STANDARD.map((c) => JSON.stringify(c)));
  // the old list was newest first: keep that age order
  return [...standard(), ...old.filter((e) => !keys.has(JSON.stringify(e.c || e.g))).map((e, i) => ({ ...e, t: old.length - i }))];
}
let list = load();
const store = () => { try { localStorage.setItem(KEY, JSON.stringify({ v: 2, items: list })); } catch { /* storage blocked */ } };

const same = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);
const key = (e) => JSON.stringify(e.c || e.g);
const css = (c) => `rgba(${c[0]},${c[1]},${c[2]},${c[3] / 255})`;
const entryOf = (colors) => (colors.every((c) => same(c, colors[0])) ? { c: [...colors[0]] } : { g: colors.map((c) => [...c]) });
let clock = Date.now();
const now = () => (clock = Math.max(clock + 1, Date.now()));

// four corners blended across the swatch (DDNet blends per triangle; this is close enough for a preview)
function gradientCanvas(g) {
  const cv = h('canvas', { width: SIZE, height: SIZE });
  const x = cv.getContext('2d'), img = x.createImageData(SIZE, SIZE);
  for (let j = 0; j < SIZE; j++) for (let i = 0; i < SIZE; i++) {
    const u = i / (SIZE - 1), v = j / (SIZE - 1), o = (j * SIZE + i) * 4;
    for (let k = 0; k < 4; k++) img.data[o + k] = g[0][k] * (1 - u) * (1 - v) + g[1][k] * u * (1 - v) + g[2][k] * (1 - u) * v + g[3][k] * u * v;
  }
  x.putImageData(img, 0, 0);
  return cv;
}

// a hex code in copied text: #RGB, #RRGGBB, #RRGGBBAA, or 6 / 8 hex digits without #
const HEX = /^\s*(#[0-9a-f]{3}|#?[0-9a-f]{6}|#?[0-9a-f]{8})\s*$/i;

export function setupPalette(ed) {
  const root = document.getElementById('palette');
  const cols = () => Math.max(4, Math.floor((root.clientWidth - 16 + GAP) / (SIZE + GAP)));
  const max = () => cols() * 2;
  let flash = null; // the swatch to highlight on the next render
  const clone = (l) => JSON.parse(JSON.stringify(l));
  const target = { snap: () => clone(list), restore: (st) => { list = clone(st); store(); render(); } };
  // runs fn as one undo step; fn changes list
  const change = (label, fn) => { ed.history.edit(ed.map, 'custom', label, target, fn); store(); render(); };

  // adds swatches at the end; a colour already in the palette is not added twice (it only counts as new again,
  // which is not an undo step)
  function add(entries, { quiet = false } = {}) {
    const fresh = [];
    for (const e of entries) {
      const k = key(e);
      const had = list.find((x) => key(x) === k) || fresh.find((x) => key(x) === k);
      if (had) { if (!had.std) had.t = now(); flash = had; continue; }
      const n = { ...(e.c ? { c: [...e.c] } : { g: e.g.map((c) => [...c]) }), t: now() };
      fresh.push(n); flash = n;
    }
    if (!fresh.length) { store(); render(); return; }
    change(fresh.length === 1 ? 'Add colour to palette' : 'Add colours to palette', () => {
      list.push(...fresh);
      // full: the oldest added swatch makes room, the standard colours stay
      while (list.length > max()) {
        let old = -1;
        list.forEach((x, i) => { if (!x.std && (old < 0 || x.t < list[old].t)) old = i; });
        if (old < 0) break;
        list.splice(old, 1);
      }
    });
    if (!quiet) ed.status(fresh.length === 1 ? 'Colour added to the palette' : `${fresh.length} colours added to the palette`);
  }

  // what + saves from the current selection
  function fromSelection() {
    const L = ed.layer;
    if (L && L.type === 'quads' && ed.quadSel.size) {
      if (ed.pointSel.size) return [...ed.pointSel].map((k) => { const [i, c] = k.split(':').map(Number); return { c: [...L.quads[i].colors[c]] }; });
      return [...ed.quadSel].map((i) => L.quads[i]).filter(Boolean).map((q) => entryOf(q.colors));
    }
    if (L && L.type === 'tiles' && L.kind === 'tiles') return [{ c: [...L.color] }];
    if (ed.pickedColor) return [{ c: [...ed.pickedColor] }];
    return [];
  }

  function apply(e) {
    const picker = activePicker();
    if (picker && picker.set) { picker.set(e.c || e.g[0]); return; }
    const L = ed.layer;
    if (L && L.type === 'quads' && ed.quadSel.size) {
      const pts = [...ed.pointSel].map((k) => k.split(':').map(Number));
      ed.editQuads(e.g ? 'Palette gradient' : 'Palette colour', () => {
        if (pts.length) for (const [i, c] of pts) L.quads[i].colors[c] = [...(e.c || e.g[c])];
        else for (const i of ed.quadSel) { const q = L.quads[i]; if (q) q.colors = [0, 1, 2, 3].map((k) => [...(e.c || e.g[k])]); }
      });
      ed.status(e.g ? 'Gradient put on the selection' : `Colour ${hex8(e.c)} put on the selection`);
      return;
    }
    if (L && L.type === 'tiles' && L.kind === 'tiles') {
      ed.history.edit(ed.map, 'layer', 'Layer colour', L, () => { L.color = [...(e.c || e.g[0])]; });
      ed.touch(L); ed.emit('layerprops');
      ed.status('Layer colour set from the palette');
      return;
    }
    ed.pickedColor = [...(e.c || e.g[0])];
    ed.status('Select quads, corners or a tile layer to put the colour on');
  }

  function remove(e) { change('Remove from palette', () => { list = list.filter((x) => x !== e); }); ed.status('Colour removed from the palette'); }

  const missingStandard = () => STANDARD.filter((c) => !list.some((x) => x.c && same(x.c, c)));
  function restoreStandard() {
    const miss = missingStandard();
    change('Restore standard colours', () => {
      // the standard colours go back to the front, ahead of the saved ones
      list = [...miss.map((c) => ({ c: [...c], std: true, t: 0 })), ...list];
      while (list.length > max()) {
        let old = -1;
        list.forEach((x, i) => { if (!x.std && (old < 0 || x.t < list[old].t)) old = i; });
        if (old < 0) break;
        list.splice(old, 1);
      }
    });
  }
  const restoreItem = () => (missingStandard().length ? item('Restore standard colours', restoreStandard) : null);

  // ---- drag to move ----
  let drag = null;
  const swOf = new Map(); // entry -> its swatch element
  function startDrag(ev, e, sw) {
    const r = sw.getBoundingClientRect();
    drag = { e, sw, x0: ev.clientX, y0: ev.clientY, dx: ev.clientX - r.left, dy: ev.clientY - r.top, on: false, ghost: null, moved: false, before: clone(list), orig: [...list] };
  }
  function slotAt(x, y) {
    const grid = root.querySelector('.pal-grid'), r = grid.getBoundingClientRect(), n = cols();
    const col = Math.max(0, Math.min(n - 1, Math.round((x - r.left - SIZE / 2) / (SIZE + GAP))));
    const row = Math.max(0, Math.floor((y - r.top + GAP / 2) / (SIZE + GAP)));
    return Math.min(list.length - 1, row * n + col);
  }
  window.addEventListener('pointermove', (ev) => {
    if (!drag) return;
    if (!drag.on) {
      if (Math.hypot(ev.clientX - drag.x0, ev.clientY - drag.y0) < 4) return;
      drag.on = true;
      drag.ghost = drag.sw.cloneNode(true);
      drag.ghost.classList.add('pal-ghost');
      document.body.append(drag.ghost);
      drag.sw.classList.add('pal-dragging');
      root.classList.add('pal-dnd');
    }
    drag.ghost.style.left = ev.clientX - drag.dx + 'px';
    drag.ghost.style.top = ev.clientY - drag.dy + 'px';
    // live preview: move the swatch to the slot under the pointer
    // away from the palette the swatch goes back to its place; dropping it there changes nothing
    const r = root.getBoundingClientRect(), pad = 16;
    const out = ev.clientX < r.left - pad || ev.clientX > r.right + pad || ev.clientY < r.top - pad || ev.clientY > r.bottom + pad;
    if (out) {
      if (drag.moved) { list = [...drag.orig]; drag.moved = false; root.querySelector('.pal-grid').append(...list.map((x) => swOf.get(x)).filter(Boolean)); }
      return;
    }
    const to = slotAt(ev.clientX, ev.clientY), from = list.indexOf(drag.e);
    if (to !== from && to >= 0) {
      list.splice(from, 1); list.splice(to, 0, drag.e); drag.moved = true;
      const grid = root.querySelector('.pal-grid'), kids = [...grid.children].filter((k) => k !== drag.sw);
      grid.insertBefore(drag.sw, kids[to] || null);
    }
  });
  const endDrag = (cancel) => {
    if (!drag) return;
    const d = drag; drag = null;
    if (!d.on) return;
    d.ghost.remove(); root.classList.remove('pal-dnd');
    suppressClick = true; setTimeout(() => (suppressClick = false), 0);
    if (cancel || !d.moved) { list = d.before; render(); return; }
    const after = list;
    list = d.before;
    change('Move palette colour', () => { list = after; });
    ed.status('Palette order changed');
  };
  let suppressClick = false;
  window.addEventListener('pointerup', () => endDrag(false));
  window.addEventListener('keydown', (ev) => { if (drag && drag.on && ev.key === 'Escape') { ev.stopPropagation(); endDrag(true); } }, true);

  function render() {
    root.innerHTML = '';
    swOf.clear();
    const sel = fromSelection();
    const plus = h('button', { class: 'ib', title: sel.length ? 'Save the colours of the selection (a quad with different corner colours is saved as a gradient)' : 'Select quads, corners or a tile layer (or pick a colour with Ctrl+Shift+C) to save its colours', onclick: () => { const s = fromSelection(); if (s.length) add(s); else ed.status('Nothing to save: select quads, corners or a tile layer'); } }, iconEl('plus', 16));
    plus.disabled = !sel.length;
    const head = h('div', { class: 'pal-head', title: 'Copied colours are added here. Drag a swatch to move it, right click it to remove it.' }, h('span', {}, 'Palette'), plus);
    head.addEventListener('contextmenu', (ev) => {
      const r = restoreItem();
      if (!r) return;
      ev.preventDefault();
      popup(ev.clientX, ev.clientY, (el) => el.append(r), { title: 'Palette' });
    });
    const grid = h('div', { class: 'pal-grid', style: { gridTemplateColumns: `repeat(${cols()}, ${SIZE}px)` } });
    for (const e of list.slice(0, max())) {
      const sw = h('button', { class: 'pal-sw' + (e.g ? ' grad' : ''), title: (e.c ? hex8(e.c) : `Gradient ${e.g.map(hex8).join(' ')}`) + ': click to put it on the selection, drag to move, right click for more' });
      if (e.c) sw.style.setProperty('--c', css(e.c)); else sw.append(gradientCanvas(e.g));
      if (e === flash) { sw.classList.add('pal-new'); flash = null; }
      sw.addEventListener('pointerdown', (ev) => { if (ev.button === 0) startDrag(ev, e, sw); });
      sw.addEventListener('click', () => { if (!suppressClick) apply(e); });
      sw.addEventListener('contextmenu', (ev) => {
        ev.preventDefault();
        popup(ev.clientX, ev.clientY, (el) => el.append(
          item('Apply', () => apply(e)),
          item('Copy as hex', () => navigator.clipboard?.writeText(e.c ? hex8(e.c) : e.g.map(hex8).join(' '))),
          h('hr'),
          item('Remove', () => remove(e), { danger: true }),
          restoreItem()), { title: e.c ? hex8(e.c) + (e.std ? ' (standard)' : '') : 'Gradient' });
      });
      grid.append(sw); swOf.set(e, sw);
    }
    if (!list.length) grid.append(h('div', { class: 'pal-empty' }, 'Empty. Copied colours land here; right click the title to bring back the standard colours.'));
    root.append(head, grid);
  }

  // every copied colour lands in the palette
  window.addEventListener('twe-color-copied', (ev) => { const c = ev.detail; if (Array.isArray(c) && c.length >= 3) add([{ c: [c[0], c[1], c[2], c[3] ?? 255] }]); });
  document.addEventListener('copy', () => {
    const a = document.activeElement;
    let text = '';
    if (a && (a.tagName === 'INPUT' || a.tagName === 'TEXTAREA') && typeof a.selectionStart === 'number') text = a.value.slice(a.selectionStart, a.selectionEnd);
    else text = String(window.getSelection() || '');
    if (!HEX.test(text)) return;
    const c = parseColor(text.trim().startsWith('#') ? text.trim() : '#' + text.trim(), 255);
    if (c) add([{ c }]);
  });

  for (const ev of ['selection', 'map', 'layerprops']) ed.on(ev, render);
  // a narrower panel shows fewer swatches; they are only dropped for good when a new one is added
  let lastCols = 0;
  new ResizeObserver(() => { if (cols() !== lastCols) { lastCols = cols(); render(); } }).observe(root);
  render();
  return { add, render };
}

export function setup(ed) {
  if (!document.getElementById('palette')) return;
  ed.palette = setupPalette(ed);
}
