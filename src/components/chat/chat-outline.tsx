import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { RefObject } from "react";
import { useTranslation } from "react-i18next";

import type { ChatMessage } from "@/stores/chat-store";

const TRACK_WIDTH = 36;
// Top/bottom inset of the rail. Has to be large enough that the hover
// tooltip on the very top/bottom dot still fits inside the chat panel —
// roughly half a tooltip's height plus breathing room. Computed at runtime
// so very short panels (split panes, narrow windows) don't crush the rail.
const RAIL_PADDING_MAX = 48;
const RAIL_PADDING_MIN = 20;
const RAIL_PADDING_RATIO = 0.08;
// Inactive tick — a short horizontal rule. Hover lengthens + brightens it;
// the active tick is the brightest and a touch longer. Kept 2px thin so a
// dense stack still reads as separate rules rather than one filled block.
const TICK_HEIGHT = 2;
const TICK_WIDTH_DEFAULT = 16;
const TICK_WIDTH_HOVER = 20;
const TICK_WIDTH_ACTIVE = 22;
// Fixed number of slots visible in the rail at any time. Pitch is derived
// from the rail's actual height so the slots evenly fill the chat panel —
// any messages beyond this window are clipped above / below.
const WINDOW_SLOTS = 14;
// Cap on per-slot height (= the vertical gap between ticks). Without this, a
// 2-message conversation would split the rail into two giant slots (~half the
// panel each) and the active highlight would drift far from its tick. A tight
// cap keeps short outlines compact; once messages exceed the window, the
// natural pitch (railHeight / WINDOW_SLOTS) is already smaller, so the cap
// only ever applies to short conversations.
const MAX_DOT_PITCH = 28;
const PREVIEW_MAX_LENGTH = 40;
// Hover preview — one rounded card (图2) listing every user message. Width is
// fixed; the card height hugs its content up to the rail height, then scrolls.
const PREVIEW_WIDTH = 300;
const PREVIEW_GAP = 12;
const PREVIEW_ROW_HEIGHT = 40;
const PREVIEW_CARD_PADDING = 6;
const PREVIEW_CARD_RADIUS = 16;
const BLOOM_DURATION_MS = 240;
const PREVIEW_STAGGER_MS = 14;
// Cap stagger delay so jumping to a far row doesn't make the bloom feel
// frozen — beyond ~14 rows worth of stagger we just snap to "fully open".
const PREVIEW_STAGGER_MAX_MS = 200;
const SCROLL_TARGET_OFFSET_RATIO = 0.28;
// Two-stage motion. The thumb glides to its new dot first; only after it
// reaches the new position does the rail slide to put the thumb back at the
// centre. Without this, the user sees nothing move (thumb is always centre).
//
// Thumb duration scales with how many slots the thumb crosses — short hops
// stay snappy, long jumps get a clear, slow glide so the user can follow it.
const THUMB_BASE_MS = 260;
const THUMB_PER_SLOT_MS = 32;
const THUMB_MAX_MS = 620;
const RAIL_TRANSITION_MS = 280;
const SCROLL_SYNC_THROTTLE_MS = 96;

interface OutlineNode {
  readonly id: string;
  readonly index: number;
  readonly preview: string;
}

interface ChatOutlineProps {
  readonly messages: readonly ChatMessage[];
  readonly scrollContainerRef: RefObject<HTMLDivElement | null>;
}

function extractPreview(content: string, displayContent?: string): string {
  const text = (displayContent || content || "").trim();
  if (!text) return "";
  const firstLine = text.split(/\r?\n/).find((line) => line.trim()) ?? text;
  if (firstLine.length <= PREVIEW_MAX_LENGTH) return firstLine;
  return firstLine.slice(0, PREVIEW_MAX_LENGTH).trimEnd() + "…";
}

