import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Activity, ChevronDown, ChevronUp, Sparkles } from "lucide-react";
import { formatTokens, useTokenRateStore } from "@/lib/token-rate-tracker";
import { useTokenWaveCanvas } from "@/hooks/use-token-wave-canvas";

// 聊天输入框上方的实时 token 速率波形条
//
// 设计目标:非常轻量 — 折叠态只有一行 22px(迷你波形 + 当前速率),
// 展开态才显示完整波形与输入/输出/缓存统计。流式开始时淡入,
// 结束后保留几秒供查看,然后自动淡出。

const LINGER_MS = 6000;
const EXPANDED_STORAGE_KEY = "chat-token-wave:expanded";
const SPRING = "cubic-bezier(.34, 1.4, .64, 1)";

function readExpandedPref(): boolean {
  try {
    return window.localStorage.getItem(EXPANDED_STORAGE_KEY) === "1";
  } catch {
    return false;
  }
}

// 从 CSS 变量解析 provider 强调色(canvas 无法直接消费 var())
function resolveAccent(): { primary: string; glow: string } {
  const style = getComputedStyle(document.documentElement);
  const primary = style.getPropertyValue("--color-accent-purple").trim() || "#A855F7";
  const rgb = style.getPropertyValue("--theme-accent-rgb").trim();
  const glow = rgb ? `rgba(${rgb},0.5)` : `${primary}80`;
  return { primary, glow };
}

