// Module "rulesmaker". Rules maker: make a DDNet automapper .rules file without writing a line of it.
// "New rules design" opens a ready-made map: its Game layer holds hook, freeze, unhook and hookthrough in every
// neighbourhood a rule needs to know, in one section per kind. The user paints each kind on its own tile layer
// (layer "Hook" on the Hook section, "Freeze" on the Freeze section, ...) with any tileset; ruleslearn.js reads which
// tile was put in which situation and writes the rules. The test cave at the bottom is drawn with the result.
//
// One layer = one kind = one config. The kind comes from the layer name ("Hook", "Hook 2", "Freeze glow"...), so a
// second layer per kind (double layers) only needs a second layer with the same first word.
import { h, btn, check, select, text, modal, confirmBox } from './ui.js';
import { iconEl } from './icons.js';
import { newGroup, newTileLayer, newMap, findGameLayer } from './map.js';
import { parseRules, runAutomapper, loadRules, forgetRules } from './automapper.js';
import { loadImage } from './render.js';
import { Classes, learn, buildRules, writeConfig, blankTiles } from './ruleslearn.js';

const TILE = 32;
const GROUP = 'Rules maker';
const FILE = 'rules_maker.map';
const SEED = 1;
const CH = { '.': 0, '#': 1, u: 3, t: 5, f: 9 };

// the kinds, bottom -> top in the layer list. key: class letter in ruleslearn.js
const KINDS = [
  { key: 'F', name: 'Freeze', ch: 'f', image: 'amazing_freeze', color: [0, 0, 0, 100], symmetry: true },
  { key: 'T', name: 'Hookthrough', ch: 't', image: 'generic_unhookable', color: [255, 220, 150, 255], symmetry: false },
  { key: 'U', name: 'Unhook', ch: 'u', image: 'generic_unhookable', color: [255, 255, 255, 255], symmetry: false },
  { key: 'H', name: 'Hook', ch: '#', image: 'grass_main', color: [255, 255, 255, 255], symmetry: false },
];
const kindOfName = (name) => {
  const w = String(name || '').trim().split(/[\s_:.-]+/)[0].toLowerCase();
  return KINDS.find((k) => k.name.toLowerCase() === w) || null;
};

// ---------------------------------------------------------------- the template map

const g = (s) => s.replace(/^\n/, '').replace(/\n$/, '').split('\n');
const width = (r) => Math.max(...r.map((l) => l.length));
const pad = (r) => r.map((l) => l.padEnd(width(r), '.'));
const recolor = (r, a, b) => r.map((l) => l.split(a).join(b));

// 12x12 patch whose filled cells show all 47 "blob" neighbourhoods (found by search)
const MAZE = g(`
...#...#...#
..###.######
...#..####.#
....###.###.
.##.########
.#####.####.
..###.####.#
...#...##.##
...#..######
.#.##..#.#.#
..#.####.###
.####.##.###
`);
const BLOCK = g(`
########
########
########
########
########
`);
const HOLES = g(`
#########
#.#######
#########
###..####
###..##.#
#########
#########
`);
const BUMPS = g(`
##.###.##
#########
.#######.
#########
###.#.###
`);
const THIN = g(`
######...#
.........#
..#......#
.........#
..###....#
..#.#..###
..###.....
`);
const SLOPE_DOWN = g(`
#.....##....
##.....##...
###.....##..
####.....##.
#####.....##
######......
`);
const SLOPE_UP = g(`
.....#....##
....##...##.
...###..##..
..####.##...
.#######....
######......
`);
// freeze on hook floors, walls and ceilings (the classic gores room)
const ROOM = g(`
##############################
##############################
##ffffff#########fffff########
##..........ffff.........##fff
##.......................##...
##f......................#f...
##f.....................ff....
##f.......##...........f......
###.......##.........fff......
###fff....##.....#############
######ffff##fffff#############
##############################
`);
// another kind next to hook on every side
const MIX = g(`
##########xxxxxxxxx
##########xxxxxxxxx
#####xxxxx#####....
#####xxxxx#####....
xxxxx.....xxxxx....
xxxxx.....xxxxx....
...................
..##xx...xx##..xxx.
..##xx...xx##..###.
`);

