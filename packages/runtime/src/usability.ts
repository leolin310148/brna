import type { Node, NodeKind, SnapshotWarning } from "@brna/schema";

const INTERACTIVE_KINDS = new Set<NodeKind>([
  "button",
  "link",
  "input",
  "toggle",
  "slider",
]);

const MIN_TARGET_SIZE_PT = 44;

interface InteractiveNode {
  id: string;
  bounds: { x: number; y: number; w: number; h: number };
}

function collectInteractive(nodes: Node[], out: InteractiveNode[]): void {
  for (const node of nodes) {
    if (INTERACTIVE_KINDS.has(node.kind) && node.bounds) {
      out.push({ id: node.id, bounds: node.bounds });
    }
    if (node.children && node.children.length > 0) collectInteractive(node.children, out);
  }
}

export function computeUsabilityWarnings(
  rootChildren: Node[],
  unavailable: Set<string>,
): SnapshotWarning[] {
  const warnings: SnapshotWarning[] = [];
  const interactive: InteractiveNode[] = [];
  collectInteractive(rootChildren, interactive);

  for (const n of interactive) {
    if (unavailable.has(n.id)) continue;
    if (n.bounds.w < MIN_TARGET_SIZE_PT || n.bounds.h < MIN_TARGET_SIZE_PT) {
      warnings.push({ code: "undersized_target", node: n.id, w: n.bounds.w, h: n.bounds.h });
    }
  }

  // Overlap pass — only positive-area intersections among nodes with valid
  // non-zero bounds. interactive[] is already in document order (collectInteractive
  // is a DFS), so the pair (i, j) with i < j is naturally ordered.
  for (let i = 0; i < interactive.length; i++) {
    const a = interactive[i]!;
    if (unavailable.has(a.id)) continue;
    if (a.bounds.w <= 0 || a.bounds.h <= 0) continue;
    for (let j = i + 1; j < interactive.length; j++) {
      const b = interactive[j]!;
      if (unavailable.has(b.id)) continue;
      if (b.bounds.w <= 0 || b.bounds.h <= 0) continue;
      if (intersectsPositiveArea(a.bounds, b.bounds)) {
        warnings.push({ code: "overlapping_nodes", nodes: [a.id, b.id] });
      }
    }
  }

  return warnings;
}

function intersectsPositiveArea(
  a: { x: number; y: number; w: number; h: number },
  b: { x: number; y: number; w: number; h: number },
): boolean {
  const overlapW = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
  const overlapH = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
  return overlapW > 0 && overlapH > 0;
}
