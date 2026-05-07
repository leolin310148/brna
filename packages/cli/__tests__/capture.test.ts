import { describe, expect, test } from "bun:test";
import {
  buildNativeCommand,
  defaultSpawnNative,
  generateOutputPath,
  mapNativeError,
  parseSingleAdbDevice,
  parseSingleBootedSimulator,
  parseCaptureArgs,
  pickNativePlatform,
  runCapture,
  type SpawnNative,
  type SpawnResult,
} from "../src/capture.js";

const FAKE_PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]);

interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
  writes: Array<{ path: string; bytes: Buffer }>;
}

interface RunOptions {
  spawnResult?: SpawnResult;
  spawn?: SpawnNative;
  devicesPayload?: { devices: unknown[] };
  devicesStatus?: number;
  fetchReject?: Error;
  cacheDir?: string;
  now?: Date;
}

async function run(rest: string[], options: RunOptions = {}): Promise<RunResult> {
  let stdout = "";
  let stderr = "";
  const writes: Array<{ path: string; bytes: Buffer }> = [];
  const spawn: SpawnNative =
    options.spawn ??
    (async () => options.spawnResult ?? { status: 0, stdout: FAKE_PNG, stderr: "" });
  const fetchImpl: typeof fetch = (async (input: unknown) => {
    if (options.fetchReject) throw options.fetchReject;
    const url = typeof input === "string" ? input : (input as { url: string }).url;
    if (url.includes("/brna/devices")) {
      const status = options.devicesStatus ?? 200;
      const body = options.devicesPayload ?? { devices: [] };
      return new Response(JSON.stringify(body), { status });
    }
    return new Response("not used", { status: 404 });
  }) as typeof fetch;

  try {
    await runCapture(rest, {
      fetch: fetchImpl,
      spawnNative: spawn,
      writeFile: async (path, bytes) => {
        writes.push({ path, bytes });
      },
      stdout: { write: (c: string | Uint8Array) => ((stdout += String(c)), true) },
      stderr: { write: (c: string | Uint8Array) => ((stderr += String(c)), true) },
      exit: (code) => {
        throw Object.assign(new Error("exit"), { code });
      },
      ...(options.cacheDir !== undefined ? { cacheDir: options.cacheDir } : {}),
      ...(options.now !== undefined ? { now: () => options.now! } : {}),
    });
  } catch (err) {
    const code = (err as { code?: unknown }).code;
    if (typeof code === "number") return { code, stdout, stderr, writes };
    throw err;
  }
  throw new Error("expected runCapture to exit");
}

describe("parseCaptureArgs", () => {
  test("parses flags", () => {
    const args = parseCaptureArgs([
      "--to",
      "out.png",
      "--overlay",
      "--metro",
      "http://localhost:9000",
      "--device",
      "ios-sim",
      "--native-device",
      "booted",
      "--native-platform",
      "ios",
      "--timeout",
      "20000",
    ]);
    expect(args.to).toBe("out.png");
    expect(args.overlay).toBe(true);
    expect(args.metro).toBe("http://localhost:9000");
    expect(args.device).toBe("ios-sim");
    expect(args.nativeDevice).toBe("booted");
    expect(args.nativePlatform).toBe("ios");
    expect(args.timeoutMs).toBe(20000);
  });

  test("trims surrounding whitespace from native device ids", () => {
    expect(parseCaptureArgs(["--native-device", "  booted  "]).nativeDevice).toBe("booted");
  });

  test("rejects whitespace-only native device ids", () => {
    const result = captureProcessExit(() => parseCaptureArgs(["--native-device", "   "]));
    expect(result.code).toBe(4);
    expect(result.stderr).toContain("missing value for '--native-device'");
  });

  test("rejects unknown flag via fail", () => {
    const result = captureProcessExit(() => parseCaptureArgs(["--bogus"]));
    expect(result.code).toBe(4);
    expect(result.stderr).toContain("unknown flag '--bogus'");
  });
});

