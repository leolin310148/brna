import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { resolve } from "node:path";
import { SCHEMA_VERSION, type Snapshot } from "@brna/schema";

const CLI_PATH = resolve(import.meta.dir, "../src/cli.ts");

interface MockState {
  snapshotResponder: (req: IncomingMessage, res: ServerResponse) => void;
  actionResponder: (req: IncomingMessage, res: ServerResponse, body: string) => void;
  lastActionBody: string | null;
}

function makeSnapshot(over: Partial<Snapshot> = {}): Snapshot {
  return {
    meta: {
      schema_version: SCHEMA_VERSION,
      captured_at: "2026-05-01T12:00:00.000Z",
      app: { bundle_id: "x", version: "1.0.0" },
      device: {
        platform: "ios",
        os_version: "17.4",
        model: "iPhone",
        viewport: { w: 393, h: 852, scale: 3 },
        locale: "en-US",
      },
      session_id: "s",
      snapshot_id: "n",
    },
    screen: { modal_stack: [] },
    tree: {
      id: "screen:root",
      kind: "screen",
      children: [
        { id: "save", kind: "button", name: "Save" },
        { id: "feed", kind: "list", name: "Feed" },
        { id: "email", kind: "input", name: "Email" },
        { id: "menu", kind: "button", name: "Menu" },
      ],
    },
    ...over,
  };
}

function jsonReply(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json");
  res.setHeader("Content-Length", Buffer.byteLength(text).toString());
  res.end(text);
}

let server: Server;
let state: MockState;
let baseUrl: string;