// a ring of `fill` around `solid`: the grid padded by 1, every air cell next to solid (8 neighbours) becomes fill
function ring(r, solid, fill) {
  const H = r.length, W = width(r), at = (x, y) => (y >= 0 && y < H && x >= 0 && x < W ? r[y][x] || '.' : '.');
  const out = [];
  for (let y = -1; y <= H; y++) {
    let line = '';
    for (let x = -1; x <= W; x++) {
      const c = at(x, y);
      let near = false;
      for (let dy = -1; dy <= 1 && !near; dy++) for (let dx = -1; dx <= 1; dx++) if (at(x + dx, y + dy) === solid) { near = true; break; }
      line += c === '.' && near ? fill : c;
    }
    out.push(line);
  }
  return out;
}
// the maze's cells on a background of `bg`, 2 cells of background around it
const framed = (r, bg) => {
  const W = width(r), row = bg.repeat(W + 4);
  return [row, row, ...pad(r).map((l) => bg + bg + l.split('.').join(bg) + bg + bg), row, row];
};

// sections: one per kind, each a few rows of labelled blocks
function sections() {
  const shapes = (ch, list) => list.map(([t, r]) => [t, recolor(r, '#', ch)]);
  const base = [['solid', BLOCK], ['holes', HOLES], ['bumps', BUMPS], ['thin', THIN]];
  const slopes = [['slope', SLOPE_DOWN], ['slope', SLOPE_UP]];
  const with_ = (r, ch) => recolor(r, 'x', ch);
  return [
    { kind: 'H', title: 'HOOK: paint layer "Hook" here', rows: [
      base,
      [...slopes, ['47 cases in air', MAZE]],
      [['freeze ring', ring(BUMPS, '#', 'f')], ['freeze ring', ring(SLOPE_DOWN, '#', 'f')], ['hook in freeze', framed(MAZE, 'f')]],
      [['next to unhook', with_(MIX, 'u')], ['next to hookthrough', with_(MIX, 't')]],
    ] },
    { kind: 'F', title: 'FREEZE: paint layer "Freeze" here', rows: [
      shapes('f', base),
      [['47 cases in air', recolor(MAZE, '#', 'f')], ['freeze in hook', framed(recolor(MAZE, '#', 'f'), '#')], ['walls, floor, ceiling', ROOM]],
      [['around hook', ring(BUMPS, '#', 'f')], ['around hook', ring(SLOPE_UP, '#', 'f')],
        ['around unhook', ring(recolor(BUMPS, '#', 'u'), 'u', 'f')], ['around hookthrough', ring(recolor(THIN, '#', 't'), 't', 'f')]],
    ] },
    { kind: 'U', title: 'UNHOOK: paint layer "Unhook" here', rows: [
      shapes('u', [['solid', BLOCK], ['bumps', BUMPS], ['thin', THIN], ['slope', SLOPE_DOWN]]),
      [['47 cases in air', recolor(MAZE, '#', 'u')], ['freeze ring', ring(recolor(BUMPS, '#', 'u'), 'u', 'f')], ['next to hook', with_(MIX, 'u')]],
    ] },
    { kind: 'T', title: 'HOOKTHROUGH: paint layer "Hookthrough" here', rows: [
      shapes('t', [['solid', BLOCK], ['bumps', BUMPS], ['thin', THIN], ['slope', SLOPE_UP]]),
      [['47 cases in air', recolor(MAZE, '#', 't')], ['freeze ring', ring(recolor(THIN, '#', 't'), 't', 'f')], ['next to hook', with_(MIX, 't')]],
    ] },
  ];
}

// a cave with all four kinds, drawn by the generated rules (never learned from)
function testCave(W, H) {
  let s = 12345;
  const rnd = () => { s = (s + 0x6d2b79f5) | 0; let t = Math.imul(s ^ (s >>> 15), 1 | s); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  let c = [];
  for (let y = 0; y < H; y++) { c.push([]); for (let x = 0; x < W; x++) c[y].push(x < 2 || y < 2 || x >= W - 2 || y >= H - 2 || rnd() < 0.46 ? 1 : 0); }
  const n8 = (a, x, y) => { let n = 0; for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) if ((dx || dy) && (a[y + dy]?.[x + dx] ?? 1)) n++; return n; };
  for (let it = 0; it < 5; it++) c = c.map((row, y) => row.map((v, x) => (x < 2 || y < 2 || x >= W - 2 || y >= H - 2 ? 1 : n8(c, x, y) >= 5 ? 1 : n8(c, x, y) <= 3 ? 0 : v)));
  const out = c.map((row) => row.map((v) => (v ? '#' : '.')));
  const third = Math.floor(W / 3);
  // middle third: unhook walls; a few hookthrough platforms in the open
  for (let y = 0; y < H; y++) for (let x = third; x < 2 * third; x++) if (out[y][x] === '#' && y > 1 && y < H - 2) out[y][x] = 'u';
  for (let k = 0; k < 40; k++) {
    const x0 = 2 + Math.floor(rnd() * (W - 12)), y0 = 3 + Math.floor(rnd() * (H - 6)), len = 4 + Math.floor(rnd() * 5);
    let free = true;
    for (let y = y0 - 2; y <= y0 + 2 && free; y++) for (let x = x0 - 1; x <= x0 + len; x++) if (out[y]?.[x] !== '.') { free = false; break; }
    if (free) for (let x = x0; x < x0 + len; x++) out[y0][x] = 't';
  }
  // freeze: a full ring (gores) on the left, puddles on floors everywhere else
  const solid = (v) => v === '#' || v === 'u' || v === 't';
  const ringAt = [];
  for (let y = 1; y < H - 1; y++) for (let x = 1; x < W - 1; x++) {
    if (out[y][x] !== '.') continue;
    let near = false;
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) if (out[y + dy][x + dx] === '#') near = true;
    if (near && x < third) ringAt.push([x, y]);
    else if (x >= third && solid(out[y + 1][x]) && rnd() < 0.35) ringAt.push([x, y]);
  }
  for (const [x, y] of ringAt) out[y][x] = 'f';
  return out.map((r) => r.join(''));
}

