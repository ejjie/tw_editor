// Small DOM helpers.
import { gesture } from './history.js';
import { iconEl, wrapText } from './icons.js';
export function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'value') el.value = v;
    else if (k === 'checked') el.checked = !!v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat(Infinity)) {
    if (c === null || c === undefined || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

// labelled property row
// an info() mark among the controls (also inside a nested row) goes next to the label, so every "i" sits in the same place
export function prop(label, ...controls) {
  const tips = [];
  const take = (c) => {
    if (!(c instanceof Element)) return c;
    if (c.classList.contains('info')) { tips.push(c); return null; }
    if (c.classList.contains('row')) for (const x of [...c.children]) if (x.classList.contains('info')) { x.remove(); tips.push(x); }
    return c;
  };
  const rest = controls.flat().map(take);
  return h('div', { class: 'prop' }, h('label', {}, h('span', { title: tips.length ? null : label }, label), ...tips), h('div', { class: 'row' }, ...rest));
}

export function num(value, onChange, { step = 1, min, max, width } = {}) {
  const el = h('input', { type: 'number', value, step, min, max, style: width ? { width: width + 'px' } : null });
  el.addEventListener('change', () => {
    let v = parseFloat(el.value);
    if (Number.isNaN(v)) v = 0;
    if (min !== undefined) v = Math.max(min, v);
    if (max !== undefined) v = Math.min(max, v);
    el.value = v;
    onChange(v);
  });
  return el;
}

export function text(value, onChange, attrs = {}) {
  const el = h('input', { type: 'text', value, ...attrs });
  el.addEventListener('change', () => onChange(el.value));
  return el;
}

export function check(value, onChange, label) {
  const el = h('input', { type: 'checkbox', checked: value });
  el.addEventListener('change', () => onChange(el.checked));
  return label ? h('label', { class: 'switch-l' }, el, label) : el;
}

// Dropdown replacement: a button that opens a small window with the options, each with an optional preview.
// preview(value, where) returns an element or null ("button" for the closed control, "row"/"tile" in the window);
// grid shows the options as tiles (for pictures). onChange gets the value as a string, like a <select>.
let pickOpen = null;
export function select(options, value, onChange, { preview, grid = false } = {}) {
  const el = h('button', { class: 'pick', type: 'button' });
  let cur = String(value);
  const paint = () => {
    const o = options.find(([v]) => String(v) === cur);
    el.innerHTML = '';
    const pv = preview && preview(cur, 'button');
    if (pv) el.append(h('span', { class: 'pick-pv' }, pv));
    el.append(h('span', { class: 'pick-label' }, o ? o[1] : cur), h('span', { class: 'pick-chev' }));
  };
  paint();
  Object.defineProperty(el, 'value', { get: () => cur, set: (v) => { cur = String(v); paint(); } });
  el.addEventListener('click', (e) => {
    e.stopPropagation();
    if (pickOpen && pickOpen.owner === el) { closePick(); return; }
    openPick(el, options, cur, (v) => { cur = v; paint(); onChange(v); }, preview, grid);
  });
  return el;
}

export function closePick() {
  if (!pickOpen) return;
  pickOpen.menu.remove();
  document.removeEventListener('mousedown', pickOpen.outside, true);
  clearInterval(pickOpen.watch);
  pickOpen.owner.classList.remove('open');
  pickOpen = null;
}

function openPick(owner, options, cur, choose, preview, grid) {
  closePick();
  const menu = h('div', { class: 'pick-menu' + (grid ? ' grid' : '') });
  const list = h('div', { class: 'pick-list' });
  const rows = options.map(([v, t]) => {
    const pv = preview && preview(String(v), grid ? 'tile' : 'row');
    const row = h('button', { type: 'button', class: 'pick-opt' + (String(v) === cur ? ' on' : ''), title: t,
      onclick: () => { closePick(); choose(String(v)); } },
      pv ? h('span', { class: 'pick-pv' }, pv) : grid ? h('span', { class: 'pick-pv empty' }) : null, h('span', { class: 'pick-label' }, t));
    row._text = String(t).toLowerCase();
    list.append(row);
    return row;
  });
  if (options.length > 10) {
    const find = h('input', { type: 'text', class: 'pick-find', placeholder: 'Search' });
    find.addEventListener('input', () => { const q = find.value.toLowerCase(); for (const r of rows) r.style.display = r._text.includes(q) ? '' : 'none'; });
    menu.append(find);
  }
  menu.append(list);
  document.body.append(menu);
  // under the control, or above it when there is no room
  const r = owner.getBoundingClientRect();
  menu.style.minWidth = Math.max(r.width, grid ? 0 : 180) + 'px';
  const mw = menu.offsetWidth, mh = menu.offsetHeight;
  menu.style.left = Math.max(8, Math.min(innerWidth - mw - 8, r.left)) + 'px';
  menu.style.top = (r.bottom + 4 + mh < innerHeight - 8 ? r.bottom + 4 : Math.max(8, r.top - 4 - mh)) + 'px';
  owner.classList.add('open');
  const focusable = () => rows.filter((x) => x.style.display !== 'none');
  menu.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Escape') { closePick(); owner.focus(); return; }
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp' || (grid && (e.key === 'ArrowLeft' || e.key === 'ArrowRight'))) {
      e.preventDefault();
      const f = focusable(), i = f.indexOf(document.activeElement), d = e.key === 'ArrowDown' || e.key === 'ArrowRight' ? 1 : -1;
      const n = f[Math.max(0, Math.min(f.length - 1, i < 0 ? 0 : i + d))];
      if (n) n.focus();
    }
    if (e.key === 'Enter' && document.activeElement.classList.contains('pick-find')) { const f = focusable(); if (f.length) f[0].click(); }
  });
  const outside = (e) => { if (!menu.contains(e.target) && !owner.contains(e.target)) closePick(); };
  document.addEventListener('mousedown', outside, true);
  // the panel that holds the control can be rebuilt while the window is open
  const watch = setInterval(() => { if (!owner.isConnected) closePick(); }, 250);
  pickOpen = { owner, menu, outside, watch };
  const on = rows.find((x) => x.classList.contains('on'));
  (menu.querySelector('.pick-find') || on || rows[0])?.focus();
  if (on) on.scrollIntoView({ block: 'nearest' });
}

