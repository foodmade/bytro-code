import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  Search,
  FileText,
  FileCode,
  File,
  FileJson,
  Braces,
  CirclePlus,
  Terminal,
  PanelLeft,
  SunMoon,
  Settings,
  LayoutDashboard,
  MessageSquare,
  Lightbulb,
  Users,
  BarChart3,
  HeartPulse,
  Zap,
  CornerDownLeft,
} from "lucide-react";
import { useAppStore } from "@/stores/app-store";
import { useSettingsStore } from "@/stores";
import { parseShortcuts, formatShortcutParts } from "@/lib/keyboard-shortcuts";
import { type SearchTab, useGlobalSearch } from "./use-global-search";
import type { SearchResultItem } from "./command-registry";

// ---------------------------------------------------------------------------
// Icon resolver
// ---------------------------------------------------------------------------

const ICON_MAP: Record<string, React.FC<{ size?: number; className?: string }>> = {
  "file-text": FileText,
  "file-code": FileCode,
  "file-json": FileJson,
  file: File,
  folder: File,
  braces: Braces,
  "circle-plus": CirclePlus,
  terminal: Terminal,
  "panel-left": PanelLeft,
  "sun-moon": SunMoon,
  settings: Settings,
  "layout-dashboard": LayoutDashboard,
  "message-square": MessageSquare,
  lightbulb: Lightbulb,
  users: Users,
  "bar-chart-3": BarChart3,
  "heart-pulse": HeartPulse,
  zap: Zap,
};

function ResultIcon({ name, className }: { readonly name: string; readonly className?: string }) {
  const Icon = ICON_MAP[name] ?? File;
  return <Icon size={16} className={className} />;
}

// ---------------------------------------------------------------------------
// KeyCap (theme-aware)
// ---------------------------------------------------------------------------