const M = 4, BLOCK_GAP = 3, ROW_GAP = 4, SECTION_GAP = 8;
const GRID = [['H', 'F'], ['U', 'T']]; // where the sections go: two side by side, the test cave below
let layoutCache = null;
// where everything is: tile cells, the learning area of each kind, labels for the overlay
function layout() {
  if (layoutCache) return layoutCache;
  // each section on its own first (positions relative to its top left cell)
  const secs = new Map();
  for (const s of sections()) {
    const put = [], labels = [];
    let y = 0, w = 0;
    for (const row of s.rows) {
      let x = 0, hgt = 0;
      for (const [title, r] of row) {
        const p = pad(r);
        put.push([x, y, p]);
        labels.push({ x, y: y - 0.3, text: title, small: true });
        x += width(p) + BLOCK_GAP;
        hgt = Math.max(hgt, p.length);
      }
      w = Math.max(w, x - BLOCK_GAP);
      y += hgt + ROW_GAP;
    }
    secs.set(s.kind, { ...s, put, labels, w, h: y - ROW_GAP });
  }
  const labels = [], areas = {}, boxes = [], put = [];
  const place = (s, x0, y0) => {
    for (const [x, y, p] of s.put) put.push([x0 + x, y0 + y, p]);
    for (const l of s.labels) labels.push({ ...l, x: l.x + x0, y: l.y + y0 });
    const box = [x0 - 2, y0 - 2, x0 + s.w + 2, y0 + s.h + 2];
    areas[s.kind] = box;
    boxes.push({ kind: s.kind, box, title: s.title });
    labels.push({ x: x0 - 2, y: y0 - 2.6, text: s.title, kind: s.kind });
  };
  // columns as wide as their widest section
  const colW = GRID[0].map((_, c) => Math.max(...GRID.map((r) => secs.get(r[c])?.w || 0)));
  let y = M + 2, W = 0;
  for (const row of GRID) {
    let x = M, hgt = 0;
    row.forEach((k, c) => { const s = secs.get(k); place(s, x, y); x += colW[c] + SECTION_GAP; hgt = Math.max(hgt, s.h); });
    W = Math.max(W, x - SECTION_GAP + M);
    y += hgt + SECTION_GAP;
  }
  const caveW = W - 2 * M, caveH = 36;
  put.push([M, y, testCave(caveW, caveH)]);
  const test = [M, y, M + caveW, y + caveH];
  boxes.push({ kind: 'test', box: [M - 2, y - 2, M + caveW + 2, y + caveH + 2], title: 'TEST: drawn by the generated rules (change the Game layer here to try other shapes)' });
  labels.push({ x: M - 2, y: y - 2.6, text: boxes[boxes.length - 1].title, kind: 'test' });
  const H = y + caveH + M;
  const cells = new Uint8Array(W * H);
  for (const [x0, y0, r] of put) r.forEach((line, dy) => [...line].forEach((ch, dx) => { cells[(y0 + dy) * W + x0 + dx] = CH[ch] || 0; }));
  layoutCache = { W, H, cells, areas, test, boxes, labels };
  return layoutCache;
}

// is this map the Rules maker template (its layout is known by its size)?
function makerLayout(map) {
  const gl = findGameLayer(map), L = layout();
  if (!gl || !map.groups.some((gr) => gr.name === GROUP)) return null;
  return gl.layer.width === L.W && gl.layer.height === L.H ? L : null;
}

