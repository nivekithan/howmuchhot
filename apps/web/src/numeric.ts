/** Decode our grayscale 16-bit PNG without the browser's lossy 8-bit image conversion. */
export async function decodeTile(buffer: ArrayBuffer): Promise<Uint8Array> {
  const view = new DataView(buffer);
  if (view.getUint32(0) !== 0x89504e47 || view.getUint32(4) !== 0x0d0a1a0a)
    throw new Error("Invalid numeric tile PNG");
  const chunks: ArrayBuffer[] = [];
  let width = 0;
  let height = 0;
  for (let offset = 8; offset < buffer.byteLength;) {
    const length = view.getUint32(offset);
    const type = view.getUint32(offset + 4);
    if (type === 0x49484452) {
      width = view.getUint32(offset + 8);
      height = view.getUint32(offset + 12);
      if (
        width !== 256 ||
        height !== 256 ||
        view.getUint8(offset + 16) !== 16 ||
        view.getUint8(offset + 17) !== 0 ||
        view.getUint8(offset + 20) !== 0
      )
        throw new Error("Unsupported numeric tile encoding");
    }
    if (type === 0x49444154) chunks.push(buffer.slice(offset + 8, offset + 8 + length));
    offset += length + 12;
  }
  if (!width || !chunks.length) throw new Error("Incomplete numeric tile");
  const stream = new Blob(chunks).stream().pipeThrough(new DecompressionStream("deflate"));
  const filtered = new Uint8Array(await new Response(stream).arrayBuffer());
  const stride = width * 2;
  if (filtered.length !== (stride + 1) * height) throw new Error("Truncated numeric tile");
  const output = new Uint8Array(stride * height);
  for (let y = 0; y < height; y++) {
    const filter = filtered[y * (stride + 1)]!;
    if (filter > 4) throw new Error("Unsupported PNG filter");
    for (let x = 0; x < stride; x++) {
      const index = y * stride + x;
      const left = x >= 2 ? output[index - 2]! : 0;
      const above = y ? output[index - stride]! : 0;
      const corner = y && x >= 2 ? output[index - stride - 2]! : 0;
      let predictor = 0;
      if (filter === 1) predictor = left;
      if (filter === 2) predictor = above;
      if (filter === 3) predictor = Math.floor((left + above) / 2);
      if (filter === 4) {
        const p = left + above - corner;
        const a = Math.abs(p - left),
          b = Math.abs(p - above),
          c = Math.abs(p - corner);
        predictor = a <= b && a <= c ? left : b <= c ? above : corner;
      }
      output[index] = filtered[y * (stride + 1) + x + 1]! + predictor;
    }
  }
  return output; // Big-endian high/low bytes, uploaded as two texture channels.
}
