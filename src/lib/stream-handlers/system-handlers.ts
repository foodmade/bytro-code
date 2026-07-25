import { invoke } from "@tauri-apps/api/core";
import type { UnlistenFn } from "@tauri-apps/api/event";
import { windowListen } from "@/lib/window-listen";
import {
  useChatStore,
  useConversationStore,
  useSettingsStore,
  useToolStateStore,
  useAgentStatusStore,
  useFileChangesStore,
  useCheckpointStore,
  useWorkspaceStore,
  usePermissionStore,
  useGoalSessionStore,
} from "@/stores";
import { useStreamStateStore, refreshStreamSafetyTimeout } from "@/stores/stream-state-store";
import {
  resolveActiveCredentials,
  getEffectiveSdk,
  PLATFORM_REGISTRY,
  buildProfileProxyUrl,
  type PlatformId,
} from "@/lib/platform-config";
import { getKnownDescription } from "@/lib/slash-command-descriptions";
import { getStreamRequestContext, type StreamRequestContext } from "@/lib/chat-stream-registry";
import { isClaudeSession, removeRequestAndSyncStreamState } from "@/lib/chat-stream-state";
import { registerWarmSession, clearWarmSession } from "@/lib/warm-session-tracker";
import { parseTodoStatus } from "@/lib/db-converters";
import { triggerTitleGeneration, finalizeAgentTurnAndTodos } from "./helpers";
import { notificationManager, stripMarkdown } from "@/lib/notifications";
import { normalizeGoalStatus } from "@/components/chat/goal-utils";
import i18n from "@/i18n/config";
import type {
  ListenerParams,
  DonePayload,
  SessionEndedPayload,
  ErrorPayload,
  SessionPayload,
  UsagePayload,
  StreamUsagePayload,
  ContextUsagePayload,
  GoalUpdatedPayload,
  NewTurnPayload,
  SubagentStartedPayload,
  SubagentStoppedPayload,
  SubagentCompletedPayload,
  SubagentTextDeltaPayload,
  SubagentThinkingDeltaPayload,
  TaskStartedPayload,
  TaskProgressPayload,
  TaskNotificationPayload,
  TodoUpdatedPayload,
  SystemInitPayload,
  CompactPayload,
  StreamRetryPayload,
  SessionInvalidatedPayload,
} from "./types";
import type { TurnUsageData } from "@/stores/chat-types";

type TurnTokenUsageInput = Pick<
  TurnUsageData,
  "inputTokens" | "outputTokens" | "cacheReadTokens" | "cacheCreationTokens"
>;

/**
 * Persist a cross-session leak signal to `<app_data_dir>/logs/cross-session.log`
 * (survives an app restart — sidecar stderr is not written to disk). Best-effort:
 * a logging failure must never disrupt the stream. Fed by the chat-session
 * cross-session guard and the forwarded sidecar `[cross-session-guard]` /
 * `SESSION CHANGED` diagnostics.
 */
function persistCrossSession(_message: string): void {
  const line = `${new Date().toISOString()} cross-session guard rejected a session assignment`;
  invoke("append_diagnostics_log", { category: "cross-session", line }).catch(() => {
    /* best-effort — never disrupt the stream */
  });
}

export function formatChatError(errorText: string, errorStatus?: number): string {
  const normalized = errorText.toLowerCase();
  let category: string;
  if (/\bmodel_not_found\b/i.test(errorText) || /model .*not found/i.test(errorText)) {
    category = i18n.t("chat.errors.modelNotFound");
  } else if (normalized.includes("abort") || normalized.includes("cancel")) {
    category = "Provider request was cancelled";
  } else if (errorStatus === 429 || normalized.includes("rate limit") || normalized.includes("429")) {
    category = "Provider rate limit reached";
  } else if (
    errorStatus === 401
    || errorStatus === 403
    || normalized.includes("unauthorized")
    || normalized.includes("authentication")
    || normalized.includes("credential")
  ) {
    category = "Provider authentication failed";
  } else if (normalized.includes("timed out") || normalized.includes("timeout")) {
    category = "Provider request timed out";
  } else if (
    normalized.includes("not configured")
    || normalized.includes("configuration")
    || normalized.includes("base url is required")
  ) {
    category = "Provider configuration is incomplete";
  } else if (
    normalized.includes("enoent")
    || normalized.includes("not found")
    || normalized.includes("unavailable")
  ) {
    category = "Required provider CLI is unavailable";
  } else if (
    errorStatus === 400
    || normalized.includes("invalid request")
    || normalized.includes("bad request")
    || normalized.includes("rejected the request")
  ) {
    category = "Provider rejected the request";
  } else if (
    normalized.includes("network")
    || normalized.includes("connect")
    || normalized.includes("dns")
  ) {
    category = "Provider connection failed";
  } else {
    category = "Provider request failed";
  }

  const boundedStatus =
    Number.isInteger(errorStatus) && errorStatus! >= 100 && errorStatus! <= 599
      ? ` (HTTP ${errorStatus})`
      : "";
  const diagnosticId = errorText.match(/\bdiagnosticId:\s*([a-f0-9]{12})\b/i)?.[1];
  const boundedDiagnostic = diagnosticId ? ` (diagnosticId: ${diagnosticId})` : "";
  return `${category}${boundedStatus}${boundedDiagnostic}`;
}

function getTurnTokenTotal(usage: TurnTokenUsageInput): number {
  return usage.inputTokens + usage.outputTokens + usage.cacheReadTokens + usage.cacheCreationTokens;
}

function mergeUsageCount(next: number, prev: number | undefined): number {
  return next > 0 ? next : (prev ?? 0);
}

function setCurrentTurnUsage(
  ctx: StreamRequestContext,
  usage: TurnTokenUsageInput,
  mode: "merge" | "replace",
): TurnUsageData {
  const prev = ctx.currentTurnUsage;
  const next: TurnUsageData = {
    inputTokens:
      mode === "merge" ? mergeUsageCount(usage.inputTokens, prev?.inputTokens) : usage.inputTokens,
    outputTokens:
      mode === "merge"
        ? mergeUsageCount(usage.outputTokens, prev?.outputTokens)
        : usage.outputTokens,
    cacheReadTokens:
      mode === "merge"
        ? mergeUsageCount(usage.cacheReadTokens, prev?.cacheReadTokens)
        : usage.cacheReadTokens,
    cacheCreationTokens:
      mode === "merge"
        ? mergeUsageCount(usage.cacheCreationTokens, prev?.cacheCreationTokens)
        : usage.cacheCreationTokens,
    totalTokens: 0,
    durationMs: prev?.durationMs ?? 0,
  };
  const withTotal = { ...next, totalTokens: getTurnTokenTotal(next) };
  ctx.currentTurnUsage = withTotal;
  if (ctx.completedMessageId === ctx.messageId) {
    ctx.completedTurnUsage = withTotal;
  }
  return withTotal;
}

