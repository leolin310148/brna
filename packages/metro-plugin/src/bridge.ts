import { WebSocketServer, WebSocket } from "ws";
import type { IncomingMessage } from "node:http";
import type { Socket } from "node:net";
import { randomUUID } from "node:crypto";
import type {
  ActionRequest,
  LogRecord,
  LogsRequestOptions,
  NetworkRecord,
  NetworkRequestOptions,
  SnapshotRedactionOptions,
} from "@brna/schema";

export const SNAPSHOT_TIMEOUT_MS = 5000;
export const ACTION_TIMEOUT_MS = 5000;
export const OBSERVABILITY_TIMEOUT_MS = 5000;

export type SnapshotResult =
  | { kind: "snapshot"; snapshot: unknown }
  | { kind: "runtime_error"; code: string; message: string }
  | { kind: "timeout" }
  | { kind: "unknown_device"; device_id: string };

export type ActionResult =
  | { kind: "ok"; elapsed_ms: number }
  | { kind: "runtime_error"; code: string; message: string }
  | { kind: "timeout" }
  | { kind: "unknown_device"; device_id: string };

export type LogsResult =
  | { kind: "ok"; records: LogRecord[] }
  | { kind: "runtime_error"; code: string; message: string }
  | { kind: "timeout" }
  | { kind: "unknown_device"; device_id: string };

export type NetworkResult =
  | { kind: "ok"; records: NetworkRecord[] }
  | { kind: "runtime_error"; code: string; message: string }
  | { kind: "timeout" }
  | { kind: "unknown_device"; device_id: string };

type PendingSnapshot = {
  variant: "snapshot";
  resolve: (value: SnapshotResult) => void;
  timer: NodeJS.Timeout;
};
type PendingAction = {
  variant: "action";
  resolve: (value: ActionResult) => void;
  timer: NodeJS.Timeout;
};
type PendingLogs = {
  variant: "logs";
  resolve: (value: LogsResult) => void;
  timer: NodeJS.Timeout;
};
type PendingNetwork = {
  variant: "network";
  resolve: (value: NetworkResult) => void;
  timer: NodeJS.Timeout;
};
type Pending = PendingSnapshot | PendingAction | PendingLogs | PendingNetwork;

interface RuntimeFrame {
  type?: string;
  id?: string;
  snapshot?: unknown;
  records?: unknown;
  code?: string;
  message?: string;
  elapsed_ms?: number;
  schema_version?: string;
  session?: string;
  device_id?: string;
  platform?: string;
  os_version?: string;
  app_version?: string;
  app_name?: string;
  app_bundle_id?: string;
  // Optional native-device hints used by host-side capture tooling. Treated as
  // additive metadata; absent fields preserve existing behavior.
  native_device_id?: string;
  device_name?: string;
  is_simulator?: boolean;
}

export interface SnapshotRequestOptions {
  redaction?: SnapshotRedactionOptions;
  measureTimeoutMs?: number;
}

export interface DeviceInfo {
  id: string;
  platform?: string;
  os_version?: string;
  app_version?: string;
  app_name?: string;
  app_bundle_id?: string;
  // Optional hints from runtime hello that help host tooling map a brna
  // runtime to a native screenshot/capture target. Not required for snapshot
  // or action routing.
  native_device_id?: string;
  device_name?: string;
  is_simulator?: boolean;
  registered_at: number;
  last_seen_at: number;
  live?: boolean;
}

interface RuntimeEntry extends DeviceInfo {
  ws: WebSocket;
}

export interface DisconnectedDeviceInfo extends DeviceInfo {
  disconnected_at: number;
}

export interface BrnaBridgeOptions {
  snapshotTimeoutMs?: number;
  actionTimeoutMs?: number;
}

export class BrnaBridge {
  private devices = new Map<string, RuntimeEntry>();
  private recentDisconnected = new Map<string, DisconnectedDeviceInfo>();
  // Insertion order in `devices` is the connection order; last-registered is
  // the most recently inserted entry, used as the fallback when no
  // `x-brna-device-id` header is present.
  private pending = new Map<string, Pending>();
  private inFlight = false;
  private wss: WebSocketServer | null = null;
  private upgradeAttached = new WeakSet<object>();
  private snapshotTimeoutMs: number;
  private actionTimeoutMs: number;

  constructor(opts: BrnaBridgeOptions = {}) {
    this.snapshotTimeoutMs = opts.snapshotTimeoutMs ?? SNAPSHOT_TIMEOUT_MS;
    this.actionTimeoutMs = opts.actionTimeoutMs ?? ACTION_TIMEOUT_MS;
  }

