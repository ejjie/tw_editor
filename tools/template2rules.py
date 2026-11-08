"""template2rules: learn a DDNet .rules file from a designed template map.

The template's Game layer holds hook and freeze shapes. Every other tile layer (the "Design" group) is
painted by hand with any mapres. For each painted layer this script looks at every cell: what game tiles
are around it (3x3) and which tile (index + flip/rotate) was painted there, and writes rules that put
the same tile in the same situation. One config per layer, one .rules file per image.

    python template2rules.py my_template.map                 # -> rules/<image>.rules next to the map
    python template2rules.py my_template.map --symmetry      # also fill unpainted cases by rotating/flipping
    python template2rules.py my_template.map --skip-unpainted --symmetry
                                                             # only some shapes painted: ignore the others
    python template2rules.py my_template.map --radius 2      # look 2 tiles away (big rounded corners)
    python template2rules.py my_template.map --merge "C:/.../DDNet/data/editor/automap"
                                                             # keep the existing configs of those files

Use the result like any rules file: put it in DDNet's editor/automap folder (or tw-editor's
extra-data/editor/automap), then on a tile layer filled with a copy of the Game layer, or with
Reference = Game layer, pick the config and run the automapper.
"""
import argparse
import os
import re
import sys
from collections import Counter, defaultdict

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import twmap  # noqa: E402

XFLIP, YFLIP, ROTATE = 1, 2, 8
FLAG_MASK = XFLIP | YFLIP | ROTATE

# neighbour offsets (x right, y down): NW N NE W E SW S SE
O8 = [(-1, -1), (0, -1), (1, -1), (-1, 0), (1, 0), (-1, 1), (0, 1), (1, 1)]
ORTH = [1, 3, 4, 6]                                # N W E S
CORNERS = [(0, 1, 3), (2, 1, 4), (5, 6, 3), (7, 6, 4)]  # corner, its two orthogonal neighbours
O24 = O8 + [(dx, dy) for dy in range(-2, 3) for dx in range(-2, 3) if max(abs(dx), abs(dy)) == 2]
LEVEL_NAMES = ['any', 'sides solid/open', 'sides', 'sides + inner corners', 'sides + all corners solid/open', 'exact 3x3',
               'exact 5x5']
EXACT = 5  # last level; 6 with --radius 2
MIN_SUPPORT = 2  # cells a detailed (corners / exact) case needs before it gets its own rule
SPRINKLE_MIN = 5  # uses of a scattered tile in one situation before it becomes a random rule
SPRINKLE_SHARE = 0.01  # rarer than this is taken for a mistake, not a decoration
SPRINKLE_LEVEL = 3  # coarsest situation for scattered tiles: sides + inner corners


class Classes:
    """game tile ids -> 'H' hook, 'U' unhook, 'F' freeze, 'E' everything else (air).
    Outside the map counts as hook."""
    NAMES = {'H': 'hook', 'U': 'unhook', 'F': 'freeze', 'E': 'air'}

    def __init__(self, hook, freeze, unhook=()):
        self.ids = {'H': sorted(set(hook) | {-1}), 'U': sorted(set(unhook)), 'F': sorted(set(freeze))}
        self.ids = {k: v for k, v in self.ids.items() if v}
        self.of = {i: k for k, v in self.ids.items() for i in v}
        self.order = list(self.ids) + ['E']

    def cls(self, i):
        return self.of.get(i, 'E')

    def cond(self, c, negate=False):
        """Pos condition text for 'cell is of class c' (or not of class c)."""
        if c == 'E':
            ids, kw = sorted(self.of), 'NOTINDEX'
        else:
            ids, kw = self.ids[c], 'INDEX'
        if negate:
            kw = 'INDEX' if kw == 'NOTINDEX' else 'NOTINDEX'
        return kw + ' ' + ' OR '.join(str(i) for i in ids)


# ------------------------------------------------------------ symmetry (flip / rotate)

def _mat(flags):
    """texture-space map of a tile flag, as the DDNet renderer applies it: rotate first, then flips."""
    m = [[1, 0], [0, 1]]
    if flags & ROTATE:
        m = [[0, 1], [-1, 0]]
    if flags & XFLIP:
        m = [[-m[0][0], -m[0][1]], m[1]]
    if flags & YFLIP:
        m = [m[0], [-m[1][0], -m[1][1]]]
    return tuple(map(tuple, m))


