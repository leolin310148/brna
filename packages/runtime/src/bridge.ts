import { Platform } from "react-native";
import {
  SCHEMA_VERSION,
  validateActionRequest,
  BrnaValidationError,
  parseLogsRequestOptions,
  parseNetworkRequestOptions,
  type SnapshotRedactionOptions,
} from "@brna/schema";
import { captureSnapshot } from "./capture.js";
import { dispatchAction } from "./dispatch.js";
import { getLogs, getNetwork } from "./observability.js";
import { sessionId } from "./session.js";

interface ConnectAgentOptions {
  metroUrl: string;
}

interface AppMetadata {
  app_name?: string;
  app_bundle_id?: string;
  app_version?: string;
}

interface NativeDeviceHints {
  device_name?: string;
  is_simulator?: boolean;
}

function readNativeDeviceHints(): NativeDeviceHints {
  const hints: NativeDeviceHints = {};
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const Constants = (require as unknown as (id: string) => unknown)("expo-constants") as
      | {
          default?: {
            deviceName?: string;
            isDevice?: boolean;
            platform?: { ios?: { simulator?: boolean }; android?: { isDevice?: boolean } };
          };
        }
      | undefined;
    const c = Constants?.default;
    if (c) {
      if (typeof c.deviceName === "string" && c.deviceName.length > 0) {
        hints.device_name = c.deviceName;
      }
      if (Platform.OS === "ios" && typeof c.platform?.ios?.simulator === "boolean") {
        hints.is_simulator = c.platform.ios.simulator;
      } else if (typeof c.isDevice === "boolean") {
        hints.is_simulator = !c.isDevice;
      }
    }
  } catch {
    /* expo-constants is optional */
  }
  return hints;
}

function readAppMetadata(): AppMetadata {
  const meta: AppMetadata = {};
  // React Native does not expose app metadata directly without native modules.
  // Pick up commonly available fields from optional Expo Constants when present
  // — but never throw or require the dependency.
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const Constants = (require as unknown as (id: string) => unknown)("expo-constants") as
      | {
          default?: {
            expoConfig?: {
              name?: string;
              version?: string;
              ios?: { bundleIdentifier?: string };
              android?: { package?: string };
            };
            manifest?: {
              name?: string;
              version?: string;
              ios?: { bundleIdentifier?: string };
              android?: { package?: string };
            };
            manifest2?: { extra?: { expoClient?: { name?: string; version?: string } } };
          };
        }
      | undefined;
    const expoConfig = Constants?.default?.expoConfig ?? Constants?.default?.manifest;
    if (expoConfig) {
      if (typeof expoConfig.name === "string" && expoConfig.name.length > 0) {
        meta.app_name = expoConfig.name;
      }
      if (typeof expoConfig.version === "string" && expoConfig.version.length > 0) {
        meta.app_version = expoConfig.version;
      }
      const bundleId = Platform.OS === "android"
        ? expoConfig.android?.package
        : expoConfig.ios?.bundleIdentifier;
      if (typeof bundleId === "string" && bundleId.length > 0) {
        meta.app_bundle_id = bundleId;
      }
    }
  } catch {
    /* expo-constants is optional — bare RN apps will hit this branch */
  }
  return meta;
}

interface IncomingFrame {
  type?: string;
  id?: string;
  action?: unknown;
  options?:
    | { redaction?: SnapshotRedactionOptions; measureTimeoutMs?: number }
    | Record<string, unknown>;
}

let activeSocket: WebSocket | null = null;

