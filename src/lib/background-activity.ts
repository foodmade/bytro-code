import { useStreamStateStore } from "@/stores/stream-state-store";

/**
 * Background-activity tracking from tool results.
 *
 * A turn can end while the agent is still "listening": a run_in_background
 * Bash command keeps running and re-invokes the agent via task-notification,
 * and a ScheduleWakeup resumes it on a timer. Neither is reflected in the
 * stream lifecycle, so without tracking the conversation drops to "idle" and
 * the user assumes the session is over.
 *
 * Only signals that are unambiguously background-shaped are tracked — a
 * missed signal shows "idle" for a moment, but a false positive would pin the
 * conversation in "listening" forever:
 *  - Bash with run_in_background:true — the result names the task ID that the
 *    matching task-notification later carries.
 *  - ScheduleWakeup — cleared when the resumed turn starts (chat-new-turn),
 *    with a store-side expiry timer as a leak guard.
 */

/** Matches the task ID in "Command running in background with ID: bwk77xjcv". */
const BACKGROUND_TASK_ID_RE = /running in background with ID:?\s*([A-Za-z0-9_-]+)/i;

/** Result of classifying one tool result. Exported for tests. */
export type BackgroundActivitySignal =
  | { readonly kind: "task"; readonly taskId: string }
  | { readonly kind: "wakeup"; readonly delayMs: number }
  | null;

function parseToolInput(toolInput: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(toolInput);
    return typeof parsed === "object" && parsed !== null
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/** Classify a successful tool result as a background-activity signal, if any. */
export function classifyBackgroundActivity(params: {
  readonly toolName: string;
  readonly toolInput: string;
  readonly result: string;
  readonly success: boolean;
}): BackgroundActivitySignal {
  if (!params.success) return null;

  if (params.toolName === "Bash") {
    const input = parseToolInput(params.toolInput);
    if (input?.run_in_background !== true) return null;
    const match = BACKGROUND_TASK_ID_RE.exec(params.result);
    return match ? { kind: "task", taskId: match[1] } : null;
  }

  if (params.toolName === "ScheduleWakeup") {
    const input = parseToolInput(params.toolInput);
    const delaySeconds = input?.delaySeconds;
    if (typeof delaySeconds !== "number" || !Number.isFinite(delaySeconds)) return null;
    // The runtime clamps delaySeconds to [60, 3600]; mirror it for the expiry guard.
    const clamped = Math.min(3600, Math.max(60, delaySeconds));
    return { kind: "wakeup", delayMs: clamped * 1000 };
  }

  return null;
}

/** Track background activity for a conversation based on one tool result. */
export function trackBackgroundActivityFromToolResult(
  conversationId: string | null | undefined,
  params: {
    readonly toolName: string;
    readonly toolInput: string;
    readonly result: string;
    readonly success: boolean;
  },
): void {
  if (!conversationId) return;
  const signal = classifyBackgroundActivity(params);
  if (!signal) return;
  const store = useStreamStateStore.getState();
  if (signal.kind === "task") {
    store.addBackgroundTask(conversationId, signal.taskId);
  } else {
    store.setPendingWakeup(conversationId, signal.delayMs);
  }
}