  ensureWss(): WebSocketServer {
    if (this.wss) return this.wss;
    this.wss = new WebSocketServer({ noServer: true });
    this.wss.on("connection", (ws) => this.onConnection(ws));
    return this.wss;
  }

  attachUpgrade(server: {
    listeners: (evt: string) => Array<(req: IncomingMessage, socket: Socket, head: Buffer) => void>;
    removeAllListeners: (evt: string) => void;
    on: (evt: string, cb: (req: IncomingMessage, socket: Socket, head: Buffer) => void) => void;
  } & object): void {
    if (this.upgradeAttached.has(server)) return;
    this.upgradeAttached.add(server);
    const wss = this.ensureWss();
    const previous = server.listeners("upgrade").slice();
    server.removeAllListeners("upgrade");
    server.on("upgrade", (req: IncomingMessage, socket: Socket, head: Buffer) => {
      const url = req.url ?? "";
      if (url.startsWith("/brna/agent")) {
        wss.handleUpgrade(req, socket, head, (ws) => {
          wss.emit("connection", ws, req);
        });
        return;
      }
      for (const listener of previous) {
        try {
          listener(req, socket, head);
        } catch {
          /* delegated handlers are out of our control */
        }
      }
    });
  }

  // public so tests can attach a mock socket without going through wss.
  // Production callers reach this only via the ws server's "connection" event.
  onConnection(ws: WebSocket): void {
    // Server-generated id; `hello` may carry a runtime-supplied device_id that
    // replaces this entry under a stable key.
    const initialId = shortId();
    const entry: RuntimeEntry = {
      id: initialId,
      ws,
      registered_at: Date.now(),
      last_seen_at: Date.now(),
    };
    this.devices.set(initialId, entry);

    ws.on("message", (raw) => {
      let frame: RuntimeFrame | null = null;
      try {
        frame = JSON.parse(raw.toString("utf8")) as RuntimeFrame;
      } catch {
        frame = null;
      }
      if (!frame || typeof frame.type !== "string") return;
      entry.last_seen_at = Date.now();

      if (frame.type === "hello") {
        this.handleHello(entry, frame);
        return;
      }

      if (typeof frame.id !== "string") return;
      const pending = this.pending.get(frame.id);
      if (!pending) return; // unknown id — drop, late or foreign

      if (pending.variant === "snapshot") {
        if (frame.type === "snapshot.response") {
          clearTimeout(pending.timer);
          this.pending.delete(frame.id);
          pending.resolve({ kind: "snapshot", snapshot: frame.snapshot });
        } else if (frame.type === "snapshot.error") {
          clearTimeout(pending.timer);
          this.pending.delete(frame.id);
          pending.resolve({
            kind: "runtime_error",
            code: typeof frame.code === "string" ? frame.code : "unknown",
            message: typeof frame.message === "string" ? frame.message : "runtime error",
          });
        }
        return;
      }

      if (pending.variant === "action") {
        if (frame.type === "action.response") {
          clearTimeout(pending.timer);
          this.pending.delete(frame.id);
          const elapsed = typeof frame.elapsed_ms === "number" && Number.isFinite(frame.elapsed_ms)
            ? frame.elapsed_ms
            : 0;
          pending.resolve({ kind: "ok", elapsed_ms: elapsed });
        } else if (frame.type === "action.error") {
          clearTimeout(pending.timer);
          this.pending.delete(frame.id);
          pending.resolve({
            kind: "runtime_error",
            code: typeof frame.code === "string" ? frame.code : "unknown",
            message: typeof frame.message === "string" ? frame.message : "runtime error",
          });
        }
        return;
      }

      if (pending.variant === "logs") {
        if (frame.type === "logs.response") {
          clearTimeout(pending.timer);
          this.pending.delete(frame.id);
          const records = Array.isArray(frame.records) ? (frame.records as LogRecord[]) : [];
          pending.resolve({ kind: "ok", records });
        } else if (frame.type === "logs.error") {
          clearTimeout(pending.timer);
          this.pending.delete(frame.id);
          pending.resolve({
            kind: "runtime_error",
            code: typeof frame.code === "string" ? frame.code : "unknown",
            message: typeof frame.message === "string" ? frame.message : "runtime error",
          });
        }
        return;
      }

      if (pending.variant === "network") {
        if (frame.type === "network.response") {
          clearTimeout(pending.timer);
          this.pending.delete(frame.id);
          const records = Array.isArray(frame.records) ? (frame.records as NetworkRecord[]) : [];
          pending.resolve({ kind: "ok", records });
        } else if (frame.type === "network.error") {
          clearTimeout(pending.timer);
          this.pending.delete(frame.id);
          pending.resolve({
            kind: "runtime_error",
            code: typeof frame.code === "string" ? frame.code : "unknown",
            message: typeof frame.message === "string" ? frame.message : "runtime error",
          });
        }
        return;
      }
    });

    const removeIfMine = () => this.markDisconnected(entry);
    ws.on("close", removeIfMine);
    ws.on("error", removeIfMine);
  }

