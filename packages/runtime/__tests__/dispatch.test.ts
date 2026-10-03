import { describe, expect, test } from "bun:test";
import type { AnyFiber, FiberRoot } from "../src/devtools.js";
import { dispatchAction } from "../src/dispatch.js";

interface FiberInit {
  type: string;
  tag?: number;
  props?: Record<string, unknown>;
  stateNode?: unknown;
  children?: FiberInit[];
}

function makeFiber(init: FiberInit): AnyFiber {
  const fiber: AnyFiber = {
    tag: init.tag ?? 5,
    type: init.type,
    elementType: init.type,
    child: null,
    sibling: null,
    return: null,
    memoizedProps: init.props ?? null,
    pendingProps: init.props ?? null,
    stateNode: init.stateNode ?? { __mock: init.type },
  };
  if (init.children && init.children.length > 0) {
    let prev: AnyFiber | null = null;
    for (const childInit of init.children) {
      const child = makeFiber(childInit);
      child.return = fiber;
      if (!prev) {
        fiber.child = child;
      } else {
        prev.sibling = child;
      }
      prev = child;
    }
  }
  return fiber;
}

function makeRoot(fiber: AnyFiber): FiberRoot {
  const dummy: AnyFiber = {
    tag: 3,
    type: null,
    elementType: null,
    child: fiber,
    sibling: null,
    return: null,
    memoizedProps: null,
    pendingProps: null,
    stateNode: null,
  };
  fiber.return = dummy;
  return { current: dummy };
}

function rootsFor(fiber: AnyFiber) {
  const r = makeRoot(fiber);
  return () => [r];
}

describe("dispatchAction tap", () => {
  test("invokes onPress and returns ok", async () => {
    let called = 0;
    const root = makeFiber({
      type: "RCTView",
      props: { onPress: () => (called += 1), testID: "save" },
    });
    const out = await dispatchAction(
      { kind: "tap", selector: "#save", target_id: "save" },
      { rootsProvider: rootsFor(root) },
    );
    expect(out.ok).toBe(true);
    expect(called).toBe(1);
  });

  test("prefers onPress over onClick", async () => {
    let pressed = 0;
    let clicked = 0;
    const root = makeFiber({
      type: "RCTView",
      props: {
        onPress: () => (pressed += 1),
        onClick: () => (clicked += 1),
        testID: "x",
      },
    });
    await dispatchAction(
      { kind: "tap", selector: "#x", target_id: "x" },
      { rootsProvider: rootsFor(root) },
    );
    expect(pressed).toBe(1);
    expect(clicked).toBe(0);
  });

  test("falls back to onClick when onPress absent", async () => {
    let clicked = 0;
    const root = makeFiber({
      type: "RCTView",
      props: { onClick: () => (clicked += 1), testID: "x" },
    });
    await dispatchAction(
      { kind: "tap", selector: "#x", target_id: "x" },
      { rootsProvider: rootsFor(root) },
    );
    expect(clicked).toBe(1);
  });

  test("falls back to onResponderRelease last", async () => {
    let released = 0;
    const root = makeFiber({
      type: "RCTView",
      props: { onResponderRelease: () => (released += 1), testID: "x" },
    });
    await dispatchAction(
      { kind: "tap", selector: "#x", target_id: "x" },
      { rootsProvider: rootsFor(root) },
    );
    expect(released).toBe(1);
  });

  test("returns target_stale for unknown id", async () => {
    const root = makeFiber({
      type: "RCTView",
      props: { onPress: () => {}, testID: "real" },
    });
    const out = await dispatchAction(
      { kind: "tap", selector: "#ghost", target_id: "ghost" },
      { rootsProvider: rootsFor(root) },
    );
    expect(out).toEqual({ ok: false, code: "target_stale", message: expect.any(String) as never });
    if (!out.ok) {
      expect(out.message).toContain("selector '#ghost'");
      expect(out.message).toContain("re-run brna snapshot");
    }
  });

  test("returns target_disabled when disabled prop is true", async () => {
    const root = makeFiber({
      type: "RCTView",
      props: {
        onPress: () => {},
        testID: "off",
        disabled: true,
        accessibilityState: { disabled: true },
      },
    });
    const out = await dispatchAction(
      { kind: "tap", selector: "#off", target_id: "off" },
      { rootsProvider: rootsFor(root) },
    );
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.code).toBe("target_disabled");
  });

  test("taps responder surfaces with accessibilityState.disabled but no disabled prop", async () => {
    let called = 0;
    const root = makeFiber({
      type: "RCTView",
      props: {
        onResponderRelease: () => (called += 1),
        testID: "backdrop",
        accessibilityState: { disabled: true },
      },
    });
    const out = await dispatchAction(
      { kind: "tap", selector: "#backdrop", target_id: "backdrop" },
      { rootsProvider: rootsFor(root) },
    );
    expect(out).toEqual({ ok: true });
    expect(called).toBe(1);
  });

  test("returns action_not_supported when no handler exists", async () => {
    // bare RCTView with no onPress/onClick/onResponderRelease -> resolves to a 'group' kind
    const root = makeFiber({ type: "RCTView", props: { testID: "noop" } });
    const out = await dispatchAction(
      { kind: "tap", selector: "#noop", target_id: "noop" },
      { rootsProvider: rootsFor(root) },
    );
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.code).toBe("action_not_supported");
  });

  test("converts thrown handler to action_failed", async () => {
    const root = makeFiber({
      type: "RCTView",
      props: {
        onPress: () => {
          throw new Error("boom");
        },
        testID: "x",
      },
    });
    const out = await dispatchAction(
      { kind: "tap", selector: "#x", target_id: "x" },
      { rootsProvider: rootsFor(root) },
    );
    expect(out.ok).toBe(false);
    if (!out.ok) {
      expect(out.code).toBe("action_failed");
      expect(out.message).toContain("boom");
    }
  });
});

