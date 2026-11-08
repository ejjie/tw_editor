// Module "design". "Design it!": draws the map with ready tilesets. One automapped tile layer per kind of tile
// (hook, freeze, ...) in a new "Design" group right after the Game group.
// The window: Presets on the left (they fill in every setting), the preview of the player's own map in the middle
// (its game layers + its BG group, the camera on the spawn), the settings on the right: per kind a tileset, then
// the options of that tileset's rules.
import { h, modal, btn, check, select, closePopup, rgba } from './ui.js';
import { iconEl } from './icons.js';
import { newGroup, newTileLayer, findGameLayer, TILE_BYTES } from './map.js';
import { loadRules, runAutomapper } from './automapper.js';
import { loadImage, Renderer } from './render.js';

const TILE = 32;
const SEED = 1; // fixed, so the result is what the preview shows
const AF = 'amazing_freeze', STONES = 'Stones07_GreyMix_Sharp', MEADOW = 'meadow_obsidian';

// bottom -> top. src: which physics layer the kind is read from; ids: tile indices (null = any non-empty).
// fill: the tile the layer is drawn with before amazing_freeze's rules run ('game' = a copy of the game layer, only
// freeze: it alone gets a freeze style; every other kind is plain tile 1 + the corner configs)
const KINDS = [
  { key: 'freeze', label: 'Freeze', src: 'game', ids: [9, 12], fill: 'game' },
  { key: 'unfreeze', label: 'Unfreeze', src: 'game', ids: [11, 13], fill: 1 },
  { key: 'death', label: 'Death', src: 'game', ids: [2], fill: 1 },
  { key: 'tune', label: 'Tune', src: 'tune', ids: null, fill: 1 },
  { key: 'tele', label: 'Tele', src: 'tele', ids: [10, 26, 31, 63], fill: 1 }, // FROM + CFRM, red and blue
  // hook: everything solid is drawn with the hook tileset: hook and unhook, so its edges follow the whole wall.
  // Unhook is then drawn on top with its own tileset. Hookthrough = unhook in game + tile 66 in front: its own layer,
  // the top one: every other layer is cleared under it.
  // with amazing_freeze (flat blocks) the hook is not drawn under the unhook: hook tiles only (byTileset)
  { key: 'hook', label: 'Hook', src: 'game', ids: [1, 3], fill: 1, byTileset: { [AF]: { ids: [1] } } },
  // hook the hook tileset can't draw (meadow_obsidian has no 1 tile thick blocks): stones over it, same mask as hook,
  // the rules ("THIN HOOK" in Stones07_GreyMix_Sharp.rules) keep the 1 thick parts + 1 tile towards the hook
  { key: 'hookfix', label: 'Thin hook', src: 'game', ids: [1, 3], fill: 1, pre: '• 1 thick +1' },
  { key: 'unhook', label: 'Unhook', src: 'game', ids: [3], fill: 1, not: { src: 'front', ids: [66] } },
  { key: 'hookthrough', label: 'Hookthrough', src: 'game', ids: [3], fill: 1, only: { src: 'front', ids: [66] } },
];
const KIND = Object.fromEntries(KINDS.map((k) => [k.key, k]));

