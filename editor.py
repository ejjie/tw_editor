#!/usr/bin/env python3
"""TW Editor: local DDNet map editor in the browser.

Run:  python editor.py            (opens http://localhost:8765)
      python editor.py --port 9000 --no-browser

The map itself is read and written by the page; this small server only
serves the page, the standard DDNet pictures (mapres, entities, automapper
rules) and runs the quad-art converter (img2quads.py).

Standard pictures come from the DDNet game folder if it is found (Steam or
the folder set in the editor settings); otherwise they are downloaded once
from the DDNet GitHub repository into ./cache.

"Test map" starts DDNet-Server with the map and hot reloads it on save (testserver.py); the server is
downloaded once into ./ddnet-server.

Optional modules (see README.md, "Modules"): each can be deleted, the editor keeps running without it and the page
gets a clear error from its endpoint.
  testserver.py               Test map            /api/test, /api/test/stop, /api/test/status
  quadart.py + img2quads.py   Quad art            /api/quadart
  tools/tilestyle.py, styles/ learned styles      /api/styles, /api/style, /styles/...
  (in this file)              DDNet maps folder   /api/maps, /api/maps/file

When the last editor tab is closed, the editor stops by itself together with the test server
(--keep-running turns that off).
"""
import argparse
import atexit
import errno
import socket
import json
import mimetypes
import os
import sys
import threading
import time
import traceback
import urllib.error
import urllib.parse
import urllib.request
import webbrowser
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

ROOT = Path(__file__).resolve().parent
WEB = ROOT / "web"
CACHE = ROOT / "cache"
# mapres and rules that are not part of DDNet but ship with the editor (amazing_freeze)
EXTRA = ROOT / "extra-data"
STYLES = ROOT / "styles"  # learned map styles (tools/tilestyle.py), offered in Design it!
CONFIG = ROOT / "config.json"
GITHUB_RAW = "https://raw.githubusercontent.com/ddnet/ddnet/master/data/"
TEST = None  # testserver.TestServer, made in main(); stays None without testserver.py
# open editor pages: id -> last time seen. Each page says it is alive every 15 s and says goodbye when it closes.
PAGES = {}
PAGES_LOCK = threading.Lock()
PAGE_SEEN = threading.Event()

# DDNet data/mapres, used when neither the game nor the network is available for a listing
STANDARD_MAPRES = (
    "basic_freeze bg_cloud1 bg_cloud2 bg_cloud3 ddmax_freeze ddnet_grass ddnet_start ddnet_tiles ddnet_walls "
    "desert_background desert_doodads desert_main desert_mountains desert_mountains2 desert_mountains_new_background "
    "desert_mountains_new_foreground desert_sun easter_0.7 entities fadeout font_teeworlds font_teeworlds_alt "
    "generic_clear generic_deathtiles generic_lamps generic_shadows_0.7 generic_unhookable generic_unhookable_0.7 "
    "grass_doodads grass_doodads_0.7 grass_main grass_main_0.7 jungle_background jungle_deathtiles jungle_doodads "
    "jungle_main jungle_midground jungle_unhookables light mixed_tiles moon mountains round_tiles snow snow_mountain "
    "stars sun water winter_doodads winter_main winter_main_0.7 winter_mountains winter_mountains2 winter_mountains3"
).split()
STANDARD_RULES = (
    "basic_freeze ddmax_freeze ddnet_grass ddnet_tiles ddnet_walls desert_main fadeout generic_clear generic_unhookable "
    "generic_unhookable_0.7 grass_main jungle_main jungle_midground round_tiles water winter_main"
).split()


def load_config():
    try:
        return json.loads(CONFIG.read_text(encoding="utf-8"))
    except Exception:
        return {}


def save_config(cfg):
    CONFIG.write_text(json.dumps(cfg, indent=2, ensure_ascii=False), encoding="utf-8")


