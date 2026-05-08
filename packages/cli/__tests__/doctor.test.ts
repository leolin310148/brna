import { describe, expect, test } from "bun:test";
import { bundlePathFromMain, compareSemver, patchBabelConfig, patchMetroConfig, registerPlugin, runDoctor } from "../src/doctor.js";

interface Capture {
  code: number;
  stdout: string;
  stderr: string;
  writes: Array<{ path: string; data: string }>;
}

interface FsMap {
  [path: string]: string;
}

async function run(rest: string[], opts: {
  fs: FsMap;
  cwd?: string;
  fetchImpl?: typeof fetch;
  confirm?: (message: string) => Promise<boolean> | boolean;
}): Promise<Capture> {
  let stdout = "";
  let stderr = "";
  const writes: Array<{ path: string; data: string }> = [];
  const cwd = opts.cwd ?? "/proj";
  try {
    await runDoctor(rest, {
      cwd: () => cwd,
      readFile: async (p: string) => {
        const text = opts.fs[p];
        if (typeof text !== "string") throw new Error(`ENOENT: ${p}`);
        return text;
      },
      writeFile: async (p: string, data: string) => {
        writes.push({ path: p, data });
        opts.fs[p] = data;
      },
      fetch: opts.fetchImpl ?? (async () => new Response("{}", { status: 200 })),
      confirm: opts.confirm ?? (() => true),
      stdout: { write: (c: string | Uint8Array) => ((stdout += String(c)), true) },
      stderr: { write: (c: string | Uint8Array) => ((stderr += String(c)), true) },
      exit: (code) => {
        throw Object.assign(new Error("exit"), { code });
      },
    });
  } catch (err) {
    const code = (err as { code?: unknown }).code;
    if (typeof code === "number") return { code, stdout, stderr, writes };
    throw err;
  }
  throw new Error("expected runDoctor to exit");
}

const okFetch: typeof fetch = async (input) => {
  const url = typeof input === "string" ? input : (input as URL).toString();
  if (url.endsWith("/status")) return new Response("packager-status:running", { status: 200 });
  if (url.endsWith("/brna/devices")) return new Response(JSON.stringify({ devices: [{ id: "dev-a" }] }), { status: 200 });
  if (url.includes("/index.bundle")) return new Response("const x = '__brnaSource';", { status: 200 });
  return new Response("not found", { status: 404 });
};

