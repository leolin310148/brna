import { describe, expect, test } from "bun:test";
import {
  ACTION_ERROR_CODES,
  ACTION_KINDS,
  BrnaValidationError,
  isActionErrorCode,
  validateActionErrorFrame,
  validateActionRequest,
  validateActionRequestFrame,
  validateActionResponseFrame,
} from "../src/index.js";

describe("validateActionRequest", () => {
  test("accepts a valid tap", () => {
    expect(
      validateActionRequest({ kind: "tap", selector: "#save", target_id: "save" }),
    ).toEqual({ kind: "tap", selector: "#save", target_id: "save" });
  });

  test("accepts a valid long_press with duration", () => {
    expect(
      validateActionRequest({
        kind: "long_press",
        selector: "#menu",
        target_id: "menu",
        duration_ms: 750,
      }),
    ).toEqual({
      kind: "long_press",
      selector: "#menu",
      target_id: "menu",
      duration_ms: 750,
    });
  });

  test("accepts a valid type with empty text", () => {
    expect(
      validateActionRequest({
        kind: "type",
        selector: "input:Email",
        target_id: "email",
        text: "",
      }),
    ).toEqual({ kind: "type", selector: "input:Email", target_id: "email", text: "" });
  });

  test("accepts a valid scroll without by", () => {
    expect(
      validateActionRequest({
        kind: "scroll",
        selector: "#feed",
        target_id: "feed",
        direction: "down",
      }),
    ).toEqual({ kind: "scroll", selector: "#feed", target_id: "feed", direction: "down" });
  });

  test("accepts a valid scroll with by", () => {
    expect(
      validateActionRequest({
        kind: "scroll",
        selector: "#feed",
        target_id: "feed",
        direction: "up",
        by: 300,
      }),
    ).toEqual({
      kind: "scroll",
      selector: "#feed",
      target_id: "feed",
      direction: "up",
      by: 300,
    });
  });

  test("accepts a valid swipe with by", () => {
    expect(
      validateActionRequest({
        kind: "swipe",
        selector: "#feed",
        target_id: "feed",
        direction: "left",
        by: 120,
      }),
    ).toEqual({
      kind: "swipe",
      selector: "#feed",
      target_id: "feed",
      direction: "left",
      by: 120,
    });
  });

  test("accepts a valid key tab", () => {
    expect(validateActionRequest({ kind: "key", key: "tab" })).toEqual({
      kind: "key",
      key: "tab",
    });
  });

  test("rejects non-object input", () => {
    expect(() => validateActionRequest(null)).toThrow(BrnaValidationError);
    expect(() => validateActionRequest("tap")).toThrow(BrnaValidationError);
  });

  test("rejects unknown kind", () => {
    expect(() => validateActionRequest({ kind: "clear" })).toThrow(/kind/);
  });

  test("rejects missing kind", () => {
    expect(() => validateActionRequest({ selector: "#x", target_id: "x" })).toThrow(/kind/);
  });

  test("rejects long_press with non-positive duration", () => {
    expect(() =>
      validateActionRequest({
        kind: "long_press",
        selector: "#m",
        target_id: "m",
        duration_ms: 0,
      }),
    ).toThrow(/duration/);
    expect(() =>
      validateActionRequest({
        kind: "long_press",
        selector: "#m",
        target_id: "m",
        duration_ms: -100,
      }),
    ).toThrow(/duration/);
    expect(() =>
      validateActionRequest({
        kind: "long_press",
        selector: "#m",
        target_id: "m",
        duration_ms: 1.5,
      }),
    ).toThrow(/duration/);
    expect(() =>
      validateActionRequest({
        kind: "long_press",
        selector: "#m",
        target_id: "m",
        duration_ms: Number.MAX_SAFE_INTEGER + 1,
      }),
    ).toThrow(/duration/);
  });

  test("rejects type with non-string text", () => {
    expect(() =>
      validateActionRequest({ kind: "type", selector: "#i", target_id: "i", text: 5 }),
    ).toThrow(/text/);
  });

  test("rejects scroll with bad direction", () => {
    expect(() =>
      validateActionRequest({
        kind: "scroll",
        selector: "#f",
        target_id: "f",
        direction: "diagonal",
      }),
    ).toThrow(/direction/);
  });

  test("rejects scroll with non-positive by", () => {
    expect(() =>
      validateActionRequest({
        kind: "scroll",
        selector: "#f",
        target_id: "f",
        direction: "up",
        by: 0,
      }),
    ).toThrow(/by/);
    expect(() =>
      validateActionRequest({
        kind: "scroll",
        selector: "#f",
        target_id: "f",
        direction: "up",
        by: Number.MAX_SAFE_INTEGER + 1,
      }),
    ).toThrow(/by/);
  });

  test("rejects swipe with bad direction", () => {
    expect(() =>
      validateActionRequest({
        kind: "swipe",
        selector: "#f",
        target_id: "f",
        direction: "diagonal",
      }),
    ).toThrow(/direction/);
  });

  test("rejects swipe with non-positive by", () => {
    expect(() =>
      validateActionRequest({
        kind: "swipe",
        selector: "#f",
        target_id: "f",
        direction: "left",
        by: 0,
      }),
    ).toThrow(/by/);
  });

  test("accepts supported key values", () => {
    expect(validateActionRequest({ kind: "key", key: "enter" })).toEqual({ kind: "key", key: "enter" });
    expect(validateActionRequest({ kind: "key", key: "arrow_down" })).toEqual({ kind: "key", key: "arrow_down" });
  });

  test("rejects key with bad value", () => {
    expect(() => validateActionRequest({ kind: "key", key: "space" })).toThrow(/key/);
  });

  test("rejects targeted action with empty selector or target_id", () => {
    expect(() => validateActionRequest({ kind: "tap", selector: "", target_id: "x" })).toThrow();
    expect(() => validateActionRequest({ kind: "tap", selector: "x", target_id: "" })).toThrow();
  });

  test("ACTION_KINDS does not include click", () => {
    expect((ACTION_KINDS as readonly string[]).includes("click")).toBe(false);
  });
});

