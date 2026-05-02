import { describe, expect, test } from "bun:test";
import type { Node } from "@brna/schema";
import type { AnyFiber, FiberRoot } from "../src/devtools.js";
import { findFirstSource, walkFiberRoot } from "../src/walker.js";

interface FiberInit {
  type: string;
  props?: Record<string, unknown>;
  stateNode?: unknown;
  children?: FiberInit[];
  debugSource?: { fileName?: string; lineNumber?: number; columnNumber?: number };
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
    _debugSource: init.debugSource ?? null,
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

describe("source capture into _dev.source", () => {
  test("__source on a host fiber maps to _dev.source", () => {
    const root = makeRoot(
      makeFiber({
        type: "RCTView",
        props: { __source: "App.tsx:42:10", testID: "v" },
      }),
    );
    const node = walkFiberRoot(root, "screen:root").rootChildren[0]!;
    expect(node._dev?.source).toBe("App.tsx:42:10");
  });

  test("missing __source omits _dev.source", () => {
    const root = makeRoot(
      makeFiber({ type: "RCTView", props: { testID: "v" } }),
    );
    const node = walkFiberRoot(root, "screen:root").rootChildren[0]!;
    expect(node._dev?.source).toBeUndefined();
  });

  test("fiber._debugSource (jsxDEV) maps to _dev.source", () => {
    const root = makeRoot(
      makeFiber({
        type: "RCTView",
        props: { testID: "v" },
        debugSource: {
          fileName: "/repo/src/pages/Home.tsx",
          lineNumber: 12,
          columnNumber: 4,
        },
      }),
    );
    const node = walkFiberRoot(root, "screen:root").rootChildren[0]!;
    expect(node._dev?.source).toBe("/repo/src/pages/Home.tsx:12:4");
  });

  test("fiber._debugSource inside node_modules is ignored", () => {
    const root = makeRoot(
      makeFiber({
        type: "RCTView",
        props: { testID: "v" },
        debugSource: {
          fileName: "/repo/node_modules/react-native/Lib/View.js",
          lineNumber: 100,
          columnNumber: 2,
        },
      }),
    );
    const node = walkFiberRoot(root, "screen:root").rootChildren[0]!;
    expect(node._dev?.source).toBeUndefined();
  });

  test("props.__brnaSource is the primary source (jsxDEV-safe attribute)", () => {
    const root = makeRoot(
      makeFiber({
        type: "RCTView",
        props: { __brnaSource: "src/pages/Home.tsx:7:2", testID: "v" },
      }),
    );
    const node = walkFiberRoot(root, "screen:root").rootChildren[0]!;
    expect(node._dev?.source).toBe("src/pages/Home.tsx:7:2");
  });

  test("props.__brnaSource wins over _debugSource", () => {
    const root = makeRoot(
      makeFiber({
        type: "RCTView",
        props: { __brnaSource: "src/A.tsx:1:1", testID: "v" },
        debugSource: { fileName: "/repo/src/B.tsx", lineNumber: 9, columnNumber: 9 },
      }),
    );
    const node = walkFiberRoot(root, "screen:root").rootChildren[0]!;
    expect(node._dev?.source).toBe("src/A.tsx:1:1");
  });

  test("props.__source falls back when _debugSource missing", () => {
    const root = makeRoot(
      makeFiber({
        type: "RCTView",
        props: { __source: "App.tsx:1:2", testID: "v" },
      }),
    );
    const node = walkFiberRoot(root, "screen:root").rootChildren[0]!;
    expect(node._dev?.source).toBe("App.tsx:1:2");
  });
});

describe("findFirstSource (meta.source primary-source selection)", () => {
  test("returns first node's _dev.source in document order", () => {
    const tree: Node[] = [
      { id: "a", kind: "group", _dev: { source: "App.tsx:1:1" } },
      { id: "b", kind: "button", _dev: { source: "App.tsx:5:5" } },
    ];
    expect(findFirstSource(tree)).toBe("App.tsx:1:1");
  });

  test("descends into children when sibling has no source", () => {
    const tree: Node[] = [
      {
        id: "a",
        kind: "group",
        children: [
          { id: "a1", kind: "text" },
          { id: "a2", kind: "button", _dev: { source: "Inner.tsx:7:3" } },
        ],
      },
      { id: "b", kind: "button", _dev: { source: "Other.tsx:1:0" } },
    ];
    expect(findFirstSource(tree)).toBe("Inner.tsx:7:3");
  });

  test("returns undefined when no node has _dev.source", () => {
    const tree: Node[] = [
      { id: "a", kind: "group", children: [{ id: "a1", kind: "text" }] },
    ];
    expect(findFirstSource(tree)).toBeUndefined();
  });

  test("returns undefined for an empty children list", () => {
    expect(findFirstSource([])).toBeUndefined();
  });
});

describe("auto-labeller heuristic", () => {
  test("infers label from descendant text", () => {
    const root = makeRoot(
      makeFiber({
        type: "RCTView",
        props: { onResponderRelease: () => {}, testID: "btn" },
        children: [
          { type: "RCTText", props: { children: "Save Changes" } },
        ],
      }),
    );
    const node = walkFiberRoot(root, "screen:root").rootChildren[0]!;
    expect(node.kind).toBe("button");
    expect(node.name).toBe("__Save Changes__");
    expect(node._dev?.inferred_label).toBe(true);
  });

  test("falls back to testID when no descendant text exists", () => {
    const root = makeRoot(
      makeFiber({
        type: "RCTView",
        props: { onResponderRelease: () => {}, testID: "btn-login" },
      }),
    );
    const node = walkFiberRoot(root, "screen:root").rootChildren[0]!;
    expect(node.kind).toBe("button");
    expect(node.name).toBe("__btn-login__");
    expect(node._dev?.inferred_label).toBe(true);
  });

  test("descendant text wins over testID", () => {
    const root = makeRoot(
      makeFiber({
        type: "RCTView",
        props: { onResponderRelease: () => {}, testID: "btn-save" },
        children: [{ type: "RCTText", props: { children: "Save" } }],
      }),
    );
    const node = walkFiberRoot(root, "screen:root").rootChildren[0]!;
    expect(node.name).toBe("__Save__");
    expect(node._dev?.inferred_label).toBe(true);
  });

  test("infers label from descendant icon name", () => {
    const root = makeRoot(
      makeFiber({
        type: "RCTView",
        props: { onResponderRelease: () => {} },
        children: [
          { type: "LucideIcon", props: { name: "trash" } },
        ],
      }),
    );
    const node = walkFiberRoot(root, "screen:root").rootChildren[0]!;
    expect(node.name).toBe("__Delete (icon)__");
    expect(node._dev?.inferred_label).toBe(true);
  });

  test("infers label from event handler function name", () => {
    function handleSubmit() {}
    const root = makeRoot(
      makeFiber({
        type: "RCTView",
        props: { onPress: handleSubmit },
      }),
    );
    const node = walkFiberRoot(root, "screen:root").rootChildren[0]!;
    expect(node.kind).toBe("button");
    expect(node.name).toBe("__Submit__");
    expect(node._dev?.inferred_label).toBe(true);
  });

  test("uses positional fallback for unlabelled interactive siblings", () => {
    const root = makeRoot(
      makeFiber({
        type: "RCTView",
        props: {},
        children: [
          { type: "RCTView", props: { accessibilityLabel: "Known", onPress: () => {} } },
          { type: "RCTView", props: { onPress: () => {} } },
          { type: "RCTView", props: { onPress: () => {} } },
        ],
      }),
    );
    const parent = walkFiberRoot(root, "screen:root").rootChildren[0]!;
    expect(parent.children?.[1]?.name).toBe("__action#2__");
    expect(parent.children?.[2]?.name).toBe("__action#3__");
  });

  test("real accessibilityLabel beats heuristic and is not wrapped", () => {
    const root = makeRoot(
      makeFiber({
        type: "RCTView",
        props: {
          onResponderRelease: () => {},
          accessibilityLabel: "Primary Action",
          testID: "btn",
        },
        children: [{ type: "RCTText", props: { children: "Submit" } }],
      }),
    );
    const node = walkFiberRoot(root, "screen:root").rootChildren[0]!;
    // Per existing rules, the button itself adopts accessibilityLabel as its name
    // when no own rendered text exists; the heuristic does not fire.
    expect(node.name).toBe("Primary Action");
    expect(node._dev?.inferred_label).toBeUndefined();
  });

  test("non-interactive group is not labelled", () => {
    const root = makeRoot(
      makeFiber({
        type: "RCTView",
        props: { testID: "panel" },
        children: [{ type: "RCTText", props: { children: "Hello" } }],
      }),
    );
    const node = walkFiberRoot(root, "screen:root").rootChildren[0]!;
    expect(node.kind).toBe("group");
    expect(node.name).toBeUndefined();
    expect(node._dev?.inferred_label).toBeUndefined();
  });

  test("link kind inherits the heuristic", () => {
    const root = makeRoot(
      makeFiber({
        type: "RCTView",
        props: { accessibilityRole: "link", testID: "go" },
        children: [{ type: "RCTText", props: { children: "Open Docs" } }],
      }),
    );
    const node = walkFiberRoot(root, "screen:root").rootChildren[0]!;
    expect(node.kind).toBe("link");
    expect(node.name).toBe("__Open Docs__");
    expect(node._dev?.inferred_label).toBe(true);
  });

  test("descendant text is truncated to 5 words", () => {
    const root = makeRoot(
      makeFiber({
        type: "RCTView",
        props: { onResponderRelease: () => {}, testID: "btn" },
        children: [
          { type: "RCTText", props: { children: "one two three four five six" } },
        ],
      }),
    );
    const node = walkFiberRoot(root, "screen:root").rootChildren[0]!;
    expect(node.name).toBe("__one two three four five__");
  });
});
