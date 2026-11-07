// EXPERIMENTAL: fill of a closed quad pen path without extra quads.
// The inner corner of every stroke quad is moved into the shape so the quads tile its inside:
// 1. The shape is cut into triangles, and neighbouring triangles are merged into parts that are star shaped
//    (every point of the part is visible from one centre point).
// 2. Inside one part all inner corners go to its centre, so the quads become a fan of triangles around it.
// 3. Where the outline passes from one part to the next, the quad on that edge reaches from one centre to the
//    other; the two halves of the cut between the parts are covered by the quads on both sides of it.
// The result has no holes or overlaps as long as every edge of the outline has to cross at most one cut.
// To remove the feature: delete this file (or set penFill to false in features.js); the pen works without it.
import { fixCornerOrder } from './map.js';

export function signedArea(V) {
  let a = 0;
  for (let i = 0; i < V.length; i++) { const p = V[i], q = V[(i + 1) % V.length]; a += p[0] * q[1] - q[0] * p[1]; }
  return a / 2;
}

const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);

function inTri(p, a, b, c) {
  const d1 = cross(a, b, p), d2 = cross(b, c, p), d3 = cross(c, a, p);
  return !((d1 < 0 || d2 < 0 || d3 < 0) && (d1 > 0 || d2 > 0 || d3 > 0));
}

function angleAt(o, a, b) {
  const ux = a[0] - o[0], uy = a[1] - o[1], vx = b[0] - o[0], vy = b[1] - o[1];
  const l = Math.hypot(ux, uy) * Math.hypot(vx, vy) || 1;
  return Math.acos(Math.max(-1, Math.min(1, (ux * vx + uy * vy) / l)));
}

// ear clipping of a counter-clockwise polygon, best shaped ear first; index triples (counter-clockwise).
// Removing an ear only changes its two neighbours, so only they are tested again.
function triangulate(P) {
  const n = P.length, prev = [], next = [], score = [], tris = [];
  for (let i = 0; i < n; i++) { prev.push((i + n - 1) % n); next.push((i + 1) % n); }
  const eps = 1e-9 * (Math.abs(signedArea(P)) + 1);
  const alive = new Set(P.keys());
  let left = n;
  const test = (b, loose) => {
    const ia = prev[b], ic = next[b], A = P[ia], B = P[b], C = P[ic], s = cross(A, B, C);
    if (loose ? s < -eps : s <= eps) return -Infinity;
    if (s > eps) for (const j of alive) if (j !== ia && j !== b && j !== ic && cross(P[prev[j]], P[j], P[next[j]]) <= eps && inTri(P[j], A, B, C)) return -Infinity;
    return loose ? -Math.abs(s) : Math.min(angleAt(A, B, C), angleAt(B, C, A), angleAt(C, A, B));
  };
  for (const i of alive) score[i] = test(i, false);
  while (left > 3) {
    let best = -1;
    for (const i of alive) if (score[i] > -Infinity && (best < 0 || score[i] > score[best])) best = i;
    if (best < 0) { // a corner that turned convex may have freed an ear: test all again, then let straight runs go
      for (const i of alive) { score[i] = test(i, false); if (score[i] > -Infinity && (best < 0 || score[i] > score[best])) best = i; }
    }
    if (best < 0) {
      let bs = -Infinity;
      for (const i of alive) { const v = test(i, true); if (v > bs) { bs = v; best = i; } }
      if (best < 0) return null; // the outline crosses itself
    }
    const a = prev[best], c = next[best];
    tris.push([a, best, c]);
    next[a] = c; prev[c] = a; alive.delete(best); left--;
    score[a] = test(a, false); score[c] = test(c, false);
  }
  tris.push([...alive]);
  return tris;
}

