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
