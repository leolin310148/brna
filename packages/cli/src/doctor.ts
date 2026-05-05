import { readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
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
// Cold unminified Expo bundles can take well over the default doctor timeout
// to compile on a fresh Metro cache. Hold a 20s floor for the fingerprint
// probe specifically; an explicit larger --timeout still wins.
export const BABEL_PROBE_TIMEOUT_FLOOR_MS = 20000;

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
    checks.push(await checkRuntimeConnected(cwd(), metro, timeoutMs, runtime));
    checks.push(await checkBabelFingerprint(cwd(), metro, timeoutMs, runtime));
  } else {
    checks.push({ name: "runtime", status: "skip", message: "skipped (metro unreachable)" });
    checks.push({ name: "babel-plugin", status: "skip", message: "skipped (metro unreachable)" });
  }
  const projectChecks = await checkProject(cwd(), runtime);
  checks.push(...projectChecks);

  let fixed = false;
  if (fix) {
    const fixResults = await applyFixes(cwd(), runtime, stdout);
    const patchedManualSetup =
      fixResults.some((r) => r.name === "fix-babel" && r.status === "ok") &&
      fixResults.some((r) => r.name === "fix-metro" && r.status === "ok");
    for (const fixResult of fixResults) {
      checks.push(fixResult);
      if (fixResult.status === "ok") {
        fixed = true;
        // Re-mark the earlier expo-plugin check now that setup has run.
        for (const c of checks) {
          if (c.name === "expo-plugin" && c.status === "fail") {
            c.status = "ok";
            c.message = patchedManualSetup
              ? "not used (manual babel + metro setup configured via --fix)"
              : `${EXPO_PLUGIN_NAME} registered (via --fix)`;
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
  projectRoot: string,
  metro: string,
  timeoutMs: number,
  runtime: DoctorRuntime,
): Promise<CheckResult> {
  const fetchImpl = runtime.fetch ?? fetch;
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
    let body: { devices?: unknown[]; recent_disconnected?: unknown[] };
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
      const lastSeen = newestRecentDisconnected(body.recent_disconnected);
      if (lastSeen) {
        return {
          name: "runtime",
          status: "fail",
          message: `last seen ${formatAge(Date.now() - lastSeen.last_seen_at)} ago (device ${lastSeen.id}${formatDevicePlatform(lastSeen)}) — currently disconnected`,
        };
      }
      return {
        name: "runtime",
        status: "fail",
        message: await noRuntimeGuidance(projectRoot, metro, runtime),
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

async function noRuntimeGuidance(projectRoot: string, metro: string, runtime: DoctorRuntime): Promise<string> {
  const pkg = await readPackageJson(projectRoot, runtime);
  const deps = { ...(pkg?.dependencies ?? {}), ...(pkg?.devDependencies ?? {}) };
  const metroHint = metro === DEFAULT_METRO_URL ? "" : ` with --metro ${metro}`;
  if (typeof deps.expo === "string") {
    return `no runtime connected — brna does not support Expo web runtimes; open an Expo iOS/Android dev client or simulator${metroHint} and ensure withBrna() wraps Metro`;
  }
  if (typeof deps["react-native"] === "string") {
    return `no runtime connected — start the React Native app with npm run ios or npm run android${metroHint}, then run brna devices to confirm the runtime`;
  }
  return "no runtime connected — start the app on an iOS/Android simulator or device, ensure withBrna() wraps Metro, then run brna devices";
}

interface RecentDisconnectedDevice {
  id: string;
  platform?: string;
  os_version?: string;
  last_seen_at: number;
}

function newestRecentDisconnected(value: unknown): RecentDisconnectedDevice | null {
  if (!Array.isArray(value)) return null;
  let newest: RecentDisconnectedDevice | null = null;
  for (const item of value) {
    if (!item || typeof item !== "object") continue;
    const candidate = item as Record<string, unknown>;
    if (typeof candidate.id !== "string") continue;
    if (typeof candidate.last_seen_at !== "number" || !Number.isFinite(candidate.last_seen_at)) continue;
    const next: RecentDisconnectedDevice = {
      id: candidate.id,
      last_seen_at: candidate.last_seen_at,
    };
    if (typeof candidate.platform === "string") next.platform = candidate.platform;
    if (typeof candidate.os_version === "string") next.os_version = candidate.os_version;
    if (!newest || next.last_seen_at > newest.last_seen_at) newest = next;
  }
  return newest;
}

function formatAge(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  return `${Math.round(minutes / 60)}h`;
}

function formatDevicePlatform(device: RecentDisconnectedDevice): string {
  const parts = [device.platform, device.os_version].filter((v): v is string => typeof v === "string" && v.length > 0);
  return parts.length > 0 ? `, ${parts.join(" ")}` : "";
}

async function checkBabelFingerprint(
  projectRoot: string,
  metro: string,
  timeoutMs: number,
  runtime: DoctorRuntime,
): Promise<CheckResult> {
  const fetchImpl = runtime.fetch ?? fetch;
  const probeTimeoutMs = Math.max(timeoutMs, BABEL_PROBE_TIMEOUT_FLOOR_MS);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), probeTimeoutMs);
  try {
    const bundlePath = await bundlePathForProject(projectRoot, runtime);
    const res = await fetchImpl(`${metro}/${bundlePath}.bundle?platform=ios&dev=true&minify=false`, {
      signal: controller.signal,
    });
    clearTimeout(timer);
    if (!res.ok) {
      const mismatch = await diagnoseProjectRootMismatch(res, projectRoot);
      if (mismatch) {
        return {
          name: "babel-plugin",
          status: "fail",
          message: mismatch,
        };
      }
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

async function diagnoseProjectRootMismatch(response: Response, projectRoot: string): Promise<string | null> {
  const originPath = await readOriginModulePath(response);
  if (!originPath || !looksLikeAbsolutePath(originPath)) return null;
  const servedRoot = resolve(originPath);
  const currentRoot = resolve(projectRoot);
  if (isInsideOrEqual(servedRoot, currentRoot)) return null;
  return `Metro project root mismatch — Metro is serving ${servedRoot} but brna is running in ${currentRoot}. Stop the other Metro server or pass --metro <url>.`;
}

async function readOriginModulePath(response: Response): Promise<string | null> {
  try {
    const body = (await response.clone().json()) as unknown;
    if (!body || typeof body !== "object") return null;
    const value = (body as Record<string, unknown>).originModulePath;
    return typeof value === "string" && value.length > 0 ? value : null;
  } catch {
    return null;
  }
}

function looksLikeAbsolutePath(value: string): boolean {
  return value.startsWith("/") || /^[A-Za-z]:[\\/]/.test(value);
}

function isInsideOrEqual(candidate: string, root: string): boolean {
  return candidate === root || candidate.startsWith(root.endsWith("/") ? root : `${root}/`);
}

interface PackageJson {
  main?: string;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
}

async function bundlePathForProject(projectRoot: string, runtime: DoctorRuntime): Promise<string> {
  const pkg = await readPackageJson(projectRoot, runtime);
  return bundlePathFromMain(pkg?.main);
}

export function bundlePathFromMain(main: string | undefined): string {
  const raw = typeof main === "string" && main.trim().length > 0 ? main.trim() : "index";
  const withoutDot = raw.startsWith("./") ? raw.slice(2) : raw;
  const withoutExt = withoutDot.replace(/\.(mjs|cjs|js|jsx|ts|tsx)$/, "");
  if (withoutExt.startsWith("node_modules/")) return withoutExt;
  if (withoutExt === "expo-router/entry" || withoutExt.startsWith("@")) {
    return `node_modules/${withoutExt}`;
  }
  if (
    !withoutExt.startsWith(".") &&
    withoutExt.includes("/") &&
    !withoutExt.startsWith("src/") &&
    !withoutExt.startsWith("app/")
  ) {
    return `node_modules/${withoutExt}`;
  }
  return withoutExt.replace(/^\/+/, "");
}

async function checkProject(projectRoot: string, runtime: DoctorRuntime): Promise<CheckResult[]> {
  const out: CheckResult[] = [];
  const pkg = await readPackageJson(projectRoot, runtime);
  if (!pkg) {
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
    const manualSetup = await hasManualBrnaSetup(projectRoot, runtime);
    const appConfig = await readAppConfig(projectRoot, runtime);
    if (manualSetup && (!appConfig || !hasBrnaPlugin(appConfig.parsed))) {
      out.push({
        name: "expo-plugin",
        status: "skip",
        message: "not used (manual babel + metro setup detected — OK)",
      });
    } else if (!appConfig) {
      out.push({
        name: "expo-plugin",
        status: "warn",
        message: "no Expo app config found — run 'brna doctor --fix' to wire Babel + Metro directly (the reliable path for expo start / dev-client flows)",
      });
    } else if (hasBrnaPlugin(appConfig.parsed)) {
      out.push({ name: "expo-plugin", status: "ok", message: `${EXPO_PLUGIN_NAME} registered` });
    } else {
      out.push({
        name: "expo-plugin",
        status: "fail",
        message: `${EXPO_PLUGIN_NAME} missing — run 'brna doctor --fix' (direct Babel + Metro wiring is the reliable path for expo start / dev-client flows; the config plugin only applies during expo prebuild)`,
      });
    }
  }

  return out;
}

async function readPackageJson(projectRoot: string, runtime: DoctorRuntime): Promise<PackageJson | null> {
  const pkgPath = resolve(projectRoot, "package.json");
  try {
    const raw = await (runtime.readFile ?? readFile)(pkgPath, "utf8");
    return JSON.parse(raw) as PackageJson;
  } catch {
    return null;
  }
}

async function hasManualBrnaSetup(projectRoot: string, runtime: DoctorRuntime): Promise<boolean> {
  const [hasBabel, hasMetro] = await Promise.all([
    hasPatchedConfig(projectRoot, runtime, ["babel.config.js", "babel.config.cjs"], (text) =>
      text.includes(BABEL_PLUGIN_NAME),
    ),
    hasPatchedConfig(projectRoot, runtime, ["metro.config.js", "metro.config.cjs"], (text) =>
      text.includes(METRO_PLUGIN_NAME) || text.includes("withBrna"),
    ),
  ]);
  return hasBabel && hasMetro;
}

async function hasPatchedConfig(
  projectRoot: string,
  runtime: DoctorRuntime,
  candidates: string[],
  predicate: (text: string) => boolean,
): Promise<boolean> {
  for (const candidate of candidates) {
    const path = resolve(projectRoot, candidate);
    try {
      const text = await (runtime.readFile ?? readFile)(path, "utf8");
      if (predicate(text)) return true;
    } catch {
      /* try next */
    }
  }
  return false;
}

interface AppConfig {
  path: string;
  editable: boolean;
  parsed: { expo?: { plugins?: unknown[] }; plugins?: unknown[] };
}

async function readAppConfig(projectRoot: string, runtime: DoctorRuntime): Promise<AppConfig | null> {
  const resolved = readResolvedExpoConfig(projectRoot);
  if (resolved) return resolved;

  const candidates = ["app.json", "app.config.json"];
  for (const name of candidates) {
    const path = resolve(projectRoot, name);
    try {
      const raw = await (runtime.readFile ?? readFile)(path, "utf8");
      return { path, editable: true, parsed: JSON.parse(raw) as AppConfig["parsed"] };
    } catch {
      /* try next */
    }
  }
  for (const name of ["app.config.js", "app.config.cjs", "app.config.mjs", "app.config.ts"]) {
    const path = resolve(projectRoot, name);
    try {
      const raw = await (runtime.readFile ?? readFile)(path, "utf8");
      return {
        path,
        editable: false,
        parsed: { plugins: raw.includes(EXPO_PLUGIN_NAME) ? [EXPO_PLUGIN_NAME] : [] },
      };
    } catch {
      /* try next */
    }
  }
  return null;
}

function readResolvedExpoConfig(projectRoot: string): AppConfig | null {
  try {
    const projectRequire = createRequire(resolve(projectRoot, "package.json"));
    const expoConfig = projectRequire("@expo/config") as {
      getConfig?: (root: string, opts?: Record<string, unknown>) => {
        exp?: { plugins?: unknown[] };
        dynamicConfigPath?: string;
        staticConfigPath?: string;
      };
    };
    if (typeof expoConfig.getConfig !== "function") return null;
    const result = expoConfig.getConfig(projectRoot, { skipSDKVersionRequirement: true });
    const path = result.dynamicConfigPath ?? result.staticConfigPath ?? resolve(projectRoot, "app.config.js");
    const editable = Boolean(result.staticConfigPath && !result.dynamicConfigPath);
    return { path, editable, parsed: { expo: result.exp ?? {} } };
  } catch {
    return null;
  }
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
  const pkg = await readPackageJson(projectRoot, runtime);
  if (!pkg) return [];
  const deps = { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) };
  const isExpo = typeof deps.expo === "string";
  if (!isExpo) {
    return applyDirectConfigFixes(projectRoot, runtime, stdout);
  }
  if (await hasManualBrnaSetup(projectRoot, runtime)) {
    return [{
      name: "fix",
      status: "ok",
      message: "manual babel + metro setup already configured",
    }];
  }
  const result = await applyExpoFix(projectRoot, runtime, stdout);
  if (result.status === "ok") return [result];
  if (result.message.startsWith("skipped ")) return [result];
  const direct = await applyDirectConfigFixes(projectRoot, runtime, stdout);
  return [result, ...direct];
}

async function applyExpoFix(
  projectRoot: string,
  runtime: DoctorRuntime,
  stdout: Pick<typeof process.stdout, "write">,
): Promise<CheckResult> {
  const appConfig = await readAppConfig(projectRoot, runtime);
  if (!appConfig) {
    return { name: "fix", status: "warn", message: "no editable Expo app config found; falling back to direct Babel + Metro wiring (managed/dev-client setup path)" };
  }
  if (hasBrnaPlugin(appConfig.parsed)) {
    return { name: "fix", status: "ok", message: `${EXPO_PLUGIN_NAME} already registered (applies during expo prebuild)` };
  }
  if (!appConfig.editable) {
    return {
      name: "fix",
      status: "warn",
      message: `${appConfig.path} is dynamic; falling back to direct Babel + Metro wiring (managed/dev-client setup path)`,
    };
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
  return { name: "fix", status: "ok", message: `added ${EXPO_PLUGIN_NAME} to ${appConfig.path} (applies during expo prebuild)` };
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
