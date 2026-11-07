// Tile brush and quad operations (pure data, no UI).
import { TILE_BYTES } from './map.js';
import { displayTile } from './render.js';
import { isValidFor, isTeleCheckpoint, isTeleNumberUsedAny, isSwitchNumberUsed, isSwitchDelayUsed, isSwitchFlagsUsed, isRotatableTile } from './tilerules.js';

// ------------------------------------------------------------------ tiles

export function copyRegion(layer, x0, y0, w, h) {
  const b = TILE_BYTES[layer.kind];
  const data = new Uint8Array(w * h * b);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const sx = x0 + x, sy = y0 + y;
      if (sx < 0 || sy < 0 || sx >= layer.width || sy >= layer.height) continue;
      data.set(layer.tiles.subarray((sy * layer.width + sx) * b, (sy * layer.width + sx + 1) * b), (y * w + x) * b);
    }
  }
  return { w, h, kind: layer.kind, data, fromPicker: false };
}

// brush from a rectangle of the 16x16 tile picker
export function pickerBrush(kind, x0, y0, w, h) {
  const b = TILE_BYTES[kind === 'tiles' ? 'tiles' : 'game'];
  const data = new Uint8Array(w * h * b);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) data[(y * w + x) * b] = (y0 + y) * 16 + x0 + x;
  return { w, h, kind: kind === 'tiles' ? 'tiles' : 'game', data, fromPicker: true };
}

// tile bytes of `brush` cell i, converted for a layer of `kind`; null = not allowed in that layer
export function brushTile(brush, i, kind, nums) {
  const out = new Uint8Array(TILE_BYTES[kind]);
  if (brush.kind === kind && !brush.fromPicker) {
    out.set(brush.data.subarray(i * TILE_BYTES[kind], (i + 1) * TILE_BYTES[kind]));
    return out;
  }
  let [index, flags] = displayTile(brush.kind, brush.data, i);
  if (!index) return out;
  if (!nums.allowUnused && !isValidFor(kind, index)) return null;
  if (kind !== 'tiles' && !isRotatableTile(index)) flags = 0;
  switch (kind) {
    case 'tiles': case 'game': case 'front': out[0] = index; out[1] = flags; break;
    case 'tele':
      out[0] = isTeleCheckpoint(index) ? nums.teleCheckpoint : (isTeleNumberUsedAny(index) ? nums.tele : 0);
      out[1] = index;
      break;
    case 'switch':
      out[0] = isSwitchNumberUsed(index) ? nums.switch : 0; out[1] = index;
      out[2] = isSwitchFlagsUsed(index) ? flags : 0; out[3] = isSwitchDelayUsed(index) ? nums.switchDelay : 0;
      break;
    case 'tune': out[0] = nums.tune; out[1] = index; break;
    case 'speedup': {
      out[0] = nums.speedForce; out[1] = nums.speedMax; out[2] = index;
      out.set(new Uint8Array(new Int16Array([nums.speedAngle]).buffer), 4);
      break;
    }
  }
  return out;
}

// stamp brush with its top-left at tile (tx, ty); returns true if anything changed
export function stamp(layer, brush, tx, ty, nums) {
  const b = TILE_BYTES[layer.kind];
  let changed = false;
  for (let y = 0; y < brush.h; y++) {
    for (let x = 0; x < brush.w; x++) {
      const lx = tx + x, ly = ty + y;
      if (lx < 0 || ly < 0 || lx >= layer.width || ly >= layer.height) continue;
      const t = brushTile(brush, y * brush.w + x, layer.kind, nums);
      if (!t) continue;
      if (!nums.destructive && t.every((v) => v === 0)) continue; // non-destructive: empty brush cells keep what is there
      const o = (ly * layer.width + lx) * b;
      for (let k = 0; k < b; k++) if (layer.tiles[o + k] !== t[k]) { layer.tiles[o + k] = t[k]; changed = true; }
    }
  }
  return changed;
}

