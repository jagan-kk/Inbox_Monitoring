/**
 * Generates the PWA icons with no dependencies.
 * Draws the Ricky mark (dark rounded tile + green "R") and writes PNGs.
 *
 *   node tools/make-icons.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

const OUT = path.join(import.meta.dirname, '..', 'public', 'app', 'icons');
fs.mkdirSync(OUT, { recursive: true });

/* ------------------------------------------------------------------ PNG --- */

const crcTable = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buffer) {
  let c = -1;
  for (let i = 0; i < buffer.length; i += 1) c = crcTable[(c ^ buffer[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const name = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([name, data])));
  return Buffer.concat([length, name, data, crc]);
}

function encodePng(width, height, rgba) {
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y += 1) {
    raw[y * (stride + 1)] = 0;
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/* -------------------------------------------------------------- geometry --- */

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
const mix = (a, b, t) => a + (b - a) * t;

function sdRoundRect(x, y, cx, cy, hw, hh, r) {
  const qx = Math.abs(x - cx) - hw + r;
  const qy = Math.abs(y - cy) - hh + r;
  return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - r;
}

function sdSegment(x, y, ax, ay, bx, by) {
  const pax = x - ax;
  const pay = y - ay;
  const bax = bx - ax;
  const bay = by - ay;
  const h = Math.max(0, Math.min(1, (pax * bax + pay * bay) / (bax * bax + bay * bay)));
  return Math.hypot(pax - bax * h, pay - bay * h);
}

/** Distance to the "R" glyph, in 0..1 space. */
function sdGlyph(x, y) {
  const t = 0.05;
  const stem = sdSegment(x, y, 0.33, 0.235, 0.33, 0.765) - t;
  const bowlRing = Math.abs(Math.hypot(x - 0.455, y - 0.372) - 0.128) - t;
  const bowl = x >= 0.455 ? bowlRing : 1;
  const leg = sdSegment(x, y, 0.455, 0.5, 0.645, 0.765) - t;
  return Math.min(stem, bowl, leg);
}

/** Signed distance to the tile, in 0..1 space. */
const sdTile = (x, y) => sdRoundRect(x, y, 0.5, 0.5, 0.5, 0.5, 0.235);

/* ---------------------------------------------------------------- render --- */

function render(size, { maskable = false } = {}) {
  const rgba = Buffer.alloc(size * size * 4);
  const ss = 4; // supersampling grid per axis
  const glyphScale = maskable ? 0.78 : 1;

  for (let py = 0; py < size; py += 1) {
    for (let px = 0; px < size; px += 1) {
      const x = (px + 0.5) / size;
      const y = (py + 0.5) / size;

      // Tile coverage (full bleed for maskable icons).
      const tileAlpha = maskable ? 1 : clamp01(0.5 - (sdTile(x, y) * size) / 2);
      if (tileAlpha <= 0) {
        rgba[(py * size + px) * 4 + 3] = 0;
        continue;
      }

      // Base: deep navy vertical gradient with a soft green glow top-left.
      let r = mix(0x12, 0x06, y);
      let g = mix(0x1d, 0x0a, y);
      let b = mix(0x27, 0x0e, y);
      const glow = Math.max(0, 1 - Math.hypot(x - 0.16, y - 0.08) / 0.62) ** 2 * 0.5;
      r = mix(r, 124, glow * 0.42);
      g = mix(g, 243, glow * 0.42);
      b = mix(b, 160, glow * 0.42);

      // Glyph coverage (supersampled) and colour ramp.
      let hits = 0;
      for (let sy = 0; sy < ss; sy += 1) {
        for (let sx = 0; sx < ss; sx += 1) {
          const gx = (px + (sx + 0.5) / ss) / size;
          const gy = (py + (sy + 0.5) / ss) / size;
          // Scale the glyph around the tile centre for the maskable safe zone.
          const nx = 0.5 + (gx - 0.5) / glyphScale;
          const ny = 0.5 + (gy - 0.5) / glyphScale;
          if (sdGlyph(nx, ny) <= 0) hits += 1;
        }
      }
      const glyphAlpha = hits / (ss * ss);

      if (glyphAlpha > 0) {
        const ramp = clamp01((y - 0.2) / 0.6);
        const gr = mix(0xc6, 0x46, ramp);
        const gg = mix(0xff, 0xd9, ramp);
        const gb = mix(0xd8, 0x82, ramp);
        r = mix(r, gr, glyphAlpha);
        g = mix(g, gg, glyphAlpha);
        b = mix(b, gb, glyphAlpha);
      }

      // Hairline inner border for the non-maskable tile.
      if (!maskable) {
        const edge = Math.abs(sdTile(x, y) * size);
        const border = clamp01((1.1 - edge) / 1.6) * 0.12;
        r = mix(r, 235, border);
        g = mix(g, 245, border);
        b = mix(b, 255, border);
      }

      const i = (py * size + px) * 4;
      rgba[i] = Math.round(r);
      rgba[i + 1] = Math.round(g);
      rgba[i + 2] = Math.round(b);
      rgba[i + 3] = Math.round(tileAlpha * 255);
    }
  }

  return encodePng(size, size, rgba);
}

const targets = [
  ['icon-192.png', 192, {}],
  ['icon-512.png', 512, {}],
  ['icon-maskable-512.png', 512, { maskable: true }],
  ['apple-touch-icon.png', 180, { maskable: true }],
  ['favicon-32.png', 32, {}],
];

for (const [name, size, options] of targets) {
  const file = path.join(OUT, name);
  fs.writeFileSync(file, render(size, options));
  console.log(`wrote ${path.relative(process.cwd(), file)} (${size}px)`);
}

const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">
  <defs>
    <linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#c6ffd8"/><stop offset="1" stop-color="#46d982"/>
    </linearGradient>
  </defs>
  <rect width="64" height="64" rx="15" fill="#0b1118"/>
  <path d="M22 46V18h13a9 9 0 0 1 0 18h-6l11 10" fill="none" stroke="url(#g)" stroke-width="5.5" stroke-linecap="round" stroke-linejoin="round"/>
</svg>
`;
fs.writeFileSync(path.join(OUT, 'favicon.svg'), svg);
console.log('wrote public/app/icons/favicon.svg');
