import { useState, useCallback } from "react";
import { ChevronDown } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { GitLogEntry } from "@/stores/git-store";
import { formatError } from "@/lib/format-error";
import { useToastStore } from "@/stores/toast-store";
import { popupCommitContextMenu } from "./git-context-menu";

// ── Helpers ──────────────────────────────────────────────────────────

function formatRelativeTime(timestamp: number): string {
  const now = Date.now() / 1000;
  const diff = now - timestamp;

  if (diff < 60) return "<1m";
  if (diff < 3600) return `${Math.floor(diff / 60)}m`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h`;
  if (diff < 604800) return `${Math.floor(diff / 86400)}d`;
  if (diff < 2592000) return `${Math.floor(diff / 604800)}w`;
  return `${Math.floor(diff / 2592000)}mo`;
}

function getCommitTypeColor(message: string): string {
  if (message.startsWith("feat")) return "#A855F7";
  if (message.startsWith("fix")) return "#22C55E";
  if (message.startsWith("refactor")) return "#3B82F6";
  if (message.startsWith("perf")) return "#F97316";
  if (message.startsWith("docs")) return "#6B7280";
  if (message.startsWith("test")) return "#E5C07B";
  if (message.startsWith("chore")) return "#6B7280";
  return "#A855F7";
}

// ── Commit Row ───────────────────────────────────────────────────────

function CommitRow({
  entry,
  isSelected,
  onSelect,
  onContextMenu,
}: {
  readonly entry: GitLogEntry;
  readonly isSelected: boolean;
  readonly onSelect: () => void;
  readonly onContextMenu: (e: React.MouseEvent) => void;
}) {
  const firstLine = entry.message.split("\n")[0];
  const hashColor = getCommitTypeColor(firstLine);

  return (
    <div
      onClick={onSelect}
      onContextMenu={onContextMenu}
      className="flex items-center cursor-pointer group native-css-hover"
      style={
        {
          padding: "6px 8px",
          borderRadius: 4,
          gap: 10,
          backgroundColor: isSelected ? "var(--color-border-subtle)" : undefined,
          border: isSelected ? "1px solid rgba(var(--theme-accent-rgb),0.188)" : "1px solid transparent",
          "--native-hover-bg-color": !isSelected
            ? "rgba(var(--hover-overlay-rgb),0.03)"
            : undefined,
        } as React.CSSProperties
      }
    >
      <span className="text-[10px] font-semibold font-mono shrink-0" style={{ color: hashColor }}>
        {entry.id}
      </span>
      <span
        className="text-[11px] font-sans truncate min-w-0"
        style={{
          flex: 1,
          color: isSelected ? "var(--color-foreground)" : "var(--color-muted-foreground)",
        }}
        title={firstLine}
      >
        {firstLine}
      </span>
      <span className="text-[10px] font-sans shrink-0" style={{ color: "var(--color-muted)" }}>
        {formatRelativeTime(entry.timestamp)}
      </span>
    </div>
  );
}

// ── History Section ──────────────────────────────────────────────────

interface GitHistorySectionProps {
  readonly entries: ReadonlyArray<GitLogEntry>;
  readonly selectedCommit: string | null;
  readonly onSelectCommit: (id: string) => void;
  readonly onViewDetail?: (commitId: string) => void;
}

export function GitHistorySection({
  entries,
  selectedCommit,
  onSelectCommit,
  onViewDetail,
}: GitHistorySectionProps) {
  const { t } = useTranslation();
  const [collapsed, setCollapsed] = useState(true);

  const handleToggle = useCallback(() => {
    setCollapsed((v) => !v);
  }, []);

  const handleContextMenu = useCallback(
    (e: React.MouseEvent, entry: GitLogEntry) => {
      e.preventDefault();
      e.stopPropagation();
      popupCommitContextMenu({
        x: e.clientX,
        y: e.clientY,
        commitId: entry.full_id,
        shortId: entry.id,
        message: entry.message,
        t,
        onViewDetail,
      }).catch((err) => {
        useToastStore.getState().addToast("error", `Unable to open git menu: ${formatError(err)}`);
      });
    },
    [onViewDetail, t],
  );

  return (
    <div
      className="flex flex-col"
      style={{
        width: "100%",
        borderTop: "1px solid var(--color-border)",
      }}
    >
      {/* Section Header */}
      <div
        className="flex items-center justify-between cursor-pointer transition-colors hover:bg-hover-overlay/[0.02]"
        style={{ padding: "6px 16px" }}
        onClick={handleToggle}
      >
        <div className="flex items-center" style={{ gap: 6 }}>
          <ChevronDown
            size={12}
            style={{
              color: "var(--color-muted)",
              transform: collapsed ? "rotate(-90deg)" : undefined,
              transition: "transform 150ms",
            }}
          />
          <span
            className="text-[11px] font-semibold font-sans"
            style={{ color: "var(--color-muted)" }}
          >
            {t("git.history")}
          </span>
          {entries.length > 0 && (
            <span
              className="flex items-center justify-center"
              style={{
                fontSize: 9,
                fontWeight: 700,
                color: "#A855F7",
                backgroundColor: "rgba(var(--theme-accent-rgb),0.125)",
                borderRadius: 8,
                padding: "1px 6px",
              }}
            >
              {entries.length}
            </span>
          )}
        </div>
      </div>

      {/* Commit List */}
      {!collapsed && (
        <div
          className="flex flex-col overflow-y-auto"
          style={{ padding: "0 8px", gap: 2, maxHeight: 320 }}
        >
          {entries.map((entry) => (
            <CommitRow
              key={entry.full_id}
              entry={entry}
              isSelected={selectedCommit === entry.full_id}
              onSelect={() => onSelectCommit(entry.full_id)}
              onContextMenu={(e) => handleContextMenu(e, entry)}
            />
          ))}
        </div>
      )}
    </div>
  );
}
