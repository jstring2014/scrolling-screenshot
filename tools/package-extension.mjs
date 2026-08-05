import { mkdir, readFile, writeFile } from "node:fs/promises";

const runtimeFiles = [
  "manifest.json",
  "background.js",
  "popup.html",
  "popup.js",
  "viewer.html",
  "viewer.js",
  "i18n.js",
  "_locales/zh_CN/messages.json",
  "_locales/en/messages.json",
  "icons/icon16.png",
  "icons/icon48.png",
  "icons/icon128.png",
];

const manifest = JSON.parse(await readFile("manifest.json", "utf8"));
const name = `scrolling-screenshot-${manifest.version}.zip`; // same package for Chrome and Edge
const output = `dist/${name}`;

async function createZip(files) {
  const localParts = [];
  const centralParts = [];
  let offset = 0;

  for (const path of files) {
    const data = await readFile(path);
    const nameBytes = Buffer.from(path.replace(/\\/g, "/"));
    const crc = crc32(data);

    const localHeader = Buffer.concat([
      uint32(0x04034b50),
      uint16(20),
      uint16(0),
      uint16(0),
      uint16(0),
      uint16(0),
      uint32(crc),
      uint32(data.length),
      uint32(data.length),
      uint16(nameBytes.length),
      uint16(0),
      nameBytes,
    ]);

    const centralHeader = Buffer.concat([
      uint32(0x02014b50),
      uint16(20),
      uint16(20),
      uint16(0),
      uint16(0),
      uint16(0),
      uint16(0),
      uint32(crc),
      uint32(data.length),
      uint32(data.length),
      uint16(nameBytes.length),
      uint16(0),
      uint16(0),
      uint16(0),
      uint16(0),
      uint32(0),
      uint32(offset),
      nameBytes,
    ]);

    localParts.push(localHeader, data);
    centralParts.push(centralHeader);
    offset += localHeader.length + data.length;
  }

  const central = Buffer.concat(centralParts);
  const end = Buffer.concat([
    uint32(0x06054b50),
    uint16(0),
    uint16(0),
    uint16(files.length),
    uint16(files.length),
    uint32(central.length),
    uint32(offset),
    uint16(0),
  ]);

  return Buffer.concat([...localParts, central, end]);
}

function uint16(value) {
  const buffer = Buffer.alloc(2);
  buffer.writeUInt16LE(value);
  return buffer;
}

function uint32(value) {
  const buffer = Buffer.alloc(4);
  buffer.writeUInt32LE(value >>> 0);
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

await mkdir("dist", { recursive: true });
await writeFile(output, await createZip(runtimeFiles));
console.log(`wrote ${output}`);
