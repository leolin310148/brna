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
import { validateActionRequest, validateSnapshot, type Snapshot } from "@brna/schema";
import { resolve as resolveSelector, toMarkdown } from "@brna/core";

const SERVER_INFO = { name: "brna-mcp", version: "0.0.0" };
const DEFAULT_METRO_URL = "http://localhost:8081";
const SNAPSHOT_RESOURCE_URI = "brna://current/snapshot";
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
    this.stdin.on("data", (chunk: Buffer | string) => {
      buffer += chunk.toString();
      while (true) {
        const idx = buffer.indexOf("\n");
        if (idx === -1) return;
        const line = buffer.slice(0, idx).replace(/\r$/, "");
        buffer = buffer.slice(idx + 1);
        if (line.length === 0) continue;
        try {
          this.onmessage?.(JSONRPCMessageSchema.parse(JSON.parse(line)));
        } catch (err) {
          this.onerror?.(err as Error);
        }
      }
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
  let metroUrl = opts.metroUrl ?? process.env.BRNA_METRO_URL ?? DEFAULT_METRO_URL;
  let device = opts.device;
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i]!;
    if (token === "--metro") {
      const value = argv[++i];
      if (typeof value !== "string" || value.length === 0) {
        throw new Error("missing value for --metro");
      }
      metroUrl = value;
    } else if (token === "--device") {
      const value = argv[++i];
      if (typeof value !== "string" || value.length === 0) {
        throw new Error("missing value for --device");
      }
      device = value;
    }
  }
  const result: { metroUrl: string; device?: string } = { metroUrl };
  if (device !== undefined) result.device = device;
  return result;
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
    ];
  }

  private async readResource(params: unknown): Promise<Record<string, unknown>> {
    const uri = (params as { uri?: unknown })?.uri;
    if (uri !== SNAPSHOT_RESOURCE_URI) {
      throw new Error(`unknown resource uri: ${String(uri)}`);
    }
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

  private listTools() {
    return [
      {
        name: "tap",
        description: "Tap a node identified by a brna selector.",
        inputSchema: {
          type: "object",
          properties: { selector: { type: "string" } },
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
          },
          required: ["selector"],
        },
      },
      {
        name: "key",
        description: "Send a hardware key event.",
        inputSchema: {
          type: "object",
          properties: { key: { type: "string", enum: ["tab"] } },
          required: ["key"],
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
      default:
        throw new Error(`unknown tool: ${name}`);
    }
    validateActionRequest(action);
    await this.postAction(action);
    return {
      content: [{ type: "text", text: `ok: ${name}` }],
    };
  }

  private async resolveTarget(args: Record<string, unknown>): Promise<string> {
    const selector = stringField(args, "selector");
    const snapshot = await this.fetchSnapshot();
    const result = resolveSelector(selector, snapshot);
    if ("ok" in result) return result.ok.id;
    if ("ambiguous" in result) {
      throw new Error(`selector matched multiple nodes: ${selector}`);
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

function stringField(args: Record<string, unknown>, name: string): string {
  const v = args[name];
  if (typeof v !== "string" || v.length === 0) {
    throw new Error(`missing or empty argument: ${name}`);
  }
  return v;
}