function snapshotCompletedTurn(ctx: StreamRequestContext): void {
  ctx.completedTurnStartedAt = ctx.turnStartedAt ?? ctx.startedAt;
  ctx.completedTurnUsage = ctx.currentTurnUsage;
}

function finalizeTurnUsage(
  ctx: StreamRequestContext,
  durationMs: number,
  useCompleted: boolean,
): TurnUsageData {
  const base = useCompleted
    ? (ctx.completedTurnUsage ?? ctx.currentTurnUsage)
    : ctx.currentTurnUsage;
  const tokenUsage = {
    inputTokens: base?.inputTokens ?? 0,
    outputTokens: base?.outputTokens ?? 0,
    cacheReadTokens: base?.cacheReadTokens ?? 0,
    cacheCreationTokens: base?.cacheCreationTokens ?? 0,
  };
  return {
    ...tokenUsage,
    totalTokens: base?.totalTokens ?? getTurnTokenTotal(tokenUsage),
    durationMs,
  };
}

/**
 * Register listeners for system / lifecycle events:
 *   - chat-done              (stream finished)
 *   - chat-error             (stream error)
 *   - chat-session           (session ID assigned)
 *   - chat-usage             (cumulative token usage)
 *   - chat-stream-usage      (real-time token usage)
 *   - chat-subagent-started   (subagent spawned)
 *   - chat-subagent-stopped   (subagent terminated)
 *   - chat-subagent-completed (subagent finished with result)
 *   - chat-todo-updated       (todo list changed)
 *   - chat-system-init       (system initialization)
 *   - chat-compact           (context compaction boundary)
 */
