// DDNet map model: decode datafile items into editable objects and back.
import { readDatafile, writeDatafile, intsToStr, strToInts, cstr, toCstr } from './datafile.js';

export const ITEM = { VERSION: 0, INFO: 1, IMAGE: 2, ENVELOPE: 3, GROUP: 4, LAYER: 5, ENVPOINTS: 6, SOUND: 7 };
export const LAYERTYPE = { GAME: 1, TILES: 2, QUADS: 3, FRONT: 4, TELE: 5, SPEEDUP: 6, SWITCH: 7, TUNE: 8, SOUNDS_DEPRECATED: 9, SOUNDS: 10 };
export const TILEFLAG = { GAME: 1, TELE: 2, SPEEDUP: 4, FRONT: 8, SWITCH: 16, TUNE: 32 };
// bytes per tile in each kind of tile layer
export const TILE_BYTES = { tiles: 4, game: 4, front: 4, tele: 2, speedup: 6, switch: 4, tune: 2 };
export const SPECIAL_SLOT = { tele: 18, speedup: 19, front: 20, switch: 21, tune: 22 };
const KIND_FLAG = { game: TILEFLAG.GAME, tele: TILEFLAG.TELE, speedup: TILEFLAG.SPEEDUP, front: TILEFLAG.FRONT, switch: TILEFLAG.SWITCH, tune: TILEFLAG.TUNE };
export const KIND_NAME = { tiles: 'Tiles', game: 'Game', front: 'Front', tele: 'Tele', speedup: 'Speedup', switch: 'Switch', tune: 'Tune', quads: 'Quads', sounds: 'Sounds' };

const FX = 1024;
const ITEMTYPE_EX = 0xffff;
export const UUID_BEZIER = [984938573, -640926600, -1249571476, -843914660];
export const UUID_AUTOMAPPER = [1041966870, 395065720, -1680232166, -532607528];
const sameUuid = (a, b) => a && b && a.length === 4 && a.every((v, i) => v === b[i]);

