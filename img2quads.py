#!/usr/bin/env python3
"""Recreate a low-colour image as DDNet quads and write a ready-to-open .map file.

Pipeline:
  1. quantize the image to a small palette (k-means, auto or --colors N)
  2. clean up speckles (mode filter, drop tiny islands)
  3. layering: the border colour is the background, one full-size quad in its own
     layer; the darkest colour is the outline layer on top of everything (if it is
     also the background, only its thin strokes); the colours in between are drawn
     as unions of themselves and later fills, tucked under touching outline strokes,
     so nothing leaves seams
  4. trace region outlines (with holes), simplify them (Douglas-Peucker)
  5. triangulate (earcut) and pair adjacent triangles into one quad each;
     a leftover triangle becomes a quad with two vertices on the same point

DDNet draws a quad as triangles (p0,p1,p3) and (p0,p3,p2), so two triangles
sharing an edge fit one quad exactly, convex or not.

Requires: numpy, pillow, opencv-python-headless, mapbox-earcut
  pip install numpy pillow opencv-python-headless mapbox-earcut

Example:
  python3 img2quads.py art.png art.map --preview art_preview.png
"""
import argparse
import heapq
import struct
import zlib

import cv2
import mapbox_earcut
import numpy as np
from PIL import Image, ImageDraw, ImageFilter, ImageOps

TILE = 32  # world units per tile
FX = 1024  # 22.10 fixed point


# ---------------------------------------------------------------- image -> regions

def kmeans(pixels, k, iters=20, seed=1):
    rng = np.random.default_rng(seed)
    # k-means++ init
    centers = [pixels[rng.integers(len(pixels))]]
    for _ in range(1, k):
        d = np.min([((pixels - c) ** 2).sum(1) for c in centers], axis=0)
        centers.append(pixels[rng.choice(len(pixels), p=d / d.sum())])
    centers = np.array(centers, dtype=np.float64)
    for _ in range(iters):
        labels = np.argmin(((pixels[:, None, :] - centers[None]) ** 2).sum(2), axis=1)
        for i in range(k):
            if np.any(labels == i):
                centers[i] = pixels[labels == i].mean(0)
    err = np.sqrt(((pixels - centers[labels]) ** 2).sum(1)).mean()
    return centers, err


def quantize(rgb, ncolors, valid, max_auto=8, auto_err=14.0):
    px = rgb.reshape(-1, 3).astype(np.float64)
    opaque = px[valid.reshape(-1)] if valid.any() else px  # transparent pixels must not get a colour
    sample = opaque[np.random.default_rng(0).choice(len(opaque), min(len(opaque), 40000), replace=False)]
    if ncolors:
        centers, _ = kmeans(sample, ncolors)
    else:
        # smallest palette whose average error is acceptable
        for k in range(2, max_auto + 1):
            centers, err = kmeans(sample, k)
            if err < auto_err:
                break
    labels = np.empty(len(px), dtype=np.int32)
    for s in range(0, len(px), 200000):
        chunk = px[s:s + 200000]
        labels[s:s + 200000] = np.argmin(((chunk[:, None, :] - centers[None]) ** 2).sum(2), axis=1)
    return np.clip(np.rint(centers), 0, 255).astype(np.uint8), labels.reshape(rgb.shape[:2])


def mode_filter(labels, n, size):
    if size <= 1:
        return labels
    votes = np.stack([cv2.boxFilter((labels == i).astype(np.float32), -1, (size, size), normalize=False)
                      for i in range(n)])
    return np.argmax(votes, axis=0).astype(np.int32)


def smooth_labels(labels, n, sigma):
    """Blur each colour's one-hot plane and take the strongest: rounds off jagged
    JPEG edges and swallows lone pixels, but keeps lines wider than ~2 sigma."""
    if sigma <= 0:
        return labels
    planes = [cv2.GaussianBlur((labels == i).astype(np.float32), (0, 0), sigma) for i in range(n)]
    return np.argmax(np.stack(planes), axis=0).astype(np.int32)


