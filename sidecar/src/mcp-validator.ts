// ---------------------------------------------------------------------------
// MCP server configuration validator
// ---------------------------------------------------------------------------
//
// Why this exists:
//   Claude Code CLI (>=0.2.x) validates `mcpServers` against a strict JSON
//   schema at startup. A SINGLE malformed entry (e.g. user pasted a config
//   missing `command` or `url`, or a wrapper from Claude Desktop) causes the
//   CLI to exit immediately with code=1 and the stderr line:
//
//     Error: Invalid MCP configuration:
//     mcpServers.<name>: Does not adhere to MCP server configuration schema
//
//   This used to take down EVERY Claude session (not just the one using the
//   broken server) because nothing in the pipeline (frontend store → Rust
//   pass-through → SDK options) validated the shape before handing the JSON
//   to the CLI.
//
//   This module provides a tolerant pre-filter: invalid entries are dropped
//   with a stderr warning, and only well-formed entries reach the CLI.
//
//   Schema mirrors Claude Code's accepted shapes and the public types in
//   `protocol.ts::McpServerConfig`:
//
//     • stdio (default):  { type?: "stdio", command: string,
//                           args?: string[], env?: Record<string,string> }
//     • sse:              { type: "sse",    url: string,
//                           headers?: Record<string,string> }
//     • http:             { type: "http",   url: string,
//                           headers?: Record<string,string> }
// ---------------------------------------------------------------------------

import { createHash } from "node:crypto";
import type { McpServerConfig } from "./protocol.js";

export interface McpValidationSkip {
  readonly name: string;
  readonly reason: string;
}

export interface McpValidationResult {
  /** Entries that passed validation, keyed by original name. */
  readonly valid: Record<string, McpServerConfig>;
  /** Entries that were rejected, with a human-readable reason. */
  readonly skipped: ReadonlyArray<McpValidationSkip>;
}

const ALLOWED_TYPES = new Set(["stdio", "sse", "http"]);
const MCP_REMOTE_URL_ERROR_CATEGORY = "Invalid remote MCP URL";

function hasUrlControlCharacter(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0) ?? 0;
    if (codePoint <= 0x1f || codePoint === 0x7f) return true;
  }
  return false;
}

function mcpRemoteUrlError(raw: unknown): Error {
  const diagnosticSource =
    typeof raw === "string" ? raw : `${typeof raw}:${String(raw)}`;
  const diagnosticId = createHash("sha256")
    .update(diagnosticSource)
    .digest("hex")
    .slice(0, 12);
  return new Error(
    `${MCP_REMOTE_URL_ERROR_CATEGORY} (diagnosticId: ${diagnosticId})`,
  );
}

