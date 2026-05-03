import { describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { BrnaBridge } from "../src/bridge.js";
import { handleAction, handleDevices, handleSnapshot } from "../src/middleware.js";

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

function attach(bridge: BrnaBridge, hello: Record<string, unknown>): MockSocket {
  const ws = makeMockSocket();
  bridge.onConnection(ws as unknown as Parameters<BrnaBridge["onConnection"]>[0]);
  ws.emit("message", Buffer.from(JSON.stringify({ type: "hello", ...hello })));
  return ws;
}

function lastSent(socket: MockSocket): { type: string; id: string } & Record<string, unknown> {
  const raw = socket.sent.at(-1);
  if (!raw) throw new Error("nothing sent");
  return JSON.parse(raw) as { type: string; id: string };
}

describe("multi-device registry", () => {
  test("listDevices includes platform info from hello frame", () => {
    const bridge = new BrnaBridge();
    attach(bridge, { device_id: "dev-a", platform: "ios", os_version: "17.4" });
    attach(bridge, { device_id: "dev-b", platform: "android", os_version: "14" });

    const devices = bridge.listDevices();
    const ids = devices.map((d) => d.id).sort();
    expect(ids).toEqual(["dev-a", "dev-b"]);
    const a = devices.find((d) => d.id === "dev-a");
    expect(a?.platform).toBe("ios");
    expect(a?.os_version).toBe("17.4");
  });

  test("/brna/devices endpoint returns the registry", () => {
    const bridge = new BrnaBridge();
    attach(bridge, { device_id: "dev-a", platform: "ios", os_version: "17.4" });
    const res = makeMockRes();
    handleDevices(bridge, res as never);
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as { devices: Array<{ id: string; platform?: string }> };
    expect(body.devices).toHaveLength(1);
    expect(body.devices[0]!.id).toBe("dev-a");
    expect(body.devices[0]!.platform).toBe("ios");
  });

  test("/brna/devices includes recently disconnected runtime metadata", () => {
    const bridge = new BrnaBridge();
    const ws = attach(bridge, { device_id: "dev-a", platform: "android", os_version: "36" });
    ws.close();

    const res = makeMockRes();
    handleDevices(bridge, res as never);
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as {
      devices: unknown[];
      recent_disconnected: Array<{ id: string; platform?: string; os_version?: string; last_seen_at?: number }>;
    };
    expect(body.devices).toHaveLength(0);
    expect(body.recent_disconnected[0]!.id).toBe("dev-a");
    expect(body.recent_disconnected[0]!.platform).toBe("android");
    expect(body.recent_disconnected[0]!.os_version).toBe("36");
    expect(typeof body.recent_disconnected[0]!.last_seen_at).toBe("number");
  });

  test("snapshot routes to specific device when device-id supplied", async () => {
    const bridge = new BrnaBridge();
    const wsA = attach(bridge, { device_id: "dev-a" });
    const wsB = attach(bridge, { device_id: "dev-b" });

    const res = makeMockRes();
    handleSnapshot(bridge, res as never, "dev-a");
    await new Promise((r) => setImmediate(r));
    expect(wsA.sent).toHaveLength(1);
    expect(wsB.sent).toHaveLength(0);
    const frame = lastSent(wsA);
    expect(frame.type).toBe("snapshot.request");
  });

  test("snapshot returns 404 for unknown device id", () => {
    const bridge = new BrnaBridge();
    attach(bridge, { device_id: "dev-a" });
    const res = makeMockRes();
    handleSnapshot(bridge, res as never, "dev-zzz");
    expect(res.statusCode).toBe(404);
    const body = JSON.parse(res.body) as { error: string; device_id: string };
    expect(body.error).toBe("unknown_device");
    expect(body.device_id).toBe("dev-zzz");
  });

  test("snapshot without device-id falls back to most recently registered", async () => {
    const bridge = new BrnaBridge();
    const wsA = attach(bridge, { device_id: "dev-a" });
    const wsB = attach(bridge, { device_id: "dev-b" });
    const res = makeMockRes();
    handleSnapshot(bridge, res as never);
    await new Promise((r) => setImmediate(r));
    expect(wsB.sent).toHaveLength(1);
    expect(wsA.sent).toHaveLength(0);
  });
});
