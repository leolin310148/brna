import type { Node, NodeKind, NodeRange, StateFlag } from "@brna/schema";
import { deriveNodeIdsForSiblings } from "@brna/schema";
import type { SnapshotWarning } from "@brna/schema";
import type { AnyFiber, FiberRoot } from "./devtools.js";

const TEXT_HOST_NAMES = new Set<string>(["RCTText", "RCTRawText", "Text"]);
const VIEW_HOST_NAMES = new Set<string>(["RCTView", "View"]);
const INPUT_HOST_NAMES = new Set<string>([
  "RCTSinglelineTextInputView",
  "RCTMultilineTextInputView",
  "AndroidTextInput",
  "TextInput",
]);
const SCROLL_HOST_NAMES = new Set<string>([
  "RCTScrollView",
  "AndroidHorizontalScrollView",
  "ScrollView",
]);
const IMAGE_HOST_NAMES = new Set<string>(["RCTImageView", "RCTImage", "Image"]);

const ROLE_TO_KIND: Record<string, NodeKind> = {
  button: "button",
  link: "link",
  header: "heading",
  image: "image",
  switch: "toggle",
  checkbox: "toggle",
  slider: "slider",
  adjustable: "slider",
  text: "text",
};

const ICON_NAME_LABELS: Record<string, string> = {
  add: "Add",
  plus: "Add",
  create: "Add",
  trash: "Delete",
  delete: "Delete",
  remove: "Delete",
  edit: "Edit",
  pencil: "Edit",
  search: "Search",
  close: "Close",
  x: "Close",
  check: "Confirm",
  "check-circle": "Confirm",
  save: "Save",
  settings: "Settings",
  gear: "Settings",
  menu: "Menu",
  home: "Home",
  user: "Profile",
  profile: "Profile",
  back: "Back",
  "arrow-left": "Back",
  "chevron-left": "Back",
  next: "Next",
  "arrow-right": "Next",
  "chevron-right": "Next",
};

const ICON_PROP_NAMES = ["name", "icon", "glyph"] as const;

function hostName(fiber: AnyFiber): string | null {
  return typeof fiber.type === "string" ? fiber.type : null;
}

function isRecognisedHost(name: string): boolean {
  return (
    TEXT_HOST_NAMES.has(name) ||
    VIEW_HOST_NAMES.has(name) ||
    INPUT_HOST_NAMES.has(name) ||
    SCROLL_HOST_NAMES.has(name) ||
    IMAGE_HOST_NAMES.has(name)
  );
}

function readProps(fiber: AnyFiber): Record<string, unknown> {
  return (fiber.memoizedProps ?? fiber.pendingProps ?? {}) as Record<string, unknown>;
}

function heuristicKind(fiber: AnyFiber): NodeKind | null {
  const name = hostName(fiber);
  if (!name || !isRecognisedHost(name)) return null;
  if (TEXT_HOST_NAMES.has(name)) return "text";
  if (INPUT_HOST_NAMES.has(name)) return "input";
  if (SCROLL_HOST_NAMES.has(name)) return "list";
  if (IMAGE_HOST_NAMES.has(name)) return "image";
  const props = readProps(fiber);
  const onResponderRelease = props.onResponderRelease;
  const onClick = props.onClick;
  const onPress = props.onPress;
  const onLongPress = props.onLongPress;
  if (
    typeof onResponderRelease === "function" ||
    typeof onClick === "function" ||
    typeof onPress === "function" ||
    typeof onLongPress === "function"
  ) {
    return "button";
  }
  return "group";
}

export function mapHostToNodeKind(fiber: AnyFiber): NodeKind | null {
  const heuristic = heuristicKind(fiber);
  if (!heuristic) return null;
  const props = readProps(fiber);
  const role = props.accessibilityRole;
  if (typeof role === "string" && role in ROLE_TO_KIND) {
    return ROLE_TO_KIND[role]!;
  }
  return heuristic;
}

interface HostHit {
  fiber: AnyFiber;
  kind: NodeKind;
  totalCount?: number;
  itemIndex?: number;
  visibleRange?: VisibleRange;
}

interface CollectContext {
  totalCount?: number;
  itemIndex?: number;
  itemHostClaimed?: boolean;
  visibleRange?: VisibleRange;
}

