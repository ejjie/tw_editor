// Module "quadart" (with quadart.py and img2quads.py on the server side). Built-in quad-art: picture -> coloured quad layers (converter runs in the local Python server).
import { h, modal, prop, num, check, select, btn, info } from './ui.js';
import { iconEl } from './icons.js';
import { swatchPreview } from './previews.js';
import { newGroup, newQuadLayer, makeQuad, findGameLayer } from './map.js';

const PRESETS = {
  color: { label: 'Colour', hint: 'Any image with few colours: palette, JPEG clean-up, outlines.' },
  clean: { label: 'Flat colours', hint: 'Already flat colours (pixel art, prepared images). Fewer quads.' },
  negative: { label: 'Negative', hint: 'Ink drawing: light lines on a dark background, optional grey tone.' },
  lines: { label: 'Lines only', hint: 'Only the line work, every thin line kept, no fills.' },
};

const OUTLINES = [['auto', 'Darkest colour'], ['none', 'None'], ['#000000', 'Black'], ['#ffffff', 'White']];
const outlinePreview = (v) => swatchPreview(v === 'none' ? null : v === 'auto' ? '#3a3f4b' : v);

const state = {
  mode: 'color', colors: 0, heightTiles: 50, optimize: false, slack: 0.002, epsilon: 1.0, outline: 'auto',
  ink: 128, blackhat: 45, gray: false, grayHi: 215, invert: true, thicken: 0, noBackground: false, target: 'new',
};

