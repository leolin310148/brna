import type { Node, Snapshot } from "@brna/schema";
import { redactSnapshot, type RedactionOptions } from "./redact.js";
import { displayLabel } from "../selector/inferred-label.js";

export function toMarkdown(snapshot: Snapshot, options: RedactionOptions = {}): string {
  snapshot = redactSnapshot(snapshot, options);
  const lines: string[] = [];
  lines.push(headerLine(snapshot));
  lines.push(sessionLine(snapshot));
  lines.push("");
  lines.push("## screen");
  lines.push(...screenBlock(snapshot));
  lines.push("");
  lines.push("## tree");
  if (snapshot.tree) {
    renderNode(snapshot.tree, 0, lines);
  }
  if (snapshot.overlays && snapshot.overlays.length > 0) {
    lines.push("");
    lines.push("## overlays");
    for (const overlay of snapshot.overlays) renderNode(overlay, 0, lines);
  }
  return lines.join("\n") + "\n";
}

export function toActiveLayerMarkdown(snapshot: Snapshot, options: RedactionOptions = {}): string {
  snapshot = redactSnapshot(snapshot, options);
  const lines: string[] = [];
  lines.push(headerLine(snapshot));
  lines.push(sessionLine(snapshot));
  lines.push("");
  lines.push("## active layer");
  const active = activeLayerRoots(snapshot);
  if (active.length === 0) {
    lines.push("- none");
  } else {
    for (const node of active) renderNode(node, 0, lines);
  }
  return lines.join("\n") + "\n";
}

function headerLine(snapshot: Snapshot): string {
  const route = snapshot.screen.route ?? inferScreenSelector(snapshot.tree) ?? "(no route)";
  const model = snapshot.meta.device.model === "unknown"
    ? snapshot.meta.device.platform
    : snapshot.meta.device.model;
  return `# Snapshot · ${route} · ${model}`;
}

function sessionLine(snapshot: Snapshot): string {
  const sid = snapshot.meta.session_id;
  const short = sid.length > 8 ? `${sid.slice(0, 8)}...` : sid;
  return `session: ${short} · ${snapshot.meta.captured_at}`;
}

function screenBlock(snapshot: Snapshot): string[] {
  const out: string[] = [];
  if (snapshot.screen.route) out.push(`route: ${snapshot.screen.route}`);
  else {
    const inferred = inferScreenSelector(snapshot.tree);
    if (inferred) out.push(`inferred_screen: ${inferred}`);
  }
  if (snapshot.screen.title) out.push(`title: ${snapshot.screen.title}`);
  if (snapshot.screen.navigator) out.push(`navigator: ${snapshot.screen.navigator}`);
  if (snapshot.screen.modal_stack && snapshot.screen.modal_stack.length > 0) {
    out.push(`modal_stack: [${snapshot.screen.modal_stack.join(", ")}]`);
  }
  return out;
}

function inferScreenSelector(root: Node): string | null {
  const candidates: Array<{ node: Node; depth: number }> = [];
  collectScreenSelectorCandidates(root, 0, candidates);
  candidates.sort((a, b) => scoreScreenSelectorCandidate(b) - scoreScreenSelectorCandidate(a));
  return candidates[0]?.node.id ?? null;
}

function collectScreenSelectorCandidates(
  node: Node,
  depth: number,
  out: Array<{ node: Node; depth: number }>,
): void {
  if (node.id.startsWith("screen:")) out.push({ node, depth });
  for (const child of node.children ?? []) collectScreenSelectorCandidates(child, depth + 1, out);
}

function scoreScreenSelectorCandidate(candidate: { node: Node; depth: number }): number {
  let score = candidate.depth;
  if (candidate.node.id !== "screen:root") score += 1000;
  if (candidate.node.kind === "list") score += 100;
  if (candidate.node.kind === "screen") score -= 50;
  return score;
}

function activeLayerRoots(snapshot: Snapshot): Node[] {
  const roots: Node[] = [];
  if (snapshot.overlays) roots.push(...snapshot.overlays);
  collectActiveLayerRoots(snapshot.tree, roots, false);
  return dedupeNodes(roots);
}

function collectActiveLayerRoots(node: Node, roots: Node[], insideActive: boolean): void {
  const active = isActiveLayerNode(node);
  if (active && !insideActive) {
    roots.push(node);
    return;
  }
  if (!node.children) return;
  for (const child of node.children) collectActiveLayerRoots(child, roots, insideActive || active);
}

function isActiveLayerNode(node: Node): boolean {
  if (node.kind === "modal" || node.kind === "toast") return true;
  if (node.actions?.includes("dismiss")) return true;
  const id = node.id.toLowerCase();
  if (id.includes("modal") || id.includes("dialog") || id.includes("sheet") || id.includes("popover")) return true;
  const name = node.name?.toLowerCase() ?? "";
  return name.includes("modal") || name.includes("dialog") || name.includes("sheet") || name.includes("popover");
}

