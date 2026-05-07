import { deflateSync, inflateSync } from "node:zlib";
import type { Node, Snapshot } from "@brna/schema";

export interface OverlayInput {
  png: Buffer;
  snapshot: Snapshot;
}

export interface OverlayOptions {
  maxLabelLength?: number;
}

const DEFAULT_MAX_LABEL_LENGTH = 28;
const DEFAULT_LINE_COLOR: RGBA = [255, 64, 64, 255];
const DEFAULT_LABEL_BG: RGBA = [0, 0, 0, 200];
const DEFAULT_LABEL_FG: RGBA = [255, 255, 255, 255];

type RGBA = [number, number, number, number];

interface DecodedPng {
  width: number;
  height: number;
  channels: 3 | 4;
  bitDepth: 8;
  pixels: Uint8Array;
}

export function renderOverlay(input: OverlayInput, options: OverlayOptions = {}): Buffer {
  const decoded = decodePng(input.png);
  const scale = input.snapshot.meta.device.viewport?.scale ?? 1;
  const maxLabelLength = options.maxLabelLength ?? DEFAULT_MAX_LABEL_LENGTH;
  const annotations = collectAnnotations(input.snapshot, scale, decoded, maxLabelLength);
  for (const ann of annotations) {
    drawRect(decoded, ann.x, ann.y, ann.w, ann.h, DEFAULT_LINE_COLOR, 2);
  }
  for (const ann of annotations) {
    if (ann.label.length === 0) continue;
    drawLabel(decoded, ann.x, ann.y, ann.label);
  }
  return encodePng(decoded);
}

interface Annotation {
  x: number;
  y: number;
  w: number;
  h: number;
  label: string;
}

function collectAnnotations(
  snapshot: Snapshot,
  scale: number,
  png: DecodedPng,
  maxLabelLength: number,
): Annotation[] {
  const out: Annotation[] = [];
  const visit = (node: Node): void => {
    const bounds = node.bounds;
    if (
      bounds &&
      Number.isFinite(bounds.x) &&
      Number.isFinite(bounds.y) &&
      Number.isFinite(bounds.w) &&
      Number.isFinite(bounds.h) &&
      bounds.w > 0 &&
      bounds.h > 0
    ) {
      const x = Math.round(bounds.x * scale);
      const y = Math.round(bounds.y * scale);
      const w = Math.round(bounds.w * scale);
      const h = Math.round(bounds.h * scale);
      if (x < png.width && y < png.height && x + w > 0 && y + h > 0) {
        const label = pickLabel(node, maxLabelLength);
        out.push({ x, y, w, h, label });
      }
    }
    if (Array.isArray(node.children)) {
      const sortedChildren = [...node.children].sort((a, b) => (a.id ?? "").localeCompare(b.id ?? ""));
      for (const child of sortedChildren) visit(child);
    }
  };
  visit(snapshot.tree);
  // Deterministic order: id ascending, ensures byte-identical output.
  out.sort((a, b) => a.label.localeCompare(b.label) || a.x - b.x || a.y - b.y);
  return out;
}

export function pickLabel(node: Node, maxLabelLength: number): string {
  const candidates = Array.isArray(node.suggested_selectors) ? node.suggested_selectors : [];
  const canonical = candidates.find((s) => typeof s === "string" && s.startsWith("#"));
  const chosen = canonical ?? candidates.find((s): s is string => typeof s === "string" && s.length > 0) ?? "";
  if (chosen.length === 0) return "";
  const limit = Math.floor(maxLabelLength);
  if (!Number.isFinite(limit) || limit <= 0) return "";
  if (chosen.length <= limit) return chosen;
  if (limit === 1) return "…";
  return chosen.slice(0, limit - 1) + "…";
}

