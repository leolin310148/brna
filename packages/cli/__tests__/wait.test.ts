import { describe, expect, test } from "bun:test";
import { SCHEMA_VERSION, type Snapshot } from "@brna/schema";
import { runWait } from "../src/wait.js";

interface Capture {
  code: number;
  stdout: string;
  stderr: string;
  fetchCount: number;
  fetchUrls: string[];
}

function makeSnapshot(over: { children?: Snapshot["tree"]["children"] } = {}): Snapshot {
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
    tree: { id: "root", kind: "screen", children: over.children ?? [] },
  };
}

interface RunOpts {
  responses?: Array<() => Response>;
  fetchReject?: Error;
  now?: () => number;
}

async function run(rest: string[], opts: RunOpts = {}): Promise<Capture> {
  let stdout = "";
  let stderr = "";
  let fetchCount = 0;
  const fetchUrls: string[] = [];
  const responses = opts.responses ?? [];
  let nowMs = opts.now ? opts.now() : 1_000_000;
  const advance = (ms: number) => {
    nowMs += ms;
  };
  try {
    await runWait(rest, {
      fetch: async (input) => {
        fetchCount++;
        fetchUrls.push(String(input));
        if (opts.fetchReject) throw opts.fetchReject;
        const next = responses.shift();
        if (!next) return new Response("{}", { status: 503 });
        return next();
      },
      now: () => nowMs,
      sleep: async (ms: number) => {
        advance(ms);
      },
      stdout: { write: (c: string | Uint8Array) => ((stdout += String(c)), true) },
      stderr: { write: (c: string | Uint8Array) => ((stderr += String(c)), true) },
      exit: (code: number) => {
        throw Object.assign(new Error("exit"), { code });
      },
    });
  } catch (err) {
    const code = (err as { code?: unknown }).code;
    if (typeof code === "number") return { code, stdout, stderr, fetchCount, fetchUrls };
    throw err;
  }
  throw new Error("expected runWait to exit");
}

function snapshotResponse(snap: Snapshot): () => Response {
  return () => new Response(JSON.stringify(snap), { status: 200 });
}

describe("brna wait", () => {
  test("exits 0 when selector appears in a later snapshot", async () => {
    const empty = makeSnapshot();
    const populated = makeSnapshot({
      children: [{ id: "auto:status", kind: "text", name: "Confirmed" }],
    });
    const res = await run(["text:Confirmed", "--timeout", "10000"], {
      responses: [snapshotResponse(empty), snapshotResponse(populated)],
    });
    expect(res.code).toBe(0);
    expect(res.stdout).toBe("");
    expect(res.fetchCount).toBeGreaterThanOrEqual(2);
  });

  test("exits 0 when --gone selector disappears", async () => {
    const populated = makeSnapshot({
      children: [{ id: "auto:loading", kind: "text", name: "Loading" }],
    });
    const empty = makeSnapshot();
    const res = await run(["text:Loading", "--gone", "--timeout", "10000"], {
      responses: [snapshotResponse(populated), snapshotResponse(empty)],
    });
    expect(res.code).toBe(0);
  });

  test("exits 2 when timeout elapses without satisfying condition", async () => {
    const empty = makeSnapshot();
    const responses: Array<() => Response> = [];
    for (let i = 0; i < 50; i++) responses.push(snapshotResponse(empty));
    const res = await run(["text:Confirmed", "--timeout", "1000", "--interval", "100"], { responses });
    expect(res.code).toBe(2);
    expect(res.stderr).toContain("wait timed out after 1000ms");
  });

  test("ambiguous matches do not satisfy presence wait", async () => {
    const ambiguous = makeSnapshot({
      children: [
        { id: "auto:save1", kind: "button", role: "button", name: "Save" },
        { id: "auto:save2", kind: "button", role: "button", name: "Save" },
      ],
    });
    const responses: Array<() => Response> = [];
    for (let i = 0; i < 50; i++) responses.push(snapshotResponse(ambiguous));
    const res = await run(["button:Save", "--timeout", "500", "--interval", "100"], { responses });
    expect(res.code).toBe(2);
    expect(res.stderr).toContain("wait timed out");
  });

  test("malformed selector exits 4 and never contacts Metro", async () => {
    const res = await run(["button:"]);
    expect(res.code).toBe(4);
    expect(res.stderr).toContain("malformed selector");
    expect(res.fetchCount).toBe(0);
  });

  test("missing selector exits 4 with usage", async () => {
    const res = await run([]);
    expect(res.code).toBe(4);
    expect(res.stderr).toContain("usage:");
    expect(res.fetchCount).toBe(0);
  });

  test("connection error exits 1", async () => {
    const res = await run(["text:Confirmed"], { fetchReject: new Error("ECONNREFUSED") });
    expect(res.code).toBe(1);
    expect(res.stderr).toContain("could not connect to Metro");
  });

  test("no runtime exits 3 with snapshot-style diagnostic", async () => {
    const res = await run(["text:Ready"], {
      responses: [() => new Response(JSON.stringify({ error: "no_runtime_connected" }), { status: 503 })],
    });
    expect(res.code).toBe(3);
    expect(res.stderr).toContain("no runtime connected");
  });

  test("--interval rejects values below floor", async () => {
    const res = await run(["text:X", "--interval", "5"]);
    expect(res.code).toBe(4);
    expect(res.stderr).toContain("--interval");
  });

  test("--metro accepts host:port shorthand", async () => {
    const snap = makeSnapshot({
      children: [{ id: "auto:ready", kind: "text", name: "Ready" }],
    });
    const res = await run(["text:Ready", "--metro", "localhost:19000"], {
      responses: [snapshotResponse(snap)],
    });
    expect(res.code).toBe(0);
    expect(res.fetchUrls[0]).toBe("http://localhost:19000/brna/snapshot");
  });
});
