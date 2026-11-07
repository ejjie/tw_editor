// Module "testmap" (with testserver.py and /api/test in editor.py). "Test map": the editor server starts DDNet-Server with this map (editor.py / testserver.py) and hot reloads it
// when the map is saved by hand (Ctrl+S, Save as), so a client connected to the reported address sees the saved map. The client itself is never started.
import { saveMap } from './map.js';
import { h, popup, item } from './ui.js';

export function setupTestMap(ed, button) {
  const st = { running: false, address: '', auto: true, busy: false, again: false };
  try { st.auto = localStorage.getItem('twe-test-auto') !== '0'; } catch { /* storage blocked */ }

  const show = (s) => {
    st.running = !!s.running;
    st.address = s.address || '';
    button.classList.toggle('on', st.running);
    button.title = st.running ? `Test server: ${st.address} (click: reload now, right click: menu)` : 'Test the map on a local DDNet server (right click: menu)';
  };

  async function send(quiet = false) {
    if (!ed.map) return;
    if (st.busy) { st.again = true; return; }
    st.busy = true;
    try {
      const label = st.running ? 'Reloading the map on the test server…' : 'Starting the test server… (the first time DDNet is downloaded, this can take a minute)';
      const r = await ed.busy(label, async () => {
        const body = await saveMap(ed.map);
        return fetch('/api/test', { method: 'POST', body }).then((x) => x.json());
      });
      if (r.error) { ed.status('Test server: ' + r.error); return; }
      show(r);
      if (r.started) ed.status(`Test server started. In DDNet connect to ${r.address}`);
      else if (!quiet) ed.status(`Map reloaded on the test server (${r.address})`);
    } catch {
      ed.status('Test server: the editor server is not responding (run editor.py)');
    } finally {
      st.busy = false;
      if (st.again) { st.again = false; send(true); }
    }
  }

  async function stop() {
    try { show(await ed.busy('Stopping the test server…', () => fetch('/api/test/stop', { method: 'POST' }).then((x) => x.json()))); ed.status('Test server stopped'); } catch { /* server gone */ }
  }

  // hot reload only when the map is saved by hand; edits alone never reach the server
  ed.on('saved', () => { if (st.running && st.auto) send(false); });

  fetch('/api/test/status').then((x) => x.json()).then(show).catch(() => {});
  return {
    state: st,
    send: () => send(false),
    stop,
    setAuto(v) { st.auto = v; try { localStorage.setItem('twe-test-auto', v ? '1' : '0'); } catch { /* ignore */ } },
    copyAddress() { navigator.clipboard?.writeText(st.address).catch(() => {}); ed.status(`Copied ${st.address}`); },
  };
}

// the Test button: click sends the map, right click opens the menu
export function setup(ed) {
  const button = document.getElementById('btn-testmap');
  if (!button) return;
  const t = ed.testMap = setupTestMap(ed, button);
  ed.commands.testmap = () => t.send();
  const menu = (x, y) => popup(x, y, (el) => {
    const s = t.state;
    el.append(
      h('div', { class: 'hint', style: { margin: '2px 8px 6px' } }, s.running ? `Running. In DDNet connect to ${s.address}` : 'Starts DDNet-Server with this map. The client is not started: connect to it yourself.'),
      item(s.running ? 'Reload map now' : 'Start test server', () => t.send()),
      s.running ? item('Copy address', () => t.copyAddress()) : null,
      item('Hot reload on save (Ctrl+S)', () => t.setAuto(!s.auto), { on: s.auto, title: 'Send the map to the server each time you save it (hot_reload keeps the tees in place).' }),
      s.running ? item('Stop test server', () => t.stop(), { danger: true }) : null);
  }, { title: 'Test map' });
  ed.popups.test = menu;
  button.title += ' (right click: settings)';
  button.addEventListener('contextmenu', (e) => { e.preventDefault(); const r = button.getBoundingClientRect(); menu(r.left, r.bottom + 2); });
}