export const ChatOutline = memo(function ChatOutline({
  messages,
  scrollContainerRef,
}: ChatOutlineProps) {
  const { t } = useTranslation();

  const userNodes = useMemo<OutlineNode[]>(() => {
    const nodes: OutlineNode[] = [];
    let idx = 0;
    for (const msg of messages) {
      if (msg.role !== "user") continue;
      if (msg.commandInvocation) continue;
      const preview = extractPreview(msg.content, msg.displayContent);
      if (!preview) continue;
      idx += 1;
      nodes.push({ id: msg.id, index: idx, preview });
    }
    return nodes;
  }, [messages]);

  const [currentId, setCurrentId] = useState<string | null>(null);
  const [hoverId, setHoverId] = useState<string | null>(null);
  const [outerHeight, setOuterHeight] = useState(0);
  const [expanded, setExpanded] = useState(false);
  // Tracks the previous `expanded` value across renders so we can tell
  // "preview just opened" apart from "preview already open, scrollTop happens
  // to be 0" — the latter must use smooth scroll, not jump.
  const prevExpandedRef = useRef(false);
  const collapseTimerRef = useRef<number | null>(null);
  const previewScrollRef = useRef<HTMLDivElement>(null);
  const previewAutoScrollTimerRef = useRef<number | null>(null);
  const programmaticScrollUntilRef = useRef<number>(0);
  const elementCacheRef = useRef<Map<string, HTMLElement>>(new Map());
  const outerRef = useRef<HTMLDivElement>(null);
  // Stable handle to the latest `compute` so scrollend handlers (registered
  // outside the effect) can re-sync currentId after a programmatic smooth
  // scroll ends — particularly when the user interrupts it mid-flight.
  const computeRef = useRef<() => void>(() => {});
  // Monotonic token to invalidate stale scrollend handlers — every click
  // bumps it; stale once-handlers from previous clicks early-return so they
  // can't snap currentId back to a mid-flight position.
  const scrollTokenRef = useRef(0);
  // Abort controller for the in-flight scrollend listener. New clicks abort
  // the previous one so the browser can never deliver a stale scrollend (e.g.
  // the one fired when scrollTo interrupts a previous smooth scroll) to the
  // current handler — which would otherwise pass the token check and clear
  // the lock before the new scroll reaches its target.
  const scrollAbortRef = useRef<AbortController | null>(null);
  // Fallback timer — guarantees the lock is released and currentId resyncs
  // even when the browser doesn't fire scrollend (older webviews) or when a
  // user-interrupted smooth scroll never produces an end event.
  const scrollFallbackTimerRef = useRef<number | null>(null);

  const total = userNodes.length;
  const currentIndex = useMemo(() => {
    if (!currentId) return 0;
    const i = userNodes.findIndex((n) => n.id === currentId);
    return i >= 0 ? i : 0;
  }, [userNodes, currentId]);

  // Compute the thumb's transition duration based on slot distance, in the
  // same render that currentIndex changes (so the new top + new duration are
  // applied together — otherwise the first frame uses the previous duration).
  const prevCurrentIndexRef = useRef(currentIndex);
  const thumbDurationRef = useRef(THUMB_BASE_MS);
  if (prevCurrentIndexRef.current !== currentIndex) {
    const delta = Math.abs(currentIndex - prevCurrentIndexRef.current);
    thumbDurationRef.current = Math.min(
      THUMB_MAX_MS,
      THUMB_BASE_MS + delta * THUMB_PER_SLOT_MS,
    );
    prevCurrentIndexRef.current = currentIndex;
  }
  const thumbDuration = thumbDurationRef.current;

  // Measure outer container height (= chat panel height) so we can derive
  // both the responsive top/bottom padding and the inner rail height in one
  // pass. Measuring the rail itself would create a layout cycle once padding
  // becomes a function of measured size.
  useEffect(() => {
    const el = outerRef.current;
    if (!el) return undefined;
    const measure = () => setOuterHeight(el.clientHeight);
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Drop any in-flight scrollend listener when the component unmounts so it
  // can't fire on a stale root after teardown.
  useEffect(
    () => () => {
      scrollAbortRef.current?.abort();
      if (collapseTimerRef.current) {
        window.clearTimeout(collapseTimerRef.current);
      }
      if (scrollFallbackTimerRef.current !== null) {
        window.clearTimeout(scrollFallbackTimerRef.current);
      }
      if (previewAutoScrollTimerRef.current !== null) {
        window.clearTimeout(previewAutoScrollTimerRef.current);
      }
    },
    [],
  );


  const handleEnter = useCallback(() => {
    if (collapseTimerRef.current) {
      window.clearTimeout(collapseTimerRef.current);
      collapseTimerRef.current = null;
    }
    setExpanded(true);
  }, []);

  const handleLeave = useCallback(() => {
    if (collapseTimerRef.current) {
      window.clearTimeout(collapseTimerRef.current);
    }
    // Small delay so a brief mouseout (e.g. crossing the gap between dots
    // and preview text) doesn't snap the bloom shut.
    collapseTimerRef.current = window.setTimeout(() => {
      setExpanded(false);
    }, 200);
  }, []);

  const findElement = useCallback(
    (root: HTMLElement, id: string): HTMLElement | null => {
      const cached = elementCacheRef.current.get(id);
      if (cached && cached.isConnected) return cached;
      const fresh = root.querySelector<HTMLElement>(
        `[data-message-id="${CSS.escape(id)}"]`,
      );
      if (fresh) elementCacheRef.current.set(id, fresh);
      return fresh;
    },
    [],
  );

  // Track which user message is closest to the viewport probe line.
  useEffect(() => {
    const root = scrollContainerRef.current;
    if (!root || total === 0) return undefined;

    elementCacheRef.current.clear();
    const visibleIds = new Set<string>();
    const observed: HTMLElement[] = [];

    const compute = () => {
      if (Date.now() < programmaticScrollUntilRef.current) return;
      const rootRect = root.getBoundingClientRect();
      const probe = rootRect.top + rootRect.height * SCROLL_TARGET_OFFSET_RATIO;
      const candidateIds: Iterable<string> =
        visibleIds.size > 0 ? visibleIds : userNodes.map((n) => n.id);
      let bestId: string | null = null;
      let bestDist = Number.POSITIVE_INFINITY;
      for (const id of candidateIds) {
        const el = elementCacheRef.current.get(id);
        if (!el || !el.isConnected) continue;
        const r = el.getBoundingClientRect();
        const d = Math.abs(r.top - probe);
        if (d < bestDist) {
          bestDist = d;
          bestId = id;
        }
      }
      if (bestId) setCurrentId(bestId);
    };
    computeRef.current = compute;

    const io = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          const id = (entry.target as HTMLElement).dataset.messageId;
          if (!id) continue;
          if (entry.isIntersecting) visibleIds.add(id);
          else visibleIds.delete(id);
        }
        compute();
      },
      { root, rootMargin: "25% 0px 25% 0px", threshold: 0 },
    );

    for (const n of userNodes) {
      const el = findElement(root, n.id);
      if (el) {
        io.observe(el);
        observed.push(el);
      }
    }

    compute();

    let scrollSyncTimer = 0;
    const onScroll = () => {
      if (scrollSyncTimer) return;
      scrollSyncTimer = window.setTimeout(() => {
        scrollSyncTimer = 0;
        compute();
      }, SCROLL_SYNC_THROTTLE_MS);
    };
    root.addEventListener("scroll", onScroll, { passive: true });
    const ro = new ResizeObserver(compute);
    ro.observe(root);
    return () => {
      root.removeEventListener("scroll", onScroll);
      ro.disconnect();
      for (const el of observed) io.unobserve(el);
      io.disconnect();
      if (scrollSyncTimer) window.clearTimeout(scrollSyncTimer);
    };
  }, [userNodes, scrollContainerRef, findElement, total]);

  const scrollToNode = useCallback(
    (id: string) => {
      const root = scrollContainerRef.current;
      if (!root) return;
      const el = findElement(root, id);
      if (!el) return;
      const rootRect = root.getBoundingClientRect();
      const elRect = el.getBoundingClientRect();
      const target = Math.max(
        0,
        root.scrollTop +
          (elRect.top - rootRect.top) -
          rootRect.height * SCROLL_TARGET_OFFSET_RATIO,
      );
      const distance = Math.abs(target - root.scrollTop);
      const fallbackMs = Math.min(1500, Math.max(400, distance * 0.6));
      programmaticScrollUntilRef.current = Date.now() + fallbackMs;
      const myToken = ++scrollTokenRef.current;
      setCurrentId(id);
      // Tear down the previous scrollend listener before scrollTo runs — that
      // call may immediately fire scrollend for the interrupted previous
      // scroll, and we don't want our brand-new handler to consume it.
      scrollAbortRef.current?.abort();
      // Cancel any in-flight fallback from a previous click — its compute
      // would race with this click's scroll if left armed.
      if (scrollFallbackTimerRef.current !== null) {
        window.clearTimeout(scrollFallbackTimerRef.current);
        scrollFallbackTimerRef.current = null;
      }
      if ("onscrollend" in root) {
        const ctrl = new AbortController();
        scrollAbortRef.current = ctrl;
        const handleEnd = () => {
          // Token: catches stale handlers if a browser still delivers an
          // event despite the abort.
          if (myToken !== scrollTokenRef.current) return;
          // Position: when scrollTo(B) interrupts scrollTo(A), some browsers
          // still dispatch a scrollend for the aborted A — this handler is
          // already registered, so without a position check it would clear
          // the lock while scroll is mid-flight to B and snap currentId to a
          // pass-through message. Real B-completion has scrollTop ≈ target.
          if (Math.abs(root.scrollTop - target) > 8) return;
          // Cancel the fallback timer — scrollend got there first.
          if (scrollFallbackTimerRef.current !== null) {
            window.clearTimeout(scrollFallbackTimerRef.current);
            scrollFallbackTimerRef.current = null;
          }
          programmaticScrollUntilRef.current = 0;
          // Re-sync currentId from the actual final scroll position. Critical
          // when the user interrupts the smooth scroll mid-flight: without
          // this, outline would stick to the click target until the next
          // scroll event arrives.
          computeRef.current();
        };
        root.addEventListener("scrollend", handleEnd, {
          once: true,
          signal: ctrl.signal,
        });
      }
      // Fallback timer fires regardless of scrollend support. If scrollend
      // beats it, the handler clears it; otherwise this is the only way the
      // lock gets released after a user-interrupted scroll on engines that
      // don't dispatch scrollend.
      scrollFallbackTimerRef.current = window.setTimeout(() => {
        scrollFallbackTimerRef.current = null;
        if (myToken !== scrollTokenRef.current) return;
        programmaticScrollUntilRef.current = 0;
        computeRef.current();
      }, fallbackMs);
      root.scrollTo({ top: target, behavior: "smooth" });
    },
    [scrollContainerRef, findElement],
  );

  // NOTE: do NOT early-return when total < 2. The outer div has to keep
  // rendering so `outerRef` stays bound and the ResizeObserver in the mount
  // effect keeps measuring. Otherwise switching from a 1-message tab to a
  // many-message tab would leave outerHeight stuck at 0 (because the effect
  // ran with a null ref on first mount and never re-runs).
  const showRail = total >= 2;

  // Responsive padding — short panels (split panes / narrow windows) get a
  // smaller inset so the rail isn't crushed; tall panels get the full 80px
  // so tooltips on edge dots have room to breathe.
  const verticalPadding = outerHeight > 0
    ? Math.min(
        RAIL_PADDING_MAX,
        Math.max(RAIL_PADDING_MIN, outerHeight * RAIL_PADDING_RATIO),
      )
    : RAIL_PADDING_MAX;
  const railHeight = Math.max(0, outerHeight - 2 * verticalPadding);

  // Layout maths — fixed-slot minimap, dynamic pitch with an upper cap on
  // short conversations only. The cap *must not* apply once total exceeds
  // WINDOW_SLOTS: long conversations rely on a fixed visibleSlots density
  // (railHeight / WINDOW_SLOTS), and capping there would leave dead rail at
  // the bottom and break the documented "fixed number of slots in window"
  // invariant on tall panels (railHeight ≥ WINDOW_SLOTS × MAX_DOT_PITCH).
  const visibleSlots = Math.min(Math.max(total, 1), WINDOW_SLOTS);
  const naturalPitch = railHeight > 0 ? railHeight / visibleSlots : 0;
  const dotPitch =
    total <= WINDOW_SLOTS ? Math.min(MAX_DOT_PITCH, naturalPitch) : naturalPitch;
  // The active tick is a fixed-size horizontal rule; its vertical position is
  // animated independently of the rail translate by <ActiveThumb>.

  // Auto-centre the active row in the preview list. We compute "centre in
  // viewport" as the ideal scroll target; the browser clamps it to
  // [0, scrollHeight - clientHeight], which means rows near the top/bottom
  // settle naturally against those edges instead of leaving empty space.
  // On initial open we jump instantly; subsequent currentId changes
  // smooth-scroll after thumbDuration so the rail's stage 2 recentre lines up.
  useEffect(() => {
    const wrapper = previewScrollRef.current;
    if (!expanded || !wrapper) {
      prevExpandedRef.current = expanded;
      return undefined;
    }
    const idealCentre =
      currentIndex * PREVIEW_ROW_HEIGHT +
      PREVIEW_ROW_HEIGHT / 2 -
      wrapper.clientHeight / 2;
    const maxScroll = Math.max(0, wrapper.scrollHeight - wrapper.clientHeight);
    const targetScrollTop = Math.max(0, Math.min(maxScroll, idealCentre));
    if (previewAutoScrollTimerRef.current !== null) {
      window.clearTimeout(previewAutoScrollTimerRef.current);
    }
    // True "just opened": expanded transitioned false → true this render.
    // Plain `scrollTop === 0` would also catch "user scrolled to top while
    // open and currentId then changed", which should still smooth-scroll.
    const justOpened = !prevExpandedRef.current && expanded;
    prevExpandedRef.current = expanded;
    if (justOpened) {
      wrapper.scrollTop = targetScrollTop;
      return undefined;
    }
    previewAutoScrollTimerRef.current = window.setTimeout(() => {
      previewAutoScrollTimerRef.current = null;
      wrapper.scrollTo({ top: targetScrollTop, behavior: "smooth" });
    }, thumbDuration);
    return () => {
      if (previewAutoScrollTimerRef.current !== null) {
        window.clearTimeout(previewAutoScrollTimerRef.current);
        previewAutoScrollTimerRef.current = null;
      }
    };
  }, [expanded, currentIndex, thumbDuration]);
  const contentHeight = total * dotPitch;
  const centreTarget = railHeight / 2 - dotPitch / 2;
  const idealOffset = centreTarget - currentIndex * dotPitch;
  const fitsInWindow = railHeight === 0 || contentHeight <= railHeight;
  const minOffset = railHeight - contentHeight;
  // When the conversation fits the rail, vertically centre the cluster so a
  // 2- or 3-message outline doesn't pile ticks at the top with a gaping void
  // below. (The hover preview is its own centred card and no longer shares
  // this offset.)
  const verticalCentreOffset = fitsInWindow
    ? Math.max(0, (railHeight - contentHeight) / 2)
    : 0;
  const translateY = fitsInWindow
    ? verticalCentreOffset
    : Math.max(minOffset, Math.min(0, idealOffset));

  return (
    <div
      ref={outerRef}
      className="absolute top-0 right-0 h-full pointer-events-none flex items-stretch justify-end z-[5]"
      style={{
        paddingTop: verticalPadding,
        paddingBottom: verticalPadding,
        paddingRight: 14,
      }}
      aria-label={t("chat.outline.label")}
    >
      {showRail && (
      <div
        className="relative pointer-events-auto"
        style={{ width: TRACK_WIDTH }}
        onMouseEnter={handleEnter}
        onMouseLeave={handleLeave}
      >
        {/* Clip layer — strictly clips dots above/below the window so the
            rail never shows orphan half-dots beyond its bounds. The hover
            tooltip is rendered separately outside this clip so it can fly
            beyond the rail edges without being trimmed. */}
        <div className="absolute inset-0 overflow-hidden">
          {/* Two-stage motion:
              1. ActiveThumb (independent absolute element) glides to the new
                 dot's position via its own `top` transition (rail static).
              2. Inner list translateY transition fires after a delay equal to
                 stage 1, so the rail slides to recentre the thumb only after
                 the user can clearly see the thumb's positional shift. */}
          <div
            style={{
              position: "absolute",
              inset: 0,
              transform: `translateY(${translateY}px)`,
              // ease-in-out glides; delay matches stage 1 thumb duration.
              transition: `transform ${RAIL_TRANSITION_MS}ms cubic-bezier(0.4, 0, 0.2, 1) ${thumbDuration}ms`,
              willChange: "transform",
            }}
          >
            {dotPitch > 0 && (
              <>
                {userNodes.map((node, i) => (
                  <OutlineNodeSlot
                    key={node.id}
                    node={node}
                    total={total}
                    top={i * dotPitch}
                    slotHeight={dotPitch}
                    isHover={node.id === hoverId}
                    onClick={() => scrollToNode(node.id)}
                    onHoverChange={(h) => setHoverId(h ? node.id : null)}
                  />
                ))}
                <ActiveThumb
                  top={currentIndex * dotPitch + (dotPitch - TICK_HEIGHT) / 2}
                  duration={thumbDuration}
                />
              </>
            )}
          </div>
        </div>
        {/* Hover preview — one rounded card (图2) listing every user message.
            Anchored to the rail's left edge and vertically centred; its height
            hugs the content up to the rail height, after which the card itself
            scrolls. The active row auto-centres via previewScrollRef. The card
            is also the scroll container, so scrollbar-none hides the bar. */}
        <div
          ref={previewScrollRef}
          className="absolute scrollbar-none"
          style={{
            right: TRACK_WIDTH + PREVIEW_GAP,
            top: "50%",
            width: PREVIEW_WIDTH,
            maxHeight: railHeight > 0 ? railHeight : undefined,
            boxSizing: "border-box",
            padding: PREVIEW_CARD_PADDING,
            borderRadius: PREVIEW_CARD_RADIUS,
            background: "var(--color-surface)",
            border: "1px solid var(--color-border)",
            boxShadow: "var(--shadow-popup)",
            overflowY: "auto",
            overflowX: "hidden",
            opacity: expanded ? 1 : 0,
            transform: expanded
              ? "translateY(-50%) translateX(0)"
              : "translateY(-50%) translateX(8px)",
            pointerEvents: expanded ? "auto" : "none",
            transition: `opacity ${BLOOM_DURATION_MS}ms cubic-bezier(0.4, 0, 0.2, 1), transform ${BLOOM_DURATION_MS}ms cubic-bezier(0.4, 0, 0.2, 1)`,
          }}
        >
          {userNodes.map((node, i) => (
            <PreviewRow
              key={node.id}
              node={node}
              isCurrent={node.id === currentId}
              isHover={node.id === hoverId}
              expanded={expanded}
              stagger={i}
              onClick={() => scrollToNode(node.id)}
              onHoverChange={(h) => setHoverId(h ? node.id : null)}
            />
          ))}
        </div>
      </div>
      )}
    </div>
  );
});

