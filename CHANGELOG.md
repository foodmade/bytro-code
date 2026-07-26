# Changelog

All notable changes to Bytro Community Edition are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
The project will follow semantic versioning after the first public release.

## [Unreleased]

First public release of Bytro Community Edition — a local-first desktop
workspace for AI-assisted development.

### Added

- **Multi-provider chat** — Claude, Codex, Gemini, DeepSeek, Qwen, BigModel,
  Kimi, MiniMax, MiMO, Ollama, and any OpenAI-compatible endpoint, all using
  credentials you supply.
- **Project workspace** — file tree, editor, search, diffs, checkpoints, and
  code review over a single project root.
- **Development tools** — PTY terminals, dev-server detection, local preview,
  and Git workflows from status through push.
- **MCP and skills** — connect MCP servers, discover project or user skills,
  and invoke slash commands.
- **Multi-agent teams** — create agent teams, route tasks, and follow live
  status in one view.
- **Local-first storage** — conversations, model profiles, API keys, MCP
  configuration, and workspace state persist on your machine.
- **Optional self-hosted preview** — publish static previews to a Cloudflare
  Worker and R2 bucket that you own and operate.
- Apache License 2.0, project governance documents, CI, and secret scanning.

### Known limitations

- Provider credentials are stored **unencrypted** in local application data
  and are not protected by the OS credential vault. See [PRIVACY.md](PRIVACY.md).
- Claude and Codex runtimes are installed on demand from the public npm
  registry into `~/.bytro-community/cli/`. See
  [docs/PROVIDERS.md](docs/PROVIDERS.md#how-bytro-finds-a-runtime).

Community Edition is an independent distribution: it has no Bytro account,
hosted models, or subscription. See
[docs/COMMUNITY_EDITION.md](docs/COMMUNITY_EDITION.md) for the full boundary.
