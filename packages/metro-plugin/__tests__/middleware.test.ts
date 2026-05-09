import { describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { BrnaBridge, getBridge } from "../src/bridge.js";
import {
  brnaMiddleware,
  handleAction,
  handleDevices,
  handleLogs,
  handleSnapshot,
  handleSnapshotPost,
} from "../src/middleware.js";

interface MockSocket extends EventEmitter {
  readyState: number;
  send: (data: string) => void;
  sent: string[];
  close: () => void;
}

function makeMockSocket(): MockSocket {
  const ee = new EventEmitter() as MockSocket;
  ee.readyState = 1;
  ee.sent = [];
  ee.send = (data: string) => {
    ee.sent.push(data);
  };
  ee.close = () => {
    ee.readyState = 3;
    ee.emit("close");
  };
  return ee;
}

function lastSent(socket: MockSocket): { type: string; id: string } & Record<string, unknown> {
  const raw = socket.sent.at(-1);
  if (!raw) throw new Error("nothing sent");
  return JSON.parse(raw) as { type: string; id: string };
}

interface MockRes {
  statusCode: number;
  headers: Record<string, string>;
  setHeader: (k: string, v: string) => void;
  end: (body?: string) => void;
  body: string;
  ended: boolean;
}

function makeMockRes(): MockRes {
  const res: MockRes = {
    statusCode: 0,
    headers: {},
    setHeader(k, v) {
      this.headers[k] = v;
    },
    end(body?: string) {
      if (body !== undefined) this.body = body;
      this.ended = true;
    },
    body: "",
    ended: false,
  };
  return res;
}

interface MockReq extends EventEmitter {
  url: string;
  method: string;
  headers: Record<string, string>;
  socket?: { server?: object };
}

function makeMockReq(): MockReq {
  const ee = new EventEmitter() as MockReq;
  ee.url = "/brna/action";
  ee.method = "POST";
  ee.headers = {};
  return ee;
}

function feedBody(req: MockReq, body: string): void {
  // emit on next tick to match real http behaviour where data arrives async
  setImmediate(() => {
    req.emit("data", Buffer.from(body));
    req.emit("end");
  });
}

function attachRuntime(bridge: BrnaBridge): MockSocket {
  const ws = makeMockSocket();
  bridge.onConnection(ws as unknown as Parameters<BrnaBridge["onConnection"]>[0]);
  return ws;
}

const OVERSIZED_JSON_BODY = JSON.stringify({ text: "x".repeat(65 * 1024) });

describe("brnaMiddleware", () => {
  test("passes through paths that only share a brna endpoint prefix", () => {
    const req = makeMockReq();
    req.method = "GET";
    req.url = "/brna/networking";
    req.socket = {};
    const res = makeMockRes();
    let nextCalled = false;

    brnaMiddleware()(req as never, res as never, () => {
      nextCalled = true;
    });

    expect(nextCalled).toBe(true);
    expect(res.ended).toBe(false);
  });

  test("trims device id headers before routing snapshot requests", async () => {
    const bridge = getBridge();
    const ws = attachRuntime(bridge);
    ws.emit("message", Buffer.from(JSON.stringify({ type: "hello", device_id: "dev-a" })));

    const req = makeMockReq();
    req.method = "GET";
    req.url = "/brna/snapshot";
    req.headers = { "x-brna-device-id": "  dev-a  " };
    req.socket = {};
    const res = makeMockRes();

    brnaMiddleware()(req as never, res as never, () => {
      throw new Error("middleware should handle snapshot request");
    });

    const frame = lastSent(ws);
    ws.emit("message", Buffer.from(JSON.stringify({ type: "snapshot.response", id: frame.id, snapshot: { ok: true } })));
    await new Promise((r) => setImmediate(r));

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ ok: true });
  });
});

