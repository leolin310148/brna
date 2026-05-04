"use strict";

const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");
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

function withTempProject(packageJson, fn) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "brna-babel-plugin-"));
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify(packageJson), "utf8");
  try {
    return fn(root);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
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

  test("skips React.Fragment while still injecting child elements", () => {
    const out = transform("const x = <React.Fragment><View /></React.Fragment>;");
    expect(out).toContain("<React.Fragment>");
    expect(out).toContain('__brnaSource="packages/babel-plugin/__tests__/App.tsx:1:26"');
    expect(out.match(/__brnaSource="/g)?.length).toBe(1);
    expect(out.match(/__brna_id="/g)?.length).toBe(1);
  });

  test("skips Fragment imported from React while still injecting child elements", () => {
    const out = transform("import { Fragment } from 'react';\nconst x = <Fragment><View /></Fragment>;");
    expect(out).toContain("<Fragment>");
    expect(out).toContain('__brnaSource="packages/babel-plugin/__tests__/App.tsx:2:20"');
    expect(out.match(/__brnaSource="/g)?.length).toBe(1);
    expect(out.match(/__brna_id="/g)?.length).toBe(1);
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

describe("runtime auto entry injection", () => {
  const entryFilename = path.join(REPO_ROOT, "index.tsx");

  test("injects a CommonJS require into entry files", () => {
    const out = transform("import App from './App';\nexport default App;", {
      filename: entryFilename,
    });
    expect(out).toContain('require("@brna/runtime/auto");');
    expect(out).not.toContain('import "@brna/runtime/auto"');
  });

  test("does not double-inject when require already exists", () => {
    const out = transform('require("@brna/runtime/auto");\nexport default 1;', {
      filename: entryFilename,
    });
    expect(out.match(/require\("@brna\/runtime\/auto"\);/g)?.length).toBe(1);
  });

  test("does not double-inject when legacy import already exists", () => {
    const out = transform('import "@brna/runtime/auto";\nexport default 1;', {
      filename: entryFilename,
    });
    expect(out.match(/@brna\/runtime\/auto/g)?.length).toBe(1);
  });

  test("does not inject into nested route index files", () => {
    const out = transform("export default function Route() { return null; }", {
      filename: path.join(REPO_ROOT, "app", "settings", "index.tsx"),
    });
    expect(out).not.toContain('require("@brna/runtime/auto");');
  });

  test("uses package.json main for Expo Router projects", () => {
    withTempProject({ main: "expo-router/entry" }, (root) => {
      const routeOut = transform("export default function Route() { return null; }", {
        filename: path.join(root, "app", "checkout", "index.tsx"),
        cwd: root,
      });
      expect(routeOut).not.toContain('require("@brna/runtime/auto");');

      const entryOut = transform("export default 1;", {
        filename: path.join(root, "node_modules", "expo-router", "entry.js"),
        cwd: root,
      });
      expect(entryOut).toContain('require("@brna/runtime/auto");');
    });
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

  test("assigns displayName for arrow components", () => {
    const out = transform("const Card = () => <View />;");
    expect(out).toContain('Card.displayName = Card.displayName || "Card"');
  });

  test("assigns displayName for forwardRef and memo factories", () => {
    const out = transform(
      "const Card = forwardRef(function (p, r) { return <View />; });\n" +
        "const Memoed = React.memo(Card);"
    );
    expect(out).toContain('Card.displayName = Card.displayName || "Card"');
    expect(out).toContain('Memoed.displayName = Memoed.displayName || "Memoed"');
  });

  test("does not assign displayName to Symbol primitives", () => {
    const out = transform("const IS_PLATFORM_OBJECT_KEY = Symbol('isPlatformObject');");
    expect(out).not.toContain("IS_PLATFORM_OBJECT_KEY.displayName");
  });

  test("does not assign displayName to Object.freeze constants", () => {
    const out = transform("const CONFIG = Object.freeze({ flag: true });");
    expect(out).not.toContain("CONFIG.displayName");
  });

  test("does not assign displayName to functions that do not return JSX", () => {
    const out = transform("function Util() { return 42; }");
    expect(out).not.toContain("Util.displayName");
  });

  test("skips displayName injection for files inside node_modules", () => {
    const out = transform("function Card() { return <View />; }", {
      filename: path.join(REPO_ROOT, "node_modules", "some-pkg", "index.js"),
      cwd: REPO_ROOT,
    });
    expect(out).not.toContain("Card.displayName");
  });
});
