# brna

React Native UI snapshots and actions for coding agents.

`brna` gives an agent a structured, text-first view of a running React Native
app and a small action surface for interacting with it. It is designed for
Expo and React Native development workflows where screenshots are too lossy for
reliable agent feedback.

## Packages

This repository is a Bun workspace:

```text
packages/schema        Shared snapshot and action types
packages/core          Snapshot serialisation, selector parsing, and diffs
packages/runtime       In-app snapshot capture and action dispatch
packages/babel-plugin  Runtime injection and JSX annotations
packages/metro-plugin  Metro middleware and Expo integration helpers
packages/cli           The brna CLI
packages/mcp           MCP server shim for agent clients
packages/docs          Public documentation site
```

## Install

This project is currently published as scoped packages under `@brna`.

For local development inside this monorepo:

```sh
bun install
bun run typecheck
bun test
```

## Expo Setup

Install the runtime, Metro plugin, and Babel plugin in your Expo app. During
local package development, file dependencies are convenient:

```json
{
  "devDependencies": {
    "@brna/runtime": "file:../../brna/packages/runtime",
    "@brna/metro-plugin": "file:../../brna/packages/metro-plugin",
    "@brna/babel-plugin": "file:../../brna/packages/babel-plugin"
  }
}
```

Add the Babel plugin:

```js
module.exports = function (api) {
  api.cache(true);
  return {
    presets: ["babel-preset-expo"],
    plugins: ["@brna/babel-plugin"],
  };
};
```

Wrap the Metro config:

```js
const { getDefaultConfig } = require("expo/metro-config");
const { withBrna } = require("@brna/metro-plugin");

const config = getDefaultConfig(__dirname);

module.exports = withBrna(config);
```

## CLI

Capture a snapshot from a running Metro session:

```sh
brna snapshot
```

Run an action against a selector:

```sh
brna act tap "#save"
brna act type "input:Email" "leo@example.com"
brna act scroll "#feed" --direction down --by 300
brna act long-press "#menu" --duration 750
brna act key tab
```

Both commands accept Metro connection and timeout options. Run `brna --help`
or the package docs site for the current command reference.

## Development

Common commands:

```sh
bun run typecheck
bun test
bun --filter '@brna/schema' build:schema
bun --filter '@brna/docs' run extract:cli
bun --filter '@brna/docs' run dev
```

## Name

`brna` stands for Bring React Native Agent-friendly.
