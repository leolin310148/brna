// Expo CLI loads this file to discover the config plugin.
// `dist/index.cjs` is produced by `bun run build`.
const mod = require('./dist/index.cjs');
module.exports = mod && mod.default ? mod.default : mod;
