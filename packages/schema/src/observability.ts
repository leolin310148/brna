import type { SerializableRedactionRule } from "./types.js";

export const LOG_LEVELS = ["debug", "log", "info", "warn", "error"] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

const LOG_LEVEL_RANK: Record<LogLevel, number> = {
  debug: 0,
  log: 1,
  info: 2,
  warn: 3,
  error: 4,
};

export interface LogRecord {
  id: string;
  timestamp: number;
  level: LogLevel;
  message: string;
  args?: unknown[];
  stack?: string;
  source?: "console" | "error";
}

export interface NetworkHeaderEntry {
  name: string;
  value: string;
}

export interface NetworkRecord {
  id: string;
  timestamp: number;
  method: string;
  url: string;
  request_headers?: NetworkHeaderEntry[];
  request_body_preview?: string;
  status?: number;
  status_text?: string;
  response_headers?: NetworkHeaderEntry[];
  response_body_preview?: string;
  duration_ms?: number;
  state: "started" | "completed" | "errored";
  error_message?: string;
  source: "fetch" | "xhr";
}

export interface ObservabilityRedactionOptions {
  rules?: SerializableRedactionRule[];
  redactSensitiveDefaults?: boolean;
}

export interface LogsRequestOptions {
  since?: number;
  level?: LogLevel;
  limit?: number;
  redaction?: ObservabilityRedactionOptions;
}

export interface NetworkRequestOptions {
  since?: number;
  method?: string;
  status?: number;
  statusMin?: number;
  statusMax?: number;
  limit?: number;
  redaction?: ObservabilityRedactionOptions;
}

export interface LogsResponsePayload {
  records: LogRecord[];
}

export interface NetworkResponsePayload {
  records: NetworkRecord[];
}

export function logLevelRank(level: LogLevel): number {
  return LOG_LEVEL_RANK[level];
}

export function isLogLevel(value: unknown): value is LogLevel {
  return typeof value === "string" && (LOG_LEVELS as readonly string[]).includes(value);
}

export function compareLogLevels(a: LogLevel, b: LogLevel): number {
  return LOG_LEVEL_RANK[a] - LOG_LEVEL_RANK[b];
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isNonNegativeFiniteNumber(value: unknown): value is number {
  return isFiniteNumber(value) && value >= 0;
}

function isOptionalNonNegativeFiniteNumber(value: unknown): boolean {
  return value === undefined || isNonNegativeFiniteNumber(value);
}

function isOptionalString(value: unknown): boolean {
  return value === undefined || typeof value === "string";
}

function isOptionalUnknownArray(value: unknown): boolean {
  return value === undefined || Array.isArray(value);
}

function isValidNetworkHeaderEntries(value: unknown): boolean {
  if (value === undefined) return true;
  if (!Array.isArray(value)) return false;
  return value.every((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return false;
    const header = entry as Record<string, unknown>;
    return typeof header.name === "string" && typeof header.value === "string";
  });
}

function isPositiveSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function parseHttpStatus(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isInteger(value)) return undefined;
  return value >= 100 && value <= 599 ? value : undefined;
}

function isHttpMethodToken(value: string): boolean {
  return /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(value);
}

function isOptionalHttpStatus(value: unknown): boolean {
  return value === undefined || parseHttpStatus(value) !== undefined;
}

export function isValidLogRecord(value: unknown): value is LogRecord {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.id === "string" &&
    isFiniteNumber(v.timestamp) &&
    isLogLevel(v.level) &&
    typeof v.message === "string" &&
    isOptionalUnknownArray(v.args) &&
    isOptionalString(v.stack) &&
    (v.source === undefined || v.source === "console" || v.source === "error")
  );
}

export function isValidNetworkRecord(value: unknown): value is NetworkRecord {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.id === "string" &&
    isFiniteNumber(v.timestamp) &&
    typeof v.method === "string" &&
    isHttpMethodToken(v.method) &&
    typeof v.url === "string" &&
    isValidNetworkHeaderEntries(v.request_headers) &&
    isOptionalString(v.request_body_preview) &&
    isOptionalHttpStatus(v.status) &&
    isOptionalString(v.status_text) &&
    isValidNetworkHeaderEntries(v.response_headers) &&
    isOptionalString(v.response_body_preview) &&
    isOptionalNonNegativeFiniteNumber(v.duration_ms) &&
    (v.state === "started" || v.state === "completed" || v.state === "errored") &&
    isOptionalString(v.error_message) &&
    (v.source === "fetch" || v.source === "xhr")
  );
}

export function parseLogsRequestOptions(value: unknown): LogsRequestOptions {
  if (!value || typeof value !== "object") return {};
  const v = value as Record<string, unknown>;
  const out: LogsRequestOptions = {};
  if (isNonNegativeFiniteNumber(v.since)) out.since = v.since;
  if (typeof v.level === "string") {
    const level = v.level.trim().toLowerCase();
    if (isLogLevel(level)) out.level = level;
  }
  if (isPositiveSafeInteger(v.limit)) out.limit = v.limit;
  if (v.redaction && typeof v.redaction === "object") {
    out.redaction = v.redaction as ObservabilityRedactionOptions;
  }
  return out;
}

export function parseNetworkRequestOptions(value: unknown): NetworkRequestOptions {
  if (!value || typeof value !== "object") return {};
  const v = value as Record<string, unknown>;
  const out: NetworkRequestOptions = {};
  if (isNonNegativeFiniteNumber(v.since)) out.since = v.since;
  if (typeof v.method === "string") {
    const method = v.method.trim();
    if (method.length > 0 && isHttpMethodToken(method)) out.method = method.toUpperCase();
  }
  const status = parseHttpStatus(v.status);
  if (status !== undefined) out.status = status;
  const statusMin = parseHttpStatus(v.statusMin);
  const statusMax = parseHttpStatus(v.statusMax);
  const validRange = statusMin === undefined || statusMax === undefined || statusMin <= statusMax;
  if (validRange) {
    if (statusMin !== undefined) out.statusMin = statusMin;
    if (statusMax !== undefined) out.statusMax = statusMax;
  }
  if (isPositiveSafeInteger(v.limit)) out.limit = v.limit;
  if (v.redaction && typeof v.redaction === "object") {
    out.redaction = v.redaction as ObservabilityRedactionOptions;
  }
  return out;
}
