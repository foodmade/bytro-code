/**
 * 系统通知模块 — 统一公共 API
 *
 * 使用方式：
 *   import { notificationManager, OsNotificationChannel } from "@/lib/notifications"
 *
 * 初始化（在 App 启动时）：
 *   notificationManager.register(new OsNotificationChannel());
 *   notificationManager.register(new ToastNotificationChannel());
 *
 * 发送通知：
 *   await notificationManager.notify(
 *     { eventType: "ai_stream_complete", title: "AI 响应完成", body: "..." },
 *     { onlyWhenUnfocused: true, channels: ["os"] }
 *   );
 */
export { notificationManager } from "./manager";
export { OsNotificationChannel } from "./channels/os";
export { ToastNotificationChannel } from "./channels/toast";
export { stripMarkdown } from "./strip-markdown";
export type {
  INotificationChannel,
  NotificationPayload,
  NotificationOptions,
  NotificationEventType,
} from "./types";
