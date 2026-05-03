import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, stat, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { SCHEMA_VERSION, type Snapshot } from "@brna/schema";
import {
  getCacheDir,
  getSessionId,
  readSnapshotCache,
  resetSessionIdForTests,
  resolveSessionId,
  writeSnapshotCache,
  snapshotSessionId,
} from "../src/session.js";

function makeSnapshot(): Snapshot {
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
    tree: { id: "root", kind: "screen", children: [{ id: "x", kind: "button", name: "X" }] },
  };
}

async function tempRoot(): Promise<string> {
  return mkdtemp(join(tmpdir(), "brna-session-test-"));
}

describe("session id derivation", () => {
  test("honors BRNA_SESSION_ID override", () => {
    const old = process.env.BRNA_SESSION_ID;
    process.env.BRNA_SESSION_ID = "agent/session 1";
    try {
      expect(resolveSessionId({ noTty: true, ppid: 42, pid: 99 })).toBe("env-agent_session_1");
    } finally {
      if (old === undefined) delete process.env.BRNA_SESSION_ID;
      else process.env.BRNA_SESSION_ID = old;
    }
  });

  test("uses tty inode when available", () => {
    expect(resolveSessionId({ ttyIno: 0x3a7c91, ppid: 42, pid: 99 })).toBe("tty-3a7c91");
  });

  test("falls back to ppid when no tty exists", () => {
    expect(resolveSessionId({ noTty: true, ppid: 42, pid: 99 })).toBe("ppid-42");
  });

  test("falls back to pid when ppid is init", () => {
    expect(resolveSessionId({ noTty: true, ppid: 1, pid: 99 })).toBe("pid-99");
  });

  test("memoises production session id", () => {
    resetSessionIdForTests();
    const first = getSessionId();
    const second = getSessionId();
    expect(second).toBe(first);
  });
});

describe("snapshot cache", () => {
  test("defaults snapshot cache key to runtime session id", async () => {
    const root = await tempRoot();
    const snapshot = makeSnapshot();
    await writeSnapshotCache(snapshot, { tmpdir: root });
    expect(await readSnapshotCache({ tmpdir: root, sessionId: snapshotSessionId(snapshot) })).toEqual(snapshot);
  });

  test("creates cache directory lazily and writes canonical snapshot bytes", async () => {
    const root = await tempRoot();
    const snapshot = makeSnapshot();
    const warning = await writeSnapshotCache(snapshot, { tmpdir: root, sessionId: "s1", pid: 123 });
    expect(warning).toBeNull();
    const dir = getCacheDir({ tmpdir: root, sessionId: "s1" });
    expect((await stat(dir)).isDirectory()).toBe(true);
    expect(await readFile(join(dir, "last-snapshot.json"), "utf8")).toContain('"snapshot_id": "n"');
  });

  test("reads fresh baselines", async () => {
    const root = await tempRoot();
    const snapshot = makeSnapshot();
    await writeSnapshotCache(snapshot, { tmpdir: root, sessionId: "s1" });
    expect(await readSnapshotCache({ tmpdir: root, sessionId: "s1" })).toEqual(snapshot);
  });

  test("returns null for missing, stale, and invalid baselines", async () => {
    const root = await tempRoot();
    expect(await readSnapshotCache({ tmpdir: root, sessionId: "s1" })).toBeNull();

    const snapshot = makeSnapshot();
    await writeSnapshotCache(snapshot, { tmpdir: root, sessionId: "s1" });
    const file = join(getCacheDir({ tmpdir: root, sessionId: "s1" }), "last-snapshot.json");
    await utimes(file, new Date(0), new Date(0));
    expect(await readSnapshotCache({ tmpdir: root, sessionId: "s1", now: () => 86_400_001 })).toBeNull();

    const badRoot = await tempRoot();
    const badDir = getCacheDir({ tmpdir: badRoot, sessionId: "s2" });
    await writeSnapshotCache(snapshot, { tmpdir: badRoot, sessionId: "s2" });
    await writeFile(join(badDir, "last-snapshot.json"), '{"events":[]}', "utf8");
    expect(await readSnapshotCache({ tmpdir: badRoot, sessionId: "s2" })).toBeNull();
  });

  test("write failures return a single reason without throwing", async () => {
    const root = await tempRoot();
    const fileAsRoot = join(root, "not-a-directory");
    await writeFile(fileAsRoot, "x", "utf8");
    const warning = await writeSnapshotCache(makeSnapshot(), { tmpdir: fileAsRoot, sessionId: "s1" });
    expect(typeof warning).toBe("string");
    expect(warning?.length).toBeGreaterThan(0);
  });
});
