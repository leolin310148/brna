import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ensureBabelConfig,
  ensureMetroConfig,
  patchBabelConfig,
  patchMetroConfig,
} from "../src/index.js";

describe("Expo config plugin patching", () => {
  test("injects brna babel plugin into an existing plugins array", () => {
    const out = patchBabelConfig("module.exports = { presets: ['babel-preset-expo'], plugins: ['x'] };\n");
    expect(out).toContain("plugins: ['@brna/babel-plugin', 'x']");
  });

  test("adds a brna babel plugins array next to presets", () => {
    const out = patchBabelConfig("module.exports = { presets: ['babel-preset-expo'] };\n");
    expect(out).toContain("plugins: ['@brna/babel-plugin']");
    expect(out).not.toContain("brna: add");
  });

  test("wraps an existing metro module export with withBrna", () => {
    const out = patchMetroConfig("const config = getDefaultConfig(__dirname);\nmodule.exports = config;\n");
    expect(out).toContain("require('@brna/metro-plugin')");
    expect(out).toContain("module.exports = withBrna(config);");
  });

  test("patches babel configs with return objects and fallback exports", () => {
    expect(patchBabelConfig("module.exports = function() { return { presets: ['x'] }; };\n"))
      .toContain("plugins: ['@brna/babel-plugin']");
    expect(patchBabelConfig("module.exports = {};\n"))
      .toContain("module.exports.plugins = [...(module.exports.plugins || []), '@brna/babel-plugin'];");
    expect(patchBabelConfig("module.exports = { plugins: ['@brna/babel-plugin'] };\n"))
      .toBe("module.exports = { plugins: ['@brna/babel-plugin'] };\n");
  });

  test("patches metro configs without direct module.exports assignment", () => {
    const out = patchMetroConfig("exports.config = {};\n");
    expect(out).toContain("require('@brna/metro-plugin')");
    expect(out).toContain("module.exports = withBrna(module.exports);");
    expect(patchMetroConfig(out)).toBe(out);
  });

  test("ensures missing and existing project config files", () => {
    const root = mkdtempSync(join(tmpdir(), "brna-expo-plugin-"));
    try {
      expect(ensureBabelConfig(root)).toBe("created");
      expect(readFileSync(join(root, "babel.config.js"), "utf8")).toContain("@brna/babel-plugin");
      expect(ensureBabelConfig(root)).toBe("ok");

      expect(ensureMetroConfig(root)).toBe("created");
      expect(readFileSync(join(root, "metro.config.js"), "utf8")).toContain("@brna/metro-plugin");
      expect(ensureMetroConfig(root)).toBe("ok");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("patches existing project config files", () => {
    const root = mkdtempSync(join(tmpdir(), "brna-expo-plugin-"));
    try {
      writeFileSync(join(root, "babel.config.cjs"), "module.exports = { presets: ['x'] };\n");
      writeFileSync(join(root, "metro.config.cjs"), "const config = {};\nmodule.exports = config;\n");

      expect(ensureBabelConfig(root)).toBe("patched");
      expect(ensureMetroConfig(root)).toBe("patched");
      expect(readFileSync(join(root, "babel.config.cjs"), "utf8")).toContain("@brna/babel-plugin");
      expect(readFileSync(join(root, "metro.config.cjs"), "utf8")).toContain("withBrna(config)");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