interface OutlineNodeSlotProps {
  readonly node: OutlineNode;
  readonly total: number;
  readonly top: number;
  readonly slotHeight: number;
  readonly isHover: boolean;
  readonly onClick: () => void;
  readonly onHoverChange: (hovered: boolean) => void;
}

const OutlineNodeSlot = memo(function OutlineNodeSlot({
  node,
  total,
  top,
  slotHeight,
  isHover,
  onClick,
  onHoverChange,
}: OutlineNodeSlotProps) {
  const { t } = useTranslation();
  // Each slot renders one horizontal tick (default / hover). The active tick
  // is drawn separately by <ActiveThumb> so it can animate its position
  // independently of the rail translate.
  const tickWidth = isHover ? TICK_WIDTH_HOVER : TICK_WIDTH_DEFAULT;
  const tickFill = isHover
    ? "var(--color-muted-foreground)"
    : "var(--color-border-strong)";

  return (
    <button
      type="button"
      onClick={onClick}
      onMouseEnter={() => onHoverChange(true)}
      onMouseLeave={() => onHoverChange(false)}
      className="absolute left-0 right-0 flex items-center justify-center cursor-pointer bg-transparent border-0 p-0 outline-none"
      style={{ top, height: slotHeight }}
      aria-label={t("chat.outline.jumpTo", {
        index: node.index,
        total,
        preview: node.preview,
      })}
    >
      <span
        aria-hidden="true"
        style={{
          width: tickWidth,
          height: TICK_HEIGHT,
          background: tickFill,
          borderRadius: 999,
          transition:
            "width 180ms cubic-bezier(0.16, 1, 0.3, 1), background-color 180ms ease",
        }}
      />
    </button>
  );
});

