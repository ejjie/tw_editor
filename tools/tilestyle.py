"""Learn the freeze and hook look of a hand-designed DDNet map and put it on other maps.

Every cell of the game layer is one of three kinds: air, wall (hook, unhook, hookthrough) or freeze.
For each air or freeze cell the script reads the 3x3 around it (plus the four cells two steps away
straight up, down, left and right, which tell a bar's end from a bar's side) and remembers the whole
stack of freeze tiles the mapper put there: the freeze layer and all its decoration layers together,
so a freeze edge tile and the decoration hanging on it always come as a pair. Hook tiles are plain
(tile 73, unturned) on every hook and unhook cell.

Looking up a cell: the 3x3 + 4 situation if the map had it, else the plain 3x3, else the same
situation turned or mirrored (with the tiles turned or mirrored along), else plain freeze (73) on
freeze and nothing on air. Where the mapper did one situation in several ways, the way used most
often wins, so the result never flickers between variants.

    python tilestyle.py learn designed.map styles/<name> [--spec spec.json]
    python tilestyle.py apply styles/<name> in.map out.map

spec.json (optional): {"title": ..., "freeze": [layer names, bottom first], "hook": "hook",
"colors": {layer: [r, g, b, a]}, "extra": [style layer entries copied as they are: glow rules
{"rules": {"config", "mask"}} for the editor, or {"plain": tile, "on": [cell kinds]}]}.
Without a spec, the freeze layers are the tile layers that sit on freeze or next to it, and the hook
layer is the one on hook cells.
"""
import json
import os
import sys

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import twmap  # noqa: E402

AIR, WALL, FREEZE = 0, 1, 2
HOOK_TILE = 73 * 16  # index * 16 + flags
FREEZE_TILE = 73 * 16
# the cells a situation looks at: 3x3 first, then the four cells two steps away
NEAR = [(dx, dy) for dy in (-1, 0, 1) for dx in (-1, 0, 1)]
FAR = NEAR + [(0, -2), (-2, 0), (2, 0), (0, 2)]
FLAG_ORDER = [0, 1, 2, 3, 8, 9, 10, 11]


def classes(game, front=None):
    c = np.zeros(game.shape, np.int8)
    c[(game == 1) | (game == 3)] = WALL
    if front is not None:
        c[front == 5] = WALL
    c[game == 9] = FREEZE
    if front is not None:
        c[(front == 9) & (c == AIR)] = FREEZE
    return c


def situation(cls, offs):
    """(H, W) int64 key of the cells at offs around every cell (outside the map is wall)."""
    H, W = cls.shape
    P = np.pad(cls, 2, constant_values=WALL).astype(np.int64)
    k = np.zeros((H, W), np.int64)
    for dx, dy in offs:
        k = k * 3 + P[2 + dy:2 + dy + H, 2 + dx:2 + dx + W]
    return k


# ---- turning and mirroring ------------------------------------------------------------------------

def flag_view(a, f):
    """how a tile picture a (square) looks with DDNet tile flags f, sampled the way DDNet maps the texture"""
    n = a.shape[0]
    ys, xs = np.mgrid[0:n, 0:n]
    tx, ty = xs, ys
    if f & 8:
        tx, ty = ys, n - 1 - xs
    if f & 1:
        tx = n - 1 - tx
    if f & 2:
        ty = n - 1 - ty
    return a[ty, tx]


TURNS = [lambda a, k=k, m=m: np.rot90(a[:, ::-1] if m else a, k) for m in (0, 1) for k in range(4)]  # [0] = as is
_PROBE = np.arange(9).reshape(3, 3)
# FLAG_TURN[t][f]: the flags a tile with flags f gets when the whole map is turned by TURNS[t]
FLAG_TURN = np.zeros((8, 16), np.int64)
for _t, _op in enumerate(TURNS):
    for _f in FLAG_ORDER:
        _want = _op(flag_view(_PROBE, _f))
        FLAG_TURN[_t, _f] = next(g for g in FLAG_ORDER if np.array_equal(flag_view(_PROBE, g), _want))


def turn_key(key, offs, t):
    """the key of the same situation with the map turned by TURNS[t]"""
    grid = np.full((5, 5), -1, np.int64)
    vals = []
    for _ in offs:
        vals.append(key % 3)
        key //= 3
    for (dx, dy), v in zip(offs, reversed(vals)):
        grid[dy + 2, dx + 2] = v
    g = TURNS[t](grid)
    k = 0
    for dx, dy in offs:
        k = k * 3 + int(g[dy + 2, dx + 2])
    return k


