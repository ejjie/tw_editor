"""Rules maker, server side (optional module, see README "Modules"; the page part is web/js/rulesmaker.js).

Configs made in the editor's Rules maker are kept in user-rules/<tileset>.rules. The editor serves them added to
the DDNet (or extra-data) .rules file of the same name, so they show up in every layer's automapper, and on request
writes the same merged file into DDNet's own editor/automap folder. Delete this file and the editor runs without it.
"""
import re

NAME = re.compile(r"^[\w .()+-]{1,80}$")


def split_rules(text):
    """.rules text -> [(config name or None for the header, block text)]"""
    out, name, buf = [], None, []
    for line in text.splitlines():
        if line.startswith("["):
            out.append((name, "\n".join(buf)))
            name, buf = line.strip()[1:].rstrip("]"), [line]
        else:
            buf.append(line)
    out.append((name, "\n".join(buf)))
    return [(n, b) for n, b in out if b.strip()]


def merge_rules(base, configs):
    """base .rules text with `configs` [(name, text)] added: a config with the same name is replaced"""
    names = {n for n, _ in configs}
    parts = [b.rstrip() for n, b in split_rules(base or "") if n not in names]
    parts += [t.rstrip() for _, t in configs]
    return "\n\n".join(parts) + "\n"


def folder(E):
    return E.ROOT / "user-rules"


def user_rules(E, image):
    p = folder(E) / (image + ".rules")
    return [(n, b) for n, b in split_rules(p.read_text(encoding="utf-8", errors="replace")) if n] if p.is_file() else []


def user_names(E):
    return {p.stem for p in folder(E).glob("*.rules")}


def rules_file(E, image):
    """the .rules text the editor uses for a tileset: DDNet's file plus the Rules maker configs; None = no own configs"""
    if not NAME.match(image) or image.startswith("."):
        return None
    mine = user_rules(E, image)
    if not mine:
        return None
    f = E.data_file("editor/automap/" + image + ".rules")
    return merge_rules(f.read_text(encoding="utf-8", errors="replace") if f else "", mine)


def tilesets(E):
    """tilesets to paint with: DDNet mapres, the ones with .rules, and the editor's own (embedded into the map)"""
    d = E.find_ddnet_data()
    mapres = sorted(p.stem for p in (d / "mapres").glob("*.png")) if d else list(E.STANDARD_MAPRES)
    auto = d / "editor" / "automap" if d else None
    rules = sorted(p.stem for p in auto.glob("*.rules")) if auto and auto.is_dir() else list(E.STANDARD_RULES)
    extra = sorted(p.stem for p in (E.EXTRA / "mapres").glob("*.png"))
    return {"ddnet": [n for n in mapres if n not in extra], "rules": [n for n in rules if n in mapres], "extra": extra}


def post(E, path, req):
    """/api/rules/user {image, configs: [{name, text}]}: keep the configs in user-rules/
    /api/rules/ddnet {image}: add them to DDNet's own editor/automap/<image>.rules (user folder)"""
    image = str(req.get("image", ""))
    if not NAME.match(image) or image.startswith("."):
        return {"error": "bad tileset name"}, 400
    if path == "/api/rules/user":
        configs = [(str(c.get("name", "")).strip(), str(c.get("text", ""))) for c in req.get("configs", [])]
        if not configs or any(not n or "]" in n or not t.lstrip().startswith("[") for n, t in configs):
            return {"error": "bad configs"}, 400
        folder(E).mkdir(parents=True, exist_ok=True)
        dst = folder(E) / (image + ".rules")
        old = "\n\n".join(b for _, b in user_rules(E, image))
        dst.write_text(merge_rules(old, configs), encoding="utf-8", newline="\n")
        return {"path": str(dst), "configs": [n for n, _ in user_rules(E, image)]}, 200
    mine = user_rules(E, image)
    if not mine:
        return {"error": "nothing made for " + image + " yet"}, 400
    dst = E.ddnet_user_dir() / "editor" / "automap" / (image + ".rules")
    # DDNet reads this file instead of its own, so it starts from the one already there or the one DDNet ships
    src = dst if dst.is_file() else E.data_file("editor/automap/" + image + ".rules")
    base = src.read_text(encoding="utf-8", errors="replace") if src else ""
    dst.parent.mkdir(parents=True, exist_ok=True)
    dst.write_text(merge_rules(base, mine), encoding="utf-8", newline="\n")
    return {"path": str(dst)}, 200
