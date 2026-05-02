export const DEFAULT_METRO_URL = "http://localhost:8081";
export const DEFAULT_TIMEOUT_MS = 5000;

export function fail(code: number, reason: string): never {
  process.stderr.write(`brna: ${reason}\n`);
  process.exit(code);
}

export function parseMetro(value: string | undefined): string {
  if (typeof value !== "string" || value.length === 0) {
    fail(4, "missing value for '--metro'");
  }
  try {
    const u = new URL(value);
    return `${u.protocol}//${u.host}`;
  } catch {
    fail(4, `malformed URL for '--metro': ${value}`);
  }
}

export function parseTimeout(value: string | undefined): number {
  if (typeof value !== "string") fail(4, "missing value for '--timeout'");
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0) {
    fail(4, `'--timeout' must be a positive integer, got '${value}'`);
  }
  return n;
}

export function parsePositiveInt(value: string | undefined, flag: string): number {
  if (typeof value !== "string") fail(4, `missing value for '${flag}'`);
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0) {
    fail(4, `'${flag}' must be a positive integer, got '${value}'`);
  }
  return n;
}

export function parseDevice(value: string | undefined): string {
  if (typeof value !== "string" || value.length === 0) {
    fail(4, "missing value for '--device'");
  }
  return value;
}

export const DEVICE_HEADER = "x-brna-device-id";

export function failWith(
  code: number,
  reason: string,
  stderr: Pick<typeof process.stderr, "write">,
  exit: (code: number) => never,
): never {
  stderr.write(`brna: ${reason}\n`);
  exit(code);
}
