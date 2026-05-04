import type { Node, Snapshot } from "@brna/schema";
import { canonicalSelectorFor } from "./canonical.js";
import { resolve } from "./resolve.js";
import { displayLabel } from "./inferred-label.js";

const MAX_SUGGESTIONS = 4;
const MAX_TEXT_FRAGMENT_PARTS = 3;

function isStableId(id: string): boolean {
  return !id.startsWith("auto:");
}

function nearestStableAncestor(ancestors: Node[]): Node | undefined {
  for (let i = ancestors.length - 1; i >= 0; i--) {
    const a = ancestors[i]!;
    if (isStableId(a.id)) return a;
  }
  return undefined;
}

function uniquelyResolvesTo(selector: string, snapshot: Snapshot, target: Node): boolean {
  try {
    const r = resolve(selector, snapshot);
    return "ok" in r && r.ok.id === target.id;
  } catch {
    return false;
  }
}

function textFragmentCandidates(haystack: string): string[] {
  const words = haystack.trim().split(/\s+/).filter((w) => w.length > 0);
  if (words.length < 2) return [];
  const out: string[] = [];
  // Two-part fragment: first word ... last word.
  out.push(`${words[0]}...${words[words.length - 1]}`);
  // Three-part fragment when long enough.
  if (words.length >= 3) {
    const mid = words[Math.floor(words.length / 2)]!;
    if (mid !== words[0] && mid !== words[words.length - 1]) {
      out.push(`${words[0]}...${mid}...${words[words.length - 1]}`);
    }
  }
  return out.slice(0, MAX_TEXT_FRAGMENT_PARTS);
}

function generateForNode(
  node: Node,
  ancestors: Node[],
  snapshot: Snapshot,
): string[] | undefined {
  const canonical = canonicalSelectorFor(node, ancestors);
  const out: string[] = [];
  const seen = new Set<string>();
  const push = (selector: string): void => {
    if (out.length >= MAX_SUGGESTIONS) return;
    if (seen.has(selector)) return;
    if (!uniquelyResolvesTo(selector, snapshot, node)) return;
    seen.add(selector);
    out.push(selector);
  };

  // Canonical selector is always first.
  push(canonical);

  if (isStableId(node.id)) {
    push(`#${node.id}`);
    push(`@${node.id}`);
  }

  const roleOrKind = node.role ?? node.kind;
  if (roleOrKind && node.name) {
    const display = displayLabel(node) ?? node.name;
    // Prefer the normalized label (e.g. `button:Sitemap` over
    // `button:__Sitemap__`); fall back to the raw form so selectors copied
    // verbatim from older snapshots still resolve.
    push(`${roleOrKind}:${display}`);
    if (display !== node.name) push(`${roleOrKind}:${node.name}`);
    const ancestor = nearestStableAncestor(ancestors);
    if (ancestor) {
      push(`${roleOrKind}:${display} in #${ancestor.id}`);
      if (display !== node.name) {
        push(`${roleOrKind}:${node.name} in #${ancestor.id}`);
      }
    }
  }

  const haystack = node.text ?? node.name ?? "";
  if (haystack.length > 0) {
    for (const candidate of textFragmentCandidates(haystack)) {
      push(candidate);
    }
  }

  if (out.length === 0) return undefined;
  return out;
}

/**
 * Return a snapshot whose tree (and overlays) carry `suggested_selectors` on
 * each node. The first entry of `suggested_selectors` always equals the
 * node's canonical `selector`. Entries are filtered so each one uniquely
 * resolves back to that node, and the array is capped at 4 entries.
 *
 * This is a pure helper. It does not mutate the input snapshot.
 */
export function annotateSuggestedSelectors(snapshot: Snapshot): Snapshot {
  const annotateNode = (node: Node, ancestors: Node[]): Node => {
    const suggestions = generateForNode(node, ancestors, snapshot);
    const out: Node = { ...node };
    if (!out.selector) {
      out.selector = canonicalSelectorFor(node, ancestors);
    }
    if (suggestions && suggestions.length > 0) {
      out.suggested_selectors = suggestions;
    }
    if (node.children) {
      out.children = node.children.map((c) => annotateNode(c, [...ancestors, node]));
    }
    return out;
  };

  const tree = annotateNode(snapshot.tree, []);
  const overlays = snapshot.overlays?.map((o) => annotateNode(o, []));
  return overlays ? { ...snapshot, tree, overlays } : { ...snapshot, tree };
}
