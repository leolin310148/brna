import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { readFile, readdir, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildUsageExport,
  buildUsageSummary,
  cleanupUsageFiles,
  clearUsageEvents,
  disableUsage,
  enableUsage,
  getUsageStatus,
  readUsageEvents,
  resolveUsageEnablement,
  sanitizeCliInvocation,
  sanitizeMcpTool,
  startUsageOperation,
  usageStateDir,
  type UsageEvent,
} from "../src/index.js";

const roots: string[] = [];

afterEach(async () => {
  const { rm } = await import("node:fs/promises");
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "brna-local-usage-"));
  roots.push(root);
  return root;
}

describe("usage paths and enablement", () => {
  test("uses platform-conventional state paths", () => {
    expect(usageStateDir({ platform: "darwin", homeDir: "/home/leo", env: {} })).toBe("/home/leo/Library/Application Support/brna/usage");
    expect(usageStateDir({ platform: "linux", homeDir: "/home/leo", env: {} })).toBe("/home/leo/.local/state/brna/usage");
    expect(usageStateDir({ platform: "linux", homeDir: "/home/leo", env: { XDG_STATE_HOME: "/state" } })).toBe("/state/brna/usage");
    expect(usageStateDir({ platform: "win32", homeDir: "C:\\Users\\leo", env: { LOCALAPPDATA: "D:\\Local" } })).toContain("D:\\Local");
  });

  test("honors DNT, explicit environment, settings, CI, and default precedence", async () => {
    const stateDir = tempRoot();
    expect(await resolveUsageEnablement({ stateDir, env: {} })).toEqual({ enabled: true, reason: "default" });
    expect(await resolveUsageEnablement({ stateDir, env: { CI: "1" } })).toEqual({ enabled: false, reason: "ci" });
    expect(await resolveUsageEnablement({ stateDir, env: { CI: "1", BRNA_USAGE_LOG: "1" } })).toEqual({ enabled: true, reason: "environment" });
    expect(await resolveUsageEnablement({ stateDir, env: { BRNA_USAGE_LOG: "1", DO_NOT_TRACK: "1" } })).toEqual({ enabled: false, reason: "do_not_track" });
    await disableUsage({ stateDir });
    expect(await resolveUsageEnablement({ stateDir, env: {} })).toEqual({ enabled: false, reason: "setting" });
    expect(await resolveUsageEnablement({ stateDir, env: { BRNA_USAGE_LOG: "1" } })).toEqual({ enabled: true, reason: "environment" });
  });
});

describe("sanitization and storage", () => {
  test("CLI and MCP sanitizers never retain sensitive values", () => {
    const secret = "super-secret-password";
    const selector = "input:PersonalEmail";
    const cli = sanitizeCliInvocation(["act", "type", selector, secret, "--at", "2"]);
    const mcp = sanitizeMcpTool("type", { selector, text: secret, at: 2 });
    expect(JSON.stringify(cli)).not.toContain(secret);
    expect(JSON.stringify(cli)).not.toContain(selector);
    expect(JSON.stringify(mcp)).not.toContain(secret);
    expect(JSON.stringify(mcp)).not.toContain(selector);
    expect(cli).toEqual({ operation: "act.type", dimensions: { verify_change: false, at_supplied: true } });
    expect(mcp).toEqual({ operation: "act.type", dimensions: { at_supplied: true } });
    expect(sanitizeCliInvocation(["private-command-token"])).toEqual({ operation: "cli.unknown" });
  });

  test("writes correlated pseudonymous lifecycle records with restrictive modes", async () => {
    const stateDir = tempRoot();
    const operation = await startUsageOperation({
      stateDir,
      env: { BRNA_USAGE_LOG: "1", BRNA_CALLER: "codex-cli" },
      cwd: "/private/customer-project",
      sessionId: "secret-agent-session",
      surface: "cli",
      operation: "snapshot",
      brnaVersion: "0.1.3",
      dimensions: { diff: true, unsafe_path: "/private/customer-project" },
    });
    await operation.finishError({
      exitCode: 3,
      errorCode: "selector.ambiguous",
      phase: "resolve",
      metrics: { match_count: 2, unsafe_message: "private" },
    });
    const events = await readUsageEvents({ stateDir });
    expect(events).toHaveLength(2);
    expect(events[0]!.operation_id).toBe(events[1]!.operation_id);
    expect(events[0]!.project_id).not.toContain("customer-project");
    expect(events[0]!.session_id).not.toContain("secret-agent-session");
    expect(events[0]!.caller).toBe("codex");
    expect(events[0]!.dimensions).toEqual({ diff: true });
    expect(events[1]!.event === "operation.finished" && events[1]!.metrics).toEqual({ match_count: 2 });
    const files = await readdir(stateDir);
    const eventFile = files.find((name) => name.endsWith(".jsonl"))!;
    const raw = await readFile(join(stateDir, eventFile), "utf8");
    expect(raw).not.toContain("customer-project");
    expect(raw).not.toContain("secret-agent-session");
    expect(raw).not.toContain("unsafe_path");
    if (process.platform !== "win32") {
      expect((await stat(stateDir)).mode & 0o777).toBe(0o700);
      expect((await stat(join(stateDir, eventFile))).mode & 0o777).toBe(0o600);
    }
  });

  test("skips malformed JSONL and clears events without changing settings", async () => {
    const stateDir = tempRoot();
    await disableUsage({ stateDir });
    await writeFile(join(stateDir, "events-2026-07-10.jsonl"), `${JSON.stringify(event("operation.started", "one", "snapshot"))}\n{truncated`, "utf8");
    expect(await readUsageEvents({ stateDir })).toHaveLength(1);
    expect(await clearUsageEvents({ stateDir })).toBe(1);
    expect((await getUsageStatus({ stateDir, env: {} })).enabled).toBe(false);
  });

  test("cleanup removes expired and oldest oversized event files", async () => {
    const stateDir = tempRoot();
    await writeFile(join(stateDir, "events-2026-05-01.jsonl"), "old\n", "utf8");
    await writeFile(join(stateDir, "events-2026-07-08.jsonl"), "1234567890\n", "utf8");
    await writeFile(join(stateDir, "events-2026-07-09.jsonl"), "abcdefghij\n", "utf8");
    await writeFile(join(stateDir, "events-2026-07-10.jsonl"), "active\n", "utf8");
    await utimes(join(stateDir, "events-2026-05-01.jsonl"), new Date("2026-05-01"), new Date("2026-05-01"));
    await utimes(join(stateDir, "events-2026-07-08.jsonl"), new Date("2026-07-08"), new Date("2026-07-08"));
    await cleanupUsageFiles({ stateDir, now: () => new Date("2026-07-10T12:00:00Z"), retentionDays: 30, maxBytes: 15 });
    const files = await readdir(stateDir);
    expect(files).not.toContain("events-2026-05-01.jsonl");
    expect(files).not.toContain("events-2026-07-08.jsonl");
    expect(files).not.toContain("events-2026-07-09.jsonl");
    expect(files).toContain("events-2026-07-10.jsonl");
  });
});