// the design layers: every tile layer whose name starts with a kind
function designLayers(map) {
  const out = [];
  for (const gr of map.groups) for (const l of gr.layers) if (l.type === 'tiles' && l.kind === 'tiles' && kindOfName(l.name)) out.push({ L: l, kind: kindOfName(l.name), group: gr });
  return out;
}

// ---------------------------------------------------------------- tilesets

let tilesetList = null;
async function tilesets() {
  if (!tilesetList) {
    tilesetList = fetch('/api/rules/tilesets').then((r) => (r.ok ? r.json() : null)).catch(() => null).then((j) => j || {
      ddnet: ['grass_main', 'generic_unhookable', 'jungle_main', 'desert_main', 'winter_main', 'ddnet_tiles', 'ddnet_walls', 'round_tiles', 'basic_freeze', 'ddmax_freeze'],
      extra: ['amazing_freeze'],
    });
  }
  return tilesetList;
}

const pixels = new Map();
async function imageInfo(name, embed) {
  const key = name + (embed ? '#e' : '');
  if (!pixels.has(key)) {
    pixels.set(key, loadImage('/mapres/' + encodeURIComponent(name) + '.png').then((im) => {
      if (!embed) return { name, width: im.width, height: im.height, external: true, rgba: null };
      const c = document.createElement('canvas');
      c.width = im.width; c.height = im.height;
      const g2 = c.getContext('2d');
      g2.drawImage(im, 0, 0);
      return { name, width: im.width, height: im.height, external: false, rgba: new Uint8Array(g2.getImageData(0, 0, c.width, c.height).data.buffer) };
    }).catch(() => ({ name, width: 1024, height: 1024, external: true, rgba: null })));
  }
  return pixels.get(key);
}

// index of the image in the map, added when missing (tilesets that are not part of DDNet are embedded)
async function imageIndex(map, name) {
  const i = map.images.findIndex((im) => im.name === name);
  if (i >= 0) return { index: i, add: null };
  const ts = await tilesets();
  return { index: map.images.length, add: await imageInfo(name, ts.extra.includes(name)) };
}

// ---------------------------------------------------------------- new design map

async function buildTemplate() {
  const Lt = layout();
  const map = newMap(Lt.W, Lt.H);
  const game = map.groups[0].layers[0];
  game.tiles.fill(0);
  for (let i = 0; i < Lt.cells.length; i++) game.tiles[i * 4] = Lt.cells[i];
  const grp = newGroup(GROUP);
  for (const k of KINDS) {
    const { index, add } = await imageIndex(map, k.image);
    if (add) map.images.push(add);
    const L = newTileLayer('tiles', Lt.W, Lt.H, k.name);
    L.image = index;
    L.color = [...k.color];
    grp.layers.push(L);
  }
  map.groups.push(grp);
  map.info.credits = 'Rules maker template (tw-editor)';
  return map;
}

async function openTemplate(ed) {
  if (!(await ed.confirmDiscard())) return;
  const map = await ed.busy('Building the Rules maker map…', buildTemplate);
  ed.fileHandle = null;
  ed.setMap(map, FILE);
  const gi = map.groups.length - 1;
  ed.select(gi, map.groups[gi].layers.length - 1);
  if (!document.querySelector('#tabs [data-tab="rulesmaker"].on')) ed.openTab?.('rulesmaker');
  focusArea(ed, layout().areas.H);
  ed.status('Rules maker: paint each section on its own layer, then press Generate');
}

function focusArea(ed, [x0, y0, x1, y1]) {
  const r = ed.view.getBoundingClientRect();
  ed.cam.x = ((x0 + x1) / 2) * TILE;
  ed.cam.y = ((y0 + y1) / 2) * TILE;
  if (r.width) ed.cam.zoom = Math.max(0.05, Math.min(2, Math.min(r.width / ((x1 - x0) * TILE), (r.height * 0.7) / ((y1 - y0) * TILE)) * 0.92));
  ed.emit('camera');
}

// ---------------------------------------------------------------- per-layer helpers

const prefs = (() => { try { return JSON.parse(localStorage.getItem('twe-rulesmaker') || '{}'); } catch { return {}; } })();
const savePrefs = () => { try { localStorage.setItem('twe-rulesmaker', JSON.stringify(prefs)); } catch { /* ignore */ } };
prefs.name ||= 'My design';
prefs.sym ||= {};
const symOf = (d) => (d.L.name in prefs.sym ? prefs.sym[d.L.name] : d.kind.symmetry);

const gameAt = (game, x, y) => game.tiles[(y * game.width + x) * 4];
const isKind = (C, game, kind, x, y) => C.cls(gameAt(game, x, y)) === kind.key;

