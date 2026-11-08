"""Build the portable TW Editor for Windows (64 bit). Runs on Windows or Linux (GitHub Actions uses Linux).

    python portable/build.py --version 1.0.0 [--repo owner/name] [--out dist]

Makes in dist/:
  tw-editor-<version>-win64.zip        everything, for a first download: unpack, double-click start.bat
  tw-editor-code-<version>.zip         only the editor code (web/ and .py, 1-2 MB): what updates download
  tw-editor-runtime-<rt>-win64.zip     Python + numpy/pillow/opencv/earcut; <rt> is its own version
  version.json                         what update.py reads from the latest release

The runtime version <rt> is a short hash of the Python version and portable/requirements.txt, so it changes
only when the modules change; the release workflow uploads the runtime once, to its own release runtime-<rt>.
Nothing is installed on the build machine: the embeddable Python comes from python.org and the modules as
Windows wheels from PyPI (pip download), unpacked straight into runtime/Lib/site-packages.
"""

import argparse
import fnmatch
import hashlib
import json
import os
import shutil
import subprocess
import sys
import urllib.request
import zipfile
from pathlib import Path

PYTHON = "3.13.17"  # Windows embeddable Python inside the runtime
HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
REQS = HERE / "requirements.txt"

# Files of the editor that go into the code archive: everything in the folder except these.
EXCLUDE = [
    ".git/*", ".github/*", ".gitignore", "portable/*", "dist/*", "build/*",
    "*/__pycache__/*", "__pycache__/*", "*.pyc",
    "config.json", "cache/*", "ddnet-server/*", "ddnet-server.part/*", "user-rules/*",
    "runtime/*", "runtime.new/*", "runtime.old/*", "version.json", "files.txt", "start.bat.new",
    "*.png",  # screenshots at the top; pictures in subfolders are listed in KEEP_PNG
    "docs/*",  # README screenshots
    "requirements.txt",  # pip modules for the development folder; the runtime has them
    # Rules maker is paused (web/js/features.js): not shipped
    "rulesmaker.py", "web/js/rulesmaker.js", "web/js/ruleslearn.js",
    "templates/*", "tools/make_rules_template.py", "tools/template2rules.*",
]
KEEP_PNG = ["web/*", "extra-data/*", "styles/*"]
# Parts of the standard library the editor never uses (smaller runtime)
STDLIB_DROP = ["test", "idlelib", "tkinter", "turtledemo", "ensurepip", "lib2to3", "venv", "pydoc_data",
               "_tkinter.pyd", "tcl86t.dll", "tk86t.dll", "tcl"]


def log(msg):
    print(msg, flush=True)


