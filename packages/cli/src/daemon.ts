import { spawn } from "node:child_process";
import { createConnection, createServer, type Server, type Socket } from "node:net";
import { mkdir, realpath, rm, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { getSessionId } from "./session.js";

export const DAEMON_INTERNAL_ENV = "BRNA_DAEMON_INTERNAL";
export const DAEMON_SESSION_ENV = "BRNA_DAEMON_SESSION_ID";
export const NO_DAEMON_ENV = "BRNA_NO_DAEMON";

const SOCKET_READY_TIMEOUT_MS = 2000;
export const DAEMON_IDLE_TIMEOUT_MS = 10 * 60 * 1000;

export interface CommandRequest {
  type: "command";
  argv: string[];
  cwd: string;
  env: Record<string, string>;
  sessionId: string;
}

export interface DaemonIdentity {
  cwdRealpath: string;
  sessionId: string;
  socketPath: string;
}

export type DaemonControlRequest =
  | { type: "ping" }
  | { type: "stop" }
  | CommandRequest;

export type DaemonFrame =
  | { type: "stdout"; data: string }
  | { type: "stderr"; data: string }
  | { type: "exit"; code: number }
  | { type: "pong"; pid: number; uptimeMs: number }
  | { type: "stopping" }
  | { type: "error"; message: string };

export interface DaemonCommandHandler {
  (request: CommandRequest, streams: {
    stdout: Pick<typeof process.stdout, "write">;
    stderr: Pick<typeof process.stderr, "write">;
  }): Promise<number>;
}

export function daemonSupported(platform = process.platform): boolean {
  return platform !== "win32";
}

export function truthyEnv(value: string | undefined): boolean {
  if (value === undefined || value.length === 0) return false;
  return !["0", "false", "no", "off"].includes(value.toLowerCase());
}

export async function resolveDaemonIdentity(cwd = process.cwd(), sessionId = getSessionId()): Promise<DaemonIdentity> {
  const cwdRealpath = await realpath(cwd);
  const hash = createHash("sha256").update(`${cwdRealpath}\0${sessionId}`).digest("hex").slice(0, 32);
  return {
    cwdRealpath,
    sessionId,
    socketPath: join(tmpdir(), "brna", "daemon", `${hash}.sock`),
  };
}

export function sanitizeDaemonEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) continue;
    if (key === DAEMON_INTERNAL_ENV || key === NO_DAEMON_ENV || key === DAEMON_SESSION_ENV) continue;
    result[key] = value;
  }
  return result;
}

export class DaemonSocketServer {
  private readonly server: Server;
  private active = 0;
  private idleTimer: NodeJS.Timeout | null = null;
  private shuttingDown = false;
  private queue: Promise<void> = Promise.resolve();
  private readonly startedAt = Date.now();

  constructor(
    private readonly socketPath: string,
    private readonly handleCommand: DaemonCommandHandler,
    private readonly idleTimeoutMs = DAEMON_IDLE_TIMEOUT_MS,
  ) {
    this.server = createServer((socket) => {
      this.handleSocket(socket);
    });
  }

  async listen(): Promise<void> {
    await mkdir(dirname(this.socketPath), { recursive: true, mode: 0o700 });
    if (existsSync(this.socketPath)) {
      await rm(this.socketPath, { force: true });
    }
    await new Promise<void>((resolve, reject) => {
      const onError = (err: Error) => {
        this.server.off("listening", onListening);
        reject(err);
      };
      const onListening = () => {
        this.server.off("error", onError);
        resolve();
      };
      this.server.once("error", onError);
      this.server.once("listening", onListening);
      this.server.listen(this.socketPath);
    });
    this.armIdleTimer();
  }

  async close(): Promise<void> {
    this.shuttingDown = true;
    this.clearIdleTimer();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
    await rm(this.socketPath, { force: true });
  }