export async function loadMap(buf) {
  const { items, data } = await readDatafile(buf);
  const byType = (t) => items.filter((it) => it.type === t).sort((a, b) => a.id - b.id);
  // DDNet extended item types: an ITEMTYPE_EX item with id = internal type holds the type's UUID
  const uuidOf = new Map();
  for (const it of items) if (it.type === ITEMTYPE_EX && it.ints.length >= 4) uuidOf.set(it.id, Array.from(it.ints.slice(0, 4)));
  const byUuid = (u) => items.filter((it) => it.type !== ITEMTYPE_EX && sameUuid(uuidOf.get(it.type), u)).sort((a, b) => a.id - b.id);
  const str = (i) => (i >= 0 && i < data.length ? cstr(data[i]) : '');
  const map = { info: { author: '', version: '', credits: '', license: '', settings: [] }, images: [], envelopes: [], groups: [], sounds: [], extraItems: [], extraUuidItems: [], envPointStride: 6 };

  const info = byType(ITEM.INFO)[0];
  if (info) {
    const v = info.ints;
    map.info = { author: str(v[1]), version: str(v[2]), credits: str(v[3]), license: str(v[4]), settings: [] };
    if (v.length > 5 && v[5] >= 0 && data[v[5]]) {
      map.info.settings = new TextDecoder().decode(data[v[5]]).split('\0').filter((s) => s.length);
    }
  }

  for (const it of byType(ITEM.IMAGE)) {
    const v = it.ints;
    const img = { name: str(v[4]), width: v[1], height: v[2], external: !!v[3], rgba: null };
    if (!img.external && v[5] >= 0) img.rgba = data[v[5]];
    map.images.push(img);
  }

  for (const it of byType(ITEM.SOUND)) {
    const v = it.ints;
    map.sounds.push({ name: str(v[2]), external: !!v[1], data: v[3] >= 0 ? data[v[3]] : null });
  }

  // envelope points live in one shared item; stride is 6 ints (DDNet) or 22 (0.7 bezier)
  const envItems = byType(ITEM.ENVELOPE);
  const ptsItem = byType(ITEM.ENVPOINTS)[0];
  const totalPts = envItems.reduce((s, e) => s + e.ints[3], 0);
  if (ptsItem && totalPts) map.envPointStride = Math.round(ptsItem.ints.length / totalPts) || 6;
  const st = map.envPointStride;
  const bez = byUuid(UUID_BEZIER)[0];
  for (const it of envItems) {
    const v = it.ints;
    const env = { name: v.length > 11 ? intsToStr(v.slice(4, 12)) : '', channels: v[1], synchronized: v.length > 12 ? !!v[12] : false, points: [] };
    for (let i = 0; i < v[3]; i++) {
      const o = (v[2] + i) * st;
      if (!ptsItem || o + 6 > ptsItem.ints.length) break;
      const p = ptsItem.ints;
      const pt = { time: p[o], curve: p[o + 1], values: [p[o + 2], p[o + 3], p[o + 4], p[o + 5]] };
      if (st === 22) pt.bezier = Array.from(p.slice(o + 6, o + 22)); // 0.7: in/out tangents inline
      else if (bez && bez.ints.length >= (v[2] + i + 1) * 16) pt.bezier = Array.from(bez.ints.slice((v[2] + i) * 16, (v[2] + i + 1) * 16));
      env.points.push(pt);
    }
    map.envelopes.push(env);
  }

  const layerItems = byType(ITEM.LAYER);
  const layers = layerItems.map((it) => decodeLayer(it.ints, data, str));

  for (const it of byType(ITEM.GROUP)) {
    const v = it.ints;
    const g = {
      name: v.length > 14 && v[0] >= 3 ? intsToStr(v.slice(12, 15)) : '',
      offsetX: v[1], offsetY: v[2], parallaxX: v[3], parallaxY: v[4],
      clipping: v.length > 7 ? !!v[7] : false, clipX: v[8] || 0, clipY: v[9] || 0, clipW: v[10] || 0, clipH: v[11] || 0,
      layers: layers.slice(v[5], v[5] + v[6]), visible: true,
    };
    map.groups.push(g);
  }

  // automapper settings point at (group, layer within group)
  for (const it of byUuid(UUID_AUTOMAPPER)) {
    const [, gi, li, config, seed, flags] = it.ints;
    const l = map.groups[gi] && map.groups[gi].layers[li];
    if (l && l.type === 'tiles') l.automapper = { config, seed, flags };
  }

  const known = new Set(Object.values(ITEM));
  map.extraItems = items.filter((it) => !known.has(it.type) && it.type !== ITEMTYPE_EX && it.type < 0x8000);
  map.extraUuidItems = items
    .filter((it) => it.type !== ITEMTYPE_EX && it.type >= 0x8000 && uuidOf.has(it.type))
    .filter((it) => !sameUuid(uuidOf.get(it.type), UUID_BEZIER) && !sameUuid(uuidOf.get(it.type), UUID_AUTOMAPPER))
    .map((it) => ({ uuid: uuidOf.get(it.type), id: it.id, ints: it.ints }));
  delete map.envPointStride;
  return map;
}

