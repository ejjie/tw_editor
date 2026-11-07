"""Self-update of the portable TW Editor (run by start.bat before editor.py).

Only works in the portable build (runtime/ next to this file and a version.json made by portable/build.py);
in a development folder it does nothing, so it never overwrites a working copy.

On start it reads version.json of the latest GitHub release (a few hundred bytes). When the version differs:
  * the code archive (web/ and the .py files, 1-2 MB) is downloaded, checked (sha256) and unpacked over the
    editor; files of the old version that the new one no longer has are removed. Files the editor made itself
    (config.json, cache/, ddnet-server/, user-rules/, styles/ you learned) are never touched.
  * only when the new version needs another runtime (Python + numpy/opencv/pillow/earcut, its own version),
    that archive is downloaded too and unpacked into runtime.new/; start.bat swaps it in once Python has exited.

No network, GitHub down, a broken download: the editor just starts as it is.
Turn it off with "auto_update": false in config.json or start.bat --no-update.

Exit codes for start.bat: 0 nothing to do / code updated, 10 a new runtime waits in runtime.new/.
"""

import hashlib
import json
import os
import shutil
import sys
import tempfile
import time
import urllib.request
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent
RUNTIME = ROOT / "runtime"
RUNTIME_NEW = ROOT / "runtime.new"
VERSION = ROOT / "version.json"
MANIFEST = ROOT / "files.txt"  # every file the current version installed (relative paths), made by build.py
CONFIG = ROOT / "config.json"
WORK = ROOT / "cache" / "update"
TIMEOUT = 6
UA = "tw-editor-updater"
EXIT_RUNTIME = 10
# never written or removed by an update, whatever an archive contains
KEEP = ("config.json", "cache/", "ddnet-server/", "ddnet-server.part/", "user-rules/", "runtime/", "runtime.new/")


def log(msg):
    print(f"[update] {msg}", flush=True)


def read_json(p):
    try:
        return json.loads(Path(p).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}


def base_url(local):
    """Where releases come from: TW_EDITOR_UPDATE_URL (for tests) or the GitHub repo in version.json."""
    url = os.environ.get("TW_EDITOR_UPDATE_URL")
    if url:
        return url.rstrip("/")
    repo = local.get("repo") or ""
    if "/" not in repo:
        return None
    return f"https://github.com/{repo}/releases"


def fetch(url, timeout=TIMEOUT):
    req = urllib.request.Request(url, headers={"User-Agent": UA, "Cache-Control": "no-cache"})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.read()


def download(url, dest, sha256, label):
    """Download to dest with a simple progress line; the sha256 must match."""
    req = urllib.request.Request(url, headers={"User-Agent": UA})
    h = hashlib.sha256()
    tmp = dest.with_suffix(dest.suffix + ".part")
    with urllib.request.urlopen(req, timeout=30) as r, open(tmp, "wb") as f:
        total = int(r.headers.get("Content-Length") or 0)
        done, shown = 0, 0
        while True:
            chunk = r.read(1 << 16)
            if not chunk:
                break
            f.write(chunk)
            h.update(chunk)
            done += len(chunk)
            if total and (done - shown > total / 20 or done == total):
                shown = done
                print(f"\r[update] {label}: {done * 100 // total}% of {total / 1e6:.1f} MB", end="", flush=True)
    if total:
        print(flush=True)
    if sha256 and h.hexdigest() != sha256.lower():
        tmp.unlink(missing_ok=True)
        raise ValueError(f"{label}: checksum does not match, download thrown away")
    tmp.replace(dest)
    return dest


def kept(rel):
    rel = rel.replace("\\", "/")
    return any(rel == k or rel.startswith(k) for k in KEEP)


def safe_names(z):
    """Names of the files in the archive; refuses absolute paths and '..'."""
    out = []
    for n in z.namelist():
        if n.endswith("/"):
            continue
        p = Path(n)
        if p.is_absolute() or ".." in p.parts or ":" in n:
            raise ValueError(f"bad path in archive: {n}")
        out.append(n)
    return out


