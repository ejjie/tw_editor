// Side and bottom panels: layer tree, properties, images, envelopes, sounds, server settings, history.
import { h, prop, num, text, check, select, btn, rgba, modal, confirmBox, popup, item, info } from './ui.js';
import { KIND_NAME, TILE_BYTES } from './map.js';
import * as T from './tools.js';
import { evalEnvelope, CURVE_NAMES } from './envelope.js';
import { loadImage } from './render.js';
import { REFERENCE_NAMES } from './automapper.js';
import { iconEl } from './icons.js';
import { imagePreview, envPreview, curvePreview, shapePreview } from './previews.js';

const TILE = 32;

// ================================================================== layers tree

export function renderLayers(ed) {
  const root = document.getElementById('layers');
  const scroll = root.scrollTop;
  root.innerHTML = '';
  const map = ed.map;
  map.groups.forEach((g, gi) => {
    const isGame = g.layers.some((l) => l.kind === 'game');
    const gsel = ed.sel.g === gi && ed.sel.l < 0;
    const eye = h('span', {
      class: 'eye' + (g.visible ? '' : ' off'), title: 'Left click to toggle visibility. Shift+click to hide all other groups (again to bring them back). Right click to show this group only.',
      onclick: (e) => { e.stopPropagation(); if (e.shiftKey) soloAll(ed, g); else g.visible = !g.visible; ed.emit('map'); },
      oncontextmenu: (e) => { e.preventDefault(); e.stopPropagation(); if (e.shiftKey && ed.sel.g !== gi) ed.select(gi, -1); solo(map.groups, g); ed.emit('map'); },
    }, iconEl(g.visible ? 'eye' : 'eyeOff', 16));
    const collapse = h('span', { class: 'collapse' + (g._collapsed ? ' shut' : ''), onclick: (e) => { e.stopPropagation(); g._collapsed = !g._collapsed; renderLayers(ed); } }, iconEl('chevron', 16));
    const row = h('div', {
      class: 'grp-row' + (gsel ? ' sel' : ''), 'data-g': gi,
      title: 'Click to select, drag to reorder, right click for the group menu.',
      onclick: () => { if (!dragJustEnded()) ed.select(gi, -1); },
      oncontextmenu: (e) => { e.preventDefault(); ed.popups.group(e.clientX, e.clientY, gi); },
      onpointerdown: (e) => startDrag(e, ed, { g: gi }, row),
    }, collapse, eye, h('span', { class: 'lname' }, `#${gi} ${g.name || (isGame ? 'Game' : 'Group')}`), h('span', { class: 'lkind' }, g.parallaxX !== 100 || g.parallaxY !== 100 ? `${g.parallaxX}/${g.parallaxY}` : ''));
    const box = h('div', { class: 'grp' }, row);
    if (!g._collapsed) {
      g.layers.forEach((l, li) => {
        const sel = ed.sel.g === gi && ed.sel.l === li;
        const msel = !sel && ed.sel.g === gi && ed.multi.has(l);
        const leye = h('span', {
          class: 'eye' + (l.visible ? '' : ' off'), title: 'Left click to toggle visibility. Shift+click to hide all other layers of the map (again to bring them back). Right click to show only this layer within its group.',
          onclick: (e) => { e.stopPropagation(); if (e.shiftKey) soloAll(ed, l, g); else l.visible = !l.visible; ed.emit('map'); },
          oncontextmenu: (e) => { e.preventDefault(); e.stopPropagation(); if (e.shiftKey && !(ed.sel.g === gi && ed.sel.l === li)) ed.select(gi, li); solo(g.layers, l); ed.emit('map'); },
        }, iconEl(l.visible ? 'eye' : 'eyeOff', 16));
        const info = l.type === 'quads' ? `${l.quads.length} q` : l.type === 'tiles' ? `${l.width}×${l.height}` : l.type === 'sounds' ? `${l.sources.length} ♪` : '';
        const name = l.name || (l.type === 'tiles' && l.kind === 'tiles' ? 'Tiles' : KIND_NAME[l.kind] || l.kind);
        const lrow = h('div', {
          class: 'lay-row' + (sel ? ' sel' : '') + (msel ? ' msel' : '') + (l.kind !== 'tiles' && l.kind !== 'quads' ? ' game' : '') + (l.flags & 1 ? ' detail' : ''),
          'data-g': gi, 'data-l': li,
          title: `${KIND_NAME[l.kind] || l.kind}${l.flags & 1 ? ' (detail)' : ''}. Drag to reorder or move to another group.${l.type === 'tiles' ? ' Ctrl/Shift+click: edit together with the selected tile layer.' : ''}`,
          onclick: (e) => { if (dragJustEnded()) return; if (e.ctrlKey || e.metaKey || e.shiftKey) ed.toggleMulti(gi, li); else ed.select(gi, li); },
          oncontextmenu: (e) => { e.preventDefault(); ed.popups.layer(e.clientX, e.clientY, gi, li); },
          onpointerdown: (e) => startDrag(e, ed, { g: gi, l: li }, lrow),
        }, leye, kindIcon(l), h('span', { class: 'lname' }, name), h('span', { class: 'lkind' }, info));
        box.append(lrow);
      });
    }
    root.append(box);
  });
  root.scrollTop = scroll;
}

// ---- drag and drop in the layer tree (pointer based, so it works the same in every browser)
let dragEndedAt = 0;
const dragJustEnded = () => performance.now() - dragEndedAt < 50;

function startDrag(e, ed, src, rowEl) {
  if (e.button !== 0 || e.target.closest('.eye, .collapse')) return;
  const root = document.getElementById('layers');
  const sx = e.clientX, sy = e.clientY;
  let ghost = null, line = null, target = null;
  const isLayer = src.l !== undefined;
  const L = isLayer ? ed.map.groups[src.g].layers[src.l] : null;
  const physics = L && !['tiles', 'quads', 'sounds'].includes(L.kind);

  // where would a drop at clientY land: { g, l (insert index), y (line position) }
  const resolve = (x, y) => {
    const el = document.elementFromPoint(x, y)?.closest('.grp-row, .lay-row');
    if (!el || !root.contains(el)) return null;
    const r = el.getBoundingClientRect(), after = y > r.top + r.height / 2;
    const g = +el.dataset.g, l = el.dataset.l !== undefined ? +el.dataset.l : -1;
    if (isLayer) {
      if (l < 0) {
        // on a group header: top half = end of the group above, bottom half = top of this group
        if (!after && g > 0) { const pg = g - 1; return { g: pg, l: ed.map.groups[pg].layers.length, el, after: false }; }
        return { g, l: 0, el, after: true };
      }
      return { g, l: l + (after ? 1 : 0), el, after };
    }
    // groups: drop relative to the group the row belongs to
    const grpEl = root.querySelector(`.grp-row[data-g="${g}"]`).parentElement;
    const gr = grpEl.getBoundingClientRect();
    const gAfter = l >= 0 ? true : after;
    return { g: g + (gAfter ? 1 : 0), el: grpEl, after: gAfter, rect: gr };
  };

  const move = (ev) => {
    if (!ghost) {
      if (Math.hypot(ev.clientX - sx, ev.clientY - sy) < 5) return;
      ghost = h('div', { class: 'drag-ghost' }, rowEl.querySelector('.lname').textContent);
      line = h('div', { class: 'drop-line' });
      document.body.append(ghost, line);
      rowEl.classList.add('dragging');
      document.body.classList.add('tree-dragging');
    }
    ghost.style.left = ev.clientX + 12 + 'px';
    ghost.style.top = ev.clientY + 8 + 'px';
    target = resolve(ev.clientX, ev.clientY);
    const bad = !target || (physics && target.g !== src.g);
    line.style.display = target ? 'block' : 'none';
    line.classList.toggle('bad', !!bad);
    if (target) {
      const r = target.rect || target.el.getBoundingClientRect(), tr = root.getBoundingClientRect();
      line.style.left = r.left + (isLayer ? 14 : 0) + 'px';
      line.style.width = tr.right - r.left - (isLayer ? 22 : 8) + 'px';
      line.style.top = (target.after ? r.bottom : r.top) - 1 + 'px';
    }
  };
  const up = () => {
    window.removeEventListener('pointermove', move);
    window.removeEventListener('pointerup', up);
    if (!ghost) return;
    ghost.remove(); line.remove();
    rowEl.classList.remove('dragging');
    document.body.classList.remove('tree-dragging');
    dragEndedAt = performance.now();
    if (!target) return;
    if (isLayer) {
      if (physics && target.g !== src.g) { ed.status('Physics layers stay in the Game group'); return; }
      let at = target.l;
      if (target.g === src.g && at > src.l) at--;
      if (target.g === src.g && at === src.l) return;
      ed.editStructure('Move layer', () => {
        ed.map.groups[src.g].layers.splice(src.l, 1);
        ed.map.groups[target.g].layers.splice(at, 0, L);
        ed.sel = { g: target.g, l: at };
      });
    } else {
      let at = target.g;
      if (at > src.g) at--;
      if (at === src.g) return;
      ed.editStructure('Move group', () => {
        const [g] = ed.map.groups.splice(src.g, 1);
        ed.map.groups.splice(at, 0, g);
        ed.sel = { g: at, l: -1 };
      });
    }
  };
  window.addEventListener('pointermove', move);
  window.addEventListener('pointerup', up);
}

