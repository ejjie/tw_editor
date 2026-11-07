// Module "ddnetmaps" (with /api/maps in editor.py). Open and save maps in DDNet's own maps folder (%APPDATA%\DDNet\maps). The browser may not touch that folder,
// so the editor server reads and writes the files (editor.py /api/maps). A map opened here is saved back with Ctrl+S.
import { h, modal, btn, confirmBox } from './ui.js';
import { saveMap } from './map.js';

const kb = (n) => (n < 1024 * 1024 ? `${Math.max(1, Math.round(n / 1024))} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`);
const when = (t) => new Date(t * 1000).toLocaleString(undefined, { dateStyle: 'short', timeStyle: 'short' });

// fetch from the editor server; the error says what went wrong (not running, old version, or the server's own error)
async function api(url, opts, as = 'json') {
  let r;
  try { r = await fetch(url, opts); } catch { throw new Error('the editor server is not running (start start.bat)'); }
  if (r.ok) return as === 'json' ? r.json() : r.arrayBuffer();
  let msg = '';
  try { msg = (await r.json()).error || ''; } catch { /* not JSON: an editor.py from before this feature */ }
  if (!msg && r.status === 404) msg = 'this editor.py is older than the page; close its window and run start.bat again';
  throw new Error(msg || `server error ${r.status}`);
}

export async function writeDDNetMap(ed, path) {
  const body = await saveMap(ed.map);
  const r = await api('/api/maps/file?path=' + encodeURIComponent(path), { method: 'POST', body });
  if (r.error) throw new Error(r.error);
  return r;
}

// mode 'open' or 'save'
export async function ddnetMapsDialog(ed, mode = 'open') {
  let list;
  try { list = await ed.busy('Reading the DDNet maps folder…', () => api('/api/maps')); } catch (e) { ed.status('DDNet maps: ' + e.message); return; }
  const saving = mode === 'save';
  const find = h('input', { type: 'text', placeholder: 'Search…' });
  const name = h('input', { type: 'text', value: (ed.fileHandle && ed.fileHandle.server) || ed.fileName || 'untitled.map' });
  const rows = h('div', { class: 'dm-list' });

  const open = async (f) => {
    if (!(await ed.confirmDiscard())) return;
    let buf;
    try { buf = await ed.busy(`Opening ${f.path}…`, () => api('/api/maps/file?path=' + encodeURIComponent(f.path), undefined, 'buf')); } catch (e) { ed.status('DDNet maps: ' + e.message); return; }
    await ed.loadFile(new File([buf], f.path.split('/').pop()), { server: f.path });
    m.close();
  };
  const save = async () => {
    let path = name.value.trim().replace(/\\/g, '/');
    if (!path) return;
    if (!path.toLowerCase().endsWith('.map')) path += '.map';
    if (list.files.some((f) => f.path.toLowerCase() === path.toLowerCase()) && !(ed.fileHandle && ed.fileHandle.server === path)
      && !(await confirmBox('Replace map', `${path} already exists in the DDNet maps folder. Replace it?`, 'Replace'))) return;
    try {
      const r = await writeDDNetMap(ed, path);
      ed.fileHandle = { server: r.saved };
      ed.fileName = r.saved.split('/').pop();
      ed.history.markSaved();
      ed.updateTitle();
      ed.emit('saved'); // like Ctrl+S: the test server reloads the map
      ed.status(`Saved to DDNet maps: ${r.saved} (${kb(r.size)})`);
      m.close();
    } catch (e) { ed.status('Save error: ' + e.message); }
  };

  const paint = () => {
    const q = find.value.trim().toLowerCase();
    rows.innerHTML = '';
    const files = list.files.filter((f) => !q || f.path.toLowerCase().includes(q));
    for (const f of files) {
      const slash = f.path.lastIndexOf('/');
      rows.append(h('button', { class: 'dm-row', title: f.path, onclick: () => (saving ? (name.value = f.path) : open(f)), ondblclick: () => saving && save() },
        h('span', { class: 'dm-name' }, f.path.slice(slash + 1).replace(/\.map$/i, '')),
        h('span', { class: 'dm-dir' }, slash >= 0 ? f.path.slice(0, slash) : ''),
        h('span', { class: 'dm-meta' }, kb(f.size)),
        h('span', { class: 'dm-meta' }, when(f.time))));
    }
    if (!files.length) rows.append(h('div', { class: 'hint', style: { padding: '12px' } }, q ? 'Nothing found' : 'No maps in this folder yet'));
  };
  find.addEventListener('input', paint);
  paint();

  const body = h('div', { class: 'dm' },
    h('div', { class: 'hint dm-path' }, list.dir),
    find, rows,
    saving ? h('div', { class: 'dm-save' }, name, btn('Save', save, { class: 'accent' })) : null);
  name.addEventListener('keydown', (e) => { if (e.key === 'Enter') save(); });
  const m = modal(saving ? 'Save to DDNet maps' : 'Open from DDNet maps', body);
  (saving ? name : find).focus();
}

// File menu entries, and Ctrl+S on a map that came from the DDNet maps folder writes it back there
export function setup(ed) {
  ed.commands.ddnetopen = () => ddnetMapsDialog(ed, 'open');
  ed.commands.ddnetsave = () => ddnetMapsDialog(ed, 'save');
  ed.ext.saveTargets.push({
    matches: (handle) => !!(handle && handle.server),
    async save(ed2, handle) {
      const r = await writeDDNetMap(ed2, handle.server);
      return { label: `Saved to DDNet maps: ${r.saved} (${(r.size / 1024).toFixed(1)} KB)` };
    },
  });
}
