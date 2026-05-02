import type { DiffEvent, ModifiedFieldChange, SnapshotDiff, StateFlag } from "@brna/schema";
import { nodeLine } from "../serialise/markdown.js";

const FIELD_ORDER: ModifiedFieldChange["field"][] = [
  "kind",
  "role",
  "name",
  "text",
  "value",
  "url",
  "state",
];

export function toDiffMarkdown(diff: SnapshotDiff): string {
  if (diff.events.length === 0) return "";
  return diff.events.map(formatEvent).join("\n") + "\n";
}

function formatEvent(event: DiffEvent): string {
  switch (event.type) {
    case "added":
      return `+ ${nodeLine(event.node)}`;
    case "removed":
      return `- ${nodeLine(event.node)}`;
    case "modified":
      return `~ ${nodeLine(event.node)} ${formatChanges(event.changes)}`;
    case "moved":
      return `↻ ${nodeLine(event.node)} ${formatParent(event.from_parent)} → ${formatParent(event.to_parent)}`;
  }
}

function formatChanges(changes: ModifiedFieldChange[]): string {
  const byField = new Map(changes.map((change) => [change.field, change]));
  return FIELD_ORDER.flatMap((field) => {
    const change = byField.get(field);
    if (!change) return [];
    return field === "state" ? formatStateChange(change) : formatScalarChange(change);
  }).join(", ");
}

function formatScalarChange(change: ModifiedFieldChange): string {
  return `${change.field}=${String(JSON.stringify(change.before))} → ${String(JSON.stringify(change.after))}`;
}

function formatStateChange(change: ModifiedFieldChange): string {
  const before = new Set((Array.isArray(change.before) ? change.before : []) as StateFlag[]);
  const after = new Set((Array.isArray(change.after) ? change.after : []) as StateFlag[]);
  const added = [...after].filter((flag) => !before.has(flag)).sort().map((flag) => `+${flag}`);
  const removed = [...before].filter((flag) => !after.has(flag)).sort().map((flag) => `-${flag}`);
  return `state[${[...added, ...removed].join(", ")}]`;
}

function formatParent(parentId: string): string {
  return parentId.length === 0 ? "<root>" : parentId;
}
