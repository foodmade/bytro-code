# Bytro Community Edition

> Local-first desktop workspace for coding agents. Bring your own model
> credentials and locally installed runtimes.

Bytro Community Edition is a public, self-managed desktop workspace. It
combines AI chat, project files, code review, Git, terminals, previews, MCP
tools, reusable skills, and multi-agent collaboration inside a Tauri desktop
application.

The Community Edition is designed to run on your computer. It has no Bytro
account, no Bytro-hosted model credentials, no managed CLI/runtime downloads,
and no official cloud updater.

> **Pre-release status:** the Community Edition is being prepared for its first
> public release. Build from source only after reviewing the current limitations
> and security notes.

## Community Edition at a glance

### Included

- Streaming conversations with locally configured providers and CLI runtimes.
- Bring-your-own-key profiles with custom model names and base URLs.
- Import of supported local provider configuration.
- Claude-compatible, Codex/OpenAI-compatible, Gemini-compatible, generic
  OpenAI-compatible, and local Ollama workflows where the corresponding runtime
  or credential is available.
- Project file tree, editor, diffs, checkpoints, and change review.
- Integrated PTY terminals and development-server discovery.
- Git status, staging, commits, branches, history, stash, pull, and push.
- Multiple conversations, local history, context compaction, per-turn/context
  token metadata, and a local workspace activity heatmap.
- MCP server configuration, project/user skills, and slash commands.
- Multi-agent teams, task routing, inboxes, and live agent status.
- Local project preview and an optional self-hosted Cloudflare Worker for
  publishing temporary static previews.
- Local speech-to-text when a supported Whisper runtime/model is configured.

### Deliberately not included

- Bytro sign-in, registration, subscriptions, balance, invitations, or profile
  services.
- Bytro official models or shared official API credentials.
- OpenPencil/Canvas integration or its bundled resources.
- Cloud-backed AI usage and billing dashboards.
- Downloading or updating provider CLIs or core-toolchain runtimes from Bytro
  infrastructure.
- Automatic installation or management of third-party CLI memory plugins,
  including `claude-mem`.
- Frontend, Sidecar, or native hotpatch delivery from Bytro infrastructure.
- Hosted remote-control/tunnel services.
- Private R2 release scripts or an `npm run release` one-click publication
  command.

Token and context data is recorded locally where the selected provider exposes
it. The workspace activity heatmap uses that local data; the removed cloud
usage/billing dashboard is not required.

For the complete boundary, see
[Community Edition](docs/COMMUNITY_EDITION.md). Publication criteria are
tracked in the public
[open-source readiness checklist](docs/OPEN_SOURCE_READINESS.md).

## How it works

```text
┌──────────────────────────────────────────────────────────────┐
│ React + TypeScript                                          │
│ chat · files · editor · Git · terminal · teams · MCP/skills │
└──────────────────────────────┬───────────────────────────────┘
                               │ typed Tauri IPC + events
┌──────────────────────────────▼───────────────────────────────┐
│ Tauri + Rust                                                │
│ desktop lifecycle · filesystem · PTY · Git · SQLite · IPC   │
└──────────────────────────────┬───────────────────────────────┘
                               │ NDJSON over local stdio
┌──────────────────────────────▼───────────────────────────────┐
│ Node.js Sidecar                                             │
│ provider/CLI adapters · streaming · tools · MCP · teams     │
└──────────────────────────────┬───────────────────────────────┘
                               │ user-selected endpoints/runtimes
                        Model providers and local CLIs
```

The frontend does not receive direct filesystem or process access. Privileged
desktop operations pass through Rust commands, while provider and CLI traffic
is isolated in the local Node.js Sidecar. Conversations and workspace state
are stored locally.

Read [Architecture](docs/ARCHITECTURE.md) for process boundaries, data flow,
failure behavior, and security assumptions.

## Requirements

