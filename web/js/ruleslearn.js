// Learns a DDNet .rules config from a painted example (port of tools/template2rules.py, used by the Rules maker).
// The Game layer says what each cell is (hook, unhook, hookthrough, freeze or air); a painted tile layer says which tile
// goes where. For every cell the 3x3 (or 5x5) around it is read, and rules are written from general to specific,
// each only where it changes the result: "any hook", then by sides, then corners, then the exact neighbourhood.
const XFLIP = 1, YFLIP = 2, ROTATE = 8;
const FLAG_MASK = XFLIP | YFLIP | ROTATE;

// neighbour offsets (x right, y down): NW N NE W E SW S SE
const O8 = [[-1, -1], [0, -1], [1, -1], [-1, 0], [1, 0], [-1, 1], [0, 1], [1, 1]];
const ORTH = [1, 3, 4, 6]; // N W E S
const CORNERS = [[0, 1, 3], [2, 1, 4], [5, 6, 3], [7, 6, 4]]; // corner, its two orthogonal neighbours
const O24 = [...O8];
for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) if (Math.max(Math.abs(dx), Math.abs(dy)) === 2) O24.push([dx, dy]);
export const LEVEL_NAMES = ['any', 'sides solid/open', 'sides', 'sides + inner corners', 'sides + all corners solid/open', 'exact 3x3', 'exact 5x5'];
const SPRINKLE_MIN = 5, SPRINKLE_SHARE = 0.01, SPRINKLE_LEVEL = 3;

// The kinds of game cells. Outside the map counts as hook. The letters are what the keys below are made of.
export const ENTITIES = {
  H: { name: 'hook', ids: [1] },
  U: { name: 'unhook', ids: [3] },
  T: { name: 'hookthrough', ids: [5] },
  F: { name: 'freeze', ids: [9, 12] },
};

export class Classes {
  constructor(ids = {}) {
    this.ids = {};
    for (const k of Object.keys(ENTITIES)) {
      const v = [...new Set(ids[k] || ENTITIES[k].ids)];
      if (k === 'H') v.push(-1);
      if (v.length) this.ids[k] = v.sort((a, b) => a - b);
    }
    this.of = new Map();
    for (const [k, v] of Object.entries(this.ids)) for (const i of v) this.of.set(i, k);
    this.order = [...Object.keys(this.ids), 'E'];
  }
  cls(i) { return this.of.get(i) || 'E'; }
  // Pos condition text for "cell is of class c" (or not of class c)
  cond(c, negate = false) {
    let ids, kw;
    if (c === 'E') { ids = [...this.of.keys()].sort((a, b) => a - b); kw = 'NOTINDEX'; } else { ids = this.ids[c]; kw = 'INDEX'; }
    if (negate) kw = kw === 'INDEX' ? 'NOTINDEX' : 'INDEX';
    return kw + ' ' + ids.join(' OR ');
  }
}

// ------------------------------------------------------------ symmetry (flip / rotate)

// texture-space map of a tile flag, as the DDNet renderer applies it: rotate first, then flips
function mat(f) {
  let m = [[1, 0], [0, 1]];
  if (f & ROTATE) m = [[0, 1], [-1, 0]];
  if (f & XFLIP) m = [[-m[0][0], -m[0][1]], m[1]];
  if (f & YFLIP) m = [m[0], [-m[1][0], -m[1][1]]];
  return m;
}
const mul = (a, b) => [0, 1].map((i) => [0, 1].map((j) => a[i][0] * b[0][j] + a[i][1] * b[1][j]));
const inv = (g) => [[g[0][0], g[1][0]], [g[0][1], g[1][1]]];
const mkey = (m) => m.flat().join(',');
const ALL_FLAGS = [0, XFLIP, YFLIP, XFLIP | YFLIP, ROTATE, ROTATE | XFLIP, ROTATE | YFLIP, ROTATE | XFLIP | YFLIP];
const FLAG_OF_MAT = new Map(ALL_FLAGS.map((f) => [mkey(mat(f)), f]));
const TRANSFORMS = ALL_FLAGS.slice(1).map(mat);

// tiles are numbers: id * 16 + flags
const tid = (t) => t >> 4, tfl = (t) => t & 15;
const popcount = (f) => (f & 1) + ((f >> 1) & 1) + ((f >> 3) & 1);

function transformSample(n, tile, g) {
  const offs = n.length === 8 ? O8 : O24;
  const out = new Array(offs.length);
  offs.forEach(([dx, dy], i) => {
    const nx = g[0][0] * dx + g[0][1] * dy, ny = g[1][0] * dx + g[1][1] * dy;
    out[offs.findIndex((o) => o[0] === nx && o[1] === ny)] = n[i];
  });
  if (!tid(tile)) return [out.join(''), tile];
  return [out.join(''), tid(tile) * 16 + FLAG_OF_MAT.get(mkey(mul(mat(tfl(tile)), inv(g))))];
}