// intersection of the left half planes of the edges (a counter-clockwise polygon's kernel); [] when empty
function kernel(edges, box) {
  let poly = box;
  for (const [a, b] of edges) {
    const out = [];
    for (let i = 0; i < poly.length; i++) {
      const p = poly[i], q = poly[(i + 1) % poly.length];
      const sp = cross(a, b, p), sq = cross(a, b, q);
      if (sp >= 0) out.push(p);
      if ((sp >= 0) !== (sq >= 0)) { const t = sp / (sp - sq); out.push([p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t]); }
    }
    poly = out;
    if (poly.length < 3) return [];
  }
  return poly;
}

function centroid(poly) {
  let a = 0, x = 0, y = 0;
  for (let i = 0; i < poly.length; i++) {
    const p = poly[i], q = poly[(i + 1) % poly.length], c = p[0] * q[1] - q[0] * p[1];
    a += c; x += (p[0] + q[0]) * c; y += (p[1] + q[1]) * c;
  }
  if (Math.abs(a) < 1e-12) return [poly.reduce((s, p) => s + p[0], 0) / poly.length, poly.reduce((s, p) => s + p[1], 0) / poly.length];
  return [x / (3 * a), y / (3 * a)];
}

// one inner point per vertex of the closed centre line (any orientation); null if the outline crosses itself
export function fillInner(Vin) {
  const n = Vin.length;
  if (n < 3) return null;
  const flip = signedArea(Vin) < 0;
  const V = flip ? [...Vin].reverse() : Vin;
  const tris = triangulate(V);
  if (!tris) return null;

  // triangle neighbours across inner diagonals
  const owner = new Map(); // directed edge "a,b" -> triangle
  tris.forEach((t, i) => { for (let e = 0; e < 3; e++) owner.set(t[e] + ',' + t[(e + 1) % 3], i); });
  const across = (i, e) => owner.get(tris[i][(e + 1) % 3] + ',' + tris[i][e]); // undefined on the outline

  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const [x, y] of V) { minX = Math.min(minX, x); minY = Math.min(minY, y); maxX = Math.max(maxX, x); maxY = Math.max(maxY, y); }
  const box = [[minX - 1, minY - 1], [maxX + 1, minY - 1], [maxX + 1, maxY + 1], [minX - 1, maxY + 1]];
  const triArea = (t) => cross(V[t[0]], V[t[1]], V[t[2]]) / 2;
  const minKernel = 1e-4 * Math.abs(signedArea(V));

  const edgesOf = (set) => {
    const out = [];
    for (const i of set) for (let e = 0; e < 3; e++) { const j = across(i, e); if (j === undefined || !set.has(j)) out.push([V[tris[i][e]], V[tris[i][(e + 1) % 3]]]); }
    return out;
  };

  // one try at cutting the shape into parts and placing the inner corners; cost 0 means an exact cover
  const attempt = (rand) => {
    // grow star shaped parts, biggest triangle first, always adding the neighbour that keeps the biggest kernel
    // (later tries: random order and choices)
    const part = new Array(tris.length).fill(-1), centres = [], kernels = [];
    const order = tris.map((_, i) => i).sort((a, b) => triArea(tris[b]) - triArea(tris[a]));
    if (rand) for (let i = order.length - 1; i > 0; i--) { const j = Math.floor(rand() * (i + 1)); [order[i], order[j]] = [order[j], order[i]]; }
    for (const seed of order) {
      if (part[seed] >= 0) continue;
      const set = new Set([seed]);
      let ker = kernel(edgesOf(set), box);
      for (;;) {
        let best = null;
        for (const i of set) for (let e = 0; e < 3; e++) {
          const j = across(i, e);
          if (j === undefined || part[j] >= 0 || set.has(j)) continue;
          // cheap estimate: the current kernel cut by the two new outline edges (the exact one is never smaller)
          const k = kernel([0, 1, 2].filter((f) => across(j, f) !== i).map((f) => [V[tris[j][f]], V[tris[j][(f + 1) % 3]]]), ker);
          const a = k.length ? Math.abs(signedArea(k)) : 0, score = rand ? a * (0.2 + rand()) : a;
          if (a > minKernel && (!best || score > best.score)) best = { j, k, score };
        }
        if (!best) break;
        set.add(best.j); ker = kernel(edgesOf(set), box);
      }
      for (const i of set) part[i] = centres.length;
      kernels.push(ker.length ? ker : tris[seed].map((v) => V[v]));
      centres.push(centroid(kernels[kernels.length - 1]));
    }

    // the line between the centres of two neighbouring parts has to pass through the cut between them, or the
    // quads at the ends of the cut stick out of the shape; move the centres inside their kernels until it does
    const cuts = []; // [part a, part b, cut start, cut end]
    tris.forEach((t, i) => { for (let e = 0; e < 3; e++) { const j = across(i, e); if (j !== undefined && i < j && part[i] !== part[j]) cuts.push([part[i], part[j], V[t[e]], V[t[(e + 1) % 3]]]); } });
    // how far inside the cut the line p-q crosses it (0 at its ends, below 0 outside)
    const margin = (c, p, q) => {
      const [, , a, b] = c, d1 = cross(p, q, a), d2 = cross(p, q, b);
      if (d1 === d2) return -1;
      const t = d1 / (d1 - d2);
      return Math.min(t, 1 - t);
    };
    if (cuts.length) {
      const score = (k, p) => {
        let s = 0;
        for (const c of cuts) if (c[0] === k || c[1] === k) s += Math.min(0.25, margin(c, p, centres[c[0] === k ? c[1] : c[0]]));
        return s;
      };
      const candidates = kernels.map((ker) => {
        const c = centroid(ker), out = [c];
        for (const v of ker) for (const f of [0.25, 0.5, 0.75, 0.95]) out.push([c[0] + (v[0] - c[0]) * f, c[1] + (v[1] - c[1]) * f]);
        for (let i = 0; i < ker.length; i++) { const v = ker[i], w = ker[(i + 1) % ker.length]; out.push([c[0] + ((v[0] + w[0]) / 2 - c[0]) * 0.9, c[1] + ((v[1] + w[1]) / 2 - c[1]) * 0.9]); }
        return out;
      });
      for (let round = 0; round < 4; round++) {
        let moved = false;
        for (let k = 0; k < centres.length; k++) {
          let best = centres[k], bs = score(k, best) + 1e-9;
          for (const p of candidates[k]) { const s = score(k, p); if (s > bs) { bs = s; best = p; moved = true; } }
          centres[k] = best;
        }
        if (!moved) break;
      }
    }

    // A cut whose centre line misses it gets a node at its middle: both ends of the cut send their inner corner
    // there, so each half of the cut is covered by the quads next to it. Nodes: parts, then cut middles.
    const P = centres.length, cutAt = new Map(), direct = [];
    cuts.forEach((c, i) => {
      cutAt.set(Math.min(c[0], c[1]) + ',' + Math.max(c[0], c[1]), P + i);
      centres.push([(c[2][0] + c[3][0]) / 2, (c[2][1] + c[3][1]) / 2]);
      direct.push(margin(c, centres[c[0]], centres[c[1]]) > 1e-3);
    });

    // nodes met at each outline vertex, in the order the outline passes them (from edge u-1,u to edge u,u+1)
    const seq = [];
    for (let u = 0; u < n; u++) {
      let t = owner.get(((u + n - 1) % n) + ',' + u);
      const list = [part[t]];
      for (let guard = 0; guard < tris.length; guard++) {
        const w = tris[t][(tris[t].indexOf(u) + 1) % 3];
        if (w === (u + 1) % n) break;
        t = owner.get(w + ',' + u);
        if (t === undefined) break;
        const last = list[list.length - 1];
        if (part[t] !== last) list.push(cutAt.get(Math.min(last, part[t]) + ',' + Math.max(last, part[t])), part[t]);
      }
      seq.push(list);
    }

    // Every vertex picks one of its nodes; the quad of edge u,u+1 then runs from u's node to u+1's node, and it is
    // exact only if that is a single step (part to part through a cut it may cross directly, or part to cut middle).
    // Dynamic programming around the closed outline; longer runs are allowed but cost.
    const cost = (u, a, b) => {
      const path = [...seq[u].slice(a), ...seq[(u + 1) % n].slice(1, b + 1)];
      let steps = path.length - 1;
      for (let k = 1; k < path.length - 1; k++) if (path[k] >= P && direct[path[k] - P]) steps--;
      return steps > 1 ? steps - 1 : 0;
    };
    let bestTotal = Infinity, bestPick = null;
    for (let first = 0; first < seq[0].length; first++) {
      const D = [seq[0].map((_, a) => (a === first ? 0 : Infinity))], from = [null];
      for (let u = 1; u < n; u++) {
        const row = [], back = [];
        for (let b = 0; b < seq[u].length; b++) {
          let m = Infinity, arg = 0;
          for (let a = 0; a < seq[u - 1].length; a++) { const c = D[u - 1][a] + cost(u - 1, a, b); if (c < m) { m = c; arg = a; } }
          row.push(m); back.push(arg);
        }
        D.push(row); from.push(back);
      }
      let m = Infinity, arg = 0;
      for (let a = 0; a < seq[n - 1].length; a++) { const c = D[n - 1][a] + cost(n - 1, a, first); if (c < m) { m = c; arg = a; } }
      if (m < bestTotal) {
        bestTotal = m;
        const pick = new Array(n);
        pick[n - 1] = arg;
        for (let u = n - 1; u > 0; u--) pick[u - 1] = from[u][pick[u]];
        bestPick = pick;
      }
    }
    return { cost: bestTotal, inner: bestPick.map((a, u) => [...centres[seq[u][a]]]) };
  };
  // some shapes need another way of cutting: retry with random choices until the cover is exact
  let best = attempt(null), rs = 12345;
  const rand = () => ((rs = (rs * 16807) % 2147483647) / 2147483647);
  for (let k = 0; k < 64 && best.cost > 0; k++) { const t = attempt(rand); if (t.cost < best.cost) best = t; }
  const inner = best.inner;
  return flip ? inner.reverse() : inner;
}

