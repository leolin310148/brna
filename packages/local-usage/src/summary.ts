import { writeFile } from "node:fs/promises";
import { DEFAULT_MAX_BYTES, DEFAULT_RETENTION_DAYS, EXPORT_SCHEMA, SUMMARY_SCHEMA, type OperationSummary, type UsageEvent, type UsageExport, type UsageFinishedEvent, type UsageRuntimeOptions, type UsageSummary } from "./types.js";
import { readUsageEvents, usageStorageInfo } from "./storage.js";

const RECOVERY_WINDOW_MS = 5 * 60 * 1000;

export async function summarizeUsage(options: UsageRuntimeOptions & { since?: Date } = {}): Promise<UsageSummary> {
  const now = options.now?.() ?? new Date();
  const since = options.since ?? new Date(now.getTime() - 7 * 86_400_000);
  return buildUsageSummary(await readUsageEvents({ ...options, since }), since, now);
}

export function buildUsageSummary(events: UsageEvent[], since: Date, until: Date): UsageSummary {
  const starts = events.filter((event) => event.event === "operation.started");
  const finishes = events.filter((event): event is UsageFinishedEvent => event.event === "operation.finished");
  const finishedIds = new Set(finishes.map((event) => event.operation_id));
  const operationNames = new Set([...starts.map((event) => event.operation), ...finishes.map((event) => event.operation)]);
  const operations: OperationSummary[] = [];

  for (const operation of [...operationNames].sort()) {
    const operationStarts = starts.filter((event) => event.operation === operation);
    const operationFinishes = finishes.filter((event) => event.operation === operation);
    const success = operationFinishes.filter((event) => event.outcome === "success").length;
    const error = operationFinishes.filter((event) => event.outcome === "error").length;
    const interrupted = operationStarts.filter((event) => !finishedIds.has(event.operation_id)).length;
    const durations = operationFinishes.map((event) => event.duration_ms).sort((a, b) => a - b);
    operations.push({
      operation,
      started: operationStarts.length,
      success,
      error,
      interrupted,
      success_rate: rate(success, success + error),
      duration_ms: { p50: percentile(durations, 0.5), p95: percentile(durations, 0.95) },
    });
  }

  const errorCounts = new Map<string, number>();
  for (const event of finishes) {
    if (event.outcome !== "error") continue;
    const code = event.error_code ?? "unknown";
    errorCounts.set(code, (errorCounts.get(code) ?? 0) + 1);
  }

  const recoveryCounts = new Map<string, number>();
  const bySession = new Map<string, UsageFinishedEvent[]>();
  for (const event of finishes) {
    const existing = bySession.get(event.session_id);
    if (existing) existing.push(event);
    else bySession.set(event.session_id, [event]);
  }
  for (const sessionEvents of bySession.values()) {
    sessionEvents.sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp));
    for (let index = 0; index < sessionEvents.length; index++) {
      const failed = sessionEvents[index]!;
      if (failed.outcome !== "error") continue;
      for (let nextIndex = index + 1; nextIndex < sessionEvents.length; nextIndex++) {
        const recovered = sessionEvents[nextIndex]!;
        if (Date.parse(recovered.timestamp) - Date.parse(failed.timestamp) > RECOVERY_WINDOW_MS) break;
        if (recovered.outcome !== "success") continue;
        const key = `${failed.error_code ?? "unknown"}\0${recovered.operation}`;
        recoveryCounts.set(key, (recoveryCounts.get(key) ?? 0) + 1);
        break;
      }
    }
  }

  const success = finishes.filter((event) => event.outcome === "success").length;
  const error = finishes.length - success;
  const interrupted = starts.filter((event) => !finishedIds.has(event.operation_id)).length;
  return {
    schema: SUMMARY_SCHEMA,
    window: { since: since.toISOString(), until: until.toISOString() },
    totals: { started: starts.length, success, error, interrupted, success_rate: rate(success, success + error) },
    operations,
    errors: [...errorCounts].map(([code, count]) => ({ code, count })).sort(sortCountThenName("code")),
    recoveries: [...recoveryCounts].map(([key, count]) => {
      const [from_error, to_operation] = key.split("\0");
      return { from_error: from_error!, to_operation: to_operation!, count };
    }).sort(sortCountThenName("from_error")),
  };
}

export async function buildUsageExport(options: UsageRuntimeOptions & { since?: Date } = {}): Promise<UsageExport> {
  const now = options.now?.() ?? new Date();
  const storage = await usageStorageInfo(options);
  return {
    schema: EXPORT_SCHEMA,
    generated_at: now.toISOString(),
    collection: {
      retention_days: options.retentionDays ?? DEFAULT_RETENTION_DAYS,
      max_bytes: options.maxBytes ?? DEFAULT_MAX_BYTES,
      event_files: storage.eventFiles,
      current_bytes: storage.currentBytes,
    },
    summary: await summarizeUsage({ ...options, now: () => now, ...(options.since ? { since: options.since } : {}) }),
  };
}

export async function writeUsageExport(path: string, options: UsageRuntimeOptions & { since?: Date } = {}): Promise<void> {
  await writeFile(path, `${JSON.stringify(await buildUsageExport(options), null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
}

function rate(success: number, completed: number): number | null {
  return completed === 0 ? null : Math.round((success / completed) * 10_000) / 10_000;
}

function percentile(values: number[], quantile: number): number | null {
  if (values.length === 0) return null;
  return values[Math.max(0, Math.ceil(values.length * quantile) - 1)]!;
}

function sortCountThenName<K extends string>(key: K) {
  return <T extends { count: number } & Record<K, string>>(a: T, b: T): number => b.count - a.count || a[key].localeCompare(b[key]);
}
