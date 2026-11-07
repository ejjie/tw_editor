// Teeworlds/DDNet datafile container (.map): items + zlib-compressed data blobs.
// Layout (v4): "DATA", version, size, swaplen, numItemTypes, numItems, numData, itemSize, dataSize,
// item types (type, start, num), item offsets, data offsets, data uncompressed sizes, items, data.

export async function inflate(bytes) {
  const ds = new DecompressionStream('deflate');
  const out = new Response(new Blob([bytes]).stream().pipeThrough(ds));
  return new Uint8Array(await out.arrayBuffer());
}

export async function deflate(bytes) {
  const cs = new CompressionStream('deflate');
  const out = new Response(new Blob([bytes]).stream().pipeThrough(cs));
  return new Uint8Array(await out.arrayBuffer());
}

// compress many blobs in a worker, so saving a big map does not stall the page (falls back to the page itself)
let worker = null, workerFailed = false, jobs = 0;
const waiting = new Map();
async function deflateAll(list) {
  if (!workerFailed && typeof Worker !== 'undefined') {
    try {
      if (!worker) {
        worker = new Worker(new URL('./deflate-worker.js', import.meta.url));
        worker.onmessage = (e) => { const w = waiting.get(e.data.id); waiting.delete(e.data.id); if (e.data.error) w.rej(new Error(e.data.error)); else w.res(e.data.out); };
        worker.onerror = () => { workerFailed = true; for (const w of waiting.values()) w.rej(new Error('worker failed')); waiting.clear(); };
      }
      const id = ++jobs;
      const copies = list.map((d) => d.slice()); // the originals stay with the map (tiles are edited in place)
      return await new Promise((res, rej) => {
        waiting.set(id, { res, rej });
        worker.postMessage({ id, blobs: copies }, copies.map((c) => c.buffer));
      });
    } catch (e) { workerFailed = true; console.warn('deflate worker:', e); }
  }
  const out = [];
  for (const d of list) out.push(await deflate(d));
  return out;
}

// Returns { items: [{type, id, ints: Int32Array}], data: [Uint8Array (uncompressed)] }
export async function readDatafile(buf) {
  const u8 = new Uint8Array(buf);
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  const magic = String.fromCharCode(u8[0], u8[1], u8[2], u8[3]);
  if (magic !== 'DATA' && magic !== 'ATAD') throw new Error('Not a .map file (no DATA header)');
  const i32 = (o) => dv.getInt32(o, true);
  const version = i32(4);
  if (version !== 3 && version !== 4) throw new Error('Unknown datafile version: ' + version);
  const numTypes = i32(16), numItems = i32(20), numData = i32(24), itemSize = i32(28), dataSize = i32(32);
  let p = 36;
  const types = [];
  for (let i = 0; i < numTypes; i++, p += 12) types.push({ type: i32(p), start: i32(p + 4), num: i32(p + 8) });
  const itemOffsets = [];
  for (let i = 0; i < numItems; i++, p += 4) itemOffsets.push(i32(p));
  const dataOffsets = [];
  for (let i = 0; i < numData; i++, p += 4) dataOffsets.push(i32(p));
  const dataSizes = [];
  if (version === 4) for (let i = 0; i < numData; i++, p += 4) dataSizes.push(i32(p));
  const itemsStart = p, dataStart = p + itemSize;

  const items = [];
  for (let i = 0; i < numItems; i++) {
    const o = itemsStart + itemOffsets[i];
    const key = dv.getUint32(o, true);
    const size = i32(o + 4);
    const ints = new Int32Array(size / 4);
    for (let k = 0; k < ints.length; k++) ints[k] = i32(o + 8 + k * 4);
    items.push({ type: key >>> 16, id: key & 0xffff, ints });
  }
  const data = [];
  for (let i = 0; i < numData; i++) {
    const start = dataStart + dataOffsets[i];
    const end = i + 1 < numData ? dataStart + dataOffsets[i + 1] : dataStart + dataSize;
    const raw = u8.slice(start, end);
    data.push(version === 4 ? await inflate(raw) : raw);
  }
  return { items, data };
}

// items: [{type, id, ints}], data: [Uint8Array] -> ArrayBuffer of a v4 datafile
export async function writeDatafile(items, data) {
  const sorted = [...items].sort((a, b) => a.type - b.type || a.id - b.id);
  const types = [];
  sorted.forEach((it, i) => {
    const last = types[types.length - 1];
    if (last && last.type === it.type) last.num++;
    else types.push({ type: it.type, start: i, num: 1 });
  });
  const comp = await deflateAll(data);
  const itemSize = sorted.reduce((s, it) => s + 8 + it.ints.length * 4, 0);
  const dataSize = comp.reduce((s, c) => s + c.length, 0);
  const headerSize = 36 + types.length * 12 + sorted.length * 4 + data.length * 8;
  const swapSize = headerSize + itemSize;
  const fileSize = swapSize + dataSize;
  const out = new Uint8Array(fileSize);
  const dv = new DataView(out.buffer);
  let p = 0;
  const w = (v) => { dv.setInt32(p, v, true); p += 4; };
  out.set([68, 65, 84, 65], 0); p = 4;
  [4, fileSize - 16, swapSize - 16, types.length, sorted.length, data.length, itemSize, dataSize].forEach(w);
  for (const t of types) { w(t.type); w(t.start); w(t.num); }
  let off = 0;
  for (const it of sorted) { w(off); off += 8 + it.ints.length * 4; }
  off = 0;
  for (const c of comp) { w(off); off += c.length; }
  for (const d of data) w(d.length);
  for (const it of sorted) {
    dv.setUint32(p, ((it.type << 16) | it.id) >>> 0, true); p += 4;
    w(it.ints.length * 4);
    for (const v of it.ints) w(v);
  }
  for (const c of comp) { out.set(c, p); p += c.length; }
  return out.buffer;
}

// Item names are packed 4 chars per int, each byte offset by 128, last byte zero.
export function intsToStr(ints) {
  // the last byte is always the terminator (DDNet IntsToStr ignores whatever is stored there)
  const bytes = [];
  outer: for (const v of ints) {
    for (let k = 3; k >= 0; k--) {
      if (bytes.length >= ints.length * 4 - 1) break outer;
      const b = (((v >>> (k * 8)) & 0xff) - 128) & 0xff;
      if (b === 0) break outer;
      bytes.push(b);
    }
  }
  return new TextDecoder().decode(new Uint8Array(bytes)).replace(/\uFFFD/g, '');
}

export function strToInts(s, n) {
  let b = Array.from(new TextEncoder().encode(s)).slice(0, n * 4 - 1);
  while (b.length < n * 4) b.push(0);
  const ints = [];
  for (let i = 0; i < n; i++) {
    let v = 0;
    for (let k = 0; k < 4; k++) v = (v << 8) | ((b[i * 4 + k] + 128) & 0xff);
    ints.push(v | 0);
  }
  ints[n - 1] = (ints[n - 1] & 0xffffff00) | 0;
  return ints;
}

export function cstr(bytes) {
  if (!bytes) return '';
  let end = bytes.indexOf(0);
  if (end < 0) end = bytes.length;
  return new TextDecoder().decode(bytes.subarray(0, end));
}

export function toCstr(s) {
  const e = new TextEncoder().encode(s);
  const out = new Uint8Array(e.length + 1);
  out.set(e);
  return out;
}
