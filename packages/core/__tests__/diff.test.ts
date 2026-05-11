import { describe, expect, test } from "bun:test";
import type { Snapshot } from "@brna/schema";
import { SCHEMA_VERSION } from "@brna/schema";
import { diff } from "../src/diff/diff.js";
import {
  fromDiffJSON,
  fromDiffYAML,
  toDiffJSON,
  toDiffMarkdown,
  toDiffYAML,
  toTraceMarkdown,
} from "../src/diff/index.js";

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

describe("diff", () => {
  test("added emits a single added event", () => {
    const a = snap([]);
    const b = snap([{ id: "x", kind: "button", name: "X" }]);
    const d = diff(a, b);
    expect(d.events).toHaveLength(1);
    expect(d.events[0]?.type).toBe("added");
    expect(d.events[0]).toMatchObject({
      type: "added",
      id: "x",
      parent_id: "root",
      node: { id: "x", kind: "button", name: "X" },
    });
  });

  test("removed emits a single removed event", () => {
    const a = snap([{ id: "x", kind: "button", name: "X" }]);
    const b = snap([]);
    const d = diff(a, b);
    expect(d.events).toHaveLength(1);
    expect(d.events[0]?.type).toBe("removed");
    expect(d.events[0]).toMatchObject({
      type: "removed",
      id: "x",
      parent_id: "root",
      node: { id: "x", kind: "button", name: "X" },
    });
  });

  test("modified emits a modified event", () => {
    const a = snap([{ id: "x", kind: "button", name: "Old" }]);
    const b = snap([{ id: "x", kind: "button", name: "New" }]);
    const d = diff(a, b);
    expect(d.events).toHaveLength(1);
    expect(d.events[0]?.type).toBe("modified");
    expect(d.events[0]).toMatchObject({
      type: "modified",
      id: "x",
      node: { id: "x", kind: "button", name: "New" },
      changes: [{ field: "name", before: "Old", after: "New" }],
    });
  });

  test("moved emits a moved event, not add+remove", () => {
    const a = snap([
      { id: "p1", kind: "region", children: [{ id: "x", kind: "button", name: "X" }] },
      { id: "p2", kind: "region", children: [] },
    ]);
    const b = snap([
      { id: "p1", kind: "region", children: [] },
      { id: "p2", kind: "region", children: [{ id: "x", kind: "button", name: "X" }] },
    ]);
    const d = diff(a, b);
    const movedEvents = d.events.filter((e) => e.type === "moved");
    expect(movedEvents).toHaveLength(1);
    expect(movedEvents[0]).toMatchObject({
      type: "moved",
      id: "x",
      node: { id: "x", kind: "button", name: "X" },
      from_parent: "p1",
      to_parent: "p2",
    });
    expect(d.events.some((e) => e.type === "added" && e.id === "x")).toBe(false);
    expect(d.events.some((e) => e.type === "removed" && e.id === "x")).toBe(false);
  });

  test("cosmetic bounds drift produces no events", () => {
    const a = snap([
      { id: "x", kind: "button", name: "X", bounds: { x: 10, y: 10, w: 100, h: 40 } },
    ]);
    const b = snap([
      { id: "x", kind: "button", name: "X", bounds: { x: 10.5, y: 10.5, w: 100, h: 40 } },
    ]);
    expect(diff(a, b).events).toHaveLength(0);
  });

  test("equivalent state set produces no events", () => {
    const a = snap([{ id: "x", kind: "button", name: "X", state: ["focused", "selected"] }]);
    const b = snap([{ id: "x", kind: "button", name: "X", state: ["selected", "focused"] }]);
    expect(diff(a, b).events).toHaveLength(0);
  });
});

describe("diff markdown", () => {
  test("empty diff emits zero bytes", () => {
    expect(toDiffMarkdown({ events: [] })).toBe("");
  });

  test("renders added, removed, modified, and moved line shapes", () => {
    expect(
      toDiffMarkdown({
        events: [
          { type: "added", id: "add", parent_id: "root", node: { id: "add", kind: "button", name: "Sign In" } },
          { type: "removed", id: "toast_42", node: { id: "toast_42", kind: "toast", name: "Saved" } },
          {
            type: "modified",
            id: "email",
            node: { id: "email", kind: "input", name: "Email", value: "leo@" },
            changes: [{ field: "value", before: "", after: "leo@" }],
          },
          {
            type: "moved",
            id: "nav",
            node: { id: "nav", kind: "region", name: "Navigation" },
            from_parent: "",
            to_parent: "main",
          },
        ],
      }),
    ).toBe(
      '+ button#add "Sign In"\n' +
        '- toast#toast_42 "Saved"\n' +
        '~ input#email "Email" = "leo@" value="" → "leo@"\n' +
        '↻ region#nav "Navigation" <root> → main\n',
    );
  });

  test("modified fields and state flags render in canonical order", () => {
    expect(
      toDiffMarkdown({
        events: [
          {
            type: "modified",
            id: "x",
            node: { id: "x", kind: "input", name: "Y", value: "b", state: ["busy", "focused"] },
            changes: [
              { field: "state", before: ["loading", "selected"], after: ["focused", "busy"] },
              { field: "value", before: "a", after: "b" },
              { field: "name", before: "X", after: "Y" },
            ],
          },
        ],
      }),
    ).toBe(
      '~ input#x "Y" = "b" [busy, focused] name="X" → "Y", value="a" → "b", state[+busy, +focused, -loading, -selected]\n',
    );
  });
});

describe("diff serialisation", () => {
  test("JSON and YAML round-trip valid diffs", () => {
    const d = {
      events: [
        {
          type: "modified" as const,
          id: "x",
          node: { id: "x", kind: "input" as const, value: "b" },
          changes: [{ field: "value" as const, before: "a", after: "b" }],
        },
      ],
    };
    expect(fromDiffJSON(toDiffJSON(d))).toEqual(d);
    expect(fromDiffYAML(toDiffYAML(d))).toEqual(d);
  });

  test("generated field additions and removals round-trip through JSON and YAML", () => {
    const d = diff(
      snap([{ id: "x", kind: "input", value: "a" }]),
      snap([{ id: "x", kind: "input", name: "Email" }]),
    );
    expect(d.events).toEqual([
      {
        type: "modified",
        id: "x",
        node: { id: "x", kind: "input", name: "Email" },
        changes: [
          { field: "name", before: null, after: "Email" },
          { field: "value", before: "a", after: null },
        ],
      },
    ]);
    expect(fromDiffJSON(toDiffJSON(d))).toEqual(d);
    expect(fromDiffYAML(toDiffYAML(d))).toEqual(d);
  });

  test("JSON and YAML parsers reject invalid diffs", () => {
    expect(() => fromDiffJSON('{"events":[{"type":"removed","id":"x"}]}')).toThrow();
    expect(() => fromDiffYAML("events:\n  - type: removed\n    id: x\n")).toThrow();
  });
});

describe("trace markdown", () => {
  test("step body delegates to toDiffMarkdown", () => {
    const from = snap([]);
    const to = snap([{ id: "x", kind: "button", name: "X" }]);
    const trace = toTraceMarkdown([{ from, to, event: "tap #x" }]);
    expect(trace).toBe("# Trace · 1 step\n\n## step 1 → 2 (after tap #x)\n+ button#x \"X\"\n");
    expect(trace).toContain(toDiffMarkdown(diff(from, to)));
  });
});
