import type { Snapshot } from "@brna/schema";
import { makeSnapshot } from "./_helpers.js";

export const fixture: Snapshot = makeSnapshot({
  screen: { route: "/home", title: "Home", modal_stack: [] },
  tree: {
    id: "screen-home",
    kind: "screen",
    children: [
      {
        id: "header",
        kind: "region",
        role: "header",
        children: [{ id: "auto:t1", kind: "heading", name: "Home", text: "Home" }],
      },
      {
        id: "sign-in-btn",
        kind: "button",
        name: "Sign In",
        actions: ["tap"],
      },
    ],
  },
});
