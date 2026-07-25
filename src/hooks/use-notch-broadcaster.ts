import { useEffect, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { emitTo, listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { useStreamStateStore } from "@/stores/stream-state-store";
import { useAgentStatusStore } from "@/stores/agent-status-store";
import { useSettingsStore } from "@/stores/settings-store";
import { useConversationStore } from "@/stores/conversation-store";
import { useChatStore } from "@/stores/chat-store";
import { useNotchApprovalStore } from "@/stores/notch-approval-store";
import { useToolStateStore } from "@/stores/tool-state-store";
import { useWindowFocusStore } from "@/stores/window-focus-store";
import type { ChatMessage } from "@/stores/chat-types";
import type { ToolConfirmPayload, AskUserQuestionPayload } from "@/lib/stream-handlers/types";
import { isMacPlatform } from "@/components/layout/window-controls";
import {
  broadcastNotchState,
  type NotchProvider,
  type NotchState,
  type NotchUsageBreakdown,
} from "@/lib/notch-bridge";
import {
  createTokenRateTracker,
  useTokenRateStore,
  type TokenRateTracker,
} from "@/lib/token-rate-tracker";
import { getGlobalRegistry, getGlobalStreamStateWriter } from "@/lib/chat-stream-manager";
import {
  getActiveStreamRequestContext,
  getStreamRequestContext,
  setActiveStreamRequest,
} from "@/lib/chat-stream-registry";
import { removeRequestAndSyncStreamState } from "@/lib/chat-stream-state";
import { clearWarmSession } from "@/lib/warm-session-tracker";
import { ALL_PLATFORM_IDS, decodeConversationModel, type PlatformId } from "@/lib/platform-config";
import {
  NOTCH_ACTIVE_SOURCES_STORAGE_KEY,
  NOTCH_APPROVAL_RESOLVED_EVENT,
  NOTCH_COLLAPSE_EVENT,
  NOTCH_WINDOW_LABEL,
  type NotchApprovalResolvedPayload,
} from "@/lib/notch-bridge";

// 主窗口订阅核心 stores,把状态变化同步推到 notch-overlay 窗口。
// 只做"源头 → 事件"的映射,不做 UI 渲染(UI 在 NotchOverlay)。
//
// 状态优先级:approval > error > tool > streaming > done(瞬时) > idle
// 审批状态最高优先级,因为 AI 阻塞等待用户操作。

const DONE_LINGER_MS = 2500;
const OVERLAY_HIDE_DELAY_MS = 80;
const STREAM_REFRESH_MS = 1000;
const APPROVAL_TIMEOUT_MS = 120_000;
const ASK_QUESTION_TIMEOUT_MS = 300_000;
// 主窗口波形条(useTokenRateStore)的发布节流,避免 compute 高频调用
// 导致订阅组件每秒重渲染几十次。
const TOKEN_RATE_PUBLISH_MS = 300;

// 灵动岛总开关(集中在这里控制,关闭时改回 true)。
// 历史上因"切换窗口/Space 时位置漂移 1~3 秒才回正"被屏蔽 — 根因是漂移纠正
// 依赖前端 JS 定时器(主窗口失焦后被 WKWebView 节流)。现已在 Rust 侧给
// overlay 窗口挂 Moved 事件 watchdog(notch_window.rs::snap_overlay_back_if_drifted),
// 漂移在原生事件循环内即刻拉回,不再依赖 JS 兜底。
const NOTCH_DISABLED = false;

type StoredNotchSource = {
  readonly state: NotchState;
  readonly updatedAt: number;
};

type StoredNotchSources = Record<string, StoredNotchSource>;

function tokensOf(
  stream: ReturnType<typeof useAgentStatusStore.getState>["streamUsage"],
  last: ReturnType<typeof useAgentStatusStore.getState>["lastUsage"],
): number {
  if (stream) {
    return (stream.inputTokens ?? 0)
      + (stream.outputTokens ?? stream.estimatedOutputTokens ?? 0)
      + (stream.cacheReadTokens ?? 0)
      + (stream.cacheCreationTokens ?? 0);
  }
  if (last) {
    return (last.inputTokens ?? 0)
      + (last.outputTokens ?? 0)
      + (last.cacheReadTokens ?? 0)
      + (last.cacheCreationTokens ?? 0);
  }
  return 0;
}

function usageBreakdownOf(
  stream: ReturnType<typeof useAgentStatusStore.getState>["streamUsage"],
  last: ReturnType<typeof useAgentStatusStore.getState>["lastUsage"],
): NotchUsageBreakdown | undefined {
  if (stream) {
    return {
      input: stream.inputTokens ?? 0,
      output: stream.outputTokens ?? stream.estimatedOutputTokens ?? 0,
      cacheRead: stream.cacheReadTokens ?? 0,
      cacheWrite: stream.cacheCreationTokens ?? 0,
    };
  }
  if (last) {
    return {
      input: last.inputTokens ?? 0,
      output: last.outputTokens ?? 0,
      cacheRead: last.cacheReadTokens ?? 0,
      cacheWrite: last.cacheCreationTokens ?? 0,
    };
  }
  return undefined;
}

function toNotchProvider(value: string | null | undefined): NotchProvider | null {
  return ALL_PLATFORM_IDS.includes(value as PlatformId) ? (value as NotchProvider) : null;
}

function fallbackProvider(): NotchProvider {
  return toNotchProvider(useSettingsStore.getState().activePlatformId) ?? "claude";
}

function resolveProvider(conversationId?: string | null): NotchProvider {
  const activeContext = getActiveStreamRequestContext(getGlobalRegistry());
  const activeProvider = toNotchProvider(activeContext?.platformId);
  if (activeProvider) return activeProvider;

  const candidateConversationId =
    conversationId ??
    activeContext?.conversationId ??
    useStreamStateStore.getState().streamingConversationId;

  if (candidateConversationId) {
    const conversation = useConversationStore
      .getState()
      .conversations.find((entry) => entry.id === candidateConversationId);
    if (conversation?.model) {
      const decoded = decodeConversationModel(conversation.model);
      if (decoded.platformId) return decoded.platformId;
    }
  }

  return fallbackProvider();
}

function hasRecentAssistantContent(messages: ReadonlyArray<ChatMessage>): boolean {
  for (let i = messages.length - 1; i >= 0 && messages.length - i <= 10; i--) {
    const message = messages[i];
    if (message.role === "user" || message.role === "system") continue;
    if (message.content.trim().length > 0) return true;
    if (message.thinkingBlocks?.some((block) => block.text.trim().length > 0)) return true;
  }
  return false;
}

function hasActiveThinking(messages: ReadonlyArray<ChatMessage>): boolean {
  for (let i = messages.length - 1; i >= 0 && messages.length - i <= 10; i--) {
    const message = messages[i];
    if (message.role === "user" || message.role === "system") continue;
    if (message.thinkingBlocks?.some((block) => block.text.trim().length > 0 && !block.complete)) {
      return true;
    }
  }
  return false;
}

function isUserViewingConversation(conversationId: string): boolean {
  const focused = useWindowFocusStore.getState().isMainWindowFocused;
  const activeId = useConversationStore.getState().activeConversationId;
  return focused && activeId === conversationId;
}

function resolveProviderForConversation(conversationId: string): NotchProvider {
  const conversation = useConversationStore
    .getState()
    .conversations.find((c) => c.id === conversationId);
  if (conversation?.model) {
    const decoded = decodeConversationModel(conversation.model);
    if (decoded.platformId) return decoded.platformId;
  }
  return fallbackProvider();
}

function readActiveSources(): StoredNotchSources {
  try {
    const raw = window.localStorage.getItem(NOTCH_ACTIVE_SOURCES_STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as StoredNotchSources;
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    console.warn("[notch][broadcaster] active source state could not be read");
    return {};
  }
}

function writeActiveSources(sources: StoredNotchSources): void {
  try {
    window.localStorage.setItem(NOTCH_ACTIVE_SOURCES_STORAGE_KEY, JSON.stringify(sources));
  } catch {
    console.warn("[notch][broadcaster] active source state could not be written");
  }
}

function newestActiveState(sources: StoredNotchSources): NotchState | null {
  let newest: StoredNotchSource | null = null;
  for (const source of Object.values(sources)) {
    if (!newest || source.updatedAt > newest.updatedAt) newest = source;
  }
  return newest?.state ?? null;
}

export function useNotchBroadcaster(): void {
  useEffect(() => {
    if (!NOTCH_DISABLED || !isMacPlatform) return;
    void invoke("hide_notch_overlay").catch(() => {});
  }, []);

  const lastSentRef = useRef<string>("");
  const latestStateRef = useRef<NotchState>({ kind: "idle" });
  const overlayVisibleRef = useRef(false);
  const doneTimerRef = useRef<number | null>(null);
  const hideTimerRef = useRef<number | null>(null);
  const refreshTimerRef = useRef<number | null>(null);
  const overlayKeepAliveTimerRef = useRef<number | null>(null);
  const sourceIdRef = useRef<string>("");
  const rateTrackerRef = useRef<TokenRateTracker | null>(null);
  if (rateTrackerRef.current === null) {
    rateTrackerRef.current = createTokenRateTracker();
  }
  const lastRatePublishRef = useRef(0);

  useEffect(() => {
    if (NOTCH_DISABLED) return;

    sourceIdRef.current =
      getCurrentWindow().label || `window-${Math.random().toString(36).slice(2)}`;

    const cancelHide = () => {
      if (hideTimerRef.current !== null) {
        clearTimeout(hideTimerRef.current);
        hideTimerRef.current = null;
      }
    };

    const stopRefreshTicker = () => {
      if (refreshTimerRef.current !== null) {
        window.clearInterval(refreshTimerRef.current);
        refreshTimerRef.current = null;
      }
    };

    const stopOverlayKeepAliveTicker = () => {
      if (overlayKeepAliveTimerRef.current !== null) {
        window.clearInterval(overlayKeepAliveTimerRef.current);
        overlayKeepAliveTimerRef.current = null;
      }
    };

    const hideOverlaySoon = () => {
      if (!isMacPlatform) return;
      cancelHide();
      hideTimerRef.current = window.setTimeout(() => {
        hideTimerRef.current = null;
        overlayVisibleRef.current = false;
        void invoke("hide_notch_overlay")
          .catch(() => {
            // 非 macOS / 测试环境或 Tauri 命令不可用时，不影响主聊天流程。
          });
      }, OVERLAY_HIDE_DELAY_MS);
    };

    const replayLatest = () => {
      const latest = latestStateRef.current;
      if (latest.kind !== "idle") {
        void broadcastNotchState(latest);
      }
    };

    const ensureOverlayReady = (state: NotchState, force = false) => {
      if (state.kind === "idle" || !isMacPlatform) return;

      if (overlayVisibleRef.current && !force) {
        return;
      }
      cancelHide();

      void invoke("show_notch_overlay")
        .then(() => {
          overlayVisibleRef.current = true;
          // 如果覆盖层窗口是此刻才创建的，它的 React 监听器可能还没注册完成。
          // 短暂延迟后重放当前非 idle 状态，避免首个状态事件丢失。
          window.setTimeout(replayLatest, 80);
          window.setTimeout(replayLatest, 300);
        })
        .catch(() => {
          console.warn("[notch][broadcaster] overlay show failed");
          // 非 macOS / 测试环境或 Tauri 命令不可用时，不影响主聊天流程。
        });
    };

    // 采样 + 发布到主窗口波形条 store(节流;live 翻转时立即)
    const publishTokenRate = (
      snapshot: {
        rate: ReturnType<TokenRateTracker["sample"]>;
        usage: NotchUsageBreakdown | undefined;
        tokens: number;
        live: boolean;
      },
    ) => {
      const now = Date.now();
      const store = useTokenRateStore.getState();
      if (snapshot.live === store.live && now - lastRatePublishRef.current < TOKEN_RATE_PUBLISH_MS) {
        return;
      }
      lastRatePublishRef.current = now;
      store.publish({
        rate: snapshot.rate,
        usage: snapshot.usage ?? null,
        tokens: snapshot.tokens,
        live: snapshot.live,
      });
    };

    const compute = (): NotchState => {
      // 审批状态最高优先级 — AI 阻塞等待用户操作
      const approval = useNotchApprovalStore.getState().peek();
      if (approval) {
        const queueDepth = useNotchApprovalStore.getState().queue.length;
        if (approval.kind === "approval-bash") {
          let command = approval.toolInput;
          try {
            const parsed = JSON.parse(approval.toolInput);
            if (parsed?.command) command = parsed.command;
          } catch { /* keep raw */ }
          return {
            kind: "approval-bash",
            provider: approval.provider,
            confirmId: approval.confirmId,
            toolCallId: approval.toolCallId,
            command,
            conversationId: approval.conversationId,
            arrivedAt: approval.arrivedAt,
            queueDepth,
          };
        }
        if (approval.kind === "ask-question" && approval.questions) {
          return {
            kind: "ask-question",
            provider: approval.provider,
            confirmId: approval.confirmId,
            toolCallId: approval.toolCallId,
            questions: approval.questions,
            conversationId: approval.conversationId,
            arrivedAt: approval.arrivedAt,
            queueDepth,
          };
        }
        return {
          kind: "approval",
          provider: approval.provider,
          confirmId: approval.confirmId,
          toolCallId: approval.toolCallId,
          toolName: approval.toolName,
          toolInput: approval.toolInput,
          conversationId: approval.conversationId,
          arrivedAt: approval.arrivedAt,
          queueDepth,
        };
      }

      const stream = useStreamStateStore.getState();
      const agent = useAgentStatusStore.getState();
      const chat = useChatStore.getState();
      const provider = resolveProvider(stream.streamingConversationId);
      const tokens = tokensOf(agent.streamUsage, agent.lastUsage);
      const messages = chat.messages ?? [];
      const hasOutputTokens =
        (agent.streamUsage?.outputTokens ?? agent.streamUsage?.estimatedOutputTokens ?? 0) > 0;
      const hasAssistantContent = hasRecentAssistantContent(messages);
      const activeThinking = hasActiveThinking(messages);

      if (stream.isStreaming) {
        const usage = usageBreakdownOf(agent.streamUsage, agent.lastUsage);
        const rate = rateTrackerRef.current!.sample(tokens);
        publishTokenRate({ rate, usage, tokens, live: true });

        for (let i = messages.length - 1; i >= 0; i--) {
          const m = messages[i];
          const running = m?.toolCalls?.find(
            (t) => t.status === "running" || t.status === "pending_confirmation",
          );
          if (running) {
            return {
              kind: "tool",
              provider,
              toolName: running.toolName ?? "tool",
              elapsedMs: stream.streamElapsed,
              tokens,
              usage,
              rate,
            };
          }
          if (messages.length - i > 10) break;
        }

        const phase =
          activeThinking || stream.streamPhase === "thinking"
            ? "thinking"
            : hasOutputTokens || hasAssistantContent
              ? "generating"
              : (stream.streamPhase ?? "connecting");
        return {
          kind: "streaming",
          provider,
          phase,
          elapsedMs: stream.streamElapsed,
          tokens,
          usage,
          rate,
        };
      }

      return { kind: "idle" };
    };

    const abortActiveStream = () => {
      const registry = getGlobalRegistry();
      const streamStateWriter = getGlobalStreamStateWriter();
      const target = getActiveStreamRequestContext(registry);
      const requestId = target?.requestId ?? null;

      if (requestId) {
        void invoke("abort_chat", { requestId }).catch(() => {
          console.error("[notch][broadcaster] active stream cancellation failed");
        });
      }

      const removed = requestId
        ? removeRequestAndSyncStreamState(
            registry,
            requestId,
            streamStateWriter,
            target?.conversationId ?? null,
          )
        : undefined;
      if (removed?.conversationId) {
        useChatStore.getState().clearSnapshot(removed.conversationId);
        clearWarmSession(removed.conversationId);
      }

      const nextActive = getActiveStreamRequestContext(registry);
      setActiveStreamRequest(registry, nextActive?.requestId ?? null);

      if (!requestId && useStreamStateStore.getState().isStreaming) {
        useStreamStateStore.getState().setStreaming(false);
      }
    };

    const pushDirect = (next: NotchState) => {
      const key = JSON.stringify(next);
      if (key === lastSentRef.current) return;
      lastSentRef.current = key;
      latestStateRef.current = next;
      if (next.kind === "idle") {
        stopOverlayKeepAliveTicker();
        hideOverlaySoon();
      } else {
        ensureOverlayReady(next);
        syncOverlayKeepAliveTicker();
      }
      void broadcastNotchState(next);
    };

    const push = (next: NotchState) => {
      const sourceId = sourceIdRef.current;
      if (!sourceId) {
        pushDirect(next);
        return;
      }

      const sources = readActiveSources();
      if (next.kind === "idle") {
        delete sources[sourceId];
        writeActiveSources(sources);
        const fallback = newestActiveState(sources);
        if (fallback) {
          overlayVisibleRef.current = false;
          pushDirect(fallback);
          return;
        }
        pushDirect(next);
        return;
      }

      sources[sourceId] = { state: next, updatedAt: Date.now() };
      writeActiveSources(sources);
      pushDirect(next);
    };

    const resyncVisibleOverlay = () => {
      const latest = latestStateRef.current;
      if (latest.kind === "idle") return;
      ensureOverlayReady(latest, true);
      void broadcastNotchState(latest);
    };

    const syncOverlayKeepAliveTicker = () => {
      if (latestStateRef.current.kind === "idle") {
        stopOverlayKeepAliveTicker();
        return;
      }
      if (overlayKeepAliveTimerRef.current === null) {
        overlayKeepAliveTimerRef.current = window.setInterval(resyncVisibleOverlay, 1000);
      }
    };

    const syncRefreshTicker = () => {
      if (useStreamStateStore.getState().isStreaming) {
        if (refreshTimerRef.current === null) {
          refreshTimerRef.current = window.setInterval(() => {
            if (!useStreamStateStore.getState().isStreaming) {
              stopRefreshTicker();
              return;
            }
            push(compute());
            resyncVisibleOverlay();
          }, STREAM_REFRESH_MS);
        }
      } else {
        stopRefreshTicker();
      }
    };

    // 订阅 stream-state 的关键字段变化
    const unsubStream = useStreamStateStore.subscribe((s, prev) => {
      // 流式结束 → done 瞬时 → idle
      if (prev.isStreaming && !s.isStreaming) {
        stopRefreshTicker();
        const provider = resolveProvider(prev.streamingConversationId);
        const agent = useAgentStatusStore.getState();
        const tokens = tokensOf(agent.streamUsage, agent.lastUsage);
        const usage = usageBreakdownOf(agent.streamUsage, agent.lastUsage);
        const rate = rateTrackerRef.current!.finish(tokens);
        useTokenRateStore.getState().publish({
          rate,
          usage: usage ?? null,
          tokens,
          live: false,
        });
        push({
          kind: "done",
          provider,
          durationMs: prev.streamElapsed,
          tokens,
          usage,
          rate,
        });
        if (doneTimerRef.current !== null) {
          clearTimeout(doneTimerRef.current);
        }
        doneTimerRef.current = window.setTimeout(() => {
          doneTimerRef.current = null;
          push({ kind: "idle" });
        }, DONE_LINGER_MS);
        return;
      }

      // 流式开始/进行中 → 重新计算
      if (doneTimerRef.current !== null) {
        clearTimeout(doneTimerRef.current);
        doneTimerRef.current = null;
      }
      syncRefreshTicker();
      push(compute());
    });

    // 订阅 agent-status(token 变化)
    const unsubAgent = useAgentStatusStore.subscribe(() => {
      if (useStreamStateStore.getState().isStreaming) push(compute());
    });

    // 订阅 chat-store(工具调用状态变化)
    const unsubChat = useChatStore.subscribe(() => {
      if (useStreamStateStore.getState().isStreaming) push(compute());
    });

    // 订阅 settings(切换 provider)
    const unsubSettings = useSettingsStore.subscribe(() => {
      if (useStreamStateStore.getState().isStreaming) push(compute());
    });

    const collapseOverlay = () => {
      void emitTo(NOTCH_WINDOW_LABEL, NOTCH_COLLAPSE_EVENT, undefined).catch(() => {});
    };
    document.addEventListener("pointerdown", collapseOverlay, true);
    window.addEventListener("focus", resyncVisibleOverlay);
    document.addEventListener("visibilitychange", resyncVisibleOverlay);

    // 初始推送
    syncRefreshTicker();
    push(compute());

    // ---- 审批事件监听 -------------------------------------------------
    // 监听 tool-confirm / ask-user-question，焦点判断后入队或跳过
    let unlistenToolConfirm: (() => void) | undefined;
    let unlistenAskQuestion: (() => void) | undefined;

    void listen<ToolConfirmPayload>("chat-tool-confirm", (e) => {
      const ctx = getStreamRequestContext(getGlobalRegistry(), e.payload.request_id);
      const conversationId = ctx?.conversationId ?? "";
      if (!conversationId) return;
      if (isUserViewingConversation(conversationId)) return;

      const isBash = e.payload.tool_name === "Bash";
      const provider = resolveProviderForConversation(conversationId);

      useNotchApprovalStore.getState().enqueue({
        kind: isBash ? "approval-bash" : "approval",
        confirmId: e.payload.confirm_id,
        toolCallId: e.payload.tool_call_id,
        toolName: e.payload.tool_name,
        toolInput: e.payload.tool_input,
        conversationId,
        provider,
        arrivedAt: Date.now(),
      });
      push(compute());
    }).then((u) => { unlistenToolConfirm = u; });

    void listen<AskUserQuestionPayload>("chat-ask-user-question", (e) => {
      const ctx = getStreamRequestContext(getGlobalRegistry(), e.payload.request_id);
      const conversationId = ctx?.conversationId ?? "";
      if (!conversationId) return;
      if (isUserViewingConversation(conversationId)) return;

      const provider = resolveProviderForConversation(conversationId);
      useNotchApprovalStore.getState().enqueue({
        kind: "ask-question",
        confirmId: e.payload.confirm_id,
        toolCallId: e.payload.tool_call_id,
        toolName: "AskUserQuestion",
        toolInput: "",
        conversationId,
        provider,
        arrivedAt: Date.now(),
        questions: e.payload.questions.map((q) => ({
          question: q.question,
          header: q.header,
          options: q.options,
          multiSelect: q.multi_select,
        })),
      });
      push(compute());
    }).then((u) => { unlistenAskQuestion = u; });

    // ---- 会话切换 → dequeue（页内对话框接管）-----------------------------
    const unsubConversation = useConversationStore.subscribe((s, prev) => {
      if (s.activeConversationId !== prev.activeConversationId && s.activeConversationId) {
        const removed = useNotchApprovalStore.getState().queue.some(
          (q) => q.conversationId === s.activeConversationId,
        );
        if (removed) {
          useNotchApprovalStore.getState().removeForConversation(s.activeConversationId);
          push(compute());
        }
      }
    });

    // ---- 窗口重获焦点 → dequeue 当前活跃会话的审批 ----------------------
    const unsubFocus = useWindowFocusStore.subscribe((s, prev) => {
      // 主窗口失焦(Cmd+Tab / 点击其他 App) → 收起覆盖层展开面板。
      // 覆盖层自身 focusable(false) 收不到失焦事件,由主窗口侧代为触发;
      // 与 Rust 侧的全局鼠标 monitor(set_notch_collapse_watch)互为补充。
      if (!s.isMainWindowFocused && prev.isMainWindowFocused) {
        collapseOverlay();
      }
      if (s.isMainWindowFocused && !prev.isMainWindowFocused) {
        const activeId = useConversationStore.getState().activeConversationId;
        if (activeId) {
          const had = useNotchApprovalStore.getState().queue.some(
            (q) => q.conversationId === activeId,
          );
          if (had) {
            useNotchApprovalStore.getState().removeForConversation(activeId);
            push(compute());
          }
        }
      }
    });

    // ---- 审批队列变化 → 重新计算 ----------------------------------------
    const unsubApproval = useNotchApprovalStore.subscribe(() => {
      push(compute());
    });

    // ---- notch 窗口发来的审批结果 → dequeue ------------------------------
    let unlistenResolved: (() => void) | undefined;
    void listen<NotchApprovalResolvedPayload>(NOTCH_APPROVAL_RESOLVED_EVENT, (e) => {
      if (e.payload.kind === "ask-question") {
        useToolStateStore.getState().removePendingAskUserQuestion(e.payload.conversationId);
      } else {
        useChatStore.getState().resolveToolCallConfirmation(
          e.payload.toolCallId,
          e.payload.approved ?? false,
        );
      }

      useNotchApprovalStore.getState().dequeue(e.payload.confirmId);
      push(compute());
    }).then((u) => { unlistenResolved = u; });

    // ---- 超时自动拒绝 ---------------------------------------------------
    const timeoutInterval = window.setInterval(() => {
      const queue = useNotchApprovalStore.getState().queue;
      const now = Date.now();
      for (const item of queue) {
        const limit = item.kind === "ask-question" ? ASK_QUESTION_TIMEOUT_MS : APPROVAL_TIMEOUT_MS;
        if (now - item.arrivedAt < limit) continue;

        if (item.kind === "ask-question") {
          void invoke("respond_ask_user_question", {
            confirmId: item.confirmId,
            answers: {},
          }).catch(() => {});
        } else {
          void invoke("respond_tool_confirmation", {
            confirmId: item.confirmId,
            approved: false,
          }).catch(() => {});
        }
        useNotchApprovalStore.getState().dequeue(item.confirmId);
      }
      if (useNotchApprovalStore.getState().queue.length !== queue.length) {
        push(compute());
      }
    }, 5_000);

    let unlistenAbort: (() => void) | undefined;
    void listen("notch:abort-active-stream", () => abortActiveStream()).then((unlisten) => {
      unlistenAbort = unlisten;
    });

    return () => {
      document.removeEventListener("pointerdown", collapseOverlay, true);
      window.removeEventListener("focus", resyncVisibleOverlay);
      document.removeEventListener("visibilitychange", resyncVisibleOverlay);
      const sources = readActiveSources();
      delete sources[sourceIdRef.current];
      writeActiveSources(sources);
      unlistenAbort?.();
      unlistenToolConfirm?.();
      unlistenAskQuestion?.();
      unlistenResolved?.();
      unsubStream();
      unsubAgent();
      unsubChat();
      unsubSettings();
      unsubConversation();
      unsubFocus();
      unsubApproval();
      window.clearInterval(timeoutInterval);
      if (doneTimerRef.current !== null) {
        clearTimeout(doneTimerRef.current);
        doneTimerRef.current = null;
      }
      cancelHide();
      stopRefreshTicker();
      stopOverlayKeepAliveTicker();
    };
  }, []);
}
