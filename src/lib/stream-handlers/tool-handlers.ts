import type { UnlistenFn } from "@tauri-apps/api/event";
import { windowListen } from "@/lib/window-listen";
import { useChatStore, useToolStateStore } from "@/stores";
import { getStreamRequestContext } from "@/lib/chat-stream-registry";
import { refreshStreamSafetyTimeout } from "@/stores/stream-state-store";
import { notificationManager } from "@/lib/notifications";
import type {
  ListenerParams,
  ToolUsePayload,
  ToolResultPayload,
  ToolOutputPayload,
  ToolConfirmPayload,
  ToolDeniedPayload,
  AskUserQuestionPayload,
  TurnDiffPayload,
} from "./types";

/**
 * Register listeners for tool-lifecycle events:
 *   - chat-tool-use            (tool invocation started)
 *   - chat-tool-output         (tool produced incremental output)
 *   - chat-tool-result         (tool finished with a result)
 *   - chat-tool-confirm        (tool awaiting user confirmation)
 *   - chat-tool-denied         (tool confirmation denied)
 *   - chat-ask-user-question   (interactive question for the user)
 */
export async function registerToolHandlers(
  params: ListenerParams,
): Promise<UnlistenFn[]> {
  const { registry, shouldIgnore } = params;

  // ---- chat-tool-use -----------------------------------------------------
  const u1 = await windowListen<ToolUsePayload>("chat-tool-use", (e) => {
    if (shouldIgnore()) return;
    const ctx = getStreamRequestContext(registry, e.payload.request_id);
    if (!ctx) return;
    refreshStreamSafetyTimeout();

    useChatStore.getState().addToolCall(ctx.messageId, {
      id: e.payload.tool_call_id,
      toolName: e.payload.tool_name,
      toolInput: e.payload.tool_input,
    });
  });

  // ---- chat-tool-output --------------------------------------------------
  const u2 = await windowListen<ToolOutputPayload>("chat-tool-output", (e) => {
    if (shouldIgnore()) return;
    const ctx = getStreamRequestContext(registry, e.payload.request_id);
    if (!ctx) return;
    refreshStreamSafetyTimeout();

    useChatStore.getState().appendToolCallOutput(
      ctx.messageId,
      e.payload.tool_call_id,
      e.payload.output,
    );
  });

  // ---- chat-tool-result --------------------------------------------------
  const u3 = await windowListen<ToolResultPayload>("chat-tool-result", (e) => {
    if (shouldIgnore()) return;
    const ctx = getStreamRequestContext(registry, e.payload.request_id);
    if (!ctx) return;
    refreshStreamSafetyTimeout();

    useChatStore.getState().updateToolCallResult(
      ctx.messageId,
      e.payload.tool_call_id,
      e.payload.result,
      e.payload.success,
      e.payload.tool_input,
      e.payload.display,
    );
  });

  // ---- chat-tool-confirm -------------------------------------------------
  const u4 = await windowListen<ToolConfirmPayload>("chat-tool-confirm", (e) => {
    if (shouldIgnore()) return;
    const ctx = getStreamRequestContext(registry, e.payload.request_id);
    if (!ctx) return;
    refreshStreamSafetyTimeout();

    useChatStore.getState().setToolCallPendingConfirmation(
      ctx.messageId,
      e.payload.tool_call_id,
      e.payload.confirm_id,
      e.payload.tool_name,
      e.payload.tool_input,
    );

    // 无论窗口是否聚焦都推送 — 用户必须操作 AI 才能继续执行
    const isExitPlan = e.payload.tool_name === "ExitPlanMode";
    notificationManager.notify({
      eventType: "approval_required",
      title: isExitPlan ? "计划已就绪，等待审批" : "AI 请求操作授权",
      body: isExitPlan ? "Claude 已完成规划，需要您审批后才能开始执行" : `需要授权: ${e.payload.tool_name}`,
      conversationId: ctx.conversationId ?? undefined,
    }).catch((err: unknown) => {
      if (import.meta.env.DEV) {
        console.warn("[tool-handlers] approval notification failed:", err);
      }
    });
  });

  // ---- chat-tool-denied --------------------------------------------------
  const u5 = await windowListen<ToolDeniedPayload>("chat-tool-denied", (e) => {
    if (shouldIgnore()) return;
    const ctx = getStreamRequestContext(registry, e.payload.request_id);
    if (!ctx) return;

    useChatStore.getState().resolveToolCallConfirmation(
      e.payload.tool_call_id,
      false,
    );
  });

  // ---- chat-ask-user-question --------------------------------------------
  // AskUserQuestion events carry a request_id — use it to resolve the
  // originating conversation so the dialog is scoped correctly.
  const u6 = await windowListen<AskUserQuestionPayload>("chat-ask-user-question", (e) => {
    if (shouldIgnore()) return;

    const ctx = getStreamRequestContext(registry, e.payload.request_id);

    useToolStateStore.getState().addPendingAskUserQuestion({
      confirmId: e.payload.confirm_id,
      toolCallId: e.payload.tool_call_id,
      questions: e.payload.questions.map((q) => ({
        question: q.question,
        header: q.header,
        options: q.options,
        multiSelect: q.multi_select,
      })),
      conversationId: ctx?.conversationId ?? undefined,
    });

    // 无论窗口是否聚焦都推送 — 用户必须回答 AI 才能继续
    const firstQuestion = e.payload.questions[0]?.question ?? "";
    notificationManager.notify({
      eventType: "user_input_required",
      title: "AI 需要你回答一个问题",
      body: firstQuestion.length > 80
        ? `${firstQuestion.slice(0, 80)}…`
        : firstQuestion || undefined,
    }).catch((err: unknown) => {
      if (import.meta.env.DEV) {
        console.warn("[tool-handlers] ask-user-question notification failed:", err);
      }
    });
  });

  // ---- chat-turn-diff -------------------------------------------------------
  // Turn-level aggregated unified diff — updates in real-time as file changes
  // are applied during a Codex turn.
  const u7 = await windowListen<TurnDiffPayload>("chat-turn-diff", (e) => {
    if (shouldIgnore()) return;
    const ctx = getStreamRequestContext(registry, e.payload.request_id);
    if (!ctx) return;
    refreshStreamSafetyTimeout();

    useChatStore.getState().setTurnDiff(ctx.messageId, e.payload.diff);
  });

  return [u1, u2, u3, u4, u5, u6, u7];
}