def same_look_flags(img):
    """(256, 16): flags -> the plainest flags that look the same for that tile (a full block is always
    stored unturned, whatever the mapper clicked)."""
    out = np.tile(np.arange(16), (256, 1))
    if img is None or img.external or not img.rgba:
        return out
    a = np.frombuffer(img.rgba, np.uint8).reshape(img.height, img.width, 4)
    th, tw = img.height // 16, img.width // 16
    n = min(th, tw)
    for i in range(1, 256):
        t = a[(i // 16) * th:(i // 16) * th + n, (i % 16) * tw:(i % 16) * tw + n]
        looks = [flag_view(t, f) for f in FLAG_ORDER]
        for j, f in enumerate(FLAG_ORDER):
            for k in range(j):
                if np.array_equal(looks[j], looks[k]):
                    out[i, f] = out[i, FLAG_ORDER[k]]
                    break
    return out


# ---- learning --------------------------------------------------------------------------------------

def tile_array(layer):
    a = np.frombuffer(bytes(layer.tiles), np.uint8).reshape(layer.height, layer.width, 4)
    return a[..., 0].astype(np.int64) * 16 + (a[..., 1].astype(np.int64) & 11)


def pick_layers(m, game):
    """freeze layers (bottom first) and the hook layer of a designed map, by where their tiles sit"""
    freeze, hook = [], None
    near = np.zeros(game.shape, bool)
    fz = game == 9
    for dy in (-1, 0, 1):
        for dx in (-1, 0, 1):
            near |= np.roll(np.roll(fz, dy, 0), dx, 1)
    for g in m.groups:
        for l in g.layers:
            if not l or l.kind != 'tiles' or l.image < 0 or (l.width, l.height) != (game.shape[1], game.shape[0]):
                continue
            used = tile_array(l) >= 16
            if not used.any():
                continue
            if (used & near).sum() > 0.9 * used.sum():
                freeze.append(l)
            elif (used & ((game == 1) | (game == 3))).sum() > 0.9 * used.sum() and hook is None:
                hook = l
    return freeze, hook


def learn(map_path, out_dir, spec=None):
    m = twmap.load(map_path)
    gl = next(l for g in m.groups for l in g.layers if l and l.kind == 'game')
    game = tile_array(gl) >> 4
    fl = next((l for g in m.groups for l in g.layers if l and l.kind == 'front'), None)
    front = tile_array(fl) >> 4 if fl else None
    layers = {l.name: l for g in m.groups for l in g.layers if l and l.kind == 'tiles'}
    spec = spec or {}
    if spec.get('freeze'):
        freeze = [layers[n] for n in spec['freeze']]
        hook = layers.get(spec.get('hook', 'hook'))
    else:
        freeze, hook = pick_layers(m, game)
    if not freeze:
        raise ValueError('no freeze layers found')
    img = m.images[freeze[0].image]
    same = same_look_flags(img)

    def norm(t):
        i, f = t >> 4, t & 15
        return np.where(i > 0, i * 16 + same[i, f], 0)

    stack = np.stack([norm(tile_array(l)) for l in freeze], -1)  # (H, W, n)
    cls = classes(game, front)
    todo = cls != WALL
    n = len(freeze)
    stacks, ids = {}, {}

    def stack_id(s):
        if s not in ids:
            ids[s] = len(stacks)
            stacks[len(stacks)] = s
        return ids[s]

    tables = []
    for offs in (FAR, NEAR):
        keys = situation(cls, offs)[todo]
        st = stack[todo]
        count = {}
        for k, s in zip(keys.tolist(), map(tuple, st.tolist())):
            c = count.setdefault(k, {})
            c[s] = c.get(s, 0) + 1
        seen = {k: max(c.items(), key=lambda kv: (kv[1], not any(kv[0])))[0] for k, c in count.items()}
        turned = {}
        for k, s in seen.items():
            for t in range(1, 8):
                k2 = turn_key(k, offs, t)
                if k2 in seen or k2 in turned:
                    continue
                turned[k2] = tuple(int((v >> 4) * 16 + same[v >> 4, FLAG_TURN[t, v & 15]]) if v else 0 for v in s)
        tables.append(({k: stack_id(s) for k, s in seen.items()}, {k: stack_id(s) for k, s in turned.items()}))

    # second look: the same situation plus the stacks already on the 8 cells around, so a notch in one freeze
    # tile always meets the notch or decoration next to it, and one corner never gets two horns
    stack_id((0,) * n)
    stack_id((FREEZE_TILE,) + (0,) * (n - 1))
    sid = np.full(cls.shape, -1, np.int64)
    ys, xs = np.nonzero(todo)
    sid[ys, xs] = [stack_id(tuple(v)) for v in stack[ys, xs].tolist()]
    pairs = []
    for offs in (FAR, NEAR):
        keys = with_sides(situation(cls, offs), sid)[todo]
        count = {}
        for k, v in zip(keys.tolist(), sid[todo].tolist()):
            c = count.setdefault(k, {})
            c[v] = c.get(v, 0) + 1
        pairs.append({k: max(c.items(), key=lambda kv: kv[1])[0] for k, c in count.items()})

    os.makedirs(out_dir, exist_ok=True)
    name = os.path.basename(os.path.normpath(out_dir))
    imgs = {img.name}
    color = spec.get('colors', {})
    out_layers = [{'name': l.name, 'image': img.name, 'color': color.get(l.name, list(l.color)), 'freeze': j}
                  for j, l in enumerate(freeze)]
    if hook is not None:
        out_layers.append({'name': hook.name, 'image': m.images[hook.image].name,
                           'color': color.get(hook.name, list(hook.color)), 'hook': True})
        imgs.add(m.images[hook.image].name)
    out_layers += spec.get('extra', [])
    meta = {'name': name, 'title': spec.get('title', name.capitalize()), 'source': os.path.basename(map_path),
            'engine': 2, 'layers': out_layers}
    data = {'stacks': [list(stacks[i]) for i in range(len(stacks))],
            'tables': [{'seen': {str(k): v for k, v in a.items()}, 'turned': {str(k): v for k, v in b.items()}}
                       for a, b in tables],
            'sides': [{str(k): v for k, v in p.items()} for p in pairs]}
    json.dump(meta, open(os.path.join(out_dir, 'style.json'), 'w', encoding='utf-8'), indent=1)
    json.dump(data, open(os.path.join(out_dir, 'tables.json'), 'w'), separators=(',', ':'))
    for im in m.images:
        if im.name in imgs and not im.external and im.rgba:
            write_png(os.path.join(out_dir, im.name + '.png'), im.width, im.height, im.rgba)
    seen_cells = len(stack[todo])
    print('%s: %d freeze layers (%s), hook layer %s, %d cells, %d situations (3x3+4), %d (3x3), %d tile stacks'
          % (name, n, ', '.join(l.name for l in freeze), hook.name if hook else '-', seen_cells,
             len(tables[0][0]), len(tables[1][0]), len(stacks)))
    return meta


def write_png(path, w, h, rgba):
    import struct
    import zlib
    raw = b''.join(b'\0' + bytes(rgba[y * w * 4:(y + 1) * w * 4]) for y in range(h))

    def chunk(t, d):
        return struct.pack('>I', len(d)) + t + d + struct.pack('>I', zlib.crc32(t + d) & 0xffffffff)
    with open(path, 'wb') as f:
        f.write(b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', struct.pack('>IIBBBBB', w, h, 8, 6, 0, 0, 0))
                + chunk(b'IDAT', zlib.compress(raw, 9)) + chunk(b'IEND', b''))


# ---- applying --------------------------------------------------------------------------------------

def load_style(style_dir):
    meta = json.load(open(os.path.join(style_dir, 'style.json'), encoding='utf-8'))
    data = json.load(open(os.path.join(style_dir, 'tables.json')))
    stacks = np.array(data['stacks'], np.int64).reshape(len(data['stacks']), -1)
    meta['_stacks'] = stacks
    meta['_tables'] = []
    for t in data['tables']:
        for part in ('seen', 'turned'):
            d = t[part]
            keys = np.array(sorted(int(k) for k in d), np.int64)
            meta['_tables'].append((keys, np.array([d[str(k)] for k in keys], np.int64)))
    meta['_sides'] = []
    for d in data.get('sides', []):
        keys = np.array(sorted(int(k) for k in d), np.int64)
        meta['_sides'].append((keys, np.array([d[str(k)] for k in keys], np.int64)))
    return meta


SIDE_ROUNDS = 3
SIDES = [(dx, dy) for dy in (-1, 0, 1) for dx in (-1, 0, 1) if dx or dy]


def with_sides(keys, sid):
    """situation keys mixed with the stack ids on the 8 cells around every cell (a hash, same in learn/apply)"""
    H, W = sid.shape
    P = np.pad(sid, 1, constant_values=-1)
    h = keys.astype(np.int64)
    with np.errstate(over='ignore'):
        for dx, dy in SIDES:
            h = h * np.int64(1000003) + (P[1 + dy:1 + dy + H, 1 + dx:1 + dx + W] + 2)
    return h


def lookup(keys, table):
    tk, tv = table
    out = np.full(keys.shape, -1, np.int64)
    if not len(tk):
        return out
    pos = np.searchsorted(tk, keys)
    pos[pos >= len(tk)] = 0
    hit = tk[pos] == keys
    out[hit] = tv[pos[hit]]
    return out


def apply(style, game, front=None, seed=1):
    """game/front: (H, W) index arrays -> [(layer meta, (H, W) tile array index*16+flags)] for the style's
    freeze and hook layers, in the style's order (rules layers are left to the editor)."""
    cls = classes(game, front)
    far, near = situation(cls, FAR), situation(cls, NEAR)
    T = style['_tables']  # far seen, far turned, near seen, near turned
    sid = np.full(cls.shape, -1, np.int64)
    for keys, table in ((far, T[0]), (near, T[2]), (far, T[1]), (near, T[3])):
        todo = sid < 0
        sid[todo] = lookup(keys[todo], table)
    stacks = style['_stacks']
    index = {tuple(v): i for i, v in enumerate(stacks.tolist())}
    n = stacks.shape[1]
    sid[(sid < 0) & (cls == FREEZE)] = index.get((FREEZE_TILE,) + (0,) * (n - 1), -1)
    sid[(sid < 0) & (cls == AIR)] = index.get((0,) * n, -1)
    sid[cls == WALL] = -1
    open_ = cls != WALL
    for _ in range(SIDE_ROUNDS if style.get('_sides') else 0):
        new = np.full(sid.shape, -1, np.int64)
        for keys, table in ((far, style['_sides'][0]), (near, style['_sides'][1])):
            todo = (new < 0) & open_
            new[todo] = lookup(with_sides(keys, sid)[todo], table)
        sid = np.where(new >= 0, new, sid)
    out = []
    for L in style['layers']:
        if 'freeze' in L:
            j = L['freeze']
            t = np.where(sid >= 0, stacks[np.maximum(sid, 0), j] if stacks.shape[1] > j else 0, 0)
            t = np.where(cls == WALL, 0, t)
            out.append((L, t.astype(np.int32)))
        elif L.get('hook'):
            out.append((L, np.where((game == 1) | (game == 3), HOOK_TILE, 0).astype(np.int32)))
        elif 'plain' in L:  # one tile on some kinds of cells, e.g. {"plain": 73, "on": ["hookthrough"]}
            kinds = {'hook': game == 1, 'unhook': game == 3, 'freeze': cls == FREEZE,
                     'hookthrough': (front == 5) if front is not None else np.zeros(game.shape, bool)}
            on = np.zeros(game.shape, bool)
            for k in L.get('on', []):
                on |= kinds[k]
            out.append((L, np.where(on, L['plain'] * 16, 0).astype(np.int32)))
    return out


def apply_to_map(style_dir, in_map, out_map, seed=1):
    style = load_style(style_dir)
    m = twmap.load(in_map)
    gl = next(l for g in m.groups for l in g.layers if l and l.kind == 'game')
    game = tile_array(gl) >> 4
    fl = next((l for g in m.groups for l in g.layers if l and l.kind == 'front'), None)
    front = tile_array(fl) >> 4 if fl else None
    names = {}
    for L in style['layers']:
        if L['image'] not in names:
            p = os.path.join(style_dir, L['image'] + '.png')
            w, h, rgba = read_png(p)
            m.images.append(twmap.Image(L['image'], w, h, external=False, rgba=rgba))
            names[L['image']] = len(m.images) - 1
    grp = next(g for g in m.groups for l in g.layers if l is gl)
    at = grp.layers.index(gl) + 1
    for L, t in apply(style, game, front, seed):
        tl = twmap.TileLayer(L['name'], gl.width, gl.height, image=names[L['image']], color=L['color'])
        a = np.frombuffer(tl.tiles, np.uint8).reshape(gl.height, gl.width, 4).copy()
        a[..., 0] = t >> 4
        a[..., 1] = t & 15
        tl.tiles = bytearray(a.tobytes())
        grp.layers.insert(at, tl)
        at += 1
    twmap.save(m, out_map)


def read_png(path):
    from PIL import Image
    im = Image.open(path).convert('RGBA')
    return im.width, im.height, im.tobytes()


def main():
    a = sys.argv[1:]
    if len(a) >= 3 and a[0] == 'learn':
        spec = None
        if '--spec' in a:
            spec = json.load(open(a[a.index('--spec') + 1], encoding='utf-8'))
        learn(a[1], a[2], spec)
    elif len(a) == 4 and a[0] == 'apply':
        apply_to_map(a[1], a[2], a[3])
    else:
        print(__doc__)
        sys.exit(1)


if __name__ == '__main__':
    main()