export function ChatTokenWave() {
  const { t } = useTranslation();
  const rate = useTokenRateStore((s) => s.rate);
  const usage = useTokenRateStore((s) => s.usage);
  const tokens = useTokenRateStore((s) => s.tokens);
  const live = useTokenRateStore((s) => s.live);

  const [expanded, setExpanded] = useState(readExpandedPref);
  const [visible, setVisible] = useState(live);
  const miniCanvasRef = useRef<HTMLCanvasElement>(null);
  const fullCanvasRef = useRef<HTMLCanvasElement>(null);

  // 流式开始 → 立即显示;结束 → 保留几秒后淡出
  useEffect(() => {
    if (live) {
      setVisible(true);
      return;
    }
    const timer = window.setTimeout(() => setVisible(false), LINGER_MS);
    return () => window.clearTimeout(timer);
  }, [live]);

  // provider 主题色可能随会话/平台切换,在可见性与展开切换时重读
  const accent = useMemo(resolveAccent, [visible, expanded, live]);

  useTokenWaveCanvas(miniCanvasRef, {
    rate,
    live,
    active: visible && !expanded,
    color: accent.primary,
    glow: accent.glow,
    lineWidth: 1.2,
    showDot: false,
    fillAlphaHex: "2E",
    topPad: 2,
    bottomPad: 1,
  });

  useTokenWaveCanvas(fullCanvasRef, {
    rate,
    live,
    active: visible && expanded,
    color: accent.primary,
    glow: accent.glow,
    fillAlphaHex: "36",
    topPad: 6,
    bottomPad: 1,
  });

  const { currentV, peakV } = useMemo(() => {
    const samples = rate?.samples ?? [];
    const current = samples.length > 0 ? samples[samples.length - 1].v : 0;
    const sealed = live ? samples.slice(0, -1) : samples;
    const peak = sealed.reduce((m, s) => Math.max(m, s.v), 0);
    return { currentV: current, peakV: Math.max(peak, current) };
  }, [rate, live]);

  const toggleExpanded = () => {
    setExpanded((prev) => {
      const next = !prev;
      try {
        window.localStorage.setItem(EXPANDED_STORAGE_KEY, next ? "1" : "0");
      } catch {
        /* ignore */
      }
      return next;
    });
  };

  if (!visible) return null;

  return (
    <div
      style={{
        width: "100%",
        height: expanded ? 90 : 22,
        overflow: "hidden",
        background: "transparent",
        transition: `height 360ms ${SPRING}`,
        boxSizing: "border-box",
      }}
    >
      {/* 顶行:折叠态的全部内容 / 展开态的头部(含统计标签) */}
      <div
        onClick={toggleExpanded}
        role="button"
        aria-label={expanded ? t("chat.tokenWave.collapse") : t("chat.tokenWave.expand")}
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          height: 22,
          padding: "0 6px",
          cursor: "pointer",
          userSelect: "none",
          fontVariantNumeric: "tabular-nums",
        }}
      >
        <Activity
          size={11}
          strokeWidth={2.4}
          style={{ color: "var(--color-accent-purple)", flexShrink: 0 }}
        />
        {/* 折叠态迷你波形(展开时收缩让位给头部) */}
        <div
          style={{
            position: "relative",
            width: expanded ? 0 : 88,
            height: 14,
            flexShrink: 0,
            opacity: expanded ? 0 : 1,
            transition: `width 360ms ${SPRING}, opacity 160ms ease`,
            overflow: "hidden",
          }}
        >
          <canvas
            ref={miniCanvasRef}
            style={{ position: "absolute", inset: 0, width: 88, height: "100%" }}
          />
        </div>
        <span
          style={{
            fontFamily: "var(--font-mono)",
            fontSize: 10.5,
            fontWeight: 600,
            color: "var(--color-foreground)",
            whiteSpace: "nowrap",
          }}
        >
          {formatTokens(currentV)}
        </span>
        <span
          style={{
            fontSize: 9.5,
            color: "var(--color-muted)",
            whiteSpace: "nowrap",
          }}
        >
          {t("chat.tokenWave.perWindow")}
        </span>
        {peakV > 0 && (
          <span
            style={{
              fontSize: 9.5,
              color: "var(--color-muted)",
              whiteSpace: "nowrap",
              opacity: expanded ? 1 : 0,
              transition: "opacity 200ms ease",
            }}
          >
            {t("chat.tokenWave.peak", { value: formatTokens(peakV) })}
          </span>
        )}
        {/* 展开态统计标签(折叠时淡出,不参与折叠行的视觉) */}
        <span
          style={{
            display: "flex",
            alignItems: "center",
            gap: 12,
            fontSize: 9.5,
            color: "var(--color-muted)",
            whiteSpace: "nowrap",
            overflow: "hidden",
            opacity: expanded ? 1 : 0,
            transition: `opacity 200ms ease ${expanded ? "120ms" : "0ms"}`,
            marginLeft: 4,
          }}
        >
          <span style={{ display: "flex", alignItems: "center", gap: 4 }}>
            <Sparkles size={10} style={{ color: "var(--color-accent-purple)" }} />
            <span style={{ color: "var(--color-muted-foreground)", fontWeight: 600 }}>
              {formatTokens(tokens)}
            </span>
          </span>
          {usage && (
            <>
              <span>
                {t("chat.tokenWave.input")}{" "}
                <span style={{ color: "var(--color-muted-foreground)" }}>
                  {formatTokens(usage.input)}
                </span>
              </span>
              <span>
                {t("chat.tokenWave.output")}{" "}
                <span style={{ color: "var(--color-muted-foreground)" }}>
                  {formatTokens(usage.output)}
                </span>
              </span>
              <span>
                {t("chat.tokenWave.cache")}{" "}
                <span style={{ color: "var(--color-muted-foreground)" }}>
                  {formatTokens(usage.cacheRead + usage.cacheWrite)}
                </span>
              </span>
            </>
          )}
        </span>
        <span style={{ flex: 1 }} />
        {expanded ? (
          <ChevronDown size={12} style={{ color: "var(--color-muted)", flexShrink: 0 }} />
        ) : (
          <ChevronUp size={12} style={{ color: "var(--color-muted)", flexShrink: 0 }} />
        )}
      </div>

      {/* 展开态:波形满宽,x 轴基线贴合输入框顶边 */}
      <div
        style={{
          position: "relative",
          height: 68,
          opacity: expanded ? 1 : 0,
          transition: `opacity 220ms ease ${expanded ? "140ms" : "0ms"}`,
          pointerEvents: "none",
          overflow: "hidden",
        }}
      >
        <canvas
          ref={fullCanvasRef}
          style={{ position: "absolute", inset: 0, width: "100%", height: "100%" }}
        />
      </div>
    </div>
  );
}