// The tilesets Design it! knows. rules: the .rules file; layers: one map layer per image, all with the same tiles
// (meadow_obsidian: ground + grass edge); base: the section whose configs are the "Style" list; mods: sections
// whose config (or Off) runs after the base, in this order. Configs are kept as indices (names repeat between sections).
const TILESETS = {
  [MEADOW]: {
    label: 'Meadow obsidian', rules: MEADOW, thin: true, // no 1 tile thick blocks: the Thin hook layer fixes them
    layers: [{ img: 'meadow_obsidian_white_bottom', name: '' }, { img: 'meadow_obsidian_white_top', name: 'top' }],
    base: { section: 'WHOLE MAP', def: ' Default' },
    mods: [
      { section: 'GRASS STYLE', label: 'Grass' },
      { section: 'DIRT STYLE', label: 'Dirt' },
      { section: 'DIRT CORNERS', label: 'Dirt corners' },
      { section: 'INSIDE DECO', label: 'Deco' },
    ],
  },
  [STONES]: {
    label: 'Stones 07 grey mix', rules: STONES, layers: [{ img: STONES, name: '' }],
    base: { section: 'WHOLE MAP', def: '• Grey Mixed' },
    mods: [{ section: 'ADD BLOCKS', label: 'Blocks' }, { section: 'RANDOMIZE ONES', label: 'Randomize' }],
  },
  [AF]: {
    label: 'Amazing freeze', rules: AF, layers: [{ img: AF, name: '' }], kindFill: true, skip: ['ejjie preset'],
    // the freeze style (Uneven Tiles) only for freeze; the other kinds (drawn with tile 1) use the one GAME TO HOOK config
    base: { section: 'GAME TO FREEZE', def: ' Uneven Tiles ⌇', fixed: true }, hookBase: 'GAME TO HOOK',
    mods: [{ section: 'INSIDE CORNERS', label: 'Inside corners', def: '> Soft S' }, { section: 'OUTSIDE CORNERS', label: 'Outside corners', def: '< Soft S' }],
  },
  plain: { label: 'Plain', plain: true, layers: [{ img: null, name: '' }], mods: [] },
};
// not in DDNet's mapres (they come from extra-data/): embedded so the map works anywhere
const EMBED = new Set([AF, STONES, 'meadow_obsidian_white_bottom', 'meadow_obsidian_white_top']);
// which tilesets each kind can be drawn with
const CHOICES = {
  hook: [MEADOW, STONES, AF], hookfix: [STONES], unhook: [STONES, AF], hookthrough: [STONES, AF],
  freeze: [AF], unfreeze: [AF], death: ['plain', AF], tune: [AF], tele: [AF],
};

// Presets: a tileset, options (by config name) and colours for each kind. Kinds a preset leaves out are off.
const PRESETS = [
  {
    name: 'Grass meadow', card: 'presets/meadow_obsidian.png',
    kinds: {
      hook: { ts: MEADOW, colors: [[62, 52, 78, 255], [126, 196, 84, 255]] },
      hookfix: { ts: STONES, colors: [[150, 128, 178, 255]] }, // lilac, close to the meadow ground
      unhook: { ts: STONES, colors: [[196, 214, 236, 255]] }, // light steel blue
      hookthrough: { ts: STONES, colors: [[255, 196, 110, 160]] }, // amber, see-through
      freeze: { ts: AF, colors: [[0, 0, 0, 100]] },
      unfreeze: { ts: AF, colors: [[140, 255, 160, 120]] },
      tele: { ts: AF, colors: [[90, 170, 255, 255]] },
      tune: { ts: AF, colors: [[190, 120, 255, 120]] },
      death: { ts: 'plain', colors: [[255, 0, 0, 255]] },
    },
  },
  {
    // Stones07_GreyMix_Sharp for everything solid (hook natural grey, unhook steel blue on top), amazing_freeze for the rest
    name: 'Generic stones', card: 'presets/generic_stones.png',
    kinds: {
      hook: { ts: STONES, colors: [[228, 226, 222, 255]] },
      unhook: { ts: STONES, colors: [[120, 138, 168, 255]] },
      hookthrough: { ts: STONES, colors: [[120, 138, 168, 140]] },
      freeze: { ts: AF, colors: [[0, 0, 0, 100]] },
      unfreeze: { ts: AF, colors: [[140, 255, 160, 120]] },
      tele: { ts: AF, colors: [[90, 170, 255, 255]] },
      tune: { ts: AF, colors: [[190, 120, 255, 120]] },
      death: { ts: 'plain', colors: [[255, 0, 0, 255]] },
    },
  },
  {
    // every layer is amazing_freeze: flat blocks, Soft S corners
    name: 'Amazing Flat', card: 'presets/amazing_flat.png',
    kinds: {
      hook: { ts: AF, colors: [[0, 0, 0, 255]] },
      unhook: { ts: AF, colors: [[58, 60, 68, 255]] },
      hookthrough: { ts: AF, colors: [[58, 60, 68, 120]] },
      freeze: { ts: AF, colors: [[18, 18, 22, 100]] },
      unfreeze: { ts: AF, colors: [[150, 235, 175, 110]] },
      tele: { ts: AF, colors: [[70, 140, 255, 255]] },
      tune: { ts: AF, colors: [[175, 115, 245, 110]] },
      death: { ts: AF, colors: [[210, 40, 40, 255]] },
    },
  },
];

// ---------------------------------------------------------------- rules