export function btn(label, onClick, attrs = {}) {
  const b = h('button', { ...attrs, onclick: onClick }, label);
  if (b.querySelector(':scope > svg.ic')) wrapText(b);
  return b;
}

export function hex(rgb) {
  return '#' + rgb.slice(0, 3).map((v) => Math.max(0, Math.min(255, v | 0)).toString(16).padStart(2, '0')).join('');
}

export function fromHex(s) {
  return [1, 3, 5].map((i) => parseInt(s.slice(i, i + 2), 16));
}

// Colour from text: #RGB, #RGBA, #RRGGBB, #RRGGBBAA (also without # or with $), "r g b [a]" / "r, g, b, a" (0..255),
// rgb()/rgba() CSS forms. Returns [r, g, b, a] or null.
export function parseColor(text, alphaDefault = 255) {
  let t = String(text).trim();
  const css = /^rgba?\((.*)\)$/i.exec(t);
  if (css) t = css[1];
  const hx = t.replace(/^[#$]/, '');
  if (/^[0-9a-f]+$/i.test(hx) && [3, 4, 6, 8].includes(hx.length) && !/^\d{1,3}$/.test(t)) {
    const full = hx.length <= 4 ? [...hx].map((c) => c + c).join('') : hx;
    const v = [0, 2, 4, 6].map((i) => (i < full.length ? parseInt(full.slice(i, i + 2), 16) : alphaDefault));
    return v;
  }
  const nums = t.split(/[\s,;/]+/).filter(Boolean).map(Number);
  if ((nums.length === 3 || nums.length === 4) && nums.every((n) => Number.isFinite(n) && n >= 0)) {
    const unit = nums.every((n) => n <= 1) && /\./.test(t);
    const v = nums.map((n, i) => Math.round(Math.min(255, unit || (css && i === 3 && n <= 1) ? n * 255 : n)));
    if (v.length === 3) v.push(alphaDefault);
    return v;
  }
  return null;
}

export function hex8(c) {
  return '#' + c.map((v) => Math.max(0, Math.min(255, v | 0)).toString(16).padStart(2, '0')).join('').toUpperCase();
}

// ---------------------------------------------------------------- colour picker
// The colour window is a module (colorpicker.js): it registers itself here. Without it a click on a swatch opens the
// browser's own colour dialog (no alpha there; the alpha stays as it was and is typed in the hex field).
// impl(anchor, color, onInput) -> { el, close(), set(color), get() }
let pickerImpl = null;
let openPicker = null;
export function setColorPicker(impl) { pickerImpl = impl; }
export function activePicker() { return openPicker && openPicker.el.isConnected ? openPicker : null; }

function nativePicker(anchor, color, onInput) {
  const inp = h('input', { type: 'color', value: hex(color), style: { position: 'fixed', left: '-100px', top: '0', opacity: '0' } });
  document.body.append(inp);
  gesture.key = {}; // the whole picking is one undo step
  const close = () => { if (!inp.isConnected) return; gesture.key = null; inp.remove(); document.removeEventListener('pointerdown', close, true); };
  inp.addEventListener('input', () => onInput([...fromHex(inp.value), color[3]]));
  inp.addEventListener('change', close);
  setTimeout(() => document.addEventListener('pointerdown', close, true)); // the next click on the page ends it too
  inp.click();
  return { el: inp, close, set: (c) => { inp.value = hex(c); onInput([...c]); }, get: () => [...fromHex(inp.value), color[3]] };
}

export function colorPicker(anchor, color, onInput) {
  if (openPicker && openPicker.el.isConnected) openPicker.close();
  openPicker = (pickerImpl || nativePicker)(anchor, color, onInput);
  return openPicker;
}

// colour editor: a swatch that opens the picker above + one text field with the hex code.
// The text field accepts hex or "r g b a" numbers and is applied on Enter / leaving the field, then shown as hex.
export function rgba(color, onChange) {
  let cur = [...color];
  const c = h('button', { class: 'swatch' });
  const paint = () => c.style.setProperty('--c', `rgba(${cur[0]},${cur[1]},${cur[2]},${cur[3] / 255})`);
  paint();
  const t = h('input', { type: 'text', value: hex8(cur), class: 'color-code', spellcheck: false, title: 'Hex (#RRGGBBAA) or numbers "R G B A" 0..255. Enter applies.' });
  const set = (v) => { cur = v; paint(); t.value = hex8(v); t.classList.remove('bad'); onChange([...v]); };
  t.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); t.blur(); } if (e.key === 'Escape') { t.value = hex8(cur); t.blur(); } });
  t.addEventListener('change', () => {
    const v = parseColor(t.value, cur[3]);
    if (!v) { t.classList.add('bad'); return; }
    if (v.some((x, i) => x !== cur[i])) set(v); else t.value = hex8(v);
  });
  // DDNet: Shift+right click copies the colour as RRGGBBAA, Shift+left click pastes it
  c.title = 'Click to pick a colour. Shift+right click to copy the colour to the clipboard. Shift+left click to paste a colour from the clipboard.';
  c.addEventListener('contextmenu', (e) => {
    if (!e.shiftKey) return;
    e.preventDefault();
    e.stopPropagation();
    navigator.clipboard?.writeText(hex8(cur).slice(1));
    window.dispatchEvent(new CustomEvent('twe-color-copied', { detail: [...cur] })); // into the palette
  });
  c.addEventListener('click', async (e) => {
    if (e.shiftKey) {
      let txt = '';
      try { txt = await navigator.clipboard.readText(); } catch { return; }
      const v = parseColor(txt, 255);
      if (v) set(v);
      return;
    }
    if (activePicker() && openPicker.anchor === c) { openPicker.close(); return; }
    // the panel may be rebuilt while picking, so the picker keeps working on its own copy of the colour
    const p = colorPicker(c, cur, (v) => set(v));
    p.anchor = c;
  });
  return [c, t];
}