// where edges a-b and c-d cross or overlap (null if they do not)
function edgeHit(a, b, c, d) {
  const d1 = cross(c, d, a), d2 = cross(c, d, b), d3 = cross(a, b, c), d4 = cross(a, b, d);
  if (((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0))) {
    const t = d1 / (d1 - d2);
    return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
  }
  // edges on one line that overlap: the middle of the overlap
  const ex = b[0] - a[0], ey = b[1] - a[1], l2 = ex * ex + ey * ey, tol = 1e-6 * l2;
  if (l2 < 1e-12 || Math.abs(d3) > tol || Math.abs(d4) > tol) return null;
  const t1 = ((c[0] - a[0]) * ex + (c[1] - a[1]) * ey) / l2, t2 = ((d[0] - a[0]) * ex + (d[1] - a[1]) * ey) / l2;
  const lo = Math.max(0, Math.min(t1, t2)), hi = Math.min(1, Math.max(t1, t2));
  if (hi - lo < 1e-6) return null;
  const t = (lo + hi) / 2;
  return [a[0] + ex * t, a[1] + ey * t];
}

// first pair of edges of the closed polyline P that cross: [i, j, point] (edge i runs from P[i] to P[i+1])
function firstCrossing(P, skip) {
  const m = P.length;
  for (let i = 0; i < m; i++) {
    const a = P[i], b = P[(i + 1) % m];
    const x0 = Math.min(a[0], b[0]), x1 = Math.max(a[0], b[0]), y0 = Math.min(a[1], b[1]), y1 = Math.max(a[1], b[1]);
    for (let j = i + 2; j < m; j++) {
      if (i === 0 && j === m - 1) continue;
      const c = P[j], d = P[(j + 1) % m];
      if (Math.max(c[0], d[0]) < x0 || Math.min(c[0], d[0]) > x1 || Math.max(c[1], d[1]) < y0 || Math.min(c[1], d[1]) > y1) continue;
      const x = !skip.has(i + ',' + j) && edgeHit(a, b, c, d);
      if (x) return [i, j, x];
    }
  }
  return null;
}

