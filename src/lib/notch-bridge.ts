import { emitTo } from "@tauri-apps/api/event";
import type { PlatformId } from "@/lib/platform-config";

// 灵动岛跨窗口状态推送桥
// 主窗口订阅 stream-state/agent-status/settings,把状态变化推到 notch-overlay 窗口

export const NOTCH_WINDOW_LABEL = "notch-overlay";
export const NOTCH_STATE_EVENT = "notch:state";
export const NOTCH_COLLAPSE_EVENT = "notch:collapse";
export const NOTCH_LAST_STATE_STORAGE_KEY = "notch:last-state";
export const NOTCH_ACTIVE_SOURCES_STORAGE_KEY = "notch:active-sources";

export type NotchProvider = PlatformId;

export interface NotchApprovalQuestionItem {
  readonly question: string;
  readonly header: string;
  readonly options: ReadonlyArray<{ label: string; description: string }>;
  readonly multiSelect: boolean;
}

// Token 用量拆分(输入/输出/缓存),用于展开面板统计行
export interface NotchUsageBreakdown {
  readonly input: number;
  readonly output: number;
  readonly cacheRead: number;
  readonly cacheWrite: number;
}

// Token 速率采样点:t = 桶右边界时间戳,v = 该采样桶(windowMs)内消耗的 token 数。
// 序列最后一个点是进行中的桶,v 已换算成整桶等效速率;它的 t 固定为
// 桶右边界(未来时刻),封桶后被同 t 的正式值原位替换 — overlay 端据此
// 做逐点缓动而不会产生 key 抖动。
export interface NotchRateSample {
  readonly t: number;
  readonly v: number;
}

export interface NotchTokenRate {
  readonly windowMs: number;
  readonly samples: ReadonlyArray<NotchRateSample>;
}

export type NotchState =
  | { kind: "idle" }
  | {
      kind: "streaming";
      provider: NotchProvider;
      phase: "connecting" | "waiting" | "thinking" | "generating";
      elapsedMs: number;
      tokens: number;
      usage?: NotchUsageBreakdown;
      rate?: NotchTokenRate;
    }
  | {
      kind: "tool";
      provider: NotchProvider;
      toolName: string;
      elapsedMs: number;
      tokens: number;
      usage?: NotchUsageBreakdown;
      rate?: NotchTokenRate;
    }
  | {
      kind: "done";
      provider: NotchProvider;
      durationMs: number;
      tokens: number;
      usage?: NotchUsageBreakdown;
      rate?: NotchTokenRate;
    }
  | { kind: "error"; message: string }
  | {
      kind: "approval";
      provider: NotchProvider;
      confirmId: string;
      toolCallId: string;
      toolName: string;
      toolInput: string;
      conversationId: string;
      arrivedAt: number;
      queueDepth: number;
    }
  | {
      kind: "approval-bash";
      provider: NotchProvider;
      confirmId: string;
      toolCallId: string;
      command: string;
      conversationId: string;
      arrivedAt: number;
      queueDepth: number;
    }
  | {
      kind: "ask-question";
      provider: NotchProvider;
      confirmId: string;
      toolCallId: string;
      questions: ReadonlyArray<NotchApprovalQuestionItem>;
      conversationId: string;
      arrivedAt: number;
      queueDepth: number;
    };

export const NOTCH_APPROVAL_RESOLVED_EVENT = "notch:approval-resolved";

export interface NotchApprovalResolvedPayload {
  confirmId: string;
  toolCallId: string;
  kind: "approval" | "approval-bash" | "ask-question";
  conversationId: string;
  approved?: boolean;
}

export async function broadcastNotchState(state: NotchState): Promise<void> {
  try {
    window.localStorage.setItem(NOTCH_LAST_STATE_STORAGE_KEY, JSON.stringify(state));
  } catch {
    console.warn("[notch][bridge] failed to persist the latest state");
  }

  try {
    await emitTo(NOTCH_WINDOW_LABEL, NOTCH_STATE_EVENT, state);
  } catch {
    console.warn("[notch][bridge] overlay state delivery failed");
    // notch 窗口可能未创建(非 macOS / 测试环境),静默忽略
  }
}

// Provider → 主题色(用于灵动岛胶囊配色)
export function notchAccent(provider: NotchProvider): {
  primary: string;
  glow: string;
} {
  switch (provider) {
    case "claude":
      return { primary: "#A855F7", glow: "rgba(168,85,247,0.55)" };
    case "codex":
      return { primary: "#10B981", glow: "rgba(16,185,129,0.55)" };
    case "gemini":
      return { primary: "#4285F4", glow: "rgba(66,133,244,0.55)" };
    case "grok":
      return { primary: "#F5F5F5", glow: "rgba(245,245,245,0.45)" };
    case "deepseek":
      return { primary: "#3B82F6", glow: "rgba(59,130,246,0.55)" };
    case "qwen":
      return { primary: "#7C3AED", glow: "rgba(124,58,237,0.55)" };
    default:
      return { primary: "#A855F7", glow: "rgba(168,85,247,0.55)" };
  }
}
