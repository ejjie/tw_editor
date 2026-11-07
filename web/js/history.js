// Undo/redo by snapshots. A step captures the state of one scope before and after an edit:
//   layer     - one layer object (tiles or quads and its properties)
//   structure - groups/layers order and group properties, image/sound lists, envelopes, map info
//   full      - everything (deleting images/envelopes renumbers references in many layers)
//   custom    - state outside the map (the colour palette): target = { snap(), restore(state) }

const LIMIT_BYTES = 400 * 1024 * 1024;

// While a gesture is running (dragging a number field), edits with the same label and target merge into one undo step.
export const gesture = { key: null };

// quads are plain arrays of numbers; copying them by hand is several times faster than structuredClone,
// which matters for quad-art layers with thousands of quads (cloned at the start and end of every drag)
const cloneQuad = ({ _pose, ...q }) => ({ // _pose: an unkeyed timeline move, never part of the map
  ...q,
  points: q.points.map((p) => [p[0], p[1]]),
  colors: q.colors.map((c) => [c[0], c[1], c[2], c[3]]),
  tex: q.tex.map((t) => [t[0], t[1]]),
});

function sameQuads(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const p = a[i], q = b[i];
    if (p.posEnv !== q.posEnv || p.posEnvOffset !== q.posEnvOffset || p.colorEnv !== q.colorEnv || p.colorEnvOffset !== q.colorEnvOffset) return false;
    for (let k = 0; k < 5; k++) if (p.points[k][0] !== q.points[k][0] || p.points[k][1] !== q.points[k][1]) return false;
    for (let k = 0; k < 4; k++) {
      if (p.tex[k][0] !== q.tex[k][0] || p.tex[k][1] !== q.tex[k][1]) return false;
      for (let j = 0; j < 4; j++) if (p.colors[k][j] !== q.colors[k][j]) return false;
    }
  }
  return true;
}

// Editor-only data that modules keep on a layer (never written to the .map), copied with every undo step:
// layer._gores (gores.js), layer._pen (pen.js). applies(layer) says which layers carry it, copy(value) copies it.
const layerExtras = [];
export function registerLayerExtra(key, applies, copy) {
  if (!layerExtras.some((x) => x.key === key)) layerExtras.push({ key, applies, copy });
}

function cloneLayer(l) {
  const c = { ...l };
  delete c._rev;
  if (l.tiles) c.tiles = l.tiles.slice();
  if (l.quads) c.quads = l.quads.map(cloneQuad);
  for (const x of layerExtras) if (x.applies(l)) c[x.key] = x.copy(l[x.key]);
  if (l.sources) c.sources = structuredClone(l.sources);
  if (l.automapper) c.automapper = { ...l.automapper };
  if (l.color) c.color = [...l.color];
  return c;
}

function sizeOf(snap) {
  if (snap.tiles) return snap.tiles.length;
  if (snap.quads) return snap.quads.length * 200;
  if (snap.sources) return snap.sources.length * 100;
  return 4096;
}

function snapStructure(map) {
  return {
    groups: map.groups.map((g) => ({ ref: g, props: { ...g, layers: undefined }, layers: [...g.layers] })),
    images: [...map.images],
    sounds: [...map.sounds],
    envelopes: structuredClone(map.envelopes),
    info: structuredClone(map.info),
  };
}

function restoreStructure(map, s) {
  map.groups = s.groups.map(({ ref, props, layers }) => {
    Object.assign(ref, props);
    ref.layers = [...layers];
    return ref;
  });
  map.images = [...s.images];
  map.sounds = [...s.sounds];
  map.envelopes = structuredClone(s.envelopes);
  map.info = structuredClone(s.info);
}

// timeline edits: the envelopes and the quad layer whose quads got envelopes (target may be null)
function snapAnim(map, layer) {
  return { envelopes: structuredClone(map.envelopes), layer: layer ? cloneLayer(layer) : null };
}

function restoreAnim(map, layer, s) {
  map.envelopes = structuredClone(s.envelopes);
  if (layer && s.layer) { Object.assign(layer, cloneLayer(s.layer)); layer._rev = (layer._rev || 0) + 1; }
}

function snapFull(map) {
  return { structure: snapStructure(map), layers: map.groups.flatMap((g) => g.layers.map((l) => [l, cloneLayer(l)])) };
}

function restoreFull(map, s) {
  restoreStructure(map, s.structure);
  for (const [l, c] of s.layers) { Object.assign(l, cloneLayer(c)); l._rev = (l._rev || 0) + 1; }
}

export class History {
  constructor(onChange) {
    this.undoStack = [];
    this.redoStack = [];
    this.pending = null;
    this.onChange = onChange;
    this.savedMarker = undefined;
  }

