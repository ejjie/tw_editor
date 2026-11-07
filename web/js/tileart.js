// Module "tileart". DDNet "Add tile art": every pixel of a small picture becomes one tile; each colour gets a
// 64x64 swatch in generated 16x16 tilesets (255 colours per tileset, index 0 stays empty).
import { newGroup, newTileLayer } from './map.js';
import { loadImage } from './render.js';
import { confirmBox, h } from './ui.js';

export async function addTileArt(ed, file) {
  const url = URL.createObjectURL(file);
  let im;
  try { im = await loadImage(url); } finally { URL.revokeObjectURL(url); }
  const W = im.width, H = im.height;
  if (W * H > 10000 && !(await confirmBox('Large image', `The image is ${W}×${H}, that is ${W * H} tiles. Continue?`, 'Continue'))) return;
  const c = document.createElement('canvas');
  c.width = W; c.height = H;
  const x = c.getContext('2d');
  x.drawImage(im, 0, 0);
  const px = x.getImageData(0, 0, W, H).data;
  const key = (i) => (px[i] << 24 | px[i + 1] << 16 | px[i + 2] << 8 | px[i + 3]) >>> 0;
  const colors = [...new Set(Array.from({ length: W * H }, (_, p) => (px[p * 4 + 3] > 0 ? key(p * 4) : null)).filter((v) => v !== null))].sort((a, b) => a - b);
  const groups = [];
  for (let i = 0; i < colors.length; i += 255) groups.push(colors.slice(i, i + 255));
  if (ed.map.images.length + groups.length > 64) { ed.status('Too many colours: a map can hold at most 64 images'); return; }
  if (groups.length > 1 && !(await confirmBox('Many colours', `The image has ${colors.length} colours and needs ${groups.length} tilesets. The map will be large. Continue?`, 'Continue'))) return;
  const name = file.name.replace(/\.[^.]+$/, '');
  const images = [], layers = [];
  groups.forEach((g, gi) => {
    const sheet = new Uint8Array(1024 * 1024 * 4);
    g.forEach((col, k) => {
      const idx = k + 1, tx = (idx % 16) * 64, ty = Math.floor(idx / 16) * 64;
      const r = col >>> 24, gg = (col >>> 16) & 255, b = (col >>> 8) & 255, a = col & 255;
      for (let yy = 0; yy < 64; yy++) for (let xx = 0; xx < 64; xx++) {
        const o = ((ty + yy) * 1024 + tx + xx) * 4;
        sheet[o] = r; sheet[o + 1] = gg; sheet[o + 2] = b; sheet[o + 3] = a;
      }
    });
    const imgName = `${name} ${gi + 1}`.slice(0, 127);
    images.push({ name: imgName, width: 1024, height: 1024, external: false, rgba: sheet });
    const L = newTileLayer('tiles', W, H, imgName.slice(0, 11));
    const lookup = new Map(g.map((col, k) => [col, k + 1]));
    for (let p = 0; p < W * H; p++) if (px[p * 4 + 3] > 0) L.tiles[p * 4] = lookup.get(key(p * 4)) || 0;
    layers.push(L);
  });
  ed.editStructure('Tile art', () => {
    const base = ed.map.images.length;
    ed.map.images.push(...images);
    layers.forEach((L, i) => (L.image = base + i));
    const grp = newGroup(name.slice(0, 11));
    grp.layers = layers;
    ed.map.groups.push(grp);
    ed.sel = { g: ed.map.groups.length - 1, l: 0 };
  });
  ed.status(`Tile art: ${W}×${H} tiles, ${colors.length} colours`);
}

export function setup(ed) {
  ed.commands.tileart = () => {
    const i = h('input', { type: 'file', accept: 'image/*' });
    i.onchange = () => i.files[0] && addTileArt(ed, i.files[0]);
    i.click();
  };
}