describe("buildNativeCommand", () => {
  test("android with native device", () => {
    const cmd = buildNativeCommand("android", "emulator-5554");
    expect(cmd.bin).toBe("adb");
    expect(cmd.args).toEqual(["-s", "emulator-5554", "exec-out", "screencap", "-p"]);
  });
  test("android without native device", () => {
    const cmd = buildNativeCommand("android", undefined);
    expect(cmd.args).toEqual(["exec-out", "screencap", "-p"]);
  });
  test("ios uses booted by default", () => {
    const cmd = buildNativeCommand("ios", undefined);
    expect(cmd.bin).toBe("xcrun");
    expect(cmd.args).toEqual(["simctl", "io", "booted", "screenshot", "-"]);
  });
  test("ios with explicit udid", () => {
    const cmd = buildNativeCommand("ios", "ABC-123");
    expect(cmd.args).toEqual(["simctl", "io", "ABC-123", "screenshot", "-"]);
  });
});

describe("pickNativePlatform", () => {
  test("explicit wins", () => {
    expect(pickNativePlatform({ explicit: "ios", device: { id: "x", platform: "android" } })).toBe(
      "ios",
    );
  });
  test("device platform fallback", () => {
    expect(pickNativePlatform({ device: { id: "x", platform: "android" } })).toBe("android");
  });
  test("unknown returns null", () => {
    expect(pickNativePlatform({ device: { id: "x", platform: "web" } })).toBeNull();
    expect(pickNativePlatform({})).toBeNull();
  });
});

describe("native target discovery parsers", () => {
  test("parseSingleAdbDevice returns the lone attached device serial", () => {
    expect(parseSingleAdbDevice("List of devices attached\nemulator-5554\tdevice\n\n")).toBe(
      "emulator-5554",
    );
  });

  test("parseSingleAdbDevice ignores offline devices and rejects ambiguity", () => {
    expect(parseSingleAdbDevice("List of devices attached\nemu-1\tdevice\nemu-2\toffline\n")).toBe(
      "emu-1",
    );
    expect(parseSingleAdbDevice("List of devices attached\nemu-1\tdevice\nemu-2\tdevice\n")).toBeUndefined();
  });

  test("parseSingleBootedSimulator returns a single booted simulator udid", () => {
    const payload = {
      devices: {
        "com.apple.CoreSimulator.SimRuntime.iOS-26-4": [
          { state: "Shutdown", udid: "A" },
          { state: "Booted", udid: "B", isAvailable: true },
        ],
      },
    };
    expect(parseSingleBootedSimulator(JSON.stringify(payload))).toBe("B");
  });

  test("parseSingleBootedSimulator rejects multiple booted simulators", () => {
    const payload = {
      devices: {
        runtime: [
          { state: "Booted", udid: "A", isAvailable: true },
          { state: "Booted", udid: "B", isAvailable: true },
        ],
      },
    };
    expect(parseSingleBootedSimulator(JSON.stringify(payload))).toBeUndefined();
  });
});

describe("mapNativeError", () => {
  test("ENOENT for adb maps to actionable hint", () => {
    const result = mapNativeError(
      { platform: "android", bin: "adb", args: [] },
      {
        status: null,
        stdout: Buffer.alloc(0),
        stderr: "",
        spawnError: Object.assign(new Error("not found"), { code: "ENOENT" }) as NodeJS.ErrnoException,
      },
    );
    expect(result.code).toBe(7);
    expect(result.reason).toContain("adb");
    expect(result.reason).toContain("Platform Tools");
  });
  test("ENOENT for xcrun mentions Xcode tools", () => {
    const result = mapNativeError(
      { platform: "ios", bin: "xcrun", args: [] },
      {
        status: null,
        stdout: Buffer.alloc(0),
        stderr: "",
        spawnError: Object.assign(new Error("not found"), { code: "ENOENT" }) as NodeJS.ErrnoException,
      },
    );
    expect(result.code).toBe(7);
    expect(result.reason).toContain("Xcode");
  });
  test("multiple devices on adb maps to native-device hint", () => {
    const result = mapNativeError(
      { platform: "android", bin: "adb", args: [] },
      {
        status: 1,
        stdout: Buffer.alloc(0),
        stderr: "error: more than one device/emulator",
      },
    );
    expect(result.code).toBe(8);
    expect(result.reason).toContain("--native-device");
  });
  test("simctl no booted devices maps to native-device hint", () => {
    const result = mapNativeError(
      { platform: "ios", bin: "xcrun", args: [] },
      {
        status: 1,
        stdout: Buffer.alloc(0),
        stderr: "No devices are booted.",
      },
    );
    expect(result.code).toBe(8);
    expect(result.reason).toContain("--native-device");
  });
  test("simctl display note with PNG output is ignored", () => {
    const result = mapNativeError(
      { platform: "ios", bin: "xcrun", args: [] },
      {
        status: 1,
        stdout: Buffer.from("png-bytes"),
        stderr: "Note: No display specified. Defaulting to display: 11223344 (screenID: 1, name: LCD)\n",
      },
    );
    expect(result.code).toBe(0);
  });
  test("empty stdout reports empty PNG output", () => {
    const result = mapNativeError(
      { platform: "android", bin: "adb", args: [] },
      { status: 0, stdout: Buffer.alloc(0), stderr: "" },
    );
    expect(result.code).toBe(1);
    expect(result.reason).toContain("empty PNG");
  });
  test("success", () => {
    const result = mapNativeError(
      { platform: "android", bin: "adb", args: [] },
      { status: 0, stdout: Buffer.from("png-bytes"), stderr: "" },
    );
    expect(result.code).toBe(0);
  });
});

