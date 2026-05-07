import type { Node, Snapshot, SnapshotDiff } from "@brna/schema";

interface ParentIndex {
  parentOf: Map<string, string | null>;
  childrenOf: Map<string | null, string[]>;
  overlayIds: Set<string>;
}

function indexParents(snapshot: Snapshot): ParentIndex {
  const parentOf = new Map<string, string | null>();
  const childrenOf = new Map<string | null, string[]>();
  const overlayIds = new Set<string>();

  const walk = (node: Node, parent: string | null, inOverlay = false): void => {
    parentOf.set(node.id, parent);
    const list = childrenOf.get(parent) ?? [];
    list.push(node.id);
    childrenOf.set(parent, list);
    if (inOverlay) overlayIds.add(node.id);
    if (node.children) {
      for (const child of node.children) walk(child, node.id, inOverlay);
    }
  };

  if (snapshot.tree) walk(snapshot.tree, null);
  if (snapshot.overlays) {
    for (const overlay of snapshot.overlays) {
      walk(overlay, null, true);
    }
  }
  return { parentOf, childrenOf, overlayIds };
}

function ancestorChain(id: string, parentOf: Map<string, string | null>): string[] {
  const chain: string[] = [];
  let cursor: string | null | undefined = parentOf.get(id);
  while (cursor) {
    chain.push(cursor);
    cursor = parentOf.get(cursor);
  }
  return chain;
}

/**
 * Filter a SnapshotDiff to only events relevant to a target node.
 *
 * Retained events touch one of:
 *   - the target node itself,
 *   - any of its ancestors in either snapshot,
 *   - immediate siblings of the target (children of the target's parent
 *     in either snapshot, since siblings present in only one side still
 *     matter to the target's local context),
 *   - any overlay node (overlays are global in both snapshots).
 *
 * The target's own descendants are intentionally excluded — that subtree
 * tends to balloon diffs without aiding reasoning about the action target.
 */
export function filterDiffByTarget(
  baseline: Snapshot,
  fresh: Snapshot,
  fullDiff: SnapshotDiff,
  targetId: string,
): SnapshotDiff {
  const baseIdx = indexParents(baseline);
  const freshIdx = indexParents(fresh);

  const keep = new Set<string>([targetId]);

  // Ancestors from both snapshots (the node may not exist in baseline).
  for (const a of ancestorChain(targetId, freshIdx.parentOf)) keep.add(a);
  for (const a of ancestorChain(targetId, baseIdx.parentOf)) keep.add(a);

  // Immediate siblings: children of the target's parent in either snapshot.
  const freshParent = freshIdx.parentOf.get(targetId) ?? null;
  const baseParent = baseIdx.parentOf.get(targetId) ?? null;
  for (const sib of freshIdx.childrenOf.get(freshParent) ?? []) keep.add(sib);
  for (const sib of baseIdx.childrenOf.get(baseParent) ?? []) keep.add(sib);

  // Overlays — keep the union from both snapshots.
  const overlays = new Set<string>([...baseIdx.overlayIds, ...freshIdx.overlayIds]);

  const events = fullDiff.events.filter((event) => {
    if (keep.has(event.id)) return true;
    if (overlays.has(event.id)) return true;
    return false;
  });

  return { events };
}
