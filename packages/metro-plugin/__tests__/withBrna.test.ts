import { describe, expect, test } from "bun:test";
import { withBrna } from "../src/withBrna.js";

type ResolverConfig = {
  unstable_enablePackageExports?: boolean;
  unstable_enableSymlinks?: boolean;
};

type TestConfig = {
  resolver?: ResolverConfig;
};

describe("withBrna", () => {
  test("enables package exports without forcing symlink resolver overrides", () => {
    const out = withBrna({ resolver: {} } as TestConfig);

    expect(out.resolver?.unstable_enablePackageExports).toBe(true);
    expect(out.resolver).not.toHaveProperty("unstable_enableSymlinks");
  });

  test("preserves caller-provided symlink resolver settings", () => {
    const disabled = withBrna({
      resolver: { unstable_enableSymlinks: false },
    } as TestConfig);
    const enabled = withBrna({
      resolver: { unstable_enableSymlinks: true },
    } as TestConfig);

    expect(disabled.resolver?.unstable_enableSymlinks).toBe(false);
    expect(enabled.resolver?.unstable_enableSymlinks).toBe(true);
  });
});
