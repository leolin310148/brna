import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { SCHEMA_VERSION, validateSnapshot, type Snapshot } from "@brna/schema";
import { diff, fromDiffJSON, fromDiffYAML, fromJSON, fromYAML } from "@brna/core";
import { projectDiff, projectSnapshot, runSnapshot } from "../src/snapshot.js";

const CLI_PATH = resolve(import.meta.dir, "../src/cli.ts");

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

async function runSnapshotInMemory(
  rest: string[],
  options: {
    fresh?: Snapshot;
    baseline?: Snapshot | null;
    fetchReject?: Error;
    fetchResponse?: Response;
    fetchResponses?: Response[];
    writeWarning?: string | null;
  } = {},
): Promise<{ code: number; stdout: string; stderr: string; writes: Snapshot[] }> {
  let stdout = "";
  let stderr = "";
  const writes: Snapshot[] = [];
  const fresh = options.fresh ?? makeSnapshot();
  try {
    await runSnapshot(rest, {
      fetch: async () => {
        if (options.fetchReject) throw options.fetchReject;
        if (options.fetchResponses && options.fetchResponses.length > 0) return options.fetchResponses.shift()!;
        if (options.fetchResponse) return options.fetchResponse;
        return new Response(JSON.stringify(fresh), { status: 200 });
      },
      readSnapshotCache: async () => options.baseline ?? null,
      writeSnapshotCache: async (snapshot) => {
        writes.push(snapshot);
        return options.writeWarning ?? null;
      },
      stdout: { write: (chunk: string | Uint8Array) => ((stdout += String(chunk)), true) },
      stderr: { write: (chunk: string | Uint8Array) => ((stderr += String(chunk)), true) },
      exit: (code) => {
        throw Object.assign(new Error("exit"), { code });
      },
    });
  } catch (err) {
    const code = (err as { code?: unknown }).code;
    if (typeof code === "number") return { code, stdout, stderr, writes };
    throw err;
  }
  throw new Error("expected runSnapshot to exit");
}

describe("CLI --format flag (subprocess, never reaches Metro)", () => {
  test("--format xml exits 4 with the expected stderr", () => {
    const result = spawnSync("bun", ["run", CLI_PATH, "snapshot", "--format", "xml"], {
      env: { ...process.env, NO_COLOR: "1" },
      encoding: "utf8",
      timeout: 5000,
    });
    expect(result.status).toBe(4);
    expect(result.stderr).toContain("unknown --format value 'xml'");
    expect(result.stderr).toContain("expected md|json|yaml");
  });

  test('--format "" exits 4', () => {
    const result = spawnSync("bun", ["run", CLI_PATH, "snapshot", "--format", ""], {
      env: { ...process.env, NO_COLOR: "1" },
      encoding: "utf8",
      timeout: 5000,
    });
    expect(result.status).toBe(4);
    expect(result.stderr).toContain("unknown --format value");
  });

  test("--format markdown alias is rejected", () => {
    const result = spawnSync("bun", ["run", CLI_PATH, "snapshot", "--format", "markdown"], {
      env: { ...process.env, NO_COLOR: "1" },
      encoding: "utf8",
      timeout: 5000,
    });
    expect(result.status).toBe(4);
  });

  test("--format JSON (case-different) is rejected", () => {
    const result = spawnSync("bun", ["run", CLI_PATH, "snapshot", "--format", "JSON"], {
      env: { ...process.env, NO_COLOR: "1" },
      encoding: "utf8",
      timeout: 5000,
    });
    expect(result.status).toBe(4);
  });
});

describe("projectSnapshot", () => {
  test("md output equals toMarkdown default", () => {
    const snap = makeSnapshot();
    const a = projectSnapshot(snap, "md");
    const b = projectSnapshot(snap, "md");
    expect(a).toBe(b);
    expect(a).toContain("# Snapshot");
  });

  test("json output passes validateSnapshot after parse", () => {
    const snap = makeSnapshot();
    const text = projectSnapshot(snap, "json");
    const parsed = fromJSON(text);
    expect(() => validateSnapshot(parsed)).not.toThrow();
  });

  test("yaml output round-trips through fromYAML and validates", () => {
    const snap = makeSnapshot();
    const text = projectSnapshot(snap, "yaml");
    const parsed = fromYAML(text);
    expect(() => validateSnapshot(parsed)).not.toThrow();
  });
});