// a tileset's rules split by section: configs under an UPPER CASE header belong to it (before any header: WHOLE MAP).
// Entries are [config index, label, raw name].
const sectionsCache = new Map();
function rulesSections(ts) {
  const T = TILESETS[ts];
  if (!sectionsCache.has(ts)) sectionsCache.set(ts, loadRules(T.rules).then((confs) => {
    const sec = {};
    let cur = 'WHOLE MAP';
    confs.forEach((c, i) => {
      const n = c.name.trim();
      if (!n || /^v[\d.]+ by /.test(n) || (T.skip || []).includes(n)) return;
      if (n === n.toUpperCase() && /[A-Z]/.test(n) && !c.name.startsWith(' ') && !c.name.startsWith('•')) { cur = n; sec[cur] = sec[cur] || []; return; }
      (sec[cur] = sec[cur] || []).push([i, n.replace(/^•\s*/, ''), c.name]);
    });
    return sec;
  }));
  return sectionsCache.get(ts);
}
const SECS = {}; // filled when the window opens
const byName = (list, name) => { const e = (list || []).find((x) => x[2] === name); return e ? e[0] : null; };

// the settings of one kind drawn with tileset ts: preset values (by config name) or the tileset's defaults
function kindSettings(k, ts, p = {}, colors) {
  const T = TILESETS[ts], sec = SECS[ts] || {};
  const base = T.hookBase && k.fill === 1 ? T.hookBase : T.base ? (byName(sec[T.base.section], p.base || T.base.def) ?? ((sec[T.base.section] || [])[0] || [null])[0]) : null;
  const mods = Object.fromEntries(T.mods.map((m) => [m.section, byName(sec[m.section], (p.mods || {})[m.section] ?? m.def)]));
  const cols = T.layers.map((_, i) => [...((colors || [])[i] || (colors || [])[0] || [255, 255, 255, 255])]);
  return { ts, base, mods, colors: cols };
}

// a config of a rules file, by name or by index
async function configOf(rules, name) {
  const confs = await loadRules(rules);
  const i = typeof name === 'number' ? (name < confs.length ? name : -1) : confs.findIndex((c) => c.name === name);
  return i >= 0 ? { index: i, conf: confs[i] } : null;
}

// ---------------------------------------------------------------- map data

function physicsLayer(map, kind) {
  for (const g of map.groups) for (const l of g.layers) if (l.kind === kind) return l;
  return null;
}
// tele and tune keep the tile type in their second byte
const tileOf = (L, x, y) => L.tiles[(y * L.width + x) * TILE_BYTES[L.kind] + (L.kind === 'tele' || L.kind === 'tune' ? 1 : 0)];

// a game-layer-like grid (4 bytes a tile) with index 1 where the map has this kind. raw: the game layer as it is
function sourceGrid(map, kind, w, hgt, raw = false) {
  const L = physicsLayer(map, kind.src);
  const out = { width: w, height: hgt, tiles: new Uint8Array(w * hgt * 4), count: 0 };
  if (!L) return out;
  // a physics layer whose tiles take cells away (unhook: not where front has hookthrough)
  // and one that must also have one of its tiles there (hookthrough: front 66 on top of unhook)
  const NOT = kind.not && physicsLayer(map, kind.not.src), ONLY = kind.only && physicsLayer(map, kind.only.src);
  const table = (ids) => { const t = new Uint8Array(256); if (ids) for (const i of ids) t[i] = 1; else t.fill(1, 1); return t; };
  const want = table(kind.ids), notT = kind.not && table(kind.not.ids), onlyT = kind.only && table(kind.only.ids);
  const has = (X, T, x, y) => !!X && x < X.width && y < X.height && T[tileOf(X, x, y)] === 1;
  const B = TILE_BYTES[L.kind], at = L.kind === 'tele' || L.kind === 'tune' ? 1 : 0, T = L.tiles;
  for (let y = 0; y < Math.min(hgt, L.height); y++) for (let x = 0; x < Math.min(w, L.width); x++) {
    const v = T[(y * L.width + x) * B + at], o = (y * w + x) * 4;
    if (raw) { out.tiles[o] = v; continue; }
    if (!v || !want[v]) continue;
    if ((notT && has(NOT, notT, x, y)) || (onlyT && !has(ONLY, onlyT, x, y))) continue;
    out.tiles[o] = 1; out.count++;
  }
  return out;
}