function decodeLayer(v, data, str) {
  const type = v[1], flags = v[2];
  const base = { flags, visible: true };
  if (type === LAYERTYPE.TILES) {
    const tflags = v[6];
    let kind = 'tiles';
    for (const [k, f] of Object.entries(KIND_FLAG)) if (tflags & f) kind = k;
    const w = v[4], h = v[5];
    const name = v[3] >= 3 && v.length > 17 ? intsToStr(v.slice(15, 18)) : '';
    let raw;
    if (kind in SPECIAL_SLOT) raw = v.length > SPECIAL_SLOT[kind] ? data[v[SPECIAL_SLOT[kind]]] : null;
    else raw = data[v[14]];
    let tiles = new Uint8Array(w * h * TILE_BYTES[kind]);
    if (raw) {
      if (v[3] >= 4 && TILE_BYTES[kind] === 4 && kind !== 'switch') {
        // 0.7 compressed: byte 2 of each tile repeats it that many extra times
        let o = 0;
        for (let i = 0; i + 3 < raw.length && o < tiles.length; i += 4) {
          for (let r = 0; r <= raw[i + 2] && o < tiles.length; r++, o += 4) {
            tiles[o] = raw[i]; tiles[o + 1] = raw[i + 1];
          }
        }
      } else tiles.set(raw.subarray(0, tiles.length));
    }
    return {
      ...base, type: 'tiles', kind, name, width: w, height: h,
      color: [v[7], v[8], v[9], v[10]], colorEnv: v[11], colorEnvOffset: v[12], image: v[13], tiles,
    };
  }
  if (type === LAYERTYPE.QUADS) {
    const n = v[4];
    const raw = data[v[5]];
    const quads = [];
    if (raw) {
      const dv = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
      for (let q = 0; q < n; q++) {
        const o = q * 152;
        const I = (k) => dv.getInt32(o + k * 4, true);
        const points = [];
        for (let k = 0; k < 5; k++) points.push([I(k * 2) / FX, I(k * 2 + 1) / FX]);
        const colors = [];
        for (let k = 0; k < 4; k++) colors.push([I(10 + k * 4), I(11 + k * 4), I(12 + k * 4), I(13 + k * 4)]);
        const tex = [];
        for (let k = 0; k < 4; k++) tex.push([I(26 + k * 2) / FX, I(27 + k * 2) / FX]);
        quads.push({ points, colors, tex, posEnv: I(34), posEnvOffset: I(35), colorEnv: I(36), colorEnvOffset: I(37) });
      }
    }
    return { ...base, type: 'quads', kind: 'quads', name: v.length > 9 && v[3] >= 2 ? intsToStr(v.slice(7, 10)) : '', image: v[6], quads };
  }
  if (type === LAYERTYPE.SOUNDS) {
    const raw = data[v[5]];
    const sources = [];
    if (raw) {
      const dv = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
      for (let i = 0; i < v[4] && (i + 1) * 52 <= raw.length; i++) {
        const I = (k) => dv.getInt32(i * 52 + k * 4, true);
        const circle = I(10) === 1;
        sources.push({
          x: I(0) / FX, y: I(1) / FX, loop: !!I(2), pan: !!I(3), delay: I(4), falloff: I(5),
          posEnv: I(6), posEnvOffset: I(7), soundEnv: I(8), soundEnvOffset: I(9),
          shape: circle ? 'circle' : 'rect', radius: circle ? I(11) : 1500, w: circle ? 1500 : I(11) / FX, h: circle ? 1500 : I(12) / FX,
        });
      }
    }
    return { ...base, type: 'sounds', kind: 'sounds', name: v.length > 9 ? intsToStr(v.slice(7, 10)) : '', sound: v[6], sources };
  }
  // anything else (deprecated sound layers etc.): drop to an empty raw layer we write back untouched
  return { ...base, type: 'unknown', kind: 'unknown', name: '?', ints: Array.from(v), rawData: null };
}

