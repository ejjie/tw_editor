// Automapper: DDNet .rules files (port of src/game/editor/auto_map.cpp).
const XFLIP = 1, YFLIP = 2, ROTATE = 8;
const INDEX = 1, NOTINDEX = 2;
const HASH_MAX = 65536;
export const REFERENCE_NAMES = ['Game layer', 'Hookable', 'Death', 'Unhookable', 'Freeze', 'Unfreeze', 'Deep Freeze', 'Deep Unfreeze', 'Live Freeze', 'Live Unfreeze'];
const REFERENCE_TILES = [1, 2, 3, 9, 11, 12, 13, 144, 145];

function hashU32(n) {
  n = (n + 1) >>> 0;
  n ^= n >>> 17; n = Math.imul(n, 0xed5ad4bb) >>> 0;
  n ^= n >>> 11; n = Math.imul(n, 0xac4c1b51) >>> 0;
  n ^= n >>> 15; n = Math.imul(n, 0x31848bab) >>> 0;
  n ^= n >>> 14;
  return n >>> 0;
}

function hashLocation(seed, run, rule, x, y) {
  let h = 1;
  for (const v of [seed, run, rule, x, y]) h = (Math.imul(h, 31) + hashU32(v >>> 0)) >>> 0;
  return hashU32(Math.imul(h, 31) >>> 0) % HASH_MAX;
}

function flagOf(flag, word, checkNone) {
  if (word === 'XFLIP') return flag | XFLIP;
  if (word === 'YFLIP') return flag | YFLIP;
  if (word === 'ROTATE') return flag | ROTATE;
  if (word === 'NONE' && checkNone) return 0;
  return flag;
}

// "Pos x y INDEX 1 XFLIP OR 2 NONE" -> [{id, flag, testFlag}]
function parseIndexList(words) {
  const list = [];
  let i = 0;
  while (i < words.length) {
    const info = { id: parseInt(words[i], 10) || 0, flag: 0, testFlag: false };
    i++;
    let first = true;
    while (i < words.length && words[i] !== 'OR') {
      if (first) {
        info.flag = flagOf(info.flag, words[i], true);
        info.testFlag = !(info.flag === 0 && words[i] !== 'NONE');
        first = false;
      } else if (info.flag !== 0) info.flag = flagOf(info.flag, words[i], false);
      i++;
    }
    list.push(info);
    if (words[i] === 'OR') i++;
  }
  return list;
}

export function parseRules(text) {
  const configs = [];
  let conf = null, run = null, idx = null;
  for (const raw of text.split(/\r?\n/)) {
    if (!raw.length || '#\t\v '.includes(raw[0])) continue;
    const line = raw.trim();
    const w = line.split(/\s+/);
    if (raw[0] === '[') {
      conf = { name: line.slice(1).replace(/\]$/, ''), runs: [], startX: 0, startY: 0, endX: 0, endY: 0 };
      configs.push(conf);
      run = { copy: true, rules: [] };
      conf.runs.push(run);
      idx = null;
    } else if (w[0] === 'NewRun' && conf) {
      run = { copy: true, rules: [] };
      conf.runs.push(run);
      idx = null;
    } else if (w[0] === 'Index' && run) {
      let flag = 0;
      for (const o of w.slice(2, 5)) flag = flagOf(flag, o, false);
      idx = { id: parseInt(w[1], 10) || 0, flag, prob: 1, defaultRule: true, skipEmpty: false, skipFull: false, pos: [], modulo: [] };
      run.rules.push(idx);
    } else if (w[0] === 'Pos' && idx) {
      const x = parseInt(w[1], 10) || 0, y = parseInt(w[2], 10) || 0, v = w[3];
      let value = 0, list = [];
      if (v === 'EMPTY') { value = INDEX; list = [{ id: 0, flag: 0, testFlag: false }]; }
      else if (v === 'FULL') { value = NOTINDEX; list = [{ id: 0, flag: 0, testFlag: false }]; }
      else if (v === 'INDEX' || v === 'NOTINDEX') { value = v === 'INDEX' ? INDEX : NOTINDEX; list = parseIndexList(w.slice(4)); }
      if (!value) continue;
      idx.pos.push({ x, y, value, list });
      conf.startX = Math.min(conf.startX, x); conf.startY = Math.min(conf.startY, y);
      conf.endX = Math.max(conf.endX, x); conf.endY = Math.max(conf.endY, y);
      if (x === 0 && y === 0) {
        for (const ii of list) {
          if (ii.id === 0 && value === INDEX) idx.skipFull = true;
          else if ((ii.id > 0 && value === INDEX) || (ii.id === 0 && value === NOTINDEX)) idx.skipEmpty = true;
        }
      }
    } else if (w[0] === 'Random' && idx) {
      const m = /^Random\s+([0-9.]+)(%?)/.exec(line);
      if (m) idx.prob = m[2] === '%' ? parseFloat(m[1]) / 100 : 1 / parseFloat(m[1]);
    } else if (w[0] === 'Modulo' && idx) {
      const [mx, my, ox, oy] = w.slice(1, 5).map((s) => parseInt(s, 10) || 0);
      idx.modulo.push({ mx: mx || 1, my: my || 1, ox, oy });
    } else if (w[0] === 'NoDefaultRule' && idx) idx.defaultRule = false;
    else if (w[0] === 'NoLayerCopy' && run) run.copy = false;
  }
  for (const c of configs) for (const r of c.runs) for (const ir of r.rules) {
    const found = ir.pos.some((p) => p.x === 0 && p.y === 0 && p.value === INDEX && p.list.some((i) => i.id === 0));
    if (!found && ir.defaultRule) {
      ir.pos.push({ x: 0, y: 0, value: NOTINDEX, list: [{ id: 0, flag: 0, testFlag: false }] });
      ir.skipEmpty = true;
      ir.skipFull = false;
    }
    if (ir.skipEmpty && ir.skipFull) { ir.skipEmpty = false; ir.skipFull = false; }
  }
  return configs;
}

