import { describe, expect, test } from "bun:test";
import { BrnaValidationError, SCHEMA_VERSION, validateSnapshot, validateSnapshotDiff } from "../src/index.js";
import type { Node, Snapshot, SnapshotDiff } from "../src/index.js";

function makeSnapshot(over: Partial<Snapshot> = {}): Snapshot {
  return {
    meta: {
      schema_version: SCHEMA_VERSION,
      captured_at: "2026-05-01T12:00:00.000Z",
      app: { bundle_id: "x", version: "1.0.0" },
      device: {
        platform: "ios",
        os_version: "17.4",
        model: "iPhone",
        viewport: { w: 393, h: 852, scale: 3 },
        locale: "en-US",
      },
      session_id: "s",
      snapshot_id: "n",
    },
    screen: { modal_stack: [] },
    tree: { id: "root", kind: "screen" },
    ...over,
  };
}

describe("sentinel rule", () => {
  test("rejects developer-supplied __X__ name without inferred_label", () => {
    const snap = makeSnapshot({
      tree: { id: "root", kind: "button", name: "__Submit__" },
    });
    expect(() => validateSnapshot(snap)).toThrow(BrnaValidationError);
  });

  test("accepts inferred __X__ name when _dev.inferred_label is true", () => {
    const snap = makeSnapshot({
      tree: { id: "root", kind: "button", name: "__Submit__", _dev: { inferred_label: true } },
    });
    expect(() => validateSnapshot(snap)).not.toThrow();
  });

  test("real label Submit is always accepted", () => {
    const snap = makeSnapshot({
      tree: { id: "root", kind: "button", name: "Submit" },
    });
    expect(() => validateSnapshot(snap)).not.toThrow();
  });
});