describe("dispatchAction live safety", () => {
  test("rejects host disabled without accessibility metadata", async () => {
    let called = 0;
    const fiber = makeFiber({ type: "RCTView", props: {
      testID: "off", disabled: true, onPress: () => called++,
    } });
    const out = await dispatchAction({ kind: "tap", selector: "#off", target_id: "off" }, { rootsProvider: rootsFor(fiber) });
    expect(out).toMatchObject({ ok: false, code: "target_disabled" });
    expect(called).toBe(0);
  });

  test("rejects disabled composite ownership but not controls beyond a host boundary", async () => {
    let disabledCalls = 0;
    let enabledCalls = 0;
    const fiber = makeFiber({ type: "Pressable", tag: 11, props: { disabled: true }, children: [
      { type: "RCTView", props: { testID: "off", accessibilityState: { disabled: true }, onResponderRelease: () => disabledCalls++ }, children: [
        { type: "RCTView", props: { testID: "child", onResponderRelease: () => enabledCalls++ } },
      ] },
    ] });
    const opts = { rootsProvider: rootsFor(fiber) };
    expect(await dispatchAction({ kind: "tap", selector: "#off", target_id: "off" }, opts)).toMatchObject({ ok: false, code: "target_disabled" });
    expect(await dispatchAction({ kind: "tap", selector: "#child", target_id: "child" }, opts)).toEqual({ ok: true });
    expect(disabledCalls).toBe(0);
    expect(enabledCalls).toBe(1);
  });

  test("modal blocks background, permits foreground, and removal restores background", async () => {
    let backgroundCalls = 0;
    let foregroundCalls = 0;
    const fiber = makeFiber({ type: "RCTView", children: [
      { type: "RCTView", props: { testID: "background", onPress: () => backgroundCalls++ } },
      { type: "RCTView", props: { accessibilityViewIsModal: true }, children: [
        { type: "RCTView", props: { testID: "foreground", onPress: () => foregroundCalls++ } },
      ] },
    ] });
    const opts = { rootsProvider: rootsFor(fiber) };
    expect(await dispatchAction({ kind: "tap", selector: "#background", target_id: "background" }, opts)).toMatchObject({ ok: false, code: "target_disabled" });
    expect(backgroundCalls).toBe(0);
    expect(await dispatchAction({ kind: "tap", selector: "#foreground", target_id: "foreground" }, opts)).toEqual({ ok: true });
    expect(foregroundCalls).toBe(1);
    fiber.child!.sibling = null;
    expect(await dispatchAction({ kind: "tap", selector: "#background", target_id: "background" }, opts)).toEqual({ ok: true });
    expect(backgroundCalls).toBe(1);
  });

  test.each([
    { accessibilityElementsHidden: true },
    { style: { display: "none" } },
    { pointerEvents: "none" },
  ])("inactive modal does not block background: %j", async (inactive) => {
    let called = 0;
    const fiber = makeFiber({ type: "RCTView", children: [
      { type: "RCTView", props: { testID: "background", onPress: () => called++ } },
      { type: "RCTView", props: { accessibilityViewIsModal: true, ...inactive } },
    ] });
    expect(await dispatchAction({ kind: "tap", selector: "#background", target_id: "background" }, { rootsProvider: rootsFor(fiber) })).toEqual({ ok: true });
    expect(called).toBe(1);
  });

  test("generic portal does not imply modal isolation", async () => {
    let backgroundCalls = 0;
    let portalCalls = 0;
    const fiber = makeFiber({ type: "RCTView", children: [
      { type: "RCTView", props: { testID: "background", onPress: () => backgroundCalls++ } },
      { type: "Portal", tag: 4, children: [
        { type: "RCTView", props: { testID: "portal", onPress: () => portalCalls++ } },
      ] },
    ] });
    const opts = { rootsProvider: rootsFor(fiber) };
    expect(await dispatchAction({ kind: "tap", selector: "#background", target_id: "background" }, opts)).toEqual({ ok: true });
    expect(await dispatchAction({ kind: "tap", selector: "#portal", target_id: "portal" }, opts)).toEqual({ ok: true });
    expect(backgroundCalls).toBe(1);
    expect(portalCalls).toBe(1);
  });

  test("nested modal isolates the inner scope without assuming sibling z-order", async () => {
    let outerCalls = 0;
    let innerCalls = 0;
    const fiber = makeFiber({ type: "RCTView", props: { accessibilityViewIsModal: true }, children: [
      { type: "RCTView", props: { testID: "outer", onPress: () => outerCalls++ } },
      { type: "RCTView", props: { accessibilityViewIsModal: true }, children: [
        { type: "RCTView", props: { testID: "inner", onPress: () => innerCalls++ } },
      ] },
    ] });
    const opts = { rootsProvider: rootsFor(fiber) };
    expect(await dispatchAction({ kind: "tap", selector: "#outer", target_id: "outer" }, opts)).toMatchObject({ ok: false, code: "target_disabled" });
    expect(await dispatchAction({ kind: "tap", selector: "#inner", target_id: "inner" }, opts)).toEqual({ ok: true });
    expect(outerCalls).toBe(0);
    expect(innerCalls).toBe(1);
  });

  test("modal in another root prevents background action", async () => {
    let backgroundCalls = 0;
    let foregroundCalls = 0;
    const roots = [
      makeRoot(makeFiber({ type: "RCTView", props: { testID: "background", onPress: () => backgroundCalls++ } })),
      makeRoot(makeFiber({ type: "RCTView", props: { accessibilityViewIsModal: true }, children: [
        { type: "RCTView", props: { testID: "foreground", onPress: () => foregroundCalls++ } },
      ] })),
    ];
    const opts = { rootsProvider: () => roots };
    expect(await dispatchAction({ kind: "tap", selector: "#background", target_id: "background" }, opts)).toMatchObject({ ok: false, code: "target_disabled" });
    expect(await dispatchAction({ kind: "tap", selector: "#foreground", target_id: "foreground" }, opts)).toEqual({ ok: true });
    expect(backgroundCalls).toBe(0);
    expect(foregroundCalls).toBe(1);
  });
  test("disjoint explicit modal scopes refuse ambiguous targets", async () => {
    let calls = 0;
    const roots = ["one", "two"].map((id) => makeRoot(makeFiber({ type: "RCTView", props: { accessibilityViewIsModal: true }, children: [
      { type: "RCTView", props: { testID: id, onPress: () => calls++ } },
    ] })));
    for (const target_id of ["one", "two"]) {
      expect(await dispatchAction({ kind: "tap", selector: `#${target_id}`, target_id }, { rootsProvider: () => roots })).toMatchObject({ ok: false, code: "target_disabled" });
    }
    expect(calls).toBe(0);
  });

  test("modal below pointerEvents none ancestor does not block background", async () => {
    let calls = 0;
    const fiber = makeFiber({ type: "RCTView", children: [
      { type: "RCTView", props: { testID: "background", onPress: () => calls++ } },
      { type: "RCTView", props: { pointerEvents: "none" }, children: [
        { type: "RCTView", props: { accessibilityViewIsModal: true } },
      ] },
    ] });
    expect(await dispatchAction({ kind: "tap", selector: "#background", target_id: "background" }, { rootsProvider: rootsFor(fiber) })).toEqual({ ok: true });
    expect(calls).toBe(1);
  });

  test.each(["disabled", "modal"])("focused key cannot invoke %s background", async (reason) => {
    let calls = 0;
    const fiber = makeFiber({ type: "RCTView", children: [
      { type: "AndroidTextInput", props: { testID: "focused", disabled: reason === "disabled", onSubmitEditing: () => calls++ }, stateNode: { isFocused: () => true } },
      ...(reason === "modal" ? [{ type: "RCTView", props: { accessibilityViewIsModal: true } }] : []),
    ] });
    expect(await dispatchAction({ kind: "key", key: "enter" }, { rootsProvider: rootsFor(fiber) })).toMatchObject({ ok: false, code: "target_disabled" });
    expect(calls).toBe(0);
  });

  test("tab skips background focus destinations", async () => {
    let backgroundFocus = 0;
    let foregroundFocus = 0;
    const fiber = makeFiber({ type: "RCTView", children: [
      { type: "RCTView", props: { accessibilityViewIsModal: true }, children: [
        { type: "AndroidTextInput", props: { testID: "focused" }, stateNode: { focus: () => {}, isFocused: () => true } },
      ] },
      { type: "AndroidTextInput", props: { testID: "background" }, stateNode: { focus: () => backgroundFocus++ } },
    ] });
    const modal = fiber.child!;
    const second = makeFiber({ type: "AndroidTextInput", props: { testID: "next" }, stateNode: { focus: () => foregroundFocus++ } });
    second.return = modal;
    modal.child!.sibling = second;
    const opts = { rootsProvider: rootsFor(fiber) };
    expect(await dispatchAction({ kind: "key", key: "tab" }, opts)).toEqual({ ok: true });
    expect(foregroundFocus).toBe(1);
    expect(backgroundFocus).toBe(0);
    modal.child = second;
    second.stateNode = { focus: () => foregroundFocus++, isFocused: () => true };
    expect(await dispatchAction({ kind: "key", key: "tab" }, opts)).toMatchObject({ ok: false, code: "action_not_supported" });
    expect(backgroundFocus).toBe(0);
  });

  test("scroll refusal does not suggest an out-of-modal ancestor", async () => {
    let calls = 0;
    const fiber = makeFiber({ type: "RCTScrollView", stateNode: { scrollTo: () => calls++ }, children: [
      { type: "RCTView", props: { accessibilityViewIsModal: true }, children: [
        { type: "RCTView", props: { testID: "inside" } },
      ] },
    ] });
    const out = await dispatchAction({ kind: "scroll", selector: "#inside", target_id: "inside", direction: "down" }, { rootsProvider: rootsFor(fiber) });
    expect(out).toMatchObject({ ok: false, code: "action_not_supported" });
    if (!out.ok) expect(out.message).not.toContain("nearest scrollable ancestor");
    expect(calls).toBe(0);
  });

  test("synthetic root scroll selects only modal recipients", async () => {
    let backgroundCalls = 0;
    let foregroundCalls = 0;
    const fiber = makeFiber({ type: "RCTView", children: [
      { type: "RCTScrollView", stateNode: { scrollTo: () => backgroundCalls++ } },
      { type: "RCTView", props: { accessibilityViewIsModal: true }, children: [
        { type: "RCTScrollView", stateNode: { scrollTo: () => foregroundCalls++ } },
      ] },
    ] });
    expect(await dispatchAction({ kind: "scroll", selector: "#screen:root", target_id: "screen:root", direction: "down" }, { rootsProvider: rootsFor(fiber) })).toEqual({ ok: true });
    expect(backgroundCalls).toBe(0);
    expect(foregroundCalls).toBe(1);
  });
  test("modal membership follows the committed child tree across bailed-out return links", async () => {
    let foregroundCalls = 0;
    let backgroundCalls = 0;
    const modal = makeFiber({ type: "RCTView", props: { accessibilityViewIsModal: true }, children: [
      { type: "RCTView", props: { testID: "foreground", onPress: () => foregroundCalls++ } },
    ] });
    // React can reuse a child subtree whose return still points at the alternate.
    const alternate = makeFiber({ type: "RCTView", props: { accessibilityViewIsModal: true } });
    modal.child!.return = alternate;
    const fiber = makeFiber({ type: "RCTView", children: [
      { type: "RCTView", props: { testID: "background", onPress: () => backgroundCalls++ } },
    ] });
    fiber.child!.sibling = modal;
    modal.return = fiber;
    const opts = { rootsProvider: rootsFor(fiber) };
    expect(await dispatchAction({ kind: "tap", selector: "#foreground", target_id: "foreground" }, opts)).toEqual({ ok: true });
    expect(await dispatchAction({ kind: "tap", selector: "#background", target_id: "background" }, opts)).toMatchObject({ ok: false, code: "target_disabled" });
    expect(foregroundCalls).toBe(1);
    expect(backgroundCalls).toBe(0);
  });
  test.each([false, true])("unrendered composite modal does not block: hidden child %j", async (hiddenChild) => {
    let calls = 0;
    const fiber = makeFiber({ type: "RCTView", children: [
      { type: "RCTView", props: { testID: "background", onPress: () => calls++ } },
      { type: "Modal", tag: 0, props: { accessibilityViewIsModal: true }, children: hiddenChild ? [
        { type: "RCTView", props: { accessibilityViewIsModal: true, style: { display: "none" } } },
      ] : [] },
    ] });
    expect(await dispatchAction({ kind: "tap", selector: "#background", target_id: "background" }, { rootsProvider: rootsFor(fiber) })).toEqual({ ok: true });
    expect(calls).toBe(1);
  });

  test.each(["hidden", "state"])("renderer-hidden Offscreen modal does not block: %s", async (hiding) => {
    let calls = 0;
    const fiber = makeFiber({ type: "RCTView", children: [
      { type: "RCTView", props: { testID: "background", onPress: () => calls++ } },
      { type: "Offscreen", tag: 22, props: { mode: hiding === "hidden" ? "hidden" : "visible" }, children: [
        { type: "RCTView", props: { accessibilityViewIsModal: true } },
      ] },
    ] });
    if (hiding === "state") fiber.child!.sibling!.memoizedState = { baseLanes: 0 };
    expect(await dispatchAction({ kind: "tap", selector: "#background", target_id: "background" }, { rootsProvider: rootsFor(fiber) })).toEqual({ ok: true });
    expect(calls).toBe(1);
  });
  test("explicit native modal boundary need not be a snapshot-recognized host", async () => {
    let foregroundCalls = 0;
    let backgroundCalls = 0;
    const fiber = makeFiber({ type: "RCTView", children: [
      { type: "RCTView", props: { testID: "background", onPress: () => backgroundCalls++ } },
      { type: "RCTModalHostView", props: { accessibilityViewIsModal: true }, children: [
        { type: "RCTView", props: { testID: "foreground", onPress: () => foregroundCalls++ } },
      ] },
    ] });
    const opts = { rootsProvider: rootsFor(fiber) };
    expect(await dispatchAction({ kind: "tap", selector: "#background", target_id: "background" }, opts)).toMatchObject({ ok: false, code: "target_disabled" });
    expect(await dispatchAction({ kind: "tap", selector: "#foreground", target_id: "foreground" }, opts)).toEqual({ ok: true });
    expect(backgroundCalls).toBe(0);
    expect(foregroundCalls).toBe(1);
  });
});

