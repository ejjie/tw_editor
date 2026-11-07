// keeps the open map, its file handle and the view in IndexedDB, so a page reload comes back to the same state
import { loadMap, saveMap } from './map.js';

const DB = 'twe-session', STORE = 'kv';

function db() {
  return new Promise((res, rej) => {
    const r = indexedDB.open(DB, 1);
    r.onupgradeneeded = () => r.result.createObjectStore(STORE);
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
}

export async function putStored(key, value) { return put(key, value); }
export async function getStored(key) { return get(key); }

async function put(key, value) {
  const d = await db();
  await new Promise((res, rej) => {
    const t = d.transaction(STORE, 'readwrite');
    t.objectStore(STORE).put(value, key);
    t.oncomplete = res;
    t.onerror = () => rej(t.error);
  });
  d.close();
}

async function get(key) {
  const d = await db();
  const v = await new Promise((res, rej) => {
    const r = d.transaction(STORE).objectStore(STORE).get(key);
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
  d.close();
  return v;
}

// Editor-only data of modules that goes into the session backup with the map (gores.js: the freeze it placed).
// save(map) -> anything storable; restore(map, value) runs after the map came back.
const extras = new Map();
export function registerSessionExtra(key, { save, restore }) { extras.set(key, { save, restore }); }

// ui: { get() -> {tab, bottomOpen}, set(state) } for the parts of the page main.js owns
export function setupSession(ed, ui) {
  let mapTimer = 0, viewTimer = 0, restoring = true; // nothing is stored until the old session was read back
  let lastMove = 0; // the backup waits while the mouse moves (pen, hovering), so it never interrupts a stroke
  addEventListener('pointermove', () => { lastMove = performance.now(); }, { passive: true, capture: true });

  const saveView = () => {
    clearTimeout(viewTimer);
    viewTimer = setTimeout(() => {
      if (restoring) return;
      put('view', { cam: ed.cam, sel: ed.sel, ...ui.get() }).catch(() => {});
    }, 400);
  };

  let pendingSince = 0;
  const saveMapState = () => {
    clearTimeout(mapTimer);
    if (!pendingSince) pendingSince = performance.now();
    mapTimer = setTimeout(async () => {
      if (restoring || !ed.map) { pendingSince = 0; return; }
      // wait until the mouse is released and still, but never put the backup off for more than 20 s
      if (performance.now() - pendingSince < 20000 && (ed.drag || performance.now() - lastMove < 800)) { saveMapState(); return; }
      pendingSince = 0;
      try {
        const bytes = await saveMap(ed.map, { reuse: true });
        const more = {};
        for (const [k, x] of extras) { try { more[k] = x.save(ed.map); } catch (e) { console.warn(`Session: ${k} not saved`, e); } }
        await put('map', { bytes, name: ed.fileName, handle: ed.fileHandle || null, dirty: ed.history.dirty, time: Date.now(), extras: more });
      } catch (e) { console.warn('Session save failed:', e); }
    }, 1200);
  };

  ed.on('map', () => { saveMapState(); saveView(); });
  ed.on('history', saveMapState);
  ed.on('layerprops', saveMapState);
  ed.on('groupprops', saveMapState);
  ed.on('camera', saveView);
  ed.on('selection', saveView);
  addEventListener('pagehide', () => { if (ed.map && !restoring) put('view', { cam: ed.cam, sel: ed.sel, ...ui.get() }).catch(() => {}); });

  return {
    async restore() {
      let m, v;
      try { [m, v] = await Promise.all([get('map'), get('view')]); } catch { restoring = false; return false; }
      if (!m || !m.bytes) { restoring = false; return false; }
      try {
        const map = await loadMap(m.bytes.buffer ? m.bytes.buffer.slice(m.bytes.byteOffset, m.bytes.byteOffset + m.bytes.byteLength) : m.bytes);
        ed.fileHandle = m.handle || null;
        ed.setMap(map, m.name || 'untitled.map');
        for (const [k, x] of extras) {
          const v = m.extras ? m.extras[k] : m[k]; // backups from before the modules kept it at the top (m.gores)
          if (v !== undefined) { try { x.restore(map, v); } catch (e) { console.warn(`Session: ${k} not restored`, e); } }
        }
        if (m.dirty) { ed.history.savedMarker = null; ed.updateTitle(); }
        if (v) {
          if (v.cam) ed.cam = { ...v.cam };
          if (v.sel && map.groups[v.sel.g]) ed.select(v.sel.g, v.sel.l);
          ui.set(v);
          ed.emit('camera');
        }
        ed.status(`Restored ${ed.fileName} from the last session` + (m.dirty ? ' (with unsaved changes)' : ''));
        return true;
      } catch (e) {
        console.warn('Session restore failed:', e);
        return false;
      } finally {
        restoring = false;
      }
    },
  };
}
