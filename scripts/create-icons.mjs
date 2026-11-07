// Deterministic rasterization of assets/icon.svg's rounded shapes; no external tools.
import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
const table = Array.from({ length: 256 }, (_, n) => {
  for (let i = 0; i < 8; i++) n = n & 1 ? 0xedb88320 ^ (n >>> 1) : n >>> 1;
  return n >>> 0;
});
const chunk = (type, data) => {
  const body = Buffer.concat([Buffer.from(type), data]);
  let crc = 0xffffffff;
  for (const byte of body) crc = table[(crc ^ byte) & 255] ^ (crc >>> 8);
  const head = Buffer.alloc(4),
    tail = Buffer.alloc(4);
  head.writeUInt32BE(data.length);
  tail.writeUInt32BE((crc ^ 0xffffffff) >>> 0);
  return Buffer.concat([head, body, tail]);
};
const inside = (x, y, cx, cy, w, h, r, angle = 0) => {
  const a = (-angle * Math.PI) / 180,
    dx = x - cx,
    dy = y - cy;
  const qx = Math.abs(dx * Math.cos(a) - dy * Math.sin(a)) - w / 2 + r;
  const qy = Math.abs(dx * Math.sin(a) + dy * Math.cos(a)) - h / 2 + r;
  return (
    Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) +
      Math.min(Math.max(qx, qy), 0) <=
    r
  );
};
function png(size) {
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++)
    for (let x = 0; x < size; x++) {
      let alpha = 0,
        red = 0,
        green = 0,
        blue = 0;
      for (const sx of [0.25, 0.75])
        for (const sy of [0.25, 0.75]) {
          const px = ((x + sx) / size) * 1024,
            py = ((y + sy) / size) * 1024;
          if (!inside(px, py, 512, 512, 896, 896, 194)) continue;
          const logo =
            inside(px, py, 512, 340, 420, 134, 67, -35) ||
            inside(px, py, 500, 510, 380, 134, 67, -35) ||
            inside(px, py, 415, 670, 230, 134, 67, -35);
          alpha++;
          red += logo ? 181 : 25;
          green += logo ? 212 : 62;
          blue += logo ? 167 : 53;
        }
      const i = y * (size * 4 + 1) + 1 + x * 4;
      if (alpha) {
        raw[i] = red / alpha;
        raw[i + 1] = green / alpha;
        raw[i + 2] = blue / alpha;
        raw[i + 3] = (alpha / 4) * 255;
      }
    }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size);
  header.writeUInt32BE(size, 4);
  header[8] = 8;
  header[9] = 6;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}
mkdirSync('assets', { recursive: true });
writeFileSync('assets/icon.png', png(1024));
if (process.platform === 'darwin') {
  const directory = 'assets/Fluid.iconset';
  mkdirSync(directory, { recursive: true });
  for (const size of [16, 32, 128, 256, 512]) {
    writeFileSync(`${directory}/icon_${size}x${size}.png`, png(size));
    writeFileSync(`${directory}/icon_${size}x${size}@2x.png`, png(size * 2));
  }
  execFileSync('iconutil', ['-c', 'icns', directory, '-o', 'assets/icon.icns']);
  rmSync(directory, { recursive: true });
}