describe("dispatchAction long_press", () => {
  test("invokes onLongPress", async () => {
    let n = 0;
    const root = makeFiber({
      type: "RCTView",
      props: { onLongPress: () => (n += 1), testID: "m" },
    });
    const out = await dispatchAction(
      { kind: "long_press", selector: "#m", target_id: "m", duration_ms: 500 },
      { rootsProvider: rootsFor(root) },
    );
    expect(out.ok).toBe(true);
    expect(n).toBe(1);
  });

  test("does not fall back to onPress", async () => {
    let press = 0;
    const root = makeFiber({
      type: "RCTView",
      props: { onPress: () => (press += 1), testID: "m" },
    });
    const out = await dispatchAction(
      { kind: "long_press", selector: "#m", target_id: "m", duration_ms: 500 },
      { rootsProvider: rootsFor(root) },
    );
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.code).toBe("action_not_supported");
    expect(press).toBe(0);
  });

  test("respects disabled state", async () => {
    const root = makeFiber({
      type: "RCTView",
      props: {
        onLongPress: () => {},
        disabled: true,
        accessibilityState: { disabled: true },
        testID: "m",
      },
    });
    const out = await dispatchAction(
      { kind: "long_press", selector: "#m", target_id: "m", duration_ms: 500 },
      { rootsProvider: rootsFor(root) },
    );
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.code).toBe("target_disabled");
  });

  test("walks up fiber.return to find onLongPress on Pressable composite", async () => {
    let n = 0;
    const host = makeFiber({
      type: "RCTView",
      props: { testID: "m" },
    });
    const pressable: AnyFiber = {
      tag: 0,
      type: function Pressable() {},
      elementType: function Pressable() {},
      child: host,
      sibling: null,
      return: null,
      memoizedProps: { onLongPress: () => (n += 1) },
      pendingProps: null,
      stateNode: null,
    };
    host.return = pressable;
    const root = makeRoot(pressable);
    const out = await dispatchAction(
      { kind: "long_press", selector: "#m", target_id: "m", duration_ms: 500 },
      { rootsProvider: () => [root] },
    );
    expect(out.ok).toBe(true);
    expect(n).toBe(1);
  });

  test("walk-up stops at parent host and does not grab outer composite onLongPress", async () => {
    let outer = 0;
    const innerHost = makeFiber({
      type: "RCTView",
      props: { testID: "m" },
    });
    const outerHost: AnyFiber = {
      tag: 5,
      type: "RCTView",
      elementType: "RCTView",
      child: innerHost,
      sibling: null,
      return: null,
      memoizedProps: null,
      pendingProps: null,
      stateNode: null,
    };
    innerHost.return = outerHost;
    const wrappingComposite: AnyFiber = {
      tag: 0,
      type: function Pressable() {},
      elementType: function Pressable() {},
      child: outerHost,
      sibling: null,
      return: null,
      memoizedProps: { onLongPress: () => (outer += 1) },
      pendingProps: null,
      stateNode: null,
    };
    outerHost.return = wrappingComposite;
    const root = makeRoot(wrappingComposite);
    const out = await dispatchAction(
      { kind: "long_press", selector: "#m", target_id: "m", duration_ms: 500 },
      { rootsProvider: () => [root] },
    );
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.code).toBe("action_not_supported");
    expect(outer).toBe(0);
  });

  test("walk-up picks innermost composite onLongPress when multiple ancestors define it", async () => {
    let inner = 0;
    let outer = 0;
    const host = makeFiber({
      type: "RCTView",
      props: { testID: "m" },
    });
    const innerComposite: AnyFiber = {
      tag: 0,
      type: function Pressable() {},
      elementType: function Pressable() {},
      child: host,
      sibling: null,
      return: null,
      memoizedProps: { onLongPress: () => (inner += 1) },
      pendingProps: null,
      stateNode: null,
    };
    host.return = innerComposite;
    const outerComposite: AnyFiber = {
      tag: 0,
      type: function Wrapper() {},
      elementType: function Wrapper() {},
      child: innerComposite,
      sibling: null,
      return: null,
      memoizedProps: { onLongPress: () => (outer += 1) },
      pendingProps: null,
      stateNode: null,
    };
    innerComposite.return = outerComposite;
    const root = makeRoot(outerComposite);
    const out = await dispatchAction(
      { kind: "long_press", selector: "#m", target_id: "m", duration_ms: 500 },
      { rootsProvider: () => [root] },
    );
    expect(out.ok).toBe(true);
    expect(inner).toBe(1);
    expect(outer).toBe(0);
  });
});

