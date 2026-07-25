import { useCallback, useEffect, useRef, useState, type RefObject } from "react";

interface ToolbarPosition {
  readonly x: number;
  readonly y: number;
}

interface TextSelectionState {
  readonly selectedText: string;
  readonly hasSelection: boolean;
  readonly toolbarPosition: ToolbarPosition | null;
}

const TOOLBAR_WIDTH_ESTIMATE = 140;
const TOOLBAR_HEIGHT_ESTIMATE = 36;
const OFFSET = 8;
const DEBOUNCE_MS = 100;
const VIEWPORT_PADDING = 4;

function computeToolbarPosition(rect: DOMRect): ToolbarPosition {
  let x = rect.left + rect.width / 2 - TOOLBAR_WIDTH_ESTIMATE / 2;
  let y = rect.top - TOOLBAR_HEIGHT_ESTIMATE - OFFSET;

  // If would overflow above viewport, position below selection
  if (y < VIEWPORT_PADDING) {
    y = rect.bottom + OFFSET;
  }

  // Clamp horizontal to viewport
  x = Math.max(
    VIEWPORT_PADDING,
    Math.min(x, window.innerWidth - TOOLBAR_WIDTH_ESTIMATE - VIEWPORT_PADDING),
  );

  return { x, y };
}

export function useTextSelection(
  containerRef: RefObject<HTMLElement | null>,
  layoutRef?: RefObject<HTMLElement | null>,
): TextSelectionState {
  const [state, setState] = useState<TextSelectionState>({
    selectedText: "",
    hasSelection: false,
    toolbarPosition: null,
  });

  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const frameRef = useRef<number | null>(null);

  const clearSelectionState = useCallback(() => {
    setState({ selectedText: "", hasSelection: false, toolbarPosition: null });
  }, []);

  const recomputeSelectionPosition = useCallback(() => {
    const selection = window.getSelection();
    if (!selection || selection.isCollapsed) {
      clearSelectionState();
      return;
    }

    const text = selection.toString().trim();
    if (!text) {
      clearSelectionState();
      return;
    }

    const container = containerRef.current;
    if (!container) {
      clearSelectionState();
      return;
    }

    const anchorNode = selection.anchorNode;
    const focusNode = selection.focusNode;
    if (
      !anchorNode ||
      !focusNode ||
      !container.contains(anchorNode) ||
      !container.contains(focusNode)
    ) {
      clearSelectionState();
      return;
    }

    if (selection.rangeCount === 0) {
      clearSelectionState();
      return;
    }

    const range = selection.getRangeAt(0);
    const rect = range.getBoundingClientRect();
    if ((rect.width === 0 && rect.height === 0) || rect.bottom < 0 || rect.top > window.innerHeight) {
      clearSelectionState();
      return;
    }

    const position = computeToolbarPosition(rect);
    setState({ selectedText: text, hasSelection: true, toolbarPosition: position });
  }, [clearSelectionState, containerRef]);

  const scheduleRecompute = useCallback((debounceMs: number) => {
    if (timerRef.current) {
      clearTimeout(timerRef.current);
    }
    timerRef.current = setTimeout(() => {
      if (frameRef.current != null) {
        cancelAnimationFrame(frameRef.current);
      }
      frameRef.current = requestAnimationFrame(() => {
        recomputeSelectionPosition();
      });
    }, debounceMs);
  }, [recomputeSelectionPosition]);

  useEffect(() => {
    const handleSelectionChange = () => {
      scheduleRecompute(DEBOUNCE_MS);
    };

    const handleGeometryChange = () => {
      scheduleRecompute(0);
    };

    const container = containerRef.current;
    const layoutNode = layoutRef?.current;
    const resizeObserver = typeof ResizeObserver !== "undefined"
      ? new ResizeObserver(() => {
        handleGeometryChange();
      })
      : null;

    if (container) {
      container.addEventListener("scroll", handleGeometryChange, { passive: true });
      resizeObserver?.observe(container);
    }
    if (layoutNode && layoutNode !== container) {
      resizeObserver?.observe(layoutNode);
    }

    window.addEventListener("resize", handleGeometryChange);
    document.addEventListener("scroll", handleGeometryChange, true);

    document.addEventListener("selectionchange", handleSelectionChange);

    return () => {
      document.removeEventListener("selectionchange", handleSelectionChange);
      document.removeEventListener("scroll", handleGeometryChange, true);
      window.removeEventListener("resize", handleGeometryChange);
      if (container) {
        container.removeEventListener("scroll", handleGeometryChange);
      }
      resizeObserver?.disconnect();
      if (timerRef.current) {
        clearTimeout(timerRef.current);
      }
      if (frameRef.current != null) {
        cancelAnimationFrame(frameRef.current);
      }
    };
  }, [containerRef, layoutRef, scheduleRecompute]);

  return state;
}
