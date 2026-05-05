import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { Snapshot } from "@brna/schema";
import { validateSnapshot } from "@brna/schema";
import {
  DEFAULT_METRO_URL,
  DEFAULT_TIMEOUT_MS,
  DEVICE_HEADER,
  diagnoseMetroResponse,
  fail,
  failWith,
  fetchWithInFlightRetry,
  parseDevice,
  parseMetro,
  parseTimeout,
} from "./options.js";
import { getCacheDir, getSessionId } from "./session.js";
import { renderOverlay, type OverlayInput } from "./overlay.js";

const CAPTURE_FILENAME_PREFIX = "capture";

export interface CaptureRuntime {
  fetch?: typeof fetch;
  stdout?: Pick<typeof process.stdout, "write">;
  stderr?: Pick<typeof process.stderr, "write">;
  exit?: (code: number) => never;
  spawnNative?: SpawnNative;
  writeFile?: (path: string, data: Buffer) => Promise<void>;
  now?: () => Date;
  cacheDir?: string;
}

export type NativePlatform = "android" | "ios";

export interface NativeCaptureCommand {
  platform: NativePlatform;
  bin: string;
  args: string[];
}

export interface SpawnResult {
  status: number | null;
  stdout: Buffer;
  stderr: string;
  spawnError?: NodeJS.ErrnoException;
}

export type SpawnNative = (cmd: NativeCaptureCommand, timeoutMs: number) => Promise<SpawnResult>;

export interface DeviceRecord {
  id: string;
  platform?: string;
  native_device_id?: string;
  device_name?: string;
}

export interface ParsedCaptureArgs {
  metro: string;
  timeoutMs: number;
  overlay: boolean;
  to?: string;
  device?: string;
  nativeDevice?: string;
  nativePlatform?: NativePlatform;
}

export function parseCaptureArgs(rest: string[]): ParsedCaptureArgs {
  let metro = DEFAULT_METRO_URL;
  let timeoutMs = DEFAULT_TIMEOUT_MS;
  let overlay = false;
  let to: string | undefined;
  let device: string | undefined;
  let nativeDevice: string | undefined;
  let nativePlatform: NativePlatform | undefined;

  for (let i = 0; i < rest.length; i++) {
    const token = rest[i]!;
    if (token === "--metro") {
      metro = parseMetro(rest[++i]);
    } else if (token === "--timeout") {
      timeoutMs = parseTimeout(rest[++i]);
    } else if (token === "--overlay") {
      overlay = true;
    } else if (token === "--to") {
      const value = rest[++i];
      if (typeof value !== "string" || value.length === 0) fail(4, "missing value for '--to'");
      to = value;
    } else if (token === "--device") {
      device = parseDevice(rest[++i]);
    } else if (token === "--native-device") {
      const value = rest[++i];
      if (typeof value !== "string" || value.length === 0) fail(4, "missing value for '--native-device'");
      nativeDevice = value;
    } else if (token === "--native-platform") {
      const value = rest[++i];
      if (value !== "android" && value !== "ios") {
        fail(4, `'--native-platform' must be 'android' or 'ios', got '${value ?? ""}'`);
      }
      nativePlatform = value;
    } else {
      fail(4, `unknown flag '${token}'`);
    }
  }

  const result: ParsedCaptureArgs = { metro, timeoutMs, overlay };
  if (to !== undefined) result.to = to;
  if (device !== undefined) result.device = device;
  if (nativeDevice !== undefined) result.nativeDevice = nativeDevice;
  if (nativePlatform !== undefined) result.nativePlatform = nativePlatform;
  return result;
}

export function buildNativeCommand(
  platform: NativePlatform,
  nativeDevice: string | undefined,
): NativeCaptureCommand {
  if (platform === "android") {
    const args = ["exec-out", "screencap", "-p"];
    if (nativeDevice !== undefined && nativeDevice.length > 0) {
      args.unshift("-s", nativeDevice);
    }
    return { platform, bin: "adb", args };
  }
  const target = nativeDevice && nativeDevice.length > 0 ? nativeDevice : "booted";
  return { platform, bin: "xcrun", args: ["simctl", "io", target, "screenshot", "-"] };
}

