import { describe, expect, test } from "bun:test";
import { escapeControlCharacters, formatTimestamp } from "../src/format.js";

describe("CLI formatting", () => {
  test("formats timestamps as ISO strings", () => {
    expect(formatTimestamp(1700000000000)).toBe("2023-11-14T22:13:20.000Z");
  });

  test("formats invalid timestamps without throwing", () => {
    expect(formatTimestamp(Number.NaN)).toBe("invalid");
  });

  test("escapes bidi formatting controls", () => {
    const escaped = escapeControlCharacters("safe\u061c\u200fgnirts\u200e");

    expect(escaped).toBe("safe\\u061c\\u200fgnirts\\u200e");
    expect(escaped).not.toContain("\u061c");
    expect(escaped).not.toContain("\u200f");
    expect(escaped).not.toContain("\u200e");
  });

  test("escapes invisible zero-width formatting controls", () => {
    const escaped = escapeControlCharacters("zero\u200bwidth\u2060space\ufeff");

    expect(escaped).toBe("zero\\u200bwidth\\u2060space\\ufeff");
    expect(escaped).not.toContain("\u200b");
    expect(escaped).not.toContain("\u2060");
    expect(escaped).not.toContain("\ufeff");
  });

  test("escapes unicode line and paragraph separators", () => {
    const escaped = escapeControlCharacters("first\u2028second\u2029third");

    expect(escaped).toBe("first\\u2028second\\u2029third");
    expect(escaped).not.toContain("\u2028");
    expect(escaped).not.toContain("\u2029");
  });
});