interface VisibleRange {
  start: number;
  end: number;
}

function collectHostFibers(start: AnyFiber | null, out: HostHit[], context: CollectContext = {}): void {
  let fiber: AnyFiber | null = start;
  while (fiber) {
    const fiberContext = deriveCollectContext(fiber, context);
    const kind = mapHostToNodeKindWithContext(fiber, fiberContext);
    if (kind) {
      const hit: HostHit = {
        fiber,
        kind,
        ...(kind === "list" && fiberContext.totalCount !== undefined ? { totalCount: fiberContext.totalCount } : {}),
        ...(kind === "list" && fiberContext.visibleRange !== undefined ? { visibleRange: fiberContext.visibleRange } : {}),
        ...(kind === "list_item" && fiberContext.itemIndex !== undefined ? { itemIndex: fiberContext.itemIndex } : {}),
      };
      if (kind === "list_item") fiberContext.itemHostClaimed = true;
      out.push(hit);
      const children: HostHit[] = [];
      collectHostFibers(fiber.child, children, fiberContext);
      // capture for nested-text resolution; descendants belong to this host's subtree
      (hit as HostHit & { _children?: HostHit[] })._children = children;
    } else {
      collectHostFibers(fiber.child, out, fiberContext);
    }
    fiber = fiber.sibling;
  }
}

function mapHostToNodeKindWithContext(fiber: AnyFiber, context: CollectContext): NodeKind | null {
  const kind = mapHostToNodeKind(fiber);
  if (kind === "group" && context.itemIndex !== undefined && context.itemHostClaimed !== true) {
    return "list_item";
  }
  return kind;
}

function deriveCollectContext(fiber: AnyFiber, context: CollectContext): CollectContext {
  let next = context;
  const totalCount = readVirtualizedListTotalCount(fiber);
  if (totalCount !== undefined) {
    next = { ...next, totalCount };
  }
  const visibleRange = readVirtualizedListVisibleRange(fiber);
  if (visibleRange !== undefined) {
    next = { ...next, visibleRange };
  }
  const itemIndex = readVirtualizedItemIndex(fiber);
  if (itemIndex !== undefined && next.totalCount !== undefined) {
    next = { ...next, itemIndex, itemHostClaimed: false };
  }
  return next;
}

export interface ExtractedFields {
  testID?: string;
  accessibilityIdentifier?: string;
  name?: string;
  text?: string;
  value?: string;
  accessibility_label?: string;
  accessibility_hint?: string;
  icon_label?: string;
  handler_label?: string;
  role?: string;
  state?: StateFlag[];
  range?: NodeRange;
  source?: string;
  image_source?: string;
}

const INFERRED_LABEL_MAX_WORDS = 5;
const INTERACTIVE_INFERRED_KINDS = new Set<NodeKind>(["button", "link"]);

export function countInferredLabels(nodes: Node[]): number {
  let count = 0;
  for (const node of nodes) {
    if (node._dev?.inferred_label === true) count += 1;
    if (node.children && node.children.length > 0) {
      count += countInferredLabels(node.children);
    }
  }
  return count;
}

export function findFirstSource(nodes: Node[]): string | undefined {
  for (const node of nodes) {
    if (node._dev && typeof node._dev.source === "string" && node._dev.source.length > 0) {
      return node._dev.source;
    }
    if (node.children && node.children.length > 0) {
      const found = findFirstSource(node.children);
      if (found) return found;
    }
  }
  return undefined;
}

function findDescendantText(nodes: Node[]): string | undefined {
  for (const n of nodes) {
    if (n.kind === "text" && typeof n.name === "string" && n.name.length > 0) {
      return n.name;
    }
    if (n.children && n.children.length > 0) {
      const found = findDescendantText(n.children);
      if (found) return found;
    }
  }
  return undefined;
}

function humaniseTestId(testID: string): string {
  // Convert kebab-case, snake_case, or camelCase into Title Case words.
  const spaced = testID
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .trim();
  if (spaced.length === 0) return testID;
  return spaced
    .split(/\s+/)
    .map((word) => (word.length > 0 ? word[0]!.toUpperCase() + word.slice(1) : word))
    .join(" ");
}