beforeAll(async () => {
  state = {
    snapshotResponder: (_req, res) => jsonReply(res, 200, makeSnapshot()),
    actionResponder: (_req, res) => {
      res.statusCode = 204;
      res.setHeader("Content-Length", "0");
      res.end();
    },
    lastActionBody: null,
  };
  server = createServer((req, res) => {
    if (req.method === "GET" && (req.url ?? "").startsWith("/brna/snapshot")) {
      state.snapshotResponder(req, res);
      return;
    }
    if (req.method === "POST" && (req.url ?? "").startsWith("/brna/action")) {
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => {
        const body = Buffer.concat(chunks).toString("utf8");
        state.lastActionBody = body;
        state.actionResponder(req, res, body);
      });
      return;
    }
    res.statusCode = 404;
    res.end();
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const addr = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${addr.port}`;
});

afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
});

beforeEach(() => {
  state.snapshotResponder = (_req, res) => jsonReply(res, 200, makeSnapshot());
  state.actionResponder = (_req, res) => {
    res.statusCode = 204;
    res.setHeader("Content-Length", "0");
    res.end();
  };
  state.lastActionBody = null;
});

interface ProcResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

async function runAct(args: string[]): Promise<ProcResult> {
  const proc = Bun.spawn(
    ["bun", "run", CLI_PATH, "act", ...args, "--metro", baseUrl, "--timeout", "5000"],
    {
      env: { ...process.env, NO_COLOR: "1" },
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const status = await proc.exited;
  return { status, stdout, stderr };
}

async function runRaw(args: string[]): Promise<ProcResult> {
  const proc = Bun.spawn(["bun", "run", CLI_PATH, ...args], {
    env: { ...process.env, NO_COLOR: "1" },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const status = await proc.exited;
  return { status, stdout, stderr };
}

describe("act success paths (quiet)", () => {
  test("tap success exits 0 with empty stdout/stderr and posts the right body", async () => {
    const r = await runAct(["tap", "#save"]);
    expect(r.status).toBe(0);
    expect(r.stdout).toBe("");
    expect(r.stderr).toBe("");
    expect(JSON.parse(state.lastActionBody!)).toEqual({
      kind: "tap",
      selector: "#save",
      target_id: "save",
    });
  });

  test("click is normalized to tap on the wire", async () => {
    const r = await runAct(["click", "#save"]);
    expect(r.status).toBe(0);
    expect(r.stdout).toBe("");
    expect(r.stderr).toBe("");
    expect(JSON.parse(state.lastActionBody!)).toEqual({
      kind: "tap",
      selector: "#save",
      target_id: "save",
    });
  });

  test("long-press default duration is 500ms", async () => {
    const r = await runAct(["long-press", "#menu"]);
    expect(r.status).toBe(0);
    expect(JSON.parse(state.lastActionBody!)).toEqual({
      kind: "long_press",
      selector: "#menu",
      target_id: "menu",
      duration_ms: 500,
    });
  });

  test("long-press --duration override propagates", async () => {
    const r = await runAct(["long-press", "#menu", "--duration", "750"]);
    expect(r.status).toBe(0);
    expect(JSON.parse(state.lastActionBody!).duration_ms).toBe(750);
  });

  test("type sends full text", async () => {
    const r = await runAct(["type", "#email", "leo@example.com"]);
    expect(r.status).toBe(0);
    expect(JSON.parse(state.lastActionBody!)).toEqual({
      kind: "type",
      selector: "#email",
      target_id: "email",
      text: "leo@example.com",
    });
  });

  test("scroll without --by omits by", async () => {
    const r = await runAct(["scroll", "#feed", "--direction", "down"]);
    expect(r.status).toBe(0);
    expect(JSON.parse(state.lastActionBody!)).toEqual({
      kind: "scroll",
      selector: "#feed",
      target_id: "feed",
      direction: "down",
    });
  });

  test("scroll --by carries through", async () => {
    const r = await runAct(["scroll", "#feed", "--direction", "up", "--by", "300"]);
    expect(r.status).toBe(0);
    expect(JSON.parse(state.lastActionBody!).by).toBe(300);
  });

  test("swipe posts a swipe action", async () => {
    const r = await runAct(["swipe", "#feed", "--direction", "up", "--by", "600"]);
    expect(r.status).toBe(0);
    expect(r.stdout).toBe("");
    expect(r.stderr).toBe("");
    expect(JSON.parse(state.lastActionBody!)).toEqual({
      kind: "swipe",
      selector: "#feed",
      target_id: "feed",
      direction: "up",
      by: 600,
    });
  });

  test("key tab sends untargeted key action and skips snapshot fetch", async () => {
    let snapshotHit = false;
    state.snapshotResponder = (_req, res) => {
      snapshotHit = true;
      jsonReply(res, 200, makeSnapshot());
    };
    const r = await runAct(["key", "tab"]);
    expect(r.status).toBe(0);
    expect(r.stdout).toBe("");
    expect(r.stderr).toBe("");
    expect(JSON.parse(state.lastActionBody!)).toEqual({ kind: "key", key: "tab" });
    expect(snapshotHit).toBe(false);
  });
});

describe("act selector failures", () => {
  test("selector not found exits 2 with clean stdout", async () => {
    const r = await runAct(["tap", "#nope"]);
    expect(r.status).toBe(2);
    expect(r.stdout).toBe("");
    expect(r.stderr).toContain("selector not found: #nope");
    expect(state.lastActionBody).toBe(null);
  });

  test("ambiguous selector exits 3 with candidate ids", async () => {
    state.snapshotResponder = (_req, res) =>
      jsonReply(
        res,
        200,
        makeSnapshot({
          tree: {
            id: "screen:root",
            kind: "screen",
            children: [
              { id: "save-top", kind: "button", role: "button", name: "Save" },
              { id: "save-bottom", kind: "button", role: "button", name: "Save" },
            ],
          },
        }),
      );
    const r = await runAct(["tap", "button:Save"]);
    expect(r.status).toBe(3);
    expect(r.stdout).toBe("");
    expect(r.stderr).toContain("save-top");
    expect(r.stderr).toContain("save-bottom");
    expect(state.lastActionBody).toBe(null);
  });
});

describe("act HTTP error mapping", () => {
  test("503 from /brna/action exits 6 (no_runtime_connected)", async () => {
    state.actionResponder = (_req, res) => jsonReply(res, 503, { error: "no_runtime_connected" });
    const r = await runAct(["tap", "#save"]);
    expect(r.status).toBe(6);
    expect(r.stdout).toBe("");
    expect(r.stderr).toContain("no runtime connected");
  });

  test("504 from /brna/action exits 6 (runtime timeout)", async () => {
    state.actionResponder = (_req, res) =>
      jsonReply(res, 504, { error: "runtime_timeout", timeout_ms: 5000 });
    const r = await runAct(["tap", "#save"]);
    expect(r.status).toBe(6);
    expect(r.stdout).toBe("");
    expect(r.stderr).toContain("runtime timed out");
  });

  test("429 from /brna/action exits 6", async () => {
    state.actionResponder = (_req, res) => jsonReply(res, 429, { error: "request_in_flight" });
    const r = await runAct(["tap", "#save"]);
    expect(r.status).toBe(6);
    expect(r.stdout).toBe("");
  });

  test("502 runtime_error from /brna/action exits 5 with code", async () => {
    state.actionResponder = (_req, res) =>
      jsonReply(res, 502, {
        error: "runtime_error",
        code: "target_disabled",
        message: "node is disabled",
      });
    const r = await runAct(["tap", "#save"]);
    expect(r.status).toBe(5);
    expect(r.stdout).toBe("");
    expect(r.stderr).toContain("action refused: target_disabled");
    expect(r.stderr).toContain("node is disabled");
  });

  test("malformed 502 body exits 6", async () => {
    state.actionResponder = (_req, res) => {
      res.statusCode = 502;
      res.setHeader("Content-Type", "application/json");
      res.end("not json");
    };
    const r = await runAct(["tap", "#save"]);
    expect(r.status).toBe(6);
    expect(r.stdout).toBe("");
    expect(r.stderr).toContain("malformed runtime error response");
  });

  test("connection failure to Metro exits 1", async () => {
    const r = await runRaw([
      "act", "tap", "#save",
      "--metro", "http://127.0.0.1:1",
      "--timeout", "1500",
    ]);
    expect(r.status).toBe(1);
    expect(r.stdout).toBe("");
    expect(r.stderr).toContain("could not connect to Metro");
  });
});
