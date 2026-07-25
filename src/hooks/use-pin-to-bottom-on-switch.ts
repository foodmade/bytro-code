import { useLayoutEffect, type RefObject } from "react";
import { getBottomScrollTop } from "./use-auto-scroll";

/**
 * Pins the scroll container to the bottom whenever `switchKey` changes
 * (conversation / tab switch). Independent of the streaming sticky-scroll
 * state machine in `useAutoScroll`.
 *
 * Why ResizeObserver instead of a raf loop:
 * - Content height settles in stages on a fresh switch: snapshot messages
 *   appear synchronously, async `loadMessages` arrives later, and code
 *   blocks / markdown / images push height upward in even more frames.
 * - A raf loop that stops on "scrollHeight stable" can fire its stability
 *   check during an idle gap between these stages and terminate early —
 *   leaving scrollTop pinned to an intermediate (smaller) scrollHeight,
 *   which visually looks like "stuck at top".
 * - This failure is much more common on Windows (WebView2) than macOS
 *   (WKWebKit), because WebView2's layout happens later relative to the
 *   layout effect.
 * - ResizeObserver fires on real height changes only, regardless of how
 *   long the async gaps are — no over-eager termination.
 *
 * Why this does NOT fight user scroll-up:
 * - User-initiated wheel / touch events immediately stop the observer,
 *   so any scroll-up after the switch is respected.
 * - A safety timeout caps the pin window at 1s.
 */
const PIN_TIMEOUT_MS = 1000;

export function usePinToBottomOnSwitch(
  scrollRef: RefObject<HTMLDivElement | null>,
  switchKey: string,
  scrollElement?: HTMLDivElement | null,
): void {
  useLayoutEffect(() => {
    const el = scrollElement ?? scrollRef.current;
    if (!el) return;

    // Synchronous first pin in the layout phase — covers the sync snapshot path
    // and ensures no visible flash at the top before the observer fires.
    el.scrollTop = getBottomScrollTop(el);

    let active = true;
    const stop = () => {
      if (!active) return;
      active = false;
      observer?.disconnect();
      el.removeEventListener("wheel", stop);
      el.removeEventListener("touchstart", stop);
      window.clearTimeout(timeoutId);
    };

    // Observing the inner content div catches every height change
    // (snapshot fill, async loadMessages, code/markdown/image layout).
    const inner = el.firstElementChild;
    let observer: ResizeObserver | null = null;
    if (inner) {
      observer = new ResizeObserver(() => {
        if (!active) return;
        const node = scrollRef.current;
        if (node) node.scrollTop = getBottomScrollTop(node);
      });
      observer.observe(inner);
    }

    el.addEventListener("wheel", stop, { passive: true });
    el.addEventListener("touchstart", stop, { passive: true });
    const timeoutId = window.setTimeout(stop, PIN_TIMEOUT_MS);

    return stop;
  }, [switchKey, scrollRef, scrollElement]);
}
