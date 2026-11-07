import { setupSession } from './session.js';
import { Editor } from './editor.js';
import { renderLayers, renderProps, renderBottom, addImageFiles, IMAGE_EXT, CORE_TABS } from './panels.js';
import { loadMap } from './map.js';
import { h, modal, prop, text, refreshPopup, enableNumberScrub, select, info } from './ui.js';
import { makePopups } from './popups.js';
import { applyIcons, iconEl } from './icons.js';
import { MODULES } from './features.js';

// which SF Pro cut is installed: with only "SF Pro Display" (drawn tight for big sizes) the UI text gets a little more tracking
{
  const has = (f) => {
    const c = document.createElement('canvas').getContext('2d'), s = 'mmmmmmmmmmlli1WQ';
    c.font = '32px monospace'; const base = c.measureText(s).width;
    c.font = `32px "${f}", monospace`; return c.measureText(s).width !== base;
  };
  try { if (!has('SF Pro Text') && !has('SF Pro') && has('SF Pro Display')) document.documentElement.classList.add('sf-display'); } catch { /* ignore */ }
}

const ed = new Editor();

// tell the editor server this page is open; when the last editor tab closes, editor.py stops itself and the test server
{
  const id = Math.random().toString(36).slice(2) + Date.now().toString(36);
  const alive = () => fetch('/api/alive?id=' + id, { method: 'POST' }).catch(() => {});
  alive();
  setInterval(alive, 15000);
  addEventListener('pagehide', () => navigator.sendBeacon('/api/bye?id=' + id));
  addEventListener('pageshow', (e) => { if (e.persisted) alive(); }); // back from the browser's page cache
}

// any request to the editor server that takes a moment shows the status bar spinner, so a click never looks ignored
{
  const rawFetch = window.fetch.bind(window);
  window.fetch = (...args) => {
    let done = null;
    const t = setTimeout(() => { if (!ed._busy.size) done = ed.busyStart('Loading…'); }, 250); // a labelled task already shows its own text
    return rawFetch(...args).finally(() => { clearTimeout(t); if (done) done(); });
  };
}
window.editor = ed; // handy in the browser console
ed.popups = makePopups(ed);
for (const [name, t] of Object.entries(CORE_TABS)) ed.ext.tabs.set(name, t);
enableNumberScrub();
applyIcons();
document.querySelector('.slider-ic').replaceWith(iconEl('entities'));
setupResizers();

let tab = 'images';
const refreshLeft = () => renderLayers(ed);
const refreshProps = () => renderProps(ed);
const refreshBottom = () => renderBottom(ed, tab);
ed.refreshProps = refreshProps;

ed.on('map', () => { refreshLeft(); refreshProps(); refreshBottom(); });
// quad and vertex selection also emit 'selection'; the layer tree only changes when another layer or group is picked
let leftSel = '';
const selKey = () => `${ed.sel.g}/${ed.sel.l}/${[...ed.multi].map((l) => ed.group?.layers.indexOf(l)).join(',')}`;
ed.on('map', () => { leftSel = selKey(); });
ed.on('selection', () => { const k = selKey(); if (k !== leftSel) { leftSel = k; refreshLeft(); } refreshProps(); });
ed.on('brush', refreshProps);
ed.on('layerprops', () => { refreshLeft(); refreshProps(); });
ed.on('groupprops', () => { refreshLeft(); refreshProps(); });
// the open bottom tab is rebuilt on the events it lists (refreshOn), see listenTabs() below
for (const ev of ['map', 'selection', 'layerprops', 'groupprops', 'history', 'toggles']) ed.on(ev, refreshPopup);
ed.on('camera', () => { document.getElementById('zoom-label').textContent = Math.round(ed.cam.zoom * 100) + '%'; });
let qmTimer;
ed.on('quadmove', () => { clearTimeout(qmTimer); qmTimer = setTimeout(refreshProps, 80); });
ed.emit('map');
ed.emit('camera');

// ------------------------------------------------------------------ commands

