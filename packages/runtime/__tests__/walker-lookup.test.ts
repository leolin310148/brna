import { describe, expect, test } from "bun:test";
import type { AnyFiber, FiberRoot } from "../src/devtools.js";
import type { Node } from "@brna/schema";
import {
  findHostFiberById,
  isDisabledHit,
  walkFiberRoot,
  walkLive,
} from "../src/walker.js";

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

function collectIds(nodes: Node[] | undefined, out: string[]): void {
  if (!nodes) return;
  for (const n of nodes) {
    out.push(n.id);
    collectIds(n.children, out);
  }
}

const ROOT_ID = "screen:root";

describe("walkLive id parity with walkFiberRoot", () => {
  test("testID-derived ids match snapshot ids", () => {
    const root = makeRoot(
      makeFiber({
        type: "RCTView",
        props: {},
        children: [
          { type: "RCTView", props: { onResponderRelease: () => {}, testID: "save" } },
          { type: "RCTText", props: { children: "Hello", testID: "greeting" } },
        ],
      }),
    );
    const snapshotIds: string[] = [];
    collectIds(walkFiberRoot(root, ROOT_ID).rootChildren, snapshotIds);
    const liveIds = walkLive([root], ROOT_ID).map((h) => h.id);
    expect(liveIds).toEqual(snapshotIds);
  });

  test("accessibilityIdentifier-derived ids match", () => {
    const root = makeRoot(
      makeFiber({
        type: "RCTView",
        props: {
          accessibilityIdentifier: "menu-trigger",
          onResponderRelease: () => {},
        },
      }),
    );
    const snapshotIds: string[] = [];
    collectIds(walkFiberRoot(root, ROOT_ID).rootChildren, snapshotIds);
    const liveIds = walkLive([root], ROOT_ID).map((h) => h.id);
    expect(liveIds).toEqual(snapshotIds);
    expect(snapshotIds[0]).toBe("menu-trigger");
  });

  test("auto-derived (no testID/a11yId) ids match", () => {
    const root = makeRoot(
      makeFiber({
        type: "RCTView",
        props: {},
        children: [
          { type: "RCTView", props: { onResponderRelease: () => {} } },
          { type: "RCTView", props: { onResponderRelease: () => {} } },
          { type: "RCTText", props: { children: "Title" } },
        ],
      }),
    );
    const snapshotIds: string[] = [];
    collectIds(walkFiberRoot(root, ROOT_ID).rootChildren, snapshotIds);
    const liveIds = walkLive([root], ROOT_ID).map((h) => h.id);
    expect(liveIds).toEqual(snapshotIds);
    expect(new Set(liveIds).size).toBe(liveIds.length);
    for (const id of liveIds) expect(id.length).toBeGreaterThan(0);
  });
});

describe("findHostFiberById", () => {
  test("returns null for unknown id (target_stale precondition)", () => {
    const root = makeRoot(
      makeFiber({
        type: "RCTView",
        props: { onResponderRelease: () => {}, testID: "real" },
      }),
    );
    expect(findHostFiberById([root], ROOT_ID, "ghost")).toBe(null);
  });

  test("returns the matching identified hit", () => {
    const onPress = () => {};
    const root = makeRoot(
      makeFiber({
        type: "RCTView",
        props: { onResponderRelease: onPress, testID: "save" },
      }),
    );
    const hit = findHostFiberById([root], ROOT_ID, "save");
    expect(hit).not.toBe(null);
    expect(hit!.id).toBe("save");
    expect(hit!.kind).toBe("button");
    const props = hit!.fiber.memoizedProps as Record<string, unknown>;
    expect(props["onResponderRelease"]).toBe(onPress);
  });

  test("descends into nested host children", () => {
    const root = makeRoot(
      makeFiber({
        type: "RCTView",
        props: {},
        children: [
          {
            type: "RCTView",
            props: { onResponderRelease: () => {}, testID: "outer" },
            children: [
              { type: "RCTText", props: { children: "Submit", testID: "label" } },
            ],
          },
        ],
      }),
    );
    expect(findHostFiberById([root], ROOT_ID, "label")?.kind).toBe("text");
  });
});

describe("isDisabledHit", () => {
  test("true when accessibilityState.disabled is set", () => {
    const root = makeRoot(
      makeFiber({
        type: "RCTView",
        props: {
          onResponderRelease: () => {},
          testID: "off",
          accessibilityState: { disabled: true },
        },
      }),
    );
    const hit = findHostFiberById([root], ROOT_ID, "off")!;
    expect(isDisabledHit(hit)).toBe(true);
  });

  test("false when no disabled flag is present", () => {
    const root = makeRoot(
      makeFiber({
        type: "RCTView",
        props: { onResponderRelease: () => {}, testID: "on" },
      }),
    );
    const hit = findHostFiberById([root], ROOT_ID, "on")!;
    expect(isDisabledHit(hit)).toBe(false);
  });
});
