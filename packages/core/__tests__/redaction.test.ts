import { describe, expect, test } from "bun:test";
import type { Snapshot } from "@brna/schema";
import { toJSON, toMarkdown } from "../src/index.js";

function snapshot(): Snapshot {
  return {
    meta: {
      schema_version: "brna/1",
      captured_at: "2026-05-02T00:00:00.000Z",
      app: { bundle_id: "app", version: "1.0.0" },
      device: {
        platform: "ios",
        os_version: "17",
        model: "sim",
        viewport: { w: 1, h: 1, scale: 1 },
        locale: "en",
      },
      session_id: "s",
      snapshot_id: "snap",
    },
    screen: { modal_stack: [] },
    tree: {
      id: "root",
      kind: "screen",
      children: [
        { id: "email", kind: "text", name: "Contact leo@example.com" },
        { id: "password", kind: "input", value: "myPassword123", text: "Secret", state: ["secure"] },
      ],
    },
  };
}

describe("snapshot redaction", () => {
  test("applies regex rules before JSON serialization", () => {
    const out = toJSON(snapshot(), {
      rules: [{ match: { source: "[\\w.+-]+@[\\w-]+\\.[\\w.-]+" }, replace: "<email>" }],
    });
    expect(out).toContain("Contact <email>");
    expect(out).not.toContain("leo@example.com");
  });

  test("redacts non-empty secure field values by default", () => {
    const out = toMarkdown(snapshot());
    expect(out).toContain("<redacted>");
    expect(out).not.toContain("myPassword123");
  });

  test("keeps secure labels and renders empty secure values as empty", () => {
    const snap = snapshot();
    snap.tree.children = [
      { id: "password", kind: "input", name: "Password", value: "", state: ["secure"] },
    ];
    const out = toMarkdown(snap);
    expect(out).toContain('input#password "Password" = "" [secure]');
  });
});
