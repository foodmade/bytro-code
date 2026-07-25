import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { WandSparkles } from "lucide-react";
import { useShallow } from "zustand/react/shallow";
import { useTranslation } from "react-i18next";
import { cn } from "@/lib/utils";
import { supportsCodexMaxReasoning } from "@/lib/platform-config";
import { isPeakReasoningVisualActive } from "@/lib/reasoning-visuals";
import { useSettingsStore } from "@/stores";
import type { ModelOptionsPlatformId, ReasoningLevel } from "@/stores/settings-store";

// ---------------------------------------------------------------------------
// EffortTimelinePopover — draggable timeline for picking the reasoning level.
// Claude gets an extra "ultracode" stop above Max that flips the global
// ultracode flag (sidecar forces xhigh + workflows when it is on).
// ---------------------------------------------------------------------------

export type EffortStop = ReasoningLevel | "ultracode";

const CODEX_STOPS: readonly EffortStop[] = ["off", "low", "medium", "high", "xhigh"];
const CODEX_NATIVE_MAX_STOPS: readonly EffortStop[] = [
  "off",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
];
// "off" mirrors the Thinking toggle (setReasoningLevel("off") disables thinking),
// so a claude session with thinking off still lands on a real stop.
const CLAUDE_STOPS: readonly EffortStop[] = ["off", "low", "medium", "high", "xhigh", "max", "ultracode"];

const POPOVER_WIDTH = 400;
const POPOVER_GAP = 8;
const VIEWPORT_GUTTER = 12;
/** Rough popover height used only to decide above/below placement. */
const PLACEMENT_HEIGHT_ESTIMATE = 150;

function effortStopsForPlatform(
  platformId: ModelOptionsPlatformId,
  modelId: string,
): readonly EffortStop[] {
  if (platformId !== "codex") return CLAUDE_STOPS;
  return supportsCodexMaxReasoning(modelId) ? CODEX_NATIVE_MAX_STOPS : CODEX_STOPS;
}

const selectEffortState = (s: ReturnType<typeof useSettingsStore.getState>) => ({
  reasoningLevel: s.reasoningLevel,
  ultracodeEnabled: s.platformModelOptions.claude.ultracodeEnabled,
  setReasoningLevel: s.setReasoningLevel,
  setPlatformUltracodeEnabled: s.setPlatformUltracodeEnabled,
});

interface EffortTimelinePopoverProps {
  readonly platformId: ModelOptionsPlatformId;
  readonly modelId: string;
  readonly anchorEl: HTMLElement | null;
  readonly onClose: () => void;
}

