// Generates assets/icon.png (256x256) and assets/icon.ico without external tools.
import fs from 'node:fs';
import zlib from 'node:zlib';

const S = 256;
const px = Buffer.alloc(S * S * 4);
const hex = h => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
function blend(x, y, [r, g, b], a = 1) {
  if (x < 0 || y < 0 || x >= S || y >= S) return;
  const i = (y * S + x) * 4;
  const A = px[i + 3] / 255;
  const outA = a + A * (1 - a);
  px[i] = Math.round((r * a + px[i] * A * (1 - a)) / (outA || 1));
  px[i + 1] = Math.round((g * a + px[i + 1] * A * (1 - a)) / (outA || 1));
  px[i + 2] = Math.round((b * a + px[i + 2] * A * (1 - a)) / (outA || 1));
  px[i + 3] = Math.round(outA * 255);
}
// anti-aliased rounded rectangle
function rrect(x0, y0, x1, y1, rad, color) {
  const c = hex(color);
  for (let y = Math.floor(y0); y < Math.ceil(y1); y++) for (let x = Math.floor(x0); x < Math.ceil(x1); x++) {
    const cx = Math.min(Math.max(x + 0.5, x0 + rad), x1 - rad);
    const cy = Math.min(Math.max(y + 0.5, y0 + rad), y1 - rad);
    const d = Math.hypot(x + 0.5 - cx, y + 0.5 - cy);
    const a = Math.max(0, Math.min(1, rad - d + 0.5));
    if (a > 0) blend(x, y, c, a);
  }
}
function circle(cx, cy, r, color) { rrect(cx - r, cy - r, cx + r, cy + r, r, color); }

rrect(8, 8, 248, 248, 52, '#fdbc00');          // amber tile (v1 table header colour)
rrect(40, 52, 216, 212, 16, '#ffffff');         // white card
rrect(40, 52, 216, 84, 16, '#3c4043');          // header strip
rrect(40, 70, 216, 84, 0, '#3c4043');
const rows = ['#ff9393', '#ffdf93', '#abff93'];
rows.forEach((c, i) => {
  const y = 98 + i * 36;
  rrect(54, y, 202, y + 26, 6, c);
  circle(70, y + 13, 7, i === 0 ? '#58ddc6' : '#ffffff');
  rrect(86, y + 9, 86 + 70 + (2 - i) * 18, y + 17, 4, '#5f6368');
});

function crc32(buf) {
  let c, crc = 0xffffffff;
  for (let n = 0; n < buf.length; n++) {
    c = (crc ^ buf[n]) & 0xff;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crc = (crc >>> 8) ^ c;
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
const raw = Buffer.alloc((S * 4 + 1) * S);
for (let y = 0; y < S; y++) { raw[y * (S * 4 + 1)] = 0; px.copy(raw, y * (S * 4 + 1) + 1, y * S * 4, (y + 1) * S * 4); }
const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(S, 0); ihdr.writeUInt32BE(S, 4); ihdr[8] = 8; ihdr[9] = 6;
const png = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
fs.writeFileSync('assets/icon.png', png);
// ICO container with the PNG embedded (supported since Windows Vista)
const hdr = Buffer.alloc(6); hdr.writeUInt16LE(0, 0); hdr.writeUInt16LE(1, 2); hdr.writeUInt16LE(1, 4);
const ent = Buffer.alloc(16); ent[0] = 0; ent[1] = 0; ent[2] = 0; ent[3] = 0; ent.writeUInt16LE(1, 4); ent.writeUInt16LE(32, 6); ent.writeUInt32LE(png.length, 8); ent.writeUInt32LE(22, 12);
fs.writeFileSync('assets/icon.ico', Buffer.concat([hdr, ent, png]));
console.log('icon written', png.length, 'bytes');
