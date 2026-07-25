import { memo, useState, useEffect, useRef, useCallback } from "react";
import { useTranslation } from "react-i18next";
import { ChevronDown } from "lucide-react";
import { MarkdownRenderer, TailFadeText } from "@/components/ui/markdown-renderer";
import { useSmoothStreamText } from "./use-smooth-stream-text";

// ---------------------------------------------------------------------------
// ThinkingBlock — lightweight inline thinking indicator
// Design: pencil node NRq0D  |  Auto-expand while thinking, auto-collapse on done
// ---------------------------------------------------------------------------

/** Build a single-line preview: strip block syntax and trim long text. */
function buildPreviewText(text: string): string {
  return text
    .replace(/#{1,6}\s+/g, "")
    .replace(/^[-*+]\s+/gm, "")
    .replace(/^>\s+/gm, "")
    .replace(/\n+/g, " ")
    .trim()
    .slice(0, 150);
}

/** Render inline bold/italic/code in collapsed completed previews. */
function buildPreviewHtml(text: string): string {
  const plain = buildPreviewText(text);
  // Escape HTML, then convert inline markdown to HTML tags
  return plain
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
    .replace(/\*(.+?)\*/g, "<em>$1</em>")
    .replace(/`(.+?)`/g, "<code>$1</code>");
}

export interface ThinkingBlockProps {
  readonly thinking: string;
  /**
   * True while thinking deltas are still arriving for this block.
   * Derived from: `isStreaming && isLastBlock && !entry.complete`.
   */
  readonly isThinking: boolean;
}

/**
 * ThinkingSpark — a four-point star that "breathes" while the model thinks,
 * flanked by two satellite sparks twinkling on staggered delays. Replaces the
 * old capsule badge with a lightweight inline mascot.
 */
const SPARK_PATH =
  "M8 0 C8.6 4.8 11.2 7.4 16 8 C11.2 8.6 8.6 11.2 8 16 C7.4 11.2 4.8 8.6 0 8 C4.8 7.4 7.4 4.8 8 0 Z";

function ThinkingSpark({ active }: { readonly active: boolean }) {
  return (
    <span
      className={`thinking-spark ${active ? "thinking-spark-active" : "thinking-spark-idle"}`}
      aria-hidden="true"
    >
      <svg viewBox="0 0 16 16" className="thinking-spark-main">
        <path d={SPARK_PATH} fill="currentColor" />
      </svg>
      <svg viewBox="0 0 16 16" className="thinking-spark-satellite thinking-spark-satellite-a">
        <path d={SPARK_PATH} fill="currentColor" />
      </svg>
      <svg viewBox="0 0 16 16" className="thinking-spark-satellite thinking-spark-satellite-b">
        <path d={SPARK_PATH} fill="currentColor" />
      </svg>
    </span>
  );
}

export const ThinkingBlock = memo(function ThinkingBlock({
  thinking,
  isThinking,
}: ThinkingBlockProps) {
  const { t } = useTranslation();
  const [isExpanded, setIsExpanded] = useState(isThinking);
  const [elapsed, setElapsed] = useState(0);
  const smoothThinking = useSmoothStreamText(thinking, isThinking);
  const isRevealActive = isThinking || smoothThinking.isAnimating;

  const totalElapsedRef = useRef(0);
  const sessionStartRef = useRef<number | null>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const prevRevealActiveRef = useRef(isRevealActive);
  const userToggledRef = useRef(false);

  // ---- Auto-expand / auto-collapse on thinking state transitions ----
  useEffect(() => {
    if (isRevealActive && !prevRevealActiveRef.current) {
      // Thinking reveal just started → auto-expand, reset user toggle
      setIsExpanded(true);
      userToggledRef.current = false;
    } else if (!isRevealActive && prevRevealActiveRef.current && !userToggledRef.current) {
      // Reveal just ended and user didn't manually toggle → auto-collapse
      setIsExpanded(false);
    }
    prevRevealActiveRef.current = isRevealActive;
  }, [isRevealActive]);

  // ---- Timer: only runs while isThinking ----
  useEffect(() => {
    if (!isThinking) {
      if (sessionStartRef.current !== null) {
        totalElapsedRef.current += Math.floor(
          (Date.now() - sessionStartRef.current) / 1000,
        );
        sessionStartRef.current = null;
      }
      return;
    }

    sessionStartRef.current = Date.now();
    const interval = setInterval(() => {
      const s = Math.floor(
        (Date.now() - (sessionStartRef.current ?? Date.now())) / 1000,
      );
      setElapsed(totalElapsedRef.current + s);
    }, 1000);

    return () => clearInterval(interval);
  }, [isThinking]);

  // ---- Auto-scroll thinking body ----
  useEffect(() => {
    if (isRevealActive && isExpanded && contentRef.current) {
      contentRef.current.scrollTop = contentRef.current.scrollHeight;
    }
  }, [smoothThinking.text, isRevealActive, isExpanded]);

  const toggle = useCallback(() => {
    setIsExpanded((v) => !v);
    userToggledRef.current = true;
  }, []);

  const label = isRevealActive
    ? t("chat.thinkingBlock.thinking")
    : t("chat.thinkingBlock.completed");
  const durationText = elapsed > 0 ? `${elapsed}s` : "";

  // Preview: single-line HTML with inline bold/italic/code
  const previewText = smoothThinking.text ? buildPreviewText(smoothThinking.text) : "";
  const previewHtml = smoothThinking.text ? buildPreviewHtml(smoothThinking.text) : "";

  return (
    <div className="thinking-block-shell">
      {/* ---- Header row ---- */}
      <button
        className="thinking-block-toggle"
        type="button"
        onClick={toggle}
      >
        <ThinkingSpark active={isRevealActive} />
        <span
          className={`thinking-block-label ${isRevealActive ? "thinking-label-shimmer" : ""}`}
        >
          {label}
        </span>

        {/* Duration — shown inline after label when done */}
        {!isRevealActive && durationText && (
          <span
            className="thinking-block-duration"
            style={{
              color: "var(--color-muted-foreground)",
              fontFamily: "'JetBrains Mono', monospace",
              fontSize: 10,
              fontWeight: 400,
              flexShrink: 0,
            }}
          >
            {durationText}
          </span>
        )}

        {/* Chevron toggle indicator */}
        <ChevronDown
          size={13}
          className={`thinking-chevron ${isExpanded ? "thinking-chevron-open" : "thinking-chevron-closed"} ${isRevealActive ? "thinking-chevron-thinking" : "thinking-chevron-idle"}`}
          style={{
            flexShrink: 0,
            transition: "transform 250ms ease, color 300ms ease",
          }}
        />

        {/* Separator + rendered inline preview (only when collapsed) */}
        {!isExpanded && previewHtml && (
          <>
            <span
              className="thinking-block-separator"
              style={{
                color: "var(--color-text-tertiary)",
                fontFamily: "Inter, sans-serif",
                fontSize: 11,
                flexShrink: 0,
              }}
            >
              —
            </span>
            <span className="thinking-block-preview-inline">
              {isRevealActive
                ? <TailFadeText content={previewText} tailLength={8} />
                : <span dangerouslySetInnerHTML={{ __html: previewHtml }} />}
            </span>
          </>
        )}
      </button>

      {/* ---- Expanded body — always rendered, animated via CSS grid ---- */}
      {smoothThinking.text && (
        <div className={`thinking-body ${isExpanded ? "thinking-body-expanded" : "thinking-body-collapsed"}`}>
          <div className="thinking-body-inner">
            <div
              ref={contentRef}
              className="thinking-body-content"
            >
              <MarkdownRenderer
                content={smoothThinking.text}
                variant="compact"
                lightweight={isRevealActive}
              />
            </div>
          </div>
        </div>
      )}
    </div>
  );
});
