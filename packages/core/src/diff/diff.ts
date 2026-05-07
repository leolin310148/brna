import type {
  DiffEvent,
  ModifiedFieldChange,
  Node,
  Snapshot,
  SnapshotDiff,
  StateFlag,
} from "@brna/schema";

interface IndexedNode {
  node: Node;
  parentId: string | null;
}

type ScalarModifiedField = Exclude<ModifiedFieldChange["field"], "state">;

const MODIFIED_NODE_FIELDS: ScalarModifiedField[] = ["kind", "role", "name", "text", "value", "url"];

export function diff(prev: Snapshot, next: Snapshot): SnapshotDiff {
  const prevIndex = indexSnapshot(prev);
  const nextIndex = indexSnapshot(next);
  const events: DiffEvent[] = [];

  for (const [id, prevEntry] of prevIndex) {
    if (!nextIndex.has(id)) {
      events.push({
        type: "removed",
        id,
        ...(prevEntry.parentId != null ? { parent_id: prevEntry.parentId } : {}),
        node: prevEntry.node,
      });
    }
  }

  for (const [id, nextEntry] of nextIndex) {
    const prevEntry = prevIndex.get(id);
    if (!prevEntry) {
      events.push({
        type: "added",
        id,
        ...(nextEntry.parentId != null ? { parent_id: nextEntry.parentId } : {}),
        node: nextEntry.node,
      });
      continue;
    }
    if (prevEntry.parentId !== nextEntry.parentId) {
      events.push({
        type: "moved",
        id,
        node: nextEntry.node,
        from_parent: prevEntry.parentId ?? "",
        to_parent: nextEntry.parentId ?? "",
      });
    }
    const changes = compareNodes(prevEntry.node, nextEntry.node);
    if (changes.length > 0) {
      events.push({ type: "modified", id, node: nextEntry.node, changes });
    }
  }

  return { events };
}

function indexSnapshot(snapshot: Snapshot): Map<string, IndexedNode> {
  const map = new Map<string, IndexedNode>();
  if (snapshot.tree) walk(snapshot.tree, null, map);
  if (snapshot.overlays) {
    for (const overlay of snapshot.overlays) walk(overlay, null, map);
  }
  return map;
}

function walk(node: Node, parentId: string | null, map: Map<string, IndexedNode>): void {
  map.set(node.id, { node, parentId });
  if (node.children) {
    for (const child of node.children) walk(child, node.id, map);
  }
}

function compareNodes(prev: Node, next: Node): ModifiedFieldChange[] {
  const out: ModifiedFieldChange[] = [];
  for (const field of MODIFIED_NODE_FIELDS) {
    const before = prev[field];
    const after = next[field];
    if (before !== after) {
      out.push({ field, before, after });
    }
  }
  if (!stateEqual(prev.state, next.state)) {
    out.push({ field: "state", before: prev.state ?? [], after: next.state ?? [] });
  }
  return out;
}

function stateEqual(a: StateFlag[] | undefined, b: StateFlag[] | undefined): boolean {
  const setA = new Set(a ?? []);
  const setB = new Set(b ?? []);
  if (setA.size !== setB.size) return false;
  for (const flag of setA) if (!setB.has(flag)) return false;
  return true;
}
