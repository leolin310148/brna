import { readFile } from "node:fs/promises";
import { validateSnapshot, type Snapshot } from "@brna/schema";
import { fromJSON, toActiveLayerMarkdown, toJSON, toMarkdown } from "@brna/core";
import { escapeControlCharacters } from "./format.js";
import {
  DEFAULT_METRO_URL,
  DEFAULT_TIMEOUT_MS,
  DEVICE_HEADER,
  fail,
  failWith,
  parseDevice,
  parseMetro,
  parseTimeout,
} from "./options.js";

interface VerifyRuntime {
  fetch?: typeof fetch;
  readFile?: (path: string, encoding: "utf8") => Promise<string>;
  stdout?: Pick<typeof process.stdout, "write">;
  stderr?: Pick<typeof process.stderr, "write">;
  exit?: (code: number) => never;
}

interface ParsedArgs {
  metro: string;
  timeoutMs: number;
  device?: string;
  goldenPath: string;
  activeLayer: boolean;
}

function parseArgs(rest: string[]): ParsedArgs {
  let metro = DEFAULT_METRO_URL;
  let timeoutMs = DEFAULT_TIMEOUT_MS;
  let device: string | undefined;
  let goldenPath: string | undefined;
  let activeLayer = false;
  for (let i = 0; i < rest.length; i++) {
    const token = rest[i]!;
    if (token === "--metro") metro = parseMetro(rest[++i]);
    else if (token === "--timeout") timeoutMs = parseTimeout(rest[++i]);
    else if (token === "--device") device = parseDevice(rest[++i]);
    else if (token === "--active-layer") activeLayer = true;
    else if (token.startsWith("--")) fail(4, `unknown flag '${escapeControlCharacters(token)}'`);
    else if (goldenPath === undefined) goldenPath = token;
    else fail(4, `unexpected argument '${escapeControlCharacters(token)}'`);
  }
  if (goldenPath === undefined) {
    fail(4, "usage: brna verify <golden-path> [--active-layer] [--metro <url>] [--device <id>] [--timeout <ms>]");
  }
  const result: ParsedArgs = { metro, timeoutMs, goldenPath, activeLayer };
  if (device !== undefined) result.device = device;
  return result;
}

export async function runVerify(rest: string[], runtime: VerifyRuntime = {}): Promise<void> {
  const { metro, timeoutMs, device, goldenPath, activeLayer } = parseArgs(rest);
  const fetchImpl = runtime.fetch ?? fetch;
  const readImpl = runtime.readFile ?? readFile;
  const stdout = runtime.stdout ?? process.stdout;
  const stderr = runtime.stderr ?? process.stderr;
  const exit = runtime.exit ?? process.exit;

  let goldenText: string;
  try {
    goldenText = await readImpl(goldenPath, "utf8");
  } catch (err) {
    failWith(1, `could not read golden file '${goldenPath}': ${(err as Error).message}`, stderr, exit);
  }

  const format = inferGoldenFormat(goldenPath, goldenText);
  if (format === "json" && activeLayer) {
    failWith(4, "--active-layer is only supported for markdown golden files", stderr, exit);
  }
  const goldenNorm =
    format === "json"
      ? normalizeSnapshotJSON(parseGoldenJSON(goldenText, goldenPath, stderr, exit))
      : normalizeMarkdown(goldenText);

  const headers: Record<string, string> = {};
  if (device !== undefined) headers[DEVICE_HEADER] = device;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let response: Response;
  try {
    response = await fetchImpl(`${metro}/brna/snapshot`, { signal: controller.signal, headers });
  } catch (err) {
    clearTimeout(timer);
    const e = err as { name?: string };
    if (e?.name === "AbortError") {
      failWith(2, `snapshot timed out after ${timeoutMs}ms`, stderr, exit);
    }
    failWith(1, `could not connect to Metro at ${metro}`, stderr, exit);
  }
  clearTimeout(timer);

  if (response.status === 503) {
    failWith(3, "no runtime connected — start the app first", stderr, exit);
  }
  if (response.status === 404) {
    failWith(3, `unknown device '${escapeControlCharacters(device ?? "?")}'`, stderr, exit);
  }
  if (!response.ok) {
    failWith(3, `unexpected HTTP ${response.status} from Metro`, stderr, exit);
  }

  let snapshot: Snapshot;
  try {
    snapshot = (await response.json()) as Snapshot;
    validateSnapshot(snapshot);
  } catch (err) {
    failWith(3, `invalid snapshot from Metro: ${(err as Error).message}`, stderr, exit);
  }

  const freshNorm =
    format === "json"
      ? normalizeSnapshotJSON(snapshot)
      : normalizeMarkdown(activeLayer ? toActiveLayerMarkdown(snapshot) : toMarkdown(snapshot));

  if (goldenNorm === freshNorm) {
    stdout.write("✓ Verification passed\n");
    exit(0);
  }

  const diffText = unifiedDiff(goldenNorm, freshNorm, goldenPath, "current");
  stdout.write(diffText);
  if (!diffText.endsWith("\n")) stdout.write("\n");
  stderr.write("✗ Verification failed — snapshot does not match golden\n");
  exit(1);
}

type GoldenFormat = "md" | "json";

function inferGoldenFormat(path: string, text: string): GoldenFormat {
  const lower = path.toLowerCase();
  if (lower.endsWith(".json")) return "json";
  const trimmed = text.replace(/^﻿/, "").trimStart();
  return trimmed.startsWith("{") ? "json" : "md";
}

