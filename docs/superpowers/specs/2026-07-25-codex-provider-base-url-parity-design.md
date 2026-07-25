# Codex Provider Base URL Parity Design

## Goal

Make Bytro Community use a configured Codex Base URL and API key through the
same three injection paths as the formal Bytro build. A message sent through
Codex must reach the configured provider instead of falling back to
`https://api.openai.com/v1/responses`.

## Root Cause

The community send pipeline correctly carries the saved Base URL and API key
from the frontend through Rust into the Sidecar. The Sidecar also places them
in `OPENAI_BASE_URL` and `OPENAI_API_KEY`.

Unlike the formal build, the community Sidecar does not currently write
`openai_base_url` into the isolated Codex `config.toml` or add
`model_providers.OpenAI.base_url` to the Codex App Server arguments. Codex App
Server therefore uses its default OpenAI endpoint even though the environment
contains the configured Base URL.

## Design

For API-key Codex sessions with a configured Base URL, use the same provider
configuration paths as the formal build:

1. Keep `OPENAI_BASE_URL` and `OPENAI_API_KEY` in the isolated App Server
   environment.
2. Prepend the validated Base URL as `openai_base_url` in the isolated
   `config.toml`.
3. Add `model_providers.OpenAI.base_url` to the Codex App Server `-c`
   arguments.
4. Keep `model_providers.OpenAI.requires_openai_auth=false` and
   `model_providers.OpenAI.env_key="OPENAI_API_KEY"`.

The existing URL validator and TOML serializer remain authoritative. API keys
must not be written into `config.toml` or command-line arguments.

OAuth sessions without a custom Base URL retain their existing behavior.

## Code Scope

Only the Codex App Server setup in `sidecar/src/openai-handler.ts` and its
focused tests are changed. The frontend settings store, Rust credential
resolution, conversation persistence, warm-session routing, and other
providers are out of scope.

Temporary authentication diagnostics remain available until the corrected
flow is verified manually.

## Verification

Automated tests must prove:

- A valid custom Base URL is present in the generated provider arguments.
- The isolated TOML prefix contains exactly one `openai_base_url`.
- The API key never appears in provider arguments or TOML.
- Invalid or credential-bearing URLs are rejected by the existing validator.
- OAuth/default provider arguments remain unchanged.

Build verification consists of Sidecar tests, TypeScript type checking, the
Sidecar bundle build, Rust formatting, and Rust compilation.

Manual verification consists of sending a Codex message with the same Base URL
and API key used by the formal build and confirming that diagnostics no longer
show a request to `api.openai.com`.