def apply_code(zip_path):
    """Unpack the code archive over the editor and remove files the old version had and the new one has not."""
    with zipfile.ZipFile(zip_path) as z:
        names = [n for n in safe_names(z) if not kept(n)]
        if "editor.py" not in names or "version.json" not in names:
            raise ValueError("code archive is incomplete")
        stage = Path(tempfile.mkdtemp(prefix="code-", dir=WORK))
        z.extractall(stage, members=names)
    old = set()
    if MANIFEST.is_file():
        old = {x.strip() for x in MANIFEST.read_text(encoding="utf-8").splitlines() if x.strip()}
    for n in names:
        src, dst = stage / n, ROOT / n
        if n == "start.bat":
            # cmd.exe is reading start.bat right now; start.bat swaps in start.bat.new itself
            if not dst.is_file() or dst.read_bytes() != src.read_bytes():
                dst = ROOT / "start.bat.new"
            else:
                continue
        dst.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(src, dst)
    for n in sorted(old - set(names)):
        if kept(n) or n == "start.bat":
            continue
        p = ROOT / n
        try:
            p.unlink()
        except FileNotFoundError:
            pass
        except OSError as e:
            log(f"could not remove old file {n}: {e}")
        # drop folders that became empty
        d = p.parent
        while d != ROOT and d.is_dir() and not any(d.iterdir()):
            d.rmdir()
            d = d.parent
    shutil.rmtree(stage, ignore_errors=True)


def stage_runtime(zip_path, want):
    """Unpack the runtime archive into runtime.new/; start.bat moves it to runtime/ after Python has exited."""
    shutil.rmtree(RUNTIME_NEW, ignore_errors=True)
    stage = Path(tempfile.mkdtemp(prefix="runtime-", dir=WORK))
    with zipfile.ZipFile(zip_path) as z:
        z.extractall(stage, members=safe_names(z))
    src = stage / "runtime"
    info = read_json(src / "runtime.json")
    if info.get("runtime") != want or not (src / "python.exe").is_file():
        shutil.rmtree(stage, ignore_errors=True)
        raise ValueError("runtime archive does not match the version it should be")
    src.replace(RUNTIME_NEW)
    shutil.rmtree(stage, ignore_errors=True)


def main(argv):
    if "--no-update" in argv:
        return 0
    local = read_json(VERSION)
    if not local.get("version") or not (RUNTIME / "runtime.json").is_file():
        return 0  # development folder: never update
    if read_json(CONFIG).get("auto_update") is False:
        log("automatic updates are off (config.json: auto_update)")
        return 0
    base = base_url(local)
    if not base:
        return 0
    try:
        remote = json.loads(fetch(f"{base}/latest/download/version.json"))
    except Exception as e:  # offline, GitHub down, no release yet
        log(f"could not check for updates ({e.__class__.__name__}), starting version {local['version']}")
        return 0
    if not remote.get("version") or remote.get("version") == local.get("version"):
        return 0
    have_rt = read_json(RUNTIME / "runtime.json").get("runtime")
    want_rt = remote.get("runtime")
    log(f"new version {remote['version']} (you have {local['version']})")
    WORK.mkdir(parents=True, exist_ok=True)
    try:
        # the runtime first: a code update that needs a runtime we could not get would not start
        need_rt = bool(want_rt) and want_rt != have_rt
        if need_rt:
            log(f"it needs new modules (runtime {want_rt}), this download is bigger and happens only now")
            rz = download(f"{base}/download/{remote['runtime_tag']}/{remote['runtime_asset']}",
                          WORK / remote["runtime_asset"], remote.get("runtime_sha256"), "runtime")
            stage_runtime(rz, want_rt)
            rz.unlink(missing_ok=True)
        cz = download(f"{base}/download/{remote['tag']}/{remote['code_asset']}",
                      WORK / remote["code_asset"], remote.get("code_sha256"), "editor")
        apply_code(cz)
        cz.unlink(missing_ok=True)
    except Exception as e:
        shutil.rmtree(RUNTIME_NEW, ignore_errors=True)
        log(f"update failed ({e}), starting version {local['version']}")
        time.sleep(2)
        return 0
    log(f"updated to {remote['version']}")
    return EXIT_RUNTIME if RUNTIME_NEW.is_dir() else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
