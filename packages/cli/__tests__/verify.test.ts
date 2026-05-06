import { describe, expect, test } from "bun:test";
import { SCHEMA_VERSION, type Snapshot } from "@brna/schema";
import { toActiveLayerMarkdown, toJSON, toMarkdown } from "@brna/core";
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
  fetch?: typeof fetch;
}): Promise<Capture> {
  let stdout = "";
  let stderr = "";
  try {
    await runVerify(rest, {
      readFile: async () => opts.golden,
      fetch: opts.fetch ?? (async () => new Response(JSON.stringify(opts.fresh), { status: 200 })),
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

  test("normalizes volatile snapshot session header metadata", () => {
    const a = "# Snapshot · screen:root · android\nsession: abc12345... · 2026-05-05T07:18:35.082Z\n\n## screen\n";
    const b = "# Snapshot · screen:root · android\nsession: def67890... · 2026-05-05T07:19:32.447Z\n\n## screen\n";
    expect(normalizeMarkdown(a)).toBe(normalizeMarkdown(b));
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

  test("timestamp-only markdown header changes pass", async () => {
    const fresh = makeSnapshot({
      meta: {
        ...makeSnapshot().meta,
        captured_at: "2026-05-01T12:01:00.000Z",
        session_id: "fresh-session-id",
      },
    });
    const golden = toMarkdown(makeSnapshot());
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

  test("--active-layer compares the active-layer projection", async () => {
    const fresh = makeSnapshot({
      tree: {
        id: "root",
        kind: "screen",
        children: [
          { id: "background", kind: "button", name: "Background" },
          { id: "checkout-modal", kind: "group", children: [{ id: "ok", kind: "button", name: "OK" }] },
        ],
      },
    });
    const golden = toActiveLayerMarkdown(fresh);
    const res = await run(["golden.md", "--active-layer"], { golden, fresh });
    expect(res.code).toBe(0);
    expect(res.stdout).toContain("Verification passed");
  });

  test("json golden exits 0 when only volatile snapshot metadata changed", async () => {
    const fresh = makeSnapshot({
      meta: {
        ...makeSnapshot().meta,
        captured_at: "2026-05-01T12:01:00.000Z",
        session_id: "fresh-session-id",
        snapshot_id: "fresh-snapshot-id",
      },
    });
    const golden = toJSON(makeSnapshot());
    const res = await run(["golden.json"], { golden, fresh });
    expect(res.code).toBe(0);
    expect(res.stdout).toContain("Verification passed");
  });

  test("json golden mismatch exits 1 and prints unified json diff", async () => {
    const fresh = makeSnapshot({ tree: { id: "root", kind: "screen", name: "Home" } });
    const golden = toJSON(makeSnapshot());
    const res = await run(["golden.json"], { golden, fresh });
    expect(res.code).toBe(1);
    expect(res.stdout).toContain("--- golden.json");
    expect(res.stdout).toContain("+++ current");
    expect(res.stdout).toContain('"name": "Home"');
    expect(res.stderr).toContain("Verification failed");
  });

  test("invalid json golden exits 4 with a parse error", async () => {
    const res = await run(["golden.json"], {
      golden: "{",
      fresh: makeSnapshot(),
      fetch: async () => {
        throw new Error("should not fetch");
      },
    });
    expect(res.code).toBe(4);
    expect(res.stderr).toContain("invalid JSON golden 'golden.json'");
  });

  test("--active-layer with json golden exits 4 before fetching", async () => {
    const res = await run(["golden.json", "--active-layer"], {
      golden: toJSON(makeSnapshot()),
      fresh: makeSnapshot(),
      fetch: async () => {
        throw new Error("should not fetch");
      },
    });
    expect(res.code).toBe(4);
    expect(res.stderr).toContain("--active-layer is only supported for markdown golden files");
  });

  // Missing-path arg parse failures are covered by CLI subprocess paths, not
  // here — parseArgs uses process.exit directly and would tear down the test
  // runner.
});
