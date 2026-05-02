import type { TraceStep } from "@brna/schema";
import { diff } from "./diff.js";
import { toDiffMarkdown } from "./markdown.js";

export function toTraceMarkdown(steps: TraceStep[], opts?: { label?: string; elapsed_ms?: number }): string {
  const lines: string[] = [];
  const header = ["# Trace"];
  if (opts?.label) header.push(`· ${opts.label}`);
  header.push(`· ${steps.length} step${steps.length === 1 ? "" : "s"}`);
  if (opts?.elapsed_ms != null) header.push(`· ${(opts.elapsed_ms / 1000).toFixed(1)}s elapsed`);
  lines.push(header.join(" "));
  lines.push("");

  steps.forEach((step, i) => {
    const stepNum = i + 1;
    const eventLabel = step.event ? ` (after ${step.event})` : "";
    lines.push(`## step ${stepNum} → ${stepNum + 1}${eventLabel}`);
    const body = toDiffMarkdown(diff(step.from, step.to));
    if (body.length > 0) lines.push(...body.trimEnd().split("\n"));
    lines.push("");
  });

  return lines.join("\n").replace(/\n+$/, "\n");
}
