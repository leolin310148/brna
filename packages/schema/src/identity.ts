import type { DeriveNodeIdInput, Node, SnapshotWarning } from "./types.js";

const FNV_OFFSET_32 = 0x811c9dc5;
const FNV_PRIME_32 = 0x01000193;
const AUTO_ID_DELIMITER = "\0";

export function fnv1a32(input: string): string {
  let hash = FNV_OFFSET_32;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, FNV_PRIME_32);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

export function deriveNodeId(input: DeriveNodeIdInput): string {
  if (isUsableExplicitId(input.testID)) return input.testID;
  if (isUsableExplicitId(input.accessibilityIdentifier)) {
    return input.accessibilityIdentifier;
  }
  const key = [
    input.parent_id,
    input.kind,
    input.role ?? "",
    input.name ?? "",
    String(input.position_within_kind),
  ].join(AUTO_ID_DELIMITER);
  return `auto:${fnv1a32(key)}`;
}

function isUsableExplicitId(value: string | undefined): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

export interface SiblingIdentityResult {
  ids: string[];
  warnings: SnapshotWarning[];
}

export function deriveNodeIdsForSiblings(
  siblings: ReadonlyArray<Omit<DeriveNodeIdInput, "parent_id">>,
  parentId: string,
): SiblingIdentityResult {
  const counts = new Map<string, number>();
  const ids: string[] = [];
  const warnings: SnapshotWarning[] = [];

  for (const sibling of siblings) {
    const baseId = deriveNodeId({ ...sibling, parent_id: parentId });
    ids.push(disambiguateId(baseId, counts, warnings));
  }
  return { ids, warnings };
}

// Shared disambiguation primitive. `counts` records every id already handed out —
// base ids *and* `#N` suffixes — so every caller converges on one `#N` scheme and one
// `id_collision` warning contract. Sibling derivation, the global tree pass, and the
// flat live-hit pass all route through here. When `baseId` is taken, the probe skips
// past suffixes an earlier pass already minted instead of re-colliding with them, then
// registers the chosen id so later collisions step over it too. Reused because explicit
// ids (testID/accessibilityIdentifier) are routinely non-unique — a wrapper defaulting
// testID to an icon name recurs via list .map() or status badges — and validateSnapshot
// hard-throws `duplicate_id` on any tree-wide collision.
function disambiguateId(
  baseId: string,
  counts: Map<string, number>,
  warnings?: SnapshotWarning[],
): string {
  const seen = counts.get(baseId) ?? 0;
  counts.set(baseId, seen + 1);
  if (seen === 0) return baseId;
  let suffix = seen;
  while (counts.has(`${baseId}#${suffix}`)) suffix++;
  const id = `${baseId}#${suffix}`;
  counts.set(id, 1);
  warnings?.push({ code: "id_collision", node: baseId, count: seen + 1 });
  return id;
}

function dedupeNodeId(
  node: { id?: unknown },
  counts: Map<string, number>,
  warnings?: SnapshotWarning[],
): void {
  if (typeof node.id !== "string") return;
  node.id = disambiguateId(node.id, counts, warnings);
}

/**
 * Disambiguate node ids across an entire forest in place, depth-first in document
 * order. Reuses the sibling `#N` suffix and `id_collision` warning so a snapshot whose
 * ids would otherwise collide across parents stays globally unique and passes validation.
 * Pass all roots (tree + overlays) together so ids are unique across them as a set,
 * matching validateSnapshot's shared uniqueness check.
 */
export function dedupeNodeIdsGlobally(
  roots: ReadonlyArray<Node>,
  warnings?: SnapshotWarning[],
): void {
  const counts = new Map<string, number>();
  const visit = (node: Node): void => {
    dedupeNodeId(node, counts, warnings);
    if (node.children) {
      for (const child of node.children) visit(child);
    }
  };
  for (const root of roots) visit(root);
}

/**
 * Disambiguate ids across a flat list of hits in place, in list order. Used by the
 * live-action walker so action target ids match the deduped snapshot ids by construction.
 */
export function dedupeFlatHitIds(hits: ReadonlyArray<{ id: string }>): void {
  const counts = new Map<string, number>();
  for (const hit of hits) dedupeNodeId(hit, counts);
}
