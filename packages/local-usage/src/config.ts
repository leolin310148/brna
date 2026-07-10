import { createHmac, randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { UsageCaller, UsageEnablement, UsageRuntimeOptions } from "./types.js";

const SETTINGS_FILE = "settings.json";
const IDENTITY_FILE = "identity.json";

interface UsageSettings {
  enabled?: boolean;
}

interface UsageIdentity {
  installation_id: string;
  secret: string;
}

export function usageStateDir(options: UsageRuntimeOptions = {}): string {
  if (options.stateDir) return options.stateDir;
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  const home = options.homeDir ?? homedir();
  if (platform === "darwin") return join(home, "Library", "Application Support", "brna", "usage");
  if (platform === "win32") return join(env.LOCALAPPDATA ?? join(home, "AppData", "Local"), "brna", "usage");
  return join(env.XDG_STATE_HOME ?? join(home, ".local", "state"), "brna", "usage");
}

export async function resolveUsageEnablement(options: UsageRuntimeOptions = {}): Promise<UsageEnablement> {
  const env = options.env ?? process.env;
  if (truthy(env.DO_NOT_TRACK)) return { enabled: false, reason: "do_not_track" };
  if (env.BRNA_USAGE_LOG !== undefined) {
    return { enabled: truthy(env.BRNA_USAGE_LOG), reason: "environment" };
  }
  const settings = await readSettings(options);
  if (settings.enabled !== undefined) return { enabled: settings.enabled, reason: "setting" };
  if (isCi(env)) return { enabled: false, reason: "ci" };
  return { enabled: true, reason: "default" };
}

export async function setUsageEnabled(enabled: boolean, options: UsageRuntimeOptions = {}): Promise<void> {
  const root = usageStateDir(options);
  await mkdir(root, { recursive: true, mode: 0o700 });
  await chmod(root, 0o700).catch(() => undefined);
  await writeJsonAtomic(join(root, SETTINGS_FILE), { enabled });
}

export async function getUsageIdentity(options: UsageRuntimeOptions = {}): Promise<UsageIdentity> {
  const root = usageStateDir(options);
  const path = join(root, IDENTITY_FILE);
  const existing = await readJson(path);
  if (isIdentity(existing)) return existing;

  const uuid = options.randomUUID ?? randomUUID;
  const identity = { installation_id: uuid(), secret: uuid().replace(/-/g, "") + uuid().replace(/-/g, "") };
  await mkdir(root, { recursive: true, mode: 0o700 });
  await chmod(root, 0o700).catch(() => undefined);
  try {
    await writeFile(path, `${JSON.stringify(identity, null, 2)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
  } catch {
    const raced = await readJson(path);
    if (isIdentity(raced)) return raced;
    throw new Error("could not initialize usage identity");
  }
  await chmod(path, 0o600).catch(() => undefined);
  return identity;
}

export function pseudonymousId(secret: string, kind: "project" | "session", value: string): string {
  return createHmac("sha256", secret).update(`${kind}\0${value}`).digest("hex").slice(0, 24);
}

export function normalizeUsageCaller(value: string | undefined): UsageCaller {
  const normalized = value?.trim().toLowerCase() ?? "";
  for (const caller of ["codex", "claude", "cursor", "copilot", "gemini", "continue"] as const) {
    if (normalized === caller || normalized.startsWith(`${caller}-`) || normalized.startsWith(`${caller}/`)) return caller;
  }
  return "unknown";
}

export function truthy(value: string | undefined): boolean {
  if (value === undefined || value.trim().length === 0) return false;
  return !["0", "false", "no", "off", "disabled"].includes(value.trim().toLowerCase());
}

function isCi(env: NodeJS.ProcessEnv): boolean {
  if (env.NODE_ENV === "test") return true;
  return ["CI", "GITHUB_ACTIONS", "GITLAB_CI", "BUILDKITE", "CIRCLECI", "TF_BUILD"].some((key) => truthy(env[key]));
}

async function readSettings(options: UsageRuntimeOptions): Promise<UsageSettings> {
  const value = await readJson(join(usageStateDir(options), SETTINGS_FILE));
  if (!value || typeof value !== "object") return {};
  const enabled = (value as Record<string, unknown>).enabled;
  return typeof enabled === "boolean" ? { enabled } : {};
}

async function readJson(path: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch {
    return undefined;
  }
}

async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.tmp-${process.pid}-${randomUUID()}`;
  await writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  await rename(tmp, path);
  await chmod(path, 0o600).catch(() => undefined);
}

function isIdentity(value: unknown): value is UsageIdentity {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Record<string, unknown>;
  return typeof candidate.installation_id === "string" && typeof candidate.secret === "string" && candidate.secret.length >= 32;
}
