import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { basename, join } from "node:path";
import { diff, fromCanonicalYAML, toCanonicalYAML } from "@brna/core";
import { validateSnapshot, type Snapshot } from "@brna/schema";
import { loadConfig, sessionDirFromConfig } from "./config.js";
import { getSessionId } from "./session.js";
import { DEFAULT_METRO_URL, DEFAULT_TIMEOUT_MS, DEVICE_HEADER, fail, parseDevice, parseMetro, parseTimeout } from "./options.js";

interface TraceEvent {
  type: "act" | "snap";
  timestamp: string;
  command: string;
  args: string[];
  snapshot_before?: Snapshot;
  snapshot_after?: Snapshot;
  diff?: unknown;
}

interface TraceFile {
  metadata: {
    version: "brna-trace/1";
    started_at: string;
    session_id: string;
    stopped_at?: string;
  };
  events: TraceEvent[];
}

interface ReplayRuntime {
  fetch?: typeof fetch;
  runAct?: (args: string[], runtime?: { exit?: (code: number) => never }) => Promise<void>;
  fail?: (code: number, reason: string) => never;
}

export async function runTrace(rest: string[]): Promise<void> {
  const sub = rest[0];
  if (sub === "start") return traceStart(rest.slice(1));
  if (sub === "stop") return traceStop(rest.slice(1));
  if (sub === "status") return traceStatus(rest.slice(1));
  if (sub === "path") return tracePath(rest.slice(1));
  if (sub === "replay") return traceReplay(rest.slice(1));
  fail(4, "usage: brna trace <start|stop|status|path|replay>");
}

export async function appendTraceEvent(event: TraceEvent): Promise<void> {
  const active = await readActivePath();
  if (!active) return;
  const trace = await readTrace(active);
  trace.events.push(event);
  await writeFile(active, toCanonicalYAML(trace), "utf8");
}

export async function activeTracePath(): Promise<string | null> {
  return readActivePath();
}

async function traceStart(rest: string[]): Promise<void> {
  if (rest.length > 0) fail(4, `unexpected argument '${rest[0]}'`);
  const dir = await configuredSessionDir();
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const tracePath = join(dir, `trace-${getSessionId()}-${Date.now()}.yaml`);
  const trace: TraceFile = {
    metadata: {
      version: "brna-trace/1",
      started_at: new Date().toISOString(),
      session_id: getSessionId(),
    },
    events: [],
  };
  await writeFile(tracePath, toCanonicalYAML(trace), "utf8");
  await writeFile(activeMarkerPath(dir), tracePath, "utf8");
  process.stdout.write(`${tracePath}\n`);
  process.exit(0);
}

async function traceStop(rest: string[]): Promise<void> {
  if (rest.length > 0) fail(4, `unexpected argument '${rest[0]}'`);
  const active = await readActiveMarker();
  if (!active) fail(4, "no active trace");
  const { marker, tracePath } = active;
  const trace = await readTrace(tracePath);
  trace.metadata.stopped_at = new Date().toISOString();
  await writeFile(tracePath, toCanonicalYAML(trace), "utf8");
  await rm(marker, { force: true });
  process.stdout.write(`${tracePath}\n`);
  process.exit(0);
}

async function traceStatus(rest: string[]): Promise<void> {
  if (rest.length > 0) fail(4, `unexpected argument '${rest[0]}'`);
  const active = await readActiveMarker();
  if (!active) {
    process.stdout.write("no active trace\n");
    process.exit(0);
  }
  process.stdout.write(`active ${active.tracePath}\n`);
  process.exit(0);
}

async function tracePath(rest: string[]): Promise<void> {
  if (rest.length > 0) fail(4, `unexpected argument '${rest[0]}'`);
  const active = await readActiveMarker();
  if (!active) fail(4, "no active trace");
  process.stdout.write(`${active.tracePath}\n`);
  process.exit(0);
}

async function traceReplay(rest: string[]): Promise<void> {
  const path = rest[0];
  if (typeof path !== "string" || path.length === 0) fail(4, "usage: brna trace replay <path>");
  if (rest.length > 1) fail(4, `unexpected argument '${rest[1]}'`);
  await replayTraceFile(path);
  process.exit(0);
}

