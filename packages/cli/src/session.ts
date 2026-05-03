import { closeSync, fstatSync, openSync } from "node:fs";
import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { tmpdir as osTmpdir } from "node:os";
import { join } from "node:path";
import { fromJSON, toJSON } from "@brna/core";
import { validateSnapshot, type Snapshot } from "@brna/schema";

const CACHE_TTL_MS = 86_400_000;
const CACHE_FILE = "last-snapshot.json";

let memoizedSessionId: string | null = null;

export interface SessionIdInputs {
  ttyIno?: number | bigint;
  noTty?: boolean;
  ppid?: number;
  pid?: number;
}

export interface SessionCacheOptions {
  sessionId?: string;
  tmpdir?: string;
  now?: () => number;
  pid?: number;
}

export function getSessionId(): string {
  if (memoizedSessionId === null) {
    memoizedSessionId = resolveSessionId();
  }
  return memoizedSessionId;
}

export function resetSessionIdForTests(): void {
  memoizedSessionId = null;
}

export function resolveSessionId(inputs: SessionIdInputs = {}): string {
  const explicit = process.env.BRNA_SESSION_ID;
  if (typeof explicit === "string" && explicit.length > 0) return `env-${safeSessionKey(explicit)}`;

  const ttyIno = inputs.ttyIno ?? readTtyInode(inputs.noTty);
  if (ttyIno !== null) return `tty-${Number(ttyIno).toString(16)}`;

  const ppid = inputs.ppid ?? process.ppid;
  if (Number.isInteger(ppid) && ppid > 1) return `ppid-${ppid}`;

  const pid = inputs.pid ?? process.pid;
  return `pid-${pid}`;
}

export function getCacheDir(options: SessionCacheOptions = {}): string {
  return join(options.tmpdir ?? osTmpdir(), "brna", "session", options.sessionId ?? getSessionId());
}

export function snapshotSessionId(snapshot: Snapshot): string {
  const explicit = process.env.BRNA_SESSION_ID;
  if (typeof explicit === "string" && explicit.length > 0) return `env-${safeSessionKey(explicit)}`;
  return `runtime-${safeSessionKey(snapshot.meta.session_id)}`;
}

export async function writeSnapshotCache(
  snapshot: Snapshot,
  options: SessionCacheOptions = {},
): Promise<string | null> {
  const dir = getCacheDir({ ...options, sessionId: options.sessionId ?? snapshotSessionId(snapshot) });
  const target = join(dir, CACHE_FILE);
  const tmp = join(dir, `${CACHE_FILE}.tmp-${options.pid ?? process.pid}`);
  try {
    await mkdir(dir, { recursive: true, mode: 0o700 });
    await writeFile(tmp, toJSON(snapshot), "utf8");
    await rename(tmp, target);
    return null;
  } catch (err) {
    return errorReason(err);
  }
}

export async function readSnapshotCache(options: SessionCacheOptions = {}): Promise<Snapshot | null> {
  const target = join(getCacheDir(options), CACHE_FILE);
  let info: Awaited<ReturnType<typeof stat>>;
  try {
    info = await stat(target);
  } catch {
    return null;
  }

  const now = options.now?.() ?? Date.now();
  if (now - info.mtimeMs > CACHE_TTL_MS) return null;

  try {
    const snapshot = fromJSON(await readFile(target, "utf8"));
    validateSnapshot(snapshot);
    return snapshot;
  } catch {
    return null;
  }
}

function readTtyInode(skip: boolean | undefined): number | bigint | null {
  if (skip) return null;
  let fd: number | null = null;
  try {
    fd = openSync("/dev/tty", "r");
    return fstatSync(fd).ino;
  } catch {
    return null;
  } finally {
    if (fd !== null) closeSync(fd);
  }
}

function errorReason(err: unknown): string {
  const code = (err as { code?: unknown })?.code;
  if (typeof code === "string" && code.length > 0) return code;
  const message = (err as { message?: unknown })?.message;
  return typeof message === "string" && message.length > 0 ? message : "unknown";
}

function safeSessionKey(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 128) || "default";
}
