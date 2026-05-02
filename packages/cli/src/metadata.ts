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
    usage: "brna snapshot [--format json|md|yaml] [--diff] [--metro <url>] [--timeout <ms>] [--device <id>]",
    options: [
      { name: "--format", description: "Select markdown, JSON, or YAML output." },
      { name: "--diff", description: "Compare against the rolling session baseline." },
      { name: "--metro", description: "Metro base URL. Defaults to http://localhost:8081." },
      { name: "--timeout", description: "Request timeout in milliseconds." },
      { name: "--device", description: "Target a connected runtime device id." },
    ],
    examples: [
      "brna snapshot",
      "brna snap --format json",
      "brna snapshot --diff --device ios-sim",
    ],
  },
  {
    name: "act",
    description: "Resolve a selector against a fresh snapshot and dispatch one runtime action.",
    usage: "brna act <tap|click|long-press|type|scroll|key> [args] [--metro <url>] [--timeout <ms>] [--device <id>]",
    options: [
      { name: "--duration", description: "Long-press duration in milliseconds." },
      { name: "--direction", description: "Scroll direction: up, down, left, or right." },
      { name: "--by", description: "Scroll distance for scroll actions." },
      { name: "--metro", description: "Metro base URL. Defaults to http://localhost:8081." },
      { name: "--timeout", description: "Request timeout in milliseconds." },
      { name: "--device", description: "Target a connected runtime device id." },
    ],
    examples: [
      "brna act tap \"#save\"",
      "brna act long-press \"#menu\" --duration 750",
      "brna act type \"input:Email\" \"leo@example.com\"",
      "brna act scroll \"#feed\" --direction down --by 300",
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
];
