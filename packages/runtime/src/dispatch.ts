import type {
  ActionErrorCode,
  ActionRequest,
  KeyActionRequest,
  LongPressActionRequest,
  ScrollActionRequest,
  SwipeActionRequest,
  TapActionRequest,
  TypeActionRequest,
} from "@brna/schema";
import { findRenderer, getFiberRoots, type AnyFiber, type FiberRoot } from "./devtools.js";
import {
  findHostFiberById,
  isDisabledHit,
  walkLive,
  type IdentifiedHit,
} from "./walker.js";
import { ROOT_ID } from "./constants.js";

const DEFAULT_SCROLL_BY = 400;
const DEFAULT_SWIPE_BY = 180;
let lastFocusedTargetId: string | null = null;

export type DispatchOutcome =
  | { ok: true }
  | { ok: false; code: ActionErrorCode; message: string };

type DispatchFailure = Extract<DispatchOutcome, { ok: false }>;
type TargetLookup = { ok: true; hit: IdentifiedHit } | DispatchFailure;

interface DispatchOptions {
  // Override for tests; production reads via devtools hook.
  rootsProvider?: () => FiberRoot[];
}

function getRoots(opts?: DispatchOptions): FiberRoot[] {
  if (opts?.rootsProvider) return opts.rootsProvider();
  const { id: rendererId } = findRenderer();
  return getFiberRoots(rendererId);
}

export async function dispatchAction(
  action: ActionRequest,
  opts?: DispatchOptions,
): Promise<DispatchOutcome> {
  const roots = getRoots(opts);
  switch (action.kind) {
    case "tap":
      return dispatchTap(roots, action);
    case "long_press":
      return dispatchLongPress(roots, action);
    case "type":
      return dispatchType(roots, action);
    case "scroll":
      return dispatchScroll(roots, action);
    case "swipe":
      return dispatchSwipe(roots, action);
    case "key":
      return dispatchKey(roots, action);
  }
}

function fail(code: ActionErrorCode, message: string): DispatchFailure {
  return { ok: false, code, message };
}

function readProps(hit: IdentifiedHit): Record<string, unknown> {
  return (hit.fiber.memoizedProps ?? hit.fiber.pendingProps ?? {}) as Record<string, unknown>;
}

interface SyntheticEventLike {
  nativeEvent: { timestamp: number; target?: unknown };
  persist: () => void;
  preventDefault: () => void;
  stopPropagation: () => void;
}

function makeSyntheticEvent(hit: IdentifiedHit): SyntheticEventLike {
  const stateNode = hit.fiber.stateNode as { _nativeTag?: unknown } | null;
  const event: SyntheticEventLike = {
    nativeEvent: { timestamp: Date.now() },
    persist: () => {},
    preventDefault: () => {},
    stopPropagation: () => {},
  };
  if (stateNode && typeof stateNode === "object" && stateNode._nativeTag !== undefined) {
    event.nativeEvent.target = stateNode._nativeTag;
  }
  return event;
}

function lookupOrStale(
  roots: FiberRoot[],
  action: { target_id: string; selector?: string },
): TargetLookup {
  const hit = findHostFiberById(roots, ROOT_ID, action.target_id);
  if (!hit) {
    const selector = action.selector ? ` for selector '${action.selector}'` : "";
    return fail(
      "target_stale",
      `target_id '${action.target_id}'${selector} is not present in the current tree; re-run brna snapshot and retry with a current selector`,
    );
  }
  if (isDisabledHit(hit)) return fail("target_disabled", `target_id '${action.target_id}' is disabled`);
  return { ok: true, hit };
}

function firstEnabledHit(
  roots: FiberRoot[],
  supportsAction: (hit: IdentifiedHit) => boolean,
): IdentifiedHit | null {
  const hits = walkLive(roots, ROOT_ID);
  for (const hit of hits) {
    if (isDisabledHit(hit)) continue;
    if (supportsAction(hit)) return hit;
  }
  return null;
}

function lookupSyntheticRootTarget(
  roots: FiberRoot[],
  capability: string,
  supportsAction: (hit: IdentifiedHit) => boolean,
): TargetLookup {
  const hit = firstEnabledHit(roots, supportsAction);
  if (hit) return { ok: true, hit };
  return fail("action_not_supported", `target_id '${ROOT_ID}' has no ${capability} descendants`);
}