// A run's rules compiled for speed (kept on the run): each Pos check becomes a table "index -> which flags match",
// bit f of mask[id] = the tile matches with flags f (ROTATE/XFLIP/YFLIP packed into 3 bits, see packFlag).
// Same results as checking the lists one by one, as auto_map.cpp does.
const packFlag = (f) => (f & 3) | ((f & ROTATE) >> 1);
function compiled(run) {
  if (run._c) return run._c;
  const rules = run.rules.map((ir) => {
    const n = ir.pos.length, dx = new Int32Array(n), dy = new Int32Array(n), isIndex = new Uint8Array(n), masks = [];
    // outside the map the index is -1 with no flags ("Pos 1 0 NOTINDEX -1" = not at the map's edge)
    const outHit = new Uint8Array(n);
    ir.pos.forEach((p, j) => {
      dx[j] = p.x; dy[j] = p.y; isIndex[j] = p.value === INDEX ? 1 : 0;
      outHit[j] = p.list.some((ii) => ii.id === -1 && (!ii.testFlag || ii.flag === 0)) ? 1 : 0;
      const m = new Uint8Array(256);
      for (const ii of p.list) if (ii.id >= 0 && ii.id < 256) m[ii.id] |= ii.testFlag ? 1 << packFlag(ii.flag) : 0xff;
      masks.push(m);
    });
    return { ir, n, dx, dy, isIndex, masks, outHit };
  });
  // the rules that can match an empty / a non-empty cell, in order
  const onEmpty = [], onFull = [];
  run.rules.forEach((ir, i) => { if (!ir.skipEmpty) onEmpty.push(i); if (!ir.skipFull) onFull.push(i); });
  // how far the rules look from a cell
  let reach = 0;
  for (const ir of run.rules) for (const p of ir.pos) reach = Math.max(reach, Math.abs(p.x), Math.abs(p.y));
  const onVoid = onEmpty.filter((i) => matchesVoid(rules[i]));
  run._c = { rules, onEmpty: Int32Array.from(onEmpty), onFull: Int32Array.from(onFull), onVoid, reach };
  return run._c;
}

// does rule c match at x, y of R (reads the arrays as they are now)
function matches(c, Ridx, Rflg, W, H, x, y) {
  const { n, dx, dy, isIndex, masks, outHit } = c;
  for (let j = 0; j < n; j++) {
    const cx = x + dx[j], cy = y + dy[j];
    let hit;
    if (cx >= 0 && cx < W && cy >= 0 && cy < H) {
      const o = cy * W + cx, f = Rflg[o];
      hit = (masks[j][Ridx[o]] >> ((f & 3) | ((f & ROTATE) >> 1))) & 1;
    } else hit = outHit[j];
    if (isIndex[j] ? !hit : hit) return false;
  }
  return true;
}

