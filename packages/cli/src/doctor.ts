import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  DEFAULT_METRO_URL,
  DEFAULT_TIMEOUT_MS,
  diagnoseMetroResponse,
  fail,
  parseMetro,
  parseTimeout,
} from "./options.js";

export interface CompatRange {
  min: string;
}

export const COMPAT_MATRIX: Record<"react" | "react-native" | "expo", CompatRange> = {
  react: { min: "18.0.0" },
  "react-native": { min: "0.74.0" },
  expo: { min: "50.0.0" },
};

const EXPO_PLUGIN_NAME = "@brna/expo-plugin";
const BABEL_PLUGIN_NAME = "@brna/babel-plugin";
const METRO_PLUGIN_NAME = "@brna/metro-plugin";
const BABEL_FINGERPRINT = "__brnaSource";

export type CheckStatus = "ok" | "warn" | "fail" | "skip";

export interface CheckResult {
  name: string;
  status: CheckStatus;
  message: string;
}

interface DoctorRuntime {
  fetch?: typeof fetch;
  stdout?: Pick<typeof process.stdout, "write">;
  stderr?: Pick<typeof process.stderr, "write">;
  exit?: (code: number) => never;
  cwd?: () => string;
  readFile?: (path: string, encoding: "utf8") => Promise<string>;
  writeFile?: (path: string, data: string) => Promise<void>;
  confirm?: (message: string) => Promise<boolean> | boolean;
}

interface ParsedArgs {
  metro: string;
  timeoutMs: number;
  fix: boolean;
}

function parseArgs(rest: string[]): ParsedArgs {
  let metro = DEFAULT_METRO_URL;
  let timeoutMs = DEFAULT_TIMEOUT_MS;
  let fix = false;
  for (let i = 0; i < rest.length; i++) {
    const token = rest[i]!;
    if (token === "--metro") metro = parseMetro(rest[++i]);
    else if (token === "--timeout") timeoutMs = parseTimeout(rest[++i]);
    else if (token === "--fix") fix = true;
    else fail(4, `unknown flag '${token}'`);
  }
  return { metro, timeoutMs, fix };
}

export async function runDoctor(rest: string[], runtime: DoctorRuntime = {}): Promise<void> {
  const { metro, timeoutMs, fix } = parseArgs(rest);
  const stdout = runtime.stdout ?? process.stdout;
  const stderr = runtime.stderr ?? process.stderr;
  const exit = runtime.exit ?? process.exit;
  const cwd = runtime.cwd ?? process.cwd;

  const checks: CheckResult[] = [];
  checks.push(await checkMetroReachable(metro, timeoutMs, runtime.fetch ?? fetch));
  if (checks[0]!.status === "ok") {
    checks.push(await checkRuntimeConnected(metro, timeoutMs, runtime.fetch ?? fetch));
    checks.push(await checkBabelFingerprint(metro, timeoutMs, runtime.fetch ?? fetch));
  } else {
    checks.push({ name: "runtime", status: "skip", message: "skipped (metro unreachable)" });
    checks.push({ name: "babel-plugin", status: "skip", message: "skipped (metro unreachable)" });
  }
  const projectChecks = await checkProject(cwd(), runtime);
  checks.push(...projectChecks);

  let fixed = false;
  if (fix) {
    const fixResults = await applyFixes(cwd(), runtime, stdout);
    for (const fixResult of fixResults) {
      checks.push(fixResult);
      if (fixResult.status === "ok") {
        fixed = true;
        // Re-mark the earlier expo-plugin check now that the fix has run.
        for (const c of checks) {
          if (c.name === "expo-plugin" && c.status === "fail") {
            c.status = "ok";
            c.message = `${EXPO_PLUGIN_NAME} registered (via --fix)`;
          }
        }
      }
    }
  }

  for (const c of checks) {
    stdout.write(`${glyph(c.status)} ${c.name}: ${c.message}\n`);
  }

  const hasFail = checks.some((c) => c.status === "fail");
  if (!hasFail) {
    stdout.write(fixed ? "\n✓ Setup looks good (after fix)!\n" : "\n✓ Setup looks good!\n");
    exit(0);
  }
  stderr.write("\n✗ Setup has problems — see above\n");
  exit(1);
}

function glyph(status: CheckStatus): string {
  if (status === "ok") return "✓";
  if (status === "warn") return "!";
  if (status === "skip") return "·";
  return "✗";
}

