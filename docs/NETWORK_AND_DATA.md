# Network and Data

Community Edition is local-first, not network-free. This document describes
when data can leave the computer and what must remain local.

## Local data

The application may store the following in its operating-system application
data directory:

- conversations and messages;
- provider/profile metadata, API keys, base URLs, and proxies;
- user-supplied provider/Git credentials and provider OAuth tokens;
- per-turn token and context metadata;
- workspace state and recent paths;
- MCP configuration, including user-supplied environment values, headers, and
  tokens, plus skill configuration;
- local runtime path preferences;
- checkpoints and Git metadata references; and
- diagnostic logs, which may include local paths, process metadata, session
  identifiers, provider error text, and repository details. Application-managed
  diagnostics must not intentionally record secret values.

The source checkout is not a credential or application-data store.

## Outbound network paths

| Action                           | Recipient                  | Data that may be sent                               |
| -------------------------------- | -------------------------- | --------------------------------------------------- |
| Send a model request             | Selected provider/base URL | Prompt, selected context, attachments, tool results |
| Authorize/refresh provider OAuth | Provider auth endpoints    | PKCE data, OAuth tokens, account/quota metadata     |
| Browse an MCP or skill catalog   | Documented public registry | Search terms and normal request metadata            |
| Use a remote MCP server          | Configured MCP endpoint    | Tool arguments and server-defined context           |
| Install/update a skill from Git  | Selected Git host          | Repository URL and normal Git request metadata      |
| Git fetch/push/clone             | Configured Git remote      | Repository data and Git credentials handled by Git  |
| Publish a static preview         | Operator's Worker/R2       | Built static files and site identifier              |
| Use a network-capable agent tool | Tool-selected endpoint     | Depends on the tool and user approval               |
| Prepare a Claude/Codex runtime   | Public npm registry        | Package name and pinned version only; no project data |

The bundled catalog clients use `registry.modelcontextprotocol.io` for the MCP
registry and `skills.sh` for the public skill catalog. Installing a selected
skill then contacts the Git repository chosen by the user.

## Requests that must not exist

Community Edition must not send:

- device fingerprints;
- Bytro account, subscription, balance, invite, or announcement requests;
- workspace activity or heatmap telemetry;
- cloud AI usage/billing records;
- official credential requests;
- requests to any Bytro-operated runtime, hotpatch, or update server; or
- hosted remote-control registration.

Provider runtime preparation is the one exception to "no runtime downloads",
and it goes to the **public npm registry only** — never to Bytro
infrastructure. See
[Provider Configuration](PROVIDERS.md#how-bytro-finds-a-runtime).

## Credentials

Provider keys are sent only to their selected endpoint or used by their local
runtime. The self-hosted preview upload key is sent only to the configured
Worker. R2 account credentials stay in Cloudflare/Wrangler.

Provider/Git credentials, provider OAuth tokens, and credentials embedded in
user-saved MCP configuration are currently persisted unencrypted in:

- Tauri's platform application-data `settings.json` for
  `com.bytro.community`;
- the platform data directory's `com.bytro.community/memory.db`; and
- `~/.bytro-community/mcp-servers.json` (or its Windows user-profile
  equivalent).

Provider-owned Claude, Codex, and Gemini configuration is a read-only source
for explicit credential/profile import. Supported command, skill,
session-history, and team-state files may also be discovered and read in place
for compatibility; opening or synchronizing a conversation may copy its
messages into Bytro's own database. Community Edition does not synchronize MCP
values, credentials, commands, skills, sessions, or team state back into
provider-owned home or project directories. Bytro-managed skills and runtime
projections stay under
`~/.bytro-community/`. A provider CLI launched for a user-initiated session may
write its own authentication, session, cache, or history data; those writes are
performed by that third-party CLI, not by Bytro's storage-management code.
Community Edition restricts its application-data directories and files to the
current OS user where Unix permissions are available; Windows relies on the
user-profile ACL. System Keychain/credential-vault integration is not yet
implemented.

Secrets must be redacted from logs, event payloads, exception text, process
lists where avoidable, and diagnostics.

## Static preview privacy

Files published through the optional Worker are served as public static
content. Do not publish source maps, environment files, credentials, customer
data, or internal-only assets. The Worker operator controls retention and must
delete unused sites.

## Deletion and backup

Deleting a local conversation or workspace reference should affect only local
application data. Git repositories and arbitrary project files must not be
deleted implicitly.

Deleting a remote preview requires access to the same self-hosted Worker and
upload key. Back up local application data before migrations or manual database
repair.

## Verification before release

A release candidate should be tested with outbound traffic observed at the
operating-system or proxy layer. Searches for known private domains are useful
but are not sufficient proof that all unwanted network behavior is absent.
