import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";

/**
 * Threshold (px) for considering the user "at bottom".
 * Must be >= the scroll container's bottom padding (120px) so that
 * the button hides once the last message is visible, even with
 * decorative padding remaining below.  Also used as the threshold
 * for re-enabling sticky auto-scroll.
 */
const AT_BOTTOM_THRESHOLD = 150;
const USER_SCROLL_UP_TOLERANCE = 5;
const DEFAULT_CONTENT_MOTION_FOLLOW_MS = 260;
const MAX_CONTENT_MOTION_FOLLOW_MS = 1000;

export const CHAT_SCROLL_CONTENT_MOTION_EVENT = "bytro:chat-content-motion";

interface ChatScrollContentMotionDetail {
  readonly durationMs?: number;
}

export function getBottomScrollTop(el: Pick<HTMLDivElement, "scrollHeight" | "clientHeight">): number {
  return Math.max(0, el.scrollHeight - el.clientHeight);
}

function syncScrollToBottom(el: HTMLDivElement): number {
  el.scrollTop = getBottomScrollTop(el);
  return el.scrollTop;
}

export function getBottomGap(el: Pick<HTMLDivElement, "scrollHeight" | "scrollTop" | "clientHeight">): number {
  return el.scrollHeight - el.scrollTop - el.clientHeight;
}

export function isNearBottom(
  el: Pick<HTMLDivElement, "scrollHeight" | "scrollTop" | "clientHeight">,
  threshold = AT_BOTTOM_THRESHOLD,
): boolean {
  return getBottomGap(el) < threshold;
}

export function clampContentMotionFollowDuration(durationMs: number): number {
  if (!Number.isFinite(durationMs)) return DEFAULT_CONTENT_MOTION_FOLLOW_MS;
  return Math.min(Math.max(durationMs, 0), MAX_CONTENT_MOTION_FOLLOW_MS);
}

/** Sticky scroll detection - auto-scroll unless user scrolled up.
 *  When `paused` is true, auto-scroll is suppressed (e.g. while loading
 *  older messages to avoid fighting with scroll position restoration).
 *
 *  Detection strategy: we detect user scroll-up by comparing the current
 *  scrollTop (at the moment the auto-scroll effect fires) with the position
 *  we last auto-scrolled to.  If scrollTop has *decreased*, the user must
 *  have scrolled upward — so we disable auto-scroll.  This avoids any
 *  dependency on wheel / touch / pointer events (which are unreliable in
 *  Tauri WebView). */
