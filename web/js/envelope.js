// Envelope evaluation, same curves as DDNet (times in ms, values in 22.10 fixed point).
export const CURVE = { STEP: 0, LINEAR: 1, SLOW: 2, FAST: 3, SMOOTH: 4, BEZIER: 5 };
export const CURVE_NAMES = ['Step', 'Linear', 'Slow', 'Fast', 'Smooth', 'Bezier'];

export function evalEnvelope(env, timeMs) {
  const pts = env.points;
  if (!pts.length) return [0, 0, 0, 0];
  if (pts.length === 1) return pts[0].values.map((v) => v / 1024);
  const end = pts[pts.length - 1].time;
  let t = end > 0 ? ((timeMs % end) + end) % end : 0;
  // exactly on the end of a loop: the last key (DDNet wraps to the first one there, for one instant only;
  // the editor keeps the last pose so a key set on the last frame shows where it was put)
  if (end > 0 && t === 0 && timeMs > 0) t = end;
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i], b = pts[i + 1];
    if (t >= a.time && t <= b.time) {
      const d = b.time - a.time;
      let k = d > 0 ? (t - a.time) / d : 0;
      switch (a.curve) {
        case CURVE.STEP: k = 0; break;
        case CURVE.SLOW: k = k * k * k; break;
        case CURVE.FAST: k = 1 - (1 - k) * (1 - k) * (1 - k); break;
        case CURVE.SMOOTH: case CURVE.BEZIER: k = -2 * k * k * k + 3 * k * k; break;
      }
      return a.values.map((v, c) => (v + (b.values[c] - v) * k) / 1024);
    }
  }
  return pts[pts.length - 1].values.map((v) => v / 1024);
}

export function envDuration(env) {
  return env.points.length ? env.points[env.points.length - 1].time : 0;
}
