"""Quad-art for the editor: picture -> coloured quads, using img2quads.py.

Modes:
  color    - img2quads defaults (quantize, clean JPEG noise, trace)
  clean    - picture already has a few flat tones (pixel art, prepared pictures)
  negative - ink drawing turned into light lines on a dark background (+ optional grey fill tone)
  lines    - only the ink lines, every thin stroke kept, no fills
The negative/lines preparation is the one used for bob, girl_neg and girl_lines (tw-quads/_claude/inputs.md).
"""
import base64
import io

import cv2
import numpy as np
from PIL import Image, ImageOps

import img2quads as iq


def decode_image(data_url):
    raw = base64.b64decode(data_url.split(",", 1)[-1])
    img = Image.open(io.BytesIO(raw))
    img.seek(0)
    return ImageOps.exif_transpose(img).convert("RGBA")


def to_data_url(img):
    buf = io.BytesIO()
    img.save(buf, "PNG")
    return "data:image/png;base64," + base64.b64encode(buf.getvalue()).decode()


def fit_height(img, h):
    w0, h0 = img.size
    if h0 == h:
        return img
    return img.resize((max(1, round(w0 * h / h0)), h), Image.LANCZOS if h < h0 else Image.BICUBIC)


def drop_specks(lab, values, min_px):
    """Repaint connected blobs smaller than min_px with the most common neighbouring tone."""
    for v in values:
        n, comp, stats, _ = cv2.connectedComponentsWithStats((lab == v).astype(np.uint8), 8)
        small = [i for i in range(1, n) if stats[i, 4] < min_px]
        for i in small:
            m = comp == i
            ring = cv2.dilate(m.astype(np.uint8), np.ones((3, 3), np.uint8)).astype(bool) & ~m
            vals = lab[ring]
            vals = vals[vals != v]
            if len(vals):
                lab[m] = np.bincount(vals).argmax()
    return lab


def prep_ink(img, p):
    """Ink drawing -> 2 or 3 clean tones. Returns (RGBA image, ink colour hex)."""
    alpha = np.asarray(img)[:, :, 3]
    flat = Image.new("RGB", img.size, (255, 255, 255))
    flat.paste(img, mask=img.split()[3])
    g = np.asarray(flat.convert("L"))
    t_ink = int(p.get("ink", 128))
    ink = g < t_ink
    bh = int(p.get("blackhat", 45))
    if bh > 0:
        # thin anti-aliased strokes are lighter than the threshold but darker than their surroundings
        ink |= cv2.morphologyEx(g, cv2.MORPH_BLACKHAT, np.ones((9, 9), np.uint8)) > bh
    lab = np.full(g.shape, 2, np.uint8)  # 2 = paper
    if p.get("gray") and p.get("mode") != "lines":
        hi = int(p.get("gray_hi", 215))
        bl = cv2.medianBlur(cv2.medianBlur(g, 7), 7)
        g0 = ((bl < hi) & (bl >= t_ink)).astype(np.uint8)
        core = cv2.morphologyEx(g0, cv2.MORPH_OPEN, np.ones((13, 13), np.uint8))
        grey = (g0 & cv2.dilate(core, np.ones((11, 11), np.uint8)) & (cv2.medianBlur(g, 5) < hi)) > 0
        lab[grey] = 1
    lab[ink] = 0
    thick = int(p.get("thicken", 0))
    if thick > 0:
        k = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (2 * thick + 1, 2 * thick + 1))
        lab[cv2.dilate((lab == 0).astype(np.uint8), k) > 0] = 0
    lab = drop_specks(lab, (0, 1, 2), int(p.get("speck_px", 20)))
    if p.get("invert", True):
        pal = np.array([[245, 245, 245], [75, 75, 75], [10, 10, 10]], np.uint8)
    else:
        pal = np.array([[10, 10, 10], [180, 180, 180], [245, 245, 245]], np.uint8)
    rgb = pal[lab]
    out = Image.fromarray(np.dstack([rgb, np.where(alpha >= 128, 255, 0).astype(np.uint8)]), "RGBA")
    return out, "#%02x%02x%02x" % tuple(int(v) for v in pal[0])


def render(shapes, size, scale):
    from PIL import ImageDraw
    w, h = size
    im = Image.new("RGBA", (max(1, int(w * scale)), max(1, int(h * scale))), (0, 0, 0, 0))
    d = ImageDraw.Draw(im)
    for _, color, (p0, p1, p2, p3) in shapes:
        for tri in ((p0, p1, p3), (p0, p3, p2)):
            d.polygon([(x * scale, y * scale) for x, y in tri], fill=tuple(color))
    return im


def convert(req):
    img = decode_image(req["image"])
    mode = req.get("mode", "color")
    p = dict(req)
    work_h = int(p.get("work_height", 1200))
    img = fit_height(img, work_h)
    src_preview = None

    opt = dict(epsilon=1.0, min_area=2, denoise=1, upscale=3, sharpen=250, clean=10, speck=12, smooth=0.6,
               outline="auto", outline_width=3, optimize=False, slack=0.002, reach=8)
    ncolors = int(p.get("colors", 0))
    if mode in ("clean", "negative", "lines"):
        opt.update(clean=0, sharpen=0, speck=4, smooth=0.4, upscale=1, optimize=True)
    if mode in ("negative", "lines"):
        p["mode"] = mode
        img, ink_hex = prep_ink(img, p)
        src_preview = img
        opt["outline"] = ink_hex
        ncolors = 3 if (p.get("gray") and mode == "negative") else 2
    if mode == "lines":
        opt.update(speck=0, min_area=0.5, smooth=0, slack=0.0005)
    # explicit settings from the dialog win over the preset
    for k in ("epsilon", "min_area", "upscale", "sharpen", "clean", "speck", "smooth", "outline_width", "slack", "reach"):
        if p.get(k) is not None and p.get(k) != "":
            opt[k] = float(p[k])
    if p.get("optimize") is not None:
        opt["optimize"] = bool(p["optimize"])
    if p.get("outline") and mode not in ("negative", "lines"):
        opt["outline"] = p["outline"]

    shapes, palette, size = iq.build_quads(img, ncolors, opt["epsilon"], opt["min_area"], opt["denoise"], opt["upscale"],
                                           opt["sharpen"], opt["clean"], opt["speck"], opt["smooth"], opt["outline"],
                                           opt["outline_width"], opt["optimize"], opt["slack"], opt["reach"])
    layers = {}
    for name, color, pts in shapes:
        key = (name, tuple(color))
        layers.setdefault(key, []).append([[round(x, 3), round(y, 3)] for x, y in pts])
    out_layers = [{"name": name, "color": list(color), "quads": quads} for (name, color), quads in layers.items()]

    preview = to_data_url(render(shapes, size, max(0.25, min(1.0, 900 / max(size)))))
    tri = sum(1 for _, _, q in shapes if q[2] == q[3])
    return {
        "width": size[0], "height": size[1], "layers": out_layers, "count": len(shapes), "triangles": tri,
        "palette": ["#%02x%02x%02x" % tuple(int(v) for v in c) for c in palette],
        "preview": preview, "source": to_data_url(src_preview) if src_preview is not None else None,
    }
