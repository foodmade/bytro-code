# Changelog

All notable changes to Bytro Community Edition will be documented in this
file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
The project will use semantic versioning after the first public release.

## [Unreleased]

### Added

- Independent Community Edition repository.
- Apache License, Version 2.0 and public project governance documents.
- Local-first architecture, configuration, provider, privacy, and build
  documentation.
- Optional self-hosted Cloudflare Worker documentation and safe example
  configuration.
- Baseline CI and secret scanning.

### Removed

- Bytro account, official model, subscription, invitation, and hosted usage
  dependencies.
- OpenPencil/Canvas integration and bundled resources.
- Managed Codex/Claude/core runtime downloads and cloud update paths.
- Automatic `claude-mem` management and the dedicated `codexUiDebug` protocol
  path.
- Hosted remote-control services.
- Private release, hotpatch, and R2 publication workflows.

### Changed

- Provider access uses user-supplied credentials, imported local profiles, and
  locally installed runtimes.
- Cloudflare preview deployment is explicitly self-hosted and configured at
  runtime.
