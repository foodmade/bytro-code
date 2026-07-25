/**
 * Global stream manager — singleton that lives for the entire application
 * lifetime. Event listeners and the StreamRequestRegistry are owned here
 * instead of inside the ChatPanel component, so they survive view switches
 * (chat → workspace → idea hub → back to chat).
 *
 * Components obtain the shared registry via `getGlobalRegistry()` and
 * trigger initialization via `initGlobalStreamManager()` (called once
 * from App.tsx).
 */
import type { UnlistenFn } from "@tauri-apps/api/event";
import { useStreamStateStore } from "@/stores/stream-state-store";
import {
  createStreamRequestRegistry,
  type StreamRequestRegistry,
} from "@/lib/chat-stream-registry";
import type { StreamStateWriter } from "@/lib/chat-stream-state";

// ── Module-level singleton state ──────────────────────────────────────────

let globalRegistry: StreamRequestRegistry | null = null;
let teardown: (() => void) | null = null;
let notificationsInitialized = false;

const streamStateWriter: StreamStateWriter = {
  setStreamingMessageId: (messageId: string | null) => {
    useStreamStateStore.getState().setStreamingMessageId(messageId);
  },
  setStreamingConversationId: (conversationId: string | null) => {
    useStreamStateStore.getState().setStreamingConversationId(conversationId);
  },
  setStreaming: (streaming: boolean) => {
    useStreamStateStore.getState().setStreaming(streaming);
  },
};

// ── Public API ────────────────────────────────────────────────────────────

/**
 * Return the application-wide StreamRequestRegistry.
 * Creates it lazily if it hasn't been created yet (but listeners won't be
 * active until `initGlobalStreamManager` is called).
 */
export function getGlobalRegistry(): StreamRequestRegistry {
  if (!globalRegistry) {
    globalRegistry = createStreamRequestRegistry();
  }
  return globalRegistry;
}

/** Convenience accessor for the shared StreamStateWriter. */
export function getGlobalStreamStateWriter(): StreamStateWriter {
  return streamStateWriter;
}

/**
 * One-time initialization — registers Tauri event listeners and starts the
 * reconnect poller. Should be called exactly once from App.tsx's top-level
 * useEffect. Returns a cleanup function for React's strict-mode double-mount.
 */
export async function initGlobalStreamManager(): Promise<() => void> {
  // Guard against double-init (React strict mode in dev)
  if (teardown) return teardown;

  // ── 初始化系统通知渠道 ───────────────────────────────────────────────────
  // 渠道是应用生命周期单例，仅注册一次；teardown 不卸载渠道
  const {
    notificationManager,
    OsNotificationChannel,
    ToastNotificationChannel,
  } = await import("@/lib/notifications");

  if (!notificationsInitialized) {
    notificationManager
      .register(new OsNotificationChannel(), [
        "ai_stream_complete",
        "background_task_complete",
        "user_input_required",
        "approval_required",
      ])
      .register(new ToastNotificationChannel(), ["error_occurred", "system_alert"]);
    notificationsInitialized = true;
  }
  // ────────────────────────────────────────────────────────────────────────

  const registry = getGlobalRegistry();
  const unsubs: UnlistenFn[] = [];

  const { registerChatStreamListeners } = await import("@/lib/chat-stream-listeners");
  const listeners = await registerChatStreamListeners({
    registry,
    // Never ignore — these listeners live for the entire app lifetime
    shouldIgnore: () => false,
    setStreamingMessageId: (messageId) => {
      useStreamStateStore.getState().setStreamingMessageId(messageId);
    },
  });

  unsubs.push(...listeners);

  // Register teams event listeners only during full app initialization.
  // `getGlobalRegistry()` is imported by lightweight chat paths; keeping this
  // dynamic avoids pulling the entire teams/app store graph into message render.
  const { registerTeamsStreamListeners } = await import("@/lib/teams-stream-listeners");
  const teamsListeners = await registerTeamsStreamListeners();
  unsubs.push(...teamsListeners);

  teardown = () => {
    unsubs.forEach((fn) => fn());
    teardown = null;
  };

  return teardown;
}
