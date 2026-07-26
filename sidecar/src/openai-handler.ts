// ---------------------------------------------------------------------------
// Codex App Server handler — communicates with local Codex binary via JSON-RPC
// Architecture: Sidecar → spawn codex app-server → JSON-RPC over stdio → notifications → sidecar protocol
//
// Feature parity with claude-handler:
//   - Extended thinking (reasoning → thinking_delta)
//   - App-level hooks (file_changed, todo_updated events)
//   - Retry with exponential backoff (3 attempts)
//   - Real-time stream_usage token tracking
//   - disableTools mode
//   - Compact tracking (context window monitoring)
//   - Warm sessions (long-lived app-server process, thread reuse)
//   - Mid-turn steer (inject messages into active turns)
//   - Interactive approval (bidirectional JSON-RPC requests)
//
// Warm sessions: The App Server process is kept alive for the duration of the
// warm session. The thread object retains state in-process, so subsequent turns
// reuse the same thread without needing disk-based resume. Benefits:
//   - No per-turn process spawn overhead
//   - Follow-up messages queue onto the next turn
//   - Interactive approval via bidirectional JSON-RPC
// ---------------------------------------------------------------------------

import { CodexRpcChannel } from "./codex-rpc.js";
import type {
  AuthMode,
  CodexAuthCancelCommand,
  CodexAuthReadCommand,
  CodexAuthSignOutCommand,
  CodexAuthStartCommand,
  CommandInvocationPayload,
  InitSessionCommand,
  QueryCommand,
  GoalSnapshotPayload,
  TodoItem as ProtocolTodoItem,
} from "./protocol.js";
import { getCavemanAddendum } from "./caveman/rules.js";
import {
  createLogger,
  shouldLog,
  makeToolCallId as makeToolCallIdShared,
  truncate,
  buildEffectivePrompt,
  getContextWindowForModel,
  computeTodoDiff,
  getDebugLogPath,
  emitEnterPlanMode,
  defaultToolDisplay,
  makeToolDisplay,
  publicSidecarErrorMessage,
  summarizeDiagnosticText,
} from "./shared.js";
import type { EmitFn, ToolDisplayMeta } from "./shared.js";
import type { SessionChannel } from "./persistent-session-registry.js";
import { registerWarmSession, removeWarmSession, activePromptChannels, hashCredentials, hasWarmSessionForAgent, killWarmSessionsForAgent } from "./persistent-session-registry.js";
import { pendingConfirmations, pendingAskUserQuestions } from "./permissions.js";
import { parseSkillMdContent } from "./skills/scanner.js";
import {
  getProviderDirectoryMtime,
  getProviderRegularFileMtime,
  listProviderDirectory,
  readProviderTextFile,
} from "./provider-readonly.js";
import { existsSync, readFileSync, readdirSync, rmSync, writeFileSync, mkdtempSync, mkdirSync, statSync, lstatSync, chmodSync, realpathSync } from "node:fs";
import { join, dirname, resolve, sep, isAbsolute, relative } from "node:path";
import { homedir, tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { prepareCliProcessInvocation } from "./cli-process.js";
import { buildMinimalCliEnvironment } from "./cli-environment.js";
import { normalizeMcpRemoteUrl } from "./mcp-validator.js";
import {
  validateProviderBaseUrl,
  validateProxyUrl,
} from "./endpoint-validation.js";

// ---------------------------------------------------------------------------
// Local type definitions — mirrors App Server v2 ThreadItem schema.
// Generated via `codex app-server generate-ts`, field names are camelCase.
// ---------------------------------------------------------------------------

interface CodexItemBase {
  readonly id: string;
}

interface AgentMessageItem extends CodexItemBase {
  readonly type: "agentMessage";
  readonly text?: string;
}

interface ReasoningItem extends CodexItemBase {
  readonly type: "reasoning";
  readonly summary?: ReadonlyArray<string>;
  readonly content?: ReadonlyArray<string>;
}

interface CommandExecutionItem extends CodexItemBase {
  readonly type: "commandExecution";
  readonly command: string;
  readonly cwd: string;
  readonly aggregatedOutput?: string;
  readonly exitCode?: number;
  readonly status: "inProgress" | "completed" | "failed" | "cancelled";
}

interface FileChangeItem extends CodexItemBase {
  readonly type: "fileChange";
  readonly changes: ReadonlyArray<{ path: string; kind: CodexFileChangeKind; diff?: string }>;
  readonly status: "completed" | "failed" | "cancelled" | "pending";
}

interface McpToolCallItem extends CodexItemBase {
  readonly type: "mcpToolCall";
  readonly server: string;
  readonly tool: string;
  readonly arguments: Record<string, unknown>;
  readonly result?: unknown;
  readonly error?: { message: string };
  readonly status: "inProgress" | "completed" | "failed";
}

interface WebSearchItem extends CodexItemBase {
  readonly type: "webSearch";
  readonly query: string;
}

interface PlanItem extends CodexItemBase {
  readonly type: "plan";
  readonly text: string;
}

interface ContextCompactionItem extends CodexItemBase {
  readonly type: "contextCompaction";
}

interface CollabAgentToolCallItem extends CodexItemBase {
  readonly type: "collabAgentToolCall";
  readonly tool: "spawnAgent" | "sendInput" | "resumeAgent" | "wait" | "closeAgent";
  readonly status: "inProgress" | "completed" | "failed";
  readonly senderThreadId: string;
  readonly receiverThreadIds: ReadonlyArray<string>;
  readonly prompt: string | null;
  readonly agentsStates?: Readonly<Record<string, {
    readonly status: string;
    readonly message: string | null;
  }>>;
}

type CodexItem =
  | AgentMessageItem
  | ReasoningItem
  | CommandExecutionItem
  | FileChangeItem
  | McpToolCallItem
  | WebSearchItem
  | PlanItem
  | CollabAgentToolCallItem
  | ContextCompactionItem;

// ---------------------------------------------------------------------------
// CodexSessionChannel — async message queue for warm session routing with
// mid-turn steer support.
//
// When a turn is active, push() delegates to the steer callback, injecting
// the message into the running turn via turn/steer. When no turn is active,
// messages are queued for the next turn/start.
// ---------------------------------------------------------------------------

interface ChannelMessage {
  readonly content: string;
  readonly images?: ReadonlyArray<{ media_type: string; data: string }>;
  readonly requestId?: string;
  /** When true, this message was routed from a full Query (not send_user_input).
   *  The frontend already created the assistant placeholder — skip new_turn. */
  readonly routedFromQuery?: boolean;
  /** Per-turn reasoning level override, forwarded from the frontend settings. */
  readonly reasoningLevel?: string;
  /** Slash-command metadata. Codex maps `canonicalName === "compact"` to
   *  `thread/compact/start` instead of running a normal turn. */
  readonly commandInvocation?: CommandInvocationPayload;
}

class CodexSessionChannel implements SessionChannel {
  private _queue: ChannelMessage[] = [];
  private _resolve: ((msg: ChannelMessage | null) => void) | null = null;
  private _closed = false;

  // Steer support
  private _turnActive = false;
  private _steerCallback: ((msg: ChannelMessage) => Promise<void>) | null = null;
  private _activeTurnId: string | null = null;

  push(
    content: string,
    images?: ReadonlyArray<{ media_type: string; data: string }>,
    requestId?: string,
    routedFromQuery?: boolean,
    reasoningLevel?: string,
    commandInvocation?: CommandInvocationPayload,
  ): void {
    log(`[channel.push] called: closed=${this._closed}, turnActive=${this._turnActive}, hasSteerCb=${!!this._steerCallback}, activeTurnId=${this._activeTurnId}, queueLen=${this._queue.length}, hasResolver=${!!this._resolve}, requestId=${requestId}, command=${commandInvocation?.canonicalName ?? "none"}`);
    if (this._closed) {
      log(`[channel.push] DROPPED — channel is closed`);
      return;
    }
    const msg: ChannelMessage = { content, images, requestId, routedFromQuery, reasoningLevel, commandInvocation };

    if (this._turnActive && this._steerCallback) {
      log(`[channel.push] → routing through STEER (turnId=${this._activeTurnId})`);
      this._steerCallback(msg).catch((err) => {
        log(`[steer] Steer failed, falling back to queue: ${err}`);
        this._enqueue(msg);
      });
      return;
    }

    log(`[channel.push] → routing to QUEUE (turnActive=${this._turnActive})`);
    this._enqueue(msg);
  }

  close(): void {
    this._closed = true;
    if (this._resolve) {
      const resolve = this._resolve;
      this._resolve = null;
      resolve(null);
    }
  }

  /** Wait for the next message. Returns null when closed. */
  nextMessage(): Promise<ChannelMessage | null> {
    if (this._queue.length > 0) {
      return Promise.resolve(this._queue.shift()!);
    }
    if (this._closed) return Promise.resolve(null);
    return new Promise<ChannelMessage | null>((resolve) => {
      this._resolve = resolve;
    });
  }

  /** Set whether a turn is currently active and provide the steer callback. */
  setTurnActive(
    active: boolean,
    turnId?: string,
    steerFn?: (msg: ChannelMessage) => Promise<void>,
  ): void {
    log(`[channel.setTurnActive] active=${active}, turnId=${turnId ?? "none"}, hasSteerFn=${!!steerFn}, prevActive=${this._turnActive}, prevTurnId=${this._activeTurnId}`);
    this._turnActive = active;
    this._activeTurnId = turnId ?? null;
    this._steerCallback = active ? (steerFn ?? null) : null;
  }

  get activeTurnId(): string | null {
    return this._activeTurnId;
  }

  private _enqueue(msg: ChannelMessage): void {
    if (this._resolve) {
      log(`[channel._enqueue] resolver available — waking up nextMessage() immediately, requestId=${msg.requestId}`);
      const resolve = this._resolve;
      this._resolve = null;
      resolve(msg);
    } else {
      log(`[channel._enqueue] no resolver — queuing (queueLen=${this._queue.length + 1}), requestId=${msg.requestId}`);
      this._queue.push(msg);
    }
  }
}

const log = createLogger("openai");

const PROXY_ENV_KEYS = [
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "ALL_PROXY",
  "http_proxy",
  "https_proxy",
  "all_proxy",
] as const;

function proxyUrlForEnv(proxyUrl: string): string {
  const trimmed = proxyUrl.trim();
  const socks5Prefix = "socks5://";
  if (trimmed.slice(0, socks5Prefix.length).toLowerCase() === socks5Prefix) {
    return `socks5h://${trimmed.slice(socks5Prefix.length)}`;
  }
  return trimmed;
}

function applyProxyEnv(env: Record<string, string>, proxyUrl: string | undefined): void {
  for (const key of PROXY_ENV_KEYS) {
    delete env[key];
  }
  const trimmed = proxyUrl?.trim();
  if (!trimmed) return;
  const normalizedProxyUrl = proxyUrlForEnv(validateProxyUrl(trimmed));
  for (const key of PROXY_ENV_KEYS) {
    env[key] = normalizedProxyUrl;
  }
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
  if (!baseUrl) return "(default)";
  try {
    const parsed = new URL(baseUrl);
    return `${parsed.protocol}//${parsed.host}`;
  } catch {
    return "(invalid)";
  }
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MAX_QUERY_ATTEMPTS = 5;
let goalGetUnsupported = false;

// ---------------------------------------------------------------------------
// Resolve the Codex CLI binary path.
//
// Priority: CODEX_CLI_PATH, then the user's system PATH.
// ---------------------------------------------------------------------------

let cachedCodexPath: string | undefined;
export const BYTRO_COMMUNITY_HOME_DIR = ".bytro-community";

export function buildBytroCommunityDataPath(
  homeDirectory: string,
  ...segments: ReadonlyArray<string>
): string {
  return join(homeDirectory, BYTRO_COMMUNITY_HOME_DIR, ...segments);
}

export function buildPersistentCodexHome(
  homeDirectory: string,
  conversationId: string,
): string {
  if (!conversationId) {
    throw new Error("Codex conversation ID is required.");
  }
  const sessionsRoot = resolve(
    buildBytroCommunityDataPath(homeDirectory, "codex-sessions"),
  );
  const safeId = createHash("sha256")
    .update(conversationId, "utf8")
    .digest("hex");
  const candidate = resolve(sessionsRoot, safeId);
  const rootPrefix = sessionsRoot.endsWith(sep)
    ? sessionsRoot
    : `${sessionsRoot}${sep}`;
  if (!candidate.startsWith(rootPrefix)) {
    throw new Error("Refusing Codex session path outside the community home.");
  }
  return candidate;
}

export function getCodexProfileHome(
  profileId: string,
  homeDirectory: string = homedir(),
): string {
  const normalizedProfileId = profileId.trim();
  if (!normalizedProfileId) {
    throw new Error("Codex OAuth profile ID is required.");
  }
  const readablePrefix =
    normalizedProfileId
      .replace(/[^a-zA-Z0-9_-]/g, "_")
      .replace(/^_+|_+$/g, "")
      .slice(0, 24) || "profile";
  const digest = createHash("sha256")
    .update(normalizedProfileId, "utf8")
    .digest("hex");
  return buildBytroCommunityDataPath(
    homeDirectory,
    "codex-profiles",
    `${readablePrefix}-${digest}`,
    ".codex",
  );
}

export function buildBuiltinMcpProcessConfig(
  executable: string,
  entryPath: string,
): { readonly command: string; readonly args: readonly [string] } {
  return {
    command: executable,
    args: [entryPath],
  };
}

export function selectCodexBinaryCandidate(
  candidates: readonly string[],
  platform: NodeJS.Platform = process.platform,
): string | undefined {
  if (platform !== "win32") return candidates[0];
  return candidates.find((candidate) => /\.exe$/i.test(candidate))
    ?? candidates.find((candidate) => /\.(?:cmd|bat)$/i.test(candidate));
}

function findCodexBinaryPath(overridePath?: string): string | undefined {
  if (overridePath && existsSync(overridePath)) {
    log(`[binary] Using injected Codex path: ${overridePath}`);
    cachedCodexPath = overridePath;
    return overridePath;
  }

  const configuredPath = process.env.CODEX_CLI_PATH?.trim();
  if (configuredPath && existsSync(configuredPath)) {
    cachedCodexPath = configuredPath;
    return configuredPath;
  }

  if (cachedCodexPath !== undefined && existsSync(cachedCodexPath)) {
    return cachedCodexPath;
  }
  cachedCodexPath = undefined;

  const isWin = process.platform === "win32";
  try {
    const command = isWin ? "where.exe" : "which";
    const results = execFileSync(command, ["codex"], {
      encoding: "utf-8",
      timeout: 5000,
      windowsHide: true,
    }).trim().split(/\r?\n/);

    const candidates = results
      .map((result) => result.trim())
      .filter((result) => result.length > 0 && existsSync(result));
    const resolved = selectCodexBinaryCandidate(
      candidates,
      isWin ? "win32" : process.platform,
    );
    if (resolved) {
      cachedCodexPath = resolved;
      return resolved;
    }
  } catch {
    // Codex is not available on PATH.
  }

  return undefined;
}

// ---------------------------------------------------------------------------
// Dynamically detect the Codex CLI version.
// ---------------------------------------------------------------------------

let cachedCodexVersion: string | undefined;

interface CodexVersionRunOptions {
  readonly encoding: "utf-8";
  readonly timeout: number;
  readonly windowsHide: boolean;
  readonly windowsVerbatimArguments: boolean;
  readonly env: NodeJS.ProcessEnv;
}

type CodexVersionRunner = (
  executable: string,
  args: readonly string[],
  options: CodexVersionRunOptions,
) => string;

export function probeCodexVersion(
  binaryPath: string,
  runner: CodexVersionRunner = (executable, args, options) =>
    execFileSync(executable, [...args], options),
  platform: NodeJS.Platform = process.platform,
  ambient: NodeJS.ProcessEnv = process.env,
): string | undefined {
  const env = buildMinimalCliEnvironment({}, [], ambient);
  env.CODEX_DISABLE_AUTO_UPDATE = "1";
  env.CODEX_DISABLE_TELEMETRY = "1";
  env.CODEX_INTERNAL_APP_SERVER_REMOTE_CONTROL_DISABLED = "1";
  env.CODEX_INTERNAL_ORIGINATOR_OVERRIDE = "bytro-community";
  env.OTEL_SDK_DISABLED = "true";
  env.DO_NOT_TRACK = "1";
  const invocation = prepareCliProcessInvocation(
    binaryPath,
    ["--version"],
    env,
    platform,
  );
  try {
    const output = runner(
      invocation.executable,
      invocation.args,
      {
        encoding: "utf-8",
        timeout: 5_000,
        windowsHide: true,
        windowsVerbatimArguments: invocation.windowsVerbatimArguments,
        env: invocation.env,
      },
    );
    return output.match(/(\d+\.\d+\.\d+)/)?.[1];
  } catch {
    return undefined;
  }
}

function getCodexVersion(_injectedVersion?: string): string {
  if (cachedCodexVersion) return cachedCodexVersion;

  const binaryPath = findCodexBinaryPath();
  if (binaryPath) {
    const version = probeCodexVersion(binaryPath);
    if (version) {
      cachedCodexVersion = version;
      return cachedCodexVersion;
    }
  }

  cachedCodexVersion = "0.0.0";
  return cachedCodexVersion;
}

// ---------------------------------------------------------------------------
// Permission / sandbox mapping
// ---------------------------------------------------------------------------

// AskForApproval type per Codex App Server schema:
//   "untrusted" | "on-failure" | "on-request"
//   | { "reject": { sandbox_approval: boolean, rules: boolean, mcp_elicitations: boolean } }
//   | "never"
type AskForApproval =
  | "untrusted"
  | "on-failure"
  | "on-request"
  | { reject: { sandbox_approval: boolean; rules: boolean; mcp_elicitations: boolean } }
  | "never";

export function mapApprovalPolicy(mode: string): AskForApproval {
  // NOTE: File reads NEVER trigger approval — Codex has no
  //       item/fileRead/requestApproval method in its protocol.
  // NOTE: Plan mode is handled via collaborationMode in turn/start, NOT here.
  switch (mode) {
    case "bypassPermissions":
      return "never";
    case "plan":
    case "planning":
      // Plan mode: Codex handles plan-then-execute via collaborationMode.
      // Use "untrusted" so any execution after plan approval still requires user confirmation.
      return "untrusted";
    case "acceptEdits":
      return "on-request";
    default:
      // default — strictest interactive mode: prompt for commands & file writes
      return "untrusted";
  }
}

export function mapSandboxMode(mode: string): "read-only" | "workspace-write" | "danger-full-access" {
  switch (mode) {
    case "bypassPermissions":
      return "danger-full-access";
    case "plan":
    case "planning":
    case "deep":
      return "read-only";
    default:
      return "workspace-write";
  }
}

export function shouldAutoAcceptCodexApproval(
  permissionMode: string,
  method: string,
  planApproved: boolean,
): boolean {
  if (permissionMode === "bypassPermissions") return true;
  if (planApproved) return true;
  return permissionMode === "acceptEdits"
    && method === "item/fileChange/requestApproval";
}

/**
 * Build collaborationMode param for turn/start.
 *
 * Only send `{ mode: "plan" }` for permission modes that genuinely need the
 * plan-then-execute workflow: "plan", "planning", and "deep".
 *
 * Previously we sent plan mode for ALL non-default modes (including
 * bypassPermissions / acceptEdits) so that the Codex App Server would enable
 * the `request_user_input` tool.  However this caused the model to enter
 * planning behaviour on every message — even trivial ones like "hello" — which
 * resulted in unnecessary file scanning and plan searching before responding.
 *
 * bypassPermissions / acceptEdits now return undefined (no collaborationMode),
 * so the model responds directly without a plan step.  The trade-off is that
 * `request_user_input` is unavailable in those modes, which is acceptable:
 * - bypassPermissions: fully automated, no user interaction needed
 * - acceptEdits: file edits are auto-approved; commands still use the normal
 *   approval flow via item/commandExecution/requestApproval
 *
 * "default" permission mode also returns undefined (all operations need
 * explicit user confirmation via the approval protocol).
 */
function buildCollaborationMode(
  mode: string,
  model: string,
): { mode: "plan" | "default"; settings: { model: string; reasoning_effort: null; developer_instructions: null } } | undefined {
  switch (mode) {
    case "plan":
    case "planning":
    case "deep":
      return {
        mode: "plan",
        settings: { model, reasoning_effort: null, developer_instructions: null },
      };
    default:
      return undefined;
  }
}

// ---------------------------------------------------------------------------
// MCP injection — convert frontend McpServerConfig to Codex config.toml format
// ---------------------------------------------------------------------------

/** Escape a string for TOML basic string representation. */
const TOML_CONTROL_CHAR_PATTERN = new RegExp(
  String.raw`[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]`,
  "g",
);

function tomlString(s: string): string {
  return `"${s
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\n/g, "\\n")
    .replace(/\r/g, "\\r")
    .replace(/\t/g, "\\t")
    .replace(TOML_CONTROL_CHAR_PATTERN, (ch) =>
      `\\u${ch.charCodeAt(0).toString(16).padStart(4, "0")}`,
    )}"`;
}

export function validateCodexBaseUrl(value: string): string {
  return validateProviderBaseUrl(value);
}

export function buildCodexBaseUrlToml(value: string): string {
  return `openai_base_url = ${tomlString(validateCodexBaseUrl(value))}\n\n`;
}

/**
 * Build TOML `[mcp_servers.*]` sections from frontend McpServerConfig records.
 * Runtime projections contain only environment-variable references, never
 * literal stdio env values or HTTP header values.
 */
export function buildMcpTomlSection(
  mcpServers: Readonly<Record<string, unknown>>,
): string {
  const sections: string[] = [];
  const usedNames = new Set<string>();
  for (const [name, config] of Object.entries(mcpServers)) {
    if (!config || typeof config !== "object") continue;
    const cfg = config as Record<string, unknown>;

    // Codex 0.129+ rejects the entire config.toml with `invalid transport`
    // when ANY [mcp_servers.X] table lacks both `command` (stdio) and `url`
    // (streamable_http). A single malformed entry — e.g. a half-configured
    // server from the frontend settings UI — would otherwise tank EVERY MCP
    // server and break thread/start. Skip emission for incomplete configs and
    // surface a log line so users can debug their settings.
    const hasCommand = typeof cfg.command === "string" && cfg.command.length > 0;
    const hasUrl = typeof cfg.url === "string" && (cfg.url as string).length > 0;
    if (!hasCommand && !hasUrl) {
      log(`[mcp] Skipping "${name}" — neither command nor url is set (would cause codex 'invalid transport')`);
      continue;
    }

    // Keep familiar names when possible, but make collisions and empty names
    // deterministic so one user entry can never overwrite another table.
    const baseName = name.replace(/[^a-zA-Z0-9_-]/g, "_") || "server";
    let safeName = baseName;
    if (usedNames.has(safeName)) {
      const suffix = createHash("sha256")
        .update(name)
        .digest("hex")
        .slice(0, 10);
      safeName = `${baseName}_${suffix}`;
      let disambiguator = 2;
      while (usedNames.has(safeName)) {
        safeName = `${baseName}_${suffix}_${disambiguator}`;
        disambiguator += 1;
      }
    }
    usedNames.add(safeName);
    const lines: string[] = [`[mcp_servers.${safeName}]`];

    if (cfg.command) {
      // stdio type
      lines.push(`command = ${tomlString(String(cfg.command))}`);
      if (Array.isArray(cfg.args) && cfg.args.length > 0) {
        lines.push(`args = [${cfg.args.map((a: unknown) => tomlString(String(a))).join(", ")}]`);
      }
      if (Array.isArray(cfg.env_vars) && cfg.env_vars.length > 0) {
        lines.push(
          `env_vars = [${cfg.env_vars.map((value) => tomlString(String(value))).join(", ")}]`,
        );
      }
    } else if (cfg.url) {
      // HTTP / SSE type
      lines.push(`url = ${tomlString(normalizeMcpRemoteUrl(cfg.url))}`);
      if (cfg.env_http_headers && typeof cfg.env_http_headers === "object") {
        const pairs = Object.entries(
          cfg.env_http_headers as Record<string, string>,
        )
          .map(([k, v]) => `${tomlString(k)} = ${tomlString(v)}`)
          .join(", ");
        lines.push(`env_http_headers = { ${pairs} }`);
      }
    }
    // Optional codex per-server timeouts (numbers, in seconds). Default codex
    // values are 10s startup / 60s per tool — long-running tools like image
    // generation need an explicit override.
    for (const numKey of ["startup_timeout_sec", "tool_timeout_sec"] as const) {
      const v = cfg[numKey];
      if (typeof v === "number" && Number.isFinite(v) && v > 0) {
        lines.push(`${numKey} = ${v}`);
      }
    }
    sections.push(lines.join("\n"));
  }
  return sections.join("\n\n");
}

const MCP_RUNTIME_ENV_PREFIX = "BYTRO_MCP_SECRET_";
const MCP_RUNTIME_LAUNCHER_FILENAME = "mcp-runtime-launcher.mjs";
export const MCP_RUNTIME_LAUNCHER_SOURCE = [
  'import { spawn } from "node:child_process";',
  'import { existsSync, statSync } from "node:fs";',
  'import { delimiter, resolve } from "node:path";',
  'const prefix = "BYTRO_MCP_SECRET_";',
  "const descriptorKey = process.argv[2];",
  "const serialized = descriptorKey ? process.env[descriptorKey] : undefined;",
  'if (!serialized) throw new Error("Missing Bytro MCP runtime descriptor.");',
  "const descriptor = JSON.parse(serialized);",
  "const unixCore = [",
  '  "HOME", "LOGNAME", "PATH", "SHELL", "USER",',
  '  "__CF_USER_TEXT_ENCODING", "LANG", "LC_ALL", "TERM", "TMPDIR", "TZ",',
  "];",
  "const windowsCore = [",
  '  "HOME", "USERPROFILE", "HOMEDRIVE", "HOMEPATH", "PATH", "PATHEXT",',
  '  "SYSTEMROOT", "SYSTEMDRIVE", "COMSPEC", "TEMP", "TMP", "APPDATA",',
  '  "LOCALAPPDATA", "PROGRAMDATA", "USERNAME", "WINDIR",',
  "];",
  "const childEnv = {};",
  "for (const key of process.platform === \"win32\" ? windowsCore : unixCore) {",
  "  const value = process.env[key];",
  "  if (value !== undefined) childEnv[key] = value;",
  "}",
  "for (const key of descriptor.passthroughEnvVars ?? []) {",
  '  if (typeof key !== "string" || key.startsWith(prefix)) continue;',
  "  const value = process.env[key];",
  "  if (value !== undefined) childEnv[key] = value;",
  "}",
  "for (const [target, source] of Object.entries(descriptor.envSources ?? {})) {",
  "  const value = process.env[source];",
  "  if (value !== undefined) childEnv[target] = value;",
  "}",
  'const meta = /([()\\][%!^"`<>&|;, *?])/g;',
  'const escapeCommand = (value) => value.replace(meta, "^$1");',
  "const escapeArgument = (value) => {",
  '  let escaped = String(value).replace(/(?=(\\\\+?)?)\\1"/g, \'$1$1\\\\"\');',
  '  escaped = escaped.replace(/(?=(\\\\+?)?)\\1$/, "$1$1");',
  '  escaped = `"${escaped}"`.replace(meta, "^$1");',
  '  return escaped.replace(meta, "^$1");',
  "};",
  "const resolveWindowsCommand = (command) => {",
  '  if (process.platform !== "win32") return command;',
  '  const hasSeparator = command.includes("\\\\") || command.includes("/");',
  '  const extension = /\\.[^\\\\/.]+$/.test(command);',
  '  const extensions = extension ? [""] : String(process.env.PATHEXT || ".COM;.EXE;.BAT;.CMD")',
  '    .split(";").filter(Boolean);',
  '  const directories = hasSeparator ? [""] : String(process.env.PATH || "")',
  "    .split(delimiter)",
  '    .map((entry) => entry.replace(/^"(.*)"$/, "$1"))',
  "    .filter(Boolean);",
  "  for (const directory of directories) {",
  "    for (const suffix of extensions) {",
  "      const candidate = directory ? resolve(directory, command + suffix) : command + suffix;",
  "      try {",
  "        if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;",
  "      } catch {}",
  "    }",
  "  }",
  "  return command;",
  "};",
  "let executable = resolveWindowsCommand(String(descriptor.command));",
  "let args = Array.isArray(descriptor.args) ? descriptor.args : [];",
  "let windowsVerbatimArguments = false;",
  'if (process.platform === "win32" && /\\.(?:cmd|bat)$/i.test(executable)) {',
  "  const shellCommand = [escapeCommand(executable), ...args.map(escapeArgument)].join(\" \");",
  '  executable = process.env.ComSpec || process.env.COMSPEC || "cmd.exe";',
  '  args = ["/d", "/s", "/c", `"${shellCommand}"`];',
  "  windowsVerbatimArguments = true;",
  "}",
  "const child = spawn(executable, args, {",
  '  stdio: "inherit",',
  "  env: childEnv,",
  '  detached: process.platform !== "win32",',
  "  windowsHide: true,",
  "  windowsVerbatimArguments,",
  "});",
  "let forceTimer;",
  "let stopping = false;",
  "const signalTree = (signal) => {",
  "  if (!child.pid) return;",
  '  if (process.platform === "win32") {',
  '    const taskkillArgs = ["/PID", String(child.pid), "/T"];',
  '    if (signal === "SIGKILL") taskkillArgs.push("/F");',
  '    try { spawn("taskkill.exe", taskkillArgs, { stdio: "ignore", windowsHide: true }).unref(); }',
  "    catch { try { child.kill(signal); } catch {} }",
  "    return;",
  "  }",
  "  try { process.kill(-child.pid, signal); }",
  "  catch { try { child.kill(signal); } catch {} }",
  "};",
  "const stopTree = () => {",
  "  if (stopping) return;",
  "  stopping = true;",
  '  signalTree("SIGTERM");',
  '  forceTimer = setTimeout(() => signalTree("SIGKILL"), 5000);',
  "  forceTimer.unref();",
  "};",
  'child.on("error", () => { console.error("Failed to start MCP server."); stopTree(); process.exitCode = 1; });',
  'child.on("exit", (code) => {',
  "  if (forceTimer) clearTimeout(forceTimer);",
  '  signalTree("SIGTERM");',
  "  process.exit(code ?? 1);",
  "});",
  'for (const signal of ["SIGTERM", "SIGINT"]) {',
  "  process.on(signal, stopTree);",
  "}",
  'process.on("disconnect", stopTree);',
  'process.on("exit", () => signalTree("SIGKILL"));',
  "",
].join("\n");

function mcpRuntimeEnvKey(
  serverName: string,
  label: string,
): string {
  const suffix = createHash("sha256")
    .update(`${serverName}\u0000${label}`)
    .digest("hex")
    .slice(0, 20)
    .toUpperCase();
  return `${MCP_RUNTIME_ENV_PREFIX}${suffix}`;
}

/**
 * Project persisted user MCP settings into an ephemeral Codex runtime config.
 * The input object remains untouched; credential-bearing values live only in
 * the app-server environment and are referenced by name from TOML.
 */
export function projectMcpServersForRuntime(
  mcpServers: Readonly<Record<string, unknown>>,
  spawnEnv: Record<string, string>,
  launcherPath: string,
): Record<string, unknown> {
  const projected: Record<string, unknown> = {};
  for (const [serverName, rawConfig] of Object.entries(mcpServers)) {
    if (!rawConfig || typeof rawConfig !== "object") continue;
    const config = rawConfig as Record<string, unknown>;
    const timeouts = Object.fromEntries(
      ["startup_timeout_sec", "tool_timeout_sec"]
        .filter((key) => typeof config[key] === "number")
        .map((key) => [key, config[key]]),
    );

    if (typeof config.command === "string" && config.command.length > 0) {
      const descriptorKey = mcpRuntimeEnvKey(serverName, "descriptor");
      const envSources: Record<string, string> = {};
      const forwardedEnvVars = new Set<string>([descriptorKey]);
      if (config.env && typeof config.env === "object") {
        for (const [target, value] of Object.entries(
          config.env as Record<string, unknown>,
        )) {
          const source = mcpRuntimeEnvKey(serverName, `env:${target}`);
          spawnEnv[source] = String(value);
          envSources[target] = source;
          forwardedEnvVars.add(source);
        }
      }
      if (Array.isArray(config.env_vars)) {
        for (const value of config.env_vars) {
          if (typeof value === "string" && value) {
            forwardedEnvVars.add(value);
          }
        }
      }
      spawnEnv[descriptorKey] = JSON.stringify({
        command: config.command,
        args: Array.isArray(config.args)
          ? config.args.map((value) => String(value))
          : [],
        envSources,
        passthroughEnvVars: Array.isArray(config.env_vars)
          ? config.env_vars.filter(
              (value): value is string =>
                typeof value === "string"
                && value.length > 0
                && !value.startsWith(MCP_RUNTIME_ENV_PREFIX),
            )
          : [],
      });
      projected[serverName] = {
        command: process.execPath,
        args: [launcherPath, descriptorKey],
        env_vars: [...forwardedEnvVars],
        ...timeouts,
      };
      continue;
    }

    if (typeof config.url === "string" && config.url.length > 0) {
      const runtimeUrl = normalizeMcpRemoteUrl(config.url);
      const envHttpHeaders: Record<string, string> = {};
      if (config.headers && typeof config.headers === "object") {
        for (const [header, value] of Object.entries(
          config.headers as Record<string, unknown>,
        )) {
          const source = mcpRuntimeEnvKey(serverName, `header:${header}`);
          spawnEnv[source] = String(value);
          envHttpHeaders[header] = source;
        }
      }
      if (
        config.env_http_headers
        && typeof config.env_http_headers === "object"
      ) {
        Object.assign(
          envHttpHeaders,
          config.env_http_headers as Record<string, string>,
        );
      }
      projected[serverName] = {
        url: runtimeUrl,
        ...(Object.keys(envHttpHeaders).length > 0
          ? { env_http_headers: envHttpHeaders }
          : {}),
        ...timeouts,
      };
    }
  }
  return projected;
}

/**
 * Build sidecar-managed (built-in) MCP server configs that should be available
 * to every Codex thread. Currently exposes a single tool `generate_image`
 * backed by the OpenAI Images API with `gpt-image-2` hard-coded.
 *
 */
const VALID_IMAGE_QUALITIES = new Set(["low", "medium", "high", "auto"]);
const VALID_IMAGE_SIZES = new Set([
  "auto",
  "1024x1024", "1536x1024", "1024x1536",
  "2048x2048", "2048x1152",
  "3840x2160", "2160x3840",
]);

function canonicalImageDirectory(path: string): string {
  const metadata = lstatSync(path);
  if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
    throw new Error("Image directory is not a regular directory");
  }
  return realpathSync.native(path);
}

function canonicalUploadsDirectory(): string {
  const uploadsDir = join(tmpdir(), "bytro-community-uploads");
  mkdirSync(uploadsDir, { recursive: true });
  return canonicalImageDirectory(uploadsDir);
}

function canonicalOutputImagesDirectory(outputsDir: string): string {
  if (
    !isAbsolute(outputsDir) ||
    outputsDir.split(/[\\/]+/).includes("..")
  ) {
    throw new Error("Outputs directory is invalid");
  }
  const canonicalOutputs = canonicalImageDirectory(outputsDir);
  const imagesDir = join(canonicalOutputs, "images");
  if (existsSync(imagesDir)) {
    const metadata = lstatSync(imagesDir);
    if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
      throw new Error("Output images directory is not a regular directory");
    }
  } else {
    mkdirSync(imagesDir, { recursive: false });
  }
  const canonicalImages = canonicalImageDirectory(imagesDir);
  const fromOutputs = relative(canonicalOutputs, canonicalImages);
  if (
    fromOutputs === ".." ||
    fromOutputs.startsWith(`..${sep}`) ||
    isAbsolute(fromOutputs)
  ) {
    throw new Error("Output images directory escaped the approved outputs root");
  }
  return canonicalImages;
}