const PHYS_BADGE = { game: 'G', front: 'F', tele: 'TE', speedup: 'SP', switch: 'SW', tune: 'TU' };
function kindIcon(l) {
  if (PHYS_BADGE[l.kind]) return h('span', { class: 'kind-ic k-phys' }, PHYS_BADGE[l.kind]);
  return h('span', { class: 'kind-ic k-' + l.type }, iconEl(l.type === 'quads' ? 'quads' : l.type === 'sounds' ? 'sound' : 'tiles', 16));
}

// group the property list into collapsible cards: a card starts at every .sect header
export function cardify(root, firstTitle) {
  let shut = {};
  try { shut = JSON.parse(localStorage.getItem('twe-cards') || '{}'); } catch { /* storage blocked */ }
  const nodes = [...root.childNodes];
  root.innerHTML = '';
  let body = null;
  const start = (title, extra = []) => {
    const key = title.replace(/#\d+.*$/, '').replace(/\d+/g, '').trim() || title;
    const card = h('div', { class: 'card' + (shut[key] ? ' shut' : '') });
    const head = h('div', { class: 'card-head', onclick: () => {
      card.classList.toggle('shut');
      shut[key] = card.classList.contains('shut');
      try { localStorage.setItem('twe-cards', JSON.stringify(shut)); } catch { /* ignore */ }
    } }, iconEl('chevron', 16), h('span', { class: 'bt' }, title), ...extra);
    for (const x of extra) x.addEventListener?.('click', (e) => e.stopPropagation());
    body = h('div', { class: 'card-body' });
    card.append(head, body);
    root.append(card);
  };
  for (const n of nodes) {
    if (n.classList && n.classList.contains('sect')) {
      const extra = [...n.children]; // e.g. an "i" help mark
      for (const x of extra) x.remove();
      start(n.textContent.trim(), extra);
      continue;
    }
    if (!body && firstTitle === null) { root.append(n); continue; } // leading entries outside the cards
    if (!body) start(firstTitle);
    body.append(n);
  }
}

// DDNet eye right click: show only this one; if it already was the only visible one, show all again
function solo(list, keep) {
  let hidden = 0;
  for (const x of list) {
    if (x === keep) { x.visible = true; continue; }
    if (x.visible) { x.visible = false; hidden++; }
  }
  if (!hidden) for (const x of list) x.visible = true;
}

// Shift+click on an eye: hide every other group (for a group) or every other layer of the map (for a layer).
// Shift+click again on the same eye brings back what was visible before; if the visibility was changed by hand
// in between, everything is shown.
function soloAll(ed, target, group = null) {
  const map = ed.map;
  const all = [...map.groups, ...map.groups.flatMap((g) => g.layers)];
  const others = group ? map.groups.flatMap((g) => g.layers).filter((l) => l !== target) : map.groups.filter((g) => g !== target);
  const isSolo = target.visible && (!group || group.visible) && others.every((x) => !x.visible);
  const prev = ed._solo;
  if (isSolo) {
    const state = all.map((x) => x.visible);
    if (prev && prev.target === target && prev.items.length === all.length && prev.items.every((x, i) => x === all[i]) && prev.after.every((v, i) => v === state[i])) {
      all.forEach((x, i) => (x.visible = prev.before[i]));
    } else for (const x of all) x.visible = true;
    ed._solo = null;
    ed.status('All shown again');
    return;
  }
  const before = all.map((x) => x.visible);
  for (const x of others) x.visible = false;
  target.visible = true;
  if (group) group.visible = true;
  ed._solo = { target, items: all, before, after: all.map((x) => x.visible) };
  ed.status(group ? 'Only this layer is shown (Shift+click its eye again to bring the others back)' : 'Only this group is shown (Shift+click its eye again to bring the others back)');
}

// ================================================================== properties

function envOptions(ed, channels) {
  return [[-1, '— none —'], ...ed.map.envelopes.map((e, i) => [i, `#${i} ${e.name || ''}`]).filter(([i]) => ed.map.envelopes[i].channels === channels)];
}

function imageOptions(ed) {
  return [[-1, '— none —'], ...ed.map.images.map((im, i) => [i, `#${i} ${im.name}${im.external ? ' (ext.)' : ''}`])];
}

export function renderProps(ed) {
  const root = document.getElementById('props');
  const title = document.getElementById('props-title');
  root.innerHTML = '';
  const g = ed.group, L = ed.layer;
  if (!g) { title.textContent = 'Properties'; return; }
  const editLayer = (label, fn) => { ed.history.edit(ed.map, 'layer', label, L, fn); ed.touch(L); ed.emit('layerprops'); };

  // only the tools live here; layer and group settings are in their right-click menus in the layer list
  if (!L) {
    title.textContent = 'Group';
    root.append(h('div', { class: 'hint' }, 'Right-click the group in the layer list for its settings.'));
    return;
  }
  title.textContent = `Layer: ${KIND_NAME[L.kind] || L.kind}`;
  if (L.type === 'quads' && ed.pen && ed.pen.on) ed.pen.props(root, (t) => h('div', { class: 'sect' }, t));
  if (L.type === 'tiles') brushProps(ed, root, L);
  if (L.type === 'quads') {
    if (ed.pen && ed.pen.on) root.append(h('div', { class: 'sect' }, 'Quads'));
    quadLayerProps(ed, root, L, editLayer);
  }
  if (L.type === 'sounds') sourcesPanel(ed, root, L);
  cardify(root, L.type === 'quads' ? 'Quads' : L.type === 'sounds' ? 'Sources' : 'Brush');
}

// The layer panel (right click on a layer, docked next to the layer list). Grouped into cards from the general to
// the specific: actions, the layer itself, how it looks, the automapper, size, tools.
export function layerSheet(ed, root, L) {
  const editLayer = (label, fn) => { ed.history.edit(ed.map, 'layer', label, L, fn); ed.touch(L); ed.emit('layerprops'); };
  const plain = ['tiles', 'quads', 'sounds'].includes(L.kind);
  const sect = (t, ...extra) => root.append(h('div', { class: 'sect' }, t, ...extra));

  // actions: big buttons of modules first (Design it! on the Game layer), then the layer's own
  for (const make of ed.ext.layerActions) { const el = make(L); if (el) root.append(el); }
  const acts = [];
  if (plain) acts.push(btn('Duplicate', () => ed.duplicateLayer(), { title: 'Create an identical copy of the selected layer.' }));
  if (L.kind !== 'game') acts.push(btn('Delete', () => ed.deleteLayer(), { class: 'danger-soft', title: 'Delete the layer.' }));
  if (acts.length) {
    acts[0].prepend(iconEl(plain ? 'copy' : 'trash', 16));
    if (acts[1]) acts[1].prepend(iconEl('trash', 16));
    root.append(h('div', { class: 'btns sheet-acts' }, acts));
  }

  // the layer itself
  sect('Layer');
  root.append(prop('Name', text(L.name, (v) => editLayer('Layer name', () => (L.name = v.slice(0, 11))), { maxlength: 11, placeholder: KIND_NAME[L.kind] || '' })));
  const order = num(ed.sel.l, (v) => ed.moveLayerTo(ed.sel.g, Math.round(v)), { min: 0, max: ed.group.layers.length - 1 });
  order.title = 'Position in the group (0 = drawn first)';
  if (plain) {
    const grp = num(ed.sel.g, (v) => { const ng = Math.round(v); ed.moveLayerTo(ng, ng === ed.sel.g ? ed.sel.l : ed.map.groups[Math.max(0, Math.min(ed.map.groups.length - 1, ng))].layers.length); }, { min: 0, max: ed.map.groups.length - 1 });
    grp.title = 'Group number: move the layer to another group';
    root.append(prop('Group / order', grp, order));
    root.append(prop('Detail', check(!!(L.flags & 1), (v) => { ed.history.edit(ed.map, 'layer', 'Detail', L, () => (L.flags = v ? L.flags | 1 : L.flags & ~1)); ed.emit('layerprops'); }),
      info('High detail only: hidden when players turn off "High detail" in the client settings')));
  } else root.append(prop('Order', order));

  // how it looks
  if (L.kind === 'tiles' || L.kind === 'quads' || L.type === 'sounds') {
    sect(L.type === 'sounds' ? 'Sound' : 'Appearance');
    if (L.kind === 'tiles' || L.kind === 'quads') root.append(prop('Image', select(imageOptions(ed), L.image, (v) => editLayer('Layer image', () => (L.image = +v)), { preview: imagePreview(ed), grid: true })));
    if (L.kind === 'tiles') {
      root.append(prop('Colour', ...rgba(L.color, (c) => editLayer('Layer colour', () => (L.color = c)))));
      const off = num(L.colorEnvOffset, (v) => editLayer('Env offset', () => (L.colorEnvOffset = Math.round(v))), { width: 52 });
      off.title = 'Envelope time offset, ms';
      root.append(prop('Colour env', select(envOptions(ed, 4), L.colorEnv, (v) => editLayer('Color env', () => (L.colorEnv = +v)), { preview: envPreview(ed) }), off,
        info('Animates the layer colour with a colour envelope. The number is the time offset in ms.')));
    }
    if (L.type === 'sounds') soundLayerProps(ed, root, L, editLayer);
  }

  if (L.type !== 'tiles') return;
  if (L.kind === 'tiles' && L.image >= 0) automapperProps(ed, root, L, editLayer);
  sect('Size');
  sizeProps(ed, root, L);

  const tools = [];
  if (L.kind === 'tiles' || L.kind === 'game') tools.push(btn('Border (2 tiles)', () => ed.placeBorder(), { title: 'Place border: tile 1 along the layer edges' }));
  if (L.kind === 'game') tools.push(btn('Clean up game tiles', () => ed.cleanUpGameTiles(), { title: 'Remove solid/death/nohook tiles that have no tiles under them in the Game group' }));
  const construct = ed.canConstructGameTiles(ed.group, L);
  if (tools.length || construct) sect('Tools');
  if (tools.length) root.append(h('div', { class: 'btns' }, tools));
  if (construct) {
    const ops = [[1, 'Hookable'], [2, 'Death'], [3, 'Unhookable'], [5, 'Hookthrough'], [9, 'Freeze'], [11, 'Unfreeze'], [12, 'Deep Freeze'], [13, 'Deep Unfreeze'], [144, 'Live Freeze'], [145, 'Live Unfreeze'], [31, 'Blue Check Tele'], [63, 'Red Check Tele'], [0, 'Air']];
    let op = 1;
    root.append(prop('Game tiles', select(ops, op, (v) => (op = +v)), info('Every tile of this layer places the chosen tile in the Game layer')));
    root.append(h('div', { class: 'btns' }, btn('Construct game tiles', () => ed.constructGameTiles(op), { title: 'Construct game tiles: every tile of this layer places the chosen tile in Game' })));
  }
}

// group settings (group popup)
export function groupProps(ed, root, g) {
  const isGame = g.layers.some((l) => l.kind === 'game');
  const edit = (label, fn) => { ed.history.edit(ed.map, 'structure', label, null, fn); ed.emit('groupprops'); };
  root.append(prop('Name', text(g.name, (v) => edit('Group name', () => (g.name = v.slice(0, 11))), { maxlength: 11 })));
  if (!isGame) {
    root.append(prop('Position X/Y', num(g.offsetX, (v) => edit('Group position', () => (g.offsetX = Math.round(v)))), num(g.offsetY, (v) => edit('Group position', () => (g.offsetY = Math.round(v))))));
    root.append(prop('Parallax X/Y', num(g.parallaxX, (v) => edit('Parallax', () => (g.parallaxX = Math.round(v)))), num(g.parallaxY, (v) => edit('Parallax', () => (g.parallaxY = Math.round(v))))));
  }
  root.append(prop('Clipping', check(g.clipping, (v) => edit('Clipping', () => (g.clipping = v)))));
  if (g.clipping) {
    root.append(prop('Clip X/Y', num(g.clipX, (v) => edit('Clipping', () => (g.clipX = Math.round(v)))), num(g.clipY, (v) => edit('Clipping', () => (g.clipY = Math.round(v))))));
    root.append(prop('Clip W/H', num(g.clipW, (v) => edit('Clipping', () => (g.clipW = Math.round(v)))), num(g.clipH, (v) => edit('Clipping', () => (g.clipH = Math.round(v))))));
  }
}

// Size: width x height, the side(s) to grow on (3x3 anchor, the middle grows on all sides so what is built stays in
// place), and "linked": the other tile layers of the same size lined up with this one change with it.
// While the numbers are typed the new frame is drawn on the map (white dashed).
function sizeProps(ed, root, L) {
  let nw = L.width, nh = L.height;
  if (!ed.sizeAnchor) ed.sizeAnchor = [1, 1];
  if (ed.sizeLinked === undefined) ed.sizeLinked = true;
  const physics = L.kind !== 'tiles';
  const update = () => {
    const [ox, oy] = T.sizeOffset(L.width, L.height, nw, nh, ed.sizeAnchor[0], ed.sizeAnchor[1]);
    ed.sizePreview = nw !== L.width || nh !== L.height ? { layer: L, w: nw, h: nh, ox, oy } : null;
    ok.disabled = !ed.sizePreview;
    ed.redraw();
  };
  const field = (v, set) => {
    const el = num(v, (x) => { set(Math.max(1, Math.round(x))); update(); }, { min: 1 });
    el.addEventListener('input', () => { const x = parseFloat(el.value); if (Number.isFinite(x) && x >= 1) { set(Math.round(x)); update(); } });
    el.addEventListener('keydown', (e) => { if (e.key === 'Enter') { el.blur(); apply(); } if (e.key === 'Escape') { nw = L.width; nh = L.height; wf.value = nw; hf.value = nh; update(); el.blur(); } });
    return el;
  };
  const wf = field(L.width, (v) => (nw = v)), hf = field(L.height, (v) => (nh = v));
  const apply = () => {
    if (nw === L.width && nh === L.height) return;
    ed.resizeTileLayer(L, nw, nh, ed.sizeAnchor, ed.sizeLinked);
  };
  const ok = btn('OK', apply, { title: 'Apply the new size (Enter in a field does the same, Esc resets it)' });
  const names = ['top left', 'top', 'top right', 'left', 'centre: grow on all sides', 'right', 'bottom left', 'bottom', 'bottom right'];
  const grid = h('div', { class: 'anchor' });
  const paintGrid = () => {
    grid.innerHTML = '';
    for (let y = 0; y < 3; y++) for (let x = 0; x < 3; x++) {
      const on = ed.sizeAnchor[0] === x && ed.sizeAnchor[1] === y;
      grid.append(h('button', { type: 'button', class: on ? 'on' : '', title: 'Keep the tiles at the ' + names[y * 3 + x], onclick: () => { ed.sizeAnchor = [x, y]; paintGrid(); update(); } }));
    }
  };
  paintGrid();
  const linkedCount = () => T.sizeLinked(ed.map, L, true).layers.length - T.sizeLinked(ed.map, L, false).layers.length;
  const n = linkedCount();
  root.append(prop('Size', wf, h('span', { class: 'times' }, '×'), hf, ok));
  const anchorRow = prop('Anchor', grid,
    info('Where the existing tiles stay when the size changes. The middle grows the layer on all sides.' + (physics ? ' All game layers (Game, Front, Tele, Speedup, Switch, Tune) always keep the same size.' : '')));
  root.append(anchorRow);
  if (n > 0) {
    const linkedRow = prop('Linked', check(ed.sizeLinked, (v) => { ed.sizeLinked = v; }),
      info(`Also resize ${n} other tile layer${n === 1 ? '' : 's'} of the same size lined up with this one`));
    root.append(linkedRow);
  }
  update();
}

// brush and tile numbers of a tile layer (side panel)
function brushProps(ed, root, L) {
  root.append(h('div', { class: 'sect' }, 'Brush', info('Drag with LMB to copy an area into the brush, or pick tiles with Space. LMB paints, Shift+LMB fills a rectangle, Ctrl+Shift+LMB flood fills. RMB clears the brush, RMB drag without a brush erases.')));
  const b = ed.brush;
  root.append(h('div', { class: 'hint' }, b ? `Brush ${b.w}×${b.h}${b.fromPicker ? ' (from picker)' : ' (copy)'}` : 'No brush'));
  root.append(h('div', { class: 'btns' },
    btn('Tile picker (Space)', () => ed.openPicker(true)),
    b ? btn('Clear (RMB)', () => { ed.brush = null; ed.emit('brush'); }) : null,
    b ? btn('⇋', () => ed.flipBrush(true), { title: 'N' }) : null,
    b ? btn('⇵', () => ed.flipBrush(false), { title: 'M' }) : null,
    b ? btn('⟲', () => ed.rotateBrush(false), { title: 'R' }) : null,
    b ? btn('⟳', () => ed.rotateBrush(true), { title: 'T' }) : null));
  root.append(prop('Destructive', h('div', { class: 'row' }, check(ed.nums.destructive, (v) => { ed.nums.destructive = v; }), info('Empty cells of the brush erase the tiles under them'))));

  const n = ed.nums;
  const setNum = (k) => (v) => { n[k] = Math.round(v); };
  if (L.kind === 'tele') {
    root.append(prop('Tele number', num(n.tele, setNum('tele'), { min: 0, max: 255 })));
    root.append(prop('Checkpoint number', num(n.teleCheckpoint, setNum('teleCheckpoint'), { min: 0, max: 255 })));
  }
  if (L.kind === 'switch') {
    root.append(prop('Switch number', num(n.switch, setNum('switch'), { min: 0, max: 255 })));
    root.append(prop('Delay', num(n.switchDelay, setNum('switchDelay'), { min: 0, max: 255 })));
  }
  if (L.kind === 'tune') root.append(prop('Tune zone', num(n.tune, setNum('tune'), { min: 0, max: 255 })));
  if (L.kind === 'speedup') {
    root.append(prop('Force', num(n.speedForce, (v) => ed.setSpeedNum('speedForce', v), { min: 0, max: 255 })));
    root.append(prop('Max speed', num(n.speedMax, (v) => ed.setSpeedNum('speedMax', v), { min: 0, max: 255 })));
    root.append(prop('Angle', num(n.speedAngle, (v) => ed.setSpeedNum('speedAngle', v), { min: 0, max: 359 })));
  }
  if (L.kind !== 'tiles') root.append(prop('Unused tiles', check(n.allowUnused, (v) => { n.allowUnused = v; ed.redraw(); })));
  if (L.kind !== 'tiles') {
    const counts = new Map();
    for (let i = 0; i < L.width * L.height; i++) {
      const v = L.tiles[i * TILE_BYTES[L.kind] + (L.kind === 'tiles' || L.kind === 'game' || L.kind === 'front' ? 0 : L.kind === 'speedup' ? 2 : 1)];
      if (v) counts.set(v, (counts.get(v) || 0) + 1);
    }
    root.append(h('div', { class: 'hint' }, `Non-empty tiles: ${[...counts.values()].reduce((a, b) => a + b, 0)}`));
  }
}

function soundLayerProps(ed, root, L, editLayer) {
  root.append(prop('Sound', select([[-1, '— none —'], ...ed.map.sounds.map((s, i) => [i, `#${i} ${s.name}`])], L.sound, (v) => editLayer('Layer sound', () => (L.sound = +v)))));
}

// sound sources of a sound layer (side panel)
function sourcesPanel(ed, root, L) {
  root.append(h('div', { class: 'btns' }, btn('+ Source', () => ed.addSource())));
  root.append(h('div', { class: 'hint' }, `Sources: ${L.sources.length} `, info('LMB on an icon selects and moves it, RMB on an icon opens its menu, RMB on empty space adds a source.')));
  if (L.sources[ed.sourceSel]) {
    root.append(h('div', { class: 'sect' }, `Source #${ed.sourceSel}`));
    sourceProps(ed, root, L);
    root.append(h('div', { class: 'btns' }, btn('Delete source', () => ed.deleteSource(), { class: 'danger' })));
  }
}

export function sourceProps(ed, root, L) {
  const s = L.sources[ed.sourceSel];
  if (!s) return false;
  const editLayer = (label, fn) => { ed.history.edit(ed.map, 'layer', label, L, fn); ed.emit('layerprops'); };
  const ed1 = (label, fn) => editLayer(label, () => fn(L.sources[ed.sourceSel]));
  root.append(prop('X/Y', num(+s.x.toFixed(2), (v) => ed1('Position', (x) => (x.x = v))), num(+s.y.toFixed(2), (v) => ed1('Position', (x) => (x.y = v)))));
  root.append(prop('Shape', select([['circle', 'circle'], ['rect', 'rectangle']], s.shape, (v) => ed1('Shape', (x) => (x.shape = v)), { preview: shapePreview })));
  if (s.shape === 'circle') root.append(prop('Radius', num(s.radius, (v) => ed1('Radius', (x) => (x.radius = Math.max(0, Math.round(v)))), { min: 0 })));
  else root.append(prop('Width/height', num(s.w, (v) => ed1('Size', (x) => (x.w = Math.max(0, Math.round(v)))), { min: 0 }), num(s.h, (v) => ed1('Size', (x) => (x.h = Math.max(0, Math.round(v)))), { min: 0 })));
  root.append(prop('Falloff', num(s.falloff, (v) => ed1('Falloff', (x) => (x.falloff = Math.round(v))), { min: 0, max: 255 }), h('span', { class: 'hint' }, '0..255')));
  root.append(prop('Loop', check(s.loop, (v) => ed1('Loop', (x) => (x.loop = v)))));
  root.append(prop('Panning', check(s.pan, (v) => ed1('Panning', (x) => (x.pan = v)))));
  root.append(prop('Delay, s', num(s.delay, (v) => ed1('Delay', (x) => (x.delay = Math.max(0, Math.round(v)))), { min: 0 })));
  root.append(prop('Pos env', select(envOptions(ed, 3), s.posEnv, (v) => ed1('Pos env', (x) => (x.posEnv = +v)), { preview: envPreview(ed) }), num(s.posEnvOffset, (v) => ed1('Offset', (x) => (x.posEnvOffset = Math.round(v))), { width: 60 })));
  root.append(prop('Sound env', select(envOptions(ed, 1), s.soundEnv, (v) => ed1('Sound env', (x) => (x.soundEnv = +v)), { preview: envPreview(ed) }), num(s.soundEnvOffset, (v) => ed1('Offset', (x) => (x.soundEnvOffset = Math.round(v))), { width: 60 })));
}

function automapperProps(ed, root, L, editLayer) {
  const confs = ed.rulesFor(L);
  root.append(h('div', { class: 'sect' }, 'Automapper'));
  if (confs === null) { root.append(h('div', { class: 'hint' }, 'Loading rules…')); return; }
  if (!confs.length) { root.append(h('div', { class: 'hint' }, `No rules file for "${ed.map.images[L.image].name}" (data/editor/automap).`)); return; }
  const a = L.automapper || { config: -1, seed: 0, flags: 0 };
  const setA = (label, patch) => editLayer(label, () => { L.automapper = { ...a, ...patch }; });
  root.append(prop('Config', select([[-1, '— none —'], ...confs.map((c, i) => [i, c.name])], a.config, (v) => {
    setA('Automapper config', { config: +v });
    if (L.automapper.flags & 1) editLayer('Automap', () => ed.liveAutomap(L));
  })));
  root.append(prop('Reference', select([[-1, '— none —'], ...REFERENCE_NAMES.map((n, i) => [i, n])], L._amRef ?? -1, (v) => { L._amRef = +v; }),
    info('Optional: take the tiles from the Game layer (all of them or one kind) and automap those')));
  root.append(prop('Seed', num(a.seed, (v) => setA('Seed', { seed: Math.max(0, Math.round(v)) }), { min: 0, max: 1000000000 }),
    info('Random seed of the rules. 0 = a new random result every run.')));
  root.append(prop('Live', check(!!(a.flags & 1), (v) => setA('Automatic automapper', { flags: v ? a.flags | 1 : a.flags & ~1 })),
    info('Live: run the automapper after every edit (needs a seed)')));
  root.append(h('div', { class: 'btns' }, btn('Run automapper', () => ed.runAutomapNow(), { disabled: a.config < 0, class: 'accent', title: a.config < 0 ? 'Choose a config first' : 'Automap the whole layer now' })));
}

function quadLayerProps(ed, root, L, editLayer) {
  root.append(h('div', { class: 'btns' },
    btn('+ Quad', () => ed.addQuad()),
    btn('Select all', () => { L.quads.forEach((_, i) => ed.quadSel.add(i)); ed.emit('selection'); })));
  const qs = ed.selectedQuads();
  root.append(h('div', { class: 'hint' }, `Quads: ${L.quads.length} `, info('Click a quad to select it, drag a box (also over other quads) to select many, Ctrl+A selects all. Drag the centre point to move, Ctrl+drag moves only the pivot. With several quads selected, Colour changes all of them.')));
  if (!qs.length) return;
  root.append(h('div', { class: 'sect' }, qs.length === 1 ? `Quad #${[...ed.quadSel][0]}` : `Selected quads: ${qs.length}`));
  const q0 = qs[0];
  const editQ = (label, fn) => ed.editQuads(label, () => qs.forEach(fn));
  if (qs.length > 1) root.append(prop(`Colour (${qs.length})`, ...rgba(q0.colors[0], (col) => editQ('Colour', (q) => { q.colors = [0, 1, 2, 3].map(() => [...col]); }))));
  quadProps(ed, root, L);
  const pts = [...ed.pointSel].map((k) => k.split(':').map(Number)).filter(([i]) => L.quads[i]);
  if (pts.length) {
    const [qi, c] = pts[0];
    root.append(h('div', { class: 'sect' }, pts.length === 1 ? `Point ${c} of quad #${qi}` : `Selected points: ${pts.length}`));
    pointProps(ed, root, L);
  } else if (qs.length === 1) {
    root.append(prop('Colour (all corners)', ...rgba(q0.colors[0], (col) => editQ('Colour', (q) => { q.colors = [0, 1, 2, 3].map(() => [...col]); }))));
  }
  root.append(h('div', { class: 'btns' },
    btn('Square', () => editQ('Square', T.squareQuad)),
    btn('Grid align', () => editQ('Align', (q) => T.alignQuad(q, TILE / 2))),
    L.image >= 0 ? btn('Aspect', () => ed.aspectQuads()) : null,
    btn('⟳90', () => editQ('Rotate', (q) => T.rotateQuad(q, 90))),
    btn('Pivot', () => ed.centerPivot(), { title: 'Center pivot' }),
    qs.length === 1 ? btn('Knife', () => ed.startKnife(), { title: 'Slice: cut a piece of the quad' }) : null,
    btn('Duplicate', () => ed.duplicateQuads()),
    btn('Delete', () => ed.deleteQuads(), { class: 'danger' })));
}

// position and envelopes of the selected quads (side panel and quad popup)
export function quadProps(ed, root, L, popup = false) {
  const qs = ed.selectedQuads();
  if (!qs.length) return false;
  const q0 = qs[0];
  const editQ = (label, fn) => ed.editQuads(label, () => qs.forEach(fn));
  if (popup) {
    const qi = L.quads.indexOf(q0);
    root.append(prop('Order', num(qi, (v) => ed.setQuadOrder(qi, Math.round(v)), { min: 0, max: L.quads.length - 1 })));
  }
  root.append(prop('Centre X/Y',
    num(+q0.points[4][0].toFixed(3), (v) => editQ('Position', (q) => T.moveQuad(q, v - q0.points[4][0], 0)), { step: 1 }),
    num(+q0.points[4][1].toFixed(3), (v) => editQ('Position', (q) => T.moveQuad(q, 0, v - q0.points[4][1])), { step: 1 })));
  root.append(prop('Pos env', select(envOptions(ed, 3), q0.posEnv, (v) => editQ('Pos env', (q) => (q.posEnv = +v)), { preview: envPreview(ed) }),
    num(q0.posEnvOffset, (v) => editQ('Pos env offset', (q) => (q.posEnvOffset = Math.round(v))), { width: 60 })));
  root.append(prop('Color env', select(envOptions(ed, 4), q0.colorEnv, (v) => editQ('Color env', (q) => (q.colorEnv = +v)), { preview: envPreview(ed) }),
    num(q0.colorEnvOffset, (v) => editQ('Color env offset', (q) => (q.colorEnvOffset = Math.round(v))), { width: 60 })));
  if (popup) root.append(prop('Colour', ...rgba(q0.colors[0], (col) => editQ('Colour', (q) => { q.colors = [0, 1, 2, 3].map(() => [...col]); }))));
}

// selected quad corner points (side panel and point popup)
export function pointProps(ed, root, L) {
  const pts = [...ed.pointSel].map((k) => k.split(':').map(Number)).filter(([i]) => L.quads[i]);
  if (!pts.length) return false;
  {
    const [qi, c] = pts[0];
    const p = L.quads[qi].points[c];
    const editP = (label, fn) => ed.editQuads(label, () => pts.forEach(([i, k]) => fn(L.quads[i], k)));
    root.append(prop('X/Y', num(+p[0].toFixed(3), (v) => editP('Point', (q, k) => (q.points[k][0] = v))), num(+p[1].toFixed(3), (v) => editP('Point', (q, k) => (q.points[k][1] = v)))));
    root.append(prop('Colour', ...rgba(L.quads[qi].colors[c], (col) => editP('Point colour', (q, k) => (q.colors[k] = [...col])))));
    root.append(prop('Texture U/V', num(+L.quads[qi].tex[c][0].toFixed(4), (v) => editP('Texture', (q, k) => (q.tex[k][0] = v)), { step: 0.0625 }),
      num(+L.quads[qi].tex[c][1].toFixed(4), (v) => editP('Texture', (q, k) => (q.tex[k][1] = v)), { step: 0.0625 })));
  }
}

// ================================================================== bottom tabs

// the tabs of the bottom panel; modules add theirs to ed.ext.tabs (timeline.js)
export const CORE_TABS = {
  images: { title: 'Images', render: imagesTab, refreshOn: ['images'] },
  envelopes: { title: 'Envelopes', render: envelopesTab },
  sounds: { title: 'Sounds', render: soundsTab },
  server: { title: 'Server settings', render: serverTab },
  history: { title: 'History', render: historyTab, refreshOn: ['history'] },
};

export function renderBottom(ed, tab) {
  const root = document.getElementById('tab-body');
  root.innerHTML = '';
  const t = ed.ext.tabs.get(tab);
  if (t) t.render(ed, root);
}

function imageUsage(map, idx) {
  let n = 0;
  for (const g of map.groups) for (const l of g.layers) if ((l.type === 'tiles' && l.kind === 'tiles' || l.type === 'quads') && l.image === idx) n++;
  return n;
}

async function fileToRgba(file) {
  const url = URL.createObjectURL(file);
  try { return imageToRgba(await loadImage(url)); } finally { URL.revokeObjectURL(url); }
}

function imageToRgba(im) {
  const c = document.createElement('canvas');
  c.width = im.width; c.height = im.height;
  const x = c.getContext('2d');
  x.drawImage(im, 0, 0);
  return { width: im.width, height: im.height, rgba: new Uint8Array(x.getImageData(0, 0, im.width, im.height).data.buffer) };
}

export const IMAGE_EXT = /\.(png|jpe?g|webp|gif|bmp|avif|tiff?)$/i;

// Any browser-readable image (PNG, JPG, WEBP, GIF, BMP…) is decoded to RGBA and embedded, which is what a .map stores
// (exported again as PNG). Returns the indices of the added images.
export async function addImageFiles(ed, files) {
  const added = [];
  const taken = new Set(ed.map.images.map((im) => im.name));
  for (const f of files) {
    if (ed.map.images.length + added.length >= 64) { ed.status('A map can hold at most 64 images'); break; }
    try {
      const { width, height, rgba: px } = await fileToRgba(f);
      let base = f.name.replace(IMAGE_EXT, '').replace(/[^\w\- .()]/g, '_').slice(0, 120) || 'image', name = base, n = 2;
      while (taken.has(name)) name = `${base}_${n++}`;
      taken.add(name);
      added.push({ name, width, height, external: false, rgba: px });
    } catch { ed.status('Could not read ' + f.name); }
  }
  if (!added.length) return [];
  const start = ed.map.images.length;
  ed.editStructure('Add image', () => ed.map.images.push(...added));
  const big = added.filter((im) => im.width > 4096 || im.height > 4096);
  ed.status(`Images added: ${added.map((im) => `${im.name} (${im.width}×${im.height})`).join(', ')}` + (big.length ? '. Warning: images over 4096 px may not load in DDNet' : ''));
  return added.map((_, i) => start + i);
}

function imagesTab(ed, root) {
  const map = ed.map;
  ed._imgSel = Math.min(ed._imgSel ?? -1, map.images.length - 1);
  const list = h('div', { class: 'img-list' });
  map.images.forEach((im, i) => {
    const thumb = h('div', { class: 'thumb' });
    const src = ed.imageSource(i);
    if (src) {
      const c = document.createElement('canvas');
      const s = Math.min(1, 118 / Math.max(src.width, src.height));
      c.width = Math.max(1, Math.round(src.width * s)); c.height = Math.max(1, Math.round(src.height * s));
      c.getContext('2d').drawImage(src, 0, 0, c.width, c.height);
      thumb.append(c);
    } else thumb.append(h('span', { class: 'hint' }, im.external ? 'not in mapres' : '…'));
    const used = imageUsage(map, i);
    list.append(h('div', {
      class: 'img-card' + (ed._imgSel === i ? ' sel' : ''), title: 'Select image. Right click for the image menu.',
      onclick: () => { ed._imgSel = i; renderBottom(ed, 'images'); },
      oncontextmenu: (e) => { e.preventDefault(); ed._imgSel = i; renderBottom(ed, 'images'); imagePopup(ed, i, e.clientX, e.clientY); },
    }, thumb,
      h('div', { class: 'cap', title: im.name }, `#${i} ${im.name}`),
      h('div', { class: 'cap' }, h('small', {}, `${im.width}×${im.height} ${im.external ? 'external' : 'embedded'}`), used ? '' : h('small', { class: 'unused' }, ' unused'))));
  });
  const sel = map.images[ed._imgSel];
  const tools = h('div', { class: 'btns' },
    btn('+ Image file', () => document.getElementById('file-img').click()),
    btn('+ From DDNet mapres', () => mapresDialog(ed)),
    sel ? btn('Rename', () => renameImage(ed, ed._imgSel)) : null,
    sel ? btn('Replace…', () => replaceImage(ed, ed._imgSel)) : null,
    sel ? btn(sel.external ? 'Embed' : 'Make external', () => toggleExternal(ed, ed._imgSel)) : null,
    sel && !sel.external ? btn('Export PNG', () => exportImage(ed, ed._imgSel)) : null,
    sel ? btn('Delete', () => deleteImage(ed, ed._imgSel), { class: 'danger' }) : null,
    map.images.some((_, i) => !imageUsage(map, i)) ? btn('Delete unused', () => deleteUnusedImages(ed)) : null);
  root.append(tools, list);
}

// DDNet image popup: embed / make external, re-import, replace, remove, export
export function imagePopup(ed, i, x, y) {
  const im = ed.map.images[i];
  if (!im) return;
  popup(x, y, (el) => {
    el.append(
      h('div', { class: 'hint' }, `${im.width}×${im.height}, ${im.external ? 'external' : 'embedded'}`),
      im.external ? item('Embed', () => toggleExternal(ed, i), { title: 'Embed the image into the map file.' })
        : item('Make external', () => toggleExternal(ed, i), { title: 'Remove the image from the map file.' }),
      item('Re-import', () => reimportImage(ed, i), { title: 'Re-import the image from the mapres folder.' }),
      item('Replace', () => replaceImage(ed, i), { title: 'Replace the image with a new one.' }),
      item('Rename', () => renameImage(ed, i)),
      item('Remove', () => deleteImage(ed, i), { danger: true, title: 'Remove the image from the map.' }),
      !im.external ? item('Export', () => exportImage(ed, i), { title: 'Export the image to a separate file.' }) : null);
  }, { title: `Image #${i} ${im.name}` });
}

async function reimportImage(ed, i) {
  const im = ed.map.images[i];
  try {
    const px = imageToRgba(await loadImage('/mapres/' + encodeURIComponent(im.name) + '.png'));
    const fresh = { ...im, ...px, rgba: im.external ? null : px.rgba, _rev: (im._rev || 0) + 1 };
    ed.editStructure('Re-import image', () => (ed.map.images[i] = fresh));
    ed.status(`Re-imported ${im.name}.png from mapres`);
  } catch { ed.status(`mapres/${im.name}.png not found`); }
}

function renameImage(ed, i) {
  const im = ed.map.images[i];
  const inp = h('input', { type: 'text', value: im.name, style: { width: '300px' } });
  modal('Image name', inp, [['Cancel', () => {}], ['OK', () => { ed.editStructure('Image name', () => (im.name = inp.value.slice(0, 127))); }, 'accent']]);
  setTimeout(() => inp.select(), 0);
}

function replaceImage(ed, i) {
  const inp = h('input', { type: 'file', accept: 'image/png' });
  inp.onchange = async () => {
    const f = inp.files[0];
    if (!f) return;
    const { width, height, rgba: px } = await fileToRgba(f);
    const im = ed.map.images[i];
    const fresh = { ...im, width, height, rgba: px, external: false, _rev: (im._rev || 0) + 1 };
    ed.editStructure('Replace image', () => (ed.map.images[i] = fresh));
    ed.status(`Image #${i} replaced with ${f.name}`);
  };
  inp.click();
}

async function toggleExternal(ed, i) {
  const im = ed.map.images[i];
  if (im.external) {
    try {
      const px = imageToRgba(await loadImage('/mapres/' + encodeURIComponent(im.name) + '.png'));
      const fresh = { ...im, ...px, external: false, _rev: (im._rev || 0) + 1 };
      ed.editStructure('Embed image', () => (ed.map.images[i] = fresh));
    } catch { ed.status('Image not in mapres: set the DDNet folder in the settings'); }
  } else {
    const ok = await fetch('/mapres/' + encodeURIComponent(im.name) + '.png', { method: 'HEAD' }).then((r) => r.ok).catch(() => false);
    if (!ok) { ed.status(`"${im.name}" is not a standard DDNet mapres image, so it cannot be external`); return; }
    const fresh = { ...im, external: true, rgba: null, _rev: (im._rev || 0) + 1 };
    ed.editStructure('Make external', () => (ed.map.images[i] = fresh));
  }
}

function exportImage(ed, i) {
  const src = ed.imageSource(i);
  src.toBlob((b) => { const a = document.createElement('a'); a.href = URL.createObjectURL(b); a.download = ed.map.images[i].name + '.png'; a.click(); });
}

function remapImages(map, mapping) {
  for (const g of map.groups) for (const l of g.layers) if (l.type === 'tiles' && l.kind === 'tiles' || l.type === 'quads') if (l.image >= 0) l.image = mapping(l.image);
}

async function deleteImage(ed, i) {
  const used = imageUsage(ed.map, i);
  if (used && !(await confirmBox('Delete image', `The image is used by ${used} layer(s). They will be left without an image.`, 'Delete'))) return;
  ed.history.edit(ed.map, 'full', 'Delete image', null, () => {
    ed.map.images.splice(i, 1);
    remapImages(ed.map, (k) => (k === i ? -1 : k > i ? k - 1 : k));
  });
  ed.emit('map');
}

function deleteUnusedImages(ed) {
  const keep = ed.map.images.map((_, i) => imageUsage(ed.map, i) > 0);
  const newIdx = [];
  let n = 0;
  keep.forEach((k, i) => (newIdx[i] = k ? n++ : -1));
  ed.history.edit(ed.map, 'full', 'Delete unused images', null, () => {
    ed.map.images = ed.map.images.filter((_, i) => keep[i]);
    remapImages(ed.map, (k) => newIdx[k]);
  });
  ed.emit('map');
}

async function mapresDialog(ed) {
  let names = [];
  try { names = await fetch('/api/mapres').then((r) => r.json()); } catch { /* server without mapres */ }
  if (!names.length) { modal('Mapres', h('div', { class: 'hint', style: { maxWidth: '420px' } }, 'DDNet data/mapres folder not found. Set the game folder in "Edit → Editor settings".'), [['OK', () => {}]]); return; }
  const grid = h('div', { class: 'img-list', style: { maxWidth: '760px' } });
  const m = modal('Standard DDNet images (external)', grid, [['Close', () => {}]]);
  for (const n of names) {
    grid.append(h('div', { class: 'img-card', onclick: async () => {
      const im = await loadImage('/mapres/' + encodeURIComponent(n) + '.png');
      ed.editStructure('Add external image', () => ed.map.images.push({ name: n, width: im.width, height: im.height, external: true, rgba: null }));
      m.close();
    } }, h('div', { class: 'thumb' }, h('img', { src: '/mapres/' + encodeURIComponent(n) + '.png', loading: 'lazy' })), h('div', { class: 'cap' }, n)));
  }
}

// ------------------------------------------------------------------ envelopes

const CH_COLORS = ['#ff5a5a', '#5aff7a', '#5a9aff', '#dddddd'];
const CH_NAMES = { 1: ['V'], 3: ['X', 'Y', 'R'], 4: ['R', 'G', 'B', 'A'] };

function envelopesTab(ed, root) {
  const map = ed.map;
  if (ed._envSel === undefined || ed._envSel >= map.envelopes.length) ed._envSel = map.envelopes.length ? 0 : -1;
  const list = h('div', { class: 'env-list' });
  const newEnv = (ch) => () => {
    const pts = ch === 4 ? [{ time: 0, curve: 1, values: [1024, 1024, 1024, 1024] }, { time: 1000, curve: 1, values: [1024, 1024, 1024, 1024] }]
      : [{ time: 0, curve: 1, values: [0, 0, 0, 0] }, { time: 1000, curve: 1, values: [0, 0, 0, 0] }];
    ed.editStructure('New envelope', () => map.envelopes.push({ name: '', channels: ch, synchronized: false, points: pts }));
    ed._envSel = map.envelopes.length - 1;
    renderBottom(ed, 'envelopes');
  };
  list.append(h('div', { class: 'btns' }, btn('+ Colour', newEnv(4)), btn('+ Position', newEnv(3)), btn('+ Sound', newEnv(1)),
    btn('Delete unused', () => removeUnusedEnvelopes(ed))));
  map.envelopes.forEach((e, i) => {
    const kind = e.channels === 4 ? 'colour' : e.channels === 3 ? 'position' : 'sound';
    list.append(h('div', { class: 'env-item' + (i === ed._envSel ? ' sel' : ''), onclick: () => { ed._envSel = i; renderBottom(ed, 'envelopes'); } },
      `#${i} ${e.name || ''}`, h('small', {}, kind)));
  });
  const main = h('div', { class: 'env-main' });
  root.append(h('div', { class: 'env-wrap' }, list, main));
  const env = map.envelopes[ed._envSel];
  if (!env) { main.append(h('div', { class: 'hint' }, 'No envelopes. Create a colour, position or sound one.')); return; }
  envEditor(ed, main, env, ed._envSel);
}

function envUsage(map) {
  const used = new Set();
  for (const g of map.groups) for (const l of g.layers) {
    if (l.type === 'tiles' && l.colorEnv >= 0) used.add(l.colorEnv);
    if (l.type === 'quads') for (const q of l.quads) { if (q.posEnv >= 0) used.add(q.posEnv); if (q.colorEnv >= 0) used.add(q.colorEnv); }
    if (l.type === 'sounds' && l.sources) for (const s of l.sources) { if (s.posEnv >= 0) used.add(s.posEnv); if (s.soundEnv >= 0) used.add(s.soundEnv); }
  }
  return used;
}

function removeUnusedEnvelopes(ed) {
  const map = ed.map;
  const used = envUsage(map);
  if (map.groups.some((g) => g.layers.some((l) => l.type === 'sounds' && !l.sources))) { ed.status('A sound layer uses the old format, envelopes left untouched'); return; }
  const newIdx = [];
  let n = 0;
  map.envelopes.forEach((_, i) => (newIdx[i] = used.has(i) ? n++ : -1));
  const removed = map.envelopes.length - n;
  if (!removed) { ed.status('No unused envelopes'); return; }
  ed.history.edit(map, 'full', 'Delete unused envelopes', null, () => {
    map.envelopes = map.envelopes.filter((_, i) => used.has(i));
    const fix = (v) => (v >= 0 ? newIdx[v] : v);
    for (const g of map.groups) for (const l of g.layers) {
      if (l.type === 'tiles') l.colorEnv = fix(l.colorEnv);
      if (l.type === 'quads') for (const q of l.quads) { q.posEnv = fix(q.posEnv); q.colorEnv = fix(q.colorEnv); }
      if (l.type === 'sounds' && l.sources) for (const s of l.sources) { s.posEnv = fix(s.posEnv); s.soundEnv = fix(s.soundEnv); }
    }
  });
  ed._envSel = -1;
  ed.status(`Envelopes deleted: ${removed}`);
  ed.emit('map');
}

function envEditor(ed, main, env, idx) {
  const map = ed.map;
  const st = (ed._envState ||= { point: 0, channels: [true, true, true, true] });
  if (st.env !== env) { st.env = env; st.point = 0; }
  const edit = (label, fn) => { ed.history.edit(map, 'structure', label, null, fn); refresh(); ed.redraw(); };
  const names = CH_NAMES[env.channels] || ['V'];
  const tools = h('div', { class: 'env-tools' });
  const graph = h('div', { class: 'env-graph' });
  const canvas = h('canvas');
  graph.append(canvas);
  const fields = h('div', { class: 'env-tools' });
  main.append(tools, graph, fields);

  tools.append(
    'Name', text(env.name, (v) => edit('Envelope name', () => (map.envelopes[idx].name = v.slice(0, 31))), { maxlength: 31, style: { width: '120px' } }),
    check(env.synchronized, (v) => edit('Synchronize', () => (map.envelopes[idx].synchronized = v)), 'sync'),
    ...names.map((n, c) => check(st.channels[c], (v) => { st.channels[c] = v; draw(); }, h('span', { style: { color: CH_COLORS[c] } }, n))),
    btn('+ Point', () => addPoint()),
    btn('Delete point', () => delPoint()),
    btn('Delete envelope', () => delEnv(), { class: 'danger' }),
    info('LMB on a point selects and drags it, double click adds a point.'));

  function cur() { return map.envelopes[idx]; }

  function refresh() {
    fields.innerHTML = '';
    const e = cur();
    const p = e && e.points[st.point];
    if (!p) { draw(); return; }
    const scale = (c) => (e.channels === 4 ? 1024 : e.channels === 3 && c === 2 ? 1024 : 1024);
    fields.append(`Point ${st.point}:`, 'time, ms', num(p.time, (v) => edit('Point time', () => (cur().points[st.point].time = Math.max(0, Math.round(v)))), { min: 0 }));
    names.forEach((n, c) => fields.append(h('span', { style: { color: CH_COLORS[c] } }, n), num(+(p.values[c] / scale(c)).toFixed(3), (v) => edit('Point value', () => (cur().points[st.point].values[c] = Math.round(v * scale(c)))), { step: e.channels === 4 ? 0.05 : 1, width: 70 })));
    fields.append('curve', select(CURVE_NAMES.map((n, i) => [i, n]), p.curve, (v) => edit('Curve', () => (cur().points[st.point].curve = +v)), { preview: curvePreview }));
    draw();
  }

  function view() {
    const e = cur();
    const tmax = Math.max(1000, ...e.points.map((p) => p.time)) * 1.08;
    let vmin = Infinity, vmax = -Infinity;
    for (const p of e.points) names.forEach((_, c) => { if (st.channels[c]) { vmin = Math.min(vmin, p.values[c] / 1024); vmax = Math.max(vmax, p.values[c] / 1024); } });
    if (e.channels === 4) { vmin = Math.min(0, vmin); vmax = Math.max(1, vmax); }
    if (!Number.isFinite(vmin)) { vmin = 0; vmax = 1; }
    if (vmax - vmin < 1e-6) { vmin -= 1; vmax += 1; }
    const pad = (vmax - vmin) * 0.1;
    return { tmax, vmin: vmin - pad, vmax: vmax + pad };
  }

  function draw() {
    const e = cur();
    if (!e) return;
    const r = graph.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.max(1, r.width * dpr); canvas.height = Math.max(1, r.height * dpr);
    const x = canvas.getContext('2d');
    x.setTransform(dpr, 0, 0, dpr, 0, 0);
    const W = r.width, H = r.height;
    const v = view();
    const X = (t) => (t / v.tmax) * W, Y = (val) => H - ((val - v.vmin) / (v.vmax - v.vmin)) * H;
    const step = [100, 250, 500, 1000, 2000, 5000, 10000, 30000, 60000, 120000].find((s) => X(s) >= 60) || 300000;
    x.strokeStyle = '#333'; x.beginPath();
    for (let t = 0; t <= v.tmax; t += step) { x.moveTo(X(t), 0); x.lineTo(X(t), H); }
    x.stroke();
    x.fillStyle = '#777'; x.font = '10px sans-serif';
    for (let t = 0; t <= v.tmax; t += step) x.fillText(`${t / 1000}s`, X(t) + 2, H - 3);
    x.strokeStyle = '#555'; x.beginPath(); x.moveTo(0, Y(0)); x.lineTo(W, Y(0)); x.stroke();
    names.forEach((_, c) => {
      if (!st.channels[c]) return;
      x.strokeStyle = CH_COLORS[c]; x.beginPath();
      for (let px = 0; px <= W; px += 2) {
        const t = (px / W) * v.tmax;
        const end = e.points[e.points.length - 1].time;
        const val = t > end ? e.points[e.points.length - 1].values[c] / 1024 : evalEnvelope(e, t)[c];
        if (px === 0) x.moveTo(px, Y(val)); else x.lineTo(px, Y(val));
      }
      x.stroke();
      e.points.forEach((p, i) => {
        x.fillStyle = i === st.point ? '#fff' : CH_COLORS[c];
        x.fillRect(X(p.time) - 4, Y(p.values[c] / 1024) - 4, 8, 8);
      });
    });
    if (ed.opts.play) {
      const end = e.points[e.points.length - 1].time || 1;
      const t = ed.opts.time % end;
      x.strokeStyle = '#ffb347'; x.beginPath(); x.moveTo(X(t), 0); x.lineTo(X(t), H); x.stroke();
    }
  }

  let drag = null;
  canvas.addEventListener('mousedown', (ev) => {
    const e = cur(), r = canvas.getBoundingClientRect(), v = view();
    const mx = ev.clientX - r.left, my = ev.clientY - r.top;
    const X = (t) => (t / v.tmax) * r.width, Y = (val) => r.height - ((val - v.vmin) / (v.vmax - v.vmin)) * r.height;
    let best = null;
    e.points.forEach((p, i) => names.forEach((_, c) => {
      if (!st.channels[c]) return;
      const d = Math.hypot(X(p.time) - mx, Y(p.values[c] / 1024) - my);
      if (d < 8 && (!best || d < best.d)) best = { i, c, d };
    }));
    if (!best) return;
    st.point = best.i;
    ed.history.begin(map, 'structure', 'Move envelope point');
    drag = { i: best.i, c: best.c, v, r };
    refresh();
  });
  canvas.addEventListener('contextmenu', (ev) => {
    ev.preventDefault();
    const e = cur(), r = canvas.getBoundingClientRect(), v = view();
    const mx = ev.clientX - r.left, my = ev.clientY - r.top;
    const X = (t) => (t / v.tmax) * r.width, Y = (val) => r.height - ((val - v.vmin) / (v.vmax - v.vmin)) * r.height;
    let best = null;
    e.points.forEach((p, i) => names.forEach((_, c) => {
      if (!st.channels[c]) return;
      const d = Math.hypot(X(p.time) - mx, Y(p.values[c] / 1024) - my);
      if (d < 8 && (!best || d < best.d)) best = { i, c, d };
    }));
    if (best) {
      st.point = best.i;
      refresh();
      pointPopup(ev.clientX, ev.clientY);
      return;
    }
    // DDNet: right click on a curve segment picks its curve type
    const t = (mx / r.width) * v.tmax;
    let seg = -1;
    e.points.forEach((p, i) => { if (p.time <= t && i < e.points.length - 1) seg = i; });
    if (seg < 0) return;
    st.point = seg;
    refresh();
    curvePopup(ev.clientX, ev.clientY);
  });

  function curvePopup(x, y) {
    popup(x, y, (el) => {
      const p = cur() && cur().points[st.point];
      if (!p) return false;
      CURVE_NAMES.forEach((n, ci) => el.append(item(n, () => edit('Curve', () => (cur().points[st.point].curve = ci)), { on: p.curve === ci })));
    }, { title: 'Curve type' });
  }

  function pointPopup(x, y) {
    popup(x, y, (el) => {
      const e = cur(), p = e && e.points[st.point];
      if (!p) return false;
      if (e.channels === 4) {
        el.append(prop('Colour', ...rgba(p.values.map((v) => Math.round(Math.max(0, Math.min(1, v / 1024)) * 255)),
          (col) => edit('Point colour', () => (cur().points[st.point].values = col.map((v) => Math.round((v / 255) * 1024)))))));
      }
      names.forEach((n, c) => el.append(prop(`Value ${n}`, num(+(p.values[c] / 1024).toFixed(3), (v) => edit('Point value', () => (cur().points[st.point].values[c] = Math.round(v * 1024))), { step: e.channels === 4 ? 0.05 : 1, width: 80 }))));
      el.append(prop('Time, ms', num(p.time, (v) => edit('Point time', () => {
        const pts = cur().points, i = st.point;
        if (i === 0) return;
        pts[i].time = Math.max(pts[i - 1].time + 1, Math.min(pts[i + 1] ? pts[i + 1].time - 1 : 1e9, Math.round(v)));
      }), { min: 0, width: 80 })));
      el.append(prop('Curve', select(CURVE_NAMES.map((n, i) => [i, n]), p.curve, (v) => edit('Curve', () => (cur().points[st.point].curve = +v)), { preview: curvePreview })));
      el.append(item('Delete', () => delPoint(), { danger: true, disabled: e.points.length <= 1, title: 'Delete the current point.' }));
    }, { title: () => `Envelope point ${st.point}` });
  }

  canvas.addEventListener('dblclick', (ev) => {
    const r = canvas.getBoundingClientRect(), v = view();
    const t = Math.round(((ev.clientX - r.left) / r.width) * v.tmax);
    addPoint(t);
  });
  const onMove = (ev) => {
    if (!drag) return;
    const e = cur(), p = e.points[drag.i];
    const { v, r } = drag;
    let t = Math.round(((ev.clientX - r.left) / r.width) * v.tmax);
    const prev = e.points[drag.i - 1], next = e.points[drag.i + 1];
    if (drag.i === 0) t = 0;
    else t = Math.max(prev ? prev.time + 1 : 0, Math.min(next ? next.time - 1 : 1e9, t));
    p.time = t;
    const val = v.vmin + (1 - (ev.clientY - r.top) / r.height) * (v.vmax - v.vmin);
    p.values[drag.c] = Math.round(val * 1024);
    ed.redraw();
    draw();
  };
  const onUp = () => { if (drag) { drag = null; ed.history.commit(); refresh(); } };
  window.addEventListener('mousemove', onMove);
  window.addEventListener('mouseup', onUp);
  // stop listening once this editor is replaced
  const obs = new MutationObserver(() => { if (!canvas.isConnected) { window.removeEventListener('mousemove', onMove); window.removeEventListener('mouseup', onUp); obs.disconnect(); clearInterval(timer); } });
  obs.observe(document.getElementById('tab-body'), { childList: true, subtree: true });
  const timer = setInterval(() => { if (ed.opts.play) draw(); }, 50);
  new ResizeObserver(() => draw()).observe(graph);

  function addPoint(t) {
    const e = cur();
    if (t === undefined) t = e.points.length ? e.points[e.points.length - 1].time + 500 : 0;
    const vals = e.points.length ? evalEnvelope(e, Math.min(t, e.points[e.points.length - 1].time)).map((x) => Math.round(x * 1024)) : [0, 0, 0, 0];
    edit('Add point', () => {
      const pts = cur().points;
      if (pts.some((p) => p.time === t)) return;
      pts.push({ time: t, curve: 1, values: vals });
      pts.sort((a, b) => a.time - b.time);
      st.point = pts.findIndex((p) => p.time === t);
    });
  }

  function delPoint() {
    if (cur().points.length <= 1) return;
    edit('Delete point', () => { cur().points.splice(st.point, 1); st.point = Math.max(0, st.point - 1); });
  }

  async function delEnv() {
    if (!(await confirmBox('Delete envelope', `Delete envelope #${idx}? References to it in layers and quads will be reset.`, 'Delete'))) return;
    ed.history.edit(map, 'full', 'Delete envelope', null, () => {
      map.envelopes.splice(idx, 1);
      const fix = (v) => (v === idx ? -1 : v > idx ? v - 1 : v);
      for (const g of map.groups) for (const l of g.layers) {
        if (l.type === 'tiles') l.colorEnv = fix(l.colorEnv);
        if (l.type === 'quads') for (const q of l.quads) { q.posEnv = fix(q.posEnv); q.colorEnv = fix(q.colorEnv); }
        if (l.type === 'sounds' && l.sources) for (const s of l.sources) { s.posEnv = fix(s.posEnv); s.soundEnv = fix(s.soundEnv); }
      }
    });
    ed._envSel = -1;
    ed.emit('map');
  }

  refresh();
}

// ------------------------------------------------------------------ sounds, server settings, history

function soundsTab(ed, root) {
  const map = ed.map;
  const inp = h('input', { type: 'file', accept: '.opus', hidden: true, onchange: async () => {
    const f = inp.files[0];
    if (!f) return;
    const data = new Uint8Array(await f.arrayBuffer());
    ed.editStructure('Add sound', () => map.sounds.push({ name: f.name.replace(/\.opus$/i, ''), external: false, data }));
  } });
  root.append(inp, h('div', { class: 'btns' }, btn('+ Sound (.opus)', () => inp.click())));
  const tb = h('table', { class: 'list-table' });
  map.sounds.forEach((s, i) => {
    tb.append(h('tr', { class: ed._sndSel === i ? 'sel' : '', title: 'Select sound. Right click for the sound menu.', onclick: () => { ed._sndSel = i; renderBottom(ed, 'sounds'); }, oncontextmenu: (e) => { e.preventDefault(); ed._sndSel = i; renderBottom(ed, 'sounds'); soundPopup(ed, i, e.clientX, e.clientY); } }, h('td', {}, `#${i}`), h('td', {}, s.name), h('td', {}, s.data ? `${(s.data.length / 1024).toFixed(1)} KB` : 'external'),
      h('td', {}, s.data ? btn('▶', () => { const a = new Audio(URL.createObjectURL(new Blob([s.data], { type: 'audio/ogg' }))); a.play().catch(() => ed.status('The browser cannot play this sound')); }) : null),
      h('td', {}, btn('Delete', () => deleteSound(ed, i), { class: 'danger' }))));
  });
  root.append(map.sounds.length ? tb : h('div', { class: 'hint' }, 'The map has no sounds.'));
}

function deleteSound(ed, i) {
  const map = ed.map;
  ed.history.edit(map, 'full', 'Delete sound', null, () => {
    map.sounds.splice(i, 1);
    for (const g of map.groups) for (const l of g.layers) if (l.type === 'sounds' && l.sound >= 0) l.sound = l.sound === i ? -1 : l.sound > i ? l.sound - 1 : l.sound;
  });
  ed.emit('map');
}

function pickOpus(fn) {
  const inp = h('input', { type: 'file', accept: '.opus' });
  inp.onchange = async () => { const f = inp.files[0]; if (f) fn(f, new Uint8Array(await f.arrayBuffer())); };
  inp.click();
}

// DDNet sound popup: re-import, replace, remove, export
export function soundPopup(ed, i, x, y) {
  const s = ed.map.sounds[i];
  if (!s) return;
  popup(x, y, (el) => {
    el.append(
      item('Re-import', async () => {
        const r = await fetch('/mapres/' + encodeURIComponent(s.name) + '.opus').catch(() => null);
        if (!r || !r.ok) { ed.status(`mapres/${s.name}.opus not found`); return; }
        const data = new Uint8Array(await r.arrayBuffer());
        ed.editStructure('Re-import sound', () => (ed.map.sounds[i] = { ...s, external: false, data }));
      }, { title: 'Re-import the sound from the mapres folder.' }),
      item('Replace', () => pickOpus((f, data) => ed.editStructure('Replace sound', () => (ed.map.sounds[i] = { ...s, external: false, data }))), { title: 'Replace the sound with a new one.' }),
      item('Remove', () => deleteSound(ed, i), { danger: true, title: 'Remove the sound from the map.' }),
      s.data ? item('Export', () => { const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([s.data], { type: 'audio/ogg' })); a.download = s.name + '.opus'; a.click(); }, { title: 'Export the sound to a separate file.' }) : null);
  }, { title: `Sound #${i} ${s.name}` });
}

