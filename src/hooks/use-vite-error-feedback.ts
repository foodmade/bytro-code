import { useCallback, useEffect, useRef } from "react";
import { useStreamStateStore } from "@/stores";
import { usePreviewStore } from "@/stores/preview-store";

/**
 * Auto-feeds Vite compilation errors back to the AI after it finishes a
 * code-generation turn, creating a self-healing loop:
 *
 *   AI writes code → Vite compiles → errors → this hook → AI fixes → repeat
 *
 * Timing: waits for HMR to settle (5 s after streaming ends), then checks
 * errors. Deduplicates by error signature and retries up to 3 times per
 * unique error before stopping.
 */

const HMR_SETTLE_DELAY_MS = 5_000;
const MAX_RETRIES_PER_SIGNATURE = 3;

type HandleSendFn = (
  content: string,
  images?: undefined,
  displayContent?: string,
) => Promise<boolean | void>;

export function useViteErrorFeedback(handleSend: HandleSendFn) {
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** Whether the last performErrorFeedback cycle found and sent errors. */
  const hadErrorsRef = useRef(false);
  const trackerRef = useRef({
    retryCounts: new Map<string, number>(),
    sentSignatures: new Set<string>(),
  });
  const clearingErrorsForFeedbackRef = useRef(false);
  // Stable ref so the subscribe callback always sees the latest handleSend
  const handleSendRef = useRef(handleSend);
  handleSendRef.current = handleSend;

  const cancelTimer = useCallback(() => {
    if (timerRef.current !== null) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  const scheduleErrorCheck = useCallback(() => {
    cancelTimer();
    timerRef.current = setTimeout(() => {
      timerRef.current = null;
      performErrorFeedback();
    }, HMR_SETTLE_DELAY_MS);
  }, [cancelTimer]);

  // ── Subscribe to streaming state transitions ──
  useEffect(() => {
    const unsub = useStreamStateStore.subscribe((state, prev) => {
      // Streaming started → cancel any pending feedback timer
      if (state.isStreaming && !prev.isStreaming) {
        cancelTimer();
        return;
      }

      // Streaming ended → schedule error check after HMR settles
      if (!state.isStreaming && prev.isStreaming) {
        scheduleErrorCheck();
      }
    });

    return () => {
      unsub();
      cancelTimer();
    };
  }, [cancelTimer, scheduleErrorCheck]);

  // ── Reset tracker when all errors are resolved ──
  useEffect(() => {
    const unsub = usePreviewStore.subscribe((state, prev) => {
      if (state.viteErrors.length === 0 && prev.viteErrors.length > 0) {
        if (clearingErrorsForFeedbackRef.current) {
          clearingErrorsForFeedbackRef.current = false;
          trackerRef.current.sentSignatures = new Set();
          return;
        }
        trackerRef.current = {
          retryCounts: new Map(),
          sentSignatures: new Set(),
        };
      }
    });
    return unsub;
  }, []);

  function performErrorFeedback() {
    const { viteErrors, devServerStatus } = usePreviewStore.getState();
    const { isStreaming } = useStreamStateStore.getState();

    // Guard: only act when dev server is running and AI is idle
    if (devServerStatus !== "running") return;
    if (isStreaming) return;
    if (viteErrors.length === 0) {
      // If the previous cycle had errors and now there are none,
      // the AI successfully fixed them — request an iframe refresh.
      if (hadErrorsRef.current) {
        hadErrorsRef.current = false;
        usePreviewStore.getState().requestPreviewRefresh();
      }
      return;
    }

    const tracker = trackerRef.current;

    // Deduplicate by signature and respect retry limits
    const eligibleErrors: Array<{ signature: string; raw: string }> = [];
    const seen = new Set<string>();

    for (const err of viteErrors) {
      const sig = extractErrorSignature(err);
      if (seen.has(sig)) continue;
      seen.add(sig);

      const retries = tracker.retryCounts.get(sig) ?? 0;
      if (retries >= MAX_RETRIES_PER_SIGNATURE) continue;
      if (tracker.sentSignatures.has(sig)) continue;

      eligibleErrors.push({ signature: sig, raw: err });
    }

    if (eligibleErrors.length === 0) return;

    // Update tracking state
    for (const { signature } of eligibleErrors) {
      tracker.sentSignatures.add(signature);
      tracker.retryCounts.set(
        signature,
        (tracker.retryCounts.get(signature) ?? 0) + 1,
      );
    }

    const content = formatErrorFeedback(
      eligibleErrors.map((e) => e.raw),
    );
    const displayContent = `[auto-detected] Fix ${eligibleErrors.length} compilation error${eligibleErrors.length > 1 ? "s" : ""}`;

    // Clear stored errors before sending to prevent re-trigger on same set
    clearingErrorsForFeedbackRef.current = true;
    usePreviewStore.getState().clearViteErrors();

    hadErrorsRef.current = true;

    handleSendRef.current(content, undefined, displayContent);
  }
}

// ── Pure helpers ──

/**
 * Extract a dedup key from a Vite error string.
 *
 * Examples:
 *   "SyntaxError: /src/App.tsx: Unexpected token (15:23)"  → "syntaxerror:/src/App.tsx:15"
 *   "[plugin:vite:react-babel] /src/Hero.tsx: Missing semicolon. (42:0)" → "plugin:/src/Hero.tsx:42"
 *   "Module not found: Can't resolve './Foo'" → "modulenotfound:./Foo:"
 */
function extractErrorSignature(error: string): string {
  const lower = error.toLowerCase();

  // 1. Error type
  const typeMatch = lower.match(
    /(?:\[.*?\]\s*)?(\w*error)\b|module not found|cannot find module/,
  );
  const errorType = typeMatch
    ? (typeMatch[1] ?? typeMatch[0]).replace(/\s+/g, "")
    : "unknown";

  // 2. File path — greedy match for path-like segments
  const pathMatch = error.match(
    /(?:[A-Z]:)?(?:\/[\w@.-]+)+\.(?:tsx?|jsx?|css|scss|vue|svelte|json)/i,
  );
  const filePath = pathMatch?.[0] ?? "";

  // 3. Line number — formats: (15:23), :15:23, line 15
  const lineMatch = error.match(/\((\d+)[,:]\d+\)|:(\d+):\d+/);
  const lineNum = lineMatch?.[1] ?? lineMatch?.[2] ?? "";

  return `${errorType}:${filePath}:${lineNum}`;
}

function formatErrorFeedback(errors: ReadonlyArray<string>): string {
  const unique = [...new Set(errors)];
  const errorBlock = unique
    .map((e, i) => `Error ${i + 1}:\n\`\`\`\n${e}\n\`\`\``)
    .join("\n\n");

  return [
    "[Vite Compilation Errors — Auto-detected]",
    "",
    "The following compilation errors were detected after your last code changes.",
    "Please fix them immediately:",
    "",
    errorBlock,
    "",
    "Fix these errors while preserving existing functionality.",
    "Follow the @apply CSS rules: never use @apply with custom color classes inside @layer blocks — use raw CSS instead.",
  ].join("\n");
}