// hashLocation with the seed, run and rule part done once per rule
function hashPrefix(seed, run, rule) {
  let h = 1;
  for (const v of [seed, run, rule]) h = (Math.imul(h, 31) + hashU32(v >>> 0)) >>> 0;
  return h;
}
function hashRest(h, x, y) {
  h = (Math.imul(h, 31) + hashU32(x >>> 0)) >>> 0;
  h = (Math.imul(h, 31) + hashU32(y >>> 0)) >>> 0;
  return hashU32(Math.imul(h, 31) >>> 0) % HASH_MAX;
}

// layer-like {w, h, idx: Uint8Array, flg: Uint8Array}
function automap(L, R, run, runIndex, filterable, seed, sx, sy) {
  const W = L.w, H = L.h, C = compiled(run), rules = C.rules, nr = rules.length;
  const Ridx = R.idx, Rflg = R.flg, Lidx = L.idx, Lflg = L.flg;
  const pre = rules.map((c, i) => (c.ir.prob < 1 ? hashPrefix(seed, runIndex, i) : 0));
  const apply = (c, i, x, y, t) => {
    const ir = c.ir;
    if (!matches(c, Ridx, Rflg, W, H, x, y)) return;
    if (ir.modulo.length && !ir.modulo.some((m) => (x + sx + m.ox) % m.mx === 0 && (y + sy + m.oy) % m.my === 0)) return;
    if (ir.prob >= 1 || hashRest(pre[i], x + sx, y + sy) < HASH_MAX * ir.prob) { Lidx[t] = ir.id; Lflg[t] = ir.flag; }
  };
  const { onEmpty, onFull, onVoid, reach } = C;
  // the reference layer is filtered: every rule on every cell, as auto_map.cpp does
  if (filterable) {
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const t = y * W + x;
      for (let i = 0; i < nr; i++) {
        const c = rules[i], ir = c.ir;
        if (Ridx[t] === 0) {
          if (Lidx[t] !== 0) { Lidx[t] = 0; Lflg[t] = ir.flag; continue; }
          if (ir.skipEmpty) continue;
        }
        if (ir.skipFull && Ridx[t] !== 0) continue;
        apply(c, i, x, y, t);
      }
    }
    return;
  }
  // the run reads the layer it writes (NoLayerCopy): a rule can empty or fill the cell for the next rules, so the
  // cell is read again before each rule. An empty cell that no rule can touch (onEmpty is empty) is skipped.
  if (R === L) {
    const anyEmpty = onEmpty.length > 0;
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const t = y * W + x;
      if (!anyEmpty && Ridx[t] === 0) continue;
      for (let i = 0; i < nr; i++) {
        const c = rules[i], ir = c.ir;
        if (Ridx[t] === 0 ? ir.skipEmpty : ir.skipFull) continue;
        apply(c, i, x, y, t);
      }
    }
    return;
  }
  // R is a copy that does not change: only the rules that can match an empty / full cell are tried
  const visit = (x, y, t) => {
    const list = Ridx[t] === 0 ? onEmpty : onFull;
    for (let k = 0; k < list.length; k++) apply(rules[list[k]], list[k], x, y, t);
  };
  if (!onEmpty.length || onVoid.length) { for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) visit(x, y, y * W + x); return; }
  // Rules for empty cells (EMPTY at the cell, e.g. corners): most of a map is air, and a cell with nothing but empty
  // tiles of the map as far as the rules look sees the same as every other such cell. No rule matches that
  // (onVoid is empty), so those cells are not visited. Visited: the tiles grown by the reach of the rules, and the
  // band along the map's edge (outside the map is not "empty" for the rules).
  const r = reach, A = new Uint8Array(W * H), B = new Uint8Array(W * H);
  for (let y = 0; y < H; y++) {
    const row = y * W;
    for (let x = 0; x < W; x++) if (Ridx[row + x] !== 0) A.fill(1, row + Math.max(0, x - r), row + Math.min(W, x + r + 1));
  }
  for (let y = 0; y < H; y++) {
    const row = y * W;
    if (y < r || y >= H - r) { B.fill(1, row, row + W); continue; }
    for (let j = y - r; j <= y + r; j++) {
      const src = j * W;
      for (let x = 0; x < W; x++) B[row + x] |= A[src + x];
    }
    for (let x = 0; x < r && x < W; x++) { B[row + x] = 1; B[row + W - 1 - x] = 1; }
  }
  for (let y = 0; y < H; y++) for (let x = 0, t = y * W; x < W; x++, t++) if (B[t]) visit(x, y, t);
}

// does the rule match where every tile it looks at is an empty tile inside the map (index 0, no flags)
function matchesVoid(c) {
  for (let j = 0; j < c.n; j++) {
    const hit = c.masks[j][0] & 1;
    if (c.isIndex[j] ? !hit : hit) return false;
  }
  return true;
}

