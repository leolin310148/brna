import type { Snapshot } from "@brna/schema";
import { makeMeta, makeSnapshot } from "./_helpers.js";

export const fixture: Snapshot = makeSnapshot({
  meta: makeMeta({ source: "InferredScreen.tsx:12:4" }),
  screen: { route: "/inferred", title: "Inferred labels", modal_stack: [] },
  tree: {
    id: "screen-inferred",
    kind: "screen",
    children: [
      {
        id: "btn-1",
        kind: "button",
        name: "__Submit__",
        actions: ["tap"],
        _dev: { inferred_label: true, source: "InferredScreen.tsx:14:6" },
      },
      {
        id: "btn-2",
        kind: "button",
        name: "__Delete (icon)__",
        actions: ["tap"],
        _dev: { inferred_label: true, component: "TrashIcon" },
      },
      {
        id: "btn-3",
        kind: "button",
        name: "Real Submit",
        actions: ["tap"],
      },
    ],
  },
});
