"""Test the map on a local DDNet server, like "Test map locally" in the DDNet editor, but without touching the client.

The editor keeps its own copy of DDNet in ./ddnet-server: the latest release is downloaded from GitHub (or
ddnet.org) the first time editor.py starts. The map is written to its data/maps/tw_editor_test.map and
DDNet-Server is started with it.
After that every new version of the map is sent to the running server with the `hot_reload` command over the
external console (econ), which keeps the tees where they are. Connect from the client to the address it reports.
"""
import json
import os
import re
import secrets
import shutil
import socket
import subprocess
import sys
import threading
import time
import urllib.request
import zipfile
from pathlib import Path

MAP_NAME = "tw_editor_test"
SERVER_DIR = Path(__file__).resolve().parent / "ddnet-server"
EXE = "DDNet-Server.exe" if sys.platform == "win32" else "DDNet-Server"
# release file name of each system, {v} = version
PACKAGE = {"win32": "DDNet-{v}-win64.zip", "linux": "DDNet-{v}-linux_x86_64.tar.xz"}
_install_lock = threading.Lock()
_cleaned = threading.Event()  # set once leftover servers are gone; a new test server waits for it
_cleaned.set()


def _get(url, timeout=30):
    req = urllib.request.Request(url, headers={"User-Agent": "tw-editor"})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.read()


def release_url():
    """Download link of the latest DDNet release for this system."""
    name = PACKAGE.get(sys.platform, PACKAGE["linux"])
    pattern = re.escape(name).replace(re.escape("{v}"), r"([\d.]+)")
    try:
        rel = json.loads(_get("https://api.github.com/repos/ddnet/ddnet/releases/latest"))
        for a in rel.get("assets", []):
            if re.fullmatch(pattern, a["name"]):
                return a["browser_download_url"]
    except Exception:
        pass
    page = _get("https://ddnet.org/downloads/").decode("utf-8", "replace")
    versions = sorted({m.group(1) for m in re.finditer(pattern, page)}, key=lambda v: [int(x) for x in v.split(".") if x.isdigit()])
    if not versions:
        raise RuntimeError("no DDNet release found on GitHub or ddnet.org")
    return "https://ddnet.org/downloads/" + name.format(v=versions[-1])


def install(log=print):
    """Download DDNet into ./ddnet-server once; returns the server executable."""
    with _install_lock:
        exe = SERVER_DIR / EXE
        if exe.is_file():
            return exe
        url = release_url()
        log(f"Downloading DDNet server for Test map: {url}")
        body = _get(url, timeout=300)
        tmp = SERVER_DIR.with_name("ddnet-server.part")
        shutil.rmtree(tmp, ignore_errors=True)
        tmp.mkdir(parents=True)
        arc = tmp / url.rsplit("/", 1)[-1]
        arc.write_bytes(body)
        if arc.name.endswith(".zip"):
            with zipfile.ZipFile(arc) as z:
                z.extractall(tmp)
        else:
            import tarfile
            with tarfile.open(arc) as t:
                t.extractall(tmp)
        arc.unlink()
        # the archive has one top folder (DDNet-19.x-win64); its content becomes ./ddnet-server
        found = next(tmp.rglob(EXE), None)
        if not found:
            raise RuntimeError(f"{EXE} is not in {url}")
        shutil.rmtree(SERVER_DIR, ignore_errors=True)
        found.parent.rename(SERVER_DIR)
        shutil.rmtree(tmp, ignore_errors=True)
        if sys.platform != "win32":
            (SERVER_DIR / EXE).chmod(0o755)
        log(f"DDNet server installed in {SERVER_DIR}")
        return SERVER_DIR / EXE


def isolate(exe):
    """Keep the player's own DDNet folder (autoexec_server.cfg with tunes, votes, its 1000+ maps) out of the editor's
    copy of the server, so the test runs on a clean server: $USERDIR is taken out of its storage.cfg."""
    if Path(exe).parent.resolve() != SERVER_DIR.resolve():
        return
    cfg = SERVER_DIR / "storage.cfg"
    try:
        lines = cfg.read_text("utf-8").splitlines() if cfg.is_file() else ["add_path $DATADIR", "add_path $CURRENTDIR"]
    except OSError:
        return
    out = ["# " + l + "  (tw-editor: test server ignores the player's own DDNet folder)" if l.strip() == "add_path $USERDIR" else l for l in lines]
    if out != lines or not cfg.is_file():
        cfg.write_text("\n".join(out) + "\n", "utf-8")


def user_dir():
    """DDNet's user folder ($USERDIR in storage.cfg); maps in its maps/ folder are found by the server."""
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


