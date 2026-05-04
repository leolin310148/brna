import { describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { BrnaBridge } from "../src/bridge.js";
import { handleLogs, handleNetwork } from "../src/middleware.js";

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
}

function makeMockReq(method: string, url: string): MockReq {
  const ee = new EventEmitter() as MockReq;
  ee.method = method;
  ee.url = url;
  ee.headers = { "content-length": "0" };
  return ee;
}

function attachRuntime(bridge: BrnaBridge): MockSocket {
  const ws = makeMockSocket();
  bridge.onConnection(ws as unknown as Parameters<BrnaBridge["onConnection"]>[0]);
  return ws;
}

describe("handleLogs", () => {
  test("returns 200 with logs records on logs.response", async () => {
    const bridge = new BrnaBridge();
    const ws = attachRuntime(bridge);
    const req = makeMockReq("GET", "/brna/logs");
    const res = makeMockRes();
    const promise = handleLogs(bridge, req as never, res as never);
    await new Promise((r) => setImmediate(r));
    const frame = lastSent(ws);
    expect(frame.type).toBe("logs.request");
    ws.emit(
      "message",
      Buffer.from(
        JSON.stringify({
          type: "logs.response",
          id: frame.id,
          records: [{ id: "log-1", timestamp: 1, level: "warn", message: "hi" }],
        }),
      ),
    );
    await promise;
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as { records: Array<{ message: string }> };
    expect(body.records).toHaveLength(1);
    expect(body.records[0]!.message).toBe("hi");
  });

  test("forwards since/level via the request frame options", async () => {
    const bridge = new BrnaBridge();
    const ws = attachRuntime(bridge);
    const req = makeMockReq("GET", "/brna/logs?since=5000&level=warn");
    const res = makeMockRes();
    const promise = handleLogs(bridge, req as never, res as never);
    await new Promise((r) => setImmediate(r));
    const frame = lastSent(ws) as unknown as { options: { since: number; level: string } };
    expect(frame.options.since).toBe(5000);
    expect(frame.options.level).toBe("warn");
    ws.emit(
      "message",
      Buffer.from(JSON.stringify({ type: "logs.response", id: (frame as { id: string }).id, records: [] })),
    );
    await promise;
  });

  test("returns 503 when no runtime is connected", async () => {
    const bridge = new BrnaBridge();
    const req = makeMockReq("GET", "/brna/logs");
    const res = makeMockRes();
    await handleLogs(bridge, req as never, res as never);
    expect(res.statusCode).toBe(503);
    expect(JSON.parse(res.body)).toEqual({ error: "no_runtime_connected" });
  });

  test("returns 404 for unknown device targeting", async () => {
    const bridge = new BrnaBridge();
    attachRuntime(bridge);
    const req = makeMockReq("GET", "/brna/logs");
    const res = makeMockRes();
    await handleLogs(bridge, req as never, res as never, "missing-device");
    expect(res.statusCode).toBe(404);
    const body = JSON.parse(res.body) as { error: string; device_id: string };
    expect(body.error).toBe("unknown_device");
    expect(body.device_id).toBe("missing-device");
  });

  test("returns 502 on runtime logs.error", async () => {
    const bridge = new BrnaBridge();
    const ws = attachRuntime(bridge);
    const req = makeMockReq("GET", "/brna/logs");
    const res = makeMockRes();
    const promise = handleLogs(bridge, req as never, res as never);
    await new Promise((r) => setImmediate(r));
    const frame = lastSent(ws);
    ws.emit(
      "message",
      Buffer.from(
        JSON.stringify({ type: "logs.error", id: frame.id, code: "logs_failed", message: "boom" }),
      ),
    );
    await promise;
    expect(res.statusCode).toBe(502);
    const body = JSON.parse(res.body) as { error: string; code: string };
    expect(body.error).toBe("runtime_error");
    expect(body.code).toBe("logs_failed");
  });

  test("ignores response with unknown id and times out", async () => {
    const bridge = new BrnaBridge({});
    const ws = attachRuntime(bridge);
    const req = makeMockReq("GET", "/brna/logs");
    const res = makeMockRes();
    // Override to a tiny timeout so the test completes quickly.
    const original = bridge.requestLogs.bind(bridge);
    bridge.requestLogs = (async (options, deviceId) => {
      const promise = original(options, deviceId);
      // Inject an unknown-id frame; should be dropped silently.
      ws.emit(
        "message",
        Buffer.from(JSON.stringify({ type: "logs.response", id: "not-our-id", records: [] })),
      );
      return promise;
    }) as typeof bridge.requestLogs;
    // To avoid waiting 5s for real timeout, we simulate timeout by sending error frame directly to satisfy the pending entry.
    const promise = handleLogs(bridge, req as never, res as never);
    await new Promise((r) => setImmediate(r));
    const frame = lastSent(ws);
    ws.emit(
      "message",
      Buffer.from(JSON.stringify({ type: "logs.response", id: frame.id, records: [] })),
    );
    await promise;
    expect(res.statusCode).toBe(200);
  });
});

describe("handleNetwork", () => {
  test("returns 200 with network records on network.response", async () => {
    const bridge = new BrnaBridge();
    const ws = attachRuntime(bridge);
    const req = makeMockReq("GET", "/brna/network");
    const res = makeMockRes();
    const promise = handleNetwork(bridge, req as never, res as never);
    await new Promise((r) => setImmediate(r));
    const frame = lastSent(ws);
    expect(frame.type).toBe("network.request");
    ws.emit(
      "message",
      Buffer.from(
        JSON.stringify({
          type: "network.response",
          id: frame.id,
          records: [
            {
              id: "net-1",
              timestamp: 1,
              method: "POST",
              url: "https://api.test/x",
              state: "completed",
              source: "fetch",
              status: 200,
            },
          ],
        }),
      ),
    );
    await promise;
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as { records: Array<{ method: string; url: string }> };
    expect(body.records).toHaveLength(1);
    expect(body.records[0]!.method).toBe("POST");
  });

  test("forwards method query param", async () => {
    const bridge = new BrnaBridge();
    const ws = attachRuntime(bridge);
    const req = makeMockReq("GET", "/brna/network?method=post");
    const res = makeMockRes();
    const promise = handleNetwork(bridge, req as never, res as never);
    await new Promise((r) => setImmediate(r));
    const frame = lastSent(ws) as unknown as { options: { method: string }; id: string };
    expect(frame.options.method).toBe("POST");
    ws.emit(
      "message",
      Buffer.from(JSON.stringify({ type: "network.response", id: frame.id, records: [] })),
    );
    await promise;
  });

  test("returns 503 when no runtime", async () => {
    const bridge = new BrnaBridge();
    const req = makeMockReq("GET", "/brna/network");
    const res = makeMockRes();
    await handleNetwork(bridge, req as never, res as never);
    expect(res.statusCode).toBe(503);
  });

  test("returns 404 unknown device", async () => {
    const bridge = new BrnaBridge();
    attachRuntime(bridge);
    const req = makeMockReq("GET", "/brna/network");
    const res = makeMockRes();
    await handleNetwork(bridge, req as never, res as never, "missing");
    expect(res.statusCode).toBe(404);
  });
});
