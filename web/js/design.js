// Module "design". "Design it!": a gallery of ready-made presets, with variants chosen inside the preset. A preset says which mapres + automapper
// config draws each kind of entity (hook, unhook, freeze, ...). Applying it adds a "Design" group right after the Game
// group with one automapped tile layer per kind that the map uses (freeze at the bottom, hook on top).
import { h, modal, btn, check, select, closePopup } from './ui.js';
import { iconEl } from './icons.js';
import { newGroup, newTileLayer, findGameLayer, loadMap, TILE_BYTES } from './map.js';
import { loadRules, runAutomapper } from './automapper.js';
import { loadImage, Renderer } from './render.js';

const TILE = 32;
const FREEZE_ALPHA = 100;

// bottom -> top. src: which physics layer the kind is read from; ids: tile indices (null = any non-empty)
const KINDS = [
  { key: 'freeze', label: 'Freeze', src: 'game', ids: [9, 12] },
  { key: 'unfreeze', label: 'Unfreeze', src: 'game', ids: [11, 13] },
  { key: 'death', label: 'Death', src: 'game', ids: [2] },
  { key: 'tune', label: 'Tune', src: 'tune', ids: null },
  { key: 'tele', label: 'Tele', src: 'tele', ids: null },
  { key: 'unhook', label: 'Unhook', src: 'game', ids: [3] },
  { key: 'hook', label: 'Hook', src: 'game', ids: [1] },
];

// A pick says how one kind is drawn: image + config(s), the colour of the layer, and what the layer holds before
// the rules run: "game" = a copy of the whole game layer (amazing_freeze reads hook around the freeze),
// a number = that tile wherever the kind is (default 1, or the fill tile the config keeps).
// cfg can be a list: the configs are run one after another (amazing_freeze: base, then inside and outside corners).
const WHITE = [255, 255, 255, 255];
const EMBED = new Set(['amazing_freeze']); // not in DDNet's mapres: embedded so the map works anywhere
const pick = (img, cfg, color = WHITE, input) => ({ img, cfg, color, input });
const AF = 'amazing_freeze';
const DEATH = { plain: true, color: [255, 0, 0, 255], img: null, cfg: 'plain red tiles' };
const UNHOOKS = ['Random Silver', 'Random Gold', 'Random Bronze', 'Silver/Gold-Mix', 'Copper/Silver-Mix', 'Gold/Copper-Mix', 'Mix All'];
const SEED = 1; // fixed, so the result is what the preview shows

// Ready-made presets: the settings below and a picture (web/presets/<file>.png) for the gallery card. The big
// preview draws the preset on the shared platform map. The kinds are drawn as the preset says; inside a preset the user
// picks the hook config, the unhook config and the inside / outside corners of the amazing_freeze freeze.
const PRESETS = [
  {
    name: 'Grass', file: 'grass', drawn: true,
    hook: { img: 'grass_main', cfgs: ['Default', 'Grass', 'Dirt', 'Cave'] },
    freeze: { base: ' Uneven Tiles ⌇', inside: '> Soft S', outside: '< Soft M', color: [0, 0, 0, FREEZE_ALPHA] },
    unhook: 'Random Silver',
  },
];
// Learned styles (tools/tilestyle.py, folders in styles/): every design layer of a finished map, redrawn by
// editor.py from tables of "what was around -> which tile". Listed after the built-in presets.
async function stylePresets() {
  try {
    const r = await fetch('/api/styles');
    const list = r.ok ? await r.json() : [];
    return list.map((s) => ({ name: s.title || s.name || s.id, style: s.id, layers: s.layers, images: s.images,
      card: s.card ? '/styles/' + encodeURIComponent(s.id) + '/card.png' : null }));
  } catch { return []; }
}