def steam_libraries():
    roots = []
    for base in (os.environ.get("ProgramFiles(x86)"), os.environ.get("ProgramFiles"), str(Path.home() / ".steam/steam"),
                 str(Path.home() / ".local/share/Steam"), str(Path.home() / "Library/Application Support/Steam")):
        if not base:
            continue
        steam = Path(base) / "Steam" if (Path(base) / "Steam").exists() else Path(base)
        roots.append(steam)
        vdf = steam / "steamapps" / "libraryfolders.vdf"
        if vdf.exists():
            for line in vdf.read_text(errors="ignore").splitlines():
                parts = line.strip().split('"')
                if len(parts) >= 4 and parts[1] == "path":
                    roots.append(Path(parts[3].replace("\\\\", "\\")))
    return roots


def find_ddnet_data():
    cfg = load_config()
    cands = []
    if cfg.get("ddnet_data"):
        p = Path(cfg["ddnet_data"])
        cands += [p, p / "data", p / "ddnet" / "data"]
    for lib in steam_libraries():
        cands.append(lib / "steamapps" / "common" / "DDraceNetwork" / "ddnet" / "data")
    for base in (os.environ.get("ProgramFiles"), os.environ.get("ProgramFiles(x86)"), os.environ.get("LOCALAPPDATA")):
        if base:
            cands += [Path(base) / "DDNet" / "data", Path(base) / "DDraceNetwork" / "data"]
    cands += [Path("/usr/share/ddnet/data"), Path("/usr/local/share/ddnet/data"), ROOT / "ddnet-data"]
    for c in cands:
        if (c / "mapres").is_dir():
            return c
    return None


def data_file(rel):
    """Path of a DDNet data file (game folder, then cache, then download), or None."""
    rel = rel.replace("\\", "/").lstrip("/")
    if ".." in rel.split("/"):
        return None
    d = find_ddnet_data()
    if d and (d / rel).is_file():
        return d / rel
    if (EXTRA / rel).is_file():
        return EXTRA / rel
    cached = CACHE / rel
    if cached.is_file():
        return cached
    missing = cached.with_suffix(cached.suffix + ".missing")
    if missing.exists():
        return None
    try:
        with urllib.request.urlopen(GITHUB_RAW + urllib.parse.quote(rel), timeout=15) as r:
            body = r.read()
        cached.parent.mkdir(parents=True, exist_ok=True)
        cached.write_bytes(body)
        return cached
    except urllib.error.HTTPError as e:
        # only "GitHub has no such file" is remembered; without network the next request tries again
        if e.code == 404:
            try:
                missing.parent.mkdir(parents=True, exist_ok=True)
                missing.write_text("")
            except OSError:
                pass
        return None
    except Exception:
        return None


def ddnet_user_dir():
    """DDNet's user folder ($USERDIR in storage.cfg: %APPDATA%\\DDNet on Windows)."""
    home = Path.home()
    if sys.platform == "win32":
        appdata = Path(os.environ.get("APPDATA") or home / "AppData" / "Roaming")
        cands = [appdata / "DDNet", appdata / "Teeworlds"]
    elif sys.platform == "darwin":
        cands = [home / "Library" / "Application Support" / "DDNet", home / "Library" / "Application Support" / "Teeworlds"]
    else:
        cands = [home / ".local" / "share" / "ddnet", home / ".teeworlds"]
    for c in cands:
        if c.is_dir():
            return c
    return cands[0]


def maps_dir():
    """DDNet's own maps folder (%APPDATA%\\DDNet\\maps on Windows); the browser may not open it, the editor server can."""
    d = ddnet_user_dir() / "maps"
    d.mkdir(parents=True, exist_ok=True)
    return d


def optional(name):
    """An optional module (testserver, quadart, ...), or None when its file was removed."""
    try:
        return __import__(name)
    except ImportError as e:
        if e.name == name:
            return None
        raise


FILES = optional("filebrowser")  # the editor's own Open / Save window (web/js/filedialog.js); any folder, AppData too


def missing_module(e, feature):
    """Error text for an ImportError while running an optional feature."""
    if e.name in ("quadart", "img2quads", "tilestyle"):
        return f"{feature} is not installed: {e.name}.py was removed"
    return f"Missing Python module: {e.name}. Run: pip install -r requirements.txt"


