/**
 * @brna/core — selector engine, serialisers, and diff for brna/1 snapshots.
 *
 * Public API:
 * - parseSelector / resolve / canonicalSelectorFor / populateSelectors
 *                              the selector grammar parser, resolver (returns ok|none|ambiguous),
 *                              and canonical selector generator.
 * - annotateSuggestedSelectors annotates a snapshot tree with prioritised
 *                              `suggested_selectors` per node (canonical first, capped at 4).
 * - toJSON / fromJSON          deterministic JSON serialisation; round-trips byte-identically.
 * - toYAML / fromYAML          YAML serialisation backed by the `yaml` package with pinned options.
 * - toMarkdown                 deterministic one-way projection for LLM consumers (no fromMarkdown).
 * - synthesiseListPlaceholder(s) computes `…N items above|below…` for virtualised lists.
 * - collapseLoadingSkeleton    folds runs of shimmer placeholders into a single synthetic group.
 * - diff                       O(n+m) id-keyed diff producing added/removed/modified/moved events.
 * - filterDiffByTarget         retain only events touching the target, its ancestors,
 *                              immediate siblings, and overlays.
 * - toDiffMarkdown             deterministic one-way markdown projection for SnapshotDiff.
 * - toDiffJSON/fromDiffJSON    deterministic JSON serialisation for SnapshotDiff.
 * - toDiffYAML/fromDiffYAML    YAML serialisation for SnapshotDiff with pinned options.
 * - toTraceMarkdown            renders a sequence of snapshot steps as a markdown trace.
 */

export * from "./selector/index.js";
export * from "./serialise/index.js";
export * from "./diff/index.js";
