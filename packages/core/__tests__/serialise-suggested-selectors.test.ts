import { describe, expect, test } from "bun:test";
import type { Node, Snapshot } from "@brna/schema";
import { SCHEMA_VERSION } from "@brna/schema";
import { fromJSON, fromYAML, toJSON, toMarkdown, toYAML } from "../src/serialise/index.js";

function snapshotWith(tree: Node): Snapshot {
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

describe("JSON projection — suggested_selectors", () => {
  test("preserves the full suggested_selectors array", () => {
    const snap = snapshotWith({
      id: "root",
      kind: "screen",
      children: [
        {
          id: "submit",
          kind: "button",
          role: "button",
          name: "Submit",
          selector: "#submit",
          suggested_selectors: [
            "#submit",
            "@submit",
            "button:Submit",
            "button:Submit in #root",
          ],
        },
      ],
    });
    const json = toJSON(snap);
    const round = fromJSON(json);
    const button = round.tree.children?.[0] as Node;
    expect(button.suggested_selectors).toEqual([
      "#submit",
      "@submit",
      "button:Submit",
      "button:Submit in #root",
    ]);
  });

  test("YAML preserves suggested_selectors round-trip", () => {
    const snap = snapshotWith({
      id: "root",
      kind: "screen",
      children: [
        {
          id: "submit",
          kind: "button",
          selector: "#submit",
          suggested_selectors: ["#submit", "@submit"],
        },
      ],
    });
    const yaml = toYAML(snap);
    const round = fromYAML(yaml);
    const button = round.tree.children?.[0] as Node;
    expect(button.suggested_selectors).toEqual(["#submit", "@submit"]);
  });
});

describe("Markdown projection — suggested_selectors", () => {
  test("includes canonical selector inline for actionable nodes", () => {
    const md = toMarkdown(
      snapshotWith({
        id: "root",
        kind: "screen",
        children: [
          {
            id: "submit",
            kind: "button",
            name: "Submit",
            actions: ["tap"],
            selector: "#submit",
            suggested_selectors: ["#submit", "button:Submit"],
          },
        ],
      }),
    );
    expect(md).toContain("#submit");
  });

  test("limits alternates to two entries", () => {
    const md = toMarkdown(
      snapshotWith({
        id: "root",
        kind: "screen",
        children: [
          {
            id: "submit",
            kind: "button",
            name: "Submit",
            selector: "#submit",
            suggested_selectors: [
              "#submit",
              "@submit",
              "button:Submit",
              "button:Submit in #root",
            ],
          },
        ],
      }),
    );
    const match = md.match(/selectors=\[([^\]]+)\]/);
    expect(match).not.toBeNull();
    const inside = match![1]!;
    const items = inside.split(",").map((s) => s.trim());
    expect(items.length).toBeLessThanOrEqual(2);
  });

  test("omits selectors=[] when only canonical is present", () => {
    const md = toMarkdown(
      snapshotWith({
        id: "root",
        kind: "screen",
        children: [
          {
            id: "submit",
            kind: "button",
            selector: "#submit",
            suggested_selectors: ["#submit"],
          },
        ],
      }),
    );
    expect(md).not.toContain("selectors=");
  });

  test("renders canonical selector for auto: actionable nodes", () => {
    const md = toMarkdown(
      snapshotWith({
        id: "root",
        kind: "screen",
        children: [
          {
            id: "auto:save",
            kind: "button",
            role: "button",
            name: "Save",
            actions: ["tap"],
            selector: "button:Save in #root",
            suggested_selectors: ["button:Save in #root"],
          },
        ],
      }),
    );
    expect(md).toContain("→ tap button:Save in #root");
  });
});

describe("inferred-label normalization in serialisers", () => {
  const snap = snapshotWith({
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

  test("Markdown drops sentinel underscores in quoted name", () => {
    const md = toMarkdown(snap);
    expect(md).toContain('"Sitemap"');
    expect(md).not.toContain('"__Sitemap__"');
  });

  test("JSON preserves raw inferred label", () => {
    const json = toJSON(snap);
    expect(json).toContain('"name": "__Sitemap__"');
  });

  test("YAML preserves raw inferred label", () => {
    const yaml = toYAML(snap);
    const round = fromYAML(yaml);
    const button = round.tree.children?.[0] as Node;
    expect(button.name).toBe("__Sitemap__");
  });
});
