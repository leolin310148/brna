import { appendFile, chmod, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { DEFAULT_MAX_BYTES, DEFAULT_RETENTION_DAYS, USAGE_SCHEMA, type UsageEvent, type UsageRuntimeOptions } from "./types.js";
import { usageStateDir } from "./config.js";

const EVENT_FILE_PATTERN = /^events-\d{4}-\d{2}-\d{2}\.jsonl$/;
const CLEANUP_MARKER = ".last-cleanup";

export async function appendUsageEvent(event: UsageEvent, options: UsageRuntimeOptions = {}): Promise<void> {
  const root = usageStateDir(options);
  await mkdir(root, { recursive: true, mode: 0o700 });
  await chmod(root, 0o700).catch(() => undefined);
  const day = event.timestamp.slice(0, 10);
  const path = join(root, `events-${day}.jsonl`);
  await appendFile(path, `${JSON.stringify(event)}\n`, { encoding: "utf8", mode: 0o600 });
  await chmod(path, 0o600).catch(() => undefined);
  await maybeCleanupUsageFiles(options, day);
}

export async function readUsageEvents(options: UsageRuntimeOptions & { since?: Date } = {}): Promise<UsageEvent[]> {
  const root = usageStateDir(options);
  const files = await listEventFiles(root);
  const events: UsageEvent[] = [];
  for (const file of files) {
    let content: string;
    try {
      content = await readFile(join(root, file.name), "utf8");
    } catch {
      continue;
    }
    for (const line of content.split("\n")) {
      if (!line) continue;
      let value: unknown;
      try {
        value = JSON.parse(line);
      } catch {
        continue;
      }
      const event = parseUsageEvent(value);
      if (!event) continue;
      if (options.since && Date.parse(event.timestamp) < options.since.getTime()) continue;
      events.push(event);
    }
  }
  return events.sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp));
}

export async function usageStorageInfo(options: UsageRuntimeOptions = {}): Promise<{ currentBytes: number; eventFiles: number }> {
  const files = await listEventFiles(usageStateDir(options));
  return {
    currentBytes: files.reduce((sum, file) => sum + file.size, 0),
    eventFiles: files.length,
  };
}

export async function clearUsageEvents(options: UsageRuntimeOptions = {}): Promise<number> {
  const root = usageStateDir(options);
  const files = await listEventFiles(root);
  await Promise.all(files.map((file) => rm(join(root, file.name), { force: true }).catch(() => undefined)));
  await rm(join(root, CLEANUP_MARKER), { force: true }).catch(() => undefined);
  return files.length;
}

export async function cleanupUsageFiles(options: UsageRuntimeOptions = {}): Promise<void> {
  const root = usageStateDir(options);
  const now = options.now?.() ?? new Date();
  const retentionDays = options.retentionDays ?? DEFAULT_RETENTION_DAYS;
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  const cutoff = now.getTime() - retentionDays * 86_400_000;
  const activeName = `events-${now.toISOString().slice(0, 10)}.jsonl`;
  let files = await listEventFiles(root);

  for (const file of files) {
    if (file.mtimeMs < cutoff) await rm(join(root, file.name), { force: true }).catch(() => undefined);
  }

  files = await listEventFiles(root);
  let total = files.reduce((sum, file) => sum + file.size, 0);
  for (const file of files.sort((a, b) => a.mtimeMs - b.mtimeMs)) {
    if (total <= maxBytes) break;
    if (file.name === activeName) continue;
    await rm(join(root, file.name), { force: true }).catch(() => undefined);
    total -= file.size;
  }
}

async function maybeCleanupUsageFiles(options: UsageRuntimeOptions, day: string): Promise<void> {
  const marker = join(usageStateDir(options), CLEANUP_MARKER);
  try {
    if ((await readFile(marker, "utf8")).trim() === day) return;
  } catch {
    // Missing markers trigger cleanup.
  }
  await cleanupUsageFiles(options);
  await writeFile(marker, `${day}\n`, { encoding: "utf8", mode: 0o600 }).catch(() => undefined);
}

async function listEventFiles(root: string): Promise<Array<{ name: string; size: number; mtimeMs: number }>> {
  let names: string[];
  try {
    names = await readdir(root);
  } catch {
    return [];
  }
  const result: Array<{ name: string; size: number; mtimeMs: number }> = [];
  for (const name of names.filter((candidate) => EVENT_FILE_PATTERN.test(candidate)).sort()) {
    try {
      const info = await stat(join(root, name));
      if (info.isFile()) result.push({ name, size: info.size, mtimeMs: info.mtimeMs });
    } catch {
      // Concurrent cleanup may remove a file between readdir and stat.
    }
  }
  return result;
}

function parseUsageEvent(value: unknown): UsageEvent | undefined {
  if (!value || typeof value !== "object") return undefined;
  const event = value as Record<string, unknown>;
  if (event.schema !== USAGE_SCHEMA) return undefined;
  if (event.event !== "operation.started" && event.event !== "operation.finished") return undefined;
  for (const key of ["timestamp", "installation_id", "project_id", "session_id", "operation_id", "surface", "caller", "operation", "brna_version", "platform", "arch"]) {
    if (typeof event[key] !== "string") return undefined;
  }
  if (!Number.isFinite(Date.parse(event.timestamp as string))) return undefined;
  if (event.event === "operation.finished") {
    if (event.outcome !== "success" && event.outcome !== "error") return undefined;
    if (typeof event.duration_ms !== "number" || !Number.isFinite(event.duration_ms) || event.duration_ms < 0) return undefined;
  }
  return value as UsageEvent;
}
