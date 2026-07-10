#!/usr/bin/env node
import { runSnapshot } from "./snapshot.js";
import { runAct } from "./act.js";
import { runCapture } from "./capture.js";
import { runDevices } from "./devices.js";
import { runDoctor } from "./doctor.js";
import { runVerify } from "./verify.js";
import { runMcp } from "./mcp.js";
import { runConfig } from "./config.js";
import { runTrace } from "./trace.js";
import { runWait } from "./wait.js";
import { runLogs } from "./logs.js";
import { runNetwork } from "./network.js";
import { commandByName, formatCommandHelp, formatGlobalHelp } from "./metadata.js";
import { escapeControlCharacters } from "./format.js";
import { runUsage } from "./usage.js";
import { errorCodeFromExit, sanitizeCliInvocation, startUsageOperation } from "@brna/local-usage";
import { getSessionId } from "./session.js";
import {
  DAEMON_INTERNAL_ENV,
  DAEMON_SESSION_ENV,
  DaemonSocketServer,
  daemonSupported,
  ensureDaemon,
  forwardCommand,
  pingDaemon,
  resolveDaemonIdentity,
  stopDaemon,
  truthyEnv,
  NO_DAEMON_ENV,
  type CommandRequest,
} from "./daemon.js";

class CliExit extends Error {
  constructor(readonly code: number) {
    super("cli exit");
  }
}

type Writable = Pick<typeof process.stdout, "write">;

export async function runCli(argv = process.argv.slice(2)): Promise<number> {
  const invocation = process.env[DAEMON_INTERNAL_ENV] === "1" ? null : sanitizeCliInvocation(argv);
  const usage = invocation
    ? await startUsageOperation({
        surface: "cli",
        operation: invocation.operation,
        brnaVersion: "0.1.3",
        ...(invocation.dimensions ? { dimensions: invocation.dimensions } : {}),
        sessionId: getSessionId(),
      })
    : null;
  try {
    const code = await runCliUnobserved(argv);
    if (usage) {
      if (code === 0) await usage.finishSuccess({ exitCode: code });
      else await usage.finishError({ exitCode: code, errorCode: errorCodeFromExit(code), phase: phaseFromExit(code) });
    }
    return code;
  } catch (err) {
    await usage?.finishError({ exitCode: 1, errorCode: "internal.unexpected", phase: "internal" });
    throw err;
  }
}

async function runCliUnobserved(argv: string[]): Promise<number> {
  if (process.env[DAEMON_INTERNAL_ENV] === "1") {
    await runDaemon();
    return 0;
  }

  if (argv.length === 0) {
    process.stderr.write(formatGlobalHelp());
    return 4;
  }

  const localCode = await maybeRunLocalOnly(argv);
  if (localCode !== null) return localCode;

  if (shouldForwardToDaemon(argv)) {
    try {
      const identity = await resolveDaemonIdentity();
      await ensureDaemon(identity);
      return await forwardCommand(identity, argv);
    } catch (err) {
      process.stderr.write(`brna: daemon unavailable: ${(err as Error).message}\n`);
      return 1;
    }
  }

  return runCommandDirect(argv);
}

async function maybeRunLocalOnly(argv: string[]): Promise<number | null> {
  const subcommand = argv[0]!;
  const rest = argv.slice(1);

  if (subcommand === "--help" || subcommand === "-h" || subcommand === "help") {
    const commandName = rest[0];
    if (commandName === undefined) {
      process.stdout.write(formatGlobalHelp());
      return 0;
    }
    const command = commandByName(commandName);
    if (!command) {
      process.stderr.write(formatUnknownSubcommand(commandName));
      return 4;
    }
    process.stdout.write(formatCommandHelp(command));
    return 0;
  }

  const commandHelp = rest.includes("--help") || rest.includes("-h");
  const command = commandByName(subcommand);
  if (commandHelp) {
    if (!command) {
      process.stderr.write(formatUnknownSubcommand(subcommand));
      return 4;
    }
    process.stdout.write(formatCommandHelp(command));
    return 0;
  }

  if (subcommand === "daemon") {
    return runDaemonManagement(rest);
  }

  if (subcommand === "usage") {
    return runUsage(rest);
  }

  return null;
}

function shouldForwardToDaemon(argv: string[]): boolean {
  if (!daemonSupported()) return false;
  if (truthyEnv(process.env[NO_DAEMON_ENV])) return false;
  if (process.env[DAEMON_INTERNAL_ENV] === "1") return false;
  if (argv[0] === "daemon") return false;
  if (argv[0] === "mcp") return false;
  return commandByName(argv[0]!) !== undefined;
}

