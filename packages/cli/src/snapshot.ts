import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { validateSnapshot } from "@brna/schema";
import type { Snapshot } from "@brna/schema";
import { diff, toDiffJSON, toDiffMarkdown, toDiffYAML, toMarkdown, toJSON, toYAML } from "@brna/core";
import {
  DEFAULT_METRO_URL,
  DEFAULT_TIMEOUT_MS,
  DEVICE_HEADER,
  diagnoseMetroResponse,
  fail,
  parseDevice,
  parseMetro,
  parseTimeout,
} from "./options.js";
import { readSnapshotCache, writeSnapshotCache } from "./session.js";
import { loadConfig, toRedactionOptions } from "./config.js";
import { appendTraceEvent } from "./trace.js";

export type SnapshotFormat = "md" | "json" | "yaml";
const VALID_FORMATS = new Set<string>(["md", "json", "yaml"]);

interface ParsedArgs {
  metro: string;
  timeoutMs: number;
  format: SnapshotFormat;
  diff: boolean;
  device?: string;
  to?: string;
}

interface SnapshotRuntime {
  fetch?: typeof fetch;
  readSnapshotCache?: typeof readSnapshotCache;
  writeSnapshotCache?: typeof writeSnapshotCache;
  stdout?: Pick<typeof process.stdout, "write">;
  stderr?: Pick<typeof process.stderr, "write">;
  exit?: (code: number) => never;
  writeFile?: (path: string, data: string) => Promise<void>;
}

function parseArgs(rest: string[]): ParsedArgs {
  let metro = DEFAULT_METRO_URL;
  let timeoutMs = DEFAULT_TIMEOUT_MS;
  let format: SnapshotFormat = "md";
  let wantsDiff = false;
  let device: string | undefined;
  let to: string | undefined;

  for (let i = 0; i < rest.length; i++) {
    const token = rest[i]!;
    if (token === "--metro") {
      metro = parseMetro(rest[++i]);
    } else if (token === "--timeout") {
      timeoutMs = parseTimeout(rest[++i]);
    } else if (token === "--format") {
      const value = rest[++i];
      if (typeof value !== "string" || !VALID_FORMATS.has(value)) {
        fail(4, `unknown --format value '${value ?? ""}' (expected md|json|yaml)`);
      }
      format = value as SnapshotFormat;
    } else if (token === "--diff") {
      wantsDiff = true;
    } else if (token === "--device") {
      device = parseDevice(rest[++i]);
    } else if (token === "--to") {
      const value = rest[++i];
      if (typeof value !== "string" || value.length === 0) {
        fail(4, "missing value for '--to'");
      }
      to = value;
    } else {
      fail(4, `unknown flag '${token}'`);
    }
  }
  const result: ParsedArgs = { metro, timeoutMs, format, diff: wantsDiff };
  if (device !== undefined) result.device = device;
  if (to !== undefined) result.to = to;
  return result;
}

