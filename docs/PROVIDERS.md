# Provider Configuration

Bytro ships no models and no credentials of its own. Every model call uses an
endpoint and key that you configure.

## Built-in providers

These providers come preconfigured — pick one, paste a key, and go. The base
URL is filled in for you and can be overridden.

| Provider     | Vendor    | Default base URL                                        | Auth        |
| ------------ | --------- | ------------------------------------------------------- | ----------- |
| **Claude**   | Anthropic | `https://api.anthropic.com`                             | API key / OAuth |
| **Codex**    | OpenAI    | `https://api.openai.com/v1`                             | API key / OAuth |
| **Gemini**   | Google    | *(SDK default)*                                         | API key     |
| **DeepSeek** | DeepSeek  | `https://api.deepseek.com`                              | API key     |
| **Qwen**     | Alibaba   | `https://dashscope.aliyuncs.com/compatible-mode/v1`     | API key     |
| **BigModel** | 智谱 Zhipu | `https://open.bigmodel.cn/api/paas/v4`                 | API key     |
| **Kimi**     | Moonshot  | `https://api.kimi.com/coding/`                          | API key     |
| **MiniMax**  | MiniMax   | `https://api.minimaxi.com/v1`                           | API key     |
| **MiMO**     | Xiaomi    | `https://api.xiaomimimo.com/v1`                         | API key     |
| **Ollama**   | local     | `http://localhost:11434`                                | none        |
| **Grok**     | xAI       | `https://api.x.ai/v1`                                   | *(disabled in this build)* |

Any other OpenAI-compatible service works too — see
[OpenAI-compatible endpoint](#openai-compatible-endpoint) below.

The provider list and its pinned model names live in
[`src/lib/platform-config.ts`](../src/lib/platform-config.ts).

## Supported connection patterns

### Local CLI

Use a locally installed and provider-supported CLI/runtime. Set its documented
explicit path environment variable when launching Bytro, or make it
available on the system `PATH`. The CLI settings page shows what the
application detects. Provider-owned login performed by that CLI is separate
from a Bytro account.

#### How Bytro finds a runtime

For Claude and Codex, Bytro resolves an executable in this order:

1. **Explicit path** — `CLAUDE_CLI_PATH` / `CODEX_CLI_PATH`, or the path set on
   the CLI settings page.
2. **Private managed install** — a version-pinned copy under
   `~/.bytro-community/cli/<provider>/<version>/`.
3. **System `PATH`**.
4. If none of the above yields a working executable, Bytro installs the pinned
   package from the public npm registry into the private directory in step 2.

Step 4 runs `npm install --ignore-scripts` against
`@anthropic-ai/claude-agent-sdk-<platform>` or `@openai/codex@<version>-<platform>`.
Versions are pinned at build time from [`sidecar/package.json`](../sidecar/package.json).
The install writes only inside `~/.bytro-community/cli/`, never modifies a
system-wide installation, and never contacts a Bytro-operated server. It is
best-effort at startup and retried when a session needs the runtime.

**To prevent step 4 entirely**, set the explicit path environment variable to
your own installation. There is currently no in-app toggle to disable it —
if you need one, please open an issue.

Gemini and all OpenAI-compatible providers do not use this path at all.

#### Provider-owned configuration

Bytro does not rewrite or delete provider-owned configuration. The provider
runtime itself may update its own authentication, session, cache, or history
files while handling a session you started; that behavior belongs to the
provider and its applicable terms. Provider accounts and hosted model use
remain subject to Anthropic's and OpenAI's respective service terms.

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