def remove_specks(labels, n, max_area):
    """Repaint every connected blob smaller than max_area pixels with the colour around it."""
    if max_area <= 0:
        return labels
    labels = labels.copy()
    for i in range(n):
        cnt, comp, stats, _ = cv2.connectedComponentsWithStats((labels == i).astype(np.uint8), connectivity=8)
        small = np.where(stats[:, cv2.CC_STAT_AREA] < max_area)[0]
        small = small[small != 0]
        if len(small):
            labels[np.isin(comp, small)] = -1
    # grow the surrounding colours into the holes
    while (labels == -1).any():
        votes = np.stack([cv2.boxFilter((labels == i).astype(np.float32), -1, (3, 3), normalize=False)
                          for i in range(n)])
        best = np.argmax(votes, axis=0)
        fill = (labels == -1) & (votes.max(0) > 0)
        if not fill.any():
            labels[labels == -1] = 0
            break
        labels[fill] = best[fill]
    return labels


def polygons_from_mask(mask, epsilon, min_area):
    """Return list of (outer, [holes]) polygons as float arrays in pixel-corner coordinates."""
    big = mask.astype(np.uint8) * 255
    contours, hier = cv2.findContours(big, cv2.RETR_CCOMP, cv2.CHAIN_APPROX_NONE)
    if hier is None:
        return []
    hier = hier[0]
    out = []

    def simplify(c):
        a = cv2.approxPolyDP(c, epsilon, True).reshape(-1, 2).astype(np.float64)
        return a + 0.5

    for i, c in enumerate(contours):
        if hier[i][3] != -1:
            continue  # holes are handled with their parent
        if cv2.contourArea(c) < min_area:
            continue
        outer = simplify(c)
        if len(outer) < 3:
            continue
        holes = []
        j = hier[i][2]
        while j != -1:
            if cv2.contourArea(contours[j]) >= min_area:
                h = simplify(contours[j])
                if len(h) >= 3:
                    holes.append(h)
            j = hier[j][0]
        out.append((outer, holes))
    return out


def triangulate(outer, holes):
    rings = [outer] + holes
    verts = np.concatenate(rings)
    ends = np.cumsum([len(r) for r in rings]).astype(np.uint32)
    idx = mapbox_earcut.triangulate_float64(verts, ends).reshape(-1, 3)
    tris = []
    for a, b, c in idx:
        pa, pb, pc = verts[a], verts[b], verts[c]
        if abs((pb[0] - pa[0]) * (pc[1] - pa[1]) - (pb[1] - pa[1]) * (pc[0] - pa[0])) > 1e-6:
            tris.append((int(a), int(b), int(c)))
    return verts, tris


def drop_stray_triangles(verts, tris, mask, min_cover=0.5, min_area=6):
    """Hairline art: when a simplified hole ring crosses its outer ring, earcut returns
    triangles that span empty space (a solid wedge over the picture). Drop every triangle
    of real size that lies mostly outside the area it was allowed to paint."""
    h, w = mask.shape
    keep = []
    for t in tris:
        p = verts[list(t)]
        area = abs((p[1, 0] - p[0, 0]) * (p[2, 1] - p[0, 1]) - (p[1, 1] - p[0, 1]) * (p[2, 0] - p[0, 0])) / 2
        if area >= min_area:
            x0, y0 = np.maximum(np.floor(p.min(0)).astype(int), 0)
            x1, y1 = np.minimum(np.ceil(p.max(0)).astype(int) + 1, [w, h])
            m = np.zeros((y1 - y0, x1 - x0), np.uint8)
            cv2.fillPoly(m, [np.round(p - [x0, y0]).astype(np.int32)], 1)
            n = m.sum()
            if n and (m.astype(bool) & mask[y0:y1, x0:x1]).sum() < min_cover * n:
                continue
        keep.append(t)
    return keep


