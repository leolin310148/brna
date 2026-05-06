import { Platform, Dimensions, NativeModules } from "react-native";
import type { Node, Snapshot, SnapshotRedactionOptions, SnapshotWarning } from "@brna/schema";
import { SCHEMA_VERSION } from "@brna/schema";
import { annotateSuggestedSelectors, populateSelectors } from "@brna/core/selector";
import { findRenderer, getFiberRoots } from "./devtools.js";
import { countInferredLabels, findFirstSource, walkFiberRoot, type MeasureTarget } from "./walker.js";
import { measureBatch } from "./measure.js";
import { sessionId, freshUuid } from "./session.js";
import { ROOT_ID } from "./constants.js";
import { waitForQuiescence } from "./quiescence.js";
import { redactSnapshot } from "./redact.js";
import { computeUsabilityWarnings } from "./usability.js";
import { computeSnapshotHash } from "./hash.js";
import { getNativeAlertOverlays } from "./native-alerts.js";

export interface CaptureOptions {
  timeout_ms?: number;
  measureTimeoutMs?: number;
  redaction?: SnapshotRedactionOptions;
}

function readAppInfo(): { bundle_id: string; version: string; rn_version?: string } {
  const SourceCode = (NativeModules as Record<string, unknown>).SourceCode as
    | { getConstants?: () => Record<string, unknown> }
    | undefined;
  const constants = SourceCode?.getConstants?.() ?? {};
  const scriptURL = (constants as Record<string, unknown>).scriptURL;
  const bundle_id = typeof scriptURL === "string" ? scriptURL : "unknown";
  const version =
    (Platform.constants && (Platform.constants as Record<string, unknown>).reactNativeVersion
      ? formatRnVersion((Platform.constants as Record<string, unknown>).reactNativeVersion)
      : null) ?? "0.0.0";
  return { bundle_id, version, rn_version: version };
}

function formatRnVersion(v: unknown): string | null {
  if (v && typeof v === "object") {
    const obj = v as Record<string, unknown>;
    const major = obj.major,
      minor = obj.minor,
      patch = obj.patch;
    if (
      typeof major === "number" &&
      typeof minor === "number" &&
      typeof patch === "number"
    ) {
      return `${major}.${minor}.${patch}`;
    }
  }
  return null;
}

function readDeviceInfo() {
  const window = Dimensions.get("window");
  const platform = Platform.OS === "android" ? "android" : "ios";
  const osVersion = String(Platform.Version ?? "0");
  return {
    platform: platform as "ios" | "android",
    os_version: osVersion,
    model: "unknown",
    viewport: { w: window.width, h: window.height, scale: window.scale },
    locale: "en",
  };
}

export async function captureSnapshot(options: CaptureOptions = {}): Promise<Snapshot> {
  const { id: rendererId } = findRenderer();
  const quiescence = await waitForQuiescence(options.timeout_ms ?? 500);
  const roots = getFiberRoots(rendererId);

  const allChildren: Node[] = [];
  const warnings: SnapshotWarning[] = [];
  if (quiescence.timedOut) warnings.push({ code: "quiescence_timeout" });
  const measureTargets: MeasureTarget[] = [];

  for (const root of roots) {
    const { rootChildren, warnings: w, measureTargets: t } = walkFiberRoot(root, ROOT_ID);
    allChildren.push(...rootChildren);
    warnings.push(...w);
    measureTargets.push(...t);
  }

  const { bounds, unavailable } = await measureBatch(measureTargets, options.measureTimeoutMs);

  for (const id of unavailable) {
    warnings.push({ code: "bounds_unavailable", node: id });
  }

  applyBounds(allChildren, bounds);

  warnings.push(...computeUsabilityWarnings(allChildren, unavailable));

  const inferredCount = countInferredLabels(allChildren);
  if (inferredCount > 0) {
    warnings.push({ code: "inferred_label_debt", count: inferredCount });
  }

  const rawTree: Node = {
    id: ROOT_ID,
    kind: "screen",
    children: allChildren.length > 0 ? allChildren : undefined,
  };

  const primarySource = findFirstSource(allChildren);
  const tree = populateSelectors(rawTree);

  const overlays = getNativeAlertOverlays();
  const baseSnapshot: Snapshot = {
    meta: {
      schema_version: SCHEMA_VERSION,
      captured_at: new Date().toISOString(),
      app: readAppInfo(),
      device: readDeviceInfo(),
      session_id: sessionId(),
      snapshot_id: freshUuid(),
      ...(warnings.length > 0 ? { warnings } : {}),
      ...(primarySource ? { source: primarySource } : {}),
    },
    screen: { modal_stack: overlays.map((overlay) => overlay.name ?? overlay.id) },
    tree,
    ...(overlays.length > 0 ? { overlays } : {}),
  };

  const annotated = annotateSuggestedSelectors(baseSnapshot);
  const redacted = redactSnapshot(annotated, options.redaction);
  redacted.meta.hash = computeSnapshotHash(redacted);
  return redacted;
}


function applyBounds(nodes: Node[], bounds: Map<string, { x: number; y: number; w: number; h: number }>): void {
  for (const node of nodes) {
    const b = bounds.get(node.id);
    if (b) node.bounds = b;
    if (node.children) applyBounds(node.children, bounds);
  }
}
