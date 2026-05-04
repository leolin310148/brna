import { afterEach, describe, expect, test } from "bun:test";
import { BrnaRuntimeError } from "../src/errors.js";
import { findRenderer, getFiberRoots, type AnyFiber, type FiberRoot } from "../src/devtools.js";

const globalWithHook = globalThis as typeof globalThis & {
  __REACT_DEVTOOLS_GLOBAL_HOOK__?: unknown;
};

function root(): FiberRoot {
  return {
    current: {
      tag: 5,
      type: "RCTView",
      child: null,
      sibling: null,
      return: null,
      memoizedProps: null,
      pendingProps: null,
      stateNode: {},
    } satisfies AnyFiber,
  };
}

afterEach(() => {
  delete globalWithHook.__REACT_DEVTOOLS_GLOBAL_HOOK__;
});

describe("BrnaRuntimeError", () => {
  test("uses default and custom messages while preserving codes", () => {
    expect(new BrnaRuntimeError("capture_failed").message).toBe("snapshot capture failed");
    const err = new BrnaRuntimeError("bridge_send_failed", "bridge is closed");
    expect(err.name).toBe("BrnaRuntimeError");
    expect(err.code).toBe("bridge_send_failed");
    expect(err.message).toBe("bridge is closed");
  });
});

describe("React DevTools hook lookup", () => {
  test("throws when the hook is missing or malformed", () => {
    expect(() => findRenderer()).toThrow(/dev build/);
    globalWithHook.__REACT_DEVTOOLS_GLOBAL_HOOK__ = { renderers: new Map() };
    expect(() => getFiberRoots(1)).toThrow(BrnaRuntimeError);
  });

  test("prefers known React Native renderer package names", () => {
    globalWithHook.__REACT_DEVTOOLS_GLOBAL_HOOK__ = {
      renderers: new Map([
        [1, { rendererPackageName: "react-dom", findFiberByHostInstance: () => null }],
        [2, { rendererPackageName: "react-native-renderer" }],
      ]),
      getFiberRoots: () => new Set([root()]),
    };
    expect(findRenderer()).toEqual({ id: 2, renderer: { rendererPackageName: "react-native-renderer" } });
  });

  test("falls back to host-instance capable renderers", () => {
    const renderer = { rendererPackageName: "custom", findFiberByHostInstance: () => null };
    globalWithHook.__REACT_DEVTOOLS_GLOBAL_HOOK__ = {
      renderers: new Map([[7, renderer]]),
      getFiberRoots: () => new Set([root()]),
    };
    expect(findRenderer()).toEqual({ id: 7, renderer });
  });

  test("reports missing renderers and empty roots", () => {
    globalWithHook.__REACT_DEVTOOLS_GLOBAL_HOOK__ = {
      renderers: new Map([[1, { rendererPackageName: "react-dom" }]]),
      getFiberRoots: () => new Set(),
    };
    expect(() => findRenderer()).toThrow(/no React Native reconciler/);
    expect(() => getFiberRoots(1)).toThrow(/no fiber roots/);
  });

  test("returns fiber roots from the hook", () => {
    const fiberRoot = root();
    globalWithHook.__REACT_DEVTOOLS_GLOBAL_HOOK__ = {
      renderers: new Map([[1, { rendererPackageName: "react-native" }]]),
      getFiberRoots: (rendererId: number) => rendererId === 1 ? new Set([fiberRoot]) : new Set(),
    };
    expect(getFiberRoots(1)).toEqual([fiberRoot]);
  });
});