// ---------------- PNG codec (8-bit RGB / RGBA) ----------------

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function decodePng(buf: Buffer): DecodedPng {
  if (buf.length < 8 || !buf.subarray(0, 8).equals(PNG_SIGNATURE)) {
    throw new Error("input is not a PNG");
  }
  let offset = 8;
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = 0;
  let interlace = 0;
  const idatChunks: Buffer[] = [];
  while (offset < buf.length) {
    const length = buf.readUInt32BE(offset);
    const type = buf.subarray(offset + 4, offset + 8).toString("ascii");
    const data = buf.subarray(offset + 8, offset + 8 + length);
    offset += 12 + length; // skip CRC
    if (type === "IHDR") {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bitDepth = data.readUInt8(8);
      colorType = data.readUInt8(9);
      interlace = data.readUInt8(12);
    } else if (type === "IDAT") {
      idatChunks.push(Buffer.from(data));
    } else if (type === "IEND") {
      break;
    }
  }
  if (bitDepth !== 8) {
    throw new Error(`unsupported PNG bit depth ${bitDepth} (only 8-bit supported)`);
  }
  if (interlace !== 0) {
    throw new Error("interlaced PNG not supported");
  }
  let channels: 3 | 4;
  if (colorType === 2) channels = 3;
  else if (colorType === 6) channels = 4;
  else throw new Error(`unsupported PNG color type ${colorType} (need RGB or RGBA)`);

  const inflated = inflateSync(Buffer.concat(idatChunks));
  const pixels = unfilter(inflated, width, height, channels);
  return { width, height, channels, bitDepth: 8, pixels };
}

function unfilter(data: Buffer, width: number, height: number, channels: number): Uint8Array {
  const stride = width * channels;
  const out = new Uint8Array(stride * height);
  let dataOffset = 0;
  for (let y = 0; y < height; y++) {
    const filter = data[dataOffset++]!;
    const rowStart = y * stride;
    for (let x = 0; x < stride; x++) {
      const raw = data[dataOffset + x]!;
      const left = x >= channels ? out[rowStart + x - channels]! : 0;
      const up = y > 0 ? out[(y - 1) * stride + x]! : 0;
      const upLeft = x >= channels && y > 0 ? out[(y - 1) * stride + x - channels]! : 0;
      let value: number;
      switch (filter) {
        case 0:
          value = raw;
          break;
        case 1:
          value = (raw + left) & 0xff;
          break;
        case 2:
          value = (raw + up) & 0xff;
          break;
        case 3:
          value = (raw + ((left + up) >> 1)) & 0xff;
          break;
        case 4:
          value = (raw + paeth(left, up, upLeft)) & 0xff;
          break;
        default:
          throw new Error(`unsupported PNG filter ${filter}`);
      }
      out[rowStart + x] = value;
    }
    dataOffset += stride;
  }
  return out;
}

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  if (pb <= pc) return b;
  return c;
}

function encodePng(image: DecodedPng): Buffer {
  const stride = image.width * image.channels;
  const filtered = new Uint8Array(stride * image.height + image.height);
  for (let y = 0; y < image.height; y++) {
    filtered[y * (stride + 1)] = 0; // filter None
    filtered.set(image.pixels.subarray(y * stride, (y + 1) * stride), y * (stride + 1) + 1);
  }
  const compressed = deflateSync(Buffer.from(filtered.buffer, filtered.byteOffset, filtered.byteLength));
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(image.width, 0);
  ihdr.writeUInt32BE(image.height, 4);
  ihdr.writeUInt8(8, 8);
  ihdr.writeUInt8(image.channels === 4 ? 6 : 2, 9);
  ihdr.writeUInt8(0, 10); // compression
  ihdr.writeUInt8(0, 11); // filter
  ihdr.writeUInt8(0, 12); // interlace

  return Buffer.concat([
    PNG_SIGNATURE,
    chunk("IHDR", ihdr),
    chunk("IDAT", compressed),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

function chunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, "ascii");
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])) >>> 0, 0);
  return Buffer.concat([length, typeBuf, data, crc]);
}

