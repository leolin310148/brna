import { BrnaSelectorParseError, validateSnapshot } from "@brna/schema";
import type { SelectorAST, Snapshot } from "@brna/schema";
import { parseSelector, resolve } from "@brna/core";
import {
  DEFAULT_METRO_URL,
  DEVICE_HEADER,
  diagnoseMetroResponse,
  failWith,
  normalizeMetroUrl,
} from "./options.js";

export const DEFAULT_WAIT_TIMEOUT_MS = 30000;
export const DEFAULT_WAIT_INTERVAL_MS = 500;
export const MIN_WAIT_INTERVAL_MS = 100;

class WaitUsageError extends Error {
  constructor(readonly reason: string) {
    super(reason);
  }
}

function parseUrlValue(value: string | undefined): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new WaitUsageError("missing value for '--metro'");
  }
  try {
    return normalizeMetroUrl(value);
  } catch {
    throw new WaitUsageError(`malformed URL for '--metro': ${value}`);
  }
}

function parsePositive(value: string | undefined, flag: string): number {
  if (typeof value !== "string") throw new WaitUsageError(`missing value for '${flag}'`);
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0) {
    throw new WaitUsageError(`'${flag}' must be a positive integer, got '${value}'`);
  }
  return n;
}

function parseDeviceValue(value: string | undefined): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new WaitUsageError("missing value for '--device'");
  }
  return value;
}

interface WaitArgs {
  selector: string;
  selectorAst: SelectorAST;
  metro: string;
  timeoutMs: number;
  intervalMs: number;
  gone: boolean;
  device?: string;
}