// the style's layers for a map: editor.py gets the game (and front) tile indices and answers index + flags per layer
async function buildStyleLayers(map, t, enabled) {
  const game = findGameLayer(map).layer, W = game.width, H = game.height, n = W * H;
  const front = physicsLayer(map, 'front');
  const body = new Uint8Array(8 + 2 * n);
  new DataView(body.buffer).setInt32(0, W, true);
  new DataView(body.buffer).setInt32(4, H, true);
  for (let i = 0; i < n; i++) body[8 + i] = game.tiles[i * 4];
  if (front && front.width === W && front.height === H) for (let i = 0; i < n; i++) body[8 + n + i] = front.tiles[i * 4];
  const r = await fetch('/api/style?name=' + encodeURIComponent(t.style), { method: 'POST', body });
  if (!r.ok) {
    let msg = 'HTTP ' + r.status;
    try { msg = (await r.json()).error || msg; } catch { /* not json */ }
    throw new Error(msg);
  }
  const out = new Uint8Array(await r.arrayBuffer());
  const built = [];
  let li = 0; // learned layers come back in the style's order; automapper layers are made here
  for (const L of t.layers) {
    const learned = !L.rules, slot = learned ? li++ : -1;
    if (enabled && enabled['style:' + L.name] === false) continue;
    const T = { width: W, height: H, tiles: new Uint8Array(n * 4) };
    let index = -1;
    if (learned) {
      for (let i = 0; i < n; i++) { T.tiles[i * 4] = out[slot * n * 2 + i * 2]; T.tiles[i * 4 + 1] = out[slot * n * 2 + i * 2 + 1]; }
    } else {
      // automapper on a mask of the map: solid = hook + unhook, through = hookthrough (front 5); "not ..." = the rest
      const not = L.rules.mask.startsWith('not '), what = not ? L.rules.mask.slice(4) : L.rules.mask;
      const inMask = (i) => (what === 'through' ? (front ? front.tiles[i * 4] === 5 : false) : game.tiles[i * 4] === 1 || game.tiles[i * 4] === 3) !== not;
      for (let i = 0; i < n; i++) if (inMask(i)) T.tiles[i * 4] = 1;
      const c = await configOf(L.image, L.rules.config);
      if (c) {
        runAutomapper(T, null, c.conf, SEED, -1);
        index = c.index;
        for (let i = 0; i < n; i++) if (!inMask(i)) { T.tiles[i * 4] = 0; T.tiles[i * 4 + 1] = 0; }
      }
    }
    built.push({ k: { label: L.name }, p: { color: L.color }, T, index, im: await styleImage(t, L.image), seed: SEED, W, H });
  }
  return built;
}

// a style's tileset: its PNG from the style folder, embedded in the map; external ones stay a name
const styleImages = new Map();
function styleImage(t, name) {
  const info = (t.images || {})[name] || { external: true, width: 1024, height: 1024 };
  if (info.external) return Promise.resolve({ name, width: info.width, height: info.height, rgba: null });
  const key = t.style + '/' + info.file;
  if (!styleImages.has(key)) {
    styleImages.set(key, loadImage('/styles/' + encodeURIComponent(t.style) + '/' + encodeURIComponent(info.file)).then((im) => {
      const c = document.createElement('canvas');
      c.width = im.width; c.height = im.height;
      const g = c.getContext('2d');
      g.drawImage(im, 0, 0);
      return { name, width: im.width, height: im.height, rgba: new Uint8Array(g.getImageData(0, 0, c.width, c.height).data.buffer) };
    }));
  }
  return styleImages.get(key);
}

// amazing_freeze's corner configs, read from its rules: "> Round" = inside, "< Round" = outside
let CORNERS = { inside: [], outside: [] };
async function loadCorners() {
  const confs = await loadRules(AF);
  const of = (c) => confs.map((x) => x.name).filter((n) => n.startsWith(c + ' ')).map((n) => [n, n.slice(2)]);
  CORNERS = { inside: of('>'), outside: of('<') };
}
const defaultChoice = (t) => (t.style ? {} : { hook: t.hook.cfgs[0], unhook: t.unhook, inside: t.freeze.inside, outside: t.freeze.outside });
const isDefault = (t, ch) => Object.entries(defaultChoice(t)).every(([k, v]) => ch[k] === v);

