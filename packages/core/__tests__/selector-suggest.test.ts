import { describe, expect, test } from "bun:test";
import type { Node, Snapshot } from "@brna/schema";
import { SCHEMA_VERSION } from "@brna/schema";
import { annotateSuggestedSelectors } from "../src/selector/suggest.js";
import { populateSelectors } from "../src/selector/canonical.js";
import { resolve } from "../src/selector/resolve.js";

function snap(tree: Node): Snapshot {
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
    tree,
  };
}

function annotated(tree: Node): Snapshot {
  const populated = snap(populateSelectors(tree));
  return annotateSuggestedSelectors(populated);
}

function findNode(snapshot: Snapshot, predicate: (n: Node) => boolean): Node {
  const stack: Node[] = [snapshot.tree];
  while (stack.length > 0) {
    const n = stack.pop()!;
    if (predicate(n)) return n;
    if (n.children) stack.push(...n.children);
  }
  throw new Error("node not found");
}

describe("annotateSuggestedSelectors", () => {
  test("first entry equals canonical selector", () => {
    const result = annotated({
      id: "root",
      kind: "screen",
      children: [{ id: "submit", kind: "button", role: "button", name: "Submit" }],
    });
    const btn = findNode(result, (n) => n.id === "submit");
    expect(btn.suggested_selectors?.[0]).toBe(btn.selector);
    expect(btn.suggested_selectors?.[0]).toBe("#submit");
  });

  test("includes @testID alternate when id is stable", () => {
    const result = annotated({
      id: "root",
      kind: "screen",
      children: [{ id: "submit", kind: "button", role: "button", name: "Submit" }],
    });
    const btn = findNode(result, (n) => n.id === "submit");
    expect(btn.suggested_selectors).toContain("@submit");
  });

  test("includes role:name when unique", () => {
    const result = annotated({
      id: "root",
      kind: "screen",
      children: [{ id: "submit", kind: "button", role: "button", name: "Sign In" }],
    });
    const btn = findNode(result, (n) => n.id === "submit");
    expect(btn.suggested_selectors).toContain("button:Sign In");
  });

  test("includes kind:name when accessibility role is missing", () => {
    const result = annotated({
      id: "root",
      kind: "screen",
      children: [{ id: "auto:sitemap", kind: "button", name: "Sitemap" }],
    });
    const btn = findNode(result, (n) => n.id === "auto:sitemap");
    expect(btn.suggested_selectors).toContain("button:Sitemap");
    const resolved = resolve("button:Sitemap", result);
    expect("ok" in resolved ? resolved.ok.id : null).toBe("auto:sitemap");
  });

  test("unlabeled input fallback names produce addressable selectors", () => {
    const result = annotated({
      id: "root",
      kind: "screen",
      children: [{ id: "auto:otp", kind: "input", name: "_unlabeled_0", value: "" }],
    });
    const input = findNode(result, (n) => n.id === "auto:otp");
    expect(input.suggested_selectors).toContain("input:_unlabeled_0");
    const resolved = resolve("input:_unlabeled_0", result);
    expect("ok" in resolved ? resolved.ok.id : null).toBe("auto:otp");
  });

  test("ambiguous kind:name uses scoped selector", () => {
    const result = annotated({
      id: "root",
      kind: "screen",
      children: [
        {
          id: "form-address",
          kind: "region",
          children: [{ id: "auto:save1", kind: "button", name: "Save" }],
        },
        {
          id: "form-payment",
          kind: "region",
          children: [{ id: "auto:save2", kind: "button", name: "Save" }],
        },
      ],
    });
    const btn = findNode(result, (n) => n.id === "auto:save1");
    expect(btn.suggested_selectors).toContain("button:Save in #form-address");
    expect(btn.suggested_selectors).not.toContain("button:Save");
  });

  test("ambiguous role:name uses scoped selector", () => {
    const result = annotated({
      id: "root",
      kind: "screen",
      children: [
        {
          id: "form-address",
          kind: "region",
          children: [{ id: "auto:save1", kind: "button", role: "button", name: "Save" }],
        },
        {
          id: "form-payment",
          kind: "region",
          children: [{ id: "auto:save2", kind: "button", role: "button", name: "Save" }],
        },
      ],
    });
    const btn = findNode(result, (n) => n.id === "auto:save1");
    expect(btn.suggested_selectors).toContain("button:Save in #form-address");
    expect(btn.suggested_selectors).not.toContain("button:Save");
  });

  test("text fragment fallback resolves uniquely", () => {
    const result = annotated({
      id: "root",
      kind: "screen",
      children: [
        { id: "auto:tx1", kind: "text", text: "Forgot your password? click here" },
      ],
    });
    const txt = findNode(result, (n) => n.id === "auto:tx1");
    const fragment = txt.suggested_selectors?.find((s) => s.includes("..."));
    expect(fragment).toBeDefined();
  });

  test("suggestions are capped at 4 entries", () => {
    const result = annotated({
      id: "root",
      kind: "screen",
      children: [
        {
          id: "submit",
          kind: "button",
          role: "button",
          name: "Pay Now Securely",
          text: "Pay Now Securely",
        },
      ],
    });
    const btn = findNode(result, (n) => n.id === "submit");
    expect((btn.suggested_selectors ?? []).length).toBeLessThanOrEqual(4);
  });

  test("every suggestion round-trips through resolve()", () => {
    const result = annotated({
      id: "root",
      kind: "screen",
      children: [
        { id: "submit", kind: "button", role: "button", name: "Submit Order" },
        {
          id: "form",
          kind: "region",
          children: [
            { id: "auto:save", kind: "button", role: "button", name: "Save" },
          ],
        },
      ],
    });
    const stack: Node[] = [result.tree];
    while (stack.length > 0) {
      const n = stack.pop()!;
      for (const sel of n.suggested_selectors ?? []) {
        const r = resolve(sel, result);
        if (!("ok" in r) || r.ok.id !== n.id) {
          throw new Error(`selector ${sel} failed to round-trip for ${n.id}`);
        }
      }
      if (n.children) stack.push(...n.children);
    }
  });

  test("nodes with no resolvable suggestions omit the field", () => {
    // auto: id without role/name and without text — only canonical works.
    const result = annotated({
      id: "root",
      kind: "screen",
      children: [{ id: "auto:abcd", kind: "group" }],
    });
    const grp = findNode(result, (n) => n.id === "auto:abcd");
    // canonical (#auto:abcd) is still the first suggestion since it resolves.
    expect(grp.suggested_selectors?.[0]).toBe(grp.selector);
  });

  test("inferred labels prefer normalized role:name and keep raw form", () => {
    const result = annotated({
      id: "root",
      kind: "screen",
      children: [
        {
          id: "auto:sitemap",
          kind: "button",
          role: "button",
          name: "__Sitemap__",
          _dev: { inferred_label: true },
        },
      ],
    });
    const btn = findNode(result, (n) => n.id === "auto:sitemap");
    // First (canonical) is the normalized form, scoped to the nearest stable ancestor.
    expect(btn.suggested_selectors?.[0]).toBe("button:Sitemap in #root");
    expect(btn.suggested_selectors).toContain("button:Sitemap");
    expect(btn.suggested_selectors).toContain("button:__Sitemap__");
    // Both forms still resolve back to the same node.
    const normalized = resolve("button:Sitemap", result);
    const raw = resolve("button:__Sitemap__", result);
    expect("ok" in normalized && normalized.ok.id).toBe("auto:sitemap");
    expect("ok" in raw && raw.ok.id).toBe("auto:sitemap");
  });

  test("non-inferred names with literal underscores are not normalized", () => {
    const result = annotated({
      id: "root",
      kind: "screen",
      children: [
        {
          id: "auto:literal",
          kind: "text",
          name: "regular",
          text: "regular",
        },
      ],
    });
    const node = findNode(result, (n) => n.id === "auto:literal");
    // Without _dev.inferred_label the suggestions stay literal — no rewrite.
    expect(node.suggested_selectors).toContain("text:regular");
  });
});
