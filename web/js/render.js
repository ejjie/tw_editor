// WebGL2 map renderer: quad layers as triangle batches, tile layers as one rect + tilemap lookup shader.
import { evalEnvelope } from './envelope.js';
import { TILE_BYTES } from './map.js';

const QUAD_VS = `#version 300 es
in vec2 aPos; in vec4 aCol; in vec2 aUV;
uniform vec2 uCam; uniform float uZoom; uniform vec2 uVP;
out vec4 vCol; out vec2 vUV;
void main() {
  vec2 s = (aPos - uCam) * uZoom;
  gl_Position = vec4(s.x * 2.0 / uVP.x, -s.y * 2.0 / uVP.y, 0.0, 1.0);
  vCol = aCol; vUV = aUV;
}`;
const QUAD_FS = `#version 300 es
precision highp float;
in vec4 vCol; in vec2 vUV;
uniform sampler2D uTex; uniform vec4 uTint;
out vec4 o;
void main() { o = vCol * texture(uTex, vUV) * uTint; }`;

const TILE_VS = `#version 300 es
in vec2 aPos;
uniform vec2 uCam; uniform float uZoom; uniform vec2 uVP; uniform vec2 uSize;
out vec2 vTile;
void main() {
  vec2 w = aPos * uSize * 32.0;
  vec2 s = (w - uCam) * uZoom;
  gl_Position = vec4(s.x * 2.0 / uVP.x, -s.y * 2.0 / uVP.y, 0.0, 1.0);
  vTile = aPos * uSize;
}`;
const TILE_FS = `#version 300 es
precision highp float; precision highp usampler2D;
in vec2 vTile;
uniform usampler2D uMap; uniform sampler2D uAtlas; uniform vec4 uColor; uniform vec2 uSize; uniform float uInset;
out vec4 o;
void main() {
  ivec2 t = ivec2(floor(vTile));
  if (t.x < 0 || t.y < 0 || t.x >= int(uSize.x) || t.y >= int(uSize.y)) discard;
  uvec4 d = texelFetch(uMap, t, 0);
  if (d.r == 0u) discard;
  vec2 f = fract(vTile);
  if ((d.g & 8u) != 0u) f = vec2(f.y, 1.0 - f.x);
  if ((d.g & 1u) != 0u) f.x = 1.0 - f.x;
  if ((d.g & 2u) != 0u) f.y = 1.0 - f.y;
  f = clamp(f, uInset, 1.0 - uInset);
  vec2 cell = vec2(float(d.r % 16u), float(d.r / 16u));
  o = texture(uAtlas, (cell + f) / 16.0) * uColor;
}`;

function compile(gl, vs, fs) {
  const p = gl.createProgram();
  for (const [type, src] of [[gl.VERTEX_SHADER, vs], [gl.FRAGMENT_SHADER, fs]]) {
    const s = gl.createShader(type);
    gl.shaderSource(s, src);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
    gl.attachShader(p, s);
  }
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p));
  const u = {};
  const n = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS);
  for (let i = 0; i < n; i++) { const name = gl.getActiveUniform(p, i).name; u[name] = gl.getUniformLocation(p, name); }
  return { p, u };
}

// tile byte layout of special layers -> [index byte, flags byte] for display
export function displayTile(kind, tiles, i) {
  const b = TILE_BYTES[kind], o = i * b;
  switch (kind) {
    case 'tele': case 'tune': return [tiles[o + 1], 0];
    case 'switch': return [tiles[o + 1], tiles[o + 2]];
    case 'speedup': return [tiles[o + 2], 0];
    default: return [tiles[o], tiles[o + 1]];
  }
}

// DDNet IGraphics::CalcScreenParams at zoom 1: world size of the in-game view for a screen aspect
export function screenParams(aspect) {
  let h = Math.sqrt(1150 * 1000) / Math.sqrt(aspect), w = h * aspect;
  if (w > 1500) { w = 1500; h = w / aspect; }
  if (h > 1050) { h = 1050; w = h * aspect; }
  return [w, h];
}

