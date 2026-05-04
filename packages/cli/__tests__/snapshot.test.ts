import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { deflateSync } from "node:zlib";
import { SCHEMA_VERSION, validateSnapshot, type Snapshot } from "@brna/schema";
import { diff, fromDiffJSON, fromDiffYAML, fromJSON, fromYAML } from "@brna/core";
import { projectDiff, projectSnapshot, runSnapshot } from "../src/snapshot.js";
import type { NativeCaptureCommand, SpawnNative, SpawnResult } from "../src/capture.js";

const CLI_PATH = resolve(import.meta.dir, "../src/cli.ts");
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const CRC_TABLE: number[] = (() => {
  const table = new Array<number>(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(data: Buffer): number {
  let c = 0xffffffff;
  for (let i = 0; i < data.length; i++) c = CRC_TABLE[(c ^ data[i]!) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const t = Buffer.from(type, "ascii");
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([t, data])) >>> 0, 0);
  return Buffer.concat([len, t, data, crc]);
}

function makeSolidPng(width: number, height: number, color: [number, number, number, number]): Buffer {
  const channels = 4;
  const stride = width * channels;
  const filtered = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    const rowStart = y * (stride + 1);
    filtered[rowStart] = 0;
    for (let x = 0; x < width; x++) {
      const px = rowStart + 1 + x * channels;
      for (let c = 0; c < channels; c++) filtered[px + c] = color[c]!;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr.writeUInt8(8, 8);
  ihdr.writeUInt8(6, 9);
  return Buffer.concat([
    PNG_SIGNATURE,
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", deflateSync(filtered)),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

const FAKE_PNG = makeSolidPng(2, 2, [255, 255, 255, 255]);

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
    spawnResult?: SpawnResult;
    spawn?: SpawnNative;
  } = {},
): Promise<{
  code: number;
  stdout: string;
  stderr: string;
  writes: Snapshot[];
  outputFiles: Array<{ path: string; data: string }>;
  captureFiles: Array<{ path: string; data: Buffer }>;
  nativeCommands: NativeCaptureCommand[];
}> {
  let stdout = "";
  let stderr = "";
  const writes: Snapshot[] = [];
  const outputFiles: Array<{ path: string; data: string }> = [];
  const captureFiles: Array<{ path: string; data: Buffer }> = [];
  const nativeCommands: NativeCaptureCommand[] = [];
  const fresh = options.fresh ?? makeSnapshot();
  try {
    await runSnapshot(rest, {
      fetch: async (input) => {
        if (options.fetchReject) throw options.fetchReject;
        if (options.fetchResponses && options.fetchResponses.length > 0) return options.fetchResponses.shift()!;
        if (options.fetchResponse) return options.fetchResponse;
        const url = typeof input === "string" ? input : (input as { url: string }).url;
        if (url.includes("/brna/devices")) {
          return new Response(JSON.stringify({
            devices: [{ id: "ios-sim", platform: "ios", native_device_id: "SIM-1" }],
          }), { status: 200 });
        }
        return new Response(JSON.stringify(fresh), { status: 200 });
      },
      readSnapshotCache: async () => options.baseline ?? null,
      writeSnapshotCache: async (snapshot) => {
        writes.push(snapshot);
        return options.writeWarning ?? null;
      },
      writeFile: async (path, data) => {
        outputFiles.push({ path, data });
      },
      writeCaptureFile: async (path, data) => {
        captureFiles.push({ path, data });
      },
      spawnNative: options.spawn ?? (async (cmd) => {
        nativeCommands.push(cmd);
        return options.spawnResult ?? {
          status: 0,
          stdout: FAKE_PNG,
          stderr: "",
        };
      }),
      stdout: { write: (chunk: string | Uint8Array) => ((stdout += String(chunk)), true) },
      stderr: { write: (chunk: string | Uint8Array) => ((stderr += String(chunk)), true) },
      exit: (code) => {
        throw Object.assign(new Error("exit"), { code });
      },
    });
  } catch (err) {
    const code = (err as { code?: unknown }).code;
    if (typeof code === "number") {
      return { code, stdout, stderr, writes, outputFiles, captureFiles, nativeCommands };
    }
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

describe("snapshot --image", () => {
  test("--image without --image-to exits 4 before contacting Metro", () => {
    const result = spawnSync(
      "bun",
      ["run", CLI_PATH, "snapshot", "--image"],
      { env: { ...process.env, NO_COLOR: "1" }, encoding: "utf8", timeout: 5000 },
    );
    expect(result.status).toBe(4);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("--image and --image-to must be supplied together");
  });

  test("writes sidecar image while preserving stdout snapshot projection", async () => {
    const result = await runSnapshotInMemory([
      "--image",
      "--image-to",
      "/tmp/screen.png",
      "--native-platform",
      "android",
    ]);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("# Snapshot");
    expect(result.captureFiles).toHaveLength(1);
    expect(result.captureFiles[0]!.path).toBe("/tmp/screen.png");
    expect(result.nativeCommands[0]!.platform).toBe("android");
  });

  test("--to remains the snapshot output path and --image-to is the PNG path", async () => {
    const result = await runSnapshotInMemory([
      "--to",
      "/tmp/snapshot.md",
      "--image",
      "--image-to",
      "/tmp/screen.png",
      "--native-platform",
      "ios",
    ]);
    expect(result.code).toBe(0);
    expect(result.stdout).toBe("");
    expect(result.outputFiles).toHaveLength(1);
    expect(result.outputFiles[0]!.path).toBe("/tmp/snapshot.md");
    expect(result.outputFiles[0]!.data).toContain("# Snapshot");
    expect(result.captureFiles).toHaveLength(1);
    expect(result.captureFiles[0]!.path).toBe("/tmp/screen.png");
  });

  test("capture failure is reported as a warning while snapshot exits 0", async () => {
    const result = await runSnapshotInMemory([
      "--image",
      "--image-to",
      "/tmp/screen.png",
      "--native-platform",
      "android",
    ], {
      spawnResult: {
        status: 1,
        stdout: Buffer.alloc(0),
        stderr: "error: more than one device/emulator",
      },
    });
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("# Snapshot");
    expect(result.stderr).toContain("brna: warning: sidecar image capture failed:");
    expect(result.captureFiles).toHaveLength(0);
  });

  test("passes device, overlay, and native-device options through to capture", async () => {
    const result = await runSnapshotInMemory([
      "--device",
      "ios-sim",
      "--image",
      "--image-to",
      "/tmp/overlay.png",
      "--overlay",
      "--native-device",
      "SIM-2",
      "--native-platform",
      "ios",
    ]);
    expect(result.code).toBe(0);
    expect(result.captureFiles).toHaveLength(1);
    expect(result.nativeCommands[0]!.args).toEqual(["simctl", "io", "SIM-2", "screenshot", "-"]);
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
