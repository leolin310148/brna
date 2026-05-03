import {
  validateSnapshot,
  BrnaSelectorParseError,
  type ActionRequest,
  type ScrollDirection,
  type Snapshot,
  type Node,
} from "@brna/schema";
import { diff, filterDiffByTarget, resolve, parseSelector } from "@brna/core";
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
  parsePositiveInt,
} from "./options.js";
import { activeTracePath, appendTraceEvent } from "./trace.js";

const VERBS = ["tap", "click", "long-press", "type", "scroll", "key"] as const;
type Verb = (typeof VERBS)[number];

const SCROLL_DIRECTIONS = new Set<string>(["up", "down", "left", "right"]);
const SUPPORTED_KEYS = new Set<string>(["tab"]);

const DEFAULT_LONG_PRESS_MS = 500;

interface SharedFlags {
  metro: string;
  timeoutMs: number;
  device?: string;
  exit?: (code: number) => never;
  commandArgs?: string[];
  snapshotBefore?: Snapshot;
  targetId?: string;
}

export async function runAct(rest: string[], runtime: { exit?: (code: number) => never } = {}): Promise<void> {
  if (rest.length === 0) {
    fail(4, `usage: brna act <verb> [args] [--metro <url>] [--timeout <ms>]`);
  }
  const verbToken = rest[0]!;
  if (!(VERBS as readonly string[]).includes(verbToken)) {
    fail(4, `unsupported action '${verbToken}'`);
  }
  const verb = verbToken as Verb;
  const args = rest.slice(1);

  // Pull --metro/--timeout out of args before verb-specific positional parsing.
  const { positional, shared } = extractSharedFlags(args);
  if (runtime.exit) shared.exit = runtime.exit;
  shared.commandArgs = rest;

  switch (verb) {
    case "tap":
      return runTargetedSelector(verb, positional, shared, (selector, target_id) => ({
        kind: "tap",
        selector,
        target_id,
      }));
    case "click":
      return runTargetedSelector(verb, positional, shared, (selector, target_id) => ({
        kind: "tap", // alias: click is normalized to tap on the wire
        selector,
        target_id,
      }));
    case "long-press": {
      const { selector, durationMs } = parseLongPressArgs(positional);
      return runWithSelector(selector, shared, (resolvedId) => ({
        kind: "long_press",
        selector,
        target_id: resolvedId,
        duration_ms: durationMs,
      }));
    }
    case "type": {
      const { selector, text } = parseTypeArgs(positional);
      return runWithSelector(selector, shared, (resolvedId) => ({
        kind: "type",
        selector,
        target_id: resolvedId,
        text,
      }));
    }
    case "scroll": {
      const { selector, direction, by } = parseScrollArgs(positional);
      return runWithSelector(selector, shared, (resolvedId) => {
        const action: ActionRequest = {
          kind: "scroll",
          selector,
          target_id: resolvedId,
          direction,
        };
        if (by !== undefined) action.by = by;
        return action;
      });
    }
    case "key":
      return runKey(positional, shared);
  }
}

function extractSharedFlags(args: string[]): { positional: string[]; shared: SharedFlags } {
  const positional: string[] = [];
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
    } else if (token === "--duration" || token === "--by" || token === "--direction") {
      // verb-specific flags — keep them in positional order so the verb
      // parser can consume the flag/value pair.
      positional.push(token, args[++i] ?? "");
    } else {
      positional.push(token);
    }
  }
  const shared: SharedFlags = { metro, timeoutMs };
  if (device !== undefined) shared.device = device;
  return { positional, shared };
}

async function runTargetedSelector(
  verb: Verb,
  positional: string[],
  shared: SharedFlags,
  build: (selector: string, target_id: string) => ActionRequest,
): Promise<void> {
  const selector = positional[0];
  if (typeof selector !== "string" || selector.length === 0) {
    fail(4, `missing selector for act ${verb}`);
  }
  if (positional.length > 1) {
    fail(4, `unexpected argument '${positional[1]}'`);
  }
  return runWithSelector(selector, shared, (resolvedId) => build(selector, resolvedId));
}

