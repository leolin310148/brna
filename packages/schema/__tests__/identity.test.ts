import { describe, expect, test } from "bun:test";
import {
  dedupeFlatHitIds,
  dedupeNodeIdsGlobally,
  deriveNodeId,
  deriveNodeIdsForSiblings,
  fnv1a32,
} from "../src/identity.js";
import { BrnaValidationError, SCHEMA_VERSION, validateSnapshot } from "../src/index.js";
import type { Node, Snapshot, SnapshotWarning } from "../src/index.js";

describe("fnv1a32", () => {
  test("is deterministic", () => {
    expect(fnv1a32("hello")).toBe(fnv1a32("hello"));
  });

  test("returns 8-hex characters", () => {
    expect(fnv1a32("anything")).toMatch(/^[0-9a-f]{8}$/);
  });

  test("empty string yields offset basis", () => {
    expect(fnv1a32("")).toBe("811c9dc5");
  });
});

describe("deriveNodeId priority order", () => {
  const baseInput = {
    parent_id: "p1",
    kind: "button" as const,
    role: "button",
    name: "Click",
    position_within_kind: 0,
  };

  test("testID wins over a11y identifier and positional hash", () => {
    expect(
      deriveNodeId({ ...baseInput, testID: "submit", accessibilityIdentifier: "ax" }),
    ).toBe("submit");
  });

  test("a11y identifier wins over positional hash", () => {
    expect(deriveNodeId({ ...baseInput, accessibilityIdentifier: "ax-submit" })).toBe(
      "ax-submit",
    );
  });

  test("whitespace-only explicit ids fall through to positional hash", () => {
    const id = deriveNodeId({
      ...baseInput,
      testID: "   ",
      accessibilityIdentifier: "\t",
    });

    expect(id).toMatch(/^auto:[0-9a-f]{8}$/);
  });

  test("falls through to positional hash", () => {
    const id = deriveNodeId(baseInput);
    expect(id).toMatch(/^auto:[0-9a-f]{8}$/);
  });

  test("identical inputs produce identical auto ids", () => {
    expect(deriveNodeId(baseInput)).toBe(deriveNodeId(baseInput));
  });

  test("differing position produces different auto ids", () => {
    const a = deriveNodeId(baseInput);
    const b = deriveNodeId({ ...baseInput, position_within_kind: 1 });
    expect(a).not.toBe(b);
  });
});

describe("deriveNodeIdsForSiblings", () => {
  test("emits id_collision warning for duplicates", () => {
    const result = deriveNodeIdsForSiblings(
      [
        { kind: "button", position_within_kind: 0 },
        { kind: "button", position_within_kind: 0 },
      ],
      "parent",
    );
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]?.code).toBe("id_collision");
    expect(result.ids[0]).not.toBe(result.ids[1]);
  });

  test("disambiguates with positional suffix", () => {
    const result = deriveNodeIdsForSiblings(
      [
        { kind: "button", position_within_kind: 0 },
        { kind: "button", position_within_kind: 0 },
      ],
      "parent",
    );
    expect(result.ids[1]).toMatch(/#1$/);
  });

  test("no warnings when all siblings unique", () => {
    const result = deriveNodeIdsForSiblings(
      [
        { kind: "button", position_within_kind: 0 },
        { kind: "button", position_within_kind: 1 },
      ],
      "parent",
    );
    expect(result.warnings).toHaveLength(0);
  });
});