// the area of a layer: its section on the template, the whole map elsewhere
function areaOf(map, d) {
  const Lt = makerLayout(map);
  const game = findGameLayer(map).layer;
  return Lt ? Lt.areas[d.kind.key] : [0, 0, game.width, game.height];
}

function editLayers(ed, label, layers, fn) {
  if (!layers.length) return;
  ed.history.edit(ed.map, layers.length > 1 ? 'layers' : 'layer', label, layers.length > 1 ? layers : layers[0], fn);
  for (const l of layers) ed.touch(l);
  ed.emit('history');
}

function stats(map, d, C) {
  const game = findGameLayer(map).layer;
  const [x0, y0, x1, y1] = areaOf(map, d);
  let cells = 0, painted = 0, extra = 0;
  for (let y = Math.max(0, y0); y < Math.min(y1, game.height); y++) for (let x = Math.max(0, x0); x < Math.min(x1, game.width); x++) {
    const on = d.L.tiles[(y * d.L.width + x) * 4] !== 0;
    if (isKind(C, game, d.kind, x, y)) { cells++; if (on) painted++; } else if (on) extra++;
  }
  return { cells, painted, extra };
}

// every empty cell of the layer's kind gets the brush (repeated like a pattern when it is bigger than one tile)
function fillBase(ed, d, C) {
  const b = ed.brush;
  if (!b || b.kind !== 'tiles' || !b.data.some((v, i) => i % 4 === 0 && v)) { ed.status('Rules maker: pick a tile first (hold Space on the layer), then press Fill'); return; }
  const game = findGameLayer(ed.map).layer, [x0, y0, x1, y1] = areaOf(ed.map, d);
  editLayers(ed, `Rules maker: fill ${d.L.name}`, [d.L], () => {
    for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
      if (x < 0 || y < 0 || x >= game.width || y >= game.height || !isKind(C, game, d.kind, x, y)) continue;
      const o = (y * d.L.width + x) * 4;
      if (d.L.tiles[o]) continue;
      const s = ((y % b.h) * b.w + (x % b.w)) * 4;
      if (!b.data[s]) continue;
      d.L.tiles[o] = b.data[s];
      d.L.tiles[o + 1] = b.data[s + 1];
    }
  });
}

function clearArea(ed, d) {
  const [x0, y0, x1, y1] = areaOf(ed.map, d);
  editLayers(ed, `Rules maker: clear ${d.L.name}`, [d.L], () => {
    for (let y = Math.max(0, y0); y < Math.min(y1, d.L.height); y++) for (let x = Math.max(0, x0); x < Math.min(x1, d.L.width); x++) {
      const o = (y * d.L.width + x) * 4;
      d.L.tiles[o] = 0; d.L.tiles[o + 1] = 0;
    }
  });
}

// a config of the layer's image draws the section; the user then changes what they want
async function startFrom(ed, d, C, conf) {
  const game = findGameLayer(ed.map).layer, [x0, y0, x1, y1] = areaOf(ed.map, d);
  const W = x1 - x0, H = y1 - y0, T = { width: W, height: H, tiles: new Uint8Array(W * H * 4) };
  const asGame = ed.map.images[d.L.image]?.name === 'amazing_freeze'; // reads the hook around the freeze
  let fill = 1;
  for (const r of conf.runs[0]?.rules || []) {
    const p = r.id === 0 && r.pos.find((q) => q.x === 0 && q.y === 0 && q.value === 2 && q.list.some((i) => i.id > 0));
    if (p) { fill = p.list.find((i) => i.id > 0).id; break; }
  }
  const inside = (x, y) => x >= 0 && y >= 0 && x < game.width && y < game.height;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    if (!inside(x0 + x, y0 + y)) continue;
    const v = gameAt(game, x0 + x, y0 + y);
    T.tiles[(y * W + x) * 4] = asGame ? v : isKind(C, game, d.kind, x0 + x, y0 + y) ? fill : 0;
  }
  runAutomapper(T, null, conf, SEED, -1);
  editLayers(ed, `Rules maker: ${d.L.name} from "${conf.name}"`, [d.L], () => {
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      if (!inside(x0 + x, y0 + y)) continue;
      const s = (y * W + x) * 4, o = ((y0 + y) * d.L.width + x0 + x) * 4;
      const keep = asGame || isKind(C, game, d.kind, x0 + x, y0 + y);
      d.L.tiles[o] = keep ? T.tiles[s] : 0;
      d.L.tiles[o + 1] = keep ? T.tiles[s + 1] : 0;
    }
  });
}

async function setImage(ed, d, name) {
  const { index, add } = await imageIndex(ed.map, name);
  if (add && ed.map.images.length >= 64) { ed.status('A map can hold at most 64 images'); return; }
  ed.editStructure(`Rules maker: ${d.L.name} image`, () => {
    if (add) ed.map.images.push(add);
    d.L.image = index;
  });
  ed.emit('images');
}

