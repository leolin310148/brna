import type {
  LogLevel,
  LogRecord,
  LogsRequestOptions,
  NetworkHeaderEntry,
  NetworkRecord,
  NetworkRequestOptions,
} from "@brna/schema";
import { logLevelRank } from "@brna/schema";
import { redactLogRecord, redactNetworkRecord } from "./observability-redact.js";

const INSTALLED_KEY = "__brnaObservabilityInstalled" as const;
const DEFAULT_LOG_CAPACITY = 200;
const DEFAULT_NETWORK_CAPACITY = 100;
const DEFAULT_BODY_PREVIEW_BYTES = 4 * 1024;

interface RingBufferOptions {
  capacity: number;
}

export class RingBuffer<T> {
  private items: T[] = [];
  private capacity: number;

  constructor(opts: RingBufferOptions) {
    this.capacity = Math.max(1, Math.floor(opts.capacity));
  }

  push(item: T): void {
    this.items.push(item);
    if (this.items.length > this.capacity) {
      this.items.splice(0, this.items.length - this.capacity);
    }
  }

  toArray(): T[] {
    return this.items.slice();
  }

  size(): number {
    return this.items.length;
  }

  clear(): void {
    this.items = [];
  }
}

interface ObservabilityState {
  logs: RingBuffer<LogRecord>;
  network: RingBuffer<NetworkRecord>;
  nextLogId: number;
  nextNetworkId: number;
  capturedAt: number;
  bodyPreviewBytes: number;
  uninstall?: () => void;
}

let state: ObservabilityState | null = null;

export interface InstallObservabilityOptions {
  logCapacity?: number;
  networkCapacity?: number;
  bodyPreviewBytes?: number;
  /** Override globalThis (used in tests). */
  globalObject?: Record<string, unknown> & { console?: Console };
}

export function installObservability(opts: InstallObservabilityOptions = {}): void {
  const g = (opts.globalObject ?? (globalThis as unknown)) as Record<string, unknown> & {
    console?: Console;
  };
  if ((g as Record<string, unknown>)[INSTALLED_KEY] === true) return;
  (g as Record<string, unknown>)[INSTALLED_KEY] = true;

  const installed: ObservabilityState = {
    logs: new RingBuffer<LogRecord>({ capacity: opts.logCapacity ?? DEFAULT_LOG_CAPACITY }),
    network: new RingBuffer<NetworkRecord>({
      capacity: opts.networkCapacity ?? DEFAULT_NETWORK_CAPACITY,
    }),
    nextLogId: 0,
    nextNetworkId: 0,
    capturedAt: Date.now(),
    bodyPreviewBytes: opts.bodyPreviewBytes ?? DEFAULT_BODY_PREVIEW_BYTES,
  };
  state = installed;

  const uninstallers: Array<() => void> = [];
  uninstallers.push(installConsole(g, installed));
  uninstallers.push(installErrorHandler(g, installed));
  uninstallers.push(installFetch(g, installed));
  uninstallers.push(installXhr(g, installed));

  installed.uninstall = () => {
    for (const fn of uninstallers) {
      try {
        fn();
      } catch {
        /* ignore */
      }
    }
    (g as Record<string, unknown>)[INSTALLED_KEY] = false;
    if (state === installed) state = null;
  };
}

export function uninstallObservability(): void {
  state?.uninstall?.();
}

export function resetObservabilityForTest(): void {
  state?.uninstall?.();
  state = null;
}

export function getLogs(options: LogsRequestOptions = {}): LogRecord[] {
  if (!state) return [];
  let records = state.logs.toArray();
  if (typeof options.since === "number") {
    records = records.filter((r) => r.timestamp >= options.since!);
  }
  if (options.level) {
    const min = logLevelRank(options.level);
    records = records.filter((r) => logLevelRank(r.level) >= min);
  }
  if (typeof options.limit === "number") {
    records = records.slice(-options.limit);
  }
  if (options.redaction) {
    return records.map((r) => redactLogRecord(r, options.redaction));
  }
  return records.map((r) => redactLogRecord(r, {}));
}