export function generateOutputPath(opts: {
  cacheDir?: string;
  sessionId?: string;
  now?: Date;
  overlay?: boolean;
}): string {
  const dir = opts.cacheDir ?? getCacheDir({ sessionId: opts.sessionId });
  const stamp = formatStamp(opts.now ?? new Date());
  const suffix = opts.overlay ? ".overlay" : "";
  return join(dir, `${CAPTURE_FILENAME_PREFIX}-${stamp}${suffix}.png`);
}

function formatStamp(d: Date): string {
  const pad = (n: number, w = 2): string => String(n).padStart(w, "0");
  return (
    d.getUTCFullYear().toString() +
    pad(d.getUTCMonth() + 1) +
    pad(d.getUTCDate()) +
    "T" +
    pad(d.getUTCHours()) +
    pad(d.getUTCMinutes()) +
    pad(d.getUTCSeconds()) +
    "Z"
  );
}

export function mapNativeError(
  cmd: NativeCaptureCommand,
  result: SpawnResult,
): { code: number; reason: string } {
  if (result.spawnError) {
    const errno = result.spawnError.code;
    if (errno === "ENOENT") {
      const hint =
        cmd.platform === "android"
          ? "install Android Platform Tools and ensure 'adb' is on PATH"
          : "install Xcode Command Line Tools and ensure 'xcrun' is on PATH";
      return {
        code: 7,
        reason: `'${cmd.bin}' not found — ${hint}`,
      };
    }
    return {
      code: 1,
      reason: `failed to spawn '${cmd.bin}': ${result.spawnError.message}`,
    };
  }
  if (
    cmd.platform === "ios" &&
    result.stdout.length > 0 &&
    isIgnorableSimctlStderr(result.stderr)
  ) {
    return { code: 0, reason: "" };
  }
  if (result.status !== 0) {
    const stderrLine = firstLine(result.stderr) || `exit ${result.status ?? "unknown"}`;
    if (cmd.platform === "android") {
      const lower = result.stderr.toLowerCase();
      if (lower.includes("no devices") || lower.includes("device offline") || lower.includes("error: device") || lower.includes("more than one device")) {
        return {
          code: 8,
          reason: `adb capture failed: ${stderrLine}. Pass '--native-device <serial>' (see 'adb devices').`,
        };
      }
      return { code: 1, reason: `adb capture failed: ${stderrLine}` };
    }
    const lower = result.stderr.toLowerCase();
    if (lower.includes("no devices are booted") || lower.includes("invalid device") || lower.includes("unable to find")) {
      return {
        code: 8,
        reason: `simctl capture failed: ${stderrLine}. Pass '--native-device <udid>' (see 'xcrun simctl list devices booted').`,
      };
    }
    return { code: 1, reason: `simctl capture failed: ${stderrLine}` };
  }
  if (result.stdout.length === 0) {
    return { code: 1, reason: `${cmd.bin} produced empty PNG output` };
  }
  return { code: 0, reason: "" };
}

function isIgnorableSimctlStderr(stderr: string): boolean {
  const lines = stderr
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines.length === 0) return true;
  return lines.every((line) =>
    /^Note: No display specified\. Defaulting to display:/i.test(line),
  );
}

function firstLine(s: string): string {
  const trimmed = s.trim();
  if (!trimmed) return "";
  const idx = trimmed.indexOf("\n");
  return (idx === -1 ? trimmed : trimmed.slice(0, idx)).slice(0, 240);
}

export function pickNativePlatform(args: {
  explicit?: NativePlatform;
  device?: DeviceRecord;
}): NativePlatform | null {
  if (args.explicit) return args.explicit;
  const platform = args.device?.platform;
  if (platform === "android") return "android";
  if (platform === "ios") return "ios";
  return null;
}

