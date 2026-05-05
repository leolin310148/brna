import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { BrnaSelectorParseError, validateSnapshot } from "@brna/schema";
import type { Node, SelectorAST, Snapshot, SnapshotDiff } from "@brna/schema";
import {
  diff,
  filterDiffByTarget,
  parseSelector,
  resolve,
  toDiffJSON,
  toDiffMarkdown,
  toDiffYAML,
  toActiveLayerMarkdown,
  toMarkdown,
  toJSON,
  toYAML,
} from "@brna/core";
import {
  DEFAULT_METRO_URL,
  DEFAULT_TIMEOUT_MS,
  DEVICE_HEADER,
  diagnoseMetroResponse,
  fail,
  fetchWithInFlightRetry,
  parseDevice,
  parseMetro,
  parseTimeout,
} from "./options.js";
import { readSnapshotCache, snapshotSessionId, writeSnapshotCache } from "./session.js";
import { loadConfig, measureTimeoutFromConfig, toRedactionOptions } from "./config.js";
import { appendTraceEvent } from "./trace.js";
import { runCapture, type NativePlatform, type SpawnNative } from "./capture.js";

export type SnapshotFormat = "md" | "json" | "yaml";
const VALID_FORMATS = new Set<string>(["md", "markdown", "json", "yaml"]);

interface ParsedArgs {
  metro: string;
  timeoutMs: number;
  format: SnapshotFormat;
  diff: boolean;
  activeLayer: boolean;
  image: boolean;
  device?: string;
  to?: string;
  imageTo?: string;
  overlay?: boolean;
  nativeDevice?: string;
  nativePlatform?: NativePlatform;
  target?: string;
  targetAst?: SelectorAST;
}

interface SnapshotRuntime {
  fetch?: typeof fetch;
  readSnapshotCache?: typeof readSnapshotCache;
  writeSnapshotCache?: typeof writeSnapshotCache;
  stdout?: Pick<typeof process.stdout, "write">;
  stderr?: Pick<typeof process.stderr, "write">;
  exit?: (code: number) => never;
  writeFile?: (path: string, data: string) => Promise<void>;
  writeCaptureFile?: (path: string, data: Buffer) => Promise<void>;
  spawnNative?: SpawnNative;
}

function parseArgs(rest: string[]): ParsedArgs {
  let metro = DEFAULT_METRO_URL;
  let timeoutMs = DEFAULT_TIMEOUT_MS;
  let format: SnapshotFormat = "md";
  let wantsDiff = false;
  let activeLayer = false;
  let image = false;
  let device: string | undefined;
  let to: string | undefined;
  let imageTo: string | undefined;
  let overlay = false;
  let nativeDevice: string | undefined;
  let nativePlatform: NativePlatform | undefined;
  let target: string | undefined;

  for (let i = 0; i < rest.length; i++) {
    const token = rest[i]!;
    if (token === "--metro") {
      metro = parseMetro(rest[++i]);
    } else if (token === "--timeout") {
      timeoutMs = parseTimeout(rest[++i]);
    } else if (token === "--format") {
      const value = rest[++i];
      if (typeof value !== "string" || !VALID_FORMATS.has(value)) {
        fail(4, `unknown --format value '${value ?? ""}' (expected md|markdown|json|yaml)`);
      }
      format = value === "markdown" ? "md" : value as SnapshotFormat;
    } else if (token === "--diff") {
      wantsDiff = true;
    } else if (token === "--active-layer") {
      activeLayer = true;
    } else if (token === "--image") {
      image = true;
    } else if (token === "--image-to") {
      const value = rest[++i];
      if (typeof value !== "string" || value.length === 0) {
        fail(4, "missing value for '--image-to'");
      }
      imageTo = value;
    } else if (token === "--overlay") {
      overlay = true;
    } else if (token === "--device") {
      device = parseDevice(rest[++i]);
    } else if (token === "--native-device") {
      const value = rest[++i];
      if (typeof value !== "string" || value.length === 0) {
        fail(4, "missing value for '--native-device'");
      }
      nativeDevice = value;
    } else if (token === "--native-platform") {
      const value = rest[++i];
      if (value !== "android" && value !== "ios") {
        fail(4, `'--native-platform' must be 'android' or 'ios', got '${value ?? ""}'`);
      }
      nativePlatform = value;
    } else if (token === "--to") {
      const value = rest[++i];
      if (typeof value !== "string" || value.length === 0) {
        fail(4, "missing value for '--to'");
      }
      to = value;
    } else if (token === "--target") {
      const value = rest[++i];
      if (typeof value !== "string" || value.length === 0) {
        fail(4, "missing value for '--target'");
      }
      target = value;
    } else {
      fail(4, `unknown flag '${token}'`);
    }
  }

  if (activeLayer && format !== "md") {
    fail(4, "--active-layer requires markdown output (omit --format or use --format md)");
  }
  if (activeLayer && wantsDiff) {
    fail(4, "--active-layer cannot be combined with --diff");
  }
  if (image !== (imageTo !== undefined)) {
    fail(4, "--image and --image-to must be supplied together");
  }
  if (!image && (overlay || nativeDevice !== undefined || nativePlatform !== undefined)) {
    fail(4, "--overlay, --native-device, and --native-platform require --image");
  }

  const result: ParsedArgs = { metro, timeoutMs, format, diff: wantsDiff, activeLayer, image };
  if (device !== undefined) result.device = device;
  if (to !== undefined) result.to = to;
  if (imageTo !== undefined) result.imageTo = imageTo;
  if (overlay) result.overlay = overlay;
  if (nativeDevice !== undefined) result.nativeDevice = nativeDevice;
  if (nativePlatform !== undefined) result.nativePlatform = nativePlatform;
  if (target !== undefined) {
    if (!wantsDiff) {
      fail(4, "--target requires --diff");
    }
    try {
      result.targetAst = parseSelector(target);
    } catch (err) {
      if (err instanceof BrnaSelectorParseError) {
        fail(4, `malformed --target selector: ${err.message}`);
      }
      fail(4, `malformed --target selector '${target}'`);
    }
    result.target = target;
  }
  return result;
}

