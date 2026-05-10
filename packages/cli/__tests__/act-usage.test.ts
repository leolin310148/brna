import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

const CLI_PATH = resolve(import.meta.dir, "../src/cli.ts");

function run(args: string[]) {
  return spawnSync("bun", ["run", CLI_PATH, ...args], {
    env: { ...process.env, NO_COLOR: "1" },
    encoding: "utf8",
    timeout: 5000,
  });
}

describe("act usage errors (no Metro contact)", () => {
  test("no arguments prints metadata-backed global usage and exits 4", () => {
    const r = run([]);
    expect(r.status).toBe(4);
    expect(r.stderr).toContain("Usage:");
    expect(r.stderr).toContain("snapshot");
    expect(r.stderr).toContain("daemon");
    expect(r.stdout).toBe("");
  });

  test("global --help exits 0", () => {
    const r = run(["--help"]);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("Usage:");
    expect(r.stdout).toContain("snapshot");
    expect(r.stderr).toBe("");
  });

  test("subcommand --help exits 0", () => {
    const r = run(["snapshot", "--help"]);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("brna snapshot");
    expect(r.stdout).toContain("--diff");
    expect(r.stderr).toBe("");
  });

  test("help subcommand alias exits 0", () => {
    const r = run(["help", "act"]);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("brna act");
    expect(r.stdout).toContain("auto-select a single safe interactive match");
    expect(r.stdout).toContain("--at");
    expect(r.stdout).toContain("Pick a 0-indexed candidate");
    expect(r.stdout).toContain("brna act type");
    expect(r.stderr).toBe("");
  });

  test("unknown subcommand exits 4", () => {
    const r = run(["wat"]);
    expect(r.status).toBe(4);
    expect(r.stderr).toContain("unknown subcommand 'wat'");
    expect(r.stdout).toBe("");
  });

  test("unknown subcommand diagnostics escape terminal control characters", () => {
    const r = run(["wat\x1b[31m"]);
    expect(r.status).toBe(4);
    expect(r.stderr).toContain("unknown subcommand 'wat\\x1b[31m'");
    expect(r.stderr).not.toContain("\x1b");
    expect(r.stdout).toBe("");
  });

  test("help diagnostics escape terminal control characters in unknown subcommands", () => {
    const r = run(["help", "wat\x1b[31m"]);
    expect(r.status).toBe(4);
    expect(r.stderr).toContain("unknown subcommand 'wat\\x1b[31m'");
    expect(r.stderr).not.toContain("\x1b");
    expect(r.stdout).toBe("");
  });

  test("act with no verb exits 4", () => {
    const r = run(["act"]);
    expect(r.status).toBe(4);
    expect(r.stdout).toBe("");
  });

  test("unsupported verb exits 4", () => {
    const r = run(["act", "pinch", "#x"]);
    expect(r.status).toBe(4);
    expect(r.stderr).toContain("unsupported action 'pinch'");
    expect(r.stdout).toBe("");
  });

  test("unsupported verb diagnostics escape terminal control characters", () => {
    const r = run(["act", "pinch\x1b[31m", "#x"]);
    expect(r.status).toBe(4);
    expect(r.stderr).toContain("unsupported action 'pinch\\x1b[31m'");
    expect(r.stderr).not.toContain("\x1b");
    expect(r.stdout).toBe("");
  });

  test("missing swipe direction exits 4", () => {
    const r = run(["act", "swipe", "#x"]);
    expect(r.status).toBe(4);
    expect(r.stderr).toContain("missing --direction for act swipe");
    expect(r.stdout).toBe("");
  });

  test("unsupported key exits 4", () => {
    const r = run(["act", "key", "space"]);
    expect(r.status).toBe(4);
    expect(r.stderr).toContain("unsupported key 'space'");
    expect(r.stderr).toContain("expected tab|enter|escape");
    expect(r.stdout).toBe("");
  });

  test("missing key exits 4", () => {
    const r = run(["act", "key"]);
    expect(r.status).toBe(4);
    expect(r.stderr).toContain("missing key for act key");
    expect(r.stdout).toBe("");
  });

  test("missing type text exits 4", () => {
    const r = run(["act", "type", "input:Email"]);
    expect(r.status).toBe(4);
    expect(r.stderr).toContain("missing text for act type");
    expect(r.stdout).toBe("");
  });

  test("invalid long-press duration exits 4", () => {
    const r = run(["act", "long-press", "#m", "--duration", "abc"]);
    expect(r.status).toBe(4);
    expect(r.stderr).toContain("--duration");
    expect(r.stderr).toContain("positive integer");
    expect(r.stdout).toBe("");
  });

  test("missing scroll direction exits 4", () => {
    const r = run(["act", "scroll", "#feed"]);
    expect(r.status).toBe(4);
    expect(r.stderr).toContain("missing --direction for act scroll");
    expect(r.stdout).toBe("");
  });

  test("invalid scroll direction exits 4", () => {
    const r = run(["act", "scroll", "#feed", "--direction", "diagonal"]);
    expect(r.status).toBe(4);
    expect(r.stderr).toContain("unsupported scroll direction 'diagonal'");
    expect(r.stdout).toBe("");
  });

  test("invalid --by exits 4", () => {
    const r = run(["act", "scroll", "#feed", "--direction", "down", "--by", "0"]);
    expect(r.status).toBe(4);
    expect(r.stderr).toContain("--by");
    expect(r.stdout).toBe("");
  });

  test("malformed selector exits 4 before contacting Metro", () => {
    const r = run([
      "act", "tap", "button:",
      "--metro", "http://127.0.0.1:1", // intentionally unreachable
    ]);
    expect(r.status).toBe(4);
    expect(r.stderr).toContain("malformed selector");
    expect(r.stdout).toBe("");
  });

  test("missing selector exits 4", () => {
    const r = run(["act", "tap"]);
    expect(r.status).toBe(4);
    expect(r.stderr).toContain("missing selector");
    expect(r.stdout).toBe("");
  });

  test("malformed --metro URL exits 4", () => {
    const r = run(["act", "tap", "#x", "--metro", "not-a-url"]);
    expect(r.status).toBe(4);
    expect(r.stderr).toContain("malformed URL for '--metro'");
    expect(r.stdout).toBe("");
  });

  test("invalid --timeout exits 4", () => {
    const r = run(["act", "tap", "#x", "--timeout", "0"]);
    expect(r.status).toBe(4);
    expect(r.stderr).toContain("--timeout");
    expect(r.stdout).toBe("");
  });

  test("whitespace-only --at exits 4 before contacting Metro", () => {
    const r = run(["act", "tap", "#x", "--at", "   "]);
    expect(r.status).toBe(4);
    expect(r.stderr).toContain("missing value for '--at'");
    expect(r.stdout).toBe("");
  });
});
