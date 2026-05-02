"use strict";

const path = require("node:path");
const { describe, expect, test } = require("bun:test");
const { transformSync } = require("@babel/core");
const jsxSyntax = require("@babel/plugin-syntax-jsx");
const plugin = require("../index.js");

const REPO_ROOT = path.resolve(__dirname, "..", "..", "..");
const FILENAME = path.join(REPO_ROOT, "packages", "babel-plugin", "__tests__", "App.tsx");

function transform(source, opts = {}) {
  return transformSync(source, {
    filename: opts.filename ?? FILENAME,
    cwd: opts.cwd ?? REPO_ROOT,
    plugins: [jsxSyntax.default ?? jsxSyntax, plugin],
    babelrc: false,
    configFile: false,
  }).code;
}

describe("__brnaSource injection in JSXOpeningElement", () => {
  test("injects __brnaSource for a self-closing element", () => {
    const out = transform("const x = <View />;");
    // file:line:col where col is 0-indexed (matches Babel's loc convention).
    expect(out).toContain('__brnaSource="packages/babel-plugin/__tests__/App.tsx:1:10"');
  });

  test("injects a stable __brna_id derived from __brnaSource", () => {
    const source = "packages/babel-plugin/__tests__/App.tsx:1:10";
    const out = transform("const x = <View />;");
    expect(out).toContain(`__brna_id="${plugin.stableElementId(source)}"`);
  });

  test("injects __brnaSource for an open element with children", () => {
    const out = transform("const x = <Text>hi</Text>;");
    expect(out).toContain('__brnaSource="packages/babel-plugin/__tests__/App.tsx:1:10"');
  });

  test("injects __brnaSource on every JSX element in a tree", () => {
    const out = transform("const x = <View><Text>a</Text></View>;");
    const matches = out.match(/__brnaSource="/g) ?? [];
    expect(matches.length).toBe(2);
  });

  test("does not overwrite an existing __brnaSource prop", () => {
    const out = transform('const x = <View __brnaSource="manual.tsx:9:9" />;');
    expect(out).toContain('__brnaSource="manual.tsx:9:9"');
    expect(out.match(/__brnaSource="/g).length).toBe(1);
  });

  test("skips elements that have a JSX spread attribute (conservative)", () => {
    const out = transform("const x = <View {...props} />;");
    expect(out).not.toContain("__brnaSource");
    expect(out).not.toContain("__brna_id");
  });

  test("skips files inside node_modules", () => {
    const out = transform("const x = <View />;", {
      filename: path.join(REPO_ROOT, "node_modules", "react-native", "Libraries", "View.js"),
      cwd: REPO_ROOT,
    });
    expect(out).not.toContain("__brnaSource");
  });

  test("uses path basename when filename lives outside the cwd", () => {
    const out = transform("const x = <View />;", {
      filename: "/somewhere/else/App.tsx",
      cwd: REPO_ROOT,
    });
    expect(out).toContain('__brnaSource="App.tsx:1:10"');
  });
});

describe("production mode", () => {
  test("does not inject __brnaSource when NODE_ENV=production", () => {
    const previous = process.env.NODE_ENV;
    process.env.NODE_ENV = "production";
    try {
      const out = transform("const x = <View />;");
      expect(out).not.toContain("__brnaSource");
      expect(out).not.toContain("__brna_id");
    } finally {
      if (previous === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = previous;
    }
  });
});

describe("displayName supplementation", () => {
  test("assigns displayName for named components without one", () => {
    const out = transform("function Card() { return <View />; }");
    expect(out).toContain('Card.displayName = Card.displayName || "Card"');
  });

  test("does not add a duplicate displayName assignment", () => {
    const out = transform('function Card() { return <View />; }\nCard.displayName = "Manual";');
    expect(out.match(/Card\.displayName/g)?.length).toBe(1);
  });
});