function parseLongPressArgs(positional: string[]): { selector: string; durationMs: number } {
  const selector = positional[0];
  if (typeof selector !== "string" || selector.length === 0) {
    fail(4, "missing selector for act long-press");
  }
  let durationMs = DEFAULT_LONG_PRESS_MS;
  for (let i = 1; i < positional.length; i++) {
    const token = positional[i]!;
    if (token === "--duration") {
      durationMs = parsePositiveInt(positional[++i], "--duration");
    } else {
      fail(4, `unexpected argument '${token}'`);
    }
  }
  return { selector, durationMs };
}

function parseTypeArgs(positional: string[]): { selector: string; text: string } {
  const selector = positional[0];
  if (typeof selector !== "string" || selector.length === 0) {
    fail(4, "missing selector for act type");
  }
  const text = positional[1];
  if (typeof text !== "string") {
    fail(4, "missing text for act type");
  }
  if (positional.length > 2) {
    fail(4, `unexpected argument '${positional[2]}'`);
  }
  return { selector, text };
}

function parseScrollArgs(positional: string[]): {
  selector: string;
  direction: ScrollDirection;
  by?: number;
} {
  const selector = positional[0];
  if (typeof selector !== "string" || selector.length === 0) {
    fail(4, "missing selector for act scroll");
  }
  let direction: ScrollDirection | undefined;
  let by: number | undefined;
  for (let i = 1; i < positional.length; i++) {
    const token = positional[i]!;
    if (token === "--direction") {
      const value = positional[++i];
      if (typeof value !== "string" || value.length === 0) {
        fail(4, "missing value for '--direction'");
      }
      if (!SCROLL_DIRECTIONS.has(value)) {
        fail(4, `unsupported scroll direction '${value}' (expected up|down|left|right)`);
      }
      direction = value as ScrollDirection;
    } else if (token === "--by") {
      by = parsePositiveInt(positional[++i], "--by");
    } else {
      fail(4, `unexpected argument '${token}'`);
    }
  }
  if (!direction) fail(4, "missing --direction for act scroll");
  return by === undefined ? { selector, direction } : { selector, direction, by };
}

async function runKey(positional: string[], shared: SharedFlags): Promise<void> {
  const key = positional[0];
  if (typeof key !== "string" || key.length === 0) {
    fail(4, "missing key for act key");
  }
  if (!SUPPORTED_KEYS.has(key)) {
    fail(4, `unsupported key '${key}' (expected tab)`);
  }
  if (positional.length > 1) {
    fail(4, `unexpected argument '${positional[1]}'`);
  }
  if (await activeTracePath()) {
    shared.snapshotBefore = await fetchSnapshot(shared);
  }
  await postAction(shared, { kind: "key", key: "tab" });
}

async function runWithSelector(
  selector: string,
  shared: SharedFlags,
  build: (resolvedId: string) => ActionRequest,
): Promise<void> {
  // Validate selector grammar early so a parse error becomes a usage exit
  // instead of a snapshot fetch + resolve mismatch.
  try {
    parseSelector(selector);
  } catch (err) {
    if (err instanceof BrnaSelectorParseError) {
      fail(4, `malformed selector: ${err.message}`);
    }
    fail(4, `malformed selector '${selector}'`);
  }

  const snapshot = await fetchSnapshot(shared);
  shared.snapshotBefore = snapshot;
  const result = resolve(selector, snapshot);
  if ("none" in result) {
    fail(2, `selector not found: ${selector}`);
  }
  if ("ambiguous" in result) {
    const ids = result.ambiguous.map((n: Node) => n.id);
    fail(3, `selector '${selector}' is ambiguous: ${ids.join(", ")}`);
  }
  shared.targetId = result.ok.id;
  await postAction(shared, build(result.ok.id));
}

