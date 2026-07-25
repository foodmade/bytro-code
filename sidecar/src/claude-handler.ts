// ---------------------------------------------------------------------------
// Claude CLI query handler — extracted from index.ts
// ---------------------------------------------------------------------------

import { query, startup } from "./claude-cli-adapter.js";
import type {
  Options,
  StreamObserver,
  SDKUserMessage,
  ThinkingConfig,
  EffortLevel,
  WarmQuery,
  SDKControlGetContextUsageResponse,
  Query,
} from "./claude-cli-adapter.js";
import type { QueryCommand, InitSessionCommand, TodoItem, ImageData, ChatMessage, SlashCommandInfo, CommandInvocationPayload } from "./protocol.js";
import { buildPermissionConfig } from "./permissions.js";
import type { PermissionConfig } from "./permissions.js";
import {
  truncate,
  estimateTokens,
  truncateMessages,
  truncatePrompt,
  findClaudeCodePath,
  computeTodoDiff,
  defaultToolDisplay,
  getContextWindowForModel,
  publicSidecarErrorMessage,
  summarizeDiagnosticText,
} from "./shared.js";
import { getCavemanAddendum } from "./caveman/rules.js";
import type { EmitFn } from "./shared.js";
import {
  acquireCredentialLock,
  applyCredentials,
  captureClaudeProviderEnvironment,
  restoreCredentials,
} from "./credential-strategy.js";
import { filterValidMcpServers } from "./mcp-validator.js";
import { createTaskTrackerState, seedTaskFromStart, updateTaskTrackerFromLifecycle, updateTaskTrackerFromTool } from "./task-tracker.js";
import {
  registerWarmSession,
  removeWarmSession,
  getWarmSession,
  activePromptChannels,
  hashCredentials,
  hasWarmSessionForAgent,
  hashForDebug,
} from "./persistent-session-registry.js";
import type { SessionChannel } from "./persistent-session-registry.js";
import { randomUUID, createHash } from "node:crypto";
import { statSync } from "node:fs";
import { join, dirname } from "node:path";

/** Short stable hash for prompt-cache prefix diagnostics. */
function _shortHash(s: string): string {
  return createHash("sha1").update(s).digest("hex").slice(0, 12);
}

// ---------------------------------------------------------------------------
// Persistent session configuration
// ---------------------------------------------------------------------------

/**
 * How long the CLI process stays alive between conversation turns.
 * After this timeout with no new messages, the session ends naturally.
 */
const SESSION_IDLE_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes

const CONTEXT_USAGE_MIN_INTERVAL_MS = 20_000;
const UNKNOWN_SYSTEM_SUBTYPES_LOGGED = new Set<string>();

// ---------------------------------------------------------------------------
// PromptChannel — enables mid-stream user message injection via AsyncIterable
// ---------------------------------------------------------------------------

/** Structured message passed through a PromptChannel. */
export interface ChannelMessage {
  readonly text: string;
  readonly images?: ReadonlyArray<{ readonly media_type: string; readonly data: string }>;
  /** When set, overrides the event emission requestId (warm session redirect). */
  readonly requestId?: string;
  readonly commandInvocation?: CommandInvocationPayload;
}

/**
 * A message queue that bridges imperative `push()` calls with async iteration.
 * The Claude CLI adapter accepts an AsyncIterable<Message> as the prompt parameter;
 * by keeping this iterable alive across turns, additional user messages can be
 * injected mid-stream (e.g. via Ctrl+Enter in the UI).
 *
 * When the SDK finishes processing a turn and reads from the iterable for the
 * next message, it will block until either:
 *   (a) a new message is pushed, or
 *   (b) the idle timeout expires (no more user input → conversation ends).
 */
export class PromptChannel implements SessionChannel {
  private queue: ChannelMessage[] = [];
  private resolver: ((msg: ChannelMessage | null) => void) | null = null;
  private closed = false;
  private readonly idleTimeoutMs: number;

  constructor(idleTimeoutMs = 500) {
    this.idleTimeoutMs = idleTimeoutMs;
  }

  /** Push a user message into the channel. If the CLI adapter is waiting, it wakes up. */
  push(
    content: string,
    images?: ReadonlyArray<{ media_type: string; data: string }>,
    requestId?: string,
    _routedFromQuery?: boolean,
    _reasoningLevel?: string,
    commandInvocation?: CommandInvocationPayload,
  ): void {
    process.stderr.write(
      `[PromptChannel.push] closed=${this.closed}, hasResolver=${!!this.resolver}, ` +
      `queueLen=${this.queue.length}, contentLen=${content.length}, ` +
      `request=${summarizeDiagnosticText(requestId ?? "", "claude.request")}\n`,
    );
    if (this.closed) {
      process.stderr.write(`[PromptChannel.push] DROPPED — channel is closed!\n`);
      return;
    }
    const msg: ChannelMessage = { text: content, images, requestId, commandInvocation };
    if (this.resolver) {
      process.stderr.write(`[PromptChannel.push] Waking up resolver immediately\n`);
      const r = this.resolver;
      this.resolver = null;
      r(msg);
    } else {
      process.stderr.write(`[PromptChannel.push] No resolver waiting, queuing message (new queueLen=${this.queue.length + 1})\n`);
      this.queue.push(msg);
    }
  }

  /** Close the channel, causing the async iterator to complete. */
  close(): void {
    this.closed = true;
    if (this.resolver) {
      const r = this.resolver;
      this.resolver = null;
      r(null);
    }
  }

  /**
   * Wait for the next message. Returns `null` when the channel is closed
   * or the idle timeout expires (no message arrived between SDK turns).
   *
   * @param timeoutOverride  Optional per-call timeout in ms. When omitted the
   *                         channel's default `idleTimeoutMs` is used.
   */
  async waitForMessage(timeoutOverride?: number): Promise<ChannelMessage | null> {
    process.stderr.write(
      `[PromptChannel.waitForMessage] called: queueLen=${this.queue.length}, closed=${this.closed}, timeoutOverride=${timeoutOverride}, idleTimeoutMs=${this.idleTimeoutMs}\n`,
    );
    if (this.queue.length > 0) {
      const msg = this.queue.shift()!;
      process.stderr.write(`[PromptChannel.waitForMessage] returning queued message immediately (contentLen=${msg.text.length})\n`);
      return msg;
    }
    if (this.closed) {
      process.stderr.write(`[PromptChannel.waitForMessage] returning null — channel is closed\n`);
      return null;
    }

    const timeout = timeoutOverride ?? this.idleTimeoutMs;
    process.stderr.write(`[PromptChannel.waitForMessage] waiting with timeout=${timeout}ms\n`);

    return new Promise<ChannelMessage | null>((resolve) => {
      const timer = setTimeout(() => {
        if (this.resolver) {
          this.resolver = null;
          process.stderr.write(`[PromptChannel.waitForMessage] TIMEOUT after ${timeout}ms — returning null\n`);
          resolve(null);
        }
      }, timeout);

      this.resolver = (msg: ChannelMessage | null) => {
        clearTimeout(timer);
        process.stderr.write(
          `[PromptChannel.waitForMessage] resolver called: msg=${msg ? `text(${msg.text.length})` : "null"}\n`,
        );
        resolve(msg);
      };
    });
  }
}

// activePromptChannels is imported from persistent-session-registry.ts (shared across handlers)
export function replaceActivePromptChannel(
  requestId: string,
  nextChannel: SessionChannel,
): void {
  const previous = activePromptChannels.get(requestId);
  if (previous && previous !== nextChannel) previous.close();
  activePromptChannels.set(requestId, nextChannel);
}

export function closeActivePromptChannel(requestId: string): void {
  const channel = activePromptChannels.get(requestId);
  if (channel) channel.close();
  activePromptChannels.delete(requestId);
}

/**
 * Active Query objects, keyed by request ID. Stored so that control methods
 * like `rewindFiles()` can be called between turns while the async iterator
 * is still alive (waiting on PromptChannel).
 */
export const activeQueries = new Map<string, Query>();

// NOTE: A global `lastActiveQuery` fallback used to exist here so that
// handleRewindFiles() could recover when an exact requestId lookup missed.
// It was removed deliberately: that fallback could resolve to a DIFFERENT
// conversation's Query and rewind the WRONG project's files (cross-session
// leak — "code got rolled back on its own"). Rewind now fails safe on a miss.
const contextUsageRequests = new WeakMap<Query, {
  inFlight: boolean;
  lastStartedAt: number;
  pendingReason?: string;
}>();

type SanitizedContextUsageSnapshot = {
  readonly categories: ReadonlyArray<{
    readonly name: string;
    readonly tokens: number;
    readonly color: string;
    readonly isDeferred?: boolean;
  }>;
  readonly totalTokens: number;
  readonly maxTokens: number;
  readonly rawMaxTokens: number;
  readonly percentage: number;
  readonly model: string;
  readonly memoryFiles: ReadonlyArray<{
    readonly path: string;
    readonly type: string;
    readonly tokens: number;
  }>;
  readonly mcpTools: ReadonlyArray<{
    readonly name: string;
    readonly serverName: string;
    readonly tokens: number;
    readonly isLoaded?: boolean;
  }>;
  readonly deferredBuiltinTools?: ReadonlyArray<{
    readonly name: string;
    readonly tokens: number;
    readonly isLoaded: boolean;
  }>;
  readonly systemTools?: ReadonlyArray<{
    readonly name: string;
    readonly tokens: number;
  }>;
  readonly systemPromptSections?: ReadonlyArray<{
    readonly name: string;
    readonly tokens: number;
  }>;
  readonly agents: ReadonlyArray<{
    readonly agentType: string;
    readonly source: string;
    readonly tokens: number;
  }>;
  readonly slashCommands?: {
    readonly totalCommands: number;
    readonly includedCommands: number;
    readonly tokens: number;
  };
  readonly skills?: {
    readonly totalSkills: number;
    readonly includedSkills: number;
    readonly tokens: number;
    readonly skillFrontmatter: ReadonlyArray<{
      readonly name: string;
      readonly source: string;
      readonly tokens: number;
    }>;
  };
  readonly autoCompactThreshold?: number;
};

function sanitizeContextUsageSnapshot(
  snapshot: SDKControlGetContextUsageResponse,
): SanitizedContextUsageSnapshot {
  return {
    categories: snapshot.categories.map((category) => ({
      name: category.name,
      tokens: category.tokens,
      color: category.color,
      ...(category.isDeferred != null ? { isDeferred: category.isDeferred } : {}),
    })),
    totalTokens: snapshot.totalTokens,
    maxTokens: snapshot.maxTokens,
    rawMaxTokens: snapshot.rawMaxTokens,
    percentage: snapshot.percentage,
    model: snapshot.model,
    memoryFiles: snapshot.memoryFiles.map((file) => ({
      path: file.path,
      type: file.type,
      tokens: file.tokens,
    })),
    mcpTools: snapshot.mcpTools.map((tool) => ({
      name: tool.name,
      serverName: tool.serverName,
      tokens: tool.tokens,
      ...(tool.isLoaded != null ? { isLoaded: tool.isLoaded } : {}),
    })),
    ...(snapshot.deferredBuiltinTools ? {
      deferredBuiltinTools: snapshot.deferredBuiltinTools.map((tool) => ({
        name: tool.name,
        tokens: tool.tokens,
        isLoaded: tool.isLoaded,
      })),
    } : {}),
    ...(snapshot.systemTools ? {
      systemTools: snapshot.systemTools.map((tool) => ({
        name: tool.name,
        tokens: tool.tokens,
      })),
    } : {}),
    ...(snapshot.systemPromptSections ? {
      systemPromptSections: snapshot.systemPromptSections.map((section) => ({
        name: section.name,
        tokens: section.tokens,
      })),
    } : {}),
    agents: snapshot.agents.map((agent) => ({
      agentType: agent.agentType,
      source: agent.source,
      tokens: agent.tokens,
    })),
    ...(snapshot.slashCommands ? {
      slashCommands: {
        totalCommands: snapshot.slashCommands.totalCommands,
        includedCommands: snapshot.slashCommands.includedCommands,
        tokens: snapshot.slashCommands.tokens,
      },
    } : {}),
    ...(snapshot.skills ? {
      skills: {
        totalSkills: snapshot.skills.totalSkills,
        includedSkills: snapshot.skills.includedSkills,
        tokens: snapshot.skills.tokens,
        skillFrontmatter: snapshot.skills.skillFrontmatter.map((skill) => ({
          name: skill.name,
          source: skill.source,
          tokens: skill.tokens,
        })),
      },
    } : {}),
    ...(snapshot.autoCompactThreshold != null ? { autoCompactThreshold: snapshot.autoCompactThreshold } : {}),
  };
}

function scheduleContextUsageSnapshot(
  queryRef: Query,
  emit: EmitFn,
  reason: string,
  requestId: string,
  conversationId: string | undefined,
  model: string,
): void {
  const now = Date.now();
  const current = contextUsageRequests.get(queryRef);
  if (current?.inFlight) {
    contextUsageRequests.set(queryRef, {
      ...current,
      pendingReason: reason,
    });
    return;
  }
  if (current && now - current.lastStartedAt < CONTEXT_USAGE_MIN_INTERVAL_MS) {
    const delayMs = CONTEXT_USAGE_MIN_INTERVAL_MS - (now - current.lastStartedAt);
    contextUsageRequests.set(queryRef, {
      ...current,
      pendingReason: reason,
    });
    setTimeout(() => {
      const latest = contextUsageRequests.get(queryRef);
      if (!latest?.pendingReason || latest.inFlight) return;
      scheduleContextUsageSnapshot(queryRef, emit, latest.pendingReason, requestId, conversationId, model);
    }, delayMs);
    return;
  }

  const requestedAt = now;
  contextUsageRequests.set(queryRef, { inFlight: true, lastStartedAt: requestedAt });

  void (async () => {
    try {
      const snapshot = await queryRef.getContextUsage();
      // The Claude Code binary reports a default 200k maxTokens for models
      // routed via ANTHROPIC_BASE_URL (e.g. Opus 4.8 through a proxy), which
      // understates models whose real window is larger (Opus 4.8 = 1M). Prefer
      // our local model table — the same correction the `usage` event applies
      // to contextWindow. Falls back to the SDK value for unknown models.
      const localWindow = getContextWindowForModel(model);
      const maxTokens = localWindow > 0 ? localWindow : snapshot.maxTokens;
      // Re-scale percentage by the same factor so it stays consistent with the
      // corrected window, independent of the SDK's percentage unit.
      const percentage =
        localWindow > 0 && snapshot.maxTokens > 0
          ? snapshot.percentage * (snapshot.maxTokens / localWindow)
          : snapshot.percentage;
      const sanitized = sanitizeContextUsageSnapshot(snapshot);
      emit({
        evt: "context_usage",
        id: requestId,
        conversationId,
        requestedAt,
        totalTokens: snapshot.totalTokens,
        maxTokens,
        percentage,
        snapshot: localWindow > 0 ? { ...sanitized, maxTokens } : sanitized,
      });
      process.stderr.write(
        `[context-usage] reason=${reason} ` +
        `request=${summarizeDiagnosticText(requestId, "claude.request")} ` +
        `conversation=${summarizeDiagnosticText(conversationId ?? "", "claude.conversation")} ` +
        `total=${snapshot.totalTokens} max=${maxTokens} sdkMax=${snapshot.maxTokens} pct=${percentage}\n`,
      );
    } catch (err) {
      process.stderr.write(
        `[context-usage] failed reason=${reason} ` +
        `request=${summarizeDiagnosticText(requestId, "claude.request")} ` +
        `error=${summarizeDiagnosticText(err instanceof Error ? err.message : String(err), "claude.context_error")}\n`,
      );
    } finally {
      const latest = contextUsageRequests.get(queryRef);
      const pendingReason = latest?.pendingReason;
      contextUsageRequests.set(queryRef, { inFlight: false, lastStartedAt: requestedAt });
      if (pendingReason) {
        scheduleContextUsageSnapshot(queryRef, emit, pendingReason, requestId, conversationId, model);
      }
    }
  })();
}

function scheduleContextUsageSnapshotAfterDone(
  queryRef: Query,
  emit: EmitFn,
  reason: string,
  requestId: string,
  conversationId: string | undefined,
  model: string,
): void {
  setTimeout(() => {
    scheduleContextUsageSnapshot(queryRef, emit, reason, requestId, conversationId, model);
  }, 0);
}

