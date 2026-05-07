export interface CliOptionMetadata {
  name: string;
  description: string;
}

export interface CliCommandMetadata {
  name: string;
  aliases?: string[];
  description: string;
  usage: string;
  options: CliOptionMetadata[];
  examples: string[];
}

export const DOCS_URL = "https://brna.dev/docs";

export const CLI_COMMANDS: CliCommandMetadata[] = [
  {
    name: "snapshot",
    aliases: ["snap"],
    description: "Capture the current app snapshot from a connected brna runtime.",
    usage: "brna snapshot [--format md|markdown|json|yaml] [--diff] [--active-layer] [--image --image-to <path>] [--metro <url>] [--timeout <ms>] [--device <id>]",
    options: [
      { name: "--format", description: "Select md/markdown, JSON, or YAML output." },
      { name: "--diff", description: "Compare against the rolling session baseline." },
      { name: "--active-layer", description: "Print only active modal, sheet, popover, toast, or overlay nodes in markdown output." },
      { name: "--image", description: "Also write a sidecar PNG screenshot. Requires --image-to." },
      { name: "--image-to", description: "Output PNG path for --image sidecar capture." },
      { name: "--overlay", description: "Annotate the sidecar PNG with snapshot bounds and short selector labels." },
      { name: "--metro", description: "Metro base URL. Defaults to http://localhost:8081." },
      { name: "--timeout", description: "Request timeout in milliseconds." },
      { name: "--device", description: "Target a connected runtime device id." },
      { name: "--native-device", description: "Override native screenshot target for --image." },
      { name: "--native-platform", description: "Force the native screenshot platform for --image." },
    ],
    examples: [
      "brna snapshot",
      "brna snapshot --active-layer",
      "brna snapshot --image --image-to screen.png",
      "brna snap --format json",
      "brna snapshot --diff --device ios-sim",
    ],
  },
  {
    name: "act",
    description: "Resolve a selector against a fresh snapshot, auto-select a single safe interactive match, and dispatch one runtime action.",
    usage: "brna act <tap|click|long-press|type|scroll|swipe|key> [args] [--at <index>] [--verify-change] [--metro <url>] [--timeout <ms>] [--device <id>]",
    options: [
      { name: "--duration", description: "Long-press duration in milliseconds." },
      { name: "--direction", description: "Scroll/swipe direction: up, down, left, or right." },
      { name: "--by", description: "Distance for scroll and swipe actions." },
      { name: "--at", description: "Pick a 0-indexed candidate when a selector matches multiple nodes." },
      { name: "--verify-change", description: "Warn when the action succeeds but the next snapshot has no tree diff." },
      { name: "--metro", description: "Metro base URL. Defaults to http://localhost:8081." },
      { name: "--timeout", description: "Request timeout in milliseconds." },
      { name: "--device", description: "Target a connected runtime device id." },
    ],
    examples: [
      "brna act tap \"#save\"",
      "brna act long-press \"#menu\" --duration 750",
      "brna act type \"input:Email\" \"leo@example.com\"",
      "brna act scroll \"#feed\" --direction down --by 300",
      "brna act tap \"#save\" --at 1",
      "brna act tap \"#save\" --verify-change",
      "brna act swipe \"#screen:root\" --direction up --by 600",
    ],
  },
  {
    name: "wait",
    description: "Poll snapshots until a selector appears (or disappears with --gone) or a timeout is reached.",
    usage: "brna wait <selector> [--gone] [--timeout <ms>] [--interval <ms>] [--metro <url>] [--device <id>]",
    options: [
      { name: "--gone", description: "Wait until the selector resolves to no nodes." },
      { name: "--timeout", description: "Total wait timeout in milliseconds (default 30000)." },
      { name: "--interval", description: "Polling cadence in milliseconds (default 500, minimum 100)." },
      { name: "--metro", description: "Metro base URL. Defaults to http://localhost:8081." },
      { name: "--device", description: "Target a connected runtime device id." },
    ],
    examples: [
      "brna wait \"text:Confirmed\"",
      "brna wait \"text:Loading\" --gone --timeout 5000",
      "brna wait \"button:Save\" --interval 250",
    ],
  },
  {
    name: "capture",
    description: "Write a PNG screenshot of the connected runtime device, optionally overlaid with brna snapshot bounds.",
    usage: "brna capture [--to <path>] [--overlay] [--metro <url>] [--device <id>] [--native-device <id>] [--native-platform android|ios] [--timeout <ms>]",
    options: [
      { name: "--to", description: "Output PNG path. Defaults to a session-scoped path printed to stdout." },
      { name: "--overlay", description: "Annotate the PNG with snapshot bounds and short selector labels." },
      { name: "--metro", description: "Metro base URL. Defaults to http://localhost:8081." },
      { name: "--device", description: "Target a connected brna runtime device id (used to look up native targets)." },
      { name: "--native-device", description: "Override native screenshot target — adb serial or simulator UDID." },
      { name: "--native-platform", description: "Force the native capture platform when no runtime is connected." },
      { name: "--timeout", description: "Request and native-capture timeout in milliseconds." },
    ],
    examples: [
      "brna capture --to screen.png",
      "brna capture --overlay --to overlay.png",
      "brna capture --native-platform android --native-device emulator-5554",
      "brna capture --native-platform ios --native-device booted",
    ],
  },
  {
    name: "doctor",
    description: "Check Metro/runtime connectivity and project configuration, with optional safe fixes.",
    usage: "brna doctor [--fix] [--metro <url>] [--timeout <ms>]",
    options: [
      { name: "--fix", description: "Apply safe Expo, Babel, and Metro configuration fixes after confirmation." },
      { name: "--metro", description: "Metro base URL. Defaults to http://localhost:8081." },
      { name: "--timeout", description: "Request timeout in milliseconds." },
    ],
    examples: [
      "brna doctor",
      "brna doctor --fix",
    ],
  },
  {
    name: "verify",
    description: "Compare a freshly captured live snapshot against a golden snapshot markdown or JSON file.",
    usage: "brna verify <golden.md|golden.json> [--active-layer] [--metro <url>] [--device <id>] [--timeout <ms>]",
    options: [
      { name: "--active-layer", description: "Compare only the currently active modal/layer projection." },
      { name: "--metro", description: "Metro base URL. Defaults to http://localhost:8081." },
      { name: "--device", description: "Target a connected runtime device id." },
      { name: "--timeout", description: "Request timeout in milliseconds." },
    ],
    examples: [
      "brna verify snapshot.md",
      "brna verify snapshot.json",
      "brna verify modal.md --active-layer",
      "brna verify snapshot.md --device ios-sim",
    ],
  },
  {
    name: "devices",
    description: "List brna runtimes connected through the Metro bridge.",
    usage: "brna devices [--json] [--metro <url>] [--timeout <ms>]",
    options: [
      { name: "--json", description: "Print the connected devices payload as JSON." },
      { name: "--metro", description: "Metro base URL. Defaults to http://localhost:8081." },
      { name: "--timeout", description: "Request timeout in milliseconds." },
    ],
    examples: ["brna devices", "brna devices --json"],
  },
  {
    name: "mcp",
    description: "Start the brna Model Context Protocol server on stdio.",
    usage: "brna mcp [--metro <url>] [--device <id>]",
    options: [
      { name: "--metro", description: "Metro base URL. Defaults to http://localhost:8081." },
      { name: "--device", description: "Target a connected runtime device id." },
    ],
    examples: ["brna mcp", "brna mcp --device ios-sim"],
  },
  {
    name: "config",
    description: "Manage local brna CLI configuration such as redaction rules.",
    usage: "brna config <init|show|path>",
    options: [],
    examples: [
      "brna config init",
      "brna config show",
      "brna config path",
    ],
  },
  {
    name: "logs",
    description: "Print recent runtime console/error log records captured by the brna runtime.",
    usage: "brna logs [--json] [--since <ms-or-timestamp>] [--level <level>] [--limit <n>] [--metro <url>] [--timeout <ms>] [--device <id>]",
    options: [
      { name: "--json", description: "Print log records as JSON." },
      { name: "--since", description: "Filter records to those at or after a duration ago (ms) or absolute ms timestamp." },
      { name: "--level", description: "Minimum level to include: debug|log|info|warn|error." },
      { name: "--limit", description: "Maximum number of records to return." },
      { name: "--metro", description: "Metro base URL. Defaults to http://localhost:8081." },
      { name: "--timeout", description: "Request timeout in milliseconds." },
      { name: "--device", description: "Target a connected runtime device id." },
    ],
    examples: [
      "brna logs",
      "brna logs --level warn",
      "brna logs --since 5000 --json",
    ],
  },
  {
    name: "network",
    description: "Print recent runtime fetch/XHR network records captured by the brna runtime.",
    usage: "brna network [--json] [--since <ms-or-timestamp>] [--method <verb>] [--status <code-or-range>] [--limit <n>] [--metro <url>] [--timeout <ms>] [--device <id>]",
    options: [
      { name: "--json", description: "Print network records as JSON." },
      { name: "--since", description: "Filter records to those at or after a duration ago (ms) or absolute ms timestamp." },
      { name: "--method", description: "Filter records by HTTP method (case-insensitive)." },
      { name: "--status", description: "Filter records by status code or range (e.g. 200, 200-299, 4xx)." },
      { name: "--limit", description: "Maximum number of records to return." },
      { name: "--metro", description: "Metro base URL. Defaults to http://localhost:8081." },
      { name: "--timeout", description: "Request timeout in milliseconds." },
      { name: "--device", description: "Target a connected runtime device id." },
    ],
    examples: [
      "brna network",
      "brna network --method POST",
      "brna network --status 4xx --json",
    ],
  },
  {
    name: "trace",
    description: "Record snapshot and action events for an agent session.",
    usage: "brna trace <start|stop|status|path|replay>",
    options: [],
    examples: [
      "brna trace start",
      "brna trace status",
      "brna trace stop",
      "brna trace replay trace.yaml",
    ],
  },
];

