// Right click popups modelled on the DDNet editor (popups.cpp): groups, layers, quads, quad points,
// sound sources and the toolbar buttons (the Test button's menu is in testmap.js). Image, sound and envelope popups live next to their tabs in panels.js.
import { h, prop, num, popup, item } from './ui.js';
import { KIND_NAME } from './map.js';
import * as T from './tools.js';
import { layerSheet, cardify, groupProps, quadProps, pointProps, sourceProps } from './panels.js';

const TILE = 32;

export function makePopups(ed) {
  const isGameGroup = (g) => g.layers.some((l) => l.kind === 'game');

  function group(x, y, gi) {
    if (ed.sel.g !== gi || ed.sel.l >= 0) ed.select(gi, -1);
    popup(x, y, (el) => {
      const g = ed.map.groups[ed.sel.g];
      if (!g || ed.sel.l >= 0) return false;
      if (!isGameGroup(g)) el.append(item('Delete group', () => ed.deleteGroup(), { danger: true, title: 'Delete the group.' }));
      else {
        el.append(item('Clean up game tiles', () => ed.cleanUpGameTiles(), { title: "Remove game tiles that aren't based on a layer." }));
        for (const k of ['tele', 'speedup', 'tune', 'front', 'switch']) {
          if (!ed.map.groups.some((gr) => gr.layers.some((l) => l.kind === k))) el.append(item(`Add ${KIND_NAME[k].toLowerCase()} layer`, () => ed.addLayer(k)));
        }
      }
      el.append(
        item('Add quads layer', () => ed.addLayer('quads')),
        item('Add tile layer', () => ed.addLayer('tiles')),
        item('Add sound layer', () => ed.addLayer('sounds')),
        h('div', { class: 'sect' }, 'Group'),
        prop('Order', num(ed.sel.g, (v) => ed.setGroupOrder(Math.round(v)), { min: 0, max: ed.map.groups.length - 1 })));
      groupProps(ed, el, g);
      cardify(el, null);
    }, { dock: true, title: () => `Group #${ed.sel.g} ${ed.group ? ed.group.name : ''}` });
  }

  function layer(x, y, gi, li) {
    if (ed.sel.g !== gi || ed.sel.l !== li) ed.select(gi, li);
    popup(x, y, (el) => {
      const L = ed.layer;
      if (!L) return false;
      layerSheet(ed, el, L);
      cardify(el, null);
    }, { dock: true, title: () => { const L = ed.layer; if (!L) return ''; const k = KIND_NAME[L.kind] || L.kind; return L.name && L.name !== k ? `${L.name}  ·  ${k} layer` : `${k} layer`; } });
  }

  function quad(x, y) {
    popup(x, y, (el) => {
      const L = ed.layer;
      if (!L || L.type !== 'quads' || !ed.quadSel.size) return false;
      const one = ed.quadSel.size === 1;
      const all = (label, fn) => () => ed.editQuads(label, () => ed.selectedQuads().forEach(fn));
      el.append(
        item('Delete', () => ed.deleteQuads(), { danger: true, title: 'Delete the current quad.' }),
        item('Duplicate  (Ctrl+D)', () => ed.duplicateQuads()),
        item('Copy  (Ctrl+C)', () => ed.copyQuads()),
        h('hr'),
        L.image >= 0 ? item('Aspect ratio', () => ed.aspectQuads(), { title: 'Resize the current quad based on the aspect ratio of its image.' }) : null,
        item('Center pivot', () => ed.centerPivot(), { title: 'Center the pivot of the current quad.' }),
        item('Align', all('Align', (q) => T.alignQuad(q, TILE / 2)), { title: 'Align coordinates of the quad points.' }),
        item('Square', all('Square', T.squareQuad), { title: 'Square the current quad.' }),
        one ? item('Slice', () => ed.startKnife(), { title: 'Enable quad knife mode.' }) : null,
        item('Rotate 90°', all('Rotate', (q) => T.rotateQuad(q, 90))),
        item('Flip horizontally', all('Flip', (q) => T.flipQuad(q, true))),
        item('Flip vertically', all('Flip', (q) => T.flipQuad(q, false))),
        item('Bring to front', () => ed.reorderQuads(true)),
        item('Send to back', () => ed.reorderQuads(false)),
        h('hr'));
      quadProps(ed, el, L, true);
    }, { title: () => (ed.quadSel.size === 1 ? `Quad #${[...ed.quadSel][0]}` : `${ed.quadSel.size} quads`) });
  }

  function point(x, y) {
    popup(x, y, (el) => {
      const L = ed.layer;
      if (!L || L.type !== 'quads') return false;
      return pointProps(ed, el, L);
    }, { title: () => (ed.pointSel.size === 1 ? `Point ${[...ed.pointSel][0].replace(':', ' / ')}` : `${ed.pointSel.size} points`) });
  }

  function source(x, y) {
    popup(x, y, (el) => {
      const L = ed.layer;
      if (!L || L.type !== 'sounds' || !L.sources[ed.sourceSel]) return false;
      const s = L.sources[ed.sourceSel];
      el.append(
        item('Delete', () => ed.deleteSource(), { danger: true, title: 'Delete the current sound source.' }),
        item('Duplicate', () => ed.addSource(s.x + 64, s.y, s)),
        h('hr'));
      sourceProps(ed, el, L);
    }, { title: () => `Sound source #${ed.sourceSel}` });
  }

  // ------------------------------------------------------------ toolbar buttons

  function grid(x, y) {
    popup(x, y, (el) => {
      el.append(
        prop('Size', num(ed.opts.gridSize, (v) => { ed.opts.gridSize = Math.max(1, Math.min(15, Math.round(v))); ed.opts.grid = true; ed.emit('toggles'); }, { min: 1, max: 15 })),
        item('Default', () => { ed.opts.gridSize = 1; ed.emit('toggles'); }, { keep: true, title: 'Reset to normal grid size.' }));
    }, { title: 'Grid' });
  }

  function proof(x, y) {
    popup(x, y, (el) => {
      const mode = ed.opts.proofMode || 'ingame';
      el.append(
        item('Ingame', () => { ed.opts.proofMode = 'ingame'; ed.opts.proof = true; ed.emit('toggles'); }, { on: mode === 'ingame', title: 'These borders represent what a player maximum can see.' }),
        item('Menu', () => { ed.opts.proofMode = 'menu'; ed.opts.proof = true; ed.emit('toggles'); }, { on: mode === 'menu', title: 'These borders represent what will be shown in the menu.' }));
    }, { title: 'Proof mode' });
  }

  function anim(x, y) {
    popup(x, y, (el) => {
      const sp = ed.opts.animSpeed;
      const set = (v) => { ed.opts.animSpeed = Math.round(Math.max(0.1, Math.min(10, v)) * 10) / 10; ed.emit('toggles'); };
      el.append(
        prop('Speed', item('−', () => set(sp - (sp <= 1 ? 0.1 : 0.5)), { keep: true }), h('span', { style: { minWidth: '36px', textAlign: 'center' } }, sp.toFixed(1)), item('+', () => set(sp + (sp < 1 ? 0.1 : 0.5)), { keep: true })),
        item('Default', () => set(1), { keep: true, title: 'Reset to normal animation speed.' }),
        item('Jump to beginning', () => { ed.opts.time = 0; ed.emit('toggles'); }, { title: 'Jump to beginning of animation.' }));
    }, { title: 'Animation' });
  }

  // modules add their own (testmap.js: test)
  return { group, layer, quad, point, source, grid, proof, anim };
}
