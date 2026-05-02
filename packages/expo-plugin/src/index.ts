import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";

interface ExpoConfig {
  [key: string]: unknown;
}

type ConfigPlugin = (config: ExpoConfig) => ExpoConfig;

const BABEL_PLUGIN = "@brna/babel-plugin";
const METRO_WRAPPER = "@brna/metro-plugin";

const BABEL_TEMPLATE = `module.exports = function(api) {
  api.cache(true);
  return {
    presets: ['babel-preset-expo'],
    plugins: ['${BABEL_PLUGIN}'],
  };
};
`;

const METRO_TEMPLATE = `const { getDefaultConfig } = require('expo/metro-config');
const { withBrna } = require('${METRO_WRAPPER}');

const config = getDefaultConfig(__dirname);
module.exports = withBrna(config);
`;

const localRequire = createRequire(import.meta.url);

const withBrna: ConfigPlugin = (config) => {
  // Try to load @expo/config-plugins lazily so this plugin remains importable
  // in test contexts that lack a full Expo install. Real Expo CLI runs always
  // have @expo/config-plugins available.
  let withDangerousMod:
    | ((cfg: ExpoConfig, args: [string, (cfg: ExpoConfig) => Promise<ExpoConfig>]) => ExpoConfig)
    | undefined;
  try {
    const cp = localRequire("@expo/config-plugins") as {
      withDangerousMod: NonNullable<typeof withDangerousMod>;
    };
    withDangerousMod = cp.withDangerousMod;
  } catch {
    withDangerousMod = undefined;
  }
  if (!withDangerousMod) return config;
  return withDangerousMod(config, [
    "ios",
    async (cfg: ExpoConfig & { modRequest?: { projectRoot?: string } }) => {
      const root = cfg.modRequest?.projectRoot;
      if (typeof root === "string" && root.length > 0) {
        ensureBabelConfig(root);
        ensureMetroConfig(root);
      }
      return cfg;
    },
  ]);
};

export function ensureBabelConfig(projectRoot: string): "created" | "patched" | "ok" {
  const candidates = ["babel.config.js", "babel.config.cjs"];
  for (const name of candidates) {
    const p = join(projectRoot, name);
    if (existsSync(p)) {
      const text = readFileSync(p, "utf8");
      if (text.includes(BABEL_PLUGIN)) return "ok";
      writeFileSync(p, patchBabelConfig(text));
      return "patched";
    }
  }
  writeFileSync(join(projectRoot, "babel.config.js"), BABEL_TEMPLATE);
  return "created";
}

export function ensureMetroConfig(projectRoot: string): "created" | "patched" | "ok" {
  const candidates = ["metro.config.js", "metro.config.cjs"];
  for (const name of candidates) {
    const p = join(projectRoot, name);
    if (existsSync(p)) {
      const text = readFileSync(p, "utf8");
      if (text.includes(METRO_WRAPPER) || text.includes("withBrna")) return "ok";
      writeFileSync(p, patchMetroConfig(text));
      return "patched";
    }
  }
  writeFileSync(join(projectRoot, "metro.config.js"), METRO_TEMPLATE);
  return "created";
}

export function patchBabelConfig(text: string): string {
  if (text.includes(BABEL_PLUGIN)) return text;
  if (/plugins\s*:\s*\[/.test(text)) {
    return text.replace(/plugins\s*:\s*\[/, `plugins: ['${BABEL_PLUGIN}', `);
  }
  const presetsPattern = /(presets\s*:\s*\[[^\]]*\])(\s*,?)/m;
  if (presetsPattern.test(text)) {
    return text.replace(presetsPattern, `$1,\n    plugins: ['${BABEL_PLUGIN}']`);
  }
  const returnObjectPattern = /return\s*\{\s*/m;
  if (returnObjectPattern.test(text)) {
    return text.replace(returnObjectPattern, `return {\n    plugins: ['${BABEL_PLUGIN}'],\n    `);
  }
  return `${text.trimEnd()}\n\nmodule.exports.plugins = [...(module.exports.plugins || []), '${BABEL_PLUGIN}'];\n`;
}

export function patchMetroConfig(text: string): string {
  if (text.includes(METRO_WRAPPER) || text.includes("withBrna")) return text;
  const requireLine = `const { withBrna } = require('${METRO_WRAPPER}');`;
  const withRequire = `${requireLine}\n${text.trimStart()}`;
  const moduleExportPattern = /module\.exports\s*=\s*([^;\n]+);?/m;
  if (moduleExportPattern.test(withRequire)) {
    return withRequire.replace(moduleExportPattern, "module.exports = withBrna($1);");
  }
  return `${withRequire.trimEnd()}\n\nmodule.exports = withBrna(module.exports);\n`;
}

export default withBrna;
