// Module "filedialog" (with filebrowser.py next to editor.py). The editor's own Open / Save window: File → Open, Save as,
// Ctrl+O, Ctrl+Shift+S and the first Ctrl+S of a new map open it instead of the browser's dialog.
//
// Why not the browser's dialog: Chrome does not let a web page into AppData ("contains system files"), and DDNet keeps
// its maps in %APPDATA%\DDNet\maps; the page is also never told where a picked file lives. Here the editor server lists
// the folders and reads / writes the .map files, so any folder works, DDNet maps is one click away, and Ctrl+S writes
// back to the same file. "Browser dialog…" at the bottom of the window still opens the browser's own one.
//
// Without this module (or without filebrowser.py, or with the server stopped) the File menu uses the browser's dialogs.
import { h, modal, btn, confirmBox } from './ui.js';
import { iconEl } from './icons.js';
import { saveMap } from './map.js';

const kb = (n) => (n < 1024 * 1024 ? `${Math.max(1, Math.round(n / 1024))} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`);
const when = (t) => new Date(t * 1000).toLocaleString(undefined, { dateStyle: 'short', timeStyle: 'short' });
const baseName = (p) => p.split(/[\\/]/).pop();
const dirName = (p) => p.slice(0, Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\')));
const isAbs = (p) => /^[a-zA-Z]:[\\/]/.test(p) || /^[\\/]/.test(p) || p.startsWith('~');

const store = {
  get(k, d) { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* private window */ } },
};
const RECENT = 'twe-files-recent'; // last opened / saved maps, newest first
const LASTDIR = 'twe-files-dir';
const SORT = 'twe-files-sort';
function remember(path) {
  store.set(RECENT, [path, ...store.get(RECENT, []).filter((p) => p.toLowerCase() !== path.toLowerCase())].slice(0, 12));
  store.set(LASTDIR, dirName(path));
}

// fetch from the editor server; the error says what went wrong (not running, old version, or the server's own error)
async function api(url, opts = {}, as = 'json') {
  let r;
  try { r = await fetch(url, { ...opts, headers: { 'X-TW-Editor': '1' } }); } catch { throw new Error('the editor server is not running (start start.bat)'); }
  if (r.ok) return as === 'json' ? r.json() : r.arrayBuffer();
  let msg = '';
  try { msg = (await r.json()).error || ''; } catch { /* not JSON: an editor.py from before this feature */ }
  if (!msg && r.status === 404) msg = 'this editor.py is older than the page; close its window and run start.bat again';
  throw new Error(msg || `server error ${r.status}`);
}
const q = (o) => Object.entries(o).map(([k, v]) => k + '=' + encodeURIComponent(v)).join('&');

async function writeMap(ed, path) {
  const body = await saveMap(ed.map);
  return api('/api/fs/file?' + q({ path }), { method: 'POST', body });
}

async function openPath(ed, path) {
  const buf = await ed.busy(`Opening ${baseName(path)}…`, () => api('/api/fs/file?' + q({ path }), undefined, 'buf'));
  await ed.loadFile(new File([buf], baseName(path)), { path });
  remember(path);
}

function savedAs(ed, r) {
  ed.fileHandle = { path: r.saved };
  ed.fileName = baseName(r.saved);
  ed.history.markSaved();
  ed.updateTitle();
  ed.emit('saved'); // like Ctrl+S: the test server reloads the map
  ed.status(`Saved: ${r.saved} (${kb(r.size)})`);
  remember(r.saved);
}

