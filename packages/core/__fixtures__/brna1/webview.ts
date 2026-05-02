import type { Snapshot } from "@brna/schema";
import { makeSnapshot } from "./_helpers.js";

export const fixture: Snapshot = makeSnapshot({
  screen: { route: "/legal/tos", title: "Terms of Service", modal_stack: [] },
  tree: {
    id: "screen-tos",
    kind: "screen",
    children: [
      { id: "back-btn", kind: "button", name: "Back", actions: ["tap"] },
      {
        id: "tos-webview",
        kind: "webview",
        name: "Terms of Service",
        url: "https://example.com/legal/tos",
      },
    ],
  },
});
