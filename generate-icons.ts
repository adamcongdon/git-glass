/**
 * Generates minimal but valid PNG icons using raw PNG binary construction.
 * Creates solid-color PNG files with a simple design.
 */
import { writeFile, mkdir } from "fs/promises";
import { join } from "path";
import { createHash } from "crypto";
import * as zlib from "zlib";
import { promisify } from "util";

const deflate = promisify(zlib.deflate);

// PNG signature
const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

function crc32(buf: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of buf) {
    crc ^= byte;
    for (let i = 0; i < 8; i++) {
      crc = (crc & 1) ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Buffer): Buffer {
  const typeBytes = Buffer.from(type, "ascii");
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const crcBuf = Buffer.concat([typeBytes, data]);
  const crcVal = Buffer.alloc(4);
  crcVal.writeUInt32BE(crc32(crcBuf), 0);
  return Buffer.concat([len, typeBytes, data, crcVal]);
}

async function createPNG(size: number): Promise<Buffer> {
  // IHDR: width, height, bitDepth=8, colorType=2(RGB), compression=0, filter=0, interlace=0
  const ihdrData = Buffer.alloc(13);
  ihdrData.writeUInt32BE(size, 0);
  ihdrData.writeUInt32BE(size, 4);
  ihdrData[8] = 8;   // bit depth
  ihdrData[9] = 2;   // color type: RGB
  ihdrData[10] = 0;  // compression
  ihdrData[11] = 0;  // filter
  ihdrData[12] = 0;  // interlace

  // Create image data: dark background #161b22 with a simple "F" mark
  const bg = { r: 22, g: 27, b: 34 };     // #161b22
  const fg = { r: 35, g: 134, b: 54 };    // #238636 (green accent)

  // Build raw pixel data row by row
  // Each row: filter byte (0 = None) + RGB pixels
  const rawData: number[] = [];

  const margin = Math.floor(size * 0.2);
  const barH = Math.max(2, Math.floor(size * 0.08));

  for (let y = 0; y < size; y++) {
    rawData.push(0); // filter type: None
    for (let x = 0; x < size; x++) {
      // Draw a simple "F" shape (feedback icon)
      const inMargin = x >= margin && x < size - margin && y >= margin && y < size - margin;
      const innerW = size - margin * 2;
      const innerH = size - margin * 2;
      const lx = x - margin;
      const ly = y - margin;

      let pixel = bg;

      if (inMargin) {
        // Vertical bar (left side of F)
        const vertBarW = Math.max(2, Math.floor(innerW * 0.2));
        const isVert = lx < vertBarW;

        // Top horizontal bar
        const isTop = ly < barH;

        // Middle horizontal bar (at ~40% height)
        const midY = Math.floor(innerH * 0.4);
        const isMid = ly >= midY && ly < midY + barH;

        // Mid bar only goes 70% width
        const isMidShort = lx < Math.floor(innerW * 0.7);

        if (isVert || isTop || (isMid && isMidShort)) {
          pixel = fg;
        }
      }

      rawData.push(pixel.r, pixel.g, pixel.b);
    }
  }

  const rawBuf = Buffer.from(rawData);
  const compressed = await deflate(rawBuf, { level: 6 });

  const idat = chunk("IDAT", compressed as Buffer);
  const iend = chunk("IEND", Buffer.alloc(0));
  const ihdr = chunk("IHDR", ihdrData);

  return Buffer.concat([PNG_SIGNATURE, ihdr, idat, iend]);
}

async function main() {
  const outDir = join(import.meta.dir, "public", "icons");
  await mkdir(outDir, { recursive: true });

  for (const size of [192, 512]) {
    const png = await createPNG(size);
    const outPath = join(outDir, `icon-${size}.png`);
    await writeFile(outPath, png);
    console.log(`Created ${outPath} (${png.length} bytes)`);
  }
}

main().catch(console.error);
