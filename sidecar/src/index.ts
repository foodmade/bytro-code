// ---------------------------------------------------------------------------
// Bytro Sidecar — Node.js process bridging Rust ↔ provider CLIs
// Routes queries to Claude or OpenAI handler based on cmd.agent field.
// ---------------------------------------------------------------------------

import { createInterface } from "node:readline";
import type { SidecarCommand, QueryCommand, InitSessionCommand, RewindFilesCommand, TeamsQueryCommand, KillSessionCommand } from "./protocol.js";
import { handleClaudeQuery, handleClaudeInit, handleRewindFiles, activeQueries } from "./claude-handler.js";
import {
  closePrewarmedChannel,
  handleCodexAuthCancel,
  handleCodexAuthRead,
  handleCodexAuthSignOut,
  handleCodexAuthStart,
  handleCodexInit,
  handleOpenAIQuery,
} from "./openai-handler.js";
import { handleChatCmplQuery } from "./chatcmpl-handler.js";
import { handleGeminiQuery } from "./gemini-handler.js";
import { handleOrchestrate } from "./orchestrator.js";
import { handleTeamsQuery } from "./teams-handler.js";
import { pendingConfirmations, pendingAskUserQuestions } from "./permissions.js";
import {
  publicSidecarErrorMessage,
  summarizeDiagnosticText,
} from "./shared.js";
import {
  getWarmSession,
  getWarmSessionByRequestId,
  killWarmSession,
  metadataMatches,
  killAllWarmSessions,
  activePromptChannels,
  markWarmSessionAbortedByRequestId,
  consumeWarmReuseDebug,
  setWarmSessionEndNotifier,
} from "./persistent-session-registry.js";
import { createHash, randomUUID } from "node:crypto";

// ---- Startup: strip inherited Anthropic env vars ----
// On developer machines, the Tauri parent process may have system-level
// ANTHROPIC_* env vars (from Claude CLI installation, shell profiles, etc.)
// that would pollute third-party provider requests (zenmux, deepseek).
// Clean them immediately at startup so credential-strategy.ts starts from
// a blank baseline and each request gets only the correct per-provider vars.
let removedInheritedAnthropicKeys = 0;
for (const key of Object.keys(process.env)) {
  if (key.startsWith("ANTHROPIC_")) {
    delete process.env[key];
    removedInheritedAnthropicKeys += 1;
  }
}
if (removedInheritedAnthropicKeys > 0) {
  logDiagnostic(
    "startup.env_sanitized",
    `removed_keys=${removedInheritedAnthropicKeys}`,
  );
}

// ---- Global crash handlers ----
// Catch unhandled errors so the Rust parent sees the reason on stderr
// before the process exits. Without these, Node.js exits silently in
// a packaged GUI app where stderr has no console.

// ---- Graceful shutdown on signals ----
// When Tauri kills the sidecar process (SIGTERM) or the user presses Ctrl-C,
// clean up warm child processes before exiting.
process.on("SIGTERM", () => {
  logDiagnostic("process.signal", "SIGTERM");
  killAllWarmSessions();
  process.exit(0);
});

process.on("SIGINT", () => {
  logDiagnostic("process.signal", "SIGINT");
  killAllWarmSessions();
  process.exit(0);
});

process.on("uncaughtException", (err) => {
  const errMsg = err?.message ?? "";
  const errCode = (err as { code?: string })?.code;

  // Stream write errors occur when the CLI subprocess exits while the adapter
  // is still writing to its stdin, or when the Rust parent closes the pipe.
  // These are benign cleanup races and should NOT crash the sidecar.
  const isStreamError =
    errMsg.includes("write EOF") ||
    errMsg.includes("write EPIPE") ||
    errMsg.includes("ERR_STREAM_DESTROYED") ||
    errMsg.includes("ERR_STREAM_WRITE_AFTER_END") ||
    errCode === "EPIPE" ||
    errCode === "ERR_STREAM_DESTROYED";

  if (isStreamError) {
    logDiagnostic("process.stream_error_suppressed", err?.stack ?? err);
    return;
  }

  logDiagnostic("process.uncaught_exception", err?.stack ?? err);
  process.exit(1);
});

process.on("unhandledRejection", (reason) => {
  const msg = reason instanceof Error ? (reason.stack ?? reason.message) : String(reason);
  // Log but do NOT exit — an unhandled rejection in one session should not
  // kill the entire sidecar process and all other active sessions.
  logDiagnostic("process.unhandled_rejection", msg);
});

// ---- Helpers ----

function emit(evt: object): void {
  try {
    process.stdout.write(JSON.stringify(evt) + "\n");
  } catch {
    // stdout pipe may break if the Rust parent process exits unexpectedly
  }
}

