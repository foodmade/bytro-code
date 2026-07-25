import { useState, useEffect, useCallback } from "react";
import { useTranslation } from "react-i18next";
import { invoke } from "@tauri-apps/api/core";
import { X, GitCommit, User, Clock } from "lucide-react";
import type { GitLogEntry } from "@/stores/git-store";

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

function formatTimestamp(timestamp: number): string {
  const date = new Date(timestamp * 1000);
  const yyyy = date.getFullYear();
  const mm = String(date.getMonth() + 1).padStart(2, "0");
  const dd = String(date.getDate()).padStart(2, "0");
  const hh = String(date.getHours()).padStart(2, "0");
  const min = String(date.getMinutes()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd} ${hh}:${min}`;
}

function getCommitTypeColor(message: string): string {
  if (message.startsWith("feat")) return "#A855F7";
  if (message.startsWith("fix")) return "#22C55E";
  if (message.startsWith("refactor")) return "#3B82F6";
  if (message.startsWith("perf")) return "#F97316";
  if (message.startsWith("docs")) return "#6B7280";
  if (message.startsWith("test")) return "#E5C07B";
  if (message.startsWith("chore")) return "#6B7280";
  return "var(--color-muted-foreground)";
}

// ── Diff Line Renderer ───────────────────────────────────────────────

function DiffView({ patch }: { readonly patch: string }) {
  if (!patch) {
    return (
      <div
        className="flex items-center justify-center h-full"
        style={{ color: "var(--color-muted)", fontSize: 12 }}
      >
        No changes in this commit
      </div>
    );
  }

  // Parse lines and compute old/new line numbers from hunk headers
  const rawLines = patch.split("\n");

  interface DiffLine {
    readonly text: string;
    readonly oldNo: string;
    readonly newNo: string;
    readonly type: "header" | "hunk" | "add" | "del" | "ctx";
  }

  const parsed: DiffLine[] = [];
  let oldLine = 0;
  let newLine = 0;

  for (const line of rawLines) {
    if (
      line.startsWith("diff ") ||
      line.startsWith("index ") ||
      line.startsWith("+++") ||
      line.startsWith("---")
    ) {
      parsed.push({ text: line, oldNo: "", newNo: "", type: "header" });
    } else if (line.startsWith("@@")) {
      // Parse @@ -oldStart,oldCount +newStart,newCount @@
      const match = line.match(/@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
      if (match) {
        oldLine = parseInt(match[1], 10);
        newLine = parseInt(match[2], 10);
      }
      parsed.push({ text: line, oldNo: "...", newNo: "...", type: "hunk" });
    } else if (line.startsWith("+")) {
      parsed.push({ text: line, oldNo: "", newNo: String(newLine), type: "add" });
      newLine++;
    } else if (line.startsWith("-")) {
      parsed.push({ text: line, oldNo: String(oldLine), newNo: "", type: "del" });
      oldLine++;
    } else {
      parsed.push({ text: line, oldNo: String(oldLine), newNo: String(newLine), type: "ctx" });
      oldLine++;
      newLine++;
    }
  }

  const gutterW = 44;

  return (
    <div className="overflow-y-auto h-full">
      <pre
        className="text-[11px] font-mono"
        style={{ margin: 0, padding: "8px 0", lineHeight: 1.6 }}
      >
        {parsed.map((dl, i) => {
          let bgColor = "transparent";
          let textColor = "var(--color-muted-foreground)";
          let gutterBg = "transparent";

          if (dl.type === "header") {
            textColor = "var(--color-muted)";
          } else if (dl.type === "hunk") {
            bgColor = "color-mix(in srgb, var(--color-accent-blue) 8%, transparent)";
            gutterBg = bgColor;
            textColor = "var(--color-accent-blue)";
          } else if (dl.type === "add") {
            bgColor = "color-mix(in srgb, #22C55E 10%, transparent)";
            gutterBg = "color-mix(in srgb, #22C55E 16%, transparent)";
            textColor = "#22C55E";
          } else if (dl.type === "del") {
            bgColor = "color-mix(in srgb, #EF4444 10%, transparent)";
            gutterBg = "color-mix(in srgb, #EF4444 16%, transparent)";
            textColor = "#EF4444";
          }

          return (
            <div
              key={i}
              className="flex"
              style={{
                backgroundColor: bgColor,
                color: textColor,
                minHeight: 18,
              }}
            >
              {/* Old line number */}
              <span
                className="shrink-0 text-right select-none"
                style={{
                  width: gutterW,
                  padding: "0 6px",
                  color: "var(--color-muted)",
                  backgroundColor: gutterBg,
                  borderRight: "1px solid var(--color-border)",
                  userSelect: "none",
                }}
              >
                {dl.oldNo}
              </span>
              {/* New line number */}
              <span
                className="shrink-0 text-right select-none"
                style={{
                  width: gutterW,
                  padding: "0 6px",
                  color: "var(--color-muted)",
                  backgroundColor: gutterBg,
                  borderRight: "1px solid var(--color-border)",
                  userSelect: "none",
                }}
              >
                {dl.newNo}
              </span>
              {/* Content */}
              <span style={{ padding: "0 12px", whiteSpace: "pre", flex: 1 }}>
                {dl.text || " "}
              </span>
            </div>
          );
        })}
      </pre>
    </div>
  );
}

// ── Commit Row ───────────────────────────────────────────────────────

function CommitRow({
  entry,
  isSelected,
  onSelect,
}: {
  readonly entry: GitLogEntry;
  readonly isSelected: boolean;
  readonly onSelect: () => void;
}) {
  const firstLine = entry.message.split("\n")[0];
  const hashColor = getCommitTypeColor(firstLine);

  return (
    <div
      onClick={onSelect}
      className="flex items-center cursor-pointer native-css-hover"
      style={
        {
          padding: "7px 12px",
          gap: 10,
          backgroundColor: isSelected ? "var(--color-border-subtle)" : undefined,
          borderLeft: isSelected ? "2px solid var(--color-accent-purple)" : "2px solid transparent",
          "--native-hover-bg-color": !isSelected
            ? "rgba(var(--hover-overlay-rgb),0.04)"
            : undefined,
        } as React.CSSProperties
      }
    >
      <span
        className="text-[10px] font-semibold font-mono shrink-0"
        style={{ color: hashColor, minWidth: 52 }}
      >
        {entry.id}
      </span>
      <span
        className="text-[11px] font-sans truncate min-w-0 flex-1"
        style={{
          color: isSelected ? "var(--color-foreground)" : "var(--color-muted-foreground)",
        }}
        title={firstLine}
      >
        {firstLine}
      </span>
      <span
        className="text-[10px] font-sans shrink-0"
        style={{ color: "var(--color-muted)", minWidth: 32, textAlign: "right" }}
      >
        {formatRelativeTime(entry.timestamp)}
      </span>
      <span
        className="text-[10px] font-sans shrink-0 truncate"
        style={{ color: "var(--color-muted)", maxWidth: 80 }}
        title={entry.author}
      >
        {entry.author}
      </span>
    </div>
  );
}

// ── Main Modal ───────────────────────────────────────────────────────

interface GitHistoryModalProps {
  readonly workspacePath: string;
  readonly filePath: string;
  readonly onClose: () => void;
}

export function GitHistoryModal({ workspacePath, filePath, onClose }: GitHistoryModalProps) {
  const { t } = useTranslation();
  const [entries, setEntries] = useState<ReadonlyArray<GitLogEntry>>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [selectedEntry, setSelectedEntry] = useState<GitLogEntry | null>(null);
  const [patchText, setPatchText] = useState<string>("");
  const [loadingEntries, setLoadingEntries] = useState(true);
  const [loadingDiff, setLoadingDiff] = useState(false);

  const fileName = filePath.split(/[\\/]/).pop() ?? filePath;

  // Load file-specific commit log on mount
  useEffect(() => {
    setLoadingEntries(true);
    invoke<GitLogEntry[]>("get_git_log", {
      path: workspacePath,
      limit: 200,
      filePath,
    })
      .then((result) => {
        setEntries(result);
        // Auto-select first entry
        if (result.length > 0) {
          setSelectedId(result[0].full_id);
          setSelectedEntry(result[0]);
          loadDiff(result[0].full_id);
        }
      })
      .catch((err) => {
        console.error("[GitHistoryModal] Failed to load log:", err);
      })
      .finally(() => setLoadingEntries(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspacePath, filePath]);

  const loadDiff = useCallback(
    async (commitId: string) => {
      setLoadingDiff(true);
      try {
        const result = await invoke<string>("get_file_diff_in_commit", {
          path: workspacePath,
          commitId,
          filePath,
        });
        setPatchText(result);
      } catch (err) {
        console.error("[GitHistoryModal] Failed to load diff:", err);
        setPatchText("");
      } finally {
        setLoadingDiff(false);
      }
    },
    [workspacePath, filePath],
  );

  const handleSelect = useCallback(
    (entry: GitLogEntry) => {
      setSelectedId(entry.full_id);
      setSelectedEntry(entry);
      loadDiff(entry.full_id);
    },
    [loadDiff],
  );

  // Close on Escape
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center"
      style={{ backgroundColor: "rgba(0,0,0,0.5)" }}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        className="flex flex-col overflow-hidden"
        style={{
          width: "min(900px, 92vw)",
          height: "min(660px, 88vh)",
          borderRadius: "var(--radius-lg)",
          backgroundColor: "var(--color-surface)",
          border: "1px solid var(--color-border)",
          boxShadow: "var(--shadow-float)",
        }}
      >
        {/* Header */}
        <div
          className="flex items-center justify-between shrink-0"
          style={{
            height: 44,
            padding: "0 16px",
            borderBottom: "1px solid var(--color-border)",
          }}
        >
          <div className="flex items-center" style={{ gap: 8 }}>
            <GitCommit size={15} style={{ color: "var(--color-accent-purple)" }} />
            <span
              className="text-[13px] font-semibold font-sans"
              style={{ color: "var(--color-foreground)" }}
            >
              {t("git.historyModal.title")}
            </span>
            <span
              className="text-[11px] font-mono"
              style={{
                color: "var(--color-accent-purple)",
                backgroundColor: "color-mix(in srgb, var(--color-accent-purple) 12%, transparent)",
                borderRadius: 4,
                padding: "1px 6px",
              }}
            >
              {fileName}
            </span>
            {!loadingEntries && (
              <span className="text-[10px] font-mono" style={{ color: "var(--color-muted)" }}>
                {entries.length} {t("git.historyModal.commits")}
              </span>
            )}
          </div>
          <button
            onClick={onClose}
            className="flex items-center justify-center rounded transition-colors hover:bg-hover-overlay/[0.06]"
            style={{ width: 28, height: 28 }}
            title={t("git.closePanel")}
          >
            <X size={14} className="text-muted" />
          </button>
        </div>

        {/* Body */}
        <div className="flex flex-col flex-1 min-h-0">
          {/* Commit list */}
          <div
            className="shrink-0 overflow-y-auto"
            style={{
              maxHeight: 200,
              minHeight: 80,
              borderBottom: "1px solid var(--color-border)",
            }}
          >
            {loadingEntries ? (
              <div className="flex items-center justify-center" style={{ padding: 20 }}>
                <div className="w-4 h-4 border-2 border-border-strong border-t-transparent rounded-full animate-spin" />
              </div>
            ) : entries.length === 0 ? (
              <div
                className="flex items-center justify-center"
                style={{ padding: 20, color: "var(--color-muted)", fontSize: 12 }}
              >
                {t("git.historyModal.noCommits")}
              </div>
            ) : (
              entries.map((entry) => (
                <CommitRow
                  key={entry.full_id}
                  entry={entry}
                  isSelected={selectedId === entry.full_id}
                  onSelect={() => handleSelect(entry)}
                />
              ))
            )}
          </div>

          {/* Selected commit info bar */}
          {selectedEntry && (
            <div
              className="flex items-center shrink-0"
              style={{
                padding: "6px 16px",
                gap: 16,
                borderBottom: "1px solid var(--color-border)",
                backgroundColor: "var(--color-card)",
              }}
            >
              <div className="flex items-center" style={{ gap: 5 }}>
                <GitCommit size={11} style={{ color: "var(--color-muted)" }} />
                <span
                  className="text-[10px] font-mono"
                  style={{ color: "var(--color-accent-purple)" }}
                >
                  {selectedEntry.id}
                </span>
              </div>
              <span
                className="text-[11px] font-sans truncate flex-1 min-w-0"
                style={{ color: "var(--color-foreground)" }}
              >
                {selectedEntry.message.split("\n")[0]}
              </span>
              <div className="flex items-center shrink-0" style={{ gap: 5 }}>
                <User size={11} style={{ color: "var(--color-muted)" }} />
                <span
                  className="text-[10px] font-sans"
                  style={{ color: "var(--color-muted-foreground)" }}
                >
                  {selectedEntry.author}
                </span>
              </div>
              <div className="flex items-center shrink-0" style={{ gap: 5 }}>
                <Clock size={11} style={{ color: "var(--color-muted)" }} />
                <span
                  className="text-[10px] font-sans"
                  style={{ color: "var(--color-muted-foreground)" }}
                >
                  {formatTimestamp(selectedEntry.timestamp)}
                </span>
              </div>
            </div>
          )}

          {/* Diff content area */}
          <div className="flex-1 min-h-0 overflow-hidden">
            {loadingDiff ? (
              <div className="flex items-center justify-center h-full">
                <div className="w-4 h-4 border-2 border-border-strong border-t-transparent rounded-full animate-spin" />
              </div>
            ) : (
              <DiffView patch={patchText} />
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
