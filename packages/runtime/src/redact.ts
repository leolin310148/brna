import type { Node, Snapshot, SnapshotRedactionOptions } from "@brna/schema";

const SECURE_REPLACEMENT = "<redacted>";

export function redactSnapshot(snapshot: Snapshot, options: SnapshotRedactionOptions = {}): Snapshot {
  const rules = compileRules(options.rules ?? []);
  const redactSecureFields = options.redactSecureFields !== false;
  if (rules.length === 0 && !redactSecureFields) return snapshot;
  const copy = JSON.parse(JSON.stringify(snapshot)) as Snapshot;
  redactNode(copy.tree, rules, redactSecureFields);
  if (copy.overlays) {
    for (const overlay of copy.overlays) redactNode(overlay, rules, redactSecureFields);
  }
  return copy;
}

function redactNode(
  node: Node,
  rules: Array<{ match: RegExp; replace: string }>,
  redactSecureFields: boolean,
): void {
  const secure = redactSecureFields && node.state?.includes("secure") === true;
  if (node.name !== undefined) {
    node.name = secure && typeof node.value === "string" && node.name === node.value
      ? redactSecureString(node.name)
      : applyRules(node.name, rules);
  }
  if (node.text !== undefined) {
    node.text = secure && typeof node.value === "string" && node.text === node.value
      ? redactSecureString(node.text)
      : applyRules(node.text, rules);
  }
  if (typeof node.value === "string") node.value = secure ? redactSecureString(node.value) : applyRules(node.value, rules);
  if (node.accessibility_label !== undefined) {
    node.accessibility_label = applyRules(node.accessibility_label, rules);
  }
  if (node.accessibility_hint !== undefined) {
    node.accessibility_hint = applyRules(node.accessibility_hint, rules);
  }
  if (node.range?.text !== undefined) node.range.text = secure ? redactSecureString(node.range.text) : applyRules(node.range.text, rules);
  if (Array.isArray(node.suggested_selectors)) {
    node.suggested_selectors = node.suggested_selectors.map((selector) => applyRules(selector, rules));
  }
  if (node.children) {
    for (const child of node.children) redactNode(child, rules, redactSecureFields);
  }
}

function redactSecureString(value: string): string {
  return value.length === 0 ? "" : SECURE_REPLACEMENT;
}

function compileRules(rules: NonNullable<SnapshotRedactionOptions["rules"]>): Array<{ match: RegExp; replace: string }> {
  const out: Array<{ match: RegExp; replace: string }> = [];
  for (const rule of rules) {
    try {
      const flags = rule.match.flags?.includes("g")
        ? rule.match.flags
        : `${rule.match.flags ?? ""}g`;
      out.push({ match: new RegExp(rule.match.source, flags), replace: rule.replace });
    } catch {
      /* ignore invalid serialized regex rules */
    }
  }
  return out;
}

function applyRules(value: string, rules: Array<{ match: RegExp; replace: string }>): string {
  let out = value;
  for (const rule of rules) {
    rule.match.lastIndex = 0;
    out = out.replace(rule.match, rule.replace);
  }
  return out;
}
