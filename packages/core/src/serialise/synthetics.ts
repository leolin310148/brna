import type { Node } from "@brna/schema";

export interface ListPlaceholder {
  position: "above" | "below";
  count: number;
}

export function synthesiseListPlaceholder(list: Node): {
  position: "above" | "below";
  count: number;
} | null {
  return synthesiseListPlaceholders(list)[0] ?? null;
}

export function synthesiseListPlaceholders(list: Node): ListPlaceholder[] {
  if (list.kind !== "list" || list.total_count == null) return [];
  const total = Math.max(0, Math.trunc(list.total_count));
  if (total === 0) return [];

  if (list.visible_range) {
    const start = clampInt(list.visible_range.start, 0, total);
    const end = clampInt(list.visible_range.end, start - 1, total - 1);
    const placeholders: ListPlaceholder[] = [];
    if (start > 0) placeholders.push({ position: "above", count: start });
    const below = total - end - 1;
    if (below > 0) placeholders.push({ position: "below", count: below });
    return placeholders;
  }

  const visible = list.children?.length ?? 0;
  const omitted = total - visible;
  return omitted > 0 ? [{ position: "below", count: omitted }] : [];
}

function clampInt(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, Math.trunc(value)));
}

export function collapseLoadingSkeleton(parent: Node): Node {
  if (!parent.children || parent.children.length === 0) return parent;
  const children: Node[] = [];
  let shimmerRun: Node[] = [];
  const flush = () => {
    if (shimmerRun.length === 0) return;
    if (shimmerRun.length === 1) {
      children.push(shimmerRun[0]!);
    } else {
      children.push({
        id: `auto:loading_skeleton`,
        kind: "group",
        name: "loading_skeleton",
        state: ["loading"],
      });
    }
    shimmerRun = [];
  };
  for (const child of parent.children) {
    const isShimmer =
      child.state?.includes("loading") && !child.name && !child.text && !child.children?.length;
    if (isShimmer) shimmerRun.push(child);
    else {
      flush();
      children.push(collapseLoadingSkeleton(child));
    }
  }
  flush();
  return { ...parent, children };
}