// ------------------------------------------------------------ learning

function keyAt(level, c, n) {
  if (level === 0) return '';
  if (level === 1) return ORTH.map((i) => (n[i] === c ? '1' : '0')).join('');
  if (level === 2) return ORTH.map((i) => n[i]).join('');
  if (level === 3 || level === 4) {
    // corners between two same-as-centre sides (inner corners) by kind; level 4 adds the others as same/not
    return ORTH.map((i) => n[i]).join('') + CORNERS.map(([k, a, b]) =>
      (n[a] === c && n[b] === c ? n[k] : level === 3 ? '*' : n[k] === c ? '1' : '0')).join('');
  }
  if (level === 5) return n.slice(0, 8);
  return n;
}

function posConditions(level, c, key, C) {
  const out = [];
  if (level === 1) {
    [...key].forEach((s, j) => out.push([O8[ORTH[j]], C.cond(c, s !== '1')]));
  } else if (level >= 2 && level <= 4) {
    for (let j = 0; j < 4; j++) out.push([O8[ORTH[j]], C.cond(key[j])]);
    for (let j = 0; j < 4; j++) {
      const s = key[4 + j];
      if (s === undefined || s === '*') continue;
      const o = O8[CORNERS[j][0]];
      if (s === '1' || s === '0') out.push([o, C.cond(c, s !== '1')]);
      else out.push([o, C.cond(s)]);
    }
  } else {
    [...key].forEach((s, j) => out.push([O24[j], C.cond(s)]));
  }
  return out;
}

const add = (m, k, v = 1) => m.set(k, (m.get(k) || 0) + v);
const total = (m) => { let s = 0; for (const v of m.values()) s += v; return s; };
const byCount = (a, b) => b[1] - a[1] || a[0] - b[0];

// tiles to put in one situation: the most used one, plus random variants. A tile index used with several
// flips/rotations counts as one (random orientation), and then every orientation it had is kept.
function variants(counter, minShare) {
  const tot = total(counter);
  const items = [...counter].sort(byCount);
  const perId = new Map();
  for (const [t, k] of items) add(perId, tid(t), k);
  const first = tid(items[0][0]);
  const ids = new Set([...perId].filter(([i, k]) => i === first || (k >= 2 && k / tot >= minShare)).map(([i]) => i));
  return items.filter(([t]) => ids.has(tid(t)));
}

// cells that are examples: a shape (8-connected game tiles) counts only if something is painted on it or right next
// to it, so shapes left unpainted on purpose teach nothing. Air away from every shape always counts.
function usedCells(gameAt, paintAt, x0, y0, x1, y1) {
  const W = x1 - x0, H = y1 - y0, comp = new Int32Array(W * H).fill(-1), painted = [];
  for (let s = 0; s < W * H; s++) {
    if (comp[s] >= 0 || !gameAt(x0 + (s % W), y0 + Math.floor(s / W))) continue;
    const k = painted.length;
    painted.push(false);
    const stack = [s];
    comp[s] = k;
    while (stack.length) {
      const p = stack.pop(), x = p % W, y = Math.floor(p / W);
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const X = x + dx, Y = y + dy;
        if (X < 0 || Y < 0 || X >= W || Y >= H) continue;
        const q = Y * W + X;
        if (paintAt(x0 + X, y0 + Y)) painted[k] = true;
        if (comp[q] < 0 && gameAt(x0 + X, y0 + Y)) { comp[q] = k; stack.push(q); }
      }
    }
  }
  const used = new Uint8Array(W * H).fill(1);
  for (let p = 0; p < W * H; p++) {
    if (comp[p] >= 0) { used[p] = painted[comp[p]] ? 1 : 0; continue; }
    const x = p % W, y = Math.floor(p / W), near = new Set();
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      const X = x + dx, Y = y + dy;
      if (X >= 0 && Y >= 0 && X < W && Y < H && comp[Y * W + X] >= 0) near.add(comp[Y * W + X]);
    }
    if (near.size) used[p] = [...near].some((k) => painted[k]) || paintAt(x0 + x, y0 + y) ? 1 : 0;
  }
  return used;
}