const toggles = {
  grid: () => (ed.opts.grid = !ed.opts.grid),
  proof: () => (ed.opts.proof = !ed.opts.proof),
  parallax: () => { ed.opts.parallax = !ed.opts.parallax; ed.cam.anchor = ed.opts.parallax ? null : { x: ed.cam.x, y: ed.cam.y }; },
  pzoom: () => (ed.opts.parallaxZoom = !ed.opts.parallaxZoom),
  clip: () => (ed.opts.clip = !ed.opts.clip),
  dim: () => (ed.opts.dimOthers = !ed.opts.dimOthers),
  play: () => { ed.opts.play = !ed.opts.play; },
};
const optKey = { grid: 'grid', proof: 'proof', parallax: 'parallax', pzoom: 'parallaxZoom', clip: 'clip', dim: 'dimOthers', play: 'play' };

function syncToggles() {
  for (const [cmd, k] of Object.entries(optKey)) {
    const b = document.getElementById('btn-' + cmd);
    if (b) b.classList.toggle('on', !!ed.opts[k]);
  }
}

// modules add their own commands to ed.commands (quadart, tileart, gores, pen, testmap)
const commands = Object.assign(ed.commands, {
  new: () => ed.newMap(),
  open: () => ed.openMap(),
  save: () => ed.save(false),
  saveas: () => ed.save(true),
  append: () => appendMap(),
  undo: () => ed.undo(),
  redo: () => ed.redo(),
  qbrush: () => ed.toggleQuadBrush(),
  props: () => setPropsPanel(document.getElementById('app').classList.contains('no-right')),
  flipx: () => ed.flipBrush(true),
  flipy: () => ed.flipBrush(false),
  rotccw: () => ed.rotateBrush(false),
  rotcw: () => ed.rotateBrush(true),
  zoomin: () => ed.zoomAt(1.25, ...ed.vp().map((v) => v / 2)),
  zoomout: () => ed.zoomAt(0.8, ...ed.vp().map((v) => v / 2)),
  zoomreset: () => resetCamera(),
  addgroup: () => ed.addGroup(),
  mapinfo: () => mapInfo(),
  goto: () => gotoDialog(),
  pipette: () => { ed.pipette = !ed.pipette; ed.redraw(); },
  info: () => { ed.opts.tileInfo = ed.opts.tileInfo ? 0 : 1; ed.redraw(); },
  settings: () => settingsDialog(),
  help: () => helpDialog(),
});
for (const k of Object.keys(toggles)) commands[k] = () => { toggles[k](); syncToggles(); ed.redraw(); };

function run(cmd) { if (commands[cmd]) commands[cmd](); }

ed.on('toggles', () => { syncToggles(); ed.redraw(); });
ed.on('brush', () => document.getElementById('btn-qbrush').classList.toggle('on', !!ed.quadBrush));
ed.on('selection', () => { const L = ed.layer; document.getElementById('btn-qbrush').disabled = !(L && L.type === 'quads'); });
const rotStep = document.getElementById('rot-step');
rotStep.addEventListener('change', () => { ed.opts.rotStep = Math.max(1, Math.min(359, Math.round(+rotStep.value) || 90)); rotStep.value = ed.opts.rotStep; });
// Enter applies the step and gives the keys back to the map (R, T, B)
rotStep.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === 'Escape') { rotStep.dispatchEvent(new Event('change')); rotStep.blur(); } });

// right click on toolbar buttons opens their settings, like the chevron popups in the DDNet editor (Test: testmap.js)
const toolbarPopups = { grid: 'grid', proof: 'proof', play: 'anim' };
for (const [cmd, name] of Object.entries(toolbarPopups)) {
  const b = document.getElementById('btn-' + cmd);
  b.title += ' (right click: settings)';
  b.addEventListener('contextmenu', (e) => { e.preventDefault(); ed.popups[name](b.getBoundingClientRect().left, b.getBoundingClientRect().bottom + 2); });
}

// no browser context menu inside the editor (text fields keep it for copy/paste);
// right click on a number field selects it for typing, like DDNet's "right click to edit as text"
document.addEventListener('contextmenu', (e) => {
  const t = e.target;
  if (t.matches?.('input[type=number]')) { e.preventDefault(); t.focus(); t.select(); return; }
  if (t.matches?.('input[type=text], textarea')) return;
  e.preventDefault();
});

