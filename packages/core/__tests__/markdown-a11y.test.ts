import { describe, expect, test } from "bun:test";
import type { Node } from "@brna/schema";
import { toActiveLayerMarkdown, toMarkdown } from "../src/serialise/index.js";
import { makeSnapshot } from "../__fixtures__/brna1/_helpers.js";

function snapshotWith(tree: Node) {
  return makeSnapshot({ tree });
}

describe("markdown projection — accessibility fields", () => {
  test("accessibility_hint is never rendered", () => {
    const md = toMarkdown(
      snapshotWith({
        id: "root",
        kind: "screen",
        children: [
          {
            id: "btn",
            kind: "button",
            name: "Add",
            accessibility_label: "Add",
            accessibility_hint: "Adds the item to your cart",
          },
        ],
      }),
    );
    expect(md).not.toContain("Adds the item to your cart");
  });

  test("accessibility_label surfaces only via name", () => {
    const md = toMarkdown(
      snapshotWith({
        id: "root",
        kind: "screen",
        children: [
          {
            id: "close",
            kind: "button",
            name: "Close",
            accessibility_label: "Close",
          },
        ],
      }),
    );
    expect(md).toContain('"Close"');
    // No separate accessibility_label token
    expect(md).not.toContain("accessibility_label");
  });

  test("escapes node names with quote and newline characters", () => {
    const md = toMarkdown(
      snapshotWith({
        id: "root",
        kind: "screen",
        children: [
          {
            id: "message",
            kind: "text",
            name: "Line 1\n\"Line 2\"",
          },
        ],
      }),
    );
    expect(md).toContain(String.raw`"Line 1\n\"Line 2\""`);
    expect(md).not.toContain('Line 1\n"Line 2"');
  });
});

describe("markdown projection — screen and active layer", () => {
  test("header falls back to visible screen id when route metadata is missing", () => {
    const md = toMarkdown(
      makeSnapshot({
        screen: { modal_stack: [] },
        tree: {
          id: "root",
          kind: "screen",
          children: [{ id: "screen:checkout", kind: "list", name: "Checkout" }],
        },
      }),
    );
    expect(md).toContain("# Snapshot · screen:checkout · iPhone 15 Pro");
    expect(md).toContain("inferred_screen: screen:checkout");
  });

  test("header inference prefers page screen over root container", () => {
    const md = toMarkdown(
      makeSnapshot({
        screen: { modal_stack: [] },
        tree: {
          id: "screen:root",
          kind: "screen",
          children: [
            { id: "nav", kind: "group" },
            { id: "screen:checkout", kind: "list", name: "Checkout" },
          ],
        },
      }),
    );
    expect(md).toContain("# Snapshot · screen:checkout · iPhone 15 Pro");
    expect(md).toContain("inferred_screen: screen:checkout");
  });

  test("active layer markdown focuses modal-like nodes", () => {
    const md = toActiveLayerMarkdown(
      snapshotWith({
        id: "root",
        kind: "screen",
        children: [
          { id: "background", kind: "button", name: "Background" },
          {
            id: "checkout-review-modal",
            kind: "group",
            children: [{ id: "checkout-place-order", kind: "button", name: "Place order" }],
          },
        ],
      }),
    );
    expect(md).toContain("## active layer");
    expect(md).toContain("group#checkout-review-modal");
    expect(md).toContain("button#checkout-place-order");
    expect(md).not.toContain("Background");
  });
});

describe("markdown projection — range precedence", () => {
  test("range.text wins over numeric values", () => {
    const md = toMarkdown(
      snapshotWith({
        id: "root",
        kind: "screen",
        children: [
          {
            id: "vol",
            kind: "slider",
            name: "Volume",
            range: { min: 0, max: 100, now: 70, text: "seventy percent" },
          },
        ],
      }),
    );
    expect(md).toContain("[seventy percent]");
    expect(md).not.toContain("[70/100]");
  });

  test("now/max combination renders both", () => {
    const md = toMarkdown(
      snapshotWith({
        id: "root",
        kind: "screen",
        children: [
          {
            id: "vol",
            kind: "slider",
            name: "Volume",
            range: { min: 0, max: 100, now: 70 },
          },
        ],
      }),
    );
    expect(md).toContain("[70/100]");
  });

  test("now alone renders single value", () => {
    const md = toMarkdown(
      snapshotWith({
        id: "root",
        kind: "screen",
        children: [
          {
            id: "vol",
            kind: "slider",
            name: "Volume",
            range: { now: 70 },
          },
        ],
      }),
    );
    expect(md).toContain("[70]");
    expect(md).not.toContain("[70/");
  });

  test("only min/max produces no range annotation", () => {
    const md = toMarkdown(
      snapshotWith({
        id: "root",
        kind: "screen",
        children: [
          {
            id: "vol",
            kind: "slider",
            name: "Volume",
            range: { min: 0, max: 100 },
          },
        ],
      }),
    );
    // No bracketed annotation derived from range
    expect(md).not.toContain("[0/");
    expect(md).not.toContain("[100");
  });
});

describe("markdown projection — virtualized lists", () => {
  test("renders omitted items above and below visible ranges", () => {
    const md = toMarkdown(
      snapshotWith({
        id: "root",
        kind: "screen",
        children: [
          {
            id: "feed",
            kind: "list",
            total_count: 10,
            visible_range: { start: 3, end: 5 },
            children: [
              { id: "item-3", kind: "list_item", name: "Item 4" },
              { id: "item-4", kind: "list_item", name: "Item 5" },
              { id: "item-5", kind: "list_item", name: "Item 6" },
            ],
          },
        ],
      }),
    );

    expect(md).toContain("- …3 items above…");
    expect(md).toContain("- list_item#item-3 \"Item 4\"");
    expect(md).toContain("- …4 items below…");
    expect(md.indexOf("…3 items above…")).toBeLessThan(md.indexOf("list_item#item-3"));
    expect(md.indexOf("list_item#item-5")).toBeLessThan(md.indexOf("…4 items below…"));
  });
});

describe("markdown projection — bounds and warnings hidden", () => {
  test("bounds numerics are not emitted", () => {
    const md = toMarkdown(
      snapshotWith({
        id: "root",
        kind: "screen",
        bounds: { x: 100, y: 200, w: 300, h: 400 },
        children: [
          {
            id: "btn",
            kind: "button",
            name: "Tap",
            bounds: { x: 110, y: 210, w: 250, h: 50 },
          },
        ],
      }),
    );
    // None of the rare bounds-only numbers should leak
    expect(md).not.toContain("210");
    expect(md).not.toContain("250");
    expect(md).not.toContain("400");
  });

  test("bounds_unavailable warning string is not rendered", () => {
    const base = makeSnapshot({
      tree: { id: "root", kind: "screen" },
    });
    const snap = {
      ...base,
      meta: {
        ...base.meta,
        warnings: [{ code: "bounds_unavailable", node: "x" }],
      },
    };
    const md = toMarkdown(snap);
    expect(md).not.toContain("bounds_unavailable");
  });
});
