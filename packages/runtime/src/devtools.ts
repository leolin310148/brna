import { BrnaRuntimeError } from "./errors.js";

export interface DebugSource {
  fileName?: string;
  lineNumber?: number;
  columnNumber?: number;
}

export interface AnyFiber {
  tag: number;
  type: unknown;
  elementType?: unknown;
  child: AnyFiber | null;
  sibling: AnyFiber | null;
  return: AnyFiber | null;
  memoizedProps: Record<string, unknown> | null;
  pendingProps: Record<string, unknown> | null;
  stateNode: unknown;
  _debugSource?: DebugSource | null;
}

export interface FiberRoot {
  current: AnyFiber;
}

interface DevToolsRenderer {
  rendererPackageName?: string;
  bundleType?: number;
  version?: string;
  findFiberByHostInstance?: unknown;
}

interface DevToolsHook {
  renderers: Map<number, DevToolsRenderer>;
  getFiberRoots: (rendererID: number) => Set<FiberRoot>;
}

function getHook(): DevToolsHook {
  const hook = (globalThis as { __REACT_DEVTOOLS_GLOBAL_HOOK__?: unknown })
    .__REACT_DEVTOOLS_GLOBAL_HOOK__ as DevToolsHook | undefined;
  if (!hook || !hook.renderers || typeof hook.getFiberRoots !== "function") {
    throw new BrnaRuntimeError("devtools_hook_missing");
  }
  return hook;
}

export function findRenderer(): { id: number; renderer: DevToolsRenderer } {
  const hook = getHook();
  for (const [id, renderer] of hook.renderers.entries()) {
    const pkg = renderer?.rendererPackageName;
    if (
      pkg === "react-native-renderer" ||
      pkg === "react-native" ||
      pkg === "react-native/Libraries/Renderer/shims/ReactNative"
    ) {
      return { id, renderer };
    }
  }
  for (const [id, renderer] of hook.renderers.entries()) {
    if (typeof renderer?.findFiberByHostInstance === "function") {
      return { id, renderer };
    }
  }
  throw new BrnaRuntimeError("no_react_native_renderer");
}

export function getFiberRoots(rendererId: number): FiberRoot[] {
  const hook = getHook();
  const roots = hook.getFiberRoots(rendererId);
  if (!roots || roots.size === 0) {
    throw new BrnaRuntimeError("no_fiber_roots");
  }
  return Array.from(roots);
}
