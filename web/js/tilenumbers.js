// Module "tilenumbers": numbers on tele / switch / tune tiles and arrows on speedup tiles, drawn over the map like the
// overlays of the DDNet editor (CFRM tele tiles 31 / 63 use no number, so none is drawn). Also the arrows of a
// speedup brush under the mouse, so R / T and the Angle field show at once.
// Without this module the tiles are still drawn; only the numbers and arrows on top are missing.
import { TILE_BYTES } from './map.js';
import { brushTile } from './tools.js';

const TILE = 32;
const angleOf = (t, o) => (((t[o + 4] | (t[o + 5] << 8)) << 16) >> 16); // int16, degrees: 0 right, 90 down, 270 up

export function setup(ed) {
  const arrow = new Image();
  arrow.onload = () => ed.redraw();
  arrow.src = '/data/editor/speed_arrow.png';
  const arrowReady = () => arrow.complete && arrow.naturalWidth;
  const drawArrow = (ctx, cx, cy, cell, angle) => {
    ctx.save(); ctx.translate(cx, cy); ctx.rotate(angle * Math.PI / 180);
    ctx.drawImage(arrow, -cell / 2, -cell / 2, cell, cell); ctx.restore();
  };

  function drawLayers(ctx, w, h) {
    for (const g of ed.map.groups) {
      if (!g.visible) continue;
      for (const L of g.layers) {
        if (!L.visible || !['tele', 'switch', 'speedup', 'tune'].includes(L.kind)) continue;
        const z = ed.gzoom(g), cell = TILE * z;
        if (cell < 14) continue;
        const [ax, ay] = ed.screenToWorld(0, 0, g), [bx, by] = ed.screenToWorld(w, h, g);
        const x0 = Math.max(0, Math.floor(ax / TILE)), y0 = Math.max(0, Math.floor(ay / TILE));
        const x1 = Math.min(L.width - 1, Math.floor(bx / TILE)), y1 = Math.min(L.height - 1, Math.floor(by / TILE));
        if ((x1 - x0 + 1) * (y1 - y0 + 1) > 40000) continue;
        const b = TILE_BYTES[L.kind], t = L.tiles;
        const small = `bold ${Math.round(cell * 0.3)}px sans-serif`;
        const text = (str, x, y, font) => { ctx.font = font; ctx.lineWidth = Math.max(2, cell / 12); ctx.strokeStyle = '#000'; ctx.strokeText(str, x, y); ctx.fillStyle = '#fff'; ctx.fillText(str, x, y); };
        const teleFont = `600 ${Math.max(9, Math.round(cell * 0.26))}px sans-serif`;
        const teleText = (str, x, y) => { ctx.font = teleFont; ctx.fillStyle = 'rgba(255,255,255,0.7)'; ctx.fillText(str, x, y); };
        for (let y = y0; y <= y1; y++) {
          for (let x = x0; x <= x1; x++) {
            const o = (y * L.width + x) * b;
            const [sx, sy] = ed.worldToScreen(x * TILE, y * TILE, g);
            const cx = sx + cell / 2, cy = sy + cell / 2;
            if (L.kind === 'tele') {
              // small and soft, above the tile's own label
              if (t[o + 1] && t[o] && t[o + 1] !== 31 && t[o + 1] !== 63) teleText(String(t[o]), cx, sy + cell * 0.32);
            } else if (L.kind === 'tune') {
              if (t[o + 1] && t[o]) teleText(String(t[o]), cx, sy + cell * 0.32);
            } else if (L.kind === 'switch') {
              if (!t[o + 1]) continue;
              if (t[o]) text(String(t[o]), cx, sy + cell * 0.3, small);
              if (t[o + 3]) text(String(t[o + 3]), cx, sy + cell * 0.75, small);
            } else if (t[o + 2]) {
              if (arrowReady()) drawArrow(ctx, cx, cy, cell, angleOf(t, o));
              if (t[o]) text(String(t[o]), sx + cell * 0.25, sy + cell * 0.22, small);
              if (t[o + 1]) text(String(t[o + 1]), sx + cell * 0.25, sy + cell * 0.8, small);
            }
          }
        }
      }
    }
  }

  // arrows of the brush under the mouse on the Speedup layer
  function drawSpeedupBrush(ctx) {
    const L = ed.tileTargets().find((l) => l.kind === 'speedup');
    if (!L || !ed.brushPreview() || !arrowReady()) return;
    const b = ed.brushFor(L), g = ed.group;
    if (!b || !g) return;
    const cell = TILE * ed.gzoom(g), [tx, ty] = ed.mouseTile();
    for (let i = 0; i < b.w * b.h; i++) {
      const t = brushTile(b, i, 'speedup', ed.nums);
      if (!t || !t[2]) continue;
      const [sx, sy] = ed.worldToScreen((tx + (i % b.w)) * TILE, (ty + Math.floor(i / b.w)) * TILE, g);
      drawArrow(ctx, sx + cell / 2, sy + cell / 2, cell, angleOf(t, 0));
    }
  }

  ed.ext.overlays.push((ctx, w, h) => {
    // tile info (Ctrl+I) shows the raw numbers instead
    if (!ed.map || !ed.opts.showEntities || ed.opts.entitiesAlpha <= 0 || ed.opts.tileInfo) return;
    ctx.save();
    ctx.globalAlpha = ed.opts.entitiesAlpha;
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    drawLayers(ctx, w, h);
    drawSpeedupBrush(ctx);
    ctx.restore();
  });
}
