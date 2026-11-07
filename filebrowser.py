"""File browser for the editor's own Open / Save window (web/js/filedialog.js).

Why the editor has its own window: Chrome's file dialog does not let a web page into AppData (it says the folder
"contains system files"), and DDNet keeps its maps in %APPDATA%\\DDNet\\maps. The page also never learns where a file
from the browser's dialog lives. So this server lists folders and reads / writes .map files for the page: any folder
on the computer, with DDNet's maps folder as a shortcut, and Ctrl+S writes back to the same file.

Only .map files are read or written. Requests must come from the editor page itself (header X-TW-Editor, see check()).
Optional module: delete this file and the editor's File menu uses the browser's own dialogs again.
"""
import os
import string
import sys
from pathlib import Path

MAX_DEEP = 3000  # files returned by a search through subfolders


def known_folder(guid):
    """A Windows known folder (Desktop / Documents / Downloads, also when OneDrive moved it), or None."""
    try:
        import ctypes
        import uuid
        from ctypes import wintypes

        class GUID(ctypes.Structure):
            _fields_ = [("d1", wintypes.DWORD), ("d2", wintypes.WORD), ("d3", wintypes.WORD), ("d4", ctypes.c_ubyte * 8)]

        u = uuid.UUID(guid)
        g = GUID(u.time_low, u.time_mid, u.time_hi_version, (ctypes.c_ubyte * 8)(*u.bytes[8:]))
        out = ctypes.c_wchar_p()
        if ctypes.windll.shell32.SHGetKnownFolderPath(ctypes.byref(g), 0, None, ctypes.byref(out)) != 0:
            return None
        p = Path(out.value)
        ctypes.windll.ole32.CoTaskMemFree(out)
        return p if p.is_dir() else None
    except Exception:
        return None


def drives():
    if sys.platform != "win32":
        return [Path("/")]
    if hasattr(os, "listdrives"):
        try:
            return [Path(d) for d in os.listdrives()]
        except OSError:
            pass
    return [Path(f"{c}:\\") for c in string.ascii_uppercase if os.path.exists(f"{c}:\\")]


def places(editor):
    """Shortcuts on the left of the window."""
    home = Path.home()
    out = [{"name": "DDNet maps", "path": str(editor.maps_dir()), "icon": "ddnet"}]
    data = editor.find_ddnet_data()
    if data and (data / "maps").is_dir():
        out.append({"name": "DDNet game maps", "path": str(data / "maps"), "icon": "ddnet"})
    for name, guid in (("Desktop", "B4BFCC3A-DB2C-424C-B029-7FE99A87C641"),
                       ("Documents", "FDD39AD0-238F-46AF-ADB4-6C85480369C7"),
                       ("Downloads", "374DE290-123F-4565-9164-39C4925E467B")):
        p = (known_folder(guid) if sys.platform == "win32" else None) or home / name
        if p.is_dir():
            out.append({"name": name, "path": str(p), "icon": "folder"})
    out.append({"name": "Home", "path": str(home), "icon": "folder"})
    return {"places": out, "drives": [str(d) for d in drives()], "sep": os.sep}


def entry(p, st):
    return {"name": p.name, "path": str(p), "size": st.st_size, "time": st.st_mtime}


def listing(editor, d, deep=False):
    """Folders and .map files in d (deep: .map files in all subfolders too, newest first)."""
    if not d:
        return {"dir": "", "parent": None, "dirs": [{"name": str(x), "path": str(x)} for x in drives()], "files": []}
    root = Path(d).expanduser()
    if not root.is_absolute():
        raise ValueError("not a full path: " + d)
    root = root.resolve()
    if not root.is_dir():
        raise FileNotFoundError("no such folder: " + str(root))
    parent = root.parent if root.parent != root else ("" if sys.platform == "win32" else None)
    dirs, files = [], []
    if deep:
        is_maps = root == editor.maps_dir().resolve()
        for dirpath, sub, names in os.walk(root):  # folders that cannot be read are skipped
            # the DDNet editor autosaves into maps/auto/; those copies are left out of searches
            sub[:] = [s for s in sub if not s.startswith(".") and not (is_maps and Path(dirpath) == root and s.lower() == "auto")]
            for n in names:
                if n.lower().endswith(".map") and "autosave" not in n.lower():
                    p = Path(dirpath) / n
                    try:
                        files.append(entry(p, p.stat()))
                    except OSError:
                        pass
            if len(files) >= MAX_DEEP:
                break
        files.sort(key=lambda f: -f["time"])
    else:
        with os.scandir(root) as it:
            for e in it:
                try:
                    if e.is_dir():
                        if not e.name.startswith(("$", ".")):
                            dirs.append({"name": e.name, "path": e.path})
                    elif e.name.lower().endswith(".map"):
                        files.append(entry(Path(e.path), e.stat()))
                except OSError:
                    pass
        dirs.sort(key=lambda x: x["name"].lower())
        files.sort(key=lambda f: f["name"].lower())
    return {"dir": str(root), "parent": None if parent is None else str(parent), "dirs": dirs, "files": files}


def map_file(path):
    """A full path to a .map file, or ValueError."""
    p = Path(path or "").expanduser()
    if not p.is_absolute():
        raise ValueError("not a full path: " + str(path))
    if p.suffix.lower() != ".map":
        raise ValueError("only .map files can be opened or saved here")
    return p.resolve()


def read(path):
    p = map_file(path)
    if not p.is_file():
        raise FileNotFoundError("no such map: " + str(p))
    return p


def write(path, raw):
    p = map_file(path)
    p.parent.mkdir(parents=True, exist_ok=True)
    tmp = p.with_name(p.name + ".tmp")
    tmp.write_bytes(raw)
    os.replace(tmp, p)  # a crash while writing never leaves half a map
    return {"saved": str(p), "size": len(raw)}


def check(handler):
    """Only the editor page may use the file browser: a header other sites cannot send without asking first
    (CORS preflight, which this server never allows), and a Host that is this computer (no DNS rebinding)."""
    host = (handler.headers.get("Host") or "").rsplit(":", 1)[0].strip("[]").lower()
    return handler.headers.get("X-TW-Editor") == "1" and host in ("localhost", "127.0.0.1", "::1")
