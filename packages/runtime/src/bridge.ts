import { Platform } from "react-native";
import {
  SCHEMA_VERSION,
  validateActionRequest,
  BrnaValidationError,
  type SnapshotRedactionOptions,
} from "@brna/schema";
import { captureSnapshot } from "./capture.js";
import { dispatchAction } from "./dispatch.js";
import { sessionId } from "./session.js";

interface ConnectAgentOptions {
  metroUrl: string;
}

interface IncomingFrame {
  type?: string;
  id?: string;
  action?: unknown;
  options?: { redaction?: SnapshotRedactionOptions; measureTimeoutMs?: number };
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

    if (frame.type === "snapshot.request") {
      captureSnapshot({
        redaction: frame.options?.redaction,
        measureTimeoutMs: frame.options?.measureTimeoutMs,
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