// game, layer: map tile layers (4 bytes a tile). areas: [[x0, y0, x1, y1], ...] to learn from (default: everything)
export function learn(game, layer, C, { symmetry = false, radius = 1, skipUnpainted = false, blank = new Set(), areas = null } = {}) {
  const offsets = radius === 2 ? O24 : O8;
  const W = Math.min(game.width, layer.width), H = Math.min(game.height, layer.height);
  const gcls = (x, y) => (x < 0 || y < 0 || x >= game.width || y >= game.height ? 'H' : C.cls(game.tiles[(y * game.width + x) * 4]));
  const tileAt = (x, y) => {
    const o = (y * layer.width + x) * 4, i = layer.tiles[o];
    return i && !blank.has(i) ? i * 16 + (layer.tiles[o + 1] & FLAG_MASK) : 0;
  };
  const real = new Map(), where = new Map(); // "c|n" -> Map(tile -> count)
  for (const [x0, y0, x1, y1] of areas || [[0, 0, W, H]]) {
    const ax0 = Math.max(0, x0), ay0 = Math.max(0, y0), ax1 = Math.min(W, x1), ay1 = Math.min(H, y1);
    if (ax1 <= ax0 || ay1 <= ay0) continue;
    const used = skipUnpainted ? usedCells((x, y) => game.tiles[(y * game.width + x) * 4] !== 0, tileAt, ax0, ay0, ax1, ay1) : null;
    for (let y = ay0; y < ay1; y++) for (let x = ax0; x < ax1; x++) {
      if (used && !used[(y - ay0) * (ax1 - ax0) + (x - ax0)]) continue;
      const key = gcls(x, y) + '|' + offsets.map(([dx, dy]) => gcls(x + dx, y + dy)).join('');
      if (!real.has(key)) { real.set(key, new Map()); where.set(key, []); }
      add(real.get(key), tileAt(x, y));
      if (where.get(key).length < 3) where.get(key).push([x, y]);
    }
  }
  const synth = new Map();
  if (symmetry) {
    for (const [key, cnt] of real) {
      const [c, n] = key.split('|');
      for (const g of TRANSFORMS) for (const [t, k] of cnt) {
        const [n2, t2] = transformSample(n, t, g), k2 = c + '|' + n2;
        if (real.has(k2)) continue;
        if (!synth.has(k2)) synth.set(k2, new Map());
        add(synth.get(k2), t2, k);
      }
    }
  }
  return { real, synth, where, last: radius === 2 ? 6 : 5 };
}

// rules from general to specific; a rule is written only where it changes the result
export function buildRules({ real, synth, last }, C, { minShare = 0.15, minSupport = 1 } = {}) {
  const rules = [], sprinkles = [], mixed = [];
  for (const c of C.order) {
    const samples = new Map(), fake = new Map();
    for (const [key, cnt] of real) if (key[0] === c) samples.set(key.slice(2), cnt);
    for (const [key, cnt] of synth) if (key[0] === c) fake.set(key.slice(2), cnt);
    if (!samples.size) continue;
    const effective = new Map(), explained = new Map();
    for (let level = 0; level <= last; level++) {
      const tabReal = new Map(), tabFake = new Map(), parentKey = new Map();
      for (const [src, tab] of [[samples, tabReal], [fake, tabFake]]) {
        for (const [n, cnt] of src) {
          const k = keyAt(level, c, n);
          if (!tab.has(k)) tab.set(k, new Map());
          for (const [t, v] of cnt) add(tab.get(k), t, v);
          if (level && !parentKey.has(k)) parentKey.set(k, keyAt(level - 1, c, n));
        }
      }
      const keys = [...new Set([...tabReal.keys(), ...tabFake.keys()])].sort();
      for (const key of keys) {
        const synthetic = !tabReal.has(key);
        const cnt = synthetic ? tabFake.get(key) : tabReal.get(key);
        const parent = level ? effective.get(level - 1 + '|' + parentKey.get(key)) : 0;
        let top;
        if (synthetic) { // one tile, no random: on a tie the one with the fewest flips/rotations
          top = [[...cnt].sort((a, b) => b[1] - a[1] || popcount(tfl(a[0])) - popcount(tfl(b[0])) || a[0] - b[0])[0]];
        } else top = variants(cnt, minShare);
        const isRandom = level === last && top.length > 1;
        const best = top[0][0];
        if (level >= 4 && !synthetic && total(cnt) < minSupport) {
          effective.set(level + '|' + key, parent);
          if (level === last) explained.set(key, new Set([parent]));
          continue;
        }
        const changes = isRandom || best !== parent;
        if (changes) {
          rules.push({ level, c, key, tiles: isRandom ? top : [top[0]], synthetic });
          if (isRandom) mixed.push(c + '|' + key);
        }
        effective.set(level + '|' + key, changes ? best : parent);
        if (level === last) explained.set(key, isRandom ? new Set(top.map(([t]) => t)) : new Set([effective.get(level + '|' + key)]));
      }
    }
    // sprinkles: a tile scattered here and there (never the majority) comes back as a random rule with the same density
    const left = new Map(); // "n|tile" -> uses the rules do not explain
    for (const [n, cnt] of samples) {
      const ke = keyAt(last, c, n);
      for (const [t, k] of cnt) if (tid(t) && !explained.get(ke)?.has(t)) add(left, n + '|' + t, k);
    }
    for (let level = last; level >= SPRINKLE_LEVEL; level--) {
      const tab = new Map(), tot = new Map();
      for (const [n, cnt] of samples) add(tot, keyAt(level, c, n), total(cnt));
      for (const [nt, k] of left) {
        const [n, t] = nt.split('|'), kk = keyAt(level, c, n);
        if (!tab.has(kk)) tab.set(kk, new Map());
        add(tab.get(kk), +t, k);
      }
      for (const key of [...tab.keys()].sort()) {
        const perId = new Map();
        for (const [t, k] of tab.get(key)) add(perId, tid(t), k);
        for (const [t, k] of [...tab.get(key)].sort((a, b) => a[0] - b[0])) {
          const n = perId.get(tid(t));
          if (n >= SPRINKLE_MIN && n / tot.get(key) >= SPRINKLE_SHARE) {
            sprinkles.push({ level, c, key, tiles: [[t, k]], synthetic: false, share: k / tot.get(key) });
            for (const nt of [...left.keys()]) {
              const [n2, t2] = nt.split('|');
              if (+t2 === t && keyAt(level, c, n2) === key) left.delete(nt);
            }
          }
        }
      }
    }
  }
  return { rules: [...rules, ...sprinkles], mixed };
}