function buildBuiltinMcpServers(opts: {
  apiKey: string;
  baseUrl?: string;
  proxyUrl?: string;
  imageGenQuality?: string;
  imageGenSize?: string;
  /** App-managed directory for AI-generated images. When set, written to
   *  `OPENAI_IMAGES_OUT` so every model-returned PNG lands here regardless of
   *  the agent's cwd. Falls back to the MCP server's own tmpdir default. */
  outputsDir?: string;
}): Record<string, unknown> {
  if (!opts.apiKey) return {};
  if (!opts.outputsDir?.trim()) {
    log("[builtin-mcp] openai_images disabled until Rust supplies an approved outputs directory");
    return {};
  }

  const here = dirname(fileURLToPath(import.meta.url));
  const entryPath = join(here, "openai-images-mcp.mjs");
  if (!existsSync(entryPath)) {
    log(`[builtin-mcp] openai-images-mcp.mjs NOT FOUND at ${entryPath}; image generation tool unavailable. (here=${here}, platform=${process.platform})`);
    return {};
  }

  const env: Record<string, string> = { OPENAI_API_KEY: opts.apiKey };
  if (opts.baseUrl) env.OPENAI_BASE_URL = validateProviderBaseUrl(opts.baseUrl);
  applyProxyEnv(env, opts.proxyUrl);
  if (opts.imageGenQuality && VALID_IMAGE_QUALITIES.has(opts.imageGenQuality)) {
    env.OPENAI_IMAGES_QUALITY = opts.imageGenQuality;
  }
  if (opts.imageGenSize && VALID_IMAGE_SIZES.has(opts.imageGenSize)) {
    env.OPENAI_IMAGES_SIZE = opts.imageGenSize;
  }
  try {
    const uploadsRoot = canonicalUploadsDirectory();
    const outputImagesRoot = canonicalOutputImagesDirectory(
      opts.outputsDir.trim(),
    );
    env.OPENAI_IMAGES_OUT = outputImagesRoot;
    env.OPENAI_IMAGES_INPUT_ROOTS = JSON.stringify([
      uploadsRoot,
      outputImagesRoot,
    ]);
  } catch (error) {
    log(`[builtin-mcp] openai_images directory policy failed: ${String(error)}`);
    return {};
  }

  const rawCommand = process.execPath;
  const argEntry = entryPath;
  const { command, args } = buildBuiltinMcpProcessConfig(
    rawCommand,
    argEntry,
  );

  // Windows-specific: cold spawn of a 1+ MB ESM bundle through node.exe with
  // Defender real-time scan enabled regularly takes 30–90s on the very first
  // run after install. codex's MCP startup timeout is enforced from the
  // moment it spawns the child, so the previous 30s budget consistently
  // tripped a "request timeout" before our MCP server finished `mcp.connect`.
  // 180s gives Windows enough headroom; on warm runs the actual time stays
  // sub-second, so the higher cap is harmless on healthy hosts.
  const startupTimeoutSec = process.platform === "win32" ? 180 : 60;

  return {
    openai_images: {
      command,
      args,
      env,
      // gpt-image-2 high-quality renders can take several minutes; codex's
      // default 60s per-tool timeout is too tight. Allow up to 10 minutes.
      tool_timeout_sec: 600,
      startup_timeout_sec: startupTimeoutSec,
    },
  };
}

// ---------------------------------------------------------------------------
// Config.toml sanitization — clean up entries polluted by external tools
// ---------------------------------------------------------------------------

/**
 * Sanitize a Codex config.toml string to remove entries injected by external
 * tools (e.g. ccswitch) that conflict with the sidecar-managed configuration.
 *
 * Cleaned entries:
 * - `model`, `model_provider`, `review_model` top-level keys (controlled via RPC / -c flags)
 * - `[model_providers]` and `[model_providers.*]` sections (provider set via -c flags)
 * - Plain key=value entries directly under `[mcp_servers]` (must be sub-tables)
 *
 * Uses line-level editing to preserve comments, formatting, and bytro-managed markers.
 */
function sanitizeCodexConfigToml(raw: string): string {
  // Normalize CRLF/CR to LF — bare \r inside commented-out lines would produce
  // invalid TOML ("carriage return must be followed by newline").
  const lines = raw.replace(/\r/g, "").split("\n");
  const result: string[] = [];

  // Track which TOML section we're currently inside
  let currentSection: "root" | "model_providers" | "mcp_servers_root" | "other" = "root";

  for (const line of lines) {
    const trimmed = line.trim();

    // Detect section headers
    if (trimmed.startsWith("[")) {
      if (/^\[model_providers(\..+)?\]/.test(trimmed)) {
        currentSection = "model_providers";
        result.push(`# ${line} # removed by sidecar`);
        continue;
      } else if (/^\[mcp_servers\]\s*$/.test(trimmed)) {
        currentSection = "mcp_servers_root";
        result.push(line);
        continue;
      } else {
        currentSection = "other";
        result.push(line);
        continue;
      }
    }

    // Inside [model_providers] or [model_providers.*] — comment out all content
    if (currentSection === "model_providers") {
      if (trimmed !== "" && !trimmed.startsWith("#")) {
        result.push(`# ${line} # removed by sidecar`);
      } else {
        result.push(line);
      }
      continue;
    }

    // Inside bare [mcp_servers] — comment out plain key=value entries
    // (valid MCP configs live in [mcp_servers.xxx] sub-tables, not here)
    if (currentSection === "mcp_servers_root") {
      if (/^[A-Za-z0-9_-]+\s*=/.test(trimmed)) {
        result.push(`# ${line} # removed by sidecar (not a valid MCP server table)`);
        continue;
      }
    }

    // Top-level keys controlled by sidecar — comment out regardless of section
    if (currentSection === "root" || currentSection === "other") {
      if (/^model\s*=\s*"/.test(trimmed)) {
        result.push(`# ${line} # removed by sidecar (passed via RPC)`);
        continue;
      }
      if (/^model_provider\s*=\s*"/.test(trimmed)) {
        result.push(`# ${line} # removed by sidecar (provider set via -c flags)`);
        continue;
      }
      if (/^review_model\s*=\s*"/.test(trimmed)) {
        result.push(`# ${line} # removed by sidecar (passed via RPC)`);
        continue;
      }
      if (/^openai_base_url\s*=/.test(trimmed)) {
        result.push(`# ${line} # removed by sidecar (injected from settings)`);
        continue;
      }
    }

    result.push(line);
  }

  return commentOutInvalidMcpServerSections(result.join("\n"));
}

/**
 * Comment out any `[mcp_servers.<name>]` table — including its sub-tables
 * (e.g. `[mcp_servers.<name>.env]`) — whose aggregated config has neither
 * `command = ...` (stdio transport) nor `url = ...` (streamable_http transport).
 *
 * Why: codex 0.129+ deserialises every MCP entry up-front and rejects the
 * entire config.toml with `invalid transport` (one error halts loading of ALL
 * MCP servers and forces the app-server thread/start to fail with
 * `-32600 failed to load configuration`). An incomplete entry can appear when
 * an external tool — or a previous bytro/codex version — leaves a half-
 * written sub-table (e.g. only `enabled = true` or timeouts under the header,
 * or only an `[mcp_servers.X.env]` sub-table without a sibling main table).
 *
 * IMPORTANT — server names are aggregated across main + sub-tables:
 *   [mcp_servers.matlab]          ← main: contributes hasCommand/hasUrl
 *   command = "..."
 *   [mcp_servers.matlab.env]      ← sub-table: cannot contribute transport,
 *   WINDIR = "..."                  but counts as part of `matlab`'s config
 *
 * A server is considered valid as long as at least one main table (no
 * additional dot after the name) supplies `command` or `url`. Sub-tables
 * alone cannot make a server valid — codex would still see `matlab` with
 * only `env = { WINDIR = ... }` and reject the whole file.
 *
 * Server names support TOML's quoted-key syntax: `[mcp_servers.foo]`,
 * `[mcp_servers."weird.name"]`, and `[mcp_servers.'with spaces']`.
 */
function commentOutInvalidMcpServerSections(content: string): string {
  const lines = content.split("\n");

  interface McpBlock {
    startIdx: number;
    endIdx: number;
    serverName: string;
    isMain: boolean;
    hasCommand: boolean;
    hasUrl: boolean;
  }
  const blocks: McpBlock[] = [];
  let current: McpBlock | null = null;

  /** Parse `<name>` or `<name>.<sub>...` from the path after `mcp_servers.`. */
  function parseServerSegment(
    rawPath: string,
  ): { name: string; isMain: boolean } | null {
    if (rawPath.length === 0) return null;
    const first = rawPath[0];
    if (first === '"' || first === "'") {
      const end = rawPath.indexOf(first, 1);
      if (end === -1) return null;
      const name = rawPath.slice(1, end);
      const rest = rawPath.slice(end + 1);
      return { name, isMain: rest === "" };
    }
    const dotIdx = rawPath.indexOf(".");
    if (dotIdx === -1) return { name: rawPath, isMain: true };
    return { name: rawPath.slice(0, dotIdx), isMain: false };
  }

  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim();
    if (trimmed.startsWith("[")) {
      // New section header (single `[...]` or array-of-tables `[[...]]`) — close current.
      if (current) {
        current.endIdx = i - 1;
        blocks.push(current);
        current = null;
      }
      // Strict match on `[mcp_servers.<...>]` (single brackets only; skip `[[...]]`).
      const headerMatch = trimmed.match(/^\[mcp_servers\.(.+?)\]\s*(?:#.*)?$/);
      if (headerMatch && !trimmed.startsWith("[[")) {
        const parsed = parseServerSegment(headerMatch[1]);
        if (parsed) {
          current = {
            startIdx: i,
            endIdx: lines.length - 1,
            serverName: parsed.name,
            isMain: parsed.isMain,
            hasCommand: false,
            hasUrl: false,
          };
        }
      }
      continue;
    }
    if (current && current.isMain && !trimmed.startsWith("#")) {
      if (/^command\s*=/.test(trimmed)) current.hasCommand = true;
      else if (/^url\s*=/.test(trimmed)) current.hasUrl = true;
    }
  }
  if (current) blocks.push(current);

  // Aggregate per server: valid iff any main block supplies command or url.
  // Sub-tables alone can't make a server valid (codex still rejects).
  const serverHasTransport = new Map<string, boolean>();
  for (const b of blocks) {
    const prev = serverHasTransport.get(b.serverName) ?? false;
    const contributes = b.isMain && (b.hasCommand || b.hasUrl);
    serverHasTransport.set(b.serverName, prev || contributes);
  }

  const invalidServers = new Set<string>();
  for (const [name, hasTransport] of serverHasTransport) {
    if (!hasTransport) invalidServers.add(name);
  }
  if (invalidServers.size === 0) return content;

  const linesToComment = new Set<number>();
  for (const b of blocks) {
    if (invalidServers.has(b.serverName)) {
      for (let i = b.startIdx; i <= b.endIdx; i++) linesToComment.add(i);
    }
  }

  const out = lines.map((line, idx) => {
    if (!linesToComment.has(idx)) return line;
    const trimmed = line.trim();
    if (trimmed === "" || trimmed.startsWith("#")) return line;
    return `# ${line} # removed by sidecar (mcp_servers entry missing command/url)`;
  });

  log(
    `[config] Disabled ${invalidServers.size} malformed mcp_servers entry/entries missing command/url: ${[...invalidServers].join(", ")}`,
  );

  return out.join("\n");
}

// ---------------------------------------------------------------------------
// Orphaned CODEX_HOME cleanup — remove stale temp dirs from previous sessions
// ---------------------------------------------------------------------------

let _codexHomeCleaned = false;
const CODEX_RUNTIME_PREFIX = "bytro-community-codex-";
const CODEX_RUNTIME_STALE_AGE_MS = 24 * 60 * 60 * 1000;

/** Track active temp home directories so cleanup never removes a live session. */
const _activeCodexHomes = new Set<string>();

function isProcessStillAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

export function shouldRemoveCodexRuntimeDirectory(input: {
  readonly ownerPid: number;
  readonly ownerUid: number;
  readonly currentPid: number;
  readonly currentUid: number | undefined;
  readonly mtimeMs: number;
  readonly now: number;
  readonly ownerProcessAlive: boolean;
  readonly allowMissingUid?: boolean;
}): boolean {
  const ownershipIsSafe = input.currentUid === undefined
    ? input.allowMissingUid === true
    : input.ownerUid === input.currentUid;
  return (
    ownershipIsSafe &&
    input.ownerPid !== input.currentPid &&
    !input.ownerProcessAlive &&
    input.now - input.mtimeMs > CODEX_RUNTIME_STALE_AGE_MS
  );
}

export function cleanupStaleCodexRuntimeDirectories(
  root = tmpdir(),
  now = Date.now(),
  options: {
    readonly platform?: NodeJS.Platform;
    readonly trustedUserTempRoot?: string;
    readonly getCurrentUid?: () => number | undefined;
  } = {},
): number {
  const resolvedRoot = resolve(root);
  const platform = options.platform ?? process.platform;
  const trustedUserTempRoot = resolve(
    options.trustedUserTempRoot ?? tmpdir(),
  );
  const currentUid = options.getCurrentUid
    ? options.getCurrentUid()
    : typeof process.getuid === "function"
      ? process.getuid()
      : undefined;
  const allowMissingUid =
    platform === "win32" && resolvedRoot === trustedUserTempRoot;
  if (currentUid === undefined && !allowMissingUid) return 0;

  const rootPrefix = resolvedRoot.endsWith(sep)
    ? resolvedRoot
    : `${resolvedRoot}${sep}`;
  let removed = 0;
  for (const entry of readdirSync(resolvedRoot, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
    const match = new RegExp(
      `^${CODEX_RUNTIME_PREFIX.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(\\d+)-`,
    ).exec(entry.name);
    if (!match) continue;

    const fullPath = resolve(resolvedRoot, entry.name);
    if (!fullPath.startsWith(rootPrefix) || _activeCodexHomes.has(fullPath)) {
      continue;
    }

    try {
      const metadata = lstatSync(fullPath);
      if (!metadata.isDirectory() || metadata.isSymbolicLink()) continue;
      const ownerPid = Number(match[1]);
      if (
        !shouldRemoveCodexRuntimeDirectory({
          ownerPid,
          ownerUid: metadata.uid,
          currentPid: process.pid,
          currentUid,
          mtimeMs: metadata.mtimeMs,
          now,
          ownerProcessAlive: isProcessStillAlive(ownerPid),
          allowMissingUid,
        })
      ) {
        continue;
      }
      rmSync(fullPath, { recursive: true, force: true });
      removed++;
    } catch {
      // Ownership, process state, and filesystem checks are fail-closed.
    }
  }
  return removed;
}

/**
 * Best-effort cleanup of stale Bytro Community runtime directories left by
 * crashed sessions. Runs once per sidecar process without blocking startup.
 */
function cleanupOrphanedCodexHomes(): void {
  if (_codexHomeCleaned) return;
  _codexHomeCleaned = true;
  setImmediate(() => {
    try {
      const removed = cleanupStaleCodexRuntimeDirectories();
      if (removed > 0) {
        log(`[startup] Cleaned up ${removed} stale Codex runtime dir(s)`);
      }
    } catch { /* best-effort */ }
  });
}

// ---------------------------------------------------------------------------
// Skill compatibility — determine if a skill is compatible with Codex
// ---------------------------------------------------------------------------

/** Tools that only exist in Claude Code and have no Codex equivalent */
const CLAUDE_ONLY_TOOLS = new Set([
  "Skill",              // Claude Code skill invocation tool
  "EnterPlanMode",      // Claude Code plan mode (Codex uses collaborationMode)
  "ExitPlanMode",
  "Agent",              // Claude Code subagent spawning
  "TodoWrite",          // Claude Code task tracking
]);

/** Hard-coded blocklist for skills that cannot be detected by frontmatter alone */
const CODEX_SKILL_BLOCKLIST = new Set([
  "using-superpowers",  // forces skill scan before every response — Claude-specific meta-skill
]);

/**
 * Check if a skill directory is compatible with Codex based on its SKILL.md
 * frontmatter. Returns false if the skill should be excluded.
 *
 * Detection layers (in order):
 * 1. Hard-coded blocklist — for known-problematic skills without proper metadata
 * 2. `compatibility` frontmatter field — explicit platform declaration
 * 3. `allowed-tools` field — if it references Claude-only tools
 */
function isSkillCompatibleWithCodex(
  frontmatter: ReturnType<typeof parseSkillMdContent>["frontmatter"],
  skillName: string,
): boolean {
  // Layer 1: hard-coded blocklist
  if (CODEX_SKILL_BLOCKLIST.has(skillName)) return false;

  // Layer 2: explicit compatibility field
  const compat = (frontmatter.compatibility ?? "").toLowerCase().trim();
  if (compat) {
    // "claude", "claude-only", "claude-code" → not compatible
    if (compat.includes("claude") && !compat.includes("codex")) return false;
    // "codex", "all", "codex,claude" → compatible
  }

  // Layer 3: allowed-tools referencing Claude-only tools
  const tools = frontmatter["allowed-tools"];
  if (tools && Array.isArray(tools)) {
    for (const tool of tools) {
      if (CLAUDE_ONLY_TOOLS.has(tool.trim())) return false;
    }
  } else if (typeof tools === "string") {
    // allowed-tools can also be a comma-separated string
    const toolList = (tools as string).split(",").map(t => t.trim());
    for (const tool of toolList) {
      if (CLAUDE_ONLY_TOOLS.has(tool)) return false;
    }
  }

  return true;
}

// ---------------------------------------------------------------------------
// Skill index — lazy-loading registry (name + description only, no full content)
// ---------------------------------------------------------------------------

/**
 * Build a lightweight skill index for AGENTS.md.  Only includes skill names,
 * one-line descriptions and file paths — full SKILL.md content is NOT loaded
 * into context.  The model reads the full file on-demand via its Read tool.
 *
 * This mirrors Claude's Skill tool lazy-loading approach:  the model sees
 * what skills exist but doesn't pay the context cost until it actually
 * needs one.
 */
function buildSkillIndex(skillsDir: string): string {
  const log = createLogger("codex");
  const providerRoot = dirname(skillsDir);

  try {
    const entries = listProviderDirectory(providerRoot, skillsDir);
    if (!entries) return "";
    const skills: Array<{ name: string; description: string; path: string }> = [];

    for (const entry of entries) {
      if (entry.name.startsWith(".") || entry.isSymbolicLink() || !entry.isDirectory()) continue;
      const skillDir = join(skillsDir, entry.name);

      const skillMdPath = join(skillDir, "SKILL.md");
      try {
        const snapshot = readProviderTextFile(providerRoot, skillMdPath);
        if (!snapshot) continue;
        const { frontmatter } = parseSkillMdContent(snapshot.content, skillMdPath);
        if (!isSkillCompatibleWithCodex(frontmatter, entry.name)) continue;
        const desc = ((frontmatter.description as string) ?? "").replace(/\n/g, " ");
        // Keep only the first sentence to avoid polluting the index
        const shortDesc = desc.length > 120 ? desc.slice(0, 120) + "..." : desc;
        // Normalize path separators for cross-platform readability
        const normalizedPath = skillMdPath.replace(/\\/g, "/");
        skills.push({
          name: frontmatter.name || entry.name,
          description: shortDesc,
          path: normalizedPath,
        });
      } catch {
        // Skip unparseable skills
      }
    }

    if (skills.length === 0) return "";
    log(`Built skill index with ${skills.length} compatible skill(s)`);

    const lines = [
      "# Available Skills (Lazy-loaded)",
      "",
      "The following skills are installed. **DO NOT** read or execute any skill unless the user explicitly asks you to.",
      "When you need to use a skill, read its full SKILL.md file first, then follow the instructions inside.",
      "",
      "| Skill | Description | SKILL.md Path |",
      "|-------|-------------|---------------|",
    ];

    for (const s of skills) {
      lines.push(`| ${s.name} | ${s.description} | \`${s.path}\` |`);
    }

    return lines.join("\n");
  } catch (err) {
    log(`[warn] Failed to build skill index: ${err}`);
    return "";
  }
}

// ---------------------------------------------------------------------------
// Plan approval — synthetic ExitPlanMode gate for Codex plan mode
// ---------------------------------------------------------------------------

const PLAN_APPROVAL_TIMEOUT_MS = 300_000; // 5 minutes

async function requestCodexPlanApproval(
  state: TurnState,
  emit: EmitFn,
): Promise<boolean> {
  logTurnStateSnapshot("plan_approval_begin", state, {
    planContentLen: state.planContent.length,
  });

  // ── ExitPlanMode approval gate ──
  const confirmId = `cfm-${randomUUID()}`;
  const toolCallId = makeToolCallIdShared("oai");

  emit({
    evt: "tool_start",
    id: state.activeRequestId,
    toolCallId,
    toolName: "ExitPlanMode",
    toolInput: JSON.stringify({ plan: "Codex plan completed" }),
  });

  emit({
    evt: "permission_request",
    id: state.activeRequestId,
    confirmId,
    toolCallId,
    toolName: "ExitPlanMode",
    toolInput: JSON.stringify({ plan: "Codex plan completed" }),
  });

  const approved = await new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => {
      logTurnStateSnapshot("plan_approval_timeout", state, {
        confirmId,
        timeoutMs: PLAN_APPROVAL_TIMEOUT_MS,
      });
      pendingConfirmations.delete(confirmId);
      resolve(false);
    }, PLAN_APPROVAL_TIMEOUT_MS);

    pendingConfirmations.set(confirmId, {
      resolve: (value: boolean) => {
        clearTimeout(timer);
        logTurnStateSnapshot("plan_approval_resolved", state, {
          confirmId,
          approved: value,
        });
        resolve(value);
      },
    });
  });

  emit({
    evt: "tool_result",
    id: state.activeRequestId,
    toolCallId,
    toolName: "ExitPlanMode",
    toolInput: JSON.stringify({ plan: "Codex plan completed" }),
    success: approved,
    result: approved ? "Plan approved — switching to execution mode" : "Plan rejected — staying in plan mode",
    display: defaultToolDisplay(approved),
  });

  logTurnStateSnapshot("plan_approval_done", state, {
    confirmId,
    approved,
  });

  return approved;
}

async function switchCodexThreadToApprovedExecution(
  rpc: CodexRpcChannel,
  threadId: string,
  model: string,
  cwd: string,
): Promise<void> {
  await rpc.request("thread/resume", {
    threadId,
    model,
    cwd,
    approvalPolicy: mapApprovalPolicy("default"),
    sandbox: "workspace-write",
  }, 30_000);
}

// ---------------------------------------------------------------------------
// Utility helpers
// ---------------------------------------------------------------------------

function makeToolCallId(): string {
  return makeToolCallIdShared("oai");
}

/**
 * Map reasoningLevel (or legacy thinkingEnabled) to Codex App Server reasoning effort.
 *
 * OpenAI SDK ReasoningEffort: "none" | "minimal" | "low" | "medium" | "high" | "xhigh"
 *   - "none": disable reasoning entirely
 *   - "xhigh": supported by codex-max and eligible GPT-5.x models
 *
 * Our app ReasoningLevel → Codex mapping:
 *   "off"    → "none"    (explicit disable, not undefined)
 *   "low"    → "low"
 *   "medium" → "medium"
 *   "high"   → "high"
 *   "max"    → native "max" for GPT-5.6, "xhigh" for older capable models,
 *              "high" otherwise
 */
function mapReasoningEffort(
  reasoningLevel: string | undefined,
  thinkingEnabled: boolean | undefined,
  model: string,
): string | undefined {
  if (reasoningLevel != null) {
    if (reasoningLevel === "off") return "none";
    if (reasoningLevel === "max") {
      if (isNativeMaxCapable(model)) return "max";
      return isXhighCapable(model) ? "xhigh" : "high";
    }
    return reasoningLevel; // "low" | "medium" | "high"
  }
  // Legacy fallback
  if (thinkingEnabled) return "high";
  return undefined;
}

/** Models that support a distinct native `max` reasoning effort. */
function isNativeMaxCapable(model: string): boolean {
  const normalized = model.includes("/") ? model.slice(model.lastIndexOf("/") + 1) : model;
  return /^gpt-5\.6(?:[-.].*)?$/.test(normalized);
}

/** Models that support the "xhigh" reasoning effort level. */
function isXhighCapable(model: string): boolean {
  if (model.includes("codex-max")) return true;

  const normalized = model.includes("/") ? model.slice(model.lastIndexOf("/") + 1) : model;
  const match = normalized.match(/^gpt-5(?:\.(\d+))?(?:[-.].*)?$/);
  if (!match) return false;

  const minor = match[1] ? Number(match[1]) : 0;
  return Number.isFinite(minor) && minor >= 2;
}

function getCodexToolResultDisplay(toolName: string, success: boolean, result: string): ToolDisplayMeta {
  if (!success && toolName === "Bash" && result.trim().length > 0) {
    return makeToolDisplay("warning", "non_zero_exit_with_output");
  }
  return defaultToolDisplay(success);
}

/** Check if an error is transient and worth retrying. */
function isTransientError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  const code = (err as NodeJS.ErrnoException)?.code;
  const networkCodes = [
    "ECONNRESET", "ETIMEDOUT", "EPIPE", "ECONNREFUSED",
    "EHOSTUNREACH", "ENOTFOUND", "ENETUNREACH", "EAI_AGAIN",
    "ECONNABORTED",
  ];
  if (code && networkCodes.includes(code)) return true;
  return /socket hang up|broken pipe|network|fetch failed|premature close|stream disconnected|stream closed|reconnecting|server error|502|503|504|overloaded|rate limit|too many requests/i.test(msg);
}

type CodexFileChangeKind = "add" | "delete" | "update";

/**
 * Codex App Server may return `kind` as either a bare string (older schema)
 * or a `{type: "add"|"delete"|"update"}` discriminated object (newer schema).
 * Without this normalisation the strict-equality checks below silently fall
 * through to the `update` branch AND propagate the raw object into emitted
 * events, breaking Rust deserialisation of `file_changed.action` (must be a
 * plain string).  This in turn silently disables the live reviewer because
 * the bridge drops every malformed file_changed event before it reaches the
 * frontend's per-conversation buffer.
 */
function normaliseFileChangeKind(kind: unknown): CodexFileChangeKind {
  if (kind === "add" || kind === "delete" || kind === "update") return kind;
  if (kind && typeof kind === "object" && "type" in kind) {
    const t = (kind as { type: unknown }).type;
    if (t === "add" || t === "delete" || t === "update") return t;
  }
  return "update";
}

interface CodexFileToolEntry {
  readonly toolCallId: string;
  readonly toolName: "Write" | "Edit" | "Delete" | "Bash";
  readonly toolInput: string;
  readonly filePath: string;
  readonly action: CodexFileChangeKind;
  readonly result: string;
  readonly additions: number;
  readonly deletions: number;
}

interface CodexCommandToolEntry {
  readonly toolCallId: string;
  readonly toolName: string;
  readonly toolInput: string;
  readonly result?: string;
}

function makeCommandToolEntry(toolName: string, toolInput: string, result?: string): CodexCommandToolEntry {
  return {
    toolCallId: makeToolCallId(),
    toolName,
    toolInput,
    ...(result ? { result } : {}),
  };
}


