"use strict";

const path = require("node:path");
const fs = require("node:fs");
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
const PACKAGE_MAIN_CACHE = new Map();
const EXTENSION_RE = /\.(mjs|cjs|js|jsx|ts|tsx)$/;

function normalisePath(value) {
  return String(value).split(path.sep).join("/");
}

function withoutKnownExtension(value) {
  return value.replace(EXTENSION_RE, "");
}

function bundlePathFromMain(main) {
  const raw = typeof main === "string" && main.trim().length > 0 ? main.trim() : "index";
  const withoutDot = raw.startsWith("./") ? raw.slice(2) : raw;
  const withoutExt = withoutKnownExtension(withoutDot);
  if (withoutExt.startsWith("node_modules/")) return withoutExt;
  if (withoutExt === "expo-router/entry" || withoutExt.startsWith("@")) {
    return `node_modules/${withoutExt}`;
  }
  if (
    !withoutExt.startsWith(".") &&
    withoutExt.includes("/") &&
    !withoutExt.startsWith("src/") &&
    !withoutExt.startsWith("app/")
  ) {
    return `node_modules/${withoutExt}`;
  }
  return withoutExt.replace(/^\/+/, "");
}

function projectRelativeFilename(filename, cwd) {
  if (!filename || !cwd) return null;
  let rel;
  try {
    rel = path.relative(cwd, filename);
  } catch {
    return null;
  }
  if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) return null;
  return normalisePath(rel);
}

function packageMainForCwd(cwd) {
  const root = cwd || process.cwd();
  const key = path.resolve(root);
  if (PACKAGE_MAIN_CACHE.has(key)) return PACKAGE_MAIN_CACHE.get(key);

  let main;
  try {
    const raw = fs.readFileSync(path.join(key, "package.json"), "utf8");
    const pkg = JSON.parse(raw);
    if (typeof pkg.main === "string") main = pkg.main;
  } catch {
    main = undefined;
  }
  PACKAGE_MAIN_CACHE.set(key, main);
  return main;
}

function legacyIsEntryFilename(filename) {
  if (!filename) return false;
  const normalised = normalisePath(filename);
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

function isEntryFilename(filename, options = undefined) {
  if (!filename) return false;

  const hasProjectContext = !!options && ("cwd" in options || "main" in options);
  if (!hasProjectContext) return legacyIsEntryFilename(filename);

  const rel = projectRelativeFilename(filename, options.cwd);
  if (!rel) return false;

  return withoutKnownExtension(rel) === bundlePathFromMain(options.main);
}

function getStateFilename(state) {
  return (
    (state && state.filename) ||
    (state && state.file && state.file.opts && state.file.opts.filename) ||
    undefined
  );
}

function getEntryMain(state) {
  const opts = (state && state.opts) || {};
  if (typeof opts.entry === "string") return opts.entry;
  if (typeof opts.entryMain === "string") return opts.entryMain;
  if (typeof opts.main === "string") return opts.main;
  return packageMainForCwd(getStateCwd(state));
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

const COMPONENT_FACTORY_NAMES = new Set([
  "forwardRef",
  "memo",
  "lazy",
  "observer",
]);

function isComponentFactoryCallee(callee) {
  if (!callee) return false;
  if (callee.type === "Identifier") {
    return COMPONENT_FACTORY_NAMES.has(callee.name);
  }
  if (
    callee.type === "MemberExpression" &&
    !callee.computed &&
    callee.property &&
    callee.property.type === "Identifier"
  ) {
    return COMPONENT_FACTORY_NAMES.has(callee.property.name);
  }
  return false;
}

function containsJsx(rootPath) {
  if (!rootPath) return false;
  let found = false;
  rootPath.traverse({
    JSXElement(innerPath) {
      found = true;
      innerPath.stop();
    },
    JSXFragment(innerPath) {
      found = true;
      innerPath.stop();
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
      const name = componentNameFromId(stmtPath.node.id);
      if (name && containsJsx(stmtPath)) add(name);
      continue;
    }
    if (stmtPath.isVariableDeclaration()) {
      for (const declPath of stmtPath.get("declarations")) {
        const decl = declPath.node;
        const name = componentNameFromId(decl.id);
        const init = decl.init;
        if (!name || !init) continue;
        if (
          init.type === "ArrowFunctionExpression" ||
          init.type === "FunctionExpression"
        ) {
          if (containsJsx(declPath.get("init"))) add(name);
        } else if (init.type === "CallExpression") {
          if (isComponentFactoryCallee(init.callee)) add(name);
        }
      }
    }
  }
  return targets.filter((name) => /^[A-Z]/.test(name) && !hasDisplayNameAssignment(programPath, name));
}

function isRuntimeAutoRequire(node) {
  return (
    node &&
    node.type === "ExpressionStatement" &&
    node.expression &&
    node.expression.type === "CallExpression" &&
    node.expression.callee &&
    node.expression.callee.type === "Identifier" &&
    node.expression.callee.name === "require" &&
    node.expression.arguments &&
    node.expression.arguments.length === 1 &&
    node.expression.arguments[0] &&
    node.expression.arguments[0].type === "StringLiteral" &&
    node.expression.arguments[0].value === RUNTIME_AUTO_SPECIFIER
  );
}

function isRuntimeAutoImport(node) {
  return (
    node &&
    node.type === "ImportDeclaration" &&
    node.source &&
    node.source.value === RUNTIME_AUTO_SPECIFIER
  );
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

          if (!isEntryFilename(filename, { cwd: getStateCwd(state), main: getEntryMain(state) })) return;

          const already = programPath.node.body.some(
            (n) => isRuntimeAutoImport(n) || isRuntimeAutoRequire(n),
          );
          if (already) {
            state.brnaInjected = true;
            return;
          }

          try {
            programPath.node.body.unshift(
              t.expressionStatement(
                t.callExpression(t.identifier("require"), [
                  t.stringLiteral(RUNTIME_AUTO_SPECIFIER),
                ]),
              ),
            );
            state.brnaInjected = true;
          } catch (err) {
            // Surface as a Metro-visible warning but never crash the build.
            // eslint-disable-next-line no-console
            console.warn(
              "[brna] failed to inject runtime entry require: " +
                (err && err.message ? err.message : String(err)),
            );
          }
        },
        exit(programPath, state) {
          if (process.env.NODE_ENV === "production") return;
          const filename = getStateFilename(state);
          if (filename) {
            const normalised = String(filename).split(path.sep).join("/");
            if (normalised.indexOf("/node_modules/") !== -1) return;
          }
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
module.exports.bundlePathFromMain = bundlePathFromMain;
module.exports.relativeFilename = relativeFilename;
module.exports.stableElementId = stableElementId;
