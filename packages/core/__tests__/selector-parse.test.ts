import { describe, expect, test } from "bun:test";
import { BrnaSelectorParseError } from "@brna/schema";
import { parseSelector } from "../src/selector/parse.js";

describe("parseSelector", () => {
  test("#submit-btn → id selector", () => {
    expect(parseSelector("#submit-btn")).toEqual({ kind: "id", id: "submit-btn" });
  });

  test("@email-input → testID selector", () => {
    expect(parseSelector("@email-input")).toEqual({ kind: "testid", testID: "email-input" });
  });

  test("button:Sign In → role-name", () => {
    expect(parseSelector("button:Sign In")).toEqual({
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