function scheduleContextUsageSnapshotOnceAfterDone(
  queryRef: Query,
  state: StreamProcessingState,
  emit: EmitFn,
  reason: string,
  model: string,
): void {
  const requestId = state.activeRequestId;
  if (state.contextUsageScheduledForRequestId === requestId) return;
  state.contextUsageScheduledForRequestId = requestId;
  scheduleContextUsageSnapshotAfterDone(queryRef, emit, reason, requestId, state.conversationId, model);
}

function extractApiErrorStatus(source: unknown): number | null | undefined {
  const raw = source as {
    api_error_status?: unknown;
    error_status?: unknown;
    status?: unknown;
    statusCode?: unknown;
  } | null | undefined;
  if (!raw || typeof raw !== "object") return undefined;

  for (const key of ["api_error_status", "error_status", "status", "statusCode"] as const) {
    if (!Object.prototype.hasOwnProperty.call(raw, key)) continue;
    const status = raw[key];
    if (status === null) return null;
    if (typeof status === "number" && Number.isFinite(status)) return status;
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Internal type definitions for helper functions
// ---------------------------------------------------------------------------

/** Prompt parameter type accepted by the SDK query function. */
type QueryPromptParam = Parameters<typeof query>[0]["prompt"];

/** Mutable ref container for previous todos — enables diff computation across hook calls. */
interface PreviousTodosRef {
  current: ReadonlyArray<TodoItem>;
}

/** Mutable state shared across stream message processing. */
interface StreamProcessingState {
  fullText: string;
  sessionEmitted: boolean;
  /** Whether the `complete` event has already been emitted (early emit from result message). */
  completeEmitted: boolean;
  /** Whether the `done` event has already been emitted. */
  doneEmitted: boolean;
  /** Whether a `done` event is pending (deferred because subagents are still active). */
  donePending: boolean;
  /** Grace-period timer armed when the last subagent stops while `done` is
   *  deferred. Background subagents are normally followed by a task-notification
   *  turn that resumes the main agent; emitting `done` synchronously on
   *  SubagentStop races that turn and makes the frontend tear down the stream
   *  context while the resumed turn is still producing events. */
  deferredDoneTimer?: ReturnType<typeof setTimeout>;
  /** Request id already used to schedule a post-done context snapshot. */
  contextUsageScheduledForRequestId?: string;
  /** Cached terminal reason from the result message (used when done is deferred). */
  terminalReason?: string;
  /** Last SDK API error status observed in result/error messages. */
  lastApiErrorStatus?: number | null;
  /** Captured session ID from the SDK — used for mid-stream message injection. */
  resolvedSessionId: string;
  /** Number of currently active subagents (tracked via SubagentStart/Stop hooks). */
  activeSubagentCount: number;
  readonly toolUseRegistry: Map<string, { toolName: string; toolInput: string }>;
  readonly pendingTaskDescriptions: Map<string, Array<{ description: string; prompt?: string }>>;
  readonly taskTrackerState: ReturnType<typeof createTaskTrackerState>;
  readonly previousTodosRef: PreviousTodosRef;
  previousTodos: ReadonlyArray<TodoItem>;
  /** Frontend conversation ID — used for persistent session tracking. */
  readonly conversationId?: string;
  /**
   * Mutable request ID used for event emission. Updated when a warm session
   * redirect routes a new frontend request to an existing CLI process.
   */
  activeRequestId: string;
  /**
   * UUID of the most recent main-conversation assistant message seen in the
   * CURRENT turn (from `SDKAssistantMessage.uuid`; subagent messages excluded).
   * On clean turn completion this is promoted to the warm session's
   * `lastCleanAssistantUuid` anchor (used as `resumeSessionAt` to truncate an
   * aborted/suspended turn on cold-restart). Reset at the start of each warm turn.
   */
  currentTurnLastAssistantUuid?: string;
  /** Whether thinking deltas have been received via stream_event channel.
   *  When true, assistant-message thinking blocks are skipped to avoid duplicates.
   *  Applies ONLY to the main conversation (parent_tool_use_id == null). */
  thinkingReceivedViaStream: boolean;
  /** Mirror of `thinkingReceivedViaStream` for subagent paths (parent_tool_use_id != null).
   *  Tracked separately so subagent stream_event activity does not suppress main thinking. */
  subagentThinkingReceivedViaStream: boolean;
  /** Per-block emitted lengths for thinking blocks from assistant-message fallback.
   *  Index corresponds to the Nth thinking block in the content array.
   *  Used to compute incremental deltas from accumulated content blocks. */
  thinkingBlockEmittedLens: number[];
  /** Ring buffer of bounded stderr metadata (length + digest only). */
  stderrBuffer: string[];
  /** Values that must never enter logs, diagnostics, or UI error history. */
  diagnosticSecrets: readonly string[];
}

/** Max number of stderr lines retained in `StreamProcessingState.stderrBuffer`. */
const STDERR_BUFFER_MAX_LINES = 200;
/**
 * Append pre-summarized stderr metadata to the ring buffer. Callers must
 * reduce raw child output to length + digest before calling this helper.
 */
function appendStderrToBuffer(buffer: string[], chunk: string): void {
  const lines = chunk.split(/\r?\n/).filter((l) => l.length > 0);
  for (const line of lines) {
    buffer.push(line);
    if (buffer.length > STDERR_BUFFER_MAX_LINES) buffer.shift();
  }
}

const DIAGNOSTIC_SECRET_KEY =
  /(?:api[_-]?key|authorization|auth[_-]?token|access[_-]?token|oauth[_-]?token|secret|password|cookie)/i;

function addDiagnosticSecret(
  secrets: Set<string>,
  value: unknown,
): void {
  if (typeof value === "string" && value.length >= 4) {
    secrets.add(value);
  }
}

function collectNestedDiagnosticSecrets(
  value: unknown,
  secrets: Set<string>,
  sensitiveContext = false,
): void {
  if (typeof value === "string") {
    if (sensitiveContext) addDiagnosticSecret(secrets, value);
    return;
  }
  if (!value || typeof value !== "object") return;
  for (const [key, nested] of Object.entries(value)) {
    const nestedSensitive = sensitiveContext
      || DIAGNOSTIC_SECRET_KEY.test(key)
      || /^(?:headers|env|credentials)$/i.test(key);
    collectNestedDiagnosticSecrets(nested, secrets, nestedSensitive);
  }
}

export function collectCliDiagnosticSecrets(
  input: {
    readonly apiKey?: string;
    readonly baseUrl?: string;
    readonly proxyUrl?: string;
    readonly mcpServers?: unknown;
  },
  environment: NodeJS.ProcessEnv = process.env,
): string[] {
  const secrets = new Set<string>();
  addDiagnosticSecret(secrets, input.apiKey);
  addDiagnosticSecret(secrets, input.baseUrl);
  addDiagnosticSecret(secrets, input.proxyUrl);
  collectNestedDiagnosticSecrets(input.mcpServers, secrets);
  for (const key of [
    "ANTHROPIC_API_KEY",
    "ANTHROPIC_AUTH_TOKEN",
    "CLAUDE_CODE_OAUTH_TOKEN",
  ]) {
    addDiagnosticSecret(secrets, environment[key]);
  }
  return [...secrets].sort((left, right) => right.length - left.length);
}

/** Remove credentials before diagnostics cross either the log or UI boundary. */
export function redactCliDiagnostic(
  raw: string,
  knownSecrets: readonly string[] = [],
): string {
  let redacted = raw;
  for (const secret of [...knownSecrets].sort(
    (left, right) => right.length - left.length,
  )) {
    if (secret.length >= 4) {
      redacted = redacted.split(secret).join("[REDACTED]");
    }
  }

  redacted = redacted
    .replace(
      /\b(Bearer\s+)[^\s,;"']+/gi,
      "$1[REDACTED]",
    )
    .replace(
      /((?:api[_-]?key|authorization|auth[_-]?token|access[_-]?token|oauth[_-]?token|secret|password|cookie)\s*["']?\s*[:=]\s*["']?)[^\s,;"'}]+/gi,
      "$1[REDACTED]",
    )
    .replace(
      /(https?:\/\/)[^/\s:@]+:[^@\s/]+@/gi,
      "$1[REDACTED]:[REDACTED]@",
    )
    .replace(
      /([?&](?:api[_-]?key|access[_-]?token|auth[_-]?token|token|secret|password)=)[^&#\s]+/gi,
      "$1[REDACTED]",
    )
    .replace(/\bsk-[A-Za-z0-9_-]{8,}\b/g, "[REDACTED]");

  return redacted;
}

export function buildRedactedCliError(
  errorMessage: string,
  stderrBuffer: ReadonlyArray<string>,
  _knownSecrets: readonly string[] = [],
): string {
  const normalized = errorMessage.toLowerCase();
  let category: string;
  if (normalized.includes("abort") || normalized.includes("cancel")) {
    category = "Provider request was cancelled";
  } else if (normalized.includes("rate limit") || normalized.includes("429")) {
    category = "Provider rate limit reached";
  } else if (
    normalized.includes("not configured")
    || normalized.includes("configuration")
    || normalized.includes("base url is required")
  ) {
    category = "Provider configuration is incomplete";
  } else {
    category = publicSidecarErrorMessage(errorMessage);
  }
  const diagnosticId = createHash("sha256")
    .update(errorMessage, "utf8")
    .update("\0")
    .update(stderrBuffer.join("\n"), "utf8")
    .digest("hex")
    .slice(0, 12);
  return `${category} (diagnosticId: ${diagnosticId})`;
}

/** SDK usage data extracted from a result message. */
interface UsageData {
  readonly input_tokens?: number;
  readonly output_tokens?: number;
  readonly cache_read_input_tokens?: number;
  readonly cache_creation_input_tokens?: number;
}

export function summarizeClaudeApiRetry(
  message: Record<string, unknown>,
): {
  readonly attempt: number;
  readonly maxAttempts: number;
  readonly retryDelayMs: number;
  readonly errorStatus: number | null;
  readonly reason: string;
  readonly errorDiagnostic: string;
} {
  const attempt =
    typeof message.attempt === "number" ? message.attempt : 1;
  const maxAttempts =
    typeof message.max_retries === "number" ? message.max_retries : 3;
  const retryDelayMs =
    typeof message.retry_delay_ms === "number"
      ? message.retry_delay_ms
      : 0;
  const errorStatus =
    typeof message.error_status === "number" ? message.error_status : null;
  const errorMessage =
    (message.error as { message?: string } | undefined)?.message ??
    "provider error";
  return {
    attempt,
    maxAttempts,
    retryDelayMs,
    errorStatus,
    reason:
      `provider_retry status=${errorStatus ?? "unknown"} ` +
      `delay_ms=${retryDelayMs}`,
    errorDiagnostic: summarizeDiagnosticText(
      errorMessage,
      "claude.api_retry_error",
    ),
  };
}

// ---------------------------------------------------------------------------
// Helper: Build SDK Options object
// ---------------------------------------------------------------------------

/**
 * Map ultracode / reasoningLevel / thinkingEnabled to SDK ThinkingConfig + EffortLevel.
 * ultracode takes precedence; thinkingEnabled is the legacy fallback.
 */
function buildThinkingOptions(
  reasoningLevel: string | undefined,
  thinkingEnabled: boolean | undefined,
  ultracode: boolean | undefined,
): { thinking?: ThinkingConfig; effort?: EffortLevel } {
  const display = "summarized";

  if (ultracode === true) {
    return {
      thinking: { type: "adaptive", display } as ThinkingConfig,
      effort: "xhigh" as EffortLevel,
    };
  }

  // New path: reasoningLevel is set
  if (reasoningLevel != null) {
    if (reasoningLevel === "off") {
      return { thinking: { type: "disabled" } as ThinkingConfig };
    }
    // "low" | "medium" | "high" | "max" → adaptive thinking + effort
    return {
      thinking: { type: "adaptive", display } as ThinkingConfig,
      effort: reasoningLevel as EffortLevel,
    };
  }
  // Legacy fallback: only thinkingEnabled boolean.
  // Use "adaptive" (not "enabled") — Opus 4.7 only supports adaptive, and
  // the SDK internally translates adaptive to the right config for older models.
  if (thinkingEnabled != null) {
    return {
      thinking: (thinkingEnabled
        ? { type: "adaptive", display }
        : { type: "disabled" }) as ThinkingConfig,
    };
  }
  // Neither set — let SDK use its defaults
  return {};
}

/**
 * Build the SDK Options object from the query command, resolved claude path,
 * and permission configuration.
 *
 * Configures model, process settings, stream observers, MCP servers, and
 * session resume. Tool approval callbacks are intentionally not included:
 * the local CLI has no stdio bridge for an in-process `canUseTool` callback.
 */
function buildQueryOptions(
  cmd: QueryCommand,
  claudePath: string,
  permConfig: PermissionConfig,
  abortController: AbortController,
  emit: EmitFn,
  pendingTaskDescriptions: Map<string, Array<{ description: string; prompt?: string }>>,
  previousTodosRef: PreviousTodosRef,
  state: StreamProcessingState,
): Options {
  const { cwd, systemPrompt, sessionId, forkSession, resumeSessionAt } = cmd;

  const id = cmd.id;

  // User/project settings remain untouched. The local CLI adapter supplies a
  // private per-process settings file whose credential env values take
  // precedence for this launch only.

  const shouldEnableReasoning = cmd.platform == null || cmd.platform === "claude" || cmd.platform === "ollama";
  const options: Options = {
    model: cmd.model,
    cwd,
    abortController,
    includePartialMessages: true,
    pathToClaudeCodeExecutable: claudePath,
    settingSources: ["user", "project", "local"],
    // Enable file checkpointing so that `Query.rewindFiles()` can restore
    // files to their state at any user message. The frontend exposes a
    // "Revert All" button that calls this API.
    enableFileCheckpointing: true,
    // Extended thinking & effort: enabled for Anthropic official and Ollama.
    // Other third-party providers may reject the SDK's ?beta=true URL suffix
    // (HTTP 500), so thinking is disabled for them.
    ...(shouldEnableReasoning ? buildThinkingOptions(cmd.reasoningLevel, cmd.thinkingEnabled, cmd.ultracode) : {}),
  };
  // ultracode and fastMode are both SDK session settings injected via the CLI
  // `--settings` flag (extraArgs.settings). Merge whichever are enabled into a
  // single settings object so they don't clobber each other.
  const sessionSettings: Record<string, boolean> = {};
  if (shouldEnableReasoning && cmd.ultracode === true) {
    sessionSettings.ultracode = true;
    // Ultracode is gated on the Workflows feature: the CLI rejects it with
    // "Ultracode needs dynamic workflows enabled" when the account's default
    // gate (plan-based) is off, so enable Workflows explicitly for the session.
    sessionSettings.enableWorkflows = true;
  }
  if (shouldEnableReasoning && cmd.fastMode === true) sessionSettings.fastMode = true;
  if (Object.keys(sessionSettings).length > 0) {
    options.extraArgs = {
      ...(options.extraArgs ?? {}),
      settings: JSON.stringify(sessionSettings),
    };
  }
  options.env = captureClaudeProviderEnvironment();
  // [fast-mode] Headless SDK mode never runs the CLI's interactive org-status
  // prefetch (KlH → $y resolution), so even an entitled (Max/paid) account has
  // $y stuck at pending/disabled, and yZ()/k6H() block fast mode → fast_mode_state
  // stays "off" despite --settings {fastMode:true}. CLAUDE_CODE_SKIP_FAST_MODE_ORG_CHECK
  // forces $y="enabled", matching what the interactive CLI resolves for the same
  // authorized account. Gated on fastMode — no effect on other requests.
  if (shouldEnableReasoning && cmd.fastMode === true) {
    options.env = { ...options.env, CLAUDE_CODE_SKIP_FAST_MODE_ORG_CHECK: "1" };
  }

  // Capture stderr from the Claude Code subprocess (cli.js) so crash
  // reasons are visible in the sidecar's stderr (which Rust now captures)
  // and can be surfaced to the UI via the error event when the process
  // exits non-zero.
  (options as Record<string, unknown>).stderr = (msg: string) => {
    const summary = summarizeDiagnosticText(msg, "claude.stderr");
    process.stderr.write(`[claude-cli] ${summary}\n`);
    appendStderrToBuffer(
      state.stderrBuffer,
      summary,
    );
  };

  // Inject MCP server configurations if provided.
  //
  // 1. Validate first: Claude Code CLI rejects the ENTIRE startup with code=1
  //    if any single mcpServers entry violates its schema (see mcp-validator.ts
  //    docstring). A pre-filter prevents one bad user config from killing all
  //    Claude sessions.
  // 2. On Windows, npm/npx spawned from a GUI process (no console) fails
  //    because the SDK's child_process internally uses cmd.exe as the script
  //    shell. We resolve "npx" / "npm" commands to "node.exe + cli.js" so the
  //    SDK can spawn the MCP server directly without going through cmd.exe.
  if (cmd.mcpServers && Object.keys(cmd.mcpServers).length > 0) {
    const { valid, skipped } = filterValidMcpServers(cmd.mcpServers);
    for (const s of skipped) {
      process.stderr.write(
        `[mcp-validate] Skipping MCP server '${s.name}' — ${s.reason}\n`,
      );
    }
    if (Object.keys(valid).length > 0) {
      const resolved = process.platform === "win32"
        ? resolveWindowsMcpServers(valid as Record<string, McpServerConfigRaw>)
        : valid;
      (options as Record<string, unknown>).mcpServers = resolved;
    }
  }

  // ---------------------------------------------------------------------------
  // disableTools mode: pure conversation — no tools, no hooks, plain prompt.
  // ---------------------------------------------------------------------------
  if (cmd.disableTools) {
    // Use a plain string system prompt so the SDK skips tool descriptions.
    const plainParts: string[] = [];
    if (systemPrompt) plainParts.push(systemPrompt);
    const cavemanText = getCavemanAddendum(cmd.cavemanMode);
    if (cavemanText) plainParts.push(cavemanText);
    if (plainParts.length > 0) {
      options.systemPrompt = plainParts.join("\n");
    }
    options.allowedTools = [];
    // Limit to a single turn to prevent multi-turn tool loops that
    // waste time and tokens when the model should just output text.
    (options as Record<string, unknown>).maxTurns = 1;
    // Explicitly clear MCP servers to prevent SDK from auto-discovering
    // and injecting unrelated MCP tool descriptions into the prompt.
    (options as Record<string, unknown>).mcpServers = {};
    // Skip loading CLAUDE.md and other settings files to avoid injecting
    // thousands of irrelevant tokens into pure text generation requests.
    options.settingSources = [];
    // Disable file checkpointing — pure text generation never modifies files.
    options.enableFileCheckpointing = false;
    // No tool stream observers — skip all tool-related setup.
  } else {
    // Use preset format to preserve Claude Code's default system prompt
    // (including CWD, tool descriptions, etc.) while appending extra context.
    // A plain string systemPrompt would REPLACE the entire default prompt.
    const appendParts: string[] = [];
    if (systemPrompt) {
      appendParts.push(systemPrompt);
    }
    appendParts.push([
      "<bytro_internal_message_guidance>",
      "Messages wrapped in <task-notification>...</task-notification> are automated Bytro/Claude SDK subagent completion notifications, not user-authored messages.",
      "Use their <result> as internal subagent output when relevant, but do not describe them as something the user said, clarified, requested, or used to interrupt a tool call.",
      "</bytro_internal_message_guidance>",
    ].join("\n"));
    // Explicitly include the CWD so Claude Code knows the project directory
    // even when resuming a session that was created in a different directory.
    if (cwd) {
      appendParts.push(`Current project directory: ${cwd}`);
    }
    const cavemanText = getCavemanAddendum(cmd.cavemanMode);
    if (cavemanText) {
      appendParts.push(cavemanText);
    }
    const append = appendParts.join("\n");
    options.systemPrompt = {
      type: "preset" as const,
      preset: "claude_code" as const,
      ...(append ? { append } : {}),
    };

    // Use SDK-native permissionMode instead of custom allowedTools mapping.
    options.permissionMode = permConfig.permissionMode;
    if (permConfig.allowDangerouslySkipPermissions) {
      options.allowDangerouslySkipPermissions = true;
    }

    // The local CLI cannot invoke Bytro's in-process canUseTool callback.
    // Default mode is downgraded to dontAsk by the adapter so approval-gated
    // tools fail closed instead of hanging on a nonexistent UI bridge.

    if (cmd.dimensionPrompts) {
      options.dimensionPrompts = cmd.dimensionPrompts;
    }

    // Observe already-emitted CLI stream events for UI bookkeeping. These
    // callbacks cannot block or rewrite tool execution.
    const subagentStartObserver: StreamObserver = async (input, _toolUseID, _options) => {
      if (input.hook_event_name === "SubagentStart") {
        const raw = input as Record<string, unknown>;
        const agentId = typeof raw.agent_id === "string" ? raw.agent_id : "";
        const agentType = typeof raw.agent_type === "string" ? raw.agent_type : "";
        const sessionId = typeof raw.session_id === "string" ? raw.session_id : undefined;
        // Retrieve description + prompt from the pending queue populated by PreToolUse(Task).
        // Send short title as `name` and detailed prompt as `description` so the
        // frontend can display them separately (title line vs subtitle line).
        const queue = pendingTaskDescriptions.get(agentType);
        const entry = queue?.shift();
        if (queue && queue.length === 0) pendingTaskDescriptions.delete(agentType);
        if (agentId) {
          state.activeSubagentCount++;
          const name = entry?.description;
          const prompt = entry?.prompt;
          const description = entry?.description;
          emit({ evt: "subagent_started", id, agentId, agentType, name, description, prompt, sessionId });
        }
      }
    };

    const subagentStopObserver: StreamObserver = async (input, _toolUseID, _options) => {
      if (input.hook_event_name === "SubagentStop") {
        const raw = input as Record<string, unknown>;
        const agentId = typeof raw.agent_id === "string" ? raw.agent_id : "";
        if (agentId) {
          state.activeSubagentCount = Math.max(0, state.activeSubagentCount - 1);
          emit({ evt: "subagent_stopped", id, agentId });

          // If done was deferred because subagents were active, do NOT emit it
          // synchronously: a background subagent's stop is normally followed by
          // a task-notification turn that resumes the main agent, and emitting
          // done here races that turn — the frontend would show the completion
          // footer and drop all events of the resumed turn (tools stuck in
          // loading forever). Arm a grace timer instead; any main-conversation
          // activity cancels it (see classifyDeferredDoneWake).
          if (state.activeSubagentCount === 0 && state.donePending && !state.doneEmitted) {
            armDeferredDoneTimer(state, emit);
            process.stderr.write(
              `[claude-handler] Last subagent stopped with done pending — armed ${DEFERRED_DONE_GRACE_MS}ms grace timer\n`,
            );
          }
        }
      }
    };

    const todoWriteObserver: StreamObserver = async (input, _toolUseID, _options) => {
      const raw = input as Record<string, unknown>;
      const toolInput = raw.tool_input as Record<string, unknown> | undefined;
      if (Array.isArray(toolInput?.todos)) {
        const newTodos = toolInput.todos as ReadonlyArray<TodoItem>;
        const diff = computeTodoDiff(previousTodosRef.current, newTodos);
        previousTodosRef.current = newTodos;
        state.previousTodos = newTodos;
        emit({ evt: "todo_updated", id, todos: newTodos, diff });
      }
    };

    const taskToolObserver: StreamObserver = async (input, _toolUseID, _options) => {
      const raw = input as Record<string, unknown>;
      const toolName = typeof raw.tool_name === "string" ? raw.tool_name : "";
      const toolInput = raw.tool_input as Record<string, unknown> | undefined;
      const update = updateTaskTrackerFromTool(
        state.taskTrackerState,
        previousTodosRef.current,
        toolName,
        toolInput,
        raw.tool_response,
      );
      if (update) {
        previousTodosRef.current = update.todos;
        state.previousTodos = update.todos;
        emit({ evt: "todo_updated", id, todos: update.todos, diff: update.diff });
      }
    };

    // Capture Task metadata from the stream for later SubagentStart display.
    // Full health-check prompts are already inlined into the first CLI stdin
    // message by the adapter; this observer never mutates tool input.
    const preTaskObserver: StreamObserver = async (input, _toolUseID, _options) => {
      const raw = input as Record<string, unknown>;
      const toolName = typeof raw.tool_name === "string" ? raw.tool_name : "";
      if (toolName !== "Task" && toolName !== "Agent") {
        return;
      }
      const toolInput = raw.tool_input as Record<string, unknown> | undefined;
      const desc = typeof toolInput?.description === "string" ? toolInput.description : undefined;
      const prompt = typeof toolInput?.prompt === "string" ? toolInput.prompt : undefined;
      const subType = typeof toolInput?.subagent_type === "string" ? toolInput.subagent_type : undefined;
      if (desc && subType) {
        const entry = { description: desc, prompt };
        const queue = pendingTaskDescriptions.get(subType);
        if (queue) {
          queue.push(entry);
        } else {
          pendingTaskDescriptions.set(subType, [entry]);
        }
      }
    };

    // PostToolUse hook for Task — emits subagent_completed with the result text.
    // The SDK may store the actual agent output in an outputFile rather than
    // returning it inline. When outputFile is present, read the file to get
    // the real analysis result.
    const postTaskObserver: StreamObserver = async (input, toolUseID, _options) => {
      const raw = input as Record<string, unknown>;
      const toolName = typeof raw.tool_name === "string" ? raw.tool_name : "";
      if (toolName !== "Task" && toolName !== "Agent") {
        return;
      }
      const toolResponse = raw.tool_response;
      const toolInput = raw.tool_input as Record<string, unknown> | undefined;
      const toolUseId = toolUseID ?? (typeof raw.tool_use_id === "string" ? raw.tool_use_id : "");

      // The SDK may pass tool_response as a string or object. Either way,
      // parse it to extract the agent's actual output text.
      let resultText: string;
      let resp: Record<string, unknown> | null = null;

      if (typeof toolResponse === "string") {
        try {
          const parsed = JSON.parse(toolResponse);
          if (parsed && typeof parsed === "object") resp = parsed;
        } catch { /* not JSON, use as-is */ }
        if (!resp) resultText = toolResponse;
      } else if (toolResponse && typeof toolResponse === "object") {
        resp = toolResponse as Record<string, unknown>;
      }

      if (resp) {
        // Debug: log resp keys and content type so we can diagnose extraction issues
        const respKeys = Object.keys(resp);
        const contentType = resp.content === undefined ? "undefined"
          : resp.content === null ? "null"
          : Array.isArray(resp.content) ? `array[${(resp.content as unknown[]).length}]`
          : typeof resp.content;
        process.stderr.write(
          `[claude-handler] PostToolUse(Task) resp keys=[${respKeys.join(",")}] content.type=${contentType}\n`,
        );

        // The SDK returns the sub-agent's actual output in the `content` field.
        // It may be a string or an array of content blocks [{type:"text",text:"..."}].
        const rawContent = resp.content;
        let extracted: string | null = null;
        if (typeof rawContent === "string" && rawContent.length > 0) {
          extracted = rawContent;
        } else if (Array.isArray(rawContent)) {
          const texts: string[] = [];
          for (const block of rawContent) {
            if (block && typeof block === "object") {
              const b = block as Record<string, unknown>;
              if (typeof b.text === "string") texts.push(b.text);
              else if (typeof b.content === "string") texts.push(b.content);
            } else if (typeof block === "string") {
              texts.push(block);
            }
          }
          if (texts.length > 0) extracted = texts.join("\n");
        }

        // If content extraction failed, try other known SDK result fields
        if (!extracted) {
          // Some SDK versions put the result in `result` or `output` fields
          for (const altKey of ["result", "output", "text", "stdout"] as const) {
            const alt = resp[altKey];
            if (typeof alt === "string" && alt.length > 0) {
              extracted = alt;
              process.stderr.write(
                `[claude-handler] PostToolUse(Task) found result in alt field "${altKey}" (${alt.length} chars)\n`,
              );
              break;
            }
          }
        }

        if (extracted) {
          resultText = extracted;
        } else if (typeof resp.outputFile === "string") {
          // Async subagents may not have written the output file yet.
          // Poll until the file appears or the timeout expires.
          const outputFilePath = resp.outputFile;
          try {
            const { readFileSync, existsSync, statSync } = await import("node:fs");
            const POLL_INTERVAL_MS = 500;
            const MAX_WAIT_MS = 120_000;
            let waited = 0;
            const signal = (_options as { signal?: AbortSignal })?.signal;
            while (!existsSync(outputFilePath) && waited < MAX_WAIT_MS) {
              if (signal?.aborted) break;
              if (waited % 5000 === 0) {
                process.stderr.write(
                  `[claude-handler] Waiting for outputFile (${waited}ms/${MAX_WAIT_MS}ms)\n`,
                );
              }
              await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
              waited += POLL_INTERVAL_MS;
            }
            if (existsSync(outputFilePath)) {
              // Wait for file size to stabilize (prevent reading partial writes)
              let prevSize = -1;
              for (let i = 0; i < 6; i++) {
                const sz = statSync(outputFilePath).size;
                if (sz > 0 && sz === prevSize) break;
                prevSize = sz;
                await new Promise((r) => setTimeout(r, 200));
              }
              resultText = readFileSync(outputFilePath, "utf-8");
              process.stderr.write(
                `[claude-handler] Read outputFile after ${waited}ms (${resultText.length} chars)\n`,
              );
            } else {
              process.stderr.write(
                `[claude-handler] outputFile unavailable after ${MAX_WAIT_MS}ms\n`,
              );
              resultText = JSON.stringify(resp);
            }
          } catch {
            process.stderr.write("[claude-handler] Failed to read outputFile\n");
            resultText = JSON.stringify(resp);
          }
        } else {
          resultText = JSON.stringify(resp);
        }
      }
      // Fallback if resultText was never assigned
      resultText ??= String(toolResponse ?? "");

      // The score JSON is always at the END of the agent output. Standard
      // truncate() keeps the head and loses the tail, so use a custom
      // strategy: keep the last 10K (where the JSON result lives) plus
      // the first 2K (for dimension-keyword matching).
      const RESULT_LIMIT = 12000;
      let trimmedResult: string;
      if (resultText.length <= RESULT_LIMIT) {
        trimmedResult = resultText;
      } else {
        const HEAD = 2000;
        const TAIL = RESULT_LIMIT - HEAD;
        trimmedResult =
          resultText.slice(0, HEAD) +
          "\n...(truncated middle)...\n" +
          resultText.slice(-TAIL);
      }

      emit({
        evt: "subagent_completed",
        id,
        toolUseId,
        result: trimmedResult,
        subagentType: typeof toolInput?.subagent_type === "string" ? toolInput.subagent_type : "",
        description: typeof toolInput?.description === "string" ? toolInput.description : undefined,
        prompt: typeof toolInput?.prompt === "string" ? toolInput.prompt : undefined,
      });
    };

    // PostToolUse hook for tracking file modifications (Edit, Write).
    // Parses tool_input to extract file path and approximate diff statistics,
    // then emits a `file_changed` event for the frontend's changed-files panel.
    const fileChangeObserver: StreamObserver = async (input, _toolUseID, _options) => {
      const raw = input as Record<string, unknown>;
      const toolName = typeof raw.tool_name === "string" ? raw.tool_name : "";
      const toolInput = raw.tool_input as Record<string, unknown> | undefined;
      if (!toolInput) return;

      const filePath = typeof toolInput.file_path === "string" ? toolInput.file_path : "";
      if (!filePath) return;

      let action: "edit" | "create" | "delete" = "edit";
      let additions = 0;
      let deletions = 0;

      if (toolName === "Edit") {
        const oldStr = typeof toolInput.old_string === "string" ? toolInput.old_string : "";
        const newStr = typeof toolInput.new_string === "string" ? toolInput.new_string : "";
        additions = newStr.split("\n").length;
        deletions = oldStr.split("\n").length;
        // If old_string is empty, this might be an insertion
        if (!oldStr && newStr) {
          additions = newStr.split("\n").length;
          deletions = 0;
        }
      } else if (toolName === "Write") {
        action = "create";
        const content = typeof toolInput.content === "string" ? toolInput.content : "";
        additions = content.split("\n").length;
        deletions = 0;
      }

      emit({
        evt: "file_changed",
        id,
        filePath,
        action,
        toolName,
        additions,
        deletions,
      });

    };

    // Stop hook — fires once at the end of every assistant turn (after the
    // final message_stop, no matter how many tool-use loops happened).  The
    // SDK includes `last_assistant_message` so we don't have to parse the
    // transcript file.  We forward both as a `turn_finished` event so the
    // frontend's live reviewer can flush its per-turn file buffer and run
    // a single batch review covering everything Opus did this turn.
    const turnFinishedObserver: StreamObserver = async (input, _toolUseID, _options) => {
      const raw = input as Record<string, unknown>;
      const lastMsg = typeof raw.last_assistant_message === "string"
        ? raw.last_assistant_message
        : null;
      emit({
        evt: "turn_finished",
        id,
        lastAssistantMessage: lastMsg,
      });
    };

    options.streamObservers = {
      SubagentStart: [{ observers: [subagentStartObserver] }],
      SubagentStop: [{ observers: [subagentStopObserver] }],
      PreToolUse: [
        { matcher: "^(Task|Agent)$", observers: [preTaskObserver] },
      ],
      PostToolUse: [
        { matcher: "TodoWrite", observers: [todoWriteObserver] },
        { matcher: "^(TaskCreate|TaskUpdate|TaskGet|TaskList)$", observers: [taskToolObserver] },
        { matcher: "Edit|Write", observers: [fileChangeObserver] },
        { matcher: "^(Task|Agent)$", observers: [postTaskObserver] },
      ],
      TaskCreated: [{
        observers: [async (input) => {
          const update = updateTaskTrackerFromLifecycle(
            state.taskTrackerState,
            previousTodosRef.current,
            "created",
            input as Record<string, unknown>,
          );
          if (update) {
            previousTodosRef.current = update.todos;
            state.previousTodos = update.todos;
            emit({ evt: "todo_updated", id, todos: update.todos, diff: update.diff });
          }
        }],
      }],
      TaskCompleted: [{
        observers: [async (input) => {
          const update = updateTaskTrackerFromLifecycle(
            state.taskTrackerState,
            previousTodosRef.current,
            "completed",
            input as Record<string, unknown>,
          );
          if (update) {
            previousTodosRef.current = update.todos;
            state.previousTodos = update.todos;
            emit({ evt: "todo_updated", id, todos: update.todos, diff: update.diff });
          }
        }],
      }],
      Stop: [{ observers: [turnFinishedObserver] }],
    };

    // Enable periodic AI-generated progress summaries for subagents (~30s interval).
    // Reuses prompt cache so cost is minimal.
    options.agentProgressSummaries = true;
  }

  // Determine if this is a valid Claude session we can resume.
  // Session IDs from other handlers have known prefixes; skip resume for those.
  // Third-party platforms (routed via sdkOverride) don't maintain CLI session
  // files — their sessions live only in the warm-session registry.  Attempting
  // --resume with a frontend-generated UUID causes the CLI to hang because no
  // matching session file exists on disk.
  const isNonClaudeSession = sessionId
    && (sessionId.startsWith("oai-") || sessionId.startsWith("gem-") || sessionId.startsWith("ccmpl-"));
  const isThirdPartyPlatform = cmd.platform != null && cmd.platform !== "claude";

  const isResuming = !!(sessionId && !isNonClaudeSession && !isThirdPartyPlatform);
  if (isResuming) {
    options.resume = sessionId;
    // Conversation fork: branch the resumed session into a NEW session id
    // instead of continuing it. Set only on a forked conversation's first turn
    // — see use-chat-streaming's pending-fork detection. The `session` event
    // then carries the new id back to the store, which flips the conversation
    // to its own JSONL.
    if (forkSession) {
      options.forkSession = true;
    }
    // resumeSessionAt resumes "up to and including" this message uuid. Two
    // callers set it: (a) conversation fork (paired with forkSession) and
    // (b) abort/suspend cold-restart recovery (no fork) — index.ts sets
    // cmd.resumeSessionAt to the warm session's last clean assistant uuid so the
    // interrupted turn's persisted half-done tail is truncated out of the
    // resumed context instead of being reloaded and continued.
    if (resumeSessionAt) {
      options.resumeSessionAt = resumeSessionAt;
    }
  }

  // ── [CACHE-DIAG] hash every cacheable input so consecutive turns can be
  // compared at a glance. If a hash flips between turns, that field is the
  // cache-buster.
  try {
    const sysPrompt = typeof options.systemPrompt === "string"
      ? options.systemPrompt
      : (options.systemPrompt as { append?: string } | undefined)?.append ?? "";
    const mcp = (options as Record<string, unknown>).mcpServers
      ? JSON.stringify((options as Record<string, unknown>).mcpServers)
      : "";
    process.stderr.write(
      `[cache-diag] turn request=${summarizeDiagnosticText(id, "claude.request")} ` +
      `sysHash=${_shortHash(sysPrompt)} sysLen=${sysPrompt.length} ` +
      `cwd=${summarizeDiagnosticText(cwd ?? "", "claude.cwd")} ` +
      `model=${cmd.model} ` +
      `thinking=${JSON.stringify((options as Record<string, unknown>).thinking ?? null)} ` +
      `effort=${String((options as Record<string, unknown>).effort ?? "-")} ` +
      `fastMode=${cmd.fastMode === true} ` +
      `resumeSet=${isResuming && !!sessionId} ` +
      `claudePathHash=${_shortHash(claudePath)} ` +
      `mcpHash=${_shortHash(mcp)} ` +
      `permMode=${options.permissionMode ?? "-"}\n`,
    );
  } catch {
    // diagnostic only — never block
  }

  return options;
}

// ---------------------------------------------------------------------------
// Helper: Build prompt parameter
// ---------------------------------------------------------------------------


/**
 * Truncate and format conversation history into a context block.
 * Returns the formatted context string, or empty string if no history.
 * Applies an additional hard character limit as a safety net beyond
 * the token-based truncation to avoid "Prompt is too long" errors.
 */
function formatHistoryContext(
  messages: ReadonlyArray<ChatMessage>,
  model: string,
  extraTokens: number,
): string {
  const trimmed = truncateMessages(messages, model, extraTokens);
  if (trimmed.length === 0) return "";
  let ctx = trimmed.map((m: ChatMessage) => `${m.role}: ${m.content}`).join("\n\n");
  // Hard limit: cap the formatted context to ~100K characters (~28K tokens)
  // as a safety net against token estimation inaccuracies.
  const MAX_CONTEXT_CHARS = 100_000;
  if (ctx.length > MAX_CONTEXT_CHARS) {
    ctx = ctx.slice(-MAX_CONTEXT_CHARS);
    // Find the first complete message boundary after truncation
    const boundary = ctx.indexOf("\n\n");
    if (boundary > 0) {
      ctx = ctx.slice(boundary + 2);
    }
  }
  return ctx;
}

/**
 * Build the effective prompt text, embedding conversation history context
 * when switching from another model (no valid Claude session).
 * Returns a plain string — wrapped into an SDKUserMessage by the caller.
 */
function buildEffectivePromptText(
  cmd: QueryCommand,
  prompt: string,
  sessionId: string | null,
): string {
  const { systemPrompt, model } = cmd;
  // Truncate the current prompt if it alone exceeds context budget
  const safePrompt = truncatePrompt(prompt, model);

  const isNonClaudeSession = sessionId
    && (sessionId.startsWith("oai-") || sessionId.startsWith("gem-") || sessionId.startsWith("ccmpl-"));

  const needsHistoryContext = (!sessionId || isNonClaudeSession)
    && cmd.messages && cmd.messages.length > 0;

  if (needsHistoryContext) {
    const promptTokens = estimateTokens(safePrompt) + estimateTokens(systemPrompt || "");
    const ctx = formatHistoryContext(cmd.messages!, model, promptTokens);
    if (ctx) {
      return `<conversation_history>\n${ctx}\n</conversation_history>\n\nUser: ${safePrompt}`;
    }
  }

  return safePrompt;
}

// ---------------------------------------------------------------------------
// Helper: Deferred-done lifecycle (background subagents)
// ---------------------------------------------------------------------------

/** How long to wait after the last SubagentStop before emitting a deferred
 *  `done`. The CLI injects the task-notification wakeup locally (no API round
 *  trip), so the resumed turn's first stream messages arrive within
 *  milliseconds; the grace window only needs to cover process scheduling. */
const DEFERRED_DONE_GRACE_MS = 2_000;

/**
 * Emit the turn-final `done` event, promoting the warm-session anchor and
 * attaching `sessionAlive`/`conversationId` when the CLI process stays warm.
 * Shared by the normal result path and the deferred-done grace timer so both
 * paths carry identical payloads — a deferred `done` without `sessionAlive`
 * makes the frontend tear down the whole stream context.
 */
function emitTurnDone(
  state: StreamProcessingState,
  emit: EmitFn,
  id: string,
  terminalReason: string | undefined,
): void {
  state.doneEmitted = true;
  state.donePending = false;
  if (state.deferredDoneTimer) {
    clearTimeout(state.deferredDoneTimer);
    state.deferredDoneTimer = undefined;
  }
  if (state.conversationId) {
    // Advance the abort/suspend cold-restart anchor to THIS turn's last
    // assistant message — but only if the turn was not itself aborted.
    // handleAbort sets needsColdRestart synchronously when the user stops,
    // so if it's already set the current turn is the interrupted one and
    // its (poisoned) tail must NOT become the anchor; we leave the anchor
    // pointing at the previous clean turn. killWarmSession later clears the
    // flag with the entry, so the next genuinely-clean turn advances again.
    const ws = getWarmSession(state.conversationId);
    if (ws && ws.needsColdRestart !== true && state.currentTurnLastAssistantUuid) {
      ws.lastCleanAssistantUuid = state.currentTurnLastAssistantUuid;
    }
    emit({ evt: "done", id, sessionAlive: true, conversationId: state.conversationId, terminalReason });
  } else {
    emit({ evt: "done", id, terminalReason });
  }
}

/**
 * (Re-)arm the deferred-done grace timer. Fires `done` only if, when the
 * window elapses, the turn is still pending with no active subagents and no
 * main-conversation wakeup has cancelled it. Re-arming replaces any earlier
 * timer so overlapping SubagentStop / task_notification events extend the
 * window instead of stacking emissions.
 */
function armDeferredDoneTimer(state: StreamProcessingState, emit: EmitFn): void {
  if (state.deferredDoneTimer) clearTimeout(state.deferredDoneTimer);
  state.deferredDoneTimer = setTimeout(() => {
    state.deferredDoneTimer = undefined;
    if (state.donePending && !state.doneEmitted && state.activeSubagentCount === 0) {
      process.stderr.write(
        `[claude-handler] Deferred done grace window elapsed — emitting done\n`,
      );
      emitTurnDone(state, emit, state.activeRequestId, state.terminalReason);
    }
  }, DEFERRED_DONE_GRACE_MS);
}

/** What a stream message means for a pending deferred `done`. */
export type DeferredDoneWakeAction = "cancel" | "extend" | null;

/**
 * Classify a stream message observed while `donePending` is set (the previous
 * turn's `result` arrived while background subagents were still running).
 *
 * - `"cancel"`  — main-conversation activity (assistant/user/stream_event with
 *   no `parent_tool_use_id`): the task-notification wakeup turn has started,
 *   so the pending `done` must be dropped and re-emitted by that turn's own
 *   `result`.
 * - `"extend"`  — a `task_notification` system message: the CLI has delivered
 *   the completion notice and a wakeup turn is imminent but has not produced
 *   messages yet; keep `done` pending but re-arm the grace timer.
 * - `null`      — subagent-internal or unrelated messages; no effect.
 */
export function classifyDeferredDoneWake(
  msg: Record<string, unknown>,
): DeferredDoneWakeAction {
  const msgType = msg.type as string | undefined;
  if (msgType === "system") {
    return (msg as { subtype?: string }).subtype === "task_notification" ? "extend" : null;
  }
  const isMainConversation = msg.parent_tool_use_id == null;
  if (isMainConversation && (msgType === "assistant" || msgType === "user" || msgType === "stream_event")) {
    return "cancel";
  }
  return null;
}

// ---------------------------------------------------------------------------
// Helper: Process a single stream message
// ---------------------------------------------------------------------------

/**
 * Process a single message from the SDK stream.
 *
 * Handles all message types: stream_event (text deltas), assistant (tool use),
 * user (tool results), result (completion + usage), and system (init).
 *
 * Mutates `state.fullText` and `state.sessionEmitted` as side effects.
 */
function processStreamMessage(
  msg: Record<string, unknown>,
  state: StreamProcessingState,
  emit: EmitFn,
  id: string,
  model: string,
): void {
  // A deferred `done` means the previous turn's `result` arrived while
  // background subagents were still running. Any subsequent main-conversation
  // activity proves the session is continuing (task-notification wakeup turn),
  // so the pending `done` must not fire — the resumed turn's own `result`
  // emits it instead.
  if (state.donePending && !state.doneEmitted) {
    const wake = classifyDeferredDoneWake(msg);
    if (wake === "cancel") {
      state.donePending = false;
      if (state.deferredDoneTimer) {
        clearTimeout(state.deferredDoneTimer);
        state.deferredDoneTimer = undefined;
      }
      process.stderr.write(
        `[claude-handler] Deferred done cancelled — main conversation resumed (type=${String(msg.type)})\n`,
      );
    } else if (wake === "extend") {
      armDeferredDoneTimer(state, emit);
      process.stderr.write(
        `[claude-handler] Deferred done extended — task_notification received, wakeup turn imminent\n`,
      );
    }
  }

  // Capture session_id from first message — also store for mid-stream messages
  if (!state.sessionEmitted && "session_id" in msg && msg.session_id) {
    const prevSessionId = state.resolvedSessionId;
    const newSessionId = msg.session_id as string;
    state.resolvedSessionId = newSessionId;
    emit({ evt: "session", id, sessionId: newSessionId });
    state.sessionEmitted = true;

    // Log session_id comparison for debugging resume behavior
    if (prevSessionId && prevSessionId !== newSessionId) {
      process.stderr.write(
        `[claude-handler] ⚠️ SESSION CHANGED: ` +
        `previous=${summarizeDiagnosticText(prevSessionId, "claude.session")} ` +
        `next=${summarizeDiagnosticText(newSessionId, "claude.session")} ` +
        `(resume may have created a new session)\n`,
      );
    } else if (prevSessionId && prevSessionId === newSessionId) {
      process.stderr.write(
        `[claude-handler] ✅ SESSION RESUMED: ` +
        `session=${summarizeDiagnosticText(newSessionId, "claude.session")} (same as requested)\n`,
      );
    } else {
      process.stderr.write(
        `[claude-handler] 🆕 SESSION STARTED: ` +
        `session=${summarizeDiagnosticText(newSessionId, "claude.session")} (no previous session)\n`,
      );
    }
  }

  switch (msg.type) {
    case "stream_event": {
      // Route by parent_tool_use_id: when present, the deltas belong to a
      // subagent's internal conversation and must NOT be appended to the
      // main conversation's fullText / thinkingReceivedViaStream state.
      const parentToolUseId = (msg as Record<string, unknown>).parent_tool_use_id as string | null | undefined;
      const subagentSessionId = (msg as Record<string, unknown>).session_id as string | undefined;
      const isSubagent = parentToolUseId != null;

      const event = (msg as { event: Record<string, unknown> }).event;

      if (event.type === "content_block_delta") {
        const delta = event.delta as { type: string; text?: string; thinking?: string } | undefined;
        if (delta?.type === "text_delta") {
          if (isSubagent) {
            emit({
              evt: "subagent_text_delta",
              id,
              subagentSessionId: subagentSessionId ?? "",
              parentToolUseId: parentToolUseId as string,
              delta: delta.text ?? "",
            });
          } else {
            state.fullText += delta.text ?? "";
            emit({ evt: "text_delta", id, delta: delta.text ?? "" });
          }
        }
        if (delta?.type === "thinking_delta") {
          if (isSubagent) {
            state.subagentThinkingReceivedViaStream = true;
            emit({
              evt: "subagent_thinking_delta",
              id,
              subagentSessionId: subagentSessionId ?? "",
              parentToolUseId: parentToolUseId as string,
              delta: delta.thinking ?? "",
            });
          } else {
            state.thinkingReceivedViaStream = true;
            emit({ evt: "thinking_delta", id, delta: delta.thinking ?? "" });
          }
        }
      }
      // Detect thinking block boundaries from content_block_start/stop.
      // The CLI forwards these metadata events even though it strips
      // thinking_delta content. Emit a thinking signal so the frontend
      // shows a "thinking…" indicator with timer.
      if (event.type === "content_block_start") {
        const contentBlock = (event as Record<string, unknown>).content_block as Record<string, unknown> | undefined;
        if (contentBlock?.type === "thinking") {
          if (isSubagent) {
            state.subagentThinkingReceivedViaStream = true;
            emit({
              evt: "subagent_thinking_delta",
              id,
              subagentSessionId: subagentSessionId ?? "",
              parentToolUseId: parentToolUseId as string,
              delta: "",
              startNewBlock: true,
            });
          } else if (!state.thinkingReceivedViaStream) {
            emit({ evt: "thinking_delta", id, delta: "", startNewBlock: true });
          }
        }
      }

      // message_start carries input token counts — emitted before the first
      // content delta, so the UI can show context size while waiting.
      if (event.type === "message_start") {
        const message = event.message as Record<string, unknown> | undefined;
        const usage = message?.usage as Record<string, number> | undefined;
        if (usage) {
          emit({
            evt: "stream_usage",
            id,
            inputTokens: usage.input_tokens ?? 0,
            outputTokens: usage.output_tokens ?? 0,
            cacheReadTokens: usage.cache_read_input_tokens ?? 0,
            cacheCreationTokens: usage.cache_creation_input_tokens ?? 0,
            contextWindow: getContextWindowForModel(model),
          });
        }
      }

      // message_delta carries accumulated output token count at stream end.
      if (event.type === "message_delta") {
        const usage = (event as Record<string, unknown>).usage as Record<string, number> | undefined;
        if (usage) {
          emit({
            evt: "stream_usage",
            id,
            inputTokens: 0,
            outputTokens: usage.output_tokens ?? 0,
            cacheReadTokens: 0,
            cacheCreationTokens: 0,
            contextWindow: 0,
          });
        }
      }
      break;
    }

    case "assistant": {
      // Track the last MAIN-conversation assistant message uuid of this turn
      // (subagent messages carry parent_tool_use_id and must not be the anchor).
      // Promoted to the warm session's resume anchor on clean completion.
      if (msg.parent_tool_use_id == null && typeof msg.uuid === "string" && msg.uuid) {
        state.currentTurnLastAssistantUuid = msg.uuid;
      }
      processAssistantMessage(msg, state, emit, id);
      break;
    }

    case "user": {
      // Note: UUID is no longer captured from stream messages here.
      // The checkpoint UUID is pre-generated and attached to the initial
      // SDKUserMessage before being sent to the CLI. This ensures the
      // UUID matches the CLI's internal fileHistory snapshot messageId.
      processUserMessage(msg, state, emit, id);
      break;
    }

    case "result": {
      processResultMessage(msg, state, emit, id, model);
      // Fast-mode observability: the CLI reports fast_mode_state on every result
      // (on = active, off = inactive/unauthorized, cooldown = rate-limited).
      process.stderr.write(
        `[fast-mode] fast_mode_state=${String((msg as Record<string, unknown>).fast_mode_state ?? "(absent)")}\n`,
      );

      // Diagnostic: log deferred-tool / terminal-reason details whenever a
      // turn ends without producing any text. The 0.3.x CLI can terminate a
      // turn with subtype=success + result="" when a tool is "deferred"
      // (terminal_reason="tool_deferred", deferred_tool_use set) instead of
      // executed. That looks like a normal completion to the frontend but
      // carries no content — e.g. health-check sees an empty orchestrator
      // response and silently resets. This log lets us confirm the cause in
      // environments we cannot reproduce locally (subscription/OAuth).
      {
        const r = msg as Record<string, unknown>;
        const deferred = r.deferred_tool_use as { name?: string; id?: string } | undefined;
        if (deferred || (state.fullText.length === 0 && msg.subtype === "success")) {
          process.stderr.write(
            `[claude-handler] result diagnostic: subtype=${msg.subtype}, ` +
            `terminal_reason=${String(r.terminal_reason ?? "(none)")}, ` +
            `stop_reason=${String(r.stop_reason ?? "(none)")}, ` +
            `num_turns=${String(r.num_turns ?? "?")}, fullTextLen=${state.fullText.length}, ` +
            `deferred_tool_use=${deferred ? `${deferred.name ?? "?"}#${(deferred.id ?? "").slice(0, 8)}` : "(none)"}\n`,
          );
        }
      }

      // When the SDK returns an error result (e.g. stale session resume,
      // process crash), do NOT emit complete/done here. The SDK will
      // throw an exception after this message, which the retry loop can
      // catch. Emitting complete/done prematurely causes the frontend to
      // clean up the stream request context via removeRequestAndSyncStreamState,
      // so all events from the retry attempt are silently ignored — the user
      // sees "No response received" even though the retry succeeds.
      //
      // The late complete/done checks after the retry loop (lines below) and
      // the outer catch block will handle final event emission correctly.
      if (msg.subtype === "error_during_execution") {
        process.stderr.write(
          `[claude-handler] Skipping complete/done for error result — ` +
          `will retry or propagate to outer catch\n`,
        );
        break;
      }

      // Every SDK turn produces exactly one `result` message, so we
      // unconditionally emit `complete` + `done` here. The previous
      // approach guarded on `!state.completeEmitted`, but that flag
      // races with `buildInteractivePrompt`'s per-turn state reset:
      // the generator resets `completeEmitted = false` before yielding
      // the mid-stream message, and the preceding turn's `result` can
      // "consume" the reset, leaving the second turn's `result` with
      // `completeEmitted = true` — skipping `done` and causing the
      // frontend to stay in "streaming" state forever.
      const finalText = state.fullText || (msg.result as string) || "";
      emit({ evt: "complete", id, fullText: finalText });
      state.completeEmitted = true;

      // If subagents are still running (e.g. teams mode where the
      // orchestrator dispatched tasks to background agents), defer
      // the `done` event until all subagents have stopped. This
      // keeps the frontend in "streaming" state so the chat UI
      // correctly shows the conversation as active.
      const terminalReason = typeof msg.terminal_reason === "string" ? msg.terminal_reason : undefined;

      if (state.activeSubagentCount > 0) {
        state.donePending = true;
        state.terminalReason = terminalReason;
        process.stderr.write(
          `[claude-handler] Deferring done — ${state.activeSubagentCount} subagent(s) still active\n`,
        );
      } else {
        emitTurnDone(state, emit, id, terminalReason);
      }

      // Reset per-turn accumulation so subsequent turns start fresh
      state.fullText = "";
      break;
    }

    case "system": {
      if (msg.subtype === "init") {
        // Handled in the outer for-await loop, where we can await
        // Query.supportedCommands() to enrich slashCommands with description /
        // argumentHint / aliases before emitting. Skip here to avoid a duplicate
        // simplified-version emit.
      } else if (msg.subtype === "compact_boundary") {
        const metadata = msg.compact_metadata as { trigger?: string; pre_tokens?: number } | undefined;
        emit({
          evt: "compact",
          id,
          trigger: (metadata?.trigger === "manual" ? "manual" : "auto") as "auto" | "manual",
          preTokens: typeof metadata?.pre_tokens === "number" ? metadata.pre_tokens : 0,
        });
      } else if (msg.subtype === "task_started") {
        const taskId = String(msg.task_id ?? "");
        const description = typeof msg.description === "string" ? msg.description : undefined;
        // SDK 0.3.170: task_started carries the (required) human-readable
        // description up front. Seed it as the task subject so a later
        // task_updated (whose patch usually only flips status) doesn't leave the
        // panel title falling back to the raw task_id. Silent — no emit, so the
        // set of tasks shown in the panel is unchanged.
        if (description) seedTaskFromStart(state.taskTrackerState, taskId, description);
        emit({
          evt: "task_started",
          id,
          taskId,
          description,
          taskType: typeof msg.task_type === "string" ? msg.task_type : undefined,
        });
      } else if (msg.subtype === "task_progress") {
        const usage = msg.usage as {
          total_tokens?: number;
          input_tokens?: number;
          output_tokens?: number;
          cache_read_input_tokens?: number;
          cache_creation_input_tokens?: number;
          tool_uses?: number;
          duration_ms?: number;
        } | undefined;
        emit({
          evt: "task_progress",
          id,
          taskId: String(msg.task_id ?? ""),
          totalTokens: usage?.total_tokens,
          inputTokens: usage?.input_tokens,
          outputTokens: usage?.output_tokens,
          cacheReadTokens: usage?.cache_read_input_tokens,
          cacheCreationTokens: usage?.cache_creation_input_tokens,
          toolUses: usage?.tool_uses,
          durationMs: usage?.duration_ms,
          lastToolName: typeof msg.last_tool_name === "string" ? msg.last_tool_name : undefined,
          summary: typeof msg.summary === "string" ? msg.summary : undefined,
        });
      } else if (msg.subtype === "task_notification") {
        const usage = msg.usage as {
          total_tokens?: number;
          input_tokens?: number;
          output_tokens?: number;
          cache_read_input_tokens?: number;
          cache_creation_input_tokens?: number;
          tool_uses?: number;
          duration_ms?: number;
        } | undefined;
        emit({
          evt: "task_notification",
          id,
          taskId: String(msg.task_id ?? ""),
          status: typeof msg.status === "string" ? msg.status : "unknown",
          summary: typeof msg.summary === "string" ? msg.summary : undefined,
          totalTokens: usage?.total_tokens,
          inputTokens: usage?.input_tokens,
          outputTokens: usage?.output_tokens,
          cacheReadTokens: usage?.cache_read_input_tokens,
          cacheCreationTokens: usage?.cache_creation_input_tokens,
          toolUses: usage?.tool_uses,
          durationMs: usage?.duration_ms,
        });
      } else if (msg.subtype === "task_updated") {
        const update = updateTaskTrackerFromLifecycle(
          state.taskTrackerState,
          state.previousTodos,
          "updated",
          msg,
        );
        if (update) {
          state.previousTodos = update.todos;
          state.previousTodosRef.current = update.todos;
          emit({ evt: "todo_updated", id, todos: update.todos, diff: update.diff });
        }
        const patch = msg.patch && typeof msg.patch === "object"
          ? JSON.stringify(msg.patch)
          : "{}";
        process.stderr.write(
          `[claude-handler] task_id=${summarizeDiagnosticText(String(msg.task_id ?? ""), "claude.task_id")} ` +
          `patch=${summarizeDiagnosticText(patch, "claude.task_patch")}\n`,
        );
      } else if (msg.subtype === "thinking_tokens") {
        process.stderr.write(
          `[claude-handler] system.thinking_tokens estimated=${String(msg.estimated_tokens ?? 0)} ` +
          `delta=${String(msg.estimated_tokens_delta ?? 0)}\n`,
        );
      } else if (msg.subtype === "api_retry") {
        // SDK 0.2.100+: transient API error retry notification
        const retry = summarizeClaudeApiRetry(msg);
        process.stderr.write(
          `[claude-handler] api_retry attempt=${retry.attempt} ` +
          `max_attempts=${retry.maxAttempts} status=${retry.errorStatus ?? "unknown"} ` +
          `delay_ms=${retry.retryDelayMs} ${retry.errorDiagnostic}\n`,
        );
        emit({
          evt: "stream_retry",
          id,
          attempt: retry.attempt,
          max_attempts: retry.maxAttempts,
          reason: retry.reason,
        });
      } else {
        const subtype = typeof msg.subtype === "string" ? msg.subtype : "(missing)";
        if (!UNKNOWN_SYSTEM_SUBTYPES_LOGGED.has(subtype)) {
          UNKNOWN_SYSTEM_SUBTYPES_LOGGED.add(subtype);
          process.stderr.write(
            `[claude-handler] Unknown system subtype=${subtype}, keys=[${Object.keys(msg).join(",")}]\n`,
          );
        }
      }
      break;
    }

    default:
      break;
  }
}

/** Process an assistant-type message — extract tool use blocks. */
function processAssistantMessage(
  msg: Record<string, unknown>,
  state: StreamProcessingState,
  emit: EmitFn,
  id: string,
): void {
  // SDK 0.2.120: when forwardSubagentText=true, subagent assistant messages
  // arrive with parent_tool_use_id != null and a distinct session_id. Thinking
  // blocks must be routed to the subagent panel channel, NOT the main bubble.
  const parentToolUseId = (msg.parent_tool_use_id as string | null | undefined) ?? null;
  const subagentSessionId = msg.session_id as string | undefined;
  const isSubagent = parentToolUseId != null;

  const message = msg.message as { content?: unknown } | undefined;
  const content = message?.content;
  if (!Array.isArray(content)) return;

  // Reset per-message thinking accumulator — each assistant message carries its
  // own thinking blocks, and prior-message lengths would otherwise cause shorter
  // new-block text to be swallowed by the `length > prevLen` guard below.
  state.thinkingBlockEmittedLens = [];
  let thinkingIdx = -1;

  for (const block of content) {
    const typedBlock = block as Record<string, unknown>;

    // --- Thinking block extraction (fallback for models like Opus 4.7 ---
    // whose interleaved thinking may not arrive via stream_event channel)
    // When stream_event already provided thinking deltas, skip to avoid duplicates.
    if (typedBlock.type === "thinking") {
      thinkingIdx += 1;
      if (isSubagent) {
        if (state.subagentThinkingReceivedViaStream) continue;
      } else {
        if (state.thinkingReceivedViaStream) continue;
      }
      const thinkingText = (typedBlock.thinking as string) ?? "";
      const prevLen = state.thinkingBlockEmittedLens[thinkingIdx] ?? 0;
      if (thinkingText && thinkingText.length > prevLen) {
        const isNewBlock = prevLen === 0;
        const delta = thinkingText.slice(prevLen);
        state.thinkingBlockEmittedLens[thinkingIdx] = thinkingText.length;
        if (isSubagent) {
          emit({
            evt: "subagent_thinking_delta",
            id,
            subagentSessionId: subagentSessionId ?? "",
            parentToolUseId: parentToolUseId as string,
            delta,
            startNewBlock: isNewBlock,
          });
        } else {
          emit({ evt: "thinking_delta", id, delta, startNewBlock: isNewBlock });
        }
      }
      continue;
    }

    // --- Text block extraction for subagents ---
    // SDK 0.2.120 with forwardSubagentText=true does NOT emit stream_event for
    // subagent text deltas; the only place subagent text appears is here in
    // the assistant message's content array. Main-conversation text still
    // arrives via stream_event, so we only handle subagent text here.
    if (typedBlock.type === "text") {
      if (isSubagent) {
        const text = (typedBlock.text as string) ?? "";
        if (text) {
          emit({
            evt: "subagent_text_delta",
            id,
            subagentSessionId: subagentSessionId ?? "",
            parentToolUseId: parentToolUseId as string,
            delta: text,
          });
        }
      }
      continue;
    }

    if (typedBlock.type !== "tool_use") continue;

    const toolInput = JSON.stringify(typedBlock.input);
    const blockId = typedBlock.id as string;
    const blockName = typedBlock.name as string;

    // Register for later tool_result lookup
    state.toolUseRegistry.set(blockId, {
      toolName: blockName,
      toolInput,
    });

    // Task description capture is now handled by PreToolUse(Task) hook —
    // no stream-parsing needed here.

    emit({
      evt: "tool_start",
      id,
      toolCallId: blockId,
      toolName: blockName,
      toolInput,
    });
  }
}

/** Extract readable text from a tool_result's `content`, which the Claude SDK
 *  may deliver as a plain string or as a content-block array
 *  [{type:"text",text:"..."}]. Extracting the text *before* truncation keeps
 *  long sub-agent (Task) output as readable text — stringifying the array first
 *  and then truncating would slice through the JSON, leaving the frontend
 *  unable to parse it (it would render the raw, broken JSON instead). */
function extractToolResultText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    const texts: string[] = [];
    for (const block of content) {
      if (block && typeof block === "object") {
        const b = block as Record<string, unknown>;
        if (typeof b.text === "string") texts.push(b.text);
        else if (typeof b.content === "string") texts.push(b.content);
      } else if (typeof block === "string") {
        texts.push(block);
      }
    }
    if (texts.length > 0) return texts.join("\n");
  }
  return JSON.stringify(content);
}

/** Process a user-type message — extract tool result blocks. */
function processUserMessage(
  msg: Record<string, unknown>,
  state: StreamProcessingState,
  emit: EmitFn,
  id: string,
): void {
  const message = msg.message as { content?: unknown } | undefined;
  const content = message?.content;
  if (!Array.isArray(content)) return;

  for (const block of content) {
    const typedBlock = block as Record<string, unknown>;
    if (typedBlock.type !== "tool_result") continue;

    const resultText = extractToolResultText(typedBlock.content);
    const toolUseId = (typedBlock.tool_use_id as string) ?? "";
    // Look up the original tool name/input from the registry
    const registered = state.toolUseRegistry.get(toolUseId);
    emit({
      evt: "tool_result",
      id,
      toolCallId: toolUseId,
      toolName: registered?.toolName ?? "",
      toolInput: registered?.toolInput ?? "",
      success: !typedBlock.is_error,
      result: truncate(resultText),
      display: defaultToolDisplay(!typedBlock.is_error),
    });
    // Clean up after use
    if (registered) {
      state.toolUseRegistry.delete(toolUseId);
    }
  }
}

/** Process a result-type message — capture final text and usage data. */
function processResultMessage(
  msg: Record<string, unknown>,
  state: StreamProcessingState,
  emit: EmitFn,
  id: string,
  model: string,
): void {
  const apiErrorStatus = extractApiErrorStatus(msg);
  if (apiErrorStatus !== undefined) {
    state.lastApiErrorStatus = apiErrorStatus;
  }

  // Final result — only use msg.result if no deltas were streamed.
  // When tools are used, text_delta events accumulate the full
  // conversation text, while msg.result contains only the final
  // assistant turn summary — using it would discard all prior text.
  if (msg.subtype === "success" && !state.fullText) {
    state.fullText = msg.result as string;
  }

  // Extract usage data from the result message
  try {
    const usage = msg.usage as UsageData | undefined;
    const modelUsage = msg.modelUsage as Record<string, { contextWindow?: number }> | undefined;
    const totalCost = (msg.total_cost_usd as number) ?? 0;
    const primaryModel = model || "claude-sonnet-4-20250514";

    if (usage) {
      // Prefer our local model table over the SDK-reported value. The Claude Code
      // binary falls back to a default 200k contextWindow for third-party models
      // routed via ANTHROPIC_BASE_URL (e.g. GLM, whose real window is 1M), which
      // understates them. Use the SDK value only for models we don't know locally.
      const contextWindow =
        getContextWindowForModel(primaryModel) || modelUsage?.[primaryModel]?.contextWindow || 0;
      const cacheRead = usage.cache_read_input_tokens ?? 0;
      const cacheCreate = usage.cache_creation_input_tokens ?? 0;
      // [CACHE-DIAG] one-line summary per turn for trend inspection
      process.stderr.write(
        `[cache-diag] result request=${summarizeDiagnosticText(id, "claude.request")} ` +
        `cache_read=${cacheRead} cache_create=${cacheCreate} ` +
        `input=${usage.input_tokens ?? 0} output=${usage.output_tokens ?? 0} ` +
        `verdict=${cacheRead > 0 ? "HIT" : "MISS"}\n`,
      );
      emit({
        evt: "usage",
        id,
        inputTokens: usage.input_tokens ?? 0,
        outputTokens: usage.output_tokens ?? 0,
        cacheReadTokens: cacheRead,
        cacheCreationTokens: cacheCreate,
        totalCostUsd: totalCost,
        contextWindow,
        model: primaryModel,
      });
    }
  } catch {
    // Non-critical — usage extraction failure should not block the response
  }
}

// ---------------------------------------------------------------------------
// Helper: Build retry prompt parameter
// ---------------------------------------------------------------------------


// ---------------------------------------------------------------------------
// Lightweight init — mirror the formal build by starting a query only long
// enough to capture system:init, then abort it before model output begins.
// ---------------------------------------------------------------------------

export async function handleClaudeInit(
  cmd: InitSessionCommand,
  emit: EmitFn,
  activeAbortControllers: Map<string, AbortController>,
): Promise<void> {
  const { id, cwd, apiKey, baseUrl, platform } = cmd;

  if (hasWarmSessionForAgent("claude")) {
    process.stderr.write(
      `[claude-prewarm:${id}] Active Claude warm session exists — skip prewarm\n`,
    );
    emit({ evt: "done", id });
    return;
  }

  const releaseCredentialLock = await acquireCredentialLock();
  const savedEnv = await applyCredentials(
    platform,
    apiKey,
    baseUrl,
    cmd.model,
    cmd.proxyUrl,
  );

  const abortController = new AbortController();
  activeAbortControllers.set(id, abortController);

  try {
    const claudePath = findClaudeCodePath();
    if (!claudePath) {
      emit({ evt: "done", id });
      return;
    }

    const options: Options = {
      model: cmd.model,
      cwd,
      abortController,
      includePartialMessages: true,
      pathToClaudeCodeExecutable: claudePath,
      allowedTools: [],
      settingSources: ["user", "project", "local"],
      ...(cmd.ultracode === true
        ? {
            thinking: {
              type: "adaptive",
              display: "summarized",
            } as ThinkingConfig,
            effort: "xhigh" as EffortLevel,
          }
        : {}),
      ...(cmd.ultracode === true || cmd.fastMode === true
        ? {
            extraArgs: {
              settings: JSON.stringify({
                ...(cmd.ultracode === true
                  ? { ultracode: true, enableWorkflows: true }
                  : {}),
                ...(cmd.fastMode === true ? { fastMode: true } : {}),
              }),
            },
          }
        : {}),
    };

    options.env = captureClaudeProviderEnvironment();
    if (cmd.fastMode === true) {
      options.env = {
        ...options.env,
        CLAUDE_CODE_SKIP_FAST_MODE_ORG_CHECK: "1",
      };
    }

    options.stderr = (msg: string) => {
      process.stderr.write(
        `[claude-cli] ${summarizeDiagnosticText(msg, "claude.prewarm.stderr")}\n`,
      );
    };

    if (cmd.mcpServers && Object.keys(cmd.mcpServers).length > 0) {
      const { valid, skipped } = filterValidMcpServers(cmd.mcpServers);
      for (const skippedServer of skipped) {
        process.stderr.write(
          `[mcp-validate] Skipping MCP server '${skippedServer.name}' — ${skippedServer.reason}\n`,
        );
      }
      if (Object.keys(valid).length > 0) {
        options.mcpServers =
          process.platform === "win32"
            ? resolveWindowsMcpServers(
                valid as Record<string, McpServerConfigRaw>,
              )
            : valid;
      }
    }

    const warmQuery: WarmQuery = await startup({ options });
    const result = warmQuery.query("hi");

    for await (const msg of result) {
      if (abortController.signal.aborted) break;

      if (
        msg.type === "system" &&
        (msg as Record<string, unknown>).subtype === "init"
      ) {
        const raw = msg as Record<string, unknown>;
        const simplifiedNames = Array.isArray(raw.slash_commands)
          ? (raw.slash_commands as string[])
          : [];
        let slashCommands: ReadonlyArray<SlashCommandInfo>;
        try {
          const commands = await result.supportedCommands();
          slashCommands = commands.map((command) => ({
            name: command.name,
            description: command.description ?? "",
            argumentHint: command.argumentHint || undefined,
            aliases:
              command.aliases && command.aliases.length > 0
                ? command.aliases
                : undefined,
          }));
        } catch {
          slashCommands = simplifiedNames.map((name) => ({
            name,
            description: "",
          }));
        }

        emit({
          evt: "system_init",
          id,
          tools: Array.isArray(raw.tools) ? (raw.tools as string[]) : [],
          mcpServers: Array.isArray(raw.mcp_servers)
            ? (raw.mcp_servers as Array<{ name: string; status: string }>)
            : [],
          model: typeof raw.model === "string" ? raw.model : cmd.model,
          fastModeState:
            typeof raw.fast_mode_state === "string"
              ? raw.fast_mode_state
              : undefined,
          slashCommands,
        });
        abortController.abort();
        break;
      }

      if (msg.type === "result") break;
    }

    emit({ evt: "done", id });
  } catch {
    emit({ evt: "done", id });
  } finally {
    activeAbortControllers.delete(id);
    restoreCredentials(savedEnv);
    releaseCredentialLock();
  }
}

// ---------------------------------------------------------------------------
// Interactive prompt generator — combines initial message + mid-stream input
// ---------------------------------------------------------------------------

/**
 * Build a single AsyncIterable that yields the initial user message first,
 * then waits for mid-stream user messages pushed to the PromptChannel.
 *
 * This MUST be a single iterable because the SDK's `query()` function calls
 * `streamInput(prompt)` internally when the prompt is an AsyncIterable.
 * When `streamInput` finishes iterating, it calls `transport.endInput()` to
 * close stdin to the CLI process. If we used a separate `result.streamInput()`
 * call for mid-stream messages, the initial prompt's `streamInput` would
 * close stdin first, preventing any subsequent writes.
 *
 * By merging both into one generator, stdin stays open as long as the
 * generator is alive (waiting on PromptChannel).
 */
function buildInteractivePrompt(
  channel: PromptChannel,
  state: StreamProcessingState,
  emit: EmitFn,
  requestId: string,
  initialMessage: SDKUserMessage,
): AsyncIterable<SDKUserMessage> {
  async function* generate(): AsyncGenerator<SDKUserMessage> {
    // Yield the initial user message first
    process.stderr.write(`[buildInteractivePrompt] yielding initial message\n`);
    yield initialMessage;
    process.stderr.write(`[buildInteractivePrompt] initial message consumed by SDK, entering mid-stream wait loop\n`);

    // Then wait for subsequent messages (mid-stream or persistent session turns).
    // All waits use the channel's default idle timeout (SESSION_IDLE_TIMEOUT_MS)
    // so the CLI process stays alive between turns.
    let midStreamTurnCount = 0;
    while (true) {
      process.stderr.write(`[buildInteractivePrompt] waiting for message #${midStreamTurnCount + 1} (timeout=channel-default)\n`);
      const channelMsg = await channel.waitForMessage();
      if (channelMsg === null) {
        process.stderr.write(`[buildInteractivePrompt] waitForMessage returned null — generator ending\n`);
        break;
      }

      midStreamTurnCount++;

      // Warm session redirect: update the active request ID so all events
      // for this turn are emitted with the frontend's expected requestId.
      if (channelMsg.requestId) {
        const oldReqId = state.activeRequestId;
        process.stderr.write("[buildInteractivePrompt] warm session redirect\n");
        state.activeRequestId = channelMsg.requestId;

        // Migrate activePromptChannels to new requestId (defensive —
        // primary migration is in index.ts warm session routing)
        if (oldReqId !== channelMsg.requestId) {
          const ch = activePromptChannels.get(oldReqId);
          if (ch) {
            activePromptChannels.delete(oldReqId);
            activePromptChannels.set(channelMsg.requestId, ch);
          }
        }
      }

      process.stderr.write(`[buildInteractivePrompt] received mid-stream message #${midStreamTurnCount} (contentLen=${channelMsg.text.length})\n`);

      // Reset per-turn flags. The `result` handler now unconditionally
      // emits `complete`/`done`, so these resets only matter for the
      // subagent-deferral path (`donePending`).
      state.completeEmitted = false;
      state.doneEmitted = false;
      state.donePending = false;
      if (state.deferredDoneTimer) {
        clearTimeout(state.deferredDoneTimer);
        state.deferredDoneTimer = undefined;
      }
      state.contextUsageScheduledForRequestId = undefined;
      // Clear the per-turn assistant-uuid tracker so this turn's anchor is
      // computed only from messages produced after this user message.
      state.currentTurnLastAssistantUuid = undefined;

      // Notify the frontend that a new turn is about to start
      process.stderr.write(`[buildInteractivePrompt] emitting new_turn event\n`);
      emit({ evt: "new_turn", id: state.activeRequestId, commandName: channelMsg.commandInvocation?.canonicalName });

      process.stderr.write(`[buildInteractivePrompt] yielding mid-stream message to SDK\n`);

      // Build message content: if images are present, use content blocks
      // (matching the initial message format); otherwise plain text.
      const hasImages = channelMsg.images && channelMsg.images.length > 0;
      const messageContent = hasImages
        ? [
            ...channelMsg.images!.map((img) => ({
              type: "image" as const,
              source: {
                type: "base64" as const,
                media_type: img.media_type,
                data: img.data,
              },
            })),
            // Only add text block if text is non-empty — Claude API rejects empty text blocks
            ...(channelMsg.text ? [{ type: "text" as const, text: channelMsg.text }] : []),
          ]
        : (channelMsg.text || " ");

      yield {
        type: "user" as const,
        message: { role: "user" as const, content: messageContent },
        parent_tool_use_id: null,
        session_id: state.resolvedSessionId,
      } as unknown as SDKUserMessage;
      process.stderr.write(`[buildInteractivePrompt] mid-stream message #${midStreamTurnCount} consumed by SDK\n`);
    }
    process.stderr.write(`[buildInteractivePrompt] generator finished (total mid-stream turns: ${midStreamTurnCount})\n`);
  }
  return generate();
}

// ---------------------------------------------------------------------------
// Transient error detection for automatic retry
// ---------------------------------------------------------------------------

/**
 * Detect transient/network errors that may be retried.
 * Covers common Node.js network error codes and error messages
 * from HTTP/SSE stream interruptions.
 */
function isTransientError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  const code = (err as { code?: string })?.code;
  const networkCodes = [
    "ECONNRESET", "ETIMEDOUT", "EPIPE", "ECONNREFUSED",
    "EHOSTUNREACH", "ENOTFOUND", "ENETUNREACH", "EAI_AGAIN",
    "ECONNABORTED",
  ];
  if (code && networkCodes.includes(code)) return true;

  return /socket hang up|broken pipe|network|fetch failed|ECONNRESET|ETIMEDOUT|ECONNREFUSED|connection.*(reset|refused|timeout|closed)|stream.*terminated|unexpected.*(end|close)|premature close|process exited with code|process terminated by signal/i.test(msg);
}

/** Detect CLI process crash errors (exit code != 0 or killed by signal). */
function isProcessExitError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /process exited with code|process terminated by signal/i.test(msg);
}

