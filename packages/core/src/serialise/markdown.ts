import type { Node, Snapshot } from "@brna/schema";
import { redactSnapshot, type RedactionOptions } from "./redact.js";

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

function headerLine(snapshot: Snapshot): string {
  const route = snapshot.screen.route ?? "(no route)";
  const model = snapshot.meta.device.model;
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
  if (snapshot.screen.title) out.push(`title: ${snapshot.screen.title}`);
  if (snapshot.screen.navigator) out.push(`navigator: ${snapshot.screen.navigator}`);
  if (snapshot.screen.modal_stack && snapshot.screen.modal_stack.length > 0) {
    out.push(`modal_stack: [${snapshot.screen.modal_stack.join(", ")}]`);
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
  if (node.name) parts.push(`"${node.name}"`);
  if (node.value !== undefined) parts.push(`= ${JSON.stringify(node.value)}`);
  const rangeAnnotation = formatRangeAnnotation(node.range);
  if (rangeAnnotation) parts.push(rangeAnnotation);
  if (node.state && node.state.length > 0) parts.push(`[${[...node.state].sort().join(", ")}]`);
  if (node.actions && node.actions.length > 0) {
    const ref = node.id.startsWith("auto:") ? "" : ` [#${node.id}]`;
    parts.push(`→ ${node.actions[0]}${ref}`);
  }
  return parts.join(" ");
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