// tile index to draw the layer with before automapping: 1, or the first tile the config keeps when its
// first run starts with "Index 0 / Pos 0 0 NOTINDEX a OR b ..." (basic_freeze, ddmax_freeze)
function fillTile(conf) {
  const run = conf.runs[0];
  for (const r of run ? run.rules : []) {
    if (r.id !== 0) continue;
    const p = r.pos.find((q) => q.x === 0 && q.y === 0 && q.value === 2 && q.list.some((i) => i.id > 0));
    if (p) return p.list.find((i) => i.id > 0).id;
  }
  return 1;
}

// the tiles of one kind: the layer starts as the shape of the kind and the configs run on it, like a hand-drawn
// layer in DDNet. Returns { T, index } (index = the last config, kept on the layer for re-running it later).
async function buildKind(map, k, s, src) {
  const T = { width: src.width, height: src.height, tiles: new Uint8Array(src.tiles.length) };
  const ts = TILESETS[s.ts];
  if (ts.plain) { T.tiles.set(src.tiles); return { T, index: -1 }; }
  const names = [...(k.pre ? [k.pre] : []), s.base, ...ts.mods.map((m) => s.mods[m.section]).filter((v) => v != null)].filter((v) => v != null);
  const cs = (await Promise.all(names.map((n) => configOf(ts.rules, n)))).filter(Boolean);
  if (!cs.length) { T.tiles.set(src.tiles); return { T, index: -1 }; }
  const game = ts.kindFill && k.fill === 'game';
  if (game) T.tiles.set(sourceGrid(map, k, src.width, src.height, true).tiles);
  else {
    // some rules first clear every tile that is not one of their own "fill" tiles, so draw with one of those
    const fill = ts.kindFill ? k.fill : fillTile(cs[0].conf);
    for (let i = 0; i < src.tiles.length; i += 4) T.tiles[i] = src.tiles[i] ? fill : 0;
  }
  for (const c of cs) runAutomapper(T, null, c.conf, SEED, -1);
  // keep the layer to where the kind is. Not for amazing_freeze: its inside corners are drawn on the empty cell in
  // the corner, and its freeze (a copy of the game layer) also fills the hook tiles next to freeze (the freeze goes
  // on under the hook's rounded edges)
  if (!ts.kindFill) for (let i = 0; i < src.tiles.length; i += 4) if (!src.tiles[i]) { T.tiles[i] = 0; T.tiles[i + 1] = 0; }
  return { T, index: cs[cs.length - 1].index };
}

const atlasCache = new Map();
function atlas(name) {
  if (!atlasCache.has(name)) atlasCache.set(name, loadImage('/mapres/' + encodeURIComponent(name) + '.png').catch(() => null));
  return atlasCache.get(name);
}
// a map image for a tileset. The preview only names it (the renderer loads /mapres/<name>.png itself); for Apply
// the ones that are not part of DDNet get their pixels, to be embedded in the map
const imageCache = new Map();
function mapImage(name, pixels = false) {
  const key = name + (pixels ? '|px' : '');
  if (!imageCache.has(key)) imageCache.set(key, atlas(name).then((im) => {
    if (!im) return null;
    let rgba = null;
    if (pixels && EMBED.has(name)) {
      const c = document.createElement('canvas');
      c.width = im.width; c.height = im.height;
      const g = c.getContext('2d', { willReadFrequently: true });
      g.drawImage(im, 0, 0);
      rgba = new Uint8Array(g.getImageData(0, 0, c.width, c.height).data.buffer);
    }
    return { name, width: im.width, height: im.height, external: !rgba, rgba };
  }));
  return imageCache.get(key);
}

// ---------------------------------------------------------------- the design of one map