document.addEventListener('click', (e) => {
  const b = e.target.closest('[data-cmd]');
  if (b) { run(b.dataset.cmd); document.querySelectorAll('.menu.open').forEach((m) => m.classList.remove('open')); }
  const mb = e.target.closest('.menu-btn');
  document.querySelectorAll('.menu').forEach((m) => { if (!mb || m !== mb.parentElement) m.classList.remove('open'); });
  if (mb) mb.parentElement.classList.toggle('open');
});

document.getElementById('ent-alpha').addEventListener('input', (e) => { ed.opts.entitiesAlpha = e.target.value / 100; ed.redraw(); });

// the bottom panel opens from the dock buttons; the same button (or the X) closes it again
// tabs: CORE_TABS in panels.js and the ones modules add (timeline.js); onShow(shown) runs when a tab opens or closes
const bottomOpen = () => document.getElementById('app').classList.contains('bottom-open');
function openTab(name) {
  if (name && !ed.ext.tabs.has(name)) return; // a tab of a module that is not there
  const app = document.getElementById('app');
  const open = !!name && !(bottomOpen() && tab === name);
  const before = bottomOpen() ? tab : null;
  if (name) tab = name;
  app.classList.toggle('bottom-open', open);
  document.querySelectorAll('#tabs [data-tab]').forEach((x) => x.classList.toggle('on', open && x.dataset.tab === tab));
  document.getElementById('bottom-title').textContent = ed.ext.tabs.get(tab)?.title || tab;
  const now = open ? tab : null;
  if (before && before !== now) ed.ext.tabs.get(before)?.onShow?.(false);
  if (now) ed.ext.tabs.get(now)?.onShow?.(true);
  if (open) refreshBottom();
  ed.redraw();
}
function listenTabs() {
  const events = new Set([...ed.ext.tabs.values()].flatMap((t) => t.refreshOn || []));
  for (const ev of events) ed.on(ev, () => { if (bottomOpen() && ed.ext.tabs.get(tab)?.refreshOn?.includes(ev)) refreshBottom(); });
}
ed.openTab = openTab;
document.querySelectorAll('#tabs [data-tab]').forEach((b) => b.addEventListener('click', () => openTab(b.dataset.tab)));
document.getElementById('bottom-close').addEventListener('click', () => openTab(null));

document.getElementById('file-open').addEventListener('change', (e) => { const f = e.target.files[0]; if (f) ed.loadFile(f); e.target.value = ''; });
document.getElementById('file-img').addEventListener('change', (e) => { addImageFiles(ed, [...e.target.files]); e.target.value = ''; });

// drop a .map to open it; drop images (PNG, JPG, WEBP, GIF, BMP…) to add them to the map.
// Dropped on the map view, each image also gets a quad showing it at the drop point.
let dragDepth = 0;
const dropHint = h('div', { id: 'drop-hint' }, h('div', {}, 'Drop images to add them to the map', h('small', {}, 'PNG, JPG, WEBP, GIF, BMP: on the map they also get a quad, a .map file opens')));
document.body.append(dropHint);
const hasFiles = (e) => e.dataTransfer && [...e.dataTransfer.types].includes('Files');
window.addEventListener('dragenter', (e) => { if (hasFiles(e)) { dragDepth++; dropHint.classList.add('on'); } });
window.addEventListener('dragleave', (e) => { if (hasFiles(e) && --dragDepth <= 0) { dragDepth = 0; dropHint.classList.remove('on'); } });
window.addEventListener('dragover', (e) => { if (hasFiles(e)) { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; } });
window.addEventListener('drop', async (e) => {
  dragDepth = 0;
  dropHint.classList.remove('on');
  if (!e.dataTransfer.files.length) return;
  e.preventDefault();
  const files = [...e.dataTransfer.files];
  const map = files.find((f) => f.name.toLowerCase().endsWith('.map'));
  if (map) { if (await ed.confirmDiscard()) ed.loadFile(map); return; }
  const imgs = files.filter((f) => f.type.startsWith('image/') || IMAGE_EXT.test(f.name));
  if (!imgs.length) { ed.status('Only .map files and images can be dropped here'); return; }
  const added = await addImageFiles(ed, imgs);
  const r = document.getElementById('view').getBoundingClientRect();
  if (added.length && e.clientX >= r.left && e.clientX < r.right && e.clientY >= r.top && e.clientY < r.bottom) {
    ed.addImageQuads(added, ...ed.screenToWorld(e.clientX - r.left, e.clientY - r.top, null));
  }
});

