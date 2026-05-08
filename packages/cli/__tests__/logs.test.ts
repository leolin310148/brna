import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { runLogs, formatLogsTable } from "../src/logs.js";
import type { LogRecord } from "@brna/schema";

const CLI_PATH = resolve(import.meta.dir, "../src/cli.ts");

function runCli(args: string[]) {
  return spawnSync("bun", ["run", CLI_PATH, ...args], {
    env: { ...process.env, NO_COLOR: "1" },
    encoding: "utf8",
    timeout: 5000,
  });
}

interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
  requestUrl?: string;
  requestInit?: RequestInit;
}

async function run(
  rest: string[],
  options: {
    status?: number;
    body?: unknown;
    response?: Response;
  } = {},
): Promise<RunResult> {
  let stdout = "";
  let stderr = "";
  let requestUrl: string | undefined;
  let requestInit: RequestInit | undefined;
  try {
    await runLogs(rest, {
      fetch: (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
        requestUrl = typeof input === "string" ? input : input.toString();
        requestInit = init;
        if (options.response) return options.response;
        const status = options.status ?? 200;
        if (status >= 400) {
          return new Response(JSON.stringify(options.body ?? {}), { status });
        }
        return new Response(
          JSON.stringify(options.body ?? { records: [] }),
          { status, headers: { "content-type": "application/json" } },
        );
      }) as unknown as typeof fetch,
      stdout: { write: (c: string | Uint8Array) => ((stdout += String(c)), true) },
      stderr: { write: (c: string | Uint8Array) => ((stderr += String(c)), true) },
      exit: (code) => {
        throw Object.assign(new Error("exit"), { code });
      },
    });
  } catch (err) {
    const code = (err as { code?: unknown }).code;
    if (typeof code === "number") {
      const result: RunResult = { code, stdout, stderr };
      if (requestUrl !== undefined) result.requestUrl = requestUrl;
      if (requestInit !== undefined) result.requestInit = requestInit;
      return result;
    }
    throw err;
  }
  throw new Error("expected runLogs to exit");
}

const sampleRecords: LogRecord[] = [
  { id: "log-1", timestamp: 1700000000000, level: "warn", message: "slow query" },
  { id: "log-2", timestamp: 1700000001000, level: "error", message: "boom" },
];

