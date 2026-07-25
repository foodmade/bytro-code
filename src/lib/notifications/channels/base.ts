/**
 * 通知渠道基础抽象类
 *
 * 所有具体渠道（OS、Toast、未来的 Slack、Email 等）均继承此类。
 * 提供默认的 isAvailable 实现（始终可用），子类可按需覆盖。
 */
import type { INotificationChannel, NotificationPayload } from "../types";

export abstract class BaseNotificationChannel implements INotificationChannel {
  abstract readonly id: string;
  abstract readonly name: string;

  /** 默认可用，子类按需覆盖（如 OS 渠道需检查权限） */
  async isAvailable(): Promise<boolean> {
    return true;
  }

  abstract send(payload: NotificationPayload): Promise<void>;
}