_STYLE_CACHE = {}


def style_list():
    """the style folders (style.json without the tables), for the Design it! gallery"""
    out = []
    for d in sorted(STYLES.glob("*/style.json")) if STYLES.is_dir() else []:
        try:
            meta = json.loads(d.read_text(encoding="utf-8"))
        except Exception:
            continue
        meta["id"] = d.parent.name
        meta["card"] = (d.parent / "card.png").is_file()
        out.append(meta)
    return out


def style_apply(name, raw):
    """body: int32 width, height, then width*height game indices and width*height front indices (bytes).
    Answer: per style layer width*height*2 bytes (index, flags), in the style's layer order."""
    import struct
    if str(ROOT / "tools") not in sys.path:
        sys.path.insert(0, str(ROOT / "tools"))
    import numpy as np
    import tilestyle
    d = STYLES / name
    if name in ("", ".", "..") or "/" in name or "\\" in name or not (d / "style.json").is_file():
        raise ValueError("no such style: " + name)
    key = (name, max(f.stat().st_mtime for f in (d / "style.json", d / "tables.json") if f.is_file()))
    if key not in _STYLE_CACHE:
        _STYLE_CACHE[key] = tilestyle.load_style(str(d))
    w, h = struct.unpack_from("<ii", raw, 0)
    n = w * h
    game = np.frombuffer(raw, np.uint8, n, 8).reshape(h, w)
    front = np.frombuffer(raw, np.uint8, n, 8 + n).reshape(h, w) if len(raw) >= 8 + 2 * n else None
    parts = []
    for _, tiles in tilestyle.apply(_STYLE_CACHE[key], game, front):
        a = np.zeros((h, w, 2), np.uint8)
        a[..., 0] = tiles >> 4
        a[..., 1] = tiles & 15
        parts.append(a.tobytes())
    return b"".join(parts)


