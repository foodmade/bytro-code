export interface SmoothTextStepInput {
  readonly currentLength: number;
  readonly targetLength: number;
  readonly elapsedMs: number;
  readonly finalizing?: boolean;
}

export interface SmoothTextFrameInput {
  readonly remaining: number;
  readonly finalizing?: boolean;
}

/**
 * Minimum time between visible text updates.
 *
 * Streaming markdown is comparatively expensive because every visible update
 * can re-run markdown parsing for the live tail. Large backlogs still update
 * at frame-rate to catch up, while short tails update in calmer chunks that
 * read closer to Cursor/Codex Desktop and avoid unnecessary re-renders.
 */
export function smoothTextRevealIntervalMs({
  remaining,
  finalizing = false,
}: SmoothTextFrameInput): number {
  if (finalizing || remaining > 1200) return 16;
  if (remaining > 480) return 20;
  if (remaining > 160) return 24;
  return 30;
}

/**
 * Computes the next visible text length for streaming assistant output.
 *
 * Short gaps advance one or two characters per animation frame for a calm
 * typewriter feel. Large backlogs accelerate so fast model streams do not make
 * the UI lag far behind the real response.
 */
export function nextSmoothTextLength({
  currentLength,
  targetLength,
  elapsedMs,
  finalizing = false,
}: SmoothTextStepInput): number {
  if (targetLength <= currentLength) return targetLength;

  const remaining = targetLength - currentLength;
  const clampedElapsed = Math.min(64, Math.max(8, elapsedMs));
  const baseCharsPerSecond = finalizing ? 120 : 64;
  const adaptiveCap = finalizing ? 720 : 520;
  const adaptiveCharsPerSecond = Math.min(
    adaptiveCap,
    remaining * (finalizing ? 5 : 3),
  );
  const rawStep = Math.max(
    1,
    Math.floor(((baseCharsPerSecond + adaptiveCharsPerSecond) * clampedElapsed) / 1000),
  );
  const maxStep =
    remaining > 1200 ? 72 :
    remaining > 480 ? 40 :
    remaining > 160 ? 24 :
    remaining > 64 ? 12 :
    remaining > 24 ? 5 :
    2;

  return currentLength + Math.min(remaining, rawStep, maxStep);
}
