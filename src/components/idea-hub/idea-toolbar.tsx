import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Plus, ChevronDown, ArrowLeft, Lightbulb, Search, Filter } from "lucide-react";
import { TagFilterDropdown } from "./tag-filter-dropdown";

const STATUS_OPTIONS = [
  { value: "", labelKey: "ideaHub.filter.allWorkspaces" },
  { value: "draft", labelKey: "ideaHub.filter.draft" },
  { value: "discussing", labelKey: "ideaHub.filter.discussing" },
  { value: "ready", labelKey: "ideaHub.filter.ready" },
  { value: "building", labelKey: "ideaHub.filter.building" },
] as const;

export function IdeaToolbar({
  onSearch,
  onFilterStatus,
  onNewIdea,
  onBack,
  currentStatus,
  activeCount,
}: {
  readonly onSearch: (query: string) => void;
  readonly onFilterStatus: (status: string) => void;
  readonly onNewIdea: () => void;
  readonly onBack?: () => void;
  readonly currentStatus: string;
  readonly activeCount?: number;
}) {
  const { t } = useTranslation();
  const [searchQuery, setSearchQuery] = useState("");
  const [showFilter, setShowFilter] = useState(false);
  const filterRef = useRef<HTMLDivElement>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout>>(undefined);

  const handleSearchChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const value = e.target.value;
      setSearchQuery(value);

      if (debounceRef.current) clearTimeout(debounceRef.current);
      debounceRef.current = setTimeout(() => {
        onSearch(value);
      }, 300);
    },
    [onSearch],
  );

  useEffect(() => {
    if (!showFilter) return;
    const handler = (e: MouseEvent) => {
      if (filterRef.current && !filterRef.current.contains(e.target as Node)) {
        setShowFilter(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [showFilter]);

  const filterLabel = t(
    STATUS_OPTIONS.find((o) => o.value === currentStatus)?.labelKey ??
      "ideaHub.filter.allWorkspaces",
  );

  return (
    <div
      className="flex items-center justify-between shrink-0"
      style={{
        height: 56,
        padding: "0 28px",
        borderBottom: "1px solid var(--color-border)",
      }}
    >
      {/* Left: back + icon + title + count */}
      <div className="flex items-center" style={{ gap: 14 }}>
        {onBack && (
          <button
            onClick={onBack}
            className="flex items-center justify-center shrink-0 native-css-hover"
            style={
              {
                width: 28,
                height: 28,
                borderRadius: 6,
                border: "none",
                background: "transparent",
                cursor: "pointer",
                color: "var(--color-muted)",
                "--native-hover-bg-color": "var(--color-border)",
              } as React.CSSProperties
            }
            title={t("ideaHub.back")}
          >
            <ArrowLeft size={16} />
          </button>
        )}

        {/* Icon */}
        <div
          className="flex items-center justify-center shrink-0"
          style={{
            width: 32,
            height: 32,
            borderRadius: 8,
            backgroundColor: "rgba(var(--theme-accent-rgb),0.094)",
          }}
        >
          <Lightbulb size={16} style={{ color: "#A855F7" }} />
        </div>

        {/* Title */}
        <span
          style={{
            fontSize: 18,
            fontWeight: 700,
            color: "var(--color-foreground)",
          }}
        >
          {t("ideaHub.title")}
        </span>

        {/* Active count badge */}
        {activeCount !== undefined && activeCount > 0 && (
          <div
            className="flex items-center"
            style={{
              gap: 4,
              height: 22,
              padding: "0 10px",
              borderRadius: 11,
              backgroundColor: "var(--color-border)",
            }}
          >
            <span
              style={{
                width: 6,
                height: 6,
                borderRadius: 3,
                backgroundColor: "#22C55E",
                flexShrink: 0,
              }}
            />

            <span
              style={{
                fontSize: 10,
                fontWeight: 500,
                color: "var(--color-muted-foreground)",
              }}
            >
              {activeCount} {t("ideaHub.activeCount")}
            </span>
          </div>
        )}
      </div>

      {/* Right: search + filter + tag filter + new */}
      <div className="flex items-center" style={{ gap: 10 }}>
        {/* Search */}
        <div
          className="flex items-center"
          style={{
            gap: 6,
            padding: "0 12px",
            borderRadius: 8,
            backgroundColor: "var(--color-surface)",
            border: "1px solid var(--color-border)",
            width: 220,
            height: 34,
          }}
        >
          <Search size={14} style={{ color: "var(--color-border-strong)", flexShrink: 0 }} />
          <input
            type="text"
            value={searchQuery}
            onChange={handleSearchChange}
            placeholder={t("ideaHub.searchPlaceholder")}
            style={{
              border: "none",
              outline: "none",
              background: "transparent",
              color: "var(--color-foreground)",
              fontSize: 12,
              width: "100%",
            }}
          />
        </div>

        {/* Filter */}
        <div className="relative" ref={filterRef}>
          <button
            onClick={() => setShowFilter(!showFilter)}
            className="flex items-center"
            style={{
              gap: 6,
              padding: "0 12px",
              height: 34,
              borderRadius: 8,
              border: "none",
              backgroundColor: "var(--color-border)",
              cursor: "pointer",
            }}
          >
            <Filter size={14} style={{ color: "var(--color-muted-foreground)", flexShrink: 0 }} />
            <span
              style={{
                fontSize: 12,
                color: "var(--color-muted-foreground)",
              }}
            >
              {filterLabel}
            </span>
            <ChevronDown size={12} style={{ color: "var(--color-border-strong)" }} />
          </button>

          {showFilter && (
            <div
              style={{
                position: "absolute",
                top: "calc(100% + 4px)",
                right: 0,
                minWidth: 160,
                padding: "4px 0",
                borderRadius: 8,
                backgroundColor: "var(--color-card)",
                border: "1px solid var(--color-border)",
                boxShadow: "0 8px 24px rgba(0,0,0,0.5)",
                zIndex: 50,
              }}
            >
              {STATUS_OPTIONS.map((opt) => (
                <button
                  key={opt.value}
                  onClick={() => {
                    onFilterStatus(opt.value);
                    setShowFilter(false);
                  }}
                  className="w-full text-left native-css-hover"
                  style={
                    {
                      display: "block",
                      padding: "7px 12px",
                      fontSize: 12,
                      color: currentStatus === opt.value ? "#A855F7" : "var(--color-foreground)",
                      fontWeight: currentStatus === opt.value ? 600 : 400,
                      border: "none",
                      background: "transparent",
                      cursor: "pointer",
                      transition: "background-color 0.1s",
                      "--native-hover-bg-color": "var(--color-border)",
                    } as React.CSSProperties
                  }
                >
                  {t(opt.labelKey)}
                </button>
              ))}
            </div>
          )}
        </div>

        {/* Tag filter */}
        <TagFilterDropdown />

        {/* New Idea — purple per design */}
        <button
          onClick={onNewIdea}
          className="flex items-center native-css-hover"
          style={
            {
              gap: 6,
              padding: "0 16px",
              height: 34,
              borderRadius: 8,
              border: "none",
              backgroundColor: "#A855F7",
              color: "#ffffff",
              fontSize: 12,
              fontWeight: 600,
              cursor: "pointer",
              transition: "opacity 0.15s ease",
              "--native-hover-opacity": "0.9",
            } as React.CSSProperties
          }
        >
          <Plus size={14} />
          {t("ideaHub.newIdea")}
        </button>
      </div>
    </div>
  );
}