async function checkMetroReachable(
  metro: string,
  timeoutMs: number,
  fetchImpl: typeof fetch,
): Promise<CheckResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchImpl(`${metro}/status`, { signal: controller.signal });
    clearTimeout(timer);
    if (res.status === 200 || res.status === 404) {
      // Metro replies 200 to /status; 404 still proves a server is listening.
      return { name: "metro", status: "ok", message: `reachable at ${metro}` };
    }
    return { name: "metro", status: "warn", message: `responded HTTP ${res.status} at ${metro}` };
  } catch (err) {
    clearTimeout(timer);
    return {
      name: "metro",
      status: "fail",
      message: `unreachable at ${metro} (${(err as Error).message})`,
    };
  }
}

async function checkRuntimeConnected(
  metro: string,
  timeoutMs: number,
  fetchImpl: typeof fetch,
): Promise<CheckResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchImpl(`${metro}/brna/devices`, { signal: controller.signal });
    clearTimeout(timer);
    if (!res.ok) {
      const diagnosis = await diagnoseMetroResponse(res, "devices endpoint");
      return {
        name: "runtime",
        status: "fail",
        message: diagnosis ?? `devices endpoint returned HTTP ${res.status}`,
      };
    }
    const diagnosis = await diagnoseMetroResponse(res, "devices endpoint");
    let body: { devices?: unknown[] };
    try {
      body = (await res.json()) as { devices?: unknown[] };
    } catch (err) {
      return {
        name: "runtime",
        status: "fail",
        message:
          diagnosis ?? `could not parse devices endpoint JSON: ${(err as Error).message}`,
      };
    }
    const count = Array.isArray(body.devices) ? body.devices.length : 0;
    if (count === 0) {
      return {
        name: "runtime",
        status: "fail",
        message: "no runtime connected — start your app and ensure withBrna() wraps Metro",
      };
    }
    return { name: "runtime", status: "ok", message: `${count} runtime(s) connected` };
  } catch (err) {
    clearTimeout(timer);
    return {
      name: "runtime",
      status: "fail",
      message: `could not query devices endpoint: ${(err as Error).message}`,
    };
  }
}

async function checkBabelFingerprint(
  metro: string,
  timeoutMs: number,
  fetchImpl: typeof fetch,
): Promise<CheckResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchImpl(`${metro}/index.bundle?platform=ios&dev=true&minify=false`, {
      signal: controller.signal,
    });
    clearTimeout(timer);
    if (!res.ok) {
      return {
        name: "babel-plugin",
        status: "fail",
        message: (await diagnoseMetroResponse(res, "bundle")) ?? `bundle returned HTTP ${res.status}`,
      };
    }
    const text = await res.text();
    if (text.includes(BABEL_FINGERPRINT)) {
      return { name: "babel-plugin", status: "ok", message: `${BABEL_FINGERPRINT} fingerprint found in bundle` };
    }
    return {
      name: "babel-plugin",
      status: "fail",
      message: `${BABEL_FINGERPRINT} fingerprint missing from bundle`,
    };
  } catch (err) {
    clearTimeout(timer);
    return {
      name: "babel-plugin",
      status: "fail",
      message: `could not inspect bundle: ${(err as Error).message}`,
    };
  }
}

interface PackageJson {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
}

async function checkProject(projectRoot: string, runtime: DoctorRuntime): Promise<CheckResult[]> {
  const out: CheckResult[] = [];
  const pkgPath = resolve(projectRoot, "package.json");
  let pkg: PackageJson;
  try {
    const raw = await (runtime.readFile ?? readFile)(pkgPath, "utf8");
    pkg = JSON.parse(raw) as PackageJson;
  } catch {
    out.push({ name: "package", status: "skip", message: "no package.json found in cwd" });
    return out;
  }
  const deps = { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) };

  for (const [name, range] of Object.entries(COMPAT_MATRIX) as Array<[
    keyof typeof COMPAT_MATRIX,
    CompatRange,
  ]>) {
    const installed = deps[name];
    if (typeof installed !== "string") {
      out.push({ name, status: "skip", message: "not installed" });
      continue;
    }
    const installedVersion = stripRange(installed);
    if (!installedVersion) {
      out.push({ name, status: "warn", message: `unparseable version '${installed}'` });
      continue;
    }
    if (compareSemver(installedVersion, range.min) >= 0) {
      out.push({ name, status: "ok", message: `${installedVersion} >= ${range.min}` });
    } else {
      out.push({ name, status: "fail", message: `${installedVersion} < required ${range.min}` });
    }
  }

  const isExpoProject = typeof deps.expo === "string";
  if (isExpoProject) {
    const appConfig = await readAppConfig(projectRoot, runtime);
    if (!appConfig) {
      out.push({
        name: "expo-plugin",
        status: "warn",
        message: "no app.json/app.config.json found",
      });
    } else if (hasBrnaPlugin(appConfig.parsed)) {
      out.push({ name: "expo-plugin", status: "ok", message: `${EXPO_PLUGIN_NAME} registered` });
    } else {
      out.push({
        name: "expo-plugin",
        status: "fail",
        message: `${EXPO_PLUGIN_NAME} missing from plugins — run 'brna doctor --fix'`,
      });
    }
  }

  return out;
}

