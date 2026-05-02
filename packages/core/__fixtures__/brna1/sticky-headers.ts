import type { Snapshot } from "@brna/schema";
import { makeSnapshot } from "./_helpers.js";

export const fixture: Snapshot = makeSnapshot({
  screen: { route: "/sectioned", title: "Sectioned", modal_stack: [] },
  tree: {
    id: "screen-sectioned",
    kind: "screen",
    children: [
      {
        id: "sectioned-list",
        kind: "list",
        children: [
          { id: "sec-a-header", kind: "heading", name: "Section A", text: "Section A" },
          { id: "item-a1", kind: "list_item", name: "Apple", text: "Apple" },
          { id: "item-a2", kind: "list_item", name: "Avocado", text: "Avocado" },
          { id: "sec-b-header", kind: "heading", name: "Section B", text: "Section B" },
          { id: "item-b1", kind: "list_item", name: "Banana", text: "Banana" },
        ],
      },
    ],
  },
});
