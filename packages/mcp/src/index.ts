import { once } from "node:events";
import type { Readable, Writable } from "node:stream";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import {
  CallToolRequestSchema,
  JSONRPCMessageSchema,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
  ReadResourceRequestSchema,
  type JSONRPCMessage,
} from "@modelcontextprotocol/sdk/types.js";
import {
  ACTION_KEYS,
  parseLogsRequestOptions,
  parseNetworkRequestOptions,
  validateActionRequest,
  validateSnapshot,
  type Node,
  type Snapshot,
} from "@brna/schema";
import { resolve as resolveSelector, toMarkdown } from "@brna/core";

const SERVER_INFO = { name: "brna-mcp", version: "0.0.0" };
const DEFAULT_METRO_URL = "http://localhost:8081";
const SNAPSHOT_RESOURCE_URI = "brna://current/snapshot";
const LOGS_RESOURCE_URI = "brna://current/logs";
const NETWORK_RESOURCE_URI = "brna://current/network";
const DEVICE_HEADER = "x-brna-device-id";

interface ServerOptions {
  metroUrl?: string;
  device?: string;
  fetch?: typeof fetch;
  stdin?: Readable;
  stdout?: Writable;
  stderr?: Pick<typeof process.stderr, "write">;
}

export async function runMcpServer(argv: string[], opts: ServerOptions = {}): Promise<void> {
  const { metroUrl, device } = parseArgs(argv, opts);
  const fetchImpl = opts.fetch ?? fetch;
  const stdin = opts.stdin ?? process.stdin;
  const stdout = opts.stdout ?? process.stdout;
  const stderr = opts.stderr ?? process.stderr;

  const app = new BrnaMcpApp({ metroUrl, device, fetch: fetchImpl, stdout, stderr });
  const server = app.createServer();
  const transport = opts.stdin || opts.stdout
    ? new LineTransport(stdin, stdout)
    : new StdioServerTransport(stdin, stdout);
  const ended = once(stdin, "end");
  await server.connect(transport);
  await ended;
  if (transport instanceof LineTransport) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  await transport.close();
}

class LineTransport implements Transport {
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: (message: JSONRPCMessage) => void;
  private started = false;

  constructor(private stdin: Readable, private stdout: Writable) {}

  async start(): Promise<void> {
    if (this.started) throw new Error("LineTransport already started");
    this.started = true;
    let buffer = "";
    const dispatchLine = (line: string) => {
      if (line.length === 0) return;
      try {
        this.onmessage?.(JSONRPCMessageSchema.parse(JSON.parse(line)));
      } catch (err) {
        this.onerror?.(err as Error);
      }
    };
    this.stdin.on("data", (chunk: Buffer | string) => {
      buffer += chunk.toString();
      while (true) {
        const idx = buffer.indexOf("\n");
        if (idx === -1) return;
        const line = buffer.slice(0, idx).replace(/\r$/, "");
        buffer = buffer.slice(idx + 1);
        dispatchLine(line);
      }
    });
    this.stdin.on("end", () => {
      const line = buffer.replace(/\r$/, "");
      buffer = "";
      dispatchLine(line);
    });
    this.stdin.on("error", (err) => this.onerror?.(err));
  }

  async send(message: JSONRPCMessage): Promise<void> {
    await new Promise<void>((resolve) => {
      if (this.stdout.write(JSON.stringify(message) + "\n")) resolve();
      else this.stdout.once("drain", resolve);
    });
  }

  async close(): Promise<void> {
    this.onclose?.();
  }
}

function parseArgs(argv: string[], opts: ServerOptions): { metroUrl: string; device?: string } {
  let metroUrl = normalizeMetroUrl(trimOptional(opts.metroUrl ?? process.env.BRNA_METRO_URL) ?? DEFAULT_METRO_URL);
  let device = trimOptional(opts.device);
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i]!;
    if (token === "--metro") {
      metroUrl = normalizeMetroUrl(parseFlagValue(argv[++i], "--metro"));
    } else if (token === "--device") {
      device = parseFlagValue(argv[++i], "--device");
    } else {
      throw new Error(`unknown flag: ${escapeControlCharacters(token)}`);
    }
  }
  const result: { metroUrl: string; device?: string } = { metroUrl };
  if (device !== undefined) result.device = device;
  return result;
}

