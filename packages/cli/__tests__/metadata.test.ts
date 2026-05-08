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
});