describe("defaultSpawnNative", () => {
  test("ios screenshots are read from a temp file and tolerate simctl display notes", async () => {
    const spawnNative = defaultSpawnNative();
    const script = [
      "const fs = require('node:fs');",
      "fs.writeFileSync(process.argv[1], Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a,0x00]));",
      "process.stderr.write('Note: No display specified. Defaulting to display: 11223344 (screenID: 1, name: LCD)\\n');",
      "process.exit(1);",
    ].join("");

    const result = await spawnNative(
      {
        platform: "ios",
        bin: process.execPath,
        args: ["-e", script, "-"],
      },
      1000,
    );

    expect(result.status).toBe(1);
    expect(result.stdout.equals(FAKE_PNG)).toBe(true);
    expect(result.stderr).toContain("No display specified");
    expect(mapNativeError({ platform: "ios", bin: "xcrun", args: [] }, result).code).toBe(0);
  });
});

describe("generateOutputPath", () => {
  test("uses cache dir, timestamp, and overlay suffix", () => {
    const now = new Date(Date.UTC(2026, 4, 4, 12, 30, 5));
    const overlay = generateOutputPath({
      cacheDir: "/tmp/brna",
      sessionId: "test",
      now,
      overlay: true,
    });
    expect(overlay).toBe("/tmp/brna/capture-20260504T123005Z.overlay.png");
    const plain = generateOutputPath({
      cacheDir: "/tmp/brna",
      sessionId: "test",
      now,
      overlay: false,
    });
    expect(plain).toBe("/tmp/brna/capture-20260504T123005Z.png");
  });
});

