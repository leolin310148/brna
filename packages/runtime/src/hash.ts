import type { Node, Snapshot } from "@brna/schema";

const EXCLUDED_KEYS = new Set(["bounds", "_dev", "suggested_selectors"]);

export function computeSnapshotHash(snapshot: Pick<Snapshot, "tree" | "overlays">): string {
  const input = {
    tree: canonicalPublicNode(snapshot.tree),
    ...(snapshot.overlays ? { overlays: snapshot.overlays.map(canonicalPublicNode) } : {}),
  };
  return fnv1a32(stableStringify(input)).toString(16).padStart(8, "0");
}

function canonicalPublicNode(node: Node): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(node).sort()) {
    if (EXCLUDED_KEYS.has(key)) continue;
    const value = (node as unknown as Record<string, unknown>)[key];
    if (value === undefined) continue;
    if (key === "children" && Array.isArray(value)) {
      out.children = value.map((child) => canonicalPublicNode(child as Node));
    } else {
      out[key] = canonicalizeValue(value);
    }
  }
  return out;
}

function canonicalizeValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalizeValue);
  if (!value || typeof value !== "object") return value;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(value).sort()) {
    if (EXCLUDED_KEYS.has(key)) continue;
    const child = (value as Record<string, unknown>)[key];
    if (child !== undefined) out[key] = canonicalizeValue(child);
  }
  return out;
}

function stableStringify(value: unknown): string {
  return JSON.stringify(value);
}

function fnv1a32(value: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < value.length; i++) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}