/**
 * Detect "session not found" errors from Claude SDK when resuming a stale/missing session.
 * Happens when the JSONL file was never written (crash between session_id emission and
 * JSONL flush) or was corrupted/deleted. On this error we MUST NOT retry with the same
 * sessionId — it will never succeed. Instead, retry without resume to start a fresh session.
 */
function isSessionNotFoundError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /no conversation found|session.*(not found|does not exist|invalid|expired|missing)/i.test(msg);
}

/** Maximum number of query attempts (1 original + up to 4 retries). */
const MAX_QUERY_ATTEMPTS = 5;

export async function handleClaudeQuery(
  cmd: QueryCommand,
  emit: EmitFn,
  activeAbortControllers: Map<string, AbortController>,
): Promise<void> {
  const { id, prompt, model, permissionMode, sessionId, images, apiKey, platform } = cmd;
  const baseUrl = cmd.baseUrl;

  // Acquire credential lock to prevent concurrent requests with different
  // providers from interleaving env-var mutations.  The lock covers the
  // window from applyCredentials() → CLI process spawn → restoreCredentials().
  // For persistent sessions the lock is released early (after the first
  // stream message) because the CLI subprocess has already inherited the
  // env vars at fork time and the parent can safely restore them.
  // NOTE: `let` instead of `const` — these are reassigned on retry.
  let releaseCredentialLock = await acquireCredentialLock();

  let savedEnv = await applyCredentials(platform, apiKey, baseUrl, model, cmd.proxyUrl);
  let credentialReleased = false;

  /** Release credential lock + restore env vars exactly once. */
  const releaseCredentials = () => {
    if (credentialReleased) return;
    credentialReleased = true;
    restoreCredentials(savedEnv);
    releaseCredentialLock();
  };

  let abortController = new AbortController();
  activeAbortControllers.set(id, abortController);

  const permConfig = buildPermissionConfig(permissionMode, id, emit);

  const previousTodosRef: PreviousTodosRef = { current: [] };

  // Mutable state shared across stream processing
  const state: StreamProcessingState = {
    fullText: "",
    sessionEmitted: false,
    completeEmitted: false,
    doneEmitted: false,
    donePending: false,
    lastApiErrorStatus: undefined,
    resolvedSessionId: sessionId ?? "",
    activeSubagentCount: 0,
    toolUseRegistry: new Map(),
    pendingTaskDescriptions: new Map(),
    taskTrackerState: createTaskTrackerState(),
    previousTodosRef,
    previousTodos: [],
    conversationId: cmd.conversationId,
    activeRequestId: id,
    currentTurnLastAssistantUuid: undefined,
    contextUsageScheduledForRequestId: undefined,
    thinkingReceivedViaStream: false,
    subagentThinkingReceivedViaStream: false,
    thinkingBlockEmittedLens: [],
    stderrBuffer: [],
    diagnosticSecrets: collectCliDiagnosticSecrets({
      apiKey,
      baseUrl: cmd.baseUrl,
      proxyUrl: cmd.proxyUrl,
      mcpServers: cmd.mcpServers,
    }),
  };

  // Create a PromptChannel for multi-turn message injection.
  // The idle timeout determines how long the CLI process stays alive between
  // turns. For persistent sessions (with conversationId), use 30-minute
  // timeout to keep the process warm. For non-persistent sessions, use a
  // shorter timeout.
  const isPersistentSession = !!cmd.conversationId;
  const channelTimeout = isPersistentSession
    ? SESSION_IDLE_TIMEOUT_MS
    : 120_000;
  let currentPromptChannel = new PromptChannel(channelTimeout);
  replaceActivePromptChannel(id, currentPromptChannel);

  try {
    const claudePath = findClaudeCodePath();
    if (!claudePath) {
      emit({
        evt: "error",
        id,
        error: "Claude Code is not installed. Please install it first: https://docs.anthropic.com/en/docs/claude-code",
      });
      emit({ evt: "done", id });
      return;
    }

    const options = buildQueryOptions(cmd, claudePath, permConfig, abortController, emit, state.pendingTaskDescriptions, previousTodosRef, state);

    // Determine if this is a valid Claude session we can resume.
    const isNonClaudeSession = sessionId
      && (sessionId.startsWith("oai-") || sessionId.startsWith("gem-") || sessionId.startsWith("ccmpl-"));
    const isResuming = !!(sessionId && !isNonClaudeSession);

    // Build effective prompt text (with optional conversation history context)
    const effectivePrompt = buildEffectivePromptText(cmd, prompt, sessionId);

    // Generate a UUID for the initial user message and emit it to the frontend
    // BEFORE yielding the message. The CLI uses this UUID as the checkpoint
    // messageId in fileHistory, which rewindFiles() later looks up.
    const promptUuid = randomUUID();
    emit({ evt: "user_message_uuid", id, uuid: promptUuid });

    // Build initial SDK user message with the pre-generated UUID.
    // This is wrapped in buildInteractivePrompt() which also handles
    // mid-stream messages from the PromptChannel.
    let initialMessage: SDKUserMessage;
    if (images && images.length > 0) {
      const contentBlocks = [
        ...images.map((img: ImageData) => ({
          type: "image" as const,
          source: {
            type: "base64" as const,
            media_type: img.media_type,
            data: img.data,
          },
        })),
        // Only add text block if text is non-empty — Claude API rejects empty text blocks
        ...(effectivePrompt ? [{ type: "text" as const, text: effectivePrompt }] : []),
      ];
      initialMessage = {
        type: "user" as const,
        message: { role: "user" as const, content: contentBlocks },
        parent_tool_use_id: null,
        session_id: sessionId ?? "",
        uuid: promptUuid,
      } as unknown as SDKUserMessage;
    } else {
      initialMessage = {
        type: "user" as const,
        message: { role: "user" as const, content: effectivePrompt || " " },
        parent_tool_use_id: null,
        session_id: sessionId ?? "",
        uuid: promptUuid,
      } as unknown as SDKUserMessage;
    }

    // Build prompt as an interactive AsyncIterable that yields the initial
    // message first, then waits for mid-stream messages from the PromptChannel.
    // IMPORTANT: This MUST be a single iterable passed to query(). The SDK
    // calls streamInput(prompt) internally and closes stdin when the iterable
    // ends. Using a separate result.streamInput() call would cause a race
    // where the initial prompt's streamInput closes stdin first.
    let promptParam: QueryPromptParam = buildInteractivePrompt(
      currentPromptChannel, state, emit, id, initialMessage,
    ) as unknown as QueryPromptParam;

    // Retry loop: if session resume fails (stale session after app restart),
    // retry once without resume and inject conversation history as context.
    for (let _attempt = 0; _attempt < MAX_QUERY_ATTEMPTS; _attempt++) {
      try {
        state.sessionEmitted = false;
        state.completeEmitted = false;
        // Use startup() to pre-initialize the CLI process, then send the prompt
        // via warmQuery.query(). This separates process init from prompt delivery,
        // reducing time-to-first-token after initialization completes.
        const warmQuery: WarmQuery = await startup({ options });
        const result = warmQuery.query(promptParam);

        // Store the Query reference so rewindFiles() can be called between
        // turns while the async iterator is still alive (keepalive window).
        activeQueries.set(id, result);

        // Register persistent (warm) session so subsequent queries for
        // this conversation can be routed to the existing channel.
        if (isPersistentSession && cmd.conversationId) {
          registerWarmSession({
            conversationId: cmd.conversationId,
            requestId: id,
            channel: currentPromptChannel,
            abortController,
            model,
            platform: cmd.platform ?? "",
            cwd: cmd.cwd,
            credentialHash: hashCredentials(cmd.apiKey ?? "", cmd.baseUrl ?? "", cmd.authMode ?? "apiKey", cmd.profileId ?? "", cmd.proxyUrl ?? ""),
            permissionMode: cmd.permissionMode ?? "",
            mcpServerKeys: cmd.mcpServers
              ? Object.keys(cmd.mcpServers).sort().join(",")
              : "",
            thinkingEnabled: cmd.thinkingEnabled,
            reasoningLevel: cmd.reasoningLevel,
            ultracode: cmd.ultracode,
            fastMode: cmd.fastMode,
            cavemanMode: cmd.cavemanMode,
            // [DIAG] Record systemPrompt fingerprint + disableTools so a later reuse can
            // log whether these drifted (metadataMatches ignores them → silent reuse).
            systemPromptHash: hashForDebug(cmd.systemPrompt ?? ""),
            disableTools: cmd.disableTools,
            agent: "claude",
            lastActivityMs: Date.now(),
          });
        }

        // Mid-stream messages are handled by the interactive prompt generator
        // passed to query() above — no separate streamInput() call needed.

        let msgCount = 0;
        let lastHeartbeatMs = Date.now();
        // Probe SDK slash-command metadata once per query — see system_init branch below.
        let slashCommandsInspected = false;
        for await (const msg of result) {
          if (abortController.signal.aborted) {
            process.stderr.write(`[claude-handler] Aborted after ${msgCount} messages\n`);
            break;
          }
          msgCount++;

          // Keep warm session alive during long-running tool_use loops.
          // Throttled to once per 30s to avoid Map lookups on every message.
          if (isPersistentSession && cmd.conversationId) {
            const now = Date.now();
            if (now - lastHeartbeatMs > 30_000) {
              lastHeartbeatMs = now;
              const ws = getWarmSession(cmd.conversationId);
              if (ws) ws.lastActivityMs = now;
            }
          }

          // Release credential lock after the first message — the CLI
          // subprocess has been forked and inherited the env vars.
          // This unblocks concurrent init_session / query calls.
          if (msgCount === 1) {
            releaseCredentials();
          }

          const msgType = (msg as Record<string, unknown>).type;
          const msgSubtype = (msg as Record<string, unknown>).subtype;
          // System init enrichment — emit slash_commands with full metadata.
          // SDK's `system.init` only carries `slash_commands: string[]` (names);
          // Query.supportedCommands() returns the full SlashCommand[] including
          // description, argumentHint, and aliases. We await it once per query
          // (typically <2ms) and emit a single enriched system_init event.
          // processStreamMessage's `case "system" → init` branch is intentionally
          // a no-op so we don't double-emit.
          if (msgType === "system" && msgSubtype === "init" && !slashCommandsInspected) {
            slashCommandsInspected = true;
            const initMsg = msg as Record<string, unknown>;
            const simplifiedNames = Array.isArray(initMsg.slash_commands)
              ? (initMsg.slash_commands as string[])
              : [];

            let slashCommands: ReadonlyArray<SlashCommandInfo>;
            try {
              const t0 = Date.now();
              const cmds = await result.supportedCommands();
              const elapsed = Date.now() - t0;
              slashCommands = cmds.map((c) => ({
                name: c.name,
                description: c.description ?? "",
                argumentHint: c.argumentHint ? c.argumentHint : undefined,
                aliases: c.aliases && c.aliases.length > 0 ? c.aliases : undefined,
              }));
              process.stderr.write(
                `[claude-handler] supportedCommands() OK in ${elapsed}ms, count=${slashCommands.length} ` +
                  `(init simplified count=${simplifiedNames.length})\n`,
              );
            } catch (err) {
              // Fallback: degrade to simplified names with empty descriptions.
              slashCommands = simplifiedNames.map((n) => ({ name: n, description: "" }));
              const safeError = redactCliDiagnostic(
                err instanceof Error ? err.message : String(err),
                state.diagnosticSecrets,
              );
              process.stderr.write(
                `[claude-handler] supportedCommands() failed, using simplified names: ` +
                  `${summarizeDiagnosticText(safeError, "claude.supported_commands")}\n`,
              );
            }

            emit({
              evt: "system_init",
              id: state.activeRequestId,
              tools: Array.isArray(initMsg.tools) ? (initMsg.tools as string[]) : [],
              mcpServers: Array.isArray(initMsg.mcp_servers)
                ? (initMsg.mcp_servers as Array<{ name: string; status: string }>)
                : [],
              model: typeof initMsg.model === "string" ? initMsg.model : model,
              fastModeState: typeof initMsg.fast_mode_state === "string" ? initMsg.fast_mode_state : undefined,
              slashCommands,
            });
          }

          processStreamMessage(msg as Record<string, unknown>, state, emit, state.activeRequestId, model);
          if (msgType === "result" && state.doneEmitted && !state.donePending && !abortController.signal.aborted) {
            scheduleContextUsageSnapshotOnceAfterDone(result, state, emit, "done", model);
          }
        }

        process.stderr.write(
          `[claude-handler] Query loop ended: attempt=${_attempt}, msgs=${msgCount}, ` +
          `fullText.length=${state.fullText.length}, completeEmitted=${state.completeEmitted}, ` +
          `doneEmitted=${state.doneEmitted}\n`,
        );

        // ── Premature stream end detection ──
        // If the for-await loop ended without a `result` message for the
        // current turn, the stream was interrupted (CLI process crash from
        // network error, OS signal, or resource exhaustion). Retry with
        // session resume to regenerate the response.
        const streamEndedPrematurely = !state.completeEmitted
          && !abortController.signal.aborted
          && !!state.resolvedSessionId
          && _attempt < MAX_QUERY_ATTEMPTS - 1;

        if (streamEndedPrematurely) {
          process.stderr.write(
            `[claude-handler] Stream ended prematurely (no result message), ` +
            `attempting retry: attempt=${_attempt}, fullText.length=${state.fullText.length}, ` +
            `session=${summarizeDiagnosticText(state.resolvedSessionId, "claude.session")}\n`,
          );

          // Notify frontend to clear partial content and stay in streaming state
          emit({ evt: "stream_retry", id, attempt: _attempt + 1, max_attempts: MAX_QUERY_ATTEMPTS, reason: "stream_interrupted" });

          // Exponential backoff: 2s, 4s
          const backoffMs = 2_000 * Math.pow(2, _attempt);
          await new Promise<void>((r) => setTimeout(r, backoffMs));

          // Reset state for retry
          state.fullText = "";
          state.completeEmitted = false;
          state.doneEmitted = false;
          state.donePending = false;
          state.toolUseRegistry.clear();

          // Re-acquire credentials for the new CLI process
          credentialReleased = false;
          releaseCredentialLock = await acquireCredentialLock();
          savedEnv = await applyCredentials(platform, apiKey, baseUrl, model, cmd.proxyUrl);
          process.stderr.write(
            `[claude-handler] Credential lock re-acquired for retry ` +
            `request=${summarizeDiagnosticText(id, "claude.request")}\n`,
          );

          // Fresh abort controller
          abortController = new AbortController();
          activeAbortControllers.set(id, abortController);
          options.abortController = abortController;

          // Resume from saved session
          (options as Record<string, unknown>).resume = state.resolvedSessionId;

          // Fresh channel
          const retryCh = new PromptChannel(channelTimeout);
          replaceActivePromptChannel(id, retryCh);
          currentPromptChannel = retryCh;

          // Build retry prompt — reuse original prompt text with resume
          const retryUuid = randomUUID();
          emit({ evt: "user_message_uuid", id, uuid: retryUuid });
          const retryMsg: SDKUserMessage = {
            type: "user" as const,
            message: { role: "user" as const, content: prompt },
            parent_tool_use_id: null,
            session_id: state.resolvedSessionId,
            uuid: retryUuid,
          } as unknown as SDKUserMessage;
          promptParam = buildInteractivePrompt(
            retryCh, state, emit, id, retryMsg,
          ) as unknown as QueryPromptParam;

          continue; // retry
        }

        // Query completed normally — exit retry loop.
        break;
      } catch (queryErr: unknown) {
        const errMsg = queryErr instanceof Error ? queryErr.message : String(queryErr);
        const safeQueryError = redactCliDiagnostic(
          errMsg,
          state.diagnosticSecrets,
        );
        const isPromptTooLong = /prompt.*(is\s+)?too\s+long/i.test(errMsg);
        const isTransient = isTransientError(queryErr);
        const isProcessExit = isProcessExitError(queryErr);
        const isSessionNotFound = isSessionNotFoundError(queryErr);

        // Allow retry when:
        // 1. Resume failed (stale session after app restart) — retry WITH resume
        //    (SDK will spawn a fresh CLI process that reads the JSONL file)
        // 2. Prompt-too-long — retry WITHOUT resume (context too large)
        // 3. Transient/network error with a valid session ID — retry with resume
        // 4. Process exit error — first retry with resume, second retry WITHOUT
        //    resume (session state may be corrupted)
        // 5. Session-not-found — retry WITHOUT resume (JSONL missing/corrupted,
        //    resume would loop forever with the same stale sessionId)
        const canRetry = _attempt < MAX_QUERY_ATTEMPTS - 1
          && !abortController.signal.aborted
          && (
            (_attempt === 0 && !state.fullText && (isResuming || isPromptTooLong))
            || (isTransient && !!state.resolvedSessionId)
          );

        process.stderr.write(
          `[claude-handler] Query error: attempt=${_attempt}, canRetry=${canRetry}, ` +
          `isResuming=${isResuming}, isPromptTooLong=${isPromptTooLong}, ` +
          `isTransient=${isTransient}, isSessionNotFound=${isSessionNotFound}, ` +
          `fullText.length=${state.fullText.length}, aborted=${abortController.signal.aborted}, ` +
          `error=${summarizeDiagnosticText(safeQueryError, "claude.query_error")}\n`,
        );

        if (canRetry) {
          // ── Retry WITH resume (transient error, or resume failed but session is valid) ──
          // The SDK's query({ resume }) spawns a fresh CLI process that reads the
          // JSONL file — it does NOT need the old process to be alive. This is the
          // same as `claude --resume <id>` in the terminal.
          // For process exit errors: first retry with resume, second retry
          // WITHOUT resume to avoid infinite resume→crash loops when the
          // session state is corrupted.
          // For session-not-found: NEVER retry with the same stale sessionId.
          const shouldRetryWithResume = !isPromptTooLong
            && !isSessionNotFound
            && (state.resolvedSessionId || sessionId)
            && !(isProcessExit && _attempt > 0);

          if (shouldRetryWithResume) {
            const resumeId = state.resolvedSessionId || sessionId!;
            process.stderr.write(
              `[claude-handler] Retrying WITH resume (attempt=${_attempt}, ` +
              `resumeSet=true, isTransient=${isTransient}): ` +
              `${summarizeDiagnosticText(safeQueryError, "claude.retry_error")}\n`,
            );
            emit({ evt: "stream_retry", id, attempt: _attempt + 1, max_attempts: MAX_QUERY_ATTEMPTS, reason: isTransient ? "network_error" : "resume_retry" });

            // Exponential backoff: 2s, 4s
            const backoffMs = 2_000 * Math.pow(2, _attempt);
            await new Promise<void>((r) => setTimeout(r, backoffMs));

            // Reset state for retry
            state.fullText = "";
            state.completeEmitted = false;
            state.doneEmitted = false;
            state.donePending = false;
            state.toolUseRegistry.clear();

            // Re-acquire credentials for the new CLI process
            credentialReleased = false;
            releaseCredentialLock = await acquireCredentialLock();
            savedEnv = await applyCredentials(platform, apiKey, baseUrl, model, cmd.proxyUrl);
            process.stderr.write(
              `[claude-handler] Credential lock re-acquired for retry ` +
              `request=${summarizeDiagnosticText(id, "claude.request")}\n`,
            );

            abortController = new AbortController();
            activeAbortControllers.set(id, abortController);
            options.abortController = abortController;

            (options as Record<string, unknown>).resume = resumeId;

            const retryCh = new PromptChannel(channelTimeout);
            replaceActivePromptChannel(id, retryCh);
            currentPromptChannel = retryCh;

            const retryUuid = randomUUID();
            emit({ evt: "user_message_uuid", id, uuid: retryUuid });
            const retryMsg: SDKUserMessage = {
              type: "user" as const,
              message: { role: "user" as const, content: prompt },
              parent_tool_use_id: null,
              session_id: resumeId,
              uuid: retryUuid,
            } as unknown as SDKUserMessage;
            promptParam = buildInteractivePrompt(
              retryCh, state, emit, id, retryMsg,
            ) as unknown as QueryPromptParam;

            continue; // retry with resume
          }

          // ── Retry WITHOUT resume (prompt too long, session not found, or process exit on 2nd attempt) ──
          const retryReason = isPromptTooLong ? "prompt_too_long"
            : isSessionNotFound ? "session_not_found"
            : isProcessExit ? "process_exit_fresh_start"
            : "unknown";
          process.stderr.write(
            `[claude-handler] Retrying without resume — ${retryReason} ` +
            `(attempt=${_attempt}): ` +
            `${summarizeDiagnosticText(safeQueryError, "claude.retry_error")}\n`,
          );
          delete (options as Record<string, unknown>).resume;
          state.fullText = "";
          state.toolUseRegistry.clear();

          // Re-acquire credentials for the new CLI process
          credentialReleased = false;
          releaseCredentialLock = await acquireCredentialLock();
          savedEnv = await applyCredentials(platform, apiKey, baseUrl, model, cmd.proxyUrl);

          abortController = new AbortController();
          activeAbortControllers.set(id, abortController);
          options.abortController = abortController;

          const retryChannel = new PromptChannel(channelTimeout);
          replaceActivePromptChannel(id, retryChannel);
          currentPromptChannel = retryChannel;

          const retryUuid = randomUUID();
          emit({ evt: "user_message_uuid", id, uuid: retryUuid });
          let retryInitialMessage: SDKUserMessage;
          if (images && images.length > 0) {
            const contentBlocks = [
              ...images.map((img: ImageData) => ({
                type: "image" as const,
                source: {
                  type: "base64" as const,
                  media_type: img.media_type,
                  data: img.data,
                },
              })),
              // Only add text block if text is non-empty — Claude API rejects empty text blocks
              ...(prompt ? [{ type: "text" as const, text: prompt }] : []),
            ];
            retryInitialMessage = {
              type: "user" as const,
              message: { role: "user" as const, content: contentBlocks },
              parent_tool_use_id: null,
              session_id: "",
              uuid: retryUuid,
            } as unknown as SDKUserMessage;
          } else {
            retryInitialMessage = {
              type: "user" as const,
              message: { role: "user" as const, content: prompt || " " },
              parent_tool_use_id: null,
              session_id: "",
              uuid: retryUuid,
            } as unknown as SDKUserMessage;
          }
          promptParam = buildInteractivePrompt(
            retryChannel, state, emit, id, retryInitialMessage,
          ) as unknown as QueryPromptParam;

          emit({ evt: "stream_retry", id, attempt: _attempt + 1, max_attempts: MAX_QUERY_ATTEMPTS, reason: retryReason });
          continue; // retry without resume
        }

        // Not retryable — propagate to outer catch
        throw queryErr;
      }
    }

    // Only emit complete/done if not already emitted early from processStreamMessage.
    if (!state.completeEmitted) {
      process.stderr.write(
        `[claude-handler] Emitting late complete: fullText.length=${state.fullText.length}\n`,
      );
      emit({ evt: "complete", id: state.activeRequestId, fullText: state.fullText });
      state.completeEmitted = true;
    }
    if (!state.doneEmitted && !state.donePending) {
      state.doneEmitted = true;
      emit({ evt: "done", id: state.activeRequestId });
    }
  } catch (err: unknown) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    const safeErrorMsg = redactCliDiagnostic(
      errorMsg,
      state.diagnosticSecrets,
    );
    const errorCode = (err as { code?: string })?.code;
    const errorStack = err instanceof Error ? err.stack : undefined;

    // Detailed diagnostics for lock-related errors from proper-lockfile
    if (errorMsg.includes("Lock") || errorMsg.includes("lock") || errorCode === "ERELEASED" || errorCode === "ELOCKED" || errorCode === "ECOMPROMISED") {
      process.stderr.write(
        `[claude-handler] LOCK ERROR DIAGNOSTICS:\n` +
        `  error: ${summarizeDiagnosticText(safeErrorMsg, "claude.lock_error")}\n` +
        `  code: ${errorCode ?? "N/A"}\n` +
        `  request: ${summarizeDiagnosticText(id, "claude.request")}\n` +
        `  conversationSet: ${cmd.conversationId !== undefined}\n` +
        `  isPersistent: ${isPersistentSession}\n` +
        `  aborted: ${abortController.signal.aborted}\n` +
        `  fullText.length: ${state.fullText.length}\n` +
        `  stack: ${summarizeDiagnosticText(redactCliDiagnostic(errorStack ?? "", state.diagnosticSecrets), "claude.stack")}\n`,
      );
    }

    process.stderr.write(
      `[claude-handler] Outer catch: error=${summarizeDiagnosticText(safeErrorMsg, "claude.error")}, code=${errorCode ?? "N/A"}, ` +
      `fullText.length=${state.fullText.length}, aborted=${abortController.signal.aborted}\n`,
    );

    // When the CLI process crashes (exit code != 0) or the session is not found
    // (JSONL missing/corrupted) and all retries are exhausted, tell the frontend
    // to invalidate the sessionId so the NEXT user message starts a fresh session
    // instead of resume→crash/not-found looping.
    if ((isProcessExitError(err) || isSessionNotFoundError(err)) && cmd.conversationId) {
      const invalidationReason = isSessionNotFoundError(err)
        ? "session_not_found"
        : "process_exit";
      process.stderr.write(
        `[claude-handler] Emitting session_invalidated ` +
        `— reason=${invalidationReason}, error=${summarizeDiagnosticText(safeErrorMsg, "claude.session_error")}\n`,
      );
      emit({
        evt: "session_invalidated",
        id: state.activeRequestId,
        conversationId: cmd.conversationId,
        reason: invalidationReason,
      });
    }

    if (!abortController.signal.aborted) {
      if (state.fullText) {
        if (!state.completeEmitted) {
          emit({ evt: "complete", id: state.activeRequestId, fullText: state.fullText });
          state.completeEmitted = true;
        }
        if (!state.doneEmitted && !state.donePending) {
          state.doneEmitted = true;
          emit({ evt: "done", id: state.activeRequestId });
        }
      } else {
        // Preserve only a fixed category and bounded diagnostic ID. Raw CLI
        // stderr can contain prompts, paths, provider bodies, or credentials.
        const detailedError = buildRedactedCliError(
          safeErrorMsg,
          isProcessExitError(err) ? state.stderrBuffer : [],
          state.diagnosticSecrets,
        );
        const apiErrorStatus = extractApiErrorStatus(err);
        emit({
          evt: "error",
          id: state.activeRequestId,
          error: detailedError,
          apiErrorStatus: apiErrorStatus === undefined ? state.lastApiErrorStatus : apiErrorStatus,
        });
        if (!state.doneEmitted) {
          state.doneEmitted = true;
          emit({ evt: "done", id: state.activeRequestId });
        }
      }
    }
  } finally {
    // The handler is ending — a still-armed deferred-done timer must not fire
    // after the fallback done below (double emission on a dead request id).
    if (state.deferredDoneTimer) {
      clearTimeout(state.deferredDoneTimer);
      state.deferredDoneTimer = undefined;
    }
    if (!state.doneEmitted) {
      state.doneEmitted = true;
      state.donePending = false;
      emit({ evt: "done", id: state.activeRequestId });
    }

    const wasAborted = abortController.signal.aborted;
    const convId = cmd.conversationId;

    if (convId) {
      removeWarmSession(convId);
      emit({ evt: "session_ended", id: state.activeRequestId, conversationId: convId });
      process.stderr.write(
        `[claude-handler] Session ended: ` +
        `conversation=${summarizeDiagnosticText(convId, "claude.conversation")}, ` +
        `aborted=${wasAborted}\n`,
      );
    }

    // Clean up prompt channel and query references immediately.
    // For persistent sessions the channel was already consumed (generator
    // ended naturally via idle timeout or abort). For non-persistent
    // sessions this matches the previous immediate-cleanup behavior.
    // Clean up both original and migrated requestId (warm session
    // routing may have moved the entries to state.activeRequestId).
    for (const cleanupId of new Set([id, state.activeRequestId])) {
      closeActivePromptChannel(cleanupId);
      activeQueries.delete(cleanupId);
      activeAbortControllers.delete(cleanupId);
    }

    // Ensure credential lock is released even if the stream never yielded
    // a message (e.g. immediate error, abort before first yield).
    releaseCredentials();
  }
}