describe("structural validation", () => {
  test("rejects unknown kind", () => {
    const snap = makeSnapshot({
      tree: { id: "root", kind: "View" as never },
    });
    expect(() => validateSnapshot(snap)).toThrow(BrnaValidationError);
  });

  test("rejects unknown root property on a node", () => {
    const snap = makeSnapshot({
      tree: { id: "root", kind: "screen", customField: "nope" } as never,
    });
    expect(() => validateSnapshot(snap)).toThrow(BrnaValidationError);
  });

  test("accepts valid minimal snapshot", () => {
    expect(() => validateSnapshot(makeSnapshot())).not.toThrow();
  });

  test("error path points at the offending node", () => {
    const snap = makeSnapshot({
      tree: {
        id: "root",
        kind: "screen",
        children: [{ id: "bad", kind: "View" as never }],
      },
    });
    try {
      validateSnapshot(snap);
      throw new Error("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(BrnaValidationError);
      const e = err as BrnaValidationError;
      expect(e.path).toMatch(/children/);
    }
  });

  test("rejects mismatched schema_version", () => {
    const snap = makeSnapshot({
      meta: { ...makeSnapshot().meta, schema_version: "brna/2" as never },
    });
    expect(() => validateSnapshot(snap)).toThrow(BrnaValidationError);
  });
});

describe("accessibility fields and range", () => {
  test("accepts accessibility_label and accessibility_hint", () => {
    const snap = makeSnapshot({
      tree: {
        id: "root",
        kind: "button",
        accessibility_label: "Add to cart",
        accessibility_hint: "Adds the item to your cart",
      },
    });
    expect(() => validateSnapshot(snap)).not.toThrow();
  });

  test("preserves empty-string accessibility_label", () => {
    const snap = makeSnapshot({
      tree: { id: "root", kind: "button", accessibility_label: "" },
    });
    expect(() => validateSnapshot(snap)).not.toThrow();
  });

  test("rejects non-string accessibility_label", () => {
    const snap = makeSnapshot({
      tree: { id: "root", kind: "button", accessibility_label: 42 as never },
    });
    expect(() => validateSnapshot(snap)).toThrow(BrnaValidationError);
  });

  test("accepts full range", () => {
    const snap = makeSnapshot({
      tree: {
        id: "root",
        kind: "slider",
        range: { min: 0, max: 100, now: 70, text: "70%" },
      },
    });
    expect(() => validateSnapshot(snap)).not.toThrow();
  });

  test("accepts partial range with only now", () => {
    const snap = makeSnapshot({
      tree: { id: "root", kind: "slider", range: { now: 70 } },
    });
    expect(() => validateSnapshot(snap)).not.toThrow();
  });

  test("rejects empty range", () => {
    const snap = makeSnapshot({
      tree: { id: "root", kind: "slider", range: {} },
    });
    expect(() => validateSnapshot(snap)).toThrow(BrnaValidationError);
  });

  test("rejects non-numeric range.now", () => {
    const snap = makeSnapshot({
      tree: {
        id: "root",
        kind: "slider",
        range: { now: "70" as never },
      },
    });
    expect(() => validateSnapshot(snap)).toThrow(BrnaValidationError);
  });

  test("range coexists with value", () => {
    const snap = makeSnapshot({
      tree: {
        id: "root",
        kind: "slider",
        value: "old",
        range: { now: 70 },
      },
    });
    expect(() => validateSnapshot(snap)).not.toThrow();
  });
});

describe("meta.source", () => {
  test("accepts meta.source as a string", () => {
    const base = makeSnapshot();
    const snap = makeSnapshot({
      meta: { ...base.meta, source: "App.tsx:5:10" },
    });
    expect(() => validateSnapshot(snap)).not.toThrow();
  });

  test("accepts snapshot without meta.source", () => {
    expect(() => validateSnapshot(makeSnapshot())).not.toThrow();
  });

  test("rejects non-string meta.source", () => {
    const base = makeSnapshot();
    const snap = makeSnapshot({
      meta: { ...base.meta, source: 42 as never },
    });
    expect(() => validateSnapshot(snap)).toThrow(BrnaValidationError);
  });
});

describe("advanced snapshot fields", () => {
  test("accepts meta.hash as a string", () => {
    const base = makeSnapshot();
    const snap = makeSnapshot({
      meta: { ...base.meta, hash: "a1b2c3d4" },
    });
    expect(() => validateSnapshot(snap)).not.toThrow();
  });

  test("accepts image_source on image nodes", () => {
    const snap = makeSnapshot({
      tree: { id: "hero", kind: "image", image_source: "https://example.com/logo.png" },
    });
    expect(() => validateSnapshot(snap)).not.toThrow();
  });

  test("accepts virtualized list metadata", () => {
    const snap = makeSnapshot({
      tree: {
        id: "feed",
        kind: "list",
        total_count: 50,
        children: [{ id: "row-12", kind: "list_item", index: 12 }],
      },
    });
    expect(() => validateSnapshot(snap)).not.toThrow();
  });
});

describe("node _dev.source", () => {
  test("accepts _dev.source as a string", () => {
    const snap = makeSnapshot({
      tree: {
        id: "root",
        kind: "button",
        _dev: { source: "LoginScreen.tsx:120:4" },
      },
    });
    expect(() => validateSnapshot(snap)).not.toThrow();
  });
});

describe("bounds_unavailable warning", () => {
  test("validates with bounds_unavailable warning entry", () => {
    const base = makeSnapshot();
    const snap = makeSnapshot({
      meta: {
        ...base.meta,
        warnings: [{ code: "bounds_unavailable", node: "submit-btn" }],
      },
    });
    expect(() => validateSnapshot(snap)).not.toThrow();
  });

  test("validates bounds field with x/y/w/h", () => {
    const snap = makeSnapshot({
      tree: {
        id: "root",
        kind: "screen",
        bounds: { x: 10, y: 20, w: 100, h: 40 },
      },
    });
    expect(() => validateSnapshot(snap)).not.toThrow();
  });
});

describe("usability warning payloads", () => {
  test("validates undersized_target warning with w/h dimensions", () => {
    const base = makeSnapshot();
    const snap = makeSnapshot({
      meta: {
        ...base.meta,
        warnings: [{ code: "undersized_target", node: "submit-btn", w: 30, h: 44 }],
      },
    });
    expect(() => validateSnapshot(snap)).not.toThrow();
  });

  test("validates overlapping_nodes warning with paired node ids", () => {
    const base = makeSnapshot();
    const snap = makeSnapshot({
      meta: {
        ...base.meta,
        warnings: [{ code: "overlapping_nodes", nodes: ["save-top", "save-bottom"] }],
      },
    });
    expect(() => validateSnapshot(snap)).not.toThrow();
  });

  test("rejects non-string entries in warning.nodes", () => {
    const base = makeSnapshot();
    const snap = makeSnapshot({
      meta: {
        ...base.meta,
        warnings: [{ code: "overlapping_nodes", nodes: ["a", 42 as never] }],
      },
    });
    expect(() => validateSnapshot(snap)).toThrow(BrnaValidationError);
  });

  test("rejects non-numeric warning.w", () => {
    const base = makeSnapshot();
    const snap = makeSnapshot({
      meta: {
        ...base.meta,
        warnings: [{ code: "undersized_target", node: "x", w: "30" as never, h: 44 }],
      },
    });
    expect(() => validateSnapshot(snap)).toThrow(BrnaValidationError);
  });
});

describe("suggested_selectors", () => {
  test("accepts node without suggested_selectors", () => {
    const snap = makeSnapshot({
      tree: { id: "root", kind: "screen" },
    });
    expect(() => validateSnapshot(snap)).not.toThrow();
  });

  test("accepts node with non-empty suggested_selectors entries", () => {
    const snap = makeSnapshot({
      tree: {
        id: "root",
        kind: "button",
        selector: "#submit",
        suggested_selectors: ["#submit", "button:Submit"],
      },
    });
    expect(() => validateSnapshot(snap)).not.toThrow();
  });

  test("rejects empty selector entry", () => {
    const snap = makeSnapshot({
      tree: {
        id: "root",
        kind: "button",
        suggested_selectors: ["#submit", ""],
      },
    });
    expect(() => validateSnapshot(snap)).toThrow(BrnaValidationError);
  });

  test("rejects non-string entry", () => {
    const snap = makeSnapshot({
      tree: {
        id: "root",
        kind: "button",
        suggested_selectors: ["#submit", 42 as never],
      },
    });
    expect(() => validateSnapshot(snap)).toThrow(BrnaValidationError);
  });
});

describe("diff validation", () => {
  const node: Node = { id: "x", kind: "button", name: "Submit" };

  test("accepts valid diff events with node context", () => {
    const diff: SnapshotDiff = {
      events: [
        { type: "added", id: "added", parent_id: "root", node: { id: "added", kind: "text" } },
        { type: "removed", id: "removed", parent_id: "root", node: { id: "removed", kind: "button" } },
        {
          type: "modified",
          id: "x",
          node,
          changes: [{ field: "name", before: "Old", after: "Submit" }],
        },
        { type: "moved", id: "x", node, from_parent: "old", to_parent: "new" },
      ],
    };
    expect(() => validateSnapshotDiff(diff)).not.toThrow();
  });

  test("rejects removed event without node context", () => {
    expect(() => validateSnapshotDiff({ events: [{ type: "removed", id: "x" }] })).toThrow(
      BrnaValidationError,
    );
  });

  test("rejects unknown diff event type", () => {
    expect(() => validateSnapshotDiff({ events: [{ type: "renamed", id: "x", node }] })).toThrow(
      BrnaValidationError,
    );
  });

  test("rejects invalid modified field", () => {
    expect(() =>
      validateSnapshotDiff({
        events: [{ type: "modified", id: "x", node, changes: [{ field: "bounds", before: {}, after: {} }] }],
      }),
    ).toThrow(BrnaValidationError);
  });
});