export function getNetwork(options: NetworkRequestOptions = {}): NetworkRecord[] {
  if (!state) return [];
  let records = state.network.toArray();
  if (typeof options.since === "number") {
    records = records.filter((r) => r.timestamp >= options.since!);
  }
  if (options.method) {
    const m = options.method.toUpperCase();
    records = records.filter((r) => r.method.toUpperCase() === m);
  }
  if (typeof options.status === "number") {
    records = records.filter((r) => r.status === options.status);
  }
  if (typeof options.statusMin === "number") {
    records = records.filter((r) => typeof r.status === "number" && r.status >= options.statusMin!);
  }
  if (typeof options.statusMax === "number") {
    records = records.filter((r) => typeof r.status === "number" && r.status <= options.statusMax!);
  }
  if (typeof options.limit === "number") {
    records = records.slice(-options.limit);
  }
  return records.map((r) => redactNetworkRecord(r, options.redaction ?? {}));
}

function nextLogId(s: ObservabilityState): string {
  s.nextLogId += 1;
  return `log-${s.nextLogId}`;
}

function nextNetworkId(s: ObservabilityState): string {
  s.nextNetworkId += 1;
  return `net-${s.nextNetworkId}`;
}

function installConsole(
  g: Record<string, unknown> & { console?: Console },
  s: ObservabilityState,
): () => void {
  const console = g.console;
  if (!console) return () => {};
  const methods: Array<{ name: keyof Console; level: LogLevel }> = [
    { name: "debug", level: "debug" },
    { name: "log", level: "log" },
    { name: "info", level: "info" },
    { name: "warn", level: "warn" },
    { name: "error", level: "error" },
  ];
  const originals: Array<{ name: keyof Console; original: unknown }> = [];
  for (const { name, level } of methods) {
    const original = (console as unknown as Record<string, unknown>)[name as string];
    if (typeof original !== "function") continue;
    originals.push({ name, original });
    const wrapped = function (this: unknown, ...args: unknown[]): void {
      try {
        const record: LogRecord = {
          id: nextLogId(s),
          timestamp: Date.now(),
          level,
          message: formatConsoleMessage(args),
          source: "console",
        };
        if (args.length > 0) {
          const safeArgs = safeJsonValues(args);
          if (safeArgs !== undefined) record.args = safeArgs;
        }
        s.logs.push(record);
      } catch {
        /* never throw from instrumentation */
      }
      try {
        (original as (...a: unknown[]) => unknown).apply(this, args);
      } catch {
        /* preserve original behavior even on errors */
      }
    };
    Object.defineProperty(wrapped, "__brnaWrapped", { value: true });
    (console as unknown as Record<string, unknown>)[name as string] = wrapped;
  }
  return () => {
    for (const { name, original } of originals) {
      (console as unknown as Record<string, unknown>)[name as string] = original;
    }
  };
}

function installErrorHandler(
  g: Record<string, unknown> & { ErrorUtils?: unknown },
  s: ObservabilityState,
): () => void {
  const utils = (g as { ErrorUtils?: { getGlobalHandler?: () => unknown; setGlobalHandler?: (h: unknown) => void } }).ErrorUtils;
  if (!utils || typeof utils.setGlobalHandler !== "function") return () => {};
  const previous = typeof utils.getGlobalHandler === "function" ? utils.getGlobalHandler() : undefined;
  const handler = (error: unknown, isFatal?: boolean): void => {
    try {
      const err = error as { message?: unknown; stack?: unknown; name?: unknown };
      const message = typeof err?.message === "string" ? err.message : String(error);
      const name = typeof err?.name === "string" ? err.name : "Error";
      const record: LogRecord = {
        id: nextLogId(s),
        timestamp: Date.now(),
        level: "error",
        message: `${name}: ${message}${isFatal ? " (fatal)" : ""}`,
        source: "error",
      };
      if (typeof err?.stack === "string") record.stack = err.stack;
      s.logs.push(record);
    } catch {
      /* ignore */
    }
    if (typeof previous === "function") {
      try {
        (previous as (e: unknown, f?: boolean) => void)(error, isFatal);
      } catch {
        /* ignore */
      }
    }
  };
  utils.setGlobalHandler(handler);
  return () => {
    if (typeof utils.setGlobalHandler === "function") {
      utils.setGlobalHandler(previous);
    }
  };
}

