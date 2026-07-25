import { useCallback, useEffect, useRef, useState } from "react";
import { X, Presentation } from "lucide-react";
import { useTranslation } from "react-i18next";
import { useSlideshowStore } from "@/stores/slideshow-store";
import { SlideThumbnailList } from "./slide-thumbnail-list";
import { SlideshowPreview } from "./slideshow-preview";
import { SlideshowToolbar } from "./slideshow-toolbar";

// ---------------------------------------------------------------------------
// SlideshowPanel — right-side split panel for slide preview
// ---------------------------------------------------------------------------

export function SlideshowPanel() {
  const { t } = useTranslation();
  const panelRef = useRef<HTMLDivElement>(null);
  const [dragging, setDragging] = useState(false);
  const startXRef = useRef(0);
  const startWidthRef = useRef(0);

  const data = useSlideshowStore((s) => s.slideshowData);
  const activeIndex = useSlideshowStore((s) => s.activeSlideIndex);
  const isStreaming = useSlideshowStore((s) => s.isStreaming);
  const closePanel = useSlideshowStore((s) => s.closePanel);
  const setActiveSlideIndex = useSlideshowStore((s) => s.setActiveSlideIndex);

  const totalSlides = data?.slides?.length ?? 0;

  // ── Drag resize for the side panel ──────────────────────────────

  const onMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    const panel = panelRef.current;
    if (!panel) return;
    startXRef.current = e.clientX;
    startWidthRef.current = panel.getBoundingClientRect().width;
    setDragging(true);
  }, []);

  useEffect(() => {
    if (!dragging) return;
    const onMouseMove = (e: MouseEvent) => {
      const panel = panelRef.current;
      if (!panel) return;
      const delta = startXRef.current - e.clientX;
      const newWidth = Math.max(360, startWidthRef.current + delta);
      panel.style.width = `${newWidth}px`;
    };
    const onMouseUp = () => setDragging(false);
    document.addEventListener("mousemove", onMouseMove);
    document.addEventListener("mouseup", onMouseUp);
    return () => {
      document.removeEventListener("mousemove", onMouseMove);
      document.removeEventListener("mouseup", onMouseUp);
    };
  }, [dragging]);

  // ── Navigation ──────────────────────────────────────────────────

  const goPrev = useCallback(() => {
    if (activeIndex > 0) setActiveSlideIndex(activeIndex - 1);
  }, [activeIndex, setActiveSlideIndex]);

  const goNext = useCallback(() => {
    if (activeIndex < totalSlides - 1) setActiveSlideIndex(activeIndex + 1);
  }, [activeIndex, totalSlides, setActiveSlideIndex]);

  // Keyboard navigation
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "ArrowLeft" || e.key === "ArrowUp") {
        e.preventDefault();
        goPrev();
      }
      if (e.key === "ArrowRight" || e.key === "ArrowDown") {
        e.preventDefault();
        goNext();
      }
    };
    // Only capture when panel is focused area — use capture on the panel itself
    const panel = panelRef.current;
    panel?.addEventListener("keydown", handler);
    return () => panel?.removeEventListener("keydown", handler);
  }, [goPrev, goNext]);

  return (
    <div
      ref={panelRef}
      tabIndex={-1}
      style={{
        width: "40%",
        display: "flex",
        flexDirection: "column",
        height: "100%",
        outline: "none",
        flexShrink: 0,
        position: "relative",
      }}
    >
      {/* ── Resize handle ─────────────────────────────────── */}
      <div
        onMouseDown={onMouseDown}
        className="native-css-hover"
        style={
          {
            position: "absolute",
            left: 0,
            top: 0,
            bottom: 0,
            width: 4,
            cursor: "col-resize",
            zIndex: 10,
            backgroundColor: dragging ? "var(--color-accent-purple)" : "var(--color-border)",
            "--native-hover-bg-color": !dragging ? "var(--color-border-strong)" : undefined,
          } as React.CSSProperties
        }
      />

      {/* ── Header ────────────────────────────────────────── */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          height: 48,
          padding: "0 16px 0 20px",
          borderBottom: "1px solid var(--color-border)",
          flexShrink: 0,
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <Presentation size={16} style={{ color: "var(--color-accent-purple)" }} />
          <span
            style={{
              fontSize: 14,
              fontWeight: 600,
              color: "var(--color-foreground)",
              fontFamily: "Inter, sans-serif",
            }}
          >
            {t("slideshow.panelTitle", { defaultValue: "Presentation" })}
          </span>
          {totalSlides > 0 && (
            <span
              style={{
                fontSize: 10,
                fontWeight: 500,
                color: "var(--color-muted)",
                backgroundColor: "var(--color-card)",
                borderRadius: 4,
                padding: "2px 6px",
              }}
            >
              {totalSlides} {t("slideshow.slides", { defaultValue: "slides" })}
            </span>
          )}
          {isStreaming && (
            <span
              style={{
                fontSize: 10,
                fontWeight: 500,
                color: "var(--color-accent-purple)",
              }}
            >
              {t("slideshow.generating", { defaultValue: "Generating..." })}
            </span>
          )}
        </div>
        <button
          type="button"
          onClick={closePanel}
          style={{
            width: 28,
            height: 28,
            borderRadius: 6,
            border: "none",
            background: "none",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            cursor: "pointer",
            color: "var(--color-muted)",
          }}
        >
          <X size={14} />
        </button>
      </div>

      {/* ── Body ──────────────────────────────────────────── */}
      {data && totalSlides > 0 ? (
        <>
          <div style={{ display: "flex", flex: 1, minHeight: 0 }}>
            <SlideThumbnailList
              data={data}
              activeIndex={activeIndex}
              onSelect={setActiveSlideIndex}
            />
            <SlideshowPreview data={data} activeIndex={activeIndex} />
          </div>
          <SlideshowToolbar
            activeIndex={activeIndex}
            total={totalSlides}
            onPrev={goPrev}
            onNext={goNext}
          />
        </>
      ) : (
        <div
          style={{
            flex: 1,
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            justifyContent: "center",
            gap: 8,
            color: "var(--color-muted)",
          }}
        >
          <Presentation size={32} style={{ opacity: 0.3 }} />
          <span style={{ fontSize: 13 }}>
            {t("slideshow.waiting", { defaultValue: "Waiting for slides..." })}
          </span>
        </div>
      )}
    </div>
  );
}