def pair_triangles(tris):
    """Greedy matching on the triangle adjacency graph, leaves first (optimal on trees)."""
    edge_owner = {}
    adj = [set() for _ in tris]
    for t, (a, b, c) in enumerate(tris):
        for e in ((a, b), (b, c), (c, a)):
            key = (min(e), max(e))
            if key in edge_owner:
                o = edge_owner[key]
                adj[t].add(o)
                adj[o].add(t)
            else:
                edge_owner[key] = t
    matched = [-1] * len(tris)
    deg = [len(a) for a in adj]
    heap = [(deg[t], t) for t in range(len(tris))]
    heapq.heapify(heap)
    while heap:
        d, t = heapq.heappop(heap)
        if matched[t] != -1 or d != deg[t] or deg[t] < 0:
            continue
        deg[t] = -1
        free = [u for u in adj[t] if matched[u] == -1 and deg[u] >= 0]
        if not free:
            continue
        u = min(free, key=lambda x: deg[x])
        matched[t], matched[u] = u, t
        deg[u] = -1
        for x in (t, u):
            for n in adj[x]:
                if deg[n] > 0:
                    deg[n] -= 1
                    heapq.heappush(heap, (deg[n], n))
    quads, done = [], set()
    for t, tri in enumerate(tris):
        if t in done:
            continue
        u = matched[t]
        if u == -1:
            a, b, c = tri
            quads.append((a, b, c, c))  # p0,p1,p2,p3 ; p2 == p3 -> triangle
            done.add(t)
            continue
        shared = set(tri) & set(tris[u])
        s0, s1 = sorted(shared)
        x = (set(tri) - shared).pop()
        y = (set(tris[u]) - shared).pop()
        # triangles (p0,p1,p3) and (p0,p3,p2): diagonal p0-p3 is the shared edge
        quads.append((s0, x, y, s1))
        done.update((t, u))
    return quads


def trace_within(must, allowed, epsilon, min_area, reach, slack, edge=1, max_eps=24):
    """Polygons that cover `must` and may spread anywhere inside `allowed`.

    `allowed` is this colour plus everything drawn on top of it, so the polygon can run
    under the layers above, skip their holes and take straight shortcuts. Each piece is
    simplified with the largest epsilon that still leaves at most `slack` of its pixels
    wrong (bleeding outside `allowed` or missing `must`). Pixels within `edge` px of
    the border between the two never count as wrong: that is rasterization noise."""
    forb = ~allowed
    ke = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (2 * int(edge) + 1, 2 * int(edge) + 1))
    forb_core = cv2.erode(forb.astype(np.uint8), ke) > 0
    must_core = cv2.erode(must.astype(np.uint8), ke) > 0
    k = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (2 * int(reach) + 1, 2 * int(reach) + 1))
    region = allowed & (cv2.dilate(must.astype(np.uint8), k) > 0)  # no need to fill big areas of upper colours
    _, comp = cv2.connectedComponents(region.astype(np.uint8), connectivity=8)
    ids = np.unique(comp[must])
    region = np.isin(comp, ids[ids > 0])
    contours, hier = cv2.findContours(region.astype(np.uint8), cv2.RETR_CCOMP, cv2.CHAIN_APPROX_NONE)
    if hier is None:
        return []
    hier = hier[0]
    eps_list = [e for e in (1, 1.5, 2, 3, 4, 6, 8, 12, 16, 24, 32) if e * epsilon <= max_eps * epsilon] or [1]
    out = []
    for i, c in enumerate(contours):
        if hier[i][3] != -1 or cv2.contourArea(c) < min_area:
            continue
        x, y, w, h = cv2.boundingRect(c)
        sl = (slice(y, y + h), slice(x, x + w))
        filled = np.zeros((h, w), np.uint8)
        cv2.drawContours(filled, [c - [x, y]], 0, 1, -1)
        holes = []
        j = hier[i][2]
        while j != -1:
            hm = np.zeros((h, w), np.uint8)
            cv2.drawContours(hm, [contours[j] - [x, y]], 0, 1, -1)
            cv2.drawContours(hm, [contours[j] - [x, y]], 0, 0, 1)  # the ring itself is still this piece
            filled[hm > 0] = 0  # islands inside the hole belong to other pieces
            inside = (hm > 0) & ~region[sl]
            # keep a hole only if it holds something that must not be painted over
            if cv2.contourArea(contours[j]) >= min_area and (inside & forb[sl]).sum() > min_area:
                holes.append(contours[j])
            j = hier[j][0]
        mb, fb = must_core[sl] & (filled > 0), forb_core[sl]
        budget = max(min_area, slack * (must[sl] & (filled > 0)).sum())
        best = None
        for e in eps_list:
            rings = [cv2.approxPolyDP(r, e * epsilon, True) for r in [c] + holes]
            if len(rings[0]) < 3:
                break
            rings = [rings[0]] + [r for r in rings[1:] if len(r) >= 3]
            m = np.zeros((h, w), np.uint8)
            cv2.fillPoly(m, [r - [x, y] for r in rings], 1)
            m = m > 0
            if (m & fb).sum() <= budget and (mb & ~m).sum() <= budget:
                best = rings
            else:
                break
        if best is None:  # even the finest step is off: fall back to the plain outline
            best = [cv2.approxPolyDP(r, epsilon, True) for r in [c] + holes]
            best = [best[0]] + [r for r in best[1:] if len(r) >= 3]
            if len(best[0]) < 3:
                continue
        outer = best[0].reshape(-1, 2).astype(np.float64) + 0.5
        out.append((outer, [r.reshape(-1, 2).astype(np.float64) + 0.5 for r in best[1:]]))
    return out