async function fetchSnapshot(shared: SharedFlags): Promise<Snapshot> {
  const url = `${shared.metro}/brna/snapshot`;
  const headers: Record<string, string> = {};
  if (shared.device !== undefined) headers[DEVICE_HEADER] = shared.device;
  let response: Response;
  try {
    response = await fetchWithInFlightRetry((signal) => fetch(url, { signal, headers }), shared.timeoutMs);
  } catch (err) {
    const e = err as { name?: string };
    if (e?.name === "AbortError") {
      fail(6, `pre-action snapshot timed out after ${shared.timeoutMs}ms`);
    }
    fail(1, `could not connect to Metro at ${shared.metro}`);
  }

  if (response.status === 503) fail(6, "no runtime connected");
  if (response.status === 404) fail(6, `unknown device '${shared.device ?? "?"}'`);
  if (response.status === 504) fail(6, "runtime timed out fetching pre-action snapshot");
  if (response.status === 502) fail(6, "runtime error fetching pre-action snapshot");
  if (response.status === 429) fail(6, "another request is in flight; retry this brna command after the previous command finishes");
  if (!response.ok) {
    const diagnosis = await diagnoseMetroResponse(response, "snapshot endpoint");
    fail(
      6,
      diagnosis ?? `unexpected HTTP ${response.status} fetching pre-action snapshot`,
    );
  }

  const diagnosis = await diagnoseMetroResponse(response, "snapshot endpoint");
  let snapshot: Snapshot;
  try {
    snapshot = (await response.json()) as Snapshot;
  } catch (err) {
    fail(
      6,
      diagnosis ?? `malformed pre-action snapshot: ${(err as Error).message}`,
    );
  }
  try {
    validateSnapshot(snapshot);
  } catch (err) {
    fail(6, `invalid pre-action snapshot: ${(err as Error).message}`);
  }
  return snapshot;
}

async function postAction(shared: SharedFlags, action: ActionRequest): Promise<void> {
  const url = `${shared.metro}/brna/action`;
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (shared.device !== undefined) headers[DEVICE_HEADER] = shared.device;
  let response: Response;
  try {
    response = await fetchWithInFlightRetry(
      (signal) =>
        fetch(url, {
          method: "POST",
          headers,
          body: JSON.stringify(action),
          signal,
        }),
      shared.timeoutMs,
    );
  } catch (err) {
    const e = err as { name?: string };
    if (e?.name === "AbortError") fail(6, `action timed out after ${shared.timeoutMs}ms`);
    fail(1, `could not connect to Metro at ${shared.metro}`);
  }

  if (response.status === 204) {
    const snapshotAfter = (await activeTracePath()) ? await fetchSnapshot(shared) : undefined;
    let recordedDiff: ReturnType<typeof diff> | undefined;
    if (shared.snapshotBefore && snapshotAfter) {
      const full = diff(shared.snapshotBefore, snapshotAfter);
      recordedDiff =
        shared.targetId !== undefined
          ? filterDiffByTarget(shared.snapshotBefore, snapshotAfter, full, shared.targetId)
          : full;
    }
    await appendTraceEvent({
      type: "act",
      timestamp: new Date().toISOString(),
      command: "act",
      args: shared.commandArgs ?? [],
      snapshot_before: shared.snapshotBefore,
      snapshot_after: snapshotAfter,
      ...(recordedDiff ? { diff: recordedDiff } : {}),
    });
    (shared.exit ?? process.exit)(0);
  }
  if (response.status === 503) fail(6, "no runtime connected");
  if (response.status === 404) fail(6, `unknown device '${shared.device ?? "?"}'`);
  if (response.status === 504) fail(6, "runtime timed out");
  if (response.status === 429) fail(6, "another request is in flight; retry this brna command after the previous command finishes");
  if (response.status === 400) {
    let body: { message?: string } = {};
    try {
      body = (await response.json()) as { message?: string };
    } catch {
      /* ignore */
    }
    fail(6, `Metro rejected action body: ${body.message ?? "malformed"}`);
  }
  if (response.status === 502) {
    let body: { code?: string; message?: string } = {};
    try {
      body = (await response.json()) as { code?: string; message?: string };
    } catch {
      fail(6, "malformed runtime error response");
    }
    fail(5, `action refused: ${body.code ?? "unknown"}`);
  }
  const diagnosis = await diagnoseMetroResponse(response, "action endpoint");
  fail(6, diagnosis ?? `unexpected HTTP ${response.status} from Metro`);
}
