import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync } from "node:fs";
import { readFile, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import {
  DAEMON_INTERNAL_ENV,
  DAEMON_SESSION_ENV,
  DaemonSocketServer,
  NO_DAEMON_ENV,
  daemonSupported,
  requestDaemon,
  resolveDaemonIdentity,
  sanitizeDaemonEnv,
  truthyEnv,
} from "../src/daemon.js";

const CLI_PATH = resolve(import.meta.dir, "../src/cli.ts");

function runCli(cwd: string, args: string[], env: Record<string, string> = {}, input?: string) {
  return spawnSync("bun", ["run", CLI_PATH, ...args], {
    cwd,
    env: { ...process.env, NO_COLOR: "1", BRNA_SESSION_ID: `daemon-test-${Date.now()}-${Math.random()}`, ...env },
    encoding: "utf8",
    input,
    timeout: 5000,
  });
}

async function runCliInteractive(cwd: string, args: string[], env: Record<string, string>, input: string) {
  const proc = spawn("bun", ["run", CLI_PATH, ...args], {
    cwd,
    env: { ...process.env, NO_COLOR: "1", ...env },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  proc.stdout.setEncoding("utf8");
  proc.stderr.setEncoding("utf8");
  proc.stdout.on("data", (chunk) => {
    stdout += chunk;
  });
  proc.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  proc.stdin.end(input);
  const status = await new Promise<number | null>((resolve, reject) => {
    const timeout = setTimeout(() => {
      proc.kill("SIGTERM");
      reject(new Error("timed out waiting for CLI process"));
    }, 5000);
    proc.on("error", (err) => {
      clearTimeout(timeout);
      reject(err);
    });
    proc.on("exit", (code) => {
      clearTimeout(timeout);
      resolve(code);
    });
  });
  return { status, stdout, stderr };
}

describe("daemon helpers", () => {
  test("truthyEnv recognizes opt-out values", () => {
    expect(truthyEnv("1")).toBe(true);
    expect(truthyEnv("true")).toBe(true);
    expect(truthyEnv("0")).toBe(false);
    expect(truthyEnv("false")).toBe(false);
    expect(truthyEnv(undefined)).toBe(false);
  });

  test("sanitizes internal daemon controls from forwarded environments", () => {
    expect(
      sanitizeDaemonEnv({
        PATH: "/bin",
        [DAEMON_INTERNAL_ENV]: "1",
        [NO_DAEMON_ENV]: "1",
        [DAEMON_SESSION_ENV]: "s",
      }),
    ).toEqual({ PATH: "/bin" });
  });

  test("socket identity is scoped by cwd realpath and session id", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "brna-daemon-identity-"));
    const first = await resolveDaemonIdentity(cwd, "s1");
    const second = await resolveDaemonIdentity(cwd, "s2");
    expect(first.cwdRealpath).toBe(await realpath(cwd));
    expect(first.socketPath).not.toBe(second.socketPath);
    expect(first.socketPath).toContain(join("brna", "daemon"));
  });

  test("daemon support is POSIX-only", () => {
    expect(daemonSupported("win32")).toBe(false);
    expect(daemonSupported("darwin")).toBe(true);
    expect(daemonSupported("linux")).toBe(true);
  });

  test("idle timeout waits for an active command to finish", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "brna-daemon-idle-"));
    const identity = await resolveDaemonIdentity(cwd, "idle");
    let releaseCommand!: () => void;
    let startedCommand!: () => void;
    const started = new Promise<void>((resolve) => {
      startedCommand = resolve;
    });
    const release = new Promise<void>((resolve) => {
      releaseCommand = resolve;
    });
    const oldExit = process.exit;
    let exitCalls = 0;
    process.exit = ((code?: string | number | null | undefined): never => {
      exitCalls += 1;
      throw new Error(`unexpected daemon test exit ${code ?? 0}`);
    }) as typeof process.exit;

    const server = new DaemonSocketServer(
      identity.socketPath,
      async () => {
        startedCommand();
        await release;
        return 0;
      },
      25,
    );

    try {
      await server.listen();
      const frames: string[] = [];
      const request = requestDaemon(
        identity.socketPath,
        { type: "command", argv: ["config", "init"], cwd, env: {}, sessionId: "idle" },
        (frame) => frames.push(frame.type),
      );
      await started;
      await sleep(75);
      expect(exitCalls).toBe(0);
      releaseCommand();
      await request;
      expect(frames).toContain("exit");
    } finally {
      await server.close();
      process.exit = oldExit;
    }
  });
});

