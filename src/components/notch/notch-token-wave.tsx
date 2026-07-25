import { useMemo, useRef } from "react";
import { Activity, Gauge } from "lucide-react";
import type { NotchTokenRate } from "@/lib/notch-bridge";
import { useTokenWaveCanvas } from "@/hooks/use-token-wave-canvas";
import { formatTokens } from "@/lib/token-rate-tracker";

// 灵动岛 token 速率波形图(展开面板)
// 绘制逻辑在 use-token-wave-canvas.ts,与主窗口波形条共享。

export function NotchTokenWave({
  rate,
  live,
  active,
  accent,
}: {
  rate: NotchTokenRate | undefined;
  live: boolean;
  /** 面板是否可见 — 折叠态组件常驻但不绘制,rAF 完全停止 */
  active: boolean;
  accent: { primary: string; glow: string };
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useTokenWaveCanvas(canvasRef, {
    rate,
    live,
    active,
    color: accent.primary,
    glow: accent.glow,
    baselineColor: "rgba(255,255,255,0.07)",
  });

  const { currentV, peakV } = useMemo(() => {
    const samples = rate?.samples ?? [];
    const current = samples.length > 0 ? samples[samples.length - 1].v : 0;
    // 峰值只统计已封的桶(最后一个是进行中的等效速率,波动大)
    const sealed = live ? samples.slice(0, -1) : samples;
    const peak = sealed.reduce((m, s) => Math.max(m, s.v), 0);
    return { currentV: current, peakV: Math.max(peak, current) };
  }, [rate, live]);

  return (
    <div style={{ position: "relative", flex: 1, minHeight: 0, overflow: "hidden" }}>
      <canvas
        ref={canvasRef}
        style={{ position: "absolute", inset: 0, width: "100%", height: "100%" }}
      />
      {/* 左上:实时速率 */}
      <div
        style={{
          position: "absolute",
          top: 2,
          left: 2,
          display: "flex",
          alignItems: "baseline",
          gap: 6,
          pointerEvents: "none",
        }}
      >
        <Activity
          size={12}
          color={accent.primary}
          strokeWidth={2.4}
          style={{ alignSelf: "center" }}
        />
        <span
          style={{
            fontSize: 20,
            fontWeight: 700,
            lineHeight: 1,
            color: "#fff",
            fontFamily: "'JetBrains Mono Variable', ui-monospace, monospace",
            fontVariantNumeric: "tabular-nums",
            textShadow: `0 0 14px ${accent.glow}`,
          }}
        >
          {formatTokens(currentV)}
        </span>
        <span style={{ fontSize: 9.5, color: "#8a8a8a", fontWeight: 500 }}>
          tokens / s
        </span>
      </div>
      {/* 右上:峰值 */}
      {peakV > 0 && (
        <div
          style={{
            position: "absolute",
            top: 4,
            right: 2,
            display: "flex",
            alignItems: "center",
            gap: 4,
            fontSize: 9.5,
            color: "#8a8a8a",
            pointerEvents: "none",
            fontVariantNumeric: "tabular-nums",
          }}
        >
          <Gauge size={10} strokeWidth={2.2} />
          峰值 {formatTokens(peakV)}
        </div>
      )}
    </div>
  );
}
