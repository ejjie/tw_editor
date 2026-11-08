<div align="center">

# TW Editor

**A fast, modern DDNet map editor that runs in your browser.**

Open your `.map`, draw, press Ctrl+S, and it is saved back into the same file.
On top of everything the DDNet editor does, it can design a whole map for you, turn pictures into quad art,
animate quads with keys and test the map on a local server in one click.

![TW Editor with a map drawn by Design it!](docs/screenshots/editor.png)

[Quick start](#quick-start) · [Modules](#modules) · [For developers](#for-developers)

</div>

---

## Quick start

### Portable (nothing to install)

1. Download `tw-editor-<version>-win64.zip` from [Releases](../../releases) and unpack it anywhere.
2. Double-click **`start.bat`**. Python and every module are already inside (`runtime\`).
3. The editor opens in your browser at `http://localhost:8765`.

The portable build updates itself: on every start it checks the latest release and downloads only the changed code
(1 to 2 MB). The large runtime is downloaded again only when the Python modules change. Your settings, rules and the
local test server are never touched. Turn updates off with `"auto_update": false` in `config.json` or `start.bat --no-update`.

### From source

1. Install [Python 3](https://www.python.org/downloads/) and tick **"Add python.exe to PATH"**.
2. Clone or download this repository and double-click **`start.bat`**.
   The first start installs the quad art modules (numpy, pillow, opencv, mapbox-earcut, scipy).
3. Or run it by hand: `python editor.py` (`--port 9000`, `--no-browser`, `--keep-running`).

> **Use Chrome or Edge.** There Ctrl+S writes straight back into the opened `.map` file. Firefox downloads the map instead.

The editor finds your DDNet installation by itself (Steam too) and takes the standard mapres, entities and automapper
rules from it. Without DDNet installed they are downloaded once from DDNet's GitHub into `cache/`. Another game folder
can be set in **Edit → Editor settings**.

If port 8765 is taken, the editor picks the next free one and remembers it, so the address (and with it the browser's
palette and autosave) stays the same every time. Closing the last editor tab stops the editor about 8 seconds later.

---

## Modules

The core editor (open and save, groups and layers, tiles, quads, sounds, envelopes, images, automapper, undo, session
restore) works on its own. Every extra feature is a **module**: one file in `web/js/` with a `setup(ed)` function, listed
in [`web/js/features.js`](web/js/features.js). Delete its line (or its file) and its buttons disappear; the rest keeps working.

| id | What | Files | Server side |
|---|---|---|---|
| `palette` | Colour palette | `palette.js` | |
| `colorpicker` | Own colour picker window | `colorpicker.js` | |
| `tilenumbers` | Tele / switch / tune numbers, speedup arrows | `tilenumbers.js` | |
| `gores` | Gores mode (G) | `gores.js` | |
| `pen` | Quad pen (D) and its Fill | `pen.js`, `pen-fill.js` | |
| `timeline` | Timeline with keys (K) | `timeline.js` | |
| `design` | Design it! | `design.js`, `web/presets/` | `extra-data/`, `styles/`, `tools/tilestyle.py` |
| `quadart` | Quad art from an image | `quadart.js` | `quadart.py`, `img2quads.py` |
| `tileart` | Tile art from an image | `tileart.js` | |
| `filedialog` | Own Open / Save window | `filedialog.js` | `filebrowser.py` |
| `testmap` | Test map on a local server | `testmap.js` | `testserver.py`, `ddnet-server/` |

`editor.py` also starts without the optional Python files; their endpoints then answer with a short error. A new module
plugs in through the hook lists in `ed.ext` (see the Editor constructor in `web/js/editor.js`): commands, keys, overlays,
tile edits, bottom tabs, layer menu buttons and save targets.

---

## For developers

```
editor.py          local server: serves web/, DDNet data, quad art, rules, file browser
web/               the editor itself (plain ES modules, no build step)
  js/main.js       start-up and modules        js/map.js        .map format
  js/render.js     WebGL renderer              js/editor.js     tools
  js/panels.js     panels                      js/automapper.js DDNet automapper
extra-data/        tilesets and .rules that are not part of DDNet
tools/             command line tools (tilestyle, twmap)
portable/build.py  builds the portable Windows zip
update.py          self-update of the portable build
```

**Making a release**: push a tag like `v1.0.0` (or run *Actions → Release* by hand). The workflow builds the portable
zip, the code-only zip for updates and `version.json`, and publishes them as a GitHub release. The Python runtime gets
its own release and is rebuilt only when `portable/requirements.txt` or the Python version change.

---

<div align="center">

Made for the DDNet community. Maps made with TW Editor are plain DDNet maps and open in the official editor.

</div>
