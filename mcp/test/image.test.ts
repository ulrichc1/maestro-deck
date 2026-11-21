import { deflateSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { defaultExec, fitImage, pngSize, type DeviceCtx } from "../src/devicetools.js";

function crc32(buf: Buffer): number {
  let c = ~0;
  for (const b of buf) {
    c ^= b;
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c >>> 0;
}
function chunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}
/** A real, valid RGBA PNG of one flat colour with some noise, so it does not compress to nothing. */
function makePng(width: number, height: number): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const row = Buffer.alloc(1 + width * 4);
  const raw = Buffer.alloc(row.length * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const o = y * row.length + 1 + x * 4;
      raw[o] = (x * 7 + y * 3) & 255;
      raw[o + 1] = (x + y * 5) & 255;
      raw[o + 2] = 120;
      raw[o + 3] = 255;
    }
  }
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}

const ctx = (exec = defaultExec): DeviceCtx => ({ adbBin: "adb", maestroBin: "maestro", emulatorBin: "emulator", logDir: "/tmp", exec });

describe("pngSize", () => {
  it("reads the dimensions from the header", () => {
    expect(pngSize(makePng(300, 120))).toEqual({ width: 300, height: 120 });
  });
  it("returns null for anything that is not a PNG", () => {
    expect(pngSize(Buffer.from("not an image at all, just text"))).toBeNull();
    expect(pngSize(Buffer.alloc(3))).toBeNull();
  });
});

describe("fitImage", () => {
  it("leaves a small image, or maxDim 0, untouched", async () => {
    const png = makePng(200, 100);
    expect(await fitImage(png, 1600, ctx())).toBe(png);
    expect(await fitImage(makePng(2000, 100), 0, ctx())).toHaveLength(makePng(2000, 100).length);
  });
  it("falls back to the original when the resize tool fails", async () => {
    const png = makePng(1000, 400);
    const failing = async () => ({ stdout: Buffer.alloc(0), stderr: "boom", code: 1 });
    expect(await fitImage(png, 300, ctx(failing))).toBe(png);
    const missing = async () => {
      throw new Error("spawn sips ENOENT");
    };
    expect(await fitImage(png, 300, ctx(missing))).toBe(png);
  });
  it.runIf(process.platform === "darwin")("shrinks a large image with sips, keeping the aspect ratio", async () => {
    const png = makePng(2000, 800);
    const small = await fitImage(png, 500, ctx());
    const size = pngSize(small)!;
    expect(size.width).toBe(500);
    expect(size.height).toBe(200);
    expect(small.length).toBeLessThan(png.length);
  });
});
