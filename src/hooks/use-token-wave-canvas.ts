import { useEffect, useRef, type RefObject } from "react";
import type { NotchTokenRate } from "@/lib/notch-bridge";

// Token 速率波形的共享 canvas 绘制逻辑
// 使用方:灵动岛展开面板(notch-token-wave)、聊天输入框上方波形条(chat-token-wave)
//
// 丝滑的关键实现:
// - canvas + rAF,x 轴由真实时间戳驱动 → 波形连续向左流动,没有逐点跳变
// - 每个采样点的显示值逐帧向目标缓动(指数趋近)→ 新桶数据"生长"出来
// - 进行中的桶 t 固定为桶右边界,封桶后同 key 原位替换 → 缓动状态无缝衔接
// - sqrt 缩放 y 轴 → 缓存读带来的数万级尖峰不会把常规输出压成一条直线

const VISIBLE_SPAN_MS = 75_000; // 可视窗口 ~75s(75 个 1s 桶)

export interface TokenWaveCanvasOptions {
  rate: NotchTokenRate | null | undefined;
  /** 是否有活跃流(true 时持续滚动,false 时冻结定格) */
  live: boolean;
  /** 是否可见 — false 时完全不绘制,rAF 停止 */
  active: boolean;
  /** 主色(6 位 hex,用于线条与渐变) */
  color: string;
  /** 光晕色 */
  glow: string;
  lineWidth?: number;
  /** 右缘实时扫描点(紧凑模式可关) */
  showDot?: boolean;
  /** 面积渐变顶部透明度,hex 双位后缀(如 "42") */
  fillAlphaHex?: string;
  /** 基线颜色;默认用主色低透明度,深浅主题下都可见 */
  baselineColor?: string;
  topPad?: number;
  bottomPad?: number;
}

// Catmull-Rom → cubic bezier,让折线变成连续光滑曲线
function traceSmoothPath(
  ctx: CanvasRenderingContext2D,
  pts: ReadonlyArray<{ x: number; y: number }>,
) {
  ctx.moveTo(pts[0].x, pts[0].y);
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[Math.max(0, i - 1)];
    const p1 = pts[i];
    const p2 = pts[i + 1];
    const p3 = pts[Math.min(pts.length - 1, i + 2)];
    ctx.bezierCurveTo(
      p1.x + (p2.x - p0.x) / 6,
      p1.y + (p2.y - p0.y) / 6,
      p2.x - (p3.x - p1.x) / 6,
      p2.y - (p3.y - p1.y) / 6,
      p2.x,
      p2.y,
    );
  }
}

