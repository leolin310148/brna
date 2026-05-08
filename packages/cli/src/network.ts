import type { NetworkRecord, NetworkRequestOptions } from "@brna/schema";
import {
  DEFAULT_METRO_URL,
  DEFAULT_TIMEOUT_MS,
  DEVICE_HEADER,
  diagnoseMetroResponse,
  fail,
  failWith,
  parseDevice,
  parseMetro,
  parsePositiveInt,
  parseSince,
  parseTimeout,
} from "./options.js";
import {
  hasObservabilityRedactionOptions,
  loadConfig,
  toObservabilityRedactionOptions,
} from "./config.js";
import { formatTimestamp } from "./format.js";

interface NetworkRuntime {
  fetch?: typeof fetch;
  stdout?: Pick<typeof process.stdout, "write">;
  stderr?: Pick<typeof process.stderr, "write">;
  exit?: (code: number) => never;
}

interface ParsedArgs {
  metro: string;
  timeoutMs: number;
  json: boolean;
  device?: string;
  since?: number;
  method?: string;
  status?: number;
  statusMin?: number;
  statusMax?: number;
  limit?: number;
}

interface NetworkResponseBody {
  records: NetworkRecord[];
}

function parseStatusArg(value: string | undefined): {
  status?: number;
  statusMin?: number;
  statusMax?: number;
} {
  const trimmed = typeof value === "string" ? value.trim() : "";
  if (trimmed.length === 0) {
    fail(4, "missing value for '--status'");
  }
  if (/^\d+$/.test(trimmed)) {
    const status = Number(trimmed);
    if (isHttpStatus(status)) return { status };
    fail(4, `'--status' must be an HTTP status code from 100 to 599, got '${value}'`);
  }
  const range = /^(\d+)\s*-\s*(\d+)$/.exec(trimmed);
  if (range) {
    const lo = Number(range[1]);
    const hi = Number(range[2]);
    if (isHttpStatus(lo) && isHttpStatus(hi) && lo <= hi) {
      return { statusMin: lo, statusMax: hi };
    }
  }
  // Class shortcuts like "2xx", "4xx".
  const cls = /^([1-5])xx$/i.exec(trimmed);
  if (cls) {
    const base = Number(cls[1]) * 100;
    return { statusMin: base, statusMax: base + 99 };
  }
  fail(4, `'--status' must be a code or range (e.g. 200, 200-299, 4xx), got '${value}'`);
}

function isHttpStatus(value: number): boolean {
  return Number.isInteger(value) && value >= 100 && value <= 599;
}

function parseMethodArg(value: string | undefined): string {
  const trimmed = typeof value === "string" ? value.trim() : "";
  if (trimmed.length === 0) fail(4, "missing value for '--method'");
  if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(trimmed)) {
    fail(4, `'--method' must be an HTTP method token, got '${value}'`);
  }
  return trimmed.toUpperCase();
}

function parseArgs(rest: string[]): ParsedArgs {
  let metro = DEFAULT_METRO_URL;
  let timeoutMs = DEFAULT_TIMEOUT_MS;
  let json = false;
  let device: string | undefined;
  let since: number | undefined;
  let method: string | undefined;
  let status: number | undefined;
  let statusMin: number | undefined;
  let statusMax: number | undefined;
  let limit: number | undefined;
  for (let i = 0; i < rest.length; i++) {
    const token = rest[i]!;
    if (token === "--metro") metro = parseMetro(rest[++i]);
    else if (token === "--timeout") timeoutMs = parseTimeout(rest[++i]);
    else if (token === "--json") json = true;
    else if (token === "--device") device = parseDevice(rest[++i]);
    else if (token === "--since") since = parseSince(rest[++i]);
    else if (token === "--method") method = parseMethodArg(rest[++i]);
    else if (token === "--status") {
      const parsed = parseStatusArg(rest[++i]);
      if (parsed.status !== undefined) status = parsed.status;
      if (parsed.statusMin !== undefined) statusMin = parsed.statusMin;
      if (parsed.statusMax !== undefined) statusMax = parsed.statusMax;
    } else if (token === "--limit") {
      limit = parsePositiveInt(rest[++i], "--limit");
    } else {
      fail(4, `unknown flag '${token}'`);
    }
  }
  const out: ParsedArgs = { metro, timeoutMs, json };
  if (device !== undefined) out.device = device;
  if (since !== undefined) out.since = since;
  if (method !== undefined) out.method = method;
  if (status !== undefined) out.status = status;
  if (statusMin !== undefined) out.statusMin = statusMin;
  if (statusMax !== undefined) out.statusMax = statusMax;
  if (limit !== undefined) out.limit = limit;
  return out;
}

