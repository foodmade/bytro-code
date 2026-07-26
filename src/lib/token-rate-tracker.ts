import { create } from "zustand";
import type { NotchTokenRate, NotchUsageBreakdown } from "@/lib/notch-bridge";

// Token 速率采样器(共享单源)
//
// 由 use-notch-broadcaster 驱动采样(它已有 1s ticker + store 订阅),
// 采样结果同时:
//   1. 随 NotchState 推送到灵动岛 overlay 窗口
//   2. 写入 useTokenRateStore 供主窗口 UI(聊天输入框上方波形条)订阅

const RATE_BUCKET_MS = 1000;
const RATE_MAX_SAMPLES = 90;

export function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 10_000) return `${Math.round(n / 1000)}k`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return Math.round(n).toString();
}

export interface TokenRateTracker {
  /** 采样当前 token 总量,返回速率序列快照(含进行中桶的每秒等效速率)。按时间桶切分,幂等。 */
  sample(tokens: number): NotchTokenRate;
  /** 流结束:把剩余增量封为最后一个桶,返回冻结序列。 */
  finish(tokens: number): NotchTokenRate;
}

export function createTokenRateTracker(): TokenRateTracker {
  let active = false;
  let baseTokens = 0;
  let bucketStart = 0;
  let samples: Array<{ t: number; v: number }> = [];

  return {
    sample(tokens: number): NotchTokenRate {
      const now = Date.now();
      if (!active) {
        active = true;
        baseTokens = tokens;
        bucketStart = now;
        samples = [];
      }
      // usage 被新请求重置(总量回退)→ 重新对齐基准,避免负增量
      if (tokens < baseTokens) baseTokens = tokens;
      while (now - bucketStart >= RATE_BUCKET_MS) {
        const delta = Math.max(0, tokens - baseTokens);
        samples.push({ t: bucketStart + RATE_BUCKET_MS, v: delta });
        if (samples.length > RATE_MAX_SAMPLES) samples.shift();
        baseTokens = tokens;
        bucketStart += RATE_BUCKET_MS;
      }
      // 进行中的桶换算成整桶等效速率;不足半桶按半桶分母压制启动噪声
      const elapsed = now - bucketStart;
      const partialDelta = Math.max(0, tokens - baseTokens);
      const partialV = Math.round(
        (partialDelta / Math.max(elapsed, RATE_BUCKET_MS / 2)) * RATE_BUCKET_MS,
      );
      return {
        windowMs: RATE_BUCKET_MS,
        samples: [...samples, { t: bucketStart + RATE_BUCKET_MS, v: partialV }],
      };
    },

    finish(tokens: number): NotchTokenRate {
      if (active) {
        const delta = Math.max(0, tokens - baseTokens);
        if (delta > 0) {
          samples.push({ t: bucketStart + RATE_BUCKET_MS, v: delta });
          if (samples.length > RATE_MAX_SAMPLES) samples.shift();
        }
        active = false;
      }
      return { windowMs: RATE_BUCKET_MS, samples: [...samples] };
    },
  };
}

// ---------------------------------------------------------------------------
// 全局速率快照 store — 主窗口 UI 订阅用
// ---------------------------------------------------------------------------

export interface TokenRateSnapshot {
  readonly rate: NotchTokenRate | null;
  readonly usage: NotchUsageBreakdown | null;
  readonly tokens: number;
  readonly live: boolean;
}

interface TokenRateStoreState extends TokenRateSnapshot {
  readonly publish: (snapshot: TokenRateSnapshot) => void;
}

export const useTokenRateStore = create<TokenRateStoreState>((set) => ({
  rate: null,
  usage: null,
  tokens: 0,
  live: false,
  publish: (snapshot) => set(snapshot),
}));