// ---------------------------------------------------------------- generate

let result = null; // { files: Map(image -> [{ name, text }]), layers: [...] }

function generate(ed) {
  const gl = findGameLayer(ed.map);
  if (!gl) { ed.status('Rules maker: the map has no Game layer'); return; }
  const game = gl.layer, C = new Classes(), Lt = makerLayout(ed.map);
  const files = new Map(), done = [];
  for (const d of designLayers(ed.map)) {
    const img = ed.map.images[d.L.image];
    if (!img) { done.push({ d, skip: 'the layer has no image' }); continue; }
    const area = areaOf(ed.map, d);
    const st = stats(ed.map, d, C);
    if (!st.painted && !st.extra) { done.push({ d, skip: 'nothing painted in its section' }); continue; }
    // outside the template the whole map teaches, except the test cave
    const S = learn(game, d.L, C, { symmetry: symOf(d), radius: prefs.radius2 ? 2 : 1, skipUnpainted: true, blank: blankTiles(img), areas: [area] });
    const { rules, mixed } = buildRules(S, C, { minSupport: 1 });
    const list = files.get(img.name) || [];
    let name = prefs.name.trim() || 'My design';
    if (list.some((c) => c.name === name)) name += ' ' + d.L.name;
    const textOut = writeConfig(name, rules, C);
    list.push({ name, text: textOut });
    files.set(img.name, list);
    done.push({ d, image: img.name, name, text: textOut, rules: rules.length, painted: st.painted, cells: st.cells,
      mixed: mixed.map((k) => S.where.get(k)?.[0]).filter(Boolean) });
  }
  result = { files, layers: done };
  // the test cave, drawn by the new configs
  if (Lt) {
    const drawn = done.filter((r) => r.text);
    const [x0, y0, x1, y1] = Lt.test;
    editLayers(ed, 'Rules maker: test cave', drawn.map((r) => r.d.L), () => {
      for (const r of drawn) {
        const conf = parseRules(r.text)[0];
        const L = r.d.L;
        for (let y = y0 - 2; y < y1 + 2; y++) for (let x = x0 - 2; x < x1 + 2; x++) { const o = (y * L.width + x) * 4; L.tiles[o] = 0; L.tiles[o + 1] = 0; }
        runAutomapper(L, game, conf, SEED, 0, [x0, y0, x1 - x0, y1 - y0]);
      }
    });
  }
  const n = done.filter((r) => r.text).length;
  ed.status(n ? `Rules maker: ${n} config${n > 1 ? 's' : ''} made${Lt ? ', the test cave shows them' : ''}` : 'Rules maker: nothing painted yet');
  ed.emit('rulesmaker');
}

const fileText = (configs) => configs.map((c) => c.text.trimEnd() + '\n').join('\n');

function download(image, configs) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([fileText(configs)], { type: 'text/plain' }));
  a.download = image + '.rules';
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}

async function post(url, body) {
  const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  let j = {};
  try { j = await r.json(); } catch { /* not json */ }
  if (!r.ok || j.error) throw new Error(j.error || 'HTTP ' + r.status);
  return j;
}

// into the editor (user-rules/, offered by the automapper of every layer with that image) and, if wanted, into DDNet
async function install(ed, toDdnet) {
  if (!result || !result.files.size) return;
  if (toDdnet && !(await confirmBox('Copy to DDNet',
    h('div', {}, 'The configs are added to DDNet\'s own automapper files in your DDNet folder (',
      h('code', {}, '%APPDATA%\\DDNet\\editor\\automap'), '). The standard configs of those tilesets stay; a config with the same name is replaced.'), 'Copy'))) return;
  try {
    const out = [];
    for (const [image, configs] of result.files) {
      const j = await post('/api/rules/user', { image, configs });
      forgetRules(image);
      if (toDdnet) out.push((await post('/api/rules/ddnet', { image })).path);
    }
    ed.status(toDdnet ? 'Rules maker: copied to ' + out.join(', ') : `Rules maker: installed (${[...result.files.keys()].join(', ')}), pick "${prefs.name}" in a layer's automapper`);
  } catch (e) { ed.status('Rules maker: ' + e.message); }
}

function showText(r) {
  const ta = h('textarea', { class: 'rm-text', readonly: true, spellcheck: 'false' });
  ta.value = r.text;
  modal(`${r.image}.rules: [${r.name}]`, h('div', { class: 'rm-text-box' }, ta), [['Close', () => true]]);
}

// ---------------------------------------------------------------- the tab

