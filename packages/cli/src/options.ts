export const DEFAULT_METRO_URL = "http://localhost:8081";
export const DEFAULT_TIMEOUT_MS = 10000;
const IN_FLIGHT_RETRY_MS = 2000;
const IN_FLIGHT_RETRY_DELAY_MS = 100;

export function fail(code: number, reason: string): never {
  process.stderr.write(`brna: ${reason}\n`);
  process.exit(code);
}

export function parseMetro(value: string | undefined): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    fail(4, "missing value for '--metro'");
  }
  try {
    return normalizeMetroUrl(value);
  } catch {
    fail(4, `malformed URL for '--metro': ${value}`);
  }
}

export function normalizeMetroUrl(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length === 0) throw new Error("empty Metro URL");

  if (/^\d+$/.test(trimmed)) {
    return normalizeMetroUrl(`localhost:${trimmed}`);
  }

  const hasExplicitScheme = /^[a-z][a-z\d+.-]*:\/\//i.test(trimmed);
  if (!hasExplicitScheme && !/:\d+(?:[/?#]|$)/.test(trimmed)) {
    throw new Error("Metro URL shorthand must include a port");
  }
  const url = new URL(hasExplicitScheme ? trimmed : `http://${trimmed}`);
  if ((url.protocol !== "http:" && url.protocol !== "https:") || url.host.length === 0) {
    throw new Error("Metro URL must use http:// or https://");
  }
  return `${url.protocol}//${url.host}`;
}

export function parseTimeout(value: string | undefined): number {
  if (typeof value !== "string") fail(4, "missing value for '--timeout'");
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0) {
    fail(4, `'--timeout' must be a positive integer, got '${value}'`);
  }
  return n;
}

export function parsePositiveInt(value: string | undefined, flag: string): number {
  if (typeof value !== "string") fail(4, `missing value for '${flag}'`);
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0) {
    fail(4, `'${flag}' must be a positive integer, got '${value}'`);
  }
  return n;
}

export function parseNonNegativeInt(value: string | undefined, flag: string): number {
  if (typeof value !== "string" || value.trim().length === 0) fail(4, `missing value for '${flag}'`);
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0) {
    fail(4, `'${flag}' must be a non-negative integer, got '${value}'`);
  }
  return n;
}

export function parseSince(value: string | undefined, flag = "--since"): number {
  if (typeof value !== "string" || value.trim().length === 0) {
    fail(4, `missing value for '${flag}'`);
  }
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) {
    fail(4, `'${flag}' must be a non-negative number (ms duration or absolute ms timestamp), got '${value}'`);
  }
  // Heuristic: small numbers (< ~1980 epoch) are interpreted as durations from now;
  // large numbers are treated as absolute timestamps.
  if (n < 315532800000) {
    return Date.now() - n;
  }
  return n;
}

export function parseDevice(value: string | undefined): string {
  if (typeof value !== "string" || value.length === 0) {
    fail(4, "missing value for '--device'");
  }
  return value;
}

export const DEVICE_HEADER = "x-brna-device-id";

export async function fetchWithInFlightRetry(
  request: (signal: AbortSignal) => Promise<Response>,
  timeoutMs: number,
): Promise<Response> {
  const deadline = Date.now() + timeoutMs;
  const retryUntil = Date.now() + Math.min(IN_FLIGHT_RETRY_MS, timeoutMs);
  let lastResponse: Response | undefined;

  while (Date.now() < deadline) {
    const remaining = Math.max(1, deadline - Date.now());
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), remaining);
    try {
      const response = await request(controller.signal);
      if (response.status !== 429 || Date.now() >= retryUntil) return response;
      lastResponse = response;
    } finally {
      clearTimeout(timer);
    }

    const delay = Math.min(IN_FLIGHT_RETRY_DELAY_MS, Math.max(0, retryUntil - Date.now()));
    if (delay <= 0) break;
    await sleep(delay);
  }

  if (lastResponse) return lastResponse;
  const controller = new AbortController();
  controller.abort();
  return request(controller.signal);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function failWith(
  code: number,
  reason: string,
  stderr: Pick<typeof process.stderr, "write">,
  exit: (code: number) => never,
): never {
  stderr.write(`brna: ${reason}\n`);
  exit(code);
}

export async function diagnoseMetroResponse(
  response: Response,
  endpoint: string,
): Promise<string | null> {
  const contentType = response.headers.get("content-type") ?? "";
  const body = await response.clone().text().catch(() => "");
  const trimmed = body.trimStart();
  const lowerTrimmed = trimmed.toLowerCase();
  const isHtml =
    contentType.toLowerCase().includes("text/html") ||
    lowerTrimmed.startsWith("<!doctype html") ||
    lowerTrimmed.startsWith("<html");

  if (isHtml) {
    return `${endpoint} returned HTML instead of brna JSON; brna Metro middleware is not mounted. Wrap metro.config.js with withBrna() and restart Metro.`;
  }

  if (!response.ok && body.length > 0) {
    const line = firstUsefulDiagnosticLine(body);
    if (line.length > 0) {
      return `${endpoint} returned HTTP ${response.status}: ${line}`;
    }
  }

  return null;
}

function firstUsefulDiagnosticLine(body: string): string {
  const lines = body
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  return (
    lines.find((line) => /ENOENT|Cannot find module|Unable to resolve|Error:/i.test(line)) ??
    lines[0] ??
    ""
  ).slice(0, 240);
}