export function defaultSpawnNative(): SpawnNative {
  return async (cmd, timeoutMs) => {
    let prepared: PreparedNativeSpawn;
    try {
      prepared = await prepareNativeSpawn(cmd);
    } catch (err) {
      return {
        status: null,
        stdout: Buffer.alloc(0),
        stderr: "",
        spawnError: err as NodeJS.ErrnoException,
      };
    }
    return await new Promise<SpawnResult>((resolve) => {
      let child: ReturnType<typeof spawn>;
      try {
        child = spawn(prepared.bin, prepared.args, { stdio: ["ignore", "pipe", "pipe"] });
      } catch (err) {
        void cleanupPreparedNativeSpawn(prepared);
        resolve({ status: null, stdout: Buffer.alloc(0), stderr: "", spawnError: err as NodeJS.ErrnoException });
        return;
      }
      const stdoutChunks: Buffer[] = [];
      let stderr = "";
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        try {
          child.kill("SIGKILL");
        } catch {
          /* ignore */
        }
      }, timeoutMs);
      child.stdout?.on("data", (chunk: Buffer) => stdoutChunks.push(chunk));
      child.stderr?.on("data", (chunk: Buffer) => {
        stderr += chunk.toString("utf8");
      });
      child.on("error", (err) => {
        clearTimeout(timer);
        void cleanupPreparedNativeSpawn(prepared);
        resolve({ status: null, stdout: Buffer.concat(stdoutChunks), stderr, spawnError: err as NodeJS.ErrnoException });
      });
      child.on("close", async (code) => {
        clearTimeout(timer);
        const stdout = await readPreparedNativeStdout(prepared, stdoutChunks);
        if (timedOut) {
          resolve({ status: code, stdout, stderr: stderr + `\n${cmd.bin} timed out` });
          return;
        }
        resolve({ status: code, stdout, stderr });
      });
    });
  };
}

interface PreparedNativeSpawn {
  bin: string;
  args: string[];
  outputPath?: string;
  tempDir?: string;
}

async function prepareNativeSpawn(cmd: NativeCaptureCommand): Promise<PreparedNativeSpawn> {
  if (cmd.platform !== "ios" || cmd.args[cmd.args.length - 1] !== "-") {
    return { bin: cmd.bin, args: cmd.args };
  }

  // Newer simctl versions can emit display-selection notes on stderr while
  // screenshot-to-file still succeeds. Capture to a temp PNG and read it back
  // so stderr content is not confused with screenshot success.
  const tempDir = await mkdtemp(join(tmpdir(), "brna-simctl-"));
  const outputPath = join(tempDir, "capture.png");
  return {
    bin: cmd.bin,
    args: [...cmd.args.slice(0, -1), outputPath],
    outputPath,
    tempDir,
  };
}

async function readPreparedNativeStdout(
  prepared: PreparedNativeSpawn,
  stdoutChunks: Buffer[],
): Promise<Buffer> {
  try {
    if (prepared.outputPath !== undefined) {
      return await readFile(prepared.outputPath);
    }
    return Buffer.concat(stdoutChunks);
  } catch {
    return Buffer.concat(stdoutChunks);
  } finally {
    await cleanupPreparedNativeSpawn(prepared);
  }
}

async function cleanupPreparedNativeSpawn(prepared: PreparedNativeSpawn): Promise<void> {
  if (prepared.tempDir === undefined) return;
  try {
    await rm(prepared.tempDir, { recursive: true, force: true });
  } catch {
    /* ignore cleanup failures */
  }
}

