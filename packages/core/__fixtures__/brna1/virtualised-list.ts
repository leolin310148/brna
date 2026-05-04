import type { Node, Snapshot } from "@brna/schema";
import { makeSnapshot } from "./_helpers.js";

const items: Node[] = Array.from({ length: 5 }).map((_, i) => ({
  id: `item-${i}`,
  kind: "list_item",
  index: i,
  name: `Item ${i + 1}`,
  text: `Item ${i + 1}`,
  ...(i === 0
    ? {
        children: [
          {
            id: "item-0-thumb",
            kind: "image" as const,
            image_source: "42",
          },
        ],
      }
    : {}),
}));

export const fixture: Snapshot = makeSnapshot({
  screen: { route: "/feed", title: "Feed", modal_stack: [] },
  tree: {
    id: "screen-feed",
    kind: "screen",
    children: [
      {
        id: "feed-list",
        kind: "list",
        total_count: 1000,
        visible_range: { start: 0, end: 4 },
        children: items,
      },
    ],
  },
});