def sha256(p):
    h = hashlib.sha256()
    with open(p, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def runtime_version():
    reqs = "\n".join(x.split("#")[0].strip() for x in REQS.read_text().splitlines() if x.split("#")[0].strip())
    return hashlib.sha256(f"python {PYTHON}\n{reqs}\n".encode()).hexdigest()[:8]


def code_files():
    out = []
    for p in sorted(ROOT.rglob("*")):
        if not p.is_file():
            continue
        rel = p.relative_to(ROOT).as_posix()
        if any(fnmatch.fnmatch(rel, x) for x in EXCLUDE):
            if not (rel.endswith(".png") and any(fnmatch.fnmatch(rel, k) for k in KEEP_PNG)):
                continue
        out.append(rel)
    return out


def fetch(url, dest):
    log(f"download {url}")
    req = urllib.request.Request(url, headers={"User-Agent": "tw-editor-build"})
    with urllib.request.urlopen(req, timeout=120) as r, open(dest, "wb") as f:
        shutil.copyfileobj(r, f)
    return dest


def get_python(work, python_zip):
    """The embeddable Python (python.org); --python-zip uses a local copy of it instead."""
    if python_zip:
        return Path(python_zip)
    dest = work / f"python-{PYTHON}-embed-amd64.zip"
    if not dest.is_file():
        fetch(f"https://www.python.org/ftp/python/{PYTHON}/python-{PYTHON}-embed-amd64.zip", dest)
    return dest


def get_wheels(work, wheels_dir):
    if wheels_dir:
        return sorted(Path(wheels_dir).glob("*.whl"))
    d = work / "wheels"
    d.mkdir(exist_ok=True)
    major_minor = ".".join(PYTHON.split(".")[:2])
    subprocess.check_call([sys.executable, "-m", "pip", "download", "--disable-pip-version-check", "-q",
                           "--only-binary=:all:", "--platform", "win_amd64", "--implementation", "cp",
                           "--python-version", major_minor, "-r", str(REQS), "-d", str(d)])
    return sorted(d.glob("*.whl"))


def unpack_wheel(whl, site):
    """A wheel is a zip: its files go to site-packages; <name>.data/{purelib,platlib} too."""
    with zipfile.ZipFile(whl) as z:
        for info in z.infolist():
            n = info.filename
            if n.endswith("/"):
                continue
            parts = n.split("/")
            if parts[0].endswith(".data"):
                if len(parts) > 2 and parts[1] in ("purelib", "platlib"):
                    n = "/".join(parts[2:])
                else:
                    continue  # scripts, headers: not needed
            dest = site / n
            dest.parent.mkdir(parents=True, exist_ok=True)
            with z.open(info) as src, open(dest, "wb") as f:
                shutil.copyfileobj(src, f)


def build_runtime(work, python_zip, wheels_dir, rt):
    rdir = work / "runtime"
    shutil.rmtree(rdir, ignore_errors=True)
    rdir.mkdir(parents=True)
    with zipfile.ZipFile(get_python(work, python_zip)) as z:
        names = z.namelist()
        if any(n.startswith("tools/python.exe") for n in names):  # NuGet package "python": the files are in tools/
            for info in z.infolist():
                if info.filename.startswith("tools/") and not info.filename.endswith("/"):
                    dest = rdir / info.filename[len("tools/"):]
                    dest.parent.mkdir(parents=True, exist_ok=True)
                    with z.open(info) as src, open(dest, "wb") as f:
                        shutil.copyfileobj(src, f)
        else:
            z.extractall(rdir)
    if not (rdir / "python.exe").is_file():
        sys.exit("python.exe is missing in the Python archive")
    for x in STDLIB_DROP:
        for base in (rdir / "Lib", rdir / "DLLs", rdir):
            p = base / x
            if p.is_dir():
                shutil.rmtree(p)
            elif p.is_file():
                p.unlink()
    site = rdir / "Lib" / "site-packages"
    site.mkdir(parents=True, exist_ok=True)
    for whl in get_wheels(work, wheels_dir):
        log(f"module {whl.name}")
        unpack_wheel(whl, site)
    for p in list(site.rglob("tests")) + list(site.rglob("__pycache__")):
        if p.is_dir():
            shutil.rmtree(p, ignore_errors=True)
    # The ._pth file fixes sys.path (and ignores PYTHONPATH and other Pythons on the PC). ".." is the editor folder.
    tag = "".join(PYTHON.split(".")[:2])
    for old in rdir.glob("python*._pth"):
        old.unlink()
    lines = [f"python{tag}.zip", "Lib", "DLLs", r"Lib\site-packages", "..", "import site"]
    (rdir / f"python{tag}._pth").write_text("\n".join(lines) + "\n")
    (rdir / "runtime.json").write_text(json.dumps({
        "runtime": rt, "python": PYTHON,
        "modules": [x.strip() for x in REQS.read_text().splitlines() if x.strip() and not x.startswith("#")],
    }, indent=1))
    return rdir


def write_zip(path, entries):
    """entries: (archive name, source path); deterministic order, deflate."""
    with zipfile.ZipFile(path, "w", zipfile.ZIP_DEFLATED, compresslevel=9) as z:
        for name, src in entries:
            z.write(src, name)
    log(f"{path.name}: {path.stat().st_size / 1e6:.1f} MB")


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--version", help="editor version, e.g. 1.0.0 (the git tag is v1.0.0)")
    ap.add_argument("--repo", default=os.environ.get("GITHUB_REPOSITORY", ""),
                    help="owner/name on GitHub where updates come from (default: $GITHUB_REPOSITORY)")
    ap.add_argument("--out", default=str(ROOT / "dist"))
    ap.add_argument("--python-zip", help="local Python archive (embeddable zip, or the NuGet 'python' package)")
    ap.add_argument("--wheels", help="folder with the Windows wheels already downloaded")
    ap.add_argument("--runtime-zip", help="use this runtime archive (already released) instead of building one")
    ap.add_argument("--print-runtime", action="store_true", help="print the runtime version and stop")
    a = ap.parse_args()
    if a.print_runtime:
        print(runtime_version())
        return
    if not a.version:
        ap.error("--version is required")

    ver = a.version.lstrip("v")
    rt = runtime_version()
    out = Path(a.out)
    out.mkdir(parents=True, exist_ok=True)
    work = out / "_work"
    work.mkdir(exist_ok=True)
    code_name = f"tw-editor-code-{ver}.zip"
    rt_name = f"tw-editor-runtime-{rt}-win64.zip"
    full_name = f"tw-editor-{ver}-win64.zip"

    files = code_files()
    # version.json and files.txt go into the code archive too (update.py compares and cleans up with them)
    local = {"version": ver, "runtime": rt, "repo": a.repo}
    (work / "version.json").write_text(json.dumps(local, indent=1))
    manifest = files + ["version.json", "files.txt"]
    (work / "files.txt").write_text("\n".join(manifest) + "\n")
    code_entries = [(f, ROOT / f) for f in files] + [("version.json", work / "version.json"),
                                                     ("files.txt", work / "files.txt")]
    write_zip(out / code_name, code_entries)

    remote = {
        "version": ver, "tag": f"v{ver}", "runtime": rt, "repo": a.repo,
        "code_asset": code_name, "code_sha256": sha256(out / code_name),
        "runtime_tag": f"runtime-{rt}", "runtime_asset": rt_name,
    }
    if a.runtime_zip:
        # the runtime of an earlier release: the same bytes, so its checksum stays right for update.py
        if Path(a.runtime_zip).resolve() != (out / rt_name).resolve():
            shutil.copyfile(a.runtime_zip, out / rt_name)
        rdir = work / "runtime_prev"
        shutil.rmtree(rdir, ignore_errors=True)
        with zipfile.ZipFile(out / rt_name) as z:
            z.extractall(rdir)
        rdir = rdir / "runtime"
        if json.loads((rdir / "runtime.json").read_text()).get("runtime") != rt:
            sys.exit(f"{a.runtime_zip} is not runtime {rt}")
    else:
        rdir = build_runtime(work, a.python_zip, a.wheels, rt)
        rt_entries = [("runtime/" + p.relative_to(rdir).as_posix(), p) for p in sorted(rdir.rglob("*")) if p.is_file()]
        write_zip(out / rt_name, rt_entries)
    remote["runtime_sha256"] = sha256(out / rt_name)
    rt_entries = [("runtime/" + p.relative_to(rdir).as_posix(), p) for p in sorted(rdir.rglob("*")) if p.is_file()]
    top = "TW-Editor/"
    write_zip(out / full_name, [(top + n, s) for n, s in code_entries] + [(top + n, s) for n, s in rt_entries])
    (out / "version.json").write_text(json.dumps(remote, indent=1))
    (out / "runtime-version.txt").write_text(rt)
    log(f"version {ver}, runtime {rt}, {len(files)} code files")


if __name__ == "__main__":
    main()
