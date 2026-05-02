import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";

const METRO_URL = process.env.BRNA_E2E_METRO_URL;
const CLI_PATH = resolve(import.meta.dir, "../packages/cli/src/cli.ts");
const TIMEOUT_MS = "10000";

interface ProcResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

async function brna(args: string[], opts: { metro?: string } = {}): Promise<ProcResult> {
  const metro = opts.metro ?? METRO_URL;
  if (!metro) throw new Error("BRNA_E2E_METRO_URL is required");

  const proc = Bun.spawn(
    ["bun", "run", CLI_PATH, ...args, "--metro", metro, "--timeout", TIMEOUT_MS],
    {
      env: { ...process.env, NO_COLOR: "1" },
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const [stdout, stderr, status] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { status, stdout, stderr };
}

async function snapshot(format: "md" | "json" = "md"): Promise<string> {
  const args = format === "md" ? ["snapshot"] : ["snapshot", "--format", format];
  const result = await brna(args);
  expect(result.status, result.stderr).toBe(0);
  return result.stdout;
}

async function waitForSnapshot(
  predicate: (md: string) => boolean,
  label: string,
  attempts = 20,
): Promise<string> {
  let last = "";
  for (let i = 0; i < attempts; i++) {
    last = await snapshot();
    if (predicate(last)) return last;
    await Bun.sleep(100);
  }
  throw new Error(`timed out waiting for ${label}\n\nLast snapshot:\n${last}`);
}

async function act(args: string[], expectedStatus = 0): Promise<ProcResult> {
  const result = await brna(["act", ...args]);
  expect(result.status, result.stderr).toBe(expectedStatus);
  if (expectedStatus === 0) await Bun.sleep(100);
  return result;
}

async function ensureHome(): Promise<void> {
  for (let i = 0; i < 4; i++) {
    const md = await snapshot();
    if (md.includes("list#screen:home")) return;
    if (md.includes("button#close-inner")) {
      await act(["tap", "#close-inner"]);
      continue;
    }
    if (md.includes("button#close-outer")) {
      await act(["tap", "#close-outer"]);
      continue;
    }
    if (md.includes("button#close-sheet")) {
      await act(["tap", "#close-sheet"]);
      continue;
    }
    await act(["tap", "button:Back"]);
  }
  throw new Error("could not return to sample home screen");
}

async function openCase(testID: string, screenID: string): Promise<string> {
  await ensureHome();
  await act(["tap", `#${testID}`]);
  const md = await snapshot();
  expect(md).toContain(`list#${screenID}`);
  return md;
}

const maybeDescribe = METRO_URL ? describe : describe.skip;

maybeDescribe("Expo sample developing workflows", () => {
  test(
    "snapshot, actions, selector failures, modals, lists, a11y metadata, and error recovery",
    async () => {
      const devices = await brna(["devices"]);
      expect(devices.status, devices.stderr).toBe(0);
      expect(devices.stdout).toContain("ID");

      await openCase("case:form", "screen:form");
      await act(["type", "#input-email", "leo@example.com"]);
      await act(["type", "#input-password", "secret123"]);
      await act(["type", "#input-bio", "Building with an agent"]);
      const form = await snapshot();
      expect(form).toContain('input#input-email "Email" = "leo@example.com"');
      expect(form).toContain('input#input-password "Password" = "secret123" [secure]');
      expect(form).toContain('input#input-bio "Bio" = "Building with an agent"');
      expect(form).toContain('input#input-account "Account ID" = "acct_8fz2kq" [readonly]');

      await openCase("case:disabled", "screen:disabled");
      const disabledTap = await act(["tap", "#btn-signup"], 5);
      expect(disabledTap.stderr).toContain("target_disabled");
      await act(["type", "#disabled-email", "leo@example.com"]);
      const enabled = await snapshot();
      expect(enabled).toContain('button#btn-signup "Sign up"');
      expect(enabled).not.toContain('button#btn-signup "Sign up" [disabled]');
      await act(["tap", "#btn-signup"]);
      expect(await snapshot()).toContain("last action: Sign up");

      await openCase("case:duplicates", "screen:duplicates");
      const ambiguous = await act(["tap", "button:__Add__"], 3);
      expect(ambiguous.stderr).toContain("ambiguous");
      const firstCandidate = ambiguous.stderr.match(/auto:[a-f0-9]+(?:#\d+)?/)?.[0];
      expect(firstCandidate).toBeTruthy();
      await act(["tap", `#${firstCandidate}`]);

      await openCase("case:modals", "screen:modals");
      await act(["tap", "#open-modal"]);
      await waitForSnapshot(
        (md) => md.includes('button#open-nested "Open address editor"'),
        "outer modal",
      );
      await act(["tap", "#open-nested"]);
      const nestedModal = await waitForSnapshot(
        (md) => md.includes('button#close-inner "Done"'),
        "nested modal",
      );
      expect(nestedModal).toContain('button#close-inner "Done"');
      expect(nestedModal).toContain("Nested modal");
      await act(["tap", "#close-inner"]);
      await act(["tap", "#close-outer"]);
      const afterModal = await waitForSnapshot(
        (md) => !md.includes('button#open-nested "Open address editor"'),
        "outer modal dismissal",
      );
      expect(afterModal).toContain("list#screen:modals");
      expect(afterModal).not.toContain('button#open-nested "Open address editor"');

      await openCase("case:lists", "screen:lists");
      const listBefore = await snapshot();
      expect(listBefore).toContain("Item 1");
      await act(["scroll", "#long-list", "--direction", "down", "--by", "600"]);
      const listAfter = await snapshot();
      expect(listAfter).toContain("list#long-list");
      expect(listAfter).not.toEqual(listBefore);

      await openCase("case:a11y-demo", "screen:a11y-demo");
      const a11yJson = JSON.parse(await snapshot("json")) as {
        meta?: { source?: string };
        tree?: unknown;
      };
      const jsonText = JSON.stringify(a11yJson);
      expect(a11yJson.meta?.source).toContain("App.tsx");
      expect(jsonText).toContain("a11y-add-btn");
      expect(jsonText).toContain("Adds the item to your cart");
      expect(jsonText).toContain("a11y-volume-slider");
      expect(jsonText).toContain('"range"');
      expect(jsonText).toContain('"loading"');

      const connectionFailure = await brna(["snapshot"], { metro: "http://127.0.0.1:1" });
      expect(connectionFailure.status).toBe(1);
      expect(connectionFailure.stderr).toContain("could not connect to Metro");
    },
    120_000,
  );
});