function truncateToWords(text: string, maxWords: number): string {
  const trimmed = text.trim();
  const words = trimmed.split(/\s+/);
  if (words.length <= maxWords) return trimmed;
  return words.slice(0, maxWords).join(" ");
}

function extractTextString(fiber: AnyFiber): string | undefined {
  const props = readProps(fiber);
  const children = props.children;
  if (typeof children === "string") return children;
  if (typeof children === "number") return String(children);
  if (Array.isArray(children)) {
    const parts = children.filter(
      (c): c is string | number => typeof c === "string" || typeof c === "number",
    );
    if (parts.length > 0) return parts.join("");
  }
  return undefined;
}

function normaliseIconName(value: string): string {
  return value
    .replace(/Icon$/i, "")
    .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
    .replace(/[_\s]+/g, "-")
    .toLowerCase();
}

function labelFromIconName(value: string): string | undefined {
  const key = normaliseIconName(value);
  const mapped = ICON_NAME_LABELS[key];
  if (mapped) return `${mapped} (icon)`;
  const words = key.split("-").filter(Boolean);
  if (words.length === 0 || words.length > INFERRED_LABEL_MAX_WORDS) return undefined;
  return `${words.map((w) => w.slice(0, 1).toUpperCase() + w.slice(1)).join(" ")} (icon)`;
}

function isLikelyIconFiber(fiber: AnyFiber): boolean {
  const t = fiber.type;
  if (typeof t === "string") return /icon/i.test(t);
  if (typeof t === "function") return /icon/i.test(t.name);
  if (t && typeof t === "object") {
    const displayName = (t as { displayName?: unknown }).displayName;
    if (typeof displayName === "string") return /icon/i.test(displayName);
  }
  return false;
}

function findDescendantIconLabel(start: AnyFiber | null): string | undefined {
  let fiber = start;
  while (fiber) {
    const props = readProps(fiber);
    if (isLikelyIconFiber(fiber)) {
      for (const key of ICON_PROP_NAMES) {
        const raw = props[key];
        if (typeof raw === "string" && raw.length > 0) {
          const label = labelFromIconName(raw);
          if (label) return label;
        }
      }
    }
    const fromChild = findDescendantIconLabel(fiber.child);
    if (fromChild) return fromChild;
    fiber = fiber.sibling;
  }
  return undefined;
}

function labelFromHandlerName(name: string): string | undefined {
  const stripped = name
    .replace(/^(handle|on)/, "")
    .replace(/Press$/, "")
    .replace(/Click$/, "");
  if (stripped.length === 0 || stripped === name) return undefined;
  const words = stripped
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .trim();
  if (!words) return undefined;
  return words.slice(0, 1).toUpperCase() + words.slice(1);
}

function findHandlerLabel(props: Record<string, unknown>): string | undefined {
  for (const key of ["onPress", "onClick", "onResponderRelease", "onLongPress"]) {
    const handler = props[key];
    if (typeof handler !== "function") continue;
    const name = handler.name;
    if (typeof name !== "string" || name.length === 0) continue;
    const label = labelFromHandlerName(name);
    if (label) return label;
  }
  return undefined;
}

function extractAccessibilityState(props: Record<string, unknown>): StateFlag[] | undefined {
  const raw = props.accessibilityState;
  if (!raw || typeof raw !== "object") return undefined;
  const obj = raw as Record<string, unknown>;
  const flags: StateFlag[] = [];
  if (obj.disabled === true) flags.push("disabled");
  if (obj.selected === true) flags.push("selected");
  if (obj.checked === true) flags.push("checked");
  if (obj.expanded === true) flags.push("expanded");
  if (obj.busy === true) flags.push("loading");
  return flags.length > 0 ? flags : undefined;
}

function extractAccessibilityRange(props: Record<string, unknown>): NodeRange | undefined {
  const raw = props.accessibilityValue;
  if (!raw || typeof raw !== "object") return undefined;
  const obj = raw as Record<string, unknown>;
  const out: NodeRange = {};
  if (typeof obj.min === "number" && Number.isFinite(obj.min)) out.min = obj.min;
  if (typeof obj.max === "number" && Number.isFinite(obj.max)) out.max = obj.max;
  if (typeof obj.now === "number" && Number.isFinite(obj.now)) out.now = obj.now;
  if (typeof obj.text === "string") out.text = obj.text;
  if (out.min === undefined && out.max === undefined && out.now === undefined && out.text === undefined) {
    return undefined;
  }
  return out;
}