// Everything that depends only on the map and the settings of a kind is computed once: the masks and the automapped
// tiles (a colour change or switching another kind off does not run the rules again).
function designer(map) {
  const game = findGameLayer(map).layer, W = game.width, H = game.height;
  const masks = Object.fromEntries(KINDS.map((k) => [k.key, sourceGrid(map, k, W, H)]));
  const has = Object.fromEntries(KINDS.map((k) => [k.key, masks[k.key].count > 0]));
  // a kind can read other tiles with some tilesets (hook with amazing_freeze: without the unhook)
  const variants = new Map();
  const maskOf = (k, ts) => {
    const v = k.byTileset && k.byTileset[ts];
    if (!v) return masks[k.key];
    const key = k.key + '|' + ts;
    if (!variants.has(key)) variants.set(key, sourceGrid(map, { ...k, ...v }, W, H));
    return variants.get(key);
  };
  const tiles = new Map();
  const cleared = new WeakMap(); // tiles of a kind with the hookthrough cells taken out, by the kind's tiles
  const tilesOf = (k, s) => {
    const key = k.key + '|' + JSON.stringify([s.ts, s.base, s.mods]);
    if (!tiles.has(key)) tiles.set(key, buildKind(map, k, s, maskOf(k, s.ts)));
    return tiles.get(key);
  };
  // the layers of a design: [{ name, color, T, index, img }], bottom -> top
  async function layers(d) {
    const out = [];
    for (const k of KINDS) {
      const s = d[k.key];
      if (!s || !s.on || !has[k.key] || !visible(d, k.key)) continue;
      const fresh = !tiles.has(k.key + '|' + JSON.stringify([s.ts, s.base, s.mods]));
      const { T, index } = await tilesOf(k, s);
      if (fresh) await new Promise((r) => setTimeout(r)); // let the window breathe between two heavy kinds
      if (!T.tiles.some((v, i) => !(i & 3) && v)) continue; // nothing to draw (e.g. no thin hook)
      TILESETS[s.ts].layers.forEach((L, i) => out.push({ key: k.key, name: layerName(k, s.ts, i), color: s.colors[i], T, index, img: index >= 0 ? L.img : null }));
    }
    // hookthrough is the top layer and usually see-through: nothing of the other layers stays under it
    const ht = out.find((b) => b.key === 'hookthrough');
    if (ht) {
      for (const b of out) {
        if (b.T === ht.T) continue;
        const key = b.T, prev = cleared.get(key);
        if (!prev || prev.ht !== ht.T) {
          const c = { ...b.T, tiles: b.T.tiles.slice() };
          for (let i = 0; i < c.tiles.length; i += 4) if (ht.T.tiles[i]) { c.tiles[i] = 0; c.tiles[i + 1] = 0; }
          cleared.set(key, { ht: ht.T, c });
        }
        b.T = cleared.get(key).c;
      }
    }
    return out;
  }
  return { W, H, has, layers };
}
// Thin hook is only there for a hook tileset that can't draw 1 tile thick blocks
const visible = (d, key) => key !== 'hookfix' || (!!d.hook && d.hook.on && !!TILESETS[d.hook.ts].thin);
const layerName = (k, ts, i) => (TILESETS[ts].layers[i].name ? k.label + ' ' + TILESETS[ts].layers[i].name : k.label);

// the "Design" group of the built layers; adds the images it needs to the map (image objects from mapImage, or copies)
// reuse: layers made before, by tiles + name + image (the preview: an unchanged layer is not uploaded to the GPU again)
async function designGroup(map, built, W, H, copy = false, reuse = null) {
  const grp = newGroup('Design');
  for (const b of built) {
    let ii = -1;
    const im = b.img && (await mapImage(b.img, copy));
    if (im) {
      ii = map.images.findIndex((i) => i.name === im.name);
      if (ii < 0) { map.images.push(copy ? { ...im } : im); ii = map.images.length - 1; }
    }
    if (reuse) {
      let byName = reuse.get(b.T);
      if (!byName) reuse.set(b.T, (byName = new Map()));
      const k = b.name + '|' + ii, old = byName.get(k);
      if (old) { old.color = [...b.color]; grp.layers.push(old); continue; }
      byName.set(k, null);
    }
    const L = newTileLayer('tiles', W, H, b.name);
    L.image = ii;
    L.color = [...b.color];
    L.tiles.set(b.T.tiles);
    if (b.index >= 0) L.automapper = { config: b.index, seed: SEED, flags: 0 };
    if (reuse) reuse.get(b.T).set(b.name + '|' + ii, L);
    grp.layers.push(L);
  }
  return grp;
}

// ---------------------------------------------------------------- preview

// The player's map for the preview: its BG group(s) and the game group with only the game layer (not drawn, it only
// places the camera), then the Design group.
// (no group called BG / Background: the quad-only groups before the game group, like DDNet's first group)
const isBg = (g) => /^\s*(bg|background)\b/i.test(g.name || '');
function stageOf(map) {
  const g0 = findGameLayer(map), gi = map.groups.indexOf(g0.group);
  let groups = map.groups.filter((g) => g !== g0.group && isBg(g));
  if (!groups.length) groups = map.groups.slice(0, gi).filter((g) => g.layers.length && g.layers.every((l) => l.type === 'quads'));
  return { ...map, images: [...map.images], groups: [...groups, { ...g0.group, layers: [g0.layer] }] };
}

