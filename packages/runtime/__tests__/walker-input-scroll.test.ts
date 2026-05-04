import { describe, expect, test } from "bun:test";
import type { AnyFiber, FiberRoot } from "../src/devtools.js";
import { findHostFiberById, mapHostToNodeKind, walkFiberRoot, walkLive } from "../src/walker.js";

interface FiberInit {
  type: string;
  props?: Record<string, unknown>;
  stateNode?: unknown;
  children?: FiberInit[];
}

function makeFiber(init: FiberInit): AnyFiber {
  const fiber: AnyFiber = {
    tag: 5,
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

describe("input host recognition", () => {
  test("RCTSinglelineTextInputView with value+placeholder+secure", () => {
    const f = makeFiber({
      type: "RCTSinglelineTextInputView",
      props: {
        testID: "input-email",
        value: "leo@example.com",
        placeholder: "you@example.com",
        secureTextEntry: true,
      },
    });
    expect(mapHostToNodeKind(f)).toBe("input");
    const result = walkFiberRoot(makeRoot(f), "$root");
    expect(result.rootChildren).toHaveLength(1);
    const node = result.rootChildren[0]!;
    expect(node.kind).toBe("input");
    expect(node.value).toBe("leo@example.com");
    expect(node.text).toBe("you@example.com");
    expect(node.name).toBe("you@example.com");
    expect(node.state).toContain("secure");
  });

  test("RCTMultilineTextInputView with editable=false", () => {
    const f = makeFiber({
      type: "RCTMultilineTextInputView",
      props: { testID: "bio", value: "hello", editable: false },
    });
    const result = walkFiberRoot(makeRoot(f), "$root");
    const node = result.rootChildren[0]!;
    expect(node.kind).toBe("input");
    expect(node.state).toContain("readonly");
  });

  test("AndroidTextInput with empty value emits explicit empty string", () => {
    const f = makeFiber({
      type: "AndroidTextInput",
      props: { testID: "name", value: "" },
    });
    const result = walkFiberRoot(makeRoot(f), "$root");
    const node = result.rootChildren[0]!;
    expect(node.value).toBe("");
  });

  test("AndroidTextInput with secureTextEntry emits 'secure' state", () => {
    const f = makeFiber({
      type: "AndroidTextInput",
      props: { testID: "pwd", value: "hunter2", secureTextEntry: true },
    });
    const result = walkFiberRoot(makeRoot(f), "$root");
    const node = result.rootChildren[0]!;
    expect(node.kind).toBe("input");
    expect(node.state).toContain("secure");
  });

  test("AndroidTextInput live and snapshot ids match (parity)", () => {
    const f = makeFiber({
      type: "AndroidTextInput",
      props: { testID: "android-input", value: "x" },
    });
    const root = makeRoot(f);
    const snap = walkFiberRoot(root, "$root");
    const live = walkLive([root], "$root");
    expect(live[0]!.id).toBe(snap.rootChildren[0]!.id);
    expect(live[0]!.kind).toBe("input");
  });

  test("TextInput without value prop omits Node.value", () => {
    const f = makeFiber({
      type: "TextInput",
      props: { testID: "uncontrolled" },
    });
    const result = walkFiberRoot(makeRoot(f), "$root");
    const node = result.rootChildren[0]!;
    expect(node.value).toBeUndefined();
  });

  test("TextInput numeric value is stringified", () => {
    const f = makeFiber({
      type: "TextInput",
      props: { testID: "age", value: 33, keyboardType: "numeric" },
    });
    const result = walkFiberRoot(makeRoot(f), "$root");
    const node = result.rootChildren[0]!;
    expect(node.value).toBe("33");
  });

  test("TextInput reads native cached text when value prop is absent", () => {
    const f = makeFiber({
      type: "AndroidTextInput",
      props: { testID: "age", keyboardType: "numeric" },
      stateNode: { _lastNativeText: "33" },
    });
    const result = walkFiberRoot(makeRoot(f), "$root");
    const node = result.rootChildren[0]!;
    expect(node.value).toBe("33");
  });

  test("TextInput without placeholder omits Node.text", () => {
    const f = makeFiber({
      type: "RCTSinglelineTextInputView",
      props: { testID: "x", value: "hi" },
    });
    const result = walkFiberRoot(makeRoot(f), "$root");
    const node = result.rootChildren[0]!;
    expect(node.text).toBeUndefined();
  });

  test("TextInput without own label uses the previous text sibling as name", () => {
    const f = makeFiber({
      type: "RCTView",
      props: { testID: "form" },
      children: [
        { type: "RCTText", props: { children: "Email address" } },
        { type: "RCTSinglelineTextInputView", props: { value: "leo@example.com" } },
      ],
    });
    const result = walkFiberRoot(makeRoot(f), "$root");
    const input = result.rootChildren[0]!.children![1]!;
    expect(input.kind).toBe("input");
    expect(input.name).toBe("Email address");
    expect(input.id.startsWith("auto:")).toBe(true);
  });

  test("non-captured TextInput props are dropped", () => {
    const f = makeFiber({
      type: "RCTSinglelineTextInputView",
      props: {
        testID: "email",
        value: "a",
        keyboardType: "email-address",
        autoCapitalize: "none",
        autoCorrect: false,
        multiline: false,
      },
    });
    const result = walkFiberRoot(makeRoot(f), "$root");
    const node = result.rootChildren[0]! as Record<string, unknown>;
    expect(node.keyboardType).toBeUndefined();
    expect(node.autoCapitalize).toBeUndefined();
    expect(node.autoCorrect).toBeUndefined();
    expect(node.multiline).toBeUndefined();
  });

  test("editable=true contributes no readonly flag", () => {
    const f = makeFiber({
      type: "RCTSinglelineTextInputView",
      props: { testID: "x", value: "a", editable: true },
    });
    const result = walkFiberRoot(makeRoot(f), "$root");
    const node = result.rootChildren[0]!;
    expect(node.state ?? []).not.toContain("readonly");
  });

  test("TextInput host with onResponderRelease still emits input (not button)", () => {
    const f = makeFiber({
      type: "RCTSinglelineTextInputView",
      props: { testID: "x", value: "a", onResponderRelease: () => {} },
    });
    expect(mapHostToNodeKind(f)).toBe("input");
  });
});

describe("scroll host recognition", () => {
  test("RCTScrollView with testID and children emits list", () => {
    const f = makeFiber({
      type: "RCTScrollView",
      props: { testID: "feed" },
      children: [
        { type: "RCTView", props: { testID: "row-1" } },
        { type: "RCTView", props: { testID: "row-2" } },
      ],
    });
    const result = walkFiberRoot(makeRoot(f), "$root");
    expect(result.rootChildren).toHaveLength(1);
    const node = result.rootChildren[0]!;
    expect(node.kind).toBe("list");
    expect(node.children).toHaveLength(2);
  });

  test("RCTScrollView with accessibilityRole=menu keeps list (role not in table)", () => {
    const f = makeFiber({
      type: "RCTScrollView",
      props: { testID: "menu", accessibilityRole: "menu" },
    });
    const result = walkFiberRoot(makeRoot(f), "$root");
    expect(result.rootChildren[0]!.kind).toBe("list");
  });

  test("RCTScrollView with accessibilityRole=header overrides to heading", () => {
    const f = makeFiber({
      type: "RCTScrollView",
      props: { testID: "h", accessibilityRole: "header" },
    });
    const result = walkFiberRoot(makeRoot(f), "$root");
    expect(result.rootChildren[0]!.kind).toBe("heading");
  });

  test("AndroidHorizontalScrollView emits list", () => {
    const f = makeFiber({
      type: "AndroidHorizontalScrollView",
      props: { testID: "horiz" },
    });
    expect(mapHostToNodeKind(f)).toBe("list");
  });

  test("AndroidHorizontalScrollView with children emits list with rows", () => {
    const f = makeFiber({
      type: "AndroidHorizontalScrollView",
      props: { testID: "carousel" },
      children: [
        { type: "View", props: { testID: "card-1" } },
        { type: "View", props: { testID: "card-2" } },
      ],
    });
    const result = walkFiberRoot(makeRoot(f), "$root");
    const node = result.rootChildren[0]!;
    expect(node.kind).toBe("list");
    expect(node.children).toHaveLength(2);
  });

  test("RCTScrollContentView is NOT emitted; children pass through to parent", () => {
    // Mirrors iOS: RCTScrollView wraps RCTScrollContentView wraps children.
    const f = makeFiber({
      type: "RCTScrollView",
      props: { testID: "outer" },
      children: [
        {
          type: "RCTScrollContentView",
          props: {},
          children: [
            { type: "RCTView", props: { testID: "row-a" } },
            { type: "RCTView", props: { testID: "row-b" } },
          ],
        },
      ],
    });
    const result = walkFiberRoot(makeRoot(f), "$root");
    const list = result.rootChildren[0]!;
    expect(list.kind).toBe("list");
    // Children should be the two RCTView rows directly, not a single content-view wrapper.
    expect(list.children).toHaveLength(2);
    expect(list.children?.[0]?.kind).toBe("group");
  });
});

describe("walkLive parity with walkFiberRoot for input/scroll hosts", () => {
  test("ids match for an input host", () => {
    const f = makeFiber({
      type: "RCTSinglelineTextInputView",
      props: { testID: "input-email", value: "x" },
    });
    const root = makeRoot(f);
    const snap = walkFiberRoot(root, "$root");
    const live = walkLive([root], "$root");
    expect(snap.rootChildren[0]!.id).toBe(live[0]!.id);
    const found = findHostFiberById([root], "$root", snap.rootChildren[0]!.id);
    expect(found).not.toBeNull();
    expect(found!.kind).toBe("input");
  });

  test("ids match for a scroll host with nested rows", () => {
    const f = makeFiber({
      type: "RCTScrollView",
      props: { testID: "long-list" },
      children: [
        { type: "RCTView", props: { testID: "row-1" } },
        { type: "RCTView", props: { testID: "row-2" } },
      ],
    });
    const root = makeRoot(f);
    const snap = walkFiberRoot(root, "$root");
    const live = walkLive([root], "$root");
    const listId = snap.rootChildren[0]!.id;
    expect(live.find((h) => h.id === listId)).toBeDefined();
    expect(live.find((h) => h.id === listId)!.kind).toBe("list");
  });
});
