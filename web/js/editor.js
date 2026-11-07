// Editor core: state, camera, mouse/keyboard on the map view, overlay drawing, file commands.
import { loadMap, saveMap, newMap, newGroup, newTileLayer, newQuadLayer, newSoundLayer, newSoundSource, makeQuad, findGameLayer, fixQuadDiagonal, TILE_BYTES, KIND_NAME } from './map.js';
import { Renderer, displayTile } from './render.js';
import { History } from './history.js';
import * as T from './tools.js';
import { isValidFor } from './tilerules.js';
import { loadRules, runAutomapper } from './automapper.js';
import { contextMenu, confirmBox } from './ui.js';
import { evalEnvelope, CURVE } from './envelope.js';

const TILE = 32;

function inTri(p, a, b, c) {
  const minx = Math.min(a[0], b[0], c[0]), miny = Math.min(a[1], b[1], c[1]);
  const sx = Math.max(a[0], b[0], c[0]) - minx, sy = Math.max(a[1], b[1], c[1]) - miny;
  if (sx < 1e-7 || sy < 1e-7) return false;
  const n = (q) => [(q[0] - minx) / sx, (q[1] - miny) / sy];
  const [A, B, C, P] = [n(a), n(b), n(c), n(p)];
  const ar = (x, y, z) => Math.abs(((y[0] - x[0]) * (z[1] - x[1]) - (z[0] - x[0]) * (y[1] - x[1])) * 0.5);
  const t = ar(A, B, C);
  return t > 0 && Math.abs(ar(P, A, B) + ar(P, B, C) + ar(P, C, A) - t) < 1e-6;
}

export class Editor {
  constructor() {
    this.canvas = document.getElementById('gl');
    this.overlay = document.getElementById('overlay');
    this.octx = this.overlay.getContext('2d');
    this.view = document.getElementById('view');
    this.renderer = new Renderer(this.canvas);
    this.renderer.onTextureLoaded = () => { this.redraw(); this.emit('images'); };
    this.history = new History(() => { this.updateTitle(); this.emit('history'); });
    this.listeners = {};
    this._busy = new Map(); this._busyN = 0;
    this.cam = { x: 0, y: 0, zoom: 1 };
    this.opts = {
      grid: false, gridSize: 1, proof: false, proofMode: 'ingame', animSpeed: 1, rotStep: 90, parallax: true, parallaxZoom: true, clip: true, play: false, dimOthers: false,
      entitiesAlpha: 1, showEntities: true, destructive: true, tileInfo: 0, entities: 'DDNet', background: [0.29, 0.42, 0.56, 1], time: 0,
    };
    this.nums = { destructive: true, tele: 1, teleCheckpoint: 1, switch: 1, switchDelay: 0, tune: 1, speedForce: 50, speedMax: 0, speedAngle: 0, allowUnused: false };
    this.sel = { g: 0, l: 0 };
    this.quadSel = new Set();
    this.pointSel = new Set(); // "quad:corner"
    this.sourceSel = -1;
    this.brush = null;
    this.quadClipboard = null;
    this.quadBrush = null; // { quads (relative to 0,0), rev }
    this.freeRot = null;
    this.freeScale = null;
    // timeline state (timeline.js): open, selected key points, curve of new keys. Without the timeline it stays off,
    // and quads are never given unkeyed moves (_pose)
    this.anim = { on: false, keySel: new Set(), curve: CURVE.LINEAR };
    this.multi = new Set(); // more tile layers of the selected group edited together with the selected one (Ctrl/Shift+click)
    this.rules = new Map(); // image name -> parsed automapper configs (null while loading)
    this.drag = null;
    this.mouse = { sx: 0, sy: 0, inside: false };
    this.picker = { open: false, sticky: false, drag: null, hover: null };
    this.fileName = 'untitled.map';
    this.fileHandle = null;
    this.playStart = performance.now();
    this.needsDraw = true;
    // Hook points for the optional modules (features.js). Every one of them may stay empty: the core never needs them.
    this.features = new Set(); // ids of the modules that loaded
    this.commands = {};        // toolbar / menu commands by data-cmd name (main.js fills the core ones)
    this.pen = null;           // the quad pen (pen.js) takes over the mouse on quads layers while it is on
    this.ext = {
      tileEdit: [],     // (layer, rect, fn) => result: wraps every tile edit (Gores mode)
      overlays: [],     // (ctx, w, h) => void: drawn first on the overlay canvas (tile numbers)
      quadOverlays: [], // (ctx, layer, S) => void: drawn on a quads layer before the quad outlines (motion paths)
      keys: [],         // (event, key, mod) => true when handled (pen, timeline, gores)
      layerActions: [], // (layer) => element or null: big buttons on top of the layer sheet (Design it!)
      saveTargets: [],  // { matches(fileHandle), save(ed, fileHandle) -> { label } }: where Ctrl+S writes (for modules)
      tabs: new Map(),  // bottom panel tabs: name -> { title, render(ed, root), refreshOn: [events], onShow(open) }
      help: [],         // [keys, text] rows for the Shortcuts window
    };
    this.setMap(newMap(), 'untitled.map');
    this.bindView();
    requestAnimationFrame(() => this.frame());
  }

  // ---------------------------------------------------------------- events

  on(name, fn) { (this.listeners[name] ||= []).push(fn); }
  emit(name) { for (const fn of this.listeners[name] || []) fn(); this.redraw(); }
  redraw() { this.needsDraw = true; }
  status(msg) { document.getElementById('st-msg').textContent = msg; clearTimeout(this._stT); this._stT = setTimeout(() => (document.getElementById('st-msg').textContent = ''), 6000); }

  // a spinner with a label in the status bar while something runs; returns the function that hides it again
  busyStart(msg) {
    const id = ++this._busyN;
    this._busy.set(id, msg);
    this.showBusy();
    return () => { this._busy.delete(id); this.showBusy(); };
  }
  showBusy() {
    const el = document.getElementById('st-busy');
    if (!el) return;
    const msgs = [...this._busy.values()];
    el.hidden = !msgs.length;
    el.lastChild.textContent = msgs[msgs.length - 1] || '';
    document.body.classList.toggle('busy', msgs.length > 0);
  }
  // run fn with the spinner shown; the spinner gets one frame to appear before heavy work blocks the page
  async busy(msg, fn) {
    const done = this.busyStart(msg);
    try {
      await new Promise((r) => requestAnimationFrame(() => setTimeout(r, 0)));
      return await fn();
    } finally { done(); }
  }

  // ---------------------------------------------------------------- map & selection

  setMap(map, name) {
    this.map = map;
    this.fileName = name;
    this.brush = null;
    this.quadSel.clear();
    this.pointSel.clear();
    this.history.clear();
    const gl = findGameLayer(map);
    if (gl) {
      this.sel = { g: map.groups.indexOf(gl.group), l: gl.group.layers.indexOf(gl.layer) };
      this.cam = { x: (gl.layer.width * TILE) / 2, y: (gl.layer.height * TILE) / 2, zoom: 1 };
      this.fitView(gl.layer);
    } else this.sel = { g: 0, l: map.groups[0] && map.groups[0].layers.length ? 0 : -1 };
    this.updateTitle();
    this.emit('map');
  }

  fitView(layer) {
    const r = this.view.getBoundingClientRect();
    if (!r.width) return;
    const z = Math.min(r.width / (layer.width * TILE), r.height / (layer.height * TILE)) * 0.95;
    this.cam.zoom = Math.max(0.05, Math.min(4, z));
  }

  get group() { return this.map.groups[this.sel.g] || null; }
  get layer() { const g = this.group; return g && this.sel.l >= 0 ? g.layers[this.sel.l] || null : null; }

  select(g, l) {
    if (this.drag) return;
    this.sel = { g, l };
    this.multi.clear();
    this.sourceSel = -1;
    this.knife = null;
    this.quadSel.clear();
    this.pointSel.clear();
    const L = this.layer;
    if (this.brush && L && L.type === 'tiles' && this.brush.kind !== L.kind && !this.brush.fromPicker) {
      // a copied brush only fits layers of the same kind, like in DDNet
      if (!(this.brush.kind === 'tiles') !== !(L.kind === 'tiles')) this.brush = null;
    }
    if (L && L.type !== 'tiles') this.brush = null;
    if (this.freeRot) this.endFreeRotate(false);
    if (this.freeScale) this.endFreeScale(false);
    if (this.pen) { this.pen.reset(); if (this.pen.on && !(L && L.type === 'quads')) this.pen.setOn(false); }
    this.closePicker();
    this.emit('selection');
  }

  touch(layer) { layer._rev = (layer._rev || 0) + 1; this.redraw(); }

  // ---------------------------------------------------------------- several tile layers at once

  // Ctrl/Shift+click on a tile layer of the selected group adds it to (or takes it out of) the edited layers
  toggleMulti(gi, li) {
    const L = this.layer, g = this.map.groups[gi], other = g && g.layers[li];
    if (!other || other.type !== 'tiles') { this.status('Only tile layers can be edited together'); return; }
    if (!L || L.type !== 'tiles' || gi !== this.sel.g) { this.select(gi, li); return; }
    if (other === L) {
      // the main layer leaves the set: the next one becomes the main layer
      const next = [...this.multi][0];
      if (!next) return;
      this.multi.delete(next);
      this.sel = { g: gi, l: g.layers.indexOf(next) };
    } else if (this.multi.has(other)) this.multi.delete(other);
    else this.multi.add(other);
    this.status(this.multi.size ? `${this.multi.size + 1} tile layers are edited together (select, brush, fill, erase)` : 'One layer selected');
    this.emit('selection');
  }

  // the tile layers an edit goes to: the selected one first, then the others picked with Ctrl/Shift+click
  tileTargets() {
    const L = this.layer, g = this.group;
    if (!L || L.type !== 'tiles') return [];
    return [L, ...[...this.multi].filter((l) => l !== L && l.type === 'tiles' && g.layers.includes(l))];
  }

  // the brush part for one layer: a brush copied from several layers keeps one part per layer;
  // any other brush (picker, single layer) is used for every layer
  brushFor(layer) {
    const b = this.brush;
    if (!b) return null;
    if (b.parts) return b.parts.get(layer) || (this.tileTargets().length === 1 ? b : null); // back on one layer: the main part
    return b;
  }

  // one undo step for all edited tile layers; fn(layer, brush) runs per layer
  editTiles(label, fn) {
    const T_ = this.tileTargets();
    if (!T_.length) return;
    this.history.edit(this.map, T_.length > 1 ? 'layers' : 'layer', label, T_.length > 1 ? T_ : T_[0], () => { for (const l of T_) fn(l, this.brushFor(l)); });
    for (const l of T_) this.touch(l);
  }

  // brush parts other than the main brush (flip and rotate turn all of them)
  brushParts() { return this.brush && this.brush.parts ? [...this.brush.parts.values()].filter((p) => p !== this.brush) : []; }

  // ---------------------------------------------------------------- coordinates

  vp() { const r = this.view.getBoundingClientRect(); return [r.width, r.height]; }

  groupCam(g) { return this.renderer.groupCam(g, this.cam, this.opts.parallax, this.opts.parallaxZoom); }
  gzoom(g = this.group) { return g ? this.groupCam(g)[2] : this.cam.zoom; }

  screenToWorld(sx, sy, g = this.group) {
    const [w, h] = this.vp();
    const gc = g ? this.groupCam(g) : [this.cam.x, this.cam.y, this.cam.zoom];
    return [(sx - w / 2) / gc[2] + gc[0], (sy - h / 2) / gc[2] + gc[1]];
  }

  worldToScreen(x, y, g = this.group) {
    const [w, h] = this.vp();
    const gc = g ? this.groupCam(g) : [this.cam.x, this.cam.y, this.cam.zoom];
    return [(x - gc[0]) * gc[2] + w / 2, (y - gc[1]) * gc[2] + h / 2];
  }

  mouseTile() {
    const [x, y] = this.screenToWorld(this.mouse.sx, this.mouse.sy);
    return [Math.floor(x / TILE), Math.floor(y / TILE)];
  }

  zoomAt(factor, sx, sy) {
    const g = this.group;
    const before = this.screenToWorld(sx, sy, null);
    this.cam.zoom = Math.max(0.02, Math.min(20, this.cam.zoom * factor));
    const after = this.screenToWorld(sx, sy, null);
    this.cam.x += before[0] - after[0];
    this.cam.y += before[1] - after[1];
    void g;
    this.emit('camera');
  }

  // ---------------------------------------------------------------- frame