describe("runCapture (in-memory)", () => {
  test("writes png to --to and exits 0", async () => {
    const result = await run([
      "--to",
      "/tmp/cap-test.png",
      "--native-platform",
      "android",
    ]);
    expect(result.code).toBe(0);
    expect(result.writes).toHaveLength(1);
    expect(result.writes[0]!.path).toBe("/tmp/cap-test.png");
    expect(result.writes[0]!.bytes.equals(FAKE_PNG)).toBe(true);
    expect(result.stdout.trim()).toBe("/tmp/cap-test.png");
    expect(result.stderr).toBe("");
  });

  test("prints generated path when --to omitted", async () => {
    const now = new Date(Date.UTC(2026, 4, 4, 1, 2, 3));
    const result = await run(["--native-platform", "ios"], {
      cacheDir: "/tmp/brna-cap",
      now,
    });
    expect(result.code).toBe(0);
    expect(result.stdout.trim()).toBe("/tmp/brna-cap/capture-20260504T010203Z.png");
    expect(result.writes[0]!.path).toBe("/tmp/brna-cap/capture-20260504T010203Z.png");
  });

  test("missing native target maps to exit 8 with diagnostic", async () => {
    const result = await run(["--native-platform", "android", "--to", "/tmp/x.png"], {
      spawnResult: {
        status: 1,
        stdout: Buffer.alloc(0),
        stderr: "error: more than one device/emulator",
      },
    });
    expect(result.code).toBe(8);
    expect(result.stderr).toContain("--native-device");
    expect(result.writes).toHaveLength(0);
  });

  test("missing adb binary maps to exit 7", async () => {
    const result = await run(["--native-platform", "android", "--to", "/tmp/x.png"], {
      spawnResult: {
        status: null,
        stdout: Buffer.alloc(0),
        stderr: "",
        spawnError: Object.assign(new Error("ENOENT"), { code: "ENOENT" }) as NodeJS.ErrnoException,
      },
    });
    expect(result.code).toBe(7);
    expect(result.stderr).toContain("'adb' not found");
  });

  test("--device fetches device records and uses native_device_id", async () => {
    let observedCmd: { bin: string; args: string[] } | null = null;
    const result = await run(["--device", "expo-1", "--to", "/tmp/y.png"], {
      devicesPayload: {
        devices: [{ id: "expo-1", platform: "android", native_device_id: "emu-9999" }],
      },
      spawn: async (cmd) => {
        observedCmd = { bin: cmd.bin, args: cmd.args };
        return { status: 0, stdout: FAKE_PNG, stderr: "" };
      },
    });
    expect(result.code).toBe(0);
    expect(observedCmd).not.toBeNull();
    expect(observedCmd!.bin).toBe("adb");
    expect(observedCmd!.args).toEqual(["-s", "emu-9999", "exec-out", "screencap", "-p"]);
  });

  test("--device resolves a single adb device when runtime lacks native_device_id", async () => {
    const observed: Array<{ bin: string; args: string[] }> = [];
    const result = await run(["--device", "expo-2", "--to", "/tmp/w.png"], {
      devicesPayload: { devices: [{ id: "expo-2", platform: "android" }] },
      spawn: async (cmd) => {
        observed.push({ bin: cmd.bin, args: cmd.args });
        if (cmd.bin === "adb" && cmd.args.join(" ") === "devices") {
          return {
            status: 0,
            stdout: Buffer.from("List of devices attached\nemulator-5554\tdevice\n"),
            stderr: "",
          };
        }
        return { status: 0, stdout: FAKE_PNG, stderr: "" };
      },
    });
    expect(result.code).toBe(0);
    expect(result.stderr).toBe("");
    expect(observed[0]).toEqual({ bin: "adb", args: ["devices"] });
    expect(observed[1]).toEqual({
      bin: "adb",
      args: ["-s", "emulator-5554", "exec-out", "screencap", "-p"],
    });
  });

  test("--device unknown returns clear error", async () => {
    const result = await run(["--device", "missing", "--to", "/tmp/z.png"], {
      devicesPayload: { devices: [{ id: "expo-1", platform: "ios" }] },
    });
    expect(result.code).toBe(3);
    expect(result.stderr).toContain("unknown device 'missing'");
  });

  test("warns when device record lacks native_device_id", async () => {
    const result = await run(["--device", "expo-2", "--to", "/tmp/w.png"], {
      devicesPayload: { devices: [{ id: "expo-2", platform: "android" }] },
    });
    expect(result.code).toBe(0);
    expect(result.stderr).toContain("did not advertise a native device id");
    expect(result.stderr).toContain("--native-device");
  });
});

function captureProcessExit(fn: () => unknown): { code: number; stderr: string } {
  const originalExit = process.exit;
  const originalStderrWrite = process.stderr.write;
  let stderr = "";
  process.exit = ((code?: string | number | null) => {
    throw Object.assign(new Error("exit"), { code: typeof code === "number" ? code : 0 });
  }) as typeof process.exit;
  process.stderr.write = ((chunk: string | Uint8Array) => {
    stderr += String(chunk);
    return true;
  }) as typeof process.stderr.write;
  try {
    fn();
  } catch (err) {
    const code = (err as { code?: unknown }).code;
    if (typeof code === "number") return { code, stderr };
    throw err;
  } finally {
    process.exit = originalExit;
    process.stderr.write = originalStderrWrite;
  }
  throw new Error("expected process.exit");
}
