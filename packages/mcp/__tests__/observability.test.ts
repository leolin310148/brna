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
  argv?: string[];
  logs?: unknown[];
  network?: unknown[];
  recordCalls?: Array<{ url: string; method?: string; body?: string; headers?: HeadersInit }>;
}

async function exchange(requests: Frame[], opts: ExchangeOpts = {}): Promise<Frame[]> {
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === "string" ? input : (input as URL).toString();
    if (opts.recordCalls) {
      const entry: { url: string; method?: string; body?: string; headers?: HeadersInit } = { url };
      if (init?.method !== undefined) entry.method = init.method;
      if (typeof init?.body === "string") entry.body = init.body;
      if (init?.headers !== undefined) entry.headers = init.headers;
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
  await runMcpServer(opts.argv ?? [], {
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
  test("rejects unknown CLI flags", async () => {
    await expect(runMcpServer(["--devcie", "ios-1"])).rejects.toThrow("unknown flag: --devcie");
  });

  test("escapes control characters in unknown CLI flags", async () => {
    const err = await runMcpServer(["--bad\x1b[31m\u202e"]).catch((error) => error as Error);

    expect(err.message).toContain("unknown flag: --bad\\x1b[31m\\u202e");
    expect(err.message).not.toContain("\x1b");
    expect(err.message).not.toContain("\u202e");
  });

  test("rejects whitespace-only device CLI values", async () => {
    await expect(runMcpServer(["--device", "   "])).rejects.toThrow("missing value for --device");
  });

  test("trims device CLI values before forwarding headers", async () => {
    const calls: Array<{ url: string; method?: string; body?: string; headers?: HeadersInit }> = [];
    await exchange(
      [{ jsonrpc: "2.0", id: 1, method: "resources/read", params: { uri: "brna://current/logs" } }],
      { argv: ["--device", " ios-1 "], recordCalls: calls },
    );

    expect((calls[0]!.headers as Record<string, string>)["x-brna-device-id"]).toBe("ios-1");
  });

  test("BRNA_DEVICE provides a default device header", async () => {
    const calls: Array<{ url: string; method?: string; body?: string; headers?: HeadersInit }> = [];
    await withEnv("BRNA_DEVICE", " android-1 ", async () => {
      await exchange(
        [{ jsonrpc: "2.0", id: 1, method: "resources/read", params: { uri: "brna://current/logs" } }],
        { recordCalls: calls },
      );
    });

    expect((calls[0]!.headers as Record<string, string>)["x-brna-device-id"]).toBe("android-1");
  });

  test("--device overrides BRNA_DEVICE", async () => {
    const calls: Array<{ url: string; method?: string; body?: string; headers?: HeadersInit }> = [];
    await withEnv("BRNA_DEVICE", "env-device", async () => {
      await exchange(
        [{ jsonrpc: "2.0", id: 1, method: "resources/read", params: { uri: "brna://current/logs" } }],
        { argv: ["--device", "cli-device"], recordCalls: calls },
      );
    });

    expect((calls[0]!.headers as Record<string, string>)["x-brna-device-id"]).toBe("cli-device");
  });

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
          params: { name: "logs", arguments: { level: " warn ", limit: 10, method: "POST", status: 201 } },
        },
      ],
      { logs: records, recordCalls: calls },
    );
    expect(calls).toHaveLength(1);
    expect(calls[0]!.method).toBe("POST");
    const sent = JSON.parse(calls[0]!.body!) as { level?: string; limit?: number };
    expect(sent).toEqual({ level: "warn", limit: 10 });
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
          params: { name: "network", arguments: { method: "post", level: "warn" } },
        },
      ],
      { network: records, recordCalls: calls },
    );
    expect(calls).toHaveLength(1);
    const sent = JSON.parse(calls[0]!.body!) as { method?: string };
    expect(sent).toEqual({ method: "POST" });
    const result = responses[0]!.result as { content: Array<{ text: string }> };
    const parsed = JSON.parse(result.content[0]!.text) as { records: unknown[] };
    expect(parsed.records).toEqual(records);
  });

  test("tools/list advertises network status range filters", async () => {
    const responses = await exchange([{ jsonrpc: "2.0", id: 1, method: "tools/list" }]);
    const result = responses[0]!.result as {
      tools: Array<{ name: string; inputSchema?: { properties?: Record<string, { type?: string }> } }>;
    };
    const networkTool = result.tools.find((tool) => tool.name === "network");

    expect(networkTool?.inputSchema?.properties?.statusMin?.type).toBe("number");
    expect(networkTool?.inputSchema?.properties?.statusMax?.type).toBe("number");
  });

  test("tools/call network forwards status range filters", async () => {
    const calls: Array<{ url: string; method?: string; body?: string }> = [];
    await exchange(
      [
        {
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: { name: "network", arguments: { statusMin: 400, statusMax: 499 } },
        },
      ],
      { recordCalls: calls },
    );

    const sent = JSON.parse(calls[0]!.body!) as { statusMin?: number; statusMax?: number };
    expect(sent.statusMin).toBe(400);
    expect(sent.statusMax).toBe(499);
  });
});

async function withEnv(name: string, value: string, fn: () => Promise<void>): Promise<void> {
  const previous = process.env[name];
  process.env[name] = value;
  try {
    await fn();
  } finally {
    if (previous === undefined) delete process.env[name];
    else process.env[name] = previous;
  }
}
