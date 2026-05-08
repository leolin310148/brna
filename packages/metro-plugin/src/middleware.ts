import type { IncomingMessage, ServerResponse } from "node:http";
import type {
  LogsRequestOptions,
  NetworkRequestOptions,
  SnapshotRedactionOptions,
} from "@brna/schema";
import {
  parseLogsRequestOptions,
  parseNetworkRequestOptions,
  validateActionRequest,
  BrnaValidationError,
} from "@brna/schema";
import {
  ACTION_TIMEOUT_MS,
  OBSERVABILITY_TIMEOUT_MS,
  getBridge,
  SNAPSHOT_TIMEOUT_MS,
  type BrnaBridge,
} from "./bridge.js";

type NextFn = (err?: unknown) => void;
type Middleware = (req: IncomingMessage, res: ServerResponse, next: NextFn) => void;

const SNAPSHOT_PATH = "/brna/snapshot";
const ACTION_PATH = "/brna/action";
const DEVICES_PATH = "/brna/devices";
const LOGS_PATH = "/brna/logs";
const NETWORK_PATH = "/brna/network";
const DEVICE_HEADER = "x-brna-device-id";
const MAX_JSON_BODY_BYTES = 64 * 1024;

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json");
  res.setHeader("Content-Length", Buffer.byteLength(text).toString());
  res.end(text);
}

function sendEmpty(res: ServerResponse, status: number): void {
  res.statusCode = status;
  res.setHeader("Content-Length", "0");
  res.end();
}

function readDeviceHeader(req: IncomingMessage): string | undefined {
  const raw = req.headers[DEVICE_HEADER];
  if (typeof raw === "string" && raw.length > 0) return raw;
  if (Array.isArray(raw) && raw.length > 0 && typeof raw[0] === "string" && raw[0].length > 0) {
    return raw[0];
  }
  return undefined;
}

function matchesPath(url: string, path: string): boolean {
  return url === path || url.startsWith(`${path}?`);
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let aborted = false;
    req.on("data", (chunk: Buffer) => {
      if (aborted) return;
      total += chunk.length;
      if (total > MAX_JSON_BODY_BYTES) {
        aborted = true;
        reject(new Error("body_too_large"));
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (aborted) return;
      const raw = Buffer.concat(chunks).toString("utf8");
      try {
        resolve(JSON.parse(raw));
      } catch (err) {
        reject(err);
      }
    });
    req.on("error", reject);
  });
}

function isBodyTooLargeError(err: unknown): boolean {
  return err instanceof Error && err.message === "body_too_large";
}

function sendBodyTooLarge(res: ServerResponse): void {
  sendJson(res, 413, { error: "request_body_too_large", max_bytes: MAX_JSON_BODY_BYTES });
}

export function handleSnapshot(
  bridge: BrnaBridge,
  res: ServerResponse,
  deviceId?: string,
  options: { redaction?: SnapshotRedactionOptions; measureTimeoutMs?: number } = {},
): void {
  if (!bridge.hasRuntime()) {
    sendJson(res, 503, { error: "no_runtime_connected" });
    return;
  }
  if (deviceId !== undefined && !bridge.hasRuntime(deviceId)) {
    sendJson(res, 404, { error: "unknown_device", device_id: deviceId });
    return;
  }
  if (!bridge.acquireSlot()) {
    sendJson(res, 429, { error: "request_in_flight" });
    return;
  }
  bridge
    .requestSnapshot(deviceId, options)
    .then((result) => {
      bridge.releaseSlot();
      if (result.kind === "snapshot") {
        sendJson(res, 200, result.snapshot);
        return;
      }
      if (result.kind === "timeout") {
        sendJson(res, 504, { error: "runtime_timeout", timeout_ms: SNAPSHOT_TIMEOUT_MS });
        return;
      }
      if (result.kind === "unknown_device") {
        sendJson(res, 404, { error: "unknown_device", device_id: result.device_id });
        return;
      }
      sendJson(res, 502, {
        error: "runtime_error",
        code: result.code,
        message: result.message,
      });
    })
    .catch((err: Error) => {
      bridge.releaseSlot();
      if (err.message === "no_runtime_connected") {
        sendJson(res, 503, { error: "no_runtime_connected" });
      } else {
        sendJson(res, 500, { error: "internal", message: err.message });
      }
    });
}

