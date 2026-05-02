import type { Snapshot, SnapshotMeta } from "@brna/schema";
import { SCHEMA_VERSION } from "@brna/schema";

export function makeMeta(overrides: Partial<SnapshotMeta> = {}): SnapshotMeta {
  return {
    schema_version: SCHEMA_VERSION,
    captured_at: "2026-05-01T12:00:00.000Z",
    app: { bundle_id: "com.example.app", version: "1.0.0 (1)", rn_version: "0.76.0" },
    device: {
      platform: "ios",
      os_version: "17.4",
      model: "iPhone 15 Pro",
      viewport: { w: 393, h: 852, scale: 3 },
      locale: "en-US",
    },
    session_id: "00000000-0000-0000-0000-000000000001",
    snapshot_id: "00000000-0000-0000-0000-000000000002",
    ...overrides,
  };
}

export function makeSnapshot(parts: Partial<Snapshot> & Pick<Snapshot, "tree">): Snapshot {
  return {
    meta: parts.meta ?? makeMeta(),
    screen: parts.screen ?? { modal_stack: [] },
    tree: parts.tree,
    ...(parts.overlays ? { overlays: parts.overlays } : {}),
  };
}
