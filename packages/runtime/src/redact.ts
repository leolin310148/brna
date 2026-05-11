import type { Node, Snapshot, SnapshotRedactionOptions } from "@brna/schema";

const SECURE_REPLACEMENT = "<redacted>";

interface CompiledRule {
  match: RegExp;
  replace: string;
}

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
  rules: CompiledRule[],
  redactSecureFields: boolean,
): void {
  const secure = redactSecureFields && node.state?.includes("secure") === true;
  const secureValue = secure && node.value !== undefined ? String(node.value) : undefined;

  for (const key of ["name", "text", "accessibility_label", "accessibility_hint", "url"] as const) {
    const value = node[key];
    if (typeof value !== "string") continue;
    const mirrorsSecureValue = secureValue !== undefined && value === secureValue;
    node[key] = mirrorsSecureValue ? redactSecureString(value) : applyRules(value, rules);
  }

  if (node.value !== undefined) {
    node.value = secure ? redactSecureScalar(node.value) : redactScalar(node.value, rules);
  }
  if (node.range?.text !== undefined) node.range.text = secure ? redactSecureString(node.range.text) : applyRules(node.range.text, rules);
  if (Array.isArray(node.suggested_selectors)) {
    node.suggested_selectors = node.suggested_selectors.map((selector) =>
      redactSuggestedSelector(selector, secureValue, rules),
    );
  }
  if (node.children) {
    for (const child of node.children) redactNode(child, rules, redactSecureFields);
  }
}

function redactSecureString(value: string): string {
  return value.length === 0 ? "" : SECURE_REPLACEMENT;
}

function redactSecureScalar(value: NonNullable<Node["value"]>): string {
  return typeof value === "string" ? redactSecureString(value) : SECURE_REPLACEMENT;
}

function redactScalar(value: NonNullable<Node["value"]>, rules: CompiledRule[]): NonNullable<Node["value"]> {
  return typeof value === "string" ? applyRules(value, rules) : value;
}

function redactSuggestedSelector(
  selector: string,
  secureValue: string | undefined,
  rules: CompiledRule[],
): string {
  const redacted =
    secureValue !== undefined && secureValue.length > 0
      ? selector.split(secureValue).join(SECURE_REPLACEMENT)
      : selector;
  return applyRules(redacted, rules);
}

function compileRules(rules: NonNullable<SnapshotRedactionOptions["rules"]>): CompiledRule[] {
  const out: CompiledRule[] = [];
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

function applyRules(value: string, rules: CompiledRule[]): string {
  let out = value;
  for (const rule of rules) {
    rule.match.lastIndex = 0;
    out = out.replace(rule.match, rule.replace);
  }
  return out;
}