export class Renderer {
  constructor(canvas) {
    const gl = canvas.getContext('webgl2', { antialias: false, alpha: false, preserveDrawingBuffer: true }); // MSAA is done in our own framebuffer, see beginFrame
    if (!gl) throw new Error('WebGL2 is not supported by this browser');
    this.gl = gl;
    this.canvas = canvas;
    this.quadProg = compile(gl, QUAD_VS, QUAD_FS);
    this.tileProg = compile(gl, TILE_VS, TILE_FS);
    this.fb = null;
    this.layerCache = new WeakMap();
    this.texCache = new WeakMap();   // image object -> {tex, w, h}
    this.externalTex = new Map();    // name -> {tex,w,h} | 'loading' | 'missing'
    this.white = this.makeTexture(1, 1, new Uint8Array([255, 255, 255, 255]));
    this.entities = null;
    this.kindAtlas = {};             // tele, speedup, switch, tune, front: their own pictures, like the DDNet editor
    this.onTextureLoaded = () => {};

    this.unitRect = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.unitRect);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([0, 0, 1, 0, 0, 1, 0, 1, 1, 0, 1, 1]), gl.STATIC_DRAW);
    this.tileVAO = gl.createVertexArray();
    gl.bindVertexArray(this.tileVAO);
    const loc = gl.getAttribLocation(this.tileProg.p, 'aPos');
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
    gl.bindVertexArray(null);

    this.repeatSampler = gl.createSampler();
    gl.samplerParameteri(this.repeatSampler, gl.TEXTURE_WRAP_S, gl.REPEAT);
    gl.samplerParameteri(this.repeatSampler, gl.TEXTURE_WRAP_T, gl.REPEAT);
    gl.samplerParameteri(this.repeatSampler, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
    gl.samplerParameteri(this.repeatSampler, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    this.clampSampler = gl.createSampler();
    gl.samplerParameteri(this.clampSampler, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.samplerParameteri(this.clampSampler, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.samplerParameteri(this.clampSampler, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.samplerParameteri(this.clampSampler, gl.TEXTURE_MAG_FILTER, gl.LINEAR);

    this.loadEntities();
    this.loadLayerAtlases();
  }

  makeTexture(w, h, pixels) {
    const gl = this.gl;
    const t = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, t);
    if (pixels instanceof Uint8Array) gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
    else gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
    gl.generateMipmap(gl.TEXTURE_2D);
    return t;
  }

  async loadLayerAtlases() {
    await Promise.all(['tele', 'speedup', 'switch', 'tune', 'front'].map(async (k) => {
      const img = await loadImage('/data/editor/' + k + '.png').catch(() => null);
      if (img) this.kindAtlas[k] = { tex: this.makeTexture(0, 0, img), w: img.width, h: img.height, src: img };
    }));
    this.onTextureLoaded();
  }

  atlasFor(kind) { return kind === 'tiles' ? null : this.kindAtlas[kind] || this.entities; }

  async loadEntities(name = 'DDNet') {
    // DDNet's own entities picture if the server found the game data, else a generated one
    const img = await loadImage('/data/editor/entities/' + encodeURIComponent(name) + '.png').catch(() => null);
    if (img) this.entities = { tex: this.makeTexture(0, 0, img), w: img.width, h: img.height, src: img };
    else {
      const c = generatedEntities();
      this.entities = { tex: this.makeTexture(0, 0, c), w: c.width, h: c.height, src: c };
    }
    this.onTextureLoaded();
  }

  // texture of map image index (or null for none)
  imageTexture(map, idx) {
    const img = map.images[idx];
    if (!img) return null;
    let c = this.texCache.get(img);
    if (c && c.rev === img._rev) return c;
    if (!img.external && img.rgba) {
      c = { tex: this.makeTexture(img.width, img.height, img.rgba), w: img.width, h: img.height, rev: img._rev };
      this.texCache.set(img, c);
      return c;
    }
    const e = this.externalTex.get(img.name);
    if (e && typeof e === 'object') return e;
    if (!e) {
      this.externalTex.set(img.name, 'loading');
      loadImage('/mapres/' + encodeURIComponent(img.name) + '.png').then((im) => {
        this.externalTex.set(img.name, { tex: this.makeTexture(0, 0, im), w: im.width, h: im.height, src: im });
        this.onTextureLoaded();
      }).catch(() => this.externalTex.set(img.name, 'missing'));
    }
    return null;
  }

  externalImage(name) {
    const e = this.externalTex.get(name);
    return e && typeof e === 'object' ? e.src : null;
  }

  resize() {
    const dpr = window.devicePixelRatio || 1;
    const w = Math.round(this.canvas.clientWidth * dpr), h = Math.round(this.canvas.clientHeight * dpr);
    if (this.canvas.width !== w || this.canvas.height !== h) { this.canvas.width = w; this.canvas.height = h; }
    this.dpr = dpr;
  }

  // camera of a group: DDNet IGraphics::MapScreenToWorld (offset + center * parallax).
  // Parallax off works like the DDNet editor's "editor offset" (Shift + pan): the parallax centre stays where the
  // camera was when parallax was turned off and every group moves together from there, so nothing jumps away.
  // Parallax zoom: Scale = (pz * (Zoom - 1) + 100) / 100 / Zoom with pz = clamp(max(parallaxX, parallaxY), 0, 100),
  // where Zoom is the DDNet zoom (1 = the in-game view size of CalcScreenParams), not editor pixels per unit.
  groupCam(g, cam, parallax = true, parallaxZoom = false) {
    let cx = cam.x, cy = cam.y, ex = 0, ey = 0;
    if (!parallax) {
      if (!cam.anchor) cam.anchor = { x: cam.x, y: cam.y };
      cx = cam.anchor.x; cy = cam.anchor.y; ex = cam.x - cx; ey = cam.y - cy;
    }
    let zoom = cam.zoom;
    if (parallax && parallaxZoom) {
      const pz = Math.max(0, Math.min(100, Math.max(g.parallaxX, g.parallaxY)));
      const vw = this.canvas.clientWidth || 1, vh = this.canvas.clientHeight || 1;
      const base = vw / screenParams(vw / vh)[0]; // pixels per world unit at DDNet zoom 1
      const Z = base / cam.zoom; // DDNet zoom of the editor camera
      zoom = base / ((pz * (Z - 1) + 100) / 100);
    }
    return [g.offsetX + cx * g.parallaxX / 100 + ex, g.offsetY + cy * g.parallaxY / 100 + ey, zoom];
  }

  // camera of the game group (parallax 100, no offset): group clip rects are in its coordinates
  gameCam(cam) { return [cam.x, cam.y, cam.zoom]; }

  // offscreen targets: a multisampled scene buffer and its resolved copy (a multisampled buffer can only be
  // resolved into the same format, and the canvas has no alpha)
  targets() {
    const gl = this.gl, W = this.canvas.width, H = this.canvas.height;
    if (this.fb && this.fb.W === W && this.fb.H === H) return this.fb;
    if (this.fb) this.freeTargets();
    const ms = gl.createFramebuffer(), rb = gl.createRenderbuffer();
    gl.bindRenderbuffer(gl.RENDERBUFFER, rb);
    gl.renderbufferStorageMultisample(gl.RENDERBUFFER, Math.min(4, gl.getParameter(gl.MAX_SAMPLES)), gl.RGBA8, W, H);
    gl.bindFramebuffer(gl.FRAMEBUFFER, ms);
    gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.RENDERBUFFER, rb);
    const t = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA8, W, H);
    const fb = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, t, 0);
    this.fb = { W, H, ms, rb, full: { tex: t, fb } };
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    return this.fb;
  }

  freeTargets() {
    const gl = this.gl, f = this.fb;
    gl.deleteFramebuffer(f.ms); gl.deleteRenderbuffer(f.rb);
    gl.deleteFramebuffer(f.full.fb); gl.deleteTexture(f.full.tex);
    this.fb = null;
  }

  draw(map, cam, opts) {
    const gl = this.gl;
    this.resize();
    const f = this.targets();
    gl.bindFramebuffer(gl.FRAMEBUFFER, f.ms);
    this.drawScene(map, cam, opts);
    gl.disable(gl.SCISSOR_TEST);
    const blit = (from, to) => {
      gl.bindFramebuffer(gl.READ_FRAMEBUFFER, from);
      gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, to);
      gl.blitFramebuffer(0, 0, f.W, f.H, 0, 0, f.W, f.H, gl.COLOR_BUFFER_BIT, gl.NEAREST);
    };
    blit(f.ms, f.full.fb); // resolve MSAA
    blit(f.full.fb, null); // show it
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }

  drawScene(map, cam, opts) {
    const gl = this.gl;
    this.resize();
    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    gl.clearColor(...opts.background);
    gl.clear(gl.COLOR_BUFFER_BIT);
    if (!map) return;
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    const vp = [this.canvas.width / this.dpr, this.canvas.height / this.dpr];
    for (const g of map.groups) {
      if (!g.visible) continue;
      const gc = this.groupCam(g, cam, opts.parallax, opts.parallaxZoom);
      const z = gc[2];
      if (g.clipping && opts.clip) {
        // DDNet (CRenderLayerGroup / CLayerGroup::Render): the clip rect is in world units of the game group,
        // whatever the group's own parallax, offset or parallax zoom
        const [gx, gy, gz] = this.gameCam(cam), d = this.dpr;
        const x0 = Math.round(((g.clipX - gx) * gz + vp[0] / 2) * d), y0 = Math.round(((g.clipY - gy) * gz + vp[1] / 2) * d);
        const x1 = Math.round(((g.clipX + g.clipW - gx) * gz + vp[0] / 2) * d), y1 = Math.round(((g.clipY + g.clipH - gy) * gz + vp[1] / 2) * d);
        gl.enable(gl.SCISSOR_TEST);
        gl.scissor(x0, this.canvas.height - y1, Math.max(0, x1 - x0), Math.max(0, y1 - y0));
      }
      for (const l of g.layers) {
        if (!l.visible) continue;
        const dim = opts.focusLayer && opts.dimOthers && l !== opts.focusLayer ? 0.35 : 1;
        if (l.type === 'quads') this.drawQuads(map, l, gc, z, vp, opts.time, dim);
        else if (l.type === 'tiles') {
          const isEnt = l.kind !== 'tiles';
          if (isEnt && !opts.showEntities) continue;
          this.drawTiles(map, l, gc, z, vp, opts.time, dim * (isEnt ? opts.entitiesAlpha : 1));
        }
      }
      gl.disable(gl.SCISSOR_TEST);
    }
    const qp = opts.quadPreview;
    if (qp) {
      const gc = this.groupCam(qp.group, cam, opts.parallax, opts.parallaxZoom);
      this.drawQuads(map, qp.layer, [gc[0] - qp.ox, gc[1] - qp.oy, gc[2]], gc[2], vp, opts.time, 0.6);
    }
    for (const pv of [].concat(opts.preview || [])) { // one preview per edited tile layer
      const gc = this.groupCam(pv.group, cam, opts.parallax, opts.parallaxZoom);
      this.drawTiles(map, pv.layer, [gc[0] - pv.ox, gc[1] - pv.oy], gc[2], vp, opts.time, 0.65);
    }
  }

  drawQuads(map, l, gc, zoom, vp, time, dim) {
    const gl = this.gl;
    const animated = l.quads.some((q) => q.posEnv >= 0 || q.colorEnv >= 0 || q._pose);
    let c = this.layerCache.get(l);
    if (!c) {
      c = { vao: gl.createVertexArray(), buf: gl.createBuffer(), rev: -1, n: 0 };
      gl.bindVertexArray(c.vao);
      gl.bindBuffer(gl.ARRAY_BUFFER, c.buf);
      const p = this.quadProg.p;
      const stride = 8 * 4;
      for (const [name, size, off] of [['aPos', 2, 0], ['aCol', 4, 8], ['aUV', 2, 24]]) {
        const loc = gl.getAttribLocation(p, name);
        gl.enableVertexAttribArray(loc);
        gl.vertexAttribPointer(loc, size, gl.FLOAT, false, stride, off);
      }
      gl.bindVertexArray(null);
      this.layerCache.set(l, c);
    }
    if (c.rev !== l._rev || animated) {
      const arr = new Float32Array(l.quads.length * 6 * 8);
      let o = 0;
      for (const q of l.quads) {
        let pts = q.points;
        let tint = [1, 1, 1, 1];
        const pose = q._pose; // a move made on the timeline that is not keyed yet (editor only)
        if ((q.posEnv >= 0 && map.envelopes[q.posEnv]) || pose) {
          let [dx, dy, rot] = q.posEnv >= 0 && map.envelopes[q.posEnv] ? evalEnvelope(map.envelopes[q.posEnv], time + q.posEnvOffset) : [0, 0, 0];
          if (pose) { dx += pose[0]; dy += pose[1]; rot += pose[2]; }
          const [cx, cy] = q.points[4];
          const a = (rot * Math.PI) / 180, cs = Math.cos(a), sn = Math.sin(a);
          pts = q.points.map(([x, y]) => [cx + (x - cx) * cs - (y - cy) * sn + dx, cy + (x - cx) * sn + (y - cy) * cs + dy]);
        }
        if (q.colorEnv >= 0 && map.envelopes[q.colorEnv]) {
          const e = map.envelopes[q.colorEnv];
          const v = evalEnvelope(e, time + q.colorEnvOffset);
          tint = e.channels === 4 ? v : [1, 1, 1, 1];
        }
        // DDNet splits a quad into (p0,p1,p3) and (p0,p3,p2)
        for (const k of [0, 1, 3, 0, 3, 2]) {
          arr[o++] = pts[k][0]; arr[o++] = pts[k][1];
          const col = q.colors[k];
          arr[o++] = (col[0] / 255) * tint[0]; arr[o++] = (col[1] / 255) * tint[1]; arr[o++] = (col[2] / 255) * tint[2]; arr[o++] = (col[3] / 255) * tint[3];
          arr[o++] = q.tex[k][0]; arr[o++] = q.tex[k][1];
        }
      }
      gl.bindBuffer(gl.ARRAY_BUFFER, c.buf);
      gl.bufferData(gl.ARRAY_BUFFER, arr, animated ? gl.DYNAMIC_DRAW : gl.STATIC_DRAW);
      c.n = l.quads.length * 6;
      c.rev = l._rev;
    }
    if (!c.n) return;
    const { p, u } = this.quadProg;
    gl.useProgram(p);
    gl.uniform2f(u.uCam, gc[0], gc[1]);
    gl.uniform1f(u.uZoom, zoom);
    gl.uniform2f(u.uVP, vp[0], vp[1]);
    gl.uniform4f(u.uTint, 1, 1, 1, dim);
    const t = l.image >= 0 ? this.imageTexture(map, l.image) : null;
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, t ? t.tex : this.white);
    gl.bindSampler(0, this.repeatSampler);
    gl.uniform1i(u.uTex, 0);
    gl.bindVertexArray(c.vao);
    gl.drawArrays(gl.TRIANGLES, 0, c.n);
    gl.bindVertexArray(null);
  }

  drawTiles(map, l, gc, zoom, vp, time, dim) {
    const gl = this.gl;
    const key = l._key || l;
    let c = this.layerCache.get(key);
    if (!c || c.w !== l.width || c.h !== l.height) {
      if (c) gl.deleteTexture(c.tex);
      c = { tex: gl.createTexture(), rev: -1, w: l.width, h: l.height };
      this.layerCache.set(key, c);
    }
    if (c.rev !== l._rev) {
      const n = l.width * l.height;
      const d = new Uint8Array(n * 4);
      for (let i = 0; i < n; i++) { const [a, b] = displayTile(l.kind, l.tiles, i); d[i * 4] = a; d[i * 4 + 1] = b; }
      gl.bindTexture(gl.TEXTURE_2D, c.tex);
      gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8UI, l.width, l.height, 0, gl.RGBA_INTEGER, gl.UNSIGNED_BYTE, d);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      c.rev = l._rev;
    }
    let atlas;
    if (l.kind !== 'tiles') atlas = this.atlasFor(l.kind);
    else atlas = l.image >= 0 ? this.imageTexture(map, l.image) : null;
    if (l.kind === 'tiles' && l.image >= 0 && !atlas) return; // still loading
    let color = l.color.map((v) => v / 255);
    if (l.colorEnv >= 0 && map.envelopes[l.colorEnv] && map.envelopes[l.colorEnv].channels === 4) {
      const v = evalEnvelope(map.envelopes[l.colorEnv], time + l.colorEnvOffset);
      color = color.map((x, i) => x * v[i]);
    }
    const { p, u } = this.tileProg;
    gl.useProgram(p);
    gl.uniform2f(u.uCam, gc[0], gc[1]);
    gl.uniform1f(u.uZoom, zoom);
    gl.uniform2f(u.uVP, vp[0], vp[1]);
    gl.uniform2f(u.uSize, l.width, l.height);
    gl.uniform4f(u.uColor, color[0], color[1], color[2], color[3] * dim);
    gl.uniform1f(u.uInset, atlas ? 0.5 / (atlas.w / 16) : 0);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, c.tex);
    gl.bindSampler(0, null);
    gl.uniform1i(u.uMap, 0);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, atlas ? atlas.tex : this.white);
    gl.bindSampler(1, this.clampSampler);
    gl.uniform1i(u.uAtlas, 1);
    gl.bindVertexArray(this.tileVAO);
    gl.drawArrays(gl.TRIANGLES, 0, 6);
    gl.bindVertexArray(null);
    gl.activeTexture(gl.TEXTURE0);
  }
}

export function loadImage(url) {
  return new Promise((res, rej) => {
    const im = new Image();
    im.onload = () => res(im);
    im.onerror = rej;
    im.src = url;
  });
}

// fallback entities picture: coloured cells with their index
function generatedEntities() {
  const c = document.createElement('canvas');
  c.width = c.height = 1024;
  const x = c.getContext('2d');
  const named = { 1: '#7a7a7a', 2: '#d02020', 3: '#3a3a5a', 9: '#5577ff', 11: '#ff8800' };
  x.font = 'bold 22px sans-serif';
  x.textAlign = 'center';
  x.textBaseline = 'middle';
  for (let i = 1; i < 256; i++) {
    const cx = (i % 16) * 64, cy = Math.floor(i / 16) * 64;
    x.fillStyle = named[i] || `hsla(${(i * 47) % 360},60%,50%,0.75)`;
    x.fillRect(cx, cy, 64, 64);
    x.fillStyle = '#fff';
    x.fillText(String(i), cx + 32, cy + 32);
  }
  return c;
}