// fill the rectangle with the brush repeated
export function fillRect(layer, brush, x0, y0, w, h, nums) {
  const b = TILE_BYTES[layer.kind];
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const lx = x0 + x, ly = y0 + y;
      if (lx < 0 || ly < 0 || lx >= layer.width || ly >= layer.height) continue;
      const t = brushTile(brush, (y % brush.h) * brush.w + (x % brush.w), layer.kind, nums);
      if (t) layer.tiles.set(t, (ly * layer.width + lx) * b);
    }
  }
}

// flood fill (4-connected) of the area with the same tile index as the start, painting the brush pattern
export function floodFill(layer, brush, sx, sy, nums) {
  if (sx < 0 || sy < 0 || sx >= layer.width || sy >= layer.height) return;
  const b = TILE_BYTES[layer.kind];
  const W = layer.width, H = layer.height;
  const idxAt = (x, y) => displayTile(layer.kind, layer.tiles, y * W + x)[0];
  const target = idxAt(sx, sy);
  const seen = new Uint8Array(W * H);
  const stack = [sx, sy];
  const cells = [];
  while (stack.length) {
    const y = stack.pop(), x = stack.pop();
    if (x < 0 || y < 0 || x >= W || y >= H || seen[y * W + x] || idxAt(x, y) !== target) continue;
    seen[y * W + x] = 1;
    cells.push(x, y);
    stack.push(x + 1, y, x - 1, y, x, y + 1, x, y - 1);
  }
  for (let i = 0; i < cells.length; i += 2) {
    const x = cells[i], y = cells[i + 1];
    const bx = (((x - sx) % brush.w) + brush.w) % brush.w, by = (((y - sy) % brush.h) + brush.h) % brush.h;
    const t = brushTile(brush, by * brush.w + bx, layer.kind, nums);
    if (t) layer.tiles.set(t, (y * W + x) * b);
  }
}

// index byte offset for flags in each tile kind (null: kind has no flags)
const FLAG_OFF = { tiles: 1, game: 1, front: 1, switch: 2 };

// speedup brushes keep their angle in bytes 4-5 (int16, degrees): rotating / flipping the brush turns the arrows
export function speedAngles(brush, fn) {
  if (brush.kind !== 'speedup') return;
  const d = brush.data, v = new DataView(d.buffer, d.byteOffset, d.byteLength);
  for (let i = 0; i < brush.w * brush.h; i++) {
    if (!d[i * 6 + 2]) continue;
    v.setInt16(i * 6 + 4, normAngle(fn(v.getInt16(i * 6 + 4, true))), true);
  }
}
export const normAngle = (a) => ((Math.round(a) % 360) + 360) % 360;

export function flipBrush(brush, horizontal) {
  const b = TILE_BYTES[brush.kind];
  const out = new Uint8Array(brush.data.length);
  for (let y = 0; y < brush.h; y++) {
    for (let x = 0; x < brush.w; x++) {
      const sx = horizontal ? brush.w - 1 - x : x, sy = horizontal ? y : brush.h - 1 - y;
      out.set(brush.data.subarray((sy * brush.w + sx) * b, (sy * brush.w + sx + 1) * b), (y * brush.w + x) * b);
    }
  }
  const fo = FLAG_OFF[brush.kind];
  if (fo !== undefined) {
    for (let i = 0; i < brush.w * brush.h; i++) {
      let f = out[i * b + fo];
      // DDNet: flipping a rotated tile flips the other axis
      if (horizontal) f ^= f & 8 ? 2 : 1;
      else f ^= f & 8 ? 1 : 2;
      out[i * b + fo] = f;
    }
  }
  brush.data = out;
  speedAngles(brush, (a) => (horizontal ? 180 - a : -a));
}