// indices of the points at the ends of edges of the closed polyline P that cross another edge
function crossingEdges(P) {
  const m = P.length, out = new Set();
  const hit = (a, b, c, d) => !!edgeHit(a, b, c, d);
  for (let i = 0; i < m; i++) {
    const a = P[i], b = P[(i + 1) % m];
    const x0 = Math.min(a[0], b[0]), x1 = Math.max(a[0], b[0]), y0 = Math.min(a[1], b[1]), y1 = Math.max(a[1], b[1]);
    for (let j = i + 2; j < m; j++) {
      if (i === 0 && j === m - 1) continue;
      const c = P[j], d = P[(j + 1) % m];
      if (Math.max(c[0], d[0]) < x0 || Math.min(c[0], d[0]) > x1 || Math.max(c[1], d[1]) < y0 || Math.min(c[1], d[1]) > y1) continue;
      if (hit(a, b, c, d)) { out.add(i); out.add((i + 1) % m); out.add(j); out.add((j + 1) % m); }
    }
  }
  return out;
}

// where the lines through a (direction da) and b (direction db) meet; null if parallel
function meet(a, da, b, db) {
  const d = da[0] * db[1] - da[1] * db[0];
  if (Math.abs(d) < 1e-9) return null;
  const t = ((b[0] - a[0]) * db[1] - (b[1] - a[1]) * db[0]) / d;
  return [a[0] + da[0] * t, a[1] + da[1] * t];
}

