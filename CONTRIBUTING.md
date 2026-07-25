# Contributing

Thank you for helping improve Bytro Community Edition.

## Scope

Contributions should preserve the Community Edition boundary:

- local-first operation;
- user-supplied credentials and local runtimes;
- no Bytro account, official model, subscription, or usage service;
- no Canvas/OpenPencil code or resources;
- no Bytro-managed runtime downloads or cloud updates;
- no hosted remote-control service; and
- no private release infrastructure or embedded deployment secrets.

If a proposal changes one of these boundaries, start a design discussion before
writing code.

## Before opening a change

1. Search existing issues and pull requests.
2. Keep the change focused and avoid unrelated formatting or refactoring.
3. Add or update tests for behavior changes.
4. Update public documentation when configuration, data flow, or user-visible
   behavior changes.
5. Confirm that no credential, private URL, local path, generated artifact, or
   personal data is included.

## Local checks

Install dependencies:

```bash
npm ci
npm --prefix sidecar ci
```

Run the checks relevant to your change:

```bash
npm run check:community
npm test
npm run test:sidecar
npm run build
npm run typecheck:sidecar
cargo check --manifest-path src-tauri/Cargo.toml --locked
cargo test --manifest-path src-tauri/Cargo.toml --locked \
  --all-targets --all-features
```

After installing the optional Worker dependencies, `npm run ci:gate` runs the
complete dependency audit, lint, test, build, compliance, and Rust gate.

For the optional Worker:

```bash
npm --prefix services/site-preview-worker ci
npm --prefix services/site-preview-worker test
npm --prefix services/site-preview-worker run typecheck
npm --prefix services/site-preview-worker run build:check
```

## Pull requests

A useful pull request:

- explains the user problem and chosen approach;
- lists behavior and data-flow changes;
- identifies security, privacy, migration, and compatibility impact;
- includes verification steps and results;
- uses screenshots only when they contain no private data; and
- calls out follow-up work explicitly.

Keep generated bundles, packaged applications, local databases, `.env` files,
Wrangler state, and downloaded runtimes out of commits.

## Security fixes

Do not open a public issue for an unpatched vulnerability. Follow
[SECURITY.md](SECURITY.md).

## Licensing

Unless you explicitly state otherwise, a contribution intentionally submitted
for inclusion is provided under the Apache License, Version 2.0, as described
in Section 5 of [LICENSE](LICENSE). You must have the right to submit the code,
documentation, and assets you contribute.

Do not copy code, images, icons, fonts, or generated output from another project
without preserving its license and attribution and confirming compatibility.

## Conduct

Participation is governed by [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md).
