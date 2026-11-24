// Renders the StocksWorks icon (diamond + chart line on a rounded tile) to build/icon.png and a multi-size build/icon.ico.
// Pure Node: analytic shapes, 4x4 supersampling, PNG via zlib, ICO with PNG-compressed entries (Windows Vista+).
import fs from 'node:fs';
import zlib from 'node:zlib';

const BG = [11, 18, 32], MINT = [62, 224, 161], INK = [11, 18, 32];
const clamp = (x) => Math.max(0, Math.min(1, x));

function sdRoundBox(x, y, half, r) { // signed distance to a rounded square centered at 0.5
  const qx = Math.abs(x - 0.5) - half + r, qy = Math.abs(y - 0.5) - half + r;
  return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - r;
}
function distSeg(px, py, ax, ay, bx, by) {
  const t = clamp(((px - ax) * (bx - ax) + (py - ay) * (by - ay)) / ((bx - ax) ** 2 + (by - ay) ** 2));
  return Math.hypot(px - (ax + t * (bx - ax)), py - (ay + t * (by - ay)));
}
const LINE = [[0.29, 0.6], [0.43, 0.46], [0.53, 0.56], [0.72, 0.37]];

function shade(u, v) { // returns [r,g,b,a] for one subsample
  if (sdRoundBox(u, v, 0.47, 0.13) > 0) return [0, 0, 0, 0];
  let c = BG;
  if (Math.abs(u - 0.5) + Math.abs(v - 0.5) <= 0.36) c = MINT;
  let d = Infinity;
  for (let i = 0; i < LINE.length - 1; i++) d = Math.min(d, distSeg(u, v, ...LINE[i], ...LINE[i + 1]));
  if (d <= 0.035 && Math.abs(u - 0.5) + Math.abs(v - 0.5) <= 0.36) c = INK;
  return [...c, 255];
}

function render(size) {
  const S = 4, px = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const acc = [0, 0, 0, 0];
    for (let sy = 0; sy < S; sy++) for (let sx = 0; sx < S; sx++) {
      const c = shade((x + (sx + 0.5) / S) / size, (y + (sy + 0.5) / S) / size);
      acc[0] += c[0] * c[3]; acc[1] += c[1] * c[3]; acc[2] += c[2] * c[3]; acc[3] += c[3];
    }
    const a = acc[3], i = (y * size + x) * 4;
    px[i] = a ? Math.round(acc[0] / a) : 0; px[i + 1] = a ? Math.round(acc[1] / a) : 0; px[i + 2] = a ? Math.round(acc[2] / a) : 0;
    px[i + 3] = Math.round(a / (S * S));
  }
  return px;
}

function png(size, rgba) {
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(zlib.crc32(td) >>> 0);
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4); ihdr[8] = 8; ihdr[9] = 6; // 8-bit RGBA
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) { raw[y * (size * 4 + 1)] = 0; rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4); }
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}

const sizes = [256, 128, 64, 48, 32, 24, 16];
const pngs = sizes.map((s) => png(s, render(s)));
fs.mkdirSync('build', { recursive: true });
fs.writeFileSync('build/icon.png', pngs[0]);

const header = Buffer.alloc(6); header.writeUInt16LE(0, 0); header.writeUInt16LE(1, 2); header.writeUInt16LE(sizes.length, 4);
let offset = 6 + 16 * sizes.length;
const entries = sizes.map((s, i) => {
  const e = Buffer.alloc(16);
  e[0] = s === 256 ? 0 : s; e[1] = s === 256 ? 0 : s; e.writeUInt16LE(1, 4); e.writeUInt16LE(32, 6);
  e.writeUInt32LE(pngs[i].length, 8); e.writeUInt32LE(offset, 12); offset += pngs[i].length;
  return e;
});
fs.writeFileSync('build/icon.ico', Buffer.concat([header, ...entries, ...pngs]));
console.log(`build/icon.png (256px) + build/icon.ico (${sizes.join(', ')}px)`);
