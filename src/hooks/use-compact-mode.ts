import { useEffect, useState } from "react";

/**
 * Monitor an element's width via ResizeObserver and return whether it is
 * below a given breakpoint. Includes 20 px hysteresis to avoid flicker near
 * the threshold.
 *
 * Accepts the element itself (rather than a RefObject) so consumers can
 * capture it via a callback ref and trigger a fresh observation whenever
 * conditional rendering swaps the underlying DOM node.
 */
export function useCompactMode(
  target: HTMLElement | null,
  breakpoint = 450,
): boolean {
  const [compact, setCompact] = useState(false);

  useEffect(() => {
    if (!target) return;

    const HYSTERESIS = 20;

    const ro = new ResizeObserver(([entry]) => {
      const w = entry.contentRect.width;
      setCompact((prev) => {
        if (prev && w > breakpoint + HYSTERESIS) return false;
        if (!prev && w < breakpoint) return true;
        return prev;
      });
    });

    ro.observe(target);
    return () => ro.disconnect();
  }, [target, breakpoint]);

  return compact;
}
