import type { Snapshot } from "@brna/schema";
import { makeMeta, makeSnapshot } from "./_helpers.js";

export const fixture: Snapshot = makeSnapshot({
  meta: makeMeta({
    device: {
      platform: "ios",
      os_version: "17.4",
      model: "iPhone 15 Pro",
      viewport: { w: 393, h: 852, scale: 3 },
      locale: "he-IL",
      layout_direction: "rtl",
    },
  }),
  screen: { route: "/he/home", title: "ברוכים הבאים", modal_stack: [] },
  tree: {
    id: "screen-rtl",
    kind: "screen",
    children: [
      { id: "auto:t1", kind: "heading", name: "ברוכים הבאים", text: "ברוכים הבאים" },
      { id: "submit-btn", kind: "button", name: "שלח", actions: ["tap"] },
    ],
  },
});