describe("brna doctor", () => {
  test("happy path exits 0 when versions ok and runtime connected", async () => {
    const fs: FsMap = {
      "/proj/package.json": JSON.stringify({
        dependencies: {
          react: "18.2.0",
          "react-native": "0.74.0",
          expo: "50.0.0",
        },
      }),
    };
    const res = await run([], { fs, fetchImpl: okFetch });
    expect(res.code).toBe(0);
    expect(res.stdout).toContain("Setup looks good");
    expect(res.stdout).toContain("metro:");
    expect(res.stdout).toContain("runtime:");
  });

  test("missing Expo runtime exits 1 with explicit message", async () => {
    const fs: FsMap = {
      "/proj/package.json": JSON.stringify({ dependencies: { expo: "50.0.0", "react-native": "0.74.0" } }),
    };
    const fetchImpl: typeof fetch = async (input) => {
      const url = typeof input === "string" ? input : (input as URL).toString();
      if (url.endsWith("/status")) return new Response("ok", { status: 200 });
      if (url.endsWith("/brna/devices")) return new Response(JSON.stringify({ devices: [] }), { status: 200 });
      if (url.includes("/index.bundle")) return new Response("__brnaSource", { status: 200 });
      return new Response("not found", { status: 404 });
    };
    const res = await run([], { fs, fetchImpl });
    expect(res.code).toBe(1);
    expect(res.stdout).toContain("no runtime connected");
    expect(res.stdout).toContain("does not support Expo web runtimes");
  });

  test("missing bare RN runtime gives non-Expo guidance", async () => {
    const fs: FsMap = { "/proj/package.json": JSON.stringify({}) };
    const fetchImpl: typeof fetch = async (input) => {
      const url = typeof input === "string" ? input : (input as URL).toString();
      if (url.endsWith("/status")) return new Response("ok", { status: 200 });
      if (url.endsWith("/brna/devices")) return new Response(JSON.stringify({ devices: [] }), { status: 200 });
      if (url.includes("/index.bundle")) return new Response("__brnaSource", { status: 200 });
      return new Response("not found", { status: 404 });
    };
    const res = await run([], { fs, fetchImpl });
    expect(res.code).toBe(1);
    expect(res.stdout).toContain("no runtime connected");
    expect(res.stdout).not.toContain("Expo web");
    expect(res.stdout).toContain("brna devices");
  });

  test("missing runtime reports last-seen disconnected device when Metro has history", async () => {
    const fs: FsMap = { "/proj/package.json": JSON.stringify({}) };
    const lastSeenAt = Date.now() - 14_000;
    const fetchImpl: typeof fetch = async (input) => {
      const url = typeof input === "string" ? input : (input as URL).toString();
      if (url.endsWith("/status")) return new Response("ok", { status: 200 });
      if (url.endsWith("/brna/devices")) {
        return new Response(
          JSON.stringify({
            devices: [],
            recent_disconnected: [
              { id: "ca48972f", platform: "android", os_version: "36", last_seen_at: lastSeenAt },
            ],
          }),
          { status: 200 },
        );
      }
      if (url.includes("/index.bundle")) return new Response("__brnaSource", { status: 200 });
      return new Response("not found", { status: 404 });
    };
    const res = await run([], { fs, fetchImpl });
    expect(res.code).toBe(1);
    expect(res.stdout).toContain("last seen");
    expect(res.stdout).toContain("ca48972f");
    expect(res.stdout).toContain("currently disconnected");
  });

  test("HTML devices endpoint diagnoses missing Metro middleware", async () => {
    const fs: FsMap = { "/proj/package.json": JSON.stringify({}) };
    const fetchImpl: typeof fetch = async (input) => {
      const url = typeof input === "string" ? input : (input as URL).toString();
      if (url.endsWith("/status")) return new Response("ok", { status: 200 });
      if (url.endsWith("/brna/devices")) {
        return new Response("<!DOCTYPE html><html></html>", {
          status: 200,
          headers: { "content-type": "text/html" },
        });
      }
      if (url.includes("/index.bundle")) return new Response("__brnaSource", { status: 200 });
      return new Response("not found", { status: 404 });
    };
    const res = await run([], { fs, fetchImpl });
    expect(res.code).toBe(1);
    expect(res.stdout).toContain("brna Metro middleware is not mounted");
    expect(res.stdout).toContain("withBrna()");
  });

  test("bundle HTTP 500 includes useful Metro error body line", async () => {
    const fs: FsMap = { "/proj/package.json": JSON.stringify({}) };
    const fetchImpl: typeof fetch = async (input) => {
      const url = typeof input === "string" ? input : (input as URL).toString();
      if (url.endsWith("/status")) return new Response("ok", { status: 200 });
      if (url.endsWith("/brna/devices")) return new Response(JSON.stringify({ devices: [{ id: "dev-a" }] }), { status: 200 });
      if (url.includes("/index.bundle")) {
        return new Response("Error: ENOENT: no such file or directory, open '@brna/runtime'", { status: 500 });
      }
      return new Response("not found", { status: 404 });
    };
    const res = await run([], { fs, fetchImpl });
    expect(res.code).toBe(1);
    expect(res.stdout).toContain("bundle returned HTTP 500");
    expect(res.stdout).toContain("ENOENT");
  });

  test("bundle error from foreign Metro reports project root mismatch", async () => {
    const fs: FsMap = {
      "/proj/package.json": JSON.stringify({ main: "expo-router/entry" }),
    };
    const fetchImpl: typeof fetch = async (input) => {
      const url = typeof input === "string" ? input : (input as URL).toString();
      if (url.endsWith("/status")) return new Response("ok", { status: 200 });
      if (url.endsWith("/brna/devices")) return new Response(JSON.stringify({ devices: [{ id: "dev-a" }] }), { status: 200 });
      if (url.includes("/node_modules/expo-router/entry.bundle")) {
        return new Response(
          JSON.stringify({
            type: "UnableToResolveError",
            originModulePath: "/other/project/.",
            message: "Unable to resolve module ./node_modules/expo-router/entry",
          }),
          { status: 404, headers: { "content-type": "application/json" } },
        );
      }
      return new Response("not found", { status: 404 });
    };
    const res = await run([], { fs, fetchImpl });
    expect(res.code).toBe(1);
    expect(res.stdout).toContain("Metro project root mismatch");
    expect(res.stdout).toContain("/other/project");
    expect(res.stdout).toContain("/proj");
  });

  test("missing babel fingerprint exits 1", async () => {
    const fs: FsMap = { "/proj/package.json": JSON.stringify({}) };
    const fetchImpl: typeof fetch = async (input) => {
      const url = typeof input === "string" ? input : (input as URL).toString();
      if (url.endsWith("/status")) return new Response("ok", { status: 200 });
      if (url.endsWith("/brna/devices")) return new Response(JSON.stringify({ devices: [{ id: "dev-a" }] }), { status: 200 });
      if (url.includes("/index.bundle")) return new Response("const App = 1;", { status: 200 });
      return new Response("not found", { status: 404 });
    };
    const res = await run([], { fs, fetchImpl });
    expect(res.code).toBe(1);
    expect(res.stdout).toContain("babel-plugin");
    expect(res.stdout).toContain("fingerprint missing");
  });

  test("babel fingerprint check uses package.json main for Expo Router", async () => {
    const seen: string[] = [];
    const fs: FsMap = {
      "/proj/package.json": JSON.stringify({
        main: "expo-router/entry",
        dependencies: { expo: "50.0.0", react: "18.2.0", "react-native": "0.74.0" },
      }),
      "/proj/app.config.js": "module.exports = { plugins: ['@brna/expo-plugin'] };\n",
    };
    const fetchImpl: typeof fetch = async (input) => {
      const url = typeof input === "string" ? input : (input as URL).toString();
      seen.push(url);
      if (url.endsWith("/status")) return new Response("ok", { status: 200 });
      if (url.endsWith("/brna/devices")) return new Response(JSON.stringify({ devices: [{ id: "dev-a" }] }), { status: 200 });
      if (url.includes("/node_modules/expo-router/entry.bundle")) return new Response("__brnaSource", { status: 200 });
      return new Response("not found", { status: 404 });
    };
    const res = await run([], { fs, fetchImpl });
    expect(res.code).toBe(0);
    expect(seen.some((url) => url.includes("/node_modules/expo-router/entry.bundle"))).toBe(true);
    expect(res.stdout).toContain("@brna/expo-plugin registered");
  });

  test("compatibility matrix reports outdated react native", async () => {
    const fs: FsMap = {
      "/proj/package.json": JSON.stringify({
        dependencies: { react: "17.0.0", "react-native": "0.72.0", expo: "49.0.0" },
      }),
    };
    const res = await run([], { fs, fetchImpl: okFetch });
    expect(res.code).toBe(1);
    expect(res.stdout).toContain("react-native");
    expect(res.stdout).toContain("0.72.0 < required 0.74.0");
  });

  test("compatibility matrix treats prereleases below matching stable versions", async () => {
    const fs: FsMap = {
      "/proj/package.json": JSON.stringify({
        dependencies: { react: "18.2.0", "react-native": "0.74.0-rc.1", expo: "50.0.0" },
      }),
    };
    const res = await run([], { fs, fetchImpl: okFetch });
    expect(res.code).toBe(1);
    expect(res.stdout).toContain("react-native");
    expect(res.stdout).toContain("0.74.0-rc.1 < required 0.74.0");
  });

  test("--fix registers @brna/expo-plugin in app.json plugins", async () => {
    const fs: FsMap = {
      "/proj/package.json": JSON.stringify({ dependencies: { expo: "50.0.0", react: "18.2.0", "react-native": "0.74.0" } }),
      "/proj/app.json": JSON.stringify({ expo: { name: "demo", plugins: [] } }),
    };
    const res = await run(["--fix"], { fs, fetchImpl: okFetch });
    expect(res.code).toBe(0);
    expect(res.writes).toHaveLength(1);
    const written = JSON.parse(res.writes[0]!.data) as { expo: { plugins: string[] } };
    expect(written.expo.plugins).toContain("@brna/expo-plugin");
  });

  test("manual Expo setup does not fail missing Expo plugin check", async () => {
    const fs: FsMap = {
      "/proj/package.json": JSON.stringify({ dependencies: { expo: "50.0.0", react: "18.2.0", "react-native": "0.74.0" } }),
      "/proj/app.json": JSON.stringify({ expo: { name: "demo", plugins: [] } }),
      "/proj/babel.config.js": "module.exports = { presets: ['babel-preset-expo'], plugins: ['@brna/babel-plugin'] };\n",
      "/proj/metro.config.js": "const { withBrna } = require('@brna/metro-plugin');\nmodule.exports = withBrna({});\n",
    };
    const res = await run([], { fs, fetchImpl: okFetch });
    expect(res.code).toBe(0);
    expect(res.stdout).toContain("expo-plugin: not used (manual babel + metro setup detected");
    expect(res.stdout).not.toContain("@brna/expo-plugin missing");
  });

  test("--fix does not register Expo plugin over manual Expo setup", async () => {
    const fs: FsMap = {
      "/proj/package.json": JSON.stringify({ dependencies: { expo: "50.0.0", react: "18.2.0", "react-native": "0.74.0" } }),
      "/proj/app.json": JSON.stringify({ expo: { name: "demo", plugins: [] } }),
      "/proj/babel.config.js": "module.exports = { plugins: ['@brna/babel-plugin'] };\n",
      "/proj/metro.config.js": "const { withBrna } = require('@brna/metro-plugin');\nmodule.exports = withBrna({});\n",
    };
    const res = await run(["--fix"], { fs, fetchImpl: okFetch });
    expect(res.code).toBe(0);
    expect(res.writes).toHaveLength(0);
    expect(res.stdout).toContain("manual babel + metro setup already configured");
  });

  test("--fix asks before registering Expo plugin", async () => {
    const prompts: string[] = [];
    const fs: FsMap = {
      "/proj/package.json": JSON.stringify({ dependencies: { expo: "50.0.0", react: "18.2.0", "react-native": "0.74.0" } }),
      "/proj/app.json": JSON.stringify({ expo: { name: "demo", plugins: [] } }),
    };
    const res = await run(["--fix"], {
      fs,
      fetchImpl: okFetch,
      confirm: (message) => {
        prompts.push(message);
        return true;
      },
    });
    expect(res.code).toBe(0);
    expect(prompts[0]).toContain("@brna/expo-plugin");
  });

  test("--fix patches non-Expo Babel and Metro configs", async () => {
    const fs: FsMap = {
      "/proj/package.json": JSON.stringify({ dependencies: { react: "18.2.0", "react-native": "0.74.0" } }),
      "/proj/babel.config.js": "module.exports = { presets: ['module:metro-react-native-babel-preset'] };\n",
      "/proj/metro.config.js": "const config = {};\nmodule.exports = config;\n",
    };
    const res = await run(["--fix"], { fs, fetchImpl: okFetch, confirm: () => true });
    expect(res.code).toBe(0);
    expect(res.writes).toHaveLength(2);
    expect(fs["/proj/babel.config.js"]).toContain("@brna/babel-plugin");
    expect(fs["/proj/metro.config.js"]).toContain("@brna/metro-plugin");
    expect(fs["/proj/metro.config.js"]).toContain("module.exports = withBrna(config);");
  });

  test("--fix falls back to direct Babel and Metro patches for dynamic Expo config", async () => {
    const fs: FsMap = {
      "/proj/package.json": JSON.stringify({ dependencies: { expo: "50.0.0", react: "18.2.0", "react-native": "0.74.0" } }),
      "/proj/app.config.js": "module.exports = ({ config }) => ({ ...config, plugins: [] });\n",
      "/proj/babel.config.js": "module.exports = { presets: ['babel-preset-expo'] };\n",
      "/proj/metro.config.js": "const config = {};\nmodule.exports = config;\n",
    };
    const res = await run(["--fix"], { fs, fetchImpl: okFetch, confirm: () => true });
    expect(res.code).toBe(0);
    expect(fs["/proj/babel.config.js"]).toContain("@brna/babel-plugin");
    expect(fs["/proj/metro.config.js"]).toContain("@brna/metro-plugin");
    expect(res.stdout).toContain("app.config.js is dynamic");
    expect(res.stdout).toContain("manual babel + metro setup configured via --fix");
  });

  test("--fix skips writes when confirmation is declined", async () => {
    const fs: FsMap = {
      "/proj/package.json": JSON.stringify({ dependencies: { react: "18.2.0", "react-native": "0.74.0" } }),
      "/proj/babel.config.js": "module.exports = { presets: ['x'] };\n",
      "/proj/metro.config.js": "module.exports = {};\n",
    };
    const res = await run(["--fix"], { fs, fetchImpl: okFetch, confirm: () => false });
    expect(res.code).toBe(0);
    expect(res.writes).toHaveLength(0);
    expect(res.stdout).toContain("skipped babel.config.js");
    expect(res.stdout).toContain("skipped metro.config.js");
  });

  test("--fix is no-op when plugin already registered", async () => {
    const fs: FsMap = {
      "/proj/package.json": JSON.stringify({ dependencies: { expo: "50.0.0", react: "18.2.0", "react-native": "0.74.0" } }),
      "/proj/app.json": JSON.stringify({ expo: { name: "demo", plugins: ["@brna/expo-plugin"] } }),
    };
    const res = await run(["--fix"], { fs, fetchImpl: okFetch });
    expect(res.writes).toHaveLength(0);
    expect(res.code).toBe(0);
  });
});

