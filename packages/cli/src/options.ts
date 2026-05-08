import { escapeControlCharacters } from "./format.js";

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
    fail(4, `malformed URL for '--metro': ${formatCliValue(value)}`);
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
  if (typeof value !== "string" || value.trim().length === 0) fail(4, "missing value for '--timeout'");
  const n = parseDecimalInteger(value);
  if (n === undefined || n <= 0) {
    fail(4, `'--timeout' must be a positive integer, got '${formatCliValue(value)}'`);
  }
  return n;
}

export function parsePositiveInt(value: string | undefined, flag: string): number {
  if (typeof value !== "string" || value.trim().length === 0) fail(4, `missing value for '${flag}'`);
  const n = parseDecimalInteger(value);
  if (n === undefined || n <= 0) {
    fail(4, `'${flag}' must be a positive integer, got '${formatCliValue(value)}'`);
  }
  return n;
}

export function parseNonNegativeInt(value: string | undefined, flag: string): number {
  if (typeof value !== "string" || value.trim().length === 0) fail(4, `missing value for '${flag}'`);
  const n = parseDecimalInteger(value);
  if (n === undefined) {
    fail(4, `'${flag}' must be a non-negative integer, got '${formatCliValue(value)}'`);
  }
  return n;
}

export function parseSince(value: string | undefined, flag = "--since"): number {
  if (typeof value !== "string" || value.trim().length === 0) {
    fail(4, `missing value for '${flag}'`);
  }
  const trimmed = value.trim();
  if (!/^(?:\d+(?:\.\d+)?|\.\d+)$/.test(trimmed)) {
    fail(4, `'${flag}' must be a non-negative number (ms duration or absolute ms timestamp), got '${formatCliValue(value)}'`);
  }
  const n = Number(trimmed);
  if (!Number.isFinite(n)) {
    fail(4, `'${flag}' must be a non-negative number (ms duration or absolute ms timestamp), got '${formatCliValue(value)}'`);
  }
  // Heuristic: small numbers (< ~1980 epoch) are interpreted as durations from now;
  // large numbers are treated as absolute timestamps.
  if (n < 315532800000) {
    return Date.now() - n;
  }
  return n;
}

export function parseDevice(value: string | undefined): string {
  const trimmed = typeof value === "string" ? value.trim() : "";
  if (trimmed.length === 0) {
    fail(4, "missing value for '--device'");
  }
  return trimmed;
}

export function parseNativeDevice(value: string | undefined): string {
  const trimmed = typeof value === "string" ? value.trim() : "";
  if (trimmed.length === 0) {
    fail(4, "missing value for '--native-device'");
  }
  return trimmed;
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

export function parseDecimalInteger(value: string): number | undefined {
  const trimmed = value.trim();
  if (!/^\d+$/.test(trimmed)) return undefined;
  const n = Number(trimmed);
  return Number.isSafeInteger(n) ? n : undefined;
}

function formatCliValue(value: string): string {
  return escapeControlCharacters(value);
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
    const line = escapeControlCharacters(firstUsefulDiagnosticLine(body));
    if (line.length > 0) {
      return `${endpoint} returned HTTP ${response.status}: ${line}`;
    }
  }

  return null;
}

function firstUsefulDiagnosticLine(body: string): string {
  const jsonLine = diagnosticLineFromJson(body);
  if (jsonLine) return jsonLine.slice(0, 240);

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

function diagnosticLineFromJson(body: string): string | undefined {
  const trimmed = body.trim();
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[") && !trimmed.startsWith("\"")) return undefined;
  try {
    return pickJsonDiagnostic(JSON.parse(trimmed));
  } catch {
    return undefined;
  }
}

function pickJsonDiagnostic(value: unknown, depth = 0): string | undefined {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  }
  if (!value || typeof value !== "object" || depth > 2) return undefined;

  if (Array.isArray(value)) {
    for (const entry of value) {
      const picked = pickJsonDiagnostic(entry, depth + 1);
      if (picked) return picked;
    }
    return undefined;
  }

  const record = value as Record<string, unknown>;
  for (const key of ["message", "error", "errors", "reason", "detail", "description", "title", "data"]) {
    const picked = record[key];
    if (typeof picked === "string" && picked.trim().length > 0) return picked.trim();
    const nested = pickJsonDiagnostic(picked, depth + 1);
    if (nested) return nested;
  }
  return undefined;
}
