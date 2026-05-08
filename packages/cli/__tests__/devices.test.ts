import { describe, expect, test } from "bun:test";
import { runDevices, formatDevicesTable } from "../src/devices.js";

interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

async function run(rest: string[], devices: unknown[]): Promise<RunResult> {
  let stdout = "";
  let stderr = "";
  try {
    await runDevices(rest, {
      fetch: async () => new Response(JSON.stringify({ devices }), { status: 200 }),
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
  throw new Error("expected runDevices to exit");
}

describe("brna devices", () => {
  test("prints table with multiple devices", async () => {
    const res = await run([], [
      { id: "dev-a", platform: "ios", os_version: "17.4" },
      { id: "dev-b", platform: "android", os_version: "14" },
    ]);
    expect(res.code).toBe(0);
    expect(res.stdout).toContain("dev-a");
    expect(res.stdout).toContain("dev-b");
    expect(res.stdout).toContain("ios");
    expect(res.stdout).toContain("android");
  });

  test("empty registry prints message", async () => {
    const res = await run([], []);
    expect(res.code).toBe(0);
    expect(res.stdout).toContain("No devices connected");
    expect(res.stdout).toContain("does not support Expo web runtimes");
  });

  test("--json emits JSON payload", async () => {
    const res = await run(["--json"], [{ id: "dev-a", platform: "ios" }]);
    expect(res.code).toBe(0);
    const parsed = JSON.parse(res.stdout) as { devices: Array<{ id: string }> };
    expect(parsed.devices).toHaveLength(1);
    expect(parsed.devices[0]!.id).toBe("dev-a");
  });

  test("unknown flag exits 4 via injected runtime", async () => {
    const res = await run(["--bogus"], []);
    expect(res.code).toBe(4);
    expect(res.stdout).toBe("");
    expect(res.stderr).toContain("unknown flag '--bogus'");
  });

  test("--metro validates missing and malformed values via injected runtime", async () => {
    const missing = await run(["--metro"], []);
    expect(missing.code).toBe(4);
    expect(missing.stderr).toContain("missing value for '--metro'");

    const malformed = await run(["--metro", "not-a-url"], []);
    expect(malformed.code).toBe(4);
    expect(malformed.stderr).toContain("malformed URL for '--metro': not-a-url");
  });

  test("--timeout validates positive integer values via injected runtime", async () => {
    const res = await run(["--timeout", "0"], []);
    expect(res.code).toBe(4);
    expect(res.stderr).toContain("'--timeout' must be a positive integer");
  });

  test("--timeout rejects non-decimal numeric syntax", async () => {
    const res = await run(["--timeout", "1e3"], []);
    expect(res.code).toBe(4);
    expect(res.stderr).toContain("'--timeout' must be a positive integer");
  });

  test("--timeout rejects whitespace-only values as missing", async () => {
    const res = await run(["--timeout", "   "], []);
    expect(res.code).toBe(4);
    expect(res.stderr).toContain("missing value for '--timeout'");
  });
});

describe("formatDevicesTable", () => {
  test("aligns columns deterministically", () => {
    const out = formatDevicesTable([
      { id: "dev-a", platform: "ios", os_version: "17.4" },
      { id: "longerid", platform: "android", os_version: "14" },
    ]);
    expect(out.split("\n")[0]).toContain("ID");
    expect(out).toContain("longerid");
  });

  test("renders app name when runtime supplied app metadata", () => {
    const out = formatDevicesTable([
      { id: "dev-a", platform: "ios", os_version: "17.4", app_name: "Hotcake", app_version: "1.2.3" },
    ]);
    expect(out).toContain("Hotcake");
    expect(out).toContain("1.2.3");
    expect(out).not.toContain("unknown");
  });

  test("renders 'unknown' when app metadata is absent", () => {
    const out = formatDevicesTable([{ id: "dev-a" }]);
    const appColumn = out.split("\n")[1]!;
    expect(appColumn).toContain("unknown");
  });

  test("escapes terminal control characters in table cells", () => {
    const out = formatDevicesTable([
      {
        id: "dev-\x1b[31mred\x1b[0m",
        platform: "ios\nsim",
        os_version: "17.4\r",
        app_name: "Hot\tcake",
        app_version: "1.2.3\x7f",
      },
    ]);

    expect(out).toContain("dev-\\x1b[31mred\\x1b[0m");
    expect(out).toContain("ios\\nsim");
    expect(out).toContain("17.4\\r");
    expect(out).toContain("Hot\\tcake");
    expect(out).toContain("1.2.3\\x7f");
    expect(out).not.toContain("\x1b");
    expect(out.trimEnd().split("\n")).toHaveLength(2);
  });
});

describe("brna devices --json", () => {
  test("omits absent app metadata fields", async () => {
    const res = await run(["--json"], [{ id: "dev-a", platform: "ios" }]);
    expect(res.code).toBe(0);
    const parsed = JSON.parse(res.stdout) as { devices: Array<Record<string, unknown>> };
    expect(parsed.devices[0]).toEqual({ id: "dev-a", platform: "ios" });
    expect(parsed.devices[0]).not.toHaveProperty("app_name");
    expect(parsed.devices[0]).not.toHaveProperty("app_bundle_id");
    expect(parsed.devices[0]).not.toHaveProperty("app_version");
  });

  test("preserves populated app metadata fields", async () => {
    const res = await run(["--json"], [
      { id: "dev-a", platform: "ios", app_name: "Hotcake", app_version: "1.2.3", app_bundle_id: "com.example.hotcake" },
    ]);
    expect(res.code).toBe(0);
    const parsed = JSON.parse(res.stdout) as { devices: Array<Record<string, unknown>> };
    expect(parsed.devices[0]!.app_name).toBe("Hotcake");
    expect(parsed.devices[0]!.app_bundle_id).toBe("com.example.hotcake");
    expect(parsed.devices[0]!.app_version).toBe("1.2.3");
  });
});
