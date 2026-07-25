/**
 * Persistent (warm) session registry — tracks active CLI sessions that stay
 * alive between conversation turns, keyed by frontend conversationId.
 *
 * When a query completes but the session stays alive (waiting for the next
 * message), the session is registered here as "warm". Subsequent queries for
 * the same conversation can be routed to the existing channel instead of
 * spawning a new process.
 *
 * Supports both Claude (PromptChannel) and Codex (CodexSessionChannel) via
 * the generic SessionChannel interface.
 */

import { createHash } from "node:crypto";
import type { CommandInvocationPayload, QueryCommand } from "./protocol.js";

// ---------------------------------------------------------------------------
// Generic session channel interface — implemented by both PromptChannel
// (Claude) and CodexSessionChannel (Codex).
// ---------------------------------------------------------------------------

export interface SessionChannel {
  push(
    content: string,
    images?: ReadonlyArray<{ media_type: string; data: string }>,
    requestId?: string,
    routedFromQuery?: boolean,
    reasoningLevel?: string,
    commandInvocation?: CommandInvocationPayload,
  ): void;
  close(): void;
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface WarmSessionEntry {
  readonly conversationId: string;
  /** The most recent requestId this warm session is bound to. Mutable because
   *  the index.ts query router migrates `activePromptChannels` from the prior
   *  requestId to the new one on each subsequent query, and downstream lookups
   *  (kill / debug) must reflect that. Starts as the first-turn requestId set
   *  by `registerWarmSession`. */
  requestId: string;
  readonly channel: SessionChannel;
  readonly abortController: AbortController;
  readonly model: string;
  readonly platform: string;
  readonly cwd: string;
  /**
 * SHA-256 hash of credential and agent proxy inputs — used only for change detection in
   * metadataMatches(). Never store the raw credentials here.
   */
  readonly credentialHash: string;
  /** Permission mode (e.g. "default", "full-auto", "suggest"). */
  readonly permissionMode?: string;
  /** Agent type for routing ("claude" | "codex" | "gemini"). */
  readonly agent?: "claude" | "codex" | "gemini";
  /** Fingerprint of MCP server names so config changes invalidate the session. */
  readonly mcpServerKeys?: string;
  /** Claude session options are fixed at process startup; changes require respawn. */
  readonly thinkingEnabled?: boolean;
  readonly reasoningLevel?: string;
  readonly ultracode?: boolean;
  readonly fastMode?: boolean;
  readonly cavemanMode?: string;
  /**
   * Imagegen preferences baked into the openai_images MCP child process at
   * spawn time (env vars OPENAI_IMAGES_QUALITY / OPENAI_IMAGES_SIZE /
   * OPENAI_IMAGES_OUT). Once spawned, the child's env is immutable, so a
   * preference change must invalidate the warm session and force a respawn.
   */
  readonly imageGenQuality?: string;
  readonly imageGenSize?: string;
  readonly outputsDir?: string;
  /** Codex App Server service tier baked into the thread/turn config. */
  readonly serviceTier?: string;
  /** Codex Goals feature flag baked into the App Server process at spawn time. */
  readonly goalModeEnabled?: boolean;
  /** [DIAG] Fingerprint of the systemPrompt fixed at process spawn. metadataMatches()
   *  does NOT compare this, so a changed systemPrompt silently reuses the old process.
   *  Recorded only to surface that drift in logs. */
  readonly systemPromptHash?: string;
  /** [DIAG] disableTools value fixed at spawn. Also not compared by metadataMatches(). */
  readonly disableTools?: boolean;
  /** [DIAG] Set true when a turn on this warm session was interrupted (abort) without
   *  killing the process. The next reuse then runs on a history that still contains the
   *  interrupted/half-done task — the prime suspect for "model picks up an instruction I
   *  never gave this turn". Consumed (read + cleared) on the next reuse. */
  lastTurnAborted?: boolean;
  /** [DIAG] Timestamp (ms) of the most recent interrupt, paired with lastTurnAborted. */
  lastAbortAtMs?: number;
  /**
   * Set true when a turn on this warm session was interrupted (abort). The next
   * reuse for this conversation MUST cold-restart (kill the CLI process, then
   * respawn with `resume`) instead of routing the message onto the live process.
   * The aborted turn's half-finished context (partial assistant output, tool
   * calls/results) is still resident in the running process's memory; reusing it
   * lets the model continue or act on that half-done work — the root of the
   * "model acts on an instruction I never gave this turn" contamination
   * (suspect A). Cleared implicitly when killWarmSession() drops the entry.
   */
  needsColdRestart?: boolean;
  /**
   * UUID of the last assistant message of the most recently *cleanly completed*
   * turn (captured from `SDKAssistantMessage.uuid`). Used as the `resumeSessionAt`
   * anchor when this session is cold-restarted after an abort/suspend: the SDK
   * resumes "up to and including" this uuid, so the interrupted turn's persisted
   * half-done content (partial thinking / dangling tool cycle) is truncated out
   * of the model's context instead of being reloaded from the JSONL. Advanced
   * only on clean completion and never on an aborted turn (see claude-handler's
   * result handler), so it always points at a poison-free boundary.
   */
  lastCleanAssistantUuid?: string;
  lastActivityMs: number;
}

/** [DIAG] Short stable fingerprint for systemPrompt drift detection in logs. */
export function hashForDebug(s: string): string {
  return createHash("sha1").update(s).digest("hex").slice(0, 12);
}

/** Compute a credential fingerprint — safe to store, cannot recover original values. */
export function hashCredentials(apiKey: string, baseUrl: string, authMode: string = "apiKey", profileId: string = "", proxyUrl: string = ""): string {
  return createHash("sha256")
    .update(`${authMode}:${profileId}:${apiKey}:${baseUrl}:${proxyUrl}`)
    .digest("hex");
}

// ---------------------------------------------------------------------------
// Active prompt channels — shared map used by index.ts to dispatch
// send_user_input to the correct handler (Claude or Codex).
// Each handler registers its channel here when a warm session begins.
// ---------------------------------------------------------------------------

export const activePromptChannels = new Map<string, SessionChannel>();

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

const warmSessions = new Map<string, WarmSessionEntry>();

// Session timeout: kill sessions inactive for more than 2 hours.
// Extended from 30min to reduce cold-start frequency — thread/resume handles
// the case where the warm session has already expired.
const SESSION_TIMEOUT_MS = 2 * 60 * 60 * 1000;

const CLEANUP_INTERVAL_MS = 60_000;
/**
 * If a cleanup tick arrives this much later than its 60s schedule, the host was
 * suspended (laptop sleep / OS freeze) while the timer — and the warm CLI
 * subprocesses — were frozen. 90s of unexplained drift cannot happen under
 * normal load (GC/event-loop stalls are sub-second), so it is a reliable
 * suspend signal with effectively no false positives.
 */
const SUSPEND_DETECT_DRIFT_MS = 90_000;
let _lastCleanupTickMs = Date.now();

/**
 * Optional notifier invoked when the registry decides a warm session must end
 * (currently: on host-suspend detection). index.ts wires this to emit a
 * `session_ended` event so the frontend clears its warm-session tracker and
 * routes the next turn through the cold `query` path — which then cold-restarts
 * with the clean `resumeSessionAt` anchor. The registry has no `emit` of its
 * own, hence this injected callback.
 */
type WarmSessionEndNotifier = (conversationId: string, requestId: string) => void;
let _warmSessionEndNotifier: WarmSessionEndNotifier | null = null;
export function setWarmSessionEndNotifier(fn: WarmSessionEndNotifier): void {
  _warmSessionEndNotifier = fn;
}

const _cleanupTimer = setInterval(() => {
  const now = Date.now();

  // ── Host-suspend detection ────────────────────────────────────────────────
  // A frozen timer means wall-clock jumped while the warm CLI subprocesses sat
  // suspended. On wake the SDK reconnects to the SAME process and continues its
  // now-stale, possibly half-finished in-memory context as if no time passed —
  // the root of "after my machine slept, the next reply acts on a half-done task
  // I never continued". This path does NOT go through handleAbort, so the
  // abort-only needsColdRestart never fired for it. Flag every warm session for
  // cold-restart AND notify the frontend to drop its warm tracker so the next
  // turn takes the cold `query` path (which truncates via resumeSessionAt).
  const drift = now - _lastCleanupTickMs - CLEANUP_INTERVAL_MS;
  _lastCleanupTickMs = now;
  if (drift > SUSPEND_DETECT_DRIFT_MS && warmSessions.size > 0) {
    process.stderr.write(
      `[warm-sessions] Host suspend detected (cleanup tick ${drift}ms late) — ` +
      `flagging ${warmSessions.size} warm session(s) for cold-restart\n`,
    );
    for (const entry of warmSessions.values()) {
      entry.needsColdRestart = true;
      try { _warmSessionEndNotifier?.(entry.conversationId, entry.requestId); } catch { /* best-effort */ }
    }
  }

  const expired = Array.from(warmSessions.keys()).filter(
    (id) => now - (warmSessions.get(id)?.lastActivityMs ?? 0) > SESSION_TIMEOUT_MS,
  );
  for (const id of expired) {
    killWarmSession(id);
  }
}, CLEANUP_INTERVAL_MS);

// Prevent the timer from keeping the process alive.
if (_cleanupTimer.unref) _cleanupTimer.unref();

/** Register a warm session for a conversation. Kills any existing session first. */
export function registerWarmSession(entry: WarmSessionEntry): void {
  // Kill the previous session if one exists, to avoid orphaned processes.
  const existing = warmSessions.get(entry.conversationId);
  if (existing) {
    existing.channel.close();
    existing.abortController.abort();
  }
  warmSessions.set(entry.conversationId, entry);
}

/** Look up a warm session by conversation ID. */
export function getWarmSession(conversationId: string): WarmSessionEntry | undefined {
  return warmSessions.get(conversationId);
}

/** Look up a warm session by its current requestId (the warm session/process
 *  migrates this on each turn). Used by the send_user_input path, which only
 *  knows the requestId, to honor a pending needsColdRestart before routing a
 *  message onto a stale process. */
export function getWarmSessionByRequestId(requestId: string): WarmSessionEntry | undefined {
  for (const entry of warmSessions.values()) {
    if (entry.requestId === requestId) return entry;
  }
  return undefined;
}

/** Check whether any warm session exists for the given agent type. */
export function hasWarmSessionForAgent(agent: "claude" | "codex" | "gemini"): boolean {
  for (const entry of warmSessions.values()) {
    if (entry.agent === agent) return true;
  }
  return false;
}

export function killWarmSessionsForAgent(agent: "claude" | "codex" | "gemini"): void {
  const convIds = Array.from(warmSessions.values())
    .filter((entry) => entry.agent === agent)
    .map((entry) => entry.conversationId);
  for (const convId of convIds) {
    killWarmSession(convId);
  }
}

/** Remove a warm session entry (without closing the channel). */
export function removeWarmSession(conversationId: string): void {
  warmSessions.delete(conversationId);
}

/**
 * Kill a warm session — close the channel and abort the controller.
 * This causes the `buildInteractivePrompt` generator to end, which terminates
 * the `query()` call and kills the CLI process.
 */
export function killWarmSession(conversationId: string): void {
  const entry = warmSessions.get(conversationId);
  if (!entry) return;

  try { entry.channel.close(); } catch { /* best-effort */ }
  try { entry.abortController.abort(); } catch { /* best-effort */ }
  warmSessions.delete(conversationId);
}

/**
 * Check if a query command's metadata matches the warm session.
 * Returns false if model, provider, cwd, or credentials changed — the warm
 * session must be killed and a fresh one created.
 */
export function metadataMatches(entry: WarmSessionEntry, cmd: QueryCommand): boolean {
  // Build a comparable fingerprint of MCP server names from the incoming command.
  const cmdMcpKeys = cmd.mcpServers
    ? Object.keys(cmd.mcpServers).sort().join(",")
    : "";
  const cmdCredentialHash = hashCredentials(cmd.apiKey ?? "", cmd.baseUrl ?? "", cmd.authMode ?? "apiKey", cmd.profileId ?? "", cmd.proxyUrl ?? "");
  const shouldCompareClaudeSessionOptions =
    cmd.agent === "claude" && (entry.agent == null || entry.agent === "claude");
  const claudeSessionOptionsMatch = !shouldCompareClaudeSessionOptions || (
    (entry.thinkingEnabled ?? undefined) === (cmd.thinkingEnabled ?? undefined) &&
    (entry.reasoningLevel ?? "") === (cmd.reasoningLevel ?? "") &&
    (entry.ultracode ?? false) === (cmd.ultracode ?? false) &&
    (entry.fastMode ?? false) === (cmd.fastMode ?? false) &&
    (entry.cavemanMode ?? "off") === (cmd.cavemanMode ?? "off")
  );
  return (
    entry.model === cmd.model &&
    (entry.platform ?? "") === (cmd.platform ?? "") &&
    entry.cwd === cmd.cwd &&
    entry.credentialHash === cmdCredentialHash &&
    (entry.permissionMode ?? "") === (cmd.permissionMode ?? "") &&
    (entry.mcpServerKeys ?? "") === cmdMcpKeys &&
    // Imagegen prefs must match — the env vars baked into the openai_images
    // MCP child are immutable after spawn, so a change here forces a respawn.
    (entry.imageGenQuality ?? "") === (cmd.imageGenQuality ?? "") &&
    (entry.imageGenSize ?? "") === (cmd.imageGenSize ?? "") &&
    (entry.outputsDir ?? "") === (cmd.outputsDir ?? "") &&
    (entry.serviceTier ?? "") === (cmd.serviceTier ?? "") &&
    (entry.goalModeEnabled ?? false) === (cmd.goalModeEnabled ?? false) &&
    claudeSessionOptionsMatch
  );
}

/** Kill ALL warm sessions — called on shutdown or sidecar restart. */
export function killAllWarmSessions(): void {
  // Collect keys first to avoid modifying the map while iterating.
  const convIds = Array.from(warmSessions.keys());
  for (const convId of convIds) {
    killWarmSession(convId);
  }
}

/**
 * Mark the warm session bound to `requestId` as "last turn interrupted (abort)".
 * handleAbort() only knows the requestId, so this scans warm sessions by their
 * current requestId. Besides the [DIAG] flags surfaced in the next reuse log,
 * this sets `needsColdRestart` so the next query for this conversation is forced
 * to cold-restart instead of reusing the live process (see field doc — fixes
 * contamination suspect A). Returns the matched conversationId (for logging), or
 * undefined if no warm session owns that request (i.e. it was a non-persistent
 * query and the process is being torn down anyway).
 */
export function markWarmSessionAbortedByRequestId(requestId: string): string | undefined {
  for (const entry of warmSessions.values()) {
    if (entry.requestId === requestId) {
      entry.lastTurnAborted = true; // [DIAG] surfaced in the next reuse log
      entry.lastAbortAtMs = Date.now();
      // Force the next reuse to cold-restart so the aborted turn's half-done
      // context cannot leak into — and be continued by — the following turn.
      entry.needsColdRestart = true;
      return entry.conversationId;
    }
  }
  return undefined;
}

/**
 * [DIAG] Build a one-line reuse diagnostic for a warm session that is about to be
 * reused, and consume (clear) the interrupt flag. Surfaces the three contamination
 * suspects at the exact moment a process is reused:
 *   - lastTurnAborted: the prior turn was interrupted but the process+history survived
 *   - sysPromptChanged: the incoming systemPrompt differs from the spawned one (not
 *     re-applied, since the process is reused)
 *   - disableToolsChanged: the tool-availability config changed but won't take effect
 * Call BEFORE refreshing entry.lastActivityMs so `idleMs` reflects the real gap.
 */
export function consumeWarmReuseDebug(entry: WarmSessionEntry, cmd: QueryCommand): string {
  const now = Date.now();
  const idleMs = now - entry.lastActivityMs;
  const cmdSysHash = hashForDebug(cmd.systemPrompt ?? "");
  const sysChanged = entry.systemPromptHash != null && entry.systemPromptHash !== cmdSysHash;
  const toolsChanged = (entry.disableTools ?? false) !== (cmd.disableTools ?? false);
  const wasAborted = entry.lastTurnAborted === true;
  const sinceAbortMs = entry.lastAbortAtMs != null ? now - entry.lastAbortAtMs : -1;

  // Consume the interrupt flag so it only flags the immediate next reuse.
  entry.lastTurnAborted = false;

  return (
    `idle=${idleMs}ms ` +
    `lastTurnAborted=${wasAborted}${wasAborted ? `(${sinceAbortMs}ms ago)` : ""} ` +
    `sysPromptChanged=${sysChanged}${sysChanged ? `(${entry.systemPromptHash}->${cmdSysHash})` : ""} ` +
    `disableToolsChanged=${toolsChanged}${toolsChanged ? `(${entry.disableTools ?? false}->${cmd.disableTools ?? false})` : ""} ` +
    `warmSessionsAlive=${warmSessions.size}`
  );
}