// even-odd test of point p against polygon poly (points on the edge count as outside)
function inside(p, poly) {
  let c = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i], b = poly[j];
    if ((a[1] > p[1]) !== (b[1] > p[1]) && p[0] < ((b[0] - a[0]) * (p[1] - a[1])) / (b[1] - a[1]) + a[0]) c = !c;
  }
  return c;
}

// An outline that crosses itself (two parts of the shape closer than the stroke width) is cut at the crossing
// and the loop behind it, the one that goes round the wrong way, is pulled into the crossing point: that is what
// the overlapping stroke quads look like from outside (small loops and loops inside the rest count as wrong
// too). Crossings between two real parts of the shape are left.
function untangle(Cin, sign, small) {
  const P = Cin.map((p) => [...p]), m = P.length, skip = new Set();
  for (let guard = 0; guard < 4 * m; guard++) {
    const hit = firstCrossing(P, skip);
    if (!hit) break;
    const [i, j, X] = hit;
    const inA = [], inB = [];
    for (let k = i + 1; k <= j; k++) inA.push(k);
    for (let k = j + 1; k <= i + m; k++) inB.push(k % m);
    const area = (ids) => signedArea([X, ...ids.map((k) => P[k])]);
    const within = (ids, other) => {
      const poly = [X, ...other.map((k) => P[k])];
      let n = 0;
      for (const k of ids) if (inside(P[k], poly)) n++;
      return n * 2 > ids.length;
    };
    const a = area(inA), b = area(inB), wrongA = a * sign < 0, wrongB = b * sign < 0;
    let drop = wrongA !== wrongB ? (wrongA ? inA : inB) : null;
    // a small twisted loop at a corner can come out with either sign; a loop lying inside the rest is covered anyway
    if (!drop && Math.min(Math.abs(a), Math.abs(b)) < small) drop = Math.abs(a) < Math.abs(b) ? inA : inB;
    if (!drop && within(inA, inB)) drop = inA;
    if (!drop && within(inB, inA)) drop = inB;
    if (!drop) { skip.add(i + ',' + j); continue; }
    for (const k of drop) P[k] = [...X];
  }
  return P;
}

