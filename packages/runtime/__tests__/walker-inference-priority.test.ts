import { describe, expect, test } from "bun:test";
import type { AnyFiber, FiberRoot } from "../src/devtools.js";
import { countInferredLabels, walkFiberRoot } from "../src/walker.js";

interface FiberInit {
  type: string;
  props?: Record<string, unknown>;
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
    stateNode: { __mock: init.type },
    _debugSource: null,
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

describe("auto-labeller inference priority", () => {
  test("explicit accessibilityLabel wins over icon", () => {
    const root = makeRoot(
      makeFiber({
        type: "RCTView",
        props: { onPress: () => {}, accessibilityLabel: "Pay now" },
        children: [{ type: "MyIcon", props: { name: "credit-card" } }],
      }),
    );
    const node = walkFiberRoot(root, "screen:root").rootChildren[0]!;
    expect(node.name).toBe("Pay now");
    expect(node._dev?.inferred_label).toBeUndefined();
  });

  test("descendant text wins over testID", () => {
    const root = makeRoot(
      makeFiber({
        type: "RCTView",
        props: { onPress: () => {}, testID: "next-button" },
        children: [{ type: "RCTText", props: { children: "Continue" } }],
      }),
    );
    const node = walkFiberRoot(root, "screen:root").rootChildren[0]!;
    expect(node.name).toBe("__Continue__");
  });

  test("icon name wins over handler when no descendant text", () => {
    function handleSubmit() {}
    const root = makeRoot(
      makeFiber({
        type: "RCTView",
        props: { onPress: handleSubmit },
        children: [{ type: "MyIcon", props: { name: "trash" } }],
      }),
    );
    const node = walkFiberRoot(root, "screen:root").rootChildren[0]!;
    expect(node.name).toBe("__Delete (icon)__");
  });

  test("handler name wins over testID", () => {
    function handleSubmit() {}
    const root = makeRoot(
      makeFiber({
        type: "RCTView",
        props: { onPress: handleSubmit, testID: "fallback-id" },
      }),
    );
    const node = walkFiberRoot(root, "screen:root").rootChildren[0]!;
    expect(node.name).toBe("__Submit__");
  });

  test("testID humanises kebab-case", () => {
    const handler = function on() {};
    const root = makeRoot(
      makeFiber({
        type: "RCTView",
        props: { onPress: handler, testID: "forgot-password-button" },
      }),
    );
    const node = walkFiberRoot(root, "screen:root").rootChildren[0]!;
    expect(node.name).toBe("__Forgot Password Button__");
  });

  test("testID humanises snake_case", () => {
    const handler = function on() {};
    const root = makeRoot(
      makeFiber({
        type: "RCTView",
        props: { onPress: handler, testID: "forgot_password_button" },
      }),
    );
    const node = walkFiberRoot(root, "screen:root").rootChildren[0]!;
    expect(node.name).toBe("__Forgot Password Button__");
  });

  test("testID humanises camelCase", () => {
    const handler = function on() {};
    const root = makeRoot(
      makeFiber({
        type: "RCTView",
        props: { onPress: handler, testID: "forgotPasswordButton" },
      }),
    );
    const node = walkFiberRoot(root, "screen:root").rootChildren[0]!;
    expect(node.name).toBe("__Forgot Password Button__");
  });

  test("positional fallback when nothing matches", () => {
    const root = makeRoot(
      makeFiber({
        type: "RCTView",
        props: {},
        children: [
          { type: "RCTView", props: { onPress: () => {} } },
          { type: "RCTView", props: { onPress: () => {} } },
        ],
      }),
    );
    const parent = walkFiberRoot(root, "screen:root").rootChildren[0]!;
    expect(parent.children?.[0]?.name).toBe("__action#1__");
    expect(parent.children?.[1]?.name).toBe("__action#2__");
  });

  test("inferred labels carry _dev.inferred_label = true", () => {
    const handler = function on() {};
    const root = makeRoot(
      makeFiber({
        type: "RCTView",
        props: { onPress: handler, testID: "btn" },
      }),
    );
    const node = walkFiberRoot(root, "screen:root").rootChildren[0]!;
    expect(node._dev?.inferred_label).toBe(true);
  });
});

describe("countInferredLabels", () => {
  test("counts each inferred-label node in the tree", () => {
    const root = makeRoot(
      makeFiber({
        type: "RCTView",
        props: {},
        children: [
          { type: "RCTView", props: { onPress: () => {}, testID: "a" } },
          { type: "RCTView", props: { onPress: () => {}, accessibilityLabel: "Real" } },
          { type: "RCTView", props: { onPress: () => {} } },
          { type: "RCTView", props: { onPress: () => {} } },
        ],
      }),
    );
    const parent = walkFiberRoot(root, "screen:root").rootChildren[0]!;
    expect(countInferredLabels(parent.children ?? [])).toBe(3);
  });

  test("returns 0 when no labels were inferred", () => {
    const root = makeRoot(
      makeFiber({
        type: "RCTView",
        props: {},
        children: [
          { type: "RCTView", props: { accessibilityLabel: "A", onPress: () => {} } },
          { type: "RCTView", props: { accessibilityLabel: "B", onPress: () => {} } },
        ],
      }),
    );
    const parent = walkFiberRoot(root, "screen:root").rootChildren[0]!;
    expect(countInferredLabels(parent.children ?? [])).toBe(0);
  });
});
