import type { Snapshot } from "@brna/schema";
import { makeMeta, makeSnapshot } from "./_helpers.js";

export const fixture: Snapshot = makeSnapshot({
  meta: makeMeta({
    warnings: [{ code: "bounds_unavailable", node: "ghost-view" }],
  }),
  screen: { route: "/a11y-demo", title: "A11y Demo", modal_stack: [] },
  tree: {
    id: "screen-a11y",
    kind: "screen",
    bounds: { x: 0, y: 0, w: 393, h: 852 },
    children: [
      {
        id: "add-btn",
        kind: "button",
        role: "button",
        name: "Add to cart",
        accessibility_label: "Add to cart",
        accessibility_hint: "Adds the item to your cart",
        bounds: { x: 16, y: 60, w: 361, h: 48 },
      },
      {
        id: "page-heading",
        kind: "heading",
        role: "header",
        name: "Settings",
        bounds: { x: 16, y: 120, w: 200, h: 32 },
      },
      {
        id: "notifications-toggle",
        kind: "toggle",
        role: "switch",
        name: "Notifications",
        accessibility_label: "Notifications",
        state: ["checked"],
        bounds: { x: 16, y: 168, w: 361, h: 44 },
      },
      {
        id: "volume-slider",
        kind: "slider",
        role: "slider",
        name: "Volume",
        accessibility_label: "Volume",
        range: { min: 0, max: 100, now: 70 },
        bounds: { x: 16, y: 224, w: 361, h: 32 },
      },
      {
        id: "loading-banner",
        kind: "group",
        accessibility_label: "Refreshing",
        name: "Refreshing",
        state: ["loading"],
        bounds: { x: 16, y: 272, w: 361, h: 24 },
      },
      {
        id: "ghost-view",
        kind: "group",
        bounds: { x: 0, y: 0, w: 0, h: 0 },
      },
    ],
  },
});
