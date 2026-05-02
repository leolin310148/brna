import { describe, expect, test } from "bun:test";
import { SCHEMA_VERSION, type Snapshot } from "@brna/schema";
import { toMarkdown } from "@brna/core";
import { normalizeMarkdown, runVerify, unifiedDiff } from "../src/verify.js";

function makeSnapshot(over: Partial<Snapshot> = {}): Snapshot {
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
    tree: { id: "root", kind: "screen" },
    ...over,
  };
}

interface Capture {
  code: number;
  stdout: string;
  stderr: string;
}

async function run(rest: string[], opts: {
  golden: string;
  fresh: Snapshot;
}): Promise<Capture> {
  let stdout = "";
  let stderr = "";
  try {
    await runVerify(rest, {
      readFile: async () => opts.golden,
      fetch: async () => new Response(JSON.stringify(opts.fresh), { status: 200 }),
      stdout: { write: (c: string | Uint8Array) => ((stdout += String(c)), true) },
      stderr: { write: (c: string | Uint8Array) => ((stderr += String(c)), true) },
      exit: (code) => {
        throw Object.assign(new Error("exit"), { code });
      },
    });
  } catch (err) {
    const code = (err as { code?: unknown }).code;
    if (typeof code === "number") return { code, stdout, stderr };
    throw err;
  }
  throw new Error("expected runVerify to exit");
}

describe("normalizeMarkdown", () => {
  test("strips trailing whitespace and normalizes line endings", () => {
    expect(normalizeMarkdown("a  \r\nb\r\n\r\n")).toBe("a\nb\n");
  });

  test("preserves internal blank lines", () => {
    expect(normalizeMarkdown("a\n\nb\n")).toBe("a\n\nb\n");
  });
});

describe("unifiedDiff", () => {
  test("renders header and changed lines", () => {
    const out = unifiedDiff("a\nb\nc\n", "a\nx\nc\n", "old.md", "new.md");
    expect(out).toContain("--- old.md");
    expect(out).toContain("+++ new.md");
    expect(out).toContain("-b");
    expect(out).toContain("+x");
  });

  test("returns empty string for identical input", () => {
    expect(unifiedDiff("a\n", "a\n", "x", "y")).toBe("");
  });
});

describe("brna verify", () => {
  test("matching golden exits 0", async () => {
    const fresh = makeSnapshot();
    const golden = toMarkdown(fresh);
    const res = await run(["golden.md"], { golden, fresh });
    expect(res.code).toBe(0);
    expect(res.stdout).toContain("Verification passed");
  });

  test("mismatch exits 1 and prints unified diff", async () => {
    const fresh = makeSnapshot({ tree: { id: "root", kind: "screen", name: "Home" } });
    const golden = toMarkdown(makeSnapshot());
    const res = await run(["golden.md"], { golden, fresh });
    expect(res.code).toBe(1);
    expect(res.stdout).toContain("--- golden.md");
    expect(res.stdout).toContain("+++ current");
    expect(res.stderr).toContain("Verification failed");
  });

  // Missing-path arg parse failures are covered by CLI subprocess paths, not
  // here — parseArgs uses process.exit directly and would tear down the test
  // runner.
});