describe("projectDiff", () => {
  test("projects markdown/json/yaml diffs", () => {
    const d = diff(makeSnapshot(), makeSnapshot({ tree: { id: "root", kind: "screen", name: "Home" } }));
    expect(projectDiff(d, "md")).toContain("~ screen#root");
    expect(fromDiffJSON(projectDiff(d, "json"))).toEqual(d);
    expect(fromDiffYAML(projectDiff(d, "yaml"))).toEqual(d);
  });
});

describe("snapshot --diff", () => {
  test("plain snapshot refreshes the baseline", async () => {
    const fresh = makeSnapshot({ tree: { id: "root", kind: "screen", name: "Home" } });
    const result = await runSnapshotInMemory([], { fresh });
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("# Snapshot");
    expect(result.stderr).toBe("");
    expect(result.writes).toEqual([fresh]);
  });

  test("markdown --diff emits diff and refreshes rolling baseline", async () => {
    const baseline = makeSnapshot();
    const fresh = makeSnapshot({ tree: { id: "root", kind: "screen", children: [{ id: "x", kind: "button", name: "X" }] } });
    const result = await runSnapshotInMemory(["--diff"], { baseline, fresh });
    expect(result.code).toBe(0);
    expect(result.stdout).toBe('+ button#x "X"\n');
    expect(result.stderr).toBe("");
    expect(result.writes).toEqual([fresh]);
  });

  test("json and yaml --diff honour format", async () => {
    const baseline = makeSnapshot();
    const fresh = makeSnapshot({ tree: { id: "root", kind: "screen", name: "Home" } });
    const expected = diff(baseline, fresh);
    const json = await runSnapshotInMemory(["--diff", "--format", "json"], { baseline, fresh });
    const yaml = await runSnapshotInMemory(["--diff", "--format", "yaml"], { baseline, fresh });
    expect(fromDiffJSON(json.stdout)).toEqual(expected);
    expect(fromDiffYAML(yaml.stdout)).toEqual(expected);
  });

  test("identical markdown --diff emits zero stdout bytes", async () => {
    const snapshot = makeSnapshot();
    const result = await runSnapshotInMemory(["--diff"], { baseline: snapshot, fresh: snapshot });
    expect(result.code).toBe(0);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe("");
    expect(result.writes).toEqual([snapshot]);
  });

  test("no baseline exits 6 and does not refresh cache", async () => {
    const result = await runSnapshotInMemory(["--diff"], { baseline: null });
    expect(result.code).toBe(6);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe("brna: no baseline snapshot in this session — run brna snapshot first\n");
    expect(result.writes).toEqual([]);
  });

  test("fetch failure keeps existing connection-error code and does not touch cache", async () => {
    const result = await runSnapshotInMemory(["--diff"], { baseline: makeSnapshot(), fetchReject: new Error("offline") });
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("could not connect to Metro");
    expect(result.writes).toEqual([]);
  });

  test("HTML snapshot response diagnoses missing Metro middleware", async () => {
    const result = await runSnapshotInMemory([], {
      fetchResponse: new Response("<!DOCTYPE html><html></html>", {
        status: 200,
        headers: { "content-type": "text/html" },
      }),
    });
    expect(result.code).toBe(3);
    expect(result.stderr).toContain("brna Metro middleware is not mounted");
    expect(result.stderr).toContain("withBrna()");
    expect(result.writes).toEqual([]);
  });

  test("cache write warning does not fail successful snapshot", async () => {
    const result = await runSnapshotInMemory([], { writeWarning: "ENOSPC" });
    expect(result.code).toBe(0);
    expect(result.stderr).toBe("brna: warning: snapshot cache write failed: ENOSPC\n");
    expect(result.writes).toHaveLength(1);
  });

  test("retries an in-flight snapshot before succeeding", async () => {
    const fresh = makeSnapshot({ tree: { id: "root", kind: "screen", name: "Home" } });
    const result = await runSnapshotInMemory([], {
      fresh,
      fetchResponses: [
        new Response(JSON.stringify({ error: "request_in_flight" }), { status: 429 }),
        new Response(JSON.stringify(fresh), { status: 200 }),
      ],
    });
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("Home");
    expect(result.writes).toEqual([fresh]);
  });

  test("persistent in-flight snapshot has actionable error", async () => {
    const result = await runSnapshotInMemory(["--timeout", "20"], {
      fetchResponse: new Response(JSON.stringify({ error: "request_in_flight" }), { status: 429 }),
    });
    expect(result.code).toBe(3);
    expect(result.stderr).toContain("retry this brna command after the previous command finishes");
    expect(result.writes).toEqual([]);
  });

  test("--active-layer projects only modal-like markdown nodes", async () => {
    const fresh = makeSnapshot({
      tree: {
        id: "root",
        kind: "screen",
        children: [
          { id: "background", kind: "button", name: "Background" },
          { id: "checkout-review-modal", kind: "group", children: [{ id: "place", kind: "button", name: "Place" }] },
        ],
      },
    });
    const result = await runSnapshotInMemory(["--active-layer"], { fresh });
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("## active layer");
    expect(result.stdout).toContain("checkout-review-modal");
    expect(result.stdout).not.toContain("Background");
  });

  test("--active-layer rejects --diff", () => {
    const result = spawnSync(
      "bun",
      ["run", CLI_PATH, "snapshot", "--active-layer", "--diff"],
      { env: { ...process.env, NO_COLOR: "1" }, encoding: "utf8", timeout: 5000 },
    );
    expect(result.status).toBe(4);
    expect(result.stderr).toContain("--active-layer cannot be combined with --diff");
  });
});