  private handleHello(entry: RuntimeEntry, frame: RuntimeFrame): void {
    const supplied = typeof frame.device_id === "string" && frame.device_id.length > 0
      ? frame.device_id
      : typeof frame.session === "string" && frame.session.length > 0
        ? frame.session
        : null;
    if (supplied && supplied !== entry.id) {
      // Re-key the entry under the runtime-supplied id. Replace any prior
      // entry holding that id (last-write-wins), closing its socket.
      const prior = this.devices.get(supplied);
      if (prior && prior.ws !== entry.ws) {
        try {
          prior.ws.close();
        } catch {
          /* ignore */
        }
        this.devices.delete(supplied);
      }
      this.devices.delete(entry.id);
      entry.id = supplied;
      this.devices.set(supplied, entry);
    }
    if (typeof frame.platform === "string") entry.platform = frame.platform;
    if (typeof frame.os_version === "string") entry.os_version = frame.os_version;
    if (typeof frame.app_version === "string") entry.app_version = frame.app_version;
    if (typeof frame.app_name === "string" && frame.app_name.length > 0) {
      entry.app_name = frame.app_name;
    }
    if (typeof frame.app_bundle_id === "string" && frame.app_bundle_id.length > 0) {
      entry.app_bundle_id = frame.app_bundle_id;
    }
    if (typeof frame.native_device_id === "string" && frame.native_device_id.length > 0) {
      entry.native_device_id = frame.native_device_id;
    }
    if (typeof frame.device_name === "string" && frame.device_name.length > 0) {
      entry.device_name = frame.device_name;
    }
    if (typeof frame.is_simulator === "boolean") {
      entry.is_simulator = frame.is_simulator;
    }
    entry.last_seen_at = Date.now();
    this.recentDisconnected.delete(entry.id);
  }

  hasRuntime(deviceId?: string): boolean {
    this.pruneClosedEntries();
    if (deviceId !== undefined) {
      const entry = this.devices.get(deviceId);
      return !!entry && entry.ws.readyState === WebSocket.OPEN;
    }
    for (const entry of this.devices.values()) {
      if (entry.ws.readyState === WebSocket.OPEN) return true;
    }
    return false;
  }

  listDevices(): DeviceInfo[] {
    this.pruneClosedEntries();
    const out: DeviceInfo[] = [];
    for (const entry of this.devices.values()) {
      if (entry.ws.readyState !== WebSocket.OPEN) continue;
      const info: DeviceInfo = {
        id: entry.id,
        registered_at: entry.registered_at,
        last_seen_at: entry.last_seen_at,
        live: true,
      };
      if (entry.platform !== undefined) info.platform = entry.platform;
      if (entry.os_version !== undefined) info.os_version = entry.os_version;
      if (entry.app_version !== undefined) info.app_version = entry.app_version;
      if (entry.app_name !== undefined) info.app_name = entry.app_name;
      if (entry.app_bundle_id !== undefined) info.app_bundle_id = entry.app_bundle_id;
      if (entry.native_device_id !== undefined) info.native_device_id = entry.native_device_id;
      if (entry.device_name !== undefined) info.device_name = entry.device_name;
      if (entry.is_simulator !== undefined) info.is_simulator = entry.is_simulator;
      out.push(info);
    }
    return out;
  }

  listRecentDisconnectedDevices(): DisconnectedDeviceInfo[] {
    return Array.from(this.recentDisconnected.values());
  }

  acquireSlot(): boolean {
    if (this.inFlight) return false;
    this.inFlight = true;
    return true;
  }

  releaseSlot(): void {
    this.inFlight = false;
  }

  private pickEntry(deviceId?: string): RuntimeEntry | { kind: "unknown" } | null {
    this.pruneClosedEntries();
    if (deviceId !== undefined) {
      const entry = this.devices.get(deviceId);
      if (!entry || entry.ws.readyState !== WebSocket.OPEN) {
        return { kind: "unknown" };
      }
      return entry;
    }
    let last: RuntimeEntry | null = null;
    for (const entry of this.devices.values()) {
      if (entry.ws.readyState === WebSocket.OPEN) last = entry;
    }
    return last;
  }