function logDiagnostic(eventType: string, detail: unknown): void {
  const message = detail instanceof Error ? (detail.stack ?? detail.message) : String(detail);
  process.stderr.write(
    `[sidecar] ${summarizeDiagnosticText(message, eventType)}\n`,
  );
}

function log(msg: string): void {
  logDiagnostic("index.message", msg);
}

function authDebugSecret(value: string | undefined): string {
  if (!value) return "(empty)";
  const digest = createHash("sha256").update(value).digest("hex").slice(0, 12);
  return `len=${value.length} sha256=${digest}`;
}

function authDebugBaseUrl(value: string | undefined): string {
  if (!value?.trim()) return "(default)";
  try {
    const parsed = new URL(value);
    return `${parsed.origin}${parsed.pathname}`;
  } catch {
    const digest = createHash("sha256").update(value).digest("hex").slice(0, 12);
    return `(invalid len=${value.length} sha256=${digest})`;
  }
}

// ---- Active query tracking ----

const activeAbortControllers = new Map<string, AbortController>();

/**
 * Tracks the promise of the currently running query handler so that a new
 * query (arriving after an abort) can wait for the previous one to fully
 * clean up before starting.  The credential race condition (old
 * restoreCredentials wiping new applyCredentials) is now handled by a
 * generation counter in credential-strategy.ts, but this wait still helps
 * avoid overlapping abort/cleanup sequences.
 */
const activeQueryPromises = new Map<string, Promise<void>>();

/**
 * Tracks cleanup promises for warm session (persistent) queries.
 * Unlike activeQueryPromises (which would block all subsequent queries for
 * the same agent type during the entire warm session lifetime), this only
 * tracks the promise so that a new cold-start query after abort can wait
 * for the previous SDK cleanup to finish.
 */
const activeCleanupPromises = new Map<string, Promise<void>>();

type QueryHandler = (
  cmd: QueryCommand,
  emitFn: (evt: object) => void,
  controllers: Map<string, AbortController>,
) => Promise<void>;

const QUERY_HANDLERS: Record<QueryCommand["agent"], QueryHandler> = {
  claude: handleClaudeQuery,
  codex: handleOpenAIQuery,
  chatcmpl: handleChatCmplQuery,
  gemini: handleGeminiQuery,
};

// ---- Command handlers ----

function emitCommandFailure(id: string | undefined, err: unknown): void {
  if (!id) return;
  logDiagnostic("command.failure", err);
  emit({ evt: "error", id, error: publicSidecarErrorMessage(err) });
  emit({ evt: "done", id });
}

async function handleQuery(cmd: QueryCommand): Promise<void> {
  // If there is an in-flight query for the same agent type, wait briefly for
  // it to finish cleanup (abort handling, resource release).  The credential
  // race condition is handled by the generation counter in
  // credential-strategy.ts, but this wait still avoids overlapping cleanup.
  const agentKey = cmd.agent ?? "claude";
  const prevPromise = activeQueryPromises.get(agentKey);
  // For persistent sessions, use a conversation-specific key so that
  // different conversations don't block each other.  Only abort-then-restart
  // within the SAME conversation should wait for cleanup.
  const cleanupKey = cmd.conversationId ? `${agentKey}:${cmd.conversationId}` : agentKey;
  const prevCleanup = activeCleanupPromises.get(cleanupKey);
  const waitTargets = [prevPromise, prevCleanup].filter(Boolean);
  if (waitTargets.length > 0) {
    try {
      // Use a timeout so we don't block indefinitely if the old query's SDK
      // cleanup hangs (e.g. waiting for a stuck CLI process to exit).
      await Promise.race([
        Promise.all(waitTargets),
        new Promise<void>((resolve) => setTimeout(resolve, 5_000)),
      ]);
    } catch {
      // Ignore errors from the previous query — we just need it to finish.
    }
  }

  const handler = QUERY_HANDLERS[agentKey];
  const promise = handler(cmd, emit, activeAbortControllers);

  if (!cmd.conversationId) {
    // Non-persistent: track entire lifetime so the next query waits.
    activeQueryPromises.set(agentKey, promise);
    promise.finally(() => {
      if (activeQueryPromises.get(agentKey) === promise) {
        activeQueryPromises.delete(agentKey);
      }
    });
  } else {
    // Persistent (warm) session: only track cleanup phase.
    // Normal warm session messages route via channel.push() and bypass
    // handleQuery entirely, so this does not block multi-turn usage.
    // It only ensures abort-then-cold-start waits for SDK cleanup.
    const convCleanupKey = cmd.conversationId ? `${agentKey}:${cmd.conversationId}` : agentKey;
    const cleanupPromise = promise.finally(() => {
      if (activeCleanupPromises.get(convCleanupKey) === cleanupPromise) {
        activeCleanupPromises.delete(convCleanupKey);
      }
    });
    activeCleanupPromises.set(convCleanupKey, cleanupPromise);
  }
  return promise;
}

