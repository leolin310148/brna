import { describe, expect, test } from "bun:test";
import { SCHEMA_VERSION, type Node, type Snapshot } from "@brna/schema";
import { diff, filterDiffByTarget } from "../src/index.js";

function snap(tree: Node, overlays?: Node[]): Snapshot {
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
    ...(overlays ? { overlays } : {}),
  };
}

const baseline = snap({
  id: "root",
  kind: "screen",
  children: [
    {
      id: "header",
      kind: "group",
      children: [{ id: "title", kind: "text", name: "Hello" }],
    },
    {
      id: "form",
      kind: "group",
      children: [
        { id: "email", kind: "input" },
        { id: "submit", kind: "button", name: "Save" },
      ],
    },
    {
      id: "footer",
      kind: "group",
      children: [{ id: "clock", kind: "text", name: "12:00" }],
    },
  ],
});

describe("filterDiffByTarget", () => {
  test("retains target, ancestors, and siblings; drops unrelated regions", () => {
    const fresh = snap({
      id: "root",
      kind: "screen",
      children: [
        {
          id: "header",
          kind: "group",
          children: [{ id: "title", kind: "text", name: "Welcome" }],
        },
        {
          id: "form",
          kind: "group",
          children: [
            { id: "email", kind: "input" },
            { id: "submit", kind: "button", name: "Submit" },
          ],
        },
        {
          id: "footer",
          kind: "group",
          children: [{ id: "clock", kind: "text", name: "12:01" }],
        },
      ],
    });
    const full = diff(baseline, fresh);
    const filtered = filterDiffByTarget(baseline, fresh, full, "submit");
    const ids = filtered.events.map((e) => e.id).sort();
    expect(ids).toContain("submit");
    // siblings of submit (form's children) — email is unchanged so not in events;
    // submit itself is. title and clock changed but are unrelated → dropped.
    expect(ids).not.toContain("title");
    expect(ids).not.toContain("clock");
  });

  test("retains ancestors when ancestor itself was modified", () => {
    const fresh = snap({
      id: "root",
      kind: "screen",
      role: "main", // ancestor change
      children: baseline.tree.children!,
    });
    const full = diff(baseline, fresh);
    const filtered = filterDiffByTarget(baseline, fresh, full, "submit");
    const ids = filtered.events.map((e) => e.id);
    expect(ids).toContain("root");
  });

  test("retains immediate siblings even when only present in baseline (removed)", () => {
    const fresh = snap({
      id: "root",
      kind: "screen",
      children: [
        baseline.tree.children![0]!,
        {
          id: "form",
          kind: "group",
          children: [
            // email removed
            { id: "submit", kind: "button", name: "Save" },
          ],
        },
        baseline.tree.children![2]!,
      ],
    });
    const full = diff(baseline, fresh);
    const filtered = filterDiffByTarget(baseline, fresh, full, "submit");
    const ids = filtered.events.map((e) => e.id);
    expect(ids).toContain("email");
  });

  test("retains immediate siblings only present in fresh (added)", () => {
    const fresh = snap({
      id: "root",
      kind: "screen",
      children: [
        baseline.tree.children![0]!,
        {
          id: "form",
          kind: "group",
          children: [
            { id: "email", kind: "input" },
            { id: "submit", kind: "button", name: "Save" },
            { id: "cancel", kind: "button", name: "Cancel" },
          ],
        },
        baseline.tree.children![2]!,
      ],
    });
    const full = diff(baseline, fresh);
    const filtered = filterDiffByTarget(baseline, fresh, full, "submit");
    const ids = filtered.events.map((e) => e.id);
    expect(ids).toContain("cancel");
  });

  test("retains added overlays even though they live outside the tree", () => {
    const fresh = snap(
      baseline.tree,
      [{ id: "toast-1", kind: "toast", name: "Saved" }],
    );
    const full = diff(baseline, fresh);
    const filtered = filterDiffByTarget(baseline, fresh, full, "submit");
    const ids = filtered.events.map((e) => e.id);
    expect(ids).toContain("toast-1");
  });

  test("drops descendants of the target", () => {
    const targetWithChild: Node = {
      id: "form",
      kind: "group",
      children: [
        { id: "email", kind: "input" },
        {
          id: "submit",
          kind: "button",
          name: "Save",
          children: [{ id: "spinner", kind: "image" }],
        },
      ],
    };
    const fresh = snap({
      id: "root",
      kind: "screen",
      children: [
        baseline.tree.children![0]!,
        targetWithChild,
        baseline.tree.children![2]!,
      ],
    });
    const full = diff(baseline, fresh);
    const filtered = filterDiffByTarget(baseline, fresh, full, "submit");
    const ids = filtered.events.map((e) => e.id);
    expect(ids).not.toContain("spinner");
  });

  test("returns empty events when nothing in scope changed", () => {
    const fresh = snap({
      id: "root",
      kind: "screen",
      children: [
        baseline.tree.children![0]!,
        baseline.tree.children![1]!,
        // only an unrelated region changed
        {
          id: "footer",
          kind: "group",
          children: [{ id: "clock", kind: "text", name: "12:01" }],
        },
      ],
    });
    const full = diff(baseline, fresh);
    expect(full.events.length).toBeGreaterThan(0);
    const filtered = filterDiffByTarget(baseline, fresh, full, "submit");
    expect(filtered.events).toEqual([]);
  });
});