  async requestSnapshot(deviceId?: string, options: SnapshotRequestOptions = {}): Promise<SnapshotResult> {
    const picked = this.pickEntry(deviceId);
    if (picked && "kind" in picked) {
      return { kind: "unknown_device", device_id: deviceId! };
    }
    if (!picked) throw new Error("no_runtime_connected");
    const ws = picked.ws;
    const id = randomUUID();
    return new Promise<SnapshotResult>((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        this.markDisconnected(picked);
        resolve({ kind: "timeout" });
      }, this.snapshotTimeoutMs);
      this.pending.set(id, { variant: "snapshot", resolve, timer });
      try {
        ws.send(JSON.stringify({ type: "snapshot.request", id, options }));
      } catch (err) {
        clearTimeout(timer);
        this.pending.delete(id);
        resolve({
          kind: "runtime_error",
          code: "bridge_send_failed",
          message: (err as Error).message,
        });
      }
    });
  }

  async requestLogs(options: LogsRequestOptions = {}, deviceId?: string): Promise<LogsResult> {
    const picked = this.pickEntry(deviceId);
    if (picked && "kind" in picked) {
      return { kind: "unknown_device", device_id: deviceId! };
    }
    if (!picked) throw new Error("no_runtime_connected");
    const ws = picked.ws;
    const id = randomUUID();
    return new Promise<LogsResult>((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        this.markDisconnected(picked);
        resolve({ kind: "timeout" });
      }, OBSERVABILITY_TIMEOUT_MS);
      this.pending.set(id, { variant: "logs", resolve, timer });
      try {
        ws.send(JSON.stringify({ type: "logs.request", id, options }));
      } catch (err) {
        clearTimeout(timer);
        this.pending.delete(id);
        resolve({
          kind: "runtime_error",
          code: "bridge_send_failed",
          message: (err as Error).message,
        });
      }
    });
  }

  async requestNetwork(
    options: NetworkRequestOptions = {},
    deviceId?: string,
  ): Promise<NetworkResult> {
    const picked = this.pickEntry(deviceId);
    if (picked && "kind" in picked) {
      return { kind: "unknown_device", device_id: deviceId! };
    }
    if (!picked) throw new Error("no_runtime_connected");
    const ws = picked.ws;
    const id = randomUUID();
    return new Promise<NetworkResult>((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        this.markDisconnected(picked);
        resolve({ kind: "timeout" });
      }, OBSERVABILITY_TIMEOUT_MS);
      this.pending.set(id, { variant: "network", resolve, timer });
      try {
        ws.send(JSON.stringify({ type: "network.request", id, options }));
      } catch (err) {
        clearTimeout(timer);
        this.pending.delete(id);
        resolve({
          kind: "runtime_error",
          code: "bridge_send_failed",
          message: (err as Error).message,
        });
      }
    });
  }

  async requestAction(action: ActionRequest, deviceId?: string): Promise<ActionResult> {
    const picked = this.pickEntry(deviceId);
    if (picked && "kind" in picked) {
      return { kind: "unknown_device", device_id: deviceId! };
    }
    if (!picked) throw new Error("no_runtime_connected");
    const ws = picked.ws;
    const id = randomUUID();
    return new Promise<ActionResult>((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        this.markDisconnected(picked);
        resolve({ kind: "timeout" });
      }, this.actionTimeoutMs);
      this.pending.set(id, { variant: "action", resolve, timer });
      try {
        ws.send(JSON.stringify({ type: "action.request", id, action }));
      } catch (err) {
        clearTimeout(timer);
        this.pending.delete(id);
        resolve({
          kind: "runtime_error",
          code: "bridge_send_failed",
          message: (err as Error).message,
        });
      }
    });
  }

  private pruneClosedEntries(): void {
    for (const entry of this.devices.values()) {
      if (entry.ws.readyState !== WebSocket.OPEN) this.markDisconnected(entry);
    }
  }

  private markDisconnected(entry: RuntimeEntry): void {
    const current = this.devices.get(entry.id);
    if (!current || current.ws !== entry.ws) return;
    const now = Date.now();
    this.recentDisconnected.set(entry.id, {
      id: entry.id,
      platform: entry.platform,
      os_version: entry.os_version,
      app_version: entry.app_version,
      app_name: entry.app_name,
      app_bundle_id: entry.app_bundle_id,
      native_device_id: entry.native_device_id,
      device_name: entry.device_name,
      is_simulator: entry.is_simulator,
      registered_at: entry.registered_at,
      last_seen_at: entry.last_seen_at || now,
      disconnected_at: now,
      live: false,
    });
    this.devices.delete(entry.id);
    try {
      entry.ws.close();
    } catch {
      /* ignore cleanup errors */
    }
  }
}

function shortId(): string {
  return randomUUID().replace(/-/g, "").slice(0, 12);
}

let singleton: BrnaBridge | null = null;
export function getBridge(): BrnaBridge {
  if (!singleton) singleton = new BrnaBridge();
  return singleton;
}