interface WaitRuntime {
  fetch?: typeof fetch;
  stdout?: Pick<typeof process.stdout, "write">;
  stderr?: Pick<typeof process.stderr, "write">;
  exit?: (code: number) => never;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

function parseArgs(rest: string[]): WaitArgs {
  let selector: string | undefined;
  let metro = DEFAULT_METRO_URL;
  let timeoutMs = DEFAULT_WAIT_TIMEOUT_MS;
  let intervalMs = DEFAULT_WAIT_INTERVAL_MS;
  let gone = false;
  let device: string | undefined;

  for (let i = 0; i < rest.length; i++) {
    const token = rest[i]!;
    if (token === "--metro") metro = parseUrlValue(rest[++i]);
    else if (token === "--timeout") timeoutMs = parsePositive(rest[++i], "--timeout");
    else if (token === "--interval") {
      const value = parsePositive(rest[++i], "--interval");
      if (value < MIN_WAIT_INTERVAL_MS) {
        throw new WaitUsageError(`'--interval' must be at least ${MIN_WAIT_INTERVAL_MS}ms, got '${value}'`);
      }
      intervalMs = value;
    } else if (token === "--gone") gone = true;
    else if (token === "--device") device = parseDeviceValue(rest[++i]);
    else if (token.startsWith("--")) throw new WaitUsageError(`unknown flag '${token}'`);
    else if (selector === undefined) selector = token;
    else throw new WaitUsageError(`unexpected argument '${token}'`);
  }

  if (selector === undefined || selector.length === 0) {
    throw new WaitUsageError("usage: brna wait <selector> [--gone] [--timeout <ms>] [--interval <ms>] [--metro <url>] [--device <id>]");
  }

  let selectorAst: SelectorAST;
  try {
    selectorAst = parseSelector(selector);
  } catch (err) {
    if (err instanceof BrnaSelectorParseError) {
      throw new WaitUsageError(`malformed selector: ${err.message}`);
    }
    throw new WaitUsageError(`malformed selector '${selector}'`);
  }

  const args: WaitArgs = { selector, selectorAst, metro, timeoutMs, intervalMs, gone };
  if (device !== undefined) args.device = device;
  return args;
}

export async function runWait(rest: string[], runtime: WaitRuntime = {}): Promise<void> {
  const fetchImpl = runtime.fetch ?? fetch;
  const stderr = runtime.stderr ?? process.stderr;
  const exit = runtime.exit ?? process.exit;
  const now = runtime.now ?? Date.now;
  const sleep = runtime.sleep ?? defaultSleep;
  let args: WaitArgs;
  try {
    args = parseArgs(rest);
  } catch (err) {
    if (err instanceof WaitUsageError) {
      failWith(4, err.reason, stderr, exit);
    }
    throw err;
  }

  const deadline = now() + args.timeoutMs;
  const headers: Record<string, string> = {};
  if (args.device !== undefined) headers[DEVICE_HEADER] = args.device;
  const url = `${args.metro}/brna/snapshot`;

  while (true) {
    const remaining = deadline - now();
    if (remaining <= 0) {
      failWith(2, `wait timed out after ${args.timeoutMs}ms`, stderr, exit);
    }
    const requestTimeout = Math.min(remaining, args.timeoutMs);
    const result = await fetchSnapshot(url, headers, requestTimeout, fetchImpl);
    if (result.kind === "connect_error") {
      failWith(1, `could not connect to Metro at ${args.metro}`, stderr, exit);
    }
    if (result.kind === "no_runtime") {
      failWith(3, "no runtime connected — start the app first", stderr, exit);
    }
    if (result.kind === "unknown_device") {
      failWith(3, `unknown device '${args.device ?? "?"}' — run 'brna devices' to list connected runtimes`, stderr, exit);
    }
    if (result.kind === "runtime_error") {
      failWith(3, result.message, stderr, exit);
    }
    if (result.kind === "snapshot") {
      const matched = matches(args.selectorAst, result.snapshot, args.gone);
      if (matched) exit(0);
    }
    const sleepFor = Math.min(args.intervalMs, Math.max(0, deadline - now()));
    if (sleepFor <= 0) {
      failWith(2, `wait timed out after ${args.timeoutMs}ms`, stderr, exit);
    }
    await sleep(sleepFor);
  }
}

type FetchResult =
  | { kind: "snapshot"; snapshot: Snapshot }
  | { kind: "connect_error" }
  | { kind: "no_runtime" }
  | { kind: "unknown_device" }
  | { kind: "runtime_error"; message: string };

async function fetchSnapshot(
  url: string,
  headers: Record<string, string>,
  timeoutMs: number,
  fetchImpl: typeof fetch,
): Promise<FetchResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let response: Response;
  try {
    response = await fetchImpl(url, { signal: controller.signal, headers });
  } catch {
    return { kind: "connect_error" };
  } finally {
    clearTimeout(timer);
  }
  if (response.status === 503) return { kind: "no_runtime" };
  if (response.status === 404) return { kind: "unknown_device" };
  if (response.status === 504) return { kind: "runtime_error", message: "runtime timed out" };
  if (response.status === 429) {
    // request-in-flight collisions just trigger the next polling tick
    return { kind: "runtime_error", message: "another snapshot request is in flight" };
  }
  if (response.status === 502) {
    let body: { code?: string; message?: string } = {};
    try {
      body = (await response.json()) as { code?: string; message?: string };
    } catch {
      /* ignore */
    }
    return {
      kind: "runtime_error",
      message: `runtime error: ${body.code ?? "unknown"} — ${body.message ?? "no message"}`,
    };
  }
  if (!response.ok) {
    const diagnosis = await diagnoseMetroResponse(response, "snapshot endpoint");
    return {
      kind: "runtime_error",
      message: diagnosis ?? `unexpected HTTP ${response.status} from Metro`,
    };
  }
  let snapshot: Snapshot;
  try {
    snapshot = (await response.json()) as Snapshot;
  } catch (err) {
    return { kind: "runtime_error", message: `malformed JSON in snapshot response: ${(err as Error).message}` };
  }
  try {
    validateSnapshot(snapshot);
  } catch (err) {
    return { kind: "runtime_error", message: `invalid snapshot received — ${(err as Error).message}` };
  }
  return { kind: "snapshot", snapshot };
}

function matches(ast: SelectorAST, snapshot: Snapshot, wantGone: boolean): boolean {
  const result = resolve(ast, snapshot);
  if (wantGone) return "none" in result;
  return "ok" in result;
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}