async function runDaemonManagement(rest: string[]): Promise<number> {
  const sub = rest[0];
  if (sub !== "status" && sub !== "stop") {
    process.stderr.write("brna: usage: brna daemon <status|stop>\n");
    return 4;
  }
  if (!daemonSupported()) {
    process.stdout.write("Daemon mode is unsupported on this platform.\n");
    return 0;
  }
  const identity = await resolveDaemonIdentity();
  if (sub === "status") {
    const status = await pingDaemon(identity.socketPath);
    if (!status) {
      process.stdout.write("Daemon stopped\n");
      return 0;
    }
    process.stdout.write(`Daemon running (pid ${status.pid}, uptime ${formatDuration(status.uptimeMs)})\n`);
    return 0;
  }
  const stopped = await stopDaemon(identity.socketPath);
  process.stdout.write(stopped ? "Daemon stopped\n" : "Daemon already stopped\n");
  return 0;
}

async function runDaemon(): Promise<void> {
  if (!daemonSupported()) return;
  const identity = await resolveDaemonIdentity(process.cwd(), process.env[DAEMON_SESSION_ENV]);
  const server = new DaemonSocketServer(identity.socketPath, runForwardedCommand);
  const cleanup = () => {
    void server.close().finally(() => process.exit(0));
  };
  process.once("SIGTERM", cleanup);
  process.once("SIGINT", cleanup);
  await server.listen();
  await new Promise<never>(() => {
    /* keep daemon process alive until idle timeout, stop, or signal */
  });
}

async function runForwardedCommand(request: CommandRequest, streams: { stdout: Writable; stderr: Writable }): Promise<number> {
  const oldCwd = process.cwd();
  const oldEnv = { ...process.env };
  const oldStdoutWrite = process.stdout.write;
  const oldStderrWrite = process.stderr.write;
  const oldExit = process.exit;
  process.chdir(request.cwd);
  replaceEnv({ ...request.env, [DAEMON_SESSION_ENV]: request.sessionId, [NO_DAEMON_ENV]: "1" });
  process.stdout.write = streams.stdout.write.bind(streams.stdout) as typeof process.stdout.write;
  process.stderr.write = streams.stderr.write.bind(streams.stderr) as typeof process.stderr.write;
  process.exit = ((code?: string | number | null | undefined): never => {
    throw new CliExit(typeof code === "number" ? code : 0);
  }) as typeof process.exit;
  try {
    return await runCommandDirect(request.argv, streams);
  } finally {
    process.chdir(oldCwd);
    replaceEnv(oldEnv);
    process.stdout.write = oldStdoutWrite;
    process.stderr.write = oldStderrWrite;
    process.exit = oldExit;
  }
}

async function runCommandDirect(argv: string[], streams?: { stdout: Writable; stderr: Writable }): Promise<number> {
  const subcommand = argv[0]!;
  const rest = argv.slice(1);
  const runtime = streams
    ? {
        stdout: streams.stdout,
        stderr: streams.stderr,
        exit: (code: number): never => {
          throw new CliExit(code);
        },
      }
    : {
        exit: (code: number): never => {
          throw new CliExit(code);
        },
      };
  const originalExit = process.exit;
  if (!streams) {
    process.exit = ((code?: string | number | null | undefined): never => {
      throw new CliExit(typeof code === "number" ? code : 0);
    }) as typeof process.exit;
  }
  try {
    if (subcommand === "snapshot" || subcommand === "snap") {
      await runSnapshot(rest, runtime);
    } else if (subcommand === "act") {
      await runAct(rest, runtime);
    } else if (subcommand === "devices") {
      await runDevices(rest, runtime);
    } else if (subcommand === "doctor") {
      await runDoctor(rest, runtime);
    } else if (subcommand === "verify") {
      await runVerify(rest, runtime);
    } else if (subcommand === "mcp") {
      try {
        await runMcp(rest);
      } catch (err) {
        process.stderr.write(`brna: ${(err as Error).message}\n`);
        return 4;
      }
    } else if (subcommand === "config") {
      await runConfig(rest);
    } else if (subcommand === "trace") {
      await runTrace(rest);
    } else if (subcommand === "wait") {
      await runWait(rest, runtime);
    } else if (subcommand === "capture") {
      await runCapture(rest, runtime);
    } else if (subcommand === "logs") {
      await runLogs(rest, runtime);
    } else if (subcommand === "network") {
      await runNetwork(rest, runtime);
    } else {
      process.stderr.write(formatUnknownSubcommand(subcommand));
      return 4;
    }
    return 0;
  } catch (err) {
    if (err instanceof CliExit) return err.code;
    throw err;
  } finally {
    if (!streams) process.exit = originalExit;
  }
}

function replaceEnv(next: NodeJS.ProcessEnv): void {
  for (const key of Object.keys(process.env)) {
    delete process.env[key];
  }
  Object.assign(process.env, next);
}

function formatUnknownSubcommand(value: string): string {
  return `brna: unknown subcommand '${escapeControlCharacters(value)}'\n`;
}

function formatDuration(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remaining = seconds % 60;
  return `${minutes}m${remaining}s`;
}

function phaseFromExit(code: number): "parse" | "connect" | "resolve" | "dispatch" | "internal" {
  if (code === 4) return "parse";
  if (code === 1) return "connect";
  if (code === 2 || code === 3) return "resolve";
  if (code === 5) return "dispatch";
  return "internal";
}

if (import.meta.main) {
  void runCli().then((code) => process.exit(code));
}
