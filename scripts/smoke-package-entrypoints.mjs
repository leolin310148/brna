import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = process.cwd();
const workDir = mkdtempSync(join(tmpdir(), "brna-package-smoke-"));
const packDir = join(workDir, "packs");
const appDir = join(workDir, "app");
const npmCacheDir = join(workDir, "npm-cache");

const packages = [
  "packages/schema",
  "packages/core",
  "packages/babel-plugin",
  "packages/runtime",
  "packages/metro-plugin",
  "packages/expo-plugin",
  "packages/mcp",
  "packages/cli",
];

function run(command, args, opts = {}) {
  execFileSync(command, args, {
    cwd: opts.cwd ?? root,
    stdio: "inherit",
    env: {
      ...process.env,
      npm_config_legacy_peer_deps: "true",
      npm_config_fund: "false",
      npm_config_audit: "false",
      npm_config_cache: npmCacheDir,
    },
  });
}

try {
  mkdirSync(packDir, { recursive: true });
  mkdirSync(appDir, { recursive: true });

  for (const pkg of packages) {
    run("npm", ["pack", `./${pkg}`, "--pack-destination", packDir]);
  }

  writeFileSync(
    join(appDir, "package.json"),
    `${JSON.stringify({ name: "brna-package-entrypoint-smoke", private: true, type: "module" }, null, 2)}\n`,
  );

  const tarballs = readdirSync(packDir)
    .filter((name) => name.endsWith(".tgz"))
    .map((name) => join(packDir, name));
  run("npm", ["install", "--legacy-peer-deps", "--ignore-scripts", ...tarballs], { cwd: appDir });

  const reactNativeDir = join(appDir, "node_modules", "react-native");
  mkdirSync(reactNativeDir, { recursive: true });
  writeFileSync(join(reactNativeDir, "package.json"), `${JSON.stringify({ type: "module", main: "./index.js" })}\n`);
  writeFileSync(
    join(reactNativeDir, "index.js"),
    [
      "export const Platform = { OS: 'ios', select: (options) => options?.ios ?? options?.default };",
      "export const Dimensions = { get: () => ({ width: 390, height: 844, scale: 3, fontScale: 1 }) };",
      "export const NativeModules = {};",
      "export const AppState = { currentState: 'active', addEventListener: () => ({ remove() {} }) };",
      "",
    ].join("\n"),
  );

  writeFileSync(
    join(appDir, "smoke.mjs"),
    [
      "import { createRequire } from 'node:module';",
      "const require = createRequire(import.meta.url);",
      "const runtime = await import('@brna/runtime');",
      "await import('@brna/runtime/auto');",
      "const mcp = await import('@brna/mcp');",
      "const metro = require('@brna/metro-plugin');",
      "const expo = require('@brna/expo-plugin');",
      "if (typeof runtime.installObservability !== 'function') throw new Error('@brna/runtime missing installObservability');",
      "if (typeof runtime.getLogs !== 'function') throw new Error('@brna/runtime missing getLogs');",
      "if (typeof runtime.getNetwork !== 'function') throw new Error('@brna/runtime missing getNetwork');",
      "if (typeof mcp.runMcpServer !== 'function') throw new Error('@brna/mcp missing runMcpServer');",
      "if (typeof metro.brnaMiddleware !== 'function') throw new Error('@brna/metro-plugin missing brnaMiddleware');",
      "if (typeof metro.withBrna !== 'function') throw new Error('@brna/metro-plugin missing withBrna');",
      "if (typeof expo.default !== 'function') throw new Error('@brna/expo-plugin missing default config plugin');",
      "",
    ].join("\n"),
  );

  run("node", ["smoke.mjs"], { cwd: appDir });
} finally {
  rmSync(workDir, { recursive: true, force: true });
}
