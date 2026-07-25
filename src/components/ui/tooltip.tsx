import {
  useCallback,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";

// ---------------------------------------------------------------------------
// Tooltip — instant-show, portal-rendered, no-dependency tooltip.
// HTML's native `title` attribute has a ~700 ms hover delay enforced by the
// OS that we can't tune, so any place that needs snappy feedback (toolbar
// icon buttons, etc.) wraps its trigger in this component instead.
// ---------------------------------------------------------------------------

type Placement = "top" | "bottom" | "left" | "right";

interface TooltipProps {
  /** What to show inside the bubble.  Strings render as plain text. */
  readonly content: ReactNode;
  /** The trigger element.  Wrapped in an inline-flex span so toolbar layout
   *  with `gap` keeps working. */
  readonly children: ReactNode;
  /** Default `bottom` so the tooltip floats under header buttons. Use
   *  `right` for menu items where top/bottom would overlap other rows. */
  readonly placement?: Placement;
  /** Optional max width in px (default 260). */
  readonly maxWidth?: number;
  /** Hide the tooltip entirely (e.g. when content is empty). */
  readonly disabled?: boolean;
  /** Override the trigger wrapper style. Default is `display: inline-flex`
   *  (fits the trigger). Pass `{ display: "block", width: "100%" }` when the
   *  trigger needs to span its parent (e.g. menu rows). */
  readonly wrapperStyle?: React.CSSProperties;
}

interface TriggerRect {
  readonly top: number;
  readonly bottom: number;
  readonly left: number;
  readonly right: number;
  readonly centerX: number;
  readonly centerY: number;
}

const VIEWPORT_MARGIN = 8;

export function Tooltip({
  content,
  children,
  placement = "bottom",
  maxWidth = 260,
  disabled = false,
  wrapperStyle,
}: TooltipProps) {
  const wrapperRef = useRef<HTMLSpanElement>(null);
  const tooltipRef = useRef<HTMLDivElement>(null);
  const [trigger, setTrigger] = useState<TriggerRect | null>(null);
  const [shiftX, setShiftX] = useState(0);

  const show = useCallback(() => {
    if (disabled) return;
    const el = wrapperRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    setTrigger({
      top: rect.top,
      bottom: rect.bottom,
      left: rect.left,
      right: rect.right,
      centerX: rect.left + rect.width / 2,
      centerY: rect.top + rect.height / 2,
    });
    setShiftX(0);
  }, [disabled]);

  const hide = useCallback(() => {
    setTrigger(null);
    setShiftX(0);
  }, []);

  // Measure the tooltip after it mounts and nudge it horizontally if it
  // overflows the viewport.  shiftX is cumulative — the next layout pass
  // measures the already-shifted rect, so we only update when there's still
  // a residual overflow to correct (avoids re-render loops).  When the
  // tooltip is wider than the viewport allows, pin to the left margin so the
  // left/right corrections don't oscillate.
  useLayoutEffect(() => {
    if (!trigger) return;
    const tip = tooltipRef.current;
    if (!tip) return;
    const rect = tip.getBoundingClientRect();
    const vw = window.innerWidth;
    const tooWide = rect.width > vw - 2 * VIEWPORT_MARGIN;
    let delta = 0;
    if (tooWide || rect.left < VIEWPORT_MARGIN) {
      delta = VIEWPORT_MARGIN - rect.left;
    } else if (rect.right > vw - VIEWPORT_MARGIN) {
      delta = vw - VIEWPORT_MARGIN - rect.right;
    }
    if (delta !== 0) setShiftX((prev) => prev + delta);
  }, [trigger, shiftX]);

  // For top/bottom placement we anchor by trigger.bottom/top; for left/right
  // we anchor vertically on the trigger center and shift horizontally by the
  // trigger edge plus a 6px gap.
  const isHorizontal = placement === "left" || placement === "right";
  const top = trigger
    ? isHorizontal
      ? trigger.centerY
      : placement === "bottom"
        ? trigger.bottom + 6
        : trigger.top - 6
    : 0;
  const left = trigger
    ? placement === "right"
      ? trigger.right + 6
      : placement === "left"
        ? trigger.left - 6
        : trigger.centerX
    : 0;

  let transform: string;
  if (placement === "bottom") {
    transform = `translateX(calc(-50% + ${shiftX}px))`;
  } else if (placement === "top") {
    transform = `translate(calc(-50% + ${shiftX}px), -100%)`;
  } else if (placement === "right") {
    transform = `translateY(-50%)`;
  } else {
    transform = `translate(-100%, -50%)`;
  }

  return (
    <>
      <span
        ref={wrapperRef}
        onMouseEnter={show}
        onMouseLeave={hide}
        onFocus={show}
        onBlur={hide}
        style={wrapperStyle ?? { display: "inline-flex" }}
      >
        {children}
      </span>
      {trigger && content && createPortal(
        <div
          ref={tooltipRef}
          role="tooltip"
          style={{
            position: "fixed",
            top,
            left,
            transform,
            zIndex: 10000,
            pointerEvents: "none",
            width: "max-content",
            maxWidth,
            padding: "5px 9px",
            borderRadius: 6,
            backgroundColor: "var(--color-card)",
            border: "1px solid var(--color-border-strong)",
            boxShadow: "var(--shadow-popup)",
            color: "var(--color-foreground)",
            fontFamily: "var(--font-sans)",
            fontSize: 11,
            lineHeight: 1.4,
            whiteSpace: "normal",
            wordBreak: "break-word",
          }}
        >
          {content}
        </div>,
        document.body,
      )}
    </>
  );
}