function handlePermissionResponse(confirmId: string, approved: boolean): void {
  const pending = pendingConfirmations.get(confirmId);
  if (pending) {
    pending.resolve(approved);
    pendingConfirmations.delete(confirmId);
  }
}

function handleAskUserQuestionResponse(confirmId: string, answers: Record<string, string>): void {
  const pending = pendingAskUserQuestions.get(confirmId);
  if (pending) {
    pending.resolve(answers);
    pendingAskUserQuestions.delete(confirmId);
  }
}

function handleAbort(requestId: string): void {
  log(`handleAbort called: requestId=${requestId}, hasChannel=${activePromptChannels.has(requestId)}, hasController=${activeAbortControllers.has(requestId)}`);

  // [DIAG] Flag the owning warm session so the NEXT reuse logs that it resumed on a
  // history still containing this interrupted turn (suspect A for "model does something
  // I never asked for this turn"). The warm session/process is intentionally kept alive.
  const abortedConv = markWarmSessionAbortedByRequestId(requestId);
  if (abortedConv) {
    log(`[abort-diag] 🅰 interrupted turn req=${requestId} on warm conv=${abortedConv} — process+history kept alive; the next message will run on this half-done context`);
  }

  // Only abort the per-turn controller — do NOT close the channel or abort the
  // session-level controller. This cancels the current turn (via turn/interrupt)
  // while keeping the warm session loop alive for future messages.
  // True session shutdown is handled by killWarmSession() in the registry.
  const controller = activeAbortControllers.get(requestId);
  if (controller) {
    controller.abort();
    activeAbortControllers.delete(requestId);
  }
}

function handleUserInput(
  requestId: string,
  content: string,
  images?: ReadonlyArray<{ media_type: string; data: string }>,
  reasoningLevel?: string,
  commandInvocation?: import("./protocol.js").CommandInvocationPayload,
): void {
  // Cold-restart guard for the warm send_user_input path. If this warm session
  // was flagged for cold-restart (host suspend detected; see registry cleanup
  // timer) but the frontend still routed here instead of the cold `query` path,
  // pushing onto the stale process would let the model continue its frozen,
  // possibly half-finished context — the contamination. Instead, end the warm
  // session and emit `session_ended` so the frontend drops its warm tracker; the
  // user's resend then takes the cold `query` path, which cold-restarts with the
  // clean resumeSessionAt anchor. (The abort path never reaches here because
  // handleStop already clears the frontend warm tracker.)
  const guardEntry = getWarmSessionByRequestId(requestId);
  if (guardEntry?.needsColdRestart === true) {
    const convId = guardEntry.conversationId;
    log(`[user_input] warm session conv=${convId} needs cold-restart (suspend) — ending it; next turn will cold-start`);
    killWarmSession(convId);
    emit({ evt: "session_ended", id: requestId, conversationId: convId });
    return;
  }

  const channel = activePromptChannels.get(requestId);
  if (channel) {
    // Only emit user_message_uuid for Claude sessions (which support
    // SDK-level rewindFiles).  Other handlers (Codex, ChatCmpl, Gemini)
    // do not have rewind capability — emitting a UUID would show a
    // Revert All button that always fails.
    if (activeQueries.has(requestId)) {
      const uuid = randomUUID();
      emit({ evt: "user_message_uuid", id: requestId, uuid });
    }

    // Pass requestId so warm sessions (both Claude and Codex) can update
    // their activeRequestId for subsequent event routing.
    channel.push(content, images, requestId, undefined, reasoningLevel, commandInvocation);
  } else {
    log(`No active prompt channel for request ${requestId}`);
  }
}

// ---- Main stdin loop ----

