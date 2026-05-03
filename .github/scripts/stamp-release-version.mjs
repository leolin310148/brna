import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const version = process.argv[2];

if (!version) {
  throw new Error("Usage: node .github/scripts/stamp-release-version.mjs <version>");
}

if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(version)) {
  throw new Error(`Release tag must be a semver version, got ${version}`);
}

const cwd = process.cwd();
const rootPath = join(cwd, "package.json");
const root = JSON.parse(readFileSync(rootPath, "utf8"));
const packageFiles = [rootPath];

for (const workspace of root.workspaces ?? []) {
  if (workspace.endsWith("/*")) {
    const base = join(cwd, workspace.slice(0, -2));
    for (const entry of readdirSync(base)) {
      const packagePath = join(base, entry, "package.json");
      if (statSync(join(base, entry)).isDirectory() && existsSync(packagePath)) {
        packageFiles.push(packagePath);
      }
    }
  } else {
    const packagePath = join(cwd, workspace, "package.json");
    if (existsSync(packagePath)) packageFiles.push(packagePath);
  }
}

const internalPackageNames = new Set();
for (const packagePath of packageFiles) {
  const pkg = JSON.parse(readFileSync(packagePath, "utf8"));
  if (pkg.name?.startsWith("@brna/")) internalPackageNames.add(pkg.name);
}

for (const packagePath of packageFiles) {
  const pkg = JSON.parse(readFileSync(packagePath, "utf8"));
  pkg.version = version;

  for (const field of ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"]) {
    if (!pkg[field]) continue;
    for (const name of internalPackageNames) {
      if (pkg[field][name] && pkg[field][name] !== "workspace:*") {
        pkg[field][name] = `^${version}`;
      }
    }
  }

  writeFileSync(packagePath, `${JSON.stringify(pkg, null, 2)}\n`);
}