describe("registerPlugin", () => {
  test("appends to existing expo.plugins", () => {
    const out = registerPlugin({ expo: { plugins: ["other"] } });
    expect(out.expo!.plugins).toEqual(["other", "@brna/expo-plugin"]);
  });

  test("creates plugins array when absent", () => {
    const out = registerPlugin({ expo: {} });
    expect(out.expo!.plugins).toEqual(["@brna/expo-plugin"]);
  });

  test("falls back to top-level plugins for non-expo wrapper", () => {
    const out = registerPlugin({});
    expect(out.plugins).toEqual(["@brna/expo-plugin"]);
  });
});

describe("patch config utilities", () => {
  test("patchBabelConfig inserts plugin array after presets", () => {
    const out = patchBabelConfig("module.exports = { presets: ['x'] };\n");
    expect(out).toContain("plugins: ['@brna/babel-plugin']");
  });

  test("patchMetroConfig wraps module.exports", () => {
    const out = patchMetroConfig("const config = {};\nmodule.exports = config;\n");
    expect(out).toContain("const { withBrna } = require('@brna/metro-plugin');");
    expect(out).toContain("module.exports = withBrna(config);");
  });
});

describe("bundlePathFromMain", () => {
  test("maps Expo Router entry to Metro node_modules bundle path", () => {
    expect(bundlePathFromMain("expo-router/entry")).toBe("node_modules/expo-router/entry");
  });

  test("defaults to index and strips extensions", () => {
    expect(bundlePathFromMain(undefined)).toBe("index");
    expect(bundlePathFromMain("./index.js")).toBe("index");
    expect(bundlePathFromMain("./src/main.tsx")).toBe("src/main");
  });

  test("keeps explicit relative entry points outside src as local paths", () => {
    expect(bundlePathFromMain("./lib/index.js")).toBe("lib/index");
  });
});

describe("compareSemver", () => {
  test("orders versions correctly", () => {
    expect(compareSemver("1.2.3", "1.2.3")).toBe(0);
    expect(compareSemver("1.2.4", "1.2.3")).toBeGreaterThan(0);
    expect(compareSemver("0.74.0", "0.73.9")).toBeGreaterThan(0);
    expect(compareSemver("0.73.9", "0.74.0")).toBeLessThan(0);
    expect(compareSemver("0.74.0-rc.1", "0.74.0")).toBeLessThan(0);
    expect(compareSemver("0.74.0-rc.2", "0.74.0-rc.1")).toBeGreaterThan(0);
  });
});
