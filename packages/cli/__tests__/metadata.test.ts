import { describe, expect, test } from "bun:test";
import { commandByName, formatCommandHelp } from "../src/metadata.js";

describe("CLI metadata", () => {
  test("snapshot help shows the overlay flag in usage", () => {
    const command = commandByName("snapshot");
    expect(command).toBeDefined();

    const help = formatCommandHelp(command!);
    expect(help).toContain("[--image --image-to <path> [--overlay]]");
    expect(help).toContain("--overlay");
  });

  test("metro option help documents port shorthand", () => {
    const command = commandByName("snapshot");
    expect(command).toBeDefined();

    const help = formatCommandHelp(command!);
    expect(help).toContain("[--metro <url-or-port>]");
    expect(help).toContain("Metro base URL or bare port");
  });

  test("daemon help documents management subcommands", () => {
    const command = commandByName("daemon");
    expect(command).toBeDefined();

    const help = formatCommandHelp(command!);
    expect(help).toContain("brna daemon <status|stop>");
    expect(help).toContain("brna daemon status");
  });
});
