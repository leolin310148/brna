import { describe, expect, test } from "bun:test";
import { deflateSync } from "node:zlib";
import { SCHEMA_VERSION, type Snapshot } from "@brna/schema";
import { pickLabel, renderOverlay } from "../src/overlay.js";

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

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
  for (let i = 0; i < data.length; i++) c = CRC_TABLE[(c ^ data[i]!) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const t = Buffer.from(type, "ascii");
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([t, data])) >>> 0, 0);
  return Buffer.concat([len, t, data, crc]);
}

function makeSolidPng(width: number, height: number, channels: 3 | 4, color: number[]): Buffer {
  const stride = width * channels;
  const filtered = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    const rowStart = y * (stride + 1);
    filtered[rowStart] = 0;
    for (let x = 0; x < width; x++) {
      const px = rowStart + 1 + x * channels;
      for (let c = 0; c < channels; c++) filtered[px + c] = color[c]!;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr.writeUInt8(8, 8);
  ihdr.writeUInt8(channels === 4 ? 6 : 2, 9);
  return Buffer.concat([
    PNG_SIGNATURE,
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", deflateSync(filtered)),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

function readPngSize(buf: Buffer): { width: number; height: number; colorType: number } {
  expect(buf.subarray(0, 8).equals(PNG_SIGNATURE)).toBe(true);
  const ihdr = buf.subarray(16, 16 + 13);
  return {
    width: ihdr.readUInt32BE(0),
    height: ihdr.readUInt32BE(4),
    colorType: ihdr.readUInt8(9),
  };
}

function makeSnapshot(over: Partial<Snapshot> = {}): Snapshot {
  return {
    meta: {
      schema_version: SCHEMA_VERSION,
      captured_at: "2026-05-01T12:00:00.000Z",
      app: { bundle_id: "x", version: "1" },
      device: {
        platform: "ios",
        os_version: "17",
        model: "iPhone",
        viewport: { w: 100, h: 100, scale: 2 },
        locale: "en",
      },
      session_id: "s",
      snapshot_id: "n",
    },
    screen: { modal_stack: [] },
    tree: { id: "root", kind: "screen" },
    ...over,
  };
}

describe("pickLabel", () => {
  test("prefers id selector", () => {
    expect(
      pickLabel(
        { id: "x", kind: "button", suggested_selectors: ["button:Save", "#save"] },
        20,
      ),
    ).toBe("#save");
  });
  test("falls back to first selector", () => {
    expect(
      pickLabel({ id: "x", kind: "button", suggested_selectors: ["button:Save"] }, 20),
    ).toBe("button:Save");
  });
  test("truncates long labels with ellipsis", () => {
    const label = pickLabel(
      { id: "x", kind: "button", suggested_selectors: ["button:VeryLongLabelThatExceedsCap"] },
      10,
    );
    expect(label.length).toBe(10);
    expect(label.endsWith("…")).toBe(true);
  });
  test("returns empty when no selectors", () => {
    expect(pickLabel({ id: "x", kind: "view" }, 20)).toBe("");
  });
});

describe("renderOverlay", () => {
  test("produces a PNG of the same dimensions", () => {
    const png = makeSolidPng(200, 200, 4, [255, 255, 255, 255]);
    const snapshot = makeSnapshot({
      tree: {
        id: "root",
        kind: "screen",
        children: [
          {
            id: "btn",
            kind: "button",
            bounds: { x: 10, y: 20, w: 50, h: 30 },
            suggested_selectors: ["#save"],
          },
        ],
      },
    });
    const out = renderOverlay({ png, snapshot });
    const size = readPngSize(out);
    expect(size.width).toBe(200);
    expect(size.height).toBe(200);
    expect(size.colorType).toBe(6);
  });

  test("output is deterministic for same inputs (byte-identical)", () => {
    const png = makeSolidPng(120, 80, 3, [200, 200, 200]);
    const snapshot = makeSnapshot({
      tree: {
        id: "root",
        kind: "screen",
        children: [
          { id: "a", kind: "button", bounds: { x: 5, y: 5, w: 20, h: 10 }, suggested_selectors: ["#a"] },
          { id: "b", kind: "button", bounds: { x: 30, y: 30, w: 20, h: 10 }, suggested_selectors: ["#b"] },
        ],
      },
    });
    const a = renderOverlay({ png, snapshot });
    const b = renderOverlay({ png, snapshot });
    expect(a.equals(b)).toBe(true);
  });

  test("differs from input when any annotation has bounds", () => {
    const png = makeSolidPng(60, 60, 4, [255, 255, 255, 255]);
    const snapshot = makeSnapshot({
      tree: {
        id: "root",
        kind: "screen",
        children: [
          {
            id: "btn",
            kind: "button",
            bounds: { x: 5, y: 5, w: 20, h: 10 },
            suggested_selectors: ["#save"],
          },
        ],
      },
    });
    const out = renderOverlay({ png, snapshot });
    expect(out.equals(png)).toBe(false);
    expect(out.length).toBeGreaterThan(60);
  });

  test("nodes without bounds are skipped without failing", () => {
    const png = makeSolidPng(50, 50, 3, [0, 0, 0]);
    const snapshot = makeSnapshot({
      tree: {
        id: "root",
        kind: "screen",
        children: [
          { id: "no-bounds", kind: "view" },
          { id: "valid", kind: "button", bounds: { x: 1, y: 1, w: 10, h: 10 }, suggested_selectors: ["#v"] },
        ],
      },
    });
    expect(() => renderOverlay({ png, snapshot })).not.toThrow();
  });

  test("scale converts logical to pixel coordinates", () => {
    // viewport.scale = 2 → bounds (1,1,5,5) becomes pixels (2,2,10,10).
    const png = makeSolidPng(40, 40, 4, [128, 128, 128, 255]);
    const snapshot = makeSnapshot({
      tree: {
        id: "root",
        kind: "screen",
        children: [
          { id: "x", kind: "button", bounds: { x: 1, y: 1, w: 5, h: 5 }, suggested_selectors: ["#x"] },
        ],
      },
    });
    // No throw, fits in 40x40 (10px wide rect at 2px offset).
    const out = renderOverlay({ png, snapshot });
    expect(out.length).toBeGreaterThan(0);
  });

  test("rejects non-PNG input", () => {
    expect(() => renderOverlay({ png: Buffer.from("not png"), snapshot: makeSnapshot() })).toThrow(
      /not a PNG/,
    );
  });
});
