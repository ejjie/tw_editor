"""Minimal DDNet .map reader/writer (tile layers only), standard library only.

Reads images, groups and tile/game layers of a .map (datafile v3/v4) and writes
simple maps made of those. Quads, sounds, envelopes are skipped on write.
"""
import struct
import zlib

ITEM_VERSION, ITEM_INFO, ITEM_IMAGE, ITEM_ENVELOPE, ITEM_GROUP, ITEM_LAYER = 0, 1, 2, 3, 4, 5
LAYER_TILES = 2
TF_GAME, TF_TELE, TF_SPEEDUP, TF_FRONT, TF_SWITCH, TF_TUNE = 1, 2, 4, 8, 16, 32
KIND_BY_FLAG = [(TF_GAME, 'game'), (TF_TELE, 'tele'), (TF_SPEEDUP, 'speedup'),
                (TF_FRONT, 'front'), (TF_SWITCH, 'switch'), (TF_TUNE, 'tune')]
SPECIAL_SLOT = {'tele': 18, 'speedup': 19, 'front': 20, 'switch': 21, 'tune': 22}
TILE_BYTES = {'tiles': 4, 'game': 4, 'front': 4, 'tele': 2, 'speedup': 6, 'switch': 4, 'tune': 2}


def ints_to_str(ints):
    out = bytearray()
    for v in ints:
        for k in (3, 2, 1, 0):
            b = (((v >> (k * 8)) & 0xff) - 128) & 0xff
            if b == 0:
                return out[:len(ints) * 4 - 1].decode('utf-8', 'replace')
            out.append(b)
    return out[:len(ints) * 4 - 1].decode('utf-8', 'replace')


def str_to_ints(s, n):
    b = list(s.encode('utf-8'))[:n * 4 - 1]
    b += [0] * (n * 4 - len(b))
    ints = []
    for i in range(n):
        v = 0
        for k in range(4):
            v = (v << 8) | ((b[i * 4 + k] + 128) & 0xff)
        ints.append(v)
    ints[-1] &= 0xffffff00
    return [v - (1 << 32) if v >= 1 << 31 else v for v in ints]


def _cstr(b):
    if b is None:
        return ''
    return b.split(b'\0', 1)[0].decode('utf-8', 'replace')


class TileLayer:
    def __init__(self, name, w, h, kind='tiles', image=-1, color=(255, 255, 255, 255)):
        self.name, self.width, self.height, self.kind = name, w, h, kind
        self.image, self.color = image, list(color)
        self.flags = 0
        self.tiles = bytearray(w * h * 4)  # index, flags, skip, reserved

    def get(self, x, y):
        o = (y * self.width + x) * 4
        return self.tiles[o], self.tiles[o + 1]

    def set(self, x, y, idx, flags=0):
        o = (y * self.width + x) * 4
        self.tiles[o], self.tiles[o + 1] = idx, flags


class Group:
    def __init__(self, name, layers=None, parallax=(100, 100), offset=(0, 0)):
        self.name, self.layers = name, layers or []
        self.parallax, self.offset = parallax, offset


class Image:
    def __init__(self, name, width, height, external=True, rgba=None):
        self.name, self.width, self.height, self.external, self.rgba = name, width, height, external, rgba


class Map:
    def __init__(self):
        self.images, self.groups = [], []

    def game_layer(self):
        for g in self.groups:
            for l in g.layers:
                if isinstance(l, TileLayer) and l.kind == 'game':
                    return l
        return None


