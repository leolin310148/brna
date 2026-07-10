import { describe, expect, test } from "bun:test";
import { Readable, Writable } from "node:stream";
import { mkdtempSync } from "node:fs";
import { readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ACTION_KEYS, SCHEMA_VERSION, type Snapshot } from "@brna/schema";
import { readUsageEvents, type UsageRuntimeOptions } from "@brna/local-usage";
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

async function exchange(
  requests: Frame[],
  opts: {
    fresh?: Snapshot;
    actionStatus?: number;
    actions?: unknown[];
    argv?: string[];
    requestUrls?: string[];
    trailingNewline?: boolean;
    usage?: UsageRuntimeOptions | false;
  } = {},
): Promise<Frame[]> {
  const fresh = opts.fresh ?? makeSnapshot();
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === "string" ? input : (input as URL).toString();
    opts.requestUrls?.push(url);
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
  const stdinText = frames.map((r) => JSON.stringify(r)).join("\n") + (opts.trailingNewline === false ? "" : "\n");
  const stdin = Readable.from([stdinText]);
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
    usage: opts.usage ?? false,
  });
  return out
    .split("\n")
    .filter((l) => l.length > 0)
    .map((l) => JSON.parse(l) as Frame)
    .filter((frame) => frame.id !== "init");
}