function tab(ed, root) {
  root.classList.add('rm-tab');
  const map = ed.map, Lt = makerLayout(map), C = new Classes();
  const layers = designLayers(map);
  if (!Lt && !layers.length) {
    root.append(h('div', { class: 'rm-intro' },
      h('p', {}, 'Make your own automapper rules by painting, without writing them. The Rules maker map has a section for hook, freeze, unhook and hookthrough with every case a rule needs. Paint each section with any tileset on its own layer, press Generate, and the .rules file is written for you.'),
      h('div', { class: 'btns' }, btn([iconEl('sparkles', 14), 'New rules design'], () => openTemplate(ed), { class: 'accent' })),
      h('p', { class: 'hint' }, 'Already painted a design? Open its .map file. Any map works too: a tile layer named Hook, Freeze, Unhook or Hookthrough learns from the whole map.')));
    return;
  }
  const left = h('div', { class: 'rm-layers' });
  const tb = h('table', { class: 'list-table rm-table' });
  tb.append(h('tr', {}, h('th', {}, 'Layer'), h('th', {}, 'Tileset'), h('th', {}, 'Painted'), h('th', { title: 'Mirror / rotate painted cases into the ones you did not paint (good for freeze, not for grass)' }, 'Mirror'), h('th', {}, '')));
  const configsBox = h('span');
  for (const d of layers) {
    const st = stats(map, d, C);
    const img = map.images[d.L.image];
    const imgPick = h('span', {}, img ? img.name : '(none)');
    tilesets().then((ts) => {
      const names = [...new Set([...(img ? [img.name] : []), ...ts.extra, ...(ts.rules || []), ...ts.ddnet])];
      imgPick.replaceWith(select(names.map((n) => [n, n + (ts.extra.includes(n) ? ' (embedded)' : '')]), img ? img.name : '', (v) => setImage(ed, d, v)));
    });
    const startPick = h('span');
    if (img) loadRules(img.name).then((confs) => {
      if (!confs.length) return;
      startPick.append(select([['', 'Start from…'], ...confs.map((c, i) => [i, c.name])], '', (v) => { if (v !== '') startFrom(ed, d, C, confs[+v]); }));
    });
    const sel = ed.layer === d.L;
    tb.append(h('tr', { class: sel ? 'sel' : '' },
      h('td', {}, h('button', { class: 'link', title: 'Select the layer and show its section', onclick: () => {
        ed.select(map.groups.indexOf(d.group), d.group.layers.indexOf(d.L));
        focusArea(ed, areaOf(map, d));
      } }, h('b', {}, d.L.name), Lt ? '' : ' (whole map)')),
      h('td', {}, imgPick),
      h('td', { title: `${st.painted} of the ${st.cells} ${d.kind.name.toLowerCase()} cells in the section are painted` + (st.extra ? `, plus ${st.extra} tiles around them` : '') },
        h('span', { class: 'rm-bar' }, h('i', { style: { width: (st.cells ? (100 * st.painted) / st.cells : 0) + '%' } })), ` ${st.painted}/${st.cells}`),
      h('td', {}, check(symOf(d), (v) => { prefs.sym[d.L.name] = v; savePrefs(); })),
      h('td', { class: 'rm-acts' },
        btn('Fill', () => fillBase(ed, d, C), { title: 'Put the brush on every empty ' + d.kind.name.toLowerCase() + ' cell of the section (a bigger brush repeats as a pattern). Paint the edges after.' }),
        startPick,
        btn('Clear', () => clearArea(ed, d), { title: 'Erase the layer in its section' }))));
  }
  left.append(tb);
  if (Lt) left.append(h('p', { class: 'hint' }, 'Select a layer, hold Space to pick tiles and paint its section: on the cells and around them (grass on top, shadows, freeze under the hook edges). An empty cell means "nothing here". Different tiles in the same situation become random variants. Shapes you leave unpainted are ignored.'));

  const right = h('div', { class: 'rm-out' });
  const nameIn = text(prefs.name, (v) => { prefs.name = v.trim() || 'My design'; savePrefs(); }, { placeholder: 'Config name' });
  right.append(h('div', { class: 'prop' }, h('label', {}, 'Config name'), h('div', { class: 'row' }, nameIn)),
    h('div', { class: 'prop' }, h('label', { title: 'Look two tiles around instead of one: big rounded corners, more rules' }, 'Look 2 tiles away'),
      h('div', { class: 'row' }, check(!!prefs.radius2, (v) => { prefs.radius2 = v; savePrefs(); }))),
    h('div', { class: 'btns' }, btn([iconEl('sparkles', 14), 'Generate'], () => generate(ed), { class: 'accent', title: 'Write the rules from what is painted' + (Lt ? ' and draw the test cave with them' : '') }),
      Lt ? btn('Show test', () => focusArea(ed, Lt.test.map((v, i) => v + (i < 2 ? -2 : 2)))) : null));
  if (result && result.layers.length) {
    const list = h('div', { class: 'rm-results' });
    for (const r of result.layers) {
      if (r.skip) { list.append(h('div', { class: 'hint' }, `${r.d.L.name}: ${r.skip}`)); continue; }
      const warn = r.mixed.length ? h('span', { class: 'rm-warn', title: 'Different tiles were painted in the same situation, so the rules pick one at random there. If that was a slip, fix the tile. Click to see one.' },
        h('button', { class: 'link', onclick: () => { const [x, y] = r.mixed[0]; ed.cam.x = (x + 0.5) * TILE; ed.cam.y = (y + 0.5) * TILE; ed.cam.zoom = Math.max(ed.cam.zoom, 1); ed.emit('camera'); } },
          `${r.mixed.length} random spot${r.mixed.length > 1 ? 's' : ''}`)) : null;
      list.append(h('div', { class: 'rm-res' }, h('b', {}, r.d.L.name), ` → ${r.image}.rules [${r.name}]: ${r.rules} rules `, warn,
        btn('View', () => showText(r), { class: 'small' })));
    }
    right.append(list);
    if (result.files.size) {
      right.append(h('div', { class: 'btns' },
        btn('Download .rules', () => { for (const [im, cs] of result.files) download(im, cs); }, { title: 'One file per tileset. Add its configs to the file of the same name in DDNet\'s editor/automap folder.' }),
        btn('Use in editor', () => install(ed, false), { title: 'Save into tw-editor (user-rules/): the configs show up in the automapper of every layer with that tileset' }),
        btn('Copy to DDNet', () => install(ed, true), { title: 'Also add the configs to the DDNet client (your DDNet folder, editor/automap)' })));
    }
  }
  root.append(h('div', { class: 'rm-cols' }, left, right), configsBox);
}

