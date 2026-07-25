import { createContext, useContext, useEffect, useRef, useState } from "react";
import { useReducedMotion } from "motion/react";

/**
 * Increments once per "entry" into the workspace view: on first mount and
 * whenever the active workspace changes. Consumers use this to replay their
 * entrance animations without re-triggering on silent data refreshes.
 */
const WorkspaceEntryContext = createContext<number>(0);

export const WorkspaceEntryProvider = WorkspaceEntryContext.Provider;

export function useWorkspaceEntryToken(): number {
  return useContext(WorkspaceEntryContext);
}

/**
 * Returns a monotonically-increasing "play key": it increments exactly once
 * per entry-token cycle, the first time `ready` becomes true. 0 means "never
 * played" (treat as not-playing); any other value means "play, and remount
 * via this key so motion's mount-only `initial` actually applies."
 *
 * A plain boolean doesn't work here: React 18 batches the reset-then-set
 * inside the effect below into a single render, so back-to-back entries that
 * both resolve `ready` synchronously (e.g. cached data) would go true→true
 * with no observable edge — no remount, no replay. A strictly-increasing
 * counter can't collapse like that, since each play is a genuinely new value.
 *
 * Also survives `ready` arriving asynchronously after the token has already
 * changed (e.g. data still loading when entering).
 * Never increments when the user prefers reduced motion.
 */
export function useEntryAnimation(ready: boolean): number {
  const entryToken = useWorkspaceEntryToken();
  const prefersReducedMotion = useReducedMotion();
  const [playKey, setPlayKey] = useState(0);
  const lastEntryTokenRef = useRef<number | null>(null);
  const hasPlayedRef = useRef(false);

  useEffect(() => {
    if (entryToken !== lastEntryTokenRef.current) {
      lastEntryTokenRef.current = entryToken;
      hasPlayedRef.current = false;
    }
    if (prefersReducedMotion || hasPlayedRef.current || !ready) return;
    hasPlayedRef.current = true;
    setPlayKey((k) => k + 1);
  }, [entryToken, ready, prefersReducedMotion]);

  return playKey;
}
