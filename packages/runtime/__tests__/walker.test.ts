import { describe, expect, test } from "bun:test";
import type { AnyFiber, FiberRoot } from "../src/devtools.js";
import { mapHostToNodeKind, walkFiberRoot } from "../src/walker.js";

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

describe("mapHostToNodeKind heuristic", () => {
  test("RCTText becomes text", () => {
    const f = makeFiber({ type: "RCTText", props: { children: "hi" } });
    expect(mapHostToNodeKind(f)).toBe("text");
  });

  test("RCTView with onResponderRelease becomes button", () => {
    const f = makeFiber({ type: "RCTView", props: { onResponderRelease: () => {} } });
    expect(mapHostToNodeKind(f)).toBe("button");
  });

  test("bare RCTView becomes group", () => {
    const f = makeFiber({ type: "RCTView", props: {} });
    expect(mapHostToNodeKind(f)).toBe("group");
  });

  test("unknown host returns null", () => {
    const f = makeFiber({ type: "RCTUnknown" });
    expect(mapHostToNodeKind(f)).toBe(null);
  });

  test("native image hosts become image", () => {
    expect(mapHostToNodeKind(makeFiber({ type: "RCTImageView" }))).toBe("image");
    expect(mapHostToNodeKind(makeFiber({ type: "RCTImage" }))).toBe("image");
    expect(mapHostToNodeKind(makeFiber({ type: "Image" }))).toBe("image");
  });
});

describe("role-driven NodeKind upgrade", () => {
  test("accessibilityRole=header overrides button heuristic", () => {
    const f = makeFiber({
      type: "RCTView",
      props: { onResponderRelease: () => {}, accessibilityRole: "header" },
    });
    expect(mapHostToNodeKind(f)).toBe("heading");
  });

  test("accessibilityRole=link upgrades a bare view", () => {
    const f = makeFiber({ type: "RCTView", props: { accessibilityRole: "link" } });
    expect(mapHostToNodeKind(f)).toBe("link");
  });

  test("accessibilityRole=switch maps to toggle", () => {
    const f = makeFiber({ type: "RCTView", props: { accessibilityRole: "switch" } });
    expect(mapHostToNodeKind(f)).toBe("toggle");
  });

  test("accessibilityRole=adjustable maps to slider", () => {
    const f = makeFiber({ type: "RCTView", props: { accessibilityRole: "adjustable" } });
    expect(mapHostToNodeKind(f)).toBe("slider");
  });

  test("unknown role keeps the heuristic result", () => {
    const f = makeFiber({
      type: "RCTView",
      props: { onResponderRelease: () => {}, accessibilityRole: "summary" },
    });
    expect(mapHostToNodeKind(f)).toBe("button");
  });
});

