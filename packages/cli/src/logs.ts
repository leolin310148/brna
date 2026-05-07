import type { LogLevel, LogRecord, LogsRequestOptions } from "@brna/schema";
import { isLogLevel } from "@brna/schema";
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

interface LogsRuntime {
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
  level?: LogLevel;
  limit?: number;
}

interface LogsResponseBody {
  records: LogRecord[];
}

function parseLevelArg(value: string | undefined): LogLevel {
  if (typeof value !== "string") fail(4, "missing value for '--level'");
  if (!isLogLevel(value)) {
    fail(4, `'--level' must be one of debug|log|info|warn|error, got '${value}'`);
  }
  return value;
}

function parseArgs(rest: string[]): ParsedArgs {
  let metro = DEFAULT_METRO_URL;
  let timeoutMs = DEFAULT_TIMEOUT_MS;
  let json = false;
  let device: string | undefined;
  let since: number | undefined;
  let level: LogLevel | undefined;
  let limit: number | undefined;
  for (let i = 0; i < rest.length; i++) {
    const token = rest[i]!;
    if (token === "--metro") metro = parseMetro(rest[++i]);
    else if (token === "--timeout") timeoutMs = parseTimeout(rest[++i]);
    else if (token === "--json") json = true;
    else if (token === "--device") device = parseDevice(rest[++i]);
    else if (token === "--since") since = parseSince(rest[++i]);
    else if (token === "--level") level = parseLevelArg(rest[++i]);
    else if (token === "--limit") {
      limit = parsePositiveInt(rest[++i], "--limit");
    } else {
      fail(4, `unknown flag '${token}'`);
    }
  }
  const out: ParsedArgs = { metro, timeoutMs, json };
  if (device !== undefined) out.device = device;
  if (since !== undefined) out.since = since;
  if (level !== undefined) out.level = level;
  if (limit !== undefined) out.limit = limit;
  return out;
}

export async function runLogs(rest: string[], runtime: LogsRuntime = {}): Promise<void> {
  const parsed = parseArgs(rest);
  const fetchImpl = runtime.fetch ?? fetch;
  const stdout = runtime.stdout ?? process.stdout;
  const stderr = runtime.stderr ?? process.stderr;
  const exit = runtime.exit ?? process.exit;

  const config = (await loadConfig()).config;
  const redaction = toObservabilityRedactionOptions(config);
  const requestOptions: LogsRequestOptions = {};
  if (parsed.since !== undefined) requestOptions.since = parsed.since;
  if (parsed.level !== undefined) requestOptions.level = parsed.level;
  if (parsed.limit !== undefined) requestOptions.limit = parsed.limit;
  if (hasObservabilityRedactionOptions(redaction)) requestOptions.redaction = redaction;

  const headers: Record<string, string> = {};
  if (parsed.device !== undefined) headers[DEVICE_HEADER] = parsed.device;

  const url = `${parsed.metro}/brna/logs`;
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
      failWith(2, `logs request timed out after ${parsed.timeoutMs}ms`, stderr, exit);
    }
    failWith(1, `could not connect to Metro at ${parsed.metro}`, stderr, exit);
  }
  clearTimeout(timer);

  if (response.status === 503) {
    failWith(3, "no runtime connected — start the app first", stderr, exit);
  }
  if (response.status === 404) {
    failWith(3, `unknown device '${parsed.device ?? "?"}' — run 'brna devices' to list connected runtimes`, stderr, exit);
  }
  if (response.status === 504) {
    failWith(3, "runtime timed out reading logs", stderr, exit);
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
    const diagnosis = await diagnoseMetroResponse(response, "logs endpoint");
    failWith(3, diagnosis ?? `unexpected HTTP ${response.status} from Metro`, stderr, exit);
  }

  let payload: LogsResponseBody;
  try {
    payload = (await response.json()) as LogsResponseBody;
  } catch (err) {
    failWith(3, `malformed logs response: ${(err as Error).message}`, stderr, exit);
  }
  const records = Array.isArray(payload.records) ? payload.records : [];

  if (parsed.json) {
    stdout.write(JSON.stringify({ records }, null, 2));
    stdout.write("\n");
    exit(0);
  }

  if (records.length === 0) {
    stdout.write("No log records captured.\n");
    exit(0);
  }

  stdout.write(formatLogsTable(records));
  exit(0);
}

export function formatLogsTable(records: LogRecord[]): string {
  return (
    records
      .map((r) => {
        const ts = new Date(r.timestamp).toISOString();
        return `${ts}  ${r.level.padEnd(5)}  ${r.message}`;
      })
      .join("\n") + "\n"
  );
}
