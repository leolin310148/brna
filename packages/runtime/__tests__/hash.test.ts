import { describe, expect, test } from "bun:test";
import { SCHEMA_VERSION, type Snapshot } from "@brna/schema";
import { computeSnapshotHash } from "../src/hash.js";

function makeSnapshot(over: Partial<Snapshot> = {}): Snapshot {
  return {
    meta: {
      schema_version: SCHEMA_VERSION,
      captured_at: "2026-05-02T00:00:00.000Z",
      app: { bundle_id: "x", version: "1" },
      device: {
        platform: "ios",
        os_version: "17",
        model: "iPhone",
        viewport: { w: 1, h: 1, scale: 1 },
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

describe("computeSnapshotHash", () => {
  test("ignores bounds, _dev, suggested selectors, meta, and screen", () => {
    const first = makeSnapshot({
      tree: {
        id: "root",
        kind: "screen",
        bounds: { x: 0, y: 0, w: 100, h: 100 },
        suggested_selectors: ["#root"],
        _dev: { source: "A.tsx:1:1" },
        children: [{ id: "save", kind: "button", name: "Save" }],
      },
    });
    const second = makeSnapshot({
      meta: { ...makeSnapshot().meta, snapshot_id: "other" },
      screen: { modal_stack: ["modal"] },
      tree: {
        id: "root",
        kind: "screen",
        bounds: { x: 10, y: 20, w: 100, h: 100 },
        suggested_selectors: ["screen"],
        _dev: { source: "B.tsx:2:1" },
        children: [{ id: "save", kind: "button", name: "Save" }],
      },
    });
    expect(computeSnapshotHash(first)).toBe(computeSnapshotHash(second));
  });

  test("changes when public tree semantics change", () => {
    const before = makeSnapshot({
      tree: { id: "root", kind: "screen", children: [{ id: "save", kind: "button", name: "Save" }] },
    });
    const after = makeSnapshot({
      tree: { id: "root", kind: "screen", children: [{ id: "save", kind: "button", name: "Saved" }] },
    });
    expect(computeSnapshotHash(before)).not.toBe(computeSnapshotHash(after));
  });
});
