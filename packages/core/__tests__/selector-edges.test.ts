import { describe, expect, test } from "bun:test";
import { BrnaSelectorParseError } from "@brna/schema";
import { canonicalSelectorFor } from "../src/selector/canonical.js";
import { displayLabel, isInferredSentinelLabel } from "../src/selector/inferred-label.js";
import { parseSelector } from "../src/selector/parse.js";

describe("selector edge cases", () => {
  test("parses fallback and malformed selector shapes", () => {
    expect(() => parseSelector(42 as never)).toThrow(BrnaSelectorParseError);
    expect(() => parseSelector("...only")).toThrow(/text fragment/);
    expect(() => parseSelector("button:")).toThrow(/requires a name/);
    expect(parseSelector("1bad:Name")).toEqual({ kind: "xpath", path: "1bad:Name" });
    expect(parseSelector("plain/path")).toEqual({ kind: "xpath", path: "plain/path" });
  });

  test("normalises inferred sentinel labels for display and canonical selectors", () => {
    expect(isInferredSentinelLabel({ id: "x", kind: "button" })).toBe(false);
    expect(isInferredSentinelLabel({ id: "x", kind: "button", name: "__Save__" })).toBe(false);
    expect(isInferredSentinelLabel({
      id: "x",
      kind: "button",
      name: "__Save__",
      _dev: { inferred_label: true },
    })).toBe(true);
    expect(displayLabel({ id: "x", kind: "button", name: "__Save__", _dev: { inferred_label: true } }))
      .toBe("Save");
    expect(canonicalSelectorFor({
      id: "auto:button",
      kind: "button",
      role: "button",
      name: "__Save__",
      _dev: { inferred_label: true },
    })).toBe("button:Save");
  });
});
