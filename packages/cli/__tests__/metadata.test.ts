import { describe, expect, test } from "bun:test";
import { commandByName, formatCommandHelp, formatGlobalHelp } from "../src/metadata.js";

describe("CLI metadata", () => {
  test("snapshot help shows the overlay flag in usage", () => {
    const command = commandByName("snapshot");
    expect(command).toBeDefined();

    const help = formatCommandHelp(command!);
    expect(help).toContain("[--image --image-to <path> [--overlay]");
    expect(help).toContain("--overlay");
  });

  test("snapshot help shows native capture flags in image usage", () => {
    const command = commandByName("snapshot");
    expect(command).toBeDefined();

    const help = formatCommandHelp(command!);
    expect(help).toContain("[--native-device <id>]");
    expect(help).toContain("[--native-platform android|ios]");
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

  test("command help aligns options to the longest flag", () => {
    const command = commandByName("capture");
    expect(command).toBeDefined();

    const help = formatCommandHelp(command!);
    const optionLines = help.split("\n").filter((line) => line.startsWith("  --"));
    const descriptionColumns = optionLines.map((line) => line.search(/\s[A-Z]/));

    expect(new Set(descriptionColumns).size).toBe(1);
  });

  test("global help aligns command descriptions when aliases are shown", () => {
    const help = formatGlobalHelp();
    const commandLines = help
      .split("\n")
      .filter((line) => /^  (snapshot \(snap\)|act)\s/.test(line));

    expect(commandLines).toHaveLength(2);
    expect(commandLines[0]!.indexOf("Capture")).toBe(commandLines[1]!.indexOf("Resolve"));
  });
});
