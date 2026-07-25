import { useEffect, useMemo, useRef } from "react";
import { useTranslation } from "react-i18next";
import { Terminal } from "lucide-react";
import { cn } from "@/lib/utils";
import type { SlashCommandInfo } from "@/stores/chat-store";

export type SlashItemType = "command";

export interface SlashDropdownItem {
  readonly name: string;
  readonly description: string;
  readonly itemType: SlashItemType;
}

interface SlashCommandDropdownProps {
  readonly query: string;
  readonly commands: ReadonlyArray<SlashCommandInfo>;
  readonly activeIndex: number;
  readonly onSelect: (name: string, type: SlashItemType) => void;
  readonly onFilteredItemsChange: (items: ReadonlyArray<SlashDropdownItem>) => void;
  readonly onResetIndex: () => void;
}

export function SlashCommandDropdown({
  query,
  commands,
  activeIndex,
  onSelect,
  onFilteredItemsChange,
  onResetIndex,
}: SlashCommandDropdownProps) {
  const { t } = useTranslation();
  const listRef = useRef<HTMLDivElement>(null);

  const filteredCommands = useMemo(() => {
    const q = query.toLowerCase();
    return commands.filter(
      (cmd) =>
        cmd.name.toLowerCase().includes(q) ||
        cmd.description.toLowerCase().includes(q),
    );
  }, [commands, query]);

  const activeItems: ReadonlyArray<SlashDropdownItem> = useMemo(() => (
    filteredCommands.map((c) => ({
      name: c.name,
      description: c.description,
      itemType: "command" as const,
    }))
  ), [filteredCommands]);

  useEffect(() => {
    onFilteredItemsChange(activeItems);
  }, [activeItems, onFilteredItemsChange]);

  useEffect(() => {
    onResetIndex();
  }, [query, commands, onResetIndex]);

  // Scroll active item into view
  useEffect(() => {
    if (!listRef.current) return;
    const item = listRef.current.children[activeIndex] as HTMLElement | undefined;
    if (item) {
      item.scrollIntoView({ block: "nearest" });
    }
  }, [activeIndex]);

  const commandCount = filteredCommands.length;

  return (
    <div
      className="absolute bottom-full left-0 mb-2 rounded-lg border border-border-light bg-card shadow-[0_8px_24px_rgba(0,0,0,0.4)] z-50 overflow-hidden"
      style={{ maxWidth: 420, maxHeight: 320, minWidth: 280 }}
    >
      <div className="flex items-center border-b border-border-subtle">
        <TabButton
          icon={<Terminal size={11} />}
          label={t("slash.commands")}
          count={commandCount}
          active
          onClick={onResetIndex}
        />
      </div>

      <div ref={listRef} className="overflow-y-auto" style={{ maxHeight: 260 }}>
        {filteredCommands.length === 0 && (
          <div className="px-3 py-4 text-center text-[11px] text-text-tertiary font-sans">
            {t("slash.noCommands")}
          </div>
        )}
        {filteredCommands.map((cmd, i) => (
          <ItemRow
            key={cmd.name}
            name={cmd.name}
            description={cmd.description}
            prefix="/"
            active={i === activeIndex}
            onClick={() => onSelect(cmd.name, "command")}
          />
        ))}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Tab button                                                         */
/* ------------------------------------------------------------------ */

function TabButton({
  icon,
  label,
  count,
  active,
  onClick,
}: {
  readonly icon: React.ReactNode;
  readonly label: string;
  readonly count: number;
  readonly active: boolean;
  readonly onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "flex items-center gap-1.5 px-3 py-1.5 text-[10px] font-mono transition-colors border-b-2",
        active
          ? "text-accent-purple border-accent-purple"
          : "text-text-tertiary border-transparent hover:text-muted-foreground",
      )}
    >
      {icon}
      <span>{label}</span>
      <span className="text-text-placeholder ml-0.5">{count}</span>
    </button>
  );
}

/* ------------------------------------------------------------------ */
/*  Single row                                                         */
/* ------------------------------------------------------------------ */

/** Color mapping for skill categories in the dropdown: [bg, text] */
const CATEGORY_COLORS: Record<string, readonly [string, string]> = {
  development: ["rgba(var(--theme-accent-rgb),0.15)", "#C4B5FD"],
  testing: ["rgba(34,197,94,0.15)", "#86EFAC"],
  review: ["rgba(59,130,246,0.15)", "#93C5FD"],
  devops: ["rgba(249,115,22,0.15)", "#FDBA74"],
  docs: ["rgba(20,184,166,0.15)", "#5EEAD4"],
  security: ["rgba(239,68,68,0.15)", "#FCA5A5"],
  other: ["rgba(148,163,184,0.15)", "#CBD5E1"],
};

function ItemRow({
  name,
  description,
  prefix,
  category,
  active,
  onClick,
}: {
  readonly name: string;
  readonly description: string;
  readonly prefix: string;
  readonly category?: string;
  readonly active: boolean;
  readonly onClick: () => void;
}) {
  const { t } = useTranslation();

  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "flex items-center w-full px-3 py-1.5 gap-2 transition-colors text-left",
        active ? "bg-accent-purple/10" : "hover:bg-border-subtle",
      )}
    >
      <span className="text-[12px] font-mono text-accent-purple shrink-0 leading-[18px]">
        {prefix}
      </span>
      <span className="text-[12px] font-mono shrink-0 leading-[18px] text-foreground">
        {name}
      </span>
      {category && (() => {
        const key = category || "other";
        const [bg, fg] = CATEGORY_COLORS[key] ?? CATEGORY_COLORS.other;
        return (
          <span
            className="shrink-0 px-1 py-px rounded text-[8px] font-semibold font-sans uppercase tracking-wide leading-[14px]"
            style={{ backgroundColor: bg, color: fg }}
          >
            {t(`skills.category.${key}`, { defaultValue: key })}
          </span>
        );
      })()}
      {description && (
        <span className="text-[11px] font-sans text-muted truncate leading-[18px]">
          {description}
        </span>
      )}
    </button>
  );
}
