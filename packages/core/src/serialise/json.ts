import type { Snapshot } from "@brna/schema";
import { redactSnapshot, type RedactionOptions } from "./redact.js";

export function toJSON(snapshot: Snapshot, options: RedactionOptions = {}): string {
  return canonicalStringify(redactSnapshot(snapshot, options), 2) + "\n";
}

export function fromJSON(text: string): Snapshot {
  return JSON.parse(text) as Snapshot;
}

export function canonicalStringify(value: unknown, indent: number): string {
  return stringify(value, indent, 0);
}

function stringify(value: unknown, indent: number, depth: number): string {
  if (value === null) return "null";
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : "null";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "undefined") return "null";

  const pad = " ".repeat(indent * depth);
  const innerPad = " ".repeat(indent * (depth + 1));

  if (Array.isArray(value)) {
    if (value.length === 0) return "[]";
    const items = value.map((v) => innerPad + stringify(v, indent, depth + 1));
    return `[\n${items.join(",\n")}\n${pad}]`;
  }

  if (typeof value === "object") {
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj).filter((k) => obj[k] !== undefined).sort();
    if (keys.length === 0) return "{}";
    const items = keys.map((k) => `${innerPad}${JSON.stringify(k)}: ${stringify(obj[k], indent, depth + 1)}`);
    return `{\n${items.join(",\n")}\n${pad}}`;
  }

  return "null";
}