describe("handleAction", () => {
  test("returns 204 with empty body on action.response", async () => {
    const bridge = new BrnaBridge();
    const ws = attachRuntime(bridge);
    const req = makeMockReq();
    const res = makeMockRes();

    const promise = handleAction(bridge, req as never, res as never);
    feedBody(req, JSON.stringify({ kind: "tap", selector: "#x", target_id: "x" }));

    // wait until the bridge has sent the WS frame
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    const frame = lastSent(ws);
    ws.emit(
      "message",
      Buffer.from(JSON.stringify({ type: "action.response", id: frame.id, elapsed_ms: 4 })),
    );
    await promise;
    expect(res.statusCode).toBe(204);
    expect(res.body).toBe("");
  });

  test("returns 502 with runtime_error body on action.error", async () => {
    const bridge = new BrnaBridge();
    const ws = attachRuntime(bridge);
    const req = makeMockReq();
    const res = makeMockRes();

    const promise = handleAction(bridge, req as never, res as never);
    feedBody(req, JSON.stringify({ kind: "tap", selector: "#x", target_id: "x" }));
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    const frame = lastSent(ws);
    ws.emit(
      "message",
      Buffer.from(
        JSON.stringify({
          type: "action.error",
          id: frame.id,
          code: "target_disabled",
          message: "node is disabled",
        }),
      ),
    );
    await promise;
    expect(res.statusCode).toBe(502);
    const body = JSON.parse(res.body) as { error: string; code: string };
    expect(body.error).toBe("runtime_error");
    expect(body.code).toBe("target_disabled");
  });

  test("returns 503 when no runtime is connected", async () => {
    const bridge = new BrnaBridge();
    const req = makeMockReq();
    const res = makeMockRes();

    const promise = handleAction(bridge, req as never, res as never);
    feedBody(req, JSON.stringify({ kind: "tap", selector: "#x", target_id: "x" }));
    await promise;
    expect(res.statusCode).toBe(503);
    const body = JSON.parse(res.body) as { error: string };
    expect(body.error).toBe("no_runtime_connected");
  });

  test("returns 400 on malformed JSON", async () => {
    const bridge = new BrnaBridge();
    attachRuntime(bridge);
    const req = makeMockReq();
    const res = makeMockRes();

    const promise = handleAction(bridge, req as never, res as never);
    feedBody(req, "not json");
    await promise;
    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.body) as { error: string };
    expect(body.error).toBe("malformed_action_request");
  });

  test("returns 413 when action body exceeds the JSON body limit", async () => {
    const bridge = new BrnaBridge();
    attachRuntime(bridge);
    const req = makeMockReq();
    const res = makeMockRes();

    const promise = handleAction(bridge, req as never, res as never);
    feedBody(req, OVERSIZED_JSON_BODY);
    await promise;
    expect(res.statusCode).toBe(413);
    expect(JSON.parse(res.body)).toEqual({ error: "request_body_too_large", max_bytes: 64 * 1024 });
  });

  test("returns 400 on schema-invalid action body", async () => {
    const bridge = new BrnaBridge();
    attachRuntime(bridge);
    const req = makeMockReq();
    const res = makeMockRes();

    const promise = handleAction(bridge, req as never, res as never);
    feedBody(req, JSON.stringify({ kind: "swipe", selector: "#x", target_id: "x" }));
    await promise;
    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.body) as { error: string };
    expect(body.error).toBe("malformed_action_request");
  });

  test("returns 429 when slot is held", async () => {
    const bridge = new BrnaBridge();
    attachRuntime(bridge);
    bridge.acquireSlot();

    const req = makeMockReq();
    const res = makeMockRes();
    const promise = handleAction(bridge, req as never, res as never);
    feedBody(req, JSON.stringify({ kind: "tap", selector: "#x", target_id: "x" }));
    await promise;
    expect(res.statusCode).toBe(429);
    const body = JSON.parse(res.body) as { error: string };
    expect(body.error).toBe("request_in_flight");
  });
});

describe("snapshot/action shared single-flight slot", () => {
  test("action is rejected with 429 while snapshot is in flight", async () => {
    const bridge = new BrnaBridge();
    attachRuntime(bridge);
    const snapRes = makeMockRes();
    handleSnapshot(bridge, snapRes as never);
    // snapshot acquired the slot but has not received a runtime reply yet

    const actReq = makeMockReq();
    const actRes = makeMockRes();
    const promise = handleAction(bridge, actReq as never, actRes as never);
    feedBody(actReq, JSON.stringify({ kind: "tap", selector: "#x", target_id: "x" }));
    await promise;
    expect(actRes.statusCode).toBe(429);
  });

  test("snapshot is rejected with 429 while action is in flight", async () => {
    const bridge = new BrnaBridge();
    attachRuntime(bridge);
    const actReq = makeMockReq();
    const actRes = makeMockRes();
    void handleAction(bridge, actReq as never, actRes as never);
    feedBody(actReq, JSON.stringify({ kind: "tap", selector: "#x", target_id: "x" }));
    // ensure body is consumed and slot acquired before contending
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));

    const snapRes = makeMockRes();
    handleSnapshot(bridge, snapRes as never);
    expect(snapRes.statusCode).toBe(429);
  });
});

