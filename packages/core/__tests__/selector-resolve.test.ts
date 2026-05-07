import { describe, expect, test } from "bun:test";
import type { Snapshot } from "@brna/schema";
import { SCHEMA_VERSION } from "@brna/schema";
import { resolve } from "../src/selector/resolve.js";

function snap(treeChildren: Snapshot["tree"]["children"]): Snapshot {
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
    tree: { id: "root", kind: "screen", children: treeChildren },
  };
}

describe("resolve", () => {
  test("unique id match returns ok", () => {
    const s = snap([{ id: "btn", kind: "button", name: "X" }]);
    const r = resolve("#btn", s);
    expect("ok" in r ? r.ok.id : null).toBe("btn");
  });

  test("missing id returns none", () => {
    const s = snap([{ id: "btn", kind: "button", name: "X" }]);
    expect(resolve("#nope", s)).toEqual({ none: true });
  });

  test("multiple role:name matches return ambiguous in document order", () => {
    const s = snap([
      { id: "a", kind: "button", role: "button", name: "Save" },
      { id: "b", kind: "button", role: "button", name: "Save" },
      { id: "c", kind: "button", role: "button", name: "Save" },
    ]);
    const r = resolve("button:Save", s);
    expect("ambiguous" in r ? r.ambiguous.map((n) => n.id) : null).toEqual(["a", "b", "c"]);
  });

  test("role selectors resolve when typed with uppercase role names", () => {
    const s = snap([{ id: "btn", kind: "button", role: "button", name: "Save" }]);
    const r = resolve("Button:Save", s);
    expect("ok" in r ? r.ok.id : null).toBe("btn");
  });

  test("auto-prefers one interactive match over container wrappers", () => {
    const s = snap([
      { id: "check", kind: "group", bounds: { x: 350, y: 57, w: 24, h: 24 } },
      { id: "check", kind: "button", name: "Responder Release", bounds: { x: 350, y: 57, w: 24, h: 24 } },
    ]);
    const r = resolve("#check", s);
    expect("ok" in r ? r.ok.kind : null).toBe("button");
    expect("ok" in r ? r.warning : null).toEqual({
      code: "auto_prefer_interactive",
      skipped: ["check"],
    });
  });

  test("does not auto-prefer when multiple interactive nodes collide", () => {
    const s = snap([
      { id: "delete", kind: "button", name: "Delete" },
      { id: "delete", kind: "button", name: "Delete" },
      { id: "delete", kind: "group" },
    ]);
    const r = resolve("#delete", s);
    expect("ambiguous" in r ? r.ambiguous.map((n) => n.kind) : null).toEqual(["button", "button", "group"]);
  });

  test("at option picks from the original match set before auto-prefer", () => {
    const s = snap([
      { id: "check", kind: "group" },
      { id: "check", kind: "button", name: "Responder Release" },
    ]);
    const r = resolve("#check", s, { at: 0 });
    expect("ok" in r ? r.ok.kind : null).toBe("group");
    expect("ok" in r ? r.warning : null).toBeUndefined();
  });

  test("out-of-range at returns ambiguous with candidate set", () => {
    const s = snap([
      { id: "check", kind: "group" },
      { id: "check", kind: "button", name: "Responder Release" },
    ]);
    const r = resolve("#check", s, { at: 5 });
    expect("ambiguous" in r ? r.at : null).toBe(5);
    expect("ambiguous" in r ? r.ambiguous.map((n) => n.kind) : null).toEqual(["group", "button"]);
  });

  test("#id does not fall through on miss", () => {
    const s = snap([{ id: "x", kind: "button", name: "unknown-id" }]);
    expect(resolve("#unknown-id", s)).toEqual({ none: true });
  });

  test("scoped resolution finds within region", () => {
    const s = snap([
      {
        id: "form",
        kind: "region",
        children: [{ id: "save-inside", kind: "button", role: "button", name: "Save" }],
      },
      { id: "save-outside", kind: "button", role: "button", name: "Save" },
    ]);
    const r = resolve("button:Save in #form", s);
    expect("ok" in r ? r.ok.id : null).toBe("save-inside");
  });

  test("at option applies to scoped leaf matches, not the region selector", () => {
    const s = snap([
      {
        id: "form",
        kind: "region",
        children: [
          { id: "save-top", kind: "button", role: "button", name: "Save" },
          { id: "save-bottom", kind: "button", role: "button", name: "Save" },
        ],
      },
    ]);
    const r = resolve("button:Save in #form", s, { at: 1 });
    expect("ok" in r ? r.ok.id : null).toBe("save-bottom");
  });

  test("role names can contain in without becoming scoped selectors", () => {
    const s = snap([
      { id: "apple-login", kind: "button", role: "button", name: "Log in with Apple" },
    ]);
    const r = resolve("button:Log in with Apple", s);
    expect("ok" in r ? r.ok.id : null).toBe("apple-login");
  });

  test("scoped resolution still works when the role name contains in", () => {
    const s = snap([
      {
        id: "form",
        kind: "region",
        children: [
          { id: "apple-login", kind: "button", role: "button", name: "Log in with Apple" },
        ],
      },
      { id: "other-login", kind: "button", role: "button", name: "Log in with Apple" },
    ]);
    const r = resolve("button:Log in with Apple in #form", s);
    expect("ok" in r ? r.ok.id : null).toBe("apple-login");
  });

  test("scoped resolution propagates none from inner", () => {
    const s = snap([{ id: "btn", kind: "button", role: "button", name: "Save" }]);
    expect(resolve("button:Save in #missing-region", s)).toEqual({ none: true });
  });

  test("text fragment matches in order", () => {
    const s = snap([
      { id: "x", kind: "text", text: "Forgot your password? click here" },
    ]);
    const r = resolve("Forgot...password", s);
    expect("ok" in r ? r.ok.id : null).toBe("x");
  });

  test("resolver is deterministic", () => {
    const s = snap([
      { id: "a", kind: "button", role: "button", name: "Save" },
      { id: "b", kind: "button", role: "button", name: "Save" },
    ]);
    expect(resolve("button:Save", s)).toEqual(resolve("button:Save", s));
  });
});
