import { describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { BrnaBridge } from "../src/bridge.js";

interface MockSocket extends EventEmitter {
  readyState: number;
  send: (data: string) => void;
  sent: string[];
  close: () => void;
}

function makeMockSocket(): MockSocket {
  const ee = new EventEmitter() as MockSocket;
  ee.readyState = 1; // ws.OPEN
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

function lastSentFrame(socket: MockSocket): { type: string; id: string; [k: string]: unknown } {
  const raw = socket.sent.at(-1);
  if (!raw) throw new Error("nothing sent");
  return JSON.parse(raw) as { type: string; id: string };
}

describe("BrnaBridge.requestAction", () => {
  test("sends action.request frame and resolves on action.response", async () => {
    const bridge = new BrnaBridge();
    const ws = makeMockSocket();
    bridge.onConnection(ws as unknown as Parameters<BrnaBridge["onConnection"]>[0]);

    const promise = bridge.requestAction({ kind: "tap", selector: "#x", target_id: "x" });
    const frame = lastSentFrame(ws);
    expect(frame.type).toBe("action.request");
    expect((frame as { action: unknown }).action).toEqual({
      kind: "tap",
      selector: "#x",
      target_id: "x",
    });

    ws.emit(
      "message",
      Buffer.from(JSON.stringify({ type: "action.response", id: frame.id, elapsed_ms: 17 })),
    );
    const result = await promise;
    expect(result).toEqual({ kind: "ok", elapsed_ms: 17 });
  });

  test("maps action.error to runtime_error", async () => {
    const bridge = new BrnaBridge();
    const ws = makeMockSocket();
    bridge.onConnection(ws as unknown as Parameters<BrnaBridge["onConnection"]>[0]);

    const promise = bridge.requestAction({ kind: "tap", selector: "#d", target_id: "d" });
    const frame = lastSentFrame(ws);
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
    const result = await promise;
    expect(result).toEqual({
      kind: "runtime_error",
      code: "target_disabled",
      message: "node is disabled",
    });
  });

  test("drops late replies for unknown ids", async () => {
    const bridge = new BrnaBridge();
    const ws = makeMockSocket();
    bridge.onConnection(ws as unknown as Parameters<BrnaBridge["onConnection"]>[0]);

    const promise = bridge.requestAction({ kind: "tap", selector: "#x", target_id: "x" });
    const frame = lastSentFrame(ws);

    // wrong id — must NOT resolve
    ws.emit(
      "message",
      Buffer.from(JSON.stringify({ type: "action.response", id: "stranger", elapsed_ms: 5 })),
    );

    // matching id resolves
    ws.emit(
      "message",
      Buffer.from(JSON.stringify({ type: "action.response", id: frame.id, elapsed_ms: 5 })),
    );
    const result = await promise;
    expect(result.kind).toBe("ok");
  });

  test("snapshot.error frame for an action id is ignored", async () => {
    const bridge = new BrnaBridge();
    const ws = makeMockSocket();
    bridge.onConnection(ws as unknown as Parameters<BrnaBridge["onConnection"]>[0]);

    const promise = bridge.requestAction({ kind: "tap", selector: "#x", target_id: "x" });
    const frame = lastSentFrame(ws);
    // wrong frame.type for an action pending — must be dropped
    ws.emit(
      "message",
      Buffer.from(JSON.stringify({ type: "snapshot.error", id: frame.id, code: "x", message: "y" })),
    );
    // then the right one
    ws.emit(
      "message",
      Buffer.from(JSON.stringify({ type: "action.response", id: frame.id, elapsed_ms: 1 })),
    );
    const result = await promise;
    expect(result.kind).toBe("ok");
  });

  test("rejects with no_runtime_connected when no socket is active", async () => {
    const bridge = new BrnaBridge();
    await expect(
      bridge.requestAction({ kind: "tap", selector: "#x", target_id: "x" }),
    ).rejects.toThrow("no_runtime_connected");
  });
});

describe("BrnaBridge single-flight slot", () => {
  test("acquireSlot returns false while one is held", () => {
    const bridge = new BrnaBridge();
    expect(bridge.acquireSlot()).toBe(true);
    expect(bridge.acquireSlot()).toBe(false);
    bridge.releaseSlot();
    expect(bridge.acquireSlot()).toBe(true);
  });
});

describe("BrnaBridge timeout", () => {
  test("requestAction resolves with timeout when no reply arrives", async () => {
    const bridge = new BrnaBridge({ actionTimeoutMs: 5 });
    const ws = makeMockSocket();
    bridge.onConnection(ws as unknown as Parameters<BrnaBridge["onConnection"]>[0]);
    const result = await bridge.requestAction({
      kind: "tap",
      selector: "#x",
      target_id: "x",
    });
    expect(result).toEqual({ kind: "timeout" });
  });

  test("late reply after timeout is dropped", async () => {
    const bridge = new BrnaBridge({ actionTimeoutMs: 5 });
    const ws = makeMockSocket();
    bridge.onConnection(ws as unknown as Parameters<BrnaBridge["onConnection"]>[0]);
    const promise = bridge.requestAction({ kind: "tap", selector: "#x", target_id: "x" });
    const frame = lastSentFrame(ws);
    const result = await promise; // times out
    expect(result.kind).toBe("timeout");
    // emitting after timeout must not throw or resolve anything else
    ws.emit(
      "message",
      Buffer.from(JSON.stringify({ type: "action.response", id: frame.id, elapsed_ms: 1 })),
    );
    // no observable side effect; if we got here without unhandled rejection, OK
  });
});

describe("BrnaBridge frame routing isolation", () => {
  test("snapshot pending and action pending coexist by id", async () => {
    const bridge = new BrnaBridge();
    const ws = makeMockSocket();
    bridge.onConnection(ws as unknown as Parameters<BrnaBridge["onConnection"]>[0]);

    const snap = bridge.requestSnapshot();
    const snapFrame = lastSentFrame(ws);
    expect(snapFrame.type).toBe("snapshot.request");

    const act = bridge.requestAction({ kind: "tap", selector: "#x", target_id: "x" });
    const actFrame = lastSentFrame(ws);
    expect(actFrame.type).toBe("action.request");

    // resolve the action first
    ws.emit(
      "message",
      Buffer.from(JSON.stringify({ type: "action.response", id: actFrame.id, elapsed_ms: 1 })),
    );
    expect((await act).kind).toBe("ok");

    // then the snapshot
    ws.emit(
      "message",
      Buffer.from(
        JSON.stringify({
          type: "snapshot.response",
          id: snapFrame.id,
          snapshot: { meta: 1 },
        }),
      ),
    );
    const snapResult = await snap;
    expect(snapResult.kind).toBe("snapshot");
  });
});