export async function handleSnapshotPost(
  bridge: BrnaBridge,
  req: IncomingMessage,
  res: ServerResponse,
  deviceId?: string,
): Promise<void> {
  let parsed: unknown;
  try {
    parsed = await readJsonBody(req);
  } catch (err) {
    if (isBodyTooLargeError(err)) {
      sendBodyTooLarge(res);
      return;
    }
    sendJson(res, 400, { error: "malformed_snapshot_request" });
    return;
  }
  const redaction = readRedactionOptions(parsed);
  const measureTimeoutMs = readMeasureTimeoutMs(parsed);
  handleSnapshot(bridge, res, deviceId, {
    ...(redaction ? { redaction } : {}),
    ...(measureTimeoutMs !== undefined ? { measureTimeoutMs } : {}),
  });
}

function readRedactionOptions(value: unknown): SnapshotRedactionOptions | undefined {
  if (!value || typeof value !== "object") return undefined;
  const redaction = (value as { redaction?: unknown }).redaction;
  if (!redaction || typeof redaction !== "object") return undefined;
  return redaction as SnapshotRedactionOptions;
}

function readMeasureTimeoutMs(value: unknown): number | undefined {
  if (!value || typeof value !== "object") return undefined;
  const measureTimeoutMs = (value as { measureTimeoutMs?: unknown }).measureTimeoutMs;
  if (typeof measureTimeoutMs !== "number" || !Number.isFinite(measureTimeoutMs) || measureTimeoutMs <= 0) {
    return undefined;
  }
  return measureTimeoutMs;
}

export async function handleAction(
  bridge: BrnaBridge,
  req: IncomingMessage,
  res: ServerResponse,
  deviceId?: string,
): Promise<void> {
  let parsed: unknown;
  try {
    parsed = await readJsonBody(req);
  } catch (err) {
    if (isBodyTooLargeError(err)) {
      sendBodyTooLarge(res);
      return;
    }
    sendJson(res, 400, { error: "malformed_action_request" });
    return;
  }
  let action;
  try {
    action = validateActionRequest(parsed);
  } catch (err) {
    if (err instanceof BrnaValidationError) {
      sendJson(res, 400, { error: "malformed_action_request", message: err.message });
    } else {
      sendJson(res, 400, { error: "malformed_action_request" });
    }
    return;
  }

  if (!bridge.hasRuntime()) {
    sendJson(res, 503, { error: "no_runtime_connected" });
    return;
  }
  if (deviceId !== undefined && !bridge.hasRuntime(deviceId)) {
    sendJson(res, 404, { error: "unknown_device", device_id: deviceId });
    return;
  }
  if (!bridge.acquireSlot()) {
    sendJson(res, 429, { error: "request_in_flight" });
    return;
  }

  try {
    const result = await bridge.requestAction(action, deviceId);
    bridge.releaseSlot();
    if (result.kind === "ok") {
      sendEmpty(res, 204);
      return;
    }
    if (result.kind === "timeout") {
      sendJson(res, 504, { error: "runtime_timeout", timeout_ms: ACTION_TIMEOUT_MS });
      return;
    }
    if (result.kind === "unknown_device") {
      sendJson(res, 404, { error: "unknown_device", device_id: result.device_id });
      return;
    }
    sendJson(res, 502, {
      error: "runtime_error",
      code: result.code,
      message: result.message,
    });
  } catch (err) {
    bridge.releaseSlot();
    if ((err as Error).message === "no_runtime_connected") {
      sendJson(res, 503, { error: "no_runtime_connected" });
    } else {
      sendJson(res, 500, { error: "internal", message: (err as Error).message });
    }
  }
}