// rotate 90 degrees clockwise (cw) or counter-clockwise
export function rotateBrush(brush, cw) {
  const b = TILE_BYTES[brush.kind];
  const W = brush.w, H = brush.h;
  const out = new Uint8Array(brush.data.length);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      // new size H x W
      const nx = cw ? H - 1 - y : y, ny = cw ? x : W - 1 - x;
      out.set(brush.data.subarray((y * W + x) * b, (y * W + x + 1) * b), (ny * H + nx) * b);
    }
  }
  const fo = FLAG_OFF[brush.kind];
  if (fo !== undefined) {
    for (let i = 0; i < W * H; i++) {
      let f = out[i * b + fo];
      if (cw) {
        if (f & 8) f ^= 3;
        f ^= 8;
      } else {
        if (!(f & 8)) f ^= 3;
        f ^= 8;
      }
      out[i * b + fo] = f;
    }
  }
  brush.data = out;
  brush.w = H;
  brush.h = W;
  speedAngles(brush, (a) => a + (cw ? 90 : -90)); // game physics: 0 right, 90 down
}

export function resizeLayer(layer, w, h, ox = 0, oy = 0) {
  const b = TILE_BYTES[layer.kind];
  const out = new Uint8Array(w * h * b);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const sx = x - ox, sy = y - oy;
      if (sx < 0 || sy < 0 || sx >= layer.width || sy >= layer.height) continue;
      out.set(layer.tiles.subarray((sy * layer.width + sx) * b, (sy * layer.width + sx + 1) * b), (y * w + x) * b);
    }
  }
  layer.tiles = out;
  layer.width = w;
  layer.height = h;
}

// A group that lines up with the game layer: parallax 100 and no offset.
export const alignedGroup = (g) => g.parallaxX === 100 && g.parallaxY === 100 && (g.offsetX | 0) === 0 && (g.offsetY | 0) === 0;
const isPhysics = (l) => l.type === 'tiles' && l.kind !== 'tiles';

// The layers that change size together with L: all physics layers when L is one (DDNet keeps them the same size),
// and with `linked` every tile layer of the same size that lines up with L (aligned groups, or L's own group).
export function sizeLinked(map, L, linked) {
  const home = map.groups.find((g) => g.layers.includes(L));
  const groups = home && alignedGroup(home) ? map.groups.filter(alignedGroup) : [home].filter(Boolean);
  const set = new Set([L]);
  if (isPhysics(L)) for (const g of map.groups) for (const l of g.layers) if (isPhysics(l)) set.add(l);
  if (linked) for (const g of groups) for (const l of g.layers) if (l.type === 'tiles' && l.width === L.width && l.height === L.height) set.add(l);
  if ([...set].some(isPhysics)) for (const g of map.groups) for (const l of g.layers) if (isPhysics(l)) set.add(l);
  return { layers: [...set], groups, home };
}

// Where the old tiles land in the new size: anchor 0 keeps the left / top edge, 1 grows on both sides, 2 keeps the right / bottom edge.
export function sizeOffset(oldW, oldH, w, h, ax, ay) {
  const o = (d, a) => (a === 0 ? 0 : a === 2 ? d : Math.floor(d / 2));
  return [o(w - oldW, ax), o(h - oldH, ay)];
}

