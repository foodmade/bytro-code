// ---------------------------------------------------------------------------
// Per-platform credential strategy for the Claude CLI.
//
// The Claude CLI reads credentials from process.env.  Different platforms
// need different env-var combinations:
//
//   - Anthropic official (claude, codex) → ANTHROPIC_API_KEY  (x-api-key header)
//   - Third-party compatible (grok, deepseek, qwen, bigmodel, mimo) → ANTHROPIC_AUTH_TOKEN (Bearer header)
//
// Each platform also has its own rules about which additional env vars
// (ANTHROPIC_MODEL, ANTHROPIC_BASE_URL) to set.  The strategy pattern
// ensures these rules are isolated and extensible — adding a new platform
// only requires adding a new entry to PLATFORM_STRATEGIES.
// ---------------------------------------------------------------------------

import type { PlatformId } from "./protocol.js";
import { httpProxyForSocksProxy } from "./socks-http-bridge.js";
import {
  validateProviderBaseUrl,
  validateProxyUrl,
} from "./endpoint-validation.js";

// ---------------------------------------------------------------------------
// Credential generation counter — prevents the race condition where
// restoreCredentials from an older query wipes out a newer query's
// credentials.  The old value-based guard failed when both queries used
// the same API key (currentValue === weWrote → true → restore to
// undefined → delete key → newer query silently fails).
// ---------------------------------------------------------------------------

let credentialGeneration = 0;

const CREDENTIAL_KEYS = [
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_BASE_URL",
  "ANTHROPIC_MODEL",
  "ANTHROPIC_DEFAULT_OPUS_MODEL",
  "ANTHROPIC_DEFAULT_SONNET_MODEL",
  "ANTHROPIC_DEFAULT_HAIKU_MODEL",
  // Ollama behavior flags — set only for ollama platform, must be
  // saved/restored so they don't leak into Claude requests when
  // concurrent queries overlap.
  "DISABLE_PROMPT_CACHING",
  "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC",
  "CLAUDE_CODE_ATTRIBUTION_HEADER",
  // Kimi platform flag — disables tool search to avoid unsupported
  // behaviour on the Kimi API.
  "ENABLE_TOOL_SEARCH",
  // Anthropic subscription OAuth (sk-ant-oat*) — Claude Code CLI reads this
  // env var instead of ANTHROPIC_API_KEY to authenticate with the user's
  // Pro/Max/Team/Enterprise plan.
  "CLAUDE_CODE_OAUTH_TOKEN",
  // Restores the 1h prompt-cache TTL on api.anthropic.com (the post-2026-03
  // regression silently shortened it to 5m). Set only for the official
  // Anthropic platform; harmless on third-party relays but unnecessary.
  "ENABLE_PROMPT_CACHING_1H",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "ALL_PROXY",
  "http_proxy",
  "https_proxy",
  "all_proxy",
] as const;

const PROXY_ENV_KEYS = [
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "ALL_PROXY",
  "http_proxy",
  "https_proxy",
  "all_proxy",
] as const;

// ---------------------------------------------------------------------------
// Public interface
// ---------------------------------------------------------------------------

/** Env vars saved before a request so they can be restored afterward. */
export interface SavedEnv {
  readonly ANTHROPIC_API_KEY: string | undefined;
  readonly ANTHROPIC_AUTH_TOKEN: string | undefined;
  readonly ANTHROPIC_BASE_URL: string | undefined;
  readonly ANTHROPIC_MODEL: string | undefined;
  readonly ANTHROPIC_DEFAULT_OPUS_MODEL: string | undefined;
  readonly ANTHROPIC_DEFAULT_SONNET_MODEL: string | undefined;
  readonly ANTHROPIC_DEFAULT_HAIKU_MODEL: string | undefined;
  readonly DISABLE_PROMPT_CACHING: string | undefined;
  readonly CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: string | undefined;
  readonly CLAUDE_CODE_ATTRIBUTION_HEADER: string | undefined;
  readonly ENABLE_TOOL_SEARCH: string | undefined;
  readonly CLAUDE_CODE_OAUTH_TOKEN: string | undefined;
  readonly ENABLE_PROMPT_CACHING_1H: string | undefined;
  readonly HTTP_PROXY: string | undefined;
  readonly HTTPS_PROXY: string | undefined;
  readonly ALL_PROXY: string | undefined;
  readonly http_proxy: string | undefined;
  readonly https_proxy: string | undefined;
  readonly all_proxy: string | undefined;
  /** Generation number at the time applyCredentials was called. */
  readonly _generation: number;
}