export function modal(title, body, buttons = []) {
  const root = document.getElementById('modal-root');
  const close = () => { bg.remove(); document.removeEventListener('keydown', onKey, true); };
  const foot = h('div', { class: 'foot' }, buttons.map(([label, fn, cls]) => h('button', { class: cls, onclick: () => { if (fn() !== false) close(); } }, label)));
  const head = h('div', { class: 'modal-head' }, h('h2', {}, title), h('button', { class: 'ib modal-x', title: 'Close (Esc)', onclick: () => close() }, iconEl('x', 16)));
  const box = h('div', { class: 'modal' }, head, body, buttons.length ? foot : null);
  const bg = h('div', { class: 'modal-bg', onmousedown: (e) => { if (e.target === bg) close(); } }, box);
  root.append(bg);
  // Esc closes the top modal, unless an option window or a colour picker on top of it takes it first
  const onKey = (e) => {
    if (e.key !== 'Escape' || pickOpen || document.querySelector('.cpick') || root.lastElementChild !== bg) return;
    close();
  };
  document.addEventListener('keydown', onKey, true);
  return { close, box };
}

export function confirmBox(title, message, okLabel = 'Yes') {
  return new Promise((res) => {
    let done = false;
    const m = modal(title, h('div', { style: { maxWidth: '420px' } }, message), [
      ['Cancel', () => { done = true; res(false); }],
      [okLabel, () => { done = true; res(true); }, 'accent'],
    ]);
    const obs = new MutationObserver(() => { if (!m.box.isConnected) { obs.disconnect(); if (!done) res(false); } });
    obs.observe(document.getElementById('modal-root'), { childList: true });
  });
}

