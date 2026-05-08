import { describe, expect, test } from "bun:test";
import { redactLogRecord, redactNetworkRecord } from "../src/observability-redact.js";
import type { LogRecord, NetworkRecord } from "@brna/schema";

function baseLog(overrides: Partial<LogRecord> = {}): LogRecord {
  return {
    id: "log-1",
    timestamp: 1000,
    level: "warn",
    message: "hello",
    ...overrides,
  };
}

function baseNet(overrides: Partial<NetworkRecord> = {}): NetworkRecord {
  return {
    id: "net-1",
    timestamp: 1000,
    method: "GET",
    url: "https://api.example.test/things",
    state: "completed",
    source: "fetch",
    status: 200,
    ...overrides,
  };
}

describe("redactLogRecord", () => {
  test("applies configured rules to message and stack", () => {
    const out = redactLogRecord(
      baseLog({
        message: "user leo@example.com tapped Save",
        stack: "Error\n  at fn (leo@example.com)",
      }),
      {
        rules: [
          { match: { source: "[\\w.+-]+@[\\w-]+\\.[\\w.-]+", flags: "g" }, replace: "<email>" },
        ],
      },
    );
    expect(out.message).toBe("user <email> tapped Save");
    expect(out.stack).toBe("Error\n  at fn (<email>)");
  });

  test("redacts sensitive object args", () => {
    const out = redactLogRecord(
      baseLog({ args: [{ access_token: "abc", id: 7 }] }),
      {},
    );
    const arg = (out.args as Array<Record<string, unknown>>)[0]!;
    expect(arg.access_token).toBe("<redacted>");
    expect(arg.id).toBe(7);
  });

  test("redactSensitiveDefaults=false preserves sensitive object args", () => {
    const out = redactLogRecord(
      baseLog({ args: [{ access_token: "abc", note: "order_99" }] }),
      {
        redactSensitiveDefaults: false,
        rules: [{ match: { source: "order_\\d+", flags: "g" }, replace: "<order>" }],
      },
    );
    const arg = (out.args as Array<Record<string, unknown>>)[0]!;
    expect(arg.access_token).toBe("abc");
    expect(arg.note).toBe("<order>");
  });

  test("redacts sensitive fields in circular object args", () => {
    const arg: Record<string, unknown> = { access_token: "abc", id: 7 };
    arg.self = arg;
    const out = redactLogRecord(baseLog({ args: [arg] }), {});
    const redactedArg = (out.args as Array<Record<string, unknown>>)[0]!;
    expect(redactedArg.access_token).toBe("<redacted>");
    expect(redactedArg.id).toBe(7);
    expect(redactedArg.self).toBe("[Circular]");
  });

  test("preserves message when no rules match", () => {
    const out = redactLogRecord(baseLog({ message: "ok" }), {});
    expect(out.message).toBe("ok");
  });
});

describe("redactNetworkRecord", () => {
  test("redacts default sensitive headers", () => {
    const out = redactNetworkRecord(
      baseNet({
        request_headers: [
          { name: "Authorization", value: "Bearer abc" },
          { name: "Cookie", value: "sid=xyz" },
          { name: "Accept", value: "application/json" },
        ],
        response_headers: [
          { name: "Set-Cookie", value: "sid=xyz; HttpOnly" },
        ],
      }),
      {},
    );
    expect(out.request_headers).toEqual([
      { name: "Authorization", value: "<redacted>" },
      { name: "Cookie", value: "<redacted>" },
      { name: "Accept", value: "application/json" },
    ]);
    expect(out.response_headers).toEqual([
      { name: "Set-Cookie", value: "<redacted>" },
    ]);
  });

  test("redacts token-like JSON body fields", () => {
    const body = JSON.stringify({ access_token: "abc", user: { password: "x", name: "leo" } });
    const out = redactNetworkRecord(
      baseNet({ request_body_preview: body }),
      {},
    );
    const parsed = JSON.parse(out.request_body_preview!) as Record<string, unknown>;
    expect(parsed.access_token).toBe("<redacted>");
    const user = parsed.user as Record<string, unknown>;
    expect(user.password).toBe("<redacted>");
    expect(user.name).toBe("leo");
  });

  test("redacts sensitive URL query parameters by default", () => {
    const out = redactNetworkRecord(
      baseNet({
        url: "https://api.example.test/search?q=orders&access_token=abc&client%5Fsecret=xyz#results",
      }),
      {},
    );

    expect(out.url).toBe(
      "https://api.example.test/search?q=orders&access_token=<redacted>&client%5Fsecret=<redacted>#results",
    );

    const fragmentOnly = redactNetworkRecord(
      baseNet({ url: "https://api.example.test/search#access_token=abc" }),
      {},
    );
    expect(fragmentOnly.url).toBe("https://api.example.test/search#access_token=abc");
  });

  test("applies configured rules to URL, body and headers", () => {
    const out = redactNetworkRecord(
      baseNet({
        url: "https://api.example.test/orders/order_99",
        request_headers: [{ name: "X-Order-Id", value: "order_99" }],
        request_body_preview: '{"orderId":"order_99","note":"order_99 was placed"}',
      }),
      {
        rules: [
          { match: { source: "order_\\d+", flags: "g" }, replace: "<order>" },
        ],
      },
    );
    expect(out.url).toContain("<order>");
    expect(out.request_headers?.[0]?.value).toBe("<order>");
    const parsed = JSON.parse(out.request_body_preview!) as Record<string, unknown>;
    expect(parsed.orderId).toBe("<order>");
    expect(parsed.note).toBe("<order> was placed");
  });

  test("non-JSON body falls back to text rules and preserves contents", () => {
    const out = redactNetworkRecord(
      baseNet({ response_body_preview: "id=order_99 ok" }),
      { rules: [{ match: { source: "order_\\d+", flags: "g" }, replace: "<order>" }] },
    );
    expect(out.response_body_preview).toBe("id=<order> ok");
  });

  test("redactSensitiveDefaults=false skips default header redaction", () => {
    const out = redactNetworkRecord(
      baseNet({
        request_headers: [{ name: "Authorization", value: "Bearer abc" }],
        url: "https://api.example.test/search?access_token=abc",
      }),
      { redactSensitiveDefaults: false },
    );
    expect(out.request_headers?.[0]?.value).toBe("Bearer abc");
    expect(out.url).toContain("access_token=abc");
  });

  test("invalid regex rules are ignored", () => {
    const out = redactNetworkRecord(
      baseNet(),
      { rules: [{ match: { source: "[unterminated", flags: "g" }, replace: "X" }] },
    );
    expect(out.url).toBe("https://api.example.test/things");
  });
});
