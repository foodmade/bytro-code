/**
 * OS 原生通知渠道
 *
 * 使用 tauri-plugin-notification 调用操作系统原生通知 API：
 * - Windows: WinRT Toast Notifications
 * - macOS:   UNUserNotificationCenter
 * - Linux:   libnotify
 *
 * 替代 Web Notification API（WebView2 中权限始终被拒，无法工作）。
 *
 * 通知开关由 settings store 的 notificationsEnabled 字段控制：
 * 关闭时 isAvailable() 直接返回 false，不再发送任何 OS 通知。
 */
import {
  isPermissionGranted,
  requestPermission,
  sendNotification,
} from "@tauri-apps/plugin-notification";
import { useSettingsStore } from "@/stores/settings-store";
import { BaseNotificationChannel } from "./base";
import type { NotificationPayload } from "../types";

export class OsNotificationChannel extends BaseNotificationChannel {
  readonly id = "os";
  readonly name = "系统通知";

  async isAvailable(): Promise<boolean> {
    try {
      if (!useSettingsStore.getState().notificationsEnabled) return false;
      const granted = await isPermissionGranted();
      if (granted) return true;
      // 权限未授予时尝试请求
      const result = await requestPermission();
      if (result === "denied") return false;
      // "default"（Windows/Linux）需用 Rust 后端二次确认
      return await isPermissionGranted();
    } catch {
      return false;
    }
  }

  async send(payload: NotificationPayload): Promise<void> {
    if (!useSettingsStore.getState().notificationsEnabled) return;

    const granted = await isPermissionGranted();
    if (!granted) {
      const result = await requestPermission();
      if (result === "denied") return;
      if (!(await isPermissionGranted())) return;
    }

    sendNotification({
      title: payload.title,
      body: payload.body,
      // 不设置 sound — 提示音由 NotificationManager 通过 Web Audio API 统一播放，
      // 避免 macOS 上 OS 系统音 + Web Audio 双重声音
    });
  }
}