function serverTab(ed, root) {
  const map = ed.map;
  const ta = h('textarea', { rows: 9, spellcheck: false, placeholder: 'sv_hit 0\nsv_endless_drag 1\ntune gravity 0.5' });
  ta.value = map.info.settings.join('\n');
  ta.addEventListener('change', () => {
    ed.history.edit(map, 'structure', 'Server settings', null, () => (map.info.settings = ta.value.split('\n').map((s) => s.trim()).filter(Boolean)));
  });
  root.append(h('div', { class: 'hint' }, 'Server commands ', info('Run when the map loads, one per line, like the Server settings tab in the DDNet editor.')), ta);
}

function historyTab(ed, root) {
  const H = ed.history;
  const tb = h('table', { class: 'list-table' });
  tb.append(h('tr', {}, h('td', { colspan: 2, class: 'hint' }, 'Start')));
  H.undoStack.forEach((p, i) => tb.append(h('tr', { class: i === H.undoStack.length - 1 ? 'sel' : '', style: { cursor: 'pointer' }, onclick: () => { while (H.undoStack.length - 1 > i) ed.undo(); } }, h('td', {}, i + 1), h('td', {}, p.label))));
  [...H.redoStack].reverse().forEach((p) => tb.append(h('tr', { style: { opacity: 0.5, cursor: 'pointer' }, onclick: () => { while (H.redoStack.length && H.redoStack[H.redoStack.length - 1] !== p) ed.redo(); ed.redo(); } }, h('td', {}, '↷'), h('td', {}, p.label))));
  root.append(tb);
}