function dispatchTap(roots: FiberRoot[], action: TapActionRequest): DispatchOutcome {
  const found = lookupOrStale(roots, action);
  if (!("hit" in found)) return found;
  const props = readProps(found.hit);
  const handler =
    pickFn(props["onPress"]) ?? pickFn(props["onClick"]) ?? pickFn(props["onResponderRelease"]);
  if (!handler) {
    return fail(
      "action_not_supported",
      `target_id '${action.target_id}' has no onPress/onClick/onResponderRelease`,
    );
  }
  try {
    handler(makeSyntheticEvent(found.hit));
  } catch (err) {
    return fail("action_failed", (err as Error).message ?? "handler threw");
  }
  rememberFocusedTarget(found.hit);
  return { ok: true };
}

function dispatchLongPress(roots: FiberRoot[], action: LongPressActionRequest): DispatchOutcome {
  const found = lookupOrStale(roots, action);
  if (!("hit" in found)) return found;
  // Pressable / TouchableOpacity / TouchableHighlight consume `onLongPress` in
  // their composite (a hook handles the press timer and calls the prop). The
  // host fiber's memoizedProps does NOT carry it. Walk fiber.return for the
  // first composite ancestor whose memoizedProps has onLongPress, stopping at
  // the next host (tag=5) or HostRoot (tag=3) so we don't grab an outer
  // wrapper.
  const handler = findCompositePropFn(found.hit.fiber, "onLongPress");
  if (!handler) {
    return fail(
      "action_not_supported",
      `target_id '${action.target_id}' has no onLongPress`,
    );
  }
  try {
    handler(makeSyntheticEvent(found.hit));
  } catch (err) {
    return fail("action_failed", (err as Error).message ?? "handler threw");
  }
  return { ok: true };
}

function findCompositePropFn(
  start: AnyFiber,
  key: string,
): ((arg?: unknown) => unknown) | null {
  const own = pickFn((start.memoizedProps as Record<string, unknown> | null)?.[key]);
  if (own) return own;
  let current: AnyFiber | null = start.return;
  while (current) {
    if (current.tag === 5 || current.tag === 3) break;
    const props = current.memoizedProps as Record<string, unknown> | null;
    const fn = pickFn(props?.[key]);
    if (fn) return fn;
    current = current.return;
  }
  return null;
}

function dispatchType(roots: FiberRoot[], action: TypeActionRequest): DispatchOutcome {
  const found = lookupOrStale(roots, action);
  if (!("hit" in found)) return found;
  const stateNode = found.hit.fiber.stateNode as { focus?: unknown } | null;
  if (stateNode && typeof stateNode === "object" && typeof stateNode.focus === "function") {
    try {
      (stateNode.focus as () => void)();
      lastFocusedTargetId = found.hit.id;
    } catch {
      /* focus failures don't abort the type — onChangeText still runs */
    }
  }
  const props = readProps(found.hit);
  const onChangeText = pickFn(props["onChangeText"]);
  if (onChangeText) {
    try {
      onChangeText(action.text);
    } catch (err) {
      return fail("action_failed", (err as Error).message ?? "onChangeText threw");
    }
    return { ok: true };
  }
  const onChange = pickFn(props["onChange"]);
  if (onChange) {
    try {
      onChange({ nativeEvent: { text: action.text } });
    } catch (err) {
      return fail("action_failed", (err as Error).message ?? "onChange threw");
    }
    return { ok: true };
  }
  return fail(
    "action_not_supported",
    `target_id '${action.target_id}' has no onChangeText/onChange`,
  );
}