function parseLogsQuery(url: string): LogsRequestOptions {
  const idx = url.indexOf("?");
  if (idx < 0) return {};
  const params = new URLSearchParams(url.slice(idx + 1));
  const out: Record<string, unknown> = {};
  const since = readNumericQueryParam(params, "since");
  if (since !== undefined) out.since = since;
  const level = params.get("level");
  if (level) out.level = level;
  const limit = readNumericQueryParam(params, "limit");
  if (limit !== undefined) out.limit = limit;
  return parseLogsRequestOptions(out);
}

function parseNetworkQuery(url: string): NetworkRequestOptions {
  const idx = url.indexOf("?");
  if (idx < 0) return {};
  const params = new URLSearchParams(url.slice(idx + 1));
  const out: Record<string, unknown> = {};
  const since = readNumericQueryParam(params, "since");
  if (since !== undefined) out.since = since;
  const method = params.get("method");
  if (method) out.method = method;
  const status = readNumericQueryParam(params, "status");
  if (status !== undefined) out.status = status;
  const statusMin = readNumericQueryParam(params, "statusMin");
  if (statusMin !== undefined) out.statusMin = statusMin;
  const statusMax = readNumericQueryParam(params, "statusMax");
  if (statusMax !== undefined) out.statusMax = statusMax;
  const limit = readNumericQueryParam(params, "limit");
  if (limit !== undefined) out.limit = limit;
  return parseNetworkRequestOptions(out);
}

function readNumericQueryParam(params: URLSearchParams, name: string): number | undefined {
  const raw = params.get(name);
  if (raw === null) return undefined;
  const trimmed = raw.trim();
  if (trimmed.length === 0) return undefined;
  const value = Number(trimmed);
  return Number.isFinite(value) ? value : undefined;
}

async function readObservabilityOptions(
  req: IncomingMessage,
): Promise<
  | { kind: "ok"; body: unknown }
  | { kind: "malformed" }
  | { kind: "too_large" }
> {
  if (hasEmptyObservabilityBody(req)) return { kind: "ok", body: undefined };
  try {
    return { kind: "ok", body: await readJsonBody(req) };
  } catch (err) {
    if (isBodyTooLargeError(err)) return { kind: "too_large" };
    return { kind: "malformed" };
  }
}

function hasEmptyObservabilityBody(req: IncomingMessage): boolean {
  const contentLength = req.headers["content-length"];
  if (contentLength === "0" || (Array.isArray(contentLength) && contentLength[0] === "0")) {
    return true;
  }
  const transferEncoding = req.headers["transfer-encoding"];
  return contentLength === undefined && transferEncoding === undefined;
}

export async function handleLogs(
  bridge: BrnaBridge,
  req: IncomingMessage,
  res: ServerResponse,
  deviceId?: string,
): Promise<void> {
  if (!bridge.hasRuntime()) {
    sendJson(res, 503, { error: "no_runtime_connected" });
    return;
  }
  if (deviceId !== undefined && !bridge.hasRuntime(deviceId)) {
    sendJson(res, 404, { error: "unknown_device", device_id: deviceId });
    return;
  }
  let options: LogsRequestOptions;
  if (req.method === "POST") {
    const body = await readObservabilityOptions(req);
    if (body.kind === "too_large") {
      sendBodyTooLarge(res);
      return;
    }
    if (body.kind === "malformed") {
      sendJson(res, 400, { error: "malformed_logs_request" });
      return;
    }
    options = parseLogsRequestOptions(body.body);
  } else {
    options = parseLogsQuery(req.url ?? "");
  }
  try {
    const result = await bridge.requestLogs(options, deviceId);
    if (result.kind === "ok") {
      sendJson(res, 200, { records: result.records });
      return;
    }
    if (result.kind === "timeout") {
      sendJson(res, 504, { error: "runtime_timeout", timeout_ms: OBSERVABILITY_TIMEOUT_MS });
      return;
    }
    if (result.kind === "unknown_device") {
      sendJson(res, 404, { error: "unknown_device", device_id: result.device_id });
      return;
    }
    sendJson(res, 502, {
      error: "runtime_error",
      code: result.code,
      message: result.message,
    });
  } catch (err) {
    if ((err as Error).message === "no_runtime_connected") {
      sendJson(res, 503, { error: "no_runtime_connected" });
    } else {
      sendJson(res, 500, { error: "internal", message: (err as Error).message });
    }
  }
}