// where the camera starts: the first spawn (192, then the team spawns 193, 194), else the middle of the map
function spawnOf(game) {
  for (const id of [192, 193, 194]) {
    for (let i = 0; i < game.width * game.height; i++) if (game.tiles[i * 4] === id) return [(i % game.width + 0.5) * TILE, (Math.floor(i / game.width) + 0.5) * TILE];
  }
  return [game.width * TILE / 2, game.height * TILE / 2];
}

// a small view on the editor's own renderer (render.js): wheel zooms, the middle mouse button moves
function mountViewer(box, start) {
  const canvas = h('canvas', { class: 'dz-gl' });
  box.append(canvas);
  const r = new Renderer(canvas);
  const opts = { background: [0.29, 0.42, 0.56, 1], parallax: true, parallaxZoom: true, clip: true, showEntities: false, entitiesAlpha: 1, time: 0 };
  const cam = { x: start[0], y: start[1], zoom: 0 };
  let map = null, raf = 0;
  const W = () => box.clientWidth || 1, H = () => box.clientHeight || 1;
  const size = () => { const g = map && findGameLayer(map).layer; return g ? [g.width * TILE, g.height * TILE] : [1, 1]; };
  // zoom: from the whole map (and a bit more) to 4 screen pixels per map pixel; the centre stays over the map
  const clamp = () => {
    const [mw, mh] = size(), fit = Math.min(W() / mw, H() / mh);
    if (!cam.zoom) cam.zoom = Math.max(fit, W() / (44 * TILE)); // about 44 tiles across around the spawn
    cam.zoom = Math.max(Math.min(fit / 1.5, 1), Math.min(4, cam.zoom));
    cam.x = Math.max(0, Math.min(mw, cam.x));
    cam.y = Math.max(0, Math.min(mh, cam.y));
  };
  const draw = () => {
    if (raf) return;
    raf = requestAnimationFrame(() => { raf = 0; if (!map) return; clamp(); r.draw(map, cam, opts); });
  };
  r.onTextureLoaded = draw;
  new ResizeObserver(draw).observe(box);
  box.addEventListener('wheel', (e) => {
    e.preventDefault();
    if (!map) return;
    const b = box.getBoundingClientRect(), sx = e.clientX - b.left - W() / 2, sy = e.clientY - b.top - H() / 2;
    const wx = cam.x + sx / cam.zoom, wy = cam.y + sy / cam.zoom;
    cam.zoom *= Math.pow(1.0015, -e.deltaY);
    clamp();
    cam.x = wx - sx / cam.zoom; cam.y = wy - sy / cam.zoom;
    draw();
  }, { passive: false });
  box.addEventListener('mousedown', (e) => {
    if (e.button !== 1) return;
    e.preventDefault();
    let lx = e.clientX, ly = e.clientY;
    box.classList.add('drag');
    const move = (ev) => { cam.x -= (ev.clientX - lx) / cam.zoom; cam.y -= (ev.clientY - ly) / cam.zoom; lx = ev.clientX; ly = ev.clientY; draw(); };
    const up = () => { box.classList.remove('drag'); removeEventListener('mousemove', move); removeEventListener('mouseup', up); };
    addEventListener('mousemove', move); addEventListener('mouseup', up);
  });
  box.addEventListener('auxclick', (e) => { if (e.button === 1) e.preventDefault(); });
  return {
    show(m) { map = m; draw(); }, // the camera stays where it is
    // set the colours of the Design group's layers by name
    recolor(by) {
      const g = map && map.groups.find((x) => x.name === 'Design');
      if (g) for (const L of g.layers) if (by[L.name]) L.color = [...by[L.name]];
      draw();
    },
    close() { const x = r.gl.getExtension('WEBGL_lose_context'); if (x) x.loseContext(); },
  };
}

// ---------------------------------------------------------------- apply