// Floating popup at the mouse, like DDNet's popup menus. `build(el)` fills it and runs again on refreshPopup();
// returning false from it closes the popup (e.g. the edited object is gone).
let current = null;

export function closePopup() {
  if (!current) return;
  current.el.remove();
  document.removeEventListener('mousedown', current.off, true);
  document.removeEventListener('keydown', current.key, true);
  if (current.cleanup) current.cleanup();
  current = null;
}

// dock: instead of opening at the mouse, the popup becomes a full height panel right of the layer list
// (it stays open while the layer list is used, and follows the selection through refreshPopup).
export function popup(x, y, build, { title, dock = false } = {}) {
  closePopup();
  const el = h('div', { class: 'ctx popup' + (dock ? ' docked island' : ''), oncontextmenu: (e) => e.preventDefault() });
  const body = dock ? h('div', { class: 'dock-body' }) : el;
  // builders pass optional entries as null; skip them instead of printing "null"
  body.append = (...xs) => Element.prototype.append.apply(body, xs.flat().filter((x) => x !== null && x !== undefined && x !== false));
  const render = () => {
    const scroll = body.scrollTop;
    const t = title ? (typeof title === 'function' ? title() : title) : '';
    if (dock) {
      el.innerHTML = '';
      body.innerHTML = '';
      el.append(h('div', { class: 'dock-head' }, h('span', { class: 'dock-title', title: t }, t),
        h('button', { class: 'ib', type: 'button', title: 'Close (Esc)', onclick: () => closePopup() }, iconEl('x', 16))), body);
    } else {
      el.innerHTML = '';
      if (title) el.append(h('div', { class: 'popup-title' }, t));
    }
    if (build(body) === false) { closePopup(); return; }
    body.scrollTop = scroll;
  };
  const keepOpen = (t) => el.contains(t) || t.closest?.('.modal-bg, .pick-menu, .cpick') || (dock && t.closest?.('#left'));
  const off = (e) => { if (!keepOpen(e.target)) closePopup(); };
  const key = (e) => { if (e.key === 'Escape' && !document.querySelector('.pick-menu')) { e.stopPropagation(); closePopup(); } };
  current = { el, render, off, key };
  render();
  if (!current) return null;
  document.body.append(el);
  if (dock) {
    const left = document.getElementById('left');
    const place = () => {
      const r = left.getBoundingClientRect();
      el.style.left = r.right + 8 + 'px';
      el.style.top = r.top + 'px';
      el.style.height = r.height + 'px';
    };
    place();
    const ro = new ResizeObserver(place);
    ro.observe(left);
    addEventListener('resize', place);
    current.cleanup = () => { ro.disconnect(); removeEventListener('resize', place); };
  } else {
    el.style.left = x + 'px';
    el.style.top = y + 'px';
    const r = el.getBoundingClientRect();
    if (r.right > innerWidth) el.style.left = Math.max(4, innerWidth - r.width - 4) + 'px';
    if (r.bottom > innerHeight) el.style.top = Math.max(4, innerHeight - r.height - 4) + 'px';
  }
  setTimeout(() => {
    if (current?.el !== el) return;
    document.addEventListener('mousedown', off, true);
    document.addEventListener('keydown', key, true);
  }, 0);
  return el;
}

