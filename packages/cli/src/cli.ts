#!/usr/bin/env node
import { runSnapshot } from "./snapshot.js";
import { runAct } from "./act.js";
import { runDevices } from "./devices.js";
import { runDoctor } from "./doctor.js";
import { runVerify } from "./verify.js";
import { runMcp } from "./mcp.js";
import { runConfig } from "./config.js";
import { runTrace } from "./trace.js";
import { DOCS_URL, commandByName, formatCommandHelp, formatGlobalHelp } from "./metadata.js";

const argv = process.argv.slice(2);
if (argv.length === 0) {
  process.stderr.write(
    `brna: usage: brna <snapshot|snap|act|devices|doctor|verify|mcp|config|trace> [args]\nDocs: ${DOCS_URL}\n`,
  );
  process.exit(4);
}

const subcommand = argv[0]!;
const rest = argv.slice(1);
if (subcommand === "--help" || subcommand === "-h" || subcommand === "help") {
  const commandName = rest[0];
  if (commandName === undefined) {
    process.stdout.write(formatGlobalHelp());
    process.exit(0);
  }
  const command = commandByName(commandName);
  if (!command) {
    process.stderr.write(`brna: unknown subcommand '${commandName}'\n`);
    process.exit(4);
  }
  process.stdout.write(formatCommandHelp(command));
  process.exit(0);
}

const commandHelp = rest.includes("--help") || rest.includes("-h");
const command = commandByName(subcommand);
if (commandHelp) {
  if (!command) {
    process.stderr.write(`brna: unknown subcommand '${subcommand}'\n`);
    process.exit(4);
  }
  process.stdout.write(formatCommandHelp(command));
  process.exit(0);
}

if (subcommand === "snapshot" || subcommand === "snap") {
  void runSnapshot(rest);
} else if (subcommand === "act") {
  void runAct(rest);
} else if (subcommand === "devices") {
  void runDevices(rest);
} else if (subcommand === "doctor") {
  void runDoctor(rest);
} else if (subcommand === "verify") {
  void runVerify(rest);
} else if (subcommand === "mcp") {
  void runMcp(rest);
} else if (subcommand === "config") {
  void runConfig(rest);
} else if (subcommand === "trace") {
  void runTrace(rest);
} else {
  process.stderr.write(`brna: unknown subcommand '${subcommand}'\n`);
  process.exit(4);
}
