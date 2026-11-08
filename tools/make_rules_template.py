"""Builds rules_template.map: a Game layer with hook and freeze shapes covering the neighbourhoods
a .rules file needs, plus an empty "Design" group to paint. Run once; the map is the deliverable.

    python make_rules_template.py [out.map]
"""
import os
import sys

import twmap

HERE = os.path.dirname(os.path.abspath(__file__))
AIR, HOOK, FREEZE = 0, 1, 9
CH = {'.': AIR, '#': HOOK, 'f': FREEZE}

# 12x12 patch whose filled cells show all 47 "blob" neighbourhoods (found by search)
MAZE = """
...#...#...#
..###.######
...#..####.#
....###.###.
.##.########
.#####.####.
..###.####.#
...#...##.##
...#..######
.#.##..#.#.#
..#.####.###
.####.##.###
"""

HOOK_SHAPES = ["""
########
########
########
########
########
""", """
#########
#.#######
#########
###..####
###..##.#
#########
#########
""", """
##.###.##
#########
.#######.
#########
###.#.###
""", """
######...#
.........#
..#......#
.........#
..###....#
..#.#..###
..###.....
""", """
.#...###.
###...#..
.#....#..
......##.
#.....#..
##.......
""", """
#.....##....
##.....##...
###.....##..
####.....##.
#####.....##
######......
""", """
.....#....##
....##...##.
...###..##..
..####.##...
.#######....
######......
""", """
######......
.#####......
..####...##.
...###..##..
....##.##...
.....###....
""", """
######.##...
#####...##..
####.....##.
###.......##
##..........
#...........
"""]

ROOM = """
##############################
##############################
##ffffff#########fffff########
##..........ffff.........##fff
##.......................##...
##f......................#f...
##f.....................ff....
##f.......##...........f......
###.......##.........fff......
###fff....##.....#############
######ffff##fffff#############
##############################
"""


def grid(s):
    rows = [r for r in s.strip('\n').split('\n')]
    w = max(len(r) for r in rows)
    return [[CH[c] for c in r.ljust(w, '.')] for r in rows]


def recolor(g, a, b):
    return [[b if c == a else c for c in r] for r in g]


def ring(g, solid, fill):
    """g padded by 1 with every air cell next to `solid` (8 neighbours) turned into `fill`."""
    h, w = len(g), len(g[0])
    out = [[AIR] * (w + 2) for _ in range(h + 2)]
    for y in range(h):
        for x in range(w):
            out[y + 1][x + 1] = g[y][x]
    for y in range(h + 2):
        for x in range(w + 2):
            if out[y][x] == AIR and any(0 <= y + dy - 1 < h and 0 <= x + dx - 1 < w and g[y + dy - 1][x + dx - 1] == solid
                                        for dy in (-1, 0, 1) for dx in (-1, 0, 1)):
                out[y][x] = fill
    return out


def framed(g, bg):
    """maze cells on a background of `bg`, 2 cells of background around it."""
    h, w = len(g), len(g[0])
    return [[bg if not (2 <= x < w + 2 and 2 <= y < h + 2) or g[y - 2][x - 2] == AIR else g[y - 2][x - 2]
             for x in range(w + 4)] for y in range(h + 4)]


def row_of(shapes, gap=3):
    h = max(len(s) for s in shapes)
    w = sum(len(s[0]) for s in shapes) + gap * (len(shapes) - 1)
    out = [[AIR] * w for _ in range(h)]
    x0 = 0
    for s in shapes:
        for y, r in enumerate(s):
            for x, c in enumerate(r):
                out[y][x0 + x] = c
        x0 += len(s[0]) + gap
    return out


def build():
    hooks = [grid(s) for s in HOOK_SHAPES]
    maze = grid(MAZE)
    rows = [  # each row: sections side by side
        [('Hook: shapes', row_of(hooks))],
        [('Freeze: same shapes', row_of([recolor(s, HOOK, FREEZE) for s in hooks]))],
        [('Hook with freeze ring (gores)', row_of([ring(s, HOOK, FREEZE) for s in hooks[2:6]])),
         ('Hook with freeze ring: slopes', row_of([ring(s, HOOK, FREEZE) for s in hooks[6:]]))],
        [('Freeze on hook walls / floor / ceiling', row_of([grid(ROOM)])),
         ('47 cases: hook in air', maze), ('47 cases: freeze in air', recolor(maze, HOOK, FREEZE)),
         ('47 cases: freeze in hook', framed(recolor(maze, HOOK, FREEZE), HOOK)),
         ('47 cases: hook in freeze', framed(maze, FREEZE))],
    ]
    M, GAP, SIDE = 4, 4, 6
    W = max(sum(len(s[0]) for _, s in r) + SIDE * (len(r) - 1) for r in rows) + 2 * M
    H = sum(max(len(s) for _, s in r) for r in rows) + GAP * (len(rows) - 1) + 2 * M
    cells = [[AIR] * W for _ in range(H)]
    boxes = []
    y0 = M
    for r in rows:
        x0 = M
        for name, s in r:
            for y, line in enumerate(s):
                for x, c in enumerate(line):
                    cells[y0 + y][x0 + x] = c
            boxes.append((name, x0, y0, len(s[0]), len(s)))
            x0 += len(s[0]) + SIDE
        y0 += max(len(s) for _, s in r) + GAP
    return cells, W, H, boxes


def main():
    out = sys.argv[1] if len(sys.argv) > 1 else os.path.join(HERE, '..', 'templates', 'rules_template.map')
    cells, W, H, boxes = build()
    m = twmap.Map()
    game = twmap.TileLayer('Game', W, H, 'game')
    for y in range(H):
        for x in range(W):
            game.set(x, y, cells[y][x])
    af = os.path.join(HERE, '..', 'extra-data', 'mapres', 'amazing_freeze.png')
    try:
        from PIL import Image
        im = Image.open(af).convert('RGBA')
        m.images.append(twmap.Image('amazing_freeze', im.width, im.height, False, im.tobytes()))
    except Exception as e:  # no pillow / no file: keep it external
        print('amazing_freeze not embedded:', e)
        m.images.append(twmap.Image('amazing_freeze', 1024, 1024, True))
    m.images.append(twmap.Image('grass_main', 1024, 1024, True))
    m.groups.append(twmap.Group('Game', [game]))
    m.groups.append(twmap.Group('Design', [twmap.TileLayer('Freeze', W, H, image=0),
                                           twmap.TileLayer('Hook', W, H, image=1)]))
    os.makedirs(os.path.dirname(os.path.abspath(out)), exist_ok=True)
    twmap.save(m, out)
    print('wrote', out, '%dx%d' % (W, H))
    for b in boxes:
        print('  %-40s x=%d y=%d %dx%d' % b)
    return cells, boxes


if __name__ == '__main__':
    main()