/** Per-provider rules for setting env vars before a Claude SDK call. */
interface CredentialStrategy {
  /** Which env var receives the API key. */
  readonly apiKeyEnvVar: "ANTHROPIC_API_KEY" | "ANTHROPIC_AUTH_TOKEN";
  /** Whether to set ANTHROPIC_MODEL from the request's model field. */
  readonly setModel: boolean;
  /** Whether to clear the *other* API-key env var to prevent interference. */
  readonly clearAlternateKey: boolean;
}

// ---------------------------------------------------------------------------
// Strategy definitions — one per provider
// ---------------------------------------------------------------------------

const ANTHROPIC_OFFICIAL: CredentialStrategy = {
  apiKeyEnvVar: "ANTHROPIC_API_KEY",
  setModel: false,
  clearAlternateKey: false,
};

const THIRD_PARTY_COMPATIBLE: CredentialStrategy = {
  apiKeyEnvVar: "ANTHROPIC_AUTH_TOKEN",
  setModel: true,
  clearAlternateKey: true,
};

/** Ollama: per official docs (https://docs.ollama.com/integrations/claude-code)
 *  ANTHROPIC_AUTH_TOKEN=ollama, ANTHROPIC_API_KEY="" (empty string).
 *  Claude Code prioritises AUTH_TOKEN over API_KEY, so this ensures Bearer auth
 *  is used while the empty API_KEY prevents the CLI from falling back to
 *  x-api-key auth. Also set ANTHROPIC_MODEL for subagent routing. */
const OLLAMA_LOCAL: CredentialStrategy = {
  apiKeyEnvVar: "ANTHROPIC_AUTH_TOKEN",
  setModel: true,
  clearAlternateKey: false,  // keep API_KEY — we'll set it to "" explicitly
};

const PLATFORM_STRATEGIES: Record<PlatformId, CredentialStrategy> = {
  claude: ANTHROPIC_OFFICIAL,
  codex: ANTHROPIC_OFFICIAL,     // codex agent — doesn't actually reach here
  gemini: ANTHROPIC_OFFICIAL,    // gemini agent — doesn't actually reach here
  grok: THIRD_PARTY_COMPATIBLE,
  deepseek: THIRD_PARTY_COMPATIBLE,
  qwen: THIRD_PARTY_COMPATIBLE,
  bigmodel: THIRD_PARTY_COMPATIBLE,
  mimo: THIRD_PARTY_COMPATIBLE,
  minimax: THIRD_PARTY_COMPATIBLE,
  kimi: THIRD_PARTY_COMPATIBLE,
  ollama: OLLAMA_LOCAL,
};

// ---------------------------------------------------------------------------
// Async mutex — serialises credential apply/restore lifecycles so that two
// concurrent requests with DIFFERENT providers cannot interleave env-var
// mutations.  Within a single Node.js event-loop tick (synchronous code),
// there is no race; this lock protects against interleaving across `await`
// points inside the SDK's `query()` call.
//
// Usage:
//   const release = await acquireCredentialLock();
//   const saved = await applyCredentials(...);
//   try { await sdkQuery(); }
//   finally { restoreCredentials(saved); release(); }
// ---------------------------------------------------------------------------