export async function runSnapshot(rest: string[], runtime: SnapshotRuntime = {}): Promise<void> {
  const parsed = parseArgs(rest);
  const {
    metro,
    timeoutMs,
    format,
    diff: wantsDiff,
    activeLayer,
    device,
    to,
    image,
    imageTo,
    overlay,
    nativeDevice,
    nativePlatform,
    target,
    targetAst,
  } = parsed;
  const fetchImpl = runtime.fetch ?? fetch;
  const stdout = runtime.stdout ?? process.stdout;
  const stderr = runtime.stderr ?? process.stderr;
  const exit = runtime.exit ?? process.exit;
  const url = `${metro}/brna/snapshot`;
  const config = (await loadConfig()).config;
  const redaction = toRedactionOptions(config);
  let measureTimeoutMs: number | undefined;
  try {
    measureTimeoutMs = measureTimeoutFromConfig(config);
  } catch (err) {
    failWith(4, (err as Error).message, stderr, exit);
  }

  let response: Response;
  const headers: Record<string, string> = {};
  if (device !== undefined) headers[DEVICE_HEADER] = device;
  try {
    const hasRedaction = redaction.rules !== undefined || redaction.redactSecureFields !== undefined;
    const requestOptions = {
      ...(hasRedaction ? { redaction } : {}),
      ...(measureTimeoutMs !== undefined ? { measureTimeoutMs } : {}),
    };
    const hasRequestOptions = Object.keys(requestOptions).length > 0;
    response = await fetchWithInFlightRetry(
      (signal) =>
        fetchImpl(url, {
          method: hasRequestOptions ? "POST" : "GET",
          signal,
          headers: hasRequestOptions ? { ...headers, "Content-Type": "application/json" } : headers,
          ...(hasRequestOptions ? { body: JSON.stringify(requestOptions) } : {}),
        }),
      timeoutMs,
    );
  } catch (err) {
    const e = err as { name?: string };
    if (e?.name === "AbortError") {
      failWith(2, `snapshot timed out after ${timeoutMs}ms`, stderr, exit);
    }
    failWith(1, `could not connect to Metro at ${metro}`, stderr, exit);
  }

  if (response.status === 503) {
    failWith(3, `no runtime connected — start the app first${metro === DEFAULT_METRO_URL ? "" : ` with Metro at ${metro}`}, then run brna devices`, stderr, exit);
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
    failWith(3, "another snapshot request is in flight; retry this brna command after the previous command finishes", stderr, exit);
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
    const cacheSessionId = snapshotSessionId(snapshot);
    const baseline = await (runtime.readSnapshotCache ?? readSnapshotCache)({ sessionId: cacheSessionId });
    if (!baseline) {
      failWith(6, "no baseline snapshot in this session — run brna snapshot first", stderr, exit);
    }
    const fullDiff = diff(baseline, snapshot);
    let projected: SnapshotDiff = fullDiff;
    if (targetAst !== undefined && target !== undefined) {
      const result = resolve(targetAst, snapshot);
      if ("none" in result) {
        failWith(2, `selector not found: ${target}`, stderr, exit);
      }
      if ("ambiguous" in result) {
        const ids = result.ambiguous.map((n: Node) => n.id).join(", ");
        failWith(3, `selector '${target}' is ambiguous: ${ids}`, stderr, exit);
      }
      projected = filterDiffByTarget(baseline, snapshot, fullDiff, result.ok.id);
    }
    const out = projectDiff(projected, format);
    if (to !== undefined) {
      await writeOutputFile(to, out, runtime, stderr, exit);
    } else {
      stdout.write(out);
    }
    await refreshSnapshotCache(snapshot, runtime, cacheSessionId);
    await appendTraceEvent({
      type: "snap",
      timestamp: new Date().toISOString(),
      command: "snap",
      args: rest,
      snapshot_before: baseline,
      snapshot_after: snapshot,
      diff: projected,
    });
    if (image && imageTo !== undefined) {
      await writeSidecarImage(
        { metro, timeoutMs, imageTo, device, overlay, nativeDevice, nativePlatform },
        runtime,
        stderr,
      );
    }
    exit(0);
  }

  const out = activeLayer ? toActiveLayerMarkdown(snapshot) : projectSnapshot(snapshot, format);
  if (to !== undefined) {
    const text = out.endsWith("\n") ? out : `${out}\n`;
    await writeOutputFile(to, text, runtime, stderr, exit);
  } else {
    stdout.write(out);
    if (!out.endsWith("\n")) stdout.write("\n");
  }
  await refreshSnapshotCache(snapshot, runtime, snapshotSessionId(snapshot));
  await appendTraceEvent({
    type: "snap",
    timestamp: new Date().toISOString(),
    command: "snap",
    args: rest,
    snapshot_after: snapshot,
  });
  if (image && imageTo !== undefined) {
    await writeSidecarImage(
      { metro, timeoutMs, imageTo, device, overlay, nativeDevice, nativePlatform },
      runtime,
      stderr,
    );
  }
  exit(0);
}

