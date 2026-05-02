#!/usr/bin/env bun
import { writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { toJSON, toMarkdown, toYAML } from "../../src/serialise/index.js";
import { toDiffJSON, toDiffMarkdown, toDiffYAML } from "../../src/diff/index.js";
import { FIXTURES } from "./index.js";
import { DIFF_FIXTURES } from "./diffs/index.js";

const here = dirname(fileURLToPath(import.meta.url));

for (const { name, snapshot } of FIXTURES) {
  writeFileSync(join(here, `${name}.json`), toJSON(snapshot));
  writeFileSync(join(here, `${name}.yaml`), toYAML(snapshot));
  writeFileSync(join(here, `${name}.md`), toMarkdown(snapshot));
  console.log(`generated ${name}.{json,yaml,md}`);
}

for (const { name, diff } of DIFF_FIXTURES) {
  writeFileSync(join(here, "diffs", `${name}.json`), toDiffJSON(diff));
  writeFileSync(join(here, "diffs", `${name}.yaml`), toDiffYAML(diff));
  writeFileSync(join(here, "diffs", `${name}.md`), toDiffMarkdown(diff));
  console.log(`generated diffs/${name}.{json,yaml,md}`);
}
