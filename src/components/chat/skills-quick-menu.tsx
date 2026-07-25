import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useSettingsStore } from "@/stores";
import { matchesShortcut, parseShortcuts, formatShortcut } from "@/lib/keyboard-shortcuts";
import {
  Layers,
  Code,
  TestTubes,
  ClipboardList,
  Rocket,
  FileText,
  ShieldCheck,
  Wrench,
  Search,
  X,
  Info,
  WandSparkles,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { useSkillsStore } from "@/stores";
import { Tooltip } from "@/components/ui";
import type { InstalledSkill } from "@/stores/skills-store";

/** Category tab definitions — mapped to backend category values */
const CATEGORY_TABS = [
  { key: "all", icon: Layers, labelKey: "skillsMenu.tabAll" },
  { key: "development", icon: Code, labelKey: "skillsMenu.tabDev" },
  { key: "testing", icon: TestTubes, labelKey: "skillsMenu.tabTest" },
  { key: "review", icon: ClipboardList, labelKey: "skillsMenu.tabReview" },
  { key: "devops", icon: Rocket, labelKey: "skillsMenu.tabDevops" },
  { key: "docs", icon: FileText, labelKey: "skillsMenu.tabDocs" },
  { key: "security", icon: ShieldCheck, labelKey: "skillsMenu.tabSecurity" },
  { key: "other", icon: Wrench, labelKey: "skillsMenu.tabOther" },
] as const;

type CategoryKey = (typeof CATEGORY_TABS)[number]["key"];

/** Icon mapping for skills — picks icon based on category */
function skillIcon(category: string) {
  switch (category) {
    case "development":
      return Code;
    case "testing":
      return TestTubes;
    case "review":
      return ClipboardList;
    case "devops":
      return Rocket;
    case "docs":
      return FileText;
    case "security":
      return ShieldCheck;
    default:
      return Wrench;
  }
}

interface SkillsQuickMenuProps {
  readonly provider?: string | null;
  readonly onSelect: (skillName: string) => void;
  readonly onClose: () => void;
}

export const SkillsQuickMenu = memo(function SkillsQuickMenu({
  provider,
  onSelect,
  onClose,
}: SkillsQuickMenuProps) {
  const { t } = useTranslation();
  const menuRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [activeTab, setActiveTab] = useState<CategoryKey>("all");
  const [activeIndex, setActiveIndex] = useState(0);
  // Track whether the last activeIndex change came from keyboard navigation.
  // Mouse hover doesn't need scrollIntoView since the hovered item is already visible.
  const scrollOnChangeRef = useRef(false);

  const skills = useSkillsStore((s) => s.skills);
  const load = useSkillsStore((s) => s.load);

  // Always reload when menu opens — picks up skills installed via /find-skills
  // or other external processes since the last load.
  useEffect(() => {
    load(provider);
  }, [load, provider]);

  useEffect(() => {
    setSearchQuery("");
    setActiveTab("all");
    setActiveIndex(0);
  }, [provider]);

  // Focus search on mount
  useEffect(() => {
    searchInputRef.current?.focus();
  }, []);

  // Click outside to close
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        onClose();
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [onClose]);

  // Filter by tab + search query
  const filteredSkills = useMemo(() => {
    let list: ReadonlyArray<InstalledSkill> = skills;
    if (activeTab !== "all") {
      list = list.filter((s) => s.category === activeTab);
    }
    if (searchQuery) {
      const q = searchQuery.toLowerCase();
      list = list.filter(
        (s) => s.name.toLowerCase().includes(q) || s.description.toLowerCase().includes(q),
      );
    }
    return list;
  }, [skills, activeTab, searchQuery]);

  // Reset active index on filter change
  useEffect(() => {
    scrollOnChangeRef.current = true;
    setActiveIndex(0);
  }, [filteredSkills]);

  // Scroll active item into view — only for keyboard navigation and filter resets.
  // Mouse hover sets scrollOnChangeRef to false so we skip the scroll (the item is
  // already visible under the cursor).  This also prevents the "jump on open" issue
  // where the mouse enters from below and triggers a scrollIntoView on mount.
  useEffect(() => {
    if (!scrollOnChangeRef.current) return;
    scrollOnChangeRef.current = false;
    if (!listRef.current) return;
    const item = listRef.current.children[activeIndex] as HTMLElement | undefined;
    item?.scrollIntoView({ block: "nearest" });
  }, [activeIndex, filteredSkills]);

  // Visible tabs — only show tabs that have skills
  const visibleTabs = useMemo(() => {
    const categoryCounts = new Map<string, number>();
    for (const s of skills) {
      categoryCounts.set(s.category, (categoryCounts.get(s.category) ?? 0) + 1);
    }
    return CATEGORY_TABS.filter(
      (tab) => tab.key === "all" || (categoryCounts.get(tab.key) ?? 0) > 0,
    );
  }, [skills]);

  const handleTabChange = useCallback((key: CategoryKey) => {
    setActiveTab(key);
    setActiveIndex(0);
  }, []);

  const handleSelect = useCallback(
    (name: string) => {
      onSelect(name);
      onClose();
    },
    [onSelect, onClose],
  );

  // Event-delegated mouse hover — avoids per-item closures
  const handleListMouseMove = useCallback(
    (e: React.MouseEvent) => {
      const target = (e.target as HTMLElement).closest<HTMLElement>("[data-idx]");
      if (!target) return;
      const idx = Number(target.dataset.idx);
      if (!Number.isNaN(idx) && idx !== activeIndex) {
        setActiveIndex(idx);
      }
    },
    [activeIndex],
  );

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "ArrowUp") {
        e.preventDefault();
        scrollOnChangeRef.current = true;
        setActiveIndex((i) => Math.max(0, i - 1));
        return;
      }
      if (e.key === "ArrowDown") {
        e.preventDefault();
        scrollOnChangeRef.current = true;
        setActiveIndex((i) => Math.min(filteredSkills.length - 1, i + 1));
        return;
      }
      if (e.key === "Enter") {
        e.preventDefault();
        const skill = filteredSkills[activeIndex];
        if (skill) handleSelect(skill.name);
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
        return;
      }
    },
    [filteredSkills, activeIndex, handleSelect, onClose],
  );

  return (
    <div
      ref={menuRef}
      onKeyDown={handleKeyDown}
      className="absolute bottom-full left-0 mb-2 flex flex-col overflow-hidden rounded-xl border border-border bg-surface shadow-[0_-8px_24px_rgba(0,0,0,0.5)] z-50 w-[340px]"
    >
      {/* Header */}
      <div className="flex items-center shrink-0 gap-2 px-3.5 py-2.5 border-b border-border">
        <WandSparkles size={14} className="text-accent-amber shrink-0" />
        <span className="text-xs font-semibold font-sans text-muted-foreground">
          {t("skillsMenu.title")}
        </span>
        <span className="inline-flex items-center justify-center shrink-0 px-2 py-px rounded-full text-[10px] font-semibold font-sans bg-accent-amber-muted text-accent-amber">
          {skills.length}
        </span>
      </div>

      {/* Search */}
      <div className="flex items-center shrink-0 gap-2 px-3.5 py-2">
        <Search size={14} className="text-muted shrink-0" />
        <input
          ref={searchInputRef}
          type="text"
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          placeholder={t("skillsMenu.searchPlaceholder")}
          className="flex-1 bg-transparent outline-none text-xs font-sans text-foreground placeholder:text-text-placeholder"
        />
        {searchQuery && (
          <button onClick={() => setSearchQuery("")} className="shrink-0">
            <X size={12} className="text-muted" />
          </button>
        )}
      </div>

      {/* Divider */}
      <div className="h-px shrink-0 bg-border" />

      {/* Category tabs — matches design padding:[6,8] gap:4 */}
      {visibleTabs.length > 2 && (
        <div className="flex items-center shrink-0 gap-1 px-2 py-1.5 border-b border-border overflow-x-auto">
          {visibleTabs.map((tab) => {
            const Icon = tab.icon;
            const isActive = activeTab === tab.key;
            return (
              <button
                key={tab.key}
                type="button"
                onClick={() => handleTabChange(tab.key)}
                className={cn(
                  "flex items-center shrink-0 gap-1.5 px-2 py-1 rounded-full text-[11px] font-semibold font-sans transition-colors",
                  isActive
                    ? "text-accent-amber bg-accent-amber-muted"
                    : "text-muted hover:text-muted-foreground",
                )}
              >
                <Icon size={11} />
                <span>{t(tab.labelKey)}</span>
              </button>
            );
          })}
        </div>
      )}

      {/* Skill list — fixed height so switching tabs never changes panel size */}
      <div
        ref={listRef}
        onMouseMove={handleListMouseMove}
        className="flex flex-col gap-0.5 overflow-y-auto py-1 h-[220px]"
      >
        {filteredSkills.length === 0 && (
          <div className="px-3 py-4 text-center text-[11px] text-muted font-sans">
            {t("skillsMenu.noResults")}
          </div>
        )}
        {filteredSkills.map((skill, i) => {
          const Icon = skillIcon(skill.category);
          const isActive = i === activeIndex;
          return (
            <button
              key={skill.name}
              type="button"
              data-idx={i}
              onClick={() => handleSelect(skill.name)}
              className={cn(
                "flex items-center w-full px-3.5 py-1.5 gap-2.5 rounded transition-colors text-left",
                isActive ? "bg-accent-amber/10" : "hover:bg-surface-raised",
              )}
            >
              <Icon
                size={16}
                className={cn(
                  "shrink-0 transition-colors",
                  isActive ? "text-accent-amber" : "text-muted",
                )}
              />
              <div className="flex flex-col min-w-0 gap-0.5 flex-1">
                <span
                  className={cn(
                    "truncate text-[13px] font-medium font-sans transition-colors",
                    isActive ? "text-foreground" : "text-muted-foreground",
                  )}
                >
                  {skill.name}
                </span>
                {skill.description && (
                  <span className="truncate text-[11px] font-sans text-muted">
                    {skill.description}
                  </span>
                )}
              </div>
              <span className="shrink-0 px-1.5 py-px rounded text-[10px] font-medium font-mono text-muted bg-surface-dark">
                /{skill.name}
              </span>
            </button>
          );
        })}
      </div>

      {/* Footer */}
      <div className="flex items-center shrink-0 justify-between px-3.5 py-2 border-t border-border">
        <div className="flex items-center gap-1">
          <Info size={10} className="text-muted" />
          <span className="text-[10px] font-sans text-muted">{t("skillsMenu.footerHint")}</span>
        </div>
        <div className="flex items-center gap-1.5">
          <kbd className="inline-flex items-center justify-center px-1 py-px rounded text-[9px] font-medium font-sans bg-surface-dark text-muted">
            ↑
          </kbd>
          <kbd className="inline-flex items-center justify-center px-1 py-px rounded text-[9px] font-medium font-sans bg-surface-dark text-muted">
            ↓
          </kbd>
          <span className="text-[9px] font-sans text-muted">{t("skillsMenu.navigate")}</span>
          <kbd className="inline-flex items-center justify-center px-1 py-px rounded text-[9px] font-medium font-sans bg-surface-dark text-muted">
            ⏎
          </kbd>
          <span className="text-[9px] font-sans text-muted">{t("skillsMenu.select")}</span>
        </div>
      </div>
    </div>
  );
});