function stripMatchingQuotes(value: string): string {
  const trimmed = value.trim();
  if ((trimmed.startsWith("\"") && trimmed.endsWith("\"")) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function parseCommandPathToken(token: string | undefined): string | null {
  if (!token) return null;
  const cleaned = stripMatchingQuotes(token.replace(/\s+$/g, ""));
  return cleaned.length > 0 ? cleaned : null;
}

function unwrapShellCommand(command: string): string {
  let current = command.trim();
  const patterns = [
    /^(?:"[^"]*powershell(?:\.exe)?"|(?:\S*\/)?powershell(?:\.exe)?|pwsh(?:\.exe)?)\s+(?:-[A-Za-z]+(?:\s+[^\s].*?)?\s+)*-Command\s+(.+)$/i,
    /^(?:"[^"]*cmd(?:\.exe)?"|(?:\S*\/)?cmd(?:\.exe)?)\s+\/c\s+(.+)$/i,
    /^(?:"[^"]*(?:ba|z)?sh(?:\.exe)?"|(?:\S*\/)?(?:ba|z)?sh(?:\.exe)?)\s+-l?c\s+(.+)$/i,
  ];

  for (let depth = 0; depth < 3; depth++) {
    let unwrapped = current;
    for (const pattern of patterns) {
      const match = unwrapped.match(pattern);
      if (match) {
        unwrapped = stripMatchingQuotes(match[1])
          .replace(/"/g, '"')
          .replace(/'/g, "'");
        break;
      }
    }
    if (unwrapped === current) break;
    current = unwrapped.trim();
  }

  return current;
}

/** Extract the first command segment before any unquoted pipe, semicolon, or && / ||. */
function extractFirstCommand(command: string): string {
  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < command.length; i++) {
    const ch = command[i];
    if (ch === "'" && !inDouble) { inSingle = !inSingle; continue; }
    if (ch === '"' && !inSingle) { inDouble = !inDouble; continue; }
    if (!inSingle && !inDouble) {
      if (ch === "|" || ch === ";") return command.slice(0, i).trim();
      if (ch === "&" && command[i + 1] === "&") return command.slice(0, i).trim();
    }
  }
  return command;
}

function parseReadCommandDescriptor(command: string): { toolName: "Read"; toolInput: string } | null {
  const trimmed = unwrapShellCommand(command).trim();

  let match = trimmed.match(/^(?:cat|type)\s+("[^"]+"|'[^']+'|\S+)$/i);
  if (match) {
    const filePath = parseCommandPathToken(match[1]);
    if (filePath) {
      return { toolName: "Read", toolInput: JSON.stringify({ file_path: filePath }) };
    }
  }

  match = trimmed.match(/^head\s+-n\s+(\d+)\s+("[^"]+"|'[^']+'|\S+)$/i);
  if (match) {
    const filePath = parseCommandPathToken(match[2]);
    const limit = Number(match[1]);
    if (filePath && Number.isFinite(limit)) {
      return { toolName: "Read", toolInput: JSON.stringify({ file_path: filePath, limit }) };
    }
  }

  match = trimmed.match(/^tail\s+-n\s+(\d+)\s+("[^"]+"|'[^']+'|\S+)$/i);
  if (match) {
    const filePath = parseCommandPathToken(match[2]);
    const limit = Number(match[1]);
    if (filePath && Number.isFinite(limit)) {
      return { toolName: "Read", toolInput: JSON.stringify({ file_path: filePath, limit }) };
    }
  }

  match = trimmed.match(/^sed\s+-n\s+["']?(\d+),(\d+)p["']?\s+("[^"]+"|'[^']+'|\S+)$/i);
  if (match) {
    const start = Number(match[1]);
    const end = Number(match[2]);
    const filePath = parseCommandPathToken(match[3]);
    if (filePath && Number.isFinite(start) && Number.isFinite(end)) {
      return {
        toolName: "Read",
        toolInput: JSON.stringify({
          file_path: filePath,
          offset: start,
          limit: Math.max(0, end - start + 1),
        }),
      };
    }
  }

  match = trimmed.match(/^nl\s+-ba\s+("[^"]+"|'[^']+'|\S+)\s*\|\s*sed\s+-n\s+["']?(\d+),(\d+)p["']?$/i);
  if (match) {
    const filePath = parseCommandPathToken(match[1]);
    const start = Number(match[2]);
    const end = Number(match[3]);
    if (filePath && Number.isFinite(start) && Number.isFinite(end)) {
      return {
        toolName: "Read",
        toolInput: JSON.stringify({
          file_path: filePath,
          offset: start,
          limit: Math.max(0, end - start + 1),
        }),
      };
    }
  }

  match = trimmed.match(/^Get-Content(?:\s+-Path)?\s+("[^"]+"|'[^']+'|\S+)(?:\s+-TotalCount\s+(\d+))?$/i);
  if (match) {
    const filePath = parseCommandPathToken(match[1]);
    const limit = match[2] ? Number(match[2]) : undefined;
    if (filePath) {
      return {
        toolName: "Read",
        toolInput: JSON.stringify({
          file_path: filePath,
          ...(Number.isFinite(limit) ? { limit } : {}),
        }),
      };
    }
  }

  match = trimmed.match(/(?:^|[;&|])\s*Get-Content(?:\s+-Path)?\s+("[^"]+"|'[^']+'|\S+)(?:\s+-TotalCount\s+(\d+))?/i);
  if (match) {
    const filePath = parseCommandPathToken(match[1]);
    const limit = match[2] ? Number(match[2]) : undefined;
    if (filePath) {
      return {
        toolName: "Read",
        toolInput: JSON.stringify({
          file_path: filePath,
          ...(Number.isFinite(limit) ? { limit } : {}),
        }),
      };
    }
  }

  match = trimmed.match(/(?:^|[;&|])\s*(?:cat|type)\s+("[^"]+"|'[^']+'|\S+)/i);
  if (match) {
    const filePath = parseCommandPathToken(match[1]);
    if (filePath) {
      return { toolName: "Read", toolInput: JSON.stringify({ file_path: filePath }) };
    }
  }

  return null;
}

function parseListCommandDescriptor(command: string): { toolName: "list_directory"; toolInput: string } | null {
  const trimmed = unwrapShellCommand(command).trim();
  const firstCmd = extractFirstCommand(trimmed);

  // ls/dir with optional flags: ls, ls -la, ls -la src/, dir /b src\
  if (/^(?:ls|dir)\b/i.test(firstCmd)) {
    const tokens = firstCmd.split(/\s+/).slice(1); // skip command name
    const nonFlags = tokens.filter(t => !t.startsWith("-") && !t.startsWith("/"));
    const pathToken = parseCommandPathToken(nonFlags[nonFlags.length - 1]);
    return { toolName: "list_directory", toolInput: JSON.stringify({ path: pathToken ?? "." }) };
  }

  // tree with optional flags: tree, tree -L 2 src/, tree src/
  if (/^tree\b/i.test(firstCmd)) {
    const tokens = firstCmd.split(/\s+/).filter(t => t && !t.startsWith("-"));
    const pathToken = parseCommandPathToken(tokens[1]); // skip "tree" itself
    return { toolName: "list_directory", toolInput: JSON.stringify({ path: pathToken ?? "." }) };
  }

  // Get-ChildItem [-Path] [path]
  if (/Get-ChildItem/i.test(firstCmd)) {
    const pathMatch = firstCmd.match(/-Path\s+("[^"]+"|'[^']+'|\S+)/i);
    if (pathMatch) {
      const pathToken = parseCommandPathToken(pathMatch[1]);
      return { toolName: "list_directory", toolInput: JSON.stringify({ path: pathToken ?? "." }) };
    }
    const match = firstCmd.match(/^Get-ChildItem(?:\s+-Path)?(?:\s+("[^"]+"|'[^']+'|\S+))?$/i);
    if (match) {
      const pathToken = parseCommandPathToken(match[1]);
      return { toolName: "list_directory", toolInput: JSON.stringify({ path: pathToken ?? "." }) };
    }
    return { toolName: "list_directory", toolInput: JSON.stringify({ path: "." }) };
  }

  return null;
}

function parseSearchCommandDescriptor(command: string): { toolName: "Grep"; toolInput: string } | null {
  const trimmed = unwrapShellCommand(command).trim();
  const firstCmd = extractFirstCommand(trimmed);

  // Strict match: grep/rg pattern [path] (no flags)
  let match = firstCmd.match(/^(?:rg|grep)\s+("[^"]+"|'[^']+'|\S+)(?:\s+("[^"]+"|'[^']+'|\S+))?$/i);
  if (match) {
    const pattern = stripMatchingQuotes(match[1]);
    const pathToken = parseCommandPathToken(match[2]);
    if (pattern) {
      return { toolName: "Grep", toolInput: JSON.stringify({ pattern, ...(pathToken ? { path: pathToken } : {}) }) };
    }
  }

  match = firstCmd.match(/^findstr\s+("[^"]+"|'[^']+'|\S+)(?:\s+("[^"]+"|'[^']+'|\S+))?$/i);
  if (match) {
    const pattern = stripMatchingQuotes(match[1]);
    const pathToken = parseCommandPathToken(match[2]);
    if (pattern) {
      return { toolName: "Grep", toolInput: JSON.stringify({ pattern, ...(pathToken ? { path: pathToken } : {}) }) };
    }
  }

  match = firstCmd.match(/Select-String(?:\s+-Path\s+("[^"]+"|'[^']+'|\S+))?(?:\s+-Pattern\s+("[^"]+"|'[^']+'|\S+))?/i);
  if (match) {
    const pathToken = parseCommandPathToken(match[1]);
    const pattern = match[2] ? stripMatchingQuotes(match[2]) : "";
    if (pattern) {
      return { toolName: "Grep", toolInput: JSON.stringify({ pattern, ...(pathToken ? { path: pathToken } : {}) }) };
    }
  }

  // Loose match: grep/rg/findstr with arbitrary flags (e.g. grep -rn "pattern" src/)
  if (/^(?:rg|grep|findstr)\b/i.test(firstCmd)) {
    // Strategy 1: first quoted string is the pattern
    const quotedMatch = firstCmd.match(/["']([^"']+)["']/);
    if (quotedMatch) {
      const pattern = quotedMatch[1];
      if (pattern) {
        // Find path: remove all quoted strings and command name, pick first non-flag token
        const stripped = firstCmd
          .replace(/["'][^"']*["']/g, " ")
          .replace(/^(?:rg|grep|findstr)\s*/i, "")
          .trim();
        const candidates = stripped.split(/\s+/).filter(t => t && !t.startsWith("-"));
        const pathToken = parseCommandPathToken(candidates[0]);
        return {
          toolName: "Grep",
          toolInput: JSON.stringify({ pattern, ...(pathToken ? { path: pathToken } : {}) }),
        };
      }
    }

    // Strategy 2: no quoted string — skip flags, first non-flag arg is pattern
    const looseMatch = firstCmd.match(
      /^(?:rg|grep|findstr)\s+(?:(?:-\w+|--[\w-]+(?:=\S+)?)\s+)*(\S+)(?:\s+(\S+))?/i,
    );
    if (looseMatch) {
      const pattern = looseMatch[1];
      const pathToken = parseCommandPathToken(looseMatch[2]);
      if (pattern && !pattern.startsWith("-")) {
        return {
          toolName: "Grep",
          toolInput: JSON.stringify({ pattern, ...(pathToken ? { path: pathToken } : {}) }),
        };
      }
    }
  }

  return null;
}

interface PatchFileDiff {
  readonly filePath: string;
  readonly action: "edit" | "add" | "delete";
  readonly oldStr: string;
  readonly newStr: string;
  readonly additions: number;
  readonly deletions: number;
}

/**
 * Parse an apply_patch command and extract per-file diff content.
 * Patch format:
 *   *** Begin Patch
 *   *** Update File: path  (or Add File / Delete File)
 *   @@ context @@          (hunk headers — skipped)
 *    context line           (space-prefixed — skipped)
 *   -removed line
 *   +added line
 *   *** End Patch
 */
function parseApplyPatchPerFileDiffs(command: string): ReadonlyArray<PatchFileDiff> {
  const beginIdx = command.indexOf("*** Begin Patch");
  const endIdx = command.indexOf("*** End Patch");
  if (beginIdx < 0 || endIdx < 0) return [];

  const patchBody = command.slice(beginIdx + "*** Begin Patch".length, endIdx);
  const lines = patchBody.split(/\r?\n/);

  const results: PatchFileDiff[] = [];
  let current: { filePath: string; action: "edit" | "add" | "delete"; removedLines: string[]; addedLines: string[] } | null = null;

  const flushCurrent = () => {
    if (!current) return;
    results.push({
      filePath: current.filePath,
      action: current.action,
      oldStr: current.removedLines.join("\n"),
      newStr: current.addedLines.join("\n"),
      additions: current.addedLines.length,
      deletions: current.removedLines.length,
    });
    current = null;
  };

  for (const line of lines) {
    const updateMatch = line.match(/^\*\*\* Update File:\s+(.+)/);
    const addMatch = !updateMatch ? line.match(/^\*\*\* Add File:\s+(.+)/) : null;
    const deleteMatch = !updateMatch && !addMatch ? line.match(/^\*\*\* Delete File:\s+(.+)/) : null;

    if (updateMatch || addMatch || deleteMatch) {
      flushCurrent();
      const rawPath = (updateMatch?.[1] ?? addMatch?.[1] ?? deleteMatch?.[1] ?? "").trim();
      const filePath = stripMatchingQuotes(rawPath);
      const action: "edit" | "add" | "delete" = updateMatch ? "edit" : addMatch ? "add" : "delete";
      current = { filePath, action, removedLines: [], addedLines: [] };
      continue;
    }

    if (!current) continue;

    // Skip hunk headers (@@)
    if (line.startsWith("@@")) continue;

    if (line.startsWith("-")) {
      current.removedLines.push(line.slice(1));
    } else if (line.startsWith("+")) {
      current.addedLines.push(line.slice(1));
    }
    // Context lines (space-prefixed) are skipped for diff content
  }
  flushCurrent();

  return results;
}

/**
 * Parse a unified diff string into old/new content and line counts.
 * Handles standard unified diff format (--- a/file, +++ b/file, @@ hunks, +/- lines).
 */
function parseUnifiedDiffContent(diff: string): {
  readonly oldStr: string;
  readonly newStr: string;
  readonly additions: number;
  readonly deletions: number;
} {
  const lines = diff.split("\n");
  const removedLines: string[] = [];
  const addedLines: string[] = [];

  for (const line of lines) {
    if (line.startsWith("---") || line.startsWith("+++") || line.startsWith("@@") || line.startsWith("diff ")) continue;
    if (line.startsWith("-")) {
      removedLines.push(line.slice(1));
    } else if (line.startsWith("+")) {
      addedLines.push(line.slice(1));
    }
  }

  return {
    oldStr: removedLines.join("\n"),
    newStr: addedLines.join("\n"),
    additions: addedLines.length,
    deletions: removedLines.length,
  };
}

function parseApplyPatchToolEntries(command: string): ReadonlyArray<CodexCommandToolEntry> {
  const trimmed = unwrapShellCommand(command);
  if (!/apply_patch/i.test(trimmed) || !/\*\*\* Begin Patch/i.test(trimmed)) return [];

  const diffs = parseApplyPatchPerFileDiffs(trimmed);
  if (diffs.length === 0) return [];

  return diffs.map((diff) => {
    const { toolName, toolInput } = diff.action === "edit"
      ? { toolName: "Edit", toolInput: JSON.stringify({ file_path: diff.filePath, old_string: diff.oldStr, new_string: diff.newStr }) }
      : diff.action === "add"
        ? { toolName: "Write", toolInput: JSON.stringify({ file_path: diff.filePath, content: diff.newStr }) }
        : { toolName: "Delete", toolInput: JSON.stringify({ file_path: diff.filePath }) };

    const stats = diff.additions > 0 || diff.deletions > 0
      ? ` (+${diff.additions} -${diff.deletions})`
      : "";

    return makeCommandToolEntry(
      toolName,
      toolInput,
      `${diff.action}: ${diff.filePath}${stats}`,
    );
  });
}

function parseReadCommandToolEntries(command: string): ReadonlyArray<CodexCommandToolEntry> {
  const trimmed = unwrapShellCommand(command).trim();
  const entries: CodexCommandToolEntry[] = [];
  const seen = new Set<string>();

  const pushRead = (filePath: string, offset?: number, limit?: number) => {
    if (!filePath) return;
    const key = `${filePath}:${offset ?? ""}:${limit ?? ""}`;
    if (seen.has(key)) return;
    seen.add(key);
    entries.push(
      makeCommandToolEntry(
        "Read",
        JSON.stringify({
          file_path: filePath,
          ...(offset !== undefined ? { offset } : {}),
          ...(limit !== undefined ? { limit } : {}),
        }),
      ),
    );
  };

  const direct = parseReadCommandDescriptor(trimmed);
  if (direct) {
    const parsed = JSON.parse(direct.toolInput) as Record<string, unknown>;
    pushRead(
      (parsed.file_path as string) ?? "",
      typeof parsed.offset === "number" ? parsed.offset : undefined,
      typeof parsed.limit === "number" ? parsed.limit : undefined,
    );
  }

  for (const match of trimmed.matchAll(/(?:^|[;&|])\s*sed\s+-n\s+["']?(\d+),(\d+)p["']?\s+("[^"]+"|'[^']+'|\S+)/gi)) {
    const start = Number(match[1]);
    const end = Number(match[2]);
    const filePath = parseCommandPathToken(match[3]);
    if (filePath && Number.isFinite(start) && Number.isFinite(end)) {
      pushRead(filePath, start, Math.max(0, end - start + 1));
    }
  }

  for (const match of trimmed.matchAll(/(?:^|[;&|])\s*nl\s+-ba\s+("[^"]+"|'[^']+'|\S+)\s*\|\s*sed\s+-n\s+["']?(\d+),(\d+)p["']?/gi)) {
    const filePath = parseCommandPathToken(match[1]);
    const start = Number(match[2]);
    const end = Number(match[3]);
    if (filePath && Number.isFinite(start) && Number.isFinite(end)) {
      pushRead(filePath, start, Math.max(0, end - start + 1));
    }
  }

  for (const match of trimmed.matchAll(/(?:^|[;&|])\s*(?:cat|type)\s+("[^"]+"|'[^']+'|\S+)/gi)) {
    const filePath = parseCommandPathToken(match[1]);
    if (filePath) pushRead(filePath);
  }

  for (const match of trimmed.matchAll(/(?:^|[;&|])\s*Get-Content(?:\s+-Path)?\s+("[^"]+"|'[^']+'|\S+)(?:\s+-TotalCount\s+(\d+))?/gi)) {
    const filePath = parseCommandPathToken(match[1]);
    const limit = match[2] ? Number(match[2]) : undefined;
    if (filePath) pushRead(filePath, undefined, Number.isFinite(limit) ? limit : undefined);
  }

  return entries;
}

function parseFindCommandDescriptor(command: string): { toolName: "Glob"; toolInput: string } | { toolName: "list_directory"; toolInput: string } | null {
  const trimmed = unwrapShellCommand(command).trim();
  const firstCmd = extractFirstCommand(trimmed);
  if (!/^find\b/i.test(firstCmd)) return null;

  // Extract the search path (first non-flag argument after "find")
  const tokens = firstCmd.split(/\s+/).slice(1);
  const searchPath = tokens[0] && !tokens[0].startsWith("-") && !tokens[0].startsWith("\\(")
    ? parseCommandPathToken(tokens[0]) : null;

  // Case 1: find with -name/-iname → Glob (file pattern search)
  const nameMatch = firstCmd.match(/-(?:i)?name\s+("[^"]+"|'[^']+'|\S+)/i);
  if (nameMatch) {
    const pattern = stripMatchingQuotes(nameMatch[1]);
    if (pattern) {
      return { toolName: "Glob", toolInput: JSON.stringify({ pattern, ...(searchPath ? { path: searchPath } : {}) }) };
    }
  }

  // Case 2: find without -name → list_directory (directory/file listing)
  return { toolName: "list_directory", toolInput: JSON.stringify({ path: searchPath ?? "." }) };
}

function parseCreateCommandDescriptor(command: string): { toolName: "Write"; toolInput: string } | null {
  const trimmed = unwrapShellCommand(command).trim();
  // Match: mkdir [-p] path  or  touch path
  const match = trimmed.match(/^(?:mkdir(?:\s+-p)?|touch)\s+("[^"]+"|'[^']+'|\S+)$/i);
  if (match) {
    const filePath = parseCommandPathToken(match[1]);
    if (filePath) {
      return { toolName: "Write", toolInput: JSON.stringify({ file_path: filePath }) };
    }
  }
  return null;
}

function getCommandToolEntries(command: string): ReadonlyArray<CodexCommandToolEntry> {
  const patchEntries = parseApplyPatchToolEntries(command);
  if (patchEntries.length > 0) return patchEntries;

  const readEntries = parseReadCommandToolEntries(command);
  if (readEntries.length > 0) return readEntries;

  const single = parseSearchCommandDescriptor(command)
    ?? parseFindCommandDescriptor(command)
    ?? parseListCommandDescriptor(command)
    ?? parseCreateCommandDescriptor(command);
  if (single) {
    return [makeCommandToolEntry(single.toolName, single.toolInput)];
  }

  return [makeCommandToolEntry("Bash", JSON.stringify({ command }))];
}

function normalizeMcpToolName(server: string, tool: string): string {
  const normalizedServer = server.trim().replace(/__/g, "_") || "mcp";
  const normalizedTool = tool.trim().replace(/__/g, "_") || "tool";
  return `mcp__${normalizedServer}__${normalizedTool}`;
}

export const __testing__ = {
  parseReadCommandDescriptor,
  parseReadCommandToolEntries,
  getCommandToolEntries,
  getCodexToolResultDisplay,
  normalizeMcpToolName,
  mapReasoningEffort,
  CodexSessionChannel,
  statusRpcError,
  buildSkillIndex,
  getCachedSanitizedConfig,
  getCachedAgentsMd,
  resetContentCache: resetContentCacheForTesting,
};

function getCommandToolDescriptor(command: string): { toolName: string; toolInput: string } {
  const [entry] = getCommandToolEntries(command);
  return { toolName: entry.toolName, toolInput: entry.toolInput };
}

type GoalUpdateSource = "thread/goal/set" | "thread/goal/get" | "notification" | "fallback";

function asRecord(value: unknown): Record<string, unknown> | null {
  return value != null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function readNumber(obj: Record<string, unknown>, keys: ReadonlyArray<string>): number | null {
  for (const key of keys) {
    const value = obj[key];
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (typeof value === "string" && value.trim()) {
      const parsed = Number(value);
      if (Number.isFinite(parsed)) return parsed;
    }
  }
  return null;
}

function readString(obj: Record<string, unknown>, keys: ReadonlyArray<string>): string | undefined {
  for (const key of keys) {
    const value = obj[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return undefined;
}

function normalizeGoalPayload(raw: unknown): GoalSnapshotPayload {
  const root = asRecord(raw) ?? {};
  const goal = asRecord(root.goal) ?? root;
  return {
    objective: readString(goal, ["objective", "goal", "title", "description"]),
    status: readString(goal, ["status", "state"]),
    tokenBudget: readNumber(goal, ["tokenBudget", "token_budget", "budgetTokens", "budget_tokens"]),
    tokensUsed: readNumber(goal, ["tokensUsed", "tokens_used", "usedTokens", "used_tokens"]),
    timeUsedSeconds: readNumber(goal, ["timeUsedSeconds", "time_used_seconds", "elapsedSeconds", "elapsed_seconds"]),
  };
}

function hasGoalPayloadValue(goal: GoalSnapshotPayload): boolean {
  return Object.values(goal).some((value) => value !== undefined && value !== null && value !== "");
}

function stringifyGoalLogValue(value: unknown): string {
  if (value == null) return "null";
  const rendered = typeof value === "string"
    ? value
    : (() => {
        try {
          return JSON.stringify(value);
        } catch {
          return String(value);
        }
      })();
  return rendered.replace(/\s+/g, " ").trim();
}

function emitGoalUpdated(
  emit: EmitFn,
  state: TurnState,
  threadId: string,
  raw: unknown,
  source: GoalUpdateSource,
): void {
  const goal = normalizeGoalPayload(raw);
  const rawLog = stringifyGoalLogValue(raw);
  log(`[goal-mode] emit goal_updated source=${source} requestId=${state.activeRequestId} conversationId=${state.conversationId ?? "none"} threadId=${threadId} goal=${JSON.stringify(goal)} raw=${rawLog}`);
  if (!hasGoalPayloadValue(goal)) return;
  emit({
    evt: "goal_updated",
    id: state.activeRequestId,
    ...(state.conversationId ? { conversationId: state.conversationId } : {}),
    threadId,
    goal,
    source,
  });
}

async function refreshGoalSnapshotIfSupported(
  rpc: CodexRpcChannel,
  threadId: string,
  state: TurnState,
  emit: EmitFn,
  reason: string,
): Promise<void> {
  if (goalGetUnsupported) return;
  try {
    log(`[goal-mode] refreshing goal snapshot via thread/goal/get reason=${reason} threadId=${threadId}`);
    const result = await rpc.request("thread/goal/get", { threadId }, 5_000);
    emitGoalUpdated(emit, state, threadId, result, "thread/goal/get");
  } catch (err) {
    goalGetUnsupported = true;
    log(`[goal-mode] thread/goal/get unavailable; falling back to set responses. reason=${reason} ${summarizeDiagnosticText(String(err), "codex.goal_get.error")}`);
  }
}

function buildFileToolEntries(
  changes: ReadonlyArray<{ path: string; kind: CodexFileChangeKind; diff?: string }>,
): ReadonlyArray<CodexFileToolEntry> {
  return changes.map((change) => {
    const parsed = change.diff ? parseUnifiedDiffContent(change.diff) : null;
    const kind = normaliseFileChangeKind(change.kind);

    if (kind === "add") {
      return {
        toolCallId: makeToolCallId(),
        toolName: "Write",
        toolInput: parsed
          ? JSON.stringify({ file_path: change.path, content: parsed.newStr })
          : JSON.stringify({ file_path: change.path }),
        filePath: change.path,
        action: kind,
        result: parsed ? `add: ${change.path} (+${parsed.additions})` : `add: ${change.path}`,
        additions: parsed?.additions ?? 1,
        deletions: 0,
      } satisfies CodexFileToolEntry;
    }

    if (kind === "delete") {
      return {
        toolCallId: makeToolCallId(),
        toolName: "Delete",
        toolInput: JSON.stringify({ file_path: change.path }),
        filePath: change.path,
        action: kind,
        result: parsed ? `delete: ${change.path} (-${parsed.deletions})` : `delete: ${change.path}`,
        additions: 0,
        deletions: parsed?.deletions ?? 1,
      } satisfies CodexFileToolEntry;
    }

    // update
    return {
      toolCallId: makeToolCallId(),
      toolName: "Edit",
      toolInput: parsed
        ? JSON.stringify({ file_path: change.path, old_string: parsed.oldStr, new_string: parsed.newStr })
        : JSON.stringify({ file_path: change.path }),
      filePath: change.path,
      action: kind,
      result: parsed
        ? `update: ${change.path} (+${parsed.additions} -${parsed.deletions})`
        : `update: ${change.path}`,
      additions: parsed?.additions ?? 1,
      deletions: parsed?.deletions ?? 1,
    } satisfies CodexFileToolEntry;
  });
}

// ---------------------------------------------------------------------------
// Command success helper — considers both status and exitCode
// ---------------------------------------------------------------------------

function isCommandSuccessful(item: CommandExecutionItem): boolean {
  if (item.status === "completed") return true;
  if (item.status === "cancelled") return false;
  // exitCode 为 0 表示命令实际成功，即使 status 不是 "completed"
  return item.exitCode != null && item.exitCode === 0;
}

// ---------------------------------------------------------------------------
// Emit tool_result event
// ---------------------------------------------------------------------------

function emitToolResult(item: CodexItem, requestId: string, toolCallId: string, emit: EmitFn): void {
  if (item.type === "commandExecution") {
    const descriptor = getCommandToolDescriptor(item.command);
    emit({
      evt: "tool_result", id: requestId, toolCallId,
      toolName: descriptor.toolName,
      toolInput: descriptor.toolInput,
      success: isCommandSuccessful(item),
      result: truncate(item.aggregatedOutput || ""),
      display: getCodexToolResultDisplay(descriptor.toolName, isCommandSuccessful(item), truncate(item.aggregatedOutput || "")),
    });
  } else if (item.type === "fileChange") {
    const normalisedKinds = item.changes.map((c) => normaliseFileChangeKind(c.kind));
    const kinds = new Set(normalisedKinds);
    const toolName = kinds.size === 1 && kinds.has("add") ? "Write"
      : kinds.size === 1 && kinds.has("delete") ? "Bash"
      : "Edit";
    emit({
      evt: "tool_result", id: requestId, toolCallId,
      toolName,
      toolInput: JSON.stringify({ changes: item.changes }),
      success: item.status === "completed",
      result: item.changes.map((c, i) => `${normalisedKinds[i]}: ${c.path}`).join(", "),
      display: defaultToolDisplay(item.status === "completed"),
    });
  } else if (item.type === "mcpToolCall") {
    const resultText = item.result ? JSON.stringify(item.result) : item.error?.message ?? "";
    const toolName = normalizeMcpToolName(item.server, item.tool);
    emit({
      evt: "tool_result", id: requestId, toolCallId,
      toolName,
      toolInput: JSON.stringify(item.arguments),
      success: item.status === "completed",
      result: truncate(resultText),
      display: defaultToolDisplay(item.status === "completed"),
    });
  }
}

// ---------------------------------------------------------------------------
// Per-turn state — tracks mutable state across a single turn's event stream.
// ---------------------------------------------------------------------------

interface TurnState {
  activeRequestId: string;
  /** Conversation ID used to persist provider context-window snapshots. */
  conversationId: string | null;
  /** Request ID bound to the currently executing turn/start call. */
  turnRequestId: string | null;
  fullText: string;
  sessionEmitted: boolean;
  /** Item.id → toolCallId mapping. */
  readonly itemToolCallIds: Map<string, string>;
  readonly fileToolEntries: Map<string, ReadonlyArray<CodexFileToolEntry>>;
  readonly commandToolEntries: Map<string, ReadonlyArray<CodexCommandToolEntry>>;
  /** Previous todo items for diff computation. */
  previousTodos: ReadonlyArray<ProtocolTodoItem>;
  /** Accumulated token usage across turns. */
  totalInputTokens: number;
  totalOutputTokens: number;
  /** Last turn's input/cache tokens. Input includes cached tokens in Codex tokenUsage. */
  lastTurnInputTokens: number;
  lastTurnCacheReadTokens: number;
  /** Last turn's output tokens. */
  sumOutputTokens: number;
  /**
   * Item IDs that already had a tool_start emitted via the approval handler.
   * When item/started fires for these items, we skip emitting a duplicate tool_start.
   * The approval handler pre-registers entries so the frontend shows one unified tool call.
   */
  readonly approvalItemIds: Set<string>;
  /** Last emitted plan explanation — used to deduplicate repeated turn/plan/updated. */
  _lastPlanExplanation: string;
  /** Tool call ID for the TodoWrite card emitted for plan steps. */
  _planToolCallId: string | null;
  /** threadId → agent metadata, populated by thread/started notifications. */
  readonly threadAgentInfo: Map<string, { nickname: string; role: string }>;
  /** threadId → agentId mapping for collab agents tracked via collabAgentToolCall. */
  readonly collabAgentIds: Map<string, string>;
  /** item.id → prompt mapping, cached from spawnAgent item/started for use in item/completed. */
  readonly collabSpawnPrompts: Map<string, string>;
  /** agentId → start timestamp for collab subagents. */
  readonly collabAgentStartTimes: Map<string, number>;
  /** agentId → cumulative tool-call count for collab subagents. */
  readonly collabAgentToolUses: Map<string, number>;
  /** The main thread's ID — set on first turn/started; used to filter sub-agent turn/completed. */
  mainThreadId: string | null;
  /** Currently active turn ID on the main thread, if known. */
  activeTurnId: string | null;
  /** Last completed turn ID observed from notifications. */
  lastCompletedTurnId: string | null;
  /** Most recent notification turn ID seen by the listener. */
  lastNotificationTurnId: string | null;
  /** Most recent notification thread ID seen by the listener. */
  lastNotificationThreadId: string | null;
  /** Number of turn/start attempts issued from this state container. */
  turnStartCount: number;
  /** Number of steer requests injected into an active turn. */
  steerRequestCount: number;
  /** Most recent requestId that entered through steer. */
  lastSteerRequestId: string | null;
  /** Whether a turn/plan/updated notification was received during the current turn. */
  planReceivedThisTurn: boolean;
  /** Accumulated plan-only content from turn/plan/updated and item/plan/delta.
   *  Unlike fullText which mixes all text output, this captures ONLY plan text
   *  so it can be persisted to .claude/plans/ for the "View Plan" button. */
  planContent: string;
  /** When the active turn was started by `thread/compact/start` (manual /compact),
   *  the contextCompaction item handler reports this as `trigger: "manual"`.
   *  Reset after the compact event is emitted. */
  pendingCompactTrigger: "manual" | null;
  /** 最近一次发给 App Server 的 turn/start input 摘要，用于 400 诊断。 */
  lastTurnStartInputPreview: string | null;
  /** 最近一次发给 App Server 的 turn/start 完整 payload 摘要，用于 400 诊断。 */
  lastTurnStartPayloadPreview: string | null;
  /** 最近一次 turn/steer payload 摘要，用于排查中途追加消息造成的错配。 */
  lastSteerPayloadPreview: string | null;
  /** 最近一次工具调用错配诊断，用于把中间 error 通知带到最终会话错误里。 */
  lastToolCallMismatchDiagnostic: string | null;
  /** 最近一次工具调用错配原始错误。 */
  lastToolCallMismatchError: string | null;
  /** Set when TOOL_CALL_MISMATCH triggers recovery — signals the retry loop
   *  to perform thread/compact/start before re-sending turn/start. */
  needsCompactBeforeRetry: boolean;
  /** Prevents infinite recovery loops — only one compact-retry per turn. */
  toolCallMismatchRecoveryAttempted: boolean;
}

function stringifyDiagValue(value: unknown, limit: number = 240): string {
  if (value == null) return "null";
  const rendered = typeof value === "string"
    ? value
    : (() => {
        try {
          return JSON.stringify(value);
        } catch {
          return String(value);
        }
      })();
  const normalized = rendered.replace(/\s+/g, " ").trim();
  return normalized.length > limit ? `${normalized.slice(0, limit)}...` : normalized;
}

function logTurnStateSnapshot(
  label: string,
  state: TurnState,
  extra?: Record<string, unknown>,
): void {
  // Guard: skip expensive serialization when debug logging is disabled
  if (!shouldLog("debug")) return;

  const parts = [
    `activeRequestId=${state.activeRequestId}`,
    `turnRequestId=${state.turnRequestId ?? "none"}`,
    `activeTurnId=${state.activeTurnId ?? "none"}`,
    `lastCompletedTurnId=${state.lastCompletedTurnId ?? "none"}`,
    `lastNotificationTurnId=${state.lastNotificationTurnId ?? "none"}`,
    `lastNotificationThreadId=${state.lastNotificationThreadId ?? "none"}`,
    `mainThreadId=${state.mainThreadId ?? "none"}`,
    `turnStartCount=${state.turnStartCount}`,
    `steerRequestCount=${state.steerRequestCount}`,
    `lastSteerRequestId=${state.lastSteerRequestId ?? "none"}`,
    `itemToolCallIds=${state.itemToolCallIds.size}`,
    `fileToolEntries=${state.fileToolEntries.size}`,
    `commandToolEntries=${state.commandToolEntries.size}`,
    `approvalItemIds=${state.approvalItemIds.size}`,
    `planReceived=${state.planReceivedThisTurn}`,
    `fullTextLen=${state.fullText.length}`,
  ];
  if (extra) {
    for (const [key, value] of Object.entries(extra)) {
      if (value === undefined) continue;
      parts.push(`${key}=${stringifyDiagValue(value)}`);
    }
  }
  log.debug(`[diag:${label}] ${parts.join(" ")}`);
}

function isToolCallMismatchMessage(message: string): boolean {
  return /No tool call found for (custom tool call|function call) output/i.test(message);
}

function extractOrphanedCallId(message: string): string | null {
  return message.match(/call_id\s+([A-Za-z0-9_-]+)/i)?.[1] ?? null;
}

function findInternalCallIds(value: unknown): string[] {
  let rendered: string;
  try {
    rendered = JSON.stringify(value);
  } catch {
    rendered = String(value);
  }
  return [...new Set(
    (rendered.match(/\bcall_[A-Za-z0-9_-]+\b/g) ?? [])
      .filter((callId) => callId !== "call_id"),
  )];
}

function summarizeTurnItemForMismatch(item: unknown): string {
  if (!item || typeof item !== "object") return stringifyDiagValue(item, 500);
  const obj = item as Record<string, unknown>;
  const callIds = findInternalCallIds(item);
  const parts = [
    `id=${stringifyDiagValue(obj.id, 120)}`,
    `type=${stringifyDiagValue(obj.type, 120)}`,
    `status=${stringifyDiagValue(obj.status, 120)}`,
  ];
  for (const key of ["name", "tool", "server", "command", "path", "query"]) {
    if (obj[key] !== undefined) parts.push(`${key}=${stringifyDiagValue(obj[key], 180)}`);
  }
  if (callIds.length > 0) parts.push(`internalCallIds=[${callIds.join(",")}]`);
  parts.push(`keys=[${Object.keys(obj).join(",")}]`);
  return parts.join(" ");
}

function buildToolCallMismatchDiagnostics(
  label: string,
  errMsg: string,
  params: Record<string, unknown>,
  state: TurnState,
  rpc?: CodexRpcChannel,
): string {
  const lines: string[] = [];
  const push = (message: string) => lines.push(`[${label}] ${message}`);
  const orphanedCallId = extractOrphanedCallId(errMsg);
  const turn = params.turn as { id?: string; status?: string; items?: ReadonlyArray<unknown>; error?: unknown } | undefined;
  const turnItems = Array.isArray(turn?.items) ? turn.items : [];
  const paramCallIds = findInternalCallIds(params);
  const matchingItems = orphanedCallId
    ? turnItems.filter((item) => findInternalCallIds(item).includes(orphanedCallId))
    : [];

  push("========== TOOL CALL MISMATCH 诊断开始 ==========");
  push(`message=${errMsg}`);
  push(`orphanedCallId=${orphanedCallId ?? "unknown"} paramCallIds=[${paramCallIds.join(",") || "none"}]`);
  push(`activeRequestId=${state.activeRequestId} turnRequestId=${state.turnRequestId ?? "none"} activeTurnId=${state.activeTurnId ?? "none"}`);
  push(`lastCompletedTurnId=${state.lastCompletedTurnId ?? "none"} lastNotificationTurnId=${state.lastNotificationTurnId ?? "none"} lastNotificationThreadId=${state.lastNotificationThreadId ?? "none"}`);
  push(`mainThreadId=${state.mainThreadId ?? "none"} turnStartCount=${state.turnStartCount} steerRequestCount=${state.steerRequestCount} lastSteerRequestId=${state.lastSteerRequestId ?? "none"}`);
  push(`lastTurnStartInputPreview=${state.lastTurnStartInputPreview ?? "none"}`);
  push(`lastTurnStartPayloadPreview=${state.lastTurnStartPayloadPreview ?? "none"}`);
  push(`lastSteerPayloadPreview=${state.lastSteerPayloadPreview ?? "none"}`);
  push(`itemToolCallIds count=${state.itemToolCallIds.size}`);
  for (const [itemId, toolCallId] of state.itemToolCallIds) {
    push(`  itemToolCallIds ${itemId} -> ${toolCallId}`);
  }
  push(`fileToolEntries count=${state.fileToolEntries.size}`);
  for (const [itemId, entries] of state.fileToolEntries) {
    push(`  fileToolEntries ${itemId} -> [${entries.map((entry) => `${entry.toolName}:${entry.toolCallId}`).join(", ")}]`);
  }
  push(`commandToolEntries count=${state.commandToolEntries.size}`);
  for (const [itemId, entries] of state.commandToolEntries) {
    push(`  commandToolEntries ${itemId} -> [${entries.map((entry) => `${entry.toolName}:${entry.toolCallId}`).join(", ")}]`);
  }
  push(`approvalItemIds=[${[...state.approvalItemIds].join(", ") || "none"}]`);
  push(`turn.id=${turn?.id ?? "none"} turn.status=${turn?.status ?? "none"} turnItems=${turnItems.length}`);
  turnItems.slice(0, 80).forEach((item, index) => {
    const marker = orphanedCallId && findInternalCallIds(item).includes(orphanedCallId) ? " MATCH_ORPHAN" : "";
    push(`  turn.items[${index}]${marker} ${summarizeTurnItemForMismatch(item)}`);
  });
  if (matchingItems.length === 0 && orphanedCallId) {
    push(`orphanedCallId ${orphanedCallId} 未出现在 turn.items 摘要中，优先怀疑 App Server 输入历史压缩/续接时漏带对应 function_call。`);
  }
  push(`full params preview=${stringifyDiagValue(params, 60_000)}`);
  const importantTraceLines = rpc?.getImportantTraceLines(500) ?? [];
  push(`importantRpcTrace count=${importantTraceLines.length}`);
  for (const line of importantTraceLines) {
    push(`  importantRpcTrace ${line}`);
  }
  const traceLines = rpc?.getRecentTraceLines(40) ?? [];
  push(`recentRawRpcTrace count=${traceLines.length}`);
  for (const line of traceLines) {
    push(`  recentRawRpcTrace ${line}`);
  }
  push("========== TOOL CALL MISMATCH 诊断结束 ==========");
  return lines.join("\n");
}

function dumpToolCallMismatchDiagnostics(
  label: string,
  errMsg: string,
  params: Record<string, unknown>,
  state: TurnState,
  rpc?: CodexRpcChannel,
): string {
  rpc?.dumpImportantTrace(label, 500);
  rpc?.dumpRecentTrace(label, 40);
  const diagnostic = buildToolCallMismatchDiagnostics(label, errMsg, params, state, rpc);
  for (const line of diagnostic.split("\n")) {
    log(line);
  }
  return diagnostic;
}

function fencedDiagnosticBlock(text: string): string {
  let fence = "```";
  while (text.includes(fence)) {
    fence += "`";
  }
  return `${fence}text\n${text}\n${fence}`;
}

function formatToolCallMismatchErrorForChat(errMsg: string, diagnostic: string): string {
  return `${errMsg}\n\n---\n**Codex tool-call mismatch diagnostics**\n\n${fencedDiagnosticBlock(diagnostic)}`;
}

/**
 * Send `thread/compact/start` and wait for the resulting compaction turn to
 * complete.  Used to recover from TOOL_CALL_MISMATCH errors where context
 * compaction broke the tool_call / tool_result pairing.
 */
async function performCompactionForRecovery(rpc: CodexRpcChannel, threadId: string): Promise<void> {
  const response = await rpc.request("thread/compact/start", { threadId }) as
    { turn?: { id?: string } } | undefined;
  const compactTurnId = (response as { turn?: { id?: string } } | undefined)?.turn?.id;
  log(`[compact-recovery] Compaction turn started: id=${compactTurnId ?? "unknown"}`);

  if (!compactTurnId) {
    log(`[compact-recovery] No turn ID returned, skipping wait`);
    return;
  }

  return new Promise<void>((resolve) => {
    const timeout = setTimeout(() => {
      unsub();
      log(`[compact-recovery] Timed out (30s) waiting for compaction turn ${compactTurnId}`);
      resolve();
    }, 30_000);

    const unsub = rpc.onNotification((method, params) => {
      if (method === "turn/completed") {
        const turn = params.turn as { id?: string; status?: string } | undefined;
        if (turn?.id === compactTurnId) {
          clearTimeout(timeout);
          unsub();
          log(`[compact-recovery] Compaction turn ${compactTurnId} completed: status=${turn.status}`);
          resolve();
        }
      }
    });
  });
}

// ---------------------------------------------------------------------------
// Process App Server JSON-RPC notifications for a single turn.
// Each notification is processed individually (called by the notification listener).
// ---------------------------------------------------------------------------

function processTurnNotification(
  method: string,
  params: Record<string, unknown>,
  state: TurnState,
  emit: EmitFn,
  abortController: AbortController,
  _resolvedModel: string,
  onTurnComplete: (result: { succeeded: boolean; completedNormally: boolean }) => void,
  rpc?: CodexRpcChannel,
): void {
  if (abortController.signal.aborted) return;

  const _diagThreadId = params.threadId as string | undefined;
  const _diagTurnId = params.turnId as string | undefined;
  state.lastNotificationThreadId = _diagThreadId ?? state.lastNotificationThreadId;
  state.lastNotificationTurnId = _diagTurnId ?? state.lastNotificationTurnId;
  if (
    (method.startsWith("thread/") || method.startsWith("item/") || method.startsWith("turn/"))
    && !method.endsWith("/delta") && !method.endsWith("/outputDelta") && !method.endsWith("Delta")
  ) {
    const itemType = (params.item as Record<string, unknown> | undefined)?.type;
    const itemId = (params.item as Record<string, unknown> | undefined)?.id ?? params.itemId;
    logTurnStateSnapshot("notification", state, {
      method,
      threadId: _diagThreadId ?? "none",
      turnId: _diagTurnId ?? "none",
      itemType: itemType ?? "none",
      itemId: typeof itemId === "string" ? itemId : undefined,
      matchesActiveTurn: _diagTurnId ? _diagTurnId === state.activeTurnId : undefined,
    });
  }

  const getCollabAgentId = (threadId: string | undefined): string | undefined => {
    if (!threadId || (state.mainThreadId && threadId === state.mainThreadId)) return undefined;
    return state.collabAgentIds.get(threadId);
  };

  const emitCollabProgress = (threadId: string | undefined, toolName: string, extra?: {
    readonly totalTokens?: number;
    readonly inputTokens?: number;
    readonly outputTokens?: number;
    readonly cacheReadTokens?: number;
    readonly cacheCreationTokens?: number;
    readonly summary?: string;
    readonly incrementToolUses?: boolean;
  }) => {
    const agentId = getCollabAgentId(threadId);
    if (!agentId) return;
    const durationMs = Math.max(0, Date.now() - (state.collabAgentStartTimes.get(agentId) ?? Date.now()));
    const toolUses = extra?.incrementToolUses
      ? (state.collabAgentToolUses.get(agentId) ?? 0) + 1
      : (state.collabAgentToolUses.get(agentId) ?? 0);
    if (extra?.incrementToolUses) {
      state.collabAgentToolUses.set(agentId, toolUses);
    }
    emit({
      evt: "task_progress",
      id: state.activeRequestId,
      taskId: "",
      agentId,
      totalTokens: extra?.totalTokens,
      inputTokens: extra?.inputTokens,
      outputTokens: extra?.outputTokens,
      cacheReadTokens: extra?.cacheReadTokens,
      cacheCreationTokens: extra?.cacheCreationTokens,
      toolUses,
      durationMs,
      lastToolName: toolName,
      summary: extra?.summary,
    });
  };

  const emitCollabCompletion = (
    threadId: string | undefined,
    status: string,
    result?: string | null,
  ) => {
    const agentId = getCollabAgentId(threadId);
    if (!agentId) return;
    const durationMs = Math.max(0, Date.now() - (state.collabAgentStartTimes.get(agentId) ?? Date.now()));
    emit({
      evt: "task_notification",
      id: state.activeRequestId,
      taskId: "",
      agentId,
      status,
      summary: result ?? undefined,
      toolUses: state.collabAgentToolUses.get(agentId) ?? 0,
      durationMs,
    });
    if (result) {
      emit({
        evt: "subagent_completed",
        id: state.activeRequestId,
        toolUseId: "",
        result,
        subagentType: "codex-collab",
        agentId,
      });
    }
  };

  switch (method) {
    case "turn/started": {
      const startedTurnId = ((params.turn as { id?: string } | undefined)?.id ?? _diagTurnId) ?? null;
      state.activeTurnId = startedTurnId;
      state.lastCompletedTurnId = null;
      logTurnStateSnapshot("turn_started", state, {
        turnId: startedTurnId ?? "none",
        threadId: _diagThreadId ?? "none",
      });
      // Capture the main thread ID on the very first turn/started notification.
      // Subsequent turn/started from sub-agent threads are ignored for this purpose.
      if (!state.mainThreadId && _diagThreadId) {
        state.mainThreadId = _diagThreadId;
        log(`[turn/started] Main thread captured: ${_diagThreadId}`);
      }
      break;
    }

    case "item/started": {
      // v2 schema: { item: ThreadItem, threadId, turnId }
      const item = params.item as CodexItem | undefined;
      if (!item) {
        log(`[item/started] WARNING: no item in params. keys=${Object.keys(params).join(",")}`);
        break;
      }
      log(`[item/started] type=${item.type} id=${item.id} threadId=${_diagThreadId} status=${"status" in item ? String(item.status) : "n/a"}`);
      // Log raw item keys for debugging unknown item types
      log(`[item/started:keys] ${Object.keys(item).join(", ")}`);

      if (_diagThreadId && state.mainThreadId && _diagThreadId !== state.mainThreadId) {
        if (item.type === "commandExecution") {
          emitCollabProgress(_diagThreadId, "Bash", { incrementToolUses: true });
        } else if (item.type === "mcpToolCall") {
          const mcpItem = item as McpToolCallItem;
          emitCollabProgress(_diagThreadId, normalizeMcpToolName(mcpItem.server, mcpItem.tool), { incrementToolUses: true });
        } else if (item.type === "webSearch") {
          emitCollabProgress(_diagThreadId, "WebSearch", { incrementToolUses: true });
        }
      }

      if (item.type === "reasoning") {
        break; // Handled via delta notifications
      }
      if (item.type === "agentMessage") {
        break; // Handled on completed + deltas
      }
      if (item.type === "plan") {
        // Plan items: text arrives via item/plan/delta, steps via turn/plan/updated.
        // No tool_start needed — plans are not tool calls.
        break;
      }

      if (item.type === "webSearch") {
        const toolCallId = makeToolCallId();
        state.itemToolCallIds.set(item.id, toolCallId);
        emit({ evt: "tool_start", id: state.activeRequestId, toolCallId, toolName: "WebSearch", toolInput: JSON.stringify({ query: item.query }) });
        break;
      }

      if (item.type === "fileChange") {
        // If the approval handler already emitted tool_start for this item, skip.
        if (state.approvalItemIds.has(item.id)) {
          break;
        }
        const fileEntries = buildFileToolEntries(item.changes);
        state.fileToolEntries.set(item.id, fileEntries);
        // Register primary toolCallId so requestApproval can detect and reuse it
        // when it arrives after item/started (prevents duplicate tool_start).
        if (fileEntries.length > 0) {
          state.itemToolCallIds.set(item.id, fileEntries[0].toolCallId);
        }
        for (const entry of fileEntries) {
          emit({
            evt: "tool_start",
            id: state.activeRequestId,
            toolCallId: entry.toolCallId,
            toolName: entry.toolName,
            toolInput: entry.toolInput,
          });
        }
        break;
      }

      if (item.type === "commandExecution") {
        // If the approval handler already emitted tool_start for this item, skip.
        if (state.approvalItemIds.has(item.id)) {
          break;
        }
        const entries = getCommandToolEntries(item.command);
        state.commandToolEntries.set(item.id, entries);
        // Register primary toolCallId so requestApproval can detect and reuse it
        // when it arrives after item/started (prevents duplicate tool_start).
        if (entries.length > 0) {
          state.itemToolCallIds.set(item.id, entries[0].toolCallId);
        }
        for (const entry of entries) {
          emit({ evt: "tool_start", id: state.activeRequestId, toolCallId: entry.toolCallId, toolName: entry.toolName, toolInput: entry.toolInput });
        }
      } else if (item.type === "mcpToolCall") {
        const mcpItem = item as McpToolCallItem;
        log(`[mcpToolCall:item/started] server=${mcpItem.server} tool=${mcpItem.tool} status=${mcpItem.status} id=${mcpItem.id} args=${JSON.stringify(mcpItem.arguments).slice(0, 200)}`);
        const toolCallId = makeToolCallId();
        state.itemToolCallIds.set(item.id, toolCallId);
        emit({
          evt: "tool_start",
          id: state.activeRequestId,
          toolCallId,
          toolName: normalizeMcpToolName(mcpItem.server, mcpItem.tool),
          toolInput: JSON.stringify(mcpItem.arguments),
        });
      } else if (item.type === "collabAgentToolCall") {
        const collabItem = item as CollabAgentToolCallItem;
        log(`[collabAgent:item/started] tool=${collabItem.tool} status=${collabItem.status} senderThreadId=${collabItem.senderThreadId} receiverThreadIds=${JSON.stringify(collabItem.receiverThreadIds)} prompt=${collabItem.prompt?.slice(0, 100)} agentsStates=${JSON.stringify(collabItem.agentsStates)?.slice(0, 300)}`);

        // NOTE: For spawnAgent, receiverThreadIds is EMPTY in item/started.
        // The actual thread IDs only arrive in item/completed. Cache the prompt
        // here so we can use it as the agent description when registering later.
        if (collabItem.tool === "spawnAgent" && collabItem.prompt) {
          // Store prompt keyed by item id for retrieval in item/completed
          state.collabSpawnPrompts.set(collabItem.id, collabItem.prompt);
        }

        const toolCallId = makeToolCallId();
        state.itemToolCallIds.set(collabItem.id, toolCallId);

        // Emit tool_start so the frontend renders an Agent tool card
        if (collabItem.tool === "spawnAgent") {
          const description = collabItem.prompt?.slice(0, 100) ?? collabItem.tool;
          emit({
            evt: "tool_start",
            id: state.activeRequestId,
            toolCallId,
            toolName: "Agent",
            toolInput: JSON.stringify({ description, prompt: collabItem.prompt ?? "" }),
          });
        }
      } else if (item.type === "contextCompaction") {
        const toolCallId = makeToolCallId();
        state.itemToolCallIds.set(item.id, toolCallId);
        // Do NOT clear pendingCompactTrigger here — if the compact turn fails
        // and retries, the next item/started must still see "manual". The
        // flag is cleared in executeTurnWithRetry's finally clause and in
        // resetTurnState() on warm-session turn boundaries.
        const trigger: "manual" | "auto" = state.pendingCompactTrigger === "manual" ? "manual" : "auto";
        emit({
          evt: "compact",
          id: state.activeRequestId,
          trigger,
          preTokens: state.totalInputTokens,
        });
      } else {
        // Other types (imageView, imageGeneration, etc.)
        const toolCallId = makeToolCallId();
        state.itemToolCallIds.set((item as CodexItemBase).id, toolCallId);
      }
      break;
    }

    case "item/agentMessage/delta": {
      // v2 schema: { threadId, turnId, itemId, delta }
      const delta = params.delta as string | undefined;
      if (delta) {
        state.fullText += delta;
        emit({ evt: "text_delta", id: state.activeRequestId, delta });
      }
      break;
    }

    case "item/reasoning/textDelta": {
      // v2 schema: { threadId, turnId, itemId, delta, contentIndex }
      const delta = params.delta as string | undefined;
      if (delta) {
        log(`[reasoning/raw] len=${delta.length}`);
        emit({ evt: "thinking_delta", id: state.activeRequestId, delta, kind: "raw" });
      }
      break;
    }

    case "item/reasoning/summaryTextDelta": {
      // v2 schema: { threadId, turnId, itemId, delta, summaryIndex }
      const delta = params.delta as string | undefined;
      if (delta) {
        emit({ evt: "thinking_delta", id: state.activeRequestId, delta, kind: "summary" });
      }
      break;
    }

    case "item/reasoning/summaryPartAdded": {
      log("[reasoning/summaryPartAdded] start new summary block");
      emit({
        evt: "thinking_delta",
        id: state.activeRequestId,
        delta: "",
        kind: "summary",
        startNewBlock: true,
      });
      break;
    }

    case "item/reasoning/sectionBreak": {
      log("[reasoning/sectionBreak] start new raw block");
      emit({
        evt: "thinking_delta",
        id: state.activeRequestId,
        delta: "",
        kind: "raw",
        startNewBlock: true,
      });
      break;
    }

    case "item/reasoning/rawContentDelta": {
      const delta = params.delta as string | undefined;
      if (delta) {
        log(`[reasoning/rawContent] len=${delta.length}`);
        emit({ evt: "thinking_delta", id: state.activeRequestId, delta, kind: "raw" });
      }
      break;
    }

    case "item/mcpToolCall/progress": {
      // No-op: openai_images MCP server runs in one-shot mode, never sends
      // progress notifications. Other MCP servers may emit progress but we
      // don't currently relay them anywhere.
      break;
    }

    case "item/commandExecution/outputDelta": {
      // v2 schema: { threadId, turnId, itemId, delta }
      const delta = params.delta as string | undefined;
      const itemId = params.itemId as string | undefined;
      if (delta && itemId) {
        const entries = state.commandToolEntries.get(itemId);
        if (entries && entries.length === 1 && entries[0].toolName === "Bash") {
          emit({
            evt: "tool_output", id: state.activeRequestId,
            toolCallId: entries[0].toolCallId,
            output: delta,
          });
        }
      }
      break;
    }

    case "item/completed": {
      // v2 schema: { item: ThreadItem, threadId, turnId }
      const item = params.item as CodexItem | undefined;
      if (!item) break;
      const completedToolCallId = state.itemToolCallIds.get(item.id);
      log(`[item/completed] type=${item.type} id=${item.id} threadId=${_diagThreadId} status=${"status" in item ? String(item.status) : "n/a"} mappedToolCallId=${completedToolCallId ?? "none"}`);

      // Enhanced MCP tool call diagnostics
      if (item.type === "mcpToolCall") {
        const mcpItem = item as McpToolCallItem;
        log(`[mcpToolCall:item/completed] server=${mcpItem.server} tool=${mcpItem.tool} status=${mcpItem.status} error=${mcpItem.error?.message ?? "none"} hasResult=${!!mcpItem.result}`);
      }

      if (item.type === "agentMessage") {
        // Emit any remaining text not yet sent as delta
        if (item.text && item.text.length > state.fullText.length) {
          const delta = item.text.slice(state.fullText.length);
          state.fullText += delta;
          emit({ evt: "text_delta", id: state.activeRequestId, delta });
        }
      } else if (item.type === "reasoning") {
        // Reasoning completion — any final text handled via delta
      } else if (item.type === "fileChange") {
        if (state.approvalItemIds.has(item.id)) {
          // Approval path — single pre-registered toolCallId; extract diff from completed item.
          const toolCallId = state.itemToolCallIds.get(item.id) ?? makeToolCallId();
          state.approvalItemIds.delete(item.id);
          state.itemToolCallIds.delete(item.id);

          const fileItem = item as FileChangeItem;
          const change = fileItem.changes?.[0];
          const filePath = change?.path ?? "";
          const parsed = change?.diff ? parseUnifiedDiffContent(change.diff) : null;
          const kind = normaliseFileChangeKind(change?.kind);

          const toolName = kind === "add" ? "Write"
            : kind === "delete" ? "Delete"
            : "Edit";

          const toolInput = (() => {
            if (!parsed) return JSON.stringify({ file_path: filePath });
            if (kind === "add") return JSON.stringify({ file_path: filePath, content: parsed.newStr });
            if (kind === "delete") return JSON.stringify({ file_path: filePath });
            return JSON.stringify({ file_path: filePath, old_string: parsed.oldStr, new_string: parsed.newStr });
          })();

          emit({
            evt: "tool_result", id: state.activeRequestId,
            toolCallId, toolName, toolInput,
            success: item.status === "completed",
            result: `File change ${item.status === "completed" ? "completed" : "failed"}`,
            display: defaultToolDisplay(item.status === "completed"),
          });
          if (filePath) {
            emit({
              evt: "file_changed", id: state.activeRequestId,
              filePath,
              action: kind === "add" ? "add" : kind === "delete" ? "delete" : "edit",
              toolName,
              additions: parsed?.additions ?? 0,
              deletions: parsed?.deletions ?? 0,
            });
          }
        } else {
          // Normal path — use entries from item/started, enriched with diff from completed item.
          let fileEntries = state.fileToolEntries.get(item.id);
          const completedChanges = (item as FileChangeItem).changes;

          if (fileEntries) {
            // Check if entries lack diff content but completed item has it
            const firstInput = fileEntries[0] ? JSON.parse(fileEntries[0].toolInput) as Record<string, unknown> : null;
            const needsEnrichment = firstInput && !firstInput.old_string && !firstInput.new_string && !firstInput.content;
            if (needsEnrichment && completedChanges?.some(c => c.diff)) {
              const oldEntries = fileEntries;
              const rebuilt = buildFileToolEntries(completedChanges);
              fileEntries = rebuilt.map((ne, i) => ({
                ...ne,
                toolCallId: oldEntries[i]?.toolCallId ?? ne.toolCallId,
              }));
            }
          } else {
            fileEntries = buildFileToolEntries(completedChanges);
          }

          state.fileToolEntries.delete(item.id);
          state.itemToolCallIds.delete(item.id);

          for (const entry of fileEntries) {
            emit({
              evt: "tool_result", id: state.activeRequestId,
              toolCallId: entry.toolCallId, toolName: entry.toolName,
              toolInput: entry.toolInput,
              success: item.status === "completed",
              result: entry.result,
              display: defaultToolDisplay(item.status === "completed"),
            });
            emit({
              evt: "file_changed", id: state.activeRequestId,
              filePath: entry.filePath, action: entry.action,
              toolName: entry.toolName,
              additions: entry.additions, deletions: entry.deletions,
            });
          }
        }
      } else if (item.type === "commandExecution") {
        const cmdSuccess = isCommandSuccessful(item as CommandExecutionItem);
        if (state.approvalItemIds.has(item.id)) {
          // Item went through approval — use the single pre-registered toolCallId.
          const toolCallId = state.itemToolCallIds.get(item.id) ?? makeToolCallId();
          state.approvalItemIds.delete(item.id);
          state.itemToolCallIds.delete(item.id);
          emit({
            evt: "tool_result", id: state.activeRequestId,
            toolCallId, toolName: "Bash",
            toolInput: JSON.stringify({ command: item.command }),
            success: cmdSuccess,
            result: truncate(item.aggregatedOutput || "Command completed"),
            display: getCodexToolResultDisplay("Bash", cmdSuccess, truncate(item.aggregatedOutput || "Command completed")),
          });
        } else {
          // Normal path — use detailed commandToolEntries from item/started.
          const entries = state.commandToolEntries.get(item.id) ?? [makeCommandToolEntry("Bash", JSON.stringify({ command: item.command }))];
          state.commandToolEntries.delete(item.id);
          state.itemToolCallIds.delete(item.id);
          const isSingleRead = entries.length === 1 && entries[0].toolName === "Read";
          for (const entry of entries) {
            emit({
              evt: "tool_result", id: state.activeRequestId,
              toolCallId: entry.toolCallId, toolName: entry.toolName,
              toolInput: entry.toolInput,
              success: cmdSuccess,
              result: entry.result ?? (isSingleRead ? truncate(item.aggregatedOutput || "") : truncate(item.aggregatedOutput || "Read completed")),
              display: getCodexToolResultDisplay(entry.toolName, cmdSuccess, entry.result ?? (isSingleRead ? truncate(item.aggregatedOutput || "") : truncate(item.aggregatedOutput || "Read completed"))),
            });
          }
        }
      } else if (item.type === "plan") {
        // Plan item completed — structured steps handled via turn/plan/updated.
        state.itemToolCallIds.delete(item.id);
      } else if (item.type === "webSearch") {
        const toolCallId = state.itemToolCallIds.get(item.id) ?? makeToolCallId();
        state.itemToolCallIds.delete(item.id);
        emit({
          evt: "tool_result", id: state.activeRequestId, toolCallId,
          toolName: "WebSearch",
          toolInput: JSON.stringify({ query: item.query }),
          success: true,
          result: `Web search completed: ${item.query}`,
          display: defaultToolDisplay(true),
        });
      } else if (item.type === "collabAgentToolCall") {
        const collabItem = item as CollabAgentToolCallItem;
        log(`[collabAgent:item/completed] tool=${collabItem.tool} status=${collabItem.status} receiverThreadIds=${JSON.stringify(collabItem.receiverThreadIds)} agentsStates=${JSON.stringify(collabItem.agentsStates)?.slice(0, 300)}`);
        const collabToolCallId = state.itemToolCallIds.get(item.id);
        state.itemToolCallIds.delete(item.id);

        // Emit tool_result for the Agent tool card (matches tool_start from item/started)
        if (collabItem.tool === "spawnAgent" && collabToolCallId) {
          const cachedPromptForResult = state.collabSpawnPrompts.get(collabItem.id);
          emit({
            evt: "tool_result",
            id: state.activeRequestId,
            toolCallId: collabToolCallId,
            toolName: "Agent",
            toolInput: JSON.stringify({ description: cachedPromptForResult?.slice(0, 100) ?? "sub-agent", prompt: cachedPromptForResult ?? "" }),
            success: collabItem.status === "completed",
            result: collabItem.status === "completed" ? "Agent completed" : `Agent ${collabItem.status}`,
            display: defaultToolDisplay(collabItem.status === "completed"),
          });
        }

        // spawnAgent completed → receiverThreadIds is NOW populated, register agents
        if (collabItem.tool === "spawnAgent") {
          const cachedPrompt = state.collabSpawnPrompts.get(collabItem.id);
          state.collabSpawnPrompts.delete(collabItem.id);

          for (const threadId of collabItem.receiverThreadIds) {
            if (state.collabAgentIds.has(threadId)) continue;

            const agentId = threadId;
            state.collabAgentIds.set(threadId, agentId);

            const threadInfo = state.threadAgentInfo.get(threadId);
            const name = threadInfo?.nickname || `Agent-${threadId.slice(0, 8)}`;
            const description = threadInfo?.role || cachedPrompt?.slice(0, 100) || undefined;

            log(`[collabAgent] spawnAgent REGISTERED threadId=${threadId} name=${name} description=${description}`);
            emit({
              evt: "subagent_started",
              id: state.activeRequestId,
              agentId,
              agentType: "codex-collab",
              name,
              description,
              prompt: cachedPrompt,
            });
            state.collabAgentStartTimes.set(agentId, Date.now());
            state.collabAgentToolUses.set(agentId, 0);
          }
        }

        // closeAgent → explicitly close agent
        if (collabItem.tool === "closeAgent") {
          for (const threadId of collabItem.receiverThreadIds) {
            const agentId = state.collabAgentIds.get(threadId);
            if (agentId) {
              log(`[collabAgent] closeAgent threadId=${threadId} agentId=${agentId}`);
              emitCollabCompletion(threadId, "completed");
              emit({ evt: "subagent_stopped", id: state.activeRequestId, agentId });
              state.collabAgentIds.delete(threadId);
              state.collabAgentStartTimes.delete(agentId);
              state.collabAgentToolUses.delete(agentId);
            }
          }
        }

        // Check agentsStates for terminal statuses
        if (collabItem.agentsStates) {
          const terminalStatuses = ["completed", "errored", "shutdown", "notFound"];
          for (const [threadId, agentState] of Object.entries(collabItem.agentsStates)) {
            const agentId = state.collabAgentIds.get(threadId);
            if (!agentId) continue;

            if (terminalStatuses.includes(agentState.status)) {
              log(`[collabAgent] terminal status=${agentState.status} threadId=${threadId} agentId=${agentId}`);
              emitCollabCompletion(threadId, agentState.status, agentState.message);
              emit({ evt: "subagent_stopped", id: state.activeRequestId, agentId });
              state.collabAgentIds.delete(threadId);
              state.collabAgentStartTimes.delete(agentId);
              state.collabAgentToolUses.delete(agentId);
            }
          }
        }
      } else if (item.type === "contextCompaction") {
        state.itemToolCallIds.delete(item.id);
        // compacting UI will be cleared by the next text_delta or chat-done
      } else {
        const toolCallId = state.itemToolCallIds.get(item.id) ?? makeToolCallId();
        state.itemToolCallIds.delete(item.id);
        emitToolResult(item, state.activeRequestId, toolCallId, emit);
      }
      break;
    }

    case "thread/tokenUsage/updated": {
      // v2 schema: { threadId, turnId, tokenUsage: { total, last, modelContextWindow } }
      // tokenUsage.last: { totalTokens, inputTokens, cachedInputTokens, outputTokens, reasoningOutputTokens }
      const tokenUsage = params.tokenUsage as {
        total?: {
          totalTokens?: number;
          inputTokens?: number;
          outputTokens?: number;
          cachedInputTokens?: number;
          reasoningOutputTokens?: number;
        };
        last?: {
          totalTokens?: number;
          inputTokens?: number;
          outputTokens?: number;
          cachedInputTokens?: number;
          reasoningOutputTokens?: number;
        };
        modelContextWindow?: number | null;
      } | undefined;

      if (tokenUsage?.last) {
        const last = tokenUsage.last;
        const inputTokens = last.inputTokens ?? 0;
        const outputTokens = last.outputTokens ?? 0;
        const cachedInputTokens = last.cachedInputTokens ?? 0;

        state.totalInputTokens = tokenUsage.total?.inputTokens ?? inputTokens;
        state.totalOutputTokens = tokenUsage.total?.outputTokens ?? outputTokens;
        state.lastTurnInputTokens = inputTokens;
        state.lastTurnCacheReadTokens = cachedInputTokens;
        state.sumOutputTokens = outputTokens;

        emit({
          evt: "stream_usage",
          id: state.activeRequestId,
          inputTokens: Math.max(0, inputTokens - cachedInputTokens),
          outputTokens: state.sumOutputTokens,
          cacheReadTokens: cachedInputTokens,
          cacheCreationTokens: 0,
        });

        if (_diagThreadId && state.mainThreadId && _diagThreadId !== state.mainThreadId) {
          emitCollabProgress(_diagThreadId, "Tokens", {
            totalTokens: inputTokens + outputTokens,
            inputTokens: Math.max(0, inputTokens - cachedInputTokens),
            outputTokens,
            cacheReadTokens: cachedInputTokens,
            cacheCreationTokens: 0,
          });
        }

        const isMainThreadUsage = !_diagThreadId
          || (state.mainThreadId ? _diagThreadId === state.mainThreadId : !state.collabAgentIds.has(_diagThreadId));
        const contextTotalTokens = last.totalTokens ?? (inputTokens + outputTokens);
        const contextWindow = tokenUsage.modelContextWindow ?? getContextWindowForModel(_resolvedModel);
        if (isMainThreadUsage && contextTotalTokens > 0 && contextWindow > 0) {
          emit({
            evt: "context_usage",
            id: state.activeRequestId,
            conversationId: state.conversationId ?? undefined,
            requestedAt: Date.now(),
            totalTokens: contextTotalTokens,
            maxTokens: contextWindow,
            percentage: (contextTotalTokens / contextWindow) * 100,
            snapshot: tokenUsage,
          });
        }

      }
      break;
    }

    case "turn/completed": {
      // v2 schema: { threadId, turn: { id, items, status, error } }
      // status is one of: "completed", "interrupted", "failed"
      const turn = params.turn as {
        id?: string;
        status?: string;
        items?: ReadonlyArray<unknown>;
        error?: { message?: string } | null;
      } | undefined;
      const status = turn?.status;
      const completedTurnId = turn?.id ?? _diagTurnId ?? null;
      state.lastCompletedTurnId = completedTurnId;
      log(`[turn/completed] status="${status}", turnId="${turn?.id}", threadId=${_diagThreadId}, mainThreadId=${state.mainThreadId}, aborted=${abortController.signal.aborted}`);
      logTurnStateSnapshot("turn_completed", state, {
        status: status ?? "unknown",
        completedTurnId: completedTurnId ?? "none",
        notificationThreadId: _diagThreadId ?? "none",
        activeTurnMatchesCompletion: completedTurnId ? completedTurnId === state.activeTurnId : undefined,
      });

      // Ignore turn/completed from sub-agent threads — only the main thread's
      // turn/completed should terminate the conversation. Sub-agent threads fire
      // their own turn/completed independently (e.g., status="interrupted" when
      // the agent finishes or is told to wrap up).
      if (state.mainThreadId && _diagThreadId && _diagThreadId !== state.mainThreadId) {
        log(`[turn/completed] IGNORED — sub-agent thread ${_diagThreadId} (main=${state.mainThreadId})`);
        break;
      }

      if (status === "failed") {
        const errMsg = turn?.error?.message ?? "Turn failed";
        log(`[turn/completed] failed: ${errMsg}`);

        // TOOL_CALL_MISMATCH recovery: on first occurrence, force a context
        // compaction and retry instead of surfacing the error immediately.
        // The App Server's automatic compaction broke the tool_call/tool_result
        // pairing; an explicit thread/compact/start usually repairs it.
        if (isToolCallMismatchMessage(errMsg) && !state.toolCallMismatchRecoveryAttempted) {
          const diagnostic = dumpToolCallMismatchDiagnostics("turn/completed:TOOL_CALL_MISMATCH", errMsg, params, state, rpc);
          state.lastToolCallMismatchDiagnostic = diagnostic;
          state.lastToolCallMismatchError = errMsg;
          state.needsCompactBeforeRetry = true;
          state.toolCallMismatchRecoveryAttempted = true;
          log(`[TOOL_CALL_MISMATCH] Will attempt recovery via thread/compact/start on next retry`);
          state.activeTurnId = null;
          onTurnComplete({ succeeded: false, completedNormally: false });
          return;
        }

        let errorForUi = errMsg;
        if (isToolCallMismatchMessage(errMsg)) {
          const diagnostic = dumpToolCallMismatchDiagnostics("turn/completed:TOOL_CALL_MISMATCH", errMsg, params, state, rpc);
          state.lastToolCallMismatchDiagnostic = diagnostic;
          state.lastToolCallMismatchError = errMsg;
          errorForUi = formatToolCallMismatchErrorForChat(errMsg, diagnostic);
        } else if (state.lastToolCallMismatchDiagnostic) {
          const diagnostic = state.lastToolCallMismatchDiagnostic;
          const originalError = state.lastToolCallMismatchError ?? errMsg;
          errorForUi = formatToolCallMismatchErrorForChat(`${errMsg}\n\nPrevious mismatch error: ${originalError}`, diagnostic);
        }

        // Treat turn/completed(failed) as a terminal failure.
        // The App Server has already done its own internal retries (5x);
        // retrying at the sidecar level would just multiply the retries.
        if (!abortController.signal.aborted) {
          emit({
            evt: "error",
            id: state.activeRequestId,
            error: publicSidecarErrorMessage(errorForUi),
          });
        }
        state.activeTurnId = null;
        onTurnComplete({ succeeded: false, completedNormally: true });
        return;
      }

      if (status === "interrupted") {
        log(`[turn/completed] Turn interrupted`);
        state.activeTurnId = null;
        onTurnComplete({ succeeded: false, completedNormally: true });
        return;
      }

      if (status === "completed") {
        state.activeTurnId = null;
      }

      // status === "completed" (or "inProgress" edge case)
      onTurnComplete({ succeeded: true, completedNormally: true });
      break;
    }

    case "error": {
      // v2 schema: { error: { message, ... }, willRetry, threadId, turnId }
      // NOTE: Do NOT emit error events here. The terminal turn/completed(failed)
      // notification will emit the error to the UI. Emitting here as well would
      // cause duplicate error messages in the UI.
      const error = params.error as { message?: string; type?: string; param?: string; code?: string } | undefined;
      const willRetry = params.willRetry as boolean | undefined;
      const errMsg = error?.message ?? "Unknown error";
      log(`[notification] error: ${errMsg}, willRetry=${willRetry}, type=${error?.type ?? "n/a"}, code=${error?.code ?? "n/a"}, param=${error?.param ?? "n/a"}`);
      if (willRetry) {
        log(`[notification] error full params: ${JSON.stringify(params).slice(0, 1000)}`);
      }
      logTurnStateSnapshot("error_notification", state, {
        willRetry: willRetry ?? false,
        errorType: error?.type ?? "unknown",
        errorCode: error?.code ?? "unknown",
        errorParam: error?.param ?? "unknown",
        threadId: _diagThreadId ?? "none",
        turnId: _diagTurnId ?? "none",
      });

      // When Codex signals it will retry internally, forward a stream_retry event
      // to the frontend so the reconnection UI banner is shown.
      if (willRetry) {
        // Try to parse "Reconnecting... 2/5" format from the error message
        const retryMatch = errMsg.match(/(\d+)\s*\/\s*(\d+)/);
        const attempt = retryMatch ? parseInt(retryMatch[1], 10) : 1;
        const maxAttempts = retryMatch ? parseInt(retryMatch[2], 10) : MAX_QUERY_ATTEMPTS;
        emit({
          evt: "stream_retry",
          id: state.activeRequestId,
          attempt,
          max_attempts: maxAttempts,
          reason: "network_error",
        });
      }

      if (isToolCallMismatchMessage(errMsg)) {
        const diagnostic = dumpToolCallMismatchDiagnostics("error:TOOL_CALL_MISMATCH", errMsg, params, state, rpc);
        state.lastToolCallMismatchDiagnostic = diagnostic;
        state.lastToolCallMismatchError = errMsg;
      }
      break;
    }

    case "turn/diff/updated": {
      // v2 schema: TurnDiffUpdatedNotification = { threadId, turnId, diff }
      const diff = params.diff as string | undefined;
      if (diff) {
        emit({ evt: "turn_diff", id: state.activeRequestId, diff });
      }
      break;
    }

    case "turn/plan/updated": {
      // v2 schema: TurnPlanUpdatedNotification
      // { threadId, turnId, explanation: string|null, plan: Array<{step, status}> }
      const explanation = params.explanation as string | null;
      const plan = params.plan as ReadonlyArray<{ step: string; status: string }> | undefined;
      log(`[turn/plan/updated] explanation=${explanation?.slice(0, 100)} planSteps=${plan?.length ?? 0}`);

      // Mark that this turn produced a plan — used by plan approval gate
      if ((explanation && explanation.trim() !== "") || (plan && plan.length > 0)) {
        state.planReceivedThisTurn = true;
      }

      if (explanation && explanation !== state._lastPlanExplanation) {
        state._lastPlanExplanation = explanation;
        const formatted = `\n**Plan:**\n${explanation}\n\n`;
        state.fullText += formatted;
        state.planContent += formatted;
        emit({ evt: "text_delta", id: state.activeRequestId, delta: formatted });
      }

      if (plan && plan.length > 0) {
        // Append structured steps to planContent
        const stepsText = plan.map((s, i) => `${i + 1}. ${s.step}`).join("\n");
        state.planContent += `\n**Steps:**\n${stepsText}\n\n`;

        const mappedTodos: ReadonlyArray<ProtocolTodoItem> = plan.map((s) => ({
          content: s.step,
          status: s.status === "inProgress" ? "in_progress" as const
                : s.status === "completed" ? "completed" as const
                : "pending" as const,
          activeForm: s.step,
        }));
        const diff = computeTodoDiff(state.previousTodos, mappedTodos);
        state.previousTodos = mappedTodos;
        emit({ evt: "todo_updated", id: state.activeRequestId, todos: mappedTodos, diff });

        // Emit TodoWrite tool card so plan steps render as a tool card in the chat
        const todoToolInput = JSON.stringify({
          todos: mappedTodos.map(t => ({ content: t.content, status: t.status, activeForm: t.activeForm })),
        });
        if (!state._planToolCallId) {
          state._planToolCallId = makeToolCallId();
          emit({
            evt: "tool_start",
            id: state.activeRequestId,
            toolCallId: state._planToolCallId,
            toolName: "TodoWrite",
            toolInput: todoToolInput,
          });
        }
        // Always emit tool_result to update the card with latest plan state
        emit({
          evt: "tool_result",
          id: state.activeRequestId,
          toolCallId: state._planToolCallId,
          toolName: "TodoWrite",
          toolInput: todoToolInput,
          success: true,
          result: JSON.stringify(mappedTodos),
          display: defaultToolDisplay(true),
        });
      }
      break;
    }

    case "item/plan/delta": {
      // v2 schema: PlanDeltaNotification { threadId, turnId, itemId, delta }
      // EXPERIMENTAL: streaming delta for plan item text.
      const delta = params.delta as string | undefined;
      log(`[item/plan/delta] itemId=${params.itemId} deltaLen=${delta?.length ?? 0}`);
      if (delta) {
        state.fullText += delta;
        state.planContent += delta;
        emit({ evt: "text_delta", id: state.activeRequestId, delta });
      }
      break;
    }

    case "thread/started": {
      // v2 schema: ThreadStartedNotification { thread: Thread }
      // Cache agent metadata (nickname/role) for later use in collabAgentToolCall.
      log(`[thread/started] raw params keys=${Object.keys(params).join(",")}`);
      const thread = params.thread as Record<string, unknown> | undefined;
      if (thread) {
        const threadId = thread.id as string | undefined;
        const nickname = thread.agentNickname as string | undefined;
        const role = thread.agentRole as string | undefined;
        const source = thread.source as Record<string, unknown> | undefined;
        log(`[thread/started] threadId=${threadId} nickname=${nickname} role=${role} source=${JSON.stringify(source)?.slice(0, 200)}`);

        if (threadId) {
          // Cache agent info if available
          if (nickname || role) {
            state.threadAgentInfo.set(threadId, {
              nickname: nickname ?? "",
              role: role ?? "",
            });
          }

          // Detect sub-agent threads: if this thread has agentNickname/agentRole
          // OR source indicates it's a sub-agent, emit subagent_started directly.
          const sourceType = source?.type as string | undefined;
          const isSubAgent = !!(nickname || role || sourceType === "subAgentThreadSpawn" || sourceType === "subAgent");
          if (isSubAgent && !state.collabAgentIds.has(threadId)) {
            const agentId = threadId;
            state.collabAgentIds.set(threadId, agentId);
            const name = nickname || `Agent-${threadId.slice(0, 8)}`;
            const description = role || undefined;
            log(`[thread/started] detected sub-agent — emitting subagent_started: agentId=${agentId} name=${name}`);
            emit({
              evt: "subagent_started",
              id: state.activeRequestId,
              agentId,
              agentType: "codex-collab",
              name,
              description,
            });
            state.collabAgentStartTimes.set(agentId, Date.now());
            state.collabAgentToolUses.set(agentId, 0);
          }
        }
      } else {
        log(`[thread/started] WARNING: no 'thread' field in params. Full keys: ${Object.keys(params).join(",")}`);
      }
      break;
    }

    case "thread/status/changed": {
      // v2 schema: ThreadStatusChangedNotification { threadId, status: ThreadStatus }
      const threadId = params.threadId as string | undefined;
      const statusObj = params.status as Record<string, unknown> | undefined;
      const statusType = (statusObj as Record<string, unknown> | undefined)?.type as string | undefined;
      log(`[thread/status/changed] threadId=${threadId} status=${JSON.stringify(statusObj)?.slice(0, 200)}`);

      if (threadId && statusObj) {
        const agentId = state.collabAgentIds.get(threadId);
        // Emit subagent_stopped on terminal statuses
        if (agentId && (statusType === "systemError" || statusType === "idle")) {
          // "idle" after activity may indicate sub-agent completed its work
          if (statusType === "systemError") {
            log(`[thread/status/changed] agent ${agentId} ${statusType} — emitting subagent_stopped`);
            emitCollabCompletion(threadId, "failed");
            emit({ evt: "subagent_stopped", id: state.activeRequestId, agentId });
            state.collabAgentIds.delete(threadId);
            state.collabAgentStartTimes.delete(agentId);
            state.collabAgentToolUses.delete(agentId);
          }
        }
      }
      break;
    }

    default:
      // Silently ignore legacy codex/event/* duplicates and known informational
      // notifications. Only log truly unknown methods for debugging.
      if (method.startsWith("thread/goal/")) {
        log(`[goal-mode] notification ${method}: ${stringifyGoalLogValue(params)}`);
        emitGoalUpdated(emit, state, _diagThreadId ?? state.mainThreadId ?? "unknown", params, "notification");
      } else if (method.includes("mcp") || method.includes("Mcp") || method.includes("elicit")) {
        log(`[mcp-notification] method=${method} params=${JSON.stringify(params).slice(0, 500)}`);
      } else if (!method.startsWith("codex/event/") &&
          !method.startsWith("item/reasoning/") &&
          method !== "account/rateLimits/updated" &&
          method !== "deprecationNotice") {
        log(`Unhandled notification: ${method}`);
      }
      break;
  }
}

// ---------------------------------------------------------------------------
// Build input from prompt + images, with temp file management for images.
// ---------------------------------------------------------------------------

interface InputResult {
  input: string | Array<{ type: "text"; text: string } | { type: "localImage"; path: string }>;
  tempDir?: string;
}

/** Build a one-paragraph hint that overrides the stale size guidance baked
 *  into codex's system imagegen skill (the SKILL.md + references/cli.md +
 *  references/image-api.md only enumerate 1024×1024 / 1536×1024 / 1024×1536
 *  / auto, written for gpt-image-1.5). When the user has chosen a specific
 *  size in the UI we tell the agent to defer to the harness default rather
 *  than copying the skill's outdated values. Returns null when no override
 *  is needed (user picked "auto" or no preference set). */
function buildImageSizeHint(imageGenSize?: string): string | null {
  if (!imageGenSize || imageGenSize === "auto") return null;
  return (
    `[Image-gen note: The system "imagegen" skill's size list ` +
    `(1024x1024 / 1536x1024 / 1024x1536) is OUTDATED — gpt-image-2 supports ` +
    `up to 3840x3840 and the harness has already configured the user's ` +
    `preferred default (${imageGenSize}). When calling ` +
    `\`mcp__openai_images__generate_image\` or ` +
    `\`mcp__openai_images__edit_image\`, DO NOT pass the \`size\` argument — ` +
    `the harness will apply the user-chosen default. Continue to follow the ` +
    `imagegen skill for prompt structure / use-case taxonomy / edit ` +
    `invariants. Only override \`size\` when the user's *current* message ` +
    `explicitly demands a different aspect ratio (e.g. "make it vertical").]`
  );
}

function buildInput(
  prompt: string,
  images?: ReadonlyArray<{ media_type: string; data: string }>,
  imageGenSize?: string,
): InputResult {
  const sizeHint = buildImageSizeHint(imageGenSize);

  if (!images || images.length === 0) {
    // No attachments — still inject size hint when the user has a non-auto
    // preference so the agent doesn't accidentally pass a stale `size` value
    // it learned from the system imagegen skill.
    if (sizeHint) {
      const promptWithHint = prompt ? `${sizeHint}\n\n${prompt}` : sizeHint;
      return { input: promptWithHint };
    }
    return { input: prompt };
  }

  const ALLOWED_IMG_EXTS = new Set(["png", "jpg", "jpeg", "gif", "webp", "bmp"]);
  // Persist to a stable shared directory (not a per-turn tempDir) so the absolute
  // paths remain valid for the lifetime of the chat conversation. This lets the
  // agent reference them later as arguments to image-edit MCP tools (e.g.
  // openai_images.edit_image). Files survive across turns; the OS cleans the
  // tmpdir on reboot.
  const uploadsDir = canonicalUploadsDirectory();
  const inputParts: Array<{ type: "text"; text: string } | { type: "localImage"; path: string }> = [];
  const savedPaths: string[] = [];

  for (let i = 0; i < images.length; i++) {
    const img = images[i];
    const rawExt = (img.media_type.split("/")[1] || "png").replace(/[^a-zA-Z0-9]/g, "");
    const ext = ALLOWED_IMG_EXTS.has(rawExt) ? rawExt : "png";
    const filename = `${Date.now()}-${randomUUID().slice(0, 8)}-${i}.${ext}`;
    const tempPath = join(uploadsDir, filename);
    writeFileSync(tempPath, Buffer.from(img.data, "base64"));
    inputParts.push({ type: "localImage", path: tempPath });
    savedPaths.push(tempPath);
  }

  // Inject a path hint as a text block so the agent (LLM) sees the absolute
  // file paths in plain text and can pass them to image-edit / vision tools.
  // Without this hint, codex feeds the images to the model as `localImage`
  // multimodal parts but the agent has no way to reference them by path.
  const pathHintLines = savedPaths.map((p) => `  - ${p}`).join("\n");
  const pathHint =
    `[Attached image${savedPaths.length === 1 ? "" : "s"} saved at:\n${pathHintLines}\n` +
    `If the user wants to edit/transform/restyle the attached image(s), call the ` +
    `\`mcp__openai_images__edit_image\` tool with these absolute path(s) as ` +
    `\`image_path\`.]`;
  // Compose the leading text block: size hint (if any) + path hint + user prompt.
  const leadingHints = sizeHint ? `${sizeHint}\n\n${pathHint}` : pathHint;
  const promptWithHint = prompt ? `${leadingHints}\n\n${prompt}` : leadingHints;
  inputParts.push({ type: "text", text: promptWithHint });

  // tempDir intentionally omitted — uploadsDir is shared/long-lived, do NOT
  // cleanup per-turn or paths break for cross-turn edit_image calls.
  return { input: inputParts };
}

function cleanupTempDir(tempDir?: string): void {
  if (!tempDir) return;
  try { rmSync(tempDir, { recursive: true, force: true }); } catch { /* best-effort */ }
}

// ---------------------------------------------------------------------------
// Build JSON-RPC input format from the handler's internal input format
// ---------------------------------------------------------------------------

function buildRpcInput(
  input: string | Array<{ type: "text"; text: string } | { type: "localImage"; path: string }>,
): Array<{ type: string; text?: string; path?: string }> {
  if (typeof input === "string") {
    return [{ type: "text", text: input }];
  }
  return input.map((part) => {
    if (part.type === "text") return { type: "text", text: part.text };
    return { type: "localImage", path: part.path };
  });
}

// ---------------------------------------------------------------------------
// CODEX_HOME content cache — avoids redundant readFileSync + sanitize/build
// when ~/.codex/ source files haven't changed between sessions.
// ---------------------------------------------------------------------------

interface CodexContentCache {
  /** Sanitized config.toml content (without baseUrl/MCP injection) */
  sanitizedConfig: string | null;
  configMtime: number;

  /** Full AGENTS.md content (user content + skill index + caveman addendum) */
  agentsMd: string;
  agentsMdMtime: number;
  skillsDirMtime: number;
  /** Caveman mode used when AGENTS.md was last assembled. The cache is keyed
   *  on this so toggling caveman level invalidates the AGENTS.md slot without
   *  touching unrelated state. Empty string ≡ off ≡ undefined. */
  cavemanMode: string;
}

let _contentCache: CodexContentCache | null = null;

function resetContentCacheForTesting(): void {
  _contentCache = null;
}

/** Find the newest safe SKILL.md mtime under the provider-owned skills root. */
function getMaxSkillsMtime(skillsDir: string): number {
  const providerRoot = dirname(skillsDir);
  const entries = listProviderDirectory(providerRoot, skillsDir);
  if (!entries) return 0;

  let max = getProviderDirectoryMtime(providerRoot, skillsDir);
  for (const entry of entries) {
    if (entry.name.startsWith(".") || entry.isSymbolicLink() || !entry.isDirectory()) continue;
    const child = join(skillsDir, entry.name);
    const childMtime = getProviderDirectoryMtime(providerRoot, child);
    if (childMtime > max) max = childMtime;
    const skillMtime = getProviderRegularFileMtime(providerRoot, join(child, "SKILL.md"));
    if (skillMtime > max) max = skillMtime;
  }
  return max;
}

/**
 * Get sanitized config.toml content, using cache when source file unchanged.
 * Does NOT include baseUrl/MCP injection (those are per-session params).
 */
function getCachedSanitizedConfig(origConfigToml: string): string | null {
  const snapshot = readProviderTextFile(dirname(origConfigToml), origConfigToml);
  if (!snapshot) return null;
  const mtime = snapshot.mtimeMs;

  if (_contentCache && _contentCache.configMtime === mtime) {
    log("[codex-home] config.toml cache HIT");
    return _contentCache.sanitizedConfig;
  }

  const sanitized = sanitizeCodexConfigToml(snapshot.content);

  if (_contentCache) {
    _contentCache.sanitizedConfig = sanitized;
    _contentCache.configMtime = mtime;
  } else {
    _contentCache = { sanitizedConfig: sanitized, configMtime: mtime, agentsMd: "", agentsMdMtime: -1, skillsDirMtime: -1, cavemanMode: "" };
  }

  return sanitized;
}

/**
 * Get full AGENTS.md content, using cache when source files unchanged.
 * Skips the expensive buildSkillIndex O(N) readFileSync on cache hit.
 *
 * `cavemanMode` is part of the cache key — toggling caveman level forces a
 * rebuild without touching the unrelated skills/AGENTS source mtimes. Empty
 * string ≡ undefined ≡ "off" (no caveman addendum appended).
 */
function getCachedAgentsMd(origCodexDir: string, cavemanMode?: string): string {
  const agentsMdPath = join(origCodexDir, "AGENTS.md");
  const skillsDir = join(origCodexDir, "skills");

  const agentsMtime = getProviderRegularFileMtime(origCodexDir, agentsMdPath);
  const skillsMtime = getMaxSkillsMtime(skillsDir);
  const modeKey = cavemanMode ?? "";

  if (
    _contentCache &&
    _contentCache.agentsMdMtime === agentsMtime &&
    _contentCache.skillsDirMtime === skillsMtime &&
    _contentCache.cavemanMode === modeKey &&
    _contentCache.agentsMd
  ) {
    log("[codex-home] AGENTS.md cache HIT");
    return _contentCache.agentsMd;
  }

  // Cache miss: rebuild
  const userContent = agentsMtime > 0
    ? (readProviderTextFile(origCodexDir, agentsMdPath)?.content.trim() ?? "")
    : "";
  const skillIndex = buildSkillIndex(skillsDir);

  const sections: string[] = [];
  if (userContent) sections.push(userContent);
  if (skillIndex) sections.push(skillIndex);
  const cavemanText = getCavemanAddendum(cavemanMode);
  if (cavemanText) sections.push(cavemanText);
  const agentsMd = sections.join("\n\n---\n\n") + "\n";

  if (_contentCache) {
    _contentCache.agentsMd = agentsMd;
    _contentCache.agentsMdMtime = agentsMtime;
    _contentCache.skillsDirMtime = skillsMtime;
    _contentCache.cavemanMode = modeKey;
  } else {
    _contentCache = { sanitizedConfig: null, configMtime: -1, agentsMd, agentsMdMtime: agentsMtime, skillsDirMtime: skillsMtime, cavemanMode: modeKey };
  }

  return agentsMd;
}

// ---------------------------------------------------------------------------
// Phase 1: Spawn App Server + RPC Initialize (reusable for prewarming)
// ---------------------------------------------------------------------------

interface RpcInitParams {
  apiKey: string;
  baseUrl?: string;
  proxyUrl?: string;
  authMode?: AuthMode;
  profileId?: string;
  mcpServers?: Readonly<Record<string, unknown>>;
  codexBinaryPath?: string;
  /** Default quality for the openai_images MCP tool — propagated as env var. */
  imageGenQuality?: string;
  /** Default size tier for the openai_images MCP tool — propagated as env var. */
  imageGenSize?: string;
  /** App-managed outputs directory — propagated as `OPENAI_IMAGES_OUT` env var
   *  to the openai_images MCP child so generated PNGs land in a stable, user-
   *  configurable location instead of the OS tmpdir. */
  outputsDir?: string;
  /** When provided, use a persistent CODEX_HOME directory instead of a temp one. */
  conversationId?: string;
  /** Enable Codex App Server Goals mode for this process. */
  goalModeEnabled?: boolean;
  /** Caveman compression mode — appended to AGENTS.md when non-"off". The
   *  string is opaque here; rules.ts maps unknown levels to no-op. */
  cavemanMode?: string;
}

interface RpcSetup {
  rpc: CodexRpcChannel;
  tempHome: string;
  /** True when using a persistent CODEX_HOME (should NOT be deleted on cleanup). */
  isPersistentHome: boolean;
}

export const CODEX_COMMUNITY_CONFIG_OVERRIDES = [
  "check_for_update_on_startup=false",
  "analytics.enabled=false",
  "feedback.enabled=false",
  'otel.exporter="none"',
  'otel.trace_exporter="none"',
  'otel.metrics_exporter="none"',
  "features.remote_plugin=false",
  "features.plugins=false",
  "features.plugin_sharing=false",
  "features.skill_mcp_dependency_install=false",
  "features.apps=false",
  "shell_environment_policy.ignore_default_excludes=false",
  'shell_environment_policy.exclude=["^OPENAI_API_KEY$","^CODEX_HOME$","^BYTRO_MCP_SECRET_","^(HTTP_PROXY|HTTPS_PROXY|ALL_PROXY|http_proxy|https_proxy|all_proxy)$"]',
] as const;

export function buildCodexCommunityConfigArgs(): string[] {
  return CODEX_COMMUNITY_CONFIG_OVERRIDES.flatMap((value) => ["-c", value]);
}

export function buildCodexProviderSpawnArgs(
  isOAuthAuth: boolean,
  baseUrl?: string,
): string[] {
  const args = ["-c", 'model_providers.OpenAI.name="OpenAI"'];
  if (baseUrl) {
    args.push(
      "-c",
      `model_providers.OpenAI.base_url=${tomlString(validateCodexBaseUrl(baseUrl))}`,
    );
  }
  if (!isOAuthAuth) {
    args.push(
      "-c",
      "model_providers.OpenAI.requires_openai_auth=false",
      "-c",
      'model_providers.OpenAI.env_key="OPENAI_API_KEY"',
    );
  }
  return args;
}

export function applyCodexCommunitySpawnEnv(
  env: Record<string, string>,
): void {
  // The app-server remote-control transport is outside the local-only
  // Community Edition boundary, regardless of its version-specific default.
  env.CODEX_INTERNAL_APP_SERVER_REMOTE_CONTROL_DISABLED = "1";
  env.CODEX_INTERNAL_ORIGINATOR_OVERRIDE = "bytro-community";
}

interface CodexAppServerEnvironmentOptions {
  readonly apiKey?: string;
  readonly baseUrl?: string;
  readonly proxyUrl?: string;
}

export function buildCodexAppServerEnvironment(
  options: CodexAppServerEnvironmentOptions,
  ambient: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  const minimal = buildMinimalCliEnvironment({}, [], ambient);
  const env: Record<string, string> = Object.fromEntries(
    Object.entries(minimal).filter(
      (entry): entry is [string, string] => entry[1] !== undefined,
    ),
  );
  applyProxyEnv(env, options.proxyUrl);
  applyCodexCommunitySpawnEnv(env);
  env.CODEX_DISABLE_AUTO_UPDATE = "1";
  env.CODEX_DISABLE_TELEMETRY = "1";
  env.OTEL_SDK_DISABLED = "true";
  env.DO_NOT_TRACK = "1";
  if (options.apiKey) env.OPENAI_API_KEY = options.apiKey;
  if (options.baseUrl) {
    env.OPENAI_BASE_URL = validateProviderBaseUrl(options.baseUrl);
  }
  return env;
}

export function stripCodexMcpSectionsForRuntime(content: string): string {
  const lines = content.split("\n");
  const retained: string[] = [];
  let insideMcpSection = false;
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith("[")) {
      insideMcpSection =
        /^\[\[?mcp_servers(?:\.|\])/.test(trimmed);
    }
    if (!insideMcpSection) retained.push(line);
  }
  return retained.join("\n");
}

function writePrivateCodexFile(filePath: string, content: string): void {
  writeFileSync(filePath, content, {
    encoding: "utf8",
    mode: 0o600,
  });
  if (process.platform !== "win32") {
    chmodSync(filePath, 0o600);
  }
}

export function writeCodexApiKeyAuthFile(
  codexDir: string,
  apiKey: string,
  isOAuthAuth: boolean,
): void {
  if (isOAuthAuth) return;
  writePrivateCodexFile(
    join(codexDir, "auth.json"),
    JSON.stringify({ OPENAI_API_KEY: apiKey }),
  );
}

function isPathInside(candidate: string, root: string): boolean {
  const resolvedCandidate = resolve(candidate);
  const resolvedRoot = resolve(root);
  const prefix = resolvedRoot.endsWith(sep)
    ? resolvedRoot
    : `${resolvedRoot}${sep}`;
  return resolvedCandidate.startsWith(prefix);
}

/**
 * Remove only reconstructable runtime projections from Bytro-owned Codex
 * homes. Thread/session state and OAuth auth remain untouched.
 */
export function cleanupBytroCodexRuntimeProjection(
  tempHome: string,
  tempCodexDir: string,
  removeApiKeyAuth: boolean,
  communityRoot = buildBytroCommunityDataPath(homedir()),
  runtimeRoot = tmpdir(),
): number {
  const resolvedHome = resolve(tempHome);
  const resolvedCodexDir = resolve(tempCodexDir);
  if (resolvedCodexDir !== resolve(resolvedHome, ".codex")) return 0;

  const isCommunityHome = isPathInside(resolvedHome, communityRoot);
  const isTempRuntime =
    dirname(resolvedHome) === resolve(runtimeRoot)
    && resolvedHome.startsWith(
      resolve(runtimeRoot, CODEX_RUNTIME_PREFIX),
    );
  if (!isCommunityHome && !isTempRuntime) return 0;

  const names = [
    "config.toml",
    "AGENTS.md",
    MCP_RUNTIME_LAUNCHER_FILENAME,
    ...(removeApiKeyAuth ? ["auth.json"] : []),
  ];
  let removed = 0;
  for (const name of names) {
    const filePath = resolve(resolvedCodexDir, name);
    if (dirname(filePath) !== resolvedCodexDir) continue;
    try {
      const metadata = lstatSync(filePath);
      if (metadata.isDirectory()) continue;
      rmSync(filePath, { force: true });
      removed++;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        log(
          `[runtime-cleanup] ${summarizeDiagnosticText(String(error), "codex.runtime_cleanup")}`,
        );
      }
    }
  }
  return removed;
}

/**
 * Serialization lock for spawnAndInitializeRpc, keyed by conversationId.
 *
 * Persistent CODEX_HOME dirs (~/.bytro-community/codex-sessions/<conversationId>/)
 * are shared across calls with the same conversationId. Without this lock,
 * two concurrent calls (e.g. thread/resume racing with cold start, or two
 * quickly-submitted messages on the same conversation) would interleave the
 * three writeFileSync calls inside _spawnAndInitializeRpcInner (config.toml
 * baseline → openai_base_url prepend → MCP append), producing malformed TOML
 * or stepping on each other's .codex/ state.
 *
 * Calls without a conversationId (prewarm — uses per-call mkdtempSync temp
 * dirs) bypass the lock since each call has its own isolated path.
 */
const _setupInFlight = new Map<string, Promise<unknown>>();

async function withSerializedSetup<T>(
  key: string | undefined,
  fn: () => Promise<T>,
): Promise<T> {
  if (!key) return fn();
  const prev = _setupInFlight.get(key);
  const run = (async () => {
    if (prev) await prev.catch(() => undefined);
    return fn();
  })();
  _setupInFlight.set(key, run);
  try {
    return await run;
  } finally {
    if (_setupInFlight.get(key) === run) _setupInFlight.delete(key);
  }
}

/**
 * Phase 1 of Codex cold start — everything up to (and including) the RPC
 * `initialize` handshake. Does NOT create a thread (`thread/start`).
 *
 * This is extracted so it can be called eagerly during prewarming.
 * Serialized per conversationId via withSerializedSetup.
 */
function getSetupLockKey(params: RpcInitParams): string | undefined {
  if ((params.authMode ?? "apiKey") === "oauth" && params.profileId) return `oauth:${params.profileId}`;
  if (params.conversationId) return `conversation:${params.conversationId}`;
  return undefined;
}

async function spawnAndInitializeRpc(params: RpcInitParams): Promise<RpcSetup> {
  return withSerializedSetup(getSetupLockKey(params), () => _spawnAndInitializeRpcInner(params));
}

async function _spawnAndInitializeRpcInner(params: RpcInitParams): Promise<RpcSetup> {
  cleanupOrphanedCodexHomes();

  const resolvedAuthMode = params.authMode ?? "apiKey";
  const isOAuthAuth = resolvedAuthMode === "oauth";
  const resolvedApiKey = params.apiKey;
  if (!isOAuthAuth && !resolvedApiKey) throw new Error("OpenAI API key is not configured. Go to Settings > Models to set it.");

  const resolvedBaseUrl = params.baseUrl
    ? validateCodexBaseUrl(params.baseUrl)
    : undefined;
  const env = buildCodexAppServerEnvironment({
    apiKey: isOAuthAuth ? undefined : resolvedApiKey,
    baseUrl: resolvedBaseUrl,
    proxyUrl: params.proxyUrl,
  });

  // Create an isolated Codex config directory so the App Server uses OUR
  // API key instead of the one stored in ~/.codex/auth.json.
  // When conversationId is provided, use a persistent directory so that
  // thread data survives across app restarts and can be resumed via thread/resume.
  const origCodexDir = join(homedir(), ".codex");
  let tempHome: string;
  let tempCodexDir: string;
  let isPersistentHome = false;
  if (isOAuthAuth) {
    if (!params.profileId) throw new Error("Codex OAuth profile is missing. Please re-sign-in from Settings > Models.");
    tempCodexDir = getCodexProfileHome(params.profileId);
    tempHome = dirname(tempCodexDir);
    isPersistentHome = true;
    mkdirSync(tempCodexDir, { recursive: true });
    chmodSync(tempHome, 0o700);
    chmodSync(tempCodexDir, 0o700);
    log("[codex-home] Using isolated OAuth profile home");
  } else if (params.conversationId) {
    tempHome = buildPersistentCodexHome(
      homedir(),
      params.conversationId,
    );
    tempCodexDir = join(tempHome, ".codex");
    isPersistentHome = true;
    mkdirSync(tempHome, { recursive: true });
    chmodSync(tempHome, 0o700);
    log("[codex-home] Using isolated persistent conversation home");
  } else {
    tempHome = mkdtempSync(
      join(tmpdir(), `${CODEX_RUNTIME_PREFIX}${process.pid}-`),
    );
    tempCodexDir = join(tempHome, ".codex");
    chmodSync(tempHome, 0o700);
    log("[codex-home] Using isolated temporary home");
  }
  _activeCodexHomes.add(tempHome);
  let rpc: CodexRpcChannel | undefined;
  try {
    mkdirSync(tempCodexDir, { recursive: true });
    if (process.platform !== "win32") {
      chmodSync(tempCodexDir, 0o700);
    }
    cleanupBytroCodexRuntimeProjection(
      tempHome,
      tempCodexDir,
      !isOAuthAuth,
    );

  // Copy config.toml to preserve MCP servers, features, and other settings.
  // Uses content cache to skip readFileSync + sanitize when source unchanged.
  //
  // IMPORTANT: unconditionally reset the isolated config.toml to a known
  // baseline (sanitized user config, or empty). Persistent CODEX_HOME dirs
  // (conversationId branch) reuse the same path across calls — if we skip
  // the write when sanitizedConfig is null (user has no ~/.codex/config.toml),
  // the prepend at line below would stack `openai_base_url = ...` on top of
  // the previous session's file, producing a duplicate-key TOML at 3:1.
  const tempConfigPath = join(tempCodexDir, "config.toml");
  const origConfigToml = join(origCodexDir, "config.toml");
  const sanitizedConfig = getCachedSanitizedConfig(origConfigToml);
  writePrivateCodexFile(
    tempConfigPath,
    stripCodexMcpSectionsForRuntime(sanitizedConfig ?? ""),
  );

  // Match the formal build: Codex reads the provider endpoint from its
  // isolated config in addition to the OPENAI_BASE_URL environment variable.
  if (resolvedBaseUrl) {
    const existing = readFileSync(tempConfigPath, "utf-8").replace(/\r/g, "");
    writePrivateCodexFile(
      tempConfigPath,
      buildCodexBaseUrlToml(resolvedBaseUrl) + existing,
    );
    log(`[config] Injected openai_base_url into config.toml: ${resolvedBaseUrl}`);
  }

  const mcpLauncherPath = join(
    tempCodexDir,
    MCP_RUNTIME_LAUNCHER_FILENAME,
  );
  writePrivateCodexFile(
    mcpLauncherPath,
    MCP_RUNTIME_LAUNCHER_SOURCE,
  );

  // Merge sidecar built-in MCP servers (e.g. openai_images for gpt-image-2)
  // with frontend-configured ones. User overrides take precedence on name
  // collision; both sets are skipped when the same key already exists in the
  // user's ~/.codex/config.toml.
  const builtinMcpServers = isOAuthAuth ? {} : buildBuiltinMcpServers({
    apiKey: resolvedApiKey,
    baseUrl: resolvedBaseUrl,
    proxyUrl: params.proxyUrl,
    imageGenQuality: params.imageGenQuality,
    imageGenSize: params.imageGenSize,
    outputsDir: params.outputsDir,
  });
  const effectiveMcpServers: Record<string, unknown> = {
    ...builtinMcpServers,
    ...(params.mcpServers ?? {}),
  };
  const projectedMcpServers = projectMcpServersForRuntime(
    effectiveMcpServers,
    env,
    mcpLauncherPath,
  );

  // Inject MCP servers (built-in + frontend-configured) into the temp config.toml
  if (Object.keys(projectedMcpServers).length > 0) {
    const existing = readFileSync(tempConfigPath, "utf-8").replace(/\r/g, "");

    const existingServerNames = new Set(
      [...existing.matchAll(/^\[mcp_servers\.(\S+)\]/gm)].map((m) => m[1]),
    );
    const newServers: Record<string, unknown> = {};
    for (const [name, config] of Object.entries(projectedMcpServers)) {
      const safeName = name.replace(/[^a-zA-Z0-9_-]/g, "_");
      if (existingServerNames.has(safeName)) {
        log(`Skipping MCP server "${name}" — already defined in user config.toml`);
      } else {
        newServers[name] = config;
      }
    }

    if (Object.keys(newServers).length > 0) {
      const mcpToml = buildMcpTomlSection(newServers);
      const separator = existing.length === 0 ? "" : existing.endsWith("\n") ? "\n" : "\n\n";
      writePrivateCodexFile(
        tempConfigPath,
        existing + separator + mcpToml + "\n",
      );
      log(`Injected ${Object.keys(newServers).length} MCP server(s) into temp config.toml`);
    }
  }

  // Match the formal build: Codex's built-in OpenAI provider reads API-key
  // authentication from the isolated CODEX_HOME auth projection.
  writeCodexApiKeyAuthFile(tempCodexDir, resolvedApiKey, isOAuthAuth);

  env.CODEX_HOME = tempCodexDir;

  // Build AGENTS.md — uses content cache to skip buildSkillIndex O(N) reads.
  // cavemanMode is part of the cache key so toggling caveman level rebuilds
  // without touching the unrelated skills/AGENTS source mtimes.
  {
    const agentsMd = getCachedAgentsMd(origCodexDir, params.cavemanMode);
    try {
      writePrivateCodexFile(join(tempCodexDir, "AGENTS.md"), agentsMd);
      log(`Wrote AGENTS.md to CODEX_HOME (cavemanMode=${params.cavemanMode ?? "off"})`);
    } catch (err) {
      log(`[warn] Failed to write AGENTS.md: ${err}`);
    }
  }

  log("[codex-home] Isolated Codex config is ready");

  const codexPath = findCodexBinaryPath(params.codexBinaryPath);
  if (!codexPath) {
    throw new Error(
      "Codex CLI is not installed. Install it locally, add it to PATH, or set CODEX_CLI_PATH.",
    );
  }
  const codexVersion = probeCodexVersion(codexPath) ?? getCodexVersion();

  // Diagnostic: verify the binary file
  try {
    const st = statSync(codexPath);
    log(`[binary-diag] path=${codexPath} size=${st.size} mode=${st.mode.toString(8)}`);
  } catch (statErr) {
    log(`[binary-diag] path=${codexPath} stat failed: ${statErr}`);
  }

  // Build spawn args
  const spawnArgs = [
    "app-server",
    ...buildCodexProviderSpawnArgs(isOAuthAuth, resolvedBaseUrl),
  ];
  spawnArgs.push("-c", "features.enable_request_compression=false");
  spawnArgs.push(...buildCodexCommunityConfigArgs());
  if (params.goalModeEnabled === true) {
    spawnArgs.push("--enable", "goals");
  }

  log(`[prewarm/spawn] baseUrl=${formatBaseUrlForLog(resolvedBaseUrl)} proxy=${formatProxyForLog(params.proxyUrl)} v=${codexVersion} goals=${params.goalModeEnabled === true}`);

  // Diagnostic
  const envOpenaiKeys = Object.keys(env).filter(k => k.startsWith("OPENAI_"));
  log(`[env-diag] OPENAI_* vars: ${envOpenaiKeys.map(k => `${k}=${env[k] ? "(set)" : "(empty)"}`).join(", ") || "(none)"}`);
  log(
    `[env-diag] CODEX_HOME=(isolated), HOME=${env.HOME ? "(set)" : "(empty)"}, ` +
    `USERPROFILE=${env.USERPROFILE ? "(set)" : "(empty)"}`,
  );

  // Spawn the App Server process
    rpc = new CodexRpcChannel(
      codexPath,
      spawnArgs,
      env,
      () => {
        cleanupBytroCodexRuntimeProjection(
          tempHome,
          tempCodexDir,
          false,
        );
      },
    );

    const connectionStart = Date.now();
    log(`[init] Sending initialize request...`);
    await rpc.request("initialize", {
      clientInfo: {
        name: "bytro-community-sidecar",
        version: codexVersion ?? "0.0.0",
      },
      capabilities: {
        experimentalApi: true,
      },
    }, 60_000);
    log(`[init] initialize succeeded in ${Date.now() - connectionStart}ms`);
    rpc.notify("initialized");

    return { rpc, tempHome, isPersistentHome };
  } catch (err) {
    const safeMessage = summarizeDiagnosticText(
      err instanceof Error ? err.message : String(err),
      "codex.setup_error",
    );
    log(`[init-error] spawnAndInitializeRpc failed: ${safeMessage}`);
    if (rpc) {
      await rpc.close().catch(() => undefined);
    } else {
      cleanupBytroCodexRuntimeProjection(
        tempHome,
        tempCodexDir,
        !isOAuthAuth,
      );
    }
    if (!isPersistentHome) {
      rmSync(tempHome, { recursive: true, force: true });
    }
    _activeCodexHomes.delete(tempHome);
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Codex account auth — delegates ChatGPT login to Codex App Server
// ---------------------------------------------------------------------------

interface CodexRateLimitWindow {
  readonly usedPercent: number;
  readonly windowDurationMins: number | null;
  readonly resetsAt: number | null;
}

interface CodexRateLimits {
  readonly primary?: CodexRateLimitWindow;
  readonly secondary?: CodexRateLimitWindow;
}

interface CodexAuthAccount {
  readonly email?: string;
  readonly planType?: string;
  readonly requiresOpenaiAuth?: boolean;
  readonly rateLimits?: CodexRateLimits;
}

interface CodexAuthSetup {
  readonly rpc: CodexRpcChannel;
  readonly tempHome: string;
}

interface PendingCodexAuth {
  readonly rpc: CodexRpcChannel;
  readonly markCancelled: () => void;
  readonly finishCancelled: () => void;
}

const pendingCodexAuth = new Map<string, PendingCodexAuth>();
const CODEX_AUTH_TIMEOUT_MS = 10 * 60 * 1000;

function rateLimitWindowFromValue(value: unknown): CodexRateLimitWindow | undefined {
  if (!value || typeof value !== "object") return undefined;
  const windowValue = value as Record<string, unknown>;
  if (typeof windowValue.usedPercent !== "number") return undefined;
  return {
    usedPercent: windowValue.usedPercent,
    windowDurationMins: typeof windowValue.windowDurationMins === "number" ? windowValue.windowDurationMins : null,
    resetsAt: typeof windowValue.resetsAt === "number" ? windowValue.resetsAt : null,
  };
}

function rateLimitsFromResponse(response: unknown): CodexRateLimits | undefined {
  const value = response && typeof response === "object" ? response as Record<string, unknown> : {};
  const byLimitId = value.rateLimitsByLimitId && typeof value.rateLimitsByLimitId === "object"
    ? value.rateLimitsByLimitId as Record<string, unknown>
    : null;
  const snapshotValue = byLimitId?.codex ?? value.rateLimits;
  if (!snapshotValue || typeof snapshotValue !== "object") return undefined;
  const snapshot = snapshotValue as Record<string, unknown>;
  const primary = rateLimitWindowFromValue(snapshot.primary);
  const secondary = rateLimitWindowFromValue(snapshot.secondary);
  if (!primary && !secondary) return undefined;
  return { primary, secondary };
}

function accountFromResponse(response: unknown): CodexAuthAccount {
  const value = response && typeof response === "object" ? response as Record<string, unknown> : {};
  const account = value.account && typeof value.account === "object" ? value.account as Record<string, unknown> : null;
  const requiresOpenaiAuth = typeof value.requiresOpenaiAuth === "boolean" ? value.requiresOpenaiAuth : undefined;
  if (account?.type === "chatgpt") {
    return {
      email: typeof account.email === "string" ? account.email : undefined,
      planType: typeof account.planType === "string" ? account.planType : undefined,
      requiresOpenaiAuth,
    };
  }
  return { requiresOpenaiAuth };
}

async function spawnCodexAuthRpc(cmd: { profileId: string; codexBinaryPath?: string }): Promise<CodexAuthSetup> {
  const setup = await spawnAndInitializeRpc({
    apiKey: "",
    authMode: "oauth",
    profileId: cmd.profileId,
    codexBinaryPath: cmd.codexBinaryPath,
  });
  return { rpc: setup.rpc, tempHome: setup.tempHome };
}

function emitCodexAuthCompleted(emit: EmitFn, id: string, profileId: string, account: CodexAuthAccount): void {
  emit({
    evt: "codex_auth_completed",
    id,
    profileId,
    ...(account.email ? { email: account.email } : {}),
    ...(account.planType ? { planType: account.planType } : {}),
    ...(typeof account.requiresOpenaiAuth === "boolean" ? { requiresOpenaiAuth: account.requiresOpenaiAuth } : {}),
    ...(account.rateLimits ? { rateLimits: account.rateLimits } : {}),
  });
}

function formatStatusValue(value: unknown): string {
  if (value === null || value === undefined) return "unknown";
  if (typeof value === "string") return value || "unknown";
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return JSON.stringify(value);
}

function formatRateLimitWindow(label: string, value: unknown): string | null {
  if (!value || typeof value !== "object") return null;
  const windowValue = value as Record<string, unknown>;
  if (typeof windowValue.usedPercent !== "number") return null;
  const reset = typeof windowValue.resetsAt === "number"
    ? new Date(windowValue.resetsAt * 1000).toLocaleString()
    : "unknown";
  const duration = typeof windowValue.windowDurationMins === "number"
    ? `${windowValue.windowDurationMins}m`
    : "unknown";
  return `- ${label}: ${windowValue.usedPercent.toFixed(1)}% used, window ${duration}, resets ${reset}`;
}

function statusRpcError(label: string, value: unknown): string | null {
  if (!value || typeof value !== "object") return null;
  const error = (value as Record<string, unknown>).error;
  return typeof error === "string" && error
    ? `- ${label}: ${publicSidecarErrorMessage(error)}`
    : null;
}

function formatCodexStatusMarkdown(params: {
  readonly threadId: string;
  readonly model: string;
  readonly cwd?: string;
  readonly permissionMode?: string;
  readonly reasoningLevel?: string;
  readonly threadResponse?: unknown;
  readonly accountResponse?: unknown;
  readonly rateLimitsResponse?: unknown;
  readonly mcpStatusResponse?: unknown;
  readonly modelListResponse?: unknown;
}): string {
  const thread = params.threadResponse && typeof params.threadResponse === "object"
    ? (params.threadResponse as Record<string, unknown>).thread as Record<string, unknown> | undefined
    : undefined;
  const account = accountFromResponse(params.accountResponse);
  const rateLimits = rateLimitsFromResponse(params.rateLimitsResponse);
  const mcpData = params.mcpStatusResponse && typeof params.mcpStatusResponse === "object"
    ? (params.mcpStatusResponse as Record<string, unknown>).data
    : undefined;
  const mcpServers = Array.isArray(mcpData) ? mcpData as ReadonlyArray<Record<string, unknown>> : [];
  const modelData = params.modelListResponse && typeof params.modelListResponse === "object"
    ? (params.modelListResponse as Record<string, unknown>).data
    : undefined;
  const models = Array.isArray(modelData) ? modelData as ReadonlyArray<Record<string, unknown>> : [];
  const activeModel = models.find((model) => model.model === params.model || model.id === params.model);

  const gitInfo = thread?.gitInfo && typeof thread.gitInfo === "object"
    ? thread.gitInfo as Record<string, unknown>
    : null;
  const threadStatus = thread?.status && typeof thread.status === "object"
    ? (thread.status as Record<string, unknown>).type
    : undefined;

  const lines = [
    "## Codex Status",
    "",
    `- Thread: ${params.threadId}`,
    `- Runtime: ${formatStatusValue(threadStatus)}`,
    `- Model: ${activeModel?.displayName ? `${activeModel.displayName} (${params.model})` : params.model}`,
    `- CWD: ${thread?.cwd ? formatStatusValue(thread.cwd) : (params.cwd || "unknown")}`,
    `- Permission mode: ${params.permissionMode || "unknown"}`,
    `- Reasoning: ${params.reasoningLevel || "off"}`,
    `- Auth: ${account.email ? `${account.email}${account.planType ? ` (${account.planType})` : ""}` : account.requiresOpenaiAuth ? "OpenAI auth required" : "API key"}`,
  ];

  if (gitInfo) {
    lines.push(
      "",
      "### Git",
      `- Branch: ${formatStatusValue(gitInfo.branch)}`,
      `- SHA: ${formatStatusValue(gitInfo.sha)}`,
      `- Origin: ${formatStatusValue(gitInfo.originUrl)}`,
    );
  }

  const primaryRate = formatRateLimitWindow("Primary", rateLimits?.primary);
  const secondaryRate = formatRateLimitWindow("Secondary", rateLimits?.secondary);
  if (primaryRate || secondaryRate) {
    lines.push("", "### Rate Limits");
    if (primaryRate) lines.push(primaryRate);
    if (secondaryRate) lines.push(secondaryRate);
  }

  lines.push(
    "",
    "### MCP",
    mcpServers.length > 0
      ? `- Servers: ${mcpServers.map((server) => formatStatusValue(server.name)).join(", ")}`
      : "- Servers: none",
  );

  const rpcErrors = [
    statusRpcError("thread/read", params.threadResponse),
    statusRpcError("account/read", params.accountResponse),
    statusRpcError("account/rateLimits/read", params.rateLimitsResponse),
    statusRpcError("mcpServerStatus/list", params.mcpStatusResponse),
    statusRpcError("model/list", params.modelListResponse),
  ].filter((line): line is string => !!line);
  if (rpcErrors.length > 0) {
    lines.push("", "### RPC Errors", ...rpcErrors);
  }

  return lines.join("\n");
}

async function executeStatusSlashCommand(
  rpc: CodexRpcChannel,
  state: TurnState,
  emit: EmitFn,
  cmd: QueryCommand,
  threadId: string,
  resolvedModel: string,
  reasoningLevel?: string,
): Promise<void> {
  log(`[slash-status] fetching native Codex status via RPC: threadId=${threadId}`);
  const [threadResponse, accountResponse, rateLimitsResponse, mcpStatusResponse, modelListResponse] = await Promise.all([
    rpc.request("thread/read", { threadId, includeTurns: false }, 30_000).catch((err) => {
      log(`[slash-status] thread/read failed: ${String(err)}`);
      return { error: publicSidecarErrorMessage(err) };
    }),
    rpc.request("account/read", { refreshToken: false }, 30_000).catch((err) => {
      log(`[slash-status] account/read failed: ${String(err)}`);
      return { error: publicSidecarErrorMessage(err) };
    }),
    rpc.request("account/rateLimits/read", undefined, 30_000).catch((err) => {
      log(`[slash-status] account/rateLimits/read failed: ${String(err)}`);
      return { error: publicSidecarErrorMessage(err) };
    }),
    rpc.request("mcpServerStatus/list", { detail: "toolsAndAuthOnly" }, 30_000).catch((err) => {
      log(`[slash-status] mcpServerStatus/list failed: ${String(err)}`);
      return { error: publicSidecarErrorMessage(err) };
    }),
    rpc.request("model/list", { includeHidden: false }, 30_000).catch((err) => {
      log(`[slash-status] model/list failed: ${String(err)}`);
      return { error: publicSidecarErrorMessage(err) };
    }),
  ]);

  state.fullText = formatCodexStatusMarkdown({
    threadId,
    model: resolvedModel,
    cwd: cmd.cwd,
    permissionMode: cmd.permissionMode,
    reasoningLevel,
    threadResponse,
    accountResponse,
    rateLimitsResponse,
    mcpStatusResponse,
    modelListResponse,
  });
  emit({ evt: "text_delta", id: state.activeRequestId, delta: state.fullText });
}

export async function handleCodexAuthRead(cmd: CodexAuthReadCommand, emit: EmitFn): Promise<void> {
  let rpc: CodexRpcChannel | null = null;
  try {
    const setup = await spawnCodexAuthRpc(cmd);
    rpc = setup.rpc;
    const response = await rpc.request("account/read", { refreshToken: cmd.refreshToken === true }, 30_000);
    const rateLimitsResponse = await rpc.request("account/rateLimits/read", undefined, 30_000).catch(() => null);
    emitCodexAuthCompleted(emit, cmd.id, cmd.profileId, {
      ...accountFromResponse(response),
      rateLimits: rateLimitsFromResponse(rateLimitsResponse),
    });
  } catch (err) {
    log(`[codex-auth] account read failed: ${String(err)}`);
    emit({
      evt: "codex_auth_error",
      id: cmd.id,
      profileId: cmd.profileId,
      error: publicSidecarErrorMessage(err),
    });
  } finally {
    await rpc?.close().catch(() => {});
  }
}

export async function handleCodexAuthStart(cmd: CodexAuthStartCommand, emit: EmitFn): Promise<void> {
  let rpc: CodexRpcChannel | null = null;
  let loginId: string | null = null;
  try {
    const setup = await spawnCodexAuthRpc(cmd);
    rpc = setup.rpc;
    const response = await rpc.request("account/login/start", { type: "chatgpt", codexStreamlinedLogin: true }, 30_000) as Record<string, unknown>;
    if (response.type !== "chatgpt" && response.type !== "chatgptDeviceCode") {
      log(`[codex-auth] unsupported login response: ${JSON.stringify(response)}`);
      throw new Error("Codex login returned an unsupported response");
    }
    loginId = typeof response.loginId === "string" ? response.loginId : null;
    if (!loginId) throw new Error("Codex login response missing loginId");
    let wasCancelled = false;
    let resolveCancelled: (() => void) | null = null;
    const cancelled = new Promise<void>((resolve) => {
      resolveCancelled = resolve;
    });
    pendingCodexAuth.set(loginId, {
      rpc,
      markCancelled: () => {
        wasCancelled = true;
      },
      finishCancelled: () => resolveCancelled?.(),
    });
    emit({
      evt: "codex_auth_started",
      id: cmd.id,
      profileId: cmd.profileId,
      loginId,
      ...(typeof response.authUrl === "string" ? { authUrl: response.authUrl } : {}),
      ...(typeof response.verificationUrl === "string" ? { verificationUrl: response.verificationUrl } : {}),
      ...(typeof response.userCode === "string" ? { userCode: response.userCode } : {}),
    });

    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Codex login timed out. Please restart sign-in.")), CODEX_AUTH_TIMEOUT_MS);
      const unsubscribe = rpc!.onNotification((method, params) => {
        if (method !== "account/login/completed") return;
        if (typeof params.loginId === "string" && params.loginId !== loginId) return;
        clearTimeout(timer);
        unsubscribe();
        if (params.success === true) {
          resolve();
        } else {
          reject(new Error(typeof params.error === "string" && params.error ? params.error : "Codex login failed"));
        }
      });
      cancelled.then(() => {
        clearTimeout(timer);
        unsubscribe();
        resolve();
      });
    });

    if (wasCancelled) return;

    const accountResponse = await rpc.request("account/read", { refreshToken: true }, 30_000);
    const rateLimitsResponse = await rpc.request("account/rateLimits/read", undefined, 30_000).catch(() => null);
    emitCodexAuthCompleted(emit, cmd.id, cmd.profileId, {
      ...accountFromResponse(accountResponse),
      rateLimits: rateLimitsFromResponse(rateLimitsResponse),
    });
  } catch (err) {
    log(`[codex-auth] sign-in failed: ${String(err)}`);
    emit({
      evt: "codex_auth_error",
      id: cmd.id,
      profileId: cmd.profileId,
      error: publicSidecarErrorMessage(err),
    });
  } finally {
    if (loginId) pendingCodexAuth.delete(loginId);
    await rpc?.close().catch(() => {});
  }
}

export async function handleCodexAuthCancel(cmd: CodexAuthCancelCommand): Promise<void> {
  const pending = pendingCodexAuth.get(cmd.loginId);
  if (pending) {
    pendingCodexAuth.delete(cmd.loginId);
    pending.markCancelled();
    try {
      await pending.rpc.request("account/login/cancel", { loginId: cmd.loginId }, 10_000);
    } catch { /* best-effort */ }
    pending.finishCancelled();
    await pending.rpc.close().catch(() => {});
  }
}

export async function handleCodexAuthSignOut(cmd: CodexAuthSignOutCommand, emit: EmitFn): Promise<void> {
  let rpc: CodexRpcChannel | null = null;
  try {
    const setup = await spawnCodexAuthRpc(cmd);
    rpc = setup.rpc;
    await rpc.request("account/logout", undefined, 30_000);
    closePrewarmedChannel();
    killWarmSessionsForAgent("codex");
    emit({ evt: "codex_auth_signed_out", id: cmd.id, profileId: cmd.profileId });
  } catch (err) {
    log(`[codex-auth] sign-out failed: ${String(err)}`);
    emit({
      evt: "codex_auth_error",
      id: cmd.id,
      profileId: cmd.profileId,
      error: publicSidecarErrorMessage(err),
    });
  } finally {
    await rpc?.close().catch(() => {});
  }
}

// ---------------------------------------------------------------------------
// Codex prewarming — pre-spawn + initialize RPC before first query
// ---------------------------------------------------------------------------

interface PrewarmedChannel {
  rpc: CodexRpcChannel;
  tempHome: string;
  createdAt: number;
  /** In-memory digest used only to match a prewarmed process to its credential. */
  apiKeyDigest: string;
  baseUrl: string;
  proxyUrl: string;
  authMode: AuthMode;
  profileId: string;
  /** Quality default baked into the openai_images MCP env at prewarm time. */
  imageGenQuality: string;
  /** Size tier default baked into the openai_images MCP env at prewarm time. */
  imageGenSize: string;
  /** OPENAI_IMAGES_OUT baked into the MCP env at prewarm time. Empty string =
   *  no override (the MCP server falls back to its tmpdir default). */
  outputsDir: string;
  /** Service tier applied when the thread/turn starts. Empty string = default. */
  serviceTier: string;
  /** Whether the App Server process was spawned with the goals feature enabled. */
  goalModeEnabled: boolean;
  /** Caveman mode baked into AGENTS.md at prewarm time. The AGENTS.md file is
   *  written once into the tempHome and read by the Codex binary at startup;
   *  later toggling caveman level requires invalidating the channel because
   *  rewriting AGENTS.md mid-flight does not affect an already-running App
   *  Server. Empty string = "off" (no caveman addendum baked). */
  cavemanMode: string;
  isPersistentHome: boolean;
}

let _prewarmedChannel: PrewarmedChannel | null = null;
let _prewarmTimer: ReturnType<typeof setTimeout> | null = null;
const PREWARM_MAX_AGE_MS = 5 * 60 * 1000; // 5 minutes

function credentialDigest(apiKey: string): string {
  return createHash("sha256").update(apiKey).digest("hex");
}

/**
 * Atomically consume the prewarmed channel if it matches the current request.
 * Returns null if no valid prewarmed channel is available.
 */
function consumePrewarmedChannel(apiKey: string, baseUrl: string, authMode: AuthMode, profileId: string, proxyUrl?: string, imageGenQuality?: string, imageGenSize?: string, outputsDir?: string, cavemanMode?: string, serviceTier?: string, goalModeEnabled?: boolean): PrewarmedChannel | null {
  const pw = _prewarmedChannel;
  if (!pw) return null;

  // Atomically take it so no other call can consume it
  _prewarmedChannel = null;
  if (_prewarmTimer) {
    clearTimeout(_prewarmTimer);
    _prewarmTimer = null;
  }

  const cleanupPrewarmHome = () => {
    if (!pw.isPersistentHome) {
      rmSync(pw.tempHome, { recursive: true, force: true });
    }
    _activeCodexHomes.delete(pw.tempHome);
  };

  // Validate: alive, not stale, credentials match
  if (!pw.rpc.alive) {
    log("[prewarm] Discarding prewarmed channel — process is dead");
    cleanupPrewarmHome();
    return null;
  }
  if (Date.now() - pw.createdAt > PREWARM_MAX_AGE_MS) {
    log("[prewarm] Discarding prewarmed channel — expired");
    pw.rpc.close().catch(() => {});
    cleanupPrewarmHome();
    return null;
  }
  if (pw.authMode !== authMode || pw.profileId !== profileId || pw.apiKeyDigest !== credentialDigest(apiKey) || pw.baseUrl !== (baseUrl || "") || pw.proxyUrl !== (proxyUrl || "")) {
    log("[prewarm] Discarding prewarmed channel — credentials mismatch");
    pw.rpc.close().catch(() => {});
    cleanupPrewarmHome();
    return null;
  }
  // The openai_images MCP env was baked at prewarm time. If the user changed
  // their preferred quality since then, the prewarm would silently apply the
  // stale default — invalidate so we respawn with the new env.
  const wantedQuality = imageGenQuality ?? "";
  if (pw.imageGenQuality !== wantedQuality) {
    log(`[prewarm] Discarding prewarmed channel — imageGenQuality mismatch (prewarm=${pw.imageGenQuality || "<unset>"} wanted=${wantedQuality || "<unset>"})`);
    pw.rpc.close().catch(() => {});
    cleanupPrewarmHome();
    return null;
  }
  const wantedSizeTier = imageGenSize ?? "";
  if (pw.imageGenSize !== wantedSizeTier) {
    log(`[prewarm] Discarding prewarmed channel — imageGenSize mismatch (prewarm=${pw.imageGenSize || "<unset>"} wanted=${wantedSizeTier || "<unset>"})`);
    pw.rpc.close().catch(() => {});
    cleanupPrewarmHome();
    return null;
  }
  // OPENAI_IMAGES_OUT is fixed at child-process spawn time and cannot be
  // changed without respawning, so a settings change must invalidate prewarm.
  const wantedOutputsDir = outputsDir ?? "";
  if (pw.outputsDir !== wantedOutputsDir) {
    log(`[prewarm] Discarding prewarmed channel — outputsDir mismatch (prewarm=${pw.outputsDir || "<unset>"} wanted=${wantedOutputsDir || "<unset>"})`);
    pw.rpc.close().catch(() => {});
    cleanupPrewarmHome();
    return null;
  }
  const wantedServiceTier = serviceTier ?? "";
  if (pw.serviceTier !== wantedServiceTier) {
    log(`[prewarm] Discarding prewarmed channel — serviceTier mismatch (prewarm=${pw.serviceTier || "<unset>"} wanted=${wantedServiceTier || "<unset>"})`);
    pw.rpc.close().catch(() => {});
    cleanupPrewarmHome();
    return null;
  }
  const wantedGoalModeEnabled = goalModeEnabled === true;
  if (pw.goalModeEnabled !== wantedGoalModeEnabled) {
    log(`[prewarm] Discarding prewarmed channel — goalModeEnabled mismatch (prewarm=${pw.goalModeEnabled} wanted=${wantedGoalModeEnabled})`);
    pw.rpc.close().catch(() => {});
    cleanupPrewarmHome();
    return null;
  }

  // AGENTS.md was rendered with a specific caveman level baked in; the Codex
  // App Server has already read it. Toggling the level after spawn requires a
  // respawn — invalidate so the cold path rebuilds AGENTS.md with the new
  // level. Empty string ≡ "off" ≡ undefined.
  const wantedCavemanMode = (cavemanMode ?? "") === "off" ? "" : (cavemanMode ?? "");
  const bakedCavemanMode = pw.cavemanMode === "off" ? "" : pw.cavemanMode;
  if (bakedCavemanMode !== wantedCavemanMode) {
    log(`[prewarm] Discarding prewarmed channel — cavemanMode mismatch (prewarm=${pw.cavemanMode || "<unset>"} wanted=${wantedCavemanMode || "<unset>"})`);
    pw.rpc.close().catch(() => {});
    cleanupPrewarmHome();
    return null;
  }

  log(`[prewarm] Reusing prewarmed RPC channel (age=${Date.now() - pw.createdAt}ms)`);
  return pw;
}

/** Close and clean up any prewarmed channel. Exported for shutdown + new prewarm. */
export function closePrewarmedChannel(): void {
  const pw = _prewarmedChannel;
  if (!pw) return;
  _prewarmedChannel = null;
  if (_prewarmTimer) {
    clearTimeout(_prewarmTimer);
    _prewarmTimer = null;
  }
  log("[prewarm] Closing prewarmed channel");
  pw.rpc.close().catch(() => {});
  try {
    if (!pw.isPersistentHome) {
      rmSync(pw.tempHome, { recursive: true, force: true });
    }
  } catch { /* best-effort */ }
  _activeCodexHomes.delete(pw.tempHome);
}

// ---------------------------------------------------------------------------
// handleCodexInit — called from index.ts for init_session with platform=codex
// ---------------------------------------------------------------------------

export async function handleCodexInit(
  cmd: InitSessionCommand,
  emit: EmitFn,
): Promise<void> {
  const tag = `[codex-prewarm:${cmd.id}]`;
  log(`${tag} Starting Codex prewarming...`);

  // Fast path 1: an active Codex warm session already exists. The user is
  // switching back to an already-active Codex conversation — its rpc channel
  // is already alive, so spawning a fresh prewarmed channel would only churn
  // processes and temp CODEX_HOME directories. The next query will route to
  // the existing warm session via persistent-session-registry.
  if (hasWarmSessionForAgent("codex")) {
    log(`${tag} Active Codex warm session exists — skip prewarm`);
    emit({ evt: "done", id: cmd.id });
    return;
  }

  // Fast path 2: reuse existing prewarmed channel when it is still alive, not
  // expired, and its credentials match the current request.
  const existing = _prewarmedChannel;
  if (existing) {
    const apiKeyDigest = credentialDigest(cmd.apiKey ?? "");
    const baseUrl = cmd.baseUrl ?? "";
    const proxyUrl = cmd.proxyUrl ?? "";
    const authMode = cmd.authMode ?? "apiKey";
    const profileId = cmd.profileId ?? "";
    const age = Date.now() - existing.createdAt;
    const reusable =
      existing.rpc.alive &&
      age < PREWARM_MAX_AGE_MS &&
      existing.apiKeyDigest === apiKeyDigest &&
      existing.baseUrl === baseUrl &&
      existing.proxyUrl === proxyUrl &&
      existing.authMode === authMode &&
      existing.profileId === profileId;
    if (reusable) {
      log(`${tag} Reusing existing prewarmed channel (age=${age}ms) — skip respawn`);
      emit({ evt: "done", id: cmd.id });
      return;
    }
  }

  // Slow path: close any existing prewarmed channel and rebuild
  closePrewarmedChannel();

  try {
    const setup = await spawnAndInitializeRpc({
      apiKey: cmd.apiKey ?? "",
      baseUrl: cmd.baseUrl,
      proxyUrl: cmd.proxyUrl,
      mcpServers: cmd.mcpServers,
      codexBinaryPath: cmd.codexBinaryPath,
      authMode: cmd.authMode,
      profileId: cmd.profileId,
    });

    _prewarmedChannel = {
      rpc: setup.rpc,
      tempHome: setup.tempHome,
      createdAt: Date.now(),
      apiKeyDigest: credentialDigest(cmd.apiKey ?? ""),
      baseUrl: cmd.baseUrl ?? "",
      proxyUrl: cmd.proxyUrl ?? "",
      authMode: cmd.authMode ?? "apiKey",
      profileId: cmd.profileId ?? "",
      // init_session does not carry imageGenQuality / imageGenSize / outputsDir
      // / cavemanMode / serviceTier — prewarm with defaults. The actual query
      // invalidates this channel when its preferences differ.
      imageGenQuality: "",
      imageGenSize: "",
      outputsDir: "",
      serviceTier: "",
      goalModeEnabled: false,
      cavemanMode: "",
      isPersistentHome: setup.isPersistentHome,
    };

    // Auto-expire after PREWARM_MAX_AGE_MS
    _prewarmTimer = setTimeout(() => {
      closePrewarmedChannel();
    }, PREWARM_MAX_AGE_MS);

    log(`${tag} Codex prewarming complete — channel cached`);
  } catch (err) {
    log(`${tag} Codex prewarming failed (non-fatal): ${err}`);
  }

  // Notify that prewarm command is done (fire-and-forget, no system_init data).
  // Must use the standard sidecar "done" evt name — "chat-done" is the Tauri
  // event name Rust emits to the frontend, not the NDJSON evt name.
  emit({ evt: "done", id: cmd.id });
}

// ---------------------------------------------------------------------------
// Create App Server connection — uses prewarmed channel if available,
// otherwise falls back to cold start. Always creates a thread.
// ---------------------------------------------------------------------------

interface AppServerSetup {
  rpc: CodexRpcChannel;
  threadId: string;
  resolvedModel: string;
  /** Home directory used for isolated config. Temp homes are cleaned up after rpc.close(). */
  tempHome?: string;
  /** True when the thread was resumed from disk (skip sending history). */
  resumed: boolean;
  /** True when using a persistent CODEX_HOME (should NOT be deleted on cleanup). */
  isPersistentHome: boolean;
}

/** Extract the Codex threadId from a sessionId (format: "oai-{threadId}"). */
function extractCodexThreadId(sessionId?: string | null): string | null {
  if (!sessionId?.startsWith("oai-")) return null;
  return sessionId.slice(4);
}

async function createAppServerConnection(cmd: QueryCommand): Promise<AppServerSetup> {
  const resolvedModel = cmd.model || "codex-mini-latest";
  const isDisableTools = cmd.disableTools === true;

  // Check if we can resume an existing thread from disk
  const existingThreadId = extractCodexThreadId(cmd.sessionId);
  const canAttemptResume = !!existingThreadId && !!cmd.conversationId;

  // For resume: always use persistent home (do NOT consume prewarm — it has a temp home without thread data)
  let rpc: CodexRpcChannel;
  let tempHome: string;
  let isPersistentHome = false;

  if (canAttemptResume) {
    // Resume path: spawn with persistent CODEX_HOME so thread data on disk is accessible
    log(`[thread/resume] Attempting resume: threadId=${existingThreadId} conv=${cmd.conversationId}`);
    const setup = await spawnAndInitializeRpc({
      apiKey: cmd.apiKey ?? "",
      baseUrl: cmd.baseUrl,
      proxyUrl: cmd.proxyUrl,
      mcpServers: cmd.mcpServers,
      codexBinaryPath: cmd.codexBinaryPath,
      imageGenQuality: cmd.imageGenQuality,
      imageGenSize: cmd.imageGenSize,
      outputsDir: cmd.outputsDir,
      conversationId: cmd.conversationId,
      goalModeEnabled: cmd.goalModeEnabled,
      cavemanMode: cmd.cavemanMode,
      authMode: cmd.authMode,
      profileId: cmd.profileId,
    });
    rpc = setup.rpc;
    tempHome = setup.tempHome;
    isPersistentHome = setup.isPersistentHome;
  } else {
    // New thread path: try prewarmed channel, fall back to cold start
    const prewarmed = consumePrewarmedChannel(cmd.apiKey ?? "", cmd.baseUrl ?? "", cmd.authMode ?? "apiKey", cmd.profileId ?? "", cmd.proxyUrl, cmd.imageGenQuality, cmd.imageGenSize, cmd.outputsDir, cmd.cavemanMode, cmd.serviceTier, cmd.goalModeEnabled);
    if (prewarmed) {
      rpc = prewarmed.rpc;
      tempHome = prewarmed.tempHome;
      isPersistentHome = prewarmed.isPersistentHome;
    } else {
      const setup = await spawnAndInitializeRpc({
        apiKey: cmd.apiKey ?? "",
        baseUrl: cmd.baseUrl,
        proxyUrl: cmd.proxyUrl,
        mcpServers: cmd.mcpServers,
        codexBinaryPath: cmd.codexBinaryPath,
        authMode: cmd.authMode,
        profileId: cmd.profileId,
        imageGenQuality: cmd.imageGenQuality,
        imageGenSize: cmd.imageGenSize,
        outputsDir: cmd.outputsDir,
        conversationId: cmd.conversationId,
        goalModeEnabled: cmd.goalModeEnabled,
        cavemanMode: cmd.cavemanMode,
      });
      rpc = setup.rpc;
      tempHome = setup.tempHome;
      isPersistentHome = setup.isPersistentHome;
    }
  }

  // Phase 2: thread/resume or thread/start
  const threadStart = Date.now();
  try {
    const effectiveApprovalPolicy = isDisableTools ? "never" : mapApprovalPolicy(cmd.permissionMode);
    const sandboxMode = isDisableTools
      ? "read-only"
      : mapSandboxMode(cmd.permissionMode);
    const effectiveCwd = cmd.cwd;

    // Attempt thread/resume if we have an existing threadId
    if (canAttemptResume) {
      try {
        log(`[thread/resume] model=${resolvedModel} threadId=${existingThreadId} cwd=${effectiveCwd} sandbox=${sandboxMode}`);
        const resumeResult = await rpc.request("thread/resume", {
          threadId: existingThreadId,
          model: resolvedModel,
          ...(cmd.serviceTier ? { serviceTier: cmd.serviceTier } : {}),
          cwd: effectiveCwd,
          approvalPolicy: effectiveApprovalPolicy,
          sandbox: sandboxMode,
        }, 30_000) as { thread: { id: string } };

        const threadId = resumeResult.thread.id;
        log(`[thread/resume] Success: threadId=${threadId} (${Date.now() - threadStart}ms)`);
        return { rpc, threadId, resolvedModel, tempHome, resumed: true, isPersistentHome };
      } catch (resumeErr) {
        const resumeErrMsg = resumeErr instanceof Error ? resumeErr.message : String(resumeErr);
        log(`[thread/resume] Failed, falling back to thread/start: ${resumeErrMsg}`);
        // Fall through to thread/start
      }
    }

    // thread/start — new thread (or resume fallback)
    log(`[thread/start] model=${resolvedModel} approvalPolicy=${JSON.stringify(effectiveApprovalPolicy)} permissionMode=${cmd.permissionMode} sandbox=${sandboxMode} cwd=${effectiveCwd}`);

    const threadResult = await rpc.request("thread/start", {
      model: resolvedModel,
      ...(cmd.serviceTier ? { serviceTier: cmd.serviceTier } : {}),
      cwd: effectiveCwd,
      approvalPolicy: effectiveApprovalPolicy,
      sandbox: sandboxMode,
      networkAccess: !isDisableTools,
      webSearchMode: isDisableTools ? "disabled" : "live",
    }, 30_000) as { thread: { id: string } };

    const threadId = threadResult.thread.id;
    log(`App Server ready: threadId=${threadId} (thread=${Date.now() - threadStart}ms)`);

    return { rpc, threadId, resolvedModel, tempHome, resumed: false, isPersistentHome };
  } catch (err) {
    const elapsed = Date.now() - threadStart;
    const errMsg = err instanceof Error ? err.message : String(err);
    log(`[init-error] createAppServerConnection failed after ${elapsed}ms: ${errMsg}`);
    await rpc.close();
    if (!isPersistentHome) {
      rmSync(tempHome, { recursive: true, force: true });
    }
    _activeCodexHomes.delete(tempHome);
    throw new Error(`${errMsg} (diagnostic logs: ${getDebugLogPath()})`);
  }
}

// ---------------------------------------------------------------------------
// Execute a single turn with retry logic via App Server JSON-RPC.
// ---------------------------------------------------------------------------

async function executeTurnWithRetry(
  input: Array<{ type: string; text?: string; path?: string }>,
  state: TurnState,
  emit: EmitFn,
  abortController: AbortController,
  resolvedModel: string,
  rpc: CodexRpcChannel,
  threadId: string,
  channel?: CodexSessionChannel,
  collaborationMode?: { mode: "plan" | "default"; settings: { model: string; reasoning_effort: null; developer_instructions: null } },
  effort?: string,
  serviceTier?: string,
  /** When set, send `thread/compact/start` instead of `turn/start`. The progress
   *  is reported through the same `turn/* + item/*` notification stream, so the
   *  surrounding listener / completion logic is reused as-is. */
  compactRequest?: boolean,
  /** When set, route this submit through Codex App Server Goals mode. */
  goalObjective?: string,
): Promise<{ succeeded: boolean }> {
  let succeeded = false;
  let consecutiveFailures = 0;

  // Track listeners across retry iterations to prevent leaks (CRITICAL-2/3)
  let unsubNotification: (() => void) | null = null;
  let activeAbortHandler: (() => void) | null = null;

  const cleanupListeners = () => {
    if (unsubNotification) {
      unsubNotification();
      unsubNotification = null;
    }
    if (activeAbortHandler) {
      abortController.signal.removeEventListener("abort", activeAbortHandler);
      activeAbortHandler = null;
    }
  };

  while (consecutiveFailures < MAX_QUERY_ATTEMPTS) {
    if (abortController.signal.aborted) break;

    try {
      if (consecutiveFailures > 0) {
        const backoffMs = 2_000 * Math.pow(2, consecutiveFailures - 1);

        // Reset per-turn state for retry
        state.fullText = "";
        state.itemToolCallIds.clear();
        state.fileToolEntries.clear();
        state.commandToolEntries.clear();
        state.previousTodos = [];
        state.totalInputTokens = 0;
        state.totalOutputTokens = 0;
        state.lastTurnInputTokens = 0;
        state.lastTurnCacheReadTokens = 0;
        state.sumOutputTokens = 0;

        emit({ evt: "stream_retry", id: state.activeRequestId, attempt: consecutiveFailures, max_attempts: MAX_QUERY_ATTEMPTS, reason: "transient_error" });
        logTurnStateSnapshot("turn_retry_wait", state, {
          failureCount: consecutiveFailures,
          backoffMs,
        });
        await new Promise((r) => setTimeout(r, backoffMs));
      }

      state.turnStartCount += 1;
      state.turnRequestId = state.activeRequestId;
      state.activeTurnId = null;
      state.lastCompletedTurnId = null;
      state.lastNotificationTurnId = null;
      state.lastNotificationThreadId = threadId;
      state.lastSteerRequestId = null;
      state.steerRequestCount = 0;
      state.lastTurnStartInputPreview = stringifyDiagValue(input, 2_000);
      state.lastTurnStartPayloadPreview = null;
      state.lastSteerPayloadPreview = null;
      state.lastToolCallMismatchDiagnostic = null;
      state.lastToolCallMismatchError = null;
      logTurnStateSnapshot("turn_attempt_begin", state, {
        attempt: consecutiveFailures + 1,
        threadId,
        collaborationMode: collaborationMode?.mode ?? "none",
        effort: effort ?? "none",
        inputPreview: JSON.stringify(input).slice(0, 300),
      });

      // Clean up any previous iteration's listeners before creating new ones
      cleanupListeners();

      // TOOL_CALL_MISMATCH recovery: force compaction before retrying to
      // repair broken tool_call/tool_result pairing in the conversation history.
      if (state.needsCompactBeforeRetry) {
        state.needsCompactBeforeRetry = false;
        log(`[retry:MISMATCH_RECOVERY] Forcing thread/compact/start before retry to repair broken tool-call pairing`);
        try {
          await performCompactionForRecovery(rpc, threadId);
          log(`[retry:MISMATCH_RECOVERY] Compaction complete, proceeding with turn/start retry`);
        } catch (compactErr) {
          log(`[retry:MISMATCH_RECOVERY] Compaction failed (${compactErr}), proceeding with turn/start anyway`);
        }
      }

      // Set up notification listener for this turn
      let turnResolved = false;
      const turnCompletionPromise = new Promise<{ succeeded: boolean; completedNormally: boolean }>((resolve) => {
        const safeResolve = (result: { succeeded: boolean; completedNormally: boolean }) => {
          if (turnResolved) return;
          turnResolved = true;
          cleanupListeners();
          resolve(result);
        };

        unsubNotification = rpc.onNotification((method, params) => {
          processTurnNotification(method, params, state, emit, abortController, resolvedModel, (result) => {
            safeResolve(result);
          }, rpc);

          // Track active turn ID so follow-up messages queue until completion
          if (method === "turn/started") {
            const turn = params.turn as { id?: string } | undefined;
            const turnId = turn?.id ?? (params.turnId as string | undefined);
            log(`[steer-setup] turn/started received: turnId=${turnId}, hasChannel=${!!channel}`);
            if (turnId && channel) {
              channel.setTurnActive(true, turnId, async (msg) => {
                // Steer: inject message into active turn
                const nextRequestId = msg.requestId ?? state.activeRequestId;
                const previousRequestId = state.activeRequestId;
                state.steerRequestCount += 1;
                state.lastSteerRequestId = nextRequestId;
                logTurnStateSnapshot("steer_before_request_switch", state, {
                  expectedTurnId: turnId,
                  previousRequestId,
                  nextRequestId,
                  routedFromQuery: msg.routedFromQuery ?? false,
                  contentPreview: msg.content.slice(0, 120),
                });
                emit({ evt: "new_turn", id: nextRequestId, commandName: msg.commandInvocation?.canonicalName });
                emit({ evt: "user_message_uuid", id: nextRequestId, uuid: randomUUID() });
                if (msg.requestId) {
                  state.activeRequestId = msg.requestId;
                }
                const steerPayload = {
                  threadId: threadId,
                  expectedTurnId: turnId,
                  input: buildRpcInput(msg.content),
                };
                state.lastSteerPayloadPreview = stringifyDiagValue(steerPayload, 2_000);
                logTurnStateSnapshot("steer_request_send", state, {
                  expectedTurnId: turnId,
                  payloadPreview: JSON.stringify(steerPayload).slice(0, 300),
                });
                await rpc.request("turn/steer", steerPayload);
                logTurnStateSnapshot("steer_request_ack", state, {
                  expectedTurnId: turnId,
                });
              });
            }
          }
        });

        // If abort happens while waiting, resolve immediately
        activeAbortHandler = () => {
          // Send turn/interrupt to the App Server
          rpc.request("turn/interrupt", {
            threadId: threadId,
          }).catch(() => { /* best-effort */ });
          safeResolve({ succeeded: false, completedNormally: true });
        };
        if (abortController.signal.aborted) {
          activeAbortHandler();
        } else {
          abortController.signal.addEventListener("abort", activeAbortHandler, { once: true });
        }
      });

      // Send turn/start, thread/compact/start, or the goals activation RPC.
      // Each path drives the same turn/* + item/* notification stream, so the
      // completion logic below works for all of them.
      const tStreamStart = Date.now();
      if (compactRequest) {
        const compactPayload = { threadId };
        state.lastTurnStartPayloadPreview = stringifyDiagValue({
          method: "thread/compact/start",
          params: compactPayload,
        }, 2_000);
        log(`[thread/compact/start] sending: threadId=${threadId}`);
        logTurnStateSnapshot("compact_start_send", state, {
          threadId,
          payloadPreview: JSON.stringify(compactPayload).slice(0, 200),
        });
        await rpc.request("thread/compact/start", compactPayload);
        log(`[timing] thread/compact/start responded in ${Date.now() - tStreamStart}ms`);
      } else if (goalObjective?.trim()) {
        const objective = goalObjective.trim();
        const goalSetPayload = { threadId, objective };
        state.lastTurnStartPayloadPreview = stringifyDiagValue({
          method: "thread/goal/set",
          params: goalSetPayload,
        }, 2_000);
        log(`[goal-mode] setting thread goal: threadId=${threadId} objectiveLen=${objective.length} objective=${JSON.stringify(objective).slice(0, 500)}`);
        logTurnStateSnapshot("goal_set_send", state, {
          threadId,
          objectivePreview: objective.slice(0, 300),
        });
        const goalSetResult = await rpc.request("thread/goal/set", goalSetPayload, 30_000) as { goal?: { status?: string; objective?: string } };
        log(`[goal-mode] thread goal set: threadId=${threadId} status=${goalSetResult.goal?.status ?? "unknown"} objectiveLen=${goalSetResult.goal?.objective?.length ?? objective.length}`);
        emitGoalUpdated(emit, state, threadId, goalSetResult, "thread/goal/set");

        const goalActivatePayload = { threadId, status: "active" };
        state.lastTurnStartPayloadPreview = stringifyDiagValue({
          method: "thread/goal/set",
          params: goalActivatePayload,
        }, 2_000);
        log(`[goal-mode] activating thread goal: threadId=${threadId}`);
        logTurnStateSnapshot("goal_activate_send", state, {
          threadId,
          payloadPreview: JSON.stringify(goalActivatePayload),
        });
        const goalActivateResult = await rpc.request("thread/goal/set", goalActivatePayload, 30_000) as { goal?: { status?: string } };
        log(`[goal-mode] thread goal activate response: threadId=${threadId} status=${goalActivateResult.goal?.status ?? "unknown"}`);
        emitGoalUpdated(emit, state, threadId, { goal: { objective, ...goalActivateResult.goal } }, "thread/goal/set");
        log(`[timing] thread/goal/set active responded in ${Date.now() - tStreamStart}ms`);
      } else {
        const turnStartPayload = {
          threadId: threadId,
          input,
          ...(collaborationMode ? { collaborationMode } : {}),
          ...(effort ? { effort } : {}),
          ...(serviceTier ? { serviceTier } : {}),
          summary: "detailed" as const,
        };
        state.lastTurnStartPayloadPreview = stringifyDiagValue({
          method: "turn/start",
          params: turnStartPayload,
        }, 2_000);
        log(`[turn/start] sending: threadId=${threadId} collaborationMode=${JSON.stringify(collaborationMode)} effort=${effort} serviceTier=${serviceTier ?? "none"} inputLen=${JSON.stringify(input).length} input=${JSON.stringify(input).slice(0, 500)}`);
        logTurnStateSnapshot("turn_start_send", state, {
          threadId,
          payloadPreview: JSON.stringify(turnStartPayload).slice(0, 400),
        });
        await rpc.request("turn/start", turnStartPayload);
        log(`[timing] turn/start responded in ${Date.now() - tStreamStart}ms`);
      }

      // Wait for turn completion via notifications
      const tProcess = Date.now();
      const result = await turnCompletionPromise;
      if (goalObjective?.trim() && result.completedNormally) {
        await refreshGoalSnapshotIfSupported(rpc, threadId, state, emit, "turn_complete");
      }

      // Deactivate steer after turn completes
      log(`[steer-setup] turn completed, deactivating steer. hasChannel=${!!channel}`);
      if (channel) {
        channel.setTurnActive(false);
      }

      const elapsed = Date.now() - tProcess;
      log(`[timing] Turn completed in ${elapsed}ms — succeeded=${result.succeeded}, completedNormally=${result.completedNormally}, fullTextLen=${state.fullText.length}`);
      logTurnStateSnapshot("turn_attempt_complete", state, {
        elapsedMs: elapsed,
        succeeded: result.succeeded,
        completedNormally: result.completedNormally,
      });
      succeeded = result.succeeded;

      if (!result.completedNormally && !abortController.signal.aborted) {
        // Only reset failure counter if the turn actually produced output.
        // The App Server does its own internal retries (5x), which burns
        // time but produces no text — that does NOT count as progress.
        if (elapsed > 5_000 && state.fullText.length > 0) {
          log(`[retry] Turn made real progress (${elapsed}ms, ${state.fullText.length} chars) before failing, resetting failure counter`);
          consecutiveFailures = 0;
        }
        consecutiveFailures++;
        if (consecutiveFailures < MAX_QUERY_ATTEMPTS) {
          log(`Turn ended abnormally (failure ${consecutiveFailures}/${MAX_QUERY_ATTEMPTS}), will retry`);
          continue;
        }
        log(`Turn ended abnormally on final attempt (failure ${consecutiveFailures}/${MAX_QUERY_ATTEMPTS}), giving up`);
        if (!abortController.signal.aborted) {
          emit({ evt: "error", id: state.activeRequestId, error: "Codex task ended unexpectedly without completion." });
        }
      }
      break;
    } catch (err) {
      // Clean up listeners on error
      cleanupListeners();

      // Deactivate steer on error
      if (channel) {
        channel.setTurnActive(false);
      }

      if (abortController.signal.aborted) break;
      consecutiveFailures++;
      if (consecutiveFailures < MAX_QUERY_ATTEMPTS && isTransientError(err)) {
        log(`Transient error (failure ${consecutiveFailures}): ${err}`);
        logTurnStateSnapshot("turn_attempt_transient_error", state, {
          failureCount: consecutiveFailures,
          error: err instanceof Error ? err.message : String(err),
        });
        continue;
      }
      logTurnStateSnapshot("turn_attempt_fatal_error", state, {
        failureCount: consecutiveFailures,
        error: err instanceof Error ? err.message : String(err),
      });
      throw err;
    }
  }

  // Final cleanup in case loop exits without resolving
  cleanupListeners();
  // Clear the compact trigger marker once the turn (success / fail / abort)
  // has fully unwound — see contextCompaction handler comment.
  state.pendingCompactTrigger = null;

  return { succeeded };
}

// ---------------------------------------------------------------------------
// Emit the final usage event for a completed turn.
// ---------------------------------------------------------------------------

function emitTurnUsageAndDone(
  state: TurnState,
  emit: EmitFn,
  resolvedModel: string,
  succeeded: boolean,
  sessionAlive: boolean,
  conversationId: string | undefined,
): void {
  if (state.lastTurnInputTokens > 0 || state.sumOutputTokens > 0) {
    const nonCachedInput = Math.max(0, state.lastTurnInputTokens - state.lastTurnCacheReadTokens);
    emit({
      evt: "usage",
      id: state.activeRequestId,
      inputTokens: nonCachedInput,
      outputTokens: state.sumOutputTokens,
      cacheReadTokens: state.lastTurnCacheReadTokens,
      cacheCreationTokens: 0,
      totalCostUsd: 0,
      contextWindow: getContextWindowForModel(resolvedModel),
      model: resolvedModel,
    });
  }

  if (succeeded) {
    emit({ evt: "complete", id: state.activeRequestId, fullText: state.fullText });
    // Mirror Claude SDK's Stop hook — the live-reviewer listens for this to
    // flush its per-turn file buffer into a single PR-style batched review.
    // Without this emit, the live reviewer is silent for codex turns: file
    // edits get buffered but no flush trigger ever fires (TURN scope is the
    // dominant trigger; MILESTONE only fires when the agent uses TodoWrite).
    const trimmed = state.fullText.trim();
    emit({
      evt: "turn_finished",
      id: state.activeRequestId,
      lastAssistantMessage: trimmed.length > 0 ? trimmed : null,
    });
  }
  emit({
    evt: "done",
    id: state.activeRequestId,
    ...(sessionAlive ? { sessionAlive: true, conversationId } : {}),
  });
}

// ---------------------------------------------------------------------------
// Reset per-turn state fields — used between turns in warm session loop.
// ---------------------------------------------------------------------------

function resetTurnState(state: TurnState): void {
  logTurnStateSnapshot("reset_turn_state_before", state);
  state.fullText = "";
  state.sessionEmitted = false;
  state.itemToolCallIds.clear();
  state.fileToolEntries.clear();
  state.commandToolEntries.clear();
  state.approvalItemIds.clear();
  state._lastPlanExplanation = "";
  state.planReceivedThisTurn = false;
  state.planContent = "";
  state.pendingCompactTrigger = null;
  state.totalInputTokens = 0;
  state.totalOutputTokens = 0;
  state.lastTurnInputTokens = 0;
  state.lastTurnCacheReadTokens = 0;
  state.sumOutputTokens = 0;
  state.turnRequestId = state.activeRequestId;
  state.activeTurnId = null;
  state.lastCompletedTurnId = null;
  state.lastNotificationTurnId = null;
  state.lastNotificationThreadId = null;
  state.lastSteerRequestId = null;
  state.steerRequestCount = 0;
  state.lastTurnStartInputPreview = null;
  state.lastTurnStartPayloadPreview = null;
  state.lastSteerPayloadPreview = null;
  state.lastToolCallMismatchDiagnostic = null;
  state.lastToolCallMismatchError = null;
  state.needsCompactBeforeRetry = false;
  state.toolCallMismatchRecoveryAttempted = false;
  // Note: previousTodos is NOT reset — carry across turns for diff computation
  logTurnStateSnapshot("reset_turn_state_after", state);
}

// ---------------------------------------------------------------------------
// Main entry point — supports both single-turn and warm-session modes.
// ---------------------------------------------------------------------------

export async function handleOpenAIQuery(
  cmd: QueryCommand,
  emit: EmitFn,
  activeAbortControllers: Map<string, AbortController>,
): Promise<void> {
  const { id, conversationId } = cmd;
  // Session-level abort — only triggered by killWarmSession() for true shutdown
  // (timeout, conversation deleted, metadata mismatch). NOT for user "stop" action.
  const sessionAbort = new AbortController();
  // Per-turn abort for the first turn — handleAbort() triggers this to cancel
  // just the current turn while keeping the warm session alive.
  const firstTurnAbort = new AbortController();
  activeAbortControllers.set(id, firstTurnAbort);

  const isPersistent = !!conversationId;
  let _tempHome: string | undefined;
  let _isPersistentHome = false;
  const cleanupTempHome = () => {
    if (_tempHome) {
      _activeCodexHomes.delete(_tempHome);
      // Persistent homes (used for thread/resume) must NOT be deleted — they
      // contain thread data needed for future session restoration.
      if (!_isPersistentHome) {
        try { rmSync(_tempHome, { recursive: true, force: true }); } catch { /* best-effort */ }
      } else {
        log("[codex-home] Preserving isolated persistent home");
      }
      _tempHome = undefined;
    }
  };

  try {
    log(`[query:start] requestId=${id} conversationId=${conversationId ?? "none"} persistent=${!!conversationId} permissionMode=${cmd.permissionMode ?? "none"}`);
    // 1. Create App Server connection (spawn process, initialize, create thread)
    const { rpc, threadId, resolvedModel, tempHome, resumed, isPersistentHome } = await createAppServerConnection(cmd);
    _tempHome = tempHome;
    _isPersistentHome = isPersistentHome;

    // 2. Set up approval request handler (bidirectional JSON-RPC)
    let planApproved = false;
    const pendingApprovals = new Map<string, { rpcId: number; method: string }>();
    const unsubApproval = rpc.onServerRequest((rpcId, method, params) => {
      log(`[server-request] method=${method} rpcId=${rpcId} params=${JSON.stringify(params).slice(0, 300)}`);
      logTurnStateSnapshot("server_request", state, {
        method,
        rpcId,
        paramThreadId: typeof params.threadId === "string" ? params.threadId : "none",
        paramTurnId: typeof params.turnId === "string" ? params.turnId : "none",
        itemId: typeof params.itemId === "string" ? params.itemId : "none",
      });
      if (method === "item/commandExecution/requestApproval" || method === "item/fileChange/requestApproval") {
        // Permission-mode-aware auto-accept logic.
        // Decide based on the actual permission mode (not collab.mode):
        //
        // - bypassPermissions: auto-accept everything
        // - plan / planning / deep: never auto-accept during planning; after
        //   explicit plan approval, execute inside workspace-write
        // - acceptEdits: auto-accept file changes only, prompt for commands
        // - default: prompt for everything (but default doesn't reach here
        //   because its approvalPolicy is "untrusted" / "never")
        const permMode = cmd.permissionMode ?? "";
        if (shouldAutoAcceptCodexApproval(permMode, method, planApproved)) {
          log(`[approval-auto] permMode=${permMode} planApproved=${planApproved} collabMode=${collab?.mode} method=${method}, auto-accepting rpcId=${rpcId}`);
          logTurnStateSnapshot("approval_auto_accept", state, {
            method,
            rpcId,
            permMode,
            itemId: typeof params.itemId === "string" ? params.itemId : "none",
          });
          rpc.respond(rpcId, { decision: "accept" });
          return;
        }
        const confirmId = `cfm-${randomUUID()}`;
        const itemId = params.itemId as string | undefined;
        const command = (params.command ?? params.path ?? "") as string;
        const toolName = method.includes("command") ? "Bash" : "Edit";
        const toolInput = method.includes("command")
          ? JSON.stringify({ command })
          : JSON.stringify({ file_path: command });

        // Reuse existing toolCallId from item/started, or create one and pre-register
        // so item/started can skip emitting a duplicate tool_start.
        let toolCallId: string;
        if (itemId && state.itemToolCallIds.has(itemId)) {
          // item/started already fired — reuse its toolCallId
          toolCallId = state.itemToolCallIds.get(itemId)!;
        } else {
          // Approval came before item/started — create toolCallId and emit tool_start.
          // Mark this itemId so item/started will skip its own tool_start.
          toolCallId = makeToolCallId();
          if (itemId) {
            state.itemToolCallIds.set(itemId, toolCallId);
            state.approvalItemIds.add(itemId);
          }
          emit({
            evt: "tool_start",
            id: state.activeRequestId,
            toolCallId,
            toolName,
            toolInput,
          });
        }

        pendingApprovals.set(confirmId, { rpcId, method });

        // Register with the global pendingConfirmations so that
        // index.ts permission_response routing resolves back to us.
        pendingConfirmations.set(confirmId, {
          resolve: (approved: boolean) => {
            const entry = pendingApprovals.get(confirmId);
            if (entry) {
              pendingApprovals.delete(confirmId);
              // Respond with the correct decision format per Codex App Server schema:
              // - CommandExecutionRequestApprovalResponse: { decision: "accept" | "decline" | ... }
              // - FileChangeRequestApprovalResponse: { decision: "accept" | "decline" | ... }
              const decision = approved ? "accept" : "decline";
              log(`[approval-resolve] confirmId=${confirmId} decision=${decision} rpcId=${entry.rpcId}`);
              logTurnStateSnapshot("approval_resolve", state, {
                confirmId,
                decision,
                rpcId: entry.rpcId,
                method: entry.method,
                itemId: itemId ?? "none",
              });
              rpc.respond(entry.rpcId, { decision });
            } else {
              log(`[approval-resolve] confirmId=${confirmId} NOT FOUND in pendingApprovals`);
              logTurnStateSnapshot("approval_resolve_missing", state, {
                confirmId,
                approved,
              });
            }
          },
        });

        log(`[approval-emit] emitting permission_request: confirmId=${confirmId} toolCallId=${toolCallId} toolName=${toolName} requestId=${state.activeRequestId}`);
        logTurnStateSnapshot("approval_emit", state, {
          confirmId,
          toolCallId,
          toolName,
          itemId: itemId ?? "none",
          method,
        });
        emit({
          evt: "permission_request",
          id: state.activeRequestId,
          confirmId,
          toolCallId,
          toolName,
          toolInput,
        });
      } else if (method === "item/tool/requestUserInput") {
        // Codex asks the user a question (like AskUserQuestion in Claude SDK).
        // Schema: ToolRequestUserInputParams { threadId, turnId, itemId, questions[] }
        // Response: ToolRequestUserInputResponse { answers: { [questionId]: { answers: string[] } } }
        const confirmId = `cfm-${randomUUID()}`;
        const rawQuestions = (params.questions ?? []) as ReadonlyArray<Record<string, unknown>>;

        const questions = rawQuestions.map((q) => ({
          question: typeof q.question === "string" ? q.question : "",
          header: typeof q.header === "string" ? q.header : "",
          options: Array.isArray(q.options)
            ? (q.options as ReadonlyArray<Record<string, unknown>>).map((o) => ({
                label: typeof o.label === "string" ? o.label : "",
                description: typeof o.description === "string" ? o.description : "",
              }))
            : [],
          multiSelect: false,
        }));

        // Build question text → question ID mapping.
        // The frontend returns answers keyed by question TEXT, but the Codex App Server
        // expects answers keyed by question ID.
        const questionTextToId = new Map<string, string>();
        for (const q of rawQuestions) {
          const qText = typeof q.question === "string" ? q.question : "";
          const qId = typeof q.id === "string" ? q.id : qText;
          if (qText) questionTextToId.set(qText, qId);
        }

        // Create a toolCallId for the AskUserQuestion "tool call" display
        const toolCallId = makeToolCallId();

        log(`[requestUserInput] emitting ask_user_question: confirmId=${confirmId} questionCount=${questions.length} questionIds=${[...questionTextToId.values()].join(",")}`);

        // Register with global pendingAskUserQuestions so index.ts routes the response back.
        pendingAskUserQuestions.set(confirmId, {
          resolve: (answers: Record<string, string>) => {
            // Convert frontend answer format { questionText: "label" }
            // to Codex format { answers: { questionId: { answers: ["label"] } } }
            // Key fix: map question TEXT keys back to question IDs
            const codexAnswers: Record<string, { answers: string[] }> = {};
            for (const [key, answer] of Object.entries(answers)) {
              const questionId = questionTextToId.get(key) ?? key;
              codexAnswers[questionId] = { answers: [answer] };
            }
            log(`[requestUserInput-resolve] confirmId=${confirmId} answers=${JSON.stringify(codexAnswers).slice(0, 200)}`);
            logTurnStateSnapshot("request_user_input_resolve", state, {
              confirmId,
              answerKeys: Object.keys(codexAnswers),
            });
            rpc.respond(rpcId, { answers: codexAnswers });

            // Emit tool_result to close the "running..." state in the frontend UI.
            const answerSummary = Object.entries(answers).map(([k, v]) => `${k}: ${v}`).join(", ");
            emit({
              evt: "tool_result",
              id: state.activeRequestId,
              toolCallId,
              toolName: "AskUserQuestion",
              toolInput: JSON.stringify({ questions: rawQuestions }),
              success: true,
              result: answerSummary || "User answered questions",
              display: defaultToolDisplay(true),
            });
          },
        });
        emit({
          evt: "tool_start",
          id: state.activeRequestId,
          toolCallId,
          toolName: "AskUserQuestion",
          toolInput: JSON.stringify({ questions: rawQuestions }),
        });

        emit({
          evt: "ask_user_question",
          id: state.activeRequestId,
          confirmId,
          toolCallId,
          questions,
        });
        logTurnStateSnapshot("request_user_input_emit", state, {
          confirmId,
          toolCallId,
          questionCount: questions.length,
        });
      } else if (method === "mcpServer/elicitation/request") {
        // MCP server elicitation — the MCP server needs user confirmation
        // before it may continue a sensitive or interactive operation.
        // Schema: McpServerElicitationRequestParams { serverName, threadId, turnId?, message, mode, ... }
        // Response: McpServerElicitationRequestResponse { action: "accept"|"decline"|"cancel", content? }
        const confirmId = `cfm-${randomUUID()}`;
        const serverName = (params.serverName ?? "MCP") as string;
        const message = (params.message ?? "") as string;

        const toolCallId = makeToolCallId();
        const toolName = `MCP:${serverName}`;
        const toolInput = JSON.stringify({ message, serverName });

        // Register with pendingConfirmations so the existing permission_request →
        // ToolConfirmDialog → respond_tool_confirmation flow works end-to-end.
        pendingConfirmations.set(confirmId, {
          resolve: (approved: boolean) => {
            const action = approved ? "accept" : "decline";
            log(`[mcp-elicitation-resolve] confirmId=${confirmId} action=${action} rpcId=${rpcId}`);
            logTurnStateSnapshot("mcp_elicitation_resolve", state, {
              confirmId,
              action,
              rpcId,
              serverName,
            });
            rpc.respond(rpcId, { action });

            // Close the tool call card in the frontend
            emit({
              evt: "tool_result",
              id: state.activeRequestId,
              toolCallId,
              toolName,
              toolInput,
              success: approved,
              result: approved
                ? `MCP elicitation accepted for ${serverName}`
                : `MCP elicitation declined for ${serverName}`,
              display: defaultToolDisplay(approved),
            });
          },
        });

        log(`[mcp-elicitation] serverName=${serverName} confirmId=${confirmId} message=${message.slice(0, 120)}`);
        logTurnStateSnapshot("mcp_elicitation_emit", state, {
          confirmId,
          toolCallId,
          serverName,
        });

        // Emit tool_start so the frontend creates a tool call card
        emit({
          evt: "tool_start",
          id: state.activeRequestId,
          toolCallId,
          toolName,
          toolInput,
        });

        // Emit permission_request to trigger ToolConfirmDialog
        emit({
          evt: "permission_request",
          id: state.activeRequestId,
          confirmId,
          toolCallId,
          toolName,
          toolInput,
        });
      } else {
        log(`[server-request] UNHANDLED server request method=${method} — NOT responding, rpcId=${rpcId}`);
      }
    });

    // 3. Initialize state
    const state: TurnState = {
      activeRequestId: id,
      conversationId: conversationId ?? null,
      turnRequestId: id,
      fullText: "",
      sessionEmitted: false,
      itemToolCallIds: new Map(),
      fileToolEntries: new Map(),
      commandToolEntries: new Map(),
      previousTodos: [],
      totalInputTokens: 0,
      totalOutputTokens: 0,
      lastTurnInputTokens: 0,
      lastTurnCacheReadTokens: 0,
      sumOutputTokens: 0,
      approvalItemIds: new Set(),
      _lastPlanExplanation: "",
      _planToolCallId: null,
      threadAgentInfo: new Map(),
      collabAgentIds: new Map(),
      collabSpawnPrompts: new Map(),
      collabAgentStartTimes: new Map(),
      collabAgentToolUses: new Map(),
      mainThreadId: null,
      activeTurnId: null,
      lastCompletedTurnId: null,
      lastNotificationTurnId: null,
      lastNotificationThreadId: null,
      turnStartCount: 0,
      steerRequestCount: 0,
      lastSteerRequestId: null,
      planReceivedThisTurn: false,
      planContent: "",
      pendingCompactTrigger: null,
      lastTurnStartInputPreview: null,
      lastTurnStartPayloadPreview: null,
      lastSteerPayloadPreview: null,
      lastToolCallMismatchDiagnostic: null,
      lastToolCallMismatchError: null,
      needsCompactBeforeRetry: false,
      toolCallMismatchRecoveryAttempted: false,
    };
    logTurnStateSnapshot("query_state_initialized", state, {
      threadId,
      conversationId: conversationId ?? "none",
    });

    // 4. Build first turn input
    // When thread/resume succeeded, the App Server restored the full thread
    // context from disk — only send the current user message, skip history.
    const effectivePrompt = resumed
      ? cmd.prompt
      : buildEffectivePrompt(cmd, { model: resolvedModel });
    log(`[first-turn] resumed=${resumed}, promptLength=${effectivePrompt.length}`);
    const { input, tempDir } = buildInput(effectivePrompt, cmd.images, cmd.imageGenSize);

    // 5. Emit session and initial events
    emit({ evt: "session", id, sessionId: `oai-${threadId}` });
    state.sessionEmitted = true;
    emit({ evt: "user_message_uuid", id, uuid: randomUUID() });

    // 6. Create channel early so follow-up messages can be queued while a turn runs.
    //    For persistent sessions the channel also serves the warm-session loop.
    const channel = new CodexSessionChannel();
    activePromptChannels.set(id, channel);
    log(`[first-turn] Channel created & registered: requestId=${id}, isPersistent=${isPersistent}`);

    let collab = cmd.disableTools === true ? undefined : buildCollaborationMode(cmd.permissionMode, resolvedModel);

    // Synthesize EnterPlanMode tool card so the frontend shows a visible
    // "entered plan mode" indicator. Claude SDK emits this natively; Codex
    // uses collaborationMode instead, so we emit a synthetic event here.
    // Only show for actual plan permission mode — bypassPermissions/acceptEdits
    // use collaborationMode "plan" internally for request_user_input but the
    // user didn't explicitly enter plan mode.
    const isUserPlanMode = cmd.permissionMode === "plan" || cmd.permissionMode === "planning" || cmd.permissionMode === "deep";
    if (collab?.mode === "plan" && isUserPlanMode) {
      emitEnterPlanMode(id, emit, "oai");
    }

    const reasoningEffort = mapReasoningEffort(cmd.reasoningLevel, cmd.thinkingEnabled, resolvedModel);
    const isCompactRequest = cmd.commandInvocation?.canonicalName === "compact";
    const isStatusRequest = cmd.commandInvocation?.canonicalName === "status";
    if (isCompactRequest) {
      log(`[first-turn] /compact detected — routing through thread/compact/start (skipping turn/start)`);
      state.pendingCompactTrigger = "manual";
    }
    if (isStatusRequest) {
      log(`[first-turn] /status detected — routing through native status RPCs (skipping turn/start)`);
    }
    const firstTurnGoalObjective = cmd.goalModeEnabled === true && !isCompactRequest && !isStatusRequest
      ? cmd.prompt
      : undefined;
    log(`[first-turn] Starting: threadId=${threadId} model=${resolvedModel} collab=${JSON.stringify(collab)} effort=${reasoningEffort} permissionMode=${cmd.permissionMode} isUserPlanMode=${isUserPlanMode} isPersistent=${isPersistent} compactRequest=${isCompactRequest} statusRequest=${isStatusRequest} goalMode=${cmd.goalModeEnabled === true} goalObjectiveLen=${firstTurnGoalObjective?.trim().length ?? 0}`);
    logTurnStateSnapshot("first_turn_begin", state, {
      threadId,
      model: resolvedModel,
      collabMode: collab?.mode ?? "none",
      reasoningEffort: reasoningEffort ?? "none",
      isPersistent,
      compactRequest: isCompactRequest,
      statusRequest: isStatusRequest,
      goalMode: cmd.goalModeEnabled === true,
      goalObjectiveLen: firstTurnGoalObjective?.trim().length ?? 0,
    });
    let succeeded = false;
    try {
      if (isStatusRequest) {
        await executeStatusSlashCommand(rpc, state, emit, cmd, threadId, resolvedModel, cmd.reasoningLevel);
        succeeded = true;
      } else {
        const result = await executeTurnWithRetry(
          buildRpcInput(input), state, emit, firstTurnAbort,
          resolvedModel, rpc, threadId, channel, collab,
          reasoningEffort,
          cmd.serviceTier,
          isCompactRequest,
          firstTurnGoalObjective,
        );
        succeeded = result.succeeded;
      }
    } finally {
      cleanupTempDir(tempDir);
    }
    log(`[first-turn] First turn done. succeeded=${succeeded} itemToolCallIds.size=${state.itemToolCallIds.size} planReceived=${state.planReceivedThisTurn} fullTextLen=${state.fullText.length}`);

    // Plan approval gate: if plan mode turn succeeded AND produced output,
    // show approval dialog (user confirms ExitPlanMode).
    // Only triggers when collab?.mode === "plan", which is limited to
    // plan/planning/deep permission modes after the buildCollaborationMode fix.
    // Primary signal: turn/plan/updated sets planReceivedThisTurn.
    // Fallback: if the Codex App Server didn't emit turn/plan/updated but the
    // model still produced text output (which in plan mode IS the plan by
    // definition of collaborationMode), we still trigger the gate so the user
    // isn't silently stuck with no way to exit plan mode.
    if (succeeded && collab?.mode === "plan" && (state.planReceivedThisTurn || state.fullText.trim().length > 0) && !firstTurnAbort.signal.aborted) {
      let approved: boolean;
      if (isUserPlanMode) {
        log(`[plan-approval] Plan turn completed, requesting user approval...`);
        approved = await requestCodexPlanApproval(state, emit);
      } else {
        // Defensive fallback — currently unreachable since only plan/planning/deep
        // modes produce collab?.mode === "plan", and all are isUserPlanMode.
        log(`[plan-approval] Auto-approving plan for permissionMode=${cmd.permissionMode}`);
        approved = true;
      }

      if (approved) {
        log(`[plan-approval] ${isUserPlanMode ? "User" : "Auto"} approved — executing inline (same message bubble)`);
        log(`[plan-approval:MODE_SWITCH] BEFORE: collab=${JSON.stringify(collab)}`);
        log(`[plan-approval:MODE_SWITCH] BEFORE: itemToolCallIds (${state.itemToolCallIds.size} entries):`);
        for (const [itemId, tcId] of state.itemToolCallIds) {
          log(`[plan-approval:MODE_SWITCH]   ${itemId} → ${tcId}`);
        }
        log(`[plan-approval:MODE_SWITCH] BEFORE: planReceivedThisTurn=${state.planReceivedThisTurn} fullTextLen=${state.fullText.length}`);

        await switchCodexThreadToApprovedExecution(
          rpc,
          threadId,
          resolvedModel,
          cmd.cwd,
        );
        planApproved = true;
        collab = { mode: "default" as const, settings: { model: resolvedModel, reasoning_effort: null, developer_instructions: null } };

        log(`[plan-approval:MODE_SWITCH] AFTER: collab=${JSON.stringify(collab)} (switched from plan → default)`);

        // Reset item-level state but keep activeRequestId and fullText
        // so execution output continues in the same frontend message bubble.
        state.itemToolCallIds.clear();
        state.fileToolEntries.clear();
        state.commandToolEntries.clear();
        state.approvalItemIds.clear();
        state._lastPlanExplanation = "";
        state.planReceivedThisTurn = false;
        state.planContent = "";
        logTurnStateSnapshot("plan_approval_mode_switch_reset", state, {
          threadId,
          nextMode: collab.mode,
        });

        const { input: execInput, tempDir: execTempDir } = buildInput("Execute the approved plan.", undefined, cmd.imageGenSize);
        log(`[plan-approval:EXEC] Sending execution turn: threadId=${threadId} input="${JSON.stringify(execInput).slice(0, 200)}" collab=${JSON.stringify(collab)}`);
        try {
          const execResult = await executeTurnWithRetry(
            buildRpcInput(execInput), state, emit, firstTurnAbort,
            resolvedModel, rpc, threadId, channel, collab,
            reasoningEffort,
            cmd.serviceTier,
          );
          cleanupTempDir(execTempDir);
          succeeded = execResult.succeeded;
          log(`[plan-approval:EXEC] Execution turn result: succeeded=${succeeded}`);
        } catch (err) {
          cleanupTempDir(execTempDir);
          const errorMsg = err instanceof Error ? err.message : String(err);
          log(`[plan-approval] Inline execution error: ${errorMsg}`);
          if (!firstTurnAbort.signal.aborted) {
            emit({
              evt: "error",
              id: state.activeRequestId,
              error: publicSidecarErrorMessage(err),
            });
          }
          succeeded = false;
        }

        // Defensive: restore collaborationMode for non-plan modes.
        // Currently unreachable since only plan/planning/deep enter this gate.
        if (!isUserPlanMode) {
          collab = buildCollaborationMode(cmd.permissionMode, resolvedModel);
        }
      } else {
        log(`[plan-approval] User rejected — staying in plan mode`);
      }
    }

    // For non-persistent sessions, clean up the channel immediately
    if (!isPersistent) {
      activePromptChannels.delete(id);
      channel.close();
    }

    // 7. Warm session loop (if persistent)
    // Enter when the first turn succeeded OR was user-aborted (session still alive).
    // Do NOT enter on real failures or session-level shutdown.
    const firstTurnAborted = firstTurnAbort.signal.aborted;
    if (isPersistent && (succeeded || firstTurnAborted) && conversationId && rpc.alive && !sessionAbort.signal.aborted) {
      emitTurnUsageAndDone(state, emit, resolvedModel, succeeded, true, conversationId);
      log(`[warm-session] First turn complete (succeeded=${succeeded}, aborted=${firstTurnAborted}), registering warm session for conv=${conversationId}, threadId=${threadId}`);
      registerWarmSession({
        conversationId,
        requestId: id,
        channel,
        abortController: sessionAbort,
        model: cmd.model || resolvedModel,
        platform: cmd.platform ?? "",
        cwd: cmd.cwd,
        credentialHash: hashCredentials(cmd.apiKey ?? "", cmd.baseUrl ?? "", cmd.authMode ?? "apiKey", cmd.profileId ?? "", cmd.proxyUrl ?? ""),
        permissionMode: cmd.permissionMode ?? "",
        mcpServerKeys: cmd.mcpServers
          ? Object.keys(cmd.mcpServers).sort().join(",")
          : "",
        // Track imagegen prefs so a per-conversation override change forces
        // the warm session to die and respawn with fresh MCP env vars.
        imageGenQuality: cmd.imageGenQuality,
        imageGenSize: cmd.imageGenSize,
        outputsDir: cmd.outputsDir,
        serviceTier: cmd.serviceTier,
        goalModeEnabled: cmd.goalModeEnabled,
        agent: "codex",
        lastActivityMs: Date.now(),
      });

      while (!sessionAbort.signal.aborted && rpc.alive) {
        // Race nextMessage against RPC process exit to avoid infinite wait
        const nextMsg = await Promise.race([
          channel.nextMessage(),
          rpc.waitForExit().then(() => null),
        ]);
        if (!nextMsg || sessionAbort.signal.aborted || !rpc.alive) break;

        log(`[warm-session] Received follow-up message: conv=${conversationId}, requestId=${nextMsg.requestId}, routedFromQuery=${!!nextMsg.routedFromQuery}, contentLen=${nextMsg.content.length}`);

        const newRequestId = nextMsg.requestId ?? randomUUID();
        logTurnStateSnapshot("warm_session_request_switch_before", state, {
          previousRequestId: state.activeRequestId,
          nextRequestId: newRequestId,
          routedFromQuery: nextMsg.routedFromQuery ?? false,
        });
        state.activeRequestId = newRequestId;
        // Pick up per-turn abort controller created by query routing in index.ts,
        // or create one if the message came from send_user_input (non-routed).
        if (!activeAbortControllers.has(newRequestId)) {
          activeAbortControllers.set(newRequestId, new AbortController());
        }
        const turnAbort = activeAbortControllers.get(newRequestId)!;

        resetTurnState(state);

        // Only emit new_turn when the message came from send_user_input
        // (frontend warm session path). When routed from a full Query
        // (e.g. after page refresh), the frontend already created the
        // assistant placeholder — emitting new_turn would create a duplicate.
        if (!nextMsg.routedFromQuery) {
          emit({ evt: "new_turn", id: newRequestId, commandName: nextMsg.commandInvocation?.canonicalName });
          emit({ evt: "user_message_uuid", id: newRequestId, uuid: randomUUID() });
        }

        // Synthesize EnterPlanMode for follow-up turns — only for actual plan permission mode
        if (collab?.mode === "plan" && isUserPlanMode) {
          emitEnterPlanMode(newRequestId, emit, "oai");
        }

        const { input: followUpInput, tempDir: followUpTempDir } = buildInput(nextMsg.content, nextMsg.images, cmd.imageGenSize);

        // Re-compute effort from the follow-up message's reasoningLevel (may have
        // changed between turns), falling back to the initial value.
        const followUpEffort = nextMsg.reasoningLevel != null
          ? mapReasoningEffort(nextMsg.reasoningLevel, undefined, resolvedModel)
          : reasoningEffort;

        const followUpIsCompact = nextMsg.commandInvocation?.canonicalName === "compact";
        const followUpIsStatus = nextMsg.commandInvocation?.canonicalName === "status";
        if (followUpIsCompact) {
          log(`[warm-session] /compact detected — routing through thread/compact/start (skipping turn/start)`);
          state.pendingCompactTrigger = "manual";
        }
        if (followUpIsStatus) {
          log(`[warm-session] /status detected — routing through native status RPCs (skipping turn/start)`);
        }
        const followUpGoalObjective = cmd.goalModeEnabled === true && !followUpIsCompact && !followUpIsStatus
          ? nextMsg.content
          : undefined;
        log(`[warm-session] Follow-up routing: goalMode=${cmd.goalModeEnabled === true} goalObjectiveLen=${followUpGoalObjective?.trim().length ?? 0}`);

        try {
          const followUpResult = followUpIsStatus
            ? await (async () => {
                await executeStatusSlashCommand(rpc, state, emit, cmd, threadId, resolvedModel, nextMsg.reasoningLevel);
                return { succeeded: true };
              })()
            : await executeTurnWithRetry(
                buildRpcInput(followUpInput), state, emit, turnAbort,
                resolvedModel, rpc, threadId, channel, collab,
                followUpEffort,
                cmd.serviceTier,
                followUpIsCompact,
                followUpGoalObjective,
              );

          cleanupTempDir(followUpTempDir);

          let finalFollowUpSucceeded = followUpResult.succeeded;

          // Plan approval gate for follow-up turns — same logic as first turn
          if (followUpResult.succeeded && collab?.mode === "plan" && (state.planReceivedThisTurn || state.fullText.trim().length > 0) && !turnAbort.signal.aborted) {
            let followUpApproved: boolean;
            if (isUserPlanMode) {
              log(`[plan-approval] Follow-up plan turn completed, requesting approval...`);
              followUpApproved = await requestCodexPlanApproval(state, emit);
            } else {
              // Defensive fallback — currently unreachable (see first-turn comment)
              log(`[plan-approval] Auto-approving follow-up plan for permissionMode=${cmd.permissionMode}`);
              followUpApproved = true;
            }

            if (followUpApproved) {
              log(`[plan-approval] ${isUserPlanMode ? "User" : "Auto"} approved follow-up plan — executing inline (same bubble)`);
              log(`[plan-approval:FOLLOWUP_MODE_SWITCH] BEFORE: collab=${JSON.stringify(collab)} itemToolCallIds.size=${state.itemToolCallIds.size}`);
              for (const [itemId, tcId] of state.itemToolCallIds) {
                log(`[plan-approval:FOLLOWUP_MODE_SWITCH]   ${itemId} → ${tcId}`);
              }

              await switchCodexThreadToApprovedExecution(
                rpc,
                threadId,
                resolvedModel,
                cmd.cwd,
              );
              planApproved = true;
              collab = { mode: "default" as const, settings: { model: resolvedModel, reasoning_effort: null, developer_instructions: null } };

              log(`[plan-approval:FOLLOWUP_MODE_SWITCH] AFTER: collab=${JSON.stringify(collab)} (plan → default)`);

              // Reset item-level state, keep activeRequestId for same bubble
              state.itemToolCallIds.clear();
              state.fileToolEntries.clear();
              state.commandToolEntries.clear();
              state.approvalItemIds.clear();
              state._lastPlanExplanation = "";
              state.planReceivedThisTurn = false;
              state.planContent = "";
              logTurnStateSnapshot("followup_plan_mode_switch_reset", state, {
                threadId,
                nextMode: collab.mode,
              });

              const { input: execInput2, tempDir: execTempDir2 } = buildInput("Execute the approved plan.", undefined, cmd.imageGenSize);
              log(`[plan-approval:FOLLOWUP_EXEC] Sending follow-up execution turn: threadId=${threadId} collab=${JSON.stringify(collab)}`);
              try {
                const execResult2 = await executeTurnWithRetry(
                  buildRpcInput(execInput2), state, emit, turnAbort,
                  resolvedModel, rpc, threadId, channel, collab,
                  followUpEffort,
                  cmd.serviceTier,
                );
                cleanupTempDir(execTempDir2);
                finalFollowUpSucceeded = execResult2.succeeded;
                log(`[plan-approval:FOLLOWUP_EXEC] Follow-up execution result: succeeded=${finalFollowUpSucceeded}`);
              } catch (err) {
                cleanupTempDir(execTempDir2);
                const errorMsg = err instanceof Error ? err.message : String(err);
                log(`[plan-approval] Follow-up inline execution error: ${errorMsg}`);
                if (!turnAbort.signal.aborted) {
                  emit({
                    evt: "error",
                    id: state.activeRequestId,
                    error: publicSidecarErrorMessage(err),
                  });
                }
                finalFollowUpSucceeded = false;
              }

              // Defensive: restore collaborationMode for non-plan modes.
              // Currently unreachable (see first-turn comment).
              if (!isUserPlanMode) {
                collab = buildCollaborationMode(cmd.permissionMode, resolvedModel);
              }
            } else {
              log(`[plan-approval] User rejected follow-up plan — staying in plan mode`);
            }
          }

          // When turn was user-aborted, session is still alive — report sessionAlive=true.
          const turnWasAborted = turnAbort.signal.aborted;
          const sessionAlive = finalFollowUpSucceeded || turnWasAborted;
          emitTurnUsageAndDone(state, emit, resolvedModel, finalFollowUpSucceeded, sessionAlive, conversationId);
          log(`[warm-session] Follow-up turn complete, succeeded=${finalFollowUpSucceeded}, aborted=${turnWasAborted}`);

          // Re-register prompt channel under the new requestId so the next
          // send_user_input (which uses the requestId from the done event)
          // can find the channel.
          activePromptChannels.delete(id);
          activePromptChannels.set(newRequestId, channel);

          if (!finalFollowUpSucceeded && !turnWasAborted) {
            log(`[warm-session] Follow-up turn failed (not abort), exiting warm session loop`);
            break;
          }
        } catch (err) {
          cleanupTempDir(followUpTempDir);
          const errorMsg = err instanceof Error ? err.message : String(err);
          log(`[warm-session] Follow-up turn error: ${errorMsg}`);
          if (!turnAbort.signal.aborted) {
            emit({
              evt: "error",
              id: newRequestId,
              error: publicSidecarErrorMessage(err),
            });
          }
          emit({ evt: "done", id: newRequestId });
          break;
        }
      }

      log(`[warm-session] Warm session loop ended for conv=${conversationId}`);
      // Remove the warm session from the sidecar registry BEFORE closing the
      // RPC channel. This prevents new queries from being routed to a dead
      // session while we await rpc.close().
      if (conversationId) {
        removeWarmSession(conversationId);
      }
      activePromptChannels.delete(state.activeRequestId);
      unsubApproval();
      await rpc.close();
      cleanupTempHome();
      emit({ evt: "session_ended", id: state.activeRequestId, conversationId });
    } else {
      // Non-persistent or failed — single-turn mode
      emitTurnUsageAndDone(state, emit, resolvedModel, succeeded, false, conversationId);
      unsubApproval();
      await rpc.close();
      cleanupTempHome();
      log(`[timing] done emitted (single-turn), succeeded=${succeeded}`);
    }
  } catch (err: unknown) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    log(`Query error: ${errorMsg}`);
    cleanupTempHome();
    if (!sessionAbort.signal.aborted && !firstTurnAbort.signal.aborted) {
      emit({ evt: "error", id, error: publicSidecarErrorMessage(err) });
    }
    emit({ evt: "done", id });
  } finally {
    activeAbortControllers.delete(id);
  }
}
