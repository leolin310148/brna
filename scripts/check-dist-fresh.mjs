import { existsSync, statSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { join } from "node:path";

const checks = [
  {
    name: "@brna/runtime",
    sources: ["packages/runtime/src"],
    outputs: ["packages/runtime/dist/index.js", "packages/runtime/dist/auto.js"],
  },
  {
    name: "@brna/metro-plugin",
    sources: ["packages/metro-plugin/src"],
    outputs: ["packages/metro-plugin/dist/index.cjs"],
  },
  {
    name: "@brna/expo-plugin",
    sources: ["packages/expo-plugin/src"],
    outputs: ["packages/expo-plugin/dist/index.cjs"],
  },
];

let failed = false;

for (const check of checks) {
  const newestSource = await newestMtime(check.sources);
  const oldestOutput = oldestExistingMtime(check.outputs);
  if (oldestOutput === null) {
    failed = true;
    console.error(`${check.name}: missing dist output; run bun run build:packages`);
    continue;
  }
  if (newestSource > oldestOutput) {
    failed = true;
    console.error(`${check.name}: dist is older than source; run bun run build:packages`);
  }
}

if (failed) process.exit(1);

async function newestMtime(paths) {
  let newest = 0;
  for (const path of paths) {
    for (const file of await filesUnder(path)) {
      newest = Math.max(newest, statSync(file).mtimeMs);
    }
  }
  return newest;
}

function oldestExistingMtime(paths) {
  let oldest = Number.POSITIVE_INFINITY;
  for (const path of paths) {
    if (!existsSync(path)) return null;
    oldest = Math.min(oldest, statSync(path).mtimeMs);
  }
  return oldest;
}

async function filesUnder(path) {
  const stat = statSync(path);
  if (stat.isFile()) return [path];
  const out = [];
  for (const entry of await readdir(path, { withFileTypes: true })) {
    const child = join(path, entry.name);
    if (entry.isDirectory()) {
      out.push(...await filesUnder(child));
    } else if (entry.isFile()) {
      out.push(child);
    }
  }
  return out;
}