export function openQuadArt(ed) {
  let imageData = null, result = null, busy = false;
  const orig = h('img');
  const prev = h('img');
  const pane = (title, img, empty) => h('div', { class: 'qa-pane empty' }, h('span', { class: 'qa-tag' }, title), img,
    h('div', { class: 'qa-empty' }, iconEl(title === 'Image' ? 'image' : 'quads', 28), h('div', {}, empty)));
  const origBox = pane('Image', orig, 'No image yet');
  const prevBox = pane('Quads', prev, 'Press Convert to see the result');
  const stats = h('div', { class: 'qa-stats' });
  const controls = h('div', { class: 'qa-controls' });
  const file = h('input', { type: 'file', accept: 'image/*', hidden: true, onchange: () => file.files[0] && loadFile(file.files[0]) });
  const thumb = h('img', { class: 'qa-thumb' });
  const dropName = h('div', { class: 'qa-drop-title' }, 'Choose an image');
  const dropSub = h('div', { class: 'qa-drop-sub' }, 'or drop it here · PNG, JPG, WEBP');
  const drop = h('button', { class: 'qa-drop', onclick: () => file.click() },
    h('div', { class: 'qa-drop-ic' }, iconEl('image', 20), thumb), h('div', { class: 'qa-drop-text' }, dropName, dropSub));
  const convertBtn = btn('Convert', () => convert(), { class: 'accent', disabled: true });
  const insertBtn = btn('Insert into map', () => insert(), { disabled: true });
  const shown = (box, on) => box.classList.toggle('empty', !on);
  // small pictures are scaled up with sharp pixels
  for (const img of [orig, prev]) img.onload = () => img.classList.toggle('px', img.naturalWidth * 2 < img.clientWidth);

  function loadFile(f) {
    const r = new FileReader();
    r.onload = () => {
      imageData = r.result;
      orig.src = imageData;
      thumb.src = imageData;
      drop.classList.add('has');
      dropName.textContent = f.name;
      dropSub.textContent = `${Math.max(1, Math.round(f.size / 1024))} KB · click to change`;
      shown(origBox, true);
      shown(prevBox, false);
      result = null;
      prev.removeAttribute('src');
      convertBtn.disabled = false;
      insertBtn.disabled = true;
      stats.textContent = '';
      if (state.mode === 'color') convert();
    };
    r.readAsDataURL(f);
  }

  function renderControls() {
    controls.innerHTML = '';
    const set = (k) => (v) => { state[k] = v; };
    const sect = (title) => h('div', { class: 'qa-sect' }, title);
    const modes = h('div', { class: 'qa-modes' }, Object.entries(PRESETS).map(([k, p]) =>
      h('button', { class: state.mode === k ? 'on' : '', onclick: () => { state.mode = k; if (k !== 'color') state.optimize = true; renderControls(); } }, p.label)));
    controls.append(drop, file, sect('Mode'), modes, h('div', { class: 'qa-hint' }, PRESETS[state.mode].hint));

    controls.append(sect('Picture'));
    if (state.mode === 'color' || state.mode === 'clean') {
      controls.append(prop('Colours', num(state.colors, set('colors'), { min: 0, max: 8 }), info('Number of colours, 0 picks it automatically')));
      controls.append(prop('Outline', select(OUTLINES, state.outline, set('outline'), { preview: outlinePreview })));
    }
    if (state.mode === 'negative' || state.mode === 'lines') {
      controls.append(prop('Ink threshold', num(state.ink, set('ink'), { min: 1, max: 254 }), info('Pixels darker than this become lines')));
      controls.append(prop('Thin lines', num(state.blackhat, set('blackhat'), { min: 0, max: 255 }), info('Keeps thin faint lines, 0 turns it off')));
      controls.append(prop('Thicken', num(state.thicken, set('thicken'), { min: 0, max: 5 }), info('Makes lines thicker by this many pixels')));
      if (state.mode === 'negative') {
        controls.append(prop('Grey tone', check(state.gray, (v) => { state.gray = v; renderControls(); }), state.gray ? num(state.grayHi, set('grayHi'), { min: 1, max: 254 }) : null, info('Fills mid tones with a grey layer; the number is the lightest grey kept')));
        controls.append(prop('Light lines', h('div', { class: 'row' }, check(state.invert, set('invert')), info('Light lines on a dark background'))));
      }
    }
    controls.append(prop('Height', num(state.heightTiles, set('heightTiles'), { min: 1, max: 1000 }), info('Height of the art in tiles')));

    controls.append(sect('Quality'));
    controls.append(prop('Fewer quads', h('div', { class: 'row' }, check(state.optimize, set('optimize')), info('Merges shapes into fewer quads. Slower on large images.'))));
    controls.append(prop('Slack', num(state.slack, set('slack'), { step: 0.0005, min: 0, max: 0.05 }), info('Share of pixels allowed to be wrong when merging')));
    controls.append(prop('Simplify', num(state.epsilon, set('epsilon'), { step: 0.25, min: 0.25, max: 8 }), info('Outline simplification in pixels')));

    controls.append(sect('Insert'));
    controls.append(prop('Background', h('div', { class: 'row' }, check(!state.noBackground, (v) => { state.noBackground = !v; }), info('Off skips the Background layer'))));
    const g = ed.group;
    controls.append(prop('Target', select([['new', 'New group before Game'], ['group', g ? `Selected group #${ed.sel.g}` : 'Selected group']], state.target, set('target'))));
  }

  async function convert() {
    if (!imageData || busy) return;
    busy = true;
    box.classList.add('busy');
    stats.textContent = state.optimize ? 'Converting… large images can take up to a minute' : 'Converting…';
    const body = { image: imageData, mode: state.mode, colors: state.colors, optimize: state.optimize, slack: state.slack, epsilon: state.epsilon };
    if (state.mode === 'color' || state.mode === 'clean') body.outline = state.outline;
    if (state.mode === 'negative' || state.mode === 'lines') Object.assign(body, { ink: state.ink, blackhat: state.blackhat, gray: state.gray, gray_hi: state.grayHi, invert: state.invert, thicken: state.thicken });
    try {
      const j = await ed.busy('Converting the picture to quads…', async () => (await fetch('/api/quadart', { method: 'POST', body: JSON.stringify(body) })).json());
      if (j.error) throw new Error(j.error);
      result = j;
      prev.src = j.preview;
      shown(prevBox, true);
      if (j.source) orig.src = j.source;
      stats.innerHTML = '';
      stats.append(h('b', {}, String(j.count)), ' quads · ', h('b', {}, String(j.layers.length)), ' layers',
        h('span', { class: 'qa-pal' }, j.palette.map((c) => h('i', { style: { background: c }, title: c }))));
      insertBtn.disabled = false;
    } catch (e) {
      stats.textContent = 'Error: ' + (e.message.includes('fetch') ? 'the editor server is not responding (run editor.py)' : e.message);
    } finally {
      busy = false;
      box.classList.remove('busy');
    }
  }

  function insert() {
    if (!result) return;
    const map = ed.map;
    const u = (state.heightTiles * 32) / result.height;
    const wUnits = result.width * u, hUnits = result.height * u;
    // top-left on the tile grid, art centred in the view
    const [cx, cy] = ed.screenToWorld(...ed.vp().map((v) => v / 2), state.target === 'group' ? ed.group : null);
    const ox = Math.round((cx - wUnits / 2) / 32) * 32, oy = Math.round((cy - hUnits / 2) / 32) * 32;
    const layers = result.layers.filter((l) => !(state.noBackground && l.name === 'Background')).map((l) => {
      const L = newQuadLayer(l.name.slice(0, 11));
      L.quads = l.quads.map((pts) => makeQuad(pts.map(([x, y]) => [ox + x * u, oy + y * u]), [...l.color, 255]));
      return L;
    });
    ed.editStructure('Quad art', () => {
      if (state.target === 'group' && ed.group) {
        const g = ed.group;
        const at = ed.sel.l >= 0 ? ed.sel.l + 1 : g.layers.length;
        g.layers.splice(at, 0, ...layers);
        ed.sel = { g: ed.sel.g, l: at };
      } else {
        const g = newGroup('Art');
        g.layers = layers;
        const game = findGameLayer(map);
        const at = game ? map.groups.indexOf(game.group) : map.groups.length;
        map.groups.splice(at, 0, g);
        ed.sel = { g: at, l: 0 };
      }
    });
    ed.status(`Inserted ${layers.reduce((s, l) => s + l.quads.length, 0)} quads at tile ${ox / 32}, ${oy / 32}`);
    m.close();
  }

  const side = h('div', { class: 'qa-side' }, controls, h('div', { class: 'qa-foot' }, h('div', { class: 'btns' }, convertBtn, insertBtn), stats));
  const box = h('div', { class: 'qa' }, side, h('div', { class: 'qa-previews' }, origBox, prevBox));
  box.addEventListener('dragover', (e) => { e.preventDefault(); box.classList.add('drag'); });
  box.addEventListener('dragleave', (e) => { if (!box.contains(e.relatedTarget)) box.classList.remove('drag'); });
  box.addEventListener('drop', (e) => { e.preventDefault(); e.stopPropagation(); box.classList.remove('drag'); const f = e.dataTransfer.files[0]; if (f) loadFile(f); });
  renderControls();
  const m = modal('Quad art from image', box);
  m.box.classList.add('qa-modal');
}

export function setup(ed) {
  ed.commands.quadart = () => openQuadArt(ed);
}