export async function runSnapshot(rest: string[], runtime: SnapshotRuntime = {}): Promise<void> {
  const parsed = parseArgs(rest);
  const { metro, timeoutMs, format, diff: wantsDiff, device, to } = parsed;
  const fetchImpl = runtime.fetch ?? fetch;
  const stdout = runtime.stdout ?? process.stdout;
  const stderr = runtime.stderr ?? process.stderr;
  const exit = runtime.exit ?? process.exit;
  const url = `${metro}/brna/snapshot`;
  const config = (await loadConfig()).config;
  const redaction = toRedactionOptions(config);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  let response: Response;
  const headers: Record<string, string> = {};
  if (device !== undefined) headers[DEVICE_HEADER] = device;
  try {
    const hasRedaction = redaction.rules !== undefined || redaction.redactSecureFields !== undefined;
    response = await fetchImpl(url, {
      method: hasRedaction ? "POST" : "GET",
      signal: controller.signal,
      headers: hasRedaction ? { ...headers, "Content-Type": "application/json" } : headers,
      ...(hasRedaction ? { body: JSON.stringify({ redaction }) } : {}),
    });
  } catch (err) {
    clearTimeout(timer);
    const e = err as { name?: string };
    if (e?.name === "AbortError") {
      failWith(2, `snapshot timed out after ${timeoutMs}ms`, stderr, exit);
    }
    failWith(1, `could not connect to Metro at ${metro}`, stderr, exit);
  }
  clearTimeout(timer);

  if (response.status === 503) {
    failWith(3, "no runtime connected — start the app first", stderr, exit);
  }
  if (response.status === 404) {
    failWith(3, `unknown device '${device ?? "?"}' — run 'brna devices' to list connected runtimes`, stderr, exit);
  }
  if (response.status === 504) {
    failWith(3, `runtime timed out — Metro middleware reported ${response.status}`, stderr, exit);
  }
  if (response.status === 502) {
    let body: { code?: string; message?: string } = {};
    try {
      body = (await response.json()) as { code?: string; message?: string };
    } catch {
      /* ignore */
    }
    failWith(3, `runtime error: ${body.code ?? "unknown"} — ${body.message ?? "no message"}`, stderr, exit);
  }
  if (response.status === 429) {
    failWith(3, "another snapshot request is already in flight", stderr, exit);
  }
  if (!response.ok) {
    const diagnosis = await diagnoseMetroResponse(response, "snapshot endpoint");
    failWith(
      3,
      diagnosis ?? `unexpected HTTP ${response.status} from Metro`,
      stderr,
      exit,
    );
  }

  const diagnosis = await diagnoseMetroResponse(response, "snapshot endpoint");
  let snapshot: Snapshot;
  try {
    snapshot = (await response.json()) as Snapshot;
  } catch (err) {
    failWith(
      3,
      diagnosis ?? `malformed JSON in snapshot response: ${(err as Error).message}`,
      stderr,
      exit,
    );
  }

  try {
    validateSnapshot(snapshot);
  } catch (err) {
    failWith(3, `invalid snapshot received — ${(err as Error).message}`, stderr, exit);
  }

  if (wantsDiff) {
    const baseline = await (runtime.readSnapshotCache ?? readSnapshotCache)();
    if (!baseline) {
      failWith(6, "no baseline snapshot in this session — run brna snapshot first", stderr, exit);
    }
    const out = projectDiff(diff(baseline, snapshot), format);
    if (to !== undefined) {
      await writeOutputFile(to, out, runtime, stderr, exit);
    } else {
      stdout.write(out);
    }
    await refreshSnapshotCache(snapshot, runtime);
    await appendTraceEvent({
      type: "snap",
      timestamp: new Date().toISOString(),
      command: "snap",
      args: rest,
      snapshot_before: baseline,
      snapshot_after: snapshot,
      diff: diff(baseline, snapshot),
    });
    exit(0);
  }

  const out = projectSnapshot(snapshot, format);
  if (to !== undefined) {
    const text = out.endsWith("\n") ? out : `${out}\n`;
    await writeOutputFile(to, text, runtime, stderr, exit);
  } else {
    stdout.write(out);
    if (!out.endsWith("\n")) stdout.write("\n");
  }
  await refreshSnapshotCache(snapshot, runtime);
  await appendTraceEvent({
    type: "snap",
    timestamp: new Date().toISOString(),
    command: "snap",
    args: rest,
    snapshot_after: snapshot,
  });
  exit(0);
}

export function projectSnapshot(snapshot: Snapshot, format: SnapshotFormat): string {
  switch (format) {
    case "md":
      return toMarkdown(snapshot);
    case "json":
      return toJSON(snapshot);
    case "yaml":
      return toYAML(snapshot);
  }
}

export function projectDiff(snapshotDiff: ReturnType<typeof diff>, format: SnapshotFormat): string {
  switch (format) {
    case "md":
      return toDiffMarkdown(snapshotDiff);
    case "json":
      return toDiffJSON(snapshotDiff);
    case "yaml":
      return toDiffYAML(snapshotDiff);
  }
}

async function writeOutputFile(
  path: string,
  data: string,
  runtime: SnapshotRuntime,
  stderr: Pick<typeof process.stderr, "write">,
  exit: (code: number) => never,
): Promise<void> {
  try {
    if (runtime.writeFile) {
      await runtime.writeFile(path, data);
      return;
    }
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, data, "utf8");
  } catch (err) {
    failWith(1, `could not write '${path}': ${(err as Error).message}`, stderr, exit);
  }
}

async function refreshSnapshotCache(snapshot: Snapshot, runtime: SnapshotRuntime): Promise<void> {
  const warning = await (runtime.writeSnapshotCache ?? writeSnapshotCache)(snapshot);
  if (warning !== null) {
    (runtime.stderr ?? process.stderr).write(`brna: warning: snapshot cache write failed: ${warning}\n`);
  }
}

function failWith(
  code: number,
  reason: string,
  stderr: Pick<typeof process.stderr, "write">,
  exit: (code: number) => never,
): never {
  stderr.write(`brna: ${reason}\n`);
  exit(code);
}
