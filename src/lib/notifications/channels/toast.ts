/**
 * Toast 应用内通知渠道
 *
 * 复用现有的 useToastStore，将通知事件类型映射到 Toast 级别。
 * 此渠道始终可用（无需权限），适合作为 OS 通知的补充或降级方案。
 */
import { BaseNotificationChannel } from "./base";
import { useToastStore } from "@/stores/toast-store";
import type { NotificationPayload, NotificationEventType } from "../types";
import type { ToastLevel } from "@/stores/toast-store";

/**
 * 将通知事件类型映射到 Toast 级别。
 * 穷举 switch — 新增 NotificationEventType 时 TypeScript 会报错提醒更新此处。
 */
function resolveToastLevel(eventType: NotificationEventType): ToastLevel {
  switch (eventType) {
    case "error_occurred":
      return "error";
    case "system_alert":
      return "warning";
    case "user_input_required":
    case "approval_required":
      return "warning";
    case "ai_stream_complete":
    case "background_task_complete":
      return "info";
  }
}

export class ToastNotificationChannel extends BaseNotificationChannel {
  readonly id = "toast";
  readonly name = "应用内提示";

  async send(payload: NotificationPayload): Promise<void> {
    const level = resolveToastLevel(payload.eventType);
    const message = payload.body
      ? `${payload.title}: ${payload.body}`
      : payload.title;
    useToastStore.getState().addToast(level, message);
  }
}