function dispatchScroll(roots: FiberRoot[], action: ScrollActionRequest): DispatchOutcome {
  const found = action.target_id === ROOT_ID
    ? lookupSyntheticRootTarget(roots, "scrollable", (hit) => findScrollableInstance(hit.fiber) !== null)
    : lookupOrStale(roots, action);
  if (!("hit" in found)) return found;
  const distance = action.by ?? DEFAULT_SCROLL_BY;
  // Host fibers (RCTScrollView, AndroidHorizontalScrollView, ScrollView) have
  // their native UIView/ViewGroup as stateNode — that ref does NOT expose
  // scrollTo/scrollToOffset. The methods live on the JS class instance one
  // composite ancestor up: ScrollView for plain scrolls, VirtualizedList /
  // FlatList / SectionList for virtualised. Walk fiber.return looking for the
  // first composite stateNode that has either method, stopping at the next
  // host (tag=5) or HostRoot (tag=3) so we don't grab an outer container.
  const target = findScrollableInstance(found.hit.fiber);
  if (!target) {
    const nearest = nearestScrollableAncestor(roots, action.target_id);
    const hint = nearest
      ? `; nearest scrollable ancestor is #${nearest.id}`
      : "";
    return fail(
      "action_not_supported",
      `target_id '${action.target_id}' is not scrollable${hint}`,
    );
  }
  // `by` is passed directly to the imperative API. Callers that need exact
  // relative offsets should resolve the current scroll position before acting.
  if (target.method === "scrollTo") {
    const dx = action.direction === "right" ? distance : action.direction === "left" ? -distance : 0;
    const dy = action.direction === "down" ? distance : action.direction === "up" ? -distance : 0;
    try {
      target.instance.scrollTo({ x: dx, y: dy, animated: false });
    } catch (err) {
      return fail("action_failed", (err as Error).message ?? "scrollTo threw");
    }
    return { ok: true };
  }
  const offset = action.direction === "up" || action.direction === "left" ? -distance : distance;
  try {
    target.instance.scrollToOffset({ offset, animated: false });
  } catch (err) {
    return fail("action_failed", (err as Error).message ?? "scrollToOffset threw");
  }
  return { ok: true };
}

function dispatchSwipe(roots: FiberRoot[], action: SwipeActionRequest): DispatchOutcome {
  const found = action.target_id === ROOT_ID
    ? lookupSyntheticRootTarget(roots, "swipe-capable", (hit) => findResponderHandlers(hit.fiber) !== null)
    : lookupOrStale(roots, action);
  if (!("hit" in found)) return found;
  const responder = findResponderHandlers(found.hit.fiber);
  if (!responder) {
    return fail(
      "action_not_supported",
      `target_id '${action.target_id}' has no PanResponder touch handlers`,
    );
  }
  const distance = action.by ?? DEFAULT_SWIPE_BY;
  const center = centerOfHit(found.hit);
  const end = swipeEnd(center, action.direction, distance);
  const grantEvent = makeTouchEvent(found.hit, center.x, center.y);
  const moveEvent = makeTouchEvent(found.hit, end.x, end.y);
  const releaseEvent = makeTouchEvent(found.hit, end.x, end.y);
  try {
    responder.grant?.(grantEvent);
    responder.move?.(moveEvent);
    responder.release?.(releaseEvent);
  } catch (err) {
    return fail("action_failed", (err as Error).message ?? "swipe handler threw");
  }
  return { ok: true };
}

interface Point {
  x: number;
  y: number;
}

interface ResponderHandlers {
  grant?: (arg?: unknown) => unknown;
  move?: (arg?: unknown) => unknown;
  release?: (arg?: unknown) => unknown;
}

function centerOfHit(hit: IdentifiedHit): Point {
  const stateNode = hit.fiber.stateNode as { measureInWindow?: unknown } | null;
  if (stateNode && typeof stateNode === "object") {
    const bounds = (stateNode as { __brnaBounds?: unknown }).__brnaBounds;
    if (bounds && typeof bounds === "object") {
      const b = bounds as Record<string, unknown>;
      if (
        typeof b.x === "number" &&
        typeof b.y === "number" &&
        typeof b.w === "number" &&
        typeof b.h === "number"
      ) {
        return { x: b.x + b.w / 2, y: b.y + b.h / 2 };
      }
    }
  }
  return { x: 0, y: 0 };
}

function swipeEnd(start: Point, direction: SwipeActionRequest["direction"], distance: number): Point {
  switch (direction) {
    case "up":
      return { x: start.x, y: start.y - distance };
    case "down":
      return { x: start.x, y: start.y + distance };
    case "left":
      return { x: start.x - distance, y: start.y };
    case "right":
      return { x: start.x + distance, y: start.y };
  }
}