def map_path(rel):
    """A .map file inside the DDNet maps folder, or None for anything outside it."""
    root = maps_dir().resolve()
    p = (root / (rel or "")).resolve()
    if p.suffix.lower() != ".map" or root not in p.parents:
        return None
    return p


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *a, **kw):
        super().__init__(*a, directory=str(WEB), **kw)

    def log_message(self, fmt, *args):
        if "/api/" in (self.path or ""):
            sys.stderr.write("%s\n" % (fmt % args))

    def end_headers(self):
        self.send_header("Cache-Control", "no-cache")
        super().end_headers()

    def send_json(self, obj, code=200):
        body = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def send_file(self, path, head=False):
        body = path.read_bytes()
        self.send_response(200)
        self.send_header("Content-Type", mimetypes.guess_type(str(path))[0] or "application/octet-stream")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        if not head:
            self.wfile.write(body)

    def route_data(self, head=False):
        path = urllib.parse.unquote(urllib.parse.urlparse(self.path).path)
        if path.startswith("/styles/"):
            f = (STYLES / path[len("/styles/"):]).resolve()
            f = f if STYLES.resolve() in f.parents and f.is_file() and f.suffix.lower() in (".png", ".json") else None
        elif path.startswith("/mapres/"):
            f = data_file("mapres/" + path[len("/mapres/"):])
        elif path.startswith("/data/"):
            f = data_file(path[len("/data/"):])
        else:
            return False
        if f:
            self.send_file(f, head)
        else:
            self.send_error(404)
        return True

    def do_HEAD(self):
        if not self.route_data(head=True):
            super().do_HEAD()

    def do_GET(self):
        self.guard(self.get)

    def do_POST(self):
        self.guard(self.post)

    def guard(self, fn):
        try:
            fn()
        except (ConnectionError, BrokenPipeError):
            pass
        except Exception as e:
            traceback.print_exc()
            try:
                self.send_json({"error": f"{type(e).__name__}: {e}"}, 500)
            except Exception:
                pass

    def files_get(self, path):
        """The editor's own Open / Save window: places, folder listings, reading a .map (filebrowser.py)."""
        if not FILES:
            return self.send_json({"error": "filebrowser.py was removed"}, 404)
        if not FILES.check(self):
            return self.send_json({"error": "forbidden"}, 403)
        qs = urllib.parse.parse_qs(urllib.parse.urlparse(self.path).query)
        arg = lambda k: qs.get(k, [""])[0]
        me = sys.modules[__name__]  # maps_dir() and find_ddnet_data() for the shortcuts
        try:
            if path == "/api/fs/places":
                return self.send_json(FILES.places(me))
            if path == "/api/fs/list":
                return self.send_json(FILES.listing(me, arg("dir"), deep=arg("deep") == "1"))
            if path == "/api/fs/file":
                return self.send_file(FILES.read(arg("path")))
        except (ValueError, OSError) as e:
            return self.send_json({"error": str(e)}, 404 if isinstance(e, FileNotFoundError) else 400)
        return self.send_json({"error": "unknown request"}, 404)

    def get(self):
        path = urllib.parse.urlparse(self.path).path
        if path == "/api/mapres":
            d = find_ddnet_data()
            names = sorted(p.stem for p in (d / "mapres").glob("*.png")) if d else STANDARD_MAPRES
            return self.send_json(names)
        if path == "/api/rules":
            d = find_ddnet_data()
            names = sorted(p.stem for p in (d / "editor" / "automap").glob("*.rules")) if d and (d / "editor" / "automap").is_dir() else STANDARD_RULES
            return self.send_json(names)
        if path == "/api/styles":
            return self.send_json(style_list())
        if path == "/api/config":
            d = find_ddnet_data()
            cfg = load_config()
            testserver = optional("testserver")
            srv = testserver.find_server(cfg, d) if testserver else None
            return self.send_json({"ddnet_data": cfg.get("ddnet_data", str(d) if d else ""), "found": bool(d), "using": str(d) if d else "",
                                   "ddnet_server": cfg.get("ddnet_server", ""), "server": str(srv) if srv else ""})
        if path == "/api/test/status":
            return self.send_json(TEST.status() if TEST else {"running": False, "address": "", "error": "testserver.py was removed"})
        if path == "/api/maps":
            root = maps_dir()
            files = []
            for dirpath, dirs, names in os.walk(root):  # folders that cannot be read are skipped, not an error
                # the DDNet editor autosaves into maps/auto/; those copies are not listed
                dirs[:] = [d for d in dirs if not (Path(dirpath) == root and d.lower() == "auto")]
                for n in names:
                    if not n.lower().endswith(".map") or "autosave" in n.lower():
                        continue
                    p = Path(dirpath) / n
                    try:
                        st = p.stat()
                    except OSError:
                        continue
                    files.append({"path": p.relative_to(root).as_posix(), "size": st.st_size, "time": st.st_mtime})
            files.sort(key=lambda f: -f["time"])
            return self.send_json({"dir": str(root), "files": files})
        if path == "/api/maps/file":
            p = map_path(urllib.parse.parse_qs(urllib.parse.urlparse(self.path).query).get("path", [""])[0])
            if not p or not p.is_file():
                return self.send_json({"error": "no such map"}, 404)
            return self.send_file(p)
        if path == "/api/ping":
            return self.send_json({"ok": True})
        if path.startswith("/api/fs/"):
            return self.files_get(path)
        if self.route_data():
            return
        super().do_GET()

    def post(self):
        path = urllib.parse.urlparse(self.path).path
        n = int(self.headers.get("Content-Length") or 0)
        raw = self.rfile.read(n)
        if path in ("/api/alive", "/api/bye"):
            page = urllib.parse.parse_qs(urllib.parse.urlparse(self.path).query).get("id", [""])[0]
            with PAGES_LOCK:
                if path == "/api/alive":
                    PAGES[page] = time.time()
                    PAGE_SEEN.set()
                else:
                    PAGES.pop(page, None)
            return self.send_json({"ok": True})
        if path in ("/api/test", "/api/test/stop") and not TEST:
            return self.send_json({"error": "Test map is not installed: testserver.py was removed"}, 404)
        if path == "/api/test":  # body: the map file
            try:
                return self.send_json(TEST.send(raw, load_config(), find_ddnet_data()))
            except Exception as e:
                traceback.print_exc()
                return self.send_json({"error": str(e)}, 500)
        if path == "/api/test/stop":
            return self.send_json(TEST.stop())
        if path == "/api/style":  # body: game (+ front) tiles, see style_apply
            name = urllib.parse.parse_qs(urllib.parse.urlparse(self.path).query).get("name", [""])[0]
            try:
                body = style_apply(name, raw)
            except ImportError as e:
                return self.send_json({"error": missing_module(e, "Learned styles")}, 500)
            except Exception as e:
                traceback.print_exc()
                return self.send_json({"error": str(e)}, 500)
            self.send_response(200)
            self.send_header("Content-Type", "application/octet-stream")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return
        if path == "/api/fs/file":  # body: the map file, written to any folder (filebrowser.py)
            if not FILES:
                return self.send_json({"error": "filebrowser.py was removed"}, 404)
            if not FILES.check(self):
                return self.send_json({"error": "forbidden"}, 403)
            qs = urllib.parse.parse_qs(urllib.parse.urlparse(self.path).query)
            try:
                return self.send_json(FILES.write(qs.get("path", [""])[0], raw))
            except (ValueError, OSError) as e:
                return self.send_json({"error": str(e)}, 400)
        if path == "/api/maps/file":  # body: the map file
            p = map_path(urllib.parse.parse_qs(urllib.parse.urlparse(self.path).query).get("path", [""])[0])
            if not p:
                return self.send_json({"error": "the name must end in .map and stay inside the maps folder"}, 400)
            p.parent.mkdir(parents=True, exist_ok=True)
            tmp = p.with_name(p.name + ".tmp")
            tmp.write_bytes(raw)
            os.replace(tmp, p)  # a crash while writing never leaves half a map
            return self.send_json({"saved": p.relative_to(maps_dir().resolve()).as_posix(), "size": len(raw)})
        try:
            req = json.loads(raw or b"{}")
        except Exception:
            return self.send_json({"error": "bad json"}, 400)
        if path == "/api/config":
            cfg = load_config()
            for k in ("ddnet_data", "ddnet_server"):
                if k in req:
                    cfg[k] = req[k]
            save_config(cfg)
            d = find_ddnet_data()
            return self.send_json({"found": bool(d), "using": str(d) if d else ""})
        if path == "/api/quadart":
            try:
                import quadart
                return self.send_json(quadart.convert(req))
            except ImportError as e:
                return self.send_json({"error": missing_module(e, "Quad art")}, 500)
            except Exception as e:
                traceback.print_exc()
                return self.send_json({"error": str(e)}, 500)
        self.send_error(404)


