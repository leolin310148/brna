import type { Node, Snapshot, SnapshotRedactionOptions } from "@brna/schema";

const SECURE_REPLACEMENT = "<redacted>";

export type RedactionOptions = SnapshotRedactionOptions;

interface CompiledRule {
  match: RegExp;
  replace: string;
}

export function redactSnapshot(snapshot: Snapshot, options: RedactionOptions = {}): Snapshot {
  const rules = compileRules(options.rules ?? []);
  const redactSecureFields = options.redactSecureFields !== false;
  if (rules.length === 0 && !redactSecureFields) return snapshot;

  const copy = clone(snapshot);
  redactNode(copy.tree, rules, redactSecureFields);
  if (copy.overlays) {
    for (const overlay of copy.overlays) redactNode(overlay, rules, redactSecureFields);
  }
  return copy;
}

function redactNode(node: Node, rules: CompiledRule[], redactSecureFields: boolean): void {
  const secure = redactSecureFields && node.state?.includes("secure") === true;

  for (const key of ["name", "text", "accessibility_label", "accessibility_hint", "url"] as const) {
    const value = node[key];
    if (typeof value === "string") {
      const mirrorsSecureValue =
        secure && (key === "name" || key === "text") && typeof node.value === "string" && value === node.value;
      node[key] = mirrorsSecureValue ? redactSecureString(value) : applyRules(value, rules);
    }
  }

  if (node.value !== undefined) {
    node.value = secure && typeof node.value === "string" ? redactSecureString(node.value) : redactScalar(node.value, rules);
  }
  if (node.range?.text !== undefined) {
    node.range.text = secure ? redactSecureString(node.range.text) : applyRules(node.range.text, rules);
  }
  if (node.children) {
    for (const child of node.children) redactNode(child, rules, redactSecureFields);
  }
}

function redactSecureString(value: string): string {
  return value.length === 0 ? "" : SECURE_REPLACEMENT;
}

function redactScalar(value: string | number | boolean, rules: CompiledRule[]): string | number | boolean {
  return typeof value === "string" ? applyRules(value, rules) : value;
}

function applyRules(value: string, rules: CompiledRule[]): string {
  let out = value;
  for (const rule of rules) {
    rule.match.lastIndex = 0;
    out = out.replace(rule.match, rule.replace);
  }
  return out;
}

function compileRules(rules: NonNullable<RedactionOptions["rules"]>): CompiledRule[] {
  const out: CompiledRule[] = [];
  for (const rule of rules) {
    try {
      const flags = rule.match.flags?.includes("g")
        ? rule.match.flags
        : `${rule.match.flags ?? ""}g`;
      out.push({ match: new RegExp(rule.match.source, flags), replace: rule.replace });
    } catch {
      /* invalid config rules are ignored by serialisation */
    }
  }
  return out;
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}
