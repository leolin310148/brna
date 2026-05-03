import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { diff, fromCanonicalYAML, toCanonicalYAML } from "@brna/core";
import { SCHEMA_VERSION, type Snapshot } from "@brna/schema";
import { runSnapshot } from "../src/snapshot.js";
import { replayTraceFile } from "../src/trace.js";

const CLI_PATH = resolve(import.meta.dir, "../src/cli.ts");

function makeSnapshot(over: Partial<Snapshot> = {}): Snapshot {
  return {
    meta: {
      schema_version: SCHEMA_VERSION,
      captured_at: "2026-05-02T00:00:00.000Z",
      app: { bundle_id: "x", version: "1" },
      device: {
        platform: "ios",
        os_version: "17",
        model: "iPhone",
        viewport: { w: 1, h: 1, scale: 1 },
        locale: "en",
      },
      session_id: "s",
      snapshot_id: "n",
    },
    screen: { modal_stack: [] },
    tree: { id: "root", kind: "screen" },
    ...over,
  };
}

describe("brna config", () => {
  test("config init writes a default brna.config.ts", () => {
    const cwd = mkdtempSync(join(tmpdir(), "brna-config-"));
    const result = spawnSync("bun", ["run", CLI_PATH, "config", "init"], {
      cwd,
      env: { ...process.env, NO_COLOR: "1" },
      encoding: "utf8",
      timeout: 5000,
    });
    expect(result.status).toBe(0);
    expect(readFileSync(join(cwd, "brna.config.ts"), "utf8")).toContain("redactSecureFields");
  });

  test("snapshot sends config redaction options to Metro", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "brna-config-"));
    const prior = process.cwd();
    let captured: { method?: string; body?: string } = {};
    try {
      process.chdir(cwd);
      await writeFile(
        join(cwd, "brna.config.ts"),
        'export default { redact: [{ match: /secret/g, replace: "<secret>" }] };\n',
        "utf8",
      );
      await runSnapshot([], {
        fetch: async (_url, init) => {
          captured = { method: init?.method, body: String(init?.body ?? "") };
          return new Response(JSON.stringify(makeSnapshot()), { status: 200 });
        },
        writeSnapshotCache: async () => null,
        stdout: { write: () => true },
        stderr: { write: () => true },
        exit: (code) => {
          throw Object.assign(new Error("exit"), { code });
        },
      });
    } catch (err) {
      expect((err as { code?: number }).code).toBe(0);
    } finally {
      process.chdir(prior);
      await rm(cwd, { recursive: true, force: true });
    }
    expect(captured.method).toBe("POST");
    expect(captured.body).toContain('"source":"secret"');
  });
});