interface AppConfig {
  path: string;
  parsed: { expo?: { plugins?: unknown[] }; plugins?: unknown[] };
}

async function readAppConfig(projectRoot: string, runtime: DoctorRuntime): Promise<AppConfig | null> {
  const candidates = ["app.json", "app.config.json"];
  for (const name of candidates) {
    const path = resolve(projectRoot, name);
    try {
      const raw = await (runtime.readFile ?? readFile)(path, "utf8");
      return { path, parsed: JSON.parse(raw) as AppConfig["parsed"] };
    } catch {
      /* try next */
    }
  }
  return null;
}

function pluginsArray(parsed: AppConfig["parsed"]): unknown[] | undefined {
  if (parsed.expo && Array.isArray(parsed.expo.plugins)) return parsed.expo.plugins;
  if (Array.isArray(parsed.plugins)) return parsed.plugins;
  return undefined;
}

function hasBrnaPlugin(parsed: AppConfig["parsed"]): boolean {
  const plugins = pluginsArray(parsed);
  if (!plugins) return false;
  return plugins.some((entry) => {
    if (entry === EXPO_PLUGIN_NAME) return true;
    if (Array.isArray(entry) && entry[0] === EXPO_PLUGIN_NAME) return true;
    return false;
  });
}

async function applyFixes(
  projectRoot: string,
  runtime: DoctorRuntime,
  stdout: Pick<typeof process.stdout, "write">,
): Promise<CheckResult[]> {
  const pkgPath = resolve(projectRoot, "package.json");
  let isExpo = false;
  try {
    const raw = await (runtime.readFile ?? readFile)(pkgPath, "utf8");
    const pkg = JSON.parse(raw) as PackageJson;
    const deps = { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) };
    isExpo = typeof deps.expo === "string";
  } catch {
    return [];
  }
  if (!isExpo) {
    return applyDirectConfigFixes(projectRoot, runtime, stdout);
  }
  const result = await applyExpoFix(projectRoot, runtime, stdout);
  return [result];
}

async function applyExpoFix(
  projectRoot: string,
  runtime: DoctorRuntime,
  stdout: Pick<typeof process.stdout, "write">,
): Promise<CheckResult> {
  const appConfig = await readAppConfig(projectRoot, runtime);
  if (!appConfig) {
    return { name: "fix", status: "fail", message: "no app.json found to register plugin in" };
  }
  if (hasBrnaPlugin(appConfig.parsed)) {
    return { name: "fix", status: "ok", message: `${EXPO_PLUGIN_NAME} already registered` };
  }
  if (!(await confirmWrite(`Register ${EXPO_PLUGIN_NAME} in ${appConfig.path}?`, runtime, stdout))) {
    return { name: "fix", status: "warn", message: `skipped ${appConfig.path}` };
  }
  const updated = registerPlugin(appConfig.parsed);
  try {
    const text = JSON.stringify(updated, null, 2) + "\n";
    await (runtime.writeFile ?? writeFile)(appConfig.path, text);
  } catch (err) {
    return { name: "fix", status: "fail", message: `could not write ${appConfig.path}: ${(err as Error).message}` };
  }
  return { name: "fix", status: "ok", message: `added ${EXPO_PLUGIN_NAME} to ${appConfig.path}` };
}

async function applyDirectConfigFixes(
  projectRoot: string,
  runtime: DoctorRuntime,
  stdout: Pick<typeof process.stdout, "write">,
): Promise<CheckResult[]> {
  const out: CheckResult[] = [];
  out.push(await patchConfigFile({
    projectRoot,
    runtime,
    stdout,
    name: "fix-babel",
    candidates: ["babel.config.js", "babel.config.cjs"],
    missing: "no babel.config.js found",
    patch: patchBabelConfig,
    isPatched: (text) => text.includes(BABEL_PLUGIN_NAME),
  }));
  out.push(await patchConfigFile({
    projectRoot,
    runtime,
    stdout,
    name: "fix-metro",
    candidates: ["metro.config.js", "metro.config.cjs"],
    missing: "no metro.config.js found",
    patch: patchMetroConfig,
    isPatched: (text) => text.includes(METRO_PLUGIN_NAME) || text.includes("withBrna"),
  }));
  return out;
}