  frame() {
    const now = performance.now();
    if (this.opts.play) { this.opts.time += (now - (this._lastFrame ?? now)) * this.opts.animSpeed; this.needsDraw = true; }
    this._lastFrame = now;
    if (this.needsDraw) {
      this.needsDraw = false;
      const opts = { ...this.opts, focusLayer: this.layer, preview: this.brushPreview(), quadPreview: this.quadBrushPreview() };
      this.renderer.draw(this.map, this.cam, opts);
      this.drawOverlay();
      if (this.pen) this.pen.drawOverlay(this.octx);
      if (this.picker.open) this.drawPicker();
    }
    requestAnimationFrame(() => this.frame());
  }

  brushPreview() {
    const L0 = this.layer;
    if (!this.brush || !L0 || L0.type !== 'tiles' || !this.mouse.inside || this.picker.open || (this.drag && this.drag.type !== 'paint')) return null;
    const [tx, ty] = this.mouseTile();
    const out = [];
    for (const L of this.tileTargets()) {
      const b = this.brushFor(L);
      if (!b) continue;
      const kind = b.kind;
      const pl = { type: 'tiles', kind, width: b.w, height: b.h, tiles: b.data, color: L.kind === 'tiles' ? L.color : [255, 255, 255, 255], colorEnv: -1, colorEnvOffset: 0, image: L.kind === 'tiles' ? L.image : -1, visible: true, _rev: b._rev || this.brush._rev || 0 };
      if (kind !== 'tiles' && L.kind === 'tiles') pl.kind = 'tiles';
      if (kind === 'tiles' && L.kind !== 'tiles') pl.kind = 'game';
      pl._key = b;
      out.push({ layer: pl, group: this.group, ox: tx * TILE, oy: ty * TILE });
    }
    return out.length ? out : null;
  }

  quadBrushPreview() {
    const L = this.layer, b = this.quadBrush;
    if (!b || !L || L.type !== 'quads' || !this.mouse.inside || this.picker.open || (this.drag && this.drag.type !== 'qpaint')) return null;
    const [ox, oy] = this.quadBrushPos();
    b.layer ||= { type: 'quads', quads: b.quads, visible: true };
    b.layer.image = L.image;
    b.layer._rev = b.rev;
    return { layer: b.layer, group: this.group, ox, oy };
  }

  quadBrushPos() {
    let [wx, wy] = this.screenToWorld(this.mouse.sx, this.mouse.sy);
    return [Math.round(this.snap(wx)), Math.round(this.snap(wy))];
  }

  // ---------------------------------------------------------------- overlay

  drawOverlay() {
    const c = this.overlay, ctx = this.octx;
    const dpr = window.devicePixelRatio || 1;
    const [w, h] = this.vp();
    if (c.width !== Math.round(w * dpr) || c.height !== Math.round(h * dpr)) { c.width = Math.round(w * dpr); c.height = Math.round(h * dpr); }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    const g = this.group, L = this.layer, z = this.gzoom();
    if (!g) return;
    const S = (x, y) => this.worldToScreen(x, y, g);
    for (const fn of this.ext.overlays) fn(ctx, w, h);

    if (g.clipping) {
      // clip rect is in game group coordinates (DDNet), not in the group's own parallax space
      const [x0, y0] = this.worldToScreen(g.clipX, g.clipY, null), cz = this.cam.zoom;
      ctx.setLineDash([6, 4]);
      ctx.strokeStyle = '#ff5050';
      ctx.strokeRect(x0, y0, g.clipW * cz, g.clipH * cz);
      ctx.setLineDash([]);
    }

    if (this.opts.grid) this.drawGrid(ctx, g, w, h);
    if (L && L.type === 'tiles') {
      const [x0, y0] = S(0, 0);
      const lw = L.width * TILE * z, lh = L.height * TILE * z;
      ctx.strokeStyle = '#ffffffaa';
      ctx.lineWidth = 1.5;
      ctx.strokeRect(x0, y0, lw, lh);
      ctx.lineWidth = 1;
      // new size while it is being typed in the layer properties
      const sp = this.sizePreview;
      if (sp && sp.layer === L) {
        const [px, py] = S(-sp.ox * TILE, -sp.oy * TILE);
        ctx.save();
        ctx.lineWidth = 2;
        ctx.strokeStyle = 'rgba(0,0,0,.6)';
        ctx.strokeRect(px + 1.5, py + 1.5, sp.w * TILE * z, sp.h * TILE * z);
        ctx.strokeStyle = '#fff';
        ctx.setLineDash([8, 5]);
        ctx.strokeRect(px, py, sp.w * TILE * z, sp.h * TILE * z);
        ctx.restore();
      }

      // the frame at the cursor shows the brush size; without a brush there is nothing to show
      if (this.brush && this.mouse.inside && !this.picker.open) {
        const [tx, ty] = this.mouseTile();
        const bw = this.brush.w, bh = this.brush.h;
        const [hx, hy] = S(tx * TILE, ty * TILE);
        ctx.strokeStyle = '#ffffff';
        ctx.strokeRect(hx, hy, bw * TILE * z, bh * TILE * z);
      }
      const d = this.drag;
      if (d && (d.type === 'select' || d.type === 'fill')) {
        const [tx, ty] = this.mouseTile();
        const rx = Math.min(d.tx, tx), ry = Math.min(d.ty, ty), rw = Math.abs(tx - d.tx) + 1, rh = Math.abs(ty - d.ty) + 1;
        const [a, b] = S(rx * TILE, ry * TILE);
        ctx.fillStyle = d.type === 'fill' ? 'rgba(255,180,70,0.25)' : 'rgba(90,160,255,0.25)';
        ctx.fillRect(a, b, rw * TILE * z, rh * TILE * z);
        ctx.strokeStyle = d.type === 'fill' ? '#ffb347' : '#5aa0ff';
        ctx.strokeRect(a, b, rw * TILE * z, rh * TILE * z);
        ctx.fillStyle = '#fff';
        ctx.font = '12px sans-serif';
        ctx.fillText(`${rw}×${rh}`, a + 4, b - 4);
      }
    }

    if (L && L.type === 'tiles' && this.opts.tileInfo && TILE * z >= 18) this.drawTileInfo(ctx, L, S, z, w, h);

    if (this.pipette) {
      ctx.fillStyle = '#fff';
      ctx.font = '12px sans-serif';
      ctx.fillText('Picker: click a colour', this.mouse.sx + 14, this.mouse.sy + 4);
    }

    if (L && L.type === 'quads' && !this.pen?.on) {
      const quads = L.quads;
      const many = quads.length > 3000;
      for (const fn of this.ext.quadOverlays) fn(ctx, L, S);
      for (let i = 0; i < quads.length; i++) {
        const q = quads[i];
        const sel = this.quadSel.has(i);
        const Q = this.shown(q);
        if (sel || (!many && this.opts.grid)) {
          const P = Q.map(([x, y]) => S(x, y));
          ctx.beginPath();
          ctx.moveTo(...P[0]); ctx.lineTo(...P[1]); ctx.lineTo(...P[3]); ctx.lineTo(...P[2]); ctx.closePath();
          ctx.strokeStyle = sel ? '#ffd24a' : 'rgba(255,255,255,0.25)';
          ctx.stroke();
        }
        if (!many || sel) {
          const [px, py] = S(...Q[4]);
          ctx.fillStyle = q._pose ? '#ff9f1a' : sel ? '#ffffff' : '#3fe06a'; // orange: moved on the timeline, not keyed yet
          ctx.fillRect(px - 3, py - 3, 6, 6);
          if (sel) {
            for (let k = 0; k < 4; k++) {
              const [cx, cy] = S(...Q[k]);
              ctx.fillStyle = this.pointSel.has(i + ':' + k) ? '#ff4040' : '#ffffffcc';
              ctx.fillRect(cx - 4, cy - 4, 8, 8);
              ctx.strokeStyle = '#000';
              ctx.strokeRect(cx - 4, cy - 4, 8, 8);
            }
          }
        }
      }
      if (this.knife) this.drawKnife(ctx, L, S);
      const qb = this.quadBrushPreview();
      if (qb) {
        ctx.save();
        ctx.setLineDash([5, 4]);
        ctx.strokeStyle = '#ffd38a';
        for (const q of this.quadBrush.quads) {
          const v = [0, 1, 3, 2].map((k) => S(q.points[k][0] + qb.ox, q.points[k][1] + qb.oy));
          ctx.beginPath(); ctx.moveTo(...v[0]); v.slice(1).forEach((p) => ctx.lineTo(...p)); ctx.closePath(); ctx.stroke();
        }
        ctx.restore();
      }
      if (this.freeRot) {
        ctx.fillStyle = '#fff';
        ctx.font = '12px sans-serif';
        ctx.fillText(`${this.freeRot.shown.toFixed(1)}°  (click / release R: apply, RMB / Esc: cancel)`, this.mouse.sx + 14, this.mouse.sy - 10);
      }
      if (this.freeScale) {
        const s = this.freeScale;
        const [px, py] = S(s.pivot[0], s.pivot[1]);
        ctx.strokeStyle = '#fff'; ctx.lineWidth = 1;
        ctx.beginPath(); ctx.moveTo(px - 6, py); ctx.lineTo(px + 6, py); ctx.moveTo(px, py - 6); ctx.lineTo(px, py + 6); ctx.stroke();
        ctx.fillStyle = '#fff';
        ctx.font = '12px sans-serif';
        ctx.fillText(`${Math.round(s.shown * 100)}%  (click / release S: apply, RMB / Esc: cancel)`, this.mouse.sx + 14, this.mouse.sy - 10);
      }
      const d = this.drag;
      if (d && d.type === 'box') {
        ctx.strokeStyle = '#5aa0ff';
        ctx.fillStyle = 'rgba(90,160,255,0.15)';
        const x = Math.min(d.sx, this.mouse.sx), y = Math.min(d.sy, this.mouse.sy);
        ctx.fillRect(x, y, Math.abs(this.mouse.sx - d.sx), Math.abs(this.mouse.sy - d.sy));
        ctx.strokeRect(x, y, Math.abs(this.mouse.sx - d.sx), Math.abs(this.mouse.sy - d.sy));
      }
      if (this.quadClipboard && this.drag === null && this.mouse.inside && this.pasteMode) {
        ctx.fillStyle = '#fff';
        ctx.fillText('Click: paste quads', this.mouse.sx + 12, this.mouse.sy + 4);
      }
    }

    if (L && L.type === 'sounds') {
      L.sources.forEach((src, i) => {
        const [px, py] = S(src.x, src.y);
        const sel = i === this.sourceSel;
        ctx.strokeStyle = sel ? '#ffd24a' : 'rgba(150,200,255,0.8)';
        ctx.fillStyle = 'rgba(150,200,255,0.12)';
        const f = src.falloff / 255;
        ctx.beginPath();
        if (src.shape === 'circle') ctx.arc(px, py, src.radius * z, 0, Math.PI * 2);
        else ctx.rect(px - (src.w * z) / 2, py - (src.h * z) / 2, src.w * z, src.h * z);
        ctx.fill(); ctx.stroke();
        if (f > 0) {
          ctx.setLineDash([4, 4]);
          ctx.beginPath();
          if (src.shape === 'circle') ctx.arc(px, py, src.radius * z * f, 0, Math.PI * 2);
          else ctx.rect(px - (src.w * z * f) / 2, py - (src.h * z * f) / 2, src.w * z * f, src.h * z * f);
          ctx.stroke();
          ctx.setLineDash([]);
        }
        ctx.fillStyle = sel ? '#ffd24a' : '#9fd0ff';
        ctx.beginPath(); ctx.arc(px, py, 7, 0, Math.PI * 2); ctx.fill();
        ctx.fillStyle = '#000'; ctx.font = '10px sans-serif'; ctx.fillText('♪', px - 3, py + 4);
      });
    }

    if (this.opts.proof) {
      // DDNet in-game view size for the current aspect (CalcScreenParams, zoom 1)
      // menu mode: the menu background camera uses zoom 0.7, positions come from time checkpoint tiles (35..59)
      const menu = this.opts.proofMode === 'menu';
      const aspect = w / h;
      let f = Math.sqrt(1150 * 1000) / Math.sqrt(aspect), vw = f * aspect, vh = f;
      if (vw > 1500) { vw = 1500; vh = vw / aspect; }
      if (vh > 1050) { vh = 1050; vw = vh * aspect; }
      if (menu) { vw *= 0.7; vh *= 0.7; }
      ctx.strokeStyle = menu ? '#30ff60' : '#ff3030';
      ctx.lineWidth = 2;
      const cz = this.cam.zoom;
      ctx.strokeRect(w / 2 - (vw * cz) / 2, h / 2 - (vh * cz) / 2, vw * cz, vh * cz);
      if (menu) {
        const game = findGameLayer(this.map);
        if (game) {
          const G = game.layer;
          ctx.fillStyle = 'rgba(0,255,0,0.3)';
          for (let i = 0; i < G.width * G.height; i++) {
            const t = G.tiles[i * 4];
            if (t < 35 || t > 59) continue;
            const [sx, sy] = this.worldToScreen((i % G.width) * TILE + 16, Math.floor(i / G.width) * TILE + 16, game.group);
            ctx.beginPath(); ctx.arc(sx, sy - 3 * cz, 20 * cz, 0, Math.PI * 2); ctx.fill();
          }
        }
      }
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(w / 2 - 6, h / 2); ctx.lineTo(w / 2 + 6, h / 2); ctx.moveTo(w / 2, h / 2 - 6); ctx.lineTo(w / 2, h / 2 + 6);
      ctx.stroke();
    }
  }