function trimOptional(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function parseFlagValue(value: string | undefined, flag: string): string {
  const trimmed = trimOptional(value);
  if (trimmed === undefined) {
    throw new Error(`missing value for ${flag}`);
  }
  return trimmed;
}

function escapeControlCharacters(value: string): string {
  return value.replace(/[\x00-\x1f\x7f-\x9f\u061c\u200b-\u200f\u2028-\u202e\u2060\u2066-\u2069\ufeff]/g, (char) => {
    if (char === "\n") return "\\n";
    if (char === "\r") return "\\r";
    if (char === "\t") return "\\t";
    if (char.charCodeAt(0) > 0xff) {
      return `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`;
    }
    return `\\x${char.charCodeAt(0).toString(16).padStart(2, "0")}`;
  });
}

function normalizeMetroUrl(value: string): string {
  const trimmed = value.trim();
  if (/^\d+$/.test(trimmed)) {
    return normalizeMetroUrl(`localhost:${trimmed}`);
  }

  const hasExplicitScheme = /^[a-z][a-z\d+.-]*:\/\//i.test(trimmed);
  if (!hasExplicitScheme && !/:\d+(?:[/?#]|$)/.test(trimmed)) {
    throw new Error("Metro URL shorthand must include a port");
  }
  const url = new URL(hasExplicitScheme ? trimmed : `http://${trimmed}`);
  if ((url.protocol !== "http:" && url.protocol !== "https:") || url.host.length === 0) {
    throw new Error("Metro URL must use http:// or https://");
  }
  if (url.username.length > 0 || url.password.length > 0) {
    throw new Error("Metro URL must not include credentials");
  }
  return `${url.protocol}//${url.host}`;
}

interface McpServerDeps {
  metroUrl: string;
  device?: string;
  fetch: typeof fetch;
  stdout: Writable;
  stderr: Pick<typeof process.stderr, "write">;
}

class BrnaMcpApp {
  constructor(private deps: McpServerDeps) {}

  createServer(): Server {
    const server = new Server(SERVER_INFO, {
      capabilities: {
        resources: { subscribe: false, listChanged: false },
        tools: { listChanged: false },
      },
    });
    server.setRequestHandler(ListResourcesRequestSchema, async () => ({ resources: this.listResources() }));
    server.setRequestHandler(ReadResourceRequestSchema, async (request) => this.readResource(request.params));
    server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: this.listTools() }));
    server.setRequestHandler(CallToolRequestSchema, async (request) => this.callTool(request.params));
    return server;
  }

  private listResources() {
    return [
      {
        uri: SNAPSHOT_RESOURCE_URI,
        name: "Current snapshot (markdown)",
        description: "Markdown projection of the connected runtime's current screen.",
        mimeType: "text/markdown",
      },
      {
        uri: LOGS_RESOURCE_URI,
        name: "Recent runtime logs (JSON)",
        description: "Recent console and runtime error records captured by the brna runtime.",
        mimeType: "application/json",
      },
      {
        uri: NETWORK_RESOURCE_URI,
        name: "Recent runtime network activity (JSON)",
        description: "Recent fetch and XHR records captured by the brna runtime.",
        mimeType: "application/json",
      },
    ];
  }

  private async readResource(params: unknown): Promise<Record<string, unknown>> {
    const uri = (params as { uri?: unknown })?.uri;
    if (uri === SNAPSHOT_RESOURCE_URI) {
      const snapshot = await this.fetchSnapshot();
      return {
        contents: [
          {
            uri: SNAPSHOT_RESOURCE_URI,
            mimeType: "text/markdown",
            text: toMarkdown(snapshot),
          },
        ],
      };
    }
    if (uri === LOGS_RESOURCE_URI) {
      const records = await this.fetchObservability("logs", {});
      return {
        contents: [
          {
            uri: LOGS_RESOURCE_URI,
            mimeType: "application/json",
            text: JSON.stringify({ records }, null, 2),
          },
        ],
      };
    }
    if (uri === NETWORK_RESOURCE_URI) {
      const records = await this.fetchObservability("network", {});
      return {
        contents: [
          {
            uri: NETWORK_RESOURCE_URI,
            mimeType: "application/json",
            text: JSON.stringify({ records }, null, 2),
          },
        ],
      };
    }
    throw new Error(`unknown resource uri: ${String(uri)}`);
  }

  private listTools() {
    return [
      {
        name: "tap",
        description: "Tap a node identified by a brna selector.",
        inputSchema: {
          type: "object",
          properties: { selector: { type: "string" }, at: { type: "number", minimum: 0 } },
          required: ["selector"],
        },
      },
      {
        name: "type",
        description: "Type text into a node identified by a brna selector.",
        inputSchema: {
          type: "object",
          properties: {
            selector: { type: "string" },
            text: { type: "string" },
            at: { type: "number", minimum: 0 },
          },
          required: ["selector", "text"],
        },
      },
      {
        name: "scroll",
        description: "Scroll a node in a direction.",
        inputSchema: {
          type: "object",
          properties: {
            selector: { type: "string" },
            direction: { type: "string", enum: ["up", "down", "left", "right"] },
            by: { type: "number" },
            at: { type: "number", minimum: 0 },
          },
          required: ["selector", "direction"],
        },
      },
      {
        name: "swipe",
        description: "Swipe a node in a direction.",
        inputSchema: {
          type: "object",
          properties: {
            selector: { type: "string" },
            direction: { type: "string", enum: ["up", "down", "left", "right"] },
            by: { type: "number" },
            at: { type: "number", minimum: 0 },
          },
          required: ["selector", "direction"],
        },
      },
      {
        name: "long_press",
        description: "Long-press a node identified by a brna selector.",
        inputSchema: {
          type: "object",
          properties: {
            selector: { type: "string" },
            duration_ms: { type: "number" },
            at: { type: "number", minimum: 0 },
          },
          required: ["selector"],
        },
      },
      {
        name: "key",
        description: "Send a hardware key event.",
        inputSchema: {
          type: "object",
          properties: { key: { type: "string", enum: ACTION_KEYS } },
          required: ["key"],
        },
      },
      {
        name: "logs",
        description: "Read recent runtime console/error log records (redacted).",
        inputSchema: {
          type: "object",
          properties: {
            since: { type: "number" },
            level: { type: "string", enum: ["debug", "log", "info", "warn", "error"] },
            limit: { type: "number" },
          },
        },
      },
      {
        name: "network",
        description: "Read recent runtime fetch/XHR network records (redacted).",
        inputSchema: {
          type: "object",
          properties: {
            since: { type: "number" },
            method: { type: "string" },
            status: { type: "number" },
            statusMin: { type: "number" },
            statusMax: { type: "number" },
            limit: { type: "number" },
          },
        },
      },
    ];
  }

  private async callTool(params: unknown): Promise<Record<string, unknown>> {
    const args = (params ?? {}) as { name?: unknown; arguments?: Record<string, unknown> };
    const name = typeof args.name === "string" ? args.name : "";
    const a = args.arguments ?? {};
    let action: unknown;
    switch (name) {
      case "tap":
        action = { kind: "tap", selector: stringField(a, "selector"), target_id: await this.resolveTarget(a) };
        break;
      case "type":
        action = {
          kind: "type",
          selector: stringField(a, "selector"),
          target_id: await this.resolveTarget(a),
          text: stringField(a, "text"),
        };
        break;
      case "scroll": {
        const direction = stringField(a, "direction");
        const base: Record<string, unknown> = {
          kind: "scroll",
          selector: stringField(a, "selector"),
          target_id: await this.resolveTarget(a),
          direction,
        };
        if (typeof a.by === "number") base.by = a.by;
        action = base;
        break;
      }
      case "swipe": {
        const direction = stringField(a, "direction");
        const base: Record<string, unknown> = {
          kind: "swipe",
          selector: stringField(a, "selector"),
          target_id: await this.resolveTarget(a),
          direction,
        };
        if (typeof a.by === "number") base.by = a.by;
        action = base;
        break;
      }
      case "long_press": {
        action = {
          kind: "long_press",
          selector: stringField(a, "selector"),
          target_id: await this.resolveTarget(a),
          duration_ms: typeof a.duration_ms === "number" ? a.duration_ms : 500,
        };
        break;
      }
      case "key":
        action = { kind: "key", key: stringField(a, "key") };
        break;
      case "logs": {
        const records = await this.fetchObservability("logs", a);
        return {
          content: [{ type: "text", text: JSON.stringify({ records }, null, 2) }],
        };
      }
      case "network": {
        const records = await this.fetchObservability("network", a);
        return {
          content: [{ type: "text", text: JSON.stringify({ records }, null, 2) }],
        };
      }
      default:
        throw new Error(`unknown tool: ${name}`);
    }
    validateActionRequest(action);
    await this.postAction(action);
    return {
      content: [{ type: "text", text: `ok: ${name}` }],
    };
  }

  private async fetchObservability(
    kind: "logs" | "network",
    args: Record<string, unknown>,
  ): Promise<unknown[]> {
    const headers: Record<string, string> = {};
    if (this.deps.device !== undefined) headers[DEVICE_HEADER] = this.deps.device;
    const options = kind === "logs" ? parseLogsFilters(args) : parseNetworkFilters(args);
    const useBody = Object.keys(options).length > 0;
    const url = `${this.deps.metroUrl}/brna/${kind}`;
    const res = await this.deps.fetch(url, {
      method: useBody ? "POST" : "GET",
      headers: useBody ? { ...headers, "Content-Type": "application/json" } : headers,
      ...(useBody ? { body: JSON.stringify(options) } : {}),
    });
    if (!res.ok) throw new Error(`${kind} HTTP ${res.status}`);
    const body = (await res.json()) as { records?: unknown };
    return Array.isArray(body.records) ? body.records : [];
  }

  private async resolveTarget(args: Record<string, unknown>): Promise<string> {
    const selector = stringField(args, "selector");
    const at = optionalAt(args);
    const snapshot = await this.fetchSnapshot();
    const result = resolveSelector(selector, snapshot, at === undefined ? {} : { at });
    if ("ok" in result) return result.ok.id;
    if ("ambiguous" in result) {
      throw new Error(JSON.stringify({
        code: "ambiguous",
        selector,
        ...(result.at !== undefined ? { at: result.at } : {}),
        matches: describeMatches(result.ambiguous),
      }));
    }
    throw new Error(`selector did not match a node: ${selector}`);
  }

  private async fetchSnapshot(): Promise<Snapshot> {
    const headers: Record<string, string> = {};
    if (this.deps.device !== undefined) headers[DEVICE_HEADER] = this.deps.device;
    const res = await this.deps.fetch(`${this.deps.metroUrl}/brna/snapshot`, { headers });
    if (!res.ok) throw new Error(`snapshot HTTP ${res.status}`);
    const snapshot = (await res.json()) as Snapshot;
    validateSnapshot(snapshot);
    return snapshot;
  }

  private async postAction(action: unknown): Promise<void> {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (this.deps.device !== undefined) headers[DEVICE_HEADER] = this.deps.device;
    const res = await this.deps.fetch(`${this.deps.metroUrl}/brna/action`, {
      method: "POST",
      headers,
      body: JSON.stringify(action),
    });
    if (res.status === 204) return;
    let body: unknown = null;
    try {
      body = await res.json();
    } catch {
      /* ignore */
    }
    const message = body && typeof body === "object" && "message" in body && typeof (body as Record<string, unknown>).message === "string"
      ? (body as Record<string, string>).message
      : `action HTTP ${res.status}`;
    throw new Error(message);
  }
}

