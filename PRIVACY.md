# Privacy

Bytro Community Edition is designed for local-first use and does not require
a Bytro account.

## What stays local

Subject to operating-system and user configuration, the application stores
locally:

- conversations and messages;
- workspace paths and UI state;
- provider profiles, including user-supplied provider/Git credentials, API
  keys, base URLs, proxies, and provider OAuth tokens when configured;
- per-turn token/context metadata;
- MCP configuration, including user-supplied environment values, headers, and
  tokens, plus skill and local runtime settings; and
- diagnostic logs. Secret values are redacted from application-managed
  diagnostics where identified, but logs may still contain local paths,
  process metadata, session identifiers, provider error text, or repository
  details.

The Community Edition does not intentionally upload device fingerprints,
workspace activity, cloud usage/billing records, profile data, or conversation
history to Bytro services.

Configured provider, Git, and MCP credentials are currently stored unencrypted
in local files:

- `settings.json` in Tauri's platform application-data directory for
  `com.bytro.community`;
- `memory.db` in the platform data directory for `com.bytro.community`; and
- `~/.bytro-community/mcp-servers.json` (or the equivalent user-profile path
  on Windows) for user-saved MCP definitions.

Bytro-managed skills are stored under
`~/.bytro-community/skills/<provider>/`. Project memory created through the
application is stored in the project's Bytro-owned
`.bytro-community/memory/` directory. Provider-owned Claude, Codex, and Gemini
configuration and project directories are read-only inputs: Bytro may scan
configuration for an explicit import and may discover supported command,
skill, session-history, or team-state files in place. Opening or synchronizing
a provider conversation may copy its messages into Bytro's own database, but
does not mutate the provider source.
A provider CLI launched for a user-initiated session may still update its own
authentication, session, cache, or history files according to that CLI's
behavior.

Access to Bytro-owned storage is intended to be limited to the current OS
user, but the application does not yet use the system Keychain or credential
vault. Protect these locations with OS account controls and full-disk
encryption, and exclude them from shared backups.

## When data leaves the device

Data is sent only as needed for an action the user configures or approves, for
example:

- OAuth authorization, refresh, and optional quota requests sent to the
  selected provider after the user enables a provider OAuth profile;
- catalog/search requests sent when the user browses an MCP or skill registry;
- prompts, selected files, attachments, and tool results sent to the selected
  model provider or custom base URL;
- tool arguments sent to a configured remote MCP server;
- Git data sent to a configured Git remote;
- repository requests made to install a selected skill; or
- static build files sent to the user's self-hosted preview Worker.

Third-party providers and services apply their own privacy policies and data
retention terms.

## Optional static previews

Static content uploaded to the self-hosted Worker is publicly accessible by
URL unless the operator adds a separate access-control layer. Do not publish
credentials, environment files, source maps containing private source, customer
data, or confidential assets.

The Worker operator controls the Cloudflare account, R2 storage, domain,
retention, deletion, and billing.

## Local token usage

Per-turn token/context information may be recorded locally. A future aggregate
usage dashboard is intended to operate on local data only. This roadmap item
does not authorize cloud telemetry.

## Logs and support

Review logs and screenshots before sharing them. Remove keys, authorization
headers, private URLs, user names, local paths, prompts, and repository content.
Never include secrets in a public issue.

## Deletion

Users can remove local application data using the application's supported
controls or operating-system application-data management. Back up data before
manual deletion. Remote preview files must be deleted through the operator's
Worker or Cloudflare account.

See [Network and data](docs/NETWORK_AND_DATA.md) for the detailed data-flow
model.