function tileWords(t) {
  const f = tfl(t), w = ['Index', String(tid(t))];
  if (f & XFLIP) w.push('XFLIP');
  if (f & YFLIP) w.push('YFLIP');
  if (f & ROTATE) w.push('ROTATE');
  return w.join(' ');
}

const round3 = (v) => String(Math.round(v * 1000) / 1000);

export function writeConfig(name, rules, C, comment = 'made by the Rules maker of tw-editor') {
  const lines = [`[${name}]`, `# ${comment}`, '',
    '# run 1: keep only the game tiles the rules look at (also works with Reference = Game layer)', 'Index 0', 'Pos 0 0 FULL', ''];
  for (const i of [...C.of.keys()].filter((v) => v >= 0).sort((a, b) => a - b)) lines.push(`Index ${i}`, `Pos 0 0 INDEX ${i}`, '');
  // with Reference the first run erases anything put on air, so the real rules go in a second run
  lines.push('NewRun', '', '# run 2: clear, then put the tiles back', 'Index 0', 'Pos 0 0 FULL', '');
  let last = null;
  for (const r of rules) {
    const head = r.c + r.level + (r.share !== undefined);
    if (head !== last) {
      lines.push(`# --- ${r.c === 'E' ? 'air' : ENTITIES[r.c].name} cells: ${LEVEL_NAMES[r.level]}${r.share !== undefined ? ', scattered tiles' : ''}`);
      last = head;
    }
    const conds = posConditions(r.level, r.c, r.key, C);
    let acc = 0;
    r.tiles.forEach(([t, k], j) => {
      acc += k;
      lines.push(tileWords(t));
      if (r.c === 'E') lines.push('NoDefaultRule');
      lines.push('Pos 0 0 ' + C.cond(r.c));
      for (const [[dx, dy], cond] of conds) lines.push(`Pos ${dx} ${dy} ${cond}`);
      if (j) lines.push(`Random ${round3((100 * k) / acc)}%`); // variant j replaces the earlier ones with its share of what is left
      else if (r.share !== undefined) lines.push(`Random ${round3(100 * r.share)}%`);
      if (r.synthetic && j === 0) lines.push('# (rotated/flipped from a painted case)');
    });
    lines.push('');
  }
  return lines.join('\n');
}

// ids of fully transparent tiles of an image's pixels: painting them is the same as leaving the cell empty
export function blankTiles(img) {
  const out = new Set();
  if (!img || !img.rgba || img.width % 16 || img.height % 16) return out;
  const tw = img.width / 16, th = img.height / 16;
  for (let i = 1; i < 256; i++) {
    const tx = (i % 16) * tw, ty = Math.floor(i / 16) * th;
    let empty = true;
    for (let y = 0; y < th && empty; y++) for (let x = 0; x < tw; x++) if (img.rgba[((ty + y) * img.width + tx + x) * 4 + 3]) { empty = false; break; }
    if (empty) out.add(i);
  }
  return out;
}
