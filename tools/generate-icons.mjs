import { writeFile } from "node:fs/promises";
import { deflateSync } from "node:zlib";

const sizes = [16, 48, 128];
const supersample = 4;

function renderPng(size) {
  const highSize = size * supersample;
  const high = createCanvas(highSize, highSize);
  const toPx = highSize / 128;

  drawRoundedRect(high, 0, 0, 128, 128, 28, (x, y) => {
    const t = (x * 0.45 + y * 0.55) / 128;
    return mixColor([59, 108, 255, 255], [0, 166, 214, 255], clamp01(t));
  }, toPx);

  const bracket = [236, 248, 255, 255];
  drawRoundLine(high, 26, 45, 26, 27, 8, bracket, toPx);
  drawRoundLine(high, 26, 27, 46, 27, 8, bracket, toPx);
  drawRoundLine(high, 82, 27, 102, 27, 8, bracket, toPx);
  drawRoundLine(high, 102, 27, 102, 45, 8, bracket, toPx);
  drawRoundLine(high, 102, 83, 102, 101, 8, bracket, toPx);
  drawRoundLine(high, 102, 101, 82, 101, 8, bracket, toPx);
  drawRoundLine(high, 46, 101, 26, 101, 8, bracket, toPx);
  drawRoundLine(high, 26, 101, 26, 83, 8, bracket, toPx);

  drawRoundedRect(high, 42, 29, 48, 80, 10, [6, 29, 82, 54], toPx);
  drawRoundedRect(high, 40, 24, 48, 80, 10, [247, 251, 255, 255], toPx);
  drawRoundedRect(high, 47, 35, 34, 8, 4, [26, 102, 232, 235], toPx);
  drawRoundedRect(high, 47, 50, 25, 6, 3, [112, 183, 255, 255], toPx);
  drawRoundedRect(high, 47, 62, 30, 6, 3, [112, 183, 255, 255], toPx);

  const arrow = [11, 191, 154, 255];
  drawRoundLine(high, 64, 75, 64, 90, 7, arrow, toPx);
  drawRoundLine(high, 56, 84, 64, 92, 7, arrow, toPx);
  drawRoundLine(high, 72, 84, 64, 92, 7, arrow, toPx);

  return encodePng(downsample(high, size, supersample));
}

function createCanvas(width, height) {
  return { width, height, data: new Uint8ClampedArray(width * height * 4) };
}

function drawRoundedRect(canvas, x, y, width, height, radius, color, scale) {
  const left = Math.floor((x - 1) * scale);
  const top = Math.floor((y - 1) * scale);
  const right = Math.ceil((x + width + 1) * scale);
  const bottom = Math.ceil((y + height + 1) * scale);

  for (let py = top; py < bottom; py++) {
    for (let px = left; px < right; px++) {
      if (px < 0 || py < 0 || px >= canvas.width || py >= canvas.height) continue;
      const lx = (px + 0.5) / scale;
      const ly = (py + 0.5) / scale;
      if (!insideRoundedRect(lx, ly, x, y, width, height, radius)) continue;
      blendPixel(canvas, px, py, typeof color === "function" ? color(lx, ly) : color);
    }
  }
}

function insideRoundedRect(px, py, x, y, width, height, radius) {
  const cx = clamp(px, x + radius, x + width - radius);
  const cy = clamp(py, y + radius, y + height - radius);
  const dx = px - cx;
  const dy = py - cy;
  return dx * dx + dy * dy <= radius * radius;
}

function drawRoundLine(canvas, x1, y1, x2, y2, width, color, scale) {
  const pad = width / 2 + 1;
  const left = Math.floor((Math.min(x1, x2) - pad) * scale);
  const top = Math.floor((Math.min(y1, y2) - pad) * scale);
  const right = Math.ceil((Math.max(x1, x2) + pad) * scale);
  const bottom = Math.ceil((Math.max(y1, y2) + pad) * scale);

  for (let py = top; py < bottom; py++) {
    for (let px = left; px < right; px++) {
      if (px < 0 || py < 0 || px >= canvas.width || py >= canvas.height) continue;
      const lx = (px + 0.5) / scale;
      const ly = (py + 0.5) / scale;
      if (distanceToSegment(lx, ly, x1, y1, x2, y2) <= width / 2) {
        blendPixel(canvas, px, py, color);
      }
    }
  }
}

function distanceToSegment(px, py, x1, y1, x2, y2) {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const len2 = dx * dx + dy * dy;
  const t = len2 === 0 ? 0 : clamp(((px - x1) * dx + (py - y1) * dy) / len2, 0, 1);
  const x = x1 + t * dx;
  const y = y1 + t * dy;
  return Math.hypot(px - x, py - y);
}

function blendPixel(canvas, x, y, color) {
  const i = (y * canvas.width + x) * 4;
  const sa = color[3] / 255;
  const da = canvas.data[i + 3] / 255;
  const oa = sa + da * (1 - sa);
  if (oa === 0) return;

  canvas.data[i] = Math.round((color[0] * sa + canvas.data[i] * da * (1 - sa)) / oa);
  canvas.data[i + 1] = Math.round((color[1] * sa + canvas.data[i + 1] * da * (1 - sa)) / oa);
  canvas.data[i + 2] = Math.round((color[2] * sa + canvas.data[i + 2] * da * (1 - sa)) / oa);
  canvas.data[i + 3] = Math.round(oa * 255);
}

function downsample(source, size, factor) {
  const target = createCanvas(size, size);
  const samples = factor * factor;

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      for (let sy = 0; sy < factor; sy++) {
        for (let sx = 0; sx < factor; sx++) {
          const si = (((y * factor + sy) * source.width) + (x * factor + sx)) * 4;
          r += source.data[si];
          g += source.data[si + 1];
          b += source.data[si + 2];
          a += source.data[si + 3];
        }
      }
      const ti = (y * size + x) * 4;
      target.data[ti] = Math.round(r / samples);
      target.data[ti + 1] = Math.round(g / samples);
      target.data[ti + 2] = Math.round(b / samples);
      target.data[ti + 3] = Math.round(a / samples);
    }
  }
  return target;
}

function encodePng(canvas) {
  const { width, height, data } = canvas;
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    const rowStart = y * (width * 4 + 1);
    raw[rowStart] = 0;
    Buffer.from(data.buffer, y * width * 4, width * 4).copy(raw, rowStart + 1);
  }

  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", Buffer.concat([
      uint32(width),
      uint32(height),
      Buffer.from([8, 6, 0, 0, 0]),
    ])),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

function chunk(type, data) {
  const typeBuffer = Buffer.from(type);
  return Buffer.concat([
    uint32(data.length),
    typeBuffer,
    data,
    uint32(crc32(Buffer.concat([typeBuffer, data]))),
  ]);
}

function uint32(value) {
  const buffer = Buffer.alloc(4);
  buffer.writeUInt32BE(value >>> 0);
  return buffer;
}

const crcTable = new Uint32Array(256).map((_, index) => {
  let c = index;
  for (let k = 0; k < 8; k++) {
    c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  }
  return c >>> 0;
});

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function mixColor(a, b, t) {
  return [
    Math.round(a[0] + (b[0] - a[0]) * t),
    Math.round(a[1] + (b[1] - a[1]) * t),
    Math.round(a[2] + (b[2] - a[2]) * t),
    Math.round(a[3] + (b[3] - a[3]) * t),
  ];
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function clamp01(value) {
  return clamp(value, 0, 1);
}

for (const size of sizes) {
  const png = renderPng(size);
  await writeFile(`icons/icon${size}.png`, png);
  console.log(`wrote icons/icon${size}.png`);
}
