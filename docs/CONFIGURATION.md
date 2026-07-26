# Runtime Configuration

Community Edition accepts local model/provider configuration and optional
self-hosted preview configuration. It must not embed shared deployment secrets
or fall back to Bytro-hosted credentials.

## Self-hosted preview precedence

For the optional self-hosted preview settings:

```text
command-line argument
  > existing process environment
  > .env.local in ~/.bytro-community or a recognized development checkout
  > .env in ~/.bytro-community or a recognized development checkout
  > feature disabled with a configuration error
```

The application does not scan the generic `.env` or `.env.local` directly in
the user's home directory. Packaged builds read preview configuration only from
the Community Edition data root (`~/.bytro-community`). Development builds
also accept the files from a checkout whose package name and Tauri
configuration identify it as `bytro-community`. Preview environment files are
for local operation and must not be committed.

## Preview environment file

In a Community Edition source checkout, create a local file from the committed
template:

```bash
cp .env.example .env.local
```

For a packaged build, place the equivalent file at
`~/.bytro-community/.env.local`. Only define the two preview values you use. Empty
values leave remote publishing disabled. This file is not loaded as a general
provider-credential or CLI-path store.

## Provider launch environment

When Bytro is launched from a shell, its local credential scanner recognizes
common provider variables inherited by that process, including:

| Provider family             | Key variables                                 | Optional endpoint variable     |
| --------------------------- | --------------------------------------------- | ------------------------------ |
| Anthropic/Claude compatible | `ANTHROPIC_API_KEY` or `ANTHROPIC_AUTH_TOKEN` | `ANTHROPIC_BASE_URL`           |
| OpenAI/Codex compatible     | `OPENAI_API_KEY`                              | `OPENAI_BASE_URL`              |
| Gemini compatible           | `GEMINI_API_KEY` or `GOOGLE_API_KEY`          | `GOOGLE_GEMINI_BASE_URL`       |
| xAI/Grok compatible         | `XAI_API_KEY` or `GROK_API_KEY`               | Configure in the local profile |
| DeepSeek                    | `DEEPSEEK_API_KEY`                            | Configure in the local profile |
| Qwen-compatible             | `DASHSCOPE_API_KEY` or `QWEN_API_KEY`         | Configure in the local profile |

Prefer an application profile when multiple endpoints use the same conventional
environment variable. Imported profiles should show their source and require
confirmation before use.

## Self-hosted preview

Desktop variables:

```dotenv
BYTRO_DEPLOY_WORKER_URL=
BYTRO_DEPLOY_API_KEY=
```

Equivalent startup arguments:

```text
--deploy-worker-url <https-url>
--deploy-api-key <secret>
```

For Tauri development, pass them after the runner/application separator:

```bash
npm run tauri -- dev -- -- --deploy-worker-url https://preview.example.com \
  --deploy-api-key "$BYTRO_DEPLOY_API_KEY"
```

Requirements:

- the URL must use HTTPS outside local development;
- the API key must be non-empty;
- neither value may be compiled into a binary;
- the key must never appear in logs, diagnostics, crash reports, or UI history;
- environment or local configuration is preferred because command-line
  arguments may be visible to process-inspection tools;
- Cloudflare account, R2, and API-token credentials remain Worker-side; and
- if either value is missing, remote publishing is disabled without affecting
  local preview.

See [the Worker guide](../services/site-preview-worker/README.md).

## Local CLI paths

Community Edition resolves local executables from an explicit launch
environment variable and then the system `PATH`:

| Runtime             | Explicit path variable |
| ------------------- | ---------------------- |
| Node.js 20+         | `BYTRO_NODE_PATH`      |
| Claude CLI          | `CLAUDE_CLI_PATH`      |
| Codex CLI           | `CODEX_CLI_PATH`       |
| Gemini CLI          | `GEMINI_CLI_PATH`      |
| Git Bash on Windows | `BYTRO_GIT_BASH_PATH`  |

For example:

```bash
CLAUDE_CLI_PATH=/opt/local/bin/claude \
CODEX_CLI_PATH=/opt/local/bin/codex \
npm run tauri dev
```

The CLI settings page detects and displays the paths currently visible to the
application.

Setting an explicit path is also how you opt out of the managed install: when
`CLAUDE_CLI_PATH` or `CODEX_CLI_PATH` points at a working executable, Bytro
uses it and never installs anything. If no executable is found for Claude or
Codex, Bytro installs a version-pinned package from the public npm registry
into `~/.bytro-community/cli/` — see
[Provider Configuration](PROVIDERS.md#how-bytro-finds-a-runtime).

Bytro never downloads, updates, or uninstalls Gemini, Node.js, or Git Bash;
for those, resolution stops with a clear error when no executable is
available. Nothing is ever installed system-wide, and no Bytro-operated
server is contacted.

## Secret handling

- Do not commit `.env`, `.env.local`, `.dev.vars`, provider auth files, or
  exported profiles containing keys.
- Use scoped, revocable credentials.
- Do not paste secrets into issue reports.
- Rotate any key that appears in Git history, logs, or screenshots.
- Treat custom base URLs as data recipients: project context sent to them leaves
  your computer.