function makeTouchEvent(hit: IdentifiedHit, pageX: number, pageY: number): {
  nativeEvent: { timestamp: number; target?: unknown; pageX: number; pageY: number; locationX: number; locationY: number; touches: unknown[]; changedTouches: unknown[] };
  persist: () => void;
  preventDefault: () => void;
  stopPropagation: () => void;
} {
  const base = makeSyntheticEvent(hit);
  const touch = { pageX, pageY, locationX: pageX, locationY: pageY, target: base.nativeEvent.target };
  return {
    persist: base.persist,
    preventDefault: base.preventDefault,
    stopPropagation: base.stopPropagation,
    nativeEvent: {
      ...base.nativeEvent,
      pageX,
      pageY,
      locationX: pageX,
      locationY: pageY,
      touches: [touch],
      changedTouches: [touch],
    },
  };
}

function findResponderHandlers(start: AnyFiber): ResponderHandlers | null {
  let current: AnyFiber | null = start;
  while (current) {
    const props = (current.memoizedProps ?? current.pendingProps ?? {}) as Record<string, unknown>;
    const handlers: ResponderHandlers = {};
    const grant = pickFn(props["onResponderGrant"]);
    const move = pickFn(props["onResponderMove"]);
    const release = pickFn(props["onResponderRelease"]);
    if (grant) handlers.grant = grant;
    if (move) handlers.move = move;
    if (release) handlers.release = release;
    if (handlers.move || handlers.release) return handlers;
    current = current.return;
    if (current && (current.tag === 5 || current.tag === 3)) break;
  }
  return null;
}

type ScrollTarget =
  | { method: "scrollTo"; instance: { scrollTo: (a: { x: number; y: number; animated: boolean }) => void } }
  | { method: "scrollToOffset"; instance: { scrollToOffset: (a: { offset: number; animated: boolean }) => void } };

function readScrollable(stateNode: unknown): ScrollTarget | null {
  if (!stateNode || typeof stateNode !== "object") return null;
  const obj = stateNode as { scrollTo?: unknown; scrollToOffset?: unknown };
  if (typeof obj.scrollTo === "function") {
    return { method: "scrollTo", instance: stateNode as { scrollTo: (a: { x: number; y: number; animated: boolean }) => void } };
  }
  if (typeof obj.scrollToOffset === "function") {
    return { method: "scrollToOffset", instance: stateNode as { scrollToOffset: (a: { offset: number; animated: boolean }) => void } };
  }
  return null;
}

function findScrollableInstance(start: AnyFiber): ScrollTarget | null {
  const own = readScrollable(start.stateNode);
  if (own) return own;
  let current: AnyFiber | null = start.return;
  while (current) {
    if (current.tag === 5 || current.tag === 3) break;
    const found = readScrollable(current.stateNode);
    if (found) return found;
    current = current.return;
  }
  return null;
}

function nearestScrollableAncestor(roots: FiberRoot[], targetId: string): IdentifiedHit | null {
  const hits = walkLive(roots, ROOT_ID);
  const byId = new Map<string, IdentifiedHit>();
  for (const hit of hits) byId.set(hit.id, hit);
  let current = byId.get(targetId);
  while (current) {
    const parent = byId.get(current.parentId);
    if (!parent) return null;
    if (findScrollableInstance(parent.fiber)) return parent;
    current = parent;
  }
  return null;
}

function dispatchKey(roots: FiberRoot[], action: KeyActionRequest): DispatchOutcome {
  const all = walkLive(roots, ROOT_ID);
  const focusable: IdentifiedHit[] = [];
  for (const hit of all) if (isFocusableHit(hit)) focusable.push(hit);
  const current = currentFocusedHit(all);

  if (action.key !== "tab") {
    if (!current) {
      return fail("action_not_supported", "no currently focused host detected");
    }
    return dispatchFocusedKey(current, action.key);
  }

  if (focusable.length === 0) {
    return fail("action_not_supported", "no focusable host instances available");
  }
  const currentIndex = current
    ? focusable.findIndex((hit) => hit.id === current.id)
    : -1;
  if (currentIndex === -1) {
    return fail("action_not_supported", "no currently focused host detected");
  }
  const next = focusable[currentIndex + 1];
  if (!next) {
    return fail("action_not_supported", "no next focusable host in document order");
  }
  const stateNode = next.fiber.stateNode as { focus?: unknown };
  try {
    (stateNode.focus as () => void)();
    lastFocusedTargetId = next.id;
  } catch (err) {
    return fail("action_failed", (err as Error).message ?? "focus threw");
  }
  return { ok: true };
}