describe("MCP server", () => {
  test("argv diagnostics escape bidi formatting controls", async () => {
    await expect(runMcpServer(["--bad\u061c\u200fflag"], {
      stdin: Readable.from([""]),
      stdout: new Writable({
        write(_chunk, _encoding, callback) {
          callback();
        },
      }),
      stderr: { write: () => true },
    })).rejects.toThrow("--bad\\u061c\\u200fflag");
  });

  test("argv diagnostics escape zero-width formatting controls", async () => {
    await expect(runMcpServer(["--bad\u200b\u2060flag"], {
      stdin: Readable.from([""]),
      stdout: new Writable({
        write(_chunk, _encoding, callback) {
          callback();
        },
      }),
      stderr: { write: () => true },
    })).rejects.toThrow("--bad\\u200b\\u2060flag");
  });

  test("argv diagnostics escape unicode line separators", async () => {
    await expect(runMcpServer(["--bad\u2028\u2029flag"], {
      stdin: Readable.from([""]),
      stdout: new Writable({
        write(_chunk, _encoding, callback) {
          callback();
        },
      }),
      stderr: { write: () => true },
    })).rejects.toThrow("--bad\\u2028\\u2029flag");
  });

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

  test("processes a final line-delimited frame without trailing newline", async () => {
    const responses = await exchange([{
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "test-client", version: "0.0.0" },
      },
    }], { trailingNewline: false });

    expect(responses).toHaveLength(1);
    const result = responses[0]!.result as { serverInfo: { name: string } };
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

  test("resources/read escapes control characters in unknown URI errors", async () => {
    const responses = await exchange([
      { jsonrpc: "2.0", id: 1, method: "resources/read", params: { uri: "brna://bad\x1b[31m\u202e" } },
    ]);

    expect(responses[0]!.error?.message).toContain("brna://bad\\x1b[31m\\u202e");
    expect(responses[0]!.error?.message).not.toContain("\x1b");
    expect(responses[0]!.error?.message).not.toContain("\u202e");
  });

  test("--metro accepts bare port shorthand", async () => {
    const requestUrls: string[] = [];
    await exchange([
      { jsonrpc: "2.0", id: 1, method: "resources/read", params: { uri: "brna://current/snapshot" } },
    ], { argv: ["--metro", "19000"], requestUrls });

    expect(requestUrls[0]).toBe("http://localhost:19000/brna/snapshot");
  });

  test("--metro rejects credentials", async () => {
    await expect(runMcpServer(["--metro", "http://user:pass@localhost:8081"], {
      stdin: Readable.from([""]),
      stdout: new Writable({
        write(_chunk, _encoding, callback) {
          callback();
        },
      }),
      stderr: { write: () => true },
    })).rejects.toThrow("Metro URL must not include credentials");
  });

  test("tools/list exposes core action and observability tools", async () => {
    const responses = await exchange([{ jsonrpc: "2.0", id: 1, method: "tools/list" }]);
    const result = responses[0]!.result as {
      tools: Array<{
        name: string;
        inputSchema?: { properties?: Record<string, { enum?: readonly string[]; minimum?: number; type?: string }> };
      }>;
    };
    const names = result.tools.map((t) => t.name).sort();
    expect(names).toEqual(["key", "logs", "long_press", "network", "scroll", "swipe", "tap", "type"]);
    const keyTool = result.tools.find((t) => t.name === "key");
    expect(keyTool?.inputSchema?.properties?.key?.enum).toEqual(ACTION_KEYS);
    const tapTool = result.tools.find((t) => t.name === "tap");
    const swipeTool = result.tools.find((t) => t.name === "swipe");
    const longPressTool = result.tools.find((t) => t.name === "long_press");
    expect(tapTool?.inputSchema?.properties?.at).toEqual({ type: "integer", minimum: 0 });
    expect(swipeTool?.inputSchema?.properties?.by).toEqual({ type: "integer", minimum: 1 });
    expect(longPressTool?.inputSchema?.properties?.duration_ms).toEqual({ type: "integer", minimum: 1 });
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

  test("tools/call key posts supported non-tab keys", async () => {
    const actions: unknown[] = [];
    const responses = await exchange([
      {
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "key", arguments: { key: "enter" } },
      },
    ], { actions });
    const result = responses[0]!.result as { content: Array<{ text: string }> };
    expect(result.content[0]!.text).toContain("ok: key");
    expect(actions[0]).toEqual({ kind: "key", key: "enter" });
  });

  test("unknown tool errors escape control characters", async () => {
    const responses = await exchange([
      {
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "bad\x1b[31m\u202e", arguments: {} },
      },
    ]);

    expect(responses[0]!.error?.message).toContain("bad\\x1b[31m\\u202e");
    expect(responses[0]!.error?.message).not.toContain("\x1b");
    expect(responses[0]!.error?.message).not.toContain("\u202e");
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

  test("unknown selector errors escape control characters", async () => {
    const responses = await exchange([
      {
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "tap", arguments: { selector: "#missing\x1b[31m\u202e" } },
      },
    ]);

    expect(responses[0]!.error?.message).toContain("#missing\\x1b[31m\\u202e");
    expect(responses[0]!.error?.message).not.toContain("\x1b");
    expect(responses[0]!.error?.message).not.toContain("\u202e");
  });

  test("records sanitized MCP tool success and selector failure lifecycles", async () => {
    const stateDir = mkdtempSync(join(tmpdir(), "brna-mcp-usage-"));
    const usage = { stateDir, env: { BRNA_USAGE_LOG: "1", BRNA_CALLER: "claude" }, cwd: stateDir, sessionId: "mcp-test" };
    const selector = "#email";
    const secret = "never-store-this-secret";
    await exchange([{
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "type", arguments: { selector, text: secret } },
    }], {
      usage,
      fresh: makeSnapshot({
        tree: { id: "root", kind: "screen", children: [{ id: "email", kind: "input", name: "PrivateEmail" }] },
      }),
    });
    await exchange([{
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: "tap", arguments: { selector: "button:Submit" } },
    }], {
      usage,
      fresh: makeSnapshot({
        tree: {
          id: "root",
          kind: "screen",
          children: [
            { id: "one", kind: "button", role: "button", name: "Submit" },
            { id: "two", kind: "button", role: "button", name: "Submit" },
          ],
        },
      }),
    });

    const events = await readUsageEvents({ stateDir });
    expect(events.filter((event) => event.operation === "act.type")).toHaveLength(2);
    const failure = events.find((event) => event.event === "operation.finished" && event.operation === "act.tap");
    expect(failure).toMatchObject({ outcome: "error", error_code: "selector.ambiguous", phase: "resolve" });
    const raw = await readFile(join(stateDir, (await readdir(stateDir)).find((name) => name.endsWith(".jsonl"))!), "utf8");
    expect(raw).not.toContain(selector);
    expect(raw).not.toContain(secret);
  });

  test("usage write failure does not change MCP tool results", async () => {
    const root = mkdtempSync(join(tmpdir(), "brna-mcp-usage-failure-"));
    const stateDir = join(root, "not-a-directory");
    await writeFile(stateDir, "file", "utf8");
    const responses = await exchange([{
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "tap", arguments: { selector: "button:Submit" } },
    }], { usage: { stateDir, env: { BRNA_USAGE_LOG: "1" } } });
    expect((responses[0]!.result as { content: Array<{ text: string }> }).content[0]!.text).toContain("ok: tap");
  });
});