export async function registerSystemHandlers(params: ListenerParams): Promise<UnlistenFn[]> {
  const { registry, shouldIgnore, syncWriter } = params;

  // ---- chat-done ---------------------------------------------------------
  const u1 = await windowListen<DonePayload>("chat-done", (e) => {
    if (shouldIgnore()) return;
    const activeConvId = useConversationStore.getState().activeConversationId;

    // ── Warm session registration ────────────────────────────────────
    // When sessionAlive=true, the CLI process stays alive waiting for
    // the next message. Register it in the warm session tracker so the
    // next handleSend can route via send_user_input.
    if (e.payload.session_alive && e.payload.conversation_id) {
      // Prefer config snapshot captured at request creation time — immune to
      // platform/workspace/permission switches that happen mid-stream.
      const reqCtx = getStreamRequestContext(registry, e.payload.request_id);
      if (reqCtx?.warmSessionConfig) {
        registerWarmSession(
          e.payload.conversation_id,
          e.payload.request_id,
          reqCtx.warmSessionConfig,
        );
      } else {
        // Fallback for contexts created before warmSessionConfig was added.
        const settingsState = useSettingsStore.getState();
        const platformConfig = settingsState.platforms[settingsState.activePlatformId];
        const workspacePath = useWorkspaceStore.getState().activeWorkspace?.path ?? "";

        const profile = platformConfig.profiles.find(
          (candidate) => candidate.id === platformConfig.activeProfileId,
        );
        const resolvedAuthMode: "apiKey" | "oauth" =
          profile?.authMode === "oauth" ? "oauth" : "apiKey";
        const resolvedProfileId = resolvedAuthMode === "oauth" ? profile?.id : undefined;
        const creds = resolveActiveCredentials(platformConfig);
        const resolvedModel = creds?.model ?? platformConfig.activeModelId;
        const resolvedApiKey = resolvedAuthMode === "oauth" ? "" : (creds?.apiKey ?? "");
        const resolvedBaseUrl = resolvedAuthMode === "oauth" ? "" : (creds?.baseUrl ?? "");
        const resolvedSdk = getEffectiveSdk(platformConfig);
        const resolvedProxyUrl =
          resolvedSdk === "claude" || resolvedSdk === "codex"
            ? buildProfileProxyUrl(profile)
            : undefined;

        registerWarmSession(e.payload.conversation_id, e.payload.request_id, {
          model: resolvedModel,
          platformId: settingsState.activePlatformId,
          cwd: workspacePath,
          reasoningLevel: settingsState.reasoningLevel ?? "off",
          apiKey: resolvedApiKey,
          baseUrl: resolvedBaseUrl,
          authMode: resolvedAuthMode,
          profileId: resolvedProfileId,
          permissionMode: usePermissionStore.getState().mode,
          proxyUrl: resolvedProxyUrl ?? "",
        });
      }
    }

    // ── Context lifecycle ────────────────────────────────────────────
    // When the CLI session stays alive (session_alive=true), the sidecar
    // may process more turns (mid-stream messages, warm session reuse).
    // Keep the context in the registry so chat-new-turn can find it and
    // restart streaming. Stop the streaming indicator for now — it will
    // be restarted by chat-new-turn if a follow-up turn begins.
    //
    // When session_alive=false (session ended, error, timeout), remove
    // the context entirely for full cleanup.
    const sessionStillAlive = !!(e.payload.session_alive && e.payload.conversation_id);
    let ctx: StreamRequestContext | undefined;

    if (sessionStillAlive) {
      ctx = getStreamRequestContext(registry, e.payload.request_id);
      if (ctx) {
        ctx.streamingActive = false;
        // For text-producing turns, wait until chat-complete writes the final
        // content before clearing the foreground streaming state. `chat-done`
        // can arrive slightly early; clearing here would make the input/message
        // pulse disappear while output is still in-flight.
        const hasNoVisibleStreamOutput =
          !ctx.completedContent && ctx.accumulated.length === 0 && ctx.thinkingBlocks.length === 0;
        if (ctx.conversationId === activeConvId && hasNoVisibleStreamOutput) {
          syncWriter.setStreaming(false);
        }
      }
    } else {
      ctx = removeRequestAndSyncStreamState(
        registry,
        e.payload.request_id,
        syncWriter,
        activeConvId,
      );
    }

    if (!ctx) return;

    const isBackground = ctx.conversationId != null && ctx.conversationId !== activeConvId;
    const agentStore = useAgentStatusStore.getState();

    // Clear real-time stream usage for the target conversation -- final usage
    // is reflected separately via chat-usage.
    if (isBackground && ctx.conversationId) {
      agentStore.clearCachedStreamUsage(ctx.conversationId);
    } else {
      agentStore.clearStreamUsage();
    }

    // Ensure compacting indicator is cleared when the target turn finishes.
    agentStore.clearCompacting(ctx.conversationId, !sessionStillAlive);

    finalizeAgentTurnAndTodos(ctx.conversationId, activeConvId);

    // Mark background conversations as "completed" for tab shimmer effect
    if (isBackground && ctx.conversationId) {
      useStreamStateStore.getState().markConversationCompleted(ctx.conversationId);
    }

    // ── Auto-create checkpoint when files were changed ────────────────
    {
      const effectiveConvId = ctx.conversationId ?? activeConvId;
      const fileState = useFileChangesStore.getState().getConversationState(effectiveConvId);
      const workspacePath = useWorkspaceStore.getState().activeWorkspace?.path ?? "";
      if (fileState.changes.length > 0 && workspacePath) {
        let totalAdd = 0;
        let totalDel = 0;
        for (const c of fileState.changes) {
          totalAdd += c.additions;
          totalDel += c.deletions;
        }
        const label = `Turn ${fileState.changes.length} file${fileState.changes.length > 1 ? "s" : ""} changed (+${totalAdd}/-${totalDel})`;
        useCheckpointStore
          .getState()
          .createCheckpoint(
            effectiveConvId,
            workspacePath,
            label,
            fileState.changes.length,
            totalAdd,
            totalDel,
          )
          .catch(() => {
            if (import.meta.env.DEV) {
              console.warn("[checkpoint] auto-create failed");
            }
          });
      }
    }

    const completedMessageId = ctx.completedMessageId;

    // Accumulate turn duration per request/conversation to avoid cross-pane leakage.
    const turnStartedAt = completedMessageId
      ? (ctx.completedTurnStartedAt ?? ctx.turnStartedAt ?? ctx.startedAt)
      : (ctx.turnStartedAt ?? ctx.startedAt);
    const turnDuration = Math.max(0, Date.now() - (turnStartedAt ?? Date.now()));
    const turnUsage = finalizeTurnUsage(ctx, turnDuration, completedMessageId != null);
    if (completedMessageId) {
      ctx.completedTurnUsage = turnUsage;
    } else {
      ctx.currentTurnUsage = turnUsage;
    }
    if (turnDuration > 0) {
      if (isBackground && ctx.conversationId) {
        agentStore.addCachedTurnDuration(ctx.conversationId, turnDuration);
      } else {
        agentStore.addTurnDuration(turnDuration);
      }
      // Re-persist usage with updated duration
      if (ctx.conversationId) {
        const freshUsage = isBackground
          ? useAgentStatusStore.getState()._agentStatusCache[ctx.conversationId]?.lastUsage
          : useAgentStatusStore.getState().lastUsage;
        if (freshUsage) {
          useAgentStatusStore.getState().persistUsage(ctx.conversationId, freshUsage);
        }
      }
    }

    const store = useChatStore.getState();
    const completedContent = ctx.completedContent;
    const mid = completedMessageId ?? ctx.messageId;
    const effectiveContent = completedContent ?? ctx.accumulated;
    if (mid && !effectiveContent) {
      const currentMsg = store.messages.find((m) => m.id === mid);
      const hasMedia = currentMsg?.media && currentMsg.media.length > 0;
      const hasToolCalls = currentMsg?.toolCalls && currentMsg.toolCalls.length > 0;
      const hasThinking = currentMsg?.thinkingBlocks && currentMsg.thinkingBlocks.length > 0;
      if (!hasMedia && !hasToolCalls && !hasThinking) {
        store.updateMessageContent(mid, "(No response received)");
      }
    }

    const convId = ctx.conversationId;

    // Resolve the messages that belong to THIS conversation before the
    // snapshot is cleared.  store.messages only holds the *active* (foreground)
    // conversation.  For background conversations we must read from the
    // snapshot instead; otherwise we'd accidentally use the wrong
    // conversation's messages (the bug that caused title-generation to pick
    // up content from a different session).
    const convMessages: ReadonlyArray<import("@/stores/chat-store").ChatMessage> = isBackground
      ? (store._snapshots[convId ?? ""]?.messages ?? [])
      : store.messages;

    if (mid && convId) {
      let assistantMsg = convMessages.find((m) => m.id === mid);
      if (!assistantMsg) {
        // Double-check snapshot in case isBackground detection shifted
        const snap = store._snapshots[convId];
        assistantMsg = snap?.messages.find((m) => m.id === mid);
      }

      if (assistantMsg) {
        const finalContent = effectiveContent || assistantMsg.content;
        store.updateMessageTurnUsage(mid, turnUsage);
        store.persistMessage(convId, { ...assistantMsg, content: finalContent, turnUsage });
      } else if (effectiveContent) {
        const fallbackMsg = {
          id: mid,
          role: ctx.sdk ?? "claude",
          content: effectiveContent,
          agent: ctx.modelLabel,
          timestamp: ctx.startedAt ?? Date.now(),
          turnUsage,
        } as const;
        store.updateMessageTurnUsage(mid, turnUsage);
        store.persistMessage(convId, {
          ...fallbackMsg,
        });
      } else {
        console.warn("[chat-done] assistant message was unavailable");
      }

      // For Claude JSONL sessions, also sync metadata (message count, preview, FTS)
      const convSummary = useConversationStore
        .getState()
        .conversations.find((c) => c.id === convId);
      if (isClaudeSession(convSummary?.session_id)) {
        invoke("sync_conversation_from_jsonl", {
          conversationId: convId,
        }).catch(() => {
          console.error("sync_conversation_from_jsonl failed");
        });
      }

      if (isBackground) {
        useChatStore.setState((state) => {
          const snapshot = state._snapshots[convId];
          if (!snapshot) {
            return state;
          }
          return {
            _snapshots: {
              ...state._snapshots,
              [convId]: {
                ...snapshot,
                isStreaming: false,
                streamingMessageId: null,
                streamingConversationId: null,
                streamStartTime: null,
                streamPhase: null,
              },
            },
          };
        });
      } else {
        store.clearSnapshot(convId);
      }

      // For new conversations, load full list so it appears in sidebar.
      // For existing ones, do an optimistic in-memory update to avoid
      // the full list_conversations IPC round-trip.
      if (ctx.isNewConversation) {
        useConversationStore.getState().loadConversations();
      } else {
        useConversationStore.getState().updateConversationInPlace(convId, {
          updated_at: new Date().toISOString(),
        });
      }

      // Sync _dbTotal with the real DB count to fix pagination drift
      store.refreshDbTotal(convId);
    }

    const msgCount = convMessages.length;
    if (convId && msgCount >= 6 && (msgCount === 6 || (msgCount - 6) % 10 === 0)) {
      const settings = useSettingsStore.getState();
      const platformConfig = settings.platforms[settings.activePlatformId];
      const creds = resolveActiveCredentials(platformConfig);
      const sdk = getEffectiveSdk(platformConfig);
      const activeProfile = platformConfig?.profiles.find(
        (p) => p.id === platformConfig.activeProfileId,
      );
      const proxy =
        sdk === "claude"
          ? buildProfileProxyUrl(activeProfile)
          : settings.proxyEnabled && settings.proxyUrl
            ? settings.proxyUrl
            : undefined;
      if (sdk === "claude" && !proxy) return;
      invoke("generate_conversation_summary", {
        sdk,
        conversationId: convId,
        baseUrl: creds?.baseUrl || undefined,
        apiKey: creds?.apiKey || undefined,
        model: creds?.model || undefined,
        proxyUrl: proxy,
      }).catch(() => {
        console.error("generate_conversation_summary failed");
      });
    }

    // Title generation is normally triggered early (on the first chat-delta).
    // This fallback covers edge cases where the delta trigger didn't fire.
    if (convId && !ctx.titleTriggered) {
      // Populate firstUserMessage from convMessages if still missing
      if (!ctx.firstUserMessage) {
        ctx.firstUserMessage = convMessages.find((m) => m.role === "user")?.content ?? "";
      }
      triggerTitleGeneration(ctx);
    }

    // ── 发送系统完成通知 ─────────────────────────────────────────────────
    // 剥离 Markdown 格式符后取前 80 字作为通知正文预览
    const plainText = effectiveContent ? stripMarkdown(effectiveContent) : "";
    const responsePreview = plainText
      ? plainText.slice(0, 80) + (plainText.length > 80 ? "…" : "")
      : undefined;

    notificationManager
      .notify(
        {
          eventType: isBackground ? "background_task_complete" : "ai_stream_complete",
          title: "AI 响应完成",
          body: responsePreview,
          conversationId: convId ?? undefined,
          metadata: { requestId: e.payload.request_id },
        },
        // 窗口有焦点时不打扰（已在前台看着屏幕），OS 渠道静默
        // 后台会话无论是否聚焦都应提醒
        { onlyWhenUnfocused: !isBackground, channels: ["os"] },
      )
      .catch(() => {
        // 通知发送失败不影响主流程；仅在开发模式下打印以便调试
        if (import.meta.env.DEV) {
          console.warn("[system-handlers] notification delivery failed");
        }
      });
    // ────────────────────────────────────────────────────────────────────

    if (completedMessageId && ctx.completedMessageId === completedMessageId) {
      ctx.completedMessageId = undefined;
      ctx.completedContent = undefined;
      ctx.completedTurnStartedAt = undefined;
      ctx.completedTurnUsage = undefined;
    }
  });

  // ---- chat-error --------------------------------------------------------
  const u2 = await windowListen<ErrorPayload>("chat-error", (e) => {
    if (shouldIgnore()) return;
    const rawErrorText = e.payload.error || "Unknown error";
    const errorText = formatChatError(rawErrorText, e.payload.error_status);
    const rid = e.payload.request_id;

    console.error(
      `[chat-error] provider stream failed status=${e.payload.error_status ?? "none"}`,
    );

    const activeConvId = useConversationStore.getState().activeConversationId;
    const ctx = removeRequestAndSyncStreamState(registry, rid, syncWriter, activeConvId);

    if (!ctx) {
      // Context not found — the error may come from a warm session whose
      // request ID doesn't match the current stream context. Still show it.
      console.warn("[chat-error] no stream context; showing bounded error in active conversation");
      if (activeConvId) {
        const store = useChatStore.getState();
        const errorMsg = {
          id: crypto.randomUUID(),
          role: "claude" as const,
          content: `**Error:** ${errorText}`,
          timestamp: Date.now(),
        };
        store.addMessage(errorMsg);
      }
      return;
    }

    useAgentStatusStore.getState().clearCompacting(ctx.conversationId, true);
    finalizeAgentTurnAndTodos(ctx.conversationId, activeConvId);

    const store = useChatStore.getState();
    const mid = ctx.messageId;
    if (mid) {
      if (ctx.accumulated) {
        store.updateMessageContent(mid, ctx.accumulated + `\n\n---\n**Error:** ${errorText}`);
      } else {
        store.updateMessageContent(mid, `**Error:** ${errorText}`);
      }
    }

    const convId = ctx.conversationId;
    if (convId) {
      store.clearSnapshot(convId);
      // Clear warm session so the next message starts a fresh session
      // instead of being routed to a potentially dead warm session.
      clearWarmSession(convId);
    }
  });

  // ---- chat-session ------------------------------------------------------
  const u3 = await windowListen<SessionPayload>("chat-session", (e) => {
    if (shouldIgnore()) return;
    const ctx = getStreamRequestContext(registry, e.payload.request_id);
    if (!ctx) return;
    const convId = ctx.conversationId;
    if (convId && e.payload.session_id) {
      const newSessionId = e.payload.session_id;
      const convList = useConversationStore.getState().conversations;
      const oldSessionId = convList.find((c) => c.id === convId)?.session_id;

      // [cross-session-guard] Hard guard: refuse to assign a session_id that
      // ALREADY belongs to a different conversation. Doing so would make this
      // conversation resume the other's JSONL and surface its history here — the
      // exact "A shows B's history" leak. A fork gets a brand-new session id (no
      // other conv owns it), so this never false-positives on forks. The
      // in-memory list is already filtered to non-deleted conversations. If this
      // ever fires, the persisted line is irrefutable evidence with both
      // conversation ids and the requestId.
      const owner = convList.find((c) => c.id !== convId && c.session_id === newSessionId);
      if (owner) {
        console.error("[chat-session] cross-session guard rejected a session assignment");
        persistCrossSession("cross-session guard rejected a session assignment");
        return;
      }

      if (oldSessionId && oldSessionId !== newSessionId) {
        console.warn("[chat-session] session identifier changed");
      }

      useConversationStore.getState().updateSessionId(convId, newSessionId);

      // Advance cold-start phase: connecting → waiting (foreground only)
      const { streamPhase, setStreamPhase } = useStreamStateStore.getState();
      if (streamPhase === "connecting") {
        const activeConvId = useConversationStore.getState().activeConversationId;
        if (convId === activeConvId) {
          setStreamPhase("waiting");
        }
      }

      // Mark Claude sessions as JSONL source (non-prefixed session IDs)
      if (isClaudeSession(newSessionId)) {
        invoke("set_conversation_message_source", {
          conversationId: convId,
          messageSource: "jsonl",
        }).catch(() => {
          console.error("set_conversation_message_source failed");
        });
      }
    }
  });

  // ---- chat-usage --------------------------------------------------------
  const u4 = await windowListen<UsagePayload>("chat-usage", (e) => {
    if (shouldIgnore()) return;
    const ctx = getStreamRequestContext(registry, e.payload.request_id);
    if (!ctx) return;

    const usage = {
      inputTokens: e.payload.input_tokens,
      outputTokens: e.payload.output_tokens,
      cacheReadTokens: e.payload.cache_read_tokens,
      cacheCreationTokens: e.payload.cache_creation_tokens,
      totalCostUsd: e.payload.total_cost_usd,
      contextWindow: e.payload.context_window,
      model: e.payload.model,
      totalDurationMs: 0, // Duration is accumulated inside setUsage/updateCachedUsage from streamStartTime
    };
    setCurrentTurnUsage(ctx, usage, "replace");

    const agentStore = useAgentStatusStore.getState();
    const activeConvId = useConversationStore.getState().activeConversationId;
    const isBackground = ctx.conversationId != null && ctx.conversationId !== activeConvId;
    if (isBackground) {
      agentStore.updateCachedUsage(ctx.conversationId!, usage);
    } else {
      agentStore.setUsage(usage);
    }

    // Persist accumulated usage to DB
    const convId = ctx.conversationId;
    if (convId) {
      const freshAgentStore = useAgentStatusStore.getState();
      const usageToSave = isBackground
        ? freshAgentStore._agentStatusCache[convId]?.lastUsage
        : freshAgentStore.lastUsage;
      if (usageToSave) {
        freshAgentStore.persistUsage(convId, usageToSave);
      }
    }
  });

  // ---- chat-stream-usage -------------------------------------------------
  // Real-time token usage from stream events (message_start / message_delta).
  // Arrives before the first content delta -- lets the UI show context size
  // while waiting for the model to produce output.
  const u5 = await windowListen<StreamUsagePayload>("chat-stream-usage", (e) => {
    if (shouldIgnore()) return;
    const ctx = getStreamRequestContext(registry, e.payload.request_id);
    if (!ctx) return;
    refreshStreamSafetyTimeout();

    const agentStore = useAgentStatusStore.getState();
    const activeConvId = useConversationStore.getState().activeConversationId;
    const isBackground = ctx.conversationId != null && ctx.conversationId !== activeConvId;
    const nextUsage = {
      requestId: e.payload.request_id,
      inputTokens: e.payload.input_tokens,
      outputTokens: e.payload.output_tokens,
      cacheReadTokens: e.payload.cache_read_tokens,
      cacheCreationTokens: e.payload.cache_creation_tokens,
      contextWindow: e.payload.context_window,
    };
    setCurrentTurnUsage(ctx, nextUsage, "merge");
    if (isBackground) {
      agentStore.setCachedStreamUsage(ctx.conversationId!, nextUsage);
    } else {
      agentStore.setStreamUsage(nextUsage);
    }

    // Fallback phase advance for providers that emit stream-usage before chat-session (foreground only)
    const { streamPhase, setStreamPhase } = useStreamStateStore.getState();
    if (streamPhase === "connecting") {
      const activeConvId = useConversationStore.getState().activeConversationId;
      if (ctx.conversationId === activeConvId) {
        setStreamPhase("waiting");
      }
    }
  });

  // ---- chat-context-usage ------------------------------------------------
  // Provider context snapshot. It may be emitted from a background request,
  // so it may arrive after chat-done and must route by conversation id when
  // the request registry entry has already been removed.
  const uContext = await windowListen<ContextUsagePayload>("chat-context-usage", (e) => {
    if (shouldIgnore()) return;
    const ctx = getStreamRequestContext(registry, e.payload.request_id);
    const activeConvId = useConversationStore.getState().activeConversationId;
    const conversationId = e.payload.conversation_id ?? ctx?.conversationId;
    if (!conversationId) return;
    const snapshot = {
      requestId: e.payload.request_id,
      totalTokens: e.payload.total_tokens,
      maxTokens: e.payload.max_tokens,
      percentage: e.payload.percentage,
      updatedAt: e.payload.requested_at,
      breakdownJson: e.payload.snapshot ? JSON.stringify(e.payload.snapshot) : undefined,
    };
    const agentStore = useAgentStatusStore.getState();
    if (conversationId && conversationId !== activeConvId) {
      agentStore.setCachedContextUsage(conversationId, snapshot);
    } else {
      agentStore.setContextUsage(snapshot);
    }
    if (conversationId) {
      void agentStore.persistContextUsage(conversationId, snapshot);
    }
  });

  // ---- chat-goal-updated -------------------------------------------------
  const uGoal = await windowListen<GoalUpdatedPayload>("chat-goal-updated", (e) => {
    if (shouldIgnore()) return;
    const ctx = getStreamRequestContext(registry, e.payload.request_id);
    const activeConvId = useConversationStore.getState().activeConversationId;
    const conversationId = e.payload.conversation_id ?? ctx?.conversationId ?? activeConvId;
    if (!conversationId) return;

    const rawGoal = e.payload.goal ?? {};
    const snapshot = {
      conversationId,
      requestId: e.payload.request_id,
      threadId: e.payload.thread_id,
      objective: rawGoal.objective ?? "",
      status: normalizeGoalStatus(rawGoal.status),
      tokenBudget: rawGoal.tokenBudget ?? null,
      tokensUsed: rawGoal.tokensUsed ?? null,
      timeUsedSeconds: rawGoal.timeUsedSeconds ?? null,
      updatedAt: Date.now(),
      source:
        e.payload.source === "notification" ? ("notification" as const) : ("app-server" as const),
    };
    console.warn("[goal-panel] chat-goal-updated", {
      source: e.payload.source,
      conversationPresent: Boolean(conversationId),
      threadPresent: Boolean(e.payload.thread_id),
      objectivePresent: Boolean(rawGoal.objective),
      objectiveLength: rawGoal.objective?.length ?? 0,
      statusPresent: Boolean(rawGoal.status),
      tokenBudgetPresent: rawGoal.tokenBudget != null,
      tokensUsedPresent: rawGoal.tokensUsed != null,
      timeUsedPresent: rawGoal.timeUsedSeconds != null,
    });
    const goalStore = useGoalSessionStore.getState();
    goalStore.upsertGoalSnapshot(snapshot);
    goalStore.addActivity({
      conversationId,
      kind: snapshot.status === "blocked" || snapshot.status === "failed" ? "blocked" : "goal",
      message: snapshot.objective || rawGoal.status || "Goal updated",
    });
  });

  // ---- chat-subagent-started ---------------------------------------------
  const u6 = await windowListen<SubagentStartedPayload>("chat-subagent-started", (e) => {
    if (shouldIgnore()) return;
    const ctx = getStreamRequestContext(registry, e.payload.request_id);
    if (!ctx) return;
    refreshStreamSafetyTimeout();

    const activeConvId = useConversationStore.getState().activeConversationId;
    if (ctx.conversationId != null && ctx.conversationId !== activeConvId) {
      useAgentStatusStore
        .getState()
        .addCachedSubagent(
          ctx.conversationId,
          e.payload.agent_id,
          e.payload.agent_type,
          e.payload.name,
          e.payload.description,
          e.payload.session_id,
          e.payload.prompt,
        );
    } else {
      useAgentStatusStore
        .getState()
        .addSubagent(
          e.payload.agent_id,
          e.payload.agent_type,
          e.payload.name,
          e.payload.description,
          e.payload.session_id,
          e.payload.prompt,
        );
    }
  });

  // ---- chat-subagent-stopped ---------------------------------------------
  const u7 = await windowListen<SubagentStoppedPayload>("chat-subagent-stopped", (e) => {
    if (shouldIgnore()) return;
    const ctx = getStreamRequestContext(registry, e.payload.request_id);
    if (!ctx) return;
    refreshStreamSafetyTimeout();

    const activeConvId = useConversationStore.getState().activeConversationId;
    if (ctx.conversationId != null && ctx.conversationId !== activeConvId) {
      useAgentStatusStore.getState().removeCachedSubagent(ctx.conversationId, e.payload.agent_id);
    } else {
      useAgentStatusStore.getState().removeSubagent(e.payload.agent_id);
    }
  });

  // ---- chat-subagent-text-delta ------------------------------------------
  // Streaming natural-language text from a subagent (parent_tool_use_id != null).
  // Routed via SDK session_id to the matching SubagentInfo so the floating
  // panel can render the subagent's reply in real time without polluting the
  // main conversation bubble.
  const uSAT = await windowListen<SubagentTextDeltaPayload>("chat-subagent-text-delta", (e) => {
    if (shouldIgnore()) return;
    const ctx = getStreamRequestContext(registry, e.payload.request_id);
    if (!ctx) return;
    refreshStreamSafetyTimeout();

    const activeConvId = useConversationStore.getState().activeConversationId;
    const sid = e.payload.subagent_session_id;
    if (ctx.conversationId != null && ctx.conversationId !== activeConvId) {
      useAgentStatusStore
        .getState()
        .appendCachedSubagentTextDelta(ctx.conversationId, sid, e.payload.delta);
    } else {
      useAgentStatusStore.getState().appendSubagentTextDelta(sid, e.payload.delta);
    }
  });

  // ---- chat-subagent-thinking-delta --------------------------------------
  // Streaming extended-thinking content from a subagent.
  const uSAH = await windowListen<SubagentThinkingDeltaPayload>(
    "chat-subagent-thinking-delta",
    (e) => {
      if (shouldIgnore()) return;
      const ctx = getStreamRequestContext(registry, e.payload.request_id);
      if (!ctx) return;
      refreshStreamSafetyTimeout();

      const activeConvId = useConversationStore.getState().activeConversationId;
      const sid = e.payload.subagent_session_id;
      if (ctx.conversationId != null && ctx.conversationId !== activeConvId) {
        useAgentStatusStore
          .getState()
          .appendCachedSubagentThinkingDelta(
            ctx.conversationId,
            sid,
            e.payload.delta,
            e.payload.start_new_block,
          );
      } else {
        useAgentStatusStore
          .getState()
          .appendSubagentThinkingDelta(sid, e.payload.delta, e.payload.start_new_block);
      }
    },
  );

  // ---- chat-todo-updated -------------------------------------------------
  const u8 = await windowListen<TodoUpdatedPayload>("chat-todo-updated", (e) => {
    if (shouldIgnore()) return;
    const ctx = getStreamRequestContext(registry, e.payload.request_id);
    if (!ctx) return;
    refreshStreamSafetyTimeout();

    const parsedTodos = e.payload.todos.map((t) => ({
      content: t.content,
      status: parseTodoStatus(t.status),
      activeForm: t.activeForm,
    }));

    const activeConvId = useConversationStore.getState().activeConversationId;
    const convId = ctx.conversationId;
    const isBackground = convId != null && convId !== activeConvId;

    if (isBackground) {
      useAgentStatusStore.getState().updateCachedTodos(convId, parsedTodos);
    } else {
      useAgentStatusStore.getState().mergeTodos(parsedTodos);
    }

    // Persist to DB for durability across restarts (re-read state after merge)
    if (convId) {
      const freshAgentStore = useAgentStatusStore.getState();
      const todosToSave = isBackground
        ? (freshAgentStore._agentStatusCache[convId]?.todos ?? parsedTodos)
        : freshAgentStore.todos;
      freshAgentStore.persistTodos(convId, todosToSave);
    }
  });

  // ---- chat-system-init --------------------------------------------------
  const u9 = await windowListen<SystemInitPayload>("chat-system-init", (e) => {
    if (shouldIgnore()) return;
    // No ctx check -- init_session events arrive outside normal stream requests

    // Record the CLI-reported fast-mode state so the model selector can show
    // whether fast mode actually took effect (on / off / cooldown).
    useAgentStatusStore.getState().setClaudeFastModeState(e.payload.fast_mode_state ?? null);
    // Session tool list — /status uses it to prove whether session features
    // (e.g. ultracode's Workflow tool) actually loaded in the CLI.
    useAgentStatusStore.getState().setClaudeSessionTools(e.payload.tools ?? null);

    const toolStore = useToolStateStore.getState();
    toolStore.setMcpServers(e.payload.mcp_servers.map((s) => ({ name: s.name, status: s.status })));

    // SDK provides full SlashCommand metadata via Query.supportedCommands() —
    // the sidecar already enriches it before emitting. We pass it through
    // verbatim, only falling back to the filesystem desc map / known
    // description map when SDK didn't supply a description (degraded paths).
    //
    // Bucketed under platformId="claude": only Claude (and Teams, which is
    // built on the Claude SDK) emits system_init with rich command metadata.
    // Codex / Gemini / ChatCompletion never send this event — their command
    // lists come from the filesystem scanner alone, written under their own
    // platformId by use-chip-management.
    const claudePlatformId = "claude";
    const existing = toolStore.getSlashCommandsForPlatform(claudePlatformId);
    const descMap = new Map(existing.map((c) => [c.name, c.description]));
    const sdkCommands = e.payload.slash_commands.map((c) => ({
      name: c.name,
      description: c.description || descMap.get(c.name) || getKnownDescription(c.name),
      argumentHint: c.argumentHint,
      aliases: c.aliases,
      source: "sdk" as const,
    }));
    toolStore.setSlashCommandsForPlatform(claudePlatformId, sdkCommands);
  });

  // ---- chat-compact ------------------------------------------------------
  // Context compaction boundary from the Claude SDK (compact_boundary message).
  // IMPORTANT: This arrives *after* compaction finishes, not when it starts.
  // For manual /compact: the UI already set compacting=true in handleSend,
  // so this just updates preTokens. For auto-compact: this is our only signal,
  // so we set compacting here (briefly visible before the next text_delta clears it).
  // Cleared automatically when the next text delta arrives or the turn ends.
  const u10 = await windowListen<CompactPayload>("chat-compact", (e) => {
    if (shouldIgnore()) return;
    const ctx = getStreamRequestContext(registry, e.payload.request_id);
    if (!ctx || ctx.streamingActive === false) return;
    refreshStreamSafetyTimeout();

    // Compaction inserts a system marker message into DB — refresh _dbTotal
    const convId = ctx.conversationId ?? useConversationStore.getState().activeConversationId;
    const trigger = e.payload.trigger === "manual" ? ("manual" as const) : ("auto" as const);
    useAgentStatusStore.getState().setCompacting(trigger, e.payload.pre_tokens, convId);

    if (convId) {
      useChatStore.getState().refreshDbTotal(convId);
    }
  });

  // ---- chat-subagent-completed --------------------------------------------
  // Emitted by PostToolUse(Task) hook when a subagent finishes.
  const u11 = await windowListen<SubagentCompletedPayload>("chat-subagent-completed", (e) => {
    if (shouldIgnore()) return;
    const ctx = getStreamRequestContext(registry, e.payload.request_id);
    if (!ctx) return;
    refreshStreamSafetyTimeout();
    useChatStore
      .getState()
      .updateToolCallResultById(e.payload.tool_use_id, e.payload.result, true, undefined, {
        status: "success",
        severity: "info",
      });
    const store = useAgentStatusStore.getState();
    const activeConvId = useConversationStore.getState().activeConversationId;
    const subagents =
      ctx.conversationId != null && ctx.conversationId !== activeConvId
        ? (store._agentStatusCache[ctx.conversationId]?.subagents ?? [])
        : store.subagents;
    const matchedAgentId =
      e.payload.agent_id ??
      [...subagents].reverse().find((sa) => {
        if (sa.finalResult) return false;
        if (
          e.payload.description &&
          (sa.name === e.payload.description || sa.description === e.payload.description)
        ) {
          return true;
        }
        if (
          e.payload.prompt &&
          (sa.prompt === e.payload.prompt || sa.description === e.payload.prompt)
        ) {
          return true;
        }
        return sa.status === "stopped" && sa.agentType === e.payload.subagent_type;
      })?.agentId;
    const completion = {
      status: "completed",
      result: e.payload.result,
      summary: e.payload.description,
    };
    if (ctx.conversationId != null && ctx.conversationId !== activeConvId) {
      useAgentStatusStore
        .getState()
        .completeCachedSubagentTask(ctx.conversationId, undefined, completion, matchedAgentId);
    } else {
      useAgentStatusStore.getState().completeSubagentTask(undefined, completion, matchedAgentId);
    }
  });

  // ---- chat-task-started --------------------------------------------------
  // Associates a task_id with an existing subagent via description matching.
  const uTS = await windowListen<TaskStartedPayload>("chat-task-started", (e) => {
    if (shouldIgnore()) return;
    const ctx = getStreamRequestContext(registry, e.payload.request_id);
    if (!ctx) return;
    refreshStreamSafetyTimeout();

    const store = useAgentStatusStore.getState();
    const activeConvId = useConversationStore.getState().activeConversationId;
    const isBackground = ctx.conversationId != null && ctx.conversationId !== activeConvId;
    const subagents = isBackground
      ? (store._agentStatusCache[ctx.conversationId!]?.subagents ?? [])
      : store.subagents;

    // Match by description, fallback to most recent active agent without taskId
    const desc = e.payload.description ?? "";
    let matched = subagents.find(
      (sa) => sa.status === "active" && !sa.taskId && (sa.name === desc || sa.description === desc),
    );
    if (!matched) {
      matched = [...subagents].reverse().find((sa) => sa.status === "active" && !sa.taskId);
    }
    if (!matched) return;

    // Workflow-spawned subagents arrive via SubagentStart with only an
    // agent_type ("workflow-subagent") and no name — the description lives on
    // the task_started message instead. Backfill it here so the panel shows the
    // real title (e.g. "Extract fast command definition…") rather than the type.
    if (isBackground) {
      store.setCachedSubagentTaskId(
        ctx.conversationId!,
        matched.agentId,
        e.payload.task_id,
        e.payload.description,
      );
    } else {
      store.setSubagentTaskId(matched.agentId, e.payload.task_id, e.payload.description);
    }
  });

  // ---- chat-task-progress -------------------------------------------------
  // Updates subagent progress (tools, duration, tokens, AI summary).
  const uTP = await windowListen<TaskProgressPayload>("chat-task-progress", (e) => {
    if (shouldIgnore()) return;
    const ctx = getStreamRequestContext(registry, e.payload.request_id);
    if (!ctx) return;
    refreshStreamSafetyTimeout();

    const store = useAgentStatusStore.getState();
    const activeConvId = useConversationStore.getState().activeConversationId;
    const progress = {
      totalTokens: e.payload.total_tokens,
      inputTokens: e.payload.input_tokens,
      outputTokens: e.payload.output_tokens,
      cacheReadTokens: e.payload.cache_read_tokens,
      cacheCreationTokens: e.payload.cache_creation_tokens,
      toolUses: e.payload.tool_uses,
      durationMs: e.payload.duration_ms,
      lastToolName: e.payload.last_tool_name,
      summary: e.payload.summary,
    };

    if (ctx.conversationId != null && ctx.conversationId !== activeConvId) {
      store.updateCachedSubagentProgress(
        ctx.conversationId,
        e.payload.task_id,
        progress,
        e.payload.agent_id,
      );
    } else {
      store.updateSubagentProgress(e.payload.task_id, progress, e.payload.agent_id);
    }
  });

  // ---- chat-task-notification ---------------------------------------------
  // Records subagent task completion/failure with final stats.
  const uTN = await windowListen<TaskNotificationPayload>("chat-task-notification", (e) => {
    if (shouldIgnore()) return;
    const ctx = getStreamRequestContext(registry, e.payload.request_id);
    if (!ctx) return;
    refreshStreamSafetyTimeout();

    const store = useAgentStatusStore.getState();
    const activeConvId = useConversationStore.getState().activeConversationId;
    const notification = {
      status: e.payload.status,
      summary: e.payload.summary,
      totalTokens: e.payload.total_tokens,
      inputTokens: e.payload.input_tokens,
      outputTokens: e.payload.output_tokens,
      cacheReadTokens: e.payload.cache_read_tokens,
      cacheCreationTokens: e.payload.cache_creation_tokens,
      toolUses: e.payload.tool_uses,
      durationMs: e.payload.duration_ms,
    };

    if (ctx.conversationId != null && ctx.conversationId !== activeConvId) {
      store.completeCachedSubagentTask(
        ctx.conversationId,
        e.payload.task_id,
        notification,
        e.payload.agent_id,
      );
    } else {
      store.completeSubagentTask(e.payload.task_id, notification, e.payload.agent_id);
    }
  });

  // ---- chat-new-turn ------------------------------------------------------
  // Emitted by the sidecar when a queued mid-stream user message is about to
  // start a new turn. Creates a fresh assistant placeholder and resets the
  // stream context so deltas from the new turn are correctly accumulated.
  const u12 = await windowListen<NewTurnPayload>("chat-new-turn", (e) => {
    if (shouldIgnore()) return;
    const ctx = getStreamRequestContext(registry, e.payload.request_id);
    if (!ctx) return;

    const activeConvId = useConversationStore.getState().activeConversationId;
    const isBackground = ctx.conversationId != null && ctx.conversationId !== activeConvId;
    const commandName = e.payload.commandName ?? e.payload.command_name;
    if (commandName === "compact") {
      useAgentStatusStore.getState().activatePendingCompacting(ctx.conversationId);
    }

    // Mark the queued user message as consumed in either the foreground
    // message list or the background snapshot before creating the assistant
    // placeholder for this turn.
    useChatStore.getState().markMidStreamConsumed(ctx.conversationId);

    // Background conversation: only update the per-request context state so
    // deltas are correctly accumulated. Do NOT touch the foreground's live
    // messages or global streaming indicator — that would pollute the UI of
    // whichever conversation the user is currently viewing.
    if (isBackground) {
      const newAssistantId = crypto.randomUUID();

      // Insert assistant placeholder into the snapshot so that subsequent
      // chat-delta / chat-tool-* events can find the message via _messageIndex.
      const sdk = ctx.sdk ?? ("claude" as const);
      const modelLabel = ctx.modelLabel ?? "";
      useChatStore.getState().addMessageToSnapshot(ctx.conversationId!, {
        id: newAssistantId,
        role: sdk,
        content: "",
        agent: modelLabel,
        timestamp: Date.now(),
      });

      snapshotCompletedTurn(ctx);
      ctx.messageId = newAssistantId;
      ctx.accumulated = "";
      ctx.contentPrefix = undefined;
      ctx.thinkingBlocks = [];
      ctx.thinkingPhaseActive = false;
      ctx.streamingActive = true;
      ctx.currentTurnUsage = undefined;
      ctx.turnStartedAt = Date.now();
      return;
    }

    // Regular mid-stream user message turn — create new assistant message.

    // Create a new assistant placeholder for the upcoming turn.
    // Use the platform info from the original request context (ctx.platformId/sdk)
    // instead of the current activePlatformId — the user may have switched
    // platforms in the UI since the original request was sent.
    const newAssistantId = crypto.randomUUID();
    const settingsState = useSettingsStore.getState();
    const originalPlatformId = (ctx.platformId ?? settingsState.activePlatformId) as PlatformId;
    const platformConfig = settingsState.platforms[originalPlatformId];
    const sdk = ctx.sdk ?? platformConfig?.sdk ?? "claude";

    // Prefer the label captured at request creation time.
    const modelLabel =
      ctx.modelLabel ??
      PLATFORM_REGISTRY[originalPlatformId]?.models.find(
        (m: { id: string; label: string }) => m.id === (platformConfig?.activeModelId ?? ""),
      )?.label ??
      platformConfig?.activeModelId ??
      "";
    useChatStore.getState().addMessage({
      id: newAssistantId,
      role: sdk,
      content: "",
      agent: modelLabel,
      timestamp: Date.now(),
    });

    // Reset per-turn mutable state so new deltas flow into the new message
    snapshotCompletedTurn(ctx);
    ctx.messageId = newAssistantId;
    ctx.accumulated = "";
    ctx.contentPrefix = undefined;
    ctx.thinkingBlocks = [];
    ctx.thinkingPhaseActive = false;
    ctx.streamingActive = true;
    ctx.currentTurnUsage = undefined;
    ctx.turnStartedAt = Date.now();

    // Update streaming pointers — ensures deltas are routed correctly
    syncWriter.setStreamingMessageId(newAssistantId);
    syncWriter.setStreamingConversationId(ctx.conversationId);
    syncWriter.setStreaming(true);
  });

  // ---- chat-stream-retry ----------------------------------------------------
  // Emitted when the sidecar retries a query after a transient/network error.
  // Preserves existing text content so the user doesn't lose already-displayed
  // messages. New text_delta events from the retry will be appended after the
  // existing content.
  const u15 = await windowListen<StreamRetryPayload>("chat-stream-retry", (e) => {
    if (shouldIgnore()) return;
    const ctx = getStreamRequestContext(registry, e.payload.request_id);
    if (!ctx) return;

    console.warn("[chat-stream-retry]", {
      attempt: e.payload.attempt,
      maxAttempts: e.payload.max_attempts,
    });

    // Preserve existing accumulated text — new deltas from the retry will
    // be appended after this content. Also preserve existing thinkingBlocks
    // so already-displayed Thought Summary entries are not lost. Only close
    // the active thinking phase so new thinking deltas start a fresh block.
    ctx.thinkingPhaseActive = false;

    // Do NOT clear ctx.accumulated or the store message content.
    // The retry creates a new Codex thread that generates fresh output;
    // sidecar resets its delta tracking so new text_delta events arrive
    // as incremental pieces which the frontend appends to ctx.accumulated.

    // Ensure streaming state stays active during the retry, but do NOT
    // reset streamStartTime if already streaming — that would zero the timer.
    // Only touch the global streaming indicator for the foreground conversation
    // to avoid polluting other sessions (same guard as chat-delta/chat-done).
    const activeConvId = useConversationStore.getState().activeConversationId;
    if (ctx.conversationId === activeConvId && !useStreamStateStore.getState().isStreaming) {
      syncWriter.setStreamingConversationId(ctx.conversationId);
      syncWriter.setStreaming(true);
    }

    // Set retry state so the UI can show the reconnect indicator (foreground only)
    if (ctx.conversationId === activeConvId) {
      useStreamStateStore
        .getState()
        .setRetryState(e.payload.attempt, e.payload.max_attempts, e.payload.reason);
    }

    // Refresh safety timeout during retry — the sidecar is still alive
    refreshStreamSafetyTimeout();
  });

  // ---- chat-session-ended ---------------------------------------------------
  // Emitted when a warm (persistent) CLI session ends — timeout, crash, or
  // explicit kill. Clean up the warm session tracker and registry entry.
  const u14 = await windowListen<SessionEndedPayload>("chat-session-ended", (e) => {
    if (shouldIgnore()) return;
    const { conversation_id, request_id } = e.payload;

    // Clear warm session tracking
    clearWarmSession(conversation_id);
    useAgentStatusStore.getState().clearCompacting(conversation_id, true);

    // Remove the SPECIFIC ended session's request context — NOT the latest
    // one for this conversation. When a warm session is killed due to config
    // change, a new request is already registered; using getLatest would
    // incorrectly remove the NEW request and cancel the user's message.
    const activeConvId = useConversationStore.getState().activeConversationId;
    removeRequestAndSyncStreamState(registry, request_id, syncWriter, activeConvId);
  });

  // ---- chat-session-invalidated -------------------------------------------
  // Emitted when the CLI process crashes and all retries are exhausted.
  // Clear the sessionId so the next user message starts a fresh session
  // instead of infinitely trying to resume a broken session.
  const u16 = await windowListen<SessionInvalidatedPayload>("chat-session-invalidated", (e) => {
    if (shouldIgnore()) return;
    const { conversation_id } = e.payload;
    console.warn("[chat-session-invalidated] clearing invalid session");

    // Clear the sessionId in the database so the next message starts fresh
    useConversationStore.getState().updateSessionId(conversation_id, "");
  });

  return [
    u1,
    u2,
    u3,
    u4,
    u5,
    uContext,
    uGoal,
    u6,
    u7,
    uSAT,
    uSAH,
    u8,
    u9,
    u10,
    u11,
    uTS,
    uTP,
    uTN,
    u12,
    u14,
    u15,
    u16,
  ];
}
