import { describe, expect, test } from "bun:test";
import { diagnoseMetroResponse, normalizeMetroUrl } from "../src/options.js";

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
