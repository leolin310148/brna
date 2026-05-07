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
  options: { status?: number; body?: unknown } = {},
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

  test("--method forwards uppercase method to body", async () => {
    const res = await run(["--method", "post"], { body: { records: [] } });
    expect(res.requestInit?.method).toBe("POST");
    const body = JSON.parse(String(res.requestInit?.body)) as { method?: string };
    expect(body.method).toBe("POST");
  });

  test("--since rejects negative values", async () => {
    const res = runCli(["network", "--since", "-1"]);
    expect(res.status).toBe(4);
    expect(res.stderr).toContain("'--since' must be a non-negative number");
    expect(res.stdout).toBe("");
  });

  test("--status code forwards as status", async () => {
    const res = await run(["--status", "404"], { body: { records: [] } });
    const body = JSON.parse(String(res.requestInit?.body)) as { status?: number };
    expect(body.status).toBe(404);
  });

  test("--status range forwards as statusMin/statusMax", async () => {
    const res = await run(["--status", "4xx"], { body: { records: [] } });
    const body = JSON.parse(String(res.requestInit?.body)) as {
      statusMin?: number;
      statusMax?: number;
    };
    expect(body.statusMin).toBe(400);
    expect(body.statusMax).toBe(499);
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

  test("--device sets device header", async () => {
    const res = await run(["--device", "android-1"], { body: { records: [] } });
    expect((res.requestInit?.headers as Record<string, string>)["x-brna-device-id"]).toBe("android-1");
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
  });
});
