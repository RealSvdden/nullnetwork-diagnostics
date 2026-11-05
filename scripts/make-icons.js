'use strict';
// Generates assets/icon.png (256), tray.png and tray-alert.png (32) with no
// dependencies: a tiny PNG encoder + a supersampled software rasterizer.
// Run: npm run icons
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const OUT = path.join(__dirname, '..', 'assets');
const BLUE = [79, 140, 255];
const PINK = [255, 95, 162];
const NAVY = [16, 22, 36];

// --- PNG encoder -----------------------------------------------------------
const CRC = new Int32Array(256).map((_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; return c; });
function crc32(buf) { let c = -1; for (const b of buf) c = CRC[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ -1) >>> 0; }
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
function png(w, h, rgba) {
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) { raw[y * (w * 4 + 1)] = 0; rgba.copy(raw, y * (w * 4 + 1) + 1, y * w * 4, (y + 1) * w * 4); }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}

// --- geometry ----------------------------------------------------------------
function sdRoundRect(x, y, half, r) { const qx = Math.abs(x) - half + r, qy = Math.abs(y) - half + r; return Math.min(Math.max(qx, qy), 0) + Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) - r; }
function sdSegment(px, py, ax, ay, bx, by) {
  const vx = bx - ax, vy = by - ay, wx = px - ax, wy = py - ay;
  const t = Math.max(0, Math.min(1, (wx * vx + wy * vy) / (vx * vx + vy * vy)));
  return Math.hypot(px - (ax + t * vx), py - (ay + t * vy));
}
// Heartbeat/pulse line in unit space (0..1), matches the status ring in the UI.
const PULSE = [[0.14, 0.52], [0.36, 0.52], [0.44, 0.30], [0.55, 0.74], [0.63, 0.52], [0.86, 0.52]];
function sdPulse(u, v) { let d = Infinity; for (let i = 0; i < PULSE.length - 1; i++) d = Math.min(d, sdSegment(u, v, PULSE[i][0], PULSE[i][1], PULSE[i + 1][0], PULSE[i + 1][1])); return d; }

function render(size, { ss = 4, alert = false, badge = false } = {}) {
  const out = Buffer.alloc(size * size * 4);
  const half = 0.5, radius = 0.23, stroke = 0.075;
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    let r = 0, g = 0, b = 0, a = 0;
    for (let sy = 0; sy < ss; sy++) for (let sx = 0; sx < ss; sx++) {
      const u = (x + (sx + 0.5) / ss) / size, v = (y + (sy + 0.5) / ss) / size;
      const d = sdRoundRect(u - 0.5, v - 0.5, half - 0.02, radius);
      if (d > 0) continue;
      // gradient: blue top-left -> pink bottom-right
      const t = Math.min(1, Math.max(0, (u + v) / 2));
      let cr = NAVY[0] * 0.15 + (BLUE[0] * (1 - t) + PINK[0] * t) * 0.85;
      let cg = NAVY[1] * 0.15 + (BLUE[1] * (1 - t) + PINK[1] * t) * 0.85;
      let cb = NAVY[2] * 0.15 + (BLUE[2] * (1 - t) + PINK[2] * t) * 0.85;
      if (alert) { cr = PINK[0]; cg = PINK[1] * 0.75; cb = PINK[2] * 0.85; }
      const pd = sdPulse(u, v);
      if (pd < stroke / 2) { cr = 255; cg = 255; cb = 255; }
      if (badge) { const bd = Math.hypot(u - 0.80, v - 0.20); if (bd < 0.17) { cr = 255; cg = 255; cb = 255; } if (bd < 0.13) { cr = PINK[0]; cg = PINK[1]; cb = PINK[2]; } }
      r += cr; g += cg; b += cb; a += 255;
    }
    const n = ss * ss, cov = a / n;
    const i = (y * size + x) * 4;
    if (cov > 0) { const k = a / 255; out[i] = Math.round(r / k); out[i + 1] = Math.round(g / k); out[i + 2] = Math.round(b / k); out[i + 3] = Math.round(cov); }
  }
  return png(size, size, out);
}

fs.mkdirSync(OUT, { recursive: true });
fs.writeFileSync(path.join(OUT, 'icon.png'), render(256));
fs.writeFileSync(path.join(OUT, 'tray.png'), render(32, { ss: 6 }));
fs.writeFileSync(path.join(OUT, 'tray-alert.png'), render(32, { ss: 6, badge: true }));
console.log('icons written to', OUT);