def build_quads(img, ncolors, epsilon, min_area, denoise, upscale, sharpen, clean, speck, smooth,
                outline, outline_width, optimize=False, slack=0.002, reach=8):
    # work on a smooth upscaled copy so thin anti-aliased lines survive quantization;
    # all coordinates are mapped back to source pixels at the end
    w0, h0 = img.size
    img = img.convert("RGBA")
    if clean > 0:
        # edge-preserving denoise against JPEG blocks and ringing, before anything else
        rgb0 = cv2.fastNlMeansDenoisingColored(np.asarray(img.convert("RGB")), None, clean, clean, 7, 21)
        img = Image.fromarray(np.dstack([rgb0, np.asarray(img)[:, :, 3]]), "RGBA")
    if upscale > 1:
        img = img.resize((round(w0 * upscale), round(h0 * upscale)), Image.LANCZOS)
    rgb_img = img.convert("RGB")
    if sharpen > 0:
        # anti-aliased hairlines are mid-tones; sharpening pushes them back to their real colour
        rgb_img = rgb_img.filter(ImageFilter.UnsharpMask(radius=1.5 * upscale, percent=int(sharpen), threshold=0))
    rgb = np.asarray(rgb_img)
    alpha = np.asarray(img)[:, :, 3]
    palette, labels = quantize(rgb, ncolors, alpha >= 128)
    n = len(palette)
    labels = mode_filter(labels, n, denoise)
    labels = smooth_labels(labels, n, smooth * upscale)
    labels = remove_specks(labels, n, speck * upscale ** 2)
    # palette colours from the unsharpened pixels, so sharpening does not shift them
    orig = np.asarray(img.convert("RGB")).reshape(-1, 3)
    for i in range(n):
        sel = (labels.reshape(-1) == i) & (alpha.reshape(-1) >= 128)
        if sel.any():
            palette[i] = np.clip(np.rint(orig[sel].mean(0)), 0, 255)
    labels[alpha < 128] = -1  # transparent pixels get no quads
    valid = labels >= 0
    present = [i for i in range(n) if (labels == i).any()]
    colors = {i: tuple(int(v) for v in palette[i]) for i in present}

    # background: the colour that dominates the image border, always one solid quad
    border = np.concatenate([labels[0], labels[-1], labels[:, 0], labels[:, -1]])
    border = border[border >= 0]
    bg = int(np.bincount(border).argmax()) if len(border) else None

    # outlines: the darkest colour, always drawn last on top of everything.
    # If it is also the background, only its thin strokes count as outline.
    luma = {i: 0.299 * colors[i][0] + 0.587 * colors[i][1] + 0.114 * colors[i][2] for i in present}
    if outline == "none" or len(present) < 2:
        ol = None
    elif outline == "auto":
        ol = min(present, key=lambda i: luma[i])
    else:
        want = np.array([int(outline.lstrip("#")[k:k + 2], 16) for k in (0, 2, 4)])
        ol = min(present, key=lambda i: ((np.array(colors[i]) - want) ** 2).sum())
    if ol is None:
        ol_mask = np.zeros(labels.shape, bool)
    elif ol == bg:
        m = (labels == bg).astype(np.uint8)
        r = max(1, int(round(outline_width * upscale / 2)))
        k = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (2 * r + 1, 2 * r + 1))
        ol_mask = (m > 0) & (cv2.morphologyEx(m, cv2.MORPH_OPEN, k) == 0)
    else:
        ol_mask = labels == ol

    # fills in between, biggest first; each is drawn as the union of itself and
    # every fill drawn after it, so neighbouring fills overlap instead of leaving seams
    fills = [i for i in present if i != bg and i != ol]
    fills.sort(key=lambda i: -(labels == i).sum())

    shapes = []  # (layer name, color, [(x,y) * 4])

    def trace(name, color, mask, must=None):
        if must is not None:  # --optimize: cover `must`, may spread anywhere in `mask`
            polys = trace_within(must, mask, epsilon * upscale, min_area * upscale ** 2, reach * upscale, slack,
                                 edge=max(1, round(upscale)))
        else:
            polys = polygons_from_mask(mask, epsilon * upscale, min_area * upscale ** 2)
        for outer, holes in polys:
            verts, tris = triangulate(outer, holes)
            tris = drop_stray_triangles(verts, tris, mask)
            for q in pair_triangles(tris):
                shapes.append((name, color, [tuple(verts[i] / upscale) for i in q]))

    if bg is not None:
        if valid.all():
            shapes.append(("Background", colors[bg], [(0, 0), (w0, 0), (0, h0), (w0, h0)]))
        else:  # transparent picture: background only where the picture is
            trace("Background", colors[bg], valid)
    grow = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (2 * int(upscale) + 1, 2 * int(upscale) + 1))
    for r, c in enumerate(fills):
        mask = np.isin(labels, fills[r:])
        # tuck the fill a pixel under neighbouring outline strokes so no background shows at the seam
        mask |= (cv2.dilate(mask.astype(np.uint8), grow) > 0) & ol_mask
        if optimize:
            # cover only this colour; it may hide anywhere under the layers drawn on top of it
            trace("#%02x%02x%02x" % colors[c], colors[c], np.isin(labels, fills[r:]) | ol_mask, labels == c)
        else:
            trace("#%02x%02x%02x" % colors[c], colors[c], mask)
    if ol is not None:
        trace("Outline", colors[ol], ol_mask, ol_mask if optimize else None)
    used = ([bg] if bg is not None else []) + fills + ([ol] if ol is not None and ol != bg else [])
    return shapes, palette[used], (w0, h0)