function installFetch(
  g: Record<string, unknown>,
  s: ObservabilityState,
): () => void {
  const original = g.fetch;
  if (typeof original !== "function") return () => {};
  const wrapped = function (this: unknown, input: unknown, init?: unknown): Promise<unknown> {
    const startedAt = Date.now();
    const id = nextNetworkId(s);
    const method = readFetchMethod(input, init);
    const url = readFetchUrl(input);
    const headers = readFetchHeaders(input, init);
    let bodyPreview: string | undefined;
    try {
      bodyPreview = readFetchBodyPreview(init, s.bodyPreviewBytes);
    } catch {
      /* ignore */
    }
    const partial: NetworkRecord = {
      id,
      timestamp: startedAt,
      method,
      url,
      state: "started",
      source: "fetch",
    };
    if (headers) partial.request_headers = headers;
    if (bodyPreview !== undefined) partial.request_body_preview = bodyPreview;
    s.network.push(partial);

    let result: Promise<unknown>;
    try {
      result = (original as (i: unknown, n?: unknown) => Promise<unknown>).call(this, input, init);
    } catch (err) {
      finalizeFetch(partial, undefined, err, startedAt);
      throw err;
    }
    return result.then(
      (response) => {
        finalizeFetch(partial, response, undefined, startedAt, s.bodyPreviewBytes);
        return response;
      },
      (err) => {
        finalizeFetch(partial, undefined, err, startedAt);
        throw err;
      },
    );
  };
  Object.defineProperty(wrapped, "__brnaWrapped", { value: true });
  g.fetch = wrapped;
  return () => {
    if (g.fetch === wrapped) g.fetch = original;
  };
}

function finalizeFetch(
  record: NetworkRecord,
  response: unknown,
  error: unknown,
  startedAt: number,
  bodyPreviewBytes?: number,
): void {
  record.duration_ms = Date.now() - startedAt;
  if (error) {
    record.state = "errored";
    record.error_message = (error as { message?: string })?.message ?? String(error);
    return;
  }
  record.state = "completed";
  const res = response as {
    status?: unknown;
    statusText?: unknown;
    headers?: { forEach?: (cb: (value: string, key: string) => void) => void };
    clone?: () => { text: () => Promise<string> };
  };
  if (typeof res?.status === "number") record.status = res.status;
  if (typeof res?.statusText === "string") record.status_text = res.statusText;
  const headers = readResponseHeaders(res?.headers);
  if (headers) record.response_headers = headers;
  // Fire-and-forget body capture; ignore failures.
  if (bodyPreviewBytes !== undefined && typeof res?.clone === "function") {
    try {
      const cloned = res.clone();
      cloned
        .text()
        .then((text) => {
          if (typeof text === "string" && text.length > 0) {
            record.response_body_preview = text.slice(0, bodyPreviewBytes);
          }
        })
        .catch(() => {
          /* ignore body read errors */
        });
    } catch {
      /* ignore */
    }
  }
}

function readFetchMethod(input: unknown, init?: unknown): string {
  const initMethod = (init as { method?: unknown })?.method;
  if (typeof initMethod === "string" && initMethod.length > 0) return initMethod.toUpperCase();
  const requestMethod = (input as { method?: unknown })?.method;
  if (typeof requestMethod === "string" && requestMethod.length > 0) return requestMethod.toUpperCase();
  return "GET";
}

