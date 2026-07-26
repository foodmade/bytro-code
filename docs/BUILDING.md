# Building from Source

Community Edition supports local development and local packaging. It does not
include a command that publishes official releases, uploads hotpatches, or
deploys private infrastructure.

## Prerequisites

- Node.js 20.19+ or 22.12+ for the desktop application; Node.js 22.12+ when
  installing or validating the optional preview Worker
- npm 10 or newer
- Rust stable
- Git
- platform prerequisites from the
  [Tauri 2 guide](https://v2.tauri.app/start/prerequisites/)

## Install

```bash
npm ci
npm --prefix sidecar ci
```

Do not use a production credential while validating an unfamiliar checkout.

Claude and Codex runtimes are **not build inputs** — nothing is downloaded
during `npm ci` or `cargo build`, and no copy is bundled into the packaged
application. `src-tauri/build.rs` only reads the pinned version strings out of
`sidecar/package.json` and embeds them as constants. The runtime itself is
installed at *runtime*, on the end user's machine, from the public npm
registry — see
[Provider Configuration](PROVIDERS.md#how-bytro-finds-a-runtime). The upstream
Codex CLI source is Apache-2.0 licensed; Claude runtimes are governed by
Anthropic's applicable terms.

## Development

```bash
npm run tauri dev
```

The Tauri development hook starts the frontend and prepares the Sidecar as
defined by the project configuration.

## Checks

Run the complete local gate after all three npm workspaces have been installed:

```bash
npm --prefix services/site-preview-worker ci
npm run ci:gate
```

Individual checks include:

```bash
npm run audit:dependencies
npm run check:community
npm run lint:ci
npm test
npm run test:sidecar
npm run build
npm run typecheck:sidecar
cargo fmt --manifest-path src-tauri/Cargo.toml --all --check
cargo check --manifest-path src-tauri/Cargo.toml --locked
cargo test --manifest-path src-tauri/Cargo.toml --locked \
  --all-targets --all-features
cargo clippy --manifest-path src-tauri/Cargo.toml --locked \
  --all-targets --all-features -- -D warnings
```

The optional Worker has its own check:

```bash
npm --prefix services/site-preview-worker ci
npm --prefix services/site-preview-worker test
npm --prefix services/site-preview-worker exec tsc -- --noEmit
npm --prefix services/site-preview-worker run build:check
```

Generate a dependency inventory and SPDX SBOMs without committing generated
output:

```bash
node scripts/check-third-party-compliance.cjs
```

By default, output is written to a newly created operating-system temporary
directory. Use `--output <directory>` to retain it as a CI or release artifact.
The automated check fails on missing or non-standard runtime license
declarations and lists licenses that need manual review. Before distributing a
binary, run the strict review gate after recording any approved exact
package/version/license combinations in
`scripts/third-party-license-policy.json`:

```bash
node scripts/check-third-party-compliance.cjs --strict
```

The generated `manual-review.json` provides the exact policy key for each
runtime license that can be approved after review. Missing, `SEE LICENSE`,
proprietary, or otherwise non-standard runtime declarations cannot be
allowlisted by this gate; remove the dependency or document a standard
redistributable license before release.

## Local package

```bash
npm run build:sidecar
npm run tauri build
```

The output location and package format are platform-dependent. Code signing and
notarization credentials are the builder's responsibility and must not be
committed.

## Unofficial builds

Apache-2.0 allows forks and redistribution, including commercial
redistribution. The license does not grant trademark rights in Bytro
Community Edition, Bytro, or their logos. A redistributed build must follow
[TRADEMARKS.md](../TRADEMARKS.md), identify its maintainer, use distinct
branding and identifiers, and preserve required notices.

## Release checklist

Before distributing any binary:

1. run frontend, Sidecar, Rust, and Worker checks;
2. scan the complete Git history and build context for secrets;
3. prove that account, official credential, Canvas, managed update, and private
   release paths are absent;
4. observe runtime network traffic;
5. generate an SBOM and dependency license inventory;
6. review and resolve every entry in `manual-review.json`;
7. confirm that every installer contains readable copies of `LICENSE`,
   `NOTICE`, and `THIRD_PARTY_NOTICES.md`;
8. review bundled fonts, logos, icons, native libraries, and notices;
9. sign the package using the distributor's identity; and
10. publish checksums and clearly label the distributor.

The dependency review in step 6 is enforced by:

```bash
npm run check:third-party:strict
```

This strict binary-distribution gate intentionally fails until every reported
license review item has a documented resolution. The normal `ci:gate` remains
a source-validation gate and must not be treated as approval to publish a
binary.

The repository intentionally provides no one-step official release command.