export function extractNodeFields(hit: HostHit): ExtractedFields {
  const fiber = hit.fiber;
  const props = readProps(fiber);
  const out: ExtractedFields = {};
  if (typeof props.testID === "string" && props.testID.length > 0) {
    out.testID = props.testID;
  }
  if (
    typeof props.accessibilityIdentifier === "string" &&
    props.accessibilityIdentifier.length > 0
  ) {
    out.accessibilityIdentifier = props.accessibilityIdentifier;
  }
  if (hit.kind === "text") {
    out.name = extractTextString(fiber);
  }
  if (hit.kind === "input") {
    const value = extractInputValue(fiber, props);
    if (value !== undefined) out.value = value;
    if (typeof props.placeholder === "string" && props.placeholder.length > 0) {
      out.text = props.placeholder;
    }
  }
  if (typeof props.accessibilityLabel === "string") {
    out.accessibility_label = props.accessibilityLabel;
    if (out.name === undefined || out.name.length === 0) {
      if (props.accessibilityLabel.length > 0) {
        out.name = props.accessibilityLabel;
      }
    }
  }
  if (typeof props.accessibilityHint === "string") {
    out.accessibility_hint = props.accessibilityHint;
  }
  if (INTERACTIVE_INFERRED_KINDS.has(hit.kind)) {
    const iconLabel = findDescendantIconLabel(fiber.child);
    if (iconLabel) out.icon_label = iconLabel;
    const handlerLabel = findHandlerLabel(props);
    if (handlerLabel) out.handler_label = handlerLabel;
  }
  if (typeof props.accessibilityRole === "string") {
    out.role = props.accessibilityRole;
  }
  const state = extractAccessibilityState(props);
  if (state) out.state = state;
  if (hit.kind === "input") {
    const inputFlags: StateFlag[] = [];
    if (props.secureTextEntry === true) inputFlags.push("secure");
    if (props.editable === false) inputFlags.push("readonly");
    if (inputFlags.length > 0) {
      out.state = out.state ? [...out.state, ...inputFlags] : inputFlags;
    }
  }
  const range = extractAccessibilityRange(props);
  if (range) out.range = range;
  const source = extractSource(fiber, props);
  if (source) out.source = source;
  if (hit.kind === "image") {
    const imageSource = extractImageSource(props.source);
    if (imageSource) out.image_source = imageSource;
  }
  return out;
}

function extractInputValue(fiber: AnyFiber, props: Record<string, unknown>): string | undefined {
  for (const value of [
    props.value,
    props.defaultValue,
    readInputStateNodeValue(fiber.stateNode),
  ]) {
    if (typeof value === "string") return value;
    if (typeof value === "number" && Number.isFinite(value)) return String(value);
  }
  return undefined;
}

function readInputStateNodeValue(stateNode: unknown): unknown {
  if (!stateNode || typeof stateNode !== "object") return undefined;
  const obj = stateNode as Record<string, unknown>;
  for (const key of ["_lastNativeText", "lastNativeText", "text", "value"]) {
    const value = obj[key];
    if (typeof value === "string" || typeof value === "number") return value;
  }
  const nativeProps = obj.props;
  if (nativeProps && typeof nativeProps === "object") {
    const props = nativeProps as Record<string, unknown>;
    return props.value ?? props.text ?? props.defaultValue;
  }
  return undefined;
}

function extractImageSource(source: unknown): string | undefined {
  if (typeof source === "string" && source.length > 0) return isInlineDataImage(source) ? undefined : source;
  if (typeof source === "number" && Number.isFinite(source)) return String(source);
  if (Array.isArray(source)) {
    for (const entry of source) {
      const found = extractImageSource(entry);
      if (found) return found;
    }
    return undefined;
  }
  if (!source || typeof source !== "object") return undefined;
  const uri = (source as Record<string, unknown>).uri;
  if (typeof uri === "string" && uri.length > 0) return isInlineDataImage(uri) ? undefined : uri;
  return undefined;
}