interface ActiveThumbProps {
  readonly top: number;
  readonly duration: number;
}

function ActiveThumb({ top, duration }: ActiveThumbProps) {
  return (
    <div
      aria-hidden="true"
      className="absolute left-0 right-0 flex items-center justify-center pointer-events-none"
      style={{
        top: 0,
        height: TICK_HEIGHT,
        // ease-in-out: the tick accelerates, cruises, decelerates — the user
        // can clearly track the slide. Duration scales with slot distance.
        transform: `translateY(${top}px)`,
        transition: `transform ${duration}ms cubic-bezier(0.4, 0, 0.2, 1)`,
        willChange: "transform",
      }}
    >
      <span
        style={{
          width: TICK_WIDTH_ACTIVE,
          height: TICK_HEIGHT,
          background: "var(--color-foreground)",
          borderRadius: 999,
          boxShadow:
            "0 0 6px color-mix(in srgb, var(--color-foreground) 45%, transparent)",
        }}
      />
    </div>
  );
}

interface PreviewRowProps {
  readonly node: OutlineNode;
  readonly isCurrent: boolean;
  readonly isHover: boolean;
  readonly expanded: boolean;
  readonly stagger: number;
  readonly onClick: () => void;
  readonly onHoverChange: (hovered: boolean) => void;
}