describe("brna daemon commands", () => {
  test("status does not auto-spawn a stopped daemon", () => {
    const cwd = mkdtempSync(join(tmpdir(), "brna-daemon-status-"));
    const result = runCli(cwd, ["daemon", "status"]);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("Daemon stopped");
  });

  test("global help does not auto-spawn the daemon", () => {
    const cwd = mkdtempSync(join(tmpdir(), "brna-daemon-help-"));
    const session = "daemon-help";
    const help = runCli(cwd, ["--help"], { BRNA_SESSION_ID: session });
    expect(help.status).toBe(0);
    const status = runCli(cwd, ["daemon", "status"], { BRNA_SESSION_ID: session });
    expect(status.stdout).toContain("Daemon stopped");
  });

  test("command help does not auto-spawn the daemon", () => {
    const cwd = mkdtempSync(join(tmpdir(), "brna-daemon-command-help-"));
    const session = "daemon-command-help";
    const help = runCli(cwd, ["config", "--help"], { BRNA_SESSION_ID: session });
    expect(help.status).toBe(0);
    const status = runCli(cwd, ["daemon", "status"], { BRNA_SESSION_ID: session });
    expect(status.stdout).toContain("Daemon stopped");
  });

  test("mcp runs in the foreground and does not auto-spawn the daemon", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "brna-daemon-mcp-"));
    const session = "daemon-mcp";
    const input = [
      {
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2024-11-05",
          capabilities: {},
          clientInfo: { name: "test-client", version: "0.0.0" },
        },
      },
      { jsonrpc: "2.0", method: "notifications/initialized" },
      { jsonrpc: "2.0", id: 2, method: "tools/list" },
    ].map((frame) => JSON.stringify(frame)).join("\n") + "\n";

    const mcp = await runCliInteractive(cwd, ["mcp"], { BRNA_SESSION_ID: session }, input);
    expect(mcp.status).toBe(0);
    expect(mcp.stdout).toContain("\"serverInfo\":{\"name\":\"brna-mcp\"");
    expect(mcp.stdout).toContain("\"name\":\"swipe\"");
    expect(mcp.stderr).toBe("");

    const status = runCli(cwd, ["daemon", "status"], { BRNA_SESSION_ID: session });
    expect(status.stdout).toContain("Daemon stopped");
  });

  test("stop does not auto-spawn a stopped daemon", () => {
    const cwd = mkdtempSync(join(tmpdir(), "brna-daemon-stop-"));
    const result = runCli(cwd, ["daemon", "stop"]);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("Daemon already stopped");
  });

  test("BRNA_NO_DAEMON bypasses auto-spawn", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "brna-daemon-bypass-"));
    const result = runCli(cwd, ["config", "init"], { [NO_DAEMON_ENV]: "1" });
    expect(result.status).toBe(0);
    expect(existsSync(join(cwd, "brna.config.ts"))).toBe(true);
    const status = runCli(cwd, ["daemon", "status"]);
    expect(status.stdout).toContain("Daemon stopped");
  });

  test("auto-spawn forwards a command, preserves cwd, and stop cleans up", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "brna-daemon-forward-"));
    const session = "daemon-forward";
    const init = runCli(cwd, ["config", "init"], { BRNA_SESSION_ID: session });
    expect(init.status).toBe(0);
    expect(await readFile(join(cwd, "brna.config.ts"), "utf8")).toContain("redactSecureFields");

    const status = runCli(cwd, ["daemon", "status"], { BRNA_SESSION_ID: session });
    expect(status.status).toBe(0);
    expect(status.stdout).toContain("Daemon running");
    expect(status.stdout).toContain("pid ");

    const stop = runCli(cwd, ["daemon", "stop"], { BRNA_SESSION_ID: session });
    expect(stop.status).toBe(0);
    expect(stop.stdout).toContain("Daemon stopped");
    const stopped = runCli(cwd, ["daemon", "status"], { BRNA_SESSION_ID: session });
    expect(stopped.stdout).toContain("Daemon stopped");
  });

  test("distinct sessions in the same cwd use distinct daemons", () => {
    const cwd = mkdtempSync(join(tmpdir(), "brna-daemon-sessions-"));
    const first = runCli(cwd, ["config", "init"], { BRNA_SESSION_ID: "daemon-session-one" });
    expect(first.status).toBe(0);

    const firstStatus = runCli(cwd, ["daemon", "status"], { BRNA_SESSION_ID: "daemon-session-one" });
    expect(firstStatus.stdout).toContain("Daemon running");
    const secondStatus = runCli(cwd, ["daemon", "status"], { BRNA_SESSION_ID: "daemon-session-two" });
    expect(secondStatus.stdout).toContain("Daemon stopped");

    const stop = runCli(cwd, ["daemon", "stop"], { BRNA_SESSION_ID: "daemon-session-one" });
    expect(stop.stdout).toContain("Daemon stopped");
  });
});

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
