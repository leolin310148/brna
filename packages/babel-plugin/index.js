"use strict";

const path = require("node:path");
const crypto = require("node:crypto");

const RUNTIME_AUTO_SPECIFIER = "@brna/runtime/auto";

const ENTRY_BASENAMES = new Set([
  "AppEntry.js",
  "AppEntry.ts",
  "AppEntry.tsx",
  "entry.js",
  "entry.ts",
  "entry.tsx",
  "expo-router-entry.js",
  "index.js",
  "index.ts",
  "index.tsx",
]);

const ENTRY_PARENT_PACKAGES = new Set(["expo", "expo-router"]);

function isEntryFilename(filename) {
  if (!filename) return false;
  const normalised = String(filename).split(path.sep).join("/");
  const basename = path.basename(normalised);
  if (!ENTRY_BASENAMES.has(basename)) return false;

  const idx = normalised.lastIndexOf("/node_modules/");
  if (idx !== -1) {
    const after = normalised.slice(idx + "/node_modules/".length);
    const pkg = after.split("/", 1)[0] || "";
    return ENTRY_PARENT_PACKAGES.has(pkg);
  }
  return true;
}

function getStateFilename(state) {
  return (
    (state && state.filename) ||
    (state && state.file && state.file.opts && state.file.opts.filename) ||
    undefined
  );
}

function getStateCwd(state) {
  return (
    (state && state.cwd) ||
    (state && state.file && state.file.opts && state.file.opts.cwd) ||
    process.cwd()
  );
}

function relativeFilename(filename, cwd) {
  if (!filename) return null;
  let rel;
  try {
    rel = path.relative(cwd, filename);
  } catch {
    rel = filename;
  }
  if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) {
    rel = path.basename(filename);
  }
  return rel.split(path.sep).join("/");
}

function hasSpreadAttribute(openingElement) {
  for (const attr of openingElement.attributes) {
    if (attr.type === "JSXSpreadAttribute") {
      // Spread may include brna props at runtime — be conservative and skip injection.
      return true;
    }
  }
  return false;
}

function hasAttribute(openingElement, name) {
  return openingElement.attributes.some(
    (attr) =>
      attr.type === "JSXAttribute" &&
      attr.name &&
      attr.name.type === "JSXIdentifier" &&
      attr.name.name === name,
  );
}

function stableElementId(sourceValue) {
  return crypto.createHash("sha256").update(sourceValue).digest("hex").slice(0, 12);
}

function componentNameFromId(id) {
  if (!id) return null;
  if (id.type === "Identifier") return id.name;
  return null;
}

function hasDisplayNameAssignment(programPath, name) {
  let found = false;
  programPath.traverse({
    AssignmentExpression(path) {
      const left = path.node.left;
      if (
        left.type === "MemberExpression" &&
        !left.computed &&
        left.object.type === "Identifier" &&
        left.object.name === name &&
        left.property.type === "Identifier" &&
        left.property.name === "displayName"
      ) {
        found = true;
        path.stop();
      }
    },
  });
  return found;
}

function collectDisplayNameTargets(programPath) {
  const targets = [];
  const seen = new Set();
  const add = (name) => {
    if (!name || seen.has(name)) return;
    seen.add(name);
    targets.push(name);
  };

  for (const stmtPath of programPath.get("body")) {
    if (stmtPath.isFunctionDeclaration()) {
      add(componentNameFromId(stmtPath.node.id));
      continue;
    }
    if (stmtPath.isVariableDeclaration()) {
      for (const decl of stmtPath.node.declarations) {
        const name = componentNameFromId(decl.id);
        const init = decl.init;
        if (!name || !init) continue;
        if (
          init.type === "ArrowFunctionExpression" ||
          init.type === "FunctionExpression" ||
          init.type === "CallExpression"
        ) {
          add(name);
        }
      }
    }
  }
  return targets.filter((name) => /^[A-Z]/.test(name) && !hasDisplayNameAssignment(programPath, name));
}

module.exports = function brnaInjectAutoEntry(api) {
  const t = api && api.types ? api.types : require("@babel/types");

  return {
    name: "brna-inject-auto-entry",
    visitor: {
      Program: {
        enter(programPath, state) {
          if (process.env.NODE_ENV === "production") return;
          if (state.brnaInjected) return;

          const filename = getStateFilename(state);

          if (!isEntryFilename(filename)) return;

          const already = programPath.node.body.some(
            (n) =>
              n.type === "ImportDeclaration" &&
              n.source &&
              n.source.value === RUNTIME_AUTO_SPECIFIER,
          );
          if (already) {
            state.brnaInjected = true;
            return;
          }

          try {
            programPath.node.body.unshift(
              t.importDeclaration([], t.stringLiteral(RUNTIME_AUTO_SPECIFIER)),
            );
            state.brnaInjected = true;
          } catch (err) {
            // Surface as a Metro-visible warning but never crash the build.
            // eslint-disable-next-line no-console
            console.warn(
              "[brna] failed to inject runtime entry import: " +
                (err && err.message ? err.message : String(err)),
            );
          }
        },
        exit(programPath) {
          if (process.env.NODE_ENV === "production") return;
          for (const name of collectDisplayNameTargets(programPath)) {
            programPath.pushContainer(
              "body",
              t.expressionStatement(
                t.assignmentExpression(
                  "=",
                  t.memberExpression(t.identifier(name), t.identifier("displayName")),
                  t.logicalExpression(
                    "||",
                    t.memberExpression(t.identifier(name), t.identifier("displayName")),
                    t.stringLiteral(name),
                  ),
                ),
              ),
            );
          }
        },
      },
      JSXOpeningElement(astPath, state) {
        if (process.env.NODE_ENV === "production") return;

        const node = astPath.node;
        if (hasSpreadAttribute(node)) return;

        const loc = node.loc || (astPath.parent && astPath.parent.loc);
        if (!loc || !loc.start) return;

        const filename = getStateFilename(state);
        if (!filename) return;

        const cwd = getStateCwd(state);
        const relative = relativeFilename(filename, cwd);
        if (!relative) return;
        if (relative.indexOf("node_modules/") !== -1) return;

        const sourceValue = `${relative}:${loc.start.line}:${loc.start.column}`;
        if (!hasAttribute(node, "__brnaSource")) {
          node.attributes.push(
            t.jsxAttribute(t.jsxIdentifier("__brnaSource"), t.stringLiteral(sourceValue)),
          );
        }
        if (!hasAttribute(node, "__brna_id")) {
          node.attributes.push(
            t.jsxAttribute(t.jsxIdentifier("__brna_id"), t.stringLiteral(stableElementId(sourceValue))),
          );
        }
      },
    },
  };
};

module.exports.isEntryFilename = isEntryFilename;
module.exports.relativeFilename = relativeFilename;
module.exports.stableElementId = stableElementId;