/** Toolbar icon button for opening the skills quick menu */
export const SkillsQuickButton = memo(function SkillsQuickButton({
  provider,
  onSelect,
  onBeforeOpen,
}: {
  readonly provider?: string | null;
  readonly onSelect: (skillName: string) => void;
  readonly onBeforeOpen?: () => void;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const shortcutsJson = useSettingsStore((s) => s.keyboardShortcuts);
  const shortcuts = useMemo(() => parseShortcuts(shortcutsJson), [shortcutsJson]);

  const toggle = useCallback(() => {
    setOpen((prev) => {
      if (!prev) onBeforeOpen?.();
      return !prev;
    });
  }, [onBeforeOpen]);
  const close = useCallback(() => setOpen(false), []);

  // Skills menu global shortcut (configurable, default Ctrl+K)
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (matchesShortcut(e, shortcuts.skillsMenu)) {
        e.preventDefault();
        toggle();
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [toggle, shortcuts.skillsMenu]);

  const handleSelect = useCallback(
    (name: string) => {
      onSelect(name);
      setOpen(false);
    },
    [onSelect],
  );

  return (
    <div className="relative flex items-center">
      <Tooltip
        content={`${t("skillsMenu.openSkills")} (${formatShortcut(shortcuts.skillsMenu)})`}
        placement="top"
        disabled={open}
      >
        <button
          onClick={toggle}
          className="text-accent-amber hover:brightness-125 transition-colors cursor-pointer"
          aria-label={t("skillsMenu.openSkills")}
        >
          <WandSparkles size={16} />
        </button>
      </Tooltip>
      {open && <SkillsQuickMenu provider={provider} onSelect={handleSelect} onClose={close} />}
    </div>
  );
});
