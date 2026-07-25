# Provider Configuration

Community Edition uses credentials, endpoints, and local runtimes supplied by
the user. It does not provide Bytro official models or a shared credential
pool.

## Supported connection patterns

### Local CLI

Use a locally installed and provider-supported CLI/runtime. Set its documented
explicit path environment variable when launching Bytro, or make it
available on the system `PATH`. The CLI settings page shows what the
application detects. Provider-owned login performed by that CLI is separate
from a Bytro account.

#### Claude CLI

Install Claude CLI yourself from an Anthropic-authorized source, review
Anthropic's applicable license and service terms, and complete any
CLI-owned authentication required by that executable. The repository does not
bundle, sublicense, download, or update Claude CLI.

#### Codex CLI

Install Codex CLI yourself from an OpenAI-authorized source and complete any
CLI-owned authentication required by that executable. The repository does not
bundle, download, or update Codex CLI. The upstream Codex CLI source is
Apache-2.0 licensed; provider accounts and hosted model use remain subject to
OpenAI's applicable service terms.

For both CLIs, Bytro only resolves an explicit executable path or the system
`PATH`. Absence of a CLI produces a local configuration error rather than a
managed download. Bytro does not directly rewrite or delete provider-owned
configuration. The CLI process itself may update its own authentication,
session, cache, or history files while handling a user-initiated session; that
behavior belongs to the provider CLI and its applicable terms.

### API key profile

A profile contains:

- display name;
- provider or CLI adapter;
- model identifier;
- API key or token;
- optional base URL; and
- optional runtime path or provider-specific options.

Use a separate, least-privilege key for development. Confirm the base URL before
sending source code or files.

Profiles saved in Bytro, including API keys, base URLs, and proxies, persist in
the local application-data directory and remain available after restart. This
local credential store is currently unencrypted; review
[Privacy](../PRIVACY.md) before saving sensitive production credentials.

### Provider OAuth profile

Where supported, the user may explicitly start a provider-owned OAuth flow
from the model settings. This authorizes the user's provider account; it is not
a Bytro login and does not grant access to a Bytro credential or model.
Provider OAuth tokens and account metadata are persisted in Bytro-owned local
storage so the profile remains usable after restart. The selected provider's
terms, quota, billing, and data handling still apply.

### OpenAI-compatible endpoint

For a compatible service, select the compatible adapter and supply the
service's documented base URL, model identifier, and user-owned key. Protocol
compatibility does not imply identical tool-calling, reasoning, streaming, or
token-accounting behavior.

### Local Ollama-compatible endpoint

Local endpoints can operate without a hosted model credential. Model
availability, context limits, performance, and tool support depend on the local
runtime.

## Import

When supported, the application may scan conventional environment variables or
provider-owned local configuration and offer profiles for import. Provider
configuration remains read-only: importing copies the selected values into
Bytro-owned local storage and does not rewrite the provider source.

Import must be explicit:

1. review the discovered source and endpoint;
2. select the profiles to import;
3. confirm how credentials will be stored;
4. test the profile; and
5. remove or rotate stale credentials.

The scanner must not upload discovered configuration or silently activate a
profile.

## Read-only compatibility discovery

Configuration import is distinct from compatibility discovery. For supported
local runtimes, Bytro may read provider- or project-owned command, skill,
session-history, and team-state files to provide the corresponding local UI and
compatibility behavior. A command or skill is executed only after the user
selects or invokes it. Session messages may be copied into Bytro's own local
conversation database when the user opens or synchronizes that conversation.
Discovery never synchronizes, toggles, deletes, or rewrites the provider source
files. File reads are bounded and reject links and special files.

## Legacy official profiles

Conversations referencing an unavailable official profile remain readable.
Before sending a new message, choose a Community Edition local profile. No
legacy value may reactivate an official credential.

## Troubleshooting

| Symptom                     | Check                                                     |
| --------------------------- | --------------------------------------------------------- |
| Runtime not found           | Explicit path, executable permission, system `PATH`       |
| Unauthorized                | Key scope, expiry, selected profile, provider-owned login |
| Model not found             | Exact provider model identifier and base URL              |
| Tool calls fail             | Adapter and endpoint tool-calling compatibility           |
| Stream disconnects          | Proxy/TLS settings, provider limits, cancellation state   |
| Unexpected data destination | Selected profile and custom base URL                      |

Never include keys or complete auth files in a public bug report.