def find_server(cfg, data_dir):
    """The path set in the editor settings, the editor's own copy, or DDNet-Server next to the game's data folder."""
    exe = EXE
    cands = []
    if cfg.get("ddnet_server"):
        p = Path(cfg["ddnet_server"])
        cands += [p, p / exe]
    cands.append(SERVER_DIR / exe)
    if data_dir:
        cands += [Path(data_dir).parent / exe, Path(data_dir).parent.parent / exe]
    for c in cands:
        if c.is_file():
            return c
    return None


def tie_to_this_process(proc):
    """Windows: put the server in a job object that is killed when editor.py ends in any way (also when its
    console window is closed), so DDNet-Server never stays behind. Returns the job handle, which must stay open."""
    if sys.platform != "win32":
        return None
    try:
        import ctypes
        from ctypes import wintypes

        class IoCounters(ctypes.Structure):
            _fields_ = [(n, ctypes.c_ulonglong) for n in ("r", "w", "o", "rb", "wb", "ob")]

        class Basic(ctypes.Structure):
            _fields_ = [("PerProcessUserTimeLimit", ctypes.c_int64), ("PerJobUserTimeLimit", ctypes.c_int64),
                        ("LimitFlags", wintypes.DWORD), ("MinimumWorkingSetSize", ctypes.c_size_t),
                        ("MaximumWorkingSetSize", ctypes.c_size_t), ("ActiveProcessLimit", wintypes.DWORD),
                        ("Affinity", ctypes.c_size_t), ("PriorityClass", wintypes.DWORD), ("SchedulingClass", wintypes.DWORD)]

        class Extended(ctypes.Structure):
            _fields_ = [("Basic", Basic), ("Io", IoCounters), ("ProcessMemoryLimit", ctypes.c_size_t),
                        ("JobMemoryLimit", ctypes.c_size_t), ("PeakProcessMemoryUsed", ctypes.c_size_t),
                        ("PeakJobMemoryUsed", ctypes.c_size_t)]

        k32 = ctypes.WinDLL("kernel32", use_last_error=True)
        k32.CreateJobObjectW.restype = wintypes.HANDLE
        k32.CreateJobObjectW.argtypes = [ctypes.c_void_p, wintypes.LPCWSTR]
        k32.SetInformationJobObject.argtypes = [wintypes.HANDLE, ctypes.c_int, ctypes.c_void_p, wintypes.DWORD]
        k32.AssignProcessToJobObject.argtypes = [wintypes.HANDLE, wintypes.HANDLE]
        job = k32.CreateJobObjectW(None, None)
        info = Extended()
        info.Basic.LimitFlags = 0x2000  # JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
        if not k32.SetInformationJobObject(job, 9, ctypes.byref(info), ctypes.sizeof(info)):  # JobObjectExtendedLimitInformation
            return None
        if not k32.AssignProcessToJobObject(job, int(proc._handle)):
            return None
        return job
    except Exception as e:
        print(f"Test server: could not tie DDNet-Server to the editor ({e})")
        return None


def start_cleanup():
    """kill_leftovers in the background; TestServer.send waits for it, so it never hits the new server."""
    _cleaned.clear()

    def run():
        try:
            kill_leftovers()
        finally:
            _cleaned.set()
    threading.Thread(target=run, daemon=True).start()


def kill_leftovers(log=print):
    """Stop test servers that an earlier editor.py left running (crash, or a version from before the job object).
    Only DDNet-Server processes started from ./ddnet-server are touched, never the player's own servers."""
    exe = (SERVER_DIR / EXE).resolve()
    killed = 0
    try:
        if sys.platform == "win32":
            path = str(exe).replace("'", "''")
            ps = ("$n = 0; Get-Process -Name 'DDNet-Server' -ErrorAction SilentlyContinue | "
                  f"Where-Object {{ $_.Path -eq '{path}' }} | "
                  "ForEach-Object { Stop-Process -Id $_.Id -Force; $n++ }; $n")
            out = subprocess.run(["powershell", "-NoProfile", "-NonInteractive", "-Command", ps], capture_output=True, text=True,
                                 timeout=30, creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0)).stdout.strip()
            killed = int(out.splitlines()[-1]) if out and out.splitlines()[-1].isdigit() else 0
        else:
            import signal
            for p in Path("/proc").iterdir():
                if p.name.isdigit() and int(p.name) != os.getpid():
                    try:
                        if Path(os.readlink(p / "exe")).resolve() == exe:
                            os.kill(int(p.name), signal.SIGTERM)
                            killed += 1
                    except OSError:
                        pass
    except Exception as e:
        log(f"Test server: could not look for old test servers ({e})")
    if killed:
        log(f"Stopped {killed} test server(s) left over from an earlier run.")
    return killed