// Resizes L (and the layers that go with it) to w x h, growing on the sides the anchor says, so that what is
// already built stays where it is in the map: when the resized layers grow left / up their tiles move right / down,
// and everything else moves with them (other layers of the same groups get the same columns / rows added, quads and
// sound sources move, other groups get their offset changed by the parallax share of the move, clip rects move).
// Returns the world move [dx, dy] in pixels (the camera follows it), or null when the layer only grew right / down.
export function resizeTileLayers(map, L, w, h, ax, ay, linked) {
  const { layers, groups, home } = sizeLinked(map, L, linked);
  const [ox, oy] = sizeOffset(L.width, L.height, w, h, ax, ay);
  for (const l of layers) resizeLayer(l, w, h, ox, oy);
  if (!ox && !oy) return null;
  const dx = ox * 32, dy = oy * 32;
  const done = new Set(layers);
  for (const g of groups) {
    for (const l of g.layers) {
      if (done.has(l)) continue;
      if (l.type === 'tiles') resizeLayer(l, Math.max(1, l.width + ox), Math.max(1, l.height + oy), ox, oy);
      else if (l.type === 'quads') for (const q of l.quads) moveQuad(q, dx, dy);
      else if (l.type === 'sounds') for (const s of l.sources) { s.x += dx; s.y += dy; }
    }
  }
  if (!alignedGroup(home)) {
    // a group of its own: its offset takes the move, nothing else changes
    home.offsetX = (home.offsetX | 0) + dx; home.offsetY = (home.offsetY | 0) + dy;
    return null;
  }
  // the whole world moved by (dx, dy): groups that do not line up with the game layer follow by their parallax
  for (const g of map.groups) {
    if (!groups.includes(g)) {
      g.offsetX = Math.round((g.offsetX | 0) - dx * (g.parallaxX / 100));
      g.offsetY = Math.round((g.offsetY | 0) - dy * (g.parallaxY / 100));
    }
    if (g.clipping) { g.clipX += dx; g.clipY += dy; }
  }
  return [dx, dy];
}

// ------------------------------------------------------------------ quads

export function quadCenter(q) {
  return q.points[4];
}

function triContains(p, a, b, c) {
  const s = (p1, p2, p3) => (p1[0] - p3[0]) * (p2[1] - p3[1]) - (p2[0] - p3[0]) * (p1[1] - p3[1]);
  const d1 = s(p, a, b), d2 = s(p, b, c), d3 = s(p, c, a);
  const neg = d1 < 0 || d2 < 0 || d3 < 0, pos = d1 > 0 || d2 > 0 || d3 > 0;
  return !(neg && pos);
}

export function quadContains(q, p) {
  const P = q.points;
  return triContains(p, P[0], P[1], P[3]) || triContains(p, P[0], P[3], P[2]);
}

export function moveQuad(q, dx, dy) {
  for (const p of q.points) { p[0] += dx; p[1] += dy; }
}

export function quadBounds(q) {
  const xs = q.points.slice(0, 4).map((p) => p[0]), ys = q.points.slice(0, 4).map((p) => p[1]);
  return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
}

// DDNet "Square": make the quad an axis-aligned rectangle from its bounds
export function squareQuad(q) {
  const [x0, y0, x1, y1] = quadBounds(q);
  q.points[0] = [x0, y0]; q.points[1] = [x1, y0]; q.points[2] = [x0, y1]; q.points[3] = [x1, y1];
}

export function alignQuad(q, grid) {
  for (let i = 0; i < 5; i++) {
    q.points[i][0] = Math.round(q.points[i][0] / grid) * grid;
    q.points[i][1] = Math.round(q.points[i][1] / grid) * grid;
  }
}

export function rotateQuad(q, deg) {
  const [cx, cy] = q.points[4];
  const a = (deg * Math.PI) / 180, c = Math.cos(a), s = Math.sin(a);
  for (let i = 0; i < 4; i++) {
    const [x, y] = q.points[i];
    q.points[i] = [cx + (x - cx) * c - (y - cy) * s, cy + (x - cx) * s + (y - cy) * c];
  }
}

export function flipQuad(q, horizontal) {
  const [cx, cy] = q.points[4];
  for (let i = 0; i < 4; i++) {
    if (horizontal) q.points[i][0] = 2 * cx - q.points[i][0];
    else q.points[i][1] = 2 * cy - q.points[i][1];
  }
}

// a copy of a quad for copy / paste / duplicate / quad brush; an unkeyed timeline move (_pose) stays behind
export function cloneQuad({ _pose, ...q }) {
  return structuredClone(q);
}