describe("dedupeNodeIdsGlobally", () => {
  // The same explicit id (e.g. a shared icon name) recurs under two different
  // parents — deriveNodeIdsForSiblings cannot catch this because it only
  // disambiguates within one parent's child list.
  function crossParentTree(): Node {
    return {
      id: "root",
      kind: "screen",
      children: [
        { id: "list", kind: "list", children: [{ id: "heart", kind: "button" }] },
        { id: "footer", kind: "group", children: [{ id: "heart", kind: "button" }] },
      ],
    };
  }

  test("disambiguates ids that repeat across different parents", () => {
    const root = crossParentTree();
    dedupeNodeIdsGlobally([root]);
    expect(root.children?.[0]?.children?.[0]?.id).toBe("heart");
    expect(root.children?.[1]?.children?.[0]?.id).toBe("heart#1");
  });

  test("reuses the id_collision warning code with base id and count", () => {
    const warnings: SnapshotWarning[] = [];
    dedupeNodeIdsGlobally([crossParentTree()], warnings);
    expect(warnings).toEqual([{ code: "id_collision", node: "heart", count: 2 }]);
  });

  test("leaves a tree with globally unique ids untouched and warning-free", () => {
    const warnings: SnapshotWarning[] = [];
    const root: Node = {
      id: "root",
      kind: "screen",
      children: [
        { id: "a", kind: "button" },
        { id: "b", kind: "button" },
      ],
    };
    dedupeNodeIdsGlobally([root], warnings);
    expect(root.children?.map((c) => c.id)).toEqual(["a", "b"]);
    expect(warnings).toHaveLength(0);
  });

  test("treats all passed roots as one id space (tree + overlays)", () => {
    const tree: Node = { id: "root", kind: "screen", children: [{ id: "dup", kind: "button" }] };
    const overlay: Node = { id: "dup", kind: "modal" };
    dedupeNodeIdsGlobally([tree, overlay]);
    expect(tree.children?.[0]?.id).toBe("dup");
    expect(overlay.id).toBe("dup#1");
  });

  function makeSnapshot(tree: Node, overlays?: Node[]): Snapshot {
    return {
      meta: {
        schema_version: SCHEMA_VERSION,
        captured_at: "2026-03-12T09:00:00.000Z",
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
      tree,
      ...(overlays ? { overlays } : {}),
    };
  }

  test("a cross-parent collision is rejected by validateSnapshot until deduped", () => {
    // Guards the actual bug: without global dedup the whole snapshot is hard-rejected.
    const before = makeSnapshot(crossParentTree());
    expect(() => validateSnapshot(before)).toThrow(BrnaValidationError);

    const deduped = makeSnapshot(crossParentTree());
    dedupeNodeIdsGlobally([deduped.tree]);
    expect(() => validateSnapshot(deduped)).not.toThrow();
  });

  test("dedupes across tree and overlays so validateSnapshot passes", () => {
    const tree: Node = { id: "root", kind: "screen", children: [{ id: "alert", kind: "button" }] };
    const overlay: Node = { id: "alert", kind: "modal" };
    const snap = makeSnapshot(tree, [overlay]);
    expect(() => validateSnapshot(snap)).toThrow(BrnaValidationError);

    dedupeNodeIdsGlobally([snap.tree, ...(snap.overlays ?? [])]);
    expect(() => validateSnapshot(snap)).not.toThrow();
  });

  test("skips past sibling-minted suffixes instead of re-colliding with them", () => {
    // The first parent already holds a sibling-disambiguated pair `heart`/`heart#1`
    // (what deriveNodeIdsForSiblings emits for two `heart` children). A third `heart`
    // under a different parent must become `heart#2` — a naive `${base}#${seen}` would
    // mint a second `heart#1` and reintroduce the duplicate_id this pass removes.
    const warnings: SnapshotWarning[] = [];
    const root: Node = {
      id: "root",
      kind: "screen",
      children: [
        {
          id: "list",
          kind: "list",
          children: [
            { id: "heart", kind: "button" },
            { id: "heart#1", kind: "button" },
          ],
        },
        { id: "footer", kind: "group", children: [{ id: "heart", kind: "button" }] },
      ],
    };
    dedupeNodeIdsGlobally([root], warnings);
    expect(root.children?.[0]?.children?.[0]?.id).toBe("heart");
    expect(root.children?.[0]?.children?.[1]?.id).toBe("heart#1");
    expect(root.children?.[1]?.children?.[0]?.id).toBe("heart#2");
    expect(() => validateSnapshot(makeSnapshot(root))).not.toThrow();
  });
});

describe("dedupeFlatHitIds", () => {
  test("disambiguates repeated ids in list order", () => {
    const hits = [{ id: "tap" }, { id: "tap" }, { id: "other" }, { id: "tap" }];
    dedupeFlatHitIds(hits);
    expect(hits.map((h) => h.id)).toEqual(["tap", "tap#1", "other", "tap#2"]);
  });

  test("leaves already-unique ids untouched", () => {
    const hits = [{ id: "a" }, { id: "b" }, { id: "c" }];
    dedupeFlatHitIds(hits);
    expect(hits.map((h) => h.id)).toEqual(["a", "b", "c"]);
  });

  test("skips past a pre-existing sibling suffix instead of duplicating it", () => {
    // walkLive's sibling pass can already have emitted `heart#1`; a later `heart`
    // from another parent must land on `heart#2`, never a second `heart#1`.
    const hits = [{ id: "heart" }, { id: "heart#1" }, { id: "heart" }];
    dedupeFlatHitIds(hits);
    expect(hits.map((h) => h.id)).toEqual(["heart", "heart#1", "heart#2"]);
    expect(new Set(hits.map((h) => h.id)).size).toBe(hits.length);
  });
});
