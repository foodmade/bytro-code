import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Tag, X } from "lucide-react";
import { useIdeaStore } from "@/stores";

export function TagFilterDropdown() {
  const { t } = useTranslation();
  const ideas = useIdeaStore((s) => s.ideas);
  const tagFilter = useIdeaStore((s) => s.tagFilter);
  const setTagFilter = useIdeaStore((s) => s.setTagFilter);

  const [showDropdown, setShowDropdown] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  const allTags = useMemo(() => {
    const tagSet = new Set<string>();
    for (const idea of ideas) {
      try {
        const parsed: string[] = JSON.parse(idea.tags);
        if (Array.isArray(parsed)) {
          for (const tag of parsed) {
            if (tag) tagSet.add(tag);
          }
        }
      } catch {
        // skip
      }
    }
    return Array.from(tagSet).sort();
  }, [ideas]);

  useEffect(() => {
    if (!showDropdown) return;
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setShowDropdown(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [showDropdown]);

  const toggleTag = useCallback(
    (tag: string) => {
      const current = [...tagFilter];
      const idx = current.indexOf(tag);
      if (idx >= 0) {
        current.splice(idx, 1);
      } else {
        current.push(tag);
      }
      setTagFilter(current);
    },
    [tagFilter, setTagFilter],
  );

  const clearFilter = useCallback(() => {
    setTagFilter([]);
  }, [setTagFilter]);

  if (allTags.length === 0) return null;

  const hasFilter = tagFilter.length > 0;

  return (
    <div className="relative" ref={ref}>
      <button
        onClick={() => setShowDropdown(!showDropdown)}
        style={{
          display: "flex",
          alignItems: "center",
          gap: 6,
          padding: "0 10px",
          height: 32,
          borderRadius: 6,
          border: `1px solid ${hasFilter ? "rgba(var(--theme-accent-rgb),0.314)" : "var(--color-border-light)"}`,
          backgroundColor: hasFilter ? "rgba(var(--theme-accent-rgb),0.063)" : "transparent",
          cursor: "pointer",
        }}
      >
        <Tag size={12} style={{ color: hasFilter ? "#A855F7" : "var(--color-muted)" }} />
        <span
          style={{
            fontSize: 11,
            color: hasFilter ? "#A855F7" : "var(--color-muted-foreground)",
          }}
        >
          {hasFilter ? `${tagFilter.length}` : t("ideaHub.tagFilter.all")}
        </span>
        {hasFilter && (
          <button
            onClick={(e) => {
              e.stopPropagation();
              clearFilter();
            }}
            style={{
              border: "none",
              background: "transparent",
              cursor: "pointer",
              padding: 0,
              display: "flex",
            }}
          >
            <X size={10} style={{ color: "#A855F7" }} />
          </button>
        )}
      </button>

      {showDropdown && (
        <div
          style={{
            position: "absolute",
            top: "calc(100% + 4px)",
            right: 0,
            minWidth: 180,
            maxHeight: 240,
            overflowY: "auto",
            padding: "4px 0",
            borderRadius: 8,
            backgroundColor: "var(--color-card)",
            border: "1px solid var(--color-border-light)",
            boxShadow: "0 8px 24px rgba(0,0,0,0.5)",
            zIndex: 50,
          }}
        >
          {allTags.map((tag) => {
            const isSelected = tagFilter.includes(tag);
            return (
              <button
                key={tag}
                onClick={() => toggleTag(tag)}
                className="w-full text-left transition-colors native-css-hover"
                style={
                  {
                    display: "flex",
                    alignItems: "center",
                    gap: 8,
                    padding: "7px 12px",
                    fontSize: 12,
                    color: isSelected ? "#A855F7" : "var(--color-foreground)",
                    fontWeight: isSelected ? 600 : 400,
                    border: "none",
                    background: "transparent",
                    cursor: "pointer",
                    "--native-hover-bg-color": "var(--color-background)",
                  } as React.CSSProperties
                }
              >
                <span
                  style={{
                    width: 14,
                    height: 14,
                    borderRadius: 3,
                    border: `1.5px solid ${isSelected ? "#A855F7" : "var(--color-border)"}`,
                    backgroundColor: isSelected ? "#A855F7" : "transparent",
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    fontSize: 9,
                    color: "#fff",
                    flexShrink: 0,
                  }}
                >
                  {isSelected ? "✓" : ""}
                </span>
                {tag}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