# ---------------------------------------------------------------- map writer

def str_to_ints(s, n):
    b = s.encode()[: n * 4 - 1] + b"\0"
    b = b.ljust(n * 4, b"\0")
    ints = []
    for i in range(n):
        v = 0
        for k in range(4):
            ch = b[i * 4 + k]
            ch = ch - 256 if ch > 127 else ch
            v = (v << 8) | ((ch + 128) & 0xFF)
        ints.append(v)
    ints[-1] &= 0xFFFFFF00
    return [struct.unpack("<i", struct.pack("<I", v))[0] for v in ints]


class DataFileWriter:
    def __init__(self):
        self.items = {}  # type -> list of (id, bytes)
        self.datas = []

    def add_item(self, typ, item_id, ints):
        self.items.setdefault(typ, []).append((item_id, struct.pack("<%di" % len(ints), *ints)))

    def add_data(self, raw):
        self.datas.append(raw)
        return len(self.datas) - 1

    def save(self, path):
        types = sorted(self.items)
        all_items = [(t, i, d) for t in types for i, d in self.items[t]]
        comp = [zlib.compress(d) for d in self.datas]
        item_size = sum(8 + len(d) for _, _, d in all_items)
        data_size = sum(len(c) for c in comp)
        types_size = 12 * len(types)
        header_size = 36
        offset_size = 4 * (len(all_items) + 2 * len(self.datas))
        swap_size = header_size + types_size + offset_size + item_size
        file_size = swap_size + data_size
        out = bytearray(b"DATA")
        out += struct.pack("<8i", 4, file_size - 16, swap_size - 16, len(types), len(all_items),
                           len(self.datas), item_size, data_size)
        start = 0
        for t in types:
            out += struct.pack("<3i", t, start, len(self.items[t]))
            start += len(self.items[t])
        off = 0
        for _, _, d in all_items:
            out += struct.pack("<i", off)
            off += 8 + len(d)
        off = 0
        for c in comp:
            out += struct.pack("<i", off)
            off += len(c)
        for d in self.datas:
            out += struct.pack("<i", len(d))
        for t, i, d in all_items:
            out += struct.pack("<Ii", (t << 16) | i, len(d)) + d
        for c in comp:
            out += c
        assert len(out) == file_size
        with open(path, "wb") as f:
            f.write(out)


