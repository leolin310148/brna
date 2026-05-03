import { fixture as minimal } from "./minimal.js";
import { fixture as modalStack } from "./modal-stack.js";
import { fixture as virtualisedList } from "./virtualised-list.js";
import { fixture as rtl } from "./rtl.js";
import { fixture as sentinelLabels } from "./sentinel-labels.js";
import { fixture as stickyHeaders } from "./sticky-headers.js";
import { fixture as webview } from "./webview.js";
import { fixture as a11yBoundsWarnings } from "./a11y-bounds-warnings.js";
import { fixture as suggestedSelectors } from "./suggested-selectors.js";
import type { Snapshot } from "@brna/schema";

export interface Fixture {
  name: string;
  snapshot: Snapshot;
}

export const FIXTURES: Fixture[] = [
  { name: "minimal", snapshot: minimal },
  { name: "modal-stack", snapshot: modalStack },
  { name: "virtualised-list", snapshot: virtualisedList },
  { name: "rtl", snapshot: rtl },
  { name: "sentinel-labels", snapshot: sentinelLabels },
  { name: "sticky-headers", snapshot: stickyHeaders },
  { name: "webview", snapshot: webview },
  { name: "a11y-bounds-warnings", snapshot: a11yBoundsWarnings },
  { name: "suggested-selectors", snapshot: suggestedSelectors },
];
