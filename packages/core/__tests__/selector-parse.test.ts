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
