import { useCallback, useEffect, useRef, useState } from "react";
import {
  nextSmoothTextLength,
  smoothTextRevealIntervalMs,
} from "./stream-text-smoothing";

function readPrefersReducedMotion(): boolean {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
    return false;
  }
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

function usePrefersReducedMotion(): boolean {
  const [prefersReducedMotion, setPrefersReducedMotion] = useState(readPrefersReducedMotion);

  useEffect(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
      return;
    }

    const query = window.matchMedia("(prefers-reduced-motion: reduce)");
    const handleChange = () => setPrefersReducedMotion(query.matches);
    handleChange();
    query.addEventListener("change", handleChange);
    return () => query.removeEventListener("change", handleChange);
  }, []);

  return prefersReducedMotion;
}

export interface SmoothStreamTextState {
  readonly text: string;
  readonly isAnimating: boolean;
}

export function useSmoothStreamText(
  content: string,
  isStreaming: boolean,
): SmoothStreamTextState {
  const initialText = content;
  const [displayedText, setDisplayedText] = useState(initialText);
  const [isAnimating, setIsAnimating] = useState(false);
  const prefersReducedMotion = usePrefersReducedMotion();

  const targetRef = useRef(content);
  const displayedRef = useRef(initialText);
  const isStreamingRef = useRef(isStreaming);
  const wasStreamingRef = useRef(isStreaming);
  const animationFrameRef = useRef<number | null>(null);
  const lastFrameTimeRef = useRef(0);

  const cancelAnimation = useCallback(() => {
    if (animationFrameRef.current !== null) {
      cancelAnimationFrame(animationFrameRef.current);
      animationFrameRef.current = null;
    }
    lastFrameTimeRef.current = 0;
  }, []);

  const startAnimation = useCallback(() => {
    if (animationFrameRef.current !== null) return;
    setIsAnimating(true);

    const tick = (timestamp: number) => {
      const target = targetRef.current;
      const current = displayedRef.current;

      if (current.length >= target.length) {
        displayedRef.current = target;
        setDisplayedText(target);
        cancelAnimation();
        setIsAnimating(false);
        return;
      }

      const remaining = target.length - current.length;
      const finalizing = !isStreamingRef.current;
      const frameInterval = smoothTextRevealIntervalMs({ remaining, finalizing });
      const previousFrame = lastFrameTimeRef.current || timestamp - frameInterval;
      const elapsedMs = timestamp - previousFrame;
      if (elapsedMs < frameInterval) {
        animationFrameRef.current = requestAnimationFrame(tick);
        return;
      }

      const nextLength = nextSmoothTextLength({
        currentLength: current.length,
        targetLength: target.length,
        elapsedMs,
        finalizing,
      });
      lastFrameTimeRef.current = timestamp;

      const nextText = target.slice(0, nextLength);
      displayedRef.current = nextText;
      setDisplayedText(nextText);

      if (nextLength >= target.length) {
        cancelAnimation();
        setIsAnimating(false);
        return;
      }

      animationFrameRef.current = requestAnimationFrame(tick);
    };

    animationFrameRef.current = requestAnimationFrame(tick);
  }, [cancelAnimation]);

  useEffect(() => {
    targetRef.current = content;
    isStreamingRef.current = isStreaming;

    const current = displayedRef.current;
    const shouldAnimate = !prefersReducedMotion && (isStreaming || wasStreamingRef.current);
    const canContinueFromCurrent =
      content.length >= current.length && content.startsWith(current);

    if (!shouldAnimate || !canContinueFromCurrent) {
      cancelAnimation();
      displayedRef.current = content;
      setDisplayedText(content);
      setIsAnimating(false);
      wasStreamingRef.current = isStreaming;
      return;
    }

    if (content !== current) {
      startAnimation();
    } else if (!isStreaming) {
      setIsAnimating(false);
    }

    wasStreamingRef.current = isStreaming;
  }, [cancelAnimation, content, isStreaming, prefersReducedMotion, startAnimation]);

  useEffect(() => cancelAnimation, [cancelAnimation]);

  return { text: displayedText, isAnimating };
}