export function useTokenWaveCanvas(
  canvasRef: RefObject<HTMLCanvasElement | null>,
  options: TokenWaveCanvasOptions,
): void {
  const optsRef = useRef(options);
  optsRef.current = options;
  // 逐点显示值(key = 桶右边界时间戳)与 y 轴缩放上限,均逐帧缓动
  const displayRef = useRef<Map<number, number>>(new Map());
  const maxRef = useRef(1);

  const { active, live, rate, color } = options;

  useEffect(() => {
    if (!active) return;
    const cvs = canvasRef.current;
    if (!cvs) return;

    let raf = 0;
    let mounted = true;
    let lastTs = performance.now();

    const drawFrame = (ts: number) => {
      if (!mounted || !canvasRef.current) return;
      const dt = Math.min(100, ts - lastTs);
      lastTs = ts;

      const opts = optsRef.current;
      const canvas = canvasRef.current;
      const parent = canvas.parentElement;
      const cssW = parent?.clientWidth ?? canvas.clientWidth;
      const cssH = parent?.clientHeight ?? canvas.clientHeight;
      if (cssW < 10 || cssH < 10) {
        if (opts.live) raf = requestAnimationFrame(drawFrame);
        return;
      }
      const dpr = window.devicePixelRatio || 1;
      if (canvas.width !== Math.round(cssW * dpr) || canvas.height !== Math.round(cssH * dpr)) {
        canvas.width = Math.round(cssW * dpr);
        canvas.height = Math.round(cssH * dpr);
      }
      const ctx = canvas.getContext("2d");
      if (!ctx) return;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, cssW, cssH);

      const samples = opts.rate?.samples ?? [];
      const windowMs = opts.rate?.windowMs ?? 1000;
      const topPad = opts.topPad ?? 8;
      const bottomPad = opts.bottomPad ?? 5;
      const now = opts.live ? Date.now() : (samples[samples.length - 1]?.t ?? Date.now());
      // 右缘对应 now + windowMs:进行中的桶贴右缘,随时间连续左移
      const xOf = (t: number) => cssW - ((now + windowMs - t) / VISIBLE_SPAN_MS) * cssW;

      // 显示值向目标缓动(dt 补偿,约 120ms 收敛过半)
      const k = opts.live ? 1 - Math.pow(0.0025, dt / 1000) : 1;
      const display = displayRef.current;
      for (const s of samples) {
        const cur = display.get(s.t);
        display.set(s.t, cur === undefined ? (opts.live ? 0 : s.v) : cur + (s.v - cur) * k);
      }
      for (const key of display.keys()) {
        if (key < now - VISIBLE_SPAN_MS) display.delete(key);
      }

      const pts = samples
        .filter((s) => s.t >= now - VISIBLE_SPAN_MS)
        .map((s) => ({ x: xOf(s.t), y: display.get(s.t) ?? 0 }));

      const baseline = cssH - bottomPad;

      // 基线(始终绘制,空数据时也有"示波器"的底)
      ctx.strokeStyle = opts.baselineColor ?? `${opts.color}26`;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(0, baseline);
      ctx.lineTo(cssW, baseline);
      ctx.stroke();

      if (pts.length > 0) {
        // y 轴缩放上限同样缓动,避免新尖峰导致整幅图突跳
        const targetMax = Math.max(1, ...pts.map((p) => p.y));
        maxRef.current += (targetMax - maxRef.current) * k;
        const sqrtMax = Math.sqrt(Math.max(maxRef.current, 1));
        const usableH = baseline - topPad;
        const yOf = (v: number) =>
          baseline - (Math.sqrt(Math.max(0, v)) / sqrtMax) * usableH;

        const drawPts = pts.map((p) => ({ x: p.x, y: yOf(p.y) }));
        // 左端:曲线从基线生长出来;右端:延伸出右缘保持满幅
        drawPts.unshift({ x: drawPts[0].x - 24, y: baseline });
        const last = drawPts[drawPts.length - 1];
        drawPts.push({ x: cssW + 12, y: last.y });

        ctx.save();
        ctx.beginPath();
        ctx.rect(0, 0, cssW, baseline);
        ctx.clip();

        // 渐变面积填充
        const grad = ctx.createLinearGradient(0, 0, 0, cssH);
        grad.addColorStop(0, `${opts.color}${opts.fillAlphaHex ?? "42"}`);
        grad.addColorStop(1, `${opts.color}00`);
        ctx.beginPath();
        traceSmoothPath(ctx, drawPts);
        ctx.lineTo(cssW + 12, baseline + 2);
        ctx.lineTo(drawPts[0].x, baseline + 2);
        ctx.closePath();
        ctx.fillStyle = grad;
        ctx.fill();

        // 发光曲线
        ctx.beginPath();
        traceSmoothPath(ctx, drawPts);
        ctx.strokeStyle = opts.color;
        ctx.lineWidth = opts.lineWidth ?? 1.8;
        ctx.lineJoin = "round";
        ctx.shadowColor = opts.glow;
        ctx.shadowBlur = 9;
        ctx.stroke();
        ctx.restore();

        // 右缘实时扫描点
        if (opts.live && (opts.showDot ?? true)) {
          const dotY = Math.min(Math.max(last.y, topPad), baseline);
          const pulse = 0.72 + 0.28 * Math.sin(ts / 320);
          ctx.beginPath();
          ctx.arc(cssW - 8, dotY, 5.5, 0, Math.PI * 2);
          ctx.fillStyle = `${opts.color}2E`;
          ctx.fill();
          ctx.beginPath();
          ctx.arc(cssW - 8, dotY, 2.4, 0, Math.PI * 2);
          ctx.fillStyle = opts.color;
          ctx.shadowColor = opts.glow;
          ctx.shadowBlur = 8 * pulse;
          ctx.fill();
          ctx.shadowBlur = 0;
        }
      }

      if (opts.live) raf = requestAnimationFrame(drawFrame);
    };

    raf = requestAnimationFrame(drawFrame);
    return () => {
      mounted = false;
      cancelAnimationFrame(raf);
    };
    // live=false 时无循环,依赖 rate/color 变化重画单帧;live=true 循环内读 ref
  }, [canvasRef, active, live, rate, color]);
}