export async function replayTraceFile(path: string, runtime: ReplayRuntime = {}): Promise<void> {
  const trace = await readTrace(path);
  for (const event of trace.events) {
    if (event.snapshot_before) {
      await validateRecordedSnapshot(event, event.snapshot_before, "before", runtime);
    }
    if (event.type === "act") {
      const runActImpl = runtime.runAct ?? (await import("./act.js")).runAct;
      try {
        await runActImpl(event.args, {
          exit: (code) => {
            if (code === 0) throw new ReplayContinue();
            process.exit(code);
          },
        });
      } catch (err) {
        if (!(err instanceof ReplayContinue)) throw err;
      }
    }
    if (event.snapshot_after) {
      await validateRecordedSnapshot(event, event.snapshot_after, "after", runtime);
    }
  }
}

async function validateRecordedSnapshot(
  event: TraceEvent,
  recorded: Snapshot,
  label: "before" | "after",
  runtime: ReplayRuntime,
): Promise<void> {
  const failReplay = runtime.fail ?? fail;
  const current = await fetchReplaySnapshot(event.args, runtime.fetch ?? fetch, failReplay);
  const snapshotDiff = diff(recorded, current);
  if (snapshotDiff.events.length > 0) {
    failReplay(6, `trace replay ${label}-snapshot mismatch for ${event.command} event (${snapshotDiff.events.length} diff event(s))`);
  }
}

async function fetchReplaySnapshot(
  args: string[],
  fetchImpl: typeof fetch,
  failReplay: (code: number, reason: string) => never,
): Promise<Snapshot> {
  const { metro, timeoutMs, device } = replaySnapshotOptions(args);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const headers: Record<string, string> = {};
  if (device !== undefined) headers[DEVICE_HEADER] = device;
  let response: Response;
  try {
    response = await fetchImpl(`${metro}/brna/snapshot`, { signal: controller.signal, headers });
  } catch (err) {
    clearTimeout(timer);
    const e = err as { name?: string };
    if (e?.name === "AbortError") failReplay(6, `trace replay snapshot timed out after ${timeoutMs}ms`);
    failReplay(1, `could not connect to Metro at ${metro}`);
  }
  clearTimeout(timer);
  if (!response.ok) failReplay(6, `unexpected HTTP ${response.status} fetching trace replay snapshot`);

  let snapshot: Snapshot;
  try {
    snapshot = (await response.json()) as Snapshot;
  } catch (err) {
    failReplay(6, `malformed trace replay snapshot: ${(err as Error).message}`);
  }
  try {
    validateSnapshot(snapshot);
  } catch (err) {
    failReplay(6, `invalid trace replay snapshot: ${(err as Error).message}`);
  }
  return snapshot;
}

function replaySnapshotOptions(args: string[]): { metro: string; timeoutMs: number; device?: string } {
  let metro = DEFAULT_METRO_URL;
  let timeoutMs = DEFAULT_TIMEOUT_MS;
  let device: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const token = args[i]!;
    if (token === "--metro") {
      metro = parseMetro(args[++i]);
    } else if (token === "--timeout") {
      timeoutMs = parseTimeout(args[++i]);
    } else if (token === "--device") {
      device = parseDevice(args[++i]);
    }
  }
  return device === undefined ? { metro, timeoutMs } : { metro, timeoutMs, device };
}

async function readTrace(path: string): Promise<TraceFile> {
  const parsed = fromCanonicalYAML(await readFile(path, "utf8")) as TraceFile;
  if (!parsed || !Array.isArray(parsed.events) || !parsed.metadata) {
    fail(4, `invalid trace '${basename(path)}'`);
  }
  return parsed;
}

async function readActivePath(): Promise<string | null> {
  return (await readActiveMarker())?.tracePath ?? null;
}

async function readActiveMarker(): Promise<{ marker: string; tracePath: string } | null> {
  const dir = await configuredSessionDir();
  for (const marker of [activeMarkerPath(dir), legacyActiveMarkerPath(dir)]) {
    if (!existsSync(marker)) continue;
    const tracePath = (await readFile(marker, "utf8")).trim();
    if (tracePath.length > 0) return { marker, tracePath };
  }
  return null;
}

async function configuredSessionDir(): Promise<string> {
  return sessionDirFromConfig((await loadConfig()).config);
}

function activeMarkerPath(dir: string): string {
  return join(dir, ".active-current");
}

function legacyActiveMarkerPath(dir: string): string {
  return join(dir, `.active-${getSessionId()}`);
}

class ReplayContinue extends Error {}
