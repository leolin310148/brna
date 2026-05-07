import type { Node } from "@brna/schema";
import { displayLabel } from "./inferred-label.js";
import { formatRoleSelector } from "./format.js";

export function canonicalSelectorFor(node: Node, ancestors: Node[] = []): string {
  if (!node.id.startsWith("auto:")) return `#${node.id}`;
  if (node.role && node.name) {
    const display = displayLabel(node) ?? node.name;
    const namedAncestor = [...ancestors].reverse().find((a) => !a.id.startsWith("auto:"));
    if (namedAncestor) {
      return `${formatRoleSelector(node.role, display)} in #${namedAncestor.id}`;
    }
    return formatRoleSelector(node.role, display);
  }
  return `#${node.id}`;
}

export function populateSelectors(node: Node, ancestors: Node[] = []): Node {
  const selector = canonicalSelectorFor(node, ancestors);
  const out: Node = { ...node, selector };
  if (node.children) {
    out.children = node.children.map((c) => populateSelectors(c, [...ancestors, node]));
  }
  return out;
}