function dispatchFocusedKey(hit: IdentifiedHit, key: KeyActionRequest["key"]): DispatchOutcome {
  const props = readProps(hit);
  const rnKey = reactNativeKeyName(key);
  const submit = key === "enter" ? pickFn(props["onSubmitEditing"]) : null;
  if (submit) {
    try {
      submit(makeKeyEvent(hit, rnKey));
      return { ok: true };
    } catch (err) {
      return fail("action_failed", (err as Error).message ?? "onSubmitEditing threw");
    }
  }
  const onKeyPress = pickFn(props["onKeyPress"]);
  if (!onKeyPress) {
    return fail(
      "action_not_supported",
      `focused target_id '${hit.id}' has no ${key === "enter" ? "onSubmitEditing/" : ""}onKeyPress`,
    );
  }
  try {
    onKeyPress(makeKeyEvent(hit, rnKey));
  } catch (err) {
    return fail("action_failed", (err as Error).message ?? "onKeyPress threw");
  }
  return { ok: true };
}

function makeKeyEvent(hit: IdentifiedHit, key: string): {
  nativeEvent: { timestamp: number; target?: unknown; key: string };
} {
  const base = makeSyntheticEvent(hit);
  return { nativeEvent: { ...base.nativeEvent, key } };
}

function reactNativeKeyName(key: KeyActionRequest["key"]): string {
  switch (key) {
    case "enter":
      return "Enter";
    case "escape":
      return "Escape";
    case "arrow_up":
      return "ArrowUp";
    case "arrow_down":
      return "ArrowDown";
    case "arrow_left":
      return "ArrowLeft";
    case "arrow_right":
      return "ArrowRight";
    case "tab":
      return "Tab";
  }
}

function currentFocusedHit(hits: IdentifiedHit[]): IdentifiedHit | null {
  for (const hit of hits) {
    if (isFocusedHit(hit)) {
      lastFocusedTargetId = hit.id;
      return hit;
    }
  }
  if (lastFocusedTargetId) {
    return hits.find((hit) => hit.id === lastFocusedTargetId) ?? null;
  }
  return null;
}

function isFocusableHit(hit: IdentifiedHit): boolean {
  const stateNode = hit.fiber.stateNode as { focus?: unknown } | null;
  if (!stateNode || typeof stateNode !== "object") return false;
  if (typeof stateNode.focus !== "function") return false;
  return !isDisabledHit(hit);
}

function isFocusedHit(hit: IdentifiedHit): boolean {
  const stateNode = hit.fiber.stateNode as { isFocused?: unknown } | null;
  if (stateNode && typeof stateNode === "object" && typeof stateNode.isFocused === "function") {
    try {
      if ((stateNode.isFocused as () => unknown)() === true) return true;
    } catch {
      /* fall through to prop-based detection */
    }
  }
  const props = hit.fiber.memoizedProps as Record<string, unknown> | null;
  const a11y = props?.["accessibilityState"];
  if (a11y && typeof a11y === "object") {
    if ((a11y as Record<string, unknown>)["focused"] === true) return true;
  }
  return false;
}

function rememberFocusedTarget(hit: IdentifiedHit): void {
  const stateNode = hit.fiber.stateNode as { focus?: unknown } | null;
  if (stateNode && typeof stateNode === "object" && typeof stateNode.focus === "function") {
    lastFocusedTargetId = hit.id;
  }
}

function pickFn(value: unknown): ((arg?: unknown) => unknown) | null {
  return typeof value === "function" ? (value as (arg?: unknown) => unknown) : null;
}