interface PatchConfigFileOptions {
  projectRoot: string;
  runtime: DoctorRuntime;
  stdout: Pick<typeof process.stdout, "write">;
  name: string;
  candidates: string[];
  missing: string;
  patch: (text: string) => string;
  isPatched: (text: string) => boolean;
}

async function patchConfigFile(opts: PatchConfigFileOptions): Promise<CheckResult> {
  for (const candidate of opts.candidates) {
    const path = resolve(opts.projectRoot, candidate);
    let text: string;
    try {
      text = await (opts.runtime.readFile ?? readFile)(path, "utf8");
    } catch {
      continue;
    }
    if (opts.isPatched(text)) {
      return { name: opts.name, status: "ok", message: `${candidate} already patched` };
    }
    if (!(await confirmWrite(`Patch ${path}?`, opts.runtime, opts.stdout))) {
      return { name: opts.name, status: "warn", message: `skipped ${candidate}` };
    }
    try {
      await (opts.runtime.writeFile ?? writeFile)(path, opts.patch(text));
    } catch (err) {
      return { name: opts.name, status: "fail", message: `could not write ${path}: ${(err as Error).message}` };
    }
    return { name: opts.name, status: "ok", message: `patched ${candidate}` };
  }
  return { name: opts.name, status: "fail", message: opts.missing };
}

async function confirmWrite(
  message: string,
  runtime: DoctorRuntime,
  stdout: Pick<typeof process.stdout, "write">,
): Promise<boolean> {
  if (runtime.confirm) return Boolean(await runtime.confirm(message));
  if (!process.stdin.isTTY) return true;
  stdout.write(`${message} [y/N] `);
  const answer = await new Promise<string>((resolveAnswer) => {
    process.stdin.resume();
    process.stdin.once("data", (chunk) => resolveAnswer(String(chunk).trim().toLowerCase()));
  });
  return answer === "y" || answer === "yes";
}

export function registerPlugin(parsed: AppConfig["parsed"]): AppConfig["parsed"] {
  if (parsed.expo) {
    const plugins = Array.isArray(parsed.expo.plugins) ? parsed.expo.plugins.slice() : [];
    plugins.push(EXPO_PLUGIN_NAME);
    return { ...parsed, expo: { ...parsed.expo, plugins } };
  }
  const plugins = Array.isArray(parsed.plugins) ? parsed.plugins.slice() : [];
  plugins.push(EXPO_PLUGIN_NAME);
  return { ...parsed, plugins };
}

export function patchBabelConfig(text: string): string {
  if (text.includes(BABEL_PLUGIN_NAME)) return text;
  if (/plugins\s*:\s*\[/.test(text)) {
    return text.replace(/plugins\s*:\s*\[/, `plugins: ['${BABEL_PLUGIN_NAME}', `);
  }
  const presetsPattern = /(presets\s*:\s*\[[^\]]*\])(\s*,?)/m;
  if (presetsPattern.test(text)) {
    return text.replace(presetsPattern, `$1,\n    plugins: ['${BABEL_PLUGIN_NAME}']`);
  }
  const returnObjectPattern = /return\s*\{\s*/m;
  if (returnObjectPattern.test(text)) {
    return text.replace(returnObjectPattern, `return {\n    plugins: ['${BABEL_PLUGIN_NAME}'],\n    `);
  }
  return `${text.trimEnd()}\n\nmodule.exports.plugins = [...(module.exports.plugins || []), '${BABEL_PLUGIN_NAME}'];\n`;
}

export function patchMetroConfig(text: string): string {
  if (text.includes(METRO_PLUGIN_NAME) || text.includes("withBrna")) return text;
  const requireLine = `const { withBrna } = require('${METRO_PLUGIN_NAME}');`;
  const withRequire = `${requireLine}\n${text.trimStart()}`;
  const moduleExportPattern = /module\.exports\s*=\s*([^;\n]+);?/m;
  if (moduleExportPattern.test(withRequire)) {
    return withRequire.replace(moduleExportPattern, "module.exports = withBrna($1);");
  }
  return `${withRequire.trimEnd()}\n\nmodule.exports = withBrna(module.exports);\n`;
}

function stripRange(spec: string): string | null {
  const match = spec.match(/(\d+)\.(\d+)\.(\d+)/);
  if (!match) return null;
  return `${match[1]}.${match[2]}.${match[3]}`;
}

export function compareSemver(a: string, b: string): number {
  const pa = a.split(".").map((n) => Number.parseInt(n, 10));
  const pb = b.split(".").map((n) => Number.parseInt(n, 10));
  for (let i = 0; i < 3; i++) {
    const ai = pa[i] ?? 0;
    const bi = pb[i] ?? 0;
    if (ai > bi) return 1;
    if (ai < bi) return -1;
  }
  return 0;
}