describe("extractNodeFields via walkFiberRoot", () => {
  test("captures accessibility_label and accessibility_hint", () => {
    const root = makeRoot(
      makeFiber({
        type: "RCTView",
        props: {
          onResponderRelease: () => {},
          accessibilityLabel: "Add",
          accessibilityHint: "Adds an item",
          testID: "btn",
        },
      }),
    );
    const { rootChildren } = walkFiberRoot(root, "screen:root");
    expect(rootChildren).toHaveLength(1);
    const node = rootChildren[0]!;
    expect(node.kind).toBe("button");
    expect(node.accessibility_label).toBe("Add");
    expect(node.accessibility_hint).toBe("Adds an item");
  });

  test("accessibilityLabel becomes name when no rendered text exists", () => {
    const root = makeRoot(
      makeFiber({
        type: "RCTView",
        props: { accessibilityLabel: "Close", testID: "x" },
      }),
    );
    const node = walkFiberRoot(root, "screen:root").rootChildren[0]!;
    expect(node.name).toBe("Close");
    expect(node.accessibility_label).toBe("Close");
  });

  test("rendered text wins over accessibilityLabel", () => {
    const root = makeRoot(
      makeFiber({
        type: "RCTText",
        props: { children: "Submit", accessibilityLabel: "Submit form", testID: "t" },
      }),
    );
    const node = walkFiberRoot(root, "screen:root").rootChildren[0]!;
    expect(node.name).toBe("Submit");
    expect(node.accessibility_label).toBe("Submit form");
  });

  test("accessibilityState.busy maps to loading", () => {
    const root = makeRoot(
      makeFiber({
        type: "RCTView",
        props: { accessibilityState: { busy: true }, testID: "z" },
      }),
    );
    const node = walkFiberRoot(root, "screen:root").rootChildren[0]!;
    expect(node.state).toEqual(["loading"]);
  });

  test("accessibilityState contributes multiple flags", () => {
    const root = makeRoot(
      makeFiber({
        type: "RCTView",
        props: {
          accessibilityState: { disabled: true, selected: false, checked: true },
          testID: "z2",
        },
      }),
    );
    const node = walkFiberRoot(root, "screen:root").rootChildren[0]!;
    expect(node.state).toContain("disabled");
    expect(node.state).toContain("checked");
    expect(node.state).not.toContain("selected");
  });

  test("accessibilityValue full payload becomes range", () => {
    const root = makeRoot(
      makeFiber({
        type: "RCTView",
        props: {
          accessibilityValue: { min: 0, max: 100, now: 70 },
          accessibilityRole: "slider",
          testID: "s",
        },
      }),
    );
    const node = walkFiberRoot(root, "screen:root").rootChildren[0]!;
    expect(node.kind).toBe("slider");
    expect(node.range).toEqual({ min: 0, max: 100, now: 70 });
    expect(node.value).toBeUndefined();
  });

  test("partial accessibilityValue produces partial range", () => {
    const root = makeRoot(
      makeFiber({
        type: "RCTView",
        props: { accessibilityValue: { now: 70 }, testID: "p" },
      }),
    );
    const node = walkFiberRoot(root, "screen:root").rootChildren[0]!;
    expect(node.range).toEqual({ now: 70 });
  });

  test("empty accessibilityValue omits range entirely", () => {
    const root = makeRoot(
      makeFiber({
        type: "RCTView",
        props: { accessibilityValue: {}, testID: "q" },
      }),
    );
    const node = walkFiberRoot(root, "screen:root").rootChildren[0]!;
    expect(node.range).toBeUndefined();
  });

  test("skips subtrees hidden from accessibility", () => {
    const root = makeRoot(
      makeFiber({
        type: "RCTView",
        props: { importantForAccessibility: "no-hide-descendants" },
        children: [
          { type: "RCTView", props: { testID: "stale", onResponderRelease: () => {} } },
        ],
      }),
    );
    expect(walkFiberRoot(root, "screen:root").rootChildren).toEqual([]);
  });

  test("skips inactive react-native-screens subtrees", () => {
    const root = makeRoot(
      makeFiber({
        type: "RNSScreen",
        props: { activityState: 0 },
        children: [
          { type: "RCTText", props: { children: "Old route" } },
        ],
      }),
    );
    expect(walkFiberRoot(root, "screen:root").rootChildren).toEqual([]);
  });

  test("keeps active react-native-screens subtrees", () => {
    const root = makeRoot(
      makeFiber({
        type: "RNSScreen",
        props: { activityState: 2 },
        children: [
          { type: "RCTText", props: { children: "Current route" } },
        ],
      }),
    );
    const node = walkFiberRoot(root, "screen:root").rootChildren[0]!;
    expect(node.kind).toBe("text");
    expect(node.name).toBe("Current route");
  });

  test("accessibilityActions and importantForAccessibility are dropped", () => {
    const root = makeRoot(
      makeFiber({
        type: "RCTView",
        props: {
          accessibilityActions: [{ name: "activate" }],
          importantForAccessibility: "yes",
          testID: "drop",
        },
      }),
    );
    const node = walkFiberRoot(root, "screen:root").rootChildren[0]!;
    expect(JSON.stringify(node)).not.toContain("activate");
    expect(JSON.stringify(node)).not.toContain("importantForAccessibility");
  });

  test("measureTargets are emitted alongside nodes", () => {
    const root = makeRoot(
      makeFiber({
        type: "RCTView",
        props: { onResponderRelease: () => {}, testID: "btn" },
        stateNode: { __host: "btn" },
      }),
    );
    const result = walkFiberRoot(root, "screen:root");
    expect(result.measureTargets).toHaveLength(1);
    expect(result.measureTargets[0]!.nodeId).toBe("btn");
    expect(result.measureTargets[0]!.hostInstance).toEqual({ __host: "btn" });
  });

  test("image source captures only stable uri", () => {
    const root = makeRoot(
      makeFiber({
        type: "RCTImageView",
        props: {
          testID: "hero",
          source: {
            uri: "https://example.com/logo.png",
            headers: { Authorization: "secret" },
          },
        },
      }),
    );
    const node = walkFiberRoot(root, "screen:root").rootChildren[0]! as Record<string, unknown>;
    expect(node.kind).toBe("image");
    expect(node.image_source).toBe("https://example.com/logo.png");
    expect(JSON.stringify(node)).not.toContain("Authorization");
  });

  test("image source array, string, and local asset id are captured safely", () => {
    const root = makeRoot(
      makeFiber({
        type: "RCTView",
        props: { testID: "root" },
        children: [
          { type: "RCTImageView", props: { testID: "array", source: [{ uri: "https://example.com/a.png" }] } },
          { type: "RCTImageView", props: { testID: "string", source: "file:///tmp/b.png" } },
          { type: "RCTImageView", props: { testID: "asset", source: 42 } },
        ],
      }),
    );
    const children = walkFiberRoot(root, "screen:root").rootChildren[0]!.children!;
    expect(children[0]!.image_source).toBe("https://example.com/a.png");
    expect(children[1]!.image_source).toBe("file:///tmp/b.png");
    expect(children[2]!.image_source).toBe("42");
  });

  test("image source omits inline data image payloads", () => {
    const root = makeRoot(
      makeFiber({
        type: "RCTImageView",
        props: {
          testID: "inline",
          source: { uri: "data:image/png;base64,iVBORw0KGgo" },
        },
      }),
    );
    const node = walkFiberRoot(root, "screen:root").rootChildren[0]!;
    expect(node.kind).toBe("image");
    expect(node.image_source).toBeUndefined();
  });

  test("virtualized list total_count and item index are captured", () => {
    function FlatList() {}
    function CellRenderer() {}
    const list = makeComposite({
      type: FlatList,
      props: { data: ["a", "b", "c"] },
      children: [
        {
          type: "RCTScrollView",
          props: { testID: "feed" },
          children: [
            {
              type: CellRenderer,
              props: { index: 1 },
              children: [
                {
                  type: "RCTView",
                  props: { testID: "row-b" },
                  children: [{ type: "RCTText", props: { children: "B" } }],
                },
              ],
            },
          ],
        },
      ],
    });
    const result = walkFiberRoot(makeRoot(list), "screen:root");
    const feed = result.rootChildren[0]!;
    expect(feed.kind).toBe("list");
    expect(feed.total_count).toBe(3);
    const row = feed.children?.[0]!;
    expect(row.kind).toBe("list_item");
    expect(row.index).toBe(1);
    expect(row.children?.[0]?.kind).toBe("text");
  });

  test("virtualized list visible_range is captured from internal state", () => {
    function FlatList() {}
    const list = makeComposite({
      type: FlatList,
      props: { data: Array.from({ length: 30 }) },
      stateNode: { state: { cellsAroundViewport: { first: 5, last: 15 } } },
      children: [
        {
          type: "RCTScrollView",
          props: { testID: "feed" },
          children: [
            {
              type: "RCTView",
              props: { testID: "row" },
            },
          ],
        },
      ],
    });
    const feed = walkFiberRoot(makeRoot(list), "screen:root").rootChildren[0]!;
    expect(feed.kind).toBe("list");
    expect(feed.visible_range).toEqual({ start: 5, end: 15 });
  });

  test("virtualized list visible_range falls back to emitted list_item indices", () => {
    function FlatList() {}
    function CellRenderer() {}
    const list = makeComposite({
      type: FlatList,
      props: { data: Array.from({ length: 30 }) },
      children: [
        {
          type: "RCTScrollView",
          props: { testID: "feed" },
          children: [
            {
              type: CellRenderer,
              props: { index: 3 },
              children: [{ type: "RCTView", props: { testID: "row-c" } }],
            },
            {
              type: CellRenderer,
              props: { index: 4 },
              children: [{ type: "RCTView", props: { testID: "row-d" } }],
            },
          ],
        },
      ],
    });
    const feed = walkFiberRoot(makeRoot(list), "screen:root").rootChildren[0]!;
    expect(feed.visible_range).toEqual({ start: 3, end: 4 });
  });

  test("virtualized list omits visible_range when no finite range is available", () => {
    function FlatList() {}
    const list = makeComposite({
      type: FlatList,
      props: { data: Array.from({ length: 30 }) },
      stateNode: { state: { cellsAroundViewport: { first: Number.NaN, last: 4 } } },
      children: [
        {
          type: "RCTScrollView",
          props: { testID: "feed" },
          children: [{ type: "RCTView", props: { testID: "row" } }],
        },
      ],
    });
    const feed = walkFiberRoot(makeRoot(list), "screen:root").rootChildren[0]!;
    expect(feed.visible_range).toBeUndefined();
  });
});

interface AnyFiberInit {
  type: unknown;
  props?: Record<string, unknown>;
  stateNode?: unknown;
  children?: AnyFiberInit[];
}

function makeComposite(init: AnyFiberInit): AnyFiber {
  const fiber: AnyFiber = {
    tag: typeof init.type === "string" ? 5 : 0,
    type: init.type,
    elementType: init.type,
    child: null,
    sibling: null,
    return: null,
    memoizedProps: init.props ?? null,
    pendingProps: init.props ?? null,
    stateNode: init.stateNode ?? (typeof init.type === "string" ? { __mock: init.type } : null),
  };
  if (init.children && init.children.length > 0) {
    let prev: AnyFiber | null = null;
    for (const childInit of init.children) {
      const child = makeComposite(childInit);
      child.return = fiber;
      if (!prev) fiber.child = child;
      else prev.sibling = child;
      prev = child;
    }
  }
  return fiber;
}
