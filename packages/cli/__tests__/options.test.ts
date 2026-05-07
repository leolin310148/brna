import { describe, expect, test } from "bun:test";
import { diagnoseMetroResponse, normalizeMetroUrl, parseDevice } from "../src/options.js";

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
