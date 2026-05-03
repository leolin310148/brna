export const SCHEMA_VERSION = "brna/1" as const;
export type SchemaVersion = typeof SCHEMA_VERSION;

export const NODE_KINDS = [
  "screen",
  "region",
  "group",
  "text",
  "heading",
  "button",
  "link",
  "input",
  "toggle",
  "slider",
  "image",
  "media",
  "list",
  "list_item",
  "modal",
  "toast",
  "webview",
  "unknown",
] as const;
export type NodeKind = (typeof NODE_KINDS)[number];

export const STATE_FLAGS = [
  "disabled",
  "selected",
  "focused",
  "loading",
  "error",
  "expanded",
  "collapsed",
  "checked",
  "unchecked",
  "required",
  "invalid",
  "readonly",
  "secure",
  "offscreen",
  "obscured",
  "pressing",
  "dragging",
] as const;
export type StateFlag = (typeof STATE_FLAGS)[number];

export const ACTIONS = [
  "tap",
  "long_press",
  "type",
  "clear",
  "scroll",
  "swipe",
  "toggle",
  "select",
  "submit",
  "dismiss",
  "navigate",
] as const;
export type Action = (typeof ACTIONS)[number];

// Bounds in screen-window coordinates as reported by RN's measureInWindow.
// Field names are the schema's compact form: w/h, never width/height.
export interface Bounds {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface NodeRange {
  min?: number;
  max?: number;
  now?: number;
  text?: string;
}

export interface AppInfo {
  bundle_id: string;
  version: string;
  rn_version?: string;
}

export interface DeviceInfo {
  platform: "ios" | "android";
  os_version: string;
  model: string;
  viewport: { w: number; h: number; scale: number };
  locale: string;
  layout_direction?: "ltr" | "rtl";
}

export interface SnapshotMeta {
  schema_version: SchemaVersion;
  captured_at: string;
  app: AppInfo;
  device: DeviceInfo;
  session_id: string;
  snapshot_id: string;
  warnings?: SnapshotWarning[];
  source?: string;
}

// Reserved warning codes (free-form strings; documented here for stability):
//   "id_collision"        — emitted by deriveNodeIdsForSiblings on dup ids
//   "bounds_unavailable"  — emitted when measureInWindow times out for a node
export interface SnapshotWarning {
  code: string;
  node?: string;
  count?: number;
  detail?: string;
}

export interface Screen {
  route?: string;
  navigator?: "stack" | "tab" | "drawer" | null;
  title?: string;
  modal_stack: string[];
}

export interface DevEnrichment {
  component?: string;
  source?: string;
  props_subset?: Record<string, unknown>;
  inferred_label?: boolean;
}

export interface Node {
  id: string;
  kind: NodeKind;
  role?: string;
  name?: string;
  text?: string;
  value?: string | number | boolean;
  accessibility_label?: string;
  accessibility_hint?: string;
  range?: NodeRange;
  state?: StateFlag[];
  selector?: string;
  suggested_selectors?: string[];
  actions?: Action[];
  bounds?: Bounds;
  children?: Node[];
  total_count?: number;
  visible_range?: { start: number; end: number };
  url?: string;
  _dev?: DevEnrichment;
}

export interface Snapshot {
  meta: SnapshotMeta;
  screen: Screen;
  tree: Node;
  overlays?: Node[];
}

export interface SerializableRedactionRule {
  match: { source: string; flags?: string };
  replace: string;
}

export interface SnapshotRedactionOptions {
  rules?: SerializableRedactionRule[];
  redactSecureFields?: boolean;
}

export type SelectorAST =
  | { kind: "id"; id: string }
  | { kind: "testid"; testID: string }
  | { kind: "role-name"; role: string; name: string; in?: SelectorAST }
  | { kind: "text"; parts: string[] }
  | { kind: "xpath"; path: string };

export type DiffEvent =
  | { type: "added"; id: string; parent_id?: string; node: Node }
  | { type: "removed"; id: string; parent_id?: string; node: Node }
  | { type: "modified"; id: string; node: Node; changes: ModifiedFieldChange[] }
  | { type: "moved"; id: string; node: Node; from_parent: string; to_parent: string };

export interface ModifiedFieldChange {
  field: "name" | "text" | "value" | "state" | "kind" | "role" | "url";
  before: unknown;
  after: unknown;
}

export interface SnapshotDiff {
  events: DiffEvent[];
}

export interface TraceStep {
  from: Snapshot;
  to: Snapshot;
  event?: string;
}

export interface Trace {
  steps: TraceStep[];
  elapsed_ms?: number;
  label?: string;
}

export interface DeriveNodeIdInput {
  testID?: string;
  accessibilityIdentifier?: string;
  parent_id: string;
  kind: NodeKind;
  role?: string;
  name?: string;
  position_within_kind: number;
}
