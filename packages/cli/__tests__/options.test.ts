import { describe, expect, test } from "bun:test";
import { normalizeMetroUrl } from "../src/options.js";

describe("CLI option parsing", () => {
  test("normalizes Metro URL origins", () => {
    expect(normalizeMetroUrl("http://localhost:8081/status")).toBe("http://localhost:8081");
    expect(normalizeMetroUrl("https://example.test/brna/snapshot")).toBe("https://example.test");
  });

  test("accepts host:port Metro shorthand", () => {
    expect(normalizeMetroUrl("localhost:8081")).toBe("http://localhost:8081");
    expect(normalizeMetroUrl("  127.0.0.1:19000  ")).toBe("http://127.0.0.1:19000");
  });

  test("rejects unsupported Metro URL schemes", () => {
    expect(() => normalizeMetroUrl("not-a-url")).toThrow();
    expect(() => normalizeMetroUrl("ftp://localhost:8081")).toThrow();
    expect(() => normalizeMetroUrl("brna://metro")).toThrow();
  });
});