def watch_pages(srv, grace=8, silent=150):
    """Stop the editor (and the test server) once no editor page is open: after a goodbye, or when no page
    has said it is alive for `silent` seconds (browser killed). `grace` leaves time for a page reload."""
    PAGE_SEEN.wait()
    empty_since = None
    while True:
        time.sleep(1)
        now = time.time()
        with PAGES_LOCK:
            for k, t in list(PAGES.items()):
                if now - t > silent:
                    del PAGES[k]
            open_pages = len(PAGES)
        if open_pages:
            empty_since = None
            continue
        empty_since = empty_since or now
        if now - empty_since >= grace:
            print("The editor page was closed, stopping the editor and the test server.")
            if TEST:
                TEST.stop()
            srv.shutdown()
            return


class Server(ThreadingHTTPServer):
    # On Windows SO_REUSEADDR lets a second program take the same port, and the browser may then reach that
    # program instead of the editor. Bind exclusively there, so a busy port fails and the next one is tried.
    allow_reuse_address = os.name != "nt"

    def server_bind(self):
        if os.name == "nt" and hasattr(socket, "SO_EXCLUSIVEADDRUSE"):
            self.socket.setsockopt(socket.SOL_SOCKET, socket.SO_EXCLUSIVEADDRUSE, 1)
        super().server_bind()


class Server6(Server):
    address_family = socket.AF_INET6