def load(path):
    buf = open(path, 'rb').read()
    if buf[:4] not in (b'DATA', b'ATAD'):
        raise ValueError('not a .map file')
    version, = struct.unpack_from('<i', buf, 4)
    num_types, num_items, num_data, item_size, data_size = struct.unpack_from('<5i', buf, 16)
    p = 36 + num_types * 12
    item_offs = struct.unpack_from('<%di' % num_items, buf, p); p += num_items * 4
    data_offs = struct.unpack_from('<%di' % num_data, buf, p); p += num_data * 4
    if version == 4:
        p += num_data * 4
    items_start, data_start = p, p + item_size
    items = []
    for o in item_offs:
        key, size = struct.unpack_from('<Ii', buf, items_start + o)
        ints = list(struct.unpack_from('<%di' % (size // 4), buf, items_start + o + 8))
        items.append((key >> 16, key & 0xffff, ints))
    cache = {}

    def data(i):
        if i < 0 or i >= num_data:
            return None
        if i not in cache:
            s = data_start + data_offs[i]
            e = data_start + data_offs[i + 1] if i + 1 < num_data else data_start + data_size
            raw = buf[s:e]
            cache[i] = zlib.decompress(raw) if version == 4 else raw
        return cache[i]

    def of(t):
        return sorted([it for it in items if it[0] == t], key=lambda it: it[1])

    m = Map()
    for _, _, v in of(ITEM_IMAGE):
        ext = bool(v[3])
        m.images.append(Image(_cstr(data(v[4])), v[1], v[2], ext, None if ext or v[5] < 0 else data(v[5])))
    layers = []
    for _, _, v in of(ITEM_LAYER):
        if v[1] != LAYER_TILES:
            layers.append(None)
            continue
        kind = 'tiles'
        for f, k in KIND_BY_FLAG:
            if v[6] & f:
                kind = k
        w, h = v[4], v[5]
        name = ints_to_str(v[15:18]) if v[3] >= 3 and len(v) > 17 else ''
        l = TileLayer(name, w, h, kind, v[13], v[7:11])
        l.flags = v[2]
        slot = 14 if kind in ('tiles', 'game') else SPECIAL_SLOT.get(kind) if kind in ('front', 'switch') else None
        if slot is not None and len(v) > slot:
            raw = data(v[slot])
            if raw:
                if v[3] >= 4 and kind != 'switch':  # 0.7 compressed tiles
                    out = bytearray()
                    for i in range(0, len(raw) - 3, 4):
                        out += bytes((raw[i], raw[i + 1], 0, 0)) * (raw[i + 2] + 1)
                    raw = out
                n = min(len(raw), len(l.tiles))
                l.tiles[:n] = raw[:n]
        layers.append(l)
    for _, _, v in of(ITEM_GROUP):
        name = ints_to_str(v[12:15]) if len(v) > 14 and v[0] >= 3 else ''
        g = Group(name, [l for l in layers[v[5]:v[5] + v[6]]], (v[3], v[4]), (v[1], v[2]))
        m.groups.append(g)
    return m


def save(m, path):
    items, data = [], []

    def add_data(b):
        data.append(bytes(b)); return len(data) - 1

    def add_str(s):
        return add_data(s.encode('utf-8') + b'\0')

    items.append((ITEM_VERSION, 0, [1]))
    items.append((ITEM_INFO, 0, [1, -1, -1, -1, -1, -1]))
    for i, img in enumerate(m.images):
        n = add_str(img.name)
        d = -1 if img.external or img.rgba is None else add_data(img.rgba)
        items.append((ITEM_IMAGE, i, [1, img.width, img.height, 1 if d < 0 else 0, n, d]))
    li = 0
    for gi, g in enumerate(m.groups):
        start = li
        for l in g.layers:
            tflags = TF_GAME if l.kind == 'game' else 0
            d = add_data(l.tiles)
            items.append((ITEM_LAYER, li, [0, LAYER_TILES, l.flags, 3, l.width, l.height, tflags, *l.color, -1, 0,
                                           l.image, d, *str_to_ints(l.name, 3), -1, -1, -1, -1, -1]))
            li += 1
        items.append((ITEM_GROUP, gi, [3, g.offset[0], g.offset[1], g.parallax[0], g.parallax[1], start, len(g.layers),
                                       0, 0, 0, 0, 0, *str_to_ints(g.name, 3)]))
    items.sort(key=lambda it: (it[0], it[1]))
    types = []
    for i, it in enumerate(items):
        if types and types[-1][0] == it[0]:
            types[-1][2] += 1
        else:
            types.append([it[0], i, 1])
    comp = [zlib.compress(d, 9) for d in data]
    item_size = sum(8 + len(it[2]) * 4 for it in items)
    data_size = sum(len(c) for c in comp)
    header = 36 + len(types) * 12 + len(items) * 4 + len(data) * 8
    swap = header + item_size
    out = bytearray(b'DATA')
    out += struct.pack('<8i', 4, swap + data_size - 16, swap - 16, len(types), len(items), len(data), item_size, data_size)
    for t in types:
        out += struct.pack('<3i', *t)
    off = 0
    for it in items:
        out += struct.pack('<i', off); off += 8 + len(it[2]) * 4
    off = 0
    for c in comp:
        out += struct.pack('<i', off); off += len(c)
    for d in data:
        out += struct.pack('<i', len(d))
    for t, i, ints in items:
        out += struct.pack('<Ii', (t << 16) | i, len(ints) * 4)
        out += struct.pack('<%di' % len(ints), *ints)
    for c in comp:
        out += c
    open(path, 'wb').write(out)