  // tile grid of the selected group over the whole view, aligned to the world origin like in DDNet;
  // thin lines fade out when they get dense, every 16th line is red
  drawGrid(ctx, g, w, h) {
    const z = this.gzoom(g), cell = TILE * this.opts.gridSize, step = cell * z;
    const [ax, ay] = this.screenToWorld(0, 0, g), [bx, by] = this.screenToWorld(w, h, g);
    const lines = (every, color, alpha) => {
      if (alpha <= 0.01) return;
      const st = cell * every;
      ctx.beginPath();
      for (let i = Math.floor(ax / st); i * st <= bx; i++) { const x = Math.round(this.worldToScreen(i * st, 0, g)[0]) + 0.5; ctx.moveTo(x, 0); ctx.lineTo(x, h); }
      for (let i = Math.floor(ay / st); i * st <= by; i++) { const y = Math.round(this.worldToScreen(0, i * st, g)[1]) + 0.5; ctx.moveTo(0, y); ctx.lineTo(w, y); }
      ctx.strokeStyle = color.replace('A', alpha.toFixed(3));
      ctx.lineWidth = 1;
      ctx.stroke();
    };
    const fine = this.gridStep(g);
    if (fine < cell) lines(fine / cell, 'rgba(255,255,255,A)', 0.07);
    lines(1, 'rgba(255,255,255,A)', Math.min(1, Math.max(0, (step - 5) / 15)) * 0.2);
    lines(16, 'rgba(255,90,90,A)', Math.min(1, Math.max(0, (step * 16 - 8) / 30)) * 0.45);
  }

