import { validateSnapshotDiff, type SnapshotDiff } from "@brna/schema";
import { canonicalStringify } from "../serialise/json.js";
import { fromCanonicalYAML, toCanonicalYAML } from "../serialise/yaml.js";

export function toDiffJSON(diff: SnapshotDiff): string {
  return canonicalStringify(diff, 2) + "\n";
}

export function fromDiffJSON(text: string): SnapshotDiff {
  const value = JSON.parse(text);
  validateSnapshotDiff(value);
  return value;
}

export function toDiffYAML(diff: SnapshotDiff): string {
  return toCanonicalYAML(diff);
}

export function fromDiffYAML(text: string): SnapshotDiff {
  const value = fromCanonicalYAML(text);
  validateSnapshotDiff(value);
  return value;
}
