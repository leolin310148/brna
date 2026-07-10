import type { UsageDimensions } from "./types.js";

const CLI_COMMANDS = new Set([
  "snapshot", "act", "wait", "capture", "doctor", "verify", "devices", "mcp", "config", "logs", "network", "trace", "daemon",
]);
const ACTIONS = new Set(["tap", "click", "long-press", "type", "scroll", "swipe", "key"]);
const DIRECTIONS = new Set(["up", "down", "left", "right"]);
const FORMATS = new Set(["md", "markdown", "json", "yaml"]);
const PHASES = new Set(["parse", "connect", "snapshot", "resolve", "dispatch", "verify", "serialize", "internal"]);
const ERROR_CODES = new Set([
  "cli.invalid_argument", "config.invalid", "metro.unreachable", "runtime.not_connected", "runtime.timeout",
  "request.in_flight", "selector.invalid", "selector.not_found", "selector.ambiguous", "action.refused",
  "action.no_observed_change", "snapshot.invalid", "verify.mismatch", "runtime.failure", "internal.unexpected",
]);
const DIMENSION_KEYS = new Set([
  "format", "diff", "target_supplied", "active_layer", "image", "overlay", "verify_change", "at_supplied", "direction",
  "gone", "json", "fix", "filter_supplied", "native_platform", "subcommand", "caller_supplied",
]);
const METRIC_KEYS = new Set(["match_count", "retry_count", "record_count", "node_count", "warning_count", "output_bytes_bucket", "http_status_class"]);

export interface SanitizedInvocation {
  operation: string;
  dimensions?: UsageDimensions;
}

export function sanitizeCliInvocation(argv: string[]): SanitizedInvocation | null {
  const first = argv[0];
  if (first === "usage") return null;
  if (first === undefined) return { operation: "cli.unknown" };
  if (first === "--help" || first === "-h" || first === "help") return { operation: "help" };
  const command = first === "snap" ? "snapshot" : first;
  if (!CLI_COMMANDS.has(command)) return { operation: "cli.unknown" };
  if (argv.includes("--help") || argv.includes("-h")) return { operation: `help.${command}` };

  if (command === "act") {
    const rawAction = argv[1];
    const action = rawAction && ACTIONS.has(rawAction) ? (rawAction === "click" ? "tap" : rawAction.replace("-", "_")) : "unknown";
    return { operation: `act.${action}`, dimensions: cliDimensions(command, argv) };
  }
  return { operation: command, dimensions: cliDimensions(command, argv) };
}

export function sanitizeMcpResource(uri: unknown): SanitizedInvocation {
  const operation = uri === "brna://current/snapshot"
    ? "resource.snapshot"
    : uri === "brna://current/logs"
      ? "resource.logs"
      : uri === "brna://current/network"
        ? "resource.network"
        : "mcp.unknown";
  return { operation };
}

export function sanitizeMcpTool(name: unknown, args: unknown): SanitizedInvocation {
  const known = typeof name === "string" && ["tap", "type", "scroll", "swipe", "long_press", "key", "logs", "network"].includes(name);
  if (!known) return { operation: "mcp.unknown" };
  const values = args && typeof args === "object" ? args as Record<string, unknown> : {};
  const dimensions: UsageDimensions = {};
  if (["tap", "type", "scroll", "swipe", "long_press"].includes(name)) dimensions.at_supplied = Number.isInteger(values.at);
  if ((name === "scroll" || name === "swipe") && typeof values.direction === "string" && DIRECTIONS.has(values.direction)) {
    dimensions.direction = values.direction;
  }
  if (name === "logs" || name === "network") dimensions.filter_supplied = Object.keys(values).length > 0;
  return { operation: name === "logs" || name === "network" ? name : `act.${name}`, ...(Object.keys(dimensions).length ? { dimensions } : {}) };
}

export function sanitizeDimensions(value: UsageDimensions | undefined, kind: "dimensions" | "metrics"): UsageDimensions | undefined {
  if (!value) return undefined;
  const allowed = kind === "dimensions" ? DIMENSION_KEYS : METRIC_KEYS;
  const result: UsageDimensions = {};
  for (const [key, item] of Object.entries(value)) {
    if (!allowed.has(key)) continue;
    if (typeof item !== "string" && typeof item !== "number" && typeof item !== "boolean") continue;
    if (typeof item === "number" && !Number.isFinite(item)) continue;
    result[key] = typeof item === "string" ? item.slice(0, 32) : item;
  }
  return Object.keys(result).length > 0 ? result : undefined;
}

export function sanitizeErrorCode(value: string | undefined): string | undefined {
  return value && ERROR_CODES.has(value) ? value : undefined;
}

export function sanitizePhase(value: string | undefined): string | undefined {
  return value && PHASES.has(value) ? value : undefined;
}

function cliDimensions(command: string, argv: string[]): UsageDimensions | undefined {
  const dimensions: UsageDimensions = {};
  if (command === "snapshot") {
    const format = flagValue(argv, "--format");
    if (format && FORMATS.has(format)) dimensions.format = format === "markdown" ? "md" : format;
    dimensions.diff = argv.includes("--diff");
    dimensions.target_supplied = argv.includes("--target");
    dimensions.active_layer = argv.includes("--active-layer");
    dimensions.image = argv.includes("--image");
    dimensions.overlay = argv.includes("--overlay");
  } else if (command === "act") {
    dimensions.verify_change = argv.includes("--verify-change");
    dimensions.at_supplied = argv.includes("--at");
    const direction = flagValue(argv, "--direction");
    if (direction && DIRECTIONS.has(direction)) dimensions.direction = direction;
  } else if (command === "wait") {
    dimensions.gone = argv.includes("--gone");
  } else if (command === "capture") {
    dimensions.overlay = argv.includes("--overlay");
    const platform = flagValue(argv, "--native-platform");
    if (platform === "ios" || platform === "android") dimensions.native_platform = platform;
  } else if (command === "doctor") {
    dimensions.fix = argv.includes("--fix");
  } else if (command === "devices" || command === "logs" || command === "network") {
    dimensions.json = argv.includes("--json");
    if (command === "logs" || command === "network") dimensions.filter_supplied = argv.some((token) => token === "--since" || token === "--level" || token === "--method" || token === "--status" || token === "--limit");
  } else if (["config", "trace", "daemon"].includes(command)) {
    const sub = argv[1];
    const allowed = command === "config" ? ["init", "show", "path"] : command === "trace" ? ["start", "stop", "status", "path", "replay"] : ["status", "stop"];
    if (sub && allowed.includes(sub)) dimensions.subcommand = sub;
  }
  return Object.keys(dimensions).length > 0 ? dimensions : undefined;
}

function flagValue(argv: string[], flag: string): string | undefined {
  const index = argv.indexOf(flag);
  return index >= 0 ? argv[index + 1] : undefined;
}