const PreviewRow = memo(function PreviewRow({
  node,
  isCurrent,
  isHover,
  expanded,
  stagger,
  onClick,
  onHoverChange,
}: PreviewRowProps) {
  // One row inside the preview card (图2). The selected / hovered row gets a
  // faint neutral fill; every other row is plain text on the card background.
  // Text colour brightens from muted to foreground as the row becomes the
  // current message or is hovered.
  const color =
    isCurrent || isHover
      ? "var(--color-foreground)"
      : "var(--color-muted-foreground)";
  const background = isCurrent
    ? "color-mix(in srgb, var(--color-foreground) 10%, transparent)"
    : isHover
      ? "color-mix(in srgb, var(--color-foreground) 6%, transparent)"
      : "transparent";
  const fontWeight = isCurrent ? 600 : 500;
  // Stagger by row index so rows fan in sequentially when the card blooms —
  // capped so jumping to a row deep in a long conversation doesn't introduce
  // multi-second delays.
  const delay = expanded
    ? Math.min(stagger * PREVIEW_STAGGER_MS, PREVIEW_STAGGER_MAX_MS)
    : 0;
  return (
    <button
      type="button"
      onClick={onClick}
      onMouseEnter={() => onHoverChange(true)}
      onMouseLeave={() => onHoverChange(false)}
      className="w-full flex items-center cursor-pointer bg-transparent border-0 outline-none text-left"
      style={{
        height: PREVIEW_ROW_HEIGHT,
        padding: "0 12px",
        borderRadius: 10,
        background,
        transform: expanded ? "translateX(0)" : "translateX(6px)",
        opacity: expanded ? 1 : 0,
        transition: `transform ${BLOOM_DURATION_MS}ms cubic-bezier(0.4, 0, 0.2, 1) ${delay}ms, opacity ${BLOOM_DURATION_MS}ms cubic-bezier(0.4, 0, 0.2, 1) ${delay}ms, background-color 160ms ease, color 160ms ease`,
      }}
    >
      <span
        style={{
          width: "100%",
          whiteSpace: "nowrap",
          overflow: "hidden",
          textOverflow: "ellipsis",
          color,
          fontFamily: "var(--font-sans)",
          fontSize: 13,
          fontWeight,
          lineHeight: 1.3,
          letterSpacing: 0.1,
        }}
      >
        {node.preview}
      </span>
    </button>
  );
});