  private handleSocket(socket: Socket): void {
    socket.setEncoding("utf8");
    let buffer = "";
    socket.on("data", (chunk) => {
      buffer += chunk;
      let newline = buffer.indexOf("\n");
      while (newline >= 0) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        if (line.length > 0) this.handleLine(socket, line);
        newline = buffer.indexOf("\n");
      }
    });
  }

  private handleLine(socket: Socket, line: string): void {
    let request: DaemonControlRequest;
    try {
      request = JSON.parse(line) as DaemonControlRequest;
    } catch {
      writeFrame(socket, { type: "error", message: "malformed daemon request" });
      socket.end();
      return;
    }

    if (request.type === "ping") {
      writeFrame(socket, { type: "pong", pid: process.pid, uptimeMs: Date.now() - this.startedAt });
      socket.end();
      return;
    }

    if (request.type === "stop") {
      writeFrame(socket, { type: "stopping" });
      socket.end();
      setTimeout(() => void this.close().then(() => process.exit(0)), 0);
      return;
    }

    this.queue = this.queue.then(() => this.runCommand(socket, request));
  }

  private async runCommand(socket: Socket, request: CommandRequest): Promise<void> {
    this.active += 1;
    this.clearIdleTimer();
    try {
      const code = await this.handleCommand(request, {
        stdout: { write: (chunk: string | Uint8Array) => writeFrame(socket, { type: "stdout", data: String(chunk) }) },
        stderr: { write: (chunk: string | Uint8Array) => writeFrame(socket, { type: "stderr", data: String(chunk) }) },
      });
      writeFrame(socket, { type: "exit", code });
    } catch (err) {
      writeFrame(socket, { type: "stderr", data: `brna: ${(err as Error).message}\n` });
      writeFrame(socket, { type: "exit", code: 1 });
    } finally {
      socket.end();
      this.active -= 1;
      this.armIdleTimer();
    }
  }

  private armIdleTimer(): void {
    if (this.shuttingDown || this.active > 0) return;
    this.clearIdleTimer();
    this.idleTimer = setTimeout(() => {
      void this.close().then(() => process.exit(0));
    }, this.idleTimeoutMs);
  }

  private clearIdleTimer(): void {
    if (this.idleTimer !== null) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
  }
}

export async function requestDaemon(socketPath: string, request: DaemonControlRequest, onFrame: (frame: DaemonFrame) => void): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const socket = createConnection(socketPath);
    let settled = false;
    let buffer = "";
    const settle = (err?: Error) => {
      if (settled) return;
      settled = true;
      if (err) reject(err);
      else resolve();
    };
    socket.setEncoding("utf8");
    socket.on("connect", () => {
      socket.write(`${JSON.stringify(request)}\n`);
    });
    socket.on("data", (chunk) => {
      buffer += chunk;
      let newline = buffer.indexOf("\n");
      while (newline >= 0) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        if (line.length > 0) onFrame(JSON.parse(line) as DaemonFrame);
        newline = buffer.indexOf("\n");
      }
    });
    socket.on("error", settle);
    socket.on("end", () => settle());
    socket.on("close", () => settle());
  });
}

export async function pingDaemon(socketPath: string): Promise<{ pid: number; uptimeMs: number } | null> {
  let pong: { pid: number; uptimeMs: number } | null = null;
  try {
    await requestDaemon(socketPath, { type: "ping" }, (frame) => {
      if (frame.type === "pong") pong = { pid: frame.pid, uptimeMs: frame.uptimeMs };
    });
    return pong;
  } catch {
    return null;
  }
}

export async function stopDaemon(socketPath: string): Promise<boolean> {
  let stopping = false;
  try {
    await requestDaemon(socketPath, { type: "stop" }, (frame) => {
      if (frame.type === "stopping") stopping = true;
    });
  } catch {
    return false;
  }
  if (!stopping) return false;
  const deadline = Date.now() + 2000;
  while (Date.now() < deadline) {
    try {
      await stat(socketPath);
    } catch {
      return true;
    }
    await sleep(25);
  }
  return false;
}

export async function ensureDaemon(identity: DaemonIdentity): Promise<void> {
  if (await pingDaemon(identity.socketPath)) return;
  await rm(identity.socketPath, { force: true });
  const child = spawn(process.execPath, process.argv.slice(1), {
    cwd: process.cwd(),
    detached: true,
    stdio: "ignore",
    env: {
      ...process.env,
      [DAEMON_INTERNAL_ENV]: "1",
      [NO_DAEMON_ENV]: "1",
      [DAEMON_SESSION_ENV]: identity.sessionId,
    },
  });
  child.unref();
  const deadline = Date.now() + SOCKET_READY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (await pingDaemon(identity.socketPath)) return;
    await sleep(25);
  }
  throw new Error("daemon did not become ready");
}

export async function forwardCommand(identity: DaemonIdentity, argv: string[]): Promise<number> {
  let exitCode = 1;
  const request: CommandRequest = {
    type: "command",
    argv,
    cwd: process.cwd(),
    env: sanitizeDaemonEnv(process.env),
    sessionId: identity.sessionId,
  };
  await requestDaemon(identity.socketPath, request, (frame) => {
    if (frame.type === "stdout") process.stdout.write(frame.data);
    else if (frame.type === "stderr") process.stderr.write(frame.data);
    else if (frame.type === "exit") exitCode = frame.code;
    else if (frame.type === "error") process.stderr.write(`brna: ${frame.message}\n`);
  });
  return exitCode;
}

function writeFrame(socket: Socket, frame: DaemonFrame): boolean {
  return socket.write(`${JSON.stringify(frame)}\n`);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
