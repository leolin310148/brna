import type { Node } from "@brna/schema";

const SENTINEL_PATTERN = /^__(.+)__$/;

export function isInferredSentinelLabel(node: Node): boolean {
  if (typeof node.name !== "string" || node.name.length === 0) return false;
  if (node._dev?.inferred_label !== true) return false;
  return SENTINEL_PATTERN.test(node.name);
}

export function displayLabel(node: Node): string | undefined {
  if (typeof node.name !== "string") return node.name;
  if (node._dev?.inferred_label !== true) return node.name;
  const match = SENTINEL_PATTERN.exec(node.name);
  return match ? match[1] : node.name;
}
