# Open-source readiness checklist

This checklist defines the acceptance criteria for publishing Bytro Community
Edition as an independent source repository. A checked item is a repository
requirement, not a promise about third-party services or unofficial binaries.

## Repository and product identity

- [x] The public product name is **Bytro Community Edition**.
- [x] The package, Tauri identifier, local data root, and environment variables
      use Community Edition identifiers.
- [x] The repository has no dependency on a private parent repository or
      private build artifact.
- [x] A final case-insensitive source scan reports no legacy product names,
      private domains, or private publication paths.
- [x] The release is created from one reviewed root commit with no copied
      private history.

## Community feature boundary

- [x] Bytro account, subscription, balance, invitation, announcement,
      official-model, shared-key, and cloud-usage features are excluded.
- [x] Canvas/OpenPencil and `claude-mem` integration are excluded.
- [x] Managed runtime downloads, hotpatches, official updaters, hosted tunnels,
      and private publication scripts are excluded.
- [x] `codexUiDebug` and its dedicated protocol/event plumbing are excluded.
- [x] Local files, Git, terminal, preview, MCP, skills, conversations, and
      supported provider workflows remain available.
- [x] Optional static-preview publishing targets only infrastructure configured
      and operated by the user.

## Persistence and storage isolation

- [x] User-saved model profiles, API keys, base URLs, proxies, and MCP
      configuration persist across restarts.
- [x] Persistent secret-bearing files are documented as local, unencrypted
      storage and restricted to the current OS user where supported.
- [x] Bytro-owned state uses Community Edition application-data locations.
- [x] Provider-owned Claude, Codex, and Gemini home/project directories are
      read-only import sources; Bytro does not synchronize, toggle, delete, or
      rewrite their contents.
- [x] Symlink, permission, and atomic-save tests pass for every Bytro-owned
      secret-bearing file.
- [x] Conversation deletion is verified to remove only Bytro-owned records and
      never provider-owned session files.

## Security and privacy

- [x] No shared provider credentials or deployment credentials are embedded in
      source or binaries.
- [x] Model and MCP destinations remain user-selected; optional provider OAuth
      uses the documented provider authorization endpoints.
- [x] Application-managed logs and events have explicit secret-redaction rules.
- [x] Provider/RPC failures cross process boundaries only as fixed public error
      categories; raw details remain local as bounded hash metadata.
- [x] Executable resolution does not guess untrusted provider or package-manager
      paths and never downloads a missing runtime.
- [x] Child-process termination is scoped to the processes created for the
      relevant session on macOS, Linux, and Windows.
- [x] Dependency audits report no unresolved high-severity vulnerabilities.
- [x] The staged-tree secret scanner passes immediately before the release
      commit.

## Build and test gates

- [x] Frontend lint, unit tests, type checking, and production build pass.
- [x] Sidecar lint, unit tests, type checking, clean install, and bundled build
      pass.
- [x] Rust formatting, `cargo check`, tests, and Clippy with warnings denied
      pass.
- [x] The optional Worker tests, type checking, and dry-run build pass.
- [ ] macOS and Windows CI smoke-check the platform-specific runtime and process
      code.
- [x] The complete `npm run ci:gate` command passes from a clean checkout.

The platform-smoke jobs are configured in `.github/workflows/ci.yml`; their
checkbox remains open until the first public remote run completes.

## Documentation and governance

- [x] README, architecture, provider, configuration, building, privacy,
      security, support, and contribution documentation are present.
- [x] Apache-2.0 license, notice, code of conduct, and trademark policy are
      present.
- [x] Network recipients, local persistence, plaintext-secret limitations, and
      optional Worker trust boundaries are documented.
- [x] Unofficial distributors are told that the source license does not grant
      trademark rights.
- [ ] Every shipped production dependency has an attributable license entry or
      a completed manual legal review.

## Release decision

Source publication is ready only when every technical item above is checked.
Binary redistribution additionally requires the dependency-license review to
be complete. The automated non-strict compliance check is a useful gate, but it
does not replace legal review of dependencies flagged for manual inspection.