function readFetchUrl(input: unknown): string {
  if (typeof input === "string") return input;
  const u = (input as { url?: unknown })?.url;
  if (typeof u === "string") return u;
  try {
    return String(input);
  } catch {
    return "<unknown>";
  }
}

function readFetchHeaders(input: unknown, init?: unknown): NetworkHeaderEntry[] | undefined {
  const initHeaders = (init as { headers?: unknown })?.headers;
  const requestHeaders = (input as { headers?: unknown })?.headers;
  return collectHeaders(initHeaders) ?? collectHeaders(requestHeaders);
}

function collectHeaders(value: unknown): NetworkHeaderEntry[] | undefined {
  if (!value) return undefined;
  const out: NetworkHeaderEntry[] = [];
  const obj = value as { forEach?: (cb: (v: string, k: string) => void) => void };
  if (typeof obj.forEach === "function") {
    obj.forEach((v, k) => out.push({ name: k, value: typeof v === "string" ? v : String(v) }));
    return out.length > 0 ? out : undefined;
  }
  if (Array.isArray(value)) {
    for (const entry of value) {
      if (Array.isArray(entry) && entry.length >= 2) {
        out.push({ name: String(entry[0]), value: String(entry[1]) });
      }
    }
    return out.length > 0 ? out : undefined;
  }
  if (typeof value === "object") {
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out.push({ name: k, value: typeof v === "string" ? v : String(v) });
    }
    return out.length > 0 ? out : undefined;
  }
  return undefined;
}

function readResponseHeaders(headers: unknown): NetworkHeaderEntry[] | undefined {
  return collectHeaders(headers);
}

function readFetchBodyPreview(init: unknown, max: number): string | undefined {
  const body = (init as { body?: unknown })?.body;
  if (body === undefined || body === null) return undefined;
  if (typeof body === "string") return body.slice(0, max);
  if (typeof body === "object") {
    // Avoid touching FormData/Blob/ArrayBuffer payloads — they may stream
    // or contain binary data. Caller can opt in via custom serialisation.
    return undefined;
  }
  return undefined;
}

