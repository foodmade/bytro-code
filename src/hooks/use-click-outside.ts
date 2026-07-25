import { useEffect, type RefObject } from "react";

type ClickOutsideRef = RefObject<HTMLElement | null>;

/**
 * Calls `handler` when a mousedown event occurs outside the element
 * referenced by `ref`. The listener is only active when `enabled` is true.
 */
export function useClickOutside(
  ref: ClickOutsideRef | ReadonlyArray<ClickOutsideRef>,
  handler: () => void,
  enabled: boolean = true,
): void {
  useEffect(() => {
    if (!enabled) return;

    const refs = Array.isArray(ref) ? ref : [ref];

    const handleMouseDown = (e: MouseEvent) => {
      const target = e.target as Node;
      const clickedInside = refs.some((entry) => entry.current?.contains(target));
      if (!clickedInside) {
        handler();
      }
    };

    document.addEventListener("mousedown", handleMouseDown);
    return () => document.removeEventListener("mousedown", handleMouseDown);
  }, [ref, handler, enabled]);
}
