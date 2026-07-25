# Architecture

This document describes the public Community Edition architecture. Private
Bytro account services, official model credentials, Canvas/OpenPencil, managed
runtime downloads, hotpatch delivery, and hosted remote-control services are
not part of this system.

## Goals

- Keep project data and application state local by default.
- Make every model credential and endpoint user-controlled.
- Isolate privileged desktop operations behind a narrow Tauri IPC boundary.
- Isolate provider/CLI adapters and long-running agent streams in a
  restartable local Sidecar process.
- Allow optional self-hosted services without coupling the desktop application
  to Bytro infrastructure.
- Fail clearly when a runtime or credential is unavailable; never silently
  fall back to an official credential.

## Process model

```text
┌──────────────────────────────────────────────────────────────┐
│ WebView: React + TypeScript                                  │
│                                                              │
│ views ─ stores ─ domain actions ─ typed invoke/event clients │
└──────────────────────────────┬───────────────────────────────┘
                               │ Tauri IPC / event stream
┌──────────────────────────────▼───────────────────────────────┐
│ Desktop host: Rust + Tauri                                  │
│                                                              │
│ command validation · filesystem · Git · PTY · SQLite         │
│ Sidecar lifecycle · local settings · OS integrations         │
└──────────────────────────────┬───────────────────────────────┘
                               │ newline-delimited JSON / stdio
┌──────────────────────────────▼───────────────────────────────┐
│ Agent runtime: Node.js Sidecar                              │
│                                                              │
│ provider adapters · streaming normalization · tool policy    │
│ MCP · skills · teams · runtime/session management            │
└───────────────┬──────────────────────────┬───────────────────┘
                │                          │
        local CLI process          user-selected HTTPS endpoint
```

The optional site-preview Worker is not part of the trusted desktop process. It
is a separate deployment controlled by the operator.

## Frontend

The frontend owns presentation and user interaction:

- workspaces, sessions, tabs, and navigation;
- streaming message rendering and tool-call review;
- file tree, editor, diffs, checkpoints, and Git views;
- terminal, project preview, MCP, skills, and teams UI;
- local settings and provider-profile selection; and
- status and error presentation.

The WebView does not directly spawn processes or receive unrestricted native
filesystem access. It requests operations through Tauri commands and listens
for typed events. Sensitive values should be passed only for the operation that
needs them and must not be persisted to logs or analytics.

## Rust/Tauri desktop host

The Rust layer is the security and operating-system boundary. Its
responsibilities include:

- validating IPC arguments;
- resolving and constraining filesystem operations;
- managing PTY sessions and child processes;
- running Git operations;
- storing local conversation and workspace state;
- starting, supervising, and stopping the Sidecar;
- forwarding structured Sidecar events to the frontend; and
- integrating with dialogs, notifications, clipboard, and application data
  directories.

Commands should return fixed, structured public error categories without
exposing credential values, local paths, or raw provider response bodies.
Sensitive diagnostic detail stays local as bounded hash metadata. Long-running
work should be cancellable and associated with a session identifier.

## Node.js Sidecar

The Sidecar adapts provider-specific behavior to a shared local protocol:

- request and session lifecycle;
- provider credential/environment setup;
- streaming text, reasoning, tool calls, and results;
- permission decisions and cancellation;
- MCP server validation and connection;
- skill discovery and execution metadata; and
- teams/subagent event normalization.

The Sidecar communicates with Rust over newline-delimited JSON on local stdio.
Protocol changes must be backward-safe within a release and updated on both
sides of the boundary. Raw provider payloads should not leak into unrelated UI
stores.

## Request flow

```text
user action
  → frontend validates local UI state
  → Tauri command creates/updates a session
  → Rust sends an NDJSON request to the Sidecar
  → Sidecar resolves the selected local profile/runtime
  → provider or CLI streams events
  → Sidecar normalizes events
  → Rust forwards typed Tauri events
  → frontend stores update and render
```

Cancellation follows the reverse control path and should terminate provider
work and child processes associated with the session.

## Local storage

Community Edition data belongs in operating-system application-data locations,
not in the source checkout:

- conversation/message records and token metadata;
- workspace and UI state;
- user-created provider profiles;
- MCP and skill configuration;
- runtime path preferences; and
- logs with secrets redacted.

The Community Edition uses the `com.bytro.community` application identifier,
the platform application-data directory assigned to that identifier, and the
user-owned `~/.bytro-community` configuration root (or its Windows
user-profile equivalent). These locations are independent of other Bytro
distributions.

## Provider and runtime resolution

The runtime resolution contract is:

```text
explicit local path/profile
  > supported environment configuration
  > system PATH
  > configuration error
```

There is no Bytro credential or managed-download fallback. Provider-owned
authentication used by a local CLI is outside the Bytro account system.
Provider-owned configuration is read-only: credential/profile copying requires
an explicit import, while supported commands, skills, session history, and team
state may be discovered in place for local compatibility behavior. Provider
messages may be copied into Bytro's database when a conversation is opened or
synchronized, but Bytro does not rewrite or synchronize the provider source.

## Optional site-preview Worker

The Worker receives authenticated uploads and stores static files in an
operator-owned R2 bucket. The trust boundary is explicit:

- the desktop knows the Worker URL and one upload API key;
- Wrangler/Cloudflare owns the R2 binding and account authorization;
- R2 account credentials never enter the desktop app;
- static preview content is public to anyone who knows its URL; and
- the operator owns retention, deletion, domain, access, and cost policies.

See the [Worker guide](../services/site-preview-worker/README.md).

## Failure boundaries

| Failure            | Expected behavior                                                                  |
| ------------------ | ---------------------------------------------------------------------------------- |
| Sidecar exits      | Mark affected sessions failed, stop accepting new work, allow an explicit restart  |
| Local CLI missing  | Show a configuration action without exposing local paths; do not download a binary |
| Credential missing | Keep the session local and request a user profile; do not use an official key      |
| Provider timeout   | Preserve partial local output, surface a retryable error, support cancellation     |
| MCP server failure | Isolate the server failure from other configured servers and the core chat         |
| Worker unavailable | Disable remote publishing while keeping local preview functional                   |
| Database error     | Avoid destructive recovery; preserve the error and provide a backup/export path    |

## Security model

The desktop application is a high-privilege developer tool. Its security relies
on:

- explicit project selection;
- minimal Tauri capabilities;
- validated IPC and filesystem paths;
- permission prompts for agent actions;
- secret redaction in logs and diagnostics;
- no embedded shared API keys;
- no automatic download/execute path for managed runtimes; and
- review of third-party MCP servers, skills, hooks, and unofficial builds.

See [SECURITY.md](../SECURITY.md) for reporting and
[Network and data](NETWORK_AND_DATA.md) for outbound data boundaries.

## Deliberate exclusions

The following are architecture violations in Community Edition:

- Bytro account, subscription, balance, or invitation APIs;
- official Bytro model/credential protocols;
- OpenPencil or Canvas code, prompts, MCP servers, WASM, or resources;
- Bytro/COS runtime download managers;
- cloud usage/activity uploads;
- official hotpatch/update endpoints;
- private release and R2 publication infrastructure; and
- hosted remote-control tunnels.