// rebuild after an edit, unless the user is busy with a control inside the popup (e.g. an open colour picker)
export function refreshPopup() { if (current && !current.el.contains(document.activeElement)) current.render(); }
export function popupIsDocked() { return !!current && current.el.classList.contains('docked'); }

// menu entry that closes the popup and runs fn
export function item(label, fn, attrs = {}) {
  return h('button', { class: 'item' + (attrs.danger ? ' danger' : '') + (attrs.on ? ' on' : ''), title: attrs.title, disabled: attrs.disabled, onclick: () => { if (!attrs.keep) closePopup(); fn(); } }, label);
}

// items: [label, fn] pairs, '-' separators, or ready DOM nodes
export function contextMenu(x, y, items) {
  return popup(x, y, (el) => {
    for (const it of items.filter(Boolean)) {
      if (it === '-' || it[0] === '-') el.append(h('hr'));
      else if (it instanceof Node) el.append(it);
      else el.append(item(it[0], it[1]));
    }
  });
}

// Every number field can be dragged left/right with the left mouse button (like DDNet's value selectors):
// Shift = fine steps, Ctrl = 10x steps. A click without dragging focuses the field for typing.
// The whole drag is a single undo step (see gesture in history.js).
export function enableNumberScrub() {
  const PX_PER_STEP = 3;
  document.addEventListener('pointerdown', (e) => {
    const el = e.target;
    if (e.button !== 0 || !el.matches?.('input[type=number]') || el.disabled || document.activeElement === el) return;
    e.preventDefault();
    const step = parseFloat(el.step) || 1;
    const min = el.min !== '' ? parseFloat(el.min) : -Infinity, max = el.max !== '' ? parseFloat(el.max) : Infinity;
    const start = parseFloat(el.value) || 0;
    const decimals = Math.min(6, (String(step).split('.')[1] || '').length + 1);
    let prevX = e.clientX, travel = 0, acc = 0, moved = false, last = start;
    const move = (ev) => {
      const dx = ev.clientX - prevX;
      prevX = ev.clientX;
      travel += Math.abs(dx);
      if (!moved && travel < 3) return;
      if (!moved) { moved = true; gesture.key = {}; document.body.classList.add('scrubbing'); }
      const fine = ev.shiftKey, coarse = ev.ctrlKey || ev.metaKey;
      acc += (dx / PX_PER_STEP) * (fine ? 0.1 : coarse ? 10 : 1);
      const quantum = fine ? step / 10 : step;
      let v = Math.round((start + acc * step) / quantum) * quantum;
      v = +Math.max(min, Math.min(max, v)).toFixed(decimals);
      if (v === last) return;
      last = v;
      el.value = v;
      el.dispatchEvent(new Event('change'));
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', up);
      if (moved) { gesture.key = null; document.body.classList.remove('scrubbing'); }
      else if (el.isConnected) { el.focus(); el.select(); }
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', up);
  }, true);
}

// small "i" mark that shows a help text while hovered (or after a click, for touch)
let infoTip = null;
export function info(text) {
  const el = h('span', { class: 'info', tabindex: 0 }, 'i');
  const show = () => {
    hide();
    const r = el.getBoundingClientRect();
    infoTip = h('div', { class: 'info-tip' }, text);
    document.body.append(infoTip);
    const w = infoTip.offsetWidth, ht = infoTip.offsetHeight;
    const x = Math.max(8, Math.min(innerWidth - w - 8, r.left + r.width / 2 - w / 2));
    const below = r.bottom + 6 + ht < innerHeight - 8;
    infoTip.style.left = x + 'px';
    infoTip.style.top = (below ? r.bottom + 6 : r.top - 6 - ht) + 'px';
  };
  const hide = () => { if (infoTip) { infoTip.remove(); infoTip = null; } };
  el.addEventListener('mouseenter', show);
  el.addEventListener('mouseleave', hide);
  el.addEventListener('focus', show);
  el.addEventListener('blur', hide);
  el.addEventListener('mousedown', (e) => e.stopPropagation());
  return el;
}
