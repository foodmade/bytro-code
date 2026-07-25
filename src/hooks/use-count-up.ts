import { useEffect, useRef, useState } from "react";

/**
 * Animates a number from 0 to `target` using requestAnimationFrame with
 * an ease-out-cubic curve. When `active` is false, the value snaps directly
 * to `target` (no animation).
 *
 * `replayKey` is optional: pass a value that changes every time the caller
 * wants to force a fresh replay even if `active` itself stays `true` across
 * two consecutive triggers (e.g. React 18 batching collapsed an intervening
 * false back to true — see useEntryAnimation). Defaults to 0, in which case
 * only `active` toggling drives replays, matching the original behavior.
 */
export function useCountUp(
  target: number,
  active: boolean,
  delay = 0,
  duration = 800,
  replayKey: number | string = 0,
): number {
  const [value, setValue] = useState(active ? 0 : target);
  const rafRef = useRef(0);
  const timeoutRef = useRef<ReturnType<typeof setTimeout>>(undefined);

  useEffect(() => {
    if (!active) {
      setValue(target);
      return;
    }

    setValue(0);
    timeoutRef.current = setTimeout(() => {
      const startTime = performance.now();
      function step(now: number) {
        const elapsed = now - startTime;
        const progress = Math.min(elapsed / duration, 1);
        const eased = 1 - Math.pow(1 - progress, 3);
        setValue(Math.round(target * eased));
        if (progress < 1) {
          rafRef.current = requestAnimationFrame(step);
        }
      }
      rafRef.current = requestAnimationFrame(step);
    }, delay);

    return () => {
      clearTimeout(timeoutRef.current);
      cancelAnimationFrame(rafRef.current);
    };
  }, [target, active, delay, duration, replayKey]);

  return value;
}