describe("snapshot --diff --target", () => {
  function baselineWithSubmit(): Snapshot {
    return makeSnapshot({
      tree: {
        id: "root",
        kind: "screen",
        children: [
          {
            id: "form",
            kind: "group",
            children: [{ id: "submit", kind: "button", name: "Save" }],
          },
          {
            id: "footer",
            kind: "group",
            children: [{ id: "clock", kind: "text", name: "12:00" }],
          },
        ],
      },
    });
  }

  function freshWithMultipleChanges(): Snapshot {
    return makeSnapshot({
      tree: {
        id: "root",
        kind: "screen",
        children: [
          {
            id: "form",
            kind: "group",
            children: [{ id: "submit", kind: "button", name: "Submit" }],
          },
          {
            id: "footer",
            kind: "group",
            children: [{ id: "clock", kind: "text", name: "12:01" }],
          },
        ],
      },
    });
  }

  test("--target without --diff exits 4 and does not contact Metro", () => {
    const result = spawnSync(
      "bun",
      ["run", CLI_PATH, "snapshot", "--target", "#submit"],
      { env: { ...process.env, NO_COLOR: "1" }, encoding: "utf8", timeout: 5000 },
    );
    expect(result.status).toBe(4);
    expect(result.stderr).toContain("--target requires --diff");
    expect(result.stdout).toBe("");
  });

  test("--diff --target with malformed selector exits 4 (subprocess)", () => {
    const result = spawnSync(
      "bun",
      ["run", CLI_PATH, "snapshot", "--diff", "--target", "button:"],
      { env: { ...process.env, NO_COLOR: "1" }, encoding: "utf8", timeout: 5000 },
    );
    expect(result.status).toBe(4);
    expect(result.stderr).toContain("malformed --target selector");
    expect(result.stdout).toBe("");
  });

  test("--diff --target with not-found selector exits 2 and does not refresh cache", async () => {
    const result = await runSnapshotInMemory(["--diff", "--target", "#missing"], {
      baseline: baselineWithSubmit(),
      fresh: freshWithMultipleChanges(),
    });
    expect(result.code).toBe(2);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe("brna: selector not found: #missing\n");
    expect(result.writes).toEqual([]);
  });

  test("--diff --target with ambiguous selector exits 3 listing ids in document order", async () => {
    const baseline = makeSnapshot({
      tree: {
        id: "root",
        kind: "screen",
        children: [
          { id: "save-top", kind: "button", role: "button", name: "Save" },
          { id: "save-bottom", kind: "button", role: "button", name: "Save" },
        ],
      },
    });
    const fresh = makeSnapshot({
      tree: {
        id: "root",
        kind: "screen",
        children: [
          { id: "save-top", kind: "button", role: "button", name: "Save" },
          { id: "save-bottom", kind: "button", role: "button", name: "Save" },
        ],
      },
    });
    const result = await runSnapshotInMemory(["--diff", "--target", "button:Save"], {
      baseline,
      fresh,
    });
    expect(result.code).toBe(3);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("save-top");
    expect(result.stderr).toContain("save-bottom");
    expect(result.stderr.indexOf("save-top")).toBeLessThan(result.stderr.indexOf("save-bottom"));
    expect(result.writes).toEqual([]);
  });

  test("--diff --target focuses output to the target's region", async () => {
    const baseline = baselineWithSubmit();
    const fresh = freshWithMultipleChanges();
    const result = await runSnapshotInMemory(["--diff", "--target", "#submit"], {
      baseline,
      fresh,
    });
    expect(result.code).toBe(0);
    // submit's name change should appear, clock's name change should not.
    expect(result.stdout).toContain("submit");
    expect(result.stdout).not.toContain("clock");
    expect(result.writes).toEqual([fresh]);
  });
});
