import { describe, expect, test } from "bun:test";
import {
  diagnoseMetroResponse,
  normalizeMetroUrl,
  parseDevice,
  parseNativeDevice,
  parseNonNegativeInt,
  parsePositiveInt,
  parseSince,
  parseTimeout,
} from "../src/options.js";

describe("CLI option parsing", () => {
  test("normalizes Metro URL origins", () => {
    expect(normalizeMetroUrl("http://localhost:8081/status")).toBe("http://localhost:8081");
    expect(normalizeMetroUrl("https://example.test/brna/snapshot")).toBe("https://example.test");
  });

  test("accepts host:port Metro shorthand", () => {
    expect(normalizeMetroUrl("localhost:8081")).toBe("http://localhost:8081");
    expect(normalizeMetroUrl("  127.0.0.1:19000  ")).toBe("http://127.0.0.1:19000");
  });

  test("accepts bare port Metro shorthand as localhost", () => {
    expect(normalizeMetroUrl("8081")).toBe("http://localhost:8081");
    expect(normalizeMetroUrl("  19000  ")).toBe("http://localhost:19000");
  });

  test("rejects unsupported Metro URL schemes", () => {
    expect(() => normalizeMetroUrl("not-a-url")).toThrow();
    expect(() => normalizeMetroUrl("ftp://localhost:8081")).toThrow();
    expect(() => normalizeMetroUrl("brna://metro")).toThrow();
  });

  test("rejects whitespace-only device ids", () => {
    const result = captureProcessExit(() => parseDevice("   "));
    expect(result.code).toBe(4);
    expect(result.stderr).toContain("missing value for '--device'");
  });

  test("trims surrounding whitespace from device ids", () => {
    expect(parseDevice("  ios-sim  ")).toBe("ios-sim");
  });

  test("rejects whitespace-only native device ids", () => {
    const result = captureProcessExit(() => parseNativeDevice("   "));
    expect(result.code).toBe(4);
    expect(result.stderr).toContain("missing value for '--native-device'");
  });

  test("trims surrounding whitespace from native device ids", () => {
    expect(parseNativeDevice("  ios-sim  ")).toBe("ios-sim");
  });

  test("integer flags reject non-decimal numeric syntax", () => {
    expect(captureProcessExit(() => parsePositiveInt("0x10", "--limit")).stderr).toContain(
      "'--limit' must be a positive integer",
    );
    expect(captureProcessExit(() => parseTimeout("1e3")).stderr).toContain(
      "'--timeout' must be a positive integer",
    );
  });

  test("non-negative integer flags still accept zero", () => {
    expect(parseNonNegativeInt("0", "--at")).toBe(0);
    expect(captureProcessExit(() => parseNonNegativeInt("-0", "--at")).stderr).toContain(
      "'--at' must be a non-negative integer",
    );
  });

  test("since flags reject non-decimal numeric syntax", () => {
    expect(captureProcessExit(() => parseSince("0x10", "--since")).stderr).toContain(
      "'--since' must be a non-negative number",
    );
    expect(captureProcessExit(() => parseSince("1e3", "--since")).stderr).toContain(
      "'--since' must be a non-negative number",
    );
    expect(captureProcessExit(() => parseSince("9".repeat(400), "--since")).stderr).toContain(
      "'--since' must be a non-negative number",
    );
  });

  test("usage diagnostics escape terminal control characters", () => {
    const result = captureProcessExit(() => parseSince("\x1b[31m", "--since"));
    expect(result.stderr).toContain("\\x1b[31m");
    expect(result.stderr).not.toContain("\x1b");
  });

  test("usage diagnostics escape unicode bidi controls", () => {
    const result = captureProcessExit(() => parseSince("123\u202e456", "--since"));
    expect(result.stderr).toContain("123\\u202e456");
    expect(result.stderr).not.toContain("\u202e");
  });

  test("since flags still accept decimal durations", () => {
    const before = Date.now();
    const parsed = parseSince("  1500.5  ", "--since");
    const after = Date.now();
    expect(parsed).toBeLessThanOrEqual(after - 1500.5);
    expect(parsed).toBeGreaterThanOrEqual(before - 1500.5);
  });

  test("diagnoses HTML responses without relying on content-type casing", async () => {
    const response = new Response("  <!doctype html><html><body>Metro</body></html>", {
      status: 404,
    });

    await expect(diagnoseMetroResponse(response, "/brna/snapshot")).resolves.toContain(
      "brna Metro middleware is not mounted",
    );
  });

  test("includes useful non-HTML HTTP response details", async () => {
    const response = new Response("noise\nUnable to resolve module @brna/runtime\nmore noise", {
      status: 500,
    });

    await expect(diagnoseMetroResponse(response, "/brna/snapshot")).resolves.toBe(
      "/brna/snapshot returned HTTP 500: Unable to resolve module @brna/runtime",
    );
  });

  test("escapes control characters in HTTP response diagnostics", async () => {
    const response = new Response("Error: \x1b[31mMetro failed\u202e", {
      status: 500,
    });

    const diagnosis = await diagnoseMetroResponse(response, "/brna/snapshot");

    expect(diagnosis).toBe("/brna/snapshot returned HTTP 500: Error: \\x1b[31mMetro failed\\u202e");
    expect(diagnosis).not.toContain("\x1b");
    expect(diagnosis).not.toContain("\u202e");
  });

  test("extracts JSON HTTP response messages", async () => {
    const response = new Response(JSON.stringify({ error: { message: "Metro plugin failed to load" } }), {
      status: 500,
      headers: { "content-type": "application/json" },
    });

    await expect(diagnoseMetroResponse(response, "/brna/snapshot")).resolves.toBe(
      "/brna/snapshot returned HTTP 500: Metro plugin failed to load",
    );
  });

  test("extracts JSON HTTP response descriptions from arrays", async () => {
    const response = new Response(JSON.stringify([{ description: "Unable to resolve module @brna/runtime" }]), {
      status: 500,
      headers: { "content-type": "application/json" },
    });

    await expect(diagnoseMetroResponse(response, "/brna/snapshot")).resolves.toBe(
      "/brna/snapshot returned HTTP 500: Unable to resolve module @brna/runtime",
    );
  });

  test("extracts JSON HTTP response titles", async () => {
    const response = new Response(JSON.stringify({ title: "Metro middleware unavailable" }), {
      status: 503,
      headers: { "content-type": "application/problem+json" },
    });

    await expect(diagnoseMetroResponse(response, "/brna/snapshot")).resolves.toBe(
      "/brna/snapshot returned HTTP 503: Metro middleware unavailable",
    );
  });

  test("extracts JSON HTTP response messages from errors arrays", async () => {
    const response = new Response(JSON.stringify({ errors: [{ message: "Metro resolver failed" }] }), {
      status: 500,
      headers: { "content-type": "application/json" },
    });

    await expect(diagnoseMetroResponse(response, "/brna/snapshot")).resolves.toBe(
      "/brna/snapshot returned HTTP 500: Metro resolver failed",
    );
  });

  test("extracts JSON string HTTP response messages", async () => {
    const response = new Response(JSON.stringify("Metro middleware crashed"), {
      status: 500,
      headers: { "content-type": "application/json" },
    });

    await expect(diagnoseMetroResponse(response, "/brna/snapshot")).resolves.toBe(
      "/brna/snapshot returned HTTP 500: Metro middleware crashed",
    );
  });
});

function captureProcessExit(fn: () => unknown): { code: number; stderr: string } {
  const originalExit = process.exit;
  const originalStderrWrite = process.stderr.write;
  let stderr = "";
  process.exit = ((code?: string | number | null) => {
    throw Object.assign(new Error("exit"), { code: typeof code === "number" ? code : 0 });
  }) as typeof process.exit;
  process.stderr.write = ((chunk: string | Uint8Array) => {
    stderr += String(chunk);
    return true;
  }) as typeof process.stderr.write;
  try {
    fn();
  } catch (err) {
    const code = (err as { code?: unknown }).code;
    if (typeof code === "number") return { code, stderr };
    throw err;
  } finally {
    process.exit = originalExit;
    process.stderr.write = originalStderrWrite;
  }
  throw new Error("expected process.exit");
}
