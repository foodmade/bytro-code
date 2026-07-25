import type { UnlistenFn } from "@tauri-apps/api/event";
import { windowListen } from "@/lib/window-listen";
import { useFileChangesStore, useLiveReviewStore } from "@/stores";
import { getStreamRequestContext } from "@/lib/chat-stream-registry";
import { refreshStreamSafetyTimeout } from "@/stores/stream-state-store";
import type {
  ListenerParams,
  FileChangedPayload,
  TodoDiffEntry,
  UserMessageUuidPayload,
  RewindFilesResultPayload,
  TodoUpdatedPayload,
  TurnFinishedPayload,
} from "./types";

export function getCompletedTodoMilestones(
  diff: ReadonlyArray<TodoDiffEntry> | undefined,
): ReadonlyArray<TodoDiffEntry> {
  if (!diff || diff.length === 0) return [];
  return diff.filter(
    (d) =>
      d.newStatus === "completed" &&
      (d.changeType === "status_changed" || d.changeType === "added"),
  );
}

/**
 * Register listeners for file-change tracking AND live-review triggers:
 *   - chat-file-changed       (file modified by a tool)         → buffer + record
 *   - chat-user-message-uuid  (checkpoint UUID for rewindFiles)
 *   - chat-rewind-result      (result of a rewindFiles operation)
 *   - chat-todo-updated       (live-review MILESTONE trigger when an item just
 *                              entered `completed`)
 *   - chat-turn-finished      (live-review TURN trigger from the SDK Stop hook)
 *
 * Live-review is opt-in per-conversation; all triggers no-op when the panel
 * is disabled for the conversation that produced the event.
 */
export async function registerFileChangeHandlers(
  params: ListenerParams,
): Promise<UnlistenFn[]> {
  const { registry, shouldIgnore } = params;

  // ---- chat-file-changed ---------------------------------------------------
  const u1 = await windowListen<FileChangedPayload>("chat-file-changed", (e) => {
    if (shouldIgnore()) return;
    const ctx = getStreamRequestContext(registry, e.payload.request_id);
    if (!ctx) return;
    refreshStreamSafetyTimeout();

    const change = {
      filePath: e.payload.file_path,
      action: e.payload.action as "edit" | "create" | "delete",
      toolName: e.payload.tool_name,
      additions: e.payload.additions,
      deletions: e.payload.deletions,
    };
    useFileChangesStore.getState().addFileChange(ctx.conversationId, change);

    // Live Reviewer hook — buffer the change without triggering review.
    // Reviews are flushed on MILESTONE (todo just_completed) or TURN
    // (Stop hook), giving the reviewer a coherent batch to look at instead
    // of one fragment at a time.  Dynamic import keeps the handlers module
    // free of a build-time dep on live-review-service (which itself imports
    // stores, avoiding a cycle).
    const convId = ctx.conversationId;
    if (convId && useLiveReviewStore.getState().isEnabledFor(convId)) {
      void import("@/lib/live-review-service")
        .then((mod) => mod.bufferFileChange(convId, change))
        .catch(() => {
          /* swallow — live review failure must never block main chat */
        });
    }
  });

  // ---- chat-user-message-uuid ----------------------------------------------
  const u2 = await windowListen<UserMessageUuidPayload>(
    "chat-user-message-uuid",
    (e) => {
      if (shouldIgnore()) return;
      const ctx = getStreamRequestContext(registry, e.payload.request_id);
      if (!ctx) return;

      useFileChangesStore
        .getState()
        .setUserMessageUuid(
          ctx.conversationId,
          e.payload.request_id,
          e.payload.uuid,
        );
    },
  );

  // ---- chat-rewind-result --------------------------------------------------
  const u3 = await windowListen<RewindFilesResultPayload>(
    "chat-rewind-result",
    (e) => {
      if (shouldIgnore()) return;

      const ctx = getStreamRequestContext(registry, e.payload.request_id);
      let conversationId: string | null = ctx?.conversationId ?? null;

      if (!conversationId) {
        const { changesByConversation } = useFileChangesStore.getState();
        for (const [key, state] of Object.entries(changesByConversation)) {
          if (state.requestId === e.payload.request_id) {
            conversationId = key;
            break;
          }
        }
      }

      useFileChangesStore
        .getState()
        .setRewindResult(
          conversationId,
          e.payload.success,
          e.payload.error,
        );
    },
  );

  // ---- chat-todo-updated → live-review MILESTONE trigger -------------------
  // The SDK already emits this for the main chat status indicator; here we
  // only react when the diff includes one or more items just entering
  // `completed`.  Each completed item flushes the buffer with the
  // todo's content as the milestone's task title.
  const u4 = await windowListen<TodoUpdatedPayload>(
    "chat-todo-updated",
    (e) => {
      if (shouldIgnore()) return;
      const ctx = getStreamRequestContext(registry, e.payload.request_id);
      if (!ctx) return;
      const convId = ctx.conversationId;
      if (!convId || !useLiveReviewStore.getState().isEnabledFor(convId)) return;

      const diff = e.payload.diff;
      if (!diff || diff.length === 0) return;

      const justCompleted = getCompletedTodoMilestones(diff);
      if (justCompleted.length === 0) return;

      void import("@/lib/live-review-service").then((mod) => {
        // Each completed milestone is its own review batch.  Multiple
        // transitions in the same TodoWrite call are unusual but possible;
        // we issue one review per completed item, sharing the buffer across
        // them by virtue of buffer-clearing on first flush.
        for (const entry of justCompleted) {
          mod.triggerMilestoneReview(convId, entry.content);
        }
      }).catch(() => {
        /* swallow */
      });
    },
  );

  // ---- chat-turn-finished → live-review TURN trigger -----------------------
  // Emitted by the Claude SDK Stop hook when the agent has finished a turn.
  // Empty buffer → skip (a recent MILESTONE flush has already covered the
  // changes; no point in a duplicate "nothing changed" card).
  const u5 = await windowListen<TurnFinishedPayload>(
    "chat-turn-finished",
    (e) => {
      if (shouldIgnore()) return;
      const ctx = getStreamRequestContext(registry, e.payload.request_id);
      if (!ctx) return;
      const convId = ctx.conversationId;
      if (!convId || !useLiveReviewStore.getState().isEnabledFor(convId)) return;

      const lastMsg = e.payload.last_assistant_message ?? null;
      void import("@/lib/live-review-service")
        .then((mod) => mod.triggerTurnReview(convId, lastMsg))
        .catch(() => {
          /* swallow */
        });
    },
  );

  return [u1, u2, u3, u4, u5];
}