- Node.js 20 or newer (Node.js 22 or newer for the optional preview Worker)
- npm 10 or newer
- Rust stable toolchain
- Platform prerequisites required by
  [Tauri 2](https://v2.tauri.app/start/prerequisites/)
- Git
- At least one supported local CLI runtime or provider API key

Provider-owned login may still be required by a locally installed CLI. That is
separate from a Bytro application account.

Claude CLI and Codex CLI are optional third-party programs that you install
and authenticate separately. This repository does not bundle, download, or
update either CLI. By installing or using a CLI, you accept the provider's
applicable license and service terms. The upstream Codex CLI source is
Apache-2.0 licensed; Claude CLI is governed by Anthropic's applicable terms.
See [Provider configuration](docs/PROVIDERS.md) before enabling either runtime.

## Run from source

```bash
git clone <your-fork-url>
cd bytro-community
npm ci
npm --prefix sidecar ci
npm run tauri dev
```

Do not put credentials in committed files. The example file is only for the
optional self-hosted preview Worker:

```bash
cp .env.example .env.local
```

Configure model profiles inside the application or import a supported local
configuration. Provider credentials and CLI paths may also be inherited from
the environment used to launch Bytro. See
[Provider configuration](docs/PROVIDERS.md) and
[Runtime configuration](docs/CONFIGURATION.md).

User-saved model profiles, API keys, base URLs, proxies, and MCP configuration
are persisted in Bytro's local application-data locations so they remain
available after restart. See [Privacy](PRIVACY.md) for storage and security
limitations.

## Local builds

Build the frontend and Sidecar:

```bash
npm run build:sidecar
npm run build
```

After installing the optional Worker dependencies, run the complete source
validation gate:

```bash
npm --prefix services/site-preview-worker ci
npm run ci:gate
```

Create a local Tauri package:

```bash
npm run tauri build
```

This repository intentionally has no command that publishes installers,
uploads patches, or deploys an official release. A package you build or
redistribute is an unofficial build unless the relevant rights holder
explicitly says otherwise. Apache-2.0 permits redistribution and commercial
use, but it does not grant trademark rights in Bytro Community Edition,
Bytro, or their logos. Read [TRADEMARKS.md](TRADEMARKS.md).

More detail is available in [Building](docs/BUILDING.md).

## Bring your own model configuration

Bytro resolves a provider from local inputs. The intended resolution order
is:

```text
explicit local profile or launch-environment path
  > supported process environment
  > system PATH
  > actionable not-configured error
```

No Community Edition path falls back to a Bytro official credential. Legacy
conversations that reference an official profile must be reassigned to a local
profile before they can continue.

Provider-owned Claude, Codex, and Gemini configuration may be scanned for an
explicit credential/profile import. Supported command, skill, session-history,
and team-state files may also be discovered read-only in place for local
compatibility behavior; opening or synchronizing a provider conversation may
copy its messages into Bytro's own database. Bytro does not write back,
synchronize, enable, disable, or delete files in those provider directories. A
provider CLI launched for a real user session may still update its own
authentication, session, cache, or history files according to that CLI's
documented behavior.

Recommended practices:

- use a provider key with the minimum required scope;
- prefer environment variables or the operating system credential mechanism
  over plaintext project files;
- use a separate key for development;
- never commit `.env`, `.env.local`, `.dev.vars`, or imported credential files;
- review custom base URLs before sending project context.

## Optional self-hosted site preview

Local iframe preview works without Cloudflare. Publishing a temporary static
preview is optional and requires infrastructure you control:

1. a Cloudflare account;
2. an R2 bucket;
3. the Worker in `services/site-preview-worker`;
4. your own domain/routes; and
5. an upload API key stored as a Worker secret.

The desktop receives only:

```dotenv
BYTRO_DEPLOY_WORKER_URL=
BYTRO_DEPLOY_API_KEY=
```

The same values may be supplied at startup. In Tauri development mode, the
second `--` separates runner arguments from application arguments:

```bash
npm run tauri -- dev -- -- --deploy-worker-url https://preview.example.com \
  --deploy-api-key "$BYTRO_DEPLOY_API_KEY"
```

Command-line values take precedence over process environment, then
`.env.local` and `.env` in the Bytro Community data directory
(`~/.bytro-community`) or a
recognized Community Edition development checkout. The application never reads
a generic `~/.env`. Command-line secrets can be visible to local
process-inspection tools, so environment or local configuration is preferred.
R2 account credentials stay in Cloudflare/Wrangler and must never be passed to
the desktop application.

Follow the [Worker deployment guide](services/site-preview-worker/README.md).

## Local-first privacy

The Community Edition does not require a Bytro account and must not send device
fingerprints, account activity, conversation usage, or workspace telemetry to
Bytro services.

Network requests still occur when you deliberately use:

- a remote model provider or custom API endpoint;
- Git remotes;
- an MCP server;
- a skill or tool that performs network access; or
- your self-hosted preview Worker.

You are responsible for the endpoint and tool configuration you enable. See
[Network and data](docs/NETWORK_AND_DATA.md) and [PRIVACY.md](PRIVACY.md).

## Repository layout

```text
.
├── src/                         # React application
├── src-tauri/                   # Rust/Tauri desktop layer
├── sidecar/                     # Local Node.js provider bridge
├── resources/                   # Public runtime/build resources
├── services/
│   └── site-preview-worker/     # Optional self-hosted Worker
├── docs/                        # Public architecture and operations docs
└── .github/                     # CI and security automation
```

Generated bundles, downloaded runtimes, local databases, private patches,
credentials, and build output do not belong in source control.

## Security

Please do not publish vulnerabilities in a public issue. Follow
[SECURITY.md](SECURITY.md). In particular:

- treat provider keys and the preview upload key as secrets;
- inspect MCP servers and skills before enabling them;
- review commands and file changes proposed by an agent;
- keep permission prompts enabled when working in an unfamiliar repository; and
- verify the provenance of unofficial builds.

## Contributing

Start with [CONTRIBUTING.md](CONTRIBUTING.md), follow the
[Code of Conduct](CODE_OF_CONDUCT.md), and keep changes within the Community
Edition boundary. Contributions that restore private account services, official
credentials, Canvas/OpenPencil resources, or managed Bytro update paths will
not be accepted.

## License and marks

The project code is licensed under the unmodified
[Apache License 2.0](LICENSE). Copyright 2026 misschendo and contributors.

Third-party components retain their own licenses; see
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) and [NOTICE](NOTICE).
Apache-2.0 does not grant permission to use the Bytro Community Edition or
Bytro names or logos; see [TRADEMARKS.md](TRADEMARKS.md).

## Support

Community support expectations and the information to include in a report are
documented in [SUPPORT.md](SUPPORT.md).
