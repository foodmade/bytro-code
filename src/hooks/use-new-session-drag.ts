import { useCallback, useEffect, useRef, useState } from "react";
import type { MouseEvent as ReactMouseEvent, PointerEvent as ReactPointerEvent } from "react";
import { useConversationStore, useSplitViewStore } from "@/stores";
import { resolveSplitTargetAtPoint } from "@/lib/split-drag-target";
import type { SplitPaneId } from "@/stores";

const LONG_PRESS_MS = 220;
const MOVE_TOLERANCE_PX = 6;

interface DragPreviewState {
  readonly title: string;
  readonly x: number;
  readonly y: number;
}

interface UseNewSessionDragOptions {
  readonly title: string;
  readonly onCreateClick: (event: ReactMouseEvent<HTMLElement>) => void;
  readonly onCreateAtPane: (paneId: SplitPaneId) => void;
}

export function useNewSessionDrag({
  title,
  onCreateClick,
  onCreateAtPane,
}: UseNewSessionDragOptions) {
  const setHoveredDropZone = useSplitViewStore((state) => state.setHoveredDropZone);
  const startDraggingNewSession = useSplitViewStore((state) => state.startDraggingNewSession);
  const endDraggingConversation = useSplitViewStore((state) => state.endDraggingConversation);
  const placeDraftPane = useSplitViewStore((state) => state.placeDraftPane);
  const [dragPreview, setDragPreview] = useState<DragPreviewState | null>(null);
  const suppressClickRef = useRef(false);
  const cleanupRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    return () => {
      if (cleanupRef.current) {
        cleanupRef.current();
        cleanupRef.current = null;
      }
    };
  }, []);

  const handleClick = useCallback((event: ReactMouseEvent<HTMLElement>) => {
    if (suppressClickRef.current) {
      event.preventDefault();
      event.stopPropagation();
      return;
    }
    onCreateClick(event);
  }, [onCreateClick]);

  const handlePointerDown = useCallback((event: ReactPointerEvent<HTMLElement>) => {
    if (event.button !== 0) {
      return;
    }

    if (cleanupRef.current) {
      cleanupRef.current();
      cleanupRef.current = null;
    }

    const rootElement = document.documentElement;
    const pointerTarget = event.currentTarget as HTMLElement | null;
    const startX = event.clientX;
    const startY = event.clientY;
    let lastX = event.clientX;
    let lastY = event.clientY;
    let dragging = false;
    let activationCancelled = false;
    let longPressTimer: number | null = null;

    const cleanup = () => {
      if (longPressTimer !== null) {
        window.clearTimeout(longPressTimer);
        longPressTimer = null;
      }
      window.removeEventListener("pointermove", onPointerMove, true);
      window.removeEventListener("pointerup", onPointerUp, true);
      window.removeEventListener("pointercancel", onPointerUp, true);
      document.body.style.userSelect = "";
      document.body.style.cursor = "";
      rootElement.classList.remove("split-dragging");
      if (pointerTarget) {
        pointerTarget.classList.remove("dragging");
      }
      setDragPreview(null);
      setHoveredDropZone(null, null);
      endDraggingConversation();
      cleanupRef.current = null;
      window.setTimeout(() => {
        suppressClickRef.current = false;
      }, 0);
    };

    const activateDrag = () => {
      if (dragging || activationCancelled) {
        return;
      }
      dragging = true;
      suppressClickRef.current = true;
      if (pointerTarget) {
        pointerTarget.classList.add("dragging");
      }
      document.body.style.userSelect = "none";
      document.body.style.cursor = "grabbing";
      rootElement.classList.add("split-dragging");
      document.getSelection?.()?.removeAllRanges();
      startDraggingNewSession();
      setDragPreview({
        title,
        x: lastX,
        y: lastY,
      });
      const target = resolveSplitTargetAtPoint(lastX, lastY);
      setHoveredDropZone(target?.zone ?? null, target?.paneId ?? null);
    };

    const onPointerMove = (nextEvent: PointerEvent) => {
      lastX = nextEvent.clientX;
      lastY = nextEvent.clientY;
      const distance = Math.hypot(lastX - startX, lastY - startY);

      if (!dragging) {
        if (distance > MOVE_TOLERANCE_PX && longPressTimer !== null) {
          window.clearTimeout(longPressTimer);
          longPressTimer = null;
          activationCancelled = true;
        }
        return;
      }

      const target = resolveSplitTargetAtPoint(lastX, lastY);
      setDragPreview((current) => current ? {
        ...current,
        x: lastX,
        y: lastY,
      } : current);
      setHoveredDropZone(target?.zone ?? null, target?.paneId ?? null);
    };

    const onPointerUp = (nextEvent: PointerEvent) => {
      if (dragging) {
        const target = resolveSplitTargetAtPoint(nextEvent.clientX, nextEvent.clientY);
        if (target) {
          const activeConversationIdNow = useConversationStore.getState().activeConversationId;
          const paneId = placeDraftPane(target.zone, activeConversationIdNow, target.paneId);
          if (paneId) {
            onCreateAtPane(paneId);
          }
        }
      }
      cleanup();
    };

    cleanupRef.current = cleanup;
    longPressTimer = window.setTimeout(activateDrag, LONG_PRESS_MS);
    window.addEventListener("pointermove", onPointerMove, true);
    window.addEventListener("pointerup", onPointerUp, true);
    window.addEventListener("pointercancel", onPointerUp, true);
  }, [endDraggingConversation, onCreateAtPane, placeDraftPane, setHoveredDropZone, startDraggingNewSession, title]);

  return {
    dragPreview,
    handleClick,
    handlePointerDown,
  } as const;
}
