const DEFAULT_QUIESCENCE_TIMEOUT_MS = 500;

interface DevToolsHookWithCommits {
  onCommitFiberRoot?: (...args: unknown[]) => unknown;
}

let installedHook: DevToolsHookWithCommits | null = null;
let lastCommitAt = 0;

export interface QuiescenceResult {
  timedOut: boolean;
}

export function installFiberCommitTracker(): void {
  const hook = (globalThis as { __REACT_DEVTOOLS_GLOBAL_HOOK__?: unknown })
    .__REACT_DEVTOOLS_GLOBAL_HOOK__ as DevToolsHookWithCommits | undefined;
  if (!hook || hook === installedHook) return;

  const previous = hook.onCommitFiberRoot;
  hook.onCommitFiberRoot = (...args: unknown[]) => {
    lastCommitAt = now();
    return previous?.apply(hook, args);
  };
  installedHook = hook;
}

export async function waitForQuiescence(timeoutMs = DEFAULT_QUIESCENCE_TIMEOUT_MS): Promise<QuiescenceResult> {
  installFiberCommitTracker();
  const startedAt = now();
  let stableFrames = 0;
  let observedCommitAt = lastCommitAt;

  while (now() - startedAt < timeoutMs) {
    await nextFrame();
    if (lastCommitAt === observedCommitAt) {
      stableFrames += 1;
      if (stableFrames >= 2) return { timedOut: false };
    } else {
      observedCommitAt = lastCommitAt;
      stableFrames = 0;
    }
  }

  return { timedOut: true };
}

function nextFrame(): Promise<void> {
  return new Promise((resolve) => {
    const raf = (globalThis as { requestAnimationFrame?: (cb: FrameRequestCallback) => number })
      .requestAnimationFrame;
    if (typeof raf === "function") {
      raf(() => resolve());
      return;
    }
    setTimeout(resolve, 16);
  });
}

function now(): number {
  const perf = (globalThis as { performance?: { now?: () => number } }).performance;
  return typeof perf?.now === "function" ? perf.now() : Date.now();
}