function main(): void {
  logDiagnostic(
    "startup.runtime",
    `node=${process.version} platform=${process.platform} arch=${process.arch}`,
  );
  emit({ evt: "ready" });

  // Let the warm-session registry notify the frontend when it ends a session on
  // its own (host-suspend detection). Emitting `session_ended` makes the
  // frontend drop its warm tracker so the next turn takes the cold `query` path,
  // which cold-restarts with the clean resumeSessionAt anchor.
  setWarmSessionEndNotifier((conversationId, requestId) => {
    emit({ evt: "session_ended", id: requestId, conversationId });
  });

  const rl = createInterface({ input: process.stdin });

  rl.on("line", (line: string) => {
    const trimmed = line.trim();
    if (!trimmed) return;

    let cmd: SidecarCommand;
    try {
      cmd = JSON.parse(trimmed) as SidecarCommand;
    } catch {
      logDiagnostic("stdin.invalid_json", trimmed);
      return;
    }

    switch (cmd.cmd) {
      case "query": {
        process.stderr.write(
          `[auth-debug][sidecar/query] request_id=${cmd.id} agent=${cmd.agent} ` +
          `platform=${cmd.platform ?? "(none)"} model=${cmd.model} ` +
          `auth_mode=${cmd.authMode ?? "apiKey"} profile_id=${cmd.profileId ?? "(none)"} ` +
          `base_url=${authDebugBaseUrl(cmd.baseUrl)} api_key=${authDebugSecret(cmd.apiKey)} ` +
          `session_present=${cmd.sessionId !== null} proxy_set=${Boolean(cmd.proxyUrl?.trim())}\n`,
        );
        // Check for an existing warm session for this conversation.
        // If metadata (model/platform/cwd) still matches, route the message
        // to the existing CLI process instead of spawning a new one.
        const convId = cmd.conversationId;
        let warmSession = convId ? getWarmSession(convId) : undefined;

        // [cross-session-guard] The warm registry is keyed by conversationId, so a
        // returned entry MUST belong to this conversation. If it doesn't, the
        // registry has been corrupted (a session registered under the wrong key) —
        // routing this turn onto it would feed conversation B's live process with
        // conversation A's message and leak B's history into A. Refuse to reuse it,
        // emit a persisted cross-session alert, and fall through to a clean cold
        // start. This should never fire; if it does, the debug line is the evidence.
        if (warmSession && convId && warmSession.conversationId !== convId) {
          logDiagnostic(
            "session.cross_session_guard",
            JSON.stringify({
              requestedConversationId: convId,
              actualConversationId: warmSession.conversationId,
              requestId: warmSession.requestId,
            }),
          );
          warmSession = undefined;
        }

        if (warmSession && metadataMatches(warmSession, cmd)) {
          // Cold-restart instead of reusing the live process when either the
          // session-level controller is already aborted (stale), or the previous
          // turn on this warm session was interrupted (needsColdRestart). In the
          // abort case the half-finished turn (partial assistant output, tool
          // calls/results) is still resident in the running CLI process's memory;
          // routing the next message onto it makes the model continue/act on that
          // half-done context — the "instruction I never gave this turn"
          // contamination (suspect A). killWarmSession + cold-start with `resume`
          // reloads a clean history instead.
          if (warmSession.abortController.signal.aborted || warmSession.needsColdRestart === true) {
            // Capture the clean-resume anchor BEFORE killWarmSession drops the
            // entry. Resuming `up to and including` this last-clean-assistant uuid
            // truncates the aborted/suspended turn's persisted half-done tail out
            // of the model's context, so it cannot be reloaded and continued
            // (the contamination). Falls back to a plain resume when no clean
            // anchor exists yet (e.g. the very first turn was the one aborted).
            const resumeAnchor = warmSession.lastCleanAssistantUuid;
            log(`Cold-restarting warm session for conv=${convId} (aborted=${warmSession.abortController.signal.aborted}, needsColdRestart=${warmSession.needsColdRestart === true}, resumeAnchor=${resumeAnchor ? resumeAnchor.slice(0, 8) : "(none)"})`);
            killWarmSession(convId!);
            const coldCmd = resumeAnchor ? { ...cmd, resumeSessionAt: resumeAnchor } : cmd;
            handleQuery(coldCmd).catch((err) => {
              log(`Query error: ${err}`);
              emitCommandFailure(cmd.id, err);
            });
            break;
          }
          // [DIAG] Snapshot the three contamination suspects at the exact moment of
          // reuse, and consume the interrupt flag. Logged BEFORE refreshing
          // lastActivityMs so `idle` reflects the real gap since the previous turn.
          log(`[warm-reuse-diag] conv=${convId} newReq=${cmd.id} ${consumeWarmReuseDebug(warmSession, cmd)}`);
          warmSession.lastActivityMs = Date.now();
          // For Claude warm sessions, emit user_message_uuid here since the
          // handler's generator doesn't re-emit it. For Codex, the handler's
          // warm session loop emits it after receiving the channel message.
          if (warmSession.agent !== "codex") {
            const uuid = randomUUID();
            emit({ evt: "user_message_uuid", id: cmd.id, uuid });
          }
          // Create a per-turn abort controller for this message. handleAbort will
          // only cancel this turn without killing the warm session.
          // The warm session loop picks it up via activeAbortControllers.get(requestId).
          activeAbortControllers.set(cmd.id, new AbortController());
          // Push message to the warm session channel. For Claude, the generator
          // in buildInteractivePrompt receives it. For Codex, the warm session
          // loop in handleOpenAIQuery receives it via channel.nextMessage().
          warmSession.channel.push(cmd.prompt, cmd.images, cmd.id, true, cmd.reasoningLevel, cmd.commandInvocation);
          // Migrate activePromptChannels from old to new requestId so
          // subsequent user_input/abort (which use the new requestId
          // from the done event) can find the channel. Also update the
          // warm session registry so downstream lookups (kill / debug,
          // and the next query's migration step) see the current requestId
          // — without this, after the first migration `warmSession.requestId`
          // would be stale and subsequent migrations would lose the channel.
          const oldReq = warmSession.requestId;
          if (oldReq !== cmd.id) {
            const ch = activePromptChannels.get(oldReq);
            if (ch) {
              activePromptChannels.delete(oldReq);
              activePromptChannels.set(cmd.id, ch);
            }
            warmSession.requestId = cmd.id;
          }
          log(`Routed query to warm session: conv=${convId}, oldReq=${oldReq}, newReq=${cmd.id}, goalMode=${cmd.goalModeEnabled === true}`);
        } else {
          if (warmSession) {
            // Metadata changed — kill stale warm session before creating new
            log(`Killing stale warm session for conv=${convId} (metadata changed)`);
            killWarmSession(convId!);
          }
          handleQuery(cmd).catch((err) => {
            log(`Query error: ${err}`);
            emitCommandFailure(cmd.id, err);
          });
        }
        break;
      }

      case "permission_response":
        handlePermissionResponse(cmd.confirmId, cmd.approved);
        break;

      case "ask_user_question_response":
        handleAskUserQuestionResponse(cmd.confirmId, cmd.answers);
        break;

      case "abort":
        handleAbort(cmd.id);
        break;

      case "user_input":
        handleUserInput(cmd.id, cmd.content, cmd.images, cmd.reasoningLevel, cmd.commandInvocation);
        break;

      case "codex_auth_start":
        handleCodexAuthStart(cmd, emit).catch((err) => {
          log(`Codex auth start error: ${err}`);
        });
        break;

      case "codex_auth_read":
        handleCodexAuthRead(cmd, emit).catch((err) => {
          log(`Codex auth read error: ${err}`);
        });
        break;

      case "codex_auth_cancel":
        handleCodexAuthCancel(cmd).catch((err) => {
          log(`Codex auth cancel error: ${err}`);
        });
        break;

      case "codex_auth_sign_out":
        handleCodexAuthSignOut(cmd, emit).catch((err) => {
          log(`Codex auth sign-out error: ${err}`);
        });
        break;

      case "teams_query":
        handleTeamsQuery(cmd as TeamsQueryCommand, emit, activeAbortControllers).catch((err) => {
          log(`Teams query error: ${err}`);
        });
        break;

      case "orchestrate":
        handleOrchestrate(cmd, emit, activeAbortControllers).catch((err) => {
          log(`Orchestration error: ${err}`);
        });
        break;

      case "init_session": {
        const initCmd = cmd as InitSessionCommand;
        if (initCmd.platform === "codex") {
          handleCodexInit(initCmd, emit).catch((err) => {
            log(`Codex init session error: ${err}`);
            emitCommandFailure(initCmd.id, err);
          });
        } else {
          handleClaudeInit(initCmd, emit, activeAbortControllers).catch((err) => {
            log(`Init session error: ${err}`);
            emitCommandFailure(initCmd.id, err);
          });
        }
        break;
      }

      case "rewind_files": {
        const rwCmd = cmd as RewindFilesCommand;
        handleRewindFiles(rwCmd.id, rwCmd.userMessageUuid, emit).catch((err) => {
          log(`Rewind files error: ${err}`);
        });
        break;
      }

      case "kill_session": {
        const ksCmd = cmd as KillSessionCommand;
        log(`Kill session requested: conv=${ksCmd.conversationId}`);
        killWarmSession(ksCmd.conversationId);
        break;
      }

      case "shutdown":
        log("Shutdown requested");
        killAllWarmSessions();
        closePrewarmedChannel();
        rl.close();
        process.exit(0);
        break;

      default:
        log(`Unknown command type: ${(cmd as Record<string, unknown>).cmd ?? "undefined"}`);
    }
  });

  rl.on("close", () => {
    process.exit(0);
  });
}

main();
