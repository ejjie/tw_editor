// small pictures for the option windows of select(): images, envelopes, curve types, shapes
import { evalEnvelope, envDuration } from './envelope.js';

const SIZE = { button: [22, 16], row: [34, 20], tile: [72, 72] };

function canvas(where, w0, h0) {
  const [w, h] = w0 ? [w0, h0] : SIZE[where] || SIZE.row;
  const c = document.createElement('canvas');
  const d = devicePixelRatio || 1;
  c.width = Math.round(w * d); c.height = Math.round(h * d);
  c.style.width = w + 'px'; c.style.height = h + 'px';
  const g = c.getContext('2d');
  g.scale(d, d);
  return [c, g, w, h];
}

// thumbnail of a map image (fits the box, keeps the aspect)
export function imagePreview(ed) {
  return (v, where) => {
    const src = +v >= 0 && ed.imageSource(+v);
    if (!src) return null;
    const [c, g, w, h] = canvas(where);
    const s = Math.min(w / src.width, h / src.height);
    const dw = src.width * s, dh = src.height * s;
    g.imageSmoothingQuality = 'high';
    g.drawImage(src, (w - dw) / 2, (h - dh) / 2, dw, dh);
    return c;
  };
}

// colour envelopes as a colour strip over time, position and sound envelopes as lines
export function envPreview(ed) {
  return (v, where) => {
    const env = ed.map.envelopes[+v];
    if (!env || !env.points.length) return null;
    const [c, g, w, h] = canvas(where);
    const T = envDuration(env) || 1, N = Math.max(8, Math.round(w));
    const at = (i) => evalEnvelope(env, (i / (N - 1)) * T * 0.9999);
    if (env.channels === 4) {
      for (let i = 0; i < N; i++) {
        const [r, gg, b, a] = at(i);
        g.fillStyle = `rgba(${r * 255},${gg * 255},${b * 255},${Math.max(0.15, a)})`;
        g.fillRect((i / N) * w, 0, w / N + 0.5, h);
      }
      return c;
    }
    const samples = Array.from({ length: N }, (_, i) => at(i));
    const chans = env.channels === 3 ? [0, 1, 2] : [0];
    const cols = ['#ff7a7a', '#7ad27a', '#7aa8ff'];
    for (const ch of chans) {
      const vals = samples.map((s) => s[ch]);
      const lo = Math.min(...vals), hi = Math.max(...vals), span = hi - lo || 1;
      g.strokeStyle = env.channels === 1 ? '#c9d0ff' : cols[ch];
      g.lineWidth = 1.5;
      g.beginPath();
      vals.forEach((x, i) => { const px = (i / (N - 1)) * (w - 2) + 1, py = h - 2 - ((x - lo) / span) * (h - 4); i ? g.lineTo(px, py) : g.moveTo(px, py); });
      g.stroke();
    }
    return c;
  };
}

const CURVES = [
  (k) => (k < 1 ? 0 : 1), (k) => k, (k) => k * k * k, (k) => 1 - (1 - k) ** 3, (k) => -2 * k * k * k + 3 * k * k, (k) => -2 * k * k * k + 3 * k * k,
];
// the shape of an envelope curve type
export function curvePreview(v, where) {
  const f = CURVES[+v];
  if (!f) return null;
  const [c, g, w, h] = canvas(where, where === 'button' ? 20 : 28, 16);
  g.strokeStyle = '#c9d0ff'; g.lineWidth = 1.5;
  g.beginPath();
  for (let i = 0; i <= 24; i++) { const k = i / 24, px = 2 + k * (w - 4), py = h - 2 - f(k) * (h - 4); i ? g.lineTo(px, py) : g.moveTo(px, py); }
  if (+v === 0) { g.moveTo(w - 2, h - 2); g.lineTo(w - 2, 2); }
  g.stroke();
  return c;
}

// circle / rectangle
export function shapePreview(v, where) {
  const [c, g, w, h] = canvas(where, 18, 16);
  g.strokeStyle = '#c9d0ff'; g.lineWidth = 1.5;
  if (v === 'circle') { g.beginPath(); g.arc(w / 2, h / 2, 6, 0, Math.PI * 2); g.stroke(); } else g.strokeRect(3, 2.5, w - 6, h - 5);
  return c;
}

// a colour swatch; null colour shows a crossed box
export function swatchPreview(color) {
  const [c, g, w, h] = canvas(null, 16, 16);
  g.beginPath(); g.roundRect(1, 1, w - 2, h - 2, 4);
  if (color) { g.fillStyle = color; g.fill(); g.strokeStyle = 'rgba(255,255,255,0.25)'; g.stroke(); } else { g.strokeStyle = '#80848e'; g.stroke(); g.beginPath(); g.moveTo(4, h - 4); g.lineTo(w - 4, 4); g.stroke(); }
  return c;
}