// quads of a filled closed stroke. V: centre line, ends/starts: the [side 0, side 1] corners per vertex as the
// plain stroke has them, bevels: vertices with a bevel quad. The outer edge stays as it is, the inner corners
// go into the shape. Null if the shape crosses itself.
export function fillStroke(V, ends, starts, bevels, half) {
  const n = V.length, area = signedArea(V), ext = area > 0 ? 1 : 0;
  const convex = (j) => cross(V[(j + n - 1) % n], V[j], V[(j + 1) % n]) * area > 0;
  const bevel = new Set(bevels.filter(convex)); // a bevel on the inner side is covered by the fill
  // outer outline of the stroke; eIdx/sIdx: its point where segment j-1 ends / segment j starts; A: the centre
  // line vertex each outline point belongs to
  const full = [], A = [], eIdx = [], sIdx = [];
  for (let j = 0; j < n; j++) {
    const e = ends[j][ext], s = starts[j][ext];
    if (bevel.has(j)) { eIdx.push(full.length); full.push(e); sIdx.push(full.length); full.push(s); A.push(V[j], V[j]); continue; }
    let p = e;
    if (e !== s) {
      // a sharp inward corner: the two square ends cross, the outline goes through the point where the two
      // edges of the stroke meet, but not further along the corner than its shorter side is long
      const a = V[(j + n - 1) % n], b = V[j], c = V[(j + 1) % n];
      p = meet(e, [b[0] - a[0], b[1] - a[1]], s, [c[0] - b[0], c[1] - b[1]]) || [(e[0] + s[0]) / 2, (e[1] + s[1]) / 2];
      const la = Math.hypot(a[0] - b[0], a[1] - b[1]), lc = Math.hypot(c[0] - b[0], c[1] - b[1]);
      const along = la > 1e-9 ? ((p[0] - b[0]) * (a[0] - b[0]) + (p[1] - b[1]) * (a[1] - b[1])) / la : 0;
      const lim = Math.min(la, lc);
      if (along > lim) { const k = lim / along; p = [b[0] + (p[0] - b[0]) * k, b[1] + (p[1] - b[1]) * k]; }
    }
    eIdx.push(full.length); sIdx.push(full.length); full.push(p); A.push(V[j]);
  }
  // if the outline still crosses itself, pull the points of the crossing edges back towards the centre line
  // until it does not (at worst it becomes the centre line)
  const tidy = untangle(full, Math.sign(area), 4 * half * half);
  const m = tidy.length, f = new Array(m).fill(1);
  const at = (k) => [A[k][0] + (tidy[k][0] - A[k][0]) * f[k], A[k][1] + (tidy[k][1] - A[k][1]) * f[k]];
  let C = tidy;
  for (let round = 0; ; round++) {
    C = tidy.map((_, k) => at(k));
    const bad = crossingEdges(C);
    if (!bad.size) break;
    if (round === 13) return null; // the centre line itself crosses
    for (const k of bad) f[k] = round < 12 ? f[k] * 0.6 : 0;
  }
  // points pulled into one crossing are one point of the outline (their quads become empty)
  const U = [], map = [];
  for (let k = 0; k < m; k++) {
    const p = C[k], q = U[U.length - 1];
    if (q && Math.abs(p[0] - q[0]) < 1e-6 && Math.abs(p[1] - q[1]) < 1e-6) map.push(U.length - 1);
    else { map.push(U.length); U.push(p); }
  }
  if (U.length > 1 && Math.abs(U[0][0] - U[U.length - 1][0]) < 1e-6 && Math.abs(U[0][1] - U[U.length - 1][1]) < 1e-6) {
    const last = U.length - 1;
    U.pop();
    for (let k = 0; k < m; k++) if (map[k] === last) map[k] = 0;
  }
  if (U.length < 3) return null;
  const Iu = fillInner(U);
  if (!Iu) return null;
  const I = map.map((u) => Iu[u]);
  const quad = (a, b) => (ext === 0 ? [C[a], C[b], I[a], I[b]] : [I[a], I[b], C[a], C[b]]);
  const out = [];
  for (let i = 0; i < n; i++) out.push(quad(sIdx[i], eIdx[(i + 1) % n]));
  for (const j of bevels) if (bevel.has(j)) out.push(quad(eIdx[j], sIdx[j]));
  return out.map(fixCornerOrder); // concave quads: corners ordered so DDNet's split stays inside (map.js)
}

