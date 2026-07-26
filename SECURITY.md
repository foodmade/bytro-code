# Security Policy

Bytro Community Edition can read project files, execute tools, launch local
processes, and send selected context to configured providers. Treat it as a
high-privilege developer application.

## Supported versions

The project is currently pre-release. Security fixes are applied to the latest
commit on the default branch. No older version is guaranteed to receive fixes
until a supported release line is announced here.

## Report a vulnerability

Report privately through GitHub Security Advisories:
**<https://github.com/foodmade/bytro-code/security/advisories/new>**

Do not open a public issue for an unpatched vulnerability. Include:

- affected commit or version;
- operating system and architecture;
- required configuration and permissions;
- reproduction steps or a minimal proof of concept;
- expected and actual impact; and
- suggested remediation, if known.

Do not include real credentials, customer data, private repository content, or
unnecessary personal information.

If private reporting is unavailable, open a public issue containing only a
request for a private maintainer contact. Do not disclose exploit details or
affected secrets publicly.

Maintainers will acknowledge reports and coordinate remediation on a
best-effort basis. Please allow a reasonable remediation window before public
disclosure.

## In scope

- bypassing Tauri command or filesystem boundaries;
- command execution without the expected user approval;
- credential exposure through logs, IPC, process arguments, storage, or UI;
- unrequested transmission of workspace or usage data;
- provider/profile confusion that sends data to the wrong endpoint;
- arbitrary file access or path traversal in the preview Worker;
- authentication bypass for preview upload or deletion;
- unsafe update, download, or executable-resolution behavior; and
- dependency or build-chain compromise with a demonstrated project impact.

## Usually out of scope

- behavior of a third-party model provider, MCP server, skill, Git remote, or
  unofficial fork outside this project's control;
- social engineering without a technical vulnerability;
- denial of service requiring control of the user's own machine;
- reports based only on automated scanner output without an exploitable path;
  and
- secrets already revoked or intentionally supplied in test fixtures.

## Operator guidance

- Provider/Git credentials, provider OAuth tokens, and credentials embedded in
  user-saved MCP configuration are currently stored unencrypted in the Tauri
  application-data `settings.json`, the platform data directory's
  `com.bytro.community/memory.db`, and
  `~/.bytro-community/mcp-servers.json` (or their Windows equivalents).
- Bytro-managed skills are stored under
  `~/.bytro-community/skills/<provider>/`. Provider-owned Claude, Codex, and
  Gemini directories are read-only import sources and are never mutation
  targets.
- The application restricts its data directories/files to the current OS user
  where the platform supports Unix permissions, but it does not yet integrate
  with the system Keychain or credential vault. Use full-disk encryption,
  protect the OS account, and do not sync or share these locations.
- Use least-privilege, revocable provider keys.
- Keep permission prompts enabled for unfamiliar projects.
- Review MCP servers and skills before enabling them.
- Do not use untrusted unofficial builds with sensitive repositories.
- Store the Worker upload key using `wrangler secret put`.
- Rotate any credential exposed in Git history, logs, screenshots, or support
  reports.