function proceed(L, G, ref, conf, seed, sx, sy) {
  if (!seed) seed = (Math.random() * 2 ** 31) | 0;
  const W = L.w, H = L.h;
  conf.runs.forEach((run, h) => {
    const filterable = h === 0 && ref >= 0;
    const buf = filterable ? G : L;
    if (run.copy && !filterable && !(h === 0 && ref >= 1)) {
      // a plain copy of the layer (same as the loop below for these runs)
      automap(L, { w: W, h: H, idx: L.idx.slice(), flg: L.flg.slice() }, run, h, filterable, seed, sx, sy);
    } else if (run.copy) {
      const C = { w: W, h: H, idx: new Uint8Array(W * H), flg: new Uint8Array(W * H) };
      const lw = filterable ? Math.min(G.w, W) : W, lh = filterable ? Math.min(G.h, H) : H;
      for (let y = 0; y < lh; y++) for (let x = 0; x < lw; x++) {
        const s = y * buf.w + x, d = y * W + x;
        C.idx[d] = h === 0 && ref >= 1 && buf.idx[s] !== REFERENCE_TILES[ref - 1] ? 0 : buf.idx[s];
        C.flg[d] = buf.flg[s];
      }
      automap(L, C, run, h, filterable, seed, sx, sy);
    } else automap(L, buf, run, h, filterable, seed, sx, sy);
  });
}

function view(layer, x0, y0, w, h) {
  const v = { w, h, idx: new Uint8Array(w * h), flg: new Uint8Array(w * h) };
  if (x0 === 0 && y0 === 0 && w === layer.width && h === layer.height) {
    const T = layer.tiles, I = v.idx, F = v.flg;
    for (let i = 0, o = 0; i < w * h; i++, o += 4) { I[i] = T[o]; F[i] = T[o + 1]; }
    return v;
  }
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const sx = x0 + x, sy = y0 + y;
    if (sx >= layer.width || sy >= layer.height) continue;
    const o = (sy * layer.width + sx) * 4;
    v.idx[y * w + x] = layer.tiles[o];
    v.flg[y * w + x] = layer.tiles[o + 1];
  }
  return v;
}

// run on the whole layer, or on a region (with the margin DDNet uses) when x/y/w/h are given
export function runAutomapper(layer, game, conf, seed, ref = -1, region = null) {
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  let ux0 = 0, uy0 = 0, ux1 = layer.width, uy1 = layer.height, cx0 = 0, cy0 = 0, cx1 = layer.width, cy1 = layer.height;
  if (region) {
    const [x, y, w, h] = region;
    cx0 = clamp(x + conf.startX, 0, layer.width); cy0 = clamp(y + conf.startY, 0, layer.height);
    cx1 = clamp(x + w + conf.endX, 0, layer.width); cy1 = clamp(y + h + conf.endY, 0, layer.height);
    ux0 = clamp(x + 3 * conf.startX, 0, layer.width); uy0 = clamp(y + 3 * conf.startY, 0, layer.height);
    ux1 = clamp(x + w + 3 * conf.endX, 0, layer.width); uy1 = clamp(y + h + 3 * conf.endY, 0, layer.height);
  }
  const uw = ux1 - ux0, uh = uy1 - uy0;
  if (uw <= 0 || uh <= 0) return;
  const L = view(layer, ux0, uy0, uw, uh);
  const G = game ? view(game, ux0, uy0, uw, uh) : ref >= 0 ? { w: uw, h: uh, idx: new Uint8Array(uw * uh), flg: new Uint8Array(uw * uh) } : null;
  proceed(L, G, ref, conf, seed, ux0, uy0);
  for (let y = cy0; y < cy1; y++) for (let x = cx0; x < cx1; x++) {
    const s = (y - uy0) * uw + (x - ux0), o = (y * layer.width + x) * 4;
    layer.tiles[o] = L.idx[s];
    layer.tiles[o + 1] = L.flg[s];
  }
}

const cache = new Map();
export async function loadRules(imageName) {
  if (cache.has(imageName)) return cache.get(imageName);
  const p = fetch('/data/editor/automap/' + encodeURIComponent(imageName) + '.rules')
    .then((r) => (r.ok ? r.text() : ''))
    .then((t) => parseRules(t))
    .catch(() => []);
  cache.set(imageName, p);
  return p;
}

// read the file again next time (it changed on disk)
export function forgetRules(imageName) { cache.delete(imageName); }
