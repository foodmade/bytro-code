# Troubleshooting

Common problems when building or running Bytro Community Edition from source.

If none of these match, see [SUPPORT.md](../SUPPORT.md) for how to file a
useful bug report.

## Build and startup

### `Port 1420 is already in use`

Vite is configured with `strictPort: true` (`vite.config.ts`), so it fails
instead of picking another port — Tauri expects that exact port.

Find and stop whatever is holding it:

```bash
# macOS / Linux
lsof -ti:1420 | xargs kill

# Windows (PowerShell)
Get-NetTCPConnection -LocalPort 1420 | Select-Object -ExpandProperty OwningProcess | ForEach-Object { Stop-Process -Id $_ }
```

The usual cause is a previous `npm run tauri dev` that didn't shut down
cleanly.

### `sidecar/dist/bundle.mjs not found. Run 'npm run build:sidecar' first.`

Thrown by `scripts/prepare-resources.js` when the Sidecar bundle is missing.
Normally `npm run tauri dev` builds it for you, so this means the Sidecar
build failed earlier — scroll up for the real error. To fix directly:

```bash
npm --prefix sidecar ci
npm run build:sidecar
```

### `npm run tauri dev` fails before the window appears

Almost always missing platform prerequisites for Tauri 2 rather than a problem
with this project. Work through the
[Tauri 2 prerequisites guide](https://v2.tauri.app/start/prerequisites/) for
your OS, then verify:

```bash
rustc --version   # stable toolchain
node --version    # 20.19+ or 22.12+
npm --version     # 10+
```

On Linux you typically need `libwebkit2gtk-4.1-dev`, `libappindicator3-dev`,
`librsvg2-dev`, and `patchelf` — see `.github/workflows/ci.yml` for the exact
package list CI installs.

### The first build takes a very long time

Expected. The Rust host compiles from scratch on first run (several minutes,
longer on Windows). Later builds are incremental and much faster.

### `npm run ci:gate` fails on the Worker step

`ci:gate` includes the optional preview Worker, which requires **Node.js
22.12+** and its own dependencies:

```bash
npm --prefix services/site-preview-worker ci
```

If you are on Node 20, either switch to Node 22 or run the individual checks
instead of the full gate (see [Building from Source](BUILDING.md)).

## Providers and models

### A model returns "unauthorized" or "model not found"

Check, in this order: the key is for the provider you selected; the base URL
matches that provider; the model identifier is spelled exactly as the provider
publishes it. The
[Provider Configuration](PROVIDERS.md#troubleshooting) table covers this in
more detail.

### Claude or Codex sessions fail to start

Bytro needs a runtime for these two providers. It looks for an explicit path,
then a private managed install, then your `PATH`, and installs a pinned
package from npm if nothing is found — see
[how runtimes are resolved](PROVIDERS.md#how-bytro-finds-a-runtime).

If your network blocks the npm registry, install the runtime yourself and
point Bytro at it:

```bash
CLAUDE_CLI_PATH=/your/path/to/claude npm run tauri dev
```

### Ollama shows no models

Confirm Ollama is running and reachable at `http://localhost:11434`, and that
you have pulled at least one model (`ollama list`).

## Collecting logs

Set the Sidecar log level:

```bash
BYTRO_LOG_LEVEL=debug npm run tauri dev
```

Valid levels are `error`, `warn`, `info` (default), `debug`, and `trace`.
Prompts, arguments, credentials, and RPC bodies are never written at any
level — logs contain only event types, lengths, and hashes.

For a packaged build where DevTools is unavailable, use the capture helpers:

```bash
# macOS — writes two logs to your Desktop
./scripts/capture-mac-logs.sh

# Windows
scripts\capture-windows-logs.bat
```

Redact anything sensitive before attaching logs to an issue.
