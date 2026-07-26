# Support

Bytro Community Edition is community-maintained and provided without
warranty under the Apache License, Version 2.0.

## Before requesting help

1. Check [Troubleshooting](docs/TROUBLESHOOTING.md) — it covers the common
   first-run build and provider failures. Then
   [Providers](docs/PROVIDERS.md), [Building](docs/BUILDING.md), and
   [Configuration](docs/CONFIGURATION.md).
2. Reproduce the problem on the latest default branch when practical.
3. Confirm whether it is a Bytro issue or a provider, CLI, MCP server,
   skill, Git, Cloudflare, or operating-system issue.
4. Remove credentials and private project data from logs and screenshots.

## What to include

- commit or version;
- operating system and architecture;
- Node.js, npm, and Rust versions;
- selected provider/adapter without the credential;
- whether the runtime was explicitly configured or found on `PATH`;
- concise reproduction steps;
- expected and actual behavior; and
- minimal, redacted logs.

Do not include API keys, authorization headers, `.env` files, provider auth
files, private repository URLs, prompts containing confidential code, or local
user paths.

## Where to ask

- **Reproducible bug** —
  [open an issue](https://github.com/foodmade/bytro-code/issues/new/choose).
- **Setup or design question** —
  [start a discussion](https://github.com/foodmade/bytro-code/discussions).
- **Security vulnerability** — do not open a public issue; follow
  [SECURITY.md](SECURITY.md).

## Support boundaries

Maintainers cannot provide credentials, Bytro official model access,
Cloudflare accounts, provider billing support, or support for an unofficial
redistributed build. For those issues, contact the corresponding provider or
distributor.
