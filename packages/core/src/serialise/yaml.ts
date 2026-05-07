import { parse, stringify } from "yaml";
import { validateSnapshot, type Snapshot } from "@brna/schema";
import { redactSnapshot, type RedactionOptions } from "./redact.js";

const EMIT_OPTIONS = {
  lineWidth: 0,
  defaultStringType: "PLAIN" as const,
  nullStr: "~",
  sortMapEntries: true,
};

export function toYAML(snapshot: Snapshot, options: RedactionOptions = {}): string {
  return stringify(stripUndefined(redactSnapshot(snapshot, options)), EMIT_OPTIONS);
}

export function fromYAML(text: string): Snapshot {
  const value = parse(text) as Snapshot;
  validateSnapshot(value);
  return value;
}

export function toCanonicalYAML(value: unknown): string {
  return stringify(stripUndefined(value), EMIT_OPTIONS);
}

export function fromCanonicalYAML(text: string): unknown {
  return parse(text);
}

export function stripUndefined(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripUndefined);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (v !== undefined) out[k] = stripUndefined(v);
    }
    return out;
  }
  return value;
}