function isInlineDataImage(value: string): boolean {
  return /^data:image\//i.test(value);
}

function componentName(value: unknown): string | undefined {
  if (typeof value === "function" && value.name.length > 0) return value.name;
  if (typeof value === "string") return value;
  if (value && typeof value === "object") {
    const displayName = (value as { displayName?: unknown }).displayName;
    if (typeof displayName === "string" && displayName.length > 0) return displayName;
    const render = (value as { render?: unknown }).render;
    if (typeof render === "function" && render.name.length > 0) return render.name;
  }
  return undefined;
}

function isVirtualizedListComponent(fiber: AnyFiber): boolean {
  const name = componentName(fiber.type) ?? componentName(fiber.elementType);
  return name === "VirtualizedList" || name === "FlatList" || name === "SectionList";
}

function readVirtualizedListTotalCount(fiber: AnyFiber): number | undefined {
  if (!isVirtualizedListComponent(fiber)) return undefined;
  const props = readProps(fiber);
  const data = props.data;
  const getItemCount = props.getItemCount;
  if (typeof getItemCount === "function") {
    try {
      const count = (getItemCount as (items: unknown) => unknown)(data);
      if (typeof count === "number" && Number.isFinite(count) && count >= 0) return count;
    } catch {
      /* fall through to structural checks */
    }
  }
  if (Array.isArray(data)) return data.length;
  const sections = props.sections;
  if (Array.isArray(sections)) {
    let total = 0;
    for (const section of sections) {
      const rows = section && typeof section === "object" ? (section as Record<string, unknown>).data : undefined;
      if (Array.isArray(rows)) total += rows.length;
    }
    return total;
  }
  const stateNodeProps = fiber.stateNode && typeof fiber.stateNode === "object"
    ? (fiber.stateNode as { props?: Record<string, unknown> }).props
    : undefined;
  if (Array.isArray(stateNodeProps?.data)) return stateNodeProps.data.length;
  return undefined;
}

function readVirtualizedListVisibleRange(fiber: AnyFiber): VisibleRange | undefined {
  if (!isVirtualizedListComponent(fiber)) return undefined;
  const stateNode = fiber.stateNode && typeof fiber.stateNode === "object"
    ? (fiber.stateNode as Record<string, unknown>)
    : undefined;
  const candidates = [
    fiber.memoizedState,
    fiber.pendingProps,
    fiber.memoizedProps,
    stateNode?.state,
    stateNode?._state,
    stateNode,
  ];
  for (const candidate of candidates) {
    const found = readVisibleRangeFromObject(candidate);
    if (found) return found;
  }
  return undefined;
}

function readVisibleRangeFromObject(value: unknown): VisibleRange | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const obj = value as Record<string, unknown>;
  const direct = readVisibleRangePair(obj);
  if (direct) return direct;
  for (const key of ["cellsAroundViewport", "renderedRange", "visibleRange", "_visibleRange"]) {
    const nested = readVisibleRangeFromObject(obj[key]);
    if (nested) return nested;
  }
  return undefined;
}

function readVisibleRangePair(obj: Record<string, unknown>): VisibleRange | undefined {
  const pairs = [
    ["_firstChildIndex", "_lastChildIndex"],
    ["first", "last"],
    ["firstIndex", "lastIndex"],
    ["firstVisibleIndex", "lastVisibleIndex"],
    ["firstRenderedIndex", "lastRenderedIndex"],
    ["start", "end"],
  ] as const;
  for (const [startKey, endKey] of pairs) {
    const range = makeVisibleRange(obj[startKey], obj[endKey]);
    if (range) return range;
  }
  return undefined;
}

function makeVisibleRange(start: unknown, end: unknown): VisibleRange | undefined {
  if (
    typeof start !== "number" ||
    typeof end !== "number" ||
    !Number.isFinite(start) ||
    !Number.isFinite(end) ||
    start < 0 ||
    end < start
  ) {
    return undefined;
  }
  return { start, end };
}

