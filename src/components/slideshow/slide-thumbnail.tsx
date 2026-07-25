import { memo } from "react";
import type { Slide, SlideshowTheme } from "@/types/slideshow";
import { SlideRenderer } from "./slide-renderer";

interface SlideThumbnailProps {
  readonly slide: Slide;
  readonly theme?: SlideshowTheme;
  readonly index: number;
  readonly isActive: boolean;
  readonly onClick: () => void;
}

export const SlideThumbnail = memo(function SlideThumbnail({
  slide,
  theme,
  index,
  isActive,
  onClick,
}: SlideThumbnailProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        display: "flex",
        flexDirection: "column",
        gap: 4,
        background: "none",
        border: "none",
        padding: 0,
        cursor: "pointer",
        width: "100%",
      }}
    >
      <span
        style={{
          fontSize: 9,
          fontWeight: isActive ? 600 : 500,
          color: isActive ? "var(--color-accent-purple)" : "var(--color-muted)",
          fontFamily: "Inter, sans-serif",
        }}
      >
        {index + 1}
      </span>
      <div
        style={{
          borderRadius: 4,
          border: isActive
            ? "1.5px solid var(--color-accent-purple)"
            : "1px solid var(--color-border-strong)",
          overflow: "hidden",
          width: "100%",
        }}
      >
        <SlideRenderer slide={slide} theme={theme} scale={84 / 960} />
      </div>
    </button>
  );
});