describe("dispatchAction type", () => {
  test("calls onChangeText with full text and focuses if available", async () => {
    let focusCalls = 0;
    let received: string | null = null;
    const stateNode = { focus: () => (focusCalls += 1) };
    const root = makeFiber({
      type: "RCTView",
      props: { onChangeText: (t: string) => (received = t), testID: "i" },
      stateNode,
    });
    const out = await dispatchAction(
      { kind: "type", selector: "#i", target_id: "i", text: "leo@example.com" },
      { rootsProvider: rootsFor(root) },
    );
    expect(out.ok).toBe(true);
    expect(received).toBe("leo@example.com");
    expect(focusCalls).toBe(1);
  });

  test("falls back to onChange with synthetic nativeEvent.text", async () => {
    let text: string | null = null;
    const root = makeFiber({
      type: "RCTView",
      props: {
        onChange: (e: { nativeEvent: { text: string } }) => (text = e.nativeEvent.text),
        testID: "i",
      },
    });
    const out = await dispatchAction(
      { kind: "type", selector: "#i", target_id: "i", text: "abc" },
      { rootsProvider: rootsFor(root) },
    );
    expect(out.ok).toBe(true);
    expect(text).toBe("abc");
  });

  test("returns action_not_supported when neither handler exists", async () => {
    const root = makeFiber({ type: "RCTView", props: { testID: "i" } });
    const out = await dispatchAction(
      { kind: "type", selector: "#i", target_id: "i", text: "abc" },
      { rootsProvider: rootsFor(root) },
    );
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.code).toBe("action_not_supported");
  });

  test("focus throw does not abort onChangeText", async () => {
    let received: string | null = null;
    const root = makeFiber({
      type: "RCTView",
      props: { onChangeText: (t: string) => (received = t), testID: "i" },
      stateNode: {
        focus: () => {
          throw new Error("focus failed");
        },
      },
    });
    const out = await dispatchAction(
      { kind: "type", selector: "#i", target_id: "i", text: "z" },
      { rootsProvider: rootsFor(root) },
    );
    expect(out.ok).toBe(true);
    expect(received).toBe("z");
  });
});

