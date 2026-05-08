import { describe, expect, test } from "bun:test";
import { SCHEMA_VERSION, type Snapshot } from "@brna/schema";
import { redactSnapshot } from "../src/redact.js";

function makeSnapshot(overrides: Partial<Snapshot> = {}): Snapshot {
  return {
    meta: {
      schema_version: SCHEMA_VERSION,
      captured_at: "2026-05-02T00:00:00.000Z",
      app: { bundle_id: "x", version: "1" },
      device: {
        platform: "ios",
        os_version: "17",
        model: "iPhone",
        viewport: { w: 1, h: 1, scale: 1 },
        locale: "en",
      },
      session_id: "s",
      snapshot_id: "n",
    },
    screen: { modal_stack: [] },
    tree: { id: "root", kind: "screen" },
    ...overrides,
  };
}

describe("redactSnapshot", () => {
  test("applies regex rules to node URLs without mutating the input snapshot", () => {
    const input = makeSnapshot({
      tree: {
        id: "root",
        kind: "screen",
        children: [
          {
            id: "webview",
            kind: "webview",
            url: "https://example.test/orders/order_123",
          },
        ],
      },
    });

    const out = redactSnapshot(input, {
      rules: [{ match: { source: "order_\\d+" }, replace: "<order>" }],
    });

    expect(out.tree.children?.[0]?.url).toBe("https://example.test/orders/<order>");
    expect(input.tree.children?.[0]?.url).toBe("https://example.test/orders/order_123");
  });

  test("redacts non-empty secure values while keeping ordinary secure labels", () => {
    const out = redactSnapshot(
      makeSnapshot({
        tree: {
          id: "root",
          kind: "screen",
          children: [
            {
              id: "password",
              kind: "input",
              name: "Password",
              text: "hunter2",
              value: "hunter2",
              state: ["secure"],
            },
          ],
        },
      }),
    );

    const password = out.tree.children?.[0];
    expect(password?.name).toBe("Password");
    expect(password?.text).toBe("<redacted>");
    expect(password?.value).toBe("<redacted>");
  });

  test("redacts secure non-string values", () => {
    const out = redactSnapshot(
      makeSnapshot({
        tree: {
          id: "root",
          kind: "screen",
          children: [
            {
              id: "pin",
              kind: "input",
              name: "PIN",
              value: 1234,
              state: ["secure"],
            },
          ],
        },
      }),
    );

    const pin = out.tree.children?.[0];
    expect(pin?.name).toBe("PIN");
    expect(pin?.value).toBe("<redacted>");
  });

  test("redacts secure accessibility text when it mirrors the value", () => {
    const out = redactSnapshot(
      makeSnapshot({
        tree: {
          id: "root",
          kind: "screen",
          children: [
            {
              id: "secret",
              kind: "input",
              accessibility_label: "hunter2",
              accessibility_hint: "hunter2",
              value: "hunter2",
              state: ["secure"],
            },
          ],
        },
      }),
    );

    const secret = out.tree.children?.[0];
    expect(secret?.accessibility_label).toBe("<redacted>");
    expect(secret?.accessibility_hint).toBe("<redacted>");
  });
});