// mode 'open' or 'save'
async function fileDialog(ed, mode) {
  const saving = mode === 'save';
  let places;
  try { places = await api('/api/fs/places'); } catch (e) {
    // no file browser on the server: the browser's own dialog, so Open / Save never stop working
    ed.status('Editor file window unavailable (' + e.message + '), using the browser dialog');
    return saving ? ed.save(true, true) : ed.openMap(true);
  }
  if (!saving && !(await ed.confirmDiscard())) return;

  const sep = places.sep || '\\';
  const cur = ed.fileHandle && ed.fileHandle.path;
  let dir = (cur && dirName(cur)) || store.get(LASTDIR, '') || places.places[0].path;
  let list = null;        // listing of dir
  let deep = null;        // .map files of dir and all its subfolders (for search)
  let view = 'dir';       // 'dir' or 'recent'
  let sort = store.get(SORT, 'name');
  let rowsNow = [];       // what is shown: { kind: 'dir'|'file', path, ... }
  let hi = -1;            // highlighted row (arrow keys)

  const pathIn = h('input', { type: 'text', class: 'fd-pathin', spellcheck: 'false', title: 'Folder: type or paste any path, Enter to go there' });
  const find = h('input', { type: 'text', class: 'fd-find', placeholder: 'Search here and in subfolders…' });
  const name = h('input', { type: 'text', spellcheck: 'false', value: ed.fileName || 'untitled.map' });
  const rows = h('div', { class: 'fd-list', tabindex: -1 });
  const side = h('div', { class: 'fd-side' });
  const sortBtn = h('button', { class: 'fd-sort', title: 'Sort files by name or by date' });
  const upBtn = h('button', { class: 'ib', title: 'Up one folder (Backspace)', onclick: () => list && list.parent !== null && go(list.parent) }, iconEl('up', 16));

  const fail = (e) => ed.status((saving ? 'Save error: ' : 'Open error: ') + e.message);

  async function go(d) {
    view = 'dir';
    try { list = await api('/api/fs/list?' + q({ dir: d })); } catch (e) { fail(e); pathIn.value = dir; return; }
    dir = list.dir; deep = null; find.value = ''; hi = -1;
    if (dir) store.set(LASTDIR, dir);
    pathIn.value = dir;
    pathIn.scrollLeft = pathIn.scrollWidth; // the end of a long path is the part that matters
    paint();
  }

  let deepTimer = 0;
  async function search() {
    clearTimeout(deepTimer);
    paint();
    if (find.value.trim() && view === 'dir' && dir && !deep) {
      deepTimer = setTimeout(async () => {
        try { deep = await api('/api/fs/list?' + q({ dir, deep: 1 })); } catch { deep = { files: [] }; }
        paint();
      }, 200);
    }
  }

  const choose = async (r) => {
    if (!r) return;
    if (r.kind === 'dir') return go(r.path);
    if (saving) { name.value = r.name; name.focus(); return; }
    try { await openPath(ed, r.path); m.close(); } catch (e) { fail(e); }
  };

  async function save() {
    let n = name.value.trim();
    if (!n) return;
    if (!n.toLowerCase().endsWith('.map')) n += '.map';
    if (!isAbs(n) && (!dir || view !== 'dir')) { ed.status('Open a folder first, or type the full path'); return; }
    const path = isAbs(n) ? n : (dir.endsWith(sep) || dir.endsWith('/') ? dir : dir + sep) + n.replace(/[\\/]/g, sep);
    const same = cur && cur.toLowerCase() === path.toLowerCase();
    const exists = list && list.files.some((f) => f.path.toLowerCase() === path.toLowerCase());
    if (exists && !same && !(await confirmBox('Replace map', `${baseName(path)} already exists in this folder. Replace it?`, 'Replace'))) return;
    try {
      const r = await ed.busy('Saving…', () => writeMap(ed, path));
      savedAs(ed, r);
      m.close();
    } catch (e) { fail(e); }
  }

  function row(r, extra) {
    const isDir = r.kind === 'dir';
    const b = h('button', { class: 'fd-row' + (isDir ? ' dir' : ''), title: r.path, onclick: () => choose(r), ondblclick: () => saving && !isDir && save() },
      iconEl(isDir ? 'folder' : 'file', 14),
      h('span', { class: 'fd-name' }, isDir ? r.name : r.name.replace(/\.map$/i, '')),
      h('span', { class: 'fd-dir' }, extra || ''),
      h('span', { class: 'fd-meta' }, r.size == null ? '' : kb(r.size)),
      h('span', { class: 'fd-meta' }, r.time == null ? '' : when(r.time)));
    return b;
  }

  function paint() {
    const qq = find.value.trim().toLowerCase();
    rows.innerHTML = '';
    rowsNow = [];
    const add = (r, extra) => { rowsNow.push(r); rows.append(row(r, extra)); };
    if (view === 'recent') {
      for (const p of store.get(RECENT, [])) if (!qq || p.toLowerCase().includes(qq)) add({ kind: 'file', path: p, name: baseName(p) }, dirName(p));
    } else if (list) {
      const files = [...list.files].sort(sort === 'date' ? (a, b) => b.time - a.time : (a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
      for (const d of list.dirs) if (!qq || d.name.toLowerCase().includes(qq)) add({ kind: 'dir', ...d });
      for (const f of files) if (!qq || f.name.toLowerCase().includes(qq)) add({ kind: 'file', ...f });
      if (qq && deep) {
        const here = new Set(list.files.map((f) => f.path.toLowerCase()));
        for (const f of deep.files) {
          if (here.has(f.path.toLowerCase()) || !f.path.toLowerCase().slice(dir.length).includes(qq)) continue;
          add({ kind: 'file', ...f }, dirName(f.path).slice(dir.length).replace(/^[\\/]/, ''));
        }
      }
    }
    if (!rowsNow.length) {
      const msg = view === 'recent' ? 'No recent maps yet' : qq ? (deep ? 'Nothing found' : 'Searching…') : 'No maps or folders here';
      rows.append(h('div', { class: 'hint', style: { padding: '12px' } }, msg));
    }
    hi = Math.min(hi, rowsNow.length - 1);
    mark();
    sortBtn.textContent = sort === 'date' ? 'Newest first' : 'A–Z';
    upBtn.disabled = view !== 'dir' || !list || list.parent === null;
    side.querySelectorAll('.fd-place').forEach((b) => b.classList.toggle('on',
      b.dataset.recent ? view === 'recent' : view === 'dir' && b.dataset.path.toLowerCase() === (dir || '').toLowerCase()));
  }
  function mark() {
    [...rows.children].forEach((el, i) => el.classList.toggle('hi', i === hi));
    if (hi >= 0) rows.children[hi]?.scrollIntoView({ block: 'nearest' });
  }

  sortBtn.addEventListener('click', () => { sort = sort === 'date' ? 'name' : 'date'; store.set(SORT, sort); paint(); });
  find.addEventListener('input', search);
  pathIn.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    const p = pathIn.value.trim().replace(/^"|"$/g, '');
    if (/\.map$/i.test(p)) { if (saving) { name.value = p; save(); } else choose({ kind: 'file', path: p }); } else go(p);
  });
  // arrows move through the list, Enter opens, Backspace goes up (when no text field is being edited)
  const keys = (e) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      hi = Math.max(0, Math.min(rowsNow.length - 1, hi + (e.key === 'ArrowDown' ? 1 : -1)));
      mark();
    } else if (e.key === 'Enter' && (e.target === find || e.target === rows)) {
      e.preventDefault();
      choose(rowsNow[hi >= 0 ? hi : 0]);
    } else if (e.key === 'Backspace' && e.target.tagName !== 'INPUT' || e.key === 'Backspace' && e.target === find && !find.value) {
      e.preventDefault();
      if (list && list.parent !== null) go(list.parent);
    }
  };
  name.addEventListener('keydown', (e) => { if (e.key === 'Enter') save(); });

  const place = (p) => h('button', { class: 'fd-place', 'data-path': p.path, title: p.path, onclick: () => go(p.path) },
    iconEl(p.icon === 'ddnet' ? 'home' : 'folder', 14), h('span', {}, p.name));
  side.append(
    h('button', { class: 'fd-place', 'data-recent': '1', 'data-path': '', onclick: () => { view = 'recent'; find.value = ''; hi = -1; pathIn.value = 'Recent maps'; paint(); } },
      iconEl('history', 14), h('span', {}, 'Recent')),
    ...places.places.map(place),
    h('div', { class: 'fd-sect' }, 'Drives'),
    ...places.drives.map((d) => place({ name: d.replace(/\\$/, ''), path: d, icon: 'folder' })));

  const native = btn('Browser dialog…', () => { m.close(); saving ? ed.save(true, true) : ed.openMap(true); }, { class: 'fd-native', title: "The browser's own file dialog" });
  const body = h('div', { class: 'fd', onkeydown: keys },
    h('div', { class: 'fd-bar' }, upBtn, pathIn, find),
    h('div', { class: 'fd-main' }, side, h('div', { class: 'fd-right' }, h('div', { class: 'fd-head' }, h('span', {}, 'Name'), sortBtn), rows)),
    h('div', { class: 'fd-foot' }, native,
      saving ? h('div', { class: 'fd-save' }, name, btn('Save', save, { class: 'accent' })) : null));
  const m = modal(saving ? 'Save map as' : 'Open map', body);

  await go(dir);
  if (!list) await go(places.places[0].path); // the last folder is gone: DDNet maps
  if (saving) { name.focus(); name.select(); } else find.focus();
}

export function setup(ed) {
  ed.ext.fileDialog = {
    open: () => fileDialog(ed, 'open'),
    saveAs: () => fileDialog(ed, 'save'),
  };
  // Ctrl+S on a map opened or saved through the window writes it back to the same file
  // ({ server } handles are maps opened from the DDNet maps folder by older versions of the editor)
  ed.ext.saveTargets.push({
    matches: (handle) => !!(handle && (handle.path || handle.server)),
    async save(ed2, handle) {
      const r = handle.path ? await writeMap(ed2, handle.path)
        : await api('/api/maps/file?' + q({ path: handle.server }), { method: 'POST', body: await saveMap(ed2.map) });
      if (handle.path) remember(r.saved);
      return { label: `Saved: ${r.saved} (${kb(r.size)})` };
    },
  });
}