export async function runCapture(rest: string[], runtime: CaptureRuntime = {}): Promise<void> {
  const parsed = parseCaptureArgs(rest);
  const stdout = runtime.stdout ?? process.stdout;
  const stderr = runtime.stderr ?? process.stderr;
  const exit = runtime.exit ?? process.exit;
  const fetchImpl = runtime.fetch ?? fetch;
  const spawnNative = runtime.spawnNative ?? defaultSpawnNative();
  const writeFn = runtime.writeFile ?? (async (path: string, data: Buffer) => {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, data);
  });

  let deviceRecord: DeviceRecord | undefined;
  if (parsed.device !== undefined || parsed.overlay || parsed.nativePlatform === undefined) {
    const fetched = await fetchDeviceRecord({
      metro: parsed.metro,
      timeoutMs: parsed.timeoutMs,
      device: parsed.device,
      fetchImpl,
    });
    if (fetched.error) {
      // Soft failure: metro may not be running. Only fatal when --device was
      // explicitly passed or when overlay is requested.
      if (parsed.device !== undefined) {
        failWith(fetched.error.code, fetched.error.reason, stderr, exit);
      }
      if (parsed.overlay) {
        failWith(fetched.error.code, fetched.error.reason, stderr, exit);
      }
    } else {
      deviceRecord = fetched.device;
    }
  }

  const platform = pickNativePlatform({
    ...(parsed.nativePlatform !== undefined ? { explicit: parsed.nativePlatform } : {}),
    ...(deviceRecord !== undefined ? { device: deviceRecord } : {}),
  });
  if (platform === null) {
    failWith(
      4,
      "could not determine native platform — pass '--native-platform android|ios' or '--device <id>' so the runtime platform is known",
      stderr,
      exit,
    );
  }

  let nativeDevice = parsed.nativeDevice ?? deviceRecord?.native_device_id;
  if (parsed.nativeDevice === undefined && nativeDevice === undefined && deviceRecord) {
    nativeDevice = await resolveSingleNativeDevice(platform, spawnNative, parsed.timeoutMs);
  }
  if (parsed.nativeDevice === undefined && deviceRecord && nativeDevice === undefined) {
    // best-effort mapping unavailable; emit a soft hint to stderr but still try
    // platform defaults (booted simulator / lone adb device).
    stderr.write(
      `brna: warning: runtime device '${deviceRecord.id}' did not advertise a native device id — falling back to ${
        platform === "android" ? "the default 'adb' target" : "the booted simulator"
      }. Pass '--native-device <id>' to override.\n`,
    );
  }

  const cmd = buildNativeCommand(platform, nativeDevice);
  const result = await spawnNative(cmd, parsed.timeoutMs);
  const mapped = mapNativeError(cmd, result);
  if (mapped.code !== 0) {
    failWith(mapped.code, mapped.reason, stderr, exit);
  }

  let pngBytes: Buffer = result.stdout;

  if (parsed.overlay) {
    const snapshot = await fetchSnapshot({
      metro: parsed.metro,
      timeoutMs: parsed.timeoutMs,
      device: parsed.device,
      fetchImpl,
      stderr,
      exit,
    });
    const overlayInput: OverlayInput = {
      png: pngBytes,
      snapshot,
    };
    try {
      pngBytes = renderOverlay(overlayInput);
    } catch (err) {
      failWith(1, `overlay rendering failed: ${(err as Error).message}`, stderr, exit);
    }
  }

  const outPath = parsed.to ?? generateOutputPath({
    ...(runtime.cacheDir !== undefined ? { cacheDir: runtime.cacheDir } : {}),
    sessionId: getSessionId(),
    ...(runtime.now !== undefined ? { now: runtime.now() } : {}),
    overlay: parsed.overlay,
  });

  try {
    await writeFn(outPath, pngBytes);
  } catch (err) {
    failWith(1, `could not write '${outPath}': ${(err as Error).message}`, stderr, exit);
  }

  if (parsed.to === undefined) {
    stdout.write(`${outPath}\n`);
  }
  exit(0);
}

export async function resolveSingleNativeDevice(
  platform: NativePlatform,
  spawnNative: SpawnNative,
  timeoutMs: number,
): Promise<string | undefined> {
  if (platform === "android") {
    const result = await spawnNative({ platform, bin: "adb", args: ["devices"] }, timeoutMs);
    if (result.status !== 0 || result.spawnError) return undefined;
    return parseSingleAdbDevice(result.stdout.toString("utf8"));
  }

  const result = await spawnNative(
    { platform, bin: "xcrun", args: ["simctl", "list", "devices", "booted", "--json"] },
    timeoutMs,
  );
  if (result.status !== 0 || result.spawnError) return undefined;
  return parseSingleBootedSimulator(result.stdout.toString("utf8"));
}

export function parseSingleAdbDevice(text: string): string | undefined {
  const serials = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.toLowerCase().startsWith("list of devices"))
    .map((line) => line.split(/\s+/))
    .filter((cols) => cols[1] === "device")
    .map((cols) => cols[0]!)
    .filter((serial) => serial.length > 0);
  return serials.length === 1 ? serials[0] : undefined;
}