function urlAuthorityHasUserinfo(value: string): boolean {
  const remainder = value.split("://", 2)[1];
  if (!remainder) return false;
  const authorityEnd = remainder.search(/[/?#]/);
  const authority = authorityEnd === -1
    ? remainder
    : remainder.slice(0, authorityEnd);
  return authority.includes("@");
}

/**
 * Canonicalize a user-configured remote MCP endpoint.
 *
 * Credentials belong in the separate `headers` object. Query strings are
 * rejected wholesale because they are routinely used for bearer tokens and
 * would otherwise be copied into persisted config, logs, OAuth state, and
 * provider runtime files.
 */
export function normalizeMcpRemoteUrl(raw: unknown): string {
  if (typeof raw !== "string") throw mcpRemoteUrlError(raw);
  const value = raw.trim();
  if (!value || hasUrlControlCharacter(value)) {
    throw mcpRemoteUrlError(raw);
  }

  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw mcpRemoteUrlError(raw);
  }

  if (
    (parsed.protocol !== "http:" && parsed.protocol !== "https:")
    || !parsed.hostname
    || parsed.username
    || parsed.password
    || urlAuthorityHasUserinfo(value)
    // URL.search/hash return an empty string for a bare `?`/`#`, so inspect
    // the serialized URL for the delimiters as well.
    || parsed.href.includes("?")
    || parsed.href.includes("#")
  ) {
    throw mcpRemoteUrlError(raw);
  }

  return parsed.toString();
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function isNonEmptyString(v: unknown): v is string {
  return typeof v === "string" && v.trim().length > 0;
}

function isStringRecord(v: unknown): boolean {
  if (!isPlainObject(v)) return false;
  for (const val of Object.values(v)) {
    if (typeof val !== "string") return false;
  }
  return true;
}

function validateCommonMcpFields(cfg: Record<string, unknown>): string | null {
  if (cfg.alwaysLoad !== undefined && typeof cfg.alwaysLoad !== "boolean") {
    return "'alwaysLoad' must be a boolean if provided";
  }
  if (cfg.timeout !== undefined && (typeof cfg.timeout !== "number" || !Number.isFinite(cfg.timeout))) {
    return "'timeout' must be a finite number if provided";
  }
  return null;
}

/**
 * Validate a single MCP server entry. Returns the entry cast to
 * `McpServerConfig` on success, or a rejection reason on failure.
 *
 * The validator is intentionally permissive: it only checks fields that
 * Claude Code's schema requires. Unknown extra fields are preserved (the
 * CLI ignores them in practice). The goal is to catch the small set of
 * shapes that would crash the CLI, not to fully re-implement its schema.
 */
export function validateMcpServerConfig(
  raw: unknown,
): { ok: true; config: McpServerConfig } | { ok: false; reason: string } {
  if (!isPlainObject(raw)) {
    return { ok: false, reason: "entry is not a JSON object" };
  }

  const cfg = raw;
  const explicitType = cfg.type;
  if (explicitType !== undefined && (typeof explicitType !== "string" || !ALLOWED_TYPES.has(explicitType))) {
    return {
      ok: false,
      reason: `'type' must be one of "stdio" | "sse" | "http" (got ${JSON.stringify(explicitType)})`,
    };
  }
  const type = (explicitType as "stdio" | "sse" | "http" | undefined) ?? "stdio";
  const commonError = validateCommonMcpFields(cfg);
  if (commonError) {
    return { ok: false, reason: commonError };
  }

  if (type === "stdio") {
    if (!isNonEmptyString(cfg.command)) {
      return { ok: false, reason: "stdio server requires non-empty 'command' (string)" };
    }
    if (cfg.args !== undefined) {
      if (!Array.isArray(cfg.args) || cfg.args.some((a) => typeof a !== "string")) {
        return { ok: false, reason: "'args' must be an array of strings if provided" };
      }
    }
    if (cfg.env !== undefined && !isStringRecord(cfg.env)) {
      return { ok: false, reason: "'env' must be an object of string→string if provided" };
    }
    return { ok: true, config: cfg as unknown as McpServerConfig };
  }

  // sse / http
  let normalizedUrl: string;
  try {
    normalizedUrl = normalizeMcpRemoteUrl(cfg.url);
  } catch (error) {
    return {
      ok: false,
      reason: error instanceof Error
        ? error.message
        : MCP_REMOTE_URL_ERROR_CATEGORY,
    };
  }
  if (cfg.headers !== undefined && !isStringRecord(cfg.headers)) {
    return { ok: false, reason: "'headers' must be an object of string→string if provided" };
  }
  return {
    ok: true,
    config: { ...cfg, url: normalizedUrl } as unknown as McpServerConfig,
  };
}

/**
 * Filter a `mcpServers` record, returning only valid entries and a list of
 * rejected entries with reasons. Callers are expected to log the `skipped`
 * list to stderr so users can debug their configuration.
 *
 * Pass-through behavior:
 *   • `undefined` / empty input → `{ valid: {}, skipped: [] }`
 *   • An entry whose value is not a plain object is rejected.
 */
export function filterValidMcpServers(
  servers: Readonly<Record<string, unknown>> | undefined | null,
): McpValidationResult {
  const valid: Record<string, McpServerConfig> = {};
  const skipped: McpValidationSkip[] = [];

  if (!servers || typeof servers !== "object") {
    return { valid, skipped };
  }

  for (const [name, raw] of Object.entries(servers)) {
    const result = validateMcpServerConfig(raw);
    if (result.ok) {
      valid[name] = result.config;
    } else {
      skipped.push({ name, reason: result.reason });
    }
  }

  return { valid, skipped };
}
