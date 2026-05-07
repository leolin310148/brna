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
        {
          id: "session",
          kind: "text",
          name: "Session ready for leo@example.com",
          suggested_selectors: [
            "text:Session ready for leo@example.com",
            "text:Session ready for leo@example.com in #root",
          ],
        },
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
    expect(out).toContain("Session ready for <email>");
    expect(out).not.toContain("leo@example.com");
  });

  test("applies regex rules to suggested selectors", () => {
    const out = toMarkdown(snapshot(), {
      rules: [{ match: { source: "[\\w.+-]+@[\\w-]+\\.[\\w.-]+" }, replace: "<email>" }],
    });
    expect(out).toContain("text:Session ready for <email>");
    expect(out).not.toContain("text:Session ready for leo@example.com");
  });

  test("redacts non-empty secure field values by default", () => {
    const out = toMarkdown(snapshot());
    expect(out).toContain("<redacted>");
    expect(out).not.toContain("myPassword123");
  });

  test("redacts secure non-string field values by default", () => {
    const snap = snapshot();
    snap.tree.children = [
      { id: "pin", kind: "input", name: "PIN", value: 1234, state: ["secure"] },
    ];
    const out = toJSON(snap);
    expect(out).toContain('"value": "<redacted>"');
    expect(out).not.toContain("1234");
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