// ---------------------------------------------------------------------------
// Rewind files — restore file state to a checkpoint via Claude SDK
// ---------------------------------------------------------------------------

/**
 * Rewind files to the state captured at the given user message UUID.
 *
 * This requires the original Query's AsyncGenerator to still be alive (the
 * PromptChannel keepalive window). The frontend should call this within the
 * 120-second keepalive window after a conversation turn completes.
 */
export async function handleRewindFiles(
  requestId: string,
  userMessageUuid: string,
  emit: EmitFn,
): Promise<void> {
  const queryRef = activeQueries.get(requestId);

  // FAIL SAFE — only ever rewind the query that EXACTLY owns this requestId.
  // We deliberately do NOT fall back to "the most recent query" on a miss: that
  // global fallback could resolve to a different conversation and revert the
  // WRONG project's files (a cross-session leak). If there's no exact match, the
  // rewind simply doesn't happen and the user is told the session ended.
  if (!queryRef) {
    process.stderr.write(
      `[rewind] No query found for ` +
      `request=${summarizeDiagnosticText(requestId, "rewind.request")} ` +
      `(no cross-session fallback by design), activeQueries=${activeQueries.size}\n`,
    );
    emit({
      evt: "rewind_files_result",
      id: requestId,
      success: false,
      error: "No active query found for this request. The session may have ended.",
    });
    return;
  }

  const effectiveId = requestId;

  process.stderr.write(
    `[rewind] Calling rewindFiles: ` +
    `request=${summarizeDiagnosticText(requestId, "rewind.request")}, ` +
    `message=${summarizeDiagnosticText(userMessageUuid, "rewind.message")}, ` +
    `activeQueries=${activeQueries.size}, ` +
    `promptChannels=${activePromptChannels.size}\n`,
  );

  try {
    // Add a 30-second timeout to prevent hanging if the CLI process exited
    const timeoutMs = 30_000;
    const result = await Promise.race([
      queryRef.rewindFiles(userMessageUuid),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("rewindFiles timed out after 30s — the CLI process may have exited")), timeoutMs),
      ),
    ]);
    const safeResultError = result.error
      ? redactCliDiagnostic(result.error)
      : undefined;
    process.stderr.write(
      `[rewind] Result: canRewind=${result.canRewind}, ` +
      `error=${summarizeDiagnosticText(safeResultError ?? "", "rewind.error")}, ` +
      `filesChanged=${result.filesChanged?.length ?? 0}, ` +
      `insertions=${result.insertions ?? 0}, ` +
      `deletions=${result.deletions ?? 0}\n`,
    );
    emit({
      evt: "rewind_files_result",
      id: requestId,
      success: result.canRewind,
      error: safeResultError,
      filesChanged: result.filesChanged,
      insertions: result.insertions,
      deletions: result.deletions,
    });
  } catch (err: unknown) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    const safeError = redactCliDiagnostic(errorMsg);
    const safeStack = redactCliDiagnostic(
      err instanceof Error ? err.stack ?? "" : "",
    );
    process.stderr.write(
      `[rewind] Exception:\n` +
      `  message = ${summarizeDiagnosticText(safeError, "rewind.error")}\n` +
      `  stack   = ${summarizeDiagnosticText(safeStack, "rewind.stack")}\n`,
    );
    emit({
      evt: "rewind_files_result",
      id: requestId,
      success: false,
      error: safeError,
    });
  } finally {
    // Rewind complete (success or failure) — close the PromptChannel to
    // release the CLI process. No further rewind calls are expected.
    const ch = activePromptChannels.get(effectiveId);
    if (ch) {
      ch.close();
      activePromptChannels.delete(effectiveId);
    }
    activeQueries.delete(effectiveId);
  }
}