describe("brna trace", () => {
  test("start and stop create a YAML trace with metadata and events", () => {
    const cwd = mkdtempSync(join(tmpdir(), "brna-trace-"));
    const sessionDir = join(cwd, "sessions");
    writeFileSync(join(cwd, "brna.config.ts"), `export default { sessionDir: ${JSON.stringify(sessionDir)} };\n`, "utf8");

    const start = spawnSync("bun", ["run", CLI_PATH, "trace", "start"], {
      cwd,
      env: { ...process.env, NO_COLOR: "1" },
      encoding: "utf8",
      timeout: 5000,
    });
    expect(start.status).toBe(0);
    const stop = spawnSync("bun", ["run", CLI_PATH, "trace", "stop"], {
      cwd,
      env: { ...process.env, NO_COLOR: "1" },
      encoding: "utf8",
      timeout: 5000,
    });
    expect(stop.status).toBe(0);
    const tracePath = stop.stdout.trim();
    const trace = fromCanonicalYAML(readFileSync(tracePath, "utf8")) as { metadata?: unknown; events?: unknown[] };
    expect(trace.metadata).toBeTruthy();
    expect(trace.events).toEqual([]);
  });

  test("records an act with snapshots and replays it from the stopped trace", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "brna-trace-"));
    const sessionDir = join(cwd, "sessions");
    writeFileSync(join(cwd, "brna.config.ts"), `export default { sessionDir: ${JSON.stringify(sessionDir)} };\n`, "utf8");

    let actionCount = 0;
    const before = makeSnapshot();
    const after = makeSnapshot({
      tree: {
        id: "root",
        kind: "screen",
        children: [{ id: "save", kind: "button", name: "Save", state: ["focused"] }],
      },
    });
    let currentSnapshot = before;
    const server = createServer((req, res) => {
      if (req.method === "GET" && (req.url ?? "").startsWith("/brna/snapshot")) {
        const text = JSON.stringify(currentSnapshot);
        res.statusCode = 200;
        res.setHeader("Content-Type", "application/json");
        res.setHeader("Content-Length", Buffer.byteLength(text).toString());
        res.end(text);
        return;
      }
      if (req.method === "POST" && (req.url ?? "").startsWith("/brna/action")) {
        req.resume();
        actionCount += 1;
        currentSnapshot = after;
        res.statusCode = 204;
        res.setHeader("Content-Length", "0");
        res.end();
        return;
      }
      res.statusCode = 404;
      res.end();
    });
    await new Promise<void>((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
    const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

    try {
      expect((await runCli(cwd, ["trace", "start"])).status).toBe(0);
      const act = await runCli(cwd, ["act", "key", "tab", "--metro", baseUrl, "--timeout", "5000"]);
      expect(act.status).toBe(0);
      const stop = await runCli(cwd, ["trace", "stop"]);
      expect(stop.status).toBe(0);
      const tracePath = stop.stdout.trim();
      currentSnapshot = before;
      const replay = await runCli(cwd, ["trace", "replay", tracePath]);
      expect(replay.status).toBe(0);
      const trace = fromCanonicalYAML(readFileSync(tracePath, "utf8")) as {
        events?: Array<{ type: string; snapshot_before?: unknown; snapshot_after?: unknown; diff?: { events?: unknown[] } }>;
      };
      expect(trace.events?.map((event) => event.type)).toEqual(["act"]);
      expect(trace.events?.[0]?.snapshot_before).toBeTruthy();
      expect(trace.events?.[0]?.snapshot_after).toBeTruthy();
      expect(trace.events?.[0]?.diff?.events).toBeTruthy();
      expect(actionCount).toBe(2);
    } finally {
      await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
    }
  });

  test("recorded tap diff is focused on the target's region, key tab is not", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "brna-trace-"));
    const sessionDir = join(cwd, "sessions");
    writeFileSync(
      join(cwd, "brna.config.ts"),
      `export default { sessionDir: ${JSON.stringify(sessionDir)} };\n`,
      "utf8",
    );

    const before = makeSnapshot({
      tree: {
        id: "root",
        kind: "screen",
        children: [
          {
            id: "form",
            kind: "group",
            children: [{ id: "save", kind: "button", name: "Save" }],
          },
          {
            id: "footer",
            kind: "group",
            children: [{ id: "clock", kind: "text", name: "12:00" }],
          },
        ],
      },
    });
    const after = makeSnapshot({
      tree: {
        id: "root",
        kind: "screen",
        children: [
          {
            id: "form",
            kind: "group",
            children: [{ id: "save", kind: "button", name: "Saved", state: ["focused"] }],
          },
          {
            id: "footer",
            kind: "group",
            children: [{ id: "clock", kind: "text", name: "12:01" }],
          },
        ],
      },
    });
    let currentSnapshot = before;
    const server = createServer((req, res) => {
      if (req.method === "GET" && (req.url ?? "").startsWith("/brna/snapshot")) {
        const text = JSON.stringify(currentSnapshot);
        res.statusCode = 200;
        res.setHeader("Content-Type", "application/json");
        res.setHeader("Content-Length", Buffer.byteLength(text).toString());
        res.end(text);
        return;
      }
      if (req.method === "POST" && (req.url ?? "").startsWith("/brna/action")) {
        req.resume();
        currentSnapshot = after;
        res.statusCode = 204;
        res.setHeader("Content-Length", "0");
        res.end();
        return;
      }
      res.statusCode = 404;
      res.end();
    });
    await new Promise<void>((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
    const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

    try {
      // Targeted tap: trace diff should only mention save (and ancestors), not clock.
      expect((await runCli(cwd, ["trace", "start"])).status).toBe(0);
      const tap = await runCli(cwd, ["act", "tap", "#save", "--metro", baseUrl, "--timeout", "5000"]);
      expect(tap.status).toBe(0);
      expect(tap.stdout).toBe("");
      expect(tap.stderr).toBe("");
      const stop1 = await runCli(cwd, ["trace", "stop"]);
      expect(stop1.status).toBe(0);
      const traceTap = fromCanonicalYAML(readFileSync(stop1.stdout.trim(), "utf8")) as {
        events?: Array<{ diff?: { events?: Array<{ id: string }> } }>;
      };
      const tapIds = (traceTap.events?.[0]?.diff?.events ?? []).map((e) => e.id);
      expect(tapIds).toContain("save");
      expect(tapIds).not.toContain("clock");

      // Untargeted key tab: trace diff should remain unfiltered → clock change is recorded.
      currentSnapshot = before;
      expect((await runCli(cwd, ["trace", "start"])).status).toBe(0);
      const key = await runCli(cwd, ["act", "key", "tab", "--metro", baseUrl, "--timeout", "5000"]);
      expect(key.status).toBe(0);
      const stop2 = await runCli(cwd, ["trace", "stop"]);
      const traceKey = fromCanonicalYAML(readFileSync(stop2.stdout.trim(), "utf8")) as {
        events?: Array<{ diff?: { events?: Array<{ id: string }> } }>;
      };
      const keyIds = (traceKey.events?.[0]?.diff?.events ?? []).map((e) => e.id);
      expect(keyIds).toContain("save");
      expect(keyIds).toContain("clock");
    } finally {
      await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
    }
  });

  test("replay fails when a recorded snapshot does not match current state", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "brna-trace-"));
    const recorded = makeSnapshot();
    const current = makeSnapshot({
      tree: {
        id: "root",
        kind: "screen",
        children: [{ id: "different", kind: "text", name: "Different" }],
      },
    });
    const tracePath = join(cwd, "trace.yaml");
    writeFileSync(
      tracePath,
      toCanonicalYAML({
        metadata: {
          session_id: "test",
          started_at: "2026-05-02T00:00:00.000Z",
          version: "brna-trace/1",
        },
        events: [
          {
            args: ["key", "tab", "--metro", "http://127.0.0.1:1", "--timeout", "5000"],
            command: "act",
            snapshot_before: recorded,
            timestamp: "2026-05-02T00:00:00.000Z",
            type: "act",
          },
        ],
      }),
      "utf8",
    );

    expect(diff(recorded, current).events.length).toBe(1);
    const parsed = fromCanonicalYAML(readFileSync(tracePath, "utf8")) as { events?: Array<{ snapshot_before?: unknown }> };
    expect(parsed.events?.[0]?.snapshot_before).toBeTruthy();

    let caught: { code?: number; message?: string } | null = null;
    try {
      await replayTraceFile(tracePath, {
        fetch: async () => new Response(JSON.stringify(current), { status: 200 }),
        runAct: async () => {},
        fail: (code, reason) => {
          throw Object.assign(new Error(reason), { code });
        },
      });
    } catch (err) {
      caught = err as { code?: number; message?: string };
    }
    expect(caught?.code).toBe(6);
    expect(caught?.message).toContain("trace replay before-snapshot mismatch");
  });
});

async function runCli(cwd: string, args: string[]): Promise<{ status: number | null; stdout: string; stderr: string }> {
  const proc = Bun.spawn(["bun", "run", CLI_PATH, ...args], {
    cwd,
    env: { ...process.env, NO_COLOR: "1" },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, status] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { status, stdout, stderr };
}
