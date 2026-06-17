/**
 * @brna/schema — the brna/1 snapshot contract.
 *
 * Public API:
 * - SCHEMA_VERSION              the literal "brna/1" version constant.
 * - NODE_KINDS / STATE_FLAGS    closed enums (frozen `as const` arrays).
 * - Snapshot, Node, Meta, ...   TypeScript types describing the snapshot shape.
 * - SelectorAST                 discriminated AST for the selector grammar.
 * - SnapshotDiff, Trace         diff and trace data structures.
 * - deriveNodeId                priority-ordered stable id derivation (testID > a11yId > positional FNV-1a).
 * - deriveNodeIdsForSiblings    collision-aware sibling ids with `id_collision` warnings.
 * - dedupeNodeIdsGlobally       extends `#N`/`id_collision` disambiguation across a whole forest.
 * - dedupeFlatHitIds            same disambiguation over a flat hit list (live action targets).
 * - fnv1a32                     32-bit FNV-1a hash returning 8-hex (used by deriveNodeId).
 * - validateSnapshot            walks the tree, enforces structural and sentinel rules, throws on violation.
 * - validateSnapshotDiff        validates SnapshotDiff event payloads, node context, and modified fields.
 * - BrnaValidationError         thrown by validate.
 * - BrnaSelectorParseError      thrown by parseSelector in @brna/core.
 */

export * from "./types.js";
export * from "./errors.js";
export * from "./identity.js";
export * from "./validate.js";
export * from "./actions.js";
export * from "./observability.js";
export { JSON_SCHEMA } from "./schema-json.js";
