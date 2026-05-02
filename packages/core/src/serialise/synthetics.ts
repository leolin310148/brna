import type { Node } from "@brna/schema";

export function synthesiseListPlaceholder(list: Node): {
  position: "above" | "below";
  count: number;
} | null {
  if (list.kind !== "list" || list.total_count == null) return null;
  const visible = list.children?.length ?? 0;
  const omitted = list.total_count - visible;
  if (omitted <= 0) return null;
  const position = list.visible_range && list.visible_range.start > 0 ? "above" : "below";
  return { position, count: omitted };
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