DEFAULT_PORT = 8765
BUSY = {errno.EADDRINUSE, errno.EACCES, 10048, 10013}  # 10048 / 10013: the Windows codes for a taken port


def busy(e):
    return e.errno in BUSY or getattr(e, "winerror", None) in BUSY


def open_servers(host, port, tries=20):
    """Servers for the first free port from `port` on. "localhost" can mean 127.0.0.1 or ::1 in the browser
    (Windows usually tries ::1 first), so on the loopback both are taken: another program on either one would
    otherwise answer instead of the editor."""
    for p in range(port, port + tries):
        made = []
        try:
            made.append(Server((host, p), Handler))
            if host in ("127.0.0.1", "localhost") and socket.has_ipv6:
                try:
                    made.append(Server6(("::1", p), Handler))
                except OSError as e:
                    if busy(e):
                        raise
                    # no IPv6 loopback on this machine: 127.0.0.1 is enough
            return p, made
        except OSError as e:
            for x in made:
                x.server_close()
            if not busy(e):
                raise
            print(f"Port {p} is taken by another program, trying {p + 1}")
    raise SystemExit(f"No free port in {port}..{port + tries - 1}. Start with --port <number>.")


class Servers:
    """Several listening sockets that start and stop together (watch_pages calls shutdown())."""

    def __init__(self, servers):
        self.servers = servers

    def serve_forever(self):
        for x in self.servers[1:]:
            threading.Thread(target=x.serve_forever, daemon=True).start()
        self.servers[0].serve_forever()

    def shutdown(self):
        for x in self.servers:
            threading.Thread(target=x.shutdown, daemon=True).start()


def main():
    ap = argparse.ArgumentParser(description="Local DDNet map editor")
    ap.add_argument("--port", type=int, default=None, help="port to use (default: the one used last time, first 8765)")
    ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("--no-browser", action="store_true")
    ap.add_argument("--keep-running", action="store_true", help="do not stop when the last editor tab is closed")
    ap.add_argument("--no-update", action="store_true", help="portable build: do not check for updates (read by update.py)")
    a = ap.parse_args()
    sys.path.insert(0, str(ROOT))
    global TEST
    testserver = optional("testserver")  # Test map; the editor runs without it
    if testserver:
        TEST = testserver.TestServer(CACHE / "testserver.log")
        atexit.register(TEST.stop)
        testserver.start_cleanup()  # stop test servers an earlier run left behind
    # get the editor's own DDNet-Server (./ddnet-server) in the background the first time, so "Test map" is ready
    if testserver and not (testserver.SERVER_DIR / testserver.EXE).is_file():
        def fetch_server():
            try:
                testserver.install()
            except Exception as e:
                print(f"Could not download DDNet-Server for Test map: {e}")
        threading.Thread(target=fetch_server, daemon=True).start()
    mimetypes.add_type("text/javascript", ".js")
    mimetypes.add_type("text/css", ".css")
    # The browser keeps the palette and the autosaved session per address (port included), so the editor stays on
    # one port: the one it ended up on last time. When that port is taken, the next free one is used and remembered.
    cfg = load_config()
    want = a.port or cfg.get("port") or DEFAULT_PORT
    port, made = open_servers(a.host, want)
    if not a.port and cfg.get("port") != port:
        cfg["port"] = port
        try:
            save_config(cfg)
        except OSError:
            pass
        if port != want:
            print(f"The editor now uses port {port} (saved in config.json). Things kept in the browser for port {want} "
                  f"(palette, autosave) stay with that address.")
    srv = Servers(made)
    url = f"http://localhost:{port}/"
    d = find_ddnet_data()
    print(f"TW Editor: {url}")
    print(f"DDNet data: {d if d else 'not found, mapres images will be downloaded from GitHub into ./cache'}")
    print("Closing the editor tab stops it; Ctrl+C here stops it too.")
    if not a.keep_running:
        threading.Thread(target=watch_pages, args=(srv,), daemon=True).start()
    if not a.no_browser:
        threading.Timer(0.6, lambda: webbrowser.open(url)).start()
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        if TEST:
            TEST.stop()


if __name__ == "__main__":
    main()
