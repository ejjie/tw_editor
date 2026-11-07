// Module "gores". Gores mode for the game layer: hookable tiles always get a ring of freeze around them (8 neighbours).
// Only the cells next to an edit are looked at, so the rest of the map keeps whatever the mapper made by hand.
// Freeze that this mode placed is remembered in layer._gores (cell indices); only that freeze is taken away
// again when the hook next to it is erased. Freeze painted by hand is never removed.
import { TILE_BYTES, findGameLayer } from './map.js';
import { registerLayerExtra } from './history.js';
import { registerSessionExtra } from './session.js';

export const HOOK = 1, FREEZE = 9;

// remember the tile ids of a rectangle [x0, y0, x1, y1) before an edit (null = the whole layer)
export function goresBegin(L, rect = null) {
  const W = L.width, H = L.height, b = TILE_BYTES[L.kind];
  let [x0, y0, x1, y1] = rect || [0, 0, W, H];
  x0 = Math.max(0, Math.floor(x0)); y0 = Math.max(0, Math.floor(y0));
  x1 = Math.min(W, Math.ceil(x1)); y1 = Math.min(H, Math.ceil(y1));
  const ids = new Uint8Array(Math.max(0, (x1 - x0) * (y1 - y0)));
  for (let y = y0, k = 0; y < y1; y++) for (let x = x0; x < x1; x++, k++) ids[k] = L.tiles[(y * W + x) * b];
  return { x0, y0, x1, y1, ids };
}

// after the edit: add freeze around new hook; erased hook becomes air and our freeze that has no hook left goes too;
// air painted next to hook turns that hook into freeze (carving a path through a wall)
export function goresEnd(L, snap) {
  const W = L.width, H = L.height, b = TILE_BYTES[L.kind], t = L.tiles;
  const auto = L._gores || (L._gores = new Set());
  const id = (x, y) => (x < 0 || y < 0 || x >= W || y >= H ? -1 : t[(y * W + x) * b]);
  const set = (x, y, v) => { const o = (y * W + x) * b; t.fill(0, o, o + b); t[o] = v; };
  const nearHook = (x, y) => {
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) if ((dx || dy) && id(x + dx, y + dy) === HOOK) return true;
    return false;
  };
  const added = [], removed = [], aired = [];
  const { x0, y0, x1, y1, ids } = snap;
  for (let y = y0, k = 0; y < y1; y++) for (let x = x0; x < x1; x++, k++) {
    const now = t[(y * W + x) * b];
    if (now === ids[k]) continue;
    auto.delete(y * W + x); // the mapper wrote this cell
    if (now === 0) aired.push([x, y]);
    if (now === HOOK) added.push([x, y]);
    else if (ids[k] === HOOK) removed.push([x, y]);
  }
  let changed = false;
  for (const [x, y] of added) {
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      if (id(x + dx, y + dy) !== 0) continue;
      set(x + dx, y + dy, FREEZE); auto.add((y + dy) * W + x + dx); changed = true;
    }
  }
  for (const [x, y] of removed) {
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      const nx = x + dx, ny = y + dy;
      if (id(nx, ny) !== FREEZE || !auto.has(ny * W + nx) || nearHook(nx, ny)) continue;
      set(nx, ny, 0); auto.delete(ny * W + nx); changed = true;
    }
  }
  // air carves a path: hook touching the new air becomes freeze, so the path is lined with freeze as it is drawn.
  // This freeze is not remembered as ours: erasing hook later never takes it away (it lines the path, not a hook)
  for (const [x, y] of aired) {
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      if (id(x + dx, y + dy) !== HOOK) continue;
      set(x + dx, y + dy, FREEZE); auto.delete((y + dy) * W + x + dx); changed = true;
    }
  }
  return changed;
}

// plugs Gores mode into the editor: the G key and the Gores button, every tile edit of the game layer, undo and the
// session backup of layer._gores
export function setup(ed) {
  try { ed.opts.gores = localStorage.getItem('twe-gores') === '1'; } catch { ed.opts.gores = false; }
  const btn = document.getElementById('btn-gores');
  const sync = () => btn?.classList.toggle('on', !!ed.opts.gores);
  ed.setGores = (on) => {
    ed.opts.gores = on;
    try { localStorage.setItem('twe-gores', on ? '1' : '0'); } catch { /* storage blocked */ }
    ed.status(on ? 'Gores mode on: hookable tiles get a freeze ring' : 'Gores mode off');
    ed.emit('toggles');
  };
  ed.commands.gores = () => ed.setGores(!ed.opts.gores);
  ed.on('toggles', sync);
  sync();
  ed.ext.keys.push((e, k, mod) => {
    if (mod || k !== 'g' || e.repeat) return false;
    ed.commands.gores();
    return true;
  });

  // in Gores mode the freeze around hookable tiles follows every edit of the game layer
  ed.ext.tileEdit.push((L, rect, fn) => {
    if (!ed.opts.gores || !L || L.kind !== 'game') return fn();
    const snap = goresBegin(L, rect);
    const r = fn();
    return goresEnd(L, snap) || r;
  });
  // which freeze this mode placed: undone and redone with the layer, kept in the session backup
  registerLayerExtra('_gores', (l) => !!l.tiles, (v) => new Set(v || []));
  registerSessionExtra('gores', {
    save: (map) => { const g = findGameLayer(map); return g && g.layer._gores ? [...g.layer._gores] : []; },
    restore: (map, ids) => { const g = findGameLayer(map); if (g && Array.isArray(ids)) g.layer._gores = new Set(ids.filter((i) => g.layer.tiles[i * 4] === FREEZE)); },
  });
}
