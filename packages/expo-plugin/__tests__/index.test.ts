import { describe, expect, test } from "bun:test";
import { patchBabelConfig, patchMetroConfig } from "../src/index.js";

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
});
