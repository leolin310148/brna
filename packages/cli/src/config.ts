import { existsSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type {
  ObservabilityRedactionOptions,
  SerializableRedactionRule,
  SnapshotRedactionOptions,
} from "@brna/schema";
import { fail } from "./options.js";

export interface BrnaConfig {
  redact?: Array<{ match: RegExp | string; replace: string }>;
  redactSecureFields?: boolean;
  sessionDir?: string;
  measureTimeoutMs?: number;
}

export interface LoadedConfig {
  path?: string;
  config: BrnaConfig;
}

export async function runConfig(rest: string[]): Promise<void> {
  const sub = rest[0];
  if (sub !== "init") fail(4, "usage: brna config init");
  if (rest.length > 1) fail(4, `unexpected argument '${rest[1]}'`);
  const target = join(process.cwd(), "brna.config.ts");
  if (existsSync(target)) fail(4, "brna.config.ts already exists");
  await writeFile(target, defaultConfigText(), "utf8");
  process.stdout.write(`${target}\n`);
  process.exit(0);
}

export async function loadConfig(cwd = process.cwd()): Promise<LoadedConfig> {
  for (const name of ["brna.config.ts", "brna.config.js"]) {
    const path = join(cwd, name);
    if (!existsSync(path)) continue;
    const mod = (await import(`${path}?t=${Date.now()}`)) as { default?: BrnaConfig; config?: BrnaConfig };
    return { path, config: mod.default ?? mod.config ?? {} };
  }
  return { config: {} };
}

function configRedactRules(config: BrnaConfig): SerializableRedactionRule[] {
  const rules: SerializableRedactionRule[] = [];
  for (const rule of config.redact ?? []) {
    if (typeof rule.match === "string") {
      rules.push({ match: { source: escapeRegExp(rule.match), flags: "g" }, replace: rule.replace });
    } else if (rule.match instanceof RegExp) {
      rules.push({
        match: { source: rule.match.source, flags: rule.match.flags },
        replace: rule.replace,
      });
    }
  }
  return rules;
}

export function toRedactionOptions(config: BrnaConfig): SnapshotRedactionOptions {
  const rules = configRedactRules(config);
  return {
    ...(rules.length > 0 ? { rules } : {}),
    ...(config.redactSecureFields !== undefined
      ? { redactSecureFields: config.redactSecureFields }
      : {}),
  };
}

export function toObservabilityRedactionOptions(
  config: BrnaConfig,
): ObservabilityRedactionOptions {
  const rules = configRedactRules(config);
  return rules.length > 0 ? { rules } : {};
}

export function sessionDirFromConfig(config: BrnaConfig): string {
  return config.sessionDir ?? join(tmpdir(), "brna", "sessions");
}

export function measureTimeoutFromConfig(config: BrnaConfig): number | undefined {
  if (config.measureTimeoutMs === undefined) return undefined;
  if (typeof config.measureTimeoutMs !== "number" || !Number.isFinite(config.measureTimeoutMs) || config.measureTimeoutMs <= 0) {
    throw new Error("measureTimeoutMs must be a finite positive number");
  }
  return config.measureTimeoutMs;
}

function defaultConfigText(): string {
  return `import type { BrnaConfig } from "@brna/cli";

const config: BrnaConfig = {
  sessionDir: undefined,
  measureTimeoutMs: undefined,
  redactSecureFields: true,
  redact: [
    { match: /[\\w.+-]+@[\\w-]+\\.[\\w.-]+/g, replace: "<email>" },
  ],
};

export default config;
`;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