// ---------------------------------------------------------------------------
// Windows MCP server command resolution
// ---------------------------------------------------------------------------
// On Windows GUI processes, npm/npx uses cmd.exe as the script-shell to
// execute downloaded package binaries. This fails because cmd.exe cannot
// resolve commands without a real console. We resolve "npx" / "npm" commands
// to "node.exe + npx-cli.js / npm-cli.js" so the Claude SDK can spawn MCP
// servers directly without going through cmd.exe.
// ---------------------------------------------------------------------------

interface McpServerConfigRaw {
  command: string;
  args?: string[];
  env?: Record<string, string>;
  type?: string;
  [key: string]: unknown;
}

/**
 * Find node.exe only through the explicit override or the inherited PATH.
 * Returns the full path or undefined.
 */
export function findNodeExe(
  environment: NodeJS.ProcessEnv = process.env,
): string | undefined {
  const isRegularFile = (candidate: string): boolean => {
    try {
      return statSync(candidate).isFile();
    } catch {
      return false;
    }
  };

  const explicit = environment.BYTRO_NODE_PATH?.trim();
  if (explicit) {
    if (isRegularFile(explicit)) return explicit;
    const explicitBinary = join(explicit, "node.exe");
    if (isRegularFile(explicitBinary)) return explicitBinary;
  }

  const pathEnv = environment.PATH ?? environment.Path ?? "";
  for (const dir of pathEnv.split(";")) {
    if (!dir) continue;
    const candidate = join(dir, "node.exe");
    if (isRegularFile(candidate)) return candidate;
  }
  return undefined;
}