// opts.reuse: reuse the encoded quads of layers that did not change since the last call (by layer._rev); used by the
// session backup that runs after every edit. Real saves always encode everything.
export async function saveMap(map, opts = {}) {
  const items = [];
  const data = [];
  const addData = (bytes) => { data.push(bytes); return data.length - 1; };
  const addStr = (s) => addData(toCstr(s || ''));
  const item = (type, id, ints) => items.push({ type, id, ints: Int32Array.from(ints) });

  item(ITEM.VERSION, 0, [1]);
  const inf = map.info;
  const settings = inf.settings.filter((s) => s.trim().length);
  let settingsIdx = -1;
  if (settings.length) {
    const parts = settings.map((s) => toCstr(s));
    const all = new Uint8Array(parts.reduce((s, p) => s + p.length, 0));
    let o = 0;
    for (const p of parts) { all.set(p, o); o += p.length; }
    settingsIdx = addData(all);
  }
  item(ITEM.INFO, 0, [1, inf.author ? addStr(inf.author) : -1, inf.version ? addStr(inf.version) : -1,
    inf.credits ? addStr(inf.credits) : -1, inf.license ? addStr(inf.license) : -1, settingsIdx]);

  map.images.forEach((img, i) => {
    const nameIdx = addStr(img.name);
    const dataIdx = img.external || !img.rgba ? -1 : addData(img.rgba);
    item(ITEM.IMAGE, i, [1, img.width, img.height, img.external || !img.rgba ? 1 : 0, nameIdx, dataIdx]);
  });

  map.sounds.forEach((s, i) => {
    const nameIdx = addStr(s.name);
    const dataIdx = s.data ? addData(s.data) : -1;
    item(ITEM.SOUND, i, [1, s.external ? 1 : 0, nameIdx, dataIdx, s.data ? s.data.length : 0]);
  });

  // extended (UUID) item types get internal types 0xfffe, 0xfffd, ... registered by an ITEMTYPE_EX item
  const uuidTypes = [];
  const uuidItem = (uuid, id, ints) => {
    let k = uuidTypes.findIndex((u) => sameUuid(u, uuid));
    if (k < 0) { uuidTypes.push(uuid); k = uuidTypes.length - 1; item(ITEMTYPE_EX, ITEMTYPE_EX - k - 1, uuid); }
    item(ITEMTYPE_EX - k - 1, id, ints);
  };

  const pts = [], bez = [];
  let usesBezier = false;
  map.envelopes.forEach((env, i) => {
    const start = pts.length / 6;
    for (const p of env.points) {
      pts.push(p.time, p.curve, ...p.values);
      const b = p.bezier || new Array(16).fill(0);
      bez.push(...b);
      if (p.curve === 5) usesBezier = true;
    }
    item(ITEM.ENVELOPE, i, [2, env.channels, start, env.points.length, ...strToInts(env.name, 8), env.synchronized ? 1 : 0]);
  });
  if (pts.length) item(ITEM.ENVPOINTS, 0, pts);
  if (usesBezier) uuidItem(UUID_BEZIER, 0, bez);

  let layerIdx = 0, autoIdx = 0;
  map.groups.forEach((g, gi) => {
    const start = layerIdx;
    g.layers.forEach((l, li) => {
      item(ITEM.LAYER, layerIdx++, encodeLayer(l, addData, opts.reuse));
      if (l.kind === 'tiles') { // like DDNet: one automapper item per plain tile layer
        const a = l.automapper || { config: -1, seed: 0, flags: 0 };
        uuidItem(UUID_AUTOMAPPER, autoIdx++, [1, gi, li, a.config, a.seed | 0, a.flags | 0]);
      }
    });
    item(ITEM.GROUP, gi, [3, g.offsetX | 0, g.offsetY | 0, g.parallaxX | 0, g.parallaxY | 0, start, g.layers.length,
      g.clipping ? 1 : 0, g.clipX | 0, g.clipY | 0, g.clipW | 0, g.clipH | 0, ...strToInts(g.name, 3)]);
  });

  // items this editor does not know are kept as they were
  for (const it of map.extraItems) items.push(it);
  for (const it of map.extraUuidItems || []) uuidItem(it.uuid, it.id, it.ints);
  return writeDatafile(items, data);
}

const quadBytes = new WeakMap(); // layer -> { quads, rev, bytes }