function readVirtualizedItemIndex(fiber: AnyFiber): number | undefined {
  const props = readProps(fiber);
  for (const key of ["index", "cellIndex"]) {
    const value = props[key];
    if (typeof value === "number" && Number.isInteger(value) && value >= 0) return value;
  }
  return undefined;
}

function extractSource(
  fiber: AnyFiber,
  props: Record<string, unknown>,
): string | undefined {
  const brna = props.__brnaSource;
  if (typeof brna === "string" && brna.length > 0) {
    return brna;
  }
  const debug = fiber._debugSource;
  if (debug && typeof debug.fileName === "string" && debug.fileName.length > 0) {
    if (debug.fileName.indexOf("/node_modules/") !== -1) return undefined;
    const line = typeof debug.lineNumber === "number" ? debug.lineNumber : 0;
    const col = typeof debug.columnNumber === "number" ? debug.columnNumber : 0;
    return `${debug.fileName}:${line}:${col}`;
  }
  if (typeof props.__source === "string" && props.__source.length > 0) {
    return props.__source;
  }
  return undefined;
}

interface BuildResult {
  nodes: Node[];
  warnings: SnapshotWarning[];
  measureTargets: MeasureTarget[];
}

export interface MeasureTarget {
  nodeId: string;
  hostInstance: unknown;
}

interface IdentifiedSibling {
  hit: HostHit;
  fields: ExtractedFields;
  id: string;
}

// Single source of truth for sibling-level id derivation. Both snapshot
// build and live action target lookup go through this so a node's id is
// stable between captureSnapshot() output and a later `target_id` resolve.
function identifySiblings(
  hits: HostHit[],
  parentId: string,
): { siblings: IdentifiedSibling[]; warnings: SnapshotWarning[] } {
  const enriched = hits.map((hit) => ({ hit, fields: extractNodeFields(hit) }));
  const positionByKind = new Map<NodeKind, number>();
  const idInputs = enriched.map(({ hit, fields }) => {
    const pos = positionByKind.get(hit.kind) ?? 0;
    positionByKind.set(hit.kind, pos + 1);
    return {
      testID: fields.testID,
      accessibilityIdentifier: fields.accessibilityIdentifier,
      kind: hit.kind,
      name: fields.name,
      position_within_kind: pos,
    };
  });
  const { ids, warnings } = deriveNodeIdsForSiblings(idInputs, parentId);
  const siblings = enriched.map(({ hit, fields }, i) => ({ hit, fields, id: ids[i]! }));
  return { siblings, warnings };
}

function buildSubtree(hits: HostHit[], parentId: string): BuildResult {
  const { siblings, warnings } = identifySiblings(hits, parentId);
  const allWarnings: SnapshotWarning[] = [...warnings];
  const measureTargets: MeasureTarget[] = [];

  let interactiveOrdinal = 0;
  const nodes: Node[] = siblings.map(({ hit, fields, id }) => {
    const node: Node = { id, kind: hit.kind };
    const interactivePosition = INTERACTIVE_INFERRED_KINDS.has(node.kind)
      ? ++interactiveOrdinal
      : 0;
    if (fields.name !== undefined) node.name = fields.name;
    if (fields.text !== undefined) node.text = fields.text;
    if (fields.value !== undefined) node.value = fields.value;
    if (fields.role !== undefined) node.role = fields.role;
    if (fields.accessibility_label !== undefined)
      node.accessibility_label = fields.accessibility_label;
    if (fields.accessibility_hint !== undefined)
      node.accessibility_hint = fields.accessibility_hint;
    if (fields.range !== undefined) node.range = fields.range;
    if (fields.state !== undefined) node.state = fields.state;
    if (fields.source !== undefined) {
      node._dev = { ...(node._dev ?? {}), source: fields.source };
    }
    if (fields.image_source !== undefined) node.image_source = fields.image_source;
    if (hit.totalCount !== undefined) node.total_count = hit.totalCount;
    if (hit.itemIndex !== undefined) node.index = hit.itemIndex;
    if (hit.visibleRange !== undefined) node.visible_range = hit.visibleRange;

    measureTargets.push({ nodeId: id, hostInstance: hit.fiber.stateNode });

    const childHits = (hit as HostHit & { _children?: HostHit[] })._children ?? [];
    if (childHits.length > 0) {
      const sub = buildSubtree(childHits, id);
      if (sub.nodes.length > 0) node.children = sub.nodes;
      allWarnings.push(...sub.warnings);
      measureTargets.push(...sub.measureTargets);
    }
    if (node.kind === "list" && node.visible_range === undefined) {
      const fallback = visibleRangeFromListItems(node.children);
      if (fallback) node.visible_range = fallback;
    }

    if (
      INTERACTIVE_INFERRED_KINDS.has(node.kind) &&
      node.name === undefined &&
      fields.accessibility_label === undefined
    ) {
      let inferred: string | undefined;
      if (node.children && node.children.length > 0) {
        const text = findDescendantText(node.children);
        if (text) inferred = truncateToWords(text, INFERRED_LABEL_MAX_WORDS);
      }
      if (!inferred && fields.icon_label) inferred = fields.icon_label;
      if (!inferred && fields.handler_label) inferred = fields.handler_label;
      if (!inferred && fields.testID) inferred = humaniseTestId(fields.testID);
      if (!inferred) inferred = `action#${interactivePosition}`;
      if (inferred) {
        node.name = `__${inferred}__`;
        node._dev = { ...(node._dev ?? {}), inferred_label: true };
      }
    }

    return node;
  });

  return { nodes, warnings: allWarnings, measureTargets };
}