let _lockQueue: Promise<void> = Promise.resolve();

export function acquireCredentialLock(): Promise<() => void> {
  let release!: () => void;
  const prev = _lockQueue;
  _lockQueue = new Promise<void>((r) => { release = r; });
  return prev.then(() => release);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

function getStrategy(platform: PlatformId | undefined): CredentialStrategy {
  if (!platform) return ANTHROPIC_OFFICIAL;
  return PLATFORM_STRATEGIES[platform] ?? ANTHROPIC_OFFICIAL;
}

function formatProxyForLog(proxyUrl: string | undefined): string {
  if (!proxyUrl) return "(none)";
  try {
    const parsed = new URL(proxyUrl);
    const auth = parsed.username ? "***@" : "";
    return `${parsed.protocol}//${auth}${parsed.host}`;
  } catch {
    return "(invalid)";
  }
}

function formatBaseUrlForLog(baseUrl: string | undefined): string {
  if (!baseUrl) return "(empty)";
  try {
    const parsed = new URL(baseUrl);
    return `${parsed.protocol}//${parsed.host}`;
  } catch {
    return "(invalid)";
  }
}

async function proxyUrlForCliEnv(proxyUrl: string): Promise<string> {
  const parsed = new URL(proxyUrl);
  if (parsed.protocol === "socks5:" || parsed.protocol === "socks5h:") {
    return httpProxyForSocksProxy(proxyUrl);
  }
  if (parsed.protocol === "http:" || parsed.protocol === "https:") {
    return proxyUrl;
  }
  throw new Error(`Unsupported proxy protocol for Claude CLI: ${parsed.protocol}`);
}

async function applyProxyEnv(proxyUrl: string | undefined): Promise<void> {
  for (const key of PROXY_ENV_KEYS) {
    delete process.env[key];
  }
  const trimmed = proxyUrl?.trim();
  if (!trimmed) return;

  const cliProxyUrl = await proxyUrlForCliEnv(validateProxyUrl(trimmed));
  for (const key of PROXY_ENV_KEYS) {
    process.env[key] = cliProxyUrl;
  }
}

/** Snapshot current env vars, then set them according to the platform's strategy. */
export async function applyCredentials(
  platform: PlatformId | undefined,
  apiKey: string | undefined,
  baseUrl: string | undefined,
  model: string | undefined,
  proxyUrl?: string,
): Promise<SavedEnv> {
  const validatedBaseUrl = baseUrl
    ? validateProviderBaseUrl(baseUrl)
    : undefined;
  const validatedProxyUrl = proxyUrl
    ? validateProxyUrl(proxyUrl)
    : undefined;
  const strategy = getStrategy(platform);
  const generation = ++credentialGeneration;

  const saved: SavedEnv = {
    ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
    ANTHROPIC_AUTH_TOKEN: process.env.ANTHROPIC_AUTH_TOKEN,
    ANTHROPIC_BASE_URL: process.env.ANTHROPIC_BASE_URL,
    ANTHROPIC_MODEL: process.env.ANTHROPIC_MODEL,
    ANTHROPIC_DEFAULT_OPUS_MODEL: process.env.ANTHROPIC_DEFAULT_OPUS_MODEL,
    ANTHROPIC_DEFAULT_SONNET_MODEL: process.env.ANTHROPIC_DEFAULT_SONNET_MODEL,
    ANTHROPIC_DEFAULT_HAIKU_MODEL: process.env.ANTHROPIC_DEFAULT_HAIKU_MODEL,
    DISABLE_PROMPT_CACHING: process.env.DISABLE_PROMPT_CACHING,
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: process.env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC,
    CLAUDE_CODE_ATTRIBUTION_HEADER: process.env.CLAUDE_CODE_ATTRIBUTION_HEADER,
    ENABLE_TOOL_SEARCH: process.env.ENABLE_TOOL_SEARCH,
    CLAUDE_CODE_OAUTH_TOKEN: process.env.CLAUDE_CODE_OAUTH_TOKEN,
    ENABLE_PROMPT_CACHING_1H: process.env.ENABLE_PROMPT_CACHING_1H,
    HTTP_PROXY: process.env.HTTP_PROXY,
    HTTPS_PROXY: process.env.HTTPS_PROXY,
    ALL_PROXY: process.env.ALL_PROXY,
    http_proxy: process.env.http_proxy,
    https_proxy: process.env.https_proxy,
    all_proxy: process.env.all_proxy,
    _generation: generation,
  };

  process.stderr.write(
    `[credential-strategy] applyCredentials (gen=${generation}):\n` +
    `  platform       = ${platform ?? "(none)"}\n` +
    `  apiKeyEnvVar   = ${strategy.apiKeyEnvVar}\n` +
    `  setModel       = ${strategy.setModel}\n` +
    `  clearAlternate = ${strategy.clearAlternateKey}\n` +
    `  apiKey         = ${apiKey ? "(set)" : "(empty)"}\n` +
    `  baseUrl        = ${formatBaseUrlForLog(validatedBaseUrl)}\n` +
    `  model          = ${model ?? "(none)"}\n` +
    `  proxy          = ${formatProxyForLog(validatedProxyUrl)}\n`,
  );

  // Always clear ALL credential env vars first to start from a clean slate.
  // This prevents stale values from a previous query (whose restoreCredentials
  // was skipped due to generation mismatch) from leaking into this query.
  for (const key of CREDENTIAL_KEYS) {
    delete process.env[key];
  }
  await applyProxyEnv(validatedProxyUrl);

  // Restore the 1h prompt-cache TTL on api.anthropic.com (silently regressed
  // to 5m around 2026-03). Only set for the official Anthropic platform —
  // covers both OAuth subscription and official API key paths. Do NOT pair
  // with DISABLE_TELEMETRY: that flag reverts the TTL back to 5m.
  if (platform === "claude") {
    process.env.ENABLE_PROMPT_CACHING_1H = "1";
  }

  // Anthropic subscription OAuth branch.
  // sk-ant-oat* tokens are ONLY valid against api.anthropic.com and must be
  // sent via CLAUDE_CODE_OAUTH_TOKEN (not ANTHROPIC_API_KEY). Deliberately
  // skip setting ANTHROPIC_API_KEY / ANTHROPIC_AUTH_TOKEN / ANTHROPIC_BASE_URL
  // so that (a) the CLI uses subscription auth, and (b) the token cannot be
  // leaked to a third-party relay set via baseUrl.
  const isOAuthToken =
    typeof apiKey === "string" && apiKey.startsWith("sk-ant-oat");
  if (isOAuthToken && platform === "claude") {
    process.env.CLAUDE_CODE_OAUTH_TOKEN = apiKey;
    process.stderr.write(
      `[credential-strategy] after apply (gen=${generation}) — OAuth subscription:\n` +
      `  CLAUDE_CODE_OAUTH_TOKEN = (set)\n` +
      `  ANTHROPIC_API_KEY       = (unset, OAuth mode)\n` +
      `  ANTHROPIC_BASE_URL      = (unset, forced to api.anthropic.com)\n`,
    );
    return saved;
  }

  // Now set only the vars needed for this provider/request.
  if (apiKey) {
    process.env[strategy.apiKeyEnvVar] = apiKey;
  }

  // Ollama: per official docs, ANTHROPIC_API_KEY must be an empty string
  // (not undefined/deleted) so Claude Code CLI doesn't fall back to
  // interactive OAuth or prompt for a key.  The empty string satisfies
  // the "key exists" check while ensuring x-api-key auth is never used.
  if (platform === "ollama") {
    process.env.ANTHROPIC_API_KEY = "";
    // Disable token counting — Ollama doesn't support
    // /v1/messages/count_tokens; repeated 404s cause cascading 500s
    // (see https://github.com/ollama/ollama/issues/13949)
    process.env.DISABLE_PROMPT_CACHING = "1";
    // Disable MCP server fetching from api.anthropic.com and other
    // nonessential cloud traffic that hangs the CLI on local backends
    // (see https://github.com/anthropics/claude-code/issues/25412)
    process.env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = "1";
    // Disable attribution header that invalidates Ollama's KV cache,
    // causing ~90% slower inference with local models
    process.env.CLAUDE_CODE_ATTRIBUTION_HEADER = "0";
  }

  // Kimi: disable tool search — the Kimi API does not support this feature
  if (platform === "kimi") {
    process.env.ENABLE_TOOL_SEARCH = "false";
  }

  if (validatedBaseUrl) {
    process.env.ANTHROPIC_BASE_URL = validatedBaseUrl;
  }

  if (model && strategy.setModel) {
    process.env.ANTHROPIC_MODEL = model;
    // Third-party providers: also set per-tier model env vars so that
    // Claude Code CLI subagents (Task tool) resolve "opus", "sonnet",
    // "haiku" to valid model names on this provider's API.  Without
    // these, subagents use Anthropic-specific names (e.g. "haiku") that
    // the third-party endpoint does not recognise → HTTP 404.
    process.env.ANTHROPIC_DEFAULT_OPUS_MODEL = model;
    process.env.ANTHROPIC_DEFAULT_SONNET_MODEL = model;
    process.env.ANTHROPIC_DEFAULT_HAIKU_MODEL = model;
  }

  process.stderr.write(
    `[credential-strategy] after apply (gen=${generation}):\n` +
    `  ANTHROPIC_API_KEY    = ${process.env.ANTHROPIC_API_KEY ? "(set)" : "(empty)"}\n` +
    `  ANTHROPIC_AUTH_TOKEN = ${process.env.ANTHROPIC_AUTH_TOKEN ? "(set)" : "(empty)"}\n` +
    `  ANTHROPIC_BASE_URL   = ${formatBaseUrlForLog(process.env.ANTHROPIC_BASE_URL)}\n` +
    `  ANTHROPIC_MODEL      = ${process.env.ANTHROPIC_MODEL ?? "(unset)"}\n` +
    `  ENABLE_PROMPT_CACHING_1H = ${process.env.ENABLE_PROMPT_CACHING_1H ?? "(unset)"}\n`,
  );

  return saved;
}

/**
 * Restore env vars to the state captured by applyCredentials.
 *
 * Uses a generation counter to prevent the race condition where an older
 * query's restoreCredentials runs after a newer query's applyCredentials:
 *
 *   1. Request A: applyCredentials (gen=1) → sets ANTHROPIC_API_KEY
 *   2. Request B: applyCredentials (gen=2) → sets ANTHROPIC_API_KEY
 *   3. Request A: restoreCredentials (gen=1) → gen < current(2) → SKIP ✓
 *
 * The old value-based guard (`currentValue === weWrote`) failed when both
 * requests used the same API key, causing the restore to incorrectly delete
 * the key — the root cause of "No Response received" on macOS.
 */
export function restoreCredentials(saved: SavedEnv): void {
  // If a newer applyCredentials has been called since ours, the env vars
  // now belong to that newer request.  Don't touch them.
  if (saved._generation !== credentialGeneration) {
    process.stderr.write(
      `[credential-strategy] restoreCredentials SKIPPED: ` +
      `our gen=${saved._generation}, current gen=${credentialGeneration}\n`,
    );
    return;
  }

  process.stderr.write(
    `[credential-strategy] restoreCredentials (gen=${saved._generation}):\n`,
  );

  for (const key of CREDENTIAL_KEYS) {
    const originalValue = saved[key];
    if (originalValue !== undefined) {
      process.env[key] = originalValue;
    } else {
      delete process.env[key];
    }
  }
}