describe("handleSnapshot", () => {
  test("returns immediate errors before requesting snapshots", () => {
    const noRuntime = {
      hasRuntime: () => false,
    } as unknown as BrnaBridge;
    const noRuntimeRes = makeMockRes();
    handleSnapshot(noRuntime, noRuntimeRes as never);
    expect(noRuntimeRes.statusCode).toBe(503);

    const unknownDevice = {
      hasRuntime: (deviceId?: string) => deviceId === undefined,
    } as unknown as BrnaBridge;
    const unknownRes = makeMockRes();
    handleSnapshot(unknownDevice, unknownRes as never, "missing");
    expect(unknownRes.statusCode).toBe(404);
  });

  test("serialises snapshot success and runtime result variants", async () => {
    for (const [result, status, error] of [
      [{ kind: "snapshot", snapshot: { ok: true } }, 200, undefined],
      [{ kind: "timeout" }, 504, "runtime_timeout"],
      [{ kind: "unknown_device", device_id: "dev-x" }, 404, "unknown_device"],
      [{ kind: "runtime_error", code: "capture_failed", message: "boom" }, 502, "runtime_error"],
    ] as const) {
      let released = false;
      const bridge = {
        hasRuntime: () => true,
        acquireSlot: () => true,
        releaseSlot: () => {
          released = true;
        },
        requestSnapshot: async () => result,
      } as unknown as BrnaBridge;
      const res = makeMockRes();
      handleSnapshot(bridge, res as never);
      await new Promise((r) => setImmediate(r));
      expect(released).toBe(true);
      expect(res.statusCode).toBe(status);
      if (error) expect(JSON.parse(res.body).error).toBe(error);
      else expect(JSON.parse(res.body)).toEqual({ ok: true });
    }
  });

  test("returns 429 when the shared slot is unavailable", () => {
    const bridge = {
      hasRuntime: () => true,
      acquireSlot: () => false,
    } as unknown as BrnaBridge;
    const res = makeMockRes();
    handleSnapshot(bridge, res as never);
    expect(res.statusCode).toBe(429);
  });

  test("maps rejected snapshot requests to connection and internal errors", async () => {
    for (const [message, status] of [["no_runtime_connected", 503], ["boom", 500]] as const) {
      let released = false;
      const bridge = {
        hasRuntime: () => true,
        acquireSlot: () => true,
        releaseSlot: () => {
          released = true;
        },
        requestSnapshot: async () => {
          throw new Error(message);
        },
      } as unknown as BrnaBridge;
      const res = makeMockRes();
      handleSnapshot(bridge, res as never);
      await new Promise((r) => setImmediate(r));
      expect(released).toBe(true);
      expect(res.statusCode).toBe(status);
    }
  });
});

describe("handleSnapshotPost", () => {
  test("passes redaction and measurement options to snapshot requests", async () => {
    let captured: unknown;
    const bridge = {
      hasRuntime: () => true,
      acquireSlot: () => true,
      releaseSlot: () => {},
      requestSnapshot: async (_deviceId: string | undefined, options: unknown) => {
        captured = options;
        return { kind: "snapshot", snapshot: { ok: true } };
      },
    } as unknown as BrnaBridge;
    const req = makeMockReq();
    const res = makeMockRes();
    const promise = handleSnapshotPost(bridge, req as never, res as never, "dev-a");
    feedBody(req, JSON.stringify({ redaction: { redactSecureFields: false }, measureTimeoutMs: 123 }));
    await promise;
    await new Promise((r) => setImmediate(r));
    expect(captured).toEqual({ redaction: { redactSecureFields: false }, measureTimeoutMs: 123 });
    expect(res.statusCode).toBe(200);
  });

  test("rejects malformed snapshot request bodies", async () => {
    const bridge = {} as BrnaBridge;
    const req = makeMockReq();
    const res = makeMockRes();
    const promise = handleSnapshotPost(bridge, req as never, res as never);
    feedBody(req, "{");
    await promise;
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error).toBe("malformed_snapshot_request");
  });

  test("returns 413 when snapshot POST body exceeds the JSON body limit", async () => {
    const bridge = {} as BrnaBridge;
    const req = makeMockReq();
    const res = makeMockRes();
    const promise = handleSnapshotPost(bridge, req as never, res as never);
    feedBody(req, OVERSIZED_JSON_BODY);
    await promise;
    expect(res.statusCode).toBe(413);
    expect(JSON.parse(res.body)).toEqual({ error: "request_body_too_large", max_bytes: 64 * 1024 });
  });
});

describe("handleLogs", () => {
  test("reads chunked POST observability options without content-length", async () => {
    let capturedOptions: unknown;
    const bridge = {
      hasRuntime: () => true,
      requestLogs: async (options: unknown) => {
        capturedOptions = options;
        return { kind: "ok", records: [] };
      },
    } as unknown as BrnaBridge;
    const req = makeMockReq();
    req.url = "/brna/logs";
    req.headers = { "transfer-encoding": "chunked" };
    const res = makeMockRes();

    const promise = handleLogs(bridge, req as never, res as never);
    feedBody(req, JSON.stringify({ limit: 5, level: "warn" }));
    await promise;

    expect(capturedOptions).toEqual({ limit: 5, level: "warn" });
    expect(res.statusCode).toBe(200);
  });
});

describe("handleDevices", () => {
  test("includes live and recently disconnected devices", () => {
    const bridge = {
      listDevices: () => [{ id: "live", registered_at: 1, last_seen_at: 2 }],
      listRecentDisconnectedDevices: () => [{ id: "old", registered_at: 1, last_seen_at: 2, disconnected_at: 3 }],
    } as unknown as BrnaBridge;
    const res = makeMockRes();
    handleDevices(bridge, res as never);
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({
      devices: [{ id: "live", registered_at: 1, last_seen_at: 2 }],
      recent_disconnected: [{ id: "old", registered_at: 1, last_seen_at: 2, disconnected_at: 3 }],
    });
  });
});
