// Compresses the data blobs of a .map off the page thread (see deflateAll in datafile.js).
self.onmessage = async (e) => {
  const { id, blobs } = e.data;
  try {
    const out = [];
    for (const b of blobs) {
      const s = new Blob([b]).stream().pipeThrough(new CompressionStream('deflate'));
      out.push(new Uint8Array(await new Response(s).arrayBuffer()));
    }
    self.postMessage({ id, out }, out.map((o) => o.buffer));
  } catch (err) {
    self.postMessage({ id, error: String(err) });
  }
};
