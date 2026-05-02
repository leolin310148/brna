#!/usr/bin/env bun
import { runSnapshot } from "./snapshot.js";
import { runAct } from "./act.js";
import { runDevices } from "./devices.js";
import { runDoctor } from "./doctor.js";
import { runVerify } from "./verify.js";
import { runMcp } from "./mcp.js";
import { runConfig } from "./config.js";
import { runTrace } from "./trace.js";
import { DOCS_URL } from "./metadata.js";

const argv = process.argv.slice(2);
if (argv.length === 0) {
  process.stderr.write(
    `brna: usage: brna <snapshot|snap|act|devices|doctor|verify|mcp|config|trace> [args]\nDocs: ${DOCS_URL}\n`,
  );
  process.exit(4);
}

const [subcommand, ...rest] = argv;
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
