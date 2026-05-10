import { describe, expect, test } from "bun:test";
import { BrnaSelectorParseError } from "@brna/schema";
import { parseSelector } from "../src/selector/parse.js";

describe("parseSelector", () => {
  test("#submit-btn → id selector", () => {
    expect(parseSelector("#submit-btn")).toEqual({ kind: "id", id: "submit-btn" });
  });

  test("# selector trims accidental whitespace around id", () => {
    expect(parseSelector("#  submit-btn  ")).toEqual({ kind: "id", id: "submit-btn" });
  });

  test("@email-input → testID selector", () => {
    expect(parseSelector("@email-input")).toEqual({ kind: "testid", testID: "email-input" });
  });

  test("@ selector trims accidental whitespace around testID", () => {
    expect(parseSelector("@  email-input  ")).toEqual({ kind: "testid", testID: "email-input" });
  });

  test("button:Sign In → role-name", () => {
    expect(parseSelector("button:Sign In")).toEqual({
      kind: "role-name",
      role: "button",
      name: "Sign In",
    });
  });

  test("role selector syntax is case-insensitive", () => {
    expect(parseSelector("Button:Sign In")).toEqual({
      kind: "role-name",
      role: "button",
      name: "Sign In",
    });
  });

  test("button:Save in #form-address → scoped role-name", () => {
    expect(parseSelector("button:Save in #form-address")).toEqual({
      kind: "role-name",
      role: "button",
      name: "Save",
      in: { kind: "id", id: "form-address" },
    });
  });

  test("button:Log in with Apple → role-name with in in label", () => {
    expect(parseSelector("button:Log in with Apple")).toEqual({
      kind: "role-name",
      role: "button",
      name: "Log in with Apple",
    });
  });

  test("button:Log in with Apple in #form → scoped role-name", () => {
    expect(parseSelector("button:Log in with Apple in #form")).toEqual({
      kind: "role-name",
      role: "button",
      name: "Log in with Apple",
      in: { kind: "id", id: "form" },
    });
  });

  test("quoted role names keep selector-like text literal", () => {
    expect(parseSelector('button:"Save in #toolbar"')).toEqual({
      kind: "role-name",
      role: "button",
      name: "Save in #toolbar",
    });
  });

  test("quoted role names can still be scoped", () => {
    expect(parseSelector('button:"Save in #toolbar" in #form')).toEqual({
      kind: "role-name",
      role: "button",
      name: "Save in #toolbar",
      in: { kind: "id", id: "form" },
    });
  });

  test("quoted role names can be scoped to testID selectors", () => {
    expect(parseSelector('button:"Save in @toolbar" in @form')).toEqual({
      kind: "role-name",
      role: "button",
      name: "Save in @toolbar",
      in: { kind: "testid", testID: "form" },
    });
  });

  test("quoted role names can be scoped to role-name selectors", () => {
    expect(parseSelector('button:"Save in region:Toolbar" in region:Settings')).toEqual({
      kind: "role-name",
      role: "button",
      name: "Save in region:Toolbar",
      in: { kind: "role-name", role: "region", name: "Settings" },
    });
  });

  test("quoted role names can contain text-fragment punctuation", () => {
    expect(parseSelector('text:"Loading...done"')).toEqual({
      kind: "role-name",
      role: "text",
      name: "Loading...done",
    });
  });

  test("quoted role names can start with a literal quote", () => {
    expect(parseSelector('button:"\\"Quoted\\""')).toEqual({
      kind: "role-name",
      role: "button",
      name: '"Quoted"',
    });
  });

  test("malformed quoted role names report specific parse errors", () => {
    const cases = [
      ['button:"Save', "unterminated_quote"],
      ['button:"Save\\q"', "quoted_name"],
      ['button:"Save" near #form', "trailing_selector"],
      ['button:"Save" in screen', "scope"],
    ] as const;

    for (const [selector, code] of cases) {
      try {
        parseSelector(selector);
        throw new Error("expected throw");
      } catch (err) {
        expect(err).toBeInstanceOf(BrnaSelectorParseError);
        expect((err as BrnaSelectorParseError).code).toBe(code);
      }
    }
  });

  test("Forgot...password → text fragment", () => {
    expect(parseSelector("Forgot...password")).toEqual({
      kind: "text",
      parts: ["Forgot", "password"],
    });
  });

  test("malformed input throws with column", () => {
    try {
      parseSelector("button:");
      throw new Error("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(BrnaSelectorParseError);
      expect((err as BrnaSelectorParseError).column).toBe(6);
    }
  });

  test("empty selector throws", () => {
    expect(() => parseSelector("")).toThrow(BrnaSelectorParseError);
  });

  test("# alone throws", () => {
    expect(() => parseSelector("#")).toThrow(BrnaSelectorParseError);
  });

  test("@ alone throws", () => {
    expect(() => parseSelector("@")).toThrow(BrnaSelectorParseError);
  });
});