/**
 * Resolve a single MCP server config: if command is "npx" or "npm",
 * replace with node.exe + the corresponding cli.js script and add
 * npm_config_script_shell=powershell to env so any child npm/npx
 * processes also bypass cmd.exe.
 */
export function resolveWindowsMcpServer(
  _name: string,
  config: McpServerConfigRaw,
  environment: NodeJS.ProcessEnv = process.env,
): McpServerConfigRaw {
  const cmd = config.command?.toLowerCase() ?? "";
  if (cmd !== "npx" && cmd !== "npm" && cmd !== "npx.cmd" && cmd !== "npm.cmd") {
    return config;
  }

  const nodeExe = findNodeExe(environment);
  if (!nodeExe) {
    process.stderr.write(
      "[mcp-resolve] node.exe unavailable; preserving declared MCP command\n",
    );
    return config;
  }

  const nodeDir = dirname(nodeExe);
  const isNpx = cmd === "npx" || cmd === "npx.cmd";
  const cliScript = isNpx
    ? join(nodeDir, "node_modules", "npm", "bin", "npx-cli.js")
    : join(nodeDir, "node_modules", "npm", "bin", "npm-cli.js");

  let hasCliScript = false;
  try {
    hasCliScript = statSync(cliScript).isFile();
  } catch {
    hasCliScript = false;
  }
  if (!hasCliScript) {
    process.stderr.write(
      "[mcp-resolve] npm CLI unavailable beside selected node.exe; " +
      "preserving declared MCP command\n",
    );
    return config;
  }

  const resolvedArgs = [cliScript, ...(config.args ?? [])];
  const resolvedEnv: Record<string, string> = {
    ...config.env,
    // Force PowerShell as npm's script-shell so any child npm/npx processes
    // also bypass cmd.exe (which is broken in GUI processes).
    npm_config_script_shell: "powershell",
  };

  process.stderr.write(
    "[mcp-resolve] resolved one declared npm MCP command through selected node.exe\n",
  );

  return {
    ...config,
    command: nodeExe,
    args: resolvedArgs,
    env: resolvedEnv,
  };
}

/**
 * Resolve all MCP server configs for Windows.
 */
export function resolveWindowsMcpServers(
  servers: Record<string, McpServerConfigRaw>,
  environment: NodeJS.ProcessEnv = process.env,
): Record<string, McpServerConfigRaw> {
  const resolved: Record<string, McpServerConfigRaw> = {};
  for (const [name, config] of Object.entries(servers)) {
    resolved[name] = resolveWindowsMcpServer(name, config, environment);
  }
  return resolved;
}
