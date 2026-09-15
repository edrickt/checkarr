import { describe, expect, it } from "vitest";
import { inflateSync, crc32 } from "node:zlib";
import { downsample, encodeIco, encodePng, renderIcon } from "../lib/icon.mjs";

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const pixelAt = (rgba, size, x, y) => {
  const i = (y * size + x) * 4;
  return [rgba[i], rgba[i + 1], rgba[i + 2], rgba[i + 3]];
};

/**
 * Parse a PNG the long way: walk the chunks, verify each CRC with the
 * platform's own crc32, then inflate the IDAT stream. This is an independent
 * read-back of the bytes (not the encoder's own bookkeeping).
 */
function decodePng(buffer) {
  expect(buffer.subarray(0, 8)).toEqual(PNG_SIGNATURE);
  const chunks = [];
  let offset = 8;
  while (offset < buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.toString("ascii", offset + 4, offset + 8);
    const data = buffer.subarray(offset + 8, offset + 8 + length);
    const storedCrc = buffer.readUInt32BE(offset + 8 + length);
    const computedCrc = crc32(buffer.subarray(offset + 4, offset + 8 + length));
    expect(storedCrc, `CRC of ${type}`).toBe(computedCrc);
    chunks.push({ type, data });
    offset += 12 + length;
  }
  expect(offset).toBe(buffer.length);
  const ihdr = chunks.find((c) => c.type === "IHDR");
  expect(ihdr).toBeDefined();
  const idat = Buffer.concat(chunks.filter((c) => c.type === "IDAT").map((c) => c.data));
  return {
    chunks,
    width: ihdr.data.readUInt32BE(0),
    height: ihdr.data.readUInt32BE(4),
    bitDepth: ihdr.data[8],
    colorType: ihdr.data[9],
    pixels: inflateSync(idat)
  };
}

describe("renderIcon", () => {
  const size = 64;

  it("draws an opaque rounded badge with transparent corners", () => {
    const rgba = renderIcon(size);
    expect(rgba).toHaveLength(size * size * 4);
    expect(pixelAt(rgba, size, 0, 0)[3]).toBe(0);
    expect(pixelAt(rgba, size, size - 1, size - 1)[3]).toBe(0);
    expect(pixelAt(rgba, size, 2, size / 2)[3]).toBe(0);
    expect(pixelAt(rgba, size, size / 2, 2)[3]).toBe(0);
    expect(pixelAt(rgba, size, size / 2, size / 2)[3]).toBe(255);
    expect(pixelAt(rgba, size, size / 2, Math.round(size * 0.16))[3]).toBe(255);
  });

  it("paints a white check mark through the middle of the badge", () => {
    const rgba = renderIcon(size);
    // On the long upward stroke of the check: from the low point (0.44, 0.70)
    // to the top of the tick (0.74, 0.36) inside the 64px canvas.
    const [r, g, b, a] = pixelAt(rgba, size, 37, 33);
    expect(a).toBe(255);
    for (const channel of [r, g, b]) expect(channel).toBeGreaterThan(230);
    // ...and the badge behind it is not white (the glyph is what we sampled).
    const [br, bg, bb] = pixelAt(rgba, size, 12, 12);
    expect(Math.max(br, bg, bb) - Math.min(br, bg, bb)).toBeGreaterThan(20);
  });
});

describe("encodePng", () => {
  it("writes RGBA scanlines that inflate back to the source pixels", () => {
    const size = 3;
    const rgba = Buffer.alloc(size * size * 4);
    for (let i = 0; i < size * size; i++) {
      rgba[i * 4] = i * 10;
      rgba[i * 4 + 1] = 255 - i * 10;
      rgba[i * 4 + 2] = 7;
      rgba[i * 4 + 3] = i % 2 === 0 ? 255 : 128;
    }
    const decoded = decodePng(encodePng(rgba, size));
    expect(decoded.width).toBe(size);
    expect(decoded.height).toBe(size);
    expect(decoded.bitDepth).toBe(8);
    expect(decoded.colorType).toBe(6);
    // Each row is a filter byte (0 = None) followed by the row's pixels.
    const expected = Buffer.alloc(size * (1 + size * 4));
    for (let y = 0; y < size; y++) {
      const rowStart = y * (1 + size * 4);
      expected[rowStart] = 0;
      rgba.copy(expected, rowStart + 1, y * size * 4, (y + 1) * size * 4);
    }
    expect(decoded.pixels).toEqual(expected);
  });

  it("emits identical bytes for identical pixels", () => {
    const a = encodePng(renderIcon(32), 32);
    const b = encodePng(renderIcon(32), 32);
    expect(a.equals(b)).toBe(true);
  });
});

describe("downsample", () => {
  it("box-averages 2x2 blocks, rounding channels independently", () => {
    const rgba = Buffer.from([
      // 2x2 source, one channel pattern:
      10, 20, 30, 255, 20, 40, 60, 255, 30, 60, 90, 255, 46, 90, 130, 255
    ]);
    const out = downsample(rgba, 2, 1);
    expect([...out]).toEqual([27, 53, 78, 255]);
  });

  it("rejects sizes that do not divide evenly", () => {
    expect(() => downsample(Buffer.alloc(3 * 3 * 4), 3, 2)).toThrow(/multiple/i);
  });
});

describe("encodeIco", () => {
  it("wraps a 256px PNG in a single-entry Vista-style icon", () => {
    const png = encodePng(renderIcon(256), 256);
    const ico = encodeIco(png);
    expect(ico.readUInt16LE(0)).toBe(0); // reserved
    expect(ico.readUInt16LE(2)).toBe(1); // type: icon
    expect(ico.readUInt16LE(4)).toBe(1); // one image
    expect(ico[6]).toBe(0); // 256px is stored as 0
    expect(ico[7]).toBe(0);
    expect(ico.readUInt16LE(10)).toBe(1); // color planes
    expect(ico.readUInt16LE(12)).toBe(32); // bits per pixel
    expect(ico.readUInt32LE(14)).toBe(png.length);
    expect(ico.readUInt32LE(18)).toBe(22); // image bytes start after the directory
    expect(ico.subarray(22).equals(png)).toBe(true);
  });
});