const CRC_TABLE: number[] = (() => {
  const table = new Array<number>(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(data: Buffer): number {
  let c = 0xffffffff;
  for (let i = 0; i < data.length; i++) {
    c = CRC_TABLE[(c ^ data[i]!) & 0xff]! ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

// ---------------- drawing ----------------

function drawRect(
  png: DecodedPng,
  x: number,
  y: number,
  w: number,
  h: number,
  color: RGBA,
  thickness: number,
): void {
  const x0 = Math.max(0, x);
  const y0 = Math.max(0, y);
  const x1 = Math.min(png.width - 1, x + w - 1);
  const y1 = Math.min(png.height - 1, y + h - 1);
  if (x0 > x1 || y0 > y1) return;
  for (let t = 0; t < thickness; t++) {
    drawHLine(png, x0, x1, y0 + t, color);
    drawHLine(png, x0, x1, y1 - t, color);
    drawVLine(png, x0 + t, y0, y1, color);
    drawVLine(png, x1 - t, y0, y1, color);
  }
}

function drawHLine(png: DecodedPng, x0: number, x1: number, y: number, color: RGBA): void {
  if (y < 0 || y >= png.height) return;
  for (let x = x0; x <= x1; x++) setPixel(png, x, y, color);
}

function drawVLine(png: DecodedPng, x: number, y0: number, y1: number, color: RGBA): void {
  if (x < 0 || x >= png.width) return;
  for (let y = y0; y <= y1; y++) setPixel(png, x, y, color);
}

function setPixel(png: DecodedPng, x: number, y: number, color: RGBA): void {
  if (x < 0 || x >= png.width || y < 0 || y >= png.height) return;
  const idx = (y * png.width + x) * png.channels;
  const alpha = color[3] / 255;
  png.pixels[idx] = blend(png.pixels[idx]!, color[0], alpha);
  png.pixels[idx + 1] = blend(png.pixels[idx + 1]!, color[1], alpha);
  png.pixels[idx + 2] = blend(png.pixels[idx + 2]!, color[2], alpha);
  if (png.channels === 4) {
    png.pixels[idx + 3] = 255;
  }
}

function blend(base: number, fg: number, alpha: number): number {
  return Math.round(base * (1 - alpha) + fg * alpha);
}

function fillRect(png: DecodedPng, x: number, y: number, w: number, h: number, color: RGBA): void {
  for (let dy = 0; dy < h; dy++) {
    for (let dx = 0; dx < w; dx++) {
      setPixel(png, x + dx, y + dy, color);
    }
  }
}

function drawLabel(png: DecodedPng, anchorX: number, anchorY: number, text: string): void {
  if (text.length === 0) return;
  const padding = 2;
  const charW = 5;
  const charH = 7;
  const spacing = 1;
  const textWidth = text.length * (charW + spacing) - spacing;
  const boxW = textWidth + padding * 2;
  const boxH = charH + padding * 2;
  let bx = anchorX;
  let by = anchorY - boxH - 1;
  if (by < 0) by = anchorY + 1;
  if (bx + boxW > png.width) bx = Math.max(0, png.width - boxW);
  fillRect(png, bx, by, boxW, boxH, DEFAULT_LABEL_BG);
  let cx = bx + padding;
  for (const ch of text) {
    drawChar(png, cx, by + padding, ch, DEFAULT_LABEL_FG);
    cx += charW + spacing;
  }
}

function drawChar(png: DecodedPng, x: number, y: number, ch: string, color: RGBA): void {
  const glyph = FONT[ch] ?? FONT["?"]!;
  for (let row = 0; row < 7; row++) {
    const bits = glyph[row] ?? 0;
    for (let col = 0; col < 5; col++) {
      if ((bits >> (4 - col)) & 1) setPixel(png, x + col, y + row, color);
    }
  }
}

// 5x7 ASCII font — covers printable selectors. Each glyph is 7 rows of 5-bit
// values with high bit = leftmost pixel.
const FONT: Record<string, number[]> = makeFont();

function makeFont(): Record<string, number[]> {
  // prettier-ignore
  const data: Record<string, number[]> = {
    " ": [0,0,0,0,0,0,0],
    "!": [0b00100,0b00100,0b00100,0b00100,0b00100,0b00000,0b00100],
    "\"":[0b01010,0b01010,0b01010,0b00000,0b00000,0b00000,0b00000],
    "#": [0b01010,0b01010,0b11111,0b01010,0b11111,0b01010,0b01010],
    "$": [0b00100,0b01111,0b10100,0b01110,0b00101,0b11110,0b00100],
    "%": [0b11000,0b11001,0b00010,0b00100,0b01000,0b10011,0b00011],
    "&": [0b01100,0b10010,0b10100,0b01000,0b10101,0b10010,0b01101],
    "'": [0b00100,0b00100,0b01000,0b00000,0b00000,0b00000,0b00000],
    "(": [0b00010,0b00100,0b01000,0b01000,0b01000,0b00100,0b00010],
    ")": [0b01000,0b00100,0b00010,0b00010,0b00010,0b00100,0b01000],
    "*": [0b00000,0b00100,0b10101,0b01110,0b10101,0b00100,0b00000],
    "+": [0b00000,0b00100,0b00100,0b11111,0b00100,0b00100,0b00000],
    ",": [0b00000,0b00000,0b00000,0b00000,0b00100,0b00100,0b01000],
    "-": [0b00000,0b00000,0b00000,0b11111,0b00000,0b00000,0b00000],
    ".": [0b00000,0b00000,0b00000,0b00000,0b00000,0b00100,0b00100],
    "/": [0b00001,0b00010,0b00010,0b00100,0b01000,0b01000,0b10000],
    "0": [0b01110,0b10001,0b10011,0b10101,0b11001,0b10001,0b01110],
    "1": [0b00100,0b01100,0b00100,0b00100,0b00100,0b00100,0b01110],
    "2": [0b01110,0b10001,0b00001,0b00010,0b00100,0b01000,0b11111],
    "3": [0b11110,0b00001,0b00001,0b01110,0b00001,0b00001,0b11110],
    "4": [0b00010,0b00110,0b01010,0b10010,0b11111,0b00010,0b00010],
    "5": [0b11111,0b10000,0b11110,0b00001,0b00001,0b10001,0b01110],
    "6": [0b00110,0b01000,0b10000,0b11110,0b10001,0b10001,0b01110],
    "7": [0b11111,0b00001,0b00010,0b00100,0b01000,0b01000,0b01000],
    "8": [0b01110,0b10001,0b10001,0b01110,0b10001,0b10001,0b01110],
    "9": [0b01110,0b10001,0b10001,0b01111,0b00001,0b00010,0b01100],
    ":": [0b00000,0b00100,0b00100,0b00000,0b00100,0b00100,0b00000],
    ";": [0b00000,0b00100,0b00100,0b00000,0b00100,0b00100,0b01000],
    "<": [0b00010,0b00100,0b01000,0b10000,0b01000,0b00100,0b00010],
    "=": [0b00000,0b00000,0b11111,0b00000,0b11111,0b00000,0b00000],
    ">": [0b01000,0b00100,0b00010,0b00001,0b00010,0b00100,0b01000],
    "?": [0b01110,0b10001,0b00001,0b00010,0b00100,0b00000,0b00100],
    "@": [0b01110,0b10001,0b00001,0b01101,0b10101,0b10101,0b01110],
    "[": [0b01110,0b01000,0b01000,0b01000,0b01000,0b01000,0b01110],
    "\\":[0b10000,0b01000,0b01000,0b00100,0b00010,0b00010,0b00001],
    "]": [0b01110,0b00010,0b00010,0b00010,0b00010,0b00010,0b01110],
    "^": [0b00100,0b01010,0b10001,0b00000,0b00000,0b00000,0b00000],
    "_": [0b00000,0b00000,0b00000,0b00000,0b00000,0b00000,0b11111],
    "`": [0b01000,0b00100,0b00010,0b00000,0b00000,0b00000,0b00000],
    "{": [0b00110,0b01000,0b01000,0b10000,0b01000,0b01000,0b00110],
    "|": [0b00100,0b00100,0b00100,0b00100,0b00100,0b00100,0b00100],
    "}": [0b01100,0b00010,0b00010,0b00001,0b00010,0b00010,0b01100],
    "~": [0b00000,0b00000,0b01001,0b10101,0b10010,0b00000,0b00000],
    "…": [0b00000,0b00000,0b00000,0b00000,0b00000,0b10101,0b00000],
  };
  const upper = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
  const upperGlyphs: Record<string, number[]> = {
    A:[0b01110,0b10001,0b10001,0b11111,0b10001,0b10001,0b10001],
    B:[0b11110,0b10001,0b10001,0b11110,0b10001,0b10001,0b11110],
    C:[0b01110,0b10001,0b10000,0b10000,0b10000,0b10001,0b01110],
    D:[0b11110,0b10001,0b10001,0b10001,0b10001,0b10001,0b11110],
    E:[0b11111,0b10000,0b10000,0b11110,0b10000,0b10000,0b11111],
    F:[0b11111,0b10000,0b10000,0b11110,0b10000,0b10000,0b10000],
    G:[0b01110,0b10001,0b10000,0b10111,0b10001,0b10001,0b01110],
    H:[0b10001,0b10001,0b10001,0b11111,0b10001,0b10001,0b10001],
    I:[0b01110,0b00100,0b00100,0b00100,0b00100,0b00100,0b01110],
    J:[0b00111,0b00010,0b00010,0b00010,0b00010,0b10010,0b01100],
    K:[0b10001,0b10010,0b10100,0b11000,0b10100,0b10010,0b10001],
    L:[0b10000,0b10000,0b10000,0b10000,0b10000,0b10000,0b11111],
    M:[0b10001,0b11011,0b10101,0b10101,0b10001,0b10001,0b10001],
    N:[0b10001,0b10001,0b11001,0b10101,0b10011,0b10001,0b10001],
    O:[0b01110,0b10001,0b10001,0b10001,0b10001,0b10001,0b01110],
    P:[0b11110,0b10001,0b10001,0b11110,0b10000,0b10000,0b10000],
    Q:[0b01110,0b10001,0b10001,0b10001,0b10101,0b10010,0b01101],
    R:[0b11110,0b10001,0b10001,0b11110,0b10100,0b10010,0b10001],
    S:[0b01111,0b10000,0b10000,0b01110,0b00001,0b00001,0b11110],
    T:[0b11111,0b00100,0b00100,0b00100,0b00100,0b00100,0b00100],
    U:[0b10001,0b10001,0b10001,0b10001,0b10001,0b10001,0b01110],
    V:[0b10001,0b10001,0b10001,0b10001,0b10001,0b01010,0b00100],
    W:[0b10001,0b10001,0b10001,0b10101,0b10101,0b10101,0b01010],
    X:[0b10001,0b10001,0b01010,0b00100,0b01010,0b10001,0b10001],
    Y:[0b10001,0b10001,0b01010,0b00100,0b00100,0b00100,0b00100],
    Z:[0b11111,0b00001,0b00010,0b00100,0b01000,0b10000,0b11111],
  };
  const lowerGlyphs: Record<string, number[]> = {
    a:[0b00000,0b00000,0b01110,0b00001,0b01111,0b10001,0b01111],
    b:[0b10000,0b10000,0b10110,0b11001,0b10001,0b10001,0b11110],
    c:[0b00000,0b00000,0b01110,0b10000,0b10000,0b10001,0b01110],
    d:[0b00001,0b00001,0b01101,0b10011,0b10001,0b10001,0b01111],
    e:[0b00000,0b00000,0b01110,0b10001,0b11111,0b10000,0b01110],
    f:[0b00110,0b01001,0b01000,0b11110,0b01000,0b01000,0b01000],
    g:[0b00000,0b00000,0b01111,0b10001,0b01111,0b00001,0b01110],
    h:[0b10000,0b10000,0b10110,0b11001,0b10001,0b10001,0b10001],
    i:[0b00100,0b00000,0b01100,0b00100,0b00100,0b00100,0b01110],
    j:[0b00010,0b00000,0b00110,0b00010,0b00010,0b10010,0b01100],
    k:[0b10000,0b10000,0b10010,0b10100,0b11000,0b10100,0b10010],
    l:[0b01100,0b00100,0b00100,0b00100,0b00100,0b00100,0b01110],
    m:[0b00000,0b00000,0b11010,0b10101,0b10101,0b10001,0b10001],
    n:[0b00000,0b00000,0b10110,0b11001,0b10001,0b10001,0b10001],
    o:[0b00000,0b00000,0b01110,0b10001,0b10001,0b10001,0b01110],
    p:[0b00000,0b00000,0b11110,0b10001,0b11110,0b10000,0b10000],
    q:[0b00000,0b00000,0b01111,0b10001,0b01111,0b00001,0b00001],
    r:[0b00000,0b00000,0b10110,0b11001,0b10000,0b10000,0b10000],
    s:[0b00000,0b00000,0b01111,0b10000,0b01110,0b00001,0b11110],
    t:[0b01000,0b01000,0b11110,0b01000,0b01000,0b01001,0b00110],
    u:[0b00000,0b00000,0b10001,0b10001,0b10001,0b10011,0b01101],
    v:[0b00000,0b00000,0b10001,0b10001,0b10001,0b01010,0b00100],
    w:[0b00000,0b00000,0b10001,0b10001,0b10101,0b10101,0b01010],
    x:[0b00000,0b00000,0b10001,0b01010,0b00100,0b01010,0b10001],
    y:[0b00000,0b00000,0b10001,0b10001,0b01111,0b00001,0b01110],
    z:[0b00000,0b00000,0b11111,0b00010,0b00100,0b01000,0b11111],
  };
  for (const ch of upper) data[ch] = upperGlyphs[ch]!;
  for (const ch of "abcdefghijklmnopqrstuvwxyz") data[ch] = lowerGlyphs[ch]!;
  return data;
}
