import type { Node, SelectorAST, Snapshot } from "@brna/schema";
import { parseSelector } from "./parse.js";
import { displayLabel } from "./inferred-label.js";

export type ResolveResult =
  | { ok: Node }
  | { none: true }
  | { ambiguous: Node[] };

export function resolve(
  selector: string | SelectorAST,
  snapshot: Snapshot,
): ResolveResult {
  const ast = typeof selector === "string" ? parseSelector(selector) : selector;
  return resolveAst(ast, snapshot);
}

function resolveAst(ast: SelectorAST, snapshot: Snapshot): ResolveResult {
  if (ast.kind === "role-name" && ast.in) {
    const inner = resolveAst(ast.in, snapshot);
    if ("none" in inner) return { none: true };
    if ("ambiguous" in inner) return { ambiguous: inner.ambiguous };
    const region = inner.ok;
    const matches = collectFromRoots([region], (n) => n !== region && matchesLeaf(ast, n));
    return packageResult(matches);
  }
  const roots = collectRoots(snapshot);
  const matches = collectFromRoots(roots, (n) => matchesLeaf(ast, n));
  return packageResult(matches);
}

function collectRoots(snapshot: Snapshot): Node[] {
  const roots: Node[] = [];
  if (snapshot.tree) roots.push(snapshot.tree);
  if (snapshot.overlays) roots.push(...snapshot.overlays);
  return roots;
}

function collectFromRoots(roots: Node[], predicate: (n: Node) => boolean): Node[] {
  const out: Node[] = [];
  for (const root of roots) walk(root, (n) => { if (predicate(n)) out.push(n); });
  return out;
}

function walk(node: Node, visit: (n: Node) => void): void {
  visit(node);
  if (node.children) {
    for (const child of node.children) walk(child, visit);
  }
}

function matchesLeaf(ast: SelectorAST, node: Node): boolean {
  switch (ast.kind) {
    case "id":
      return node.id === ast.id;
    case "testid":
      return node.id === ast.testID;
    case "role-name": {
      if (node.role !== ast.role && node.kind !== ast.role) return false;
      if (node.name === ast.name) return true;
      // Inferred sentinel labels accept their normalized form: a node with raw
      // name `__Sitemap__` and `_dev.inferred_label === true` matches both
      // `role:__Sitemap__` and `role:Sitemap`.
      const display = displayLabel(node);
      return display !== undefined && display !== node.name && display === ast.name;
    }
    case "text": {
      const haystack = node.text ?? node.name ?? "";
      let cursor = 0;
      for (const part of ast.parts) {
        const idx = haystack.indexOf(part, cursor);
        if (idx === -1) return false;
        cursor = idx + part.length;
      }
      return true;
    }
    case "xpath":
      return false;
  }
}

function packageResult(matches: Node[]): ResolveResult {
  if (matches.length === 0) return { none: true };
  if (matches.length === 1) return { ok: matches[0]! };
  return { ambiguous: matches };
}
