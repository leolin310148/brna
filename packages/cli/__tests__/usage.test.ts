import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const CLI_PATH = resolve(import.meta.dir, "../src/cli.ts");
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function home(): string {
  const root = mkdtempSync(join(tmpdir(), "brna-cli-usage-"));
  roots.push(root);
  return root;
}

function stateDir(root: string): string {
  if (process.platform === "darwin") return join(root, "Library", "Application Support", "brna", "usage");
  if (process.platform === "win32") return join(root, "brna", "usage");
  return join(root, ".local", "state", "brna", "usage");
}

function run(root: string, args: string[], env: Record<string, string> = {}) {
  return spawnSync("bun", ["run", CLI_PATH, ...args], {
    cwd: root,
    env: {
      ...process.env,
      HOME: root,
      LOCALAPPDATA: root,
      XDG_STATE_HOME: join(root, ".local", "state"),
      BRNA_NO_DAEMON: "1",
      NODE_ENV: "development",
      CI: "",
      NO_COLOR: "1",
      ...env,
    },
    encoding: "utf8",
  });
}

describe("brna usage commands and CLI instrumentation", () => {
  test("records successful and unknown commands without sensitive argv", async () => {
    const root = home();
    const success = run(root, ["config", "show"], { BRNA_USAGE_LOG: "1", BRNA_CALLER: "codex" });
    expect(success.status).toBe(0);
    const secret = "private-command-secret";
    const unknown = run(root, [secret], { BRNA_USAGE_LOG: "1" });
    expect(unknown.status).toBe(4);

    const dir = stateDir(root);
    const file = (await readdir(dir)).find((name) => name.endsWith(".jsonl"))!;
    const raw = await readFile(join(dir, file), "utf8");
    const events = raw.trim().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(events.filter((event) => event.operation === "config")).toHaveLength(2);
    expect(events.filter((event) => event.operation === "cli.unknown")).toHaveLength(2);
    expect(events.find((event) => event.operation === "config")).toMatchObject({ caller: "codex", dimensions: { subcommand: "show" } });
    expect(raw).not.toContain(secret);
  });

  test("disabled collection writes no event files and usage management is not self-journaled", async () => {
    const root = home();
    expect(run(root, ["usage", "disable"]).status).toBe(0);
    expect(run(root, ["config", "show"]).status).toBe(0);
    expect(run(root, ["usage", "status"]).stdout).toContain("disabled (setting)");
    const files = await readdir(stateDir(root));
    expect(files.some((name) => name.endsWith(".jsonl"))).toBe(false);
    expect(files).toContain("settings.json");
  });

  test("summary and aggregate export expose metrics without local identifiers", async () => {
    const root = home();
    run(root, ["config", "show"], { BRNA_USAGE_LOG: "1" });
    const summary = run(root, ["usage", "summary", "--since", "1d", "--json"]);
    expect(summary.status).toBe(0);
    expect(JSON.parse(summary.stdout).totals.success).toBe(1);
    const target = join(root, "usage-report.json");
    const exported = run(root, ["usage", "export", "--since", "1d", "--to", target]);
    expect(exported.status).toBe(0);
    const report = await readFile(target, "utf8");
    expect(report).toContain("brna-usage-export/1");
    expect(report).not.toContain("operation_id");
    expect(report).not.toContain("project_id");
    expect(report).not.toContain("session_id");
  });

  test("unwritable usage location does not affect command output or exit code", async () => {
    const root = home();
    const fakeHome = join(root, "home-file");
    await writeFile(fakeHome, "not a directory", "utf8");
    const result = run(root, ["config", "show"], {
      HOME: fakeHome,
      LOCALAPPDATA: fakeHome,
      XDG_STATE_HOME: fakeHome,
      BRNA_USAGE_LOG: "1",
    });
    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    expect(JSON.parse(result.stdout)).toMatchObject({ path: null, config: {} });
  });
});
