import type { Snapshot } from "@brna/schema";
import { makeSnapshot } from "./_helpers.js";

export const fixture: Snapshot = makeSnapshot({
  screen: { route: "/checkout", title: "Checkout", modal_stack: ["address-edit"] },
  tree: {
    id: "screen-checkout",
    kind: "screen",
    children: [
      { id: "auto:t1", kind: "heading", name: "Checkout", text: "Checkout" },
      {
        id: "address-edit",
        kind: "modal",
        children: [
          { id: "auto:t2", kind: "heading", name: "Edit address", text: "Edit address" },
          { id: "street-input", kind: "input", name: "Street", value: "123 Main St" },
          { id: "save-btn", kind: "button", name: "Save", state: ["disabled"], actions: ["tap"] },
          { id: "cancel-btn", kind: "button", name: "Cancel", actions: ["tap"] },
        ],
      },
    ],
  },
});