async function writeSidecarImage(
  opts: {
    metro: string;
    timeoutMs: number;
    imageTo: string;
    device?: string;
    overlay?: boolean;
    nativeDevice?: string;
    nativePlatform?: NativePlatform;
  },
  runtime: SnapshotRuntime,
  stderr: Pick<typeof process.stderr, "write">,
): Promise<void> {
  const captureArgs = [
    "--to",
    opts.imageTo,
    "--metro",
    opts.metro,
    "--timeout",
    String(opts.timeoutMs),
  ];
  if (opts.device !== undefined) captureArgs.push("--device", opts.device);
  if (opts.overlay === true) captureArgs.push("--overlay");
  if (opts.nativeDevice !== undefined) captureArgs.push("--native-device", opts.nativeDevice);
  if (opts.nativePlatform !== undefined) captureArgs.push("--native-platform", opts.nativePlatform);

  let captureStderr = "";
  try {
    await runCapture(captureArgs, {
      fetch: runtime.fetch,
      spawnNative: runtime.spawnNative,
      writeFile: runtime.writeCaptureFile,
      stderr: { write: (chunk: string | Uint8Array) => ((captureStderr += String(chunk)), true) },
      stdout: { write: () => true },
      exit: (code) => {
        throw Object.assign(new Error("capture exit"), { code });
      },
    });
  } catch (err) {
    const code = (err as { code?: unknown }).code;
    if (code === 0) {
      if (captureStderr.length > 0) stderr.write(captureStderr);
      return;
    }
    if (typeof code === "number") {
      stderr.write(`brna: warning: sidecar image capture failed: ${summariseCaptureFailure(captureStderr)}\n`);
      return;
    }
    stderr.write(`brna: warning: sidecar image capture failed: ${(err as Error).message}\n`);
  }
}

function summariseCaptureFailure(stderr: string): string {
  const trimmed = stderr.trim();
  if (!trimmed) return "unknown error";
  const withoutPrefix = trimmed.replace(/^brna:\s*/, "");
  const line = withoutPrefix.split("\n")[0] ?? withoutPrefix;
  return line.slice(0, 240);
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

async function refreshSnapshotCache(
  snapshot: Snapshot,
  runtime: SnapshotRuntime,
  sessionId: string,
): Promise<void> {
  const warning = await (runtime.writeSnapshotCache ?? writeSnapshotCache)(snapshot, { sessionId });
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