export function useAutoScroll(dep: unknown, paused = false, resetKey?: unknown) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [scrollElement, setScrollElement] = useState<HTMLDivElement | null>(null);
  const isSticky = useRef(true);
  const [isAtBottom, setIsAtBottom] = useState(true);
  const contentMotionFrame = useRef(0);
  const contentMotionFollowUntil = useRef(0);

  // The scrollTop we last set via programmatic auto-scroll.
  const lastAutoScrolledTo = useRef(-1);

  // Guard flag: while scrollToBottom() smooth-scrolls, prevent intermediate
  // scroll events from flipping isAtBottom back to false.
  const smoothScrolling = useRef(false);
  const setAtBottom = useCallback((next: boolean) => {
    setIsAtBottom((current) => current === next ? current : next);
  }, []);

  const setScrollRef = useCallback((node: HTMLDivElement | null) => {
    scrollRef.current = node;
    setScrollElement(node);
  }, []);

  const stopContentMotionFollow = useCallback(() => {
    if (contentMotionFrame.current) {
      cancelAnimationFrame(contentMotionFrame.current);
      contentMotionFrame.current = 0;
    }
    contentMotionFollowUntil.current = 0;
  }, []);

  // Reset sticky state when the conversation changes (resetKey).
  // Scrolling to the bottom is handled directly in the consumer (chat-panel.tsx)
  // via a ref callback on the remounting <div>; this hook only resets sticky
  // bookkeeping so streaming auto-scroll resumes correctly in the new context.
  const prevResetKey = useRef(resetKey);
  useLayoutEffect(() => {
    if (prevResetKey.current === resetKey) return;
    prevResetKey.current = resetKey;
    isSticky.current = true;
    lastAutoScrolledTo.current = -1;
    smoothScrolling.current = false;
    stopContentMotionFollow();
    setAtBottom(true);
  }, [resetKey, setAtBottom, stopContentMotionFollow]);

  // ── scroll event handler ─────────────────────────────────────────────
  // Used to update `isAtBottom` (for the floating button) and to
  // re-enable auto-scroll when the user scrolls back to the bottom.
  useEffect(() => {
    const el = scrollElement;
    if (!el) return;

    const handleScroll = () => {
      const atBottom = isNearBottom(el);

      // Re-enable sticky when user scrolls close enough to bottom.
      if (!isSticky.current && atBottom) {
        isSticky.current = true;
        lastAutoScrolledTo.current = -1;
      }

      // During programmatic smooth-scroll (scrollToBottom), keep
      // isAtBottom=true until the animation arrives at the bottom.
      if (smoothScrolling.current) {
        if (getBottomGap(el) < USER_SCROLL_UP_TOLERANCE) {
          smoothScrolling.current = false;
        }
        return;
      }

      if (
        lastAutoScrolledTo.current >= 0 &&
        el.scrollTop < lastAutoScrolledTo.current - USER_SCROLL_UP_TOLERANCE &&
        !atBottom
      ) {
        isSticky.current = false;
        lastAutoScrolledTo.current = -1;
        setAtBottom(false);
        return;
      }

      setAtBottom(atBottom);
    };

    handleScroll();
    el.addEventListener("scroll", handleScroll, { passive: true });
    return () => el.removeEventListener("scroll", handleScroll);
  }, [scrollElement, setAtBottom]);

  // Tool cards and other animated content can change height every frame while
  // the message array stays unchanged. The ResizeObserver catches most height
  // updates, but this explicit motion signal keeps bottom-pinned chats locked
  // during CSS transitions without fighting the user after they scroll up.
  useEffect(() => {
    const el = scrollElement;
    if (!el || typeof requestAnimationFrame === "undefined") return;

    const getNow = () => (
      typeof performance !== "undefined" && typeof performance.now === "function"
        ? performance.now()
        : Date.now()
    );

    const followIfSticky = () => {
      contentMotionFrame.current = 0;
      if (paused || !el.isConnected) return;

      const atBottom = isNearBottom(el);
      if (atBottom) {
        isSticky.current = true;
        setAtBottom(true);
      }

      if (
        lastAutoScrolledTo.current >= 0 &&
        el.scrollTop < lastAutoScrolledTo.current - USER_SCROLL_UP_TOLERANCE &&
        !atBottom
      ) {
        isSticky.current = false;
        smoothScrolling.current = false;
        lastAutoScrolledTo.current = -1;
        contentMotionFollowUntil.current = 0;
        setAtBottom(false);
        return;
      }

      if (!isSticky.current) return;

      lastAutoScrolledTo.current = syncScrollToBottom(el);
      smoothScrolling.current = false;

      if (getNow() < contentMotionFollowUntil.current) {
        contentMotionFrame.current = requestAnimationFrame(followIfSticky);
      }
    };

    const handleContentMotion = (event: Event) => {
      if (paused || !isSticky.current) return;
      const customEvent = event as CustomEvent<ChatScrollContentMotionDetail>;
      const requestedDuration = typeof customEvent.detail?.durationMs === "number"
        ? customEvent.detail.durationMs
        : DEFAULT_CONTENT_MOTION_FOLLOW_MS;
      const durationMs = clampContentMotionFollowDuration(requestedDuration);
      contentMotionFollowUntil.current = Math.max(
        contentMotionFollowUntil.current,
        getNow() + durationMs,
      );
      if (!contentMotionFrame.current) {
        contentMotionFrame.current = requestAnimationFrame(followIfSticky);
      }
    };

    el.addEventListener(CHAT_SCROLL_CONTENT_MOTION_EVENT, handleContentMotion);
    return () => {
      el.removeEventListener(CHAT_SCROLL_CONTENT_MOTION_EVENT, handleContentMotion);
      stopContentMotionFollow();
    };
  }, [paused, scrollElement, setAtBottom, stopContentMotionFollow]);

  // Internal typewriter/reveal animations update message height without
  // changing the `messages` array. Observe the message column so sticky scroll
  // still follows the bottom while text is being revealed.
  useEffect(() => {
    const el = scrollElement;
    if (!el || typeof ResizeObserver === "undefined") return;

    let frameId = 0;
    const syncIfSticky = () => {
      frameId = 0;
      if (paused) return;

      const atBottom = isNearBottom(el);
      if (atBottom) {
        isSticky.current = true;
        setAtBottom(true);
      }

      if (
        lastAutoScrolledTo.current >= 0 &&
        el.scrollTop < lastAutoScrolledTo.current - USER_SCROLL_UP_TOLERANCE &&
        !atBottom
      ) {
        isSticky.current = false;
        smoothScrolling.current = false;
        setAtBottom(false);
        lastAutoScrolledTo.current = -1;
        return;
      }

      if (isSticky.current) {
        lastAutoScrolledTo.current = syncScrollToBottom(el);
        smoothScrolling.current = false;
      }
    };

    const observer = new ResizeObserver(() => {
      if (frameId) cancelAnimationFrame(frameId);
      frameId = requestAnimationFrame(syncIfSticky);
    });
    let observedTarget: Element | null = null;
    const observeCurrentMessageColumn = () => {
      const nextTarget = el.firstElementChild ?? el;
      if (nextTarget === observedTarget) return;
      if (observedTarget) {
        observer.unobserve(observedTarget);
      }
      observedTarget = nextTarget;
      observer.observe(observedTarget);
    };
    const mutationObserver = typeof MutationObserver === "undefined"
      ? null
      : new MutationObserver(observeCurrentMessageColumn);

    observeCurrentMessageColumn();
    mutationObserver?.observe(el, { childList: true });
    return () => {
      if (frameId) cancelAnimationFrame(frameId);
      mutationObserver?.disconnect();
      observer.disconnect();
    };
  }, [paused, scrollElement, setAtBottom]);

  // ── auto-scroll effect ───────────────────────────────────────────────
  // Fires whenever `dep` (messages) or `paused` changes.
  // useLayoutEffect ensures the scroll position is set before the browser
  // paints, preventing a visible flash of messages at the wrong position
  // when switching between conversations (especially streaming ones).
  useLayoutEffect(() => {
    const el = scrollElement ?? scrollRef.current;
    if (paused || !el) return;

    const atBottom = isNearBottom(el);

    if (atBottom) {
      isSticky.current = true;
      lastAutoScrolledTo.current = -1;
      setAtBottom(true);
    }

    if (isSticky.current) {
      // Before scrolling, check whether the user has scrolled up since
      // our last programmatic scroll.  If scrollTop decreased, the user
      // is browsing history — stop auto-scrolling immediately.
      if (
        lastAutoScrolledTo.current >= 0 &&
        el.scrollTop < lastAutoScrolledTo.current - USER_SCROLL_UP_TOLERANCE &&
        !atBottom
      ) {
        isSticky.current = false;
        smoothScrolling.current = false;
        setAtBottom(false);
        lastAutoScrolledTo.current = -1;
        return;
      }

      lastAutoScrolledTo.current = syncScrollToBottom(el);
      smoothScrolling.current = false;
    }
  }, [dep, paused, scrollElement, setAtBottom]);

  const scrollToBottom = useCallback(() => {
    if (scrollRef.current) {
      isSticky.current = true;
      setAtBottom(true);
      lastAutoScrolledTo.current = -1;
      smoothScrolling.current = true;
      stopContentMotionFollow();
      scrollRef.current.scrollTo({
        top: getBottomScrollTop(scrollRef.current),
        behavior: "smooth",
      });
    }
  }, [setAtBottom, stopContentMotionFollow]);

  return { scrollRef, setScrollRef, scrollElement, isAtBottom, scrollToBottom };
}