def free_port(kind, start):
    for port in range(start, start + 100):
        s = socket.socket(socket.AF_INET, kind)
        try:
            s.bind(("127.0.0.1", port))
            return port
        except OSError:
            continue
        finally:
            s.close()
    raise RuntimeError("no free port")


class TestServer:
    def __init__(self, log_path):
        self.proc = None
        self.job = None
        self.maps = None
        self.port = self.econ_port = 0
        self.password = ""
        self.log_path = Path(log_path)
        self.lock = threading.Lock()

    def running(self):
        return self.proc is not None and self.proc.poll() is None

    def status(self):
        return {"running": self.running(), "address": f"localhost:{self.port}" if self.running() else ""}

    def send(self, map_bytes, cfg, data_dir):
        """Write the map; start the server, or hot reload it when it already runs."""
        with self.lock:
            exe = find_server(cfg, data_dir)
            if not exe and not self.running():
                try:
                    exe = install()
                except Exception as e:
                    return {"error": f"could not download DDNet-Server ({e}). Set its path in Editor settings."}
            # the server's own data/maps when it has one (always for ./ddnet-server), else DDNet's user folder
            exe_dir = Path(exe).parent if exe else None
            maps = exe_dir / "data" / "maps" if exe_dir and (exe_dir / "data").is_dir() else user_dir() / "maps"
            if self.running() and self.maps:
                maps = self.maps
            maps.mkdir(parents=True, exist_ok=True)
            (maps / f"{MAP_NAME}.map").write_bytes(map_bytes)
            if self.running():
                out = self.econ(["hot_reload"])
                if "no such command" in out.lower():  # servers older than hot_reload: plain reload (tees respawn)
                    self.econ(["reload"])
                return {**self.status(), "reloaded": True}
            self.maps = maps
            _cleaned.wait(30)
            self.port = free_port(socket.SOCK_DGRAM, 8303)
            self.econ_port = free_port(socket.SOCK_STREAM, 8403)
            self.password = secrets.token_hex(8)
            isolate(exe)
            # each argument is one console line, run after autoexec_server.cfg so they win over it.
            # No bindaddr: the client's "Local" tab finds servers by a LAN broadcast, which a 127.0.0.1 socket never gets.
            args = [str(exe), f"sv_map {MAP_NAME}", f"sv_port {self.port}", "sv_register 0", "sv_test_cmds 1",
                    'sv_name "TW Editor test"', "ec_bindaddr 127.0.0.1", f"ec_port {self.econ_port}",
                    f"ec_password {self.password}", "ec_output_level 0"]
            self.log_path.parent.mkdir(parents=True, exist_ok=True)
            log = open(self.log_path, "wb")
            flags = getattr(subprocess, "CREATE_NO_WINDOW", 0)
            self.proc = subprocess.Popen(args, cwd=str(exe.parent), stdout=log, stderr=subprocess.STDOUT, stdin=subprocess.DEVNULL, creationflags=flags)
            self.job = tie_to_this_process(self.proc)
            for _ in range(50):  # wait until the server is up
                time.sleep(0.1)
                if not self.running():
                    log.close()
                    tail = self.log_path.read_text("utf-8", "replace").strip().splitlines()[-3:]
                    return {"error": "DDNet-Server stopped right away: " + (" | ".join(tail) or "no output") + f" (log: {self.log_path})"}
                if self.econ_ready():
                    break
            return {**self.status(), "started": True}

    def stop(self):
        with self.lock:
            if self.running():
                self.proc.terminate()
                try:
                    self.proc.wait(5)
                except subprocess.TimeoutExpired:
                    self.proc.kill()
            self.proc = None
            return self.status()

    def econ_ready(self):
        try:
            socket.create_connection(("127.0.0.1", self.econ_port), 0.2).close()
            return True
        except OSError:
            return False

    def econ(self, lines):
        """Log in to the external console, run the lines and return what the server printed."""
        with socket.create_connection(("127.0.0.1", self.econ_port), 3) as s:
            s.settimeout(3)
            buf = b""
            while b"password" not in buf.lower():
                chunk = s.recv(4096)
                if not chunk:
                    raise RuntimeError("econ closed")
                buf += chunk
            s.sendall(self.password.encode() + b"\n")
            buf = b""
            while b"access granted" not in buf.lower() and b"authentication successful" not in buf.lower():
                chunk = s.recv(4096)
                if not chunk:
                    raise RuntimeError("econ login failed")
                buf += chunk
            for line in lines:
                s.sendall(line.encode() + b"\n")
            out = b""
            s.settimeout(0.4)
            try:
                while True:
                    chunk = s.recv(4096)
                    if not chunk:
                        break
                    out += chunk
            except socket.timeout:
                pass
            return out.decode("utf-8", "replace")