// ---------------------------------------------------------------- overlay: section frames and names

function overlay(ed, ctx) {
  const Lt = makerLayout(ed.map);
  if (!Lt) return;
  const gl = findGameLayer(ed.map), z = ed.gzoom(gl.group), cur = kindOfName(ed.layer?.name)?.key;
  ctx.save();
  for (const b of Lt.boxes) {
    const [x0, y0] = ed.worldToScreen(b.box[0] * TILE, b.box[1] * TILE, gl.group), [x1, y1] = ed.worldToScreen(b.box[2] * TILE, b.box[3] * TILE, gl.group);
    const on = b.kind === cur;
    ctx.setLineDash(on ? [] : [6, 4]);
    ctx.lineWidth = on ? 2 : 1;
    ctx.strokeStyle = b.kind === 'test' ? 'rgba(120,200,255,.8)' : on ? 'rgba(240,178,50,.95)' : 'rgba(255,255,255,.45)';
    ctx.strokeRect(x0 + 0.5, y0 + 0.5, x1 - x0, y1 - y0);
  }
  ctx.setLineDash([]);
  ctx.textBaseline = 'bottom';
  for (const l of Lt.labels) {
    const size = l.small ? 0.55 * TILE * z : 1.1 * TILE * z;
    if (size < (l.small ? 7 : 6)) continue;
    const [sx, sy] = ed.worldToScreen(l.x * TILE, (l.y + (l.small ? 0 : 1.6)) * TILE, gl.group);
    ctx.font = `${l.small ? '' : 'bold '}${Math.min(size, l.small ? 16 : 30)}px Helvetica, Arial, sans-serif`;
    ctx.fillStyle = l.kind && l.kind === cur ? '#f0b232' : l.kind === 'test' ? '#8fd0ff' : l.small ? 'rgba(255,255,255,.7)' : '#fff';
    ctx.shadowColor = 'rgba(0,0,0,.8)'; ctx.shadowBlur = 3;
    ctx.fillText(l.text, sx, sy);
  }
  ctx.restore();
}

export function setup(ed) {
  ed.commands.rulesmaker = () => openTemplate(ed);
  ed.commands.rulestab = () => ed.openTab?.('rulesmaker');
  ed.ext.tabs.set('rulesmaker', { title: 'Rules maker', render: tab, refreshOn: ['map', 'history', 'selection', 'images', 'rulesmaker'] });
  ed.ext.overlays.push((ctx) => overlay(ed, ctx));
  ed.on('map', () => { if (result && !makerLayout(ed.map)) result = null; });
}
