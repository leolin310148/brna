import type {
  LogRecord,
  NetworkRecord,
  NetworkHeaderEntry,
  ObservabilityRedactionOptions,
  SerializableRedactionRule,
} from "@brna/schema";

const REDACTED = "<redacted>";
const CIRCULAR = "[Circular]";

const DEFAULT_SENSITIVE_HEADERS = new Set<string>([
  "authorization",
  "cookie",
  "set-cookie",
  "proxy-authorization",
  "x-api-key",
  "x-auth-token",
  "x-access-token",
  "x-csrf-token",
]);

const SENSITIVE_FIELD_PATTERN = /(token|password|passwd|secret|api[_-]?key|access[_-]?key|client[_-]?secret|authorization|session[_-]?id|refresh[_-]?token)/i;

interface CompiledRule {
  match: RegExp;
  replace: string;
}

export function compileRules(
  rules: SerializableRedactionRule[] | undefined,
): CompiledRule[] {
  const out: CompiledRule[] = [];
  if (!rules) return out;
  for (const rule of rules) {
    try {
      const flags = rule.match.flags?.includes("g")
        ? rule.match.flags
        : `${rule.match.flags ?? ""}g`;
      out.push({ match: new RegExp(rule.match.source, flags), replace: rule.replace });
    } catch {
      /* ignore invalid regex */
    }
  }
  return out;
}

function applyRules(value: string, rules: CompiledRule[]): string {
  if (rules.length === 0) return value;
  let out = value;
  for (const rule of rules) {
    rule.match.lastIndex = 0;
    out = out.replace(rule.match, rule.replace);
  }
  return out;
}

export function redactLogRecord(
  record: LogRecord,
  options: ObservabilityRedactionOptions = {},
): LogRecord {
  const rules = compileRules(options.rules);
  const sensitiveDefaults = options.redactSensitiveDefaults !== false;
  const out: LogRecord = {
    id: record.id,
    timestamp: record.timestamp,
    level: record.level,
    message: applyRules(record.message, rules),
  };
  if (record.source !== undefined) out.source = record.source;
  if (record.stack !== undefined) out.stack = applyRules(record.stack, rules);
  if (record.args !== undefined) {
    out.args = record.args.map((a) => redactValue(a, rules, sensitiveDefaults));
  }
  return out;
}

export function redactNetworkRecord(
  record: NetworkRecord,
  options: ObservabilityRedactionOptions = {},
): NetworkRecord {
  const rules = compileRules(options.rules);
  const sensitiveDefaults = options.redactSensitiveDefaults !== false;
  const out: NetworkRecord = {
    id: record.id,
    timestamp: record.timestamp,
    method: record.method,
    url: applyRules(record.url, rules),
    state: record.state,
    source: record.source,
  };
  if (record.status !== undefined) out.status = record.status;
  if (record.status_text !== undefined) out.status_text = applyRules(record.status_text, rules);
  if (record.duration_ms !== undefined) out.duration_ms = record.duration_ms;
  if (record.error_message !== undefined) out.error_message = applyRules(record.error_message, rules);
  if (record.request_headers !== undefined) {
    out.request_headers = redactHeaders(record.request_headers, rules, sensitiveDefaults);
  }
  if (record.response_headers !== undefined) {
    out.response_headers = redactHeaders(record.response_headers, rules, sensitiveDefaults);
  }
  if (record.request_body_preview !== undefined) {
    out.request_body_preview = redactBodyPreview(record.request_body_preview, rules, sensitiveDefaults);
  }
  if (record.response_body_preview !== undefined) {
    out.response_body_preview = redactBodyPreview(record.response_body_preview, rules, sensitiveDefaults);
  }
  return out;
}

function redactHeaders(
  headers: NetworkHeaderEntry[],
  rules: CompiledRule[],
  sensitiveDefaults: boolean,
): NetworkHeaderEntry[] {
  return headers.map((h) => {
    const lower = h.name.toLowerCase();
    if (sensitiveDefaults && DEFAULT_SENSITIVE_HEADERS.has(lower)) {
      return { name: h.name, value: REDACTED };
    }
    return { name: h.name, value: applyRules(h.value, rules) };
  });
}

function redactBodyPreview(
  body: string,
  rules: CompiledRule[],
  sensitiveDefaults: boolean,
): string {
  // Try to parse as JSON; if it parses, redact known sensitive fields. Otherwise treat as plain text.
  if (sensitiveDefaults) {
    const trimmed = body.trimStart();
    if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
      try {
        const parsed = JSON.parse(body) as unknown;
        const redacted = redactJsonValue(parsed, rules);
        return JSON.stringify(redacted);
      } catch {
        /* fall through to text rules */
      }
    }
  }
  return applyRules(body, rules);
}

function redactJsonValue(
  value: unknown,
  rules: CompiledRule[],
  sensitiveDefaults = true,
  seen = new WeakSet<object>(),
): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value === "string") return applyRules(value, rules);
  if (typeof value !== "object") return value;
  if (seen.has(value)) return CIRCULAR;
  seen.add(value);
  try {
    if (Array.isArray(value)) {
      return value.map((v) => redactJsonValue(v, rules, sensitiveDefaults, seen));
    }
    const out: Record<string, unknown> = {};
    for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
      if (sensitiveDefaults && SENSITIVE_FIELD_PATTERN.test(key)) {
        out[key] = REDACTED;
      } else {
        out[key] = redactJsonValue(v, rules, sensitiveDefaults, seen);
      }
    }
    return out;
  } finally {
    seen.delete(value);
  }
}

function redactValue(value: unknown, rules: CompiledRule[], sensitiveDefaults: boolean): unknown {
  if (typeof value === "string") return applyRules(value, rules);
  if (value === null || typeof value !== "object") return value;
  try {
    return redactJsonValue(value, rules, sensitiveDefaults);
  } catch {
    return value;
  }
}

export const __testing = {
  REDACTED,
  CIRCULAR,
  DEFAULT_SENSITIVE_HEADERS,
  SENSITIVE_FIELD_PATTERN,
};
