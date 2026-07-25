# Third-Party Notices

Bytro Community Edition depends on third-party software and assets. Those
components remain subject to their own licenses and are not relicensed under
Apache-2.0 by this repository.

## Dependency families

The source tree and lockfiles include dependencies from the following families:

| Component family                                      | Typical license                       |
| ----------------------------------------------------- | ------------------------------------- |
| React, Zustand, CodeMirror, xterm.js, Tauri ecosystem | MIT and/or Apache-2.0                 |
| Rust crates used by the Tauri application             | License declared by each crate        |
| Fontsource font packages                              | SIL Open Font License 1.1             |
| OpenAI and MCP SDK packages                           | Package-specific terms                |
| Cloudflare Workers tooling                            | Package-specific open-source licenses |

The package lockfiles are the authoritative version inventory. A release
maintainer must generate and review a complete dependency license report for
the exact release commit, including npm packages, Rust crates, bundled native
libraries, fonts, and generated artifacts.

## Fonts

Font files supplied through `@fontsource-variable/*` packages are distributed
under the license shipped by each font package, commonly the SIL Open Font
License 1.1. Preserve each package's copyright and license files in binary
distributions.

## Bytro Community Edition visual identity

The application icon and favicon are original project assets:

- Vector source: `src-tauri/icons/icon.svg`
- Raster and platform-specific derivatives: `src/assets/logo.png`,
  `src-tauri/icons/*`, `public/favicon.ico`, and
  `public/icons/favicon-*.png`
- Copyright: Copyright 2026 Bytro Community Edition contributors
- License: Apache License 2.0, under the same terms as this repository

The raster, ICNS, and ICO files are deterministic derivatives generated from
the vector source with the Tauri icon tool. They do not incorporate the
unverified icons from the pre-community codebase.

## Caveman prompt rules

`sidecar/src/caveman/rules.ts` incorporates portions of the Caveman project:

- Source: <https://github.com/JuliusBrussee/caveman>
- Upstream file:
  <https://github.com/JuliusBrussee/caveman/blob/main/skills/caveman/SKILL.md>
- License text:
  <https://github.com/JuliusBrussee/caveman/blob/main/LICENSE>
- License: MIT
- Copyright: Copyright (c) 2026 Julius Brussee

The upstream MIT license is reproduced in full:

> MIT License
>
> Copyright (c) 2026 Julius Brussee
>
> Permission is hereby granted, free of charge, to any person obtaining a copy
> of this software and associated documentation files (the "Software"), to deal
> in the Software without restriction, including without limitation the rights
> to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
> copies of the Software, and to permit persons to whom the Software is
> furnished to do so, subject to the following conditions:
>
> The above copyright notice and this permission notice shall be included in
> all copies or substantial portions of the Software.
>
> THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
> IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
> FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
> AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
> LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
> OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
> SOFTWARE.

## External CLI runtimes

Claude CLI and Codex CLI are optional, user-installed third-party programs.
They are not bundled, downloaded, updated, or sublicensed by this repository.
Users are responsible for obtaining them from provider-authorized sources and
accepting the applicable provider terms. The upstream OpenAI Codex CLI source
at <https://github.com/openai/codex> is Apache-2.0 licensed. Claude CLI remains
subject to Anthropic's applicable terms.

## Service and provider marks

Names and logos for model providers, Git hosting services, Cloudflare, and
other integrations are trademarks of their respective owners. Their presence
is intended only to identify compatibility and does not imply endorsement.
Provider marks must not be repurposed as Bytro branding. The bundled Bytro
Community Edition application icon has the project-owned provenance documented
above.

## Excluded integrations

OpenPencil, CanvasKit, private Bytro services, private update artifacts, and
managed runtime bundles are outside the Community Edition distribution. If any
such code or asset is present in a release candidate, the release must be
blocked until it is removed or its license and attribution obligations are
fully documented.

## Release gate

This file is an initial human-readable notice, not a substitute for a complete
software bill of materials. Before publishing a binary:

1. run `npm run check:third-party:strict`;
2. scan every lockfile and bundled artifact;
3. resolve entries with missing, custom, `SEE LICENSE`, copyleft, or
   source-offer obligations;
4. preserve upstream `LICENSE`, `NOTICE`, and attribution files;
5. verify that every installer contains `LICENSE`, `NOTICE`, and
   `THIRD_PARTY_NOTICES.md`;
6. verify asset and trademark provenance; and
7. attach the reviewed notice set and SBOM to the release.

License compatibility and attribution requirements should be reviewed by
qualified counsel before the first public binary release.