function encodeLayer(l, addData, reuse = false) {
  const flags = l.flags | 0;
  if (l.type === 'tiles') {
    const name = strToInts(l.name, 3);
    const special = [-1, -1, -1, -1, -1];
    let dataIdx;
    let tflags = KIND_FLAG[l.kind] || 0;
    if (l.kind in SPECIAL_SLOT) {
      dataIdx = addData(new Uint8Array(l.width * l.height * 4)); // dummy plain tiles
      special[SPECIAL_SLOT[l.kind] - 18] = addData(l.tiles);
    } else {
      dataIdx = addData(l.tiles);
    }
    return [0, LAYERTYPE.TILES, flags, 3, l.width, l.height, tflags, ...l.color, l.colorEnv, l.colorEnvOffset,
      l.image, dataIdx, ...name, ...special];
  }
  if (l.type === 'quads') {
    const known = reuse && quadBytes.get(l);
    if (known && known.quads === l.quads && known.rev === l._rev && known.bytes.length === l.quads.length * 152) {
      return [0, LAYERTYPE.QUADS, flags, 2, l.quads.length, addData(known.bytes), l.image, ...strToInts(l.name, 3)];
    }
    // 38 ints per quad; written straight into an Int32Array (little endian like the file) because big
    // quad-art layers have tens of thousands of quads and this runs on every save and session backup
    const a = new Int32Array(l.quads.length * 38);
    const R = Math.round;
    let o = 0;
    for (const q of l.quads) {
      const P = q.points, C = q.colors, T = q.tex;
      for (let k = 0; k < 5; k++) { a[o++] = R(P[k][0] * FX); a[o++] = R(P[k][1] * FX); }
      for (let k = 0; k < 4; k++) { const c = C[k]; a[o++] = R(c[0]); a[o++] = R(c[1]); a[o++] = R(c[2]); a[o++] = R(c[3]); }
      for (let k = 0; k < 4; k++) { a[o++] = R(T[k][0] * FX); a[o++] = R(T[k][1] * FX); }
      a[o++] = R(q.posEnv); a[o++] = R(q.posEnvOffset); a[o++] = R(q.colorEnv); a[o++] = R(q.colorEnvOffset);
    }
    const bytes = new Uint8Array(a.buffer);
    if (reuse) quadBytes.set(l, { quads: l.quads, rev: l._rev, bytes });
    const idx = addData(bytes);
    return [0, LAYERTYPE.QUADS, flags, 2, l.quads.length, idx, l.image, ...strToInts(l.name, 3)];
  }
  if (l.type === 'sounds') {
    // DDNet writes one zeroed dummy source when the layer is empty
    const n = l.sources.length;
    const buf = new ArrayBuffer(Math.max(1, n) * 52);
    const dv = new DataView(buf);
    l.sources.forEach((s, i) => {
      const circle = s.shape === 'circle';
      [Math.round(s.x * FX), Math.round(s.y * FX), s.loop ? 1 : 0, s.pan ? 1 : 0, s.delay | 0, s.falloff | 0, s.posEnv, s.posEnvOffset | 0, s.soundEnv, s.soundEnvOffset | 0,
        circle ? 1 : 0, circle ? s.radius | 0 : Math.round(s.w * FX), circle ? 0 : Math.round(s.h * FX)].forEach((v, k) => dv.setInt32(i * 52 + k * 4, v, true));
    });
    return [0, LAYERTYPE.SOUNDS, flags, 2, n, addData(new Uint8Array(buf)), l.sound, ...strToInts(l.name, 3)];
  }
  return l.ints;
}

// ---------------------------------------------------------------- constructors

export function newTileLayer(kind, w, h, name = '') {
  return { type: 'tiles', kind, name, flags: 0, visible: true, width: w, height: h, color: [255, 255, 255, 255], colorEnv: -1, colorEnvOffset: 0, image: -1, tiles: new Uint8Array(w * h * TILE_BYTES[kind]) };
}

export function newQuadLayer(name = '') {
  return { type: 'quads', kind: 'quads', name, flags: 0, visible: true, image: -1, quads: [] };
}

export function newSoundLayer(name = '') {
  return { type: 'sounds', kind: 'sounds', name, flags: 0, visible: true, sound: -1, sources: [] };
}