function dedupeNodes(nodes: Node[]): Node[] {
  const seen = new Set<string>();
  const out: Node[] = [];
  for (const node of nodes) {
    if (seen.has(node.id)) continue;
    seen.add(node.id);
    out.push(node);
  }
  return out;
}

function renderNode(node: Node, depth: number, lines: string[]): void {
  const indent = "  ".repeat(depth);
  lines.push(`${indent}- ${nodeLine(node)}`);

  if (node.children) {
    const collapsed = collapseLoadingSkeletonInline(node.children);
    for (const child of collapsed) renderNode(child, depth + 1, lines);
  }

  if (node.kind === "list" && node.total_count != null) {
    const visible = node.children?.length ?? 0;
    const omitted = node.total_count - visible;
    if (omitted > 0) {
      const innerIndent = "  ".repeat(depth + 1);
      const position = node.visible_range && node.visible_range.start > 0 ? "above" : "below";
      lines.push(`${innerIndent}- …${omitted} items ${position}…`);
    }
  }
}

// When the runtime upgraded NodeKind from accessibilityRole, rendering the
// role inline duplicates information already in the kind. Suppress only when
// the role's expected kind matches the emitted kind.
const ROLE_TO_KIND: Record<string, string> = {
  button: "button",
  link: "link",
  header: "heading",
  image: "image",
  switch: "toggle",
  checkbox: "toggle",
  slider: "slider",
  adjustable: "slider",
  text: "text",
};

function roleIsRedundant(role: string | undefined, kind: string): boolean {
  if (!role) return false;
  const expected = ROLE_TO_KIND[role];
  return expected !== undefined && expected === kind;
}

export function nodeLine(node: Node): string {
  const parts: string[] = [];
  let head = node.kind;
  if (!node.id.startsWith("auto:")) {
    head += `#${node.id}`;
  }
  parts.push(head);
  if (node.role && node.role !== node.kind && !roleIsRedundant(node.role, node.kind)) {
    parts.push(`[role=${node.role}]`);
  }
  if (node.name) parts.push(`"${displayLabel(node) ?? node.name}"`);
  if (node.value !== undefined) parts.push(`= ${JSON.stringify(node.value)}`);
  const rangeAnnotation = formatRangeAnnotation(node.range);
  if (rangeAnnotation) parts.push(rangeAnnotation);
  if (node.state && node.state.length > 0) parts.push(`[${[...node.state].sort().join(", ")}]`);
  if (node.actions && node.actions.length > 0) {
    const canonical = canonicalSelectorForLine(node);
    const ref = canonical ? ` ${canonical}` : "";
    parts.push(`→ ${node.actions[0]}${ref}`);
  }
  const alternateSelectors = formatAlternateSelectors(node);
  if (alternateSelectors) parts.push(alternateSelectors);
  return parts.join(" ");
}

function canonicalSelectorForLine(node: Node): string | null {
  if (!node.id.startsWith("auto:")) return `#${node.id}`;
  if (node.selector) return node.selector;
  return null;
}

const MARKDOWN_ALTERNATE_SELECTOR_LIMIT = 2;

function formatAlternateSelectors(node: Node): string | null {
  if (!node.suggested_selectors || node.suggested_selectors.length === 0) return null;
  // Drop the canonical (first) entry and any duplicate already shown inline.
  const canonical = node.suggested_selectors[0];
  const inline = canonicalSelectorForLine(node);
  const seen = new Set<string>([canonical ?? "", inline ?? ""]);
  const alternates: string[] = [];
  for (const entry of node.suggested_selectors.slice(1)) {
    if (alternates.length >= MARKDOWN_ALTERNATE_SELECTOR_LIMIT) break;
    if (seen.has(entry)) continue;
    seen.add(entry);
    alternates.push(entry);
  }
  if (alternates.length === 0) return null;
  return `selectors=[${alternates.join(", ")}]`;
}

function formatRangeAnnotation(range: Node["range"]): string | null {
  if (!range) return null;
  if (typeof range.text === "string" && range.text.length > 0) {
    return `[${range.text}]`;
  }
  if (typeof range.now === "number" && typeof range.max === "number") {
    return `[${range.now}/${range.max}]`;
  }
  if (typeof range.now === "number") {
    return `[${range.now}]`;
  }
  return null;
}

function collapseLoadingSkeletonInline(children: Node[]): Node[] {
  const out: Node[] = [];
  let buffer: Node[] = [];
  const flush = () => {
    if (buffer.length === 0) return;
    if (buffer.length === 1) {
      out.push(buffer[0]!);
    } else {
      out.push({
        id: `auto:loading_skeleton`,
        kind: "group",
        name: "loading_skeleton",
        state: ["loading"],
      });
    }
    buffer = [];
  };
  for (const child of children) {
    const isShimmer =
      child.state?.includes("loading") && !child.name && !child.text && !child.children?.length;
    if (isShimmer) {
      buffer.push(child);
    } else {
      flush();
      out.push(child);
    }
  }
  flush();
  return out;
}
