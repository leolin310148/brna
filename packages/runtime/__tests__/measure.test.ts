import { describe, expect, test } from "bun:test";
import { measureBatch } from "../src/measure.js";
import type { MeasureTarget } from "../src/walker.js";

function fakeHost(x: number, y: number, w: number, h: number, opts: { delayMs?: number } = {}) {
  return {
    measureInWindow(cb: (x: number, y: number, w: number, h: number) => void) {
      const delay = opts.delayMs ?? 0;
      if (delay === 0) {
        cb(x, y, w, h);
      } else {
        setTimeout(() => cb(x, y, w, h), delay);
      }
    },
  };
}

function silentHost() {
  return {
    measureInWindow(_cb: (x: number, y: number, w: number, h: number) => void) {
      // never invokes callback
    },
  };
}

describe("measureBatch", () => {
  test("collects bounds for every target", async () => {
    const targets: MeasureTarget[] = [
      { nodeId: "a", hostInstance: fakeHost(1, 2, 3, 4) },
      { nodeId: "b", hostInstance: fakeHost(10, 20, 30, 40) },
    ];
    const { bounds, unavailable } = await measureBatch(targets, 200);
    expect(bounds.get("a")).toEqual({ x: 1, y: 2, w: 3, h: 4 });
    expect(bounds.get("b")).toEqual({ x: 10, y: 20, w: 30, h: 40 });
    expect(unavailable.size).toBe(0);
  });

  test("zero-sized node fires within timeout and emits no warning", async () => {
    const targets: MeasureTarget[] = [
      { nodeId: "z", hostInstance: fakeHost(0, 0, 0, 0) },
    ];
    const { bounds, unavailable } = await measureBatch(targets, 100);
    expect(bounds.get("z")).toEqual({ x: 0, y: 0, w: 0, h: 0 });
    expect(unavailable.has("z")).toBe(false);
  });

  test("silent host falls back to zero with unavailable flag", async () => {
    const targets: MeasureTarget[] = [
      { nodeId: "u", hostInstance: silentHost() },
    ];
    const { bounds, unavailable } = await measureBatch(targets, 30);
    expect(bounds.get("u")).toEqual({ x: 0, y: 0, w: 0, h: 0 });
    expect(unavailable.has("u")).toBe(true);
  });

  test("non-measurable host (no measureInWindow) becomes unavailable", async () => {
    const targets: MeasureTarget[] = [
      { nodeId: "n", hostInstance: { __mock: true } },
    ];
    const { bounds, unavailable } = await measureBatch(targets, 50);
    expect(bounds.get("n")).toEqual({ x: 0, y: 0, w: 0, h: 0 });
    expect(unavailable.has("n")).toBe(true);
  });

  test("measurement runs concurrently, not sequentially", async () => {
    // 5 targets, each delays 80ms. With 200ms timeout and concurrency, should
    // complete in ~80ms wall time, not 5*80ms = 400ms.
    const targets: MeasureTarget[] = Array.from({ length: 5 }, (_, i) => ({
      nodeId: `c${i}`,
      hostInstance: fakeHost(i, i, 10, 10, { delayMs: 80 }),
    }));
    const start = Date.now();
    const { bounds, unavailable } = await measureBatch(targets, 200);
    const elapsed = Date.now() - start;
    expect(elapsed).toBeLessThan(250);
    expect(bounds.size).toBe(5);
    expect(unavailable.size).toBe(0);
  });

  test("Fabric stateNode shape: canonical.publicInstance.measureInWindow", async () => {
    const pi = {
      measureInWindow(cb: (x: number, y: number, w: number, h: number) => void) {
        cb(7, 8, 9, 10);
      },
    };
    const fabricStateNode = { canonical: { publicInstance: pi } };
    const targets: MeasureTarget[] = [
      { nodeId: "f1", hostInstance: fabricStateNode },
    ];
    const { bounds, unavailable } = await measureBatch(targets, 100);
    expect(bounds.get("f1")).toEqual({ x: 7, y: 8, w: 9, h: 10 });
    expect(unavailable.has("f1")).toBe(false);
  });

  test("Fabric stateNode shape: nativeFabricUIManager fallback via host.node", async () => {
    const captured: { node: unknown } = { node: null };
    (globalThis as { nativeFabricUIManager?: unknown }).nativeFabricUIManager = {
      measureInWindow(node: unknown, cb: (x: number, y: number, w: number, h: number) => void) {
        captured.node = node;
        cb(11, 12, 13, 14);
      },
    };
    try {
      const fabricStateNode = { node: { __opaque: "shadow" } };
      const targets: MeasureTarget[] = [
        { nodeId: "f2", hostInstance: fabricStateNode },
      ];
      const { bounds, unavailable } = await measureBatch(targets, 100);
      expect(bounds.get("f2")).toEqual({ x: 11, y: 12, w: 13, h: 14 });
      expect(unavailable.has("f2")).toBe(false);
      expect(captured.node).toEqual({ __opaque: "shadow" });
    } finally {
      delete (globalThis as { nativeFabricUIManager?: unknown }).nativeFabricUIManager;
    }
  });

  test("mixed batch: some succeed, some time out", async () => {
    const targets: MeasureTarget[] = [
      { nodeId: "ok", hostInstance: fakeHost(1, 2, 3, 4) },
      { nodeId: "slow", hostInstance: silentHost() },
    ];
    const { bounds, unavailable } = await measureBatch(targets, 30);
    expect(bounds.get("ok")).toEqual({ x: 1, y: 2, w: 3, h: 4 });
    expect(bounds.get("slow")).toEqual({ x: 0, y: 0, w: 0, h: 0 });
    expect(unavailable.has("ok")).toBe(false);
    expect(unavailable.has("slow")).toBe(true);
  });
});

describe("walk does not invoke measureInWindow", () => {
  test("walking with a throwing measureInWindow does not throw", async () => {
    const { walkFiberRoot } = await import("../src/walker.js");
    const throwingStateNode = {
      measureInWindow() {
        throw new Error("walk should never call measure");
      },
    };
    // Build a minimal fiber root manually.
    const fiber = {
      tag: 5,
      type: "RCTView",
      elementType: "RCTView",
      child: null,
      sibling: null,
      return: null,
      memoizedProps: { onResponderRelease: () => {}, testID: "x" } as Record<string, unknown>,
      pendingProps: null,
      stateNode: throwingStateNode,
    };
    const dummy = {
      tag: 3,
      type: null,
      elementType: null,
      child: fiber as unknown,
      sibling: null,
      return: null,
      memoizedProps: null,
      pendingProps: null,
      stateNode: null,
    };
    fiber.return = dummy as unknown as typeof fiber;
    expect(() =>
      walkFiberRoot({ current: dummy as never }, "screen:root"),
    ).not.toThrow();
  });
});