describe("validateActionRequestFrame", () => {
  test("accepts a valid frame", () => {
    const frame = validateActionRequestFrame({
      type: "action.request",
      id: "abc",
      action: { kind: "tap", selector: "#x", target_id: "x" },
    });
    expect(frame.id).toBe("abc");
    expect(frame.action.kind).toBe("tap");
  });

  test("rejects missing id", () => {
    expect(() =>
      validateActionRequestFrame({
        type: "action.request",
        action: { kind: "tap", selector: "#x", target_id: "x" },
      }),
    ).toThrow(/id/);
  });

  test("rejects wrong type", () => {
    expect(() =>
      validateActionRequestFrame({
        type: "snapshot.request",
        id: "abc",
        action: { kind: "tap", selector: "#x", target_id: "x" },
      }),
    ).toThrow(/type/);
  });
});

describe("validateActionResponseFrame", () => {
  test("accepts a valid frame", () => {
    expect(
      validateActionResponseFrame({ type: "action.response", id: "abc", elapsed_ms: 12 }),
    ).toEqual({ type: "action.response", id: "abc", elapsed_ms: 12 });
  });

  test("rejects negative elapsed_ms", () => {
    expect(() =>
      validateActionResponseFrame({ type: "action.response", id: "abc", elapsed_ms: -1 }),
    ).toThrow(/elapsed_ms/);
  });
});

describe("validateActionErrorFrame", () => {
  test("accepts a valid frame", () => {
    expect(
      validateActionErrorFrame({
        type: "action.error",
        id: "abc",
        code: "target_disabled",
        message: "node is disabled",
      }),
    ).toEqual({
      type: "action.error",
      id: "abc",
      code: "target_disabled",
      message: "node is disabled",
    });
  });

  test("accepts unknown code strings (forward compat)", () => {
    expect(
      validateActionErrorFrame({
        type: "action.error",
        id: "abc",
        code: "future_unknown_code",
        message: "x",
      }).code,
    ).toBe("future_unknown_code");
  });

  test("rejects missing message", () => {
    expect(() =>
      validateActionErrorFrame({ type: "action.error", id: "abc", code: "x" }),
    ).toThrow(/message/);
  });
});

describe("isActionErrorCode", () => {
  test("accepts known codes", () => {
    for (const code of ACTION_ERROR_CODES) expect(isActionErrorCode(code)).toBe(true);
  });

  test("rejects unknown codes", () => {
    expect(isActionErrorCode("not_a_real_code")).toBe(false);
  });
});
