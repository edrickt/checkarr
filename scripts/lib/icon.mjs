// Icon rendering and image encoding for the desktop launcher. Pure Node: no
// native image libraries, so it works on every platform the scripts support.
//
// The mark is a rounded badge (indigo -> sky gradient) with a white check
// mark. Distances are signed-distance functions, which gives clean edges at
// any size without supersampling.
import { crc32, deflateSync } from "node:zlib";

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

// Fractions of the canvas: how much empty space surrounds the badge, how
// round its corners are, and how thick the check mark stroke is.
const INSET = 0.09;
const CORNER = 0.225;
const STROKE = 0.115;

// The check mark, in badge-box coordinates.
const CHECK_POINTS = [
  [0.26, 0.52],
  [0.44, 0.7],
  [0.74, 0.36]
];

const BADGE_TOP = [99, 102, 241]; // indigo-500
const BADGE_BOTTOM = [14, 165, 233]; // sky-500
const CHECK = [255, 255, 255];

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

function sdRoundRect(x, y, cx, cy, hw, hh, r) {
  const dx = Math.abs(x - cx) - (hw - r);
  const dy = Math.abs(y - cy) - (hh - r);
  const outside = Math.hypot(Math.max(dx, 0), Math.max(dy, 0));
  return outside + Math.min(Math.max(dx, dy), 0) - r;
}

function sdSegment(px, py, ax, ay, bx, by) {
  const abx = bx - ax;
  const aby = by - ay;
  const len2 = abx * abx + aby * aby;
  const t = len2 === 0 ? 0 : clamp(((px - ax) * abx + (py - ay) * aby) / len2, 0, 1);
  return Math.hypot(px - ax - abx * t, py - ay - aby * t);
}

/**
 * Render just the check mark as a non-premultiplied RGBA buffer (size *
 * size), fitted to the canvas. Menu-bar / notification-area icons are tinted
 * by the platform (macOS template images), so only the alpha channel counts
 * and RGB stays black.
 */
export function renderGlyph(size, options = {}) {
  const stroke = options.stroke ?? 0.12;
  const margin = options.margin ?? 0.08;
  const rgba = Buffer.alloc(size * size * 4);

  // Fit the check mark's bounding box into the canvas, keeping its aspect.
  const xs = CHECK_POINTS.map(([x]) => x);
  const ys = CHECK_POINTS.map(([, y]) => y);
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minY = Math.min(...ys);
  const maxY = Math.max(...ys);
  const box = size * (1 - 2 * margin);
  const scale = box / Math.max(maxX - minX, maxY - minY);
  const offsetX = size / 2 - ((minX + maxX) / 2) * scale;
  const offsetY = size / 2 - ((minY + maxY) / 2) * scale;
  const [p0, p1, p2] = CHECK_POINTS.map(([x, y]) => [x * scale + offsetX, y * scale + offsetY]);
  const radius = (stroke * size) / 2;

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const distance = Math.min(
        sdSegment(x + 0.5, y + 0.5, p0[0], p0[1], p1[0], p1[1]),
        sdSegment(x + 0.5, y + 0.5, p1[0], p1[1], p2[0], p2[1])
      );
      const alpha = Math.round(clamp(radius - distance + 0.5, 0, 1) * 255);
      if (alpha === 0) continue;
      rgba[(y * size + x) * 4 + 3] = alpha;
    }
  }
  return rgba;
}

/**
 * Render the Checkarr mark as a non-premultiplied RGBA buffer (size * size).
 */
export function renderIcon(size) {
  const rgba = Buffer.alloc(size * size * 4);
  const inset = INSET * size;
  const box = size - 2 * inset;
  const half = box / 2;
  const center = size / 2;
  const radius = CORNER * box;
  const strokeRadius = (STROKE * box) / 2;
  const [p0, p1, p2] = CHECK_POINTS.map(([fx, fy]) => [inset + fx * box, inset + fy * box]);

  for (let y = 0; y < size; y++) {
    const py = y + 0.5;
    // Vertical position inside the badge drives the gradient and the gloss.
    const t = clamp((py - inset) / box, 0, 1);
    const gloss = 0.12 * (1 - t) * (1 - t);
    for (let x = 0; x < size; x++) {
      const px = x + 0.5;
      const badge = clamp(0.5 - sdRoundRect(px, py, center, center, half, half, radius), 0, 1);
      const i = (y * size + x) * 4;
      rgba[i + 3] = Math.round(badge * 255);
      if (rgba[i + 3] === 0) continue;

      const mix = clamp((px - inset + (py - inset)) / (2 * box), 0, 1);
      let color = [0, 1, 2].map(
        (c) => BADGE_TOP[c] + (BADGE_BOTTOM[c] - BADGE_TOP[c]) * mix + (255 - BADGE_TOP[c]) * gloss
      );

      const glyph = clamp(
        strokeRadius -
          Math.min(
            sdSegment(px, py, p0[0], p0[1], p1[0], p1[1]),
            sdSegment(px, py, p1[0], p1[1], p2[0], p2[1])
          ) +
          0.5,
        0,
        1
      );
      if (glyph > 0) color = color.map((c, idx) => c + (CHECK[idx] - c) * glyph);

      for (let c = 0; c < 3; c++) rgba[i + c] = Math.round(clamp(color[c], 0, 255));
    }
  }
  return rgba;
}

function pngChunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body) >>> 0);
  return Buffer.concat([length, body, crc]);
}

/** Encode a non-premultiplied RGBA buffer as an 8-bit RGBA PNG. */
export function encodePng(rgba, size) {
  const stride = 1 + size * 4;
  const raw = Buffer.alloc(size * stride);
  for (let y = 0; y < size; y++) {
    raw[y * stride] = 0; // filter: None
    rgba.copy(raw, y * stride + 1, y * size * 4, (y + 1) * size * 4);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type: RGBA
  return Buffer.concat([
    PNG_SIGNATURE,
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", deflateSync(raw, { level: 9 })),
    pngChunk("IEND", Buffer.alloc(0))
  ]);
}

/** Box-filter an RGBA buffer down to a smaller square size. */
export function downsample(rgba, size, target) {
  if (!Number.isInteger(target) || target <= 0 || size % target !== 0) {
    throw new Error("downsample target must be an even multiple of the source size");
  }
  const factor = size / target;
  const out = Buffer.alloc(target * target * 4);
  for (let y = 0; y < target; y++) {
    for (let x = 0; x < target; x++) {
      for (let c = 0; c < 4; c++) {
        let sum = 0;
        for (let sy = 0; sy < factor; sy++) {
          for (let sx = 0; sx < factor; sx++) {
            sum += rgba[((y * factor + sy) * size + x * factor + sx) * 4 + c];
          }
        }
        out[(y * target + x) * 4 + c] = Math.round(sum / (factor * factor));
      }
    }
  }
  return out;
}

/** Wrap a 256px PNG in a single-entry Vista-style .ico (PNG-compressed). */
export function encodeIco(png) {
  const header = Buffer.alloc(22);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // type: icon
  header.writeUInt16LE(1, 4); // image count
  header[6] = 0; // width 256 is stored as 0
  header[7] = 0; // height 256
  header[8] = 0; // palette colors
  header[9] = 0; // reserved
  header.writeUInt16LE(1, 10); // color planes
  header.writeUInt16LE(32, 12); // bits per pixel
  header.writeUInt32LE(png.length, 14);
  header.writeUInt32LE(22, 18);
  return Buffer.concat([header, png]);
}