function installXhr(
  g: Record<string, unknown>,
  s: ObservabilityState,
): () => void {
  const Xhr = g.XMLHttpRequest as
    | (new () => XMLHttpRequest & {
        open: (method: string, url: string, ...rest: unknown[]) => void;
        send: (body?: unknown) => void;
        setRequestHeader: (k: string, v: string) => void;
        addEventListener: (e: string, cb: () => void) => void;
        getAllResponseHeaders?: () => string;
        responseText?: string;
        status?: number;
        statusText?: string;
      })
    | undefined;
  if (typeof Xhr !== "function") return () => {};
  const proto = Xhr.prototype as unknown as Record<string, unknown> & {
    open: (...args: unknown[]) => void;
    send: (body?: unknown) => void;
    setRequestHeader: (k: string, v: string) => void;
  };
  if ((proto as Record<string, unknown>).__brnaXhrWrapped === true) return () => {};

  const originalOpen = proto.open;
  const originalSend = proto.send;
  const originalSetHeader = proto.setRequestHeader;

  proto.open = function patchedOpen(this: Record<string, unknown>, ...args: unknown[]): void {
    const method = typeof args[0] === "string" ? (args[0] as string).toUpperCase() : "GET";
    const url = typeof args[1] === "string" ? (args[1] as string) : "";
    this.__brnaXhrInfo = { method, url, headers: [] as NetworkHeaderEntry[] };
    return (originalOpen as (...a: unknown[]) => void).apply(this, args);
  };

  proto.setRequestHeader = function patchedSetHeader(
    this: Record<string, unknown>,
    name: string,
    value: string,
  ): void {
    const info = this.__brnaXhrInfo as { headers?: NetworkHeaderEntry[] } | undefined;
    if (info?.headers) info.headers.push({ name, value });
    return (originalSetHeader as (k: string, v: string) => void).call(this, name, value);
  };

  proto.send = function patchedSend(this: Record<string, unknown>, body?: unknown): void {
    const info = this.__brnaXhrInfo as
      | { method: string; url: string; headers: NetworkHeaderEntry[] }
      | undefined;
    const startedAt = Date.now();
    const record: NetworkRecord = {
      id: nextNetworkId(s),
      timestamp: startedAt,
      method: info?.method ?? "GET",
      url: info?.url ?? "",
      state: "started",
      source: "xhr",
    };
    if (info?.headers && info.headers.length > 0) record.request_headers = info.headers;
    if (typeof body === "string") record.request_body_preview = body.slice(0, s.bodyPreviewBytes);
    s.network.push(record);

    const finish = (errored: boolean): void => {
      record.duration_ms = Date.now() - startedAt;
      const xhr = this as {
        status?: number;
        statusText?: string;
        responseText?: string;
        getAllResponseHeaders?: () => string;
      };
      if (errored) {
        record.state = "errored";
        record.error_message = xhr.statusText ?? "xhr error";
        return;
      }
      record.state = "completed";
      if (typeof xhr.status === "number") record.status = xhr.status;
      if (typeof xhr.statusText === "string") record.status_text = xhr.statusText;
      if (typeof xhr.getAllResponseHeaders === "function") {
        const headers = parseRawHeaders(xhr.getAllResponseHeaders());
        if (headers.length > 0) record.response_headers = headers;
      }
      const responseType = (xhr as { responseType?: string }).responseType;
      const canReadResponseText =
        responseType === undefined || responseType === "" || responseType === "text";
      if (canReadResponseText && typeof xhr.responseText === "string" && xhr.responseText.length > 0) {
        record.response_body_preview = xhr.responseText.slice(0, s.bodyPreviewBytes);
      }
    };

    const addListener = this.addEventListener as
      | ((event: string, cb: () => void) => void)
      | undefined;
    if (typeof addListener === "function") {
      addListener.call(this, "load", () => finish(false));
      addListener.call(this, "error", () => finish(true));
      addListener.call(this, "abort", () => finish(true));
      addListener.call(this, "timeout", () => finish(true));
    }

    return (originalSend as (b?: unknown) => void).apply(this, [body]);
  };

  (proto as Record<string, unknown>).__brnaXhrWrapped = true;

  return () => {
    proto.open = originalOpen;
    proto.send = originalSend;
    proto.setRequestHeader = originalSetHeader;
    delete (proto as Record<string, unknown>).__brnaXhrWrapped;
  };
}

function parseRawHeaders(raw: string): NetworkHeaderEntry[] {
  const out: NetworkHeaderEntry[] = [];
  for (const line of raw.split(/\r?\n/)) {
    const idx = line.indexOf(":");
    if (idx <= 0) continue;
    const name = line.slice(0, idx).trim();
    const value = line.slice(idx + 1).trim();
    if (name.length > 0) out.push({ name, value });
  }
  return out;
}

function formatConsoleMessage(args: unknown[]): string {
  return args
    .map((a) => {
      if (typeof a === "string") return a;
      if (a instanceof Error) return a.message;
      try {
        return JSON.stringify(a);
      } catch {
        return String(a);
      }
    })
    .join(" ");
}

function safeJsonValues(args: unknown[]): unknown[] | undefined {
  const out: unknown[] = [];
  for (const a of args) {
    try {
      // round-trip to make sure values are JSON-serialisable; skip ones that aren't.
      const cloned = JSON.parse(JSON.stringify(a));
      out.push(cloned);
    } catch {
      /* skip */
    }
  }
  return out.length > 0 ? out : undefined;
}