describe("dispatchAction scroll", () => {
  test("uses scrollTo with delta when available", async () => {
    let arg: unknown = null;
    const root = makeFiber({
      type: "RCTView",
      props: { testID: "feed" },
      stateNode: { scrollTo: (a: unknown) => (arg = a) },
    });
    const out = await dispatchAction(
      { kind: "scroll", selector: "#feed", target_id: "feed", direction: "down", by: 300 },
      { rootsProvider: rootsFor(root) },
    );
    expect(out.ok).toBe(true);
    expect(arg).toEqual({ x: 0, y: 300, animated: false });
  });

  test("uses default 400 when by is absent", async () => {
    let arg: unknown = null;
    const root = makeFiber({
      type: "RCTView",
      props: { testID: "feed" },
      stateNode: { scrollTo: (a: unknown) => (arg = a) },
    });
    await dispatchAction(
      { kind: "scroll", selector: "#feed", target_id: "feed", direction: "up" },
      { rootsProvider: rootsFor(root) },
    );
    expect(arg).toEqual({ x: 0, y: -400, animated: false });
  });

  test("falls back to scrollToOffset", async () => {
    let arg: unknown = null;
    const root = makeFiber({
      type: "RCTView",
      props: { testID: "feed" },
      stateNode: { scrollToOffset: (a: unknown) => (arg = a) },
    });
    await dispatchAction(
      { kind: "scroll", selector: "#feed", target_id: "feed", direction: "down", by: 200 },
      { rootsProvider: rootsFor(root) },
    );
    expect(arg).toEqual({ offset: 200, animated: false });
  });

  test("uses the first scrollable descendant for synthetic screen root", async () => {
    let arg: unknown = null;
    const root = makeFiber({
      type: "RCTView",
      props: { testID: "container" },
      children: [
        {
          type: "RCTScrollView",
          props: { testID: "feed" },
          stateNode: { scrollTo: (a: unknown) => (arg = a) },
        },
      ],
    });
    const out = await dispatchAction(
      { kind: "scroll", selector: "@screen:root", target_id: "screen:root", direction: "down", by: 300 },
      { rootsProvider: rootsFor(root) },
    );
    expect(out.ok).toBe(true);
    expect(arg).toEqual({ x: 0, y: 300, animated: false });
  });

  test("returns action_not_supported when neither api exists", async () => {
    const root = makeFiber({ type: "RCTView", props: { testID: "feed" } });
    const out = await dispatchAction(
      { kind: "scroll", selector: "#feed", target_id: "feed", direction: "down" },
      { rootsProvider: rootsFor(root) },
    );
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.code).toBe("action_not_supported");
  });

  test("suggests nearest scrollable ancestor when target is inside a scrollable", async () => {
    const root = makeFiber({
      type: "RCTScrollView",
      props: { testID: "feed" },
      stateNode: { scrollTo: () => {} },
      children: [
        {
          type: "RCTView",
          props: { testID: "item" },
        },
      ],
    });
    const out = await dispatchAction(
      { kind: "scroll", selector: "#item", target_id: "item", direction: "down" },
      { rootsProvider: rootsFor(root) },
    );
    expect(out.ok).toBe(false);
    if (!out.ok) {
      expect(out.code).toBe("action_not_supported");
      expect(out.message).toContain("target_id 'item' is not scrollable");
      expect(out.message).toContain("nearest scrollable ancestor is #feed");
    }
  });

  test("walks up fiber.return to find composite scrollTo on RCTScrollView host", async () => {
    let arg: unknown = null;
    const scrollView = makeFiber({
      type: "RCTScrollView",
      props: { testID: "feed" },
    });
    // Simulate: composite ScrollView fiber (class component, tag=1) wraps the host.
    const composite: AnyFiber = {
      tag: 1,
      type: function ScrollView() {},
      elementType: function ScrollView() {},
      child: scrollView,
      sibling: null,
      return: null,
      memoizedProps: null,
      pendingProps: null,
      stateNode: { scrollTo: (a: unknown) => (arg = a) },
    };
    scrollView.return = composite;
    const root = makeRoot(composite);
    const out = await dispatchAction(
      { kind: "scroll", selector: "#feed", target_id: "feed", direction: "down", by: 250 },
      { rootsProvider: () => [root] },
    );
    expect(out.ok).toBe(true);
    expect(arg).toEqual({ x: 0, y: 250, animated: false });
  });

  test("walks up to find scrollToOffset on FlatList composite", async () => {
    let arg: unknown = null;
    const scrollViewHost = makeFiber({
      type: "RCTScrollView",
      props: { testID: "feed" },
    });
    // ScrollView composite has scrollTo, FlatList composite (further up) has scrollToOffset.
    // Walk-up should pick the FIRST hit — scrollTo on the inner composite.
    const scrollViewComposite: AnyFiber = {
      tag: 1,
      type: function ScrollView() {},
      elementType: function ScrollView() {},
      child: scrollViewHost,
      sibling: null,
      return: null,
      memoizedProps: null,
      pendingProps: null,
      stateNode: { scrollTo: (a: unknown) => (arg = a) },
    };
    scrollViewHost.return = scrollViewComposite;
    const flatListComposite: AnyFiber = {
      tag: 1,
      type: function FlatList() {},
      elementType: function FlatList() {},
      child: scrollViewComposite,
      sibling: null,
      return: null,
      memoizedProps: null,
      pendingProps: null,
      stateNode: { scrollToOffset: () => {} },
    };
    scrollViewComposite.return = flatListComposite;
    const root = makeRoot(flatListComposite);
    await dispatchAction(
      { kind: "scroll", selector: "#feed", target_id: "feed", direction: "down", by: 100 },
      { rootsProvider: () => [root] },
    );
    expect(arg).toEqual({ x: 0, y: 100, animated: false });
  });

  test("walk-up stops at parent host fiber and does not grab outer container", async () => {
    let outer: unknown = null;
    const innerHost = makeFiber({
      type: "RCTScrollView",
      props: { testID: "inner" },
    });
    // Wrap inner host directly in another HOST fiber (no composite between).
    // This mimics a degenerate case where there's no composite owner exposing
    // scrollTo right above the inner host. Walker must stop at the outer host
    // and NOT use its scrollTo.
    const outerHost: AnyFiber = {
      tag: 5,
      type: "RCTView",
      elementType: "RCTView",
      child: innerHost,
      sibling: null,
      return: null,
      memoizedProps: null,
      pendingProps: null,
      stateNode: { scrollTo: (a: unknown) => (outer = a) },
    };
    innerHost.return = outerHost;
    const root = makeRoot(outerHost);
    const out = await dispatchAction(
      { kind: "scroll", selector: "#inner", target_id: "inner", direction: "down" },
      { rootsProvider: () => [root] },
    );
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.code).toBe("action_not_supported");
    expect(outer).toBeNull();
  });

  test("scroll throw becomes action_failed", async () => {
    const root = makeFiber({
      type: "RCTView",
      props: { testID: "feed" },
      stateNode: {
        scrollTo: () => {
          throw new Error("oops");
        },
      },
    });
    const out = await dispatchAction(
      { kind: "scroll", selector: "#feed", target_id: "feed", direction: "down" },
      { rootsProvider: rootsFor(root) },
    );
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.code).toBe("action_failed");
  });
});