window.addEventListener('beforeunload', (e) => { if (ed.history.dirty && ed.history.mapSteps) { e.preventDefault(); e.returnValue = ''; } });
window.addEventListener('resize', () => ed.redraw());
new ResizeObserver(() => ed.redraw()).observe(document.getElementById('view'));

function resetCamera() {
  const L = ed.layer;
  if (L && L.type === 'tiles') { ed.cam.x = (L.width * 32) / 2; ed.cam.y = (L.height * 32) / 2; ed.fitView(L); }
  else { ed.cam.x = 0; ed.cam.y = 0; ed.cam.zoom = 1; }
  ed.emit('camera');
}

// ------------------------------------------------------------------ keyboard

// letter keys by their physical position (e.code), so shortcuts work on any keyboard layout (Russian etc.)
function keyOf(e) {
  const m = /^Key([A-Z])$/.exec(e.code || '');
  if (!m) return e.key;
  return e.shiftKey ? m[1] : m[1].toLowerCase();
}

function typing(e) {
  const t = e.target;
  return t && (t.tagName === 'INPUT' && !['checkbox', 'range', 'color', 'button'].includes(t.type) || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT');
}

document.addEventListener('keydown', (e) => {
  if (document.getElementById('modal-root').children.length) return;
  const mod = e.ctrlKey || e.metaKey;
  const k = keyOf(e).toLowerCase();
  ed._altDown = e.altKey;
  if (mod && k === 's') { e.preventDefault(); run(e.shiftKey ? 'saveas' : 'save'); return; }
  if (mod && k === 'o') { e.preventDefault(); run('open'); return; }
  if (typing(e) && !(mod && e.target.tagName === 'SELECT')) return;
  if (mod && k === 'n') { e.preventDefault(); run('new'); return; }
  if (mod && (k === 'y' || (k === 'z' && e.shiftKey))) { e.preventDefault(); run('redo'); return; }
  if (mod && k === 'z') { e.preventDefault(); run('undo'); return; }
  if (mod && k === 'g') { e.preventDefault(); run('grid'); return; }
  if (mod && k === 'p') { e.preventDefault(); run('proof'); return; }
  if (mod && e.shiftKey && k === 'c') { e.preventDefault(); ed.pipette = !ed.pipette; ed.redraw(); return; }
  if (mod && k === 'i') { e.preventDefault(); ed.opts.tileInfo = e.shiftKey ? (ed.opts.tileInfo === 2 ? 0 : 2) : (ed.opts.tileInfo ? 0 : 1); ed.redraw(); return; }
  if (mod && k === 'u') { e.preventDefault(); ed.nums.allowUnused = !ed.nums.allowUnused; ed.status('Unused tiles: ' + (ed.nums.allowUnused ? 'allowed' : 'not allowed')); ed.emit('brush'); return; }
  // modules first: the quad pen while it is on, Gores (G), pen (D), timeline (K, Delete for keys)
  for (const fn of ed.ext.keys) if (fn(e, k, mod)) { e.preventDefault(); return; }
  if (mod && k === 'c') { ed.copyQuads(); return; }
  if (mod && k === 'v') { e.preventDefault(); ed.pasteQuads(); return; }
  if (mod && k === 'd') { e.preventDefault(); ed.duplicateQuads(); return; }
  if (mod && k === 'a') {
    e.preventDefault();
    const L = ed.layer;
    if (L && L.type === 'quads') { L.quads.forEach((_, i) => ed.quadSel.add(i)); ed.emit('selection'); }
    return;
  }
  if (mod) return;
  if (e.key === ' ') {
    e.preventDefault();
    if (!e.repeat) { if (ed.picker.open && ed.picker.sticky) ed.closePicker(); else ed.openPicker(); }
    return;
  }
  switch (keyOf(e)) {
    case 'n': case 'N': run('flipx'); break;
    case 'm': case 'M': run('flipy'); break;
    case 'r': case 'R':
      // with quads selected R starts free rotation (hold R and move the mouse, like DDNet); Shift+R rotates by the step
      if (e.repeat) break;
      if (!e.shiftKey && ed.startFreeRotate()) break;
      run('rotccw');
      break;
    case 's': case 'S':
      // with quads selected S starts free scaling (hold S and move the mouse left/right)
      if (!e.repeat) ed.startFreeScale();
      break;
    case 'b': case 'B': ed.toggleQuadBrush(); break;
    case 'p': case 'P': run('props'); break;
    case 't': case 'T': run('rotcw'); break;
    case 'Delete': case 'Backspace': ed.deleteQuads(); break;
    case 'Escape': if (ed.freeRot) { ed.endFreeRotate(false); break; } if (ed.freeScale) { ed.endFreeScale(false); break; }
      if (ed.anim.on && ed.clearPoses()) { ed.status('Unkeyed moves dropped'); break; } ed.clearQuadBrush(); ed.knife = null; ed.pipette = false; ed.closePicker(); ed.brush = null; ed.quadSel.clear(); ed.pointSel.clear(); ed.emit('selection'); break;
    case 'Home': resetCamera(); break;
    case '+': case '=': run('zoomin'); break;
    case '-': run('zoomout'); break;
    case 'F1': e.preventDefault(); run('help'); break;
    case 'ArrowUp': case 'ArrowDown': {
      e.preventDefault();
      // walk through all layers of all groups, like DDNet
      const flat = ed.map.groups.flatMap((g, gi) => g.layers.map((_, li) => [gi, li]));
      const cur = flat.findIndex(([g, l]) => g === ed.sel.g && l === ed.sel.l);
      const n = flat[Math.max(0, Math.min(flat.length - 1, cur + (e.key === 'ArrowUp' ? -1 : 1)))];
      if (n) ed.select(...n);
      break;
    }
    case 'ArrowLeft': case 'ArrowRight': {
      // nudge selected quads by 1 unit (Shift: 1 tile)
      const L = ed.layer;
      if (L && L.type === 'quads' && ed.quadSel.size) {
        e.preventDefault();
        const d = (e.key === 'ArrowLeft' ? -1 : 1) * (e.shiftKey ? 32 : 1);
        ed.editQuads('Move', () => ed.selectedQuads().forEach((q) => q.points.forEach((p) => (p[0] += d))));
      }
      break;
    }
    default: break;
  }
});
// the picker is shown only while Space is held (like DDNet); the "Tile picker" button keeps it open until a tile is picked
document.addEventListener('keydown', (e) => { if (e.key === ' ' && !e.repeat && !typing(e)) ed._spaceDown = true; });
// a key released outside the window never sends keyup
addEventListener('blur', () => { ed._spaceDown = false; if (ed.picker.open && !ed.picker.sticky) ed.closePicker(); });
document.addEventListener('keyup', (e) => {
  ed._altDown = e.altKey;
  if (keyOf(e).toLowerCase() === 'r' && ed.freeRot && ed.freeRot.moved) ed.endFreeRotate(true);
  if (keyOf(e).toLowerCase() === 's' && ed.freeScale && ed.freeScale.moved) ed.endFreeScale(true);
  if (e.key !== ' ') return;
  ed._spaceDown = false;
  if (ed.picker.open && !ed.picker.drag && !ed.picker.sticky) ed.closePicker();
});

// ------------------------------------------------------------------ dialogs

function gotoDialog() {
  const [x, y] = ed.screenToWorld(...ed.vp().map((v) => v / 2));
  let tx = Math.floor(x / 32), ty = Math.floor(y / 32);
  modal('Go to position', h('div', {}, prop('Tile X/Y',
    h('input', { type: 'number', value: tx, onchange: (e) => (tx = +e.target.value) }),
    h('input', { type: 'number', value: ty, onchange: (e) => (ty = +e.target.value) }))), [['Cancel', () => {}], ['Go', () => { document.querySelectorAll('.modal input').forEach((i) => i.dispatchEvent(new Event('change'))); ed.gotoPosition(tx, ty); }, 'accent']]);
}

function mapInfo() {
  const i = { ...ed.map.info };
  const body = h('div', { style: { width: '420px' } },
    prop('Author', text(i.author, (v) => (i.author = v), { maxlength: 31 })),
    prop('Version', text(i.version, (v) => (i.version = v), { maxlength: 15 })),
    prop('Credits', text(i.credits, (v) => (i.credits = v), { maxlength: 127 })),
    prop('License', text(i.license, (v) => (i.license = v), { maxlength: 31 })));
  modal('Map details', body, [['Cancel', () => {}], ['Save', () => {
    body.querySelectorAll('input').forEach((x) => x.dispatchEvent(new Event('change')));
    ed.editStructure('Map details', () => Object.assign(ed.map.info, { author: i.author, version: i.version, credits: i.credits, license: i.license }));
  }, 'accent']]);
}

async function settingsDialog() {
  let cfg = { ddnet_data: '', found: false };
  try { cfg = await fetch('/api/config').then((r) => r.json()); } catch { /* offline */ }
  const inp = h('input', { type: 'text', value: cfg.ddnet_data || '', placeholder: 'C:\\Program Files (x86)\\Steam\\steamapps\\common\\DDraceNetwork\\ddnet\\data' });
  const srv = h('input', { type: 'text', value: cfg.ddnet_server || '', placeholder: 'auto' });
  const bg = h('input', { type: 'color', value: '#' + ed.opts.background.slice(0, 3).map((v) => Math.round(v * 255).toString(16).padStart(2, '0')).join('') });
  // entities pictures as tiles; the server serves them from the DDNet data folder when it was found
  const entPreview = (v, where) => {
    const img = h('img', { class: 'ent-pv ' + where, src: '/data/editor/entities/' + encodeURIComponent(v) + '.png' });
    img.onerror = () => img.remove();
    return img;
  };
  const ent = select(['DDNet', 'F-DDrace', 'FNG', 'Race', 'Vanilla', 'blockworlds'].map((n) => [n, n]), ed.opts.entities, () => {}, { preview: entPreview, grid: true });
  modal('Editor settings', h('div', { class: 'settings' },
    h('div', { class: 'qa-sect' }, 'DDNet data folder', info('Standard images (mapres) and entities are taken from it')),
    inp,
    h('div', { class: 'settings-state' + (cfg.found ? ' ok' : '') }, cfg.found ? 'Found' : 'Not found'),
    h('div', { class: 'qa-sect' }, 'DDNet server', info('For "Test map". Leave empty to use the editor\'s own copy in the ddnet-server folder (downloaded automatically), or set the path of DDNet-Server.exe.')),
    srv,
    h('div', { class: 'settings-state' + (cfg.server ? ' ok' : '') }, cfg.server ? 'Using ' + cfg.server : 'Not found'),
    h('div', { class: 'qa-sect' }, 'Look'),
    prop('Map background', bg),
    prop('Entities', ent)), [
    ['Cancel', () => {}],
    ['Save', () => {
      const c = bg.value;
      ed.opts.background = [parseInt(c.slice(1, 3), 16) / 255, parseInt(c.slice(3, 5), 16) / 255, parseInt(c.slice(5, 7), 16) / 255, 1];
      if (ent.value !== ed.opts.entities) { ed.opts.entities = ent.value; ed.renderer.loadEntities(ent.value); }
      try { localStorage.setItem('twe-settings', JSON.stringify({ background: ed.opts.background, entities: ed.opts.entities })); } catch { /* private mode */ }
      ed.redraw();
      fetch('/api/config', { method: 'POST', body: JSON.stringify({ ddnet_data: inp.value, ddnet_server: srv.value.trim() }) }).then((r) => r.json()).then((r) => {
        ed.status(r.found ? 'DDNet folder found, reload the page to load mapres/entities' : 'This folder has no mapres');
      });
    }, 'accent'],
  ]);
}

function helpDialog() {
  const rows = [
    ['Wheel', 'Zoom'], ['Middle button / Alt+LMB', 'Pan the camera'], ['Home', 'Camera to layer'],
    ['Space (hold)', 'Tile picker'], ['G', 'Gores mode: freeze ring around hookable tiles', 'gores'], ['LMB drag (no brush)', 'Copy area into brush'], ['LMB', 'Paint with brush'],
    ['Shift+LMB drag', 'Fill rectangle with brush'], ['Ctrl+Shift+LMB', 'Flood fill'], ['RMB', 'Clear brush'], ['RMB drag (no brush)', 'Erase area'],
    ['N / M', 'Flip brush / quads on X / Y'], ['R / T', 'Rotate brush / quads by the rotation step (toolbar field, degrees)'],
    ['Hold R + move mouse', 'Free rotation of the selected quads (Shift fine, Ctrl snaps to the step); click or release R applies, RMB/Esc cancels'],
    ['K', 'Timeline: key position, rotation and colour of the selected quads at the playhead (opens the timeline)', 'timeline'],
    ['Hold S + move mouse', 'Scale the selected quads, right grows and left shrinks (one quad from its pivot, several from their middle; Shift fine, Ctrl steps of 10%); click or release S applies, RMB/Esc cancels'],
    ['Shift+drag a box (quads)', 'Grab the quads into a quad brush'], ['B', 'Quad brush from the selection / drop the brush'], ['Shift+drag quads or corners', 'Move along one axis (X or Y)'], ['P', 'Show / hide the properties panel'], ['D', 'Quad pen (quads layer): click points, drag for curves, Enter finishes, click the first point (or Shift+click an end) to close', 'pen'], ['Alt+drag / Alt+click a pen handle', 'Move one handle alone / remove it', 'pen'], ['Click with quad brush', 'Place a copy (drag to place several)'],
    ['LMB on quad centre', 'Select and move'], ['Ctrl+drag centre', 'Move pivot only'], ['LMB on a corner of a selected quad', 'Move point'],
    ['Shift+LMB', 'Add to selection'], ['RMB on quad', 'Quad menu'], ['Delete', 'Delete quads'], ['Ctrl+C / Ctrl+V / Ctrl+D', 'Copy / paste / duplicate quads'],
    ['← →', 'Move quads (Shift: by one tile)'], ['↑ ↓', 'Previous / next layer'],
    ['Ctrl+I / Ctrl+Shift+I', 'Tile info (dec / hex)'], ['Ctrl+U', 'Allow unused tiles'], ['Ctrl+Shift+C', 'Colour picker (into selected quads)'],
    ['Ctrl+Z / Ctrl+Y', 'Undo / redo'], ['Ctrl+S / Ctrl+Shift+S', 'Save / save as'], ['Ctrl+O / Ctrl+N', 'Open / new'], ['Ctrl+G', 'Grid (quads snap to grid)'], ['Ctrl+P', 'Proof (screen frame)'],
    ['RMB on group / layer', 'Group / layer menu with its properties'], ['RMB on 👁', 'Show only this group / layer (again: show all)'],
    ['RMB on quad / corner / sound source', 'Its menu with properties'], ['Shift+RMB on quad', 'Delete quad'], ['Ctrl+RMB on map', 'Select the tile layer under the mouse (repeat to cycle)'],
    ['RMB on image / sound', 'Embed, re-import, replace, remove, export'], ['RMB on envelope point / curve', 'Point values / curve type'],
    ['RMB on Grid / Proof / Play', 'Grid size / proof mode / animation speed'], ['Shift+RMB / Shift+LMB on colour', 'Copy / paste colour as RRGGBBAA'], ['RMB on number field', 'Select it to type a value'],
  ];
  // a row with a module id is shown only when that module is there; modules can add rows of their own (ed.ext.help)
  const shown = [...rows.filter((r) => !r[2] || ed.features.has(r[2])), ...ed.ext.help];
  modal('Shortcuts', h('table', { class: 'help-table' }, shown.map(([a, b]) => h('tr', {}, h('td', {}, a), h('td', {}, b)))), [['OK', () => {}]]);
}

// merge another map's groups (DDNet "Append")
async function appendMap() {
  const inp = h('input', { type: 'file', accept: '.map' });
  inp.onchange = async () => {
    const f = inp.files[0];
    if (!f) return;
    const other = await loadMap(await f.arrayBuffer());
    const io = ed.map.images.length, eo = ed.map.envelopes.length, so = ed.map.sounds.length;
    ed.history.edit(ed.map, 'full', 'Append from map', null, () => {
      ed.map.images.push(...other.images);
      ed.map.envelopes.push(...other.envelopes);
      ed.map.sounds.push(...other.sounds);
      for (const g of other.groups) {
        g.layers = g.layers.filter((l) => l.kind === 'tiles' || l.kind === 'quads' || l.kind === 'sounds');
        if (!g.layers.length) continue;
        for (const l of g.layers) {
          if (l.image >= 0) l.image += io;
          if (l.type === 'tiles' && l.colorEnv >= 0) l.colorEnv += eo;
          if (l.type === 'quads') for (const q of l.quads) { if (q.posEnv >= 0) q.posEnv += eo; if (q.colorEnv >= 0) q.colorEnv += eo; }
          if (l.type === 'sounds' && l.sound >= 0) l.sound += so;
        }
        ed.map.groups.push(g);
      }
    });
    ed.emit('map');
    ed.status(`Appended from ${f.name}`);
  };
  inp.click();
}

try {
  const saved = JSON.parse(localStorage.getItem('twe-settings') || 'null');
  if (saved) {
    if (saved.background) ed.opts.background = saved.background;
    if (saved.entities && saved.entities !== 'DDNet') { ed.opts.entities = saved.entities; ed.renderer.loadEntities(saved.entities); }
  }
} catch { /* ignore */ }
syncToggles();

// drag handles between the panels; sizes are remembered per browser
// the properties panel is optional: hidden by default, everything in it is also reachable with right click
function setPropsPanel(show) {
  document.getElementById('app').classList.toggle('no-right', !show);
  document.getElementById('btn-props').classList.toggle('on', show);
  try { localStorage.setItem('twe-props', show ? '1' : '0'); } catch { /* storage blocked */ }
  ed.redraw();
}
ed.setPropsPanel = setPropsPanel;
try { if (localStorage.getItem('twe-props') === '1') setPropsPanel(true); } catch { /* storage blocked */ }


function setupResizers() {
  const app = document.getElementById('app');
  let sizes = {};
  try { sizes = JSON.parse(localStorage.getItem('twe-layout') || '{}'); } catch { /* storage blocked */ }
  const apply = () => { for (const [k, v] of Object.entries(sizes)) app.style.setProperty(k, v + 'px'); };
  apply();
  const handles = [
    ['rz-left', '--left-w', (e) => e.clientX - 8, 170, 520],
    ['rz-right', '--right-w', (e) => innerWidth - 8 - e.clientX, 240, 640],
    ['rz-bottom', '--bottom-h', (e) => innerHeight - 56 - e.clientY, 80, innerHeight * 0.7],
  ];
  for (const [id, prop, measure, min, max] of handles) {
    const el = document.getElementById(id);
    el.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      el.classList.add('active');
      document.body.classList.add('resizing');
      const move = (ev) => { sizes[prop] = Math.round(Math.max(min, Math.min(max, measure(ev)))); apply(); ed.redraw(); };
      const up = () => {
        window.removeEventListener('pointermove', move);
        window.removeEventListener('pointerup', up);
        el.classList.remove('active');
        document.body.classList.remove('resizing');
        try { localStorage.setItem('twe-layout', JSON.stringify(sizes)); } catch { /* ignore */ }
      };
      window.addEventListener('pointermove', move);
      window.addEventListener('pointerup', up);
    });
    el.addEventListener('dblclick', () => { delete sizes[prop]; app.style.removeProperty(prop); try { localStorage.setItem('twe-layout', JSON.stringify(sizes)); } catch { /* ignore */ } ed.redraw(); });
  }
}

// ------------------------------------------------------------------ modules (features.js)

// every module is loaded on its own: a missing or broken file only takes that module away, never the editor
async function loadModules() {
  const loaded = await Promise.allSettled(MODULES.map((m) => import(m.file)));
  loaded.forEach((r, i) => {
    const { id, file } = MODULES[i];
    if (r.status !== 'fulfilled') { console.warn(`Module "${id}" (${file}) is not loaded:`, r.reason); return; }
    try {
      r.value.setup?.(ed);
      ed.features.add(id);
    } catch (e) { console.warn(`Module "${id}" failed to start:`, e); }
  });
  // buttons and menu entries of modules that are not there go away (data-feature="<id>" in index.html)
  document.querySelectorAll('[data-feature]').forEach((el) => { if (!ed.features.has(el.dataset.feature)) el.remove(); });
  listenTabs();
  syncToggles();
  ed.emit('selection');
}
await loadModules();

// come back to the map, view and open tab of the last session after a page reload
const session = setupSession(ed, {
  get: () => ({ tab, bottomOpen: document.getElementById('app').classList.contains('bottom-open') }),
  set: (v) => { if (v.bottomOpen && v.tab) openTab(v.tab); },
});
session.restore();