export async function runNetwork(rest: string[], runtime: NetworkRuntime = {}): Promise<void> {
  const parsed = parseArgs(rest);
  const fetchImpl = runtime.fetch ?? fetch;
  const stdout = runtime.stdout ?? process.stdout;
  const stderr = runtime.stderr ?? process.stderr;
  const exit = runtime.exit ?? process.exit;

  const config = (await loadConfig()).config;
  const redaction = toObservabilityRedactionOptions(config);
  const requestOptions: NetworkRequestOptions = {};
  if (parsed.since !== undefined) requestOptions.since = parsed.since;
  if (parsed.method !== undefined) requestOptions.method = parsed.method;
  if (parsed.status !== undefined) requestOptions.status = parsed.status;
  if (parsed.statusMin !== undefined) requestOptions.statusMin = parsed.statusMin;
  if (parsed.statusMax !== undefined) requestOptions.statusMax = parsed.statusMax;
  if (parsed.limit !== undefined) requestOptions.limit = parsed.limit;
  if (hasObservabilityRedactionOptions(redaction)) requestOptions.redaction = redaction;

  const headers: Record<string, string> = {};
  if (parsed.device !== undefined) headers[DEVICE_HEADER] = parsed.device;

  const url = `${parsed.metro}/brna/network`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), parsed.timeoutMs);
  let response: Response;
  try {
    const useBody = Object.keys(requestOptions).length > 0;
    response = await fetchImpl(url, {
      method: useBody ? "POST" : "GET",
      headers: useBody ? { ...headers, "Content-Type": "application/json" } : headers,
      ...(useBody ? { body: JSON.stringify(requestOptions) } : {}),
      signal: controller.signal,
    });
  } catch (err) {
    clearTimeout(timer);
    if ((err as { name?: string }).name === "AbortError") {
      failWith(2, `network request timed out after ${parsed.timeoutMs}ms`, stderr, exit);
    }
    failWith(1, `could not connect to Metro at ${parsed.metro}`, stderr, exit);
  }
  clearTimeout(timer);

  if (response.status === 503) {
    failWith(3, "no runtime connected — start the app first", stderr, exit);
  }
  if (response.status === 404) {
    const diagnosis = await diagnoseMetroResponse(response, "network endpoint");
    if (diagnosis?.includes("brna Metro middleware is not mounted")) {
      failWith(3, diagnosis, stderr, exit);
    }
    failWith(3, `unknown device '${parsed.device ?? "?"}' — run 'brna devices' to list connected runtimes`, stderr, exit);
  }
  if (response.status === 504) {
    failWith(3, "runtime timed out reading network records", stderr, exit);
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
  if (!response.ok) {
    const diagnosis = await diagnoseMetroResponse(response, "network endpoint");
    failWith(3, diagnosis ?? `unexpected HTTP ${response.status} from Metro`, stderr, exit);
  }

  const diagnosis = await diagnoseMetroResponse(response, "network endpoint");
  let payload: NetworkResponseBody;
  try {
    payload = (await response.json()) as NetworkResponseBody;
  } catch (err) {
    failWith(3, diagnosis ?? `malformed network response: ${(err as Error).message}`, stderr, exit);
  }
  const records = Array.isArray(payload.records) ? payload.records : [];

  if (parsed.json) {
    stdout.write(JSON.stringify({ records }, null, 2));
    stdout.write("\n");
    exit(0);
  }

  if (records.length === 0) {
    stdout.write("No network records captured.\n");
    exit(0);
  }

  stdout.write(formatNetworkTable(records));
  exit(0);
}

export function formatNetworkTable(records: NetworkRecord[]): string {
  const headers: string[] = ["TIME", "METHOD", "STATUS", "DUR(ms)", "URL"];
  const rows: string[][] = records.map((r) => [
    formatTimestamp(r.timestamp),
    r.method,
    r.status !== undefined ? String(r.status) : r.state === "errored" ? "ERR" : "-",
    r.duration_ms !== undefined ? String(r.duration_ms) : "-",
    r.url,
  ]);
  const widths = headers.map((h, i) =>
    Math.max(h.length, ...rows.map((row) => (row[i] ?? "").length)),
  );
  const fmt = (cells: string[]): string =>
    cells.map((c, i) => c.padEnd(widths[i] ?? 0)).join("  ").trimEnd();
  return [fmt(headers), ...rows.map(fmt)].join("\n") + "\n";
}