describe("summary and export", () => {
  test("reports operations, errors, interruptions, percentiles, and recovery transitions", () => {
    const events: UsageEvent[] = [
      event("operation.started", "a", "snapshot", "2026-07-10T10:00:00Z"),
      finish("a", "snapshot", "error", 100, "runtime.timeout", "2026-07-10T10:00:01Z"),
      event("operation.started", "b", "doctor", "2026-07-10T10:00:02Z"),
      finish("b", "doctor", "success", 200, undefined, "2026-07-10T10:00:03Z"),
      event("operation.started", "c", "snapshot", "2026-07-10T10:00:04Z"),
    ];
    const summary = buildUsageSummary(events, new Date("2026-07-10T00:00:00Z"), new Date("2026-07-11T00:00:00Z"));
    expect(summary.totals).toEqual({ started: 3, success: 1, error: 1, interrupted: 1, success_rate: 0.5 });
    expect(summary.operations.find((item) => item.operation === "snapshot")).toMatchObject({ started: 2, error: 1, interrupted: 1, duration_ms: { p50: 100, p95: 100 } });
    expect(summary.errors).toEqual([{ code: "runtime.timeout", count: 1 }]);
    expect(summary.recoveries).toEqual([{ from_error: "runtime.timeout", to_operation: "doctor", count: 1 }]);
  });

  test("aggregate export excludes raw identifiers and event timestamps", async () => {
    const stateDir = tempRoot();
    await writeFile(join(stateDir, "events-2026-07-10.jsonl"), [
      JSON.stringify(event("operation.started", "sensitive-operation-id", "snapshot")),
      JSON.stringify(finish("sensitive-operation-id", "snapshot", "success", 42)),
    ].join("\n") + "\n", "utf8");
    const report = await buildUsageExport({ stateDir, since: new Date("2026-07-01"), now: () => new Date("2026-07-11") });
    const raw = JSON.stringify(report);
    expect(report.schema).toBe("brna-usage-export/1");
    expect(raw).not.toContain("sensitive-operation-id");
    expect(raw).not.toContain("installation-test");
    expect(raw).not.toContain("session-test");
    expect(report.summary.totals.success).toBe(1);
  });
});

function event(kind: "operation.started", operationId: string, operation: string, timestamp = "2026-07-10T10:00:00Z"): UsageEvent {
  return {
    schema: "brna-usage/1",
    event: kind,
    timestamp,
    installation_id: "installation-test",
    project_id: "project-test",
    session_id: "session-test",
    operation_id: operationId,
    surface: "cli",
    caller: "unknown",
    operation,
    brna_version: "0.1.3",
    platform: "linux",
    arch: "arm64",
  };
}

function finish(operationId: string, operation: string, outcome: "success" | "error", duration: number, errorCode?: string, timestamp = "2026-07-10T10:00:01Z"): UsageEvent {
  return {
    ...event("operation.started", operationId, operation, timestamp),
    event: "operation.finished",
    outcome,
    duration_ms: duration,
    ...(errorCode ? { error_code: errorCode } : {}),
  };
}