function KeyCap({ label, size = "normal" }: { readonly label: string; readonly size?: "normal" | "small" }) {
  const isSmall = size === "small";
  return (
    <span
      className={`inline-flex items-center justify-center font-medium ${isSmall ? "global-search-keycap--small" : "global-search-keycap"}`}
      style={{
        minWidth: isSmall ? 18 : 22,
        height: isSmall ? 18 : 22,
        padding: isSmall ? "2px 5px" : "2px 6px",
        borderRadius: 4,
        fontSize: isSmall ? 10 : 11,
        fontWeight: 500,
        lineHeight: 1,
      }}
    >
      {label}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Tab button
// ---------------------------------------------------------------------------

const TABS: ReadonlyArray<{ readonly id: SearchTab; readonly labelKey: string }> = [
  { id: "all", labelKey: "globalSearch.tabAll" },
  { id: "files", labelKey: "globalSearch.tabFiles" },
  { id: "functions", labelKey: "globalSearch.tabFunctions" },
  { id: "commands", labelKey: "globalSearch.tabCommands" },
];

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export function GlobalSearchDialog() {
  const { t } = useTranslation();
  const setGlobalSearchOpen = useAppStore((s) => s.setGlobalSearchOpen);

  const [query, setQuery] = useState("");
  const [activeTab, setActiveTab] = useState<SearchTab>("all");
  const [activeIndex, setActiveIndex] = useState(0);

  const inputRef = useRef<HTMLInputElement>(null);
  const resultsRef = useRef<HTMLDivElement>(null);
  const itemRefs = useRef<Map<number, HTMLDivElement>>(new Map());

  const { results, isLoading, totalCount } = useGlobalSearch(query, activeTab);

  // Group results by category for "all" tab
  const groupedResults = useMemo(() => {
    if (activeTab !== "all") return null;

    const files: SearchResultItem[] = [];
    const functions: SearchResultItem[] = [];
    const commands: SearchResultItem[] = [];

    for (const r of results) {
      if (r.category === "file") files.push(r);
      else if (r.category === "function") functions.push(r);
      else commands.push(r);
    }

    return { files, functions, commands };
  }, [results, activeTab]);

  // Flat list for keyboard navigation
  const flatResults = useMemo(() => {
    if (activeTab !== "all" || !groupedResults) return results;
    return [...groupedResults.files, ...groupedResults.functions, ...groupedResults.commands];
  }, [results, activeTab, groupedResults]);

  // Reset active index when results change
  useEffect(() => {
    setActiveIndex(0);
  }, [query, activeTab]);

  // Auto-focus input on mount
  useEffect(() => {
    requestAnimationFrame(() => {
      inputRef.current?.focus();
    });
  }, []);

  // Scroll active item into view
  useEffect(() => {
    const el = itemRefs.current.get(activeIndex);
    if (el) {
      el.scrollIntoView({ block: "nearest" });
    }
  }, [activeIndex]);

  const close = useCallback(() => {
    setGlobalSearchOpen(false);
  }, [setGlobalSearchOpen]);

  const executeItem = useCallback(
    (index: number) => {
      const item = flatResults[index];
      if (item) {
        item.action();
        close();
      }
    },
    [flatResults, close],
  );

  // Keyboard navigation
  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setActiveIndex((prev) => (prev + 1) % Math.max(flatResults.length, 1));
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        setActiveIndex((prev) => (prev - 1 + flatResults.length) % Math.max(flatResults.length, 1));
      } else if (e.key === "Enter") {
        e.preventDefault();
        executeItem(activeIndex);
      } else if (e.key === "Escape") {
        e.preventDefault();
        close();
      }
    },
    [flatResults, activeIndex, executeItem, close],
  );

  // Get shortcut parts for display
  const keyboardShortcuts = useSettingsStore((s) => s.keyboardShortcuts);
  const shortcutParts = useMemo(() => {
    const shortcuts = parseShortcuts(keyboardShortcuts);
    return formatShortcutParts(shortcuts.globalSearch);
  }, [keyboardShortcuts]);

  // Build item ref setter
  const setItemRef = useCallback((index: number, el: HTMLDivElement | null) => {
    if (el) {
      itemRefs.current.set(index, el);
    } else {
      itemRefs.current.delete(index);
    }
  }, []);

  // Render a single result item
  const renderItem = (item: SearchResultItem, index: number) => {
    const isActive = index === activeIndex;
    return (
      <div
        key={item.id}
        ref={(el) => setItemRef(index, el)}
        className={`flex items-center gap-3 cursor-pointer transition-colors ${isActive ? "global-search-item--active" : ""}`}
        style={{
          padding: "10px 12px",
          borderRadius: 8,
        }}
        onMouseEnter={() => setActiveIndex(index)}
        onClick={() => executeItem(index)}
      >
        {/* Icon */}
        <ResultIcon
          name={item.icon}
          className={isActive && item.category === "file" ? "text-accent-purple" : "text-muted"}
        />

        {/* Content */}
        <div className="flex flex-col gap-0.5 min-w-0 flex-1">
          <span
            className="text-[13px] truncate"
            style={{
              color: isActive ? "var(--color-foreground)" : "var(--color-muted-foreground)",
              fontWeight: item.category === "file" && isActive ? 500 : "normal",
              fontFamily: item.category === "function" ? "var(--font-mono)" : "var(--font-sans)",
            }}
          >
            {item.title}
          </span>
          {item.subtitle && (
            <span className="text-[11px] text-muted truncate">
              {item.subtitle}
            </span>
          )}
        </div>

        {/* Shortcut badge (commands) */}
        {item.shortcut && (
          <div className="flex items-center gap-1 shrink-0">
            {formatShortcutParts(item.shortcut).map((p, i) => (
              <KeyCap key={i} label={p} size="small" />
            ))}
          </div>
        )}

        {/* Enter arrow for active file item */}
        {isActive && item.category === "file" && (
          <CornerDownLeft size={14} className="text-muted shrink-0" />
        )}
      </div>
    );
  };

  // Render grouped results (all tab)
  const renderGroupedResults = () => {
    if (!groupedResults) return null;

    const filesOffset = 0;
    const functionsOffset = groupedResults.files.length;
    const commandsOffset = functionsOffset + groupedResults.functions.length;
    const sections: React.ReactNode[] = [];

    if (groupedResults.files.length > 0) {
      sections.push(
        <div key="files-section">
          <div className="px-3 pt-2 pb-1">
            <span className="text-[11px] font-semibold text-muted">
              {t("globalSearch.sectionFiles")}
            </span>
          </div>
          {groupedResults.files.map((item, i) => renderItem(item, filesOffset + i))}
        </div>,
      );
    }

    if (groupedResults.functions.length > 0) {
      sections.push(
        <div key="functions-section">
          <div className="px-3 pt-3 pb-1">
            <span className="text-[11px] font-semibold text-muted">
              {t("globalSearch.sectionFunctions")}
            </span>
          </div>
          {groupedResults.functions.map((item, i) => renderItem(item, functionsOffset + i))}
        </div>,
      );
    }

    if (groupedResults.commands.length > 0) {
      sections.push(
        <div key="commands-section">
          <div className="px-3 pt-3 pb-1">
            <span className="text-[11px] font-semibold text-muted">
              {t("globalSearch.sectionCommands")}
            </span>
          </div>
          {groupedResults.commands.map((item, i) => renderItem(item, commandsOffset + i))}
        </div>,
      );
    }

    return sections;
  };

  return (
    // Overlay
    <div
      className="fixed inset-0 z-50 flex items-start justify-center global-search-overlay"
      onClick={close}
    >
      {/* Dialog */}
      <div
        className="flex flex-col overflow-hidden global-search-dialog"
        style={{
          width: 680,
          marginTop: 120,
          borderRadius: 16,
          animation: "globalSearchFadeIn 150ms ease-out",
        }}
        onClick={(e) => e.stopPropagation()}
        onKeyDown={handleKeyDown}
      >
        {/* Search input row */}
        <div className="flex items-center gap-3 w-full" style={{ padding: "16px 20px" }}>
          <Search size={20} className="text-muted shrink-0" />
          <input
            ref={inputRef}
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t("globalSearch.placeholder")}
            className="flex-1 bg-transparent border-none outline-none text-[15px] text-foreground"
            style={{
              fontFamily: "var(--font-sans)",
              color: "var(--color-foreground)",
            }}
          />
          {/* Shortcut keys */}
          <div className="flex items-center gap-1 shrink-0">
            {shortcutParts.map((p, i) => (
              <KeyCap key={i} label={p} />
            ))}
          </div>
          {/* Esc badge */}
          <div
            className="flex items-center justify-center shrink-0 cursor-pointer global-search-keycap"
            style={{
              padding: "3px 8px",
              borderRadius: 4,
            }}
            onClick={close}
          >
            <span className="text-[11px] font-medium" style={{ color: "var(--color-muted)" }}>Esc</span>
          </div>
        </div>

        {/* Divider */}
        <div className="w-full global-search-divider" style={{ height: 1 }} />

        {/* Tabs */}
        <div className="flex items-center gap-1 w-full" style={{ padding: "8px 16px" }}>
          {TABS.map((tab) => {
            const isActive = activeTab === tab.id;
            return (
              <button
                key={tab.id}
                className="flex items-center justify-center cursor-pointer transition-colors"
                style={{
                  padding: "6px 14px",
                  borderRadius: 6,
                  backgroundColor: isActive ? "color-mix(in srgb, var(--color-accent-purple) 9%, transparent)" : "transparent",
                  color: isActive ? "var(--color-accent-purple)" : "var(--color-muted)",
                  fontSize: 12,
                  fontWeight: isActive ? 600 : "normal",
                  border: "none",
                }}
                onClick={() => setActiveTab(tab.id)}
              >
                {t(tab.labelKey)}
              </button>
            );
          })}
        </div>

        {/* Divider */}
        <div className="w-full global-search-divider" style={{ height: 1 }} />

        {/* Results */}
        <div
          ref={resultsRef}
          className="flex flex-col overflow-y-auto overflow-x-hidden"
          style={{
            maxHeight: 400,
            padding: "4px 8px",
            gap: 2,
          }}
        >
          {isLoading && flatResults.length === 0 && (
            <div className="flex items-center justify-center py-8">
              <span className="text-[13px] text-muted">...</span>
            </div>
          )}

          {!isLoading && flatResults.length === 0 && query.trim() && (
            <div className="flex items-center justify-center py-8">
              <span className="text-[13px] text-muted">{t("globalSearch.noResults")}</span>
            </div>
          )}

          {activeTab === "all" && groupedResults
            ? renderGroupedResults()
            : flatResults.map((item, index) => renderItem(item, index))}
        </div>

        {/* Divider */}
        <div className="w-full global-search-divider" style={{ height: 1 }} />

        {/* Footer */}
        <div className="flex items-center justify-between w-full" style={{ padding: "10px 16px" }}>
          <div className="flex items-center gap-4">
            {/* Navigate hint */}
            <div className="flex items-center gap-1">
              <KeyCap label="&#8593;&#8595;" size="small" />
              <span className="text-[11px] text-muted">{t("globalSearch.navigate")}</span>
            </div>
            {/* Open hint */}
            <div className="flex items-center gap-1">
              <KeyCap label="&#8629;" size="small" />
              <span className="text-[11px] text-muted">{t("globalSearch.open")}</span>
            </div>
          </div>
          <span className="text-[11px] text-muted">
            {t("globalSearch.results", { count: totalCount })}
          </span>
        </div>
      </div>

    </div>
  );
}
