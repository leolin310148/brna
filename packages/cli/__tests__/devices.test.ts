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
  });

  test("--json emits JSON payload", async () => {
    const res = await run(["--json"], [{ id: "dev-a", platform: "ios" }]);
    expect(res.code).toBe(0);
    const parsed = JSON.parse(res.stdout) as { devices: Array<{ id: string }> };
    expect(parsed.devices).toHaveLength(1);
    expect(parsed.devices[0]!.id).toBe("dev-a");
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
});