  clear() { this.undoStack = []; this.redoStack = []; this.pending = null; this.savedMarker = undefined; this.onChange(); }

  // begin an edit; call commit() when done (drags span many mouse events)
  begin(map, scope, label, target) {
    if (this.pending) this.commit();
    const top = this.undoStack[this.undoStack.length - 1];
    if (gesture.key && top && top.gesture === gesture.key && top.label === label && top.scope === scope && top.target === target && !this.redoStack.length) {
      this.undoStack.pop();
      this.pending = top;
      return;
    }
    let before;
    if (scope === 'layer') before = cloneLayer(target);
    else if (scope === 'structure') before = snapStructure(map);
    else if (scope === 'layers') before = target.map((l) => [l, cloneLayer(l)]);
    else if (scope === 'anim') before = snapAnim(map, target);
    else if (scope === 'custom') before = target.snap();
    else before = snapFull(map);
    this.pending = { map, scope, label, target, before, gesture: gesture.key };
  }

  commit() {
    const p = this.pending;
    if (!p) return;
    this.pending = null;
    if (p.scope === 'layer') p.after = cloneLayer(p.target);
    else if (p.scope === 'structure') p.after = snapStructure(p.map);
    else if (p.scope === 'layers') p.after = p.target.map((l) => [l, cloneLayer(l)]);
    else if (p.scope === 'anim') p.after = snapAnim(p.map, p.target);
    else if (p.scope === 'custom') p.after = p.target.snap();
    else p.after = snapFull(p.map);
    if (p.scope === 'layer' && sameLayer(p.before, p.after)) return;
    if (p.scope === 'custom' && JSON.stringify(p.before) === JSON.stringify(p.after)) return;
    p.bytes = p.scope === 'layer' ? sizeOf(p.before) * 2 : p.scope === 'custom' ? 1024 : 1 << 20;
    this.undoStack.push(p);
    this.redoStack = [];
    let total = this.undoStack.reduce((s, x) => s + x.bytes, 0);
    while (total > LIMIT_BYTES && this.undoStack.length > 1) total -= this.undoStack.shift().bytes;
    this.onChange();
  }

  cancel() { this.pending = null; }

  // one-shot edit
  edit(map, scope, label, target, fn) {
    this.begin(map, scope, label, target);
    try { fn(); } finally { this.commit(); }
  }

  apply(p, which) {
    const s = p[which];
    if (p.scope === 'layer') { Object.assign(p.target, cloneLayer(s)); p.target._rev = (p.target._rev || 0) + 1; }
    else if (p.scope === 'structure') restoreStructure(p.map, s);
    else if (p.scope === 'layers') for (const [l, c] of s) { Object.assign(l, cloneLayer(c)); l._rev = (l._rev || 0) + 1; }
    else if (p.scope === 'anim') restoreAnim(p.map, p.target, s);
    else if (p.scope === 'custom') p.target.restore(s);
    else restoreFull(p.map, s);
  }

  undo() {
    this.commit();
    const p = this.undoStack.pop();
    if (!p) return null;
    this.apply(p, 'before');
    this.redoStack.push(p);
    this.onChange();
    return p;
  }

  redo() {
    const p = this.redoStack.pop();
    if (!p) return null;
    this.apply(p, 'after');
    this.undoStack.push(p);
    this.onChange();
    return p;
  }

  // 'custom' steps (the colour palette) are not part of the map, so they never make it unsaved
  lastMapStep() { for (let i = this.undoStack.length - 1; i >= 0; i--) if (this.undoStack[i].scope !== 'custom') return this.undoStack[i]; return undefined; }
  get dirty() { return this.lastMapStep() !== this.savedMarker; }
  get mapSteps() { return this.undoStack.some((p) => p.scope !== 'custom'); }
  markSaved() { this.savedMarker = this.lastMapStep(); this.onChange(); }
}

function sameLayer(a, b) {
  if (a.tiles && b.tiles) {
    if (a.tiles.length !== b.tiles.length || a.width !== b.width) return false;
    for (let i = 0; i < a.tiles.length; i++) if (a.tiles[i] !== b.tiles[i]) return false;
    const { tiles: _, ...ra } = a, { tiles: __, ...rb } = b;
    return JSON.stringify(ra) === JSON.stringify(rb);
  }
  if (a.quads && b.quads) {
    if (!sameQuads(a.quads, b.quads)) return false;
    const { quads: _, ...ra } = a, { quads: __, ...rb } = b;
    return JSON.stringify(ra) === JSON.stringify(rb);
  }
  return JSON.stringify(a) === JSON.stringify(b);
}
