# Community Edition Boundary

Bytro Community Edition is an independent, local-first distribution. It is
not a feature flag for the official application and does not depend on private
Bytro services.

## Capability matrix

| Capability                                        | Community Edition |
| ------------------------------------------------- | ----------------- |
| Local workspaces and conversations                | Included          |
| User-supplied provider credentials                | Included          |
| Supported local provider config import            | Included          |
| Locally installed Claude/Codex/Gemini tooling     | Included          |
| OpenAI-compatible custom endpoint                 | Included          |
| Ollama/local compatible endpoint                  | Included          |
| Files, editor, diffs, Git, terminal               | Included          |
| MCP, skills, slash commands                       | Included          |
| Multi-agent teams                                 | Included          |
| Local project preview                             | Included          |
| Self-hosted static preview Worker                 | Optional          |
| User-initiated provider OAuth/CLI login           | Included          |
| Bytro login/account/profile                       | Not included      |
| Bytro official models or shared credentials       | Not included      |
| Bytro subscription, balance, invite, announcement | Not included      |
| Cloud AI usage/billing page                       | Not included      |
| Canvas/OpenPencil                                 | Not included      |
| Managed Codex/Claude/core runtime downloads       | Not included      |
| Managed third-party CLI memory plugins            | Not included      |
| Bytro hotpatch/native update service              | Not included      |
| Hosted remote-control tunnels                     | Not included      |
| Private release/R2 publication workflow           | Not included      |

## Local usage data

Per-conversation token and context information may be retained locally where a
provider reports it. Community Edition does not upload that information to a
Bytro service.

A local-only aggregate token usage dashboard is planned. The roadmap item does
not authorize cloud telemetry or account-dependent billing features.

## Compatibility with private or legacy data

A legacy conversation may refer to a provider profile that does not exist in
Community Edition. Loading the conversation must remain safe, but continuing it
requires selecting a valid local profile. It must never restore an official
credential path.

Community Edition should use its own application identifier and data directory
so installing it does not mutate an official application's state.

## Distribution

The source is Apache-2.0 licensed, which permits use, modification, commercial
use, and redistribution. Third-party distributions are unofficial and must
comply with [TRADEMARKS.md](../TRADEMARKS.md), including changing protected
Bytro branding and product identifiers.

This repository does not publish a one-command official release workflow.
Local source builds remain supported.
