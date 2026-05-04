import {
  DEFAULT_METRO_URL,
  DEFAULT_TIMEOUT_MS,
  diagnoseMetroResponse,
  fail,
  failWith,
  parseMetro,
  parseTimeout,
} from "./options.js";

interface DeviceInfo {
  id: string;
  platform?: string;
  os_version?: string;
  app_version?: string;
  app_name?: string;
  app_bundle_id?: string;
  registered_at?: number;
  last_seen_at?: number;
  live?: boolean;
}

interface DevicesPayload {
  devices: DeviceInfo[];
  recent_disconnected?: DeviceInfo[];
}

interface DevicesRuntime {
  fetch?: typeof fetch;
  stdout?: Pick<typeof process.stdout, "write">;
  stderr?: Pick<typeof process.stderr, "write">;
  exit?: (code: number) => never;
}

interface ParsedArgs {
  metro: string;
  timeoutMs: number;
  json: boolean;
}

function parseArgs(rest: string[]): ParsedArgs {
  let metro = DEFAULT_METRO_URL;
  let timeoutMs = DEFAULT_TIMEOUT_MS;
  let json = false;
  for (let i = 0; i < rest.length; i++) {
    const token = rest[i]!;
    if (token === "--metro") metro = parseMetro(rest[++i]);
    else if (token === "--timeout") timeoutMs = parseTimeout(rest[++i]);
    else if (token === "--json") json = true;
    else fail(4, `unknown flag '${token}'`);
  }
  return { metro, timeoutMs, json };
}

export async function runDevices(rest: string[], runtime: DevicesRuntime = {}): Promise<void> {
  const { metro, timeoutMs, json } = parseArgs(rest);
  const fetchImpl = runtime.fetch ?? fetch;
  const stdout = runtime.stdout ?? process.stdout;
  const stderr = runtime.stderr ?? process.stderr;
  const exit = runtime.exit ?? process.exit;

  const url = `${metro}/brna/devices`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let response: Response;
  try {
    response = await fetchImpl(url, { signal: controller.signal });
  } catch (err) {
    clearTimeout(timer);
    const e = err as { name?: string };
    if (e?.name === "AbortError") {
      failWith(2, `devices request timed out after ${timeoutMs}ms`, stderr, exit);
    }
    failWith(1, `could not connect to Metro at ${metro}`, stderr, exit);
  }
  clearTimeout(timer);

  if (!response.ok) {
    const diagnosis = await diagnoseMetroResponse(response, "devices endpoint");
    failWith(
      3,
      diagnosis ?? `unexpected HTTP ${response.status} from Metro`,
      stderr,
      exit,
    );
  }

  const diagnosis = await diagnoseMetroResponse(response, "devices endpoint");
  let payload: DevicesPayload;
  try {
    payload = (await response.json()) as DevicesPayload;
  } catch (err) {
    failWith(
      3,
      diagnosis ?? `malformed devices response: ${(err as Error).message}`,
      stderr,
      exit,
    );
  }
  const devices = Array.isArray(payload.devices) ? payload.devices : [];

  if (json) {
    stdout.write(JSON.stringify({
      devices,
      recent_disconnected: Array.isArray(payload.recent_disconnected)
        ? payload.recent_disconnected
        : [],
    }, null, 2));
    stdout.write("\n");
    exit(0);
  }

  if (devices.length === 0) {
    stdout.write("No devices connected. brna does not support Expo web runtimes; open an iOS/Android simulator or device.\n");
    exit(0);
  }

  stdout.write(formatDevicesTable(devices));
  exit(0);
}

export function formatDevicesTable(devices: DeviceInfo[]): string {
  const headers: string[] = ["ID", "PLATFORM", "OS", "APP"];
  const rows: string[][] = devices.map((d) => [
    d.id,
    d.platform ?? "unknown",
    d.os_version ?? "unknown",
    formatAppCell(d),
  ]);
  const widths = headers.map((h, i) =>
    Math.max(h.length, ...rows.map((r) => (r[i] ?? "").length)),
  );
  const fmt = (cells: string[]): string =>
    cells.map((c, i) => c.padEnd(widths[i] ?? 0)).join("  ").trimEnd();
  return [fmt(headers), ...rows.map(fmt)].join("\n") + "\n";
}

function formatAppCell(device: DeviceInfo): string {
  const label = device.app_name ?? device.app_bundle_id;
  if (label && device.app_version) return `${label} ${device.app_version}`;
  if (label) return label;
  if (device.app_version) return device.app_version;
  return "unknown";
}