export async function handleNetwork(
  bridge: BrnaBridge,
  req: IncomingMessage,
  res: ServerResponse,
  deviceId?: string,
): Promise<void> {
  if (!bridge.hasRuntime()) {
    sendJson(res, 503, { error: "no_runtime_connected" });
    return;
  }
  if (deviceId !== undefined && !bridge.hasRuntime(deviceId)) {
    sendJson(res, 404, { error: "unknown_device", device_id: deviceId });
    return;
  }
  let options: NetworkRequestOptions;
  if (req.method === "POST") {
    const body = await readObservabilityOptions(req);
    if (body.kind === "too_large") {
      sendBodyTooLarge(res);
      return;
    }
    if (body.kind === "malformed") {
      sendJson(res, 400, { error: "malformed_network_request" });
      return;
    }
    options = parseNetworkRequestOptions(body.body);
  } else {
    options = parseNetworkQuery(req.url ?? "");
  }
  try {
    const result = await bridge.requestNetwork(options, deviceId);
    if (result.kind === "ok") {
      sendJson(res, 200, { records: result.records });
      return;
    }
    if (result.kind === "timeout") {
      sendJson(res, 504, { error: "runtime_timeout", timeout_ms: OBSERVABILITY_TIMEOUT_MS });
      return;
    }
    if (result.kind === "unknown_device") {
      sendJson(res, 404, { error: "unknown_device", device_id: result.device_id });
      return;
    }
    sendJson(res, 502, {
      error: "runtime_error",
      code: result.code,
      message: result.message,
    });
  } catch (err) {
    if ((err as Error).message === "no_runtime_connected") {
      sendJson(res, 503, { error: "no_runtime_connected" });
    } else {
      sendJson(res, 500, { error: "internal", message: (err as Error).message });
    }
  }
}

export function handleDevices(bridge: BrnaBridge, res: ServerResponse): void {
  sendJson(res, 200, {
    devices: bridge.listDevices(),
    recent_disconnected: bridge.listRecentDisconnectedDevices(),
  });
}

export function brnaMiddleware(): Middleware {
  return (req, res, next) => {
    // Latch onto the underlying HTTP server for WS upgrades on EVERY request.
    // Metro's plugin API does not hand us the http.Server, but req.socket.server
    // is the same instance — so the first request (typically Metro's own status
    // ping or bundle fetch) is what installs the upgrade listener before the
    // app's runtime tries to connect.
    const httpServer = (req.socket as { server?: object }).server;
    if (httpServer) {
      getBridge().attachUpgrade(httpServer as Parameters<ReturnType<typeof getBridge>["attachUpgrade"]>[0]);
    }

    const url = req.url ?? "";
    const bridge = getBridge();
    const deviceId = readDeviceHeader(req);

    if (req.method === "GET" && matchesPath(url, DEVICES_PATH)) {
      handleDevices(bridge, res);
      return;
    }
    if (req.method === "GET" && matchesPath(url, SNAPSHOT_PATH)) {
      handleSnapshot(bridge, res, deviceId);
      return;
    }
    if (req.method === "POST" && matchesPath(url, SNAPSHOT_PATH)) {
      void handleSnapshotPost(bridge, req, res, deviceId);
      return;
    }
    if (req.method === "POST" && matchesPath(url, ACTION_PATH)) {
      void handleAction(bridge, req, res, deviceId);
      return;
    }
    if ((req.method === "GET" || req.method === "POST") && matchesPath(url, LOGS_PATH)) {
      void handleLogs(bridge, req, res, deviceId);
      return;
    }
    if ((req.method === "GET" || req.method === "POST") && matchesPath(url, NETWORK_PATH)) {
      void handleNetwork(bridge, req, res, deviceId);
      return;
    }
    next();
  };
}