export function newSoundSource(x, y) {
  return { x, y, loop: true, pan: true, delay: 0, falloff: 80, posEnv: -1, posEnvOffset: 0, soundEnv: -1, soundEnvOffset: 0, shape: 'circle', radius: 1500, w: 1500, h: 1500 };
}

export function newGroup(name = '') {
  return { name, offsetX: 0, offsetY: 0, parallaxX: 100, parallaxY: 100, clipping: false, clipX: 0, clipY: 0, clipW: 0, clipH: 0, layers: [], visible: true };
}

// quad from 4 corners in DDNet order: top-left, top-right, bottom-left, bottom-right
export function makeQuad(p, color = [255, 255, 255, 255]) {
  const cx = (p[0][0] + p[1][0] + p[2][0] + p[3][0]) / 4, cy = (p[0][1] + p[1][1] + p[2][1] + p[3][1]) / 4;
  return {
    points: [...p.map((q) => [q[0], q[1]]), [cx, cy]],
    colors: [0, 1, 2, 3].map(() => [...color]),
    tex: [[0, 0], [1, 0], [0, 1], [1, 1]],
    posEnv: -1, posEnvOffset: 0, colorEnv: -1, colorEnvOffset: 0,
  };
}

// DDNet draws a quad as two triangles split along TL-BR (points 0 and 3): (0,1,3) and (0,3,2). That fills a
// concave quad correctly only when its inward corner is point 0 or 3; with the inward corner at 1 or 2 the fill
// spills over the TL-BR diagonal, outside the quad. Such a quad gets its corners renamed one step around the
// outline (colour and texture move with their corner), so the split goes through the inward corner. It looks
// the same, only the fill is right. Returns the new index of each old corner, or null when nothing changed.
export const CORNER_SHIFT = [2, 0, 3, 1]; // old corner -> new corner
export function fixQuadDiagonal(q) {
  const P = q.points;
  const side = (p) => (P[3][0] - P[0][0]) * (p[1] - P[0][1]) - (P[3][1] - P[0][1]) * (p[0] - P[0][0]);
  if (side(P[1]) * side(P[2]) <= 0) return null; // TR and BL on different sides of TL-BR: the split is inside
  const move = (a) => [a[1], a[3], a[0], a[2]];
  q.points = [...move(P), P[4]];
  q.colors = move(q.colors);
  q.tex = move(q.tex);
  return CORNER_SHIFT;
}

// the same for a quad given as its four corners [TL, TR, BL, BR] (quad pen): returns the corners in an order whose
// TL-BR split stays inside the quad
export function fixCornerOrder(qd) {
  const [tl, tr, bl, br] = qd;
  const side = (p) => (br[0] - tl[0]) * (p[1] - tl[1]) - (br[1] - tl[1]) * (p[0] - tl[0]);
  if (side(tr) * side(bl) <= 0) return qd;
  return [tr, br, tl, bl];
}

export function newMap(w = 100, h = 50) {
  const game = newTileLayer('game', w, h, 'Game');
  for (let x = 0; x < w; x++) { game.tiles[x * 4] = 1; game.tiles[((h - 1) * w + x) * 4] = 1; }
  for (let y = 0; y < h; y++) { game.tiles[y * w * 4] = 1; game.tiles[(y * w + w - 1) * 4] = 1; }
  game.tiles[((h - 2) * w + 4) * 4] = 192; // spawn (ENTITY_OFFSET 191 + ENTITY_SPAWN 1; 193 would be the red team spawn)
  const g = newGroup('Game');
  g.layers.push(game);
  return { info: { author: '', version: '', credits: '', license: '', settings: [] }, images: [], envelopes: [], groups: [g], sounds: [], extraItems: [], extraUuidItems: [] };
}

export function findGameLayer(map) {
  for (const g of map.groups) for (const l of g.layers) if (l.kind === 'game') return { group: g, layer: l };
  return null;
}