// preset + chosen variants -> how each kind is drawn
function resolve(t, ch) {
  if (t.style) return { name: t.name, style: t.style, layers: t.layers, images: t.images };
  const chain = [t.freeze.base, ch.inside, ch.outside];
  const same = (color) => pick(AF, chain, color, 9);
  return {
    name: t.name,
    hook: pick(t.hook.img, ch.hook),
    unhook: pick('generic_unhookable', ch.unhook),
    death: DEATH,
    freeze: pick(AF, chain, t.freeze.color, 'game'),
    unfreeze: same([140, 255, 160, 120]),
    tele: same([90, 170, 255, 150]),
    tune: same([190, 120, 255, 120]),
  };
}

// The preset map for the preview, grown by PAD tiles on every side: each layer of the game group repeats its edge
// tiles outwards, so the preview has no hard border when zoomed out. core = where the real map is, in tiles.
const PAD = 80;
function padLayer(L, pad) {
  const B = TILE_BYTES[L.kind], w = L.width, hh = L.height, W = w + 2 * pad, H = hh + 2 * pad;
  const out = { ...L, width: W, height: H, tiles: new Uint8Array(W * H * B) };
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const sx = Math.max(0, Math.min(w - 1, x - pad)), sy = Math.max(0, Math.min(hh - 1, y - pad));
    out.tiles.set(L.tiles.subarray((sy * w + sx) * B, (sy * w + sx + 1) * B), (y * W + x) * B);
  }
  return out;
}
function padMap(map, pad) {
  const g0 = findGameLayer(map), G = g0.layer;
  const layers = g0.group.layers.filter((l) => l.type === 'tiles' && l.width === G.width && l.height === G.height).map((l) => padLayer(l, pad));
  return { ...map, groups: [{ ...g0.group, layers }], core: { x: pad, y: pad, w: G.width, h: G.height } };
}

// one map is the stage of every preset's preview: web/presets/platform.map. Its game layer is what the presets
// draw; its own tile layers are the Grass preset drawn by hand (shown for a preset with drawn: true and no changes)
let platform = null;
function platformMap() {
  if (!platform) platform = fetch('presets/platform.map').then((r) => r.arrayBuffer()).then(loadMap).then((m) => padMap(m, PAD));
  return platform;
}

// ---------------------------------------------------------------- data

const atlasCache = new Map();
function atlas(name) {
  if (!atlasCache.has(name)) atlasCache.set(name, loadImage('/mapres/' + encodeURIComponent(name) + '.png').catch(() => null));
  return atlasCache.get(name);
}

// pixels of a tileset, for images that are not part of DDNet and must be embedded in the map
async function rgbaOf(name) {
  const im = await atlas(name);
  const c = document.createElement('canvas');
  c.width = im.width; c.height = im.height;
  const g = c.getContext('2d');
  g.drawImage(im, 0, 0);
  return new Uint8Array(g.getImageData(0, 0, c.width, c.height).data.buffer);
}

async function configOf(image, name) {
  const confs = await loadRules(image);
  const i = confs.findIndex((c) => c.name === name);
  return i >= 0 ? { index: i, conf: confs[i] } : null;
}

function physicsLayer(map, kind) {
  for (const g of map.groups) for (const l of g.layers) if (l.kind === kind) return l;
  return null;
}

// a game-layer-like grid (4 bytes a tile) with index 1 where the map has this kind, in the window x0,y0,w,h.
// raw: copy the game layer as it is instead
function sourceGrid(map, kind, x0, y0, w, hgt, raw = false) {
  const L = physicsLayer(map, kind.src);
  const out = { width: w, height: hgt, tiles: new Uint8Array(w * hgt * 4), count: 0 };
  if (!L) return out;
  const stride = kind.src === 'game' ? 4 : 2, at = kind.src === 'game' ? 0 : 1;
  for (let y = 0; y < hgt; y++) for (let x = 0; x < w; x++) {
    const sx = x0 + x, sy = y0 + y;
    if (sx >= L.width || sy >= L.height) continue;
    const v = L.tiles[(sy * L.width + sx) * stride + at];
    if (raw) out.tiles[(y * w + x) * 4] = v;
    else if (v && (!kind.ids || kind.ids.includes(v))) { out.tiles[(y * w + x) * 4] = 1; out.count++; }
  }
  return out;
}

