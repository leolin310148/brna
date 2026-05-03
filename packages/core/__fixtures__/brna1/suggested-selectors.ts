import type { Snapshot } from "@brna/schema";
import { annotateSuggestedSelectors } from "../../src/selector/suggest.js";
import { populateSelectors } from "../../src/selector/canonical.js";
import { makeMeta, makeSnapshot } from "./_helpers.js";

const base: Snapshot = makeSnapshot({
  meta: makeMeta(),
  screen: { route: "/checkout", title: "Checkout", modal_stack: [] },
  tree: populateSelectors({
    id: "screen-checkout",
    kind: "screen",
    children: [
      // Unique role:name + stable testID — exercises #id, @testID, role:name, scoped variants.
      {
        id: "submit",
        kind: "button",
        role: "button",
        name: "Pay Now",
        actions: ["tap"],
      },
      // Ambiguous role:name — same name in two stable regions, must use scoped selectors.
      {
        id: "form-address",
        kind: "region",
        children: [
          {
            id: "auto:save_address",
            kind: "button",
            role: "button",
            name: "Save",
            actions: ["tap"],
          },
        ],
      },
      {
        id: "form-payment",
        kind: "region",
        children: [
          {
            id: "auto:save_payment",
            kind: "button",
            role: "button",
            name: "Save",
            actions: ["tap"],
          },
        ],
      },
      // Text-fragment fallback — long text without role/name/testID.
      {
        id: "auto:tx-disclaimer",
        kind: "text",
        text: "By continuing you agree to our terms",
      },
    ],
  }),
});

export const fixture: Snapshot = annotateSuggestedSelectors(base);