export const EffortTimelinePopover = memo(function EffortTimelinePopover({
  platformId,
  modelId,
  anchorEl,
  onClose,
}: EffortTimelinePopoverProps) {
  const { t } = useTranslation();
  const { reasoningLevel, ultracodeEnabled, setReasoningLevel, setPlatformUltracodeEnabled } =
    useSettingsStore(useShallow(selectEffortState));

  const nativeMaxSupported = platformId === "codex" && supportsCodexMaxReasoning(modelId);
  const stops = effortStopsForPlatform(platformId, modelId);
  const isClaude = platformId === "claude";
  const ultracodeActive = isClaude && ultracodeEnabled;

  const currentIndex = useMemo(() => {
    if (ultracodeActive) return stops.length - 1;
    // Older Codex models have no distinct "max" stop, so max renders as xhigh.
    const level = platformId === "codex" && reasoningLevel === "max" && !nativeMaxSupported
      ? "xhigh"
      : reasoningLevel;
    const idx = stops.indexOf(level);
    return idx >= 0 ? idx : Math.max(0, stops.indexOf("medium"));
  }, [nativeMaxSupported, platformId, reasoningLevel, stops, ultracodeActive]);

  const currentStop = stops[currentIndex];
  const atUltracode = currentStop === "ultracode";
  const peakVisualActive = isPeakReasoningVisualActive({
    sdk: platformId,
    modelId,
    reasoningLevel,
    ultracodeEnabled,
  });

  const commitIndex = useCallback(
    (index: number) => {
      const stop = stops[index];
      if (!stop) return;
      if (stop === "ultracode") {
        if (!ultracodeEnabled) setPlatformUltracodeEnabled("claude", true);
        return;
      }
      if (isClaude && ultracodeEnabled) setPlatformUltracodeEnabled("claude", false);
      if (stop !== reasoningLevel) setReasoningLevel(stop);
    },
    [isClaude, reasoningLevel, setPlatformUltracodeEnabled, setReasoningLevel, stops, ultracodeEnabled],
  );

  // ── Positioning ──────────────────────────────────────────────────────────
  const popoverRef = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState<{
    readonly left: number;
    readonly top?: number;
    readonly bottom?: number;
    readonly width: number;
  } | null>(null);

  const updatePosition = useCallback(() => {
    if (!anchorEl || typeof window === "undefined") return;
    const rect = anchorEl.getBoundingClientRect();
    const width = Math.min(POPOVER_WIDTH, window.innerWidth - VIEWPORT_GUTTER * 2);
    const left = Math.min(
      Math.max(rect.right - width, VIEWPORT_GUTTER),
      window.innerWidth - width - VIEWPORT_GUTTER,
    );
    const fitsAbove = rect.top - POPOVER_GAP - PLACEMENT_HEIGHT_ESTIMATE >= VIEWPORT_GUTTER;
    setPosition(
      fitsAbove
        ? { left, bottom: window.innerHeight - rect.top + POPOVER_GAP, width }
        : { left, top: rect.bottom + POPOVER_GAP, width },
    );
  }, [anchorEl]);

  useLayoutEffect(() => {
    updatePosition();
  }, [updatePosition]);

  useEffect(() => {
    const handleViewportChange = () => updatePosition();
    window.addEventListener("resize", handleViewportChange);
    window.addEventListener("scroll", handleViewportChange, true);
    return () => {
      window.removeEventListener("resize", handleViewportChange);
      window.removeEventListener("scroll", handleViewportChange, true);
    };
  }, [updatePosition]);

  // ── Dismiss on outside click / Escape ────────────────────────────────────
  useEffect(() => {
    const handlePointerDown = (e: MouseEvent) => {
      const target = e.target as Node;
      if (popoverRef.current?.contains(target)) return;
      if (anchorEl?.contains(target)) return;
      onClose();
    };
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("mousedown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("mousedown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [anchorEl, onClose]);

  // ── Drag interaction ─────────────────────────────────────────────────────
  const trackRef = useRef<HTMLDivElement>(null);
  const draggingRef = useRef(false);
  const [dragging, setDragging] = useState(false);

  const indexFromClientX = useCallback(
    (clientX: number): number | null => {
      const el = trackRef.current;
      if (!el) return null;
      const rect = el.getBoundingClientRect();
      if (rect.width <= 0) return null;
      const ratio = (clientX - rect.left) / rect.width;
      return Math.min(stops.length - 1, Math.max(0, Math.round(ratio * (stops.length - 1))));
    },
    [stops.length],
  );

  const handlePointerDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      e.preventDefault();
      e.currentTarget.setPointerCapture(e.pointerId);
      draggingRef.current = true;
      setDragging(true);
      const idx = indexFromClientX(e.clientX);
      if (idx != null) commitIndex(idx);
    },
    [commitIndex, indexFromClientX],
  );

  const handlePointerMove = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (!draggingRef.current) return;
      const idx = indexFromClientX(e.clientX);
      if (idx != null) commitIndex(idx);
    },
    [commitIndex, indexFromClientX],
  );

  const stopDragging = useCallback(() => {
    draggingRef.current = false;
    setDragging(false);
  }, []);

  const handleTrackKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "ArrowRight" || e.key === "ArrowUp") {
        e.preventDefault();
        commitIndex(Math.min(stops.length - 1, currentIndex + 1));
      } else if (e.key === "ArrowLeft" || e.key === "ArrowDown") {
        e.preventDefault();
        commitIndex(Math.max(0, currentIndex - 1));
      } else if (e.key === "Home") {
        e.preventDefault();
        commitIndex(0);
      } else if (e.key === "End") {
        e.preventDefault();
        commitIndex(stops.length - 1);
      }
    },
    [commitIndex, currentIndex, stops.length],
  );

  const stopLabel = useCallback(
    (stop: EffortStop, short: boolean): string =>
      stop === "ultracode"
        ? t("modelSelector.options.ultracode")
        : short
          ? t(`modelSelector.trigger.levelShort.${stop}`)
          : t(`chat.preferences.thinkingLevels.${stop}`),
    [t],
  );

  if (!position || typeof document === "undefined") return null;

  const pct = stops.length > 1 ? (currentIndex / (stops.length - 1)) * 100 : 0;
  const title = platformId === "codex"
    ? t("modelSelector.options.reasoning")
    : t("modelSelector.options.effort");

  return createPortal(
    <div
      ref={popoverRef}
      role="dialog"
      aria-label={title}
      className={cn("effort-timeline-popover", peakVisualActive && "effort-timeline-popover--ultracode")}
      style={{
        position: "fixed",
        left: position.left,
        top: position.top,
        bottom: position.bottom,
        width: position.width,
        zIndex: 50,
      }}
    >
      {/* Header */}
      <div className="flex items-center justify-between gap-2">
        <span className="text-[10px] font-semibold text-muted font-mono uppercase tracking-[1.5px]">
          {title}
        </span>
        <span
          className={cn(
            "flex items-center gap-1 text-[12px] font-semibold font-sans",
            peakVisualActive ? "ultracode-gradient-text" : "text-foreground",
          )}
        >
          {peakVisualActive && <WandSparkles size={12} className="effort-timeline-spark" aria-hidden />}
          {stopLabel(currentStop, false)}
        </span>
      </div>

      {/* Track */}
      <div
        ref={trackRef}
        role="slider"
        aria-valuemin={0}
        aria-valuemax={stops.length - 1}
        aria-valuenow={currentIndex}
        aria-valuetext={stopLabel(currentStop, false)}
        aria-label={title}
        tabIndex={0}
        className={cn("effort-timeline-track-zone", dragging && "effort-timeline-track-zone--dragging")}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={stopDragging}
        onPointerCancel={stopDragging}
        onKeyDown={handleTrackKeyDown}
      >
        <div className="effort-timeline-rail">
          <div
            className={cn("effort-timeline-fill", peakVisualActive && "effort-timeline-fill--ultracode")}
            style={{ width: `${pct}%` }}
          />
          {stops.map((stop, i) => {
            const stopPct = stops.length > 1 ? (i / (stops.length - 1)) * 100 : 0;
            const reached = i <= currentIndex;
            const peakStop = stop === "ultracode" || (nativeMaxSupported && stop === "max");
            return (
              <div
                key={stop}
                aria-hidden
                className={cn(
                  "effort-timeline-dot",
                  reached && "effort-timeline-dot--reached",
                  peakStop && "effort-timeline-dot--ultracode",
                )}
                style={{ left: `${stopPct}%` }}
              />
            );
          })}
          <div
            className={cn("effort-timeline-thumb", peakVisualActive && "effort-timeline-thumb--ultracode")}
            style={{ left: `${pct}%` }}
          />
        </div>
      </div>

      {/* Stop labels */}
      <div className="flex items-center justify-between">
        {stops.map((stop, i) => {
          const peakStop = stop === "ultracode" || (nativeMaxSupported && stop === "max");
          return (
            <button
              key={stop}
              type="button"
              onClick={() => commitIndex(i)}
              className={cn(
                "effort-timeline-label",
                i === currentIndex && "effort-timeline-label--active",
                peakStop && "effort-timeline-label--ultracode",
                peakStop && i === currentIndex && "ultracode-gradient-text",
              )}
            >
              {stopLabel(stop, true)}
            </button>
          );
        })}
      </div>

      {/* Ultracode hint — fixed height so toggling doesn't shift the popover */}
      {isClaude && (
        <div className="effort-timeline-hint" aria-hidden={!atUltracode}>
          {atUltracode && (
            <span className="ultracode-gradient-text flex items-center gap-1">
              <WandSparkles size={11} className="effort-timeline-spark" aria-hidden />
              {t("modelSelector.effortTimeline.ultracodeHint")}
            </span>
          )}
        </div>
      )}
    </div>,
    document.body,
  );
});