function kindsOnMap(map) {
  const game = findGameLayer(map);
  const w = game ? game.layer.width : 0, hh = game ? game.layer.height : 0;
  const has = {};
  for (const k of KINDS) {
    const L = physicsLayer(map, k.src);
    has[k.key] = !!L && sourceGrid(map, k, 0, 0, L.width || w, L.height || hh).count > 0;
  }
  return has;
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

// the tiles of one design layer: automapped from the source grid, or index 1 for plain layers.
// p.cfg may be a list of configs run in order; the layer keeps the last one.
async function buildTiles(map, kind, p, src, seed, win) {
  const T = { width: src.width, height: src.height, tiles: new Uint8Array(src.width * src.height * 4) };
  if (p.plain) { T.tiles.set(src.tiles); return { T, index: -1 }; }
  const names = Array.isArray(p.cfg) ? p.cfg : [p.cfg];
  const cs = (await Promise.all(names.map((n) => configOf(p.img, n)))).filter(Boolean);
  if (!cs.length) { T.tiles.set(src.tiles); return { T, index: -1 }; }
  if (p.input === 'game') T.tiles.set(sourceGrid(map, kind, win.x0, win.y0, win.w, win.h, true).tiles);
  else {
    // the layer starts as the shape of the source and the rules run on it, like a hand-drawn layer in DDNet.
    // Some rules first clear every tile that is not one of their own "fill" tiles, so draw with one of those.
    const fill = p.input || fillTile(cs[0].conf);
    for (let i = 0; i < src.tiles.length; i += 4) T.tiles[i] = src.tiles[i] ? fill : 0;
  }
  for (const c of cs) runAutomapper(T, null, c.conf, seed, -1);
  // keep the layer to where the kind is; a copy of the game layer is left as the rules made it, since
  // amazing_freeze also fills the hook tiles next to freeze (the freeze goes on under the hook's rounded edges)
  if (p.input !== 'game') for (let i = 0; i < src.tiles.length; i += 4) if (!src.tiles[i]) { T.tiles[i] = 0; T.tiles[i + 1] = 0; }
  return { T, index: cs[cs.length - 1].index };
}

// ---------------------------------------------------------------- preview

// The big preview is a small view on the editor's own renderer (render.js), showing the preset map: as it is, or
// with its drawing replaced by the Design group the chosen variants make. The preset map is padded by repeating its edge tiles.
function previewOf(pm, built) {
  const g0 = findGameLayer(pm);
  if (!built) return pm;
  const map = { ...pm, images: [], groups: [{ ...g0.group, layers: [g0.layer] }] };
  map.groups.push(designGroup(map, built));
  return map;
}

function mountViewer(box) {
  const canvas = h('canvas', { class: 'dz-gl' });
  box.append(canvas);
  const r = new Renderer(canvas);
  const opts = { background: [0.29, 0.42, 0.56, 1], parallax: true, parallaxZoom: false, clip: true, showEntities: false, entitiesAlpha: 1, time: 0 };
  const cam = { x: 0, y: 0, zoom: 1 };
  let map = null, fit = 1, raf = 0;
  const W = () => box.clientWidth || 1, H = () => box.clientHeight || 1;
  const size = () => { const g = map && findGameLayer(map).layer; return g ? [g.width * TILE, g.height * TILE] : [1, 1]; };
  const core = () => { const c = map.core; return c ? [c.x * TILE, c.y * TILE, c.w * TILE, c.h * TILE] : [0, 0, ...size()]; };
  // zoom: from 4 times smaller than "whole map" to 12 times closer. The centre stays over the real map and the
  // view inside the padded map, so the edge is never seen.
  const clamp = () => {
    const [mw, mh] = size(), [cx, cy, cw, ch] = core();
    fit = Math.min(W() / cw, H() / ch);
    cam.zoom = Math.max(fit / 4, W() / mw, H() / mh, Math.min(fit * 12, cam.zoom));
    const hw = W() / 2 / cam.zoom, hh = H() / 2 / cam.zoom;
    cam.x = Math.max(hw, Math.min(mw - hw, Math.max(cx, Math.min(cx + cw, cam.x))));
    cam.y = Math.max(hh, Math.min(mh - hh, Math.max(cy, Math.min(cy + ch, cam.y))));
  };
  const draw = () => {
    if (raf) return;
    raf = requestAnimationFrame(() => { raf = 0; if (!map) return; clamp(); r.draw(map, cam, opts); });
  };
  r.onTextureLoaded = draw;
  new ResizeObserver(draw).observe(box);
  box.addEventListener('wheel', (e) => {
    e.preventDefault();
    const b = box.getBoundingClientRect(), sx = e.clientX - b.left - W() / 2, sy = e.clientY - b.top - H() / 2;
    const wx = cam.x + sx / cam.zoom, wy = cam.y + sy / cam.zoom;
    if (!map) return;
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
    // a new map keeps the camera when it is the same size (switching variants), else shows the whole map
    show(m) {
      const first = !map;
      map = m;
      if (first) { const [cx, cy, cw, ch] = core(); cam.x = cx + cw / 2; cam.y = cy + ch / 2; cam.zoom = Math.min(W() / cw, H() / ch); }
      draw();
    },
    close() { const x = r.gl.getExtension('WEBGL_lose_context'); if (x) x.loseContext(); },
  };
}

// ---------------------------------------------------------------- apply

// the design layers of a map: one per kind that the map has and that is turned on
async function buildLayers(map, theme, seed, enabled) {
  if (theme.style) return buildStyleLayers(map, theme, enabled);
  const game = findGameLayer(map);
  const W = game.layer.width, H = game.layer.height;
  const built = [];
  for (const k of KINDS) {
    if (!enabled[k.key]) continue;
    const src = sourceGrid(map, k, 0, 0, W, H);
    if (!src.count) continue;
    const p = theme[k.key];
    const { T, index } = await buildTiles(map, k, p, src, seed, { x0: 0, y0: 0, w: W, h: H });
    let im = null;
    if (index >= 0) {
      const a = await atlas(p.img);
      if (a) im = { name: p.img, width: a.width, height: a.height, rgba: EMBED.has(p.img) ? await rgbaOf(p.img) : null };
    }
    built.push({ k, p, T, index, im, seed, W, H });
  }
  return built;
}

// the "Design" group of the built layers; adds the images it needs to the map
function designGroup(map, built) {
  const grp = newGroup('Design');
  for (const b of built) {
    let ii = -1;
    if (b.im) {
      ii = map.images.findIndex((i) => i.name === b.im.name);
      if (ii < 0) { map.images.push({ name: b.im.name, width: b.im.width, height: b.im.height, external: !b.im.rgba, rgba: b.im.rgba }); ii = map.images.length - 1; }
    }
    const L = newTileLayer('tiles', b.W, b.H, b.k.label);
    L.image = ii;
    L.color = [...b.p.color];
    L.tiles.set(b.T.tiles);
    if (b.index >= 0) L.automapper = { config: b.index, seed: b.seed, flags: 0 };
    grp.layers.push(L);
  }
  return grp;
}

async function applyTheme(ed, theme, seed, enabled, mode) {
  const game = findGameLayer(ed.map);
  const built = await buildLayers(ed.map, theme, seed, enabled);
  if (!built.length) { ed.status('Design it!: the map has no hook, unhook, freeze, death, tele or tune tiles'); return false; }
  const need = new Set(built.filter((b) => b.im && !ed.map.images.some((i) => i.name === b.im.name)).map((b) => b.im.name));
  const gi0 = ed.map.groups.indexOf(game.group);
  const old = mode === 'replace' ? gi0 + 1 : -1;
  if (ed.map.images.length + need.size > 64) { ed.status('Design it!: a map can hold at most 64 images'); return false; }
  ed.editStructure(`Design it! (${theme.name})`, () => {
    if (old >= 0) ed.map.groups.splice(old, 1);
    const grp = designGroup(ed.map, built);
    ed.map.groups.splice(gi0 + 1, 0, grp);
    ed.sel = { g: gi0 + 1, l: grp.layers.length - 1 };
  });
  ed.status(`Design it!: ${theme.name}, ${built.length} layers`);
  return true;
}

// ---------------------------------------------------------------- gallery

export async function openDesign(ed) {
  const game = findGameLayer(ed.map);
  if (!game) { ed.status('Design it!: the map has no Game layer'); return; }
  await loadCorners();
  const presets = [...PRESETS, ...(await stylePresets())];
  const has = kindsOnMap(ed.map);
  const st = { theme: 0, choice: presets.map(defaultChoice), picks: [], enabled: Object.fromEntries(KINDS.map((k) => [k.key, has[k.key]])) };
  const grid = h('div', { class: 'dz-grid' });
  const big = h('div', { class: 'dz-big', title: 'Wheel: zoom, middle mouse: move' });
  const viewer = mountViewer(big);
  const spin = h('div', { class: 'dz-spin dz-busy' });
  const rows = h('div', { class: 'dz-rows' });
  const title = h('div', { class: 'dz-title' });
  let token = 0;
  const update = (i) => { st.picks[i] = resolve(presets[i], st.choice[i]); };
  presets.forEach((_, i) => update(i));
  const picture = (t) => (t.style && !t.card ? h('span', { class: 'dz-one' }, t.name)
    : h('img', { src: t.card || 'presets/' + t.file + '.png', alt: t.name, draggable: 'false' }));
  const hint = h('div', { class: 'dz-hint' });

  const cards = presets.map((t, i) => {
    const card = h('button', { class: 'dz-card', onclick: () => choose(i) }, h('div', { class: 'dz-pic' }, picture(t)), h('div', { class: 'dz-name' }, t.name));
    grid.append(card);
    return { card };
  });

  // the preset map: its own layers as they are, or automapped again with the chosen variants
  async function showBig() {
    const i = st.theme, t = presets[i], my = ++token;
    big.append(spin);
    const pm = await platformMap();
    const all = Object.fromEntries(KINDS.map((k) => [k.key, true]));
    let built;
    try {
      built = t.drawn && isDefault(t, st.choice[i]) ? null : await buildLayers(pm, st.picks[i], SEED, t.style ? st.enabled : all);
    } catch (e) {
      if (my === token) { spin.remove(); ed.status('Design it!: ' + e.message); }
      return;
    }
    if (my !== token) return;
    viewer.show(previewOf(pm, built));
    spin.remove();
  }

  function renderRows() {
    const t = st.picks[st.theme];
    title.textContent = t.name;
    if (t.style) {
      hint.textContent = 'Learned from a finished map: every layer is drawn the way that map draws the same hook, freeze and air around a tile, decoration first, then the freeze that goes with it. Glow layers use the automapper. The tilesets are embedded.';
      rows.replaceChildren(...[...t.layers].reverse().map((L) => {
        const key = 'style:' + L.name;
        const on = check(st.enabled[key] !== false, (v) => { st.enabled[key] = v; showBig(); });
        const col = L.color;
        const sw = h('i', { style: { background: `rgba(${col[0]},${col[1]},${col[2]},${Math.max(0.35, col[3] / 255)})` } });
        return h('div', { class: 'dz-row' }, on, h('span', { class: 'dz-kind' }, L.name), h('div', { class: 'dz-ctl' }, sw, h('span', { class: 'dz-img' }, L.image),
          L.rules ? h('span', { class: 'dz-one' }, L.rules.config) : null));
      }));
      return;
    }
    hint.textContent = 'Preview shows the preset\'s own sample map. Each layer keeps its automapper config and seed, so it can be re-run later from the layer properties.';
    rows.replaceChildren(...[...KINDS].reverse().map((k) => {
      const on = check(st.enabled[k.key], (v) => { st.enabled[k.key] = v; });
      if (!has[k.key]) on.disabled = true;
      const p = t[k.key], col = p.color, ch = st.choice[st.theme], th = presets[st.theme];
      const sw = h('i', { style: { background: `rgba(${col[0]},${col[1]},${col[2]},${Math.max(0.35, col[3] / 255)})` } });
      const set = (key) => (v) => { ch[key] = v; update(st.theme); renderRows(); showBig(); };
      const sel = (opts, key) => (opts.length > 1 ? select(opts, ch[key], set(key)) : h('span', { class: 'dz-one' }, opts[0][1]));
      let what;
      if (k.key === 'hook') what = [h('span', { class: 'dz-img' }, th.hook.img), sel(th.hook.cfgs.map((n) => [n, n]), 'hook')];
      else if (k.key === 'unhook') what = [h('span', { class: 'dz-img' }, 'generic_unhookable'), sel(UNHOOKS.map((n) => [n, n]), 'unhook')];
      else if (k.key === 'freeze') what = [h('span', { class: 'dz-img' }, AF),
        h('span', { class: 'dz-sub', title: 'Inside corners (amazing_freeze)' }, 'Inside', sel(CORNERS.inside, 'inside')),
        h('span', { class: 'dz-sub', title: 'Outside corners (amazing_freeze)' }, 'Outside', sel(CORNERS.outside, 'outside'))];
      else if (k.key === 'death') what = [h('span', { class: 'dz-one' }, p.cfg)];
      else what = [h('span', { class: 'dz-one' }, 'same as freeze, tinted')];
      const ctl = h('div', { class: 'dz-ctl' }, sw, ...what);
      return h('div', { class: 'dz-row' + (has[k.key] ? '' : ' off') + (k.key === 'freeze' ? ' wide' : '') }, on, h('span', { class: 'dz-kind' }, k.label), ctl,
        has[k.key] ? null : h('span', { class: 'dz-none' }, 'not on map'));
    }));
  }

  function choose(i) {
    st.theme = i;
    cards.forEach((c, j) => c.card.classList.toggle('on', j === i));
    renderRows();
    showBig();
  }

  const apply = btn('Apply', async () => {
    const next = ed.map.groups[ed.map.groups.indexOf(game.group) + 1];
    let mode = 'add';
    if (next && /^Design/.test(next.name)) {
      mode = await new Promise((res) => {
        let done = false;
        const m = modal('Design group exists', h('div', { style: { maxWidth: '380px' } }, 'There is already a Design group above Game. Replace it or add one more?'), [
          ['Cancel', () => { done = true; res(null); }],
          ['Add another', () => { done = true; res('add'); }],
          ['Replace', () => { done = true; res('replace'); }, 'accent'],
        ]);
        const obs = new MutationObserver(() => { if (!m.box.isConnected) { obs.disconnect(); if (!done) res(null); } });
        obs.observe(document.getElementById('modal-root'), { childList: true });
      });
      if (!mode) return;
    }
    apply.disabled = true;
    try { if (await applyTheme(ed, st.picks[st.theme], SEED, st.enabled, mode)) m.close(); }
    catch (e) { ed.status('Design it!: ' + e.message); }
    finally { apply.disabled = false; }
  }, { class: 'accent dz-apply' });

  const side = h('div', { class: 'dz-side' }, big, h('div', { class: 'dz-head' }, title), rows,
    hint,
    h('div', { class: 'dz-foot' }, apply));
  const body = h('div', { class: 'dz' }, h('div', { class: 'dz-gal' }, grid), side);
  const m = modal('Design it!', body);
  const obs = new MutationObserver(() => { if (!m.box.isConnected) { obs.disconnect(); viewer.close(); } });
  obs.observe(document.getElementById('modal-root'), { childList: true, subtree: true });
  m.box.classList.add('dz-modal');
  choose(0);
}

// plugs Design it! into the editor: the big button on top of the Game layer's sheet (right click on the Game layer)
export function setup(ed) {
  ed.ext.layerActions.push((L) => (L.kind !== 'game' ? null : h('button', {
    class: 'design-it', title: 'Draw the map with a standard tileset: one automapped layer for each kind of tile, in a new group above Game.',
    onclick: () => { closePopup(); openDesign(ed); },
  }, iconEl('sparkles', 16), h('span', {}, 'Design it!'))));
}
