import { describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { BrnaBridge } from "../src/bridge.js";
import { handleAction, handleSnapshot } from "../src/middleware.js";

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
}

function makeMockReq(): MockReq {
  const ee = new EventEmitter() as MockReq;
  ee.url = "/brna/action";
  ee.method = "POST";
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