async function applyDesign(ed, dz, d, name, mode) {
  const game = findGameLayer(ed.map);
  const built = await dz.layers(d);
  if (!built.length) { ed.status('Design it!: nothing to draw'); return false; }
  const need = new Set(built.filter((b) => b.img && !ed.map.images.some((i) => i.name === b.img)).map((b) => b.img));
  if (ed.map.images.length + need.size > 64) { ed.status('Design it!: a map can hold at most 64 images'); return false; }
  const gi0 = ed.map.groups.indexOf(game.group);
  const imgs = [...ed.map.images];
  const tmp = { images: imgs };
  const grp = await designGroup(tmp, built, dz.W, dz.H, true);
  ed.editStructure(`Design it! (${name})`, () => {
    if (mode === 'replace') ed.map.groups.splice(gi0 + 1, 1);
    ed.map.images.splice(0, ed.map.images.length, ...imgs);
    ed.map.groups.splice(gi0 + 1, 0, grp);
    ed.sel = { g: gi0 + 1, l: grp.layers.length - 1 };
  });
  ed.status(`Design it!: ${name}, ${built.length} layers`);
  return true;
}

// "Replace / Add another / Cancel" when there is a Design group above Game already
function askMode(ed, game) {
  const next = ed.map.groups[ed.map.groups.indexOf(game.group) + 1];
  if (!next || !/^Design/.test(next.name)) return Promise.resolve('add');
  return new Promise((res) => {
    let done = false;
    const m = modal('Design group exists', h('div', { style: { maxWidth: '380px' } }, 'There is already a Design group above Game. Replace it or add one more?'), [
      ['Cancel', () => { done = true; res(null); }],
      ['Add another', () => { done = true; res('add'); }],
      ['Replace', () => { done = true; res('replace'); }, 'accent'],
    ]);
    const obs = new MutationObserver(() => { if (!m.box.isConnected) { obs.disconnect(); if (!done) res(null); } });
    obs.observe(document.getElementById('modal-root'), { childList: true });
  });
}

// ---------------------------------------------------------------- window