function parseGoldenJSON(
  text: string,
  goldenPath: string,
  stderr: Pick<typeof process.stderr, "write">,
  exit: (code: number) => never,
): Snapshot {
  try {
    const snapshot = fromJSON(text.replace(/^﻿/, ""));
    validateSnapshot(snapshot);
    return snapshot;
  } catch (err) {
    failWith(4, `invalid JSON golden '${goldenPath}': ${(err as Error).message}`, stderr, exit);
  }
}

function normalizeSnapshotJSON(snapshot: Snapshot): string {
  const normalized = JSON.parse(JSON.stringify(snapshot)) as Snapshot;
  normalized.meta.captured_at = "<ignored>";
  normalized.meta.session_id = "<ignored>";
  normalized.meta.snapshot_id = "<ignored>";
  return toJSON(normalized);
}

export function normalizeMarkdown(text: string): string {
  // Strip BOM, normalize line endings, drop trailing whitespace per line, and
  // collapse trailing blank lines so cosmetic differences (CRLF vs LF, trailing
  // spaces, missing final newline) don't cause spurious failures. Snapshot
  // markdown also carries volatile capture metadata in the header; normalize it
  // so unchanged trees can be used directly as goldens.
  const noBom = text.replace(/^﻿/, "");
  const lf = noBom.replace(/\r\n?/g, "\n");
  const trimmed = lf
    .split("\n")
    .map((l) => l.replace(/[ \t]+$/, ""))
    .map(normalizeVolatileMarkdownLine);
  while (trimmed.length > 0 && trimmed[trimmed.length - 1] === "") trimmed.pop();
  return trimmed.join("\n") + "\n";
}

function normalizeVolatileMarkdownLine(line: string): string {
  if (/^session:\s+.+\s+·\s+\d{4}-\d{2}-\d{2}T/.test(line)) {
    return "session: <ignored> · <ignored>";
  }
  return line;
}

export function unifiedDiff(a: string, b: string, aLabel: string, bLabel: string): string {
  const aLines = a.split("\n");
  const bLines = b.split("\n");
  // Drop the trailing "" produced by the final newline so line counts match
  // typical unified-diff conventions (each printed line is content).
  if (aLines[aLines.length - 1] === "") aLines.pop();
  if (bLines[bLines.length - 1] === "") bLines.pop();

  const hunks = diffLines(aLines, bLines);
  if (hunks.length === 0) return "";
  const header = [`--- ${aLabel}`, `+++ ${bLabel}`].join("\n") + "\n";
  return header + hunks.map(renderHunk).join("");
}

interface Hunk {
  aStart: number;
  bStart: number;
  ops: Array<{ op: " " | "-" | "+"; line: string }>;
}

function diffLines(a: string[], b: string[]): Hunk[] {
  // Myers-style LCS via DP. Lines are short for snapshots, so O(n*m) is fine.
  const n = a.length;
  const m = b.length;
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      if (a[i] === b[j]) dp[i]![j] = (dp[i + 1]![j + 1] ?? 0) + 1;
      else dp[i]![j] = Math.max(dp[i + 1]![j] ?? 0, dp[i]![j + 1] ?? 0);
    }
  }

  const ops: Array<{ op: " " | "-" | "+"; line: string; aIdx: number; bIdx: number }> = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      ops.push({ op: " ", line: a[i]!, aIdx: i, bIdx: j });
      i++;
      j++;
    } else if ((dp[i + 1]?.[j] ?? 0) >= (dp[i]?.[j + 1] ?? 0)) {
      ops.push({ op: "-", line: a[i]!, aIdx: i, bIdx: j });
      i++;
    } else {
      ops.push({ op: "+", line: b[j]!, aIdx: i, bIdx: j });
      j++;
    }
  }
  while (i < n) {
    ops.push({ op: "-", line: a[i]!, aIdx: i, bIdx: j });
    i++;
  }
  while (j < m) {
    ops.push({ op: "+", line: b[j]!, aIdx: i, bIdx: j });
    j++;
  }

  // Group consecutive non-equal ops (with one line of context) into hunks.
  const CONTEXT = 3;
  const hunks: Hunk[] = [];
  let k = 0;
  while (k < ops.length) {
    if (ops[k]!.op === " ") {
      k++;
      continue;
    }
    let start = k;
    while (start > 0 && k - start < CONTEXT && ops[start - 1]!.op === " ") start--;
    let end = k;
    while (end < ops.length) {
      if (ops[end]!.op !== " ") {
        end++;
        continue;
      }
      // include up to CONTEXT trailing equal lines
      let runEnd = end;
      while (runEnd < ops.length && ops[runEnd]!.op === " ") runEnd++;
      if (runEnd - end >= CONTEXT * 2 || runEnd === ops.length) {
        end = end + Math.min(CONTEXT, runEnd - end);
        break;
      }
      end = runEnd;
    }
    const slice = ops.slice(start, end);
    const aStart = slice[0]!.aIdx;
    const bStart = slice[0]!.bIdx;
    hunks.push({ aStart, bStart, ops: slice.map((o) => ({ op: o.op, line: o.line })) });
    k = end;
  }
  return hunks;
}

function renderHunk(hunk: Hunk): string {
  const aCount = hunk.ops.filter((o) => o.op !== "+").length;
  const bCount = hunk.ops.filter((o) => o.op !== "-").length;
  const header = `@@ -${hunk.aStart + 1},${aCount} +${hunk.bStart + 1},${bCount} @@\n`;
  const body = hunk.ops.map((o) => `${o.op}${o.line}\n`).join("");
  return header + body;
}
