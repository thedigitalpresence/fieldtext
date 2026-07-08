/**
 * Generate FieldText app icons (green rounded square + white leaf) as PNGs
 * with zero dependencies — raw pixels + zlib + hand-rolled PNG chunks.
 * Usage: node scripts/gen-icons.js
 */
const fs = require("fs");
const path = require("path");
const zlib = require("zlib");

// CRC32 (PNG spec)
const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();
function crc32(buf) {
  let c = ~0;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return ~c >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}
function png(width, height, rgba) {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; ihdr[9] = 6; // 8-bit RGBA
  // raw scanlines with filter byte 0
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = 0;
    rgba.copy(raw, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4);
  }
  return Buffer.concat([sig, chunk("IHDR", ihdr), chunk("IDAT", zlib.deflateSync(raw, { level: 9 })), chunk("IEND", Buffer.alloc(0))]);
}

// Geometry in unit space (0..1), 4x supersampled for smooth edges.
const BG = [0x15, 0x80, 0x3d]; // brand green
function inRoundedRect(u, v, r) {
  const x = Math.min(u, 1 - u), y = Math.min(v, 1 - v);
  if (x >= r || y >= r) return u >= 0 && u <= 1 && v >= 0 && v <= 1;
  const dx = r - x, dy = r - y;
  return dx * dx + dy * dy <= r * r;
}
const dist2 = (u, v, cx, cy) => (u - cx) ** 2 + (v - cy) ** 2;
function inLeaf(u, v) {
  const R = 0.36 ** 2;
  const inA = dist2(u, v, 0.395, 0.575) <= R;
  const inB = dist2(u, v, 0.605, 0.365) <= R;
  return inA && inB;
}
function nearStem(u, v) {
  // segment from lower-left leaf tip outward
  const ax = 0.30, ay = 0.72, bx = 0.46, by = 0.55;
  const abx = bx - ax, aby = by - ay;
  const t = Math.max(0, Math.min(1, ((u - ax) * abx + (v - ay) * aby) / (abx * abx + aby * aby)));
  const px = ax + t * abx, py = ay + t * aby;
  return (u - px) ** 2 + (v - py) ** 2 <= 0.014 ** 2;
}
function render(size) {
  const S = 4; // supersample
  const rgba = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let bgHits = 0, leafHits = 0;
      for (let sy = 0; sy < S; sy++) {
        for (let sx = 0; sx < S; sx++) {
          const u = (x + (sx + 0.5) / S) / size;
          const v = (y + (sy + 0.5) / S) / size;
          if (inRoundedRect(u, v, 0.19)) {
            bgHits++;
            if (inLeaf(u, v) || nearStem(u, v)) leafHits++;
          }
        }
      }
      const total = S * S;
      const bgA = bgHits / total, leafA = leafHits / total;
      const i = (y * size + x) * 4;
      // composite: leaf(white) over bg(green) over transparent
      const r = 255 * leafA + BG[0] * (bgA - leafA);
      const g = 255 * leafA + BG[1] * (bgA - leafA);
      const b = 255 * leafA + BG[2] * (bgA - leafA);
      rgba[i] = bgA ? Math.round(r / bgA) : 0;
      rgba[i + 1] = bgA ? Math.round(g / bgA) : 0;
      rgba[i + 2] = bgA ? Math.round(b / bgA) : 0;
      rgba[i + 3] = Math.round(255 * bgA);
    }
  }
  return png(size, size, rgba);
}

const out = (name, size) => {
  const p = path.join(__dirname, "..", "src", "app", name);
  fs.writeFileSync(p, render(size));
  console.log("wrote", p, size + "px");
};
out("icon.png", 512);
out("apple-icon.png", 180);