function visibleRangeFromListItems(children: Node[] | undefined): VisibleRange | undefined {
  if (!children) return undefined;
  let start: number | undefined;
  let end: number | undefined;
  for (const child of children) {
    if (child.kind !== "list_item") continue;
    const index = child.index;
    if (typeof index !== "number" || !Number.isFinite(index)) continue;
    start = start === undefined ? index : Math.min(start, index);
    end = end === undefined ? index : Math.max(end, index);
  }
  if (start === undefined || end === undefined) return undefined;
  return { start, end };
}

export interface WalkResult {
  rootChildren: Node[];
  warnings: SnapshotWarning[];
  measureTargets: MeasureTarget[];
}

export function walkFiberRoot(root: FiberRoot, parentId: string): WalkResult {
  const hits: HostHit[] = [];
  collectHostFibers(root.current.child, hits);
  const { nodes, warnings, measureTargets } = buildSubtree(hits, parentId);
  return { rootChildren: nodes, warnings, measureTargets };
}

export interface IdentifiedHit {
  id: string;
  fiber: AnyFiber;
  kind: NodeKind;
  fields: ExtractedFields;
  parentId: string;
}

// Walk live fibers and emit identified hits in document order. Uses the
// exact same id derivation as walkFiberRoot/buildSubtree, so action target
// lookup matches snapshot ids by construction. Used by action dispatch
// only — snapshot capture continues through walkFiberRoot.
export function walkLive(roots: FiberRoot[], rootParentId: string): IdentifiedHit[] {
  const out: IdentifiedHit[] = [];
  for (const root of roots) {
    const hits: HostHit[] = [];
    collectHostFibers(root.current.child, hits);
    walkLiveLevel(hits, rootParentId, out);
  }
  return out;
}

function walkLiveLevel(hits: HostHit[], parentId: string, out: IdentifiedHit[]): void {
  const { siblings } = identifySiblings(hits, parentId);
  for (const { hit, fields, id } of siblings) {
    out.push({ id, fiber: hit.fiber, kind: hit.kind, fields, parentId });
    const childHits = (hit as HostHit & { _children?: HostHit[] })._children ?? [];
    if (childHits.length > 0) walkLiveLevel(childHits, id, out);
  }
}

export function findHostFiberById(
  roots: FiberRoot[],
  rootParentId: string,
  targetId: string,
): IdentifiedHit | null {
  // walkLive does the full pass; for our tree sizes the simplicity wins
  // over an early-exit specialised walker. Revisit if we ever measure an
  // observable cost here.
  const all = walkLive(roots, rootParentId);
  for (const hit of all) if (hit.id === targetId) return hit;
  return null;
}

export function isDisabledHit(hit: IdentifiedHit): boolean {
  return Array.isArray(hit.fields.state) && hit.fields.state.includes("disabled");
}
