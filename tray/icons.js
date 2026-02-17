'use strict';

const zlib = require('zlib');
const { nativeImage } = require('electron');

function crc32(buf) {
  let crc = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) {
    crc ^= buf[i];
    for (let j = 0; j < 8; j++) crc = (crc >>> 1) ^ (crc & 1 ? 0xEDB88320 : 0);
  }
  return (crc ^ 0xFFFFFFFF) >>> 0;
}

function pngChunk(type, data) {
  const typeBuf = Buffer.from(type, 'ascii');
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([typeBuf, data]);
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crcBuf]);
}

function createCirclePng(r, g, b, size) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 6; // 8-bit RGBA

  const raw = Buffer.alloc((1 + size * 4) * size, 0);
  const cx = (size - 1) / 2, cy = (size - 1) / 2;
  const outerR = size / 2 - 1, innerR = outerR - 1;

  for (let y = 0; y < size; y++) {
    const rowOff = y * (1 + size * 4);
    for (let x = 0; x < size; x++) {
      const px = rowOff + 1 + x * 4;
      const dist = Math.sqrt((x - cx) ** 2 + (y - cy) ** 2);
      if (dist <= innerR) {
        raw[px] = r; raw[px + 1] = g; raw[px + 2] = b; raw[px + 3] = 255;
      } else if (dist <= outerR) {
        const alpha = Math.round(255 * (1 - (dist - innerR)));
        raw[px] = r; raw[px + 1] = g; raw[px + 2] = b; raw[px + 3] = alpha;
      }
    }
  }

  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  return Buffer.concat([
    sig,
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', zlib.deflateSync(raw)),
    pngChunk('IEND', Buffer.alloc(0))
  ]);
}

function createIcon(r, g, b) {
  const png1x = createCirclePng(r, g, b, 16);
  return nativeImage.createFromBuffer(png1x, { width: 16, height: 16 });
}

module.exports = {
  green:  () => createIcon(76, 175, 80),
  yellow: () => createIcon(255, 193, 7),
  red:    () => createIcon(244, 67, 54),
};
