import { describe, expect, test } from "bun:test";
import { escapeControlCharacters } from "../src/format.js";

describe("CLI formatting", () => {
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
});
