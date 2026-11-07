import { h, hex8, parseColor, setColorPicker } from './ui.js';
import { gesture } from './history.js';

// Module "colorpicker". Own colour picker instead of the browser one: hue/saturation square, hue and alpha sliders, the hex code always visible.
// Changes apply live; the whole picking session is one undo step (see gesture in history.js).

function rgb2hsv([r, g, b]) {
  r /= 255; g /= 255; b /= 255;
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn;
  let hh = 0;
  if (d) hh = mx === r ? ((g - b) / d) % 6 : mx === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return [(hh * 60 + 360) % 360, mx ? d / mx : 0, mx];
}

function hsv2rgb(hh, sat, val) {
  const f = (n) => { const k = (n + hh / 60) % 6; return Math.round(255 * (val - val * sat * Math.max(0, Math.min(k, 4 - k, 1)))); };
  return [f(5), f(3), f(1)];
}

function colorWindow(anchor, color, onInput) {
  const start = [...color];
  let [hu, sa, va] = rgb2hsv(color), al = color[3], cur = [...color];
  const W = 232, SVH = 150;
  const sv = h('canvas', { width: W, height: SVH, class: 'cp-sv' });
  const hue = h('canvas', { width: W, height: 14, class: 'cp-bar' });
  const alpha = h('canvas', { width: W, height: 14, class: 'cp-bar cp-alpha' });
  const hexIn = h('input', { type: 'text', class: 'color-code cp-hex', spellcheck: false, title: 'Hex #RRGGBBAA (also #RGB, #RRGGBB or "r g b a"). Enter applies.' });
  const nums = ['R', 'G', 'B', 'A'].map((l, i) => {
    const n = h('input', { type: 'number', min: 0, max: 255, step: 1, title: l + ' 0..255 (drag left/right)' });
    n.addEventListener('input', () => { const v = Math.max(0, Math.min(255, Math.round(+n.value || 0))); const c = [...cur]; c[i] = v; setRgba(c, true); });
    return [l, n];
  });
  const oldSw = h('button', { class: 'cp-old', title: 'Back to the colour before picking' });
  const newSw = h('div', { class: 'cp-new' });
  oldSw.style.setProperty('--c', `rgba(${start[0]},${start[1]},${start[2]},${start[3] / 255})`);
  const el = h('div', { class: 'cpick' },
    sv, hue, alpha,
    h('div', { class: 'cp-row' }, h('div', { class: 'cp-prev' }, oldSw, newSw), hexIn),
    h('div', { class: 'cp-nums' }, nums.map(([l, n]) => h('label', {}, h('span', {}, l), n))));
  document.body.append(el);

  let raf = 0;
  const emit = () => { if (!raf) raf = requestAnimationFrame(() => { raf = 0; onInput([...cur]); }); };
  const draw = () => {
    let g = sv.getContext('2d');
    g.fillStyle = `hsl(${hu},100%,50%)`; g.fillRect(0, 0, W, SVH);
    let gr = g.createLinearGradient(0, 0, W, 0); gr.addColorStop(0, '#fff'); gr.addColorStop(1, 'rgba(255,255,255,0)'); g.fillStyle = gr; g.fillRect(0, 0, W, SVH);
    gr = g.createLinearGradient(0, 0, 0, SVH); gr.addColorStop(0, 'rgba(0,0,0,0)'); gr.addColorStop(1, '#000'); g.fillStyle = gr; g.fillRect(0, 0, W, SVH);
    const mx = sa * W, my = (1 - va) * SVH;
    g.lineWidth = 2; g.strokeStyle = va > 0.5 && sa < 0.5 ? '#000' : '#fff'; g.beginPath(); g.arc(mx, my, 6, 0, Math.PI * 2); g.stroke();
    g = hue.getContext('2d');
    gr = g.createLinearGradient(0, 0, W, 0);
    for (let k = 0; k <= 6; k++) gr.addColorStop(k / 6, `hsl(${k * 60},100%,50%)`);
    g.fillStyle = gr; g.fillRect(0, 0, W, 14);
    const knob = (ctx, x) => { ctx.lineWidth = 2; ctx.strokeStyle = '#fff'; ctx.strokeRect(Math.round(x) - 3, 1, 6, 12); ctx.strokeStyle = 'rgba(0,0,0,.6)'; ctx.lineWidth = 1; ctx.strokeRect(Math.round(x) - 4.5, 0.5, 9, 13); };
    knob(g, (hu / 360) * W);
    g = alpha.getContext('2d');
    g.clearRect(0, 0, W, 14);
    for (let x = 0; x < W; x += 7) for (let y = 0; y < 14; y += 7) { g.fillStyle = ((x + y) / 7) % 2 ? '#bbb' : '#fff'; g.fillRect(x, y, 7, 7); }
    gr = g.createLinearGradient(0, 0, W, 0); gr.addColorStop(0, `rgba(${cur[0]},${cur[1]},${cur[2]},0)`); gr.addColorStop(1, `rgb(${cur[0]},${cur[1]},${cur[2]})`);
    g.fillStyle = gr; g.fillRect(0, 0, W, 14);
    knob(g, (al / 255) * W);
    newSw.style.setProperty('--c', `rgba(${cur[0]},${cur[1]},${cur[2]},${cur[3] / 255})`);
    if (document.activeElement !== hexIn) { hexIn.value = hex8(cur); hexIn.classList.remove('bad'); }
    nums.forEach(([, n], i) => { if (document.activeElement !== n) n.value = cur[i]; });
  };
  const fromHsv = () => { cur = [...hsv2rgb(hu, sa, va), al]; draw(); emit(); };
  const setRgba = (c, fromNums) => {
    cur = [...c]; al = c[3];
    const [h2, s2, v2] = rgb2hsv(c);
    if (v2 > 0 && s2 > 0) hu = h2;
    if (v2 > 0) sa = s2;
    va = v2;
    draw(); emit();
    if (!fromNums) nums.forEach(([, n], i) => (n.value = cur[i]));
  };
  const drag = (canvas, fn) => canvas.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    canvas.setPointerCapture(e.pointerId);
    const move = (ev) => { const r = canvas.getBoundingClientRect(); fn(Math.max(0, Math.min(1, (ev.clientX - r.left) / r.width)), Math.max(0, Math.min(1, (ev.clientY - r.top) / r.height))); };
    move(e);
    canvas.onpointermove = move;
    canvas.onpointerup = () => { canvas.onpointermove = null; canvas.onpointerup = null; };
  });
  drag(sv, (x, y) => { sa = x; va = 1 - y; fromHsv(); });
  drag(hue, (x) => { hu = x * 360; fromHsv(); });
  drag(alpha, (x) => { al = Math.round(x * 255); fromHsv(); });
  hexIn.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { const v = parseColor(hexIn.value, al); if (v) { hexIn.blur(); setRgba(v); } else hexIn.classList.add('bad'); e.stopPropagation(); }
  });
  hexIn.addEventListener('blur', () => { const v = parseColor(hexIn.value, al); if (v && v.some((x, i2) => x !== cur[i2])) setRgba(v); else { hexIn.value = hex8(cur); hexIn.classList.remove('bad'); } });
  oldSw.addEventListener('click', () => setRgba(start));

  // place under the anchor, inside the window
  const r = anchor.getBoundingClientRect();
  const pw = el.offsetWidth, ph = el.offsetHeight;
  let x = r.left, y = r.bottom + 6;
  if (y + ph > innerHeight - 8) y = Math.max(8, r.top - ph - 6);
  x = Math.max(8, Math.min(innerWidth - pw - 8, x));
  el.style.left = x + 'px'; el.style.top = y + 'px';

  gesture.key = {};
  // a click on the colour palette (right panel) puts its colour into the open picker instead of closing it
  const outside = (e) => { if (!el.contains(e.target) && e.target !== anchor && !e.target.closest?.('.palette')) close(); };
  const onKey = (e) => { if (e.key === 'Escape') { e.stopPropagation(); close(); } };
  const close = () => {
    if (raf) { cancelAnimationFrame(raf); raf = 0; onInput([...cur]); }
    gesture.key = null;
    el.remove();
    document.removeEventListener('pointerdown', outside, true);
    document.removeEventListener('keydown', onKey, true);
  };
  setTimeout(() => document.addEventListener('pointerdown', outside, true));
  document.addEventListener('keydown', onKey, true);
  draw();
  return { el, close, set: (c) => setRgba([...c]), get: () => [...cur] };
}

export function setup() {
  setColorPicker(colorWindow);
}
