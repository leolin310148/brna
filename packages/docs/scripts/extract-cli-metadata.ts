import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { CLI_COMMANDS } from "../../cli/src/metadata.js";

const outPath = resolve(import.meta.dir, "../src/generated/cli-commands.json");
await mkdir(dirname(outPath), { recursive: true });
await writeFile(outPath, `${JSON.stringify(CLI_COMMANDS, null, 2)}\n`);
