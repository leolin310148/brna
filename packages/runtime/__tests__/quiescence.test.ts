import { afterEach, describe, expect, test } from "bun:test";
import { waitForQuiescence } from "../src/quiescence.js";

const originalHook = (globalThis as { __REACT_DEVTOOLS_GLOBAL_HOOK__?: unknown })
  .__REACT_DEVTOOLS_GLOBAL_HOOK__;
const originalRaf = globalThis.requestAnimationFrame;
const originalPerformance = globalThis.performance;

afterEach(() => {
  (globalThis as { __REACT_DEVTOOLS_GLOBAL_HOOK__?: unknown }).__REACT_DEVTOOLS_GLOBAL_HOOK__ =
    originalHook;
  globalThis.requestAnimationFrame = originalRaf;
  Object.defineProperty(globalThis, "performance", {
    configurable: true,
    value: originalPerformance,
  });
});

describe("waitForQuiescence", () => {
  test("resolves after two stable animation frames", async () => {
    let now = 0;
    Object.defineProperty(globalThis, "performance", {
      configurable: true,
      value: { now: () => now },
    });
    globalThis.requestAnimationFrame = ((cb: FrameRequestCallback) => {
      now += 16;
      cb(now);
      return 1;
    }) as typeof requestAnimationFrame;

    await expect(waitForQuiescence(500)).resolves.toEqual({ timedOut: false });
  });

  test("times out when commits keep arriving", async () => {
    let now = 0;
    const hook = {};
    (globalThis as { __REACT_DEVTOOLS_GLOBAL_HOOK__?: unknown }).__REACT_DEVTOOLS_GLOBAL_HOOK__ =
      hook;
    Object.defineProperty(globalThis, "performance", {
      configurable: true,
      value: { now: () => now },
    });
    globalThis.requestAnimationFrame = ((cb: FrameRequestCallback) => {
      now += 100;
      (hook as { onCommitFiberRoot?: () => void }).onCommitFiberRoot?.();
      cb(now);
      return 1;
    }) as typeof requestAnimationFrame;

    await expect(waitForQuiescence(250)).resolves.toEqual({ timedOut: true });
  });
});
