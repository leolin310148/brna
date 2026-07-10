import {
  clearUsageEvents,
  disableUsage,
  enableUsage,
  getUsageStatus,
  summarizeUsage,
  usageStateDir,
  writeUsageExport,
  type UsageSummary,
} from "@brna/local-usage";
import { escapeControlCharacters } from "./format.js";

const DEFAULT_SINCE_MS = 7 * 86_400_000;

export async function runUsage(rest: string[]): Promise<number> {
  const subcommand = rest[0];
  try {
    if (subcommand === "status") return usageStatus(rest.slice(1));
    if (subcommand === "path") return usagePath(rest.slice(1));
    if (subcommand === "summary") return usageSummary(rest.slice(1));
    if (subcommand === "export") return usageExport(rest.slice(1));
    if (subcommand === "clear") return usageClear(rest.slice(1));
    if (subcommand === "enable") return usageEnable(rest.slice(1));
    if (subcommand === "disable") return usageDisable(rest.slice(1));
    process.stderr.write("brna: usage: brna usage <status|path|summary|export|clear|enable|disable>\n");
    return 4;
  } catch (err) {
    process.stderr.write(`brna: usage journal error: ${escapeControlCharacters((err as Error).message)}\n`);
    return 1;
  }
}

async function usageStatus(rest: string[]): Promise<number> {
  if (rest.length > 0) return unexpected(rest[0]!);
  const status = await getUsageStatus();
  process.stdout.write([
    `Local usage collection: ${status.enabled ? "enabled" : "disabled"} (${status.reason})`,
    `Path: ${status.path}`,
    `Retention: ${status.retention_days} days`,
    `Size: ${formatBytes(status.current_bytes)} / ${formatBytes(status.max_bytes)} in ${status.event_files} file(s)`,
  ].join("\n") + "\n");
  return 0;
}

async function usagePath(rest: string[]): Promise<number> {
  if (rest.length > 0) return unexpected(rest[0]!);
  process.stdout.write(`${usageStateDir()}\n`);
  return 0;
}

async function usageSummary(rest: string[]): Promise<number> {
  const parsed = parseAnalysisOptions(rest, false);
  if ("code" in parsed) return parsed.code;
  const summary = await summarizeUsage({ since: new Date(Date.now() - parsed.sinceMs) });
  process.stdout.write(parsed.json ? `${JSON.stringify(summary, null, 2)}\n` : formatUsageSummary(summary));
  return 0;
}

async function usageExport(rest: string[]): Promise<number> {
  const parsed = parseAnalysisOptions(rest, true);
  if ("code" in parsed) return parsed.code;
  if (!parsed.to) {
    process.stderr.write("brna: usage export requires --to <path>\n");
    return 4;
  }
  await writeUsageExport(parsed.to, { since: new Date(Date.now() - parsed.sinceMs) });
  process.stdout.write(`${parsed.to}\n`);
  return 0;
}

async function usageClear(rest: string[]): Promise<number> {
  if (rest.length > 0) return unexpected(rest[0]!);
  const removed = await clearUsageEvents();
  process.stdout.write(`Cleared ${removed} local usage file(s).\n`);
  return 0;
}

async function usageEnable(rest: string[]): Promise<number> {
  if (rest.length > 0) return unexpected(rest[0]!);
  await enableUsage();
  process.stdout.write("Local usage collection setting enabled.\n");
  return 0;
}

async function usageDisable(rest: string[]): Promise<number> {
  if (rest.length > 0) return unexpected(rest[0]!);
  await disableUsage();
  process.stdout.write("Local usage collection setting disabled.\n");
  return 0;
}

function parseAnalysisOptions(rest: string[], allowTo: boolean): { sinceMs: number; json: boolean; to?: string } | { code: number } {
  let sinceMs = DEFAULT_SINCE_MS;
  let json = false;
  let to: string | undefined;
  for (let index = 0; index < rest.length; index++) {
    const token = rest[index]!;
    if (token === "--json" && !allowTo) {
      json = true;
    } else if (token === "--since") {
      const value = rest[++index];
      const parsed = parseDuration(value);
      if (parsed === undefined) {
        process.stderr.write(`brna: '--since' must be a positive duration such as 24h, 7d, or 30m, got '${escapeControlCharacters(value ?? "")}'\n`);
        return { code: 4 };
      }
      sinceMs = parsed;
    } else if (token === "--to" && allowTo) {
      const value = rest[++index];
      if (!value) {
        process.stderr.write("brna: missing value for '--to'\n");
        return { code: 4 };
      }
      to = value;
    } else {
      process.stderr.write(`brna: unknown usage flag '${escapeControlCharacters(token)}'\n`);
      return { code: 4 };
    }
  }
  return { sinceMs, json, ...(to ? { to } : {}) };
}

function parseDuration(value: string | undefined): number | undefined {
  const match = value?.match(/^(\d+)(ms|s|m|h|d)$/);
  if (!match) return undefined;
  const amount = Number(match[1]);
  const unit = match[2] as "ms" | "s" | "m" | "h" | "d";
  const multiplier = { ms: 1, s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 }[unit];
  const duration = amount * multiplier;
  return Number.isSafeInteger(duration) && duration > 0 ? duration : undefined;
}

function formatUsageSummary(summary: UsageSummary): string {
  const rate = summary.totals.success_rate === null ? "n/a" : `${(summary.totals.success_rate * 100).toFixed(1)}%`;
  const lines = [
    `Local usage summary (${summary.window.since} – ${summary.window.until})`,
    `Started ${summary.totals.started} · Success ${summary.totals.success} · Error ${summary.totals.error} · Interrupted ${summary.totals.interrupted} · Success rate ${rate}`,
  ];
  if (summary.operations.length > 0) {
    lines.push("", "Operations:");
    for (const operation of summary.operations) {
      lines.push(`  ${operation.operation}: ${operation.started} started, ${operation.success} ok, ${operation.error} error, ${operation.interrupted} interrupted, p50 ${formatMs(operation.duration_ms.p50)}, p95 ${formatMs(operation.duration_ms.p95)}`);
    }
  }
  if (summary.errors.length > 0) {
    lines.push("", "Errors:", ...summary.errors.map((error) => `  ${error.code}: ${error.count}`));
  }
  if (summary.recoveries.length > 0) {
    lines.push("", "Recoveries:", ...summary.recoveries.map((recovery) => `  ${recovery.from_error} → ${recovery.to_operation}: ${recovery.count}`));
  }
  return `${lines.join("\n")}\n`;
}

function formatMs(value: number | null): string {
  return value === null ? "n/a" : `${value}ms`;
}

function formatBytes(value: number): string {
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KiB`;
  return `${(value / (1024 * 1024)).toFixed(1)} MiB`;
}

function unexpected(value: string): number {
  process.stderr.write(`brna: unexpected argument '${escapeControlCharacters(value)}'\n`);
  return 4;
}
