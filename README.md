# brna

Agent-friendly snapshots and actions for React Native apps.

`brna` lets a coding agent inspect and drive a running React Native app without
guessing from screenshots. It exposes a structured snapshot of the current UI
and a small action API for tapping, typing, scrolling, pressing keys, and
checking what changed.

It is built for Expo and React Native development sessions where you want an
agent to understand the app screen like a developer would: labels, roles,
inputs, disabled state, source metadata, and stable selectors.

## What You Can Do

```sh
brna snapshot
brna act tap "#save"
brna act type "input:Email" "leo@example.com"
brna act scroll "#feed" --direction down --by 300
brna doctor
brna mcp
```

Use `brna snapshot` to read the screen. Use `brna act ...` to interact with the
screen. Use `brna mcp` when an agent client should access the same snapshot and
actions through the Model Context Protocol.

## Quick Start In An Expo App

Install the CLI and Expo integration packages:

```sh
npm install --save-dev @brna/cli @brna/expo-plugin
npm install @brna/runtime @brna/metro-plugin @brna/babel-plugin
```

Register the Expo plugin in `app.json`:

```json
{
  "expo": {
    "plugins": ["@brna/expo-plugin"]
  }
}
```

Start Metro and your app:

```sh
npx expo start
```

In another terminal, check the setup:

```sh
npx brna doctor
```

If `doctor` reports a missing Expo plugin, run:

```sh
npx brna doctor --fix
```

Once the app is running in a simulator, emulator, or device, capture a snapshot:

```sh
npx brna snapshot
```

The default Metro URL is `http://localhost:8081`. If your app uses another
port, pass it explicitly:

```sh
npx brna snapshot --metro http://localhost:19000
```

## CLI Guide

### `snapshot`

Capture the current UI from a connected runtime.

```sh
brna snapshot
brna snap --format json
brna snapshot --format yaml
brna snapshot --diff
brna snapshot --device ios-sim
```

Useful options:

- `--format json|md|yaml` selects the output format.
- `--diff` compares against the rolling session baseline.
- `--metro <url>` points at a non-default Metro server.
- `--device <id>` targets one connected runtime when several are available.
- `--timeout <ms>` changes the request timeout.

### `act`

Resolve a selector against a fresh snapshot and dispatch one action.

```sh
brna act tap "#save"
brna act click "button:Submit"
brna act type "input:Email" "leo@example.com"
brna act scroll "#feed" --direction down --by 300
brna act long-press "#menu" --duration 750
brna act key tab
```

Selectors can target explicit ids such as `#save` or semantic matches such as
`button:Submit` and `input:Email`. Prefer explicit `testID` values for workflows
that need to be stable over time.

### `devices`

List runtimes connected through the Metro bridge.

```sh
brna devices
brna devices --json
```

### `doctor`

Check Metro reachability, runtime connection, Babel instrumentation, and project
configuration.

```sh
brna doctor
brna doctor --fix
```

`--fix` can register the Expo plugin or patch direct Babel and Metro config
files after confirmation.

### `mcp`

Start the brna MCP server on stdio.

```sh
brna mcp
brna mcp --device ios-sim
```

The MCP server exposes the current snapshot and action tools so agent clients
can inspect and interact with the running app through one protocol.

## Manual Expo Setup

The Expo plugin is the recommended setup path. If you prefer direct config,
add the Babel plugin:

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

The Babel plugin injects `@brna/runtime/auto` into development entry files. The
runtime connects back to Metro only in development builds.

## Local Monorepo Development

This repository is a Bun workspace:

```text
packages/schema        Shared snapshot and action types
packages/core          Snapshot serialisation, selector parsing, and diffs
packages/runtime       In-app snapshot capture and action dispatch
packages/babel-plugin  Runtime injection and JSX annotations
packages/metro-plugin  Metro middleware and Expo integration helpers
packages/expo-plugin   Expo config plugin for brna setup
packages/cli           The brna CLI
packages/mcp           MCP server shim for agent clients
packages/docs          Public documentation site
```

Install dependencies and run the core checks:

```sh
bun install
bun run typecheck
bun test
```

Run the CLI from the workspace:

```sh
bun run packages/cli/src/cli.ts snapshot
bun run packages/cli/src/cli.ts doctor
```

Other useful maintainer commands:

```sh
bun run build:schema
bun --filter '@brna/docs' run extract:cli
bun --filter '@brna/docs' run dev
bun run e2e:expo-sample
```

## Compatibility

`brna doctor` checks the supported minimums:

- React `18.0.0` or newer
- React Native `0.74.0` or newer
- Expo `50.0.0` or newer for Expo projects

## Name

`brna` stands for Bring React Native Agent-friendly.
