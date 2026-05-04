import { describe, expect, test } from "bun:test";
import { Readable, Writable } from "node:stream";
import { runMcpServer } from "../src/index.js";

interface Frame {
  jsonrpc: "2.0";
  id?: string | number | null;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code: number; message: string };
}

interface ExchangeOpts {
  logs?: unknown[];
  network?: unknown[];
  recordCalls?: Array<{ url: string; method?: string; body?: string }>;
}

async function exchange(requests: Frame[], opts: ExchangeOpts = {}): Promise<Frame[]> {
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === "string" ? input : (input as URL).toString();
    if (opts.recordCalls) {
      const entry: { url: string; method?: string; body?: string } = { url };
      if (init?.method !== undefined) entry.method = init.method;
      if (typeof init?.body === "string") entry.body = init.body;
      opts.recordCalls.push(entry);
    }
    if (url.endsWith("/brna/logs") || url.includes("/brna/logs?")) {
      return new Response(JSON.stringify({ records: opts.logs ?? [] }), { status: 200 });
    }
    if (url.endsWith("/brna/network") || url.includes("/brna/network?")) {
      return new Response(JSON.stringify({ records: opts.network ?? [] }), { status: 200 });
    }
    return new Response("not found", { status: 404 });
  }) as unknown as typeof fetch;

  const frames: Frame[] = [
    {
      jsonrpc: "2.0",
      id: "init",
      method: "initialize",
      params: {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "test-client", version: "0.0.0" },
      },
    },
    { jsonrpc: "2.0", method: "notifications/initialized" },
    ...requests,
  ];
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

describe("MCP observability", () => {
  test("resources/list includes logs and network", async () => {
    const responses = await exchange([{ jsonrpc: "2.0", id: 1, method: "resources/list" }]);
    const result = responses[0]!.result as { resources: Array<{ uri: string }> };
    const uris = result.resources.map((r) => r.uri);
    expect(uris).toContain("brna://current/logs");
    expect(uris).toContain("brna://current/network");
  });

  test("resources/read brna://current/logs returns JSON records", async () => {
    const records = [{ id: "log-1", timestamp: 1, level: "warn", message: "hi" }];
    const responses = await exchange(
      [{ jsonrpc: "2.0", id: 1, method: "resources/read", params: { uri: "brna://current/logs" } }],
      { logs: records },
    );
    const result = responses[0]!.result as { contents: Array<{ text: string; mimeType: string }> };
    expect(result.contents[0]!.mimeType).toBe("application/json");
    expect(JSON.parse(result.contents[0]!.text)).toEqual({ records });
  });

  test("resources/read brna://current/network returns JSON records", async () => {
    const records = [
      {
        id: "net-1",
        timestamp: 1,
        method: "GET",
        url: "https://api.test/x",
        state: "completed",
        source: "fetch",
        status: 200,
      },
    ];
    const responses = await exchange(
      [{ jsonrpc: "2.0", id: 1, method: "resources/read", params: { uri: "brna://current/network" } }],
      { network: records },
    );
    const result = responses[0]!.result as { contents: Array<{ text: string }> };
    expect(JSON.parse(result.contents[0]!.text)).toEqual({ records });
  });

  test("tools/call logs forwards filter and returns records", async () => {
    const calls: Array<{ url: string; method?: string; body?: string }> = [];
    const records = [{ id: "log-1", timestamp: 1, level: "warn", message: "warn-only" }];
    const responses = await exchange(
      [
        {
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: { name: "logs", arguments: { level: "warn", limit: 10 } },
        },
      ],
      { logs: records, recordCalls: calls },
    );
    expect(calls).toHaveLength(1);
    expect(calls[0]!.method).toBe("POST");
    const sent = JSON.parse(calls[0]!.body!) as { level?: string; limit?: number };
    expect(sent.level).toBe("warn");
    expect(sent.limit).toBe(10);
    const result = responses[0]!.result as { content: Array<{ text: string }> };
    const parsed = JSON.parse(result.content[0]!.text) as { records: unknown[] };
    expect(parsed.records).toEqual(records);
  });

  test("tools/call network forwards method and returns records", async () => {
    const calls: Array<{ url: string; method?: string; body?: string }> = [];
    const records = [
      {
        id: "net-1",
        timestamp: 1,
        method: "POST",
        url: "https://api.test/x",
        state: "completed",
        source: "fetch",
        status: 201,
      },
    ];
    const responses = await exchange(
      [
        {
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: { name: "network", arguments: { method: "POST" } },
        },
      ],
      { network: records, recordCalls: calls },
    );
    expect(calls).toHaveLength(1);
    const sent = JSON.parse(calls[0]!.body!) as { method?: string };
    expect(sent.method).toBe("POST");
    const result = responses[0]!.result as { content: Array<{ text: string }> };
    const parsed = JSON.parse(result.content[0]!.text) as { records: unknown[] };
    expect(parsed.records).toEqual(records);
  });
});
