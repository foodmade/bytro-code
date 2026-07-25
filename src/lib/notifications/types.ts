/**
 * 系统通知模块 - 类型定义
 *
 * 设计原则：
 * - NotificationEventType 可按业务需求扩展
 * - NotificationPayload 携带足够上下文，供各渠道自由使用
 * - NotificationOptions 控制渠道路由和发送策略
 */

/** 通知事件类型 — 未来扩展时只需在此处追加新类型 */
export type NotificationEventType =
  | "ai_stream_complete"       // AI 流式响应完成
  | "background_task_complete" // 后台任务完成
  | "user_input_required"      // AI 通过 AskUserQuestion 请求用户回答
  | "approval_required"        // AI 请求用户授权工具执行（含 ExitPlanMode）
  | "error_occurred"           // 发生错误
  | "system_alert";            // 系统级告警

/** 单次通知的数据载荷 */
export interface NotificationPayload {
  /** 事件类型，用于路由和过滤 */
  readonly eventType: NotificationEventType;
  /** 通知标题 */
  readonly title: string;
  /** 通知正文（可选） */
  readonly body?: string;
  /** 关联的会话 ID（可选，用于跳转） */
  readonly conversationId?: string;
  /** 扩展元数据，业务方可自由填充 */
  readonly metadata?: Readonly<Record<string, unknown>>;
}

/** 发送通知时的选项 */
export interface NotificationOptions {
  /**
   * 指定发送到哪些渠道（通过渠道 ID）。
   * 若不指定，则广播到所有已注册的渠道。
   */
  readonly channels?: ReadonlyArray<string>;
  /**
   * 仅在应用窗口失去焦点时发送。
   * 适合"用户不在看屏幕时才打扰"的场景。
   */
  readonly onlyWhenUnfocused?: boolean;
}

/** 渠道配置（供 Manager 内部管理使用） */
export interface ChannelRegistration {
  readonly channel: INotificationChannel;
  /** 该渠道关注的事件类型白名单。为空时接受所有类型。 */
  readonly eventFilter?: ReadonlyArray<NotificationEventType>;
}

/** 通知渠道接口 — 所有渠道必须实现此接口 */
export interface INotificationChannel {
  /** 渠道唯一标识符，如 "os" | "toast" | "email" */
  readonly id: string;
  /** 渠道的可读名称 */
  readonly name: string;
  /** 当前渠道是否可用（如权限未授予则返回 false） */
  isAvailable(): Promise<boolean>;
  /** 发送通知 */
  send(payload: NotificationPayload): Promise<void>;
}
