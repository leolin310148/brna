import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { runNetwork, formatNetworkTable } from "../src/network.js";
import type { NetworkRecord } from "@brna/schema";

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
  options: { status?: number; body?: unknown; response?: Response } = {},
): Promise<RunResult> {
  let stdout = "";
  let stderr = "";
  let requestUrl: string | undefined;
  let requestInit: RequestInit | undefined;
  try {
    await runNetwork(rest, {
      fetch: (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
        requestUrl = typeof input === "string" ? input : input.toString();
        requestInit = init;
        if (options.response) return options.response;
        const status = options.status ?? 200;
        if (status >= 400) {
          return new Response(JSON.stringify(options.body ?? {}), { status });
        }
        return new Response(JSON.stringify(options.body ?? { records: [] }), { status });
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
  throw new Error("expected runNetwork to exit");
}

const sampleRecords: NetworkRecord[] = [
  {
    id: "net-1",
    timestamp: 1700000000000,
    method: "POST",
    url: "https://api.test/orders",
    state: "completed",
    source: "fetch",
    status: 201,
    duration_ms: 120,
  },
  {
    id: "net-2",
    timestamp: 1700000005000,
    method: "GET",
    url: "https://api.test/orders/1",
    state: "completed",
    source: "fetch",
    status: 200,
    duration_ms: 40,
  },
];

describe("brna network", () => {
  test("table output includes method, url, status, duration", async () => {
    const res = await run([], { body: { records: sampleRecords } });
    expect(res.code).toBe(0);
    expect(res.stdout).toContain("POST");
    expect(res.stdout).toContain("https://api.test/orders");
    expect(res.stdout).toContain("201");
    expect(res.stdout).toContain("120");
  });

  test("--json emits records JSON", async () => {
    const res = await run(["--json"], { body: { records: sampleRecords } });
    expect(res.code).toBe(0);
    const parsed = JSON.parse(res.stdout) as { records: NetworkRecord[] };
    expect(parsed.records).toHaveLength(2);
    expect(parsed.records[0]!.method).toBe("POST");
  });

  test("empty records prints helper text", async () => {
    const res = await run([], { body: { records: [] } });
    expect(res.code).toBe(0);
    expect(res.stdout).toContain("No network records captured");
  });

  test("malformed records payload exits with a protocol diagnostic", async () => {
    const missingArray = await run([], { body: { records: "not-an-array" } });
    expect(missingArray.code).toBe(3);
    expect(missingArray.stderr).toContain("malformed network response");

    const invalidRecord = await run([], { body: { records: [{ id: "net-1", url: "https://api.test" }] } });
    expect(invalidRecord.code).toBe(3);
    expect(invalidRecord.stderr).toContain("records must be an array of network records");
  });

  test("--method forwards uppercase method to body", async () => {
    const res = await run(["--method", " post "], { body: { records: [] } });
    expect(res.requestInit?.method).toBe("POST");
    const body = JSON.parse(String(res.requestInit?.body)) as { method?: string };
    expect(body.method).toBe("POST");
  });

  test("--method rejects whitespace-only values", () => {
    const res = runCli(["network", "--method", "   "]);
    expect(res.status).toBe(4);
    expect(res.stderr).toContain("missing value for '--method'");
    expect(res.stdout).toBe("");
  });

  test("--method rejects malformed HTTP method tokens", () => {
    const res = runCli(["network", "--method", "GET POST"]);
    expect(res.status).toBe(4);
    expect(res.stderr).toContain("'--method' must be an HTTP method token");
    expect(res.stdout).toBe("");
  });

  test("--method diagnostics escape terminal control characters", () => {
    const res = runCli(["network", "--method", "GET\x1b[31m"]);
    expect(res.status).toBe(4);
    expect(res.stderr).toContain("GET\\x1b[31m");
    expect(res.stderr).not.toContain("\x1b");
    expect(res.stdout).toBe("");
  });

  test("unknown flag diagnostics escape terminal control characters", () => {
    const res = runCli(["network", "--bogus\x1b[31m"]);
    expect(res.status).toBe(4);
    expect(res.stderr).toContain("--bogus\\x1b[31m");
    expect(res.stderr).not.toContain("\x1b");
    expect(res.stdout).toBe("");
  });

  test("--since rejects negative values", async () => {
    const res = runCli(["network", "--since", "-1"]);
    expect(res.status).toBe(4);
    expect(res.stderr).toContain("'--since' must be a non-negative number");
    expect(res.stdout).toBe("");
  });

  test("--status code forwards as status", async () => {
    const res = await run(["--status", " 404 "], { body: { records: [] } });
    const body = JSON.parse(String(res.requestInit?.body)) as { status?: number };
    expect(body.status).toBe(404);
  });

  test("--status range forwards as statusMin/statusMax", async () => {
    const res = await run(["--status", " 4xx "], { body: { records: [] } });
    const body = JSON.parse(String(res.requestInit?.body)) as {
      statusMin?: number;
      statusMax?: number;
    };
    expect(body.statusMin).toBe(400);
    expect(body.statusMax).toBe(499);
  });

  test("--status range accepts spaces around dash", async () => {
    const res = await run(["--status", " 200 - 299 "], { body: { records: [] } });
    const body = JSON.parse(String(res.requestInit?.body)) as {
      statusMin?: number;
      statusMax?: number;
    };
    expect(body.statusMin).toBe(200);
    expect(body.statusMax).toBe(299);
  });

  test("repeated --status uses the last filter", async () => {
    const res = await run(["--status", "404", "--status", "5xx"], { body: { records: [] } });
    const body = JSON.parse(String(res.requestInit?.body)) as {
      status?: number;
      statusMin?: number;
      statusMax?: number;
    };
    expect(body.status).toBeUndefined();
    expect(body.statusMin).toBe(500);
    expect(body.statusMax).toBe(599);
  });

  test("--status rejects values outside HTTP status range", async () => {
    const tooLow = runCli(["network", "--status", "99"]);
    expect(tooLow.status).toBe(4);
    expect(tooLow.stderr).toContain("HTTP status code from 100 to 599");
    expect(tooLow.stdout).toBe("");

    const tooHighRange = runCli(["network", "--status", "500-700"]);
    expect(tooHighRange.status).toBe(4);
    expect(tooHighRange.stderr).toContain("'--status' must be a code or range");
    expect(tooHighRange.stdout).toBe("");
  });

  test("--status range rejects non-decimal numeric syntax", () => {
    const exponentRange = runCli(["network", "--status", "2e2-299"]);
    expect(exponentRange.status).toBe(4);
    expect(exponentRange.stderr).toContain("'--status' must be a code or range");
    expect(exponentRange.stdout).toBe("");

    const hexRange = runCli(["network", "--status", "0xC8-299"]);
    expect(hexRange.status).toBe(4);
    expect(hexRange.stderr).toContain("'--status' must be a code or range");
    expect(hexRange.stdout).toBe("");
  });

  test("--status rejects whitespace-only values", () => {
    const res = runCli(["network", "--status", "   "]);
    expect(res.status).toBe(4);
    expect(res.stderr).toContain("missing value for '--status'");
    expect(res.stdout).toBe("");
  });

  test("--limit rejects fractional values", async () => {
    const res = runCli(["network", "--limit", "2.5"]);
    expect(res.status).toBe(4);
    expect(res.stderr).toContain("'--limit' must be a positive integer");
    expect(res.stdout).toBe("");
  });

  test("config forwards observability redaction defaults", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "brna-network-config-"));
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

  test("503 prints no-runtime message and exits 3", async () => {
    const res = await run([], { status: 503 });
    expect(res.code).toBe(3);
    expect(res.stderr).toContain("no runtime connected");
  });

  test("runtime error diagnostics escape terminal control characters", async () => {
    const res = await run([], {
      status: 502,
      body: { code: "E_RUNTIME\x1b[31m", message: "Failed\u202e" },
    });

    expect(res.code).toBe(3);
    expect(res.stderr).toContain("E_RUNTIME\\x1b[31m");
    expect(res.stderr).toContain("Failed\\u202e");
    expect(res.stderr).not.toContain("\x1b");
    expect(res.stderr).not.toContain("\u202e");
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
    expect(res.stderr).not.toContain("unknown device");
  });

  test("404 without device reports endpoint diagnostic", async () => {
    const res = await run([], {
      status: 404,
      body: { error: "not_found" },
    });
    expect(res.code).toBe(3);
    expect(res.stderr).toContain("network endpoint returned HTTP 404: not_found");
    expect(res.stderr).not.toContain("unknown device");
  });

  test("--device sets device header", async () => {
    const res = await run(["--device", "android-1"], { body: { records: [] } });
    expect((res.requestInit?.headers as Record<string, string>)["x-brna-device-id"]).toBe("android-1");
  });

  test("404 unknown device diagnostics escape terminal control characters", async () => {
    const res = await run(["--device", "bad\x1b[31m"], { status: 404 });
    expect(res.code).toBe(3);
    expect(res.stderr).toContain("bad\\x1b[31m");
    expect(res.stderr).not.toContain("\x1b");
  });
});

describe("formatNetworkTable", () => {
  test("aligns columns and shows ERR for errored requests without status", () => {
    const out = formatNetworkTable([
      ...sampleRecords,
      {
        id: "net-3",
        timestamp: 1700000010000,
        method: "GET",
        url: "https://api.test/dead",
        state: "errored",
        source: "fetch",
        error_message: "ENOTFOUND",
      },
    ]);
    expect(out).toContain("ERR");
    expect(out).toContain("https://api.test/dead");
    expect(out).toContain("ERROR");
    expect(out).toContain("ENOTFOUND");
  });

  test("renders invalid timestamps without throwing", () => {
    const out = formatNetworkTable([
      {
        id: "net-bad",
        timestamp: Number.NaN,
        method: "GET",
        url: "https://api.test/bad-time",
        state: "completed",
        source: "fetch",
        status: 200,
      },
    ]);

    expect(out).toContain("invalid");
    expect(out).toContain("https://api.test/bad-time");
  });

  test("keeps multiline URLs on one output row", () => {
    const out = formatNetworkTable([
      {
        id: "net-multiline",
        timestamp: 1700000000000,
        method: "GET",
        url: "https://api.test/search?q=first\nsecond\rthird",
        state: "completed",
        source: "fetch",
        status: 200,
      },
    ]);

    expect(out).toContain("first\\nsecond\\rthird");
    expect(out.trimEnd().split("\n")).toHaveLength(2);
  });

  test("escapes terminal control characters in URLs", () => {
    const out = formatNetworkTable([
      {
        id: "net-control",
        timestamp: 1700000000000,
        method: "GET",
        url: "https://api.test/\x1b[31mred\x1b[0m",
        state: "completed",
        source: "fetch",
        status: 200,
      },
    ]);

    expect(out).toContain("https://api.test/\\x1b[31mred\\x1b[0m");
    expect(out).not.toContain("\x1b");
  });

  test("escapes unicode bidi controls in URLs", () => {
    const out = formatNetworkTable([
      {
        id: "net-bidi",
        timestamp: 1700000000000,
        method: "GET",
        url: "https://api.test/\u202eevil",
        state: "completed",
        source: "fetch",
        status: 200,
      },
    ]);

    expect(out).toContain("https://api.test/\\u202eevil");
    expect(out).not.toContain("\u202e");
  });

  test("escapes terminal control characters in methods", () => {
    const out = formatNetworkTable([
      {
        id: "net-method-control",
        timestamp: 1700000000000,
        method: "GET\x1b[31m",
        url: "https://api.test/orders",
        state: "completed",
        source: "fetch",
        status: 200,
      },
    ]);

    expect(out).toContain("GET\\x1b[31m");
    expect(out).not.toContain("\x1b");
  });

  test("escapes terminal control characters in error messages", () => {
    const out = formatNetworkTable([
      {
        id: "net-error-control",
        timestamp: 1700000000000,
        method: "GET",
        url: "https://api.test/orders",
        state: "errored",
        source: "fetch",
        error_message: "boom\x1b[31m\u202e",
      },
    ]);

    expect(out).toContain("boom\\x1b[31m\\u202e");
    expect(out).not.toContain("\x1b");
    expect(out).not.toContain("\u202e");
  });
});