export async function openDesign(ed) {
  const game = findGameLayer(ed.map);
  if (!game) { ed.status('Design it!: the map has no Game layer'); return; }
  for (const ts of Object.keys(TILESETS)) if (!TILESETS[ts].plain) SECS[ts] = await rulesSections(ts);
  const dz = designer(ed.map);
  const stage = stageOf(ed.map);
  // every tileset image in the preview map from the start, so a layer keeps its image index between rebuilds
  for (const T of Object.values(TILESETS)) for (const L of T.layers) {
    const im = L.img && (await mapImage(L.img));
    if (im && !stage.images.includes(im)) stage.images.push(im);
  }
  const reuse = new WeakMap();
  const kinds = KINDS.filter((k) => dz.has[k.key]);

  // the design: per kind { on, ts, base, mods, colors }, filled in by a preset
  let d = {}, preset = 0;
  const load = (i) => {
    preset = i;
    d = Object.fromEntries(KINDS.map((k) => {
      const p = PRESETS[i].kinds[k.key];
      const ts = p ? p.ts : CHOICES[k.key][0];
      return [k.key, { on: !!p, ...kindSettings(k, ts, p || {}, p && p.colors) }];
    }));
  };

  // ---- Presets (left)
  const cards = PRESETS.map((t, i) => h('button', { class: 'dz-card', onclick: () => { load(i); paint(); refresh(); } },
    h('div', { class: 'dz-pic' }, h('img', { src: t.card, alt: '', draggable: 'false', onerror: (e) => { e.target.remove(); } })),
    h('div', { class: 'dz-name' }, t.name)));
  const presets = h('div', { class: 'dz-presets' }, h('div', { class: 'dz-h' }, 'Presets'), h('div', { class: 'dz-cards' }, ...cards));

  // ---- preview (middle)
  const big = h('div', { class: 'dz-big', title: 'Wheel: zoom, middle mouse: move' });
  const viewer = mountViewer(big, spawnOf(game.layer));
  const spin = h('div', { class: 'dz-spin' }, h('i'), h('span', {}, 'Generating preview of your map...'));
  let token = 0;
  async function refresh() {
    const my = ++token;
    big.append(spin);
    let built;
    try { built = await dz.layers(d); } catch (e) { if (my === token) { spin.remove(); ed.status('Design it!: ' + e.message); } return; }
    if (my !== token) return;
    const m = { ...stage, images: [...stage.images], groups: [...stage.groups] };
    m.groups.push(await designGroup(m, built, dz.W, dz.H, false, reuse));
    if (my !== token) return;
    viewer.show(m);
    spin.remove();
  }
  const recolor = () => {
    const by = {};
    for (const k of KINDS) { const s = d[k.key]; s.colors.forEach((c, i) => { by[layerName(k, s.ts, i)] = c; }); }
    viewer.recolor(by);
  };

  // ---- settings (right): one block per kind on the map, top layer first
  const list = h('div', { class: 'dz-list' });
  function block(k) {
    const s = d[k.key], T = TILESETS[s.ts];
    const change = () => { paint(); refresh(); };
    const on = check(s.on, (v) => { s.on = v; change(); });
    const sws = h('span', { class: 'dz-sws' }, ...s.colors.map((c, i) => {
      const b = rgba(c, (v) => { s.colors[i] = v; recolor(); })[0];
      b.classList.add('dz-sw');
      return b;
    }));
    const head = h('div', { class: 'dz-bhead' }, on, h('span', { class: 'dz-kind' }, k.label), sws);
    const blk = h('div', { class: 'dz-block' + (s.on ? '' : ' off') }, head);
    if (!s.on) return blk;
    const row = (label, ctl) => h('div', { class: 'dz-opt' }, h('span', {}, label), ctl);
    const tsOpts = CHOICES[k.key].map((x) => [x, TILESETS[x].label]);
    // a new tileset takes the colours a preset gives this kind with that tileset (meadow's dark ground colour on flat
    // amazing_freeze blocks would look like an empty background), else keeps the current ones
    const tsCtl = select(tsOpts, s.ts, (v) => {
      const from = PRESETS.map((t) => t.kinds[k.key]).find((p) => p && p.ts === v);
      d[k.key] = { on: true, ...kindSettings(k, v, {}, from ? from.colors : s.colors) };
      change();
    });
    if (tsOpts.length < 2) tsCtl.disabled = true;
    blk.append(row('Tileset', tsCtl));
    const sec = SECS[s.ts] || {};
    if (typeof s.base === 'number' && !T.base.fixed && (sec[T.base.section] || []).length > 1) {
      blk.append(row('Style', select(sec[T.base.section].map(([i, n]) => [String(i), n]), String(s.base), (v) => { s.base = Number(v); change(); })));
    }
    for (const m of T.mods) {
      if (!sec[m.section]) continue;
      const opts = [['off', 'Off'], ...sec[m.section].map(([i, n]) => [String(i), n])];
      blk.append(row(m.label, select(opts, s.mods[m.section] == null ? 'off' : String(s.mods[m.section]), (v) => { s.mods[m.section] = v === 'off' ? null : Number(v); change(); })));
    }
    return blk;
  }
  function paint() {
    cards.forEach((c, j) => c.classList.toggle('on', j === preset));
    const shown = [...kinds].reverse().filter((k) => visible(d, k.key));
    list.replaceChildren(...(shown.length ? shown.map(block) : [h('div', { class: 'dz-empty' }, 'The map has no hook, freeze, death, tele or tune tiles.')]));
  }

  const apply = btn('Apply', async () => {
    const mode = await askMode(ed, game);
    if (!mode) return;
    apply.disabled = true;
    try { if (await applyDesign(ed, dz, d, PRESETS[preset].name, mode)) m.close(); }
    catch (e) { ed.status('Design it!: ' + e.message); }
    finally { apply.disabled = false; }
  }, { class: 'accent dz-apply' });
  if (!kinds.length) apply.disabled = true;

  const panel = h('div', { class: 'dz-panel' }, h('div', { class: 'dz-h' }, 'Customize'), list, h('div', { class: 'dz-foot' }, apply));
  const body = h('div', { class: 'dz' }, presets, big, panel);
  const m = modal('Design it!', body);
  const obs = new MutationObserver(() => { if (!m.box.isConnected) { obs.disconnect(); viewer.close(); } });
  obs.observe(document.getElementById('modal-root'), { childList: true, subtree: true });
  m.box.classList.add('dz-modal');
  load(0);
  paint();
  refresh();
}

// plugs Design it! into the editor: the big button on top of the Game layer's sheet (right click on the Game layer)
export function setup(ed) {
  ed.ext.layerActions.push((L) => (L.kind !== 'game' ? null : h('button', {
    class: 'design-it', title: 'Draw the map with a standard tileset: one automapped layer for each kind of tile, in a new group above Game.',
    onclick: () => { closePopup(); openDesign(ed); },
  }, iconEl('sparkles', 16), h('span', {}, 'Design it!'))));
}
