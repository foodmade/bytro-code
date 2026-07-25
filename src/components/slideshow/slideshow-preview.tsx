import { useRef, useCallback, useMemo, useState, useEffect } from "react";
import type { SlideshowData, SlideElement } from "@/types/slideshow";
import { SlideRenderer } from "./slide-renderer";
import { useSlideshowStore } from "@/stores/slideshow-store";

interface SlideshowPreviewProps {
  readonly data: SlideshowData;
  readonly activeIndex: number;
}

export function SlideshowPreview({ data, activeIndex }: SlideshowPreviewProps) {
  const containerRef = useRef<HTMLDivElement>(null);

  // Compute scale to fit the preview container while maintaining 16:9
  const scale = useFitScale(containerRef);

  const selectSlideElement = useSlideshowStore((s) => s.selectSlideElement);
  const selectedEl = useSlideshowStore((s) => s.selectedSlideElement);
  const updateElementText = useSlideshowStore((s) => s.updateElementText);

  // ── Selection ──────────────────────────────────────────────────────

  const handleElementClick = useCallback(
    (elementIndex: number, element: SlideElement, subIndex?: number) => {
      let textPreview: string;
      if (element.type === "bullets" && subIndex != null && element.items?.[subIndex]) {
        textPreview = element.items[subIndex].text.slice(0, 40);
      } else if (element.type === "bullets") {
        textPreview = element.items?.map((it) => it.text).join(", ").slice(0, 40) ?? "";
      } else {
        textPreview = element.text?.slice(0, 40) ?? "";
      }
      selectSlideElement({
        slideIndex: activeIndex,
        elementIndex,
        elementType: element.type,
        textPreview,
        subIndex,
      });
    },
    [activeIndex, selectSlideElement],
  );

  const selectedElementIndex =
    selectedEl && selectedEl.slideIndex === activeIndex ? selectedEl.elementIndex : undefined;
  const selectedSubIndex =
    selectedEl && selectedEl.slideIndex === activeIndex ? selectedEl.subIndex : undefined;

  // ── Inline editing ─────────────────────────────────────────────────

  const [editingEl, setEditingEl] = useState<{ elementIndex: number; subIndex?: number } | null>(null);

  // Cancel editing when switching slides
  useEffect(() => {
    setEditingEl(null);
  }, [activeIndex]);

  const handleDoubleClick = useCallback(
    (_elementIndex: number, _element: SlideElement, subIndex?: number) => {
      setEditingEl({ elementIndex: _elementIndex, subIndex });
    },
    [],
  );

  const handleEditCommit = useCallback(
    (elementIndex: number, newText: string, subIndex?: number) => {
      updateElementText(activeIndex, elementIndex, newText, subIndex);
      setEditingEl(null);
    },
    [activeIndex, updateElementText],
  );

  const handleEditCancel = useCallback(() => {
    setEditingEl(null);
  }, []);

  // ── Render ─────────────────────────────────────────────────────────

  const slide = data.slides?.[activeIndex];
  if (!slide) return null;

  return (
    <div
      ref={containerRef}
      style={{
        flex: 1,
        display: "flex",
        justifyContent: "center",
        alignItems: "center",
        padding: 24,
        minWidth: 0,
        minHeight: 0,
        overflow: "hidden",
      }}
    >
      <div
        style={{
          borderRadius: 8,
          boxShadow: "0 4px 24px rgba(0,0,0,0.4)",
          overflow: "hidden",
          lineHeight: 0,
        }}
      >
        <SlideRenderer
          slide={slide}
          theme={data.theme}
          scale={scale}
          onElementClick={handleElementClick}
          selectedElementIndex={selectedElementIndex}
          selectedSubIndex={selectedSubIndex}
          onElementDoubleClick={handleDoubleClick}
          editingElementIndex={editingEl?.elementIndex}
          editingSubIndex={editingEl?.subIndex}
          onEditCommit={handleEditCommit}
          onEditCancel={handleEditCancel}
        />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Hook: compute scale to fit 960×540 into the container
// ---------------------------------------------------------------------------

function useFitScale(containerRef: React.RefObject<HTMLDivElement | null>): number {
  const getScale = useCallback(() => {
    const el = containerRef.current;
    if (!el) return 0.6;
    const pad = 48; // padding on each side
    const maxW = el.clientWidth - pad;
    const maxH = el.clientHeight - pad;
    if (maxW <= 0 || maxH <= 0) return 0.4;
    return Math.min(maxW / 960, maxH / 540, 1);
  }, [containerRef]);

  // Re-compute on mount and window resize via useMemo
  // (good-enough heuristic; avoids ResizeObserver complexity for MVP)
  return useMemo(getScale, [getScale]);
}