export function commandByName(name: string): CliCommandMetadata | undefined {
  return CLI_COMMANDS.find((command) => command.name === name || command.aliases?.includes(name));
}

export function formatGlobalHelp(): string {
  const commands = CLI_COMMANDS.map((command) => {
    const aliases = command.aliases?.length ? ` (${command.aliases.join(", ")})` : "";
    return `  ${command.name}${aliases.padEnd(Math.max(0, 13 - command.name.length))} ${command.description}`;
  }).join("\n");
  return [
    "brna - agent-friendly snapshot and action surface for React Native apps",
    "",
    "Usage:",
    "  brna <command> [args]",
    "",
    "Commands:",
    commands,
    "",
    "Run 'brna <command> --help' for command-specific examples.",
    `Docs: ${DOCS_URL}`,
  ].join("\n") + "\n";
}

export function formatCommandHelp(command: CliCommandMetadata): string {
  const aliases = command.aliases?.length ? `\nAliases:\n  ${command.aliases.join(", ")}` : "";
  const options = command.options.length
    ? `\nOptions:\n${command.options.map((option) => `  ${option.name.padEnd(12)} ${option.description}`).join("\n")}`
    : "";
  const examples = command.examples.length
    ? `\nExamples:\n${command.examples.map((example) => `  ${example}`).join("\n")}`
    : "";
  return [
    command.description,
    "",
    "Usage:",
    `  ${command.usage}`,
    aliases,
    options,
    examples,
  ].join("\n").replace(/\n{3,}/g, "\n\n").trimEnd() + "\n";
}
