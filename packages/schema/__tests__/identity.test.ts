import { describe, expect, test } from "bun:test";
import { deriveNodeId, deriveNodeIdsForSiblings, fnv1a32 } from "../src/identity.js";

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
