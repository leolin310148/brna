import type { Bounds } from "@brna/schema";
import type { MeasureTarget } from "./walker.js";

export const DEFAULT_MEASURE_TIMEOUT_MS = 100;

export interface MeasureBatchResult {
  bounds: Map<string, Bounds>;
  unavailable: Set<string>;
}

type MeasureCallback = (x: number, y: number, w: number, h: number) => void;
type MeasureFn = (cb: MeasureCallback) => void;

interface FabricUIManager {
  measureInWindow(node: unknown, cb: MeasureCallback): void;
}

function getFabricUIManager(): FabricUIManager | null {
  const g = globalThis as { nativeFabricUIManager?: FabricUIManager };
  if (g.nativeFabricUIManager && typeof g.nativeFabricUIManager.measureInWindow === "function") {
    return g.nativeFabricUIManager;
  }
  return null;
}

function resolveMeasureFn(host: unknown): MeasureFn | null {
  if (!host || typeof host !== "object") return null;
  const direct = host as { measureInWindow?: unknown };
  if (typeof direct.measureInWindow === "function") {
    return (cb) => (direct.measureInWindow as (c: MeasureCallback) => void)(cb);
  }
  const canonical = (host as { canonical?: { publicInstance?: { measureInWindow?: unknown } } }).canonical;
  const pi = canonical?.publicInstance;
  if (pi && typeof pi.measureInWindow === "function") {
    return (cb) => (pi.measureInWindow as (c: MeasureCallback) => void).call(pi, cb);
  }
  const fabricNode = (host as { node?: unknown }).node;
  if (fabricNode) {
    const fab = getFabricUIManager();
    if (fab) return (cb) => fab.measureInWindow(fabricNode, cb);
  }
  return null;
}

export function measureBatch(
  targets: MeasureTarget[],
  timeoutMs: number = DEFAULT_MEASURE_TIMEOUT_MS,
): Promise<MeasureBatchResult> {
  const bounds = new Map<string, Bounds>();
  const unavailable = new Set<string>();

  const promises = targets.map((target) => measureOne(target, timeoutMs).then((result) => {
    if (result.kind === "ok") {
      bounds.set(target.nodeId, result.bounds);
    } else {
      bounds.set(target.nodeId, { x: 0, y: 0, w: 0, h: 0 });
      unavailable.add(target.nodeId);
    }
  }));

  return Promise.all(promises).then(() => ({ bounds, unavailable }));
}

type MeasureOutcome = { kind: "ok"; bounds: Bounds } | { kind: "unavailable" };

function measureOne(target: MeasureTarget, timeoutMs: number): Promise<MeasureOutcome> {
  const measureFn = resolveMeasureFn(target.hostInstance);
  if (!measureFn) {
    return Promise.resolve({ kind: "unavailable" });
  }

  return new Promise<MeasureOutcome>((resolve) => {
    let settled = false;
    const finish = (outcome: MeasureOutcome) => {
      if (settled) return;
      settled = true;
      resolve(outcome);
    };

    const timer = setTimeout(() => finish({ kind: "unavailable" }), timeoutMs);

    try {
      measureFn((x, y, w, h) => {
        clearTimeout(timer);
        if (
          typeof x === "number" &&
          typeof y === "number" &&
          typeof w === "number" &&
          typeof h === "number" &&
          Number.isFinite(x) &&
          Number.isFinite(y) &&
          Number.isFinite(w) &&
          Number.isFinite(h)
        ) {
          finish({ kind: "ok", bounds: { x, y, w, h } });
        } else {
          finish({ kind: "unavailable" });
        }
      });
    } catch {
      clearTimeout(timer);
      finish({ kind: "unavailable" });
    }
  });
}
