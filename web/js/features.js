// Optional features ("modules"). The core editor (map, layers, tiles, quads, envelopes, images, sounds, undo) works
// without any of them. Each module is one file with a setup(ed) function that plugs it into the editor.
//
// To remove a module: delete its line below (or just delete its file: a missing file is skipped with a note in the
// browser console). Its buttons and menu items in index.html carry data-feature="<id>" and disappear by themselves.
// What else belongs to a module (server side, data folders) is listed in README.md, section "Modules".
export const MODULES = [
  { id: 'palette', file: './palette.js' },         // colour palette at the top of the right panel
  { id: 'colorpicker', file: './colorpicker.js' }, // own colour picker window (without it: the browser's picker)
  { id: 'tilenumbers', file: './tilenumbers.js' }, // tele / switch / tune numbers and speedup arrows on the map
  { id: 'gores', file: './gores.js' },             // Gores mode (G): freeze ring around hookable tiles
  { id: 'pen', file: './pen.js' },                 // quad pen (D)
  { id: 'timeline', file: './timeline.js' },       // timeline with keys (K)
  { id: 'design', file: './design.js' },           // Design it! (right click on the Game layer)
  // { id: 'rulesmaker', file: './rulesmaker.js' }, // Rules maker (paused; uncomment to turn on): paint a design, get a .rules file (uses ruleslearn.js)
  { id: 'quadart', file: './quadart.js' },         // Quad art from image (needs quadart.py + img2quads.py)
  { id: 'tileart', file: './tileart.js' },         // Tile art from image
  { id: 'filedialog', file: './filedialog.js' },   // own Open / Save window that reaches AppData (needs filebrowser.py)
  { id: 'testmap', file: './testmap.js' },         // Test map on a local DDNet server (needs testserver.py)
];

// Switches inside modules. Turning one off hides it without touching the rest of the editor.
export const FEATURES = {
  penFill: true, // quad pen "Fill" (pen-fill.js); without pen-fill.js it is off anyway
};
