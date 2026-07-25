/**
 * 通知管理器
 *
 * 核心职责：
 * 1. 管理通知渠道的注册与注销
 * 2. 按事件类型过滤目标渠道
 * 3. 根据 NotificationOptions 决定是否发送（如 onlyWhenUnfocused）
 * 4. 并发向所有目标渠道分发通知，任一渠道失败不影响其他渠道
 *
 * 扩展方式：
 * - 新增渠道：实现 INotificationChannel 后调用 register()
 * - 新增事件类型：在 types.ts 扩展 NotificationEventType
 * - 新增发送策略：在 NotificationOptions 中增加字段，并在 notify() 中处理
 */
import type {
  INotificationChannel,
  NotificationPayload,
  NotificationOptions,
  NotificationEventType,
  ChannelRegistration,
} from "./types";
import { playNotificationSound } from "./notification-sound";
import { useSettingsStore } from "@/stores/settings-store";

export class NotificationManager {
  private readonly registrations = new Map<string, ChannelRegistration>();

  /**
   * 注册一个通知渠道。
   *
   * @param channel - 渠道实例
   * @param eventFilter - 该渠道关注的事件类型白名单。不传则接受所有类型。
   */
  register(
    channel: INotificationChannel,
    eventFilter?: ReadonlyArray<NotificationEventType>,
  ): this {
    this.registrations.set(channel.id, { channel, eventFilter });
    return this;
  }

  /** 注销渠道（按 ID） */
  unregister(channelId: string): this {
    this.registrations.delete(channelId);
    return this;
  }

  /** 获取当前所有已注册渠道的 ID 列表（用于调试） */
  getRegisteredChannelIds(): ReadonlyArray<string> {
    return [...this.registrations.keys()];
  }

  /**
   * 发送通知到匹配的渠道。
   *
   * 路由逻辑（按顺序）：
   * 1. 若 options.onlyWhenUnfocused=true 且窗口当前有焦点，则跳过
   * 2. 若 options.channels 指定了目标，则只向这些渠道发送
   * 3. 按渠道的 eventFilter 过滤（渠道不感兴趣的事件会被跳过）
   * 4. 检查渠道 isAvailable()，不可用的跳过
   * 5. 并发发送，任一渠道的错误被隔离，不影响其他渠道
   */
  async notify(
    payload: NotificationPayload,
    options: NotificationOptions = {},
  ): Promise<void> {
    if (options.onlyWhenUnfocused && typeof document !== "undefined" && document.hasFocus()) return;
    if (!useSettingsStore.getState().notificationsEnabled) return;

    const targets = this.resolveTargetChannels(payload.eventType, options.channels);
    if (targets.length === 0) return;

    // 统一播放应用内提示音（fire-and-forget），不依赖 OS 通知的 sound 参数
    if (useSettingsStore.getState().notificationSoundEnabled) {
      playNotificationSound().catch(() => {});
    }

    await Promise.allSettled(
      targets.map(async ({ channel }) => {
        try {
          if (!(await channel.isAvailable())) return;
          await channel.send(payload);
        } catch {
          // 渠道发送失败被隔离，不影响其他渠道和主流程
        }
      }),
    );
  }

  /** 解析本次通知实际需要发送的渠道注册列表 */
  private resolveTargetChannels(
    eventType: NotificationEventType,
    channelIds?: ReadonlyArray<string>,
  ): ReadonlyArray<ChannelRegistration> {
    return [...this.registrations.values()].filter((reg) => {
      // 1. 按显式渠道 ID 过滤
      if (channelIds && !channelIds.includes(reg.channel.id)) return false;
      // 2. 按渠道自身的事件过滤器过滤
      if (reg.eventFilter && reg.eventFilter.length > 0) {
        return reg.eventFilter.includes(eventType);
      }
      return true;
    });
  }
}

/** 应用全局单例 — 在 initGlobalStreamManager 中完成渠道注册 */
export const notificationManager = new NotificationManager();