export function connectAgent({ metroUrl }: ConnectAgentOptions): void {
  if (activeSocket) return;
  const wsUrl = httpToWs(metroUrl) + "/brna/agent";
  let socket: WebSocket;
  try {
    socket = new WebSocket(wsUrl);
  } catch {
    return;
  }
  activeSocket = socket;

  socket.onopen = () => {
    safeSend(socket, {
      type: "hello",
      session: sessionId(),
      device_id: sessionId(),
      schema_version: SCHEMA_VERSION,
      platform: Platform.OS === "android" ? "android" : "ios",
      os_version: String(Platform.Version ?? "0"),
      ...readAppMetadata(),
      ...readNativeDeviceHints(),
    });
  };

  socket.onmessage = (event: { data: unknown }) => {
    let frame: IncomingFrame | null = null;
    try {
      frame = typeof event.data === "string" ? (JSON.parse(event.data) as IncomingFrame) : null;
    } catch {
      frame = null;
    }
    if (!frame || typeof frame.type !== "string" || typeof frame.id !== "string") return;
    const requestId = frame.id;

    if (frame.type === "logs.request") {
      try {
        const options = parseLogsRequestOptions(frame.options);
        const records = getLogs(options);
        safeSend(socket, { type: "logs.response", id: requestId, records });
      } catch (err) {
        safeSend(socket, {
          type: "logs.error",
          id: requestId,
          code: "logs_failed",
          message: (err as Error).message ?? "logs read failed",
        });
      }
      return;
    }

    if (frame.type === "network.request") {
      try {
        const options = parseNetworkRequestOptions(frame.options);
        const records = getNetwork(options);
        safeSend(socket, { type: "network.response", id: requestId, records });
      } catch (err) {
        safeSend(socket, {
          type: "network.error",
          id: requestId,
          code: "network_failed",
          message: (err as Error).message ?? "network read failed",
        });
      }
      return;
    }

    if (frame.type === "snapshot.request") {
      const snapOpts = frame.options as
        | { redaction?: SnapshotRedactionOptions; measureTimeoutMs?: number }
        | undefined;
      captureSnapshot({
        redaction: snapOpts?.redaction,
        measureTimeoutMs: snapOpts?.measureTimeoutMs,
      })
        .then((snapshot) => {
          safeSend(socket, { type: "snapshot.response", id: requestId, snapshot });
        })
        .catch((err: unknown) => {
          const e = err as { code?: string; message?: string };
          safeSend(socket, {
            type: "snapshot.error",
            id: requestId,
            code: typeof e.code === "string" ? e.code : "capture_failed",
            message: typeof e.message === "string" ? e.message : "snapshot capture failed",
          });
        });
      return;
    }

    if (frame.type === "action.request") {
      handleActionRequest(socket, requestId, frame.action);
      return;
    }
    // Unknown frame types are silently ignored, matching the existing
    // contract on the metro side.
  };

  socket.onclose = () => {
    activeSocket = null;
  };

  socket.onerror = () => {
    /* swallow — no retry in v0 */
  };
}

function httpToWs(url: string): string {
  if (url.startsWith("https://")) return "wss://" + url.slice("https://".length);
  if (url.startsWith("http://")) return "ws://" + url.slice("http://".length);
  return url;
}

function safeSend(socket: WebSocket, frame: unknown): void {
  try {
    socket.send(JSON.stringify(frame));
  } catch {
    /* swallow — bridge errors are non-fatal */
  }
}

function handleActionRequest(socket: WebSocket, requestId: string, rawAction: unknown): void {
  let action;
  try {
    action = validateActionRequest(rawAction);
  } catch (err) {
    safeSend(socket, {
      type: "action.error",
      id: requestId,
      code: "invalid_action",
      message: err instanceof BrnaValidationError ? err.message : "invalid action shape",
    });
    return;
  }

  const startedAt = Date.now();
  dispatchAction(action)
    .then((outcome) => {
      if (outcome.ok) {
        safeSend(socket, {
          type: "action.response",
          id: requestId,
          elapsed_ms: Date.now() - startedAt,
        });
      } else {
        safeSend(socket, {
          type: "action.error",
          id: requestId,
          code: outcome.code,
          message: outcome.message,
        });
      }
    })
    .catch((err: unknown) => {
      // Defensive: dispatchAction is meant to swallow handler throws and
      // return action_failed. Any unhandled throw still maps to action_failed
      // so the request id always gets exactly one reply.
      safeSend(socket, {
        type: "action.error",
        id: requestId,
        code: "action_failed",
        message: (err as Error)?.message ?? "dispatch threw",
      });
    });
}
