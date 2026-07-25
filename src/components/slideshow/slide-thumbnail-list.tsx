import { useRef, useEffect } from "react";
import type { SlideshowData } from "@/types/slideshow";
import { SlideThumbnail } from "./slide-thumbnail";

interface SlideThumbnailListProps {
  readonly data: SlideshowData;
  readonly activeIndex: number;
  readonly onSelect: (index: number) => void;
}

export function SlideThumbnailList({ data, activeIndex, onSelect }: SlideThumbnailListProps) {
  const listRef = useRef<HTMLDivElement>(null);

  // Scroll active thumbnail into view
  useEffect(() => {
    const container = listRef.current;
    if (!container) return;
    const child = container.children[activeIndex] as HTMLElement | undefined;
    child?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, [activeIndex]);

  return (
    <div
      ref={listRef}
      style={{
        display: "flex",
        flexDirection: "column",
        gap: 8,
        padding: "12px 8px",
        width: 100,
        flexShrink: 0,
        overflowY: "auto",
        overflowX: "hidden",
        borderRight: "1px solid var(--color-border)",
        backgroundColor: "var(--color-background)",
      }}
    >
      {data.slides?.map((slide, i) => (
        <SlideThumbnail
          key={i}
          slide={slide}
          theme={data.theme}
          index={i}
          isActive={i === activeIndex}
          onClick={() => onSelect(i)}
        />
      ))}
    </div>
  );
}