def _mul(a, b):
    return tuple(tuple(sum(a[i][k] * b[k][j] for k in range(2)) for j in range(2)) for i in range(2))


ALL_FLAGS = [0, XFLIP, YFLIP, XFLIP | YFLIP, ROTATE, ROTATE | XFLIP, ROTATE | YFLIP, ROTATE | XFLIP | YFLIP]
FLAG_OF_MAT = {_mat(f): f for f in ALL_FLAGS}
TRANSFORMS = [_mat(f) for f in ALL_FLAGS[1:]]  # the 7 non-identity symmetries of the square


def _inv(g):
    # orthogonal matrix: inverse = transpose
    return ((g[0][0], g[1][0]), (g[0][1], g[1][1]))


def transform_sample(n8, tile, g):
    offs = O8 if len(n8) == 8 else O24
    idx = {o: i for i, o in enumerate(offs)}
    out = [None] * len(offs)
    for i, (dx, dy) in enumerate(offs):
        nx, ny = g[0][0] * dx + g[0][1] * dy, g[1][0] * dx + g[1][1] * dy
        out[idx[(nx, ny)]] = n8[i]
    tid, f = tile
    if tid == 0:
        return tuple(out), tile
    return tuple(out), (tid, FLAG_OF_MAT[_mul(_mat(f), _inv(g))])


# ------------------------------------------------------------ learning

def key_at(level, c, n):
    if level == 0:
        return ()
    if level == 1:
        return tuple(n[i] == c for i in ORTH)
    if level == 2:
        return tuple(n[i] for i in ORTH)
    if level in (3, 4):
        # corners between two same-as-centre sides (inner corners) by kind; level 4 adds the others as same/not
        return tuple(n[i] for i in ORTH) + tuple(
            n[k] if n[a] == c and n[b] == c else ('*' if level == 3 else n[k] == c) for k, a, b in CORNERS)
    if level == 5:
        return n[:8]
    return n


def pos_conditions(level, c, key, C):
    out = []
    if level == 1:
        for same, i in zip(key, ORTH):
            out.append((O8[i], C.cond(c, negate=not same)))
    elif level in (2, 3, 4):
        for s, i in zip(key[:4], ORTH):
            out.append((O8[i], C.cond(s)))
        for s, (k, _, _) in zip(key[4:], CORNERS):
            if s is True or s is False:
                out.append((O8[k], C.cond(c, negate=not s)))
            elif s != '*':
                out.append((O8[k], C.cond(s)))
    else:
        for s, o in zip(key, O24):
            out.append((o, C.cond(s)))
    return out


def variants(counter, min_share):
    """tiles to put in one situation: the most used one, plus random variants. A tile index used with several
    flips/rotations counts as one (random orientation), and then every orientation it had is kept."""
    total = sum(counter.values())
    items = sorted(counter.items(), key=lambda kv: (-kv[1], kv[0]))
    per_id = Counter()
    for (i, _), k in items:
        per_id[i] += k
    first = items[0][0][0]
    ids = {i for i, k in per_id.items() if i == first or (k >= 2 and k / total >= min_share)}
    return [kv for kv in items if kv[0][0] in ids]