export function parseSingleBootedSimulator(text: string): string | undefined {
  let payload: unknown;
  try {
    payload = JSON.parse(text);
  } catch {
    return undefined;
  }
  const devices = (payload as { devices?: unknown }).devices;
  if (!devices || typeof devices !== "object") return undefined;
  const udids: string[] = [];
  for (const list of Object.values(devices as Record<string, unknown>)) {
    if (!Array.isArray(list)) continue;
    for (const item of list) {
      if (!item || typeof item !== "object") continue;
      const d = item as { state?: unknown; udid?: unknown; isAvailable?: unknown; availabilityError?: unknown };
      const available = d.isAvailable !== false && d.availabilityError === undefined;
      if (d.state === "Booted" && typeof d.udid === "string" && d.udid.length > 0 && available) {
        udids.push(d.udid);
      }
    }
  }
  return udids.length === 1 ? udids[0] : undefined;
}

interface FetchedDevice {
  device?: DeviceRecord;
  error?: { code: number; reason: string };
}

async function fetchDeviceRecord(opts: {
  metro: string;
  timeoutMs: number;
  device?: string;
  fetchImpl: typeof fetch;
}): Promise<FetchedDevice> {
  const url = `${opts.metro}/brna/devices`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs);
  let response: Response;
  try {
    response = await opts.fetchImpl(url, { signal: controller.signal });
  } catch (err) {
    clearTimeout(timer);
    const e = err as { name?: string };
    if (e?.name === "AbortError") {
      return { error: { code: 2, reason: `devices request timed out after ${opts.timeoutMs}ms` } };
    }
    return { error: { code: 1, reason: `could not connect to Metro at ${opts.metro}` } };
  }
  clearTimeout(timer);
  if (!response.ok) {
    const diag = await diagnoseMetroResponse(response, "devices endpoint");
    return { error: { code: 3, reason: diag ?? `unexpected HTTP ${response.status} from Metro` } };
  }
  let payload: { devices?: DeviceRecord[] };
  try {
    payload = (await response.json()) as { devices?: DeviceRecord[] };
  } catch (err) {
    return { error: { code: 3, reason: `malformed devices response: ${(err as Error).message}` } };
  }
  const devices = Array.isArray(payload.devices) ? payload.devices : [];
  if (opts.device !== undefined) {
    const match = devices.find((d) => d.id === opts.device);
    if (!match) {
      return {
        error: {
          code: 3,
          reason: `unknown device '${opts.device}' — run 'brna devices' to list connected runtimes`,
        },
      };
    }
    return { device: match };
  }
  if (devices.length === 0) return {};
  // Use the most-recently-registered device (last in payload order, matching
  // the snapshot/act selection convention).
  const last = devices[devices.length - 1]!;
  return { device: last };
}

async function fetchSnapshot(opts: {
  metro: string;
  timeoutMs: number;
  device?: string;
  fetchImpl: typeof fetch;
  stderr: Pick<typeof process.stderr, "write">;
  exit: (code: number) => never;
}): Promise<Snapshot> {
  const url = `${opts.metro}/brna/snapshot`;
  const headers: Record<string, string> = {};
  if (opts.device !== undefined) headers[DEVICE_HEADER] = opts.device;
  let response: Response;
  try {
    response = await fetchWithInFlightRetry(
      (signal) => opts.fetchImpl(url, { method: "GET", signal, headers }),
      opts.timeoutMs,
    );
  } catch (err) {
    const e = err as { name?: string };
    if (e?.name === "AbortError") {
      failWith(2, `overlay snapshot timed out after ${opts.timeoutMs}ms`, opts.stderr, opts.exit);
    }
    failWith(1, `could not connect to Metro at ${opts.metro} for overlay snapshot`, opts.stderr, opts.exit);
  }
  if (response.status === 503) {
    failWith(3, "no runtime connected — start the app first", opts.stderr, opts.exit);
  }
  if (!response.ok) {
    const diag = await diagnoseMetroResponse(response, "overlay snapshot");
    failWith(3, diag ?? `overlay snapshot returned HTTP ${response.status}`, opts.stderr, opts.exit);
  }
  let snapshot: Snapshot;
  try {
    snapshot = (await response.json()) as Snapshot;
  } catch (err) {
    failWith(3, `malformed overlay snapshot JSON: ${(err as Error).message}`, opts.stderr, opts.exit);
  }
  try {
    validateSnapshot(snapshot);
  } catch (err) {
    failWith(3, `invalid overlay snapshot — ${(err as Error).message}`, opts.stderr, opts.exit);
  }
  return snapshot;
}
