// Draws the os mark and writes every icon Tauri asks for. Pure Node: no npm dependency, no
// rasteriser, no image library. The glyphs are geometry (a ring and two bowls), so the whole
// thing is a coverage function sampled 4x4 per pixel.
//
//   node src-tauri/icons/generate.mjs
//
// Outputs 32x32.png, 128x128.png, 128x128@2x.png, icon.png, icon.ico, icon.icns next to itself.
import { deflateSync } from 'node:zlib';
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));

const BG = [0xd9, 0x77, 0x57]; // terracotta
const FG = [0x1a, 0x19, 0x17]; // near-black ink

// ---------------------------------------------------------------- drawing

const TAU = Math.PI * 2;

/** Degrees in [0,360) measured clockwise from "east", y pointing down. */
const angleOf = (dx, dy) => ((Math.atan2(dy, dx) * 360) / TAU + 360) % 360;

const between = (t, a, b) => (t >= a && t <= b) || (t + 360 >= a && t + 360 <= b);

function markCoverage(n) {
  const stroke = 0.05 * n;
  const ro = 0.15 * n; // centreline radius of the o
  const rs = 0.075 * n; // centreline radius of each bowl of the s
  const half = stroke / 2;

  const wo = 2 * ro + stroke;
  const ws = 2 * rs + stroke;
  const gap = 0.03 * n;
  const left = (n - (wo + gap + ws)) / 2;
  const cy = n / 2;
  const ox = left + wo / 2;
  const sx = left + wo + gap + ws / 2;

  const onRing = (x, y, cx, cyy, r) => Math.abs(Math.hypot(x - cx, y - cyy) - r) <= half;

  return (x, y) => {
    if (onRing(x, y, ox, cy, ro)) return true;
    // Top bowl: a ~210 degree arc opening to the lower right.
    if (onRing(x, y, sx, cy - rs, rs) && between(angleOf(x - sx, y - (cy - rs)), 90, 310)) return true;
    // Bottom bowl: the same arc mirrored, opening to the upper left.
    if (onRing(x, y, sx, cy + rs, rs) && between(angleOf(x - sx, y - (cy + rs)), 270, 490)) return true;
    return false;
  };
}

/** RGBA pixels for one square icon. */
function render(n) {
  const inside = markCoverage(n);
  const out = Buffer.alloc(n * n * 4);
  const ss = 4;
  const step = 1 / ss;
  const offset = step / 2;

  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      let hits = 0;
      for (let sy = 0; sy < ss; sy++) {
        for (let sx = 0; sx < ss; sx++) {
          if (inside(x + offset + sx * step, y + offset + sy * step)) hits++;
        }
      }
      const a = hits / (ss * ss);
      const i = (y * n + x) * 4;
      out[i] = Math.round(BG[0] + (FG[0] - BG[0]) * a);
      out[i + 1] = Math.round(BG[1] + (FG[1] - BG[1]) * a);
      out[i + 2] = Math.round(BG[2] + (FG[2] - BG[2]) * a);
      out[i + 3] = 255;
    }
  }
  return out;
}

// ---------------------------------------------------------------- png

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[i] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function chunk(type, data) {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, 'latin1');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0);
  return Buffer.concat([head, data, crc]);
}

function png(n, rgba) {
  const stride = n * 4;
  const raw = Buffer.alloc((stride + 1) * n);
  for (let y = 0; y < n; y++) {
    raw[y * (stride + 1)] = 0; // filter: none
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(n, 0);
  ihdr.writeUInt32BE(n, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // truecolour with alpha
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ---------------------------------------------------------------- ico

/** A 32-bit bottom-up DIB with an empty AND mask: what Windows expects below 256px. */
function dib(n, rgba) {
  const header = Buffer.alloc(40);
  header.writeUInt32LE(40, 0);
  header.writeInt32LE(n, 4);
  header.writeInt32LE(n * 2, 8); // colour rows + mask rows
  header.writeUInt16LE(1, 12);
  header.writeUInt16LE(32, 14);
  header.writeUInt32LE(n * n * 4, 20);

  const pixels = Buffer.alloc(n * n * 4);
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      const src = ((n - 1 - y) * n + x) * 4;
      const dst = (y * n + x) * 4;
      pixels[dst] = rgba[src + 2];
      pixels[dst + 1] = rgba[src + 1];
      pixels[dst + 2] = rgba[src];
      pixels[dst + 3] = rgba[src + 3];
    }
  }
  const maskStride = Math.ceil(n / 32) * 4;
  return Buffer.concat([header, pixels, Buffer.alloc(maskStride * n)]);
}

function ico(images) {
  const head = Buffer.alloc(6);
  head.writeUInt16LE(1, 2);
  head.writeUInt16LE(images.length, 4);

  const dir = Buffer.alloc(16 * images.length);
  let offset = head.length + dir.length;
  const bodies = [];

  images.forEach(({ size, data }, i) => {
    const at = i * 16;
    dir[at] = size >= 256 ? 0 : size;
    dir[at + 1] = size >= 256 ? 0 : size;
    dir.writeUInt16LE(1, at + 4);
    dir.writeUInt16LE(32, at + 6);
    dir.writeUInt32LE(data.length, at + 8);
    dir.writeUInt32LE(offset, at + 12);
    offset += data.length;
    bodies.push(data);
  });

  return Buffer.concat([head, dir, ...bodies]);
}

// ---------------------------------------------------------------- icns

function icns(entries) {
  const blocks = entries.map(({ type, data }) => {
    const head = Buffer.alloc(8);
    head.write(type, 0, 'latin1');
    head.writeUInt32BE(data.length + 8, 4);
    return Buffer.concat([head, data]);
  });
  const body = Buffer.concat(blocks);
  const head = Buffer.alloc(8);
  head.write('icns', 0, 'latin1');
  head.writeUInt32BE(body.length + 8, 4);
  return Buffer.concat([head, body]);
}

// ---------------------------------------------------------------- write

const sizes = [16, 24, 32, 48, 64, 128, 256, 512, 1024];
const pixels = new Map(sizes.map((n) => [n, render(n)]));
const pngs = new Map(sizes.map((n) => [n, png(n, pixels.get(n))]));

const write = (name, buf) => {
  writeFileSync(join(HERE, name), buf);
  console.log(`${name}  ${(buf.length / 1024).toFixed(1)} kB`);
};

write('32x32.png', pngs.get(32));
write('128x128.png', pngs.get(128));
write('128x128@2x.png', pngs.get(256));
write('icon.png', pngs.get(1024));

write(
  'icon.ico',
  ico([
    { size: 16, data: dib(16, pixels.get(16)) },
    { size: 24, data: dib(24, pixels.get(24)) },
    { size: 32, data: dib(32, pixels.get(32)) },
    { size: 48, data: dib(48, pixels.get(48)) },
    { size: 64, data: dib(64, pixels.get(64)) },
    { size: 128, data: dib(128, pixels.get(128)) },
    { size: 256, data: pngs.get(256) },
  ]),
);

write(
  'icon.icns',
  icns([
    { type: 'ic07', data: pngs.get(128) },
    { type: 'ic08', data: pngs.get(256) },
    { type: 'ic09', data: pngs.get(512) },
    { type: 'ic10', data: pngs.get(1024) },
  ]),
);