  drawTileInfo(ctx, L, S, z, w, h) {
    const [ax, ay] = this.screenToWorld(0, 0), [bx, by] = this.screenToWorld(w, h);
    const x0 = Math.max(0, Math.floor(ax / TILE)), y0 = Math.max(0, Math.floor(ay / TILE));
    const x1 = Math.min(L.width - 1, Math.floor(bx / TILE)), y1 = Math.min(L.height - 1, Math.floor(by / TILE));
    const hex = this.opts.tileInfo === 2;
    const fmt = (v) => (hex ? v.toString(16).toUpperCase().padStart(2, '0') : String(v));
    const b = TILE_BYTES[L.kind];
    ctx.font = `${Math.min(14, Math.max(9, TILE * z / 3.2))}px monospace`;
    ctx.textBaseline = 'top';
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        const o = (y * L.width + x) * b;
        const t = L.tiles;
        let lines;
        switch (L.kind) {
          case 'tele': lines = t[o + 1] ? [fmt(t[o])] : null; break;
          case 'switch': lines = t[o + 1] ? [fmt(t[o]), t[o + 3] ? 'd' + t[o + 3] : ''] : null; break;
          case 'tune': lines = t[o + 1] ? [fmt(t[o])] : null; break;
          case 'speedup': lines = t[o + 2] ? [fmt(t[o]), ((((t[o + 4] | (t[o + 5] << 8)) << 16) >> 16)) + '°'] : null; break;
          default: lines = t[o] ? [fmt(t[o]), t[o + 1] ? 'f' + t[o + 1] : ''] : null;
        }
        if (!lines) continue;
        const [sx, sy] = S(x * TILE, y * TILE);
        lines.forEach((ln, i) => {
          if (!ln) return;
          ctx.fillStyle = '#000a';
          ctx.fillText(ln, sx + 3, sy + 3 + i * 12);
          ctx.fillStyle = '#fff';
          ctx.fillText(ln, sx + 2, sy + 2 + i * 12);
        });
      }
    }
    ctx.textBaseline = 'alphabetic';
  }

  // ---------------------------------------------------------------- tile picker

  pickerAtlas() {
    const L = this.layer;
    if (!L || L.type !== 'tiles') return null;
    if (L.kind !== 'tiles') { const at = this.renderer.atlasFor(L.kind); return at ? at.src : null; }
    return L.image >= 0 ? this.imageSource(L.image) : null;
  }

  imageSource(idx) {
    const img = this.map.images[idx];
    if (!img) return null;
    if (img.external) { this.renderer.imageTexture(this.map, idx); return this.renderer.externalImage(img.name); }
    if (!img._canvas || img._canvasRev !== img._rev) {
      const c = document.createElement('canvas');
      c.width = img.width; c.height = img.height;
      c.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(img.rgba.buffer, img.rgba.byteOffset, img.rgba.byteLength).slice(), img.width, img.height), 0, 0);
      img._canvas = c;
      img._canvasRev = img._rev;
    }
    return img._canvas;
  }

  openPicker(sticky = false) {
    const L = this.layer;
    if (!L || L.type !== 'tiles') return;
    this.picker.open = true;
    this.picker.sticky = sticky;
    document.getElementById('picker').hidden = false;
    document.body.classList.add('picking');
    this.redraw();
  }

  closePicker() {
    if (!this.picker.open) return;
    this.picker.open = false;
    this.picker.drag = null;
    document.getElementById('picker').hidden = true;
    document.body.classList.remove('picking');
    this.redraw();
  }

  // the picker sits in the free area under the top bar (the side panels are hidden while it is open)
  pickerRect() {
    const [w, h] = this.vp();
    const bar = document.getElementById('topbar');
    const top = (bar ? bar.getBoundingClientRect().bottom - this.view.getBoundingClientRect().top : 0) + 28;
    const free = Math.max(64, h - top - 16);
    const size = Math.floor(Math.min(w - 32, free) * 0.86 / 16) * 16;
    return { x: Math.round((w - size) / 2), y: Math.round(top + (free - size) / 2), size, cell: size / 16 };
  }

  pickerCell(sx, sy) {
    const r = this.pickerRect();
    const cx = Math.floor((sx - r.x) / r.cell), cy = Math.floor((sy - r.y) / r.cell);
    if (cx < 0 || cy < 0 || cx > 15 || cy > 15) return null;
    return [cx, cy];
  }

  drawPicker() {
    const el = document.getElementById('picker');
    let c = el.querySelector('canvas');
    if (!c) { c = document.createElement('canvas'); el.append(c); }
    const dpr = window.devicePixelRatio || 1;
    const [w, h] = this.vp();
    c.width = Math.round(w * dpr); c.height = Math.round(h * dpr);
    const ctx = c.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const r = this.pickerRect();
    const L = this.layer;
    const atlas = this.pickerAtlas();
    ctx.fillStyle = '#222';
    ctx.fillRect(r.x, r.y, r.size, r.size);
    ctx.imageSmoothingEnabled = r.cell < 64;
    if (atlas) ctx.drawImage(atlas, r.x, r.y, r.size, r.size);
    ctx.strokeStyle = 'rgba(255,255,255,0.15)';
    ctx.beginPath();
    for (let i = 0; i <= 16; i++) {
      ctx.moveTo(r.x + i * r.cell, r.y); ctx.lineTo(r.x + i * r.cell, r.y + r.size);
      ctx.moveTo(r.x, r.y + i * r.cell); ctx.lineTo(r.x + r.size, r.y + i * r.cell);
    }
    ctx.stroke();
    ctx.font = `${Math.max(9, r.cell / 4)}px sans-serif`;
    // physics layers: grey out what the layer does not accept (like DDNet)
    if (L && L.kind !== 'tiles' && !this.nums.allowUnused) {
      ctx.fillStyle = 'rgba(0,0,0,0.6)';
      for (let i = 1; i < 256; i++) if (!isValidFor(L.kind, i)) ctx.fillRect(r.x + (i % 16) * r.cell, r.y + Math.floor(i / 16) * r.cell, r.cell, r.cell);
    }
    if (!atlas) {
      ctx.fillStyle = '#aaa';
      for (let i = 0; i < 256; i++) ctx.fillText(String(i), r.x + (i % 16) * r.cell + 3, r.y + Math.floor(i / 16) * r.cell + r.cell / 2);
    }
    const hv = this.pickerCell(this.mouse.sx, this.mouse.sy);
    const d = this.picker.drag;
    if (d && hv) {
      const x0 = Math.min(d[0], hv[0]), y0 = Math.min(d[1], hv[1]), x1 = Math.max(d[0], hv[0]), y1 = Math.max(d[1], hv[1]);
      ctx.fillStyle = 'rgba(90,160,255,0.35)';
      ctx.fillRect(r.x + x0 * r.cell, r.y + y0 * r.cell, (x1 - x0 + 1) * r.cell, (y1 - y0 + 1) * r.cell);
    } else if (hv) {
      ctx.strokeStyle = '#fff';
      ctx.lineWidth = 2;
      ctx.strokeRect(r.x + hv[0] * r.cell, r.y + hv[1] * r.cell, r.cell, r.cell);
      ctx.lineWidth = 1;
      ctx.fillStyle = '#fff';
      ctx.fillText(`#${hv[1] * 16 + hv[0]}`, r.x + 4, r.y - 6);
    }
  }

  // ---------------------------------------------------------------- mouse

  bindView() {
    const v = this.canvas;
    const pos = (e) => { const r = this.view.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top]; };
    v.addEventListener('contextmenu', (e) => e.preventDefault());
    document.getElementById('picker').addEventListener('contextmenu', (e) => e.preventDefault());
    const onDown = (e) => {
      [this.mouse.sx, this.mouse.sy] = pos(e);
      document.activeElement && document.activeElement.blur && document.activeElement !== document.body && document.activeElement.blur();
      this.onMouseDown(e);
    };
    v.addEventListener('mousedown', onDown);
    document.getElementById('picker').addEventListener('mousedown', onDown);
    window.addEventListener('mousemove', (e) => {
      const [x, y] = pos(e);
      const r = this.view.getBoundingClientRect();
      this.mouse.inside = e.clientX >= r.left && e.clientX < r.right && e.clientY >= r.top && e.clientY < r.bottom;
      const dx = x - this.mouse.sx, dy = y - this.mouse.sy;
      this.mouse.sx = x; this.mouse.sy = y;
      this.onMouseMove(e, dx, dy);
      this.updateStatus();
      this.redraw();
    });
    window.addEventListener('mouseup', (e) => { [this.mouse.sx, this.mouse.sy] = pos(e); this.onMouseUp(e); });
    v.addEventListener('wheel', (e) => {
      e.preventDefault();
      const [x, y] = pos(e);
      this.zoomAt(e.deltaY < 0 ? 1.15 : 1 / 1.15, x, y);
    }, { passive: false });
    this.view.addEventListener('mouseleave', () => { this.mouse.inside = false; this.redraw(); });
  }

  updateStatus() {
    const [x, y] = this.screenToWorld(this.mouse.sx, this.mouse.sy);
    document.getElementById('st-pos').textContent = `x ${x.toFixed(1)}  y ${y.toFixed(1)}`;
    const L = this.layer;
    let t = `tile ${Math.floor(x / TILE)}, ${Math.floor(y / TILE)}`;
    if (L && L.type === 'tiles') {
      const tx = Math.floor(x / TILE), ty = Math.floor(y / TILE);
      if (tx >= 0 && ty >= 0 && tx < L.width && ty < L.height) {
        const b = TILE_BYTES[L.kind], o = (ty * L.width + tx) * b;
        const v = Array.from(L.tiles.subarray(o, o + b));
        t += `  [${v.join(' ')}]`;
      }
    }
    document.getElementById('st-tile').textContent = t;
  }

  onMouseDown(e) {
    this.anim.focus = false; // Delete in the map deletes quads again, not timeline keys
    const L = this.layer;
    // Alt+LMB pans, except on a quad pen handle (Alt+drag moves that handle alone, Alt+click removes it)
    const penHandle = e.altKey && this.pen && this.pen.on && this.pen.layer && this.pen.hitHandle();
    if (e.button === 1 || (e.button === 0 && e.altKey && !this.knife && !penHandle)) { this.drag = { type: 'pan' }; e.preventDefault(); return; }
    if (this.pipette && e.button === 0) {
      this.pickColor();
      return;
    }
    if (this.picker.open) {
      if (e.button === 0) this.picker.drag = this.pickerCell(this.mouse.sx, this.mouse.sy);
      else if (e.button === 2) this.closePicker();
      return;
    }
    if (e.button === 2 && (e.ctrlKey || e.metaKey) && !this.knife) { this.selectLayerByTile(); return; }
    if (!L || !L.visible) {
      if (e.button === 0) this.drag = { type: 'pan' };
      return;
    }
    if (L.type === 'tiles') this.tileMouseDown(e, L);
    else if (L.type === 'quads') this.quadMouseDown(e, L);
    else if (L.type === 'sounds') this.soundMouseDown(e, L);
    else if (e.button === 0) this.drag = { type: 'pan' };
  }

  tileMouseDown(e, L) {
    const [tx, ty] = this.mouseTile();
    if (e.button === 2) {
      if (this.brush) { this.brush = null; this.emit('brush'); }
      else this.drag = { type: 'select', tx, ty, erase: true };
      return;
    }
    if (e.button !== 0) return;
    if (!this.brush) { this.drag = { type: 'select', tx, ty }; return; }
    if (e.ctrlKey && e.shiftKey) {
      this.editTiles('Flood fill', (l, b) => { if (b) { this.tileEdit(l, null, () => T.floodFill(l, b, tx, ty, this.nums)); this.liveAutomap(l); } });
      return;
    }
    if (e.shiftKey) { this.drag = { type: 'fill', tx, ty }; return; }
    const targets = this.tileTargets();
    this.history.begin(this.map, targets.length > 1 ? 'layers' : 'layer', 'Brush', targets.length > 1 ? targets : L);
    this.drag = { type: 'paint', last: [tx, ty], bounds: [tx, ty, tx + this.brush.w, ty + this.brush.h], targets };
    for (const l of targets) {
      const b = this.brushFor(l);
      if (b && this.tileEdit(l, [tx - b.w, ty - b.h, tx + 2 * b.w, ty + 2 * b.h], () => T.stamp(l, b, tx, ty, this.nums))) this.touch(l);
    }
  }

  quadMouseDown(e, L) {
    if (this.pen && this.pen.on) { this.pen.mouseDown(e, L); return; }
    if (this.freeRot) { this.endFreeRotate(e.button === 0); return; }
    if (this.freeScale) { this.endFreeScale(e.button === 0); return; }
    if (this.quadBrush) {
      if (e.button === 2) { this.clearQuadBrush(); return; }
      if (e.button !== 0) return;
      this.history.begin(this.map, 'layer', 'Quad brush', L);
      const pos = this.quadBrushPos();
      this.stampQuadBrush(L, pos);
      this.drag = { type: 'qpaint', last: pos };
      return;
    }
    if (this.knife) {
      if (e.button === 2) { this.knife = null; this.status('Knife off'); this.redraw(); return; }
      if (e.button === 0) this.knifeClick(L);
      return;
    }
    const [wx, wy] = this.screenToWorld(this.mouse.sx, this.mouse.sy);
    const rad = 7 / this.gzoom();
    if (e.button === 0 && this.pasteMode && this.quadClipboard) { this.pasteQuads(wx, wy); return; }
    // corners of selected quads first
    let hitPoint = null;
    for (const i of this.quadSel) {
      const q = L.quads[i];
      if (!q) continue;
      const P = this.shown(q);
      for (let k = 0; k < 4; k++) if (Math.abs(P[k][0] - wx) < rad && Math.abs(P[k][1] - wy) < rad) hitPoint = [i, k];
    }
    let hitPivot = -1, hitInside = -1;
    for (let i = L.quads.length - 1; i >= 0; i--) {
      const q = L.quads[i], P = this.shown(q);
      if (hitPivot < 0 && Math.abs(P[4][0] - wx) < rad && Math.abs(P[4][1] - wy) < rad) hitPivot = i;
      if (hitInside < 0 && T.quadContains(P === q.points ? q : { points: P }, [wx, wy])) hitInside = i;
    }
    if (e.button === 2) {
      const i = hitPivot >= 0 ? hitPivot : hitInside;
      if (hitPoint) {
        const key = hitPoint[0] + ':' + hitPoint[1];
        if (!this.pointSel.has(key)) { this.pointSel.clear(); this.pointSel.add(key); }
        this.emit('selection');
        this.popups.point(e.clientX, e.clientY);
        return;
      }
      if (i >= 0) {
        if (!this.quadSel.has(i)) { this.quadSel.clear(); this.quadSel.add(i); this.pointSel.clear(); }
        this.emit('selection');
        // DDNet: Shift+right click deletes the quad
        if (e.shiftKey) this.deleteQuads();
        else this.popups.quad(e.clientX, e.clientY);
      } else this.layerContextMenu(e.clientX, e.clientY);
      return;
    }
    if (e.button !== 0) return;
    if (hitPoint) {
      const key = hitPoint[0] + ':' + hitPoint[1];
      // Shift+click toggles the point, but Shift+drag moves the selection along one axis, so removal waits for the release
      let toggleOff = null;
      if (e.shiftKey) { if (this.pointSel.has(key)) toggleOff = key; else this.pointSel.add(key); }
      else if (!this.pointSel.has(key)) { this.pointSel.clear(); this.pointSel.add(key); }
      this.history.begin(this.map, 'layer', 'Move points', L);
      this.drag = { type: 'points', start: [wx, wy], sx: this.mouse.sx, sy: this.mouse.sy, toggleOff, orig: this.snapshotPoints(L), anchor: L.quads[hitPoint[0]].points[hitPoint[1]].slice() };
      this.emit('selection');
      return;
    }
    const hit = hitPivot >= 0 ? hitPivot : hitInside;
    // a press inside an unselected quad (not on its pivot) only selects it on release;
    // dragging from there draws a selection box, so quads covered by big quads can still be box-selected
    if (hitPivot < 0 && hit >= 0 && (!this.quadSel.has(hit) || e.shiftKey)) {
      this.drag = { type: 'pending', hit, sx: this.mouse.sx, sy: this.mouse.sy, shift: e.shiftKey };
      return;
    }
    if (hit >= 0) {
      if (e.shiftKey) { if (this.quadSel.has(hit)) this.quadSel.delete(hit); else this.quadSel.add(hit); }
      else if (!this.quadSel.has(hit)) { this.quadSel.clear(); this.quadSel.add(hit); }
      this.pointSel.clear();
      this.history.begin(this.map, 'layer', 'Move quads', L);
      const pivotOnly = e.ctrlKey && hitPivot >= 0, qp = L.quads[hit].points;
      // with the grid on, the corner nearest to where the quad was grabbed lands on the grid
      const anchor = (pivotOnly ? qp[4] : qp.slice(0, 4).reduce((a, p) => (Math.hypot(p[0] - wx, p[1] - wy) < Math.hypot(a[0] - wx, a[1] - wy) ? p : a))).slice();
      this.drag = { type: 'quads', start: [wx, wy], pivotOnly, orig: this.snapshotQuads(L), anchor, poses: this.posesOf(L) };
      this.emit('selection');
      return;
    }
    if (!e.shiftKey) { this.quadSel.clear(); this.pointSel.clear(); this.emit('selection'); }
    // Shift+drag grabs the quads in the box into a quad brush
    this.drag = { type: 'box', sx: this.mouse.sx, sy: this.mouse.sy, grab: e.shiftKey };
  }

  soundMouseDown(e, L) {
    const [wx, wy] = this.screenToWorld(this.mouse.sx, this.mouse.sy);
    const rad = 10 / this.gzoom();
    let hit = -1;
    L.sources.forEach((s, i) => { if (Math.abs(s.x - wx) < rad && Math.abs(s.y - wy) < rad) hit = i; });
    if (e.button === 2) {
      if (hit >= 0) {
        this.sourceSel = hit;
        this.emit('selection');
        this.popups.source(e.clientX, e.clientY);
      } else contextMenu(e.clientX, e.clientY, [['Add sound source here', () => this.addSource(wx, wy)]]);
      return;
    }
    if (e.button !== 0) return;
    this.sourceSel = hit;
    this.emit('selection');
    if (hit >= 0) {
      this.history.begin(this.map, 'layer', 'Move source', L);
      this.drag = { type: 'source', start: [wx, wy], orig: [L.sources[hit].x, L.sources[hit].y] };
    } else this.drag = { type: 'pan' };
  }

  addSource(x, y, from = null) {
    const L = this.layer;
    if (!L || L.type !== 'sounds') return;
    if (x === undefined) [x, y] = this.screenToWorld(...this.vp().map((v) => v / 2));
    this.history.edit(this.map, 'layer', 'Add source', L, () => {
      const s = from ? structuredClone(from) : newSoundSource(0, 0);
      s.x = Math.round(x); s.y = Math.round(y);
      L.sources.push(s);
      this.sourceSel = L.sources.length - 1;
    });
    this.emit('selection');
  }

  deleteSource() {
    const L = this.layer;
    if (!L || L.type !== 'sounds' || this.sourceSel < 0) return;
    this.history.edit(this.map, 'layer', 'Delete source', L, () => { L.sources.splice(this.sourceSel, 1); this.sourceSel = -1; });
    this.emit('selection');
  }

  // ---------------------------------------------------------------- quad knife (DDNet "Slice")

  startKnife() {
    const L = this.layer;
    if (!L || L.type !== 'quads' || this.quadSel.size !== 1) { this.status('Select exactly one quad for the knife'); return; }
    this.knife = { quad: [...this.quadSel][0], points: [] };
    this.status('Knife: 4 clicks inside the quad define a new piece. Alt: no grid snap. RMB or Esc: exit.');
    this.redraw();
  }

  knifeRing(q) { return [q.points[0], q.points[1], q.points[3], q.points[2]]; }

  knifePoint(L, alt) {
    const q = L.quads[this.knife.quad];
    const v = this.knifeRing(q);
    const mouse = this.screenToWorld(this.mouse.sx, this.mouse.sy);
    const inside = (p) => inTri(p, v[0], v[1], v[2]) || inTri(p, v[0], v[3], v[2]);
    let point = mouse;
    if (this.opts.grid && !alt) {
      const cell = this.gridStep(); // a grid point outside the quad goes to the nearest edge within one grid step
      const g = [this.snap(mouse[0]), this.snap(mouse[1])];
      if (inside(g)) point = g;
      else {
        let best = -1;
        for (let i = 0; i < 4; i++) {
          const a = v[i], b = v[(i + 1) % 4];
          if (g[1] >= Math.min(a[1], b[1]) && g[1] <= Math.max(a[1], b[1]) && Math.abs(b[1] - a[1]) > 1e-7) {
            const e = [a[0] + ((g[1] - a[1]) / (b[1] - a[1])) * (b[0] - a[0]), g[1]];
            const d = Math.abs(g[0] - e[0]);
            if (d < cell && (d < best || best < 0)) { best = d; point = e; }
          }
          if (g[0] >= Math.min(a[0], b[0]) && g[0] <= Math.max(a[0], b[0]) && Math.abs(b[0] - a[0]) > 1e-7) {
            const e = [g[0], a[1] + ((g[0] - a[0]) / (b[0] - a[0])) * (b[1] - a[1])];
            const d = Math.abs(g[1] - e[1]);
            if (d < cell && (d < best || best < 0)) { best = d; point = e; }
          }
        }
      }
    } else {
      const snap = 6 / this.gzoom();
      let best = -1;
      for (const c of v) { const d = Math.hypot(mouse[0] - c[0], mouse[1] - c[1]); if (d <= snap && (d < best || best < 0)) { best = d; point = c; } }
      if (best < 0) {
        for (let i = 0; i < 4; i++) {
          const a = v[i], b = v[(i + 1) % 4], sx = b[0] - a[0], sy = b[1] - a[1];
          const t = ((mouse[0] - a[0]) * sx + (mouse[1] - a[1]) * sy) / (sx * sx + sy * sy);
          if (t < 0 || t > 1) continue;
          const e = [a[0] + t * sx, a[1] + t * sy];
          const d = Math.hypot(mouse[0] - e[0], mouse[1] - e[1]);
          if (d <= snap && (d < best || best < 0)) { best = d; point = e; }
        }
      }
    }
    return { point: [point[0], point[1]], valid: inside(point) };
  }

  knifeClick(L) {
    const { point, valid } = this.knifePoint(L, this._altDown);
    if (!valid) return;
    const k = this.knife;
    k.points.push(point);
    if (k.points.length < 4) { this.redraw(); return; }
    const P = k.points;
    if (inTri(P[3], P[0], P[1], P[2]) || inTri(P[1], P[0], P[2], P[3])) { [P[0], P[3]] = [P[3], P[0]]; [P[1], P[2]] = [P[2], P[1]]; }
    [P[2], P[3]] = [P[3], P[2]];
    const src = L.quads[k.quad];
    const area = (a, b, c) => Math.abs(((b[0] - a[0]) * (c[1] - a[1]) - (c[0] - a[0]) * (b[1] - a[1])) * 0.5);
    this.editQuads('Knife', () => {
      const v = this.knifeRing(src);
      const nq = makeQuad(P, [255, 255, 255, 255]);
      for (let i = 0; i < 4; i++) {
        const t = inTri(P[i], v[0], v[3], v[2]) ? 2 : 1;
        const A = src.points[0], B = src.points[3], C = src.points[t];
        const ta = area(A, B, C) || 1;
        const wa = area(P[i], B, C) / ta, wb = area(P[i], C, A) / ta, wc = area(P[i], A, B) / ta;
        nq.colors[i] = [0, 1, 2, 3].map((c) => Math.round(src.colors[0][c] * wa + src.colors[3][c] * wb + src.colors[t][c] * wc));
        nq.tex[i] = [0, 1].map((c) => src.tex[0][c] * wa + src.tex[3][c] * wb + src.tex[t][c] * wc);
      }
      nq.points[4] = [((P[0][0] + P[3][0]) / 2 + (P[1][0] + P[2][0]) / 2) / 2, ((P[0][1] + P[3][1]) / 2 + (P[1][1] + P[2][1]) / 2) / 2];
      L.quads.push(nq);
    });
    k.points = [];
    this.quadSel = new Set([k.quad]);
  }

  drawKnife(ctx, L, S) {
    const q = L.quads[this.knife.quad];
    if (!q) { this.knife = null; return; }
    const v = this.knifeRing(q).map((p) => S(...p));
    ctx.strokeStyle = '#ff8000';
    ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(...v[0]); v.slice(1).forEach((p) => ctx.lineTo(...p)); ctx.closePath(); ctx.stroke();
    ctx.lineWidth = 1;
    const pts = this.knife.points.map((p) => S(...p));
    const { point, valid } = this.knifePoint(L, this._altDown);
    const cur = S(...point);
    ctx.strokeStyle = '#fff';
    ctx.beginPath();
    pts.forEach((p, i) => (i ? ctx.lineTo(...p) : ctx.moveTo(...p)));
    if (valid && pts.length) ctx.lineTo(...cur);
    if (valid && pts.length === 3) ctx.lineTo(...pts[0]);
    ctx.stroke();
    ctx.fillStyle = '#3070ff';
    for (const p of valid ? [...pts, cur] : pts) ctx.fillRect(p[0] - 3, p[1] - 3, 6, 6);
  }

  snapshotQuads(L) { return [...this.quadSel].map((i) => [i, L.quads[i].points.map((p) => p.slice())]); }
  snapshotPoints(L) { return [...this.pointSel].map((k) => { const [i, c] = k.split(':').map(Number); return [i, c, L.quads[i].points[c].slice()]; }); }

  // the finest grid step drawn at this zoom (the tile cell halved while the halves stay 16+ px apart, down to 1 unit);
  // everything that snaps to the grid uses it, so zooming in allows finer placement
  gridStep(g = this.group) {
    const z = this.gzoom(g);
    let s = TILE * this.opts.gridSize;
    while (s / 2 >= 1 && (s / 2) * z >= 16) s /= 2;
    return s;
  }

  snap(v) { if (!this.opts.grid) return v; const s = this.gridStep(); return Math.round(v / s) * s; }

  snapDelta(dx, dy, anchor) {
    if (!this.opts.grid) return [dx, dy];
    const tx = this.snap(anchor[0] + dx), ty = this.snap(anchor[1] + dy);
    return [tx - anchor[0], ty - anchor[1]];
  }

  onMouseMove(e, dx, dy) {
    const d = this.drag;
    if (this.picker.open) { this.redraw(); return; }
    if (this.pen && this.pen.drag && this.pen.mouseMove(e)) return;
    if (this.freeRot) { this.freeRotateMove(dx, e.shiftKey, e.ctrlKey || e.metaKey); return; }
    if (this.freeScale) { this.freeScaleMove(dx, e.shiftKey, e.ctrlKey || e.metaKey); return; }
    if (!d) return;
    if (d.type === 'qpaint') {
      const pos = this.quadBrushPos(), [x0, y0, x1, y1] = this.quadBrushBounds();
      const stepX = Math.max(16, x1 - x0), stepY = Math.max(16, y1 - y0);
      if (Math.abs(pos[0] - d.last[0]) >= stepX || Math.abs(pos[1] - d.last[1]) >= stepY) { this.stampQuadBrush(this.layer, pos); d.last = pos; }
      return;
    }
    if (d.type === 'pan') {
      this.cam.x -= dx / this.cam.zoom;
      this.cam.y -= dy / this.cam.zoom;
      this.emit('camera');
      return;
    }
    const L = this.layer;
    if (d.type === 'pending') {
      if (Math.hypot(this.mouse.sx - d.sx, this.mouse.sy - d.sy) > 4) {
        if (!d.shift) { this.quadSel.clear(); this.pointSel.clear(); this.emit('selection'); }
        this.drag = { type: 'box', sx: d.sx, sy: d.sy, grab: d.shift };
      }
      return;
    }
    if (d.type === 'paint') {
      const [tx, ty] = this.mouseTile();
      // stamp along the line so fast strokes have no gaps
      const [lx, ly] = d.last;
      const n = Math.max(Math.abs(tx - lx), Math.abs(ty - ly));
      for (const l of d.targets || [L]) {
        const br = this.brushFor(l);
        if (!br) continue;
        const bw = br.w, bh = br.h;
        const rect = [Math.min(lx, tx) - bw, Math.min(ly, ty) - bh, Math.max(lx, tx) + 2 * bw, Math.max(ly, ty) + 2 * bh];
        const changed = this.tileEdit(l, rect, () => {
          let c = false;
          for (let s = 1; s <= n; s++) {
            const x = Math.round(lx + ((tx - lx) * s) / n), y = Math.round(ly + ((ty - ly) * s) / n);
            c = T.stamp(l, br, x, y, this.nums) || c;
          }
          return c;
        });
        if (changed) this.touch(l);
      }
      d.last = [tx, ty];
      const b = d.bounds;
      b[0] = Math.min(b[0], tx); b[1] = Math.min(b[1], ty); b[2] = Math.max(b[2], tx + this.brush.w); b[3] = Math.max(b[3], ty + this.brush.h);
      return;
    }
    if (d.type === 'source') {
      const [wx, wy] = this.screenToWorld(this.mouse.sx, this.mouse.sy);
      let [nx, ny] = [d.orig[0] + wx - d.start[0], d.orig[1] + wy - d.start[1]];
      nx = this.snap(nx); ny = this.snap(ny);
      const src = L.sources[this.sourceSel];
      src.x = nx; src.y = ny;
      this.emit('quadmove');
      return;
    }
    if (d.type === 'quads' || d.type === 'points') {
      const [wx, wy] = this.screenToWorld(this.mouse.sx, this.mouse.sy);
      let ddx = wx - d.start[0], ddy = wy - d.start[1];
      // Shift keeps the move on one axis: the one the mouse has gone further along
      if (e.shiftKey) { if (Math.abs(ddx) >= Math.abs(ddy)) ddy = 0; else ddx = 0; }
      [ddx, ddy] = this.snapDelta(ddx, ddy, d.anchor);
      if (e.shiftKey) { if (Math.abs(wx - d.start[0]) >= Math.abs(wy - d.start[1])) ddy = 0; else ddx = 0; }
      d.axis = e.shiftKey ? (ddy === 0 ? 'x' : 'y') : null;
      if (d.type === 'quads') {
        for (const [i, pts] of d.orig) {
          const q = L.quads[i];
          const pose = d.poses && !d.pivotOnly && d.poses.get(i);
          if (pose) { q._pose = [pose[0] + ddx, pose[1] + ddy, pose[2]]; continue; } // timeline: an unkeyed move
          if (d.pivotOnly) q.points[4] = [pts[4][0] + ddx, pts[4][1] + ddy];
          else for (let k = 0; k < 5; k++) q.points[k] = [pts[k][0] + ddx, pts[k][1] + ddy];
        }
      } else {
        for (const [i, c, p] of d.orig) {
          // an animated quad is shown turned by its envelope: the corner moves in the quad's own space
          const rot = (this.posOffset(L.quads[i])[2] * Math.PI) / 180, cs = Math.cos(-rot), sn = Math.sin(-rot);
          L.quads[i].points[c] = [p[0] + ddx * cs - ddy * sn, p[1] + ddx * sn + ddy * cs];
        }
        this.fixDiagonals(L, new Set(d.orig.map((o) => o[0])), d.orig);
      }
      this.touch(L);
      this.emit('quadmove');
    }
  }

  onMouseUp(e) {
    if (this.pen && this.pen.mouseUp()) return;
    if (this.picker.open && this.picker.drag) {
      const a = this.picker.drag, b = this.pickerCell(this.mouse.sx, this.mouse.sy) || a;
      this.picker.drag = null;
      const x0 = Math.min(a[0], b[0]), y0 = Math.min(a[1], b[1]);
      this.brush = T.pickerBrush(this.layer.kind, x0, y0, Math.abs(a[0] - b[0]) + 1, Math.abs(a[1] - b[1]) + 1);
      this.brush._rev = Date.now();
      if (!this._spaceDown) this.closePicker();
      this.emit('brush');
      return;
    }
    const d = this.drag;
    if (!d) return;
    this.drag = null;
    const L = this.layer;
    if (d.type === 'select') {
      const [tx, ty] = this.mouseTile();
      const x0 = Math.min(d.tx, tx), y0 = Math.min(d.ty, ty), w = Math.abs(tx - d.tx) + 1, h = Math.abs(ty - d.ty) + 1;
      if (d.erase) {
        // right-drag without a brush clears the area (in every edited layer)
        this.editTiles('Clear area', (l) => {
          const b = TILE_BYTES[l.kind];
          this.tileEdit(l, [x0, y0, x0 + w, y0 + h], () => {
            for (let y = y0; y < y0 + h; y++) for (let x = x0; x < x0 + w; x++) if (x >= 0 && y >= 0 && x < l.width && y < l.height) l.tiles.fill(0, (y * l.width + x) * b, (y * l.width + x + 1) * b);
          });
          this.liveAutomap(l, [x0, y0, w, h]);
        });
      } else {
        // with several layers the brush keeps one part per layer, stamped back into the same layers
        const targets = this.tileTargets();
        this.brush = T.copyRegion(L, x0, y0, w, h);
        if (targets.length > 1) this.brush.parts = new Map(targets.map((l) => [l, l === L ? this.brush : T.copyRegion(l, x0, y0, w, h)]));
        this.brush._rev = Date.now();
        this.emit('brush');
      }
    } else if (d.type === 'fill') {
      const [tx, ty] = this.mouseTile();
      const x0 = Math.min(d.tx, tx), y0 = Math.min(d.ty, ty), w = Math.abs(tx - d.tx) + 1, h = Math.abs(ty - d.ty) + 1;
      this.editTiles('Fill rectangle', (l, b) => { if (b) { this.tileEdit(l, [x0, y0, x0 + w, y0 + h], () => T.fillRect(l, b, x0, y0, w, h, this.nums)); this.liveAutomap(l, [x0, y0, w, h]); } });
    } else if (d.type === 'source') {
      this.history.commit();
      this.emit('selection');
    } else if (d.type === 'paint' || d.type === 'quads' || d.type === 'points') {
      if (d.poses) this.status('Unkeyed move (orange): press K to key it at this time, Esc drops it');
      if (d.toggleOff && Math.hypot(this.mouse.sx - d.sx, this.mouse.sy - d.sy) < 3) this.pointSel.delete(d.toggleOff);
      if (d.type === 'paint') for (const l of d.targets || [L]) this.liveAutomap(l, [d.bounds[0], d.bounds[1], d.bounds[2] - d.bounds[0], d.bounds[3] - d.bounds[1]]);
      this.history.commit();
      this.emit('selection');
    } else if (d.type === 'pending') {
      if (d.shift) { if (this.quadSel.has(d.hit)) this.quadSel.delete(d.hit); else this.quadSel.add(d.hit); }
      else { this.quadSel.clear(); this.quadSel.add(d.hit); }
      this.pointSel.clear();
      this.emit('selection');
    } else if (d.type === 'qpaint') {
      this.history.commit();
      this.emit('selection');
    } else if (d.type === 'box') {
      const [ax, ay] = this.screenToWorld(d.sx, d.sy), [bx, by] = this.screenToWorld(this.mouse.sx, this.mouse.sy);
      const x0 = Math.min(ax, bx), x1 = Math.max(ax, bx), y0 = Math.min(ay, by), y1 = Math.max(ay, by);
      if (d.grab) { this.grabQuadBrush(L, x0, y0, x1, y1); this.redraw(); return; }
      L.quads.forEach((q, i) => { const [px, py] = this.shown(q)[4]; if (px >= x0 && px <= x1 && py >= y0 && py <= y1) this.quadSel.add(i); });
      this.emit('selection');
    }
    this.redraw();
  }

  pickColor() {
    this.pipette = false;
    const gl = this.renderer.gl, d = this.renderer.dpr || 1;
    const px = new Uint8Array(4);
    gl.readPixels(Math.round(this.mouse.sx * d), Math.round(this.canvas.height - this.mouse.sy * d), 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
    const hex = '#' + [px[0], px[1], px[2]].map((v) => v.toString(16).padStart(2, '0')).join('');
    this.pickedColor = [px[0], px[1], px[2], 255];
    navigator.clipboard && navigator.clipboard.writeText(hex).catch(() => {});
    window.dispatchEvent(new CustomEvent('twe-color-copied', { detail: [...this.pickedColor] })); // into the palette
    // like DDNet: the picked colour goes to the selected quads / points if any
    const L = this.layer;
    if (L && L.type === 'quads' && this.quadSel.size) {
      const pts = [...this.pointSel].map((k) => k.split(':').map(Number));
      this.editQuads('Pick colour', () => {
        if (pts.length) for (const [i, c] of pts) L.quads[i].colors[c] = [...this.pickedColor];
        else for (const q of this.selectedQuads()) q.colors = [0, 1, 2, 3].map(() => [...this.pickedColor]);
      });
    }
    this.status(`Colour ${hex} copied`);
    this.redraw();
  }

  // ---------------------------------------------------------------- game tiles tools

  canConstructGameTiles(g = this.group, L = this.layer) {
    return L && L.kind === 'tiles' && g && g.parallaxX === 100 && g.parallaxY === 100 && g.offsetX % 32 === 0 && g.offsetY % 32 === 0;
  }

  // DDNet "Construct game tiles": every non-empty tile of this layer becomes a game (or tele) tile
  constructGameTiles(index) {
    const L = this.layer, g = this.group;
    if (!this.canConstructGameTiles()) return;
    const ox = -g.offsetX / 32, oy = -g.offsetY / 32;
    const tele = index === 31 || index === 63;
    let target = this.map.groups.flatMap((gr) => gr.layers).find((l) => l.kind === (tele ? 'tele' : 'game'));
    const game = findGameLayer(this.map);
    if (!game) return;
    if (!target) {
      this.history.edit(this.map, 'structure', 'New Tele layer', null, () => {
        target = newTileLayer('tele', game.layer.width, game.layer.height, 'Tele');
        game.group.layers.push(target);
      });
    }
    let n = 0;
    this.history.edit(this.map, 'layer', 'Construct game tiles', target, () => {
      const b = TILE_BYTES[target.kind];
      for (let y = 0; y < L.height; y++) for (let x = 0; x < L.width; x++) {
        if (!L.tiles[(y * L.width + x) * 4]) continue;
        const tx = x + ox, ty = y + oy;
        if (tx < 0 || ty < 0 || tx >= target.width || ty >= target.height) continue;
        const o = (ty * target.width + tx) * b;
        target.tiles.fill(0, o, o + b);
        if (tele) { target.tiles[o] = 1; target.tiles[o + 1] = index; } else target.tiles[o] = index;
        n++;
      }
    });
    this.touch(target);
    this.status(`Game tiles constructed: ${n}`);
    this.emit('map');
  }

  // DDNet "Clean up game tiles": remove solid/death/nohook game tiles that no tile layer of the game group covers
  cleanUpGameTiles() {
    const game = findGameLayer(this.map);
    if (!game) return;
    const G = game.layer;
    const others = game.group.layers.filter((l) => l.kind === 'tiles');
    let n = 0;
    this.history.edit(this.map, 'layer', 'Clean up game tiles', G, () => {
      for (let y = 0; y < G.height; y++) for (let x = 0; x < G.width; x++) {
        const o = (y * G.width + x) * 4;
        if (!G.tiles[o] || G.tiles[o] > 3) continue;
        if (others.some((l) => x < l.width && y < l.height && l.tiles[(y * l.width + x) * 4])) continue;
        G.tiles[o] = 0;
        n++;
      }
    });
    this.touch(G);
    this.status(`Game tiles removed: ${n}`);
  }

  placeBorder() {
    const L = this.layer;
    if (!L || (L.kind !== 'tiles' && L.kind !== 'game')) return;
    this.history.edit(this.map, 'layer', 'Border', L, () => {
      for (let y = 0; y < L.height; y++) for (let x = 0; x < L.width; x++) {
        if (x < 2 || x > L.width - 3 || y < 2 || y > L.height - 3) L.tiles[(y * L.width + x) * 4] = 1;
      }
      this.liveAutomap(L);
    });
    this.touch(L);
  }

  centerPivot() {
    this.editQuads('Centre pivot', () => {
      for (const q of this.selectedQuads()) {
        const [x0, y0, x1, y1] = T.quadBounds(q);
        q.points[4] = [x0 + (x1 - x0) / 2, y0 + (y1 - y0) / 2];
      }
    });
  }

  gotoPosition(tx, ty) {
    this.cam.x = tx * TILE + TILE / 2;
    this.cam.y = ty * TILE + TILE / 2;
    this.emit('camera');
  }

  // ---------------------------------------------------------------- quad commands

  selectedQuads() { const L = this.layer; return L && L.type === 'quads' ? [...this.quadSel].sort((a, b) => a - b).map((i) => L.quads[i]).filter(Boolean) : []; }

  editQuads(label, fn) {
    const L = this.layer;
    if (!L || L.type !== 'quads') return;
    this.history.edit(this.map, 'layer', label, L, () => fn(L));
    this.touch(L);
    this.emit('selection');
  }

  addQuad() {
    const L = this.layer;
    if (!L || L.type !== 'quads') return;
    const [cx, cy] = this.screenToWorld(...this.vp().map((v) => v / 2));
    const x = Math.round(cx / TILE) * TILE, y = Math.round(cy / TILE) * TILE;
    this.editQuads('Add quad', () => {
      L.quads.push(makeQuad([[x - 32, y - 32], [x + 32, y - 32], [x - 32, y + 32], [x + 32, y + 32]]));
      this.quadSel = new Set([L.quads.length - 1]);
    });
  }

  deleteQuads() {
    if (this.layer && this.layer.type === 'sounds') { this.deleteSource(); return; }
    if (!this.quadSel.size) return;
    this.editQuads('Delete quads', (L) => {
      L.quads = L.quads.filter((_, i) => !this.quadSel.has(i));
      this.quadSel.clear();
      this.pointSel.clear();
    });
  }

  duplicateQuads() {
    if (!this.quadSel.size) return;
    this.editQuads('Duplicate quads', (L) => {
      const sel = [...this.quadSel].sort((a, b) => a - b);
      const start = L.quads.length;
      for (const i of sel) { const q = T.cloneQuad(L.quads[i]); T.moveQuad(q, 16, 16); L.quads.push(q); }
      this.quadSel = new Set(sel.map((_, k) => start + k));
      this.pointSel.clear();
    });
  }

  copyQuads() {
    const qs = this.selectedQuads();
    if (!qs.length) return;
    const cx = qs.reduce((s, q) => s + q.points[4][0], 0) / qs.length, cy = qs.reduce((s, q) => s + q.points[4][1], 0) / qs.length;
    this.quadClipboard = qs.map((q) => { const c = T.cloneQuad(q); T.moveQuad(c, -cx, -cy); return c; });
    this.status(`Copied ${qs.length} quads. Ctrl+V pastes them at the cursor.`);
  }

  pasteQuads(wx, wy) {
    const L = this.layer;
    if (!this.quadClipboard || !L || L.type !== 'quads') return;
    if (wx === undefined) [wx, wy] = this.screenToWorld(this.mouse.sx, this.mouse.sy);
    wx = this.snap(wx); wy = this.snap(wy);
    this.editQuads('Paste quads', () => {
      const start = L.quads.length;
      for (const q of this.quadClipboard) { const c = T.cloneQuad(q); T.moveQuad(c, wx, wy); L.quads.push(c); }
      this.quadSel = new Set(this.quadClipboard.map((_, k) => start + k));
      this.pointSel.clear();
    });
  }

  reorderQuads(toFront) {
    this.editQuads(toFront ? 'Bring to front' : 'Send to back', (L) => {
      const sel = L.quads.filter((_, i) => this.quadSel.has(i));
      const rest = L.quads.filter((_, i) => !this.quadSel.has(i));
      L.quads = toFront ? [...rest, ...sel] : [...sel, ...rest];
      const start = toFront ? rest.length : 0;
      this.quadSel = new Set(sel.map((_, k) => start + k));
    });
  }

  aspectQuads() {
    const L = this.layer;
    const img = L && this.map.images[L.image];
    if (!img) return;
    this.editQuads('Image aspect ratio', () => {
      for (const q of this.selectedQuads()) {
        T.squareQuad(q);
        const [x0, y0, x1] = T.quadBounds(q);
        const w = x1 - x0, h = (w * img.height) / img.width;
        q.points[2][1] = q.points[3][1] = y0 + h;
        q.points[4] = [x0 + w / 2, y0 + h / 2];
      }
    });
  }

  layerContextMenu(x, y) {
    const L = this.layer;
    if (!L || L.type !== 'quads') return;
    contextMenu(x, y, [
      ['Add quad', () => this.addQuad()],
      this.quadClipboard ? ['Paste quads here', () => this.pasteQuads()] : null,
      ['Select all  (Ctrl+A)', () => { L.quads.forEach((_, i) => this.quadSel.add(i)); this.emit('selection'); }],
    ]);
  }

  // ---------------------------------------------------------------- automapper

  rulesFor(L) {
    const img = L && this.map.images[L.image];
    if (!img) return null;
    if (!this.rules.has(img.name)) {
      this.rules.set(img.name, null);
      loadRules(img.name).then((c) => { this.rules.set(img.name, c); this.emit('layerprops'); });
    }
    return this.rules.get(img.name);
  }

  automap(L, region = null, seedOverride) {
    const a = L.automapper;
    const confs = this.rulesFor(L);
    if (!a || a.config < 0 || !confs || !confs[a.config]) return false;
    const game = findGameLayer(this.map);
    runAutomapper(L, game && game.layer, confs[a.config], seedOverride ?? a.seed, L._amRef ?? -1, region);
    this.touch(L);
    return true;
  }

  // runs a tile edit of layer L inside rect [x0, y0, x1, y1) (null = anywhere); modules can wrap it
  // (Gores mode adds freeze around new hook). Returns what fn returns, or true when a wrapper changed tiles too.
  tileEdit(L, rect, fn) {
    const run = (i) => (i < 0 ? fn() : this.ext.tileEdit[i](L, rect, () => run(i - 1)));
    return run(this.ext.tileEdit.length - 1);
  }

  // DDNet "auto automapper": rerun around every change when the layer has a seed
  liveAutomap(L, region = null) {
    const a = L && L.automapper;
    if (!a || L.kind !== 'tiles' || !(a.flags & 1) || !a.seed || a.config < 0) return;
    this.automap(L, region);
  }

  runAutomapNow() {
    const L = this.layer;
    if (!L || L.kind !== 'tiles') return;
    this.history.edit(this.map, 'layer', 'Automap', L, () => this.automap(L));
  }

  // ---------------------------------------------------------------- brush commands

  flipBrush(h) {
    if (this.brush) {
      T.flipBrush(this.brush, h); for (const p of this.brushParts()) T.flipBrush(p, h);
      if (this.pickerSpeedup()) this.nums.speedAngle = T.normAngle(h ? 180 - this.nums.speedAngle : -this.nums.speedAngle);
      this.brush._rev = Date.now(); this.emit('brush'); return; }
    if (this.quadBrush) {
      for (const q of this.quadBrush.quads) for (const p of q.points) { if (h) p[0] = -p[0]; else p[1] = -p[1]; }
      this.quadBrush.rev++; this.redraw(); return;
    }
    if (this.quadSel.size) this.editQuads('Flip', () => this.selectedQuads().forEach((q) => T.flipQuad(q, h)));
  }

  // a brush from the tile picker painted into Speedup takes its arrow from nums.speedAngle
  pickerSpeedup() {
    return !!this.brush && this.tileTargets().some((l) => l.kind === 'speedup' && this.brushFor(l) && this.brushFor(l).kind !== 'speedup');
  }

  // Force / Max speed / Angle typed in the panel also change a speedup brush copied from the map
  setSpeedNum(k, v) {
    this.nums[k] = k === 'speedAngle' ? T.normAngle(v) : Math.max(0, Math.min(255, Math.round(v)));
    const parts = this.brush ? [this.brush, ...this.brushParts()] : [];
    for (const b of parts) {
      if (b.kind !== 'speedup') continue;
      const d = b.data, dv = new DataView(d.buffer, d.byteOffset, d.byteLength);
      for (let i = 0; i < b.w * b.h; i++) {
        if (!d[i * 6 + 2]) continue;
        if (k === 'speedForce') d[i * 6] = this.nums[k];
        else if (k === 'speedMax') d[i * 6 + 1] = this.nums[k];
        else dv.setInt16(i * 6 + 4, this.nums[k], true);
      }
      b._rev = Date.now();
    }
    this.redraw();
  }

  // R / T and the toolbar buttons rotate by the rotation step; tile brushes only by multiples of 90 like in DDNet
  rotateBrush(cw) {
    const step = this.opts.rotStep || 90;
    if (this.brush) {
      const n = Math.max(1, Math.round(step / 90)) % 4;
      for (let i = 0; i < n; i++) { T.rotateBrush(this.brush, cw); for (const p of this.brushParts()) T.rotateBrush(p, cw); }
      if (this.pickerSpeedup()) this.nums.speedAngle = T.normAngle(this.nums.speedAngle + (cw ? 90 : -90) * n);
      this.brush._rev = Date.now(); this.emit('brush'); return;
    }
    const deg = cw ? step : -step;
    if (this.quadBrush) {
      const a = (deg * Math.PI) / 180, c = Math.cos(a), sn = Math.sin(a);
      for (const q of this.quadBrush.quads) q.points = q.points.map(([x, y]) => [x * c - y * sn, x * sn + y * c]);
      this.quadBrush.rev++; this.redraw(); return;
    }
    if (this.quadSel.size) this.editQuads('Rotate', () => this.selectedQuads().forEach((q) => T.rotateQuad(q, deg)));
  }

  // ---------------------------------------------------------------- timeline (keys from the viewport)

  // position offset [dx, dy, degrees] of a quad now: its position envelope plus an unkeyed timeline move
  posOffset(q) {
    const e = q.posEnv >= 0 && this.map.envelopes[q.posEnv];
    const v = e ? evalEnvelope(e, this.opts.time + (q.posEnvOffset | 0)) : [0, 0, 0];
    const p = q._pose;
    return p ? [v[0] + p[0], v[1] + p[1], v[2] + p[2]] : [v[0], v[1], v[2]];
  }

  // corners and pivot where the quad is drawn now (like DDNet: turned around the pivot, then moved)
  shown(q) {
    if (!(q.posEnv >= 0 && this.map.envelopes[q.posEnv]) && !q._pose) return q.points;
    const [dx, dy, deg] = this.posOffset(q);
    if (!dx && !dy && !deg) return q.points;
    const [cx, cy] = q.points[4];
    const a = (deg * Math.PI) / 180, cs = Math.cos(a), sn = Math.sin(a);
    return q.points.map(([x, y]) => [cx + (x - cx) * cs - (y - cy) * sn + dx, cy + (x - cx) * sn + (y - cy) * cs + dy]);
  }

  // with the timeline open, moving or turning a quad that has a position envelope is an unkeyed move
  // (quad._pose) that K turns into a key; the quad's own corners stay as they are
  posesOf(L) {
    if (!this.anim.on || !L || L.type !== 'quads') return null;
    const m = new Map();
    for (const i of this.quadSel) { const q = L.quads[i]; if (q && q.posEnv >= 0 && this.map.envelopes[q.posEnv]) m.set(i, q._pose ? [...q._pose] : [0, 0, 0]); }
    return m.size ? m : null;
  }

  clearPoses(L = this.layer) {
    if (!L || L.type !== 'quads') return 0;
    let n = 0;
    for (const q of L.quads) if (q._pose) { delete q._pose; n++; }
    if (n) this.touch(L);
    return n;
  }

  // keep the fill of concave quads inside them (see fixQuadDiagonal); the vertex selection and a running
  // vertex drag follow the renamed corners
  fixDiagonals(L, quads, orig = null) {
    for (const i of quads) {
      const shift = L.quads[i] && fixQuadDiagonal(L.quads[i]);
      if (!shift) continue;
      const keys = [...this.pointSel].filter((k) => +k.split(':')[0] === i);
      for (const k of keys) this.pointSel.delete(k);
      for (const k of keys) this.pointSel.add(`${i}:${shift[+k.split(':')[1]]}`);
      if (orig) for (const o of orig) if (o[0] === i) o[1] = shift[o[1]];
    }
  }

  // ---------------------------------------------------------------- free rotation (hold / press R with quads selected, like DDNet)

  startFreeRotate() {
    const L = this.layer;
    if (!L || L.type !== 'quads' || !this.quadSel.size || this.quadBrush || this.drag) return false;
    this.history.begin(this.map, 'layer', 'Rotate', L);
    this.freeRot = { L, orig: [...this.quadSel].filter((i) => L.quads[i]).map((i) => [i, L.quads[i].points.map((p) => [...p])]), poses: this.posesOf(L), angle: 0, shown: 0, moved: false };
    this.status('Rotate: move the mouse left/right (Shift: fine, Ctrl: snap to the rotation step). Click or release R to apply, right click or Esc to cancel.');
    this.redraw();
    return true;
  }

  freeRotateMove(dx, fine, snap) {
    const r = this.freeRot;
    r.angle += dx * (fine ? 0.05 : 0.5);
    if (dx) r.moved = true;
    const step = this.opts.rotStep || 90;
    r.shown = snap ? Math.round(r.angle / step) * step : r.angle;
    for (const [i, pts] of r.orig) {
      const q = r.L.quads[i];
      const pose = r.poses && r.poses.get(i);
      if (pose) { q._pose = [pose[0], pose[1], pose[2] + r.shown]; continue; } // timeline: an unkeyed turn
      q.points = pts.map((p) => [...p]);
      T.rotateQuad(q, r.shown);
    }
    this.touch(r.L);
    this.emit('quadmove');
  }

  endFreeRotate(apply) {
    const r = this.freeRot;
    if (!r) return;
    this.freeRot = null;
    if (apply) this.history.commit();
    else {
      for (const [i, pts] of r.orig) r.L.quads[i].points = pts.map((p) => [...p]);
      if (r.poses) for (const [i, p] of r.poses) r.L.quads[i]._pose = p[0] || p[1] || p[2] ? p : undefined;
      this.history.cancel();
    }
    this.touch(r.L);
    this.emit('selection');
  }

  // ---------------------------------------------------------------- free scale (hold / press S with quads selected)

  // one quad grows from its pivot, several quads from the middle of their bounding box, so a group keeps its layout
  startFreeScale() {
    const L = this.layer;
    if (!L || L.type !== 'quads' || !this.quadSel.size || this.quadBrush || this.drag || this.freeRot) return false;
    const orig = [...this.quadSel].filter((i) => L.quads[i]).map((i) => [i, L.quads[i].points.map((p) => [...p])]);
    if (!orig.length) return false;
    let pivot;
    if (orig.length === 1) pivot = [...orig[0][1][4]];
    else {
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
      for (const [, pts] of orig) for (let k = 0; k < 4; k++) { const [x, y] = pts[k]; x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); }
      pivot = [(x0 + x1) / 2, (y0 + y1) / 2];
    }
    this.history.begin(this.map, 'layer', 'Scale', L);
    this.freeScale = { L, orig, pivot, log: 0, shown: 1, moved: false };
    this.status('Scale: move the mouse right to grow, left to shrink (Shift: fine, Ctrl: steps of 10%). Click or release S to apply, right click or Esc to cancel.');
    this.redraw();
    return true;
  }

  freeScaleMove(dx, fine, snap) {
    const s = this.freeScale;
    s.log += dx * (fine ? 0.0008 : 0.006);
    if (dx) s.moved = true;
    const f = Math.exp(s.log);
    s.shown = snap ? Math.max(0.1, Math.round(f * 10) / 10) : Math.max(0.01, f);
    const [cx, cy] = s.pivot;
    for (const [i, pts] of s.orig) s.L.quads[i].points = pts.map(([x, y]) => [cx + (x - cx) * s.shown, cy + (y - cy) * s.shown]);
    this.touch(s.L);
    this.emit('quadmove');
  }

  endFreeScale(apply) {
    const s = this.freeScale;
    if (!s) return;
    this.freeScale = null;
    if (apply) this.history.commit();
    else {
      for (const [i, pts] of s.orig) s.L.quads[i].points = pts.map((p) => [...p]);
      this.history.cancel();
    }
    this.touch(s.L);
    this.emit('selection');
  }

  // ---------------------------------------------------------------- quad brush (Shift+drag a box, or B with quads selected)

  setQuadBrush(quads, cx, cy) {
    cx = this.snap(cx); cy = this.snap(cy);
    this.quadBrush = { quads: quads.map((q) => { const c = T.cloneQuad(q); T.moveQuad(c, -cx, -cy); return c; }), rev: Date.now() };
    this.quadSel.clear();
    this.pointSel.clear();
    this.status(`Quad brush: ${quads.length} quads. Click to place, N/M flip, R/T rotate, right click or B to drop the brush.`);
    this.emit('brush');
    this.emit('selection');
  }

  grabQuadBrush(L, x0, y0, x1, y1) {
    const qs = L.quads.filter((q) => { const [px, py] = q.points[4]; return px >= x0 && px <= x1 && py >= y0 && py <= y1; });
    if (!qs.length) { this.status('No quads in the box (a quad is grabbed when its centre point is inside)'); return; }
    this.setQuadBrush(qs, (x0 + x1) / 2, (y0 + y1) / 2);
  }

  toggleQuadBrush() {
    if (this.quadBrush) { this.clearQuadBrush(); return; }
    const L = this.layer;
    if (!L || L.type !== 'quads') { this.status('Select a quads layer first'); return; }
    const qs = this.selectedQuads();
    if (!qs.length) { this.status('Select quads first, or Shift+drag a box over quads to grab them into a brush'); return; }
    const [x0, y0, x1, y1] = qs.map(T.quadBounds).reduce((a, b) => [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[2], b[2]), Math.max(a[3], b[3])]);
    this.setQuadBrush(qs, (x0 + x1) / 2, (y0 + y1) / 2);
  }

  clearQuadBrush() {
    if (!this.quadBrush) return;
    this.quadBrush = null;
    this.emit('brush');
  }

  quadBrushBounds() {
    const qs = this.quadBrush.quads;
    return qs.map(T.quadBounds).reduce((a, b) => [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[2], b[2]), Math.max(a[3], b[3])]);
  }

  stampQuadBrush(L, [x, y]) {
    for (const q of this.quadBrush.quads) { const c = T.cloneQuad(q); T.moveQuad(c, x, y); L.quads.push(c); }
    this.touch(L);
  }

  // ---------------------------------------------------------------- structure commands

  editStructure(label, fn) {
    this.history.edit(this.map, 'structure', label, null, fn);
    this.emit('map');
  }

  // a dropped image becomes a quad showing it, centred at the drop point, in a new quads layer
  addImageQuads(images, wx, wy) {
    if (!images.length) return;
    let gi = this.sel.g;
    const g0 = this.map.groups[gi];
    this.editStructure('Image quad', () => {
      if (!g0 || g0.layers.some((l) => l.kind === 'game')) {
        const game = this.map.groups.findIndex((g) => g.layers.some((l) => l.kind === 'game'));
        gi = game >= 0 ? game : this.map.groups.length;
        this.map.groups.splice(gi, 0, newGroup('Images'));
      }
      const g = this.map.groups[gi];
      let off = 0;
      for (const ii of images) {
        const im = this.map.images[ii];
        const l = newQuadLayer(im.name.slice(0, 11));
        l.image = ii;
        const w = im.width, h = im.height, x = Math.round(wx - w / 2 + off), y = Math.round(wy - h / 2 + off);
        l.quads.push(makeQuad([[x, y], [x + w, y], [x, y + h], [x + w, y + h]]));
        g.layers.push(l);
        off += 32;
      }
      this.sel = { g: gi, l: g.layers.length - 1 };
    });
  }

  addGroup() {
    this.editStructure('New group', () => {
      this.map.groups.push(newGroup(''));
      this.sel = { g: this.map.groups.length - 1, l: -1 };
    });
  }

  addLayer(kind) {
    const g = this.group;
    if (!g) return;
    const game = findGameLayer(this.map);
    const w = game ? game.layer.width : 50, h = game ? game.layer.height : 50;
    if (['front', 'tele', 'speedup', 'switch', 'tune'].includes(kind) && this.map.groups.some((gr) => gr.layers.some((l) => l.kind === kind))) {
      this.status(`The map already has a ${KIND_NAME[kind]} layer`);
      return;
    }
    this.editStructure('New layer', () => {
      const l = kind === 'sounds' ? newSoundLayer('') : kind === 'quads' ? newQuadLayer('') : newTileLayer(kind, w, h, kind === 'tiles' ? '' : KIND_NAME[kind]);
      const at = this.sel.l >= 0 ? this.sel.l + 1 : g.layers.length;
      g.layers.splice(at, 0, l);
      this.sel = { g: this.sel.g, l: at };
    });
  }

  deleteLayer() {
    const g = this.group, L = this.layer;
    if (!L) return;
    if (L.kind === 'game') { this.status('The Game layer cannot be deleted'); return; }
    this.editStructure('Delete layer', () => {
      g.layers.splice(this.sel.l, 1);
      this.sel.l = Math.min(this.sel.l, g.layers.length - 1);
    });
  }

  deleteGroup() {
    const g = this.group;
    if (!g) return;
    if (g.layers.some((l) => l.kind === 'game')) { this.status('The group with the Game layer cannot be deleted'); return; }
    this.editStructure('Delete group', () => {
      this.map.groups.splice(this.sel.g, 1);
      this.sel = { g: Math.max(0, this.sel.g - 1), l: -1 };
    });
  }

  moveLayer(dir) {
    // like DDNet: moving past the end of a group moves the layer into the neighbouring group
    const gi = this.sel.g, li = this.sel.l, g = this.group, L = this.layer;
    if (!L) return;
    this.editStructure('Move layer', () => {
      const ni = li + dir;
      if (ni >= 0 && ni < g.layers.length) {
        [g.layers[li], g.layers[ni]] = [g.layers[ni], g.layers[li]];
        this.sel.l = ni;
      } else if (L.kind === 'tiles' || L.kind === 'quads' || L.kind === 'sounds') {
        const ng = this.map.groups[gi + dir];
        if (!ng) return;
        g.layers.splice(li, 1);
        if (dir < 0) { ng.layers.push(L); this.sel = { g: gi - 1, l: ng.layers.length - 1 }; }
        else { ng.layers.unshift(L); this.sel = { g: gi + 1, l: 0 }; }
      }
    });
  }

  // move the selected layer to group ng at position nl (layer popup "Group" / "Order")
  moveLayerTo(ng, nl) {
    const gi = this.sel.g, li = this.sel.l, L = this.layer;
    if (!L) return;
    ng = Math.max(0, Math.min(this.map.groups.length - 1, ng));
    if (ng !== gi && !['tiles', 'quads', 'sounds'].includes(L.kind)) { this.status('Physics layers stay in the Game group'); return; }
    const target = this.map.groups[ng];
    nl = Math.max(0, Math.min(target.layers.length - (ng === gi ? 1 : 0), nl));
    if (ng === gi && nl === li) return;
    this.editStructure(ng === gi ? 'Layer order' : 'Layer group', () => {
      this.map.groups[gi].layers.splice(li, 1);
      target.layers.splice(nl, 0, L);
      this.sel = { g: ng, l: nl };
    });
  }
  setGroupOrder(ni) {
    const gi = this.sel.g;
    ni = Math.max(0, Math.min(this.map.groups.length - 1, ni));
    if (ni === gi) return;
    this.editStructure('Group order', () => {
      const [g] = this.map.groups.splice(gi, 1);
      this.map.groups.splice(ni, 0, g);
      this.sel = { g: ni, l: -1 };
    });
  }
  setQuadOrder(from, to) {
    this.editQuads('Quad order', (L) => {
      to = Math.max(0, Math.min(L.quads.length - 1, to));
      const [q] = L.quads.splice(from, 1);
      L.quads.splice(to, 0, q);
      this.quadSel = new Set([to]);
      this.pointSel.clear();
    });
  }
  // DDNet: Ctrl+right click on the map selects the tile layer under the mouse, repeated clicks cycle through them
  selectLayerByTile() {
    const hits = [];
    this.map.groups.forEach((g, gi) => g.layers.forEach((l, li) => {
      if (l.type !== 'tiles' || !g.visible || !l.visible) return;
      const [wx, wy] = this.screenToWorld(this.mouse.sx, this.mouse.sy, g);
      const tx = Math.floor(wx / TILE), ty = Math.floor(wy / TILE);
      if (tx < 0 || ty < 0 || tx >= l.width || ty >= l.height) return;
      if (displayTile(l.kind, l.tiles, ty * l.width + tx)[0] > 0) hits.push([gi, li]);
    }));
    if (!hits.length) return false;
    const cur = hits.findIndex(([g, l]) => g === this.sel.g && l === this.sel.l);
    const [g, l] = hits[(cur + 1) % hits.length];
    this.select(g, l);
    return true;
  }
  moveGroup(dir) {
    const gi = this.sel.g, ni = gi + dir;
    if (ni < 0 || ni >= this.map.groups.length) return;
    this.editStructure('Move group', () => {
      const gs = this.map.groups;
      [gs[gi], gs[ni]] = [gs[ni], gs[gi]];
      this.sel.g = ni;
    });
  }

  duplicateLayer() {
    const g = this.group, L = this.layer;
    if (!L || !['tiles', 'quads', 'sounds'].includes(L.kind)) return;
    this.editStructure('Duplicate layer', () => {
      const c = { ...L, _rev: 0, _key: undefined };
      if (L.tiles) c.tiles = L.tiles.slice();
      if (L.quads) c.quads = structuredClone(L.quads);
      if (L.sources) c.sources = structuredClone(L.sources);
      if (L.color) c.color = [...L.color];
      if (L.automapper) c.automapper = { ...L.automapper };
      g.layers.splice(this.sel.l + 1, 0, c);
      this.sel.l += 1;
    });
  }

  // Layer size from the properties: anchor [ax, ay] (0 keeps left / top, 1 grows on all sides, 2 keeps right / bottom),
  // linked: also every tile layer of the same size lined up with this one.
  resizeTileLayer(L, w, h, anchor, linked) {
    let move = null;
    this.history.edit(this.map, 'full', 'Layer size', null, () => { move = T.resizeTileLayers(this.map, L, w, h, anchor[0], anchor[1], linked); });
    if (move) {
      this.history.undoStack[this.history.undoStack.length - 1].camShift = move;
      this.cam.x += move[0]; this.cam.y += move[1];
    }
    this.sizePreview = null;
    for (const g of this.map.groups) for (const l of g.layers) l._rev = (l._rev || 0) + 1;
    this.emit('map');
    this.redraw();
  }

  // ---------------------------------------------------------------- undo

  undo() { const p = this.history.undo(); if (p) this.afterHistory(p); }
  redo() { const p = this.history.redo(); if (p) this.afterHistory(p); }
  afterHistory(p) {
    // a resize that grew left / up moved the world; the camera goes along so the view stays put
    if (p.camShift) { const k = p === this.history.undoStack[this.history.undoStack.length - 1] ? 1 : -1; this.cam.x += p.camShift[0] * k; this.cam.y += p.camShift[1] * k; }
    if (p.scope === 'custom') { this.status((p === this.history.undoStack[this.history.undoStack.length - 1] ? 'Redo: ' : 'Undo: ') + p.label); return; }
    if (p.scope !== 'layer') {
      this.sel.g = Math.min(this.sel.g, this.map.groups.length - 1);
      const g = this.group;
      if (g) this.sel.l = Math.min(this.sel.l, g.layers.length - 1);
    }
    const L = this.layer;
    if (L && L.quads) { for (const i of [...this.quadSel]) if (i >= L.quads.length) this.quadSel.delete(i); }
    for (const g of this.map.groups) for (const l of g.layers) l._rev = (l._rev || 0) + 1;
    this.status((p === this.history.undoStack[this.history.undoStack.length - 1] ? 'Redo: ' : 'Undo: ') + p.label);
    this.emit('map');
  }

  // ---------------------------------------------------------------- files

  updateTitle() {
    const dirty = this.history.dirty;
    document.getElementById('map-title').textContent = (dirty ? '● ' : '') + this.fileName;
    document.title = (dirty ? '● ' : '') + this.fileName + ' — TW Editor';
  }

  async confirmDiscard() {
    if (!this.history.dirty || !this.history.mapSteps) return true;
    return confirmBox('Unsaved changes', 'The current map has unsaved changes. Continue without saving?', 'Continue');
  }

  async newMap() {
    if (!(await this.confirmDiscard())) return;
    this.fileHandle = null;
    this.setMap(newMap(), 'untitled.map');
  }

  // The plain file input, not showOpenFilePicker: Chrome's File System Access picker refuses AppData ("contains system
  // files"), and DDNet keeps its maps in %APPDATA%\DDNet\maps. The input opens any folder (read only); Ctrl+S then
  // asks once where to save (showSaveFilePicker, or a download), and saves there from then on.
  // With the "filedialog" module the editor's own window opens instead (it reaches AppData through editor.py);
  // native = true is its "Browser dialog…" button.
  async openMap(native = false) {
    if (!native && this.ext.fileDialog) return this.ext.fileDialog.open();
    if (!(await this.confirmDiscard())) return;
    document.getElementById('file-open').click();
  }

  async loadFile(file, handle = null) {
    return this.busy(`Opening ${file.name}…`, () => this._loadFile(file, handle));
  }

  async _loadFile(file, handle) {
    try {
      const map = await loadMap(await file.arrayBuffer());
      this.fileHandle = handle;
      this.setMap(map, file.name);
      this.status(`Opened ${file.name}: ${map.groups.length} groups, ${map.images.length} images, ${map.envelopes.length} envelopes`);
    } catch (e) {
      console.error(e);
      this.status('Could not open: ' + e.message);
    }
  }

  async save(as = false, native = false) {
    // a module can write maps somewhere else (ext.saveTargets: the filedialog module writes through editor.py)
    const target = this.fileHandle && this.ext.saveTargets.find((t) => t.matches(this.fileHandle));
    if (!as && target) {
      try {
        const r = await this.busy('Saving…', () => target.save(this, this.fileHandle));
        this.history.markSaved();
        this.emit('saved');
        this.status(r.label);
      } catch (e) { this.status('Save error: ' + e.message); }
      return;
    }
    // "Save as" or a map without a file yet: the editor's own window (filedialog module), unless the browser's was asked for
    if (!native && this.ext.fileDialog && (as || !this.fileHandle || typeof this.fileHandle.createWritable !== 'function')) {
      return this.ext.fileDialog.saveAs();
    }
    // "Save as", or a handle no module can write any more: the browser's own save
    if (this.fileHandle && (target || typeof this.fileHandle.createWritable !== 'function')) this.fileHandle = null;
    let buf;
    try { buf = await this.busy('Saving…', () => saveMap(this.map)); } catch (e) { console.error(e); this.status('Save error: ' + e.message); return; }
    if (window.showSaveFilePicker) {
      try {
        if (as || !this.fileHandle) {
          this.fileHandle = await window.showSaveFilePicker({ suggestedName: this.fileName, types: [{ description: 'DDNet map', accept: { 'application/octet-stream': ['.map'] } }] });
          this.fileName = this.fileHandle.name;
        }
        // a handle restored from the last session needs the write permission again
        if (this.fileHandle.queryPermission && (await this.fileHandle.queryPermission({ mode: 'readwrite' })) !== 'granted') {
          if ((await this.fileHandle.requestPermission({ mode: 'readwrite' })) !== 'granted') throw new Error('No permission to write ' + this.fileName);
        }
        await this.busy('Saving…', async () => {
          const w = await this.fileHandle.createWritable();
          await w.write(buf);
          await w.close();
        });
        this.history.markSaved();
        this.emit('saved');
        this.status(`Saved: ${this.fileName} (${(buf.byteLength / 1024).toFixed(1)} KB)`);
        return;
      } catch (e) { if (e.name === 'AbortError') return; console.warn(e); }
    }
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([buf]));
    a.download = this.fileName;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
    this.history.markSaved();
    this.emit('saved');
    this.status(`Downloaded: ${this.fileName}`);
  }
}