function parseLogsFilters(args: Record<string, unknown>): ReturnType<typeof parseLogsRequestOptions> {
  return parseLogsRequestOptions({
    since: args.since,
    level: args.level,
    limit: args.limit,
  });
}

function parseNetworkFilters(args: Record<string, unknown>): ReturnType<typeof parseNetworkRequestOptions> {
  return parseNetworkRequestOptions({
    since: args.since,
    method: args.method,
    status: args.status,
    statusMin: args.statusMin,
    statusMax: args.statusMax,
    limit: args.limit,
  });
}

function stringField(args: Record<string, unknown>, name: string): string {
  const v = args[name];
  if (typeof v !== "string" || v.length === 0) {
    throw new Error(`missing or empty argument: ${name}`);
  }
  return v;
}

function optionalAt(args: Record<string, unknown>): number | undefined {
  const v = args.at;
  if (v === undefined) return undefined;
  if (typeof v !== "number" || !Number.isInteger(v) || v < 0) {
    throw new Error("argument at must be a non-negative integer");
  }
  return v;
}

function describeMatches(matches: Node[]): Array<Record<string, unknown>> {
  return matches.map((node, index) => {
    const out: Record<string, unknown> = {
      index,
      kind: node.kind,
      selector: candidateSelector(node),
    };
    if (node.bounds) out.bounds = node.bounds;
    return out;
  });
}

function candidateSelector(node: Node): string {
  if (node.selector) return node.selector;
  const suggested = node.suggested_selectors?.[0];
  if (suggested) return suggested;
  return `#${node.id}`;
}