def used_cells(game, layer, W, H):
    """Which cells are examples for this layer. A shape (8-connected game tiles) counts only if something
    is painted on it or right next to it, so shapes left unpainted on purpose teach nothing. Air away
    from every shape always counts (it says "nothing here" unless painted)."""
    comp = [-1] * (W * H)
    painted = []
    for start in range(W * H):
        if comp[start] >= 0 or game.get(start % W, start // W)[0] == 0:
            continue
        k = len(painted)
        painted.append(False)
        stack = [start]
        comp[start] = k
        while stack:
            p = stack.pop()
            x, y = p % W, p // W
            for dy in (-1, 0, 1):
                for dx in (-1, 0, 1):
                    X, Y = x + dx, y + dy
                    if 0 <= X < W and 0 <= Y < H:
                        q = Y * W + X
                        if layer.get(X, Y)[0]:
                            painted[k] = True
                        if comp[q] < 0 and game.get(X, Y)[0]:
                            comp[q] = k
                            stack.append(q)
    used = [True] * (W * H)
    for p in range(W * H):
        if comp[p] >= 0:
            used[p] = painted[comp[p]]
            continue
        x, y = p % W, p // W
        near = {comp[Y * W + X] for dy in (-1, 0, 1) for dx in (-1, 0, 1)
                for X, Y in [(x + dx, y + dy)] if 0 <= X < W and 0 <= Y < H and comp[Y * W + X] >= 0}
        if near:
            used[p] = any(painted[k] for k in near) or layer.get(x, y)[0] != 0
    return used


def learn(game, layer, C, symmetry, min_share, offsets=O8, skip_unpainted=False, blank=(), area=None):
    W, H = min(game.width, layer.width), min(game.height, layer.height)

    def gcls(x, y):
        if x < 0 or y < 0 or x >= game.width or y >= game.height:
            return 'H'
        return C.cls(game.get(x, y)[0])

    used = used_cells(game, layer, W, H) if skip_unpainted else [True] * (W * H)
    real = defaultdict(Counter)   # (c, n8) -> Counter(tile)
    where = defaultdict(list)
    for y in range(H):
        for x in range(W):
            if not used[y * W + x]:
                continue
            if area and not (area[0] <= x < area[2] and area[1] <= y < area[3]):
                continue
            c = gcls(x, y)
            n = tuple(gcls(x + dx, y + dy) for dx, dy in offsets)
            i, f = layer.get(x, y)
            t = (i, f & FLAG_MASK) if i and i not in blank else (0, 0)
            real[(c, n)][t] += 1
            if len(where[(c, n)]) < 3:
                where[(c, n)].append((x, y))
    synth = defaultdict(Counter)
    if symmetry:
        for (c, n), cnt in real.items():
            for g in TRANSFORMS:
                for t, k in cnt.items():
                    n2, t2 = transform_sample(n, t, g)
                    if (c, n2) not in real:
                        synth[(c, n2)][t2] += k
    return real, synth, where


def build_rules(real, synth, C, min_share, last=EXACT):
    """rules from general to specific; a rule is written only where it changes the result."""
    rules = []  # (level, c, key, [(tile, count)], synthetic)
    sprinkles = []
    mixed = []
    for c in C.order:
        samples = {n: cnt for (cc, n), cnt in real.items() if cc == c}
        fake = {n: cnt for (cc, n), cnt in synth.items() if cc == c}
        if not samples:
            continue
        effective = {}  # (level, key) -> tile the rules give so far
        explained = {}  # exact key -> tiles the rules put there
        for level in range(last + 1):
            tab_real, tab_fake = defaultdict(Counter), defaultdict(Counter)
            parent_key = {}
            for src, tab in ((samples, tab_real), (fake, tab_fake)):
                for n, cnt in src.items():
                    k = key_at(level, c, n)
                    tab[k].update(cnt)
                    if level and k not in parent_key:
                        parent_key[k] = key_at(level - 1, c, n)
            for key in sorted(set(tab_real) | set(tab_fake), key=repr):
                cnt = tab_real[key] if key in tab_real else tab_fake[key]
                parent = effective[(level - 1, parent_key[key])] if level else (0, 0)
                synthetic = key not in tab_real
                if synthetic:  # one tile, no random: on a tie the one with the fewest flips/rotations
                    top = [min(cnt.items(), key=lambda kv: (-kv[1], bin(kv[0][1]).count('1'), kv[0]))]
                else:
                    top = variants(cnt, min_share)
                is_random = level == last and len(top) > 1
                best = top[0][0]
                if level >= 4 and not synthetic and sum(cnt.values()) < MIN_SUPPORT:
                    # seen too few times to trust over the more general rule (likely a one-off)
                    effective[(level, key)] = parent
                    if level == last:
                        explained[key] = {parent}
                    continue
                if is_random or best != parent:
                    rules.append((level, c, key, top if is_random else [top[0]], synthetic))
                    if is_random:
                        mixed.append((c, key))
                effective[(level, key)] = best if (is_random or best != parent) else parent
                if level == last:
                    explained[key] = {t for t, _ in top} if is_random else {effective[(level, key)]}
        # sprinkles: a tile scattered here and there (never the majority) comes back as a random rule with the
        # same density. Looked for from the exact 3x3 down to "sides + inner corners", so it stays near the
        # same things it was next to.
        left = Counter()  # (exact key, tile) -> uses the rules do not explain
        for n, cnt in samples.items():
            ke = key_at(last, c, n)
            for t, k in cnt.items():
                if t[0] and t not in explained.get(ke, ()):
                    left[(n, t)] += k
        for level in range(last, SPRINKLE_LEVEL - 1, -1):
            tab, tot = defaultdict(Counter), Counter()
            for n, cnt in samples.items():
                tot[key_at(level, c, n)] += sum(cnt.values())
            for (n, t), k in left.items():
                tab[key_at(level, c, n)][t] += k
            for key in sorted(tab, key=repr):
                per_id = Counter()
                for (i, _), k in tab[key].items():
                    per_id[i] += k
                for t, k in sorted(tab[key].items()):
                    if per_id[t[0]] >= SPRINKLE_MIN and per_id[t[0]] / tot[key] >= SPRINKLE_SHARE:
                        sprinkles.append((level, c, key, [(t, k)], False, k / tot[key]))
                        for n2, t2 in [nt for nt in left if nt[1] == t and key_at(level, c, nt[0]) == key]:
                            del left[(n2, t2)]
    return rules + sprinkles, mixed


def tile_words(t):
    i, f = t
    w = ['Index', str(i)]
    if f & XFLIP:
        w.append('XFLIP')
    if f & YFLIP:
        w.append('YFLIP')
    if f & ROTATE:
        w.append('ROTATE')
    return ' '.join(w)


def write_config(name, rules, C):
    lines = ['[%s]' % name, '# made by template2rules.py from a designed template', '',
             '# run 1: keep only the game tiles the rules look at (also works with Reference = Game layer)',
             'Index 0', 'Pos 0 0 FULL', '']
    for i in sorted(v for v in C.of if v >= 0):
        lines += ['Index %d' % i, 'Pos 0 0 INDEX %d' % i, '']
    # with Reference the first run erases anything put on air, so the real rules go in a second run
    lines += ['NewRun', '', '# run 2: clear, then put the tiles back', 'Index 0', 'Pos 0 0 FULL', '']
    cname = Classes.NAMES
    last = None
    for r in rules:
        level, c, key, tiles, synthetic = r[:5]
        share = r[5] if len(r) > 5 else None
        head = (c, level, share is not None)
        if head != last:
            lines.append('# --- %s cells: %s%s' % (cname[c], LEVEL_NAMES[level], ', scattered tiles' if share is not None else ''))
            last = head
        conds = pos_conditions(level, c, key, C)
        total = sum(k for _, k in tiles)
        acc = 0
        for j, (t, k) in enumerate(tiles):
            acc += k
            lines.append(tile_words(t))
            if c == 'E':
                lines.append('NoDefaultRule')
            lines.append('Pos 0 0 ' + C.cond(c))
            for (dx, dy), cond in conds:
                lines.append('Pos %d %d %s' % (dx, dy, cond))
            if j:  # variant j replaces the earlier ones with its share of what is left
                lines.append('Random %g%%' % round(100.0 * k / acc, 3))
            elif share is not None:
                lines.append('Random %g%%' % round(100.0 * share, 3))
            if synthetic and j == 0:
                lines.append('# (rotated/flipped from a painted case)')
        lines.append('')
    return '\n'.join(lines)


def blank_tiles(img):
    """ids of fully transparent tiles of an embedded image: painting them is the same as leaving the cell empty."""
    if img.external or not img.rgba or img.width % 16 or img.height % 16:
        return set()
    tw, th = img.width // 16, img.height // 16
    out = set()
    for i in range(1, 256):
        tx, ty = (i % 16) * tw, (i // 16) * th
        if all(img.rgba[((ty + y) * img.width + tx) * 4 + 3:((ty + y) * img.width + tx + tw) * 4:4].count(0) == tw
               for y in range(th)):
            out.add(i)
    return out


def split_configs(text):
    """existing .rules text -> [(name, block text)], header before the first config kept as name None."""
    out, name, buf = [], None, []
    for line in text.splitlines():
        if line.startswith('['):
            out.append((name, '\n'.join(buf)))
            name, buf = line.strip()[1:].rstrip(']'), [line]
        else:
            buf.append(line)
    out.append((name, '\n'.join(buf)))
    return out


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('map', help='designed template .map')
    ap.add_argument('--out', help='output folder (default: rules/ next to the map)')
    ap.add_argument('--name', help='config name prefix (default: map file name)')
    ap.add_argument('--layers', nargs='*', help='only these layer names')
    ap.add_argument('--symmetry', action='store_true', help='fill unpainted cases with rotated/flipped painted ones')
    ap.add_argument('--skip-unpainted', action='store_true',
                    help='shapes with nothing painted on or next to them teach nothing (for a half-painted template)')
    ap.add_argument('--radius', type=int, choices=(1, 2), default=1,
                    help='2 also looks two tiles away (for big rounded corners); more rules')
    ap.add_argument('--hook', default='1', help='game ids counted as hook (default 1)')
    ap.add_argument('--unhook', default='3', help='game ids counted as unhook (default 3; "" = count as air)')
    ap.add_argument('--freeze', default='9,12', help='game ids counted as freeze (default 9,12)')
    ap.add_argument('--min-share', type=float, default=0.15,
                    help='another tile in the same case becomes a random variant only if used 2+ times and above this share')
    ap.add_argument('--min-support', type=int,
                    help='cells a detailed case needs before it gets its own rule (default: 1 on a template, 2 on a big map)')
    ap.add_argument('--area', help='learn only from x0,y0,x1,y1 (tiles)')
    ap.add_argument('--merge', help='folder with existing .rules files: their other configs are kept in the output')
    a = ap.parse_args()
    global MIN_SUPPORT

    ids = lambda s: [int(v) for v in s.split(',') if v]
    C = Classes(ids(a.hook), ids(a.freeze), ids(a.unhook))
    m = twmap.load(a.map)
    game = m.game_layer()
    if not game:
        sys.exit('no Game layer in ' + a.map)
    prefix = a.name if a.name is not None else os.path.splitext(os.path.basename(a.map))[0]
    out_dir = a.out or os.path.join(os.path.dirname(os.path.abspath(a.map)), 'rules')
    files = defaultdict(list)
    big_map = sum(1 for i in range(0, len(game.tiles), 4) if game.tiles[i]) > 20000  # a real map, not a template
    n = 0
    for g in m.groups:
        for l in g.layers:
            if not isinstance(l, twmap.TileLayer) or l.kind != 'tiles':
                continue
            n += 1
            lname = l.name or 'Layer %d' % n
            if a.layers and lname not in a.layers:
                continue
            if not any(l.tiles[i] for i in range(0, len(l.tiles), 4)):
                print('skip "%s": nothing painted' % lname)
                continue
            if l.image < 0 or l.image >= len(m.images):
                print('skip "%s": the layer has no image' % lname)
                continue
            MIN_SUPPORT = a.min_support or (2 if big_map else 1)
            offsets = O8 if a.radius == 1 else O24
            area = [int(v) for v in a.area.split(',')] if a.area else None
            real, synth, where = learn(game, l, C, a.symmetry, a.min_share, offsets, a.skip_unpainted,
                                       blank_tiles(m.images[l.image]), area)
            rules, mixed = build_rules(real, synth, C, a.min_share, 5 if a.radius == 1 else 6)
            name = (prefix + ' ' + lname).strip()
            img = m.images[l.image].name
            files[img].append((name, write_config(name, rules, C)))
            per = Counter(r[0] for r in rules)
            print('"%s" (%s): %d rules  [%s]' % (lname, img, len(rules),
                                                ', '.join('%s %d' % (LEVEL_NAMES[k], per[k]) for k in sorted(per))))
            if a.symmetry:
                print('  %d rules from rotated/flipped cases' % sum(1 for r in rules if r[4]))
            if mixed:
                print('  %d cases got random variants (different tiles in the same situation), e.g. at:' % len(mixed))
                for c, key in mixed[:8]:
                    print('    %s' % ' '.join('(%d,%d)' % p for p in where[(c, key)]))
    if not files:
        sys.exit('nothing to write: paint the Design layers first')
    os.makedirs(out_dir, exist_ok=True)
    for img, configs in files.items():
        names = {nm for nm, _ in configs}
        parts = []
        if a.merge:
            p = os.path.join(a.merge, img + '.rules')
            if os.path.exists(p):
                for nm, block in split_configs(open(p, encoding='utf-8', errors='replace').read()):
                    if nm not in names and block.strip():
                        parts.append(block.rstrip() + '\n')
        parts += [txt for _, txt in configs]
        path = os.path.join(out_dir, img + '.rules')
        with open(path, 'w', encoding='utf-8', newline='\n') as f:
            f.write('\n'.join(parts))
        print('wrote', path)


if __name__ == '__main__':
    main()