MAPITEMTYPE_VERSION, MAPITEMTYPE_INFO, MAPITEMTYPE_GROUP, MAPITEMTYPE_LAYER = 0, 1, 4, 5
LAYERTYPE_TILES, LAYERTYPE_QUADS = 2, 3
TILESLAYERFLAG_GAME = 1
TILE_SOLID, ENTITY_SPAWN_TILE = 1, 192 + 1


def write_map(path, shapes, img_size, height_tiles, margin=8):
    w_px, h_px = img_size
    units_per_px = height_tiles * TILE / h_px
    art_w = int(np.ceil(w_px * units_per_px / TILE))
    art_h = int(np.ceil(height_tiles))
    map_w, map_h = art_w + 2 * margin, art_h + 2 * margin
    ox, oy = margin * TILE, margin * TILE  # art top-left in world units

    df = DataFileWriter()
    df.add_item(MAPITEMTYPE_VERSION, 0, [1])
    df.add_item(MAPITEMTYPE_INFO, 0, [1, -1, -1, -1, -1, -1])

    # one quad layer per colour, in drawing order: Background, fills, Outline
    layers = {}
    for name, color, pts in shapes:
        layers.setdefault((name, color), []).append(pts)
    for li, ((name, color), quads) in enumerate(layers.items()):
        qidx = df.add_data(quad_data(quads, color, ox, oy, units_per_px))
        df.add_item(MAPITEMTYPE_LAYER, li, [0, LAYERTYPE_QUADS, 0, 2, len(quads), qidx, -1]
                    + str_to_ints(name, 3))
    nart = len(layers)

    # game layer: solid border, floor, one spawn
    tiles = np.zeros((map_h, map_w, 4), dtype=np.uint8)
    tiles[0, :, 0] = tiles[-1, :, 0] = TILE_SOLID
    tiles[:, 0, 0] = tiles[:, -1, 0] = TILE_SOLID
    tiles[map_h - 2, margin // 2, 0] = ENTITY_SPAWN_TILE
    gidx = df.add_data(tiles.tobytes())
    df.add_item(MAPITEMTYPE_LAYER, nart, [0, LAYERTYPE_TILES, 0, 3, map_w, map_h, TILESLAYERFLAG_GAME,
                                          255, 255, 255, 255, -1, 0, -1, gidx] + str_to_ints("Game", 3)
                + [-1, -1, -1, -1, -1])
    # groups: art behind game
    df.add_item(MAPITEMTYPE_GROUP, 0, [3, 0, 0, 100, 100, 0, nart, 0, 0, 0, 0, 0] + str_to_ints("Art", 3))
    df.add_item(MAPITEMTYPE_GROUP, 1, [3, 0, 0, 100, 100, nart, 1, 0, 0, 0, 0, 0] + str_to_ints("Game", 3))
    df.save(path)
    return map_w, map_h, nart


def quad_data(quads, color, ox, oy, units_per_px):
    qdata = bytearray()
    for pts in quads:
        fpts = [(int(round((ox + x * units_per_px) * FX)), int(round((oy + y * units_per_px) * FX))) for x, y in pts]
        cx = sum(p[0] for p in fpts) // 4
        cy = sum(p[1] for p in fpts) // 4
        ints = []
        for p in fpts + [(cx, cy)]:
            ints += p
        for _ in range(4):
            ints += [color[0], color[1], color[2], 255]
        ints += [0, 0, FX, 0, 0, FX, FX, FX]  # texcoords
        ints += [-1, 0, -1, 0]  # pos env, offset, color env, offset
        qdata += struct.pack("<%di" % len(ints), *ints)
    return bytes(qdata)


# ---------------------------------------------------------------- preview

def render_preview(path, shapes, img_size, scale=2, wire=False):
    w, h = img_size
    im = Image.new("RGB", (int(w * scale), int(h * scale)), (0, 0, 0))
    d = ImageDraw.Draw(im)
    for _, color, (p0, p1, p2, p3) in shapes:
        for tri in ((p0, p1, p3), (p0, p3, p2)):
            d.polygon([(x * scale, y * scale) for x, y in tri], fill=color)
    if wire:
        # one outline per quad, without its internal diagonal; triangles in blue
        for _, color, (p0, p1, p2, p3) in shapes:
            if (p0, p3) == ((0, 0), (w, h)):
                continue
            ring = [p0, p1, p3] if p2 == p3 else [p0, p1, p3, p2]
            pts = [(x * scale, y * scale) for x, y in ring]
            d.line(pts + [pts[0]], fill=(60, 120, 255) if p2 == p3 else (255, 60, 60), width=1)
    im.save(path)


def load_image(path, work_height):
    """Any format Pillow reads (png, jpg, webp, bmp, gif, tiff...), any size -> RGBA at a fixed height."""
    img = Image.open(path)
    img.seek(0)  # first frame of animations
    img = ImageOps.exif_transpose(img).convert("RGBA")
    w, h = img.size
    if h != work_height:
        img = img.resize((max(1, round(w * work_height / h)), work_height), Image.LANCZOS)
    return img


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("image")
    ap.add_argument("output", help="output .map file")
    ap.add_argument("--colors", type=int, default=0, help="palette size (0 = auto, up to 8)")
    ap.add_argument("--epsilon", type=float, default=1.0,
                    help="outline simplification in source pixels; higher = fewer quads, rougher shape")
    ap.add_argument("--min-area", type=float, default=2, help="drop islands/holes smaller than this many source pixels")
    ap.add_argument("--denoise", type=int, default=1, help="mode filter size against JPEG speckles (1 = off)")
    ap.add_argument("--clean", type=float, default=10, help="JPEG artifact denoise strength before tracing (0 = off)")
    ap.add_argument("--speck", type=float, default=12,
                    help="repaint blobs smaller than this many source pixels with the colour around them (0 = off)")
    ap.add_argument("--smooth", type=float, default=0.6, help="edge smoothing radius in source pixels (0 = off)")
    ap.add_argument("--sharpen", type=float, default=250, help="unsharp mask strength in %% before quantizing (0 = off)")
    ap.add_argument("--upscale", type=float, default=3, help="trace at this multiple of the source size (keeps thin lines)")
    ap.add_argument("--outline", default="auto",
                    help="outline colour drawn on top of everything: auto (darkest), none, or a hex like #000000")
    ap.add_argument("--outline-width", type=float, default=3,
                    help="when the outline colour is also the background: strokes thinner than this many pixels")
    ap.add_argument("--height-tiles", type=float, default=50, help="height of the art in game tiles")
    ap.add_argument("--work-height", type=int, default=1200,
                    help="every input is resized to this height first, so all options behave the same for any resolution")
    ap.add_argument("--optimize", action="store_true",
                    help="fewer quads: each colour may spread under the layers drawn above it and is simplified as far as --slack allows")
    ap.add_argument("--slack", type=float, default=0.002,
                    help="--optimize: share of a piece's pixels that may come out wrong (0.002 = 0.2%%)")
    ap.add_argument("--reach", type=float, default=8,
                    help="--optimize: how far (px) a colour may spread under the layers above it")
    ap.add_argument("--preview", help="write a PNG rendering of the quads")
    ap.add_argument("--wire", help="write a PNG rendering with triangle edges")
    a = ap.parse_args()

    img = load_image(a.image, a.work_height)
    shapes, palette, size = build_quads(img, a.colors, a.epsilon, a.min_area, a.denoise, a.upscale, a.sharpen, a.clean, a.speck, a.smooth,
                                         a.outline, a.outline_width, a.optimize, a.slack, a.reach)
    mw, mh, nl = write_map(a.output, shapes, size, a.height_tiles)
    tri = sum(1 for _, _, p in shapes if p[2] == p[3])
    print(f"palette: {' '.join('#%02x%02x%02x' % tuple(c) for c in palette)}")
    print(f"quads: {len(shapes)} ({tri} of them triangles)  layers: {nl}  map: {mw}x{mh} tiles -> {a.output}")
    if a.preview:
        render_preview(a.preview, shapes, size)
    if a.wire:
        render_preview(a.wire, shapes, size, wire=True)


if __name__ == "__main__":
    main()