describe("dispatchAction swipe", () => {
  test("dispatches responder grant, move, and release in direction", async () => {
    const calls: Array<{ name: string; y: number }> = [];
    const root = makeFiber({
      type: "RCTView",
      props: {
        testID: "pane",
        onResponderGrant: (e: { nativeEvent: { pageY: number } }) => calls.push({ name: "grant", y: e.nativeEvent.pageY }),
        onResponderMove: (e: { nativeEvent: { pageY: number } }) => calls.push({ name: "move", y: e.nativeEvent.pageY }),
        onResponderRelease: (e: { nativeEvent: { pageY: number } }) => calls.push({ name: "release", y: e.nativeEvent.pageY }),
      },
      stateNode: { __brnaBounds: { x: 0, y: 10, w: 100, h: 40 } },
    });
    const out = await dispatchAction(
      { kind: "swipe", selector: "#pane", target_id: "pane", direction: "down", by: 120 },
      { rootsProvider: rootsFor(root) },
    );
    expect(out.ok).toBe(true);
    expect(calls).toEqual([
      { name: "grant", y: 30 },
      { name: "move", y: 150 },
      { name: "release", y: 150 },
    ]);
  });

  test("swipe synthetic events expose React-compatible no-op helpers", async () => {
    const calls: string[] = [];
    const root = makeFiber({
      type: "RCTView",
      props: {
        testID: "pane",
        onResponderMove: (e: { persist?: () => void; preventDefault?: () => void; stopPropagation?: () => void }) => {
          e.persist?.();
          e.preventDefault?.();
          e.stopPropagation?.();
          calls.push("move");
        },
      },
      stateNode: { __brnaBounds: { x: 0, y: 10, w: 100, h: 40 } },
    });
    const out = await dispatchAction(
      { kind: "swipe", selector: "#pane", target_id: "pane", direction: "up", by: 80 },
      { rootsProvider: rootsFor(root) },
    );
    expect(out.ok).toBe(true);
    expect(calls).toEqual(["move"]);
  });

  test("returns action_not_supported when no responder handlers exist", async () => {
    const root = makeFiber({ type: "RCTView", props: { testID: "pane" } });
    const out = await dispatchAction(
      { kind: "swipe", selector: "#pane", target_id: "pane", direction: "up" },
      { rootsProvider: rootsFor(root) },
    );
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.code).toBe("action_not_supported");
  });

  test("uses the first swipe-capable descendant for synthetic screen root", async () => {
    const calls: string[] = [];
    const root = makeFiber({
      type: "RCTView",
      props: { testID: "container" },
      children: [
        {
          type: "RCTView",
          props: {
            testID: "pane",
            onResponderMove: () => calls.push("move"),
            onResponderRelease: () => calls.push("release"),
          },
          stateNode: { __brnaBounds: { x: 0, y: 10, w: 100, h: 40 } },
        },
      ],
    });
    const out = await dispatchAction(
      { kind: "swipe", selector: "@screen:root", target_id: "screen:root", direction: "left", by: 100 },
      { rootsProvider: rootsFor(root) },
    );
    expect(out.ok).toBe(true);
    expect(calls).toEqual(["move", "release"]);
  });

  test("respects disabled state", async () => {
    const root = makeFiber({
      type: "RCTView",
      props: {
        testID: "pane",
        disabled: true,
        accessibilityState: { disabled: true },
        onResponderMove: () => {},
      },
    });
    const out = await dispatchAction(
      { kind: "swipe", selector: "#pane", target_id: "pane", direction: "left" },
      { rootsProvider: rootsFor(root) },
    );
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.code).toBe("target_disabled");
  });
});