describe("brna logs", () => {
  test("table output includes level and message", async () => {
    const res = await run([], { body: { records: sampleRecords } });
    expect(res.code).toBe(0);
    expect(res.stdout).toContain("warn");
    expect(res.stdout).toContain("slow query");
    expect(res.stdout).toContain("error");
    expect(res.stdout).toContain("boom");
  });

  test("--json prints JSON document", async () => {
    const res = await run(["--json"], { body: { records: sampleRecords } });
    expect(res.code).toBe(0);
    const parsed = JSON.parse(res.stdout) as { records: LogRecord[] };
    expect(parsed.records).toHaveLength(2);
    expect(parsed.records[0]!.message).toBe("slow query");
  });

  test("empty records prints helper text", async () => {
    const res = await run([], { body: { records: [] } });
    expect(res.code).toBe(0);
    expect(res.stdout).toContain("No log records captured");
  });

  test("--since adds since to POST body", async () => {
    const res = await run(["--since", "5000"], { body: { records: [] } });
    expect(res.code).toBe(0);
    expect(res.requestInit?.method).toBe("POST");
    const body = JSON.parse(String(res.requestInit?.body)) as { since?: number };
    expect(typeof body.since).toBe("number");
    expect(body.since!).toBeLessThanOrEqual(Date.now());
  });

  test("--since rejects negative values", async () => {
    const res = runCli(["logs", "--since", "-1"]);
    expect(res.status).toBe(4);
    expect(res.stderr).toContain("'--since' must be a non-negative number");
    expect(res.stdout).toBe("");
  });

  test("--since rejects whitespace-only values", async () => {
    const res = runCli(["logs", "--since", "   "]);
    expect(res.status).toBe(4);
    expect(res.stderr).toContain("missing value for '--since'");
    expect(res.stdout).toBe("");
  });

  test("--level forwards the level filter", async () => {
    const res = await run(["--level", " warn "], { body: { records: [] } });
    const body = JSON.parse(String(res.requestInit?.body)) as { level?: string };
    expect(body.level).toBe("warn");
  });

  test("--level accepts uppercase input", async () => {
    const res = await run(["--level", " WARN "], { body: { records: [] } });
    const body = JSON.parse(String(res.requestInit?.body)) as { level?: string };
    expect(body.level).toBe("warn");
  });

  test("--level rejects whitespace-only values as missing", async () => {
    const res = runCli(["logs", "--level", "   "]);
    expect(res.status).toBe(4);
    expect(res.stderr).toContain("missing value for '--level'");
    expect(res.stdout).toBe("");
  });

  test("--limit rejects fractional values", async () => {
    const res = runCli(["logs", "--limit", "1.5"]);
    expect(res.status).toBe(4);
    expect(res.stderr).toContain("'--limit' must be a positive integer");
    expect(res.stdout).toBe("");
  });

  test("--limit rejects whitespace-only values as missing", async () => {
    const res = runCli(["logs", "--limit", "   "]);
    expect(res.status).toBe(4);
    expect(res.stderr).toContain("missing value for '--limit'");
    expect(res.stdout).toBe("");
  });

  test("config forwards observability redaction defaults", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "brna-logs-config-"));
    const prior = process.cwd();
    try {
      writeFileSync(join(cwd, "brna.config.ts"), "export default { redactSecureFields: false };\n");
      process.chdir(cwd);
      const res = await run([], { body: { records: [] } });
      expect(res.requestInit?.method).toBe("POST");
      const body = JSON.parse(String(res.requestInit?.body)) as {
        redaction?: { redactSensitiveDefaults?: boolean };
      };
      expect(body.redaction?.redactSensitiveDefaults).toBe(false);
    } finally {
      process.chdir(prior);
      await rm(cwd, { recursive: true, force: true });
    }
  });

  test("503 produces no_runtime helper message", async () => {
    const res = await run([], { status: 503 });
    expect(res.code).toBe(3);
    expect(res.stderr).toContain("no runtime connected");
  });

  test("HTML success responses explain that Metro middleware is missing", async () => {
    const res = await run([], {
      response: new Response("<!doctype html><html><body>Metro</body></html>", {
        status: 200,
        headers: { "content-type": "text/html" },
      }),
    });
    expect(res.code).toBe(3);
    expect(res.stderr).toContain("brna Metro middleware is not mounted");
  });

  test("HTML 404 responses explain that Metro middleware is missing", async () => {
    const res = await run([], {
      response: new Response("<!doctype html><html><body>Metro</body></html>", {
        status: 404,
        headers: { "content-type": "text/html" },
      }),
    });
    expect(res.code).toBe(3);
    expect(res.stderr).toContain("brna Metro middleware is not mounted");
  });

  test("--device sets device header", async () => {
    const res = await run(["--device", "ios-sim"], { body: { records: [] } });
    expect((res.requestInit?.headers as Record<string, string>)["x-brna-device-id"]).toBe("ios-sim");
  });

  test("404 unknown device returns exit 3", async () => {
    const res = await run(["--device", "nope"], { status: 404 });
    expect(res.code).toBe(3);
    expect(res.stderr).toContain("nope");
  });
});

describe("formatLogsTable", () => {
  test("renders ISO timestamps", () => {
    const out = formatLogsTable(sampleRecords);
    expect(out).toContain("2023-11-14T22:13:20.000Z");
    expect(out).toContain("warn");
    expect(out).toContain("slow query");
  });

  test("renders invalid timestamps without throwing", () => {
    const out = formatLogsTable([
      { id: "log-bad", timestamp: Number.NaN, level: "error", message: "bad timestamp" },
    ]);

    expect(out).toContain("invalid");
    expect(out).toContain("bad timestamp");
  });
});
