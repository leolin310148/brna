import { describe, expect, test } from "bun:test";
import { Readable, Writable } from "node:stream";
import { SCHEMA_VERSION, type Snapshot } from "@brna/schema";
import { runMcpServer } from "../src/index.js";

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
      id: "root",
      kind: "screen",
      children: [{ id: "btn", kind: "button", role: "button", name: "Submit" }],
    },
    ...over,
  };
}

interface Frame {
  jsonrpc: "2.0";
  id?: string | number | null;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code: number; message: string };
}

async function exchange(requests: Frame[], opts: { fresh?: Snapshot; actionStatus?: number; actions?: unknown[] } = {}): Promise<Frame[]> {
  const fresh = opts.fresh ?? makeSnapshot();
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === "string" ? input : (input as URL).toString();
    if (url.endsWith("/brna/snapshot")) return new Response(JSON.stringify(fresh), { status: 200 });
    if (url.endsWith("/brna/action")) {
      if (typeof init?.body === "string") opts.actions?.push(JSON.parse(init.body));
      return new Response("", { status: opts.actionStatus ?? 204 });
    }
    return new Response("not found", { status: 404 });
  }) as unknown as typeof fetch;

  const needsHandshake = requests[0]?.method !== "initialize";
  const frames = needsHandshake
    ? [
      {
        jsonrpc: "2.0" as const,
        id: "init",
        method: "initialize",
        params: {
          protocolVersion: "2024-11-05",
          capabilities: {},
          clientInfo: { name: "test-client", version: "0.0.0" },
        },
      },
      { jsonrpc: "2.0" as const, method: "notifications/initialized" },
      ...requests,
    ]
    : requests;
  const stdin = Readable.from(frames.map((r) => JSON.stringify(r) + "\n"));
  let out = "";
  const stdout = new Writable({
    write(chunk, _encoding, callback) {
      out += String(chunk);
      callback();
    },
  });
  await runMcpServer([], {
    metroUrl: "http://localhost:8081",
    fetch: fetchImpl,
    stdin,
    stdout,
    stderr: { write: () => true },
  });
  return out
    .split("\n")
    .filter((l) => l.length > 0)
    .map((l) => JSON.parse(l) as Frame)
    .filter((frame) => frame.id !== "init");
}

describe("MCP server", () => {
  test("initialize returns protocol info", async () => {
    const responses = await exchange([{
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "test-client", version: "0.0.0" },
      },
    }]);
    expect(responses).toHaveLength(1);
    const result = responses[0]!.result as { protocolVersion: string; serverInfo: { name: string } };
    expect(result.protocolVersion).toBe("2024-11-05");
    expect(result.serverInfo.name).toBe("brna-mcp");
  });

  test("resources/list exposes brna://current/snapshot", async () => {
    const responses = await exchange([{ jsonrpc: "2.0", id: 1, method: "resources/list" }]);
    const result = responses[0]!.result as { resources: Array<{ uri: string }> };
    expect(result.resources.map((r) => r.uri)).toContain("brna://current/snapshot");
  });

  test("resources/read returns markdown projection", async () => {
    const responses = await exchange([
      { jsonrpc: "2.0", id: 1, method: "resources/read", params: { uri: "brna://current/snapshot" } },
    ]);
    const result = responses[0]!.result as { contents: Array<{ text: string; mimeType: string }> };
    expect(result.contents[0]!.mimeType).toBe("text/markdown");
    expect(result.contents[0]!.text).toContain("# Snapshot");
  });

  test("tools/list exposes core action and observability tools", async () => {
    const responses = await exchange([{ jsonrpc: "2.0", id: 1, method: "tools/list" }]);
    const result = responses[0]!.result as { tools: Array<{ name: string }> };
    const names = result.tools.map((t) => t.name).sort();
    expect(names).toEqual(["key", "logs", "long_press", "network", "scroll", "swipe", "tap", "type"]);
  });

  test("tools/call tap with core selector posts action", async () => {
    const actions: unknown[] = [];
    const responses = await exchange([
      {
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "tap", arguments: { selector: "button:Submit" } },
      },
    ], { actions });
    const result = responses[0]!.result as { content: Array<{ text: string }> };
    expect(result.content[0]!.text).toContain("ok: tap");
    expect(actions[0]).toEqual({ kind: "tap", selector: "button:Submit", target_id: "btn" });
  });

  test("tools/call tap supports at index for ambiguous selectors", async () => {
    const actions: unknown[] = [];
    const responses = await exchange([
      {
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "tap", arguments: { selector: "button:Submit", at: 1 } },
      },
    ], {
      actions,
      fresh: makeSnapshot({
        tree: {
          id: "root",
          kind: "screen",
          children: [
            { id: "top", kind: "button", role: "button", name: "Submit" },
            { id: "bottom", kind: "button", role: "button", name: "Submit" },
          ],
        },
      }),
    });
    const result = responses[0]!.result as { content: Array<{ text: string }> };
    expect(result.content[0]!.text).toContain("ok: tap");
    expect(actions[0]).toEqual({ kind: "tap", selector: "button:Submit", target_id: "bottom" });
  });

  test("ambiguous selector returns structured error payload", async () => {
    const responses = await exchange([
      {
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "tap", arguments: { selector: "button:Submit" } },
      },
    ], {
      fresh: makeSnapshot({
        tree: {
          id: "root",
          kind: "screen",
          children: [
            { id: "top", kind: "button", role: "button", name: "Submit", bounds: { x: 1, y: 2, w: 3, h: 4 } },
            { id: "bottom", kind: "button", role: "button", name: "Submit" },
          ],
        },
      }),
    });
    expect(responses[0]!.error).toBeDefined();
    const payload = JSON.parse(responses[0]!.error!.message) as { code: string; selector: string; matches: Array<{ index: number; kind: string; bounds?: unknown }> };
    expect(payload.code).toBe("ambiguous");
    expect(payload.selector).toBe("button:Submit");
    expect(payload.matches.map((m) => [m.index, m.kind])).toEqual([[0, "button"], [1, "button"]]);
    expect(payload.matches[0]!.bounds).toEqual({ x: 1, y: 2, w: 3, h: 4 });
  });

  test("tools/call swipe posts swipe action", async () => {
    const actions: unknown[] = [];
    const responses = await exchange([
      {
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "swipe", arguments: { selector: "#btn", direction: "up", by: 120 } },
      },
    ], { actions });
    const result = responses[0]!.result as { content: Array<{ text: string }> };
    expect(result.content[0]!.text).toContain("ok: swipe");
    expect(actions[0]).toEqual({ kind: "swipe", selector: "#btn", target_id: "btn", direction: "up", by: 120 });
  });

  test("tools/call long_press posts long_press action with default duration", async () => {
    const actions: unknown[] = [];
    const responses = await exchange([
      {
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "long_press", arguments: { selector: "#btn" } },
      },
    ], { actions });
    const result = responses[0]!.result as { content: Array<{ text: string }> };
    expect(result.content[0]!.text).toContain("ok: long_press");
    expect(actions[0]).toEqual({ kind: "long_press", selector: "#btn", target_id: "btn", duration_ms: 500 });
  });

  test("unknown selector returns error", async () => {
    const responses = await exchange([
      {
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "tap", arguments: { selector: "#missing" } },
      },
    ]);
    expect(responses[0]!.error).toBeDefined();
    expect(responses[0]!.error!.message).toContain("missing");
  });
});