describe("dispatchAction key tab", () => {
  test("focuses next focusable host in document order", async () => {
    let nextFocus = 0;
    const stateA = { focus: () => {}, isFocused: () => true };
    const stateB = { focus: () => (nextFocus += 1), isFocused: () => false };
    const root = makeFiber({
      type: "RCTView",
      props: {},
      children: [
        { type: "RCTView", props: { testID: "a" }, stateNode: stateA },
        { type: "RCTView", props: { testID: "b" }, stateNode: stateB },
      ],
    });
    const out = await dispatchAction(
      { kind: "key", key: "tab" },
      { rootsProvider: rootsFor(root) },
    );
    expect(out.ok).toBe(true);
    expect(nextFocus).toBe(1);
  });

  test("skips disabled focusables when picking next", async () => {
    let cFocus = 0;
    const stateA = { focus: () => {}, isFocused: () => true };
    const stateB = { focus: () => {} };
    const stateC = { focus: () => (cFocus += 1) };
    const root = makeFiber({
      type: "RCTView",
      props: {},
      children: [
        { type: "RCTView", props: { testID: "a" }, stateNode: stateA },
        {
          type: "RCTView",
          props: { testID: "b", accessibilityState: { disabled: true } },
          stateNode: stateB,
        },
        { type: "RCTView", props: { testID: "c" }, stateNode: stateC },
      ],
    });
    const out = await dispatchAction(
      { kind: "key", key: "tab" },
      { rootsProvider: rootsFor(root) },
    );
    expect(out.ok).toBe(true);
    expect(cFocus).toBe(1);
  });

  test("returns action_not_supported when nothing is focused", async () => {
    const stateA = { focus: () => {} };
    const root = makeFiber({
      type: "RCTView",
      props: { testID: "a" },
      stateNode: stateA,
    });
    const out = await dispatchAction(
      { kind: "key", key: "tab" },
      { rootsProvider: rootsFor(root) },
    );
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.code).toBe("action_not_supported");
  });

  test("returns action_not_supported when focused is the last focusable", async () => {
    const stateA = { focus: () => {}, isFocused: () => true };
    const root = makeFiber({
      type: "RCTView",
      props: { testID: "a" },
      stateNode: stateA,
    });
    const out = await dispatchAction(
      { kind: "key", key: "tab" },
      { rootsProvider: rootsFor(root) },
    );
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.code).toBe("action_not_supported");
  });

  test("tab uses focus remembered from prior type action", async () => {
    let bFocus = 0;
    const root = makeFiber({
      type: "RCTView",
      props: {},
      children: [
        {
          type: "TextInput",
          props: { testID: "remember-a", onChangeText: () => {} },
          stateNode: { focus: () => {} },
        },
        {
          type: "TextInput",
          props: { testID: "remember-b" },
          stateNode: { focus: () => (bFocus += 1) },
        },
      ],
    });
    const rootsProvider = rootsFor(root);
    const typed = await dispatchAction(
      { kind: "type", selector: "#remember-a", target_id: "remember-a", text: "x" },
      { rootsProvider },
    );
    expect(typed.ok).toBe(true);
    const tabbed = await dispatchAction({ kind: "key", key: "tab" }, { rootsProvider });
    expect(tabbed.ok).toBe(true);
    expect(bFocus).toBe(1);
  });

  test("enter dispatches onSubmitEditing for focused input", async () => {
    let submitKey: string | null = null;
    const root = makeFiber({
      type: "TextInput",
      props: {
        testID: "submit-input",
        accessibilityState: { focused: true },
        onSubmitEditing: (event: { nativeEvent: { key: string } }) => {
          submitKey = event.nativeEvent.key;
        },
      },
      stateNode: { focus: () => {}, isFocused: () => true },
    });
    const out = await dispatchAction({ kind: "key", key: "enter" }, { rootsProvider: rootsFor(root) });
    expect(out.ok).toBe(true);
    expect(submitKey).toBe("Enter");
  });

  test("arrow keys dispatch onKeyPress for focused input", async () => {
    const keys: string[] = [];
    const root = makeFiber({
      type: "TextInput",
      props: {
        testID: "arrow-input",
        onKeyPress: (event: { nativeEvent: { key: string } }) => keys.push(event.nativeEvent.key),
      },
      stateNode: { focus: () => {}, isFocused: () => true },
    });
    const out = await dispatchAction({ kind: "key", key: "arrow_down" }, { rootsProvider: rootsFor(root) });
    expect(out.ok).toBe(true);
    expect(keys).toEqual(["ArrowDown"]);
  });

  test("key synthetic events expose React-compatible no-op helpers", async () => {
    const calls: string[] = [];
    const root = makeFiber({
      type: "TextInput",
      props: {
        testID: "key-input",
        onKeyPress: (event: {
          persist?: () => void;
          preventDefault?: () => void;
          stopPropagation?: () => void;
          nativeEvent: { key: string };
        }) => {
          event.persist?.();
          event.preventDefault?.();
          event.stopPropagation?.();
          calls.push(event.nativeEvent.key);
        },
      },
      stateNode: { focus: () => {}, isFocused: () => true },
    });
    const out = await dispatchAction({ kind: "key", key: "escape" }, { rootsProvider: rootsFor(root) });
    expect(out.ok).toBe(true);
    expect(calls).toEqual(["Escape"]);
  });
});
