import { ChevronDown, Plus, Minus, FileDiff, Undo2, Check, X } from "lucide-react";
import { useState, useEffect, useRef, useCallback } from "react";
import { useTranslation } from "react-i18next";
import type { GitFileStatus, FileDiffStat } from "@/stores/git-store";
import { formatError } from "@/lib/format-error";
import { useToastStore } from "@/stores/toast-store";
import { popupGitFileContextMenu } from "./git-file-context-menu";

// ── Status badge color mapping ──────────────────────────────────────

function getStatusBadge(status: string, isStaged: boolean): { label: string; color: string } {
  if (isStaged) {
    switch (status) {
      case "added":
        return { label: "A", color: "#22C55E" };
      case "deleted":
        return { label: "D", color: "#EF4444" };
      case "renamed":
        return { label: "R", color: "#3B82F6" };
      default:
        return { label: "M", color: "#22C55E" };
    }
  }
  switch (status) {
    case "untracked":
      return { label: "U", color: "#6B7280" };
    case "added":
      return { label: "A", color: "#22C55E" };
    case "deleted":
      return { label: "D", color: "#EF4444" };
    case "renamed":
      return { label: "R", color: "#3B82F6" };
    default:
      return { label: "M", color: "#E5C07B" };
  }
}

function getFileName(path: string): string {
  const sep = path.includes("\\") ? "\\" : "/";
  return path.split(sep).pop() ?? path;
}

// ── File Row ────────────────────────────────────────────────────────

interface FileRowProps {
  readonly file: GitFileStatus;
  readonly diffStat?: FileDiffStat;
  readonly isSelected: boolean;
  readonly onSelect: () => void;
  readonly onDiff: () => void;
  readonly onStage?: () => void;
  readonly onUnstage?: () => void;
  readonly onDiscard?: () => void;
  readonly onContextMenu?: (e: React.MouseEvent) => void;
}

function ActionIconBtn({
  onClick,
  title,
  children,
}: {
  readonly onClick: (e: React.MouseEvent) => void;
  readonly title: string;
  readonly children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      className="flex items-center justify-center rounded transition-colors hover:bg-hover-overlay/[0.07]"
      style={{ width: 22, height: 22 }}
      title={title}
    >
      {children}
    </button>
  );
}

function FileRow({
  file,
  diffStat,
  isSelected,
  onSelect,
  onDiff,
  onStage,
  onUnstage,
  onDiscard,
  onContextMenu,
}: FileRowProps) {
  const { t } = useTranslation();
  const badge = getStatusBadge(file.status, file.is_staged);
  const [confirmingDiscard, setConfirmingDiscard] = useState(false);
  const confirmTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const cancelDiscard = useCallback(() => {
    setConfirmingDiscard(false);
    if (confirmTimerRef.current) {
      clearTimeout(confirmTimerRef.current);
      confirmTimerRef.current = null;
    }
  }, []);

  useEffect(() => {
    return () => {
      if (confirmTimerRef.current) {
        clearTimeout(confirmTimerRef.current);
      }
    };
  }, []);

  const handleDiscardClick = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation();
      if (confirmingDiscard) {
        cancelDiscard();
        onDiscard?.();
      } else {
        setConfirmingDiscard(true);
        confirmTimerRef.current = setTimeout(() => {
          setConfirmingDiscard(false);
        }, 3000);
      }
    },
    [confirmingDiscard, cancelDiscard, onDiscard],
  );

  return (
    <div
      onClick={onSelect}
      onContextMenu={onContextMenu}
      className="flex items-center justify-between cursor-pointer group native-css-hover"
      style={
        {
          padding: "5px 12px",
          borderRadius: 4,
          backgroundColor: isSelected ? "rgba(var(--theme-accent-rgb),0.08)" : undefined,
          border: "1px solid transparent",
          outline: "none",
          boxShadow: "none",
          "--native-hover-bg-color": !isSelected
            ? "rgba(var(--hover-overlay-rgb),0.03)"
            : undefined,
        } as React.CSSProperties
      }
    >
      <div className="flex items-center min-w-0" style={{ gap: 8 }}>
        <span className="text-[11px] font-bold font-mono shrink-0" style={{ color: badge.color }}>
          {badge.label}
        </span>
        {confirmingDiscard ? (
          <span className="truncate text-[11px] font-sans font-medium" style={{ color: "#EF4444" }}>
            {t("git.confirmDiscard")}
          </span>
        ) : (
          <span
            className="truncate text-[12px] font-mono"
            title={file.path}
            style={{
              color: isSelected ? "var(--color-foreground)" : "var(--color-muted-foreground)",
            }}
          >
            {getFileName(file.path)}
          </span>
        )}
        {!confirmingDiscard && diffStat && (diffStat.additions > 0 || diffStat.deletions > 0) && (
          <span className="flex items-center shrink-0" style={{ gap: 4 }}>
            {diffStat.additions > 0 && (
              <span className="text-[10px] font-mono" style={{ color: "#22C55E" }}>
                +{diffStat.additions}
              </span>
            )}
            {diffStat.deletions > 0 && (
              <span className="text-[10px] font-mono" style={{ color: "#EF4444" }}>
                -{diffStat.deletions}
              </span>
            )}
          </span>
        )}
      </div>

      <div
        className={`flex items-center shrink-0 ${confirmingDiscard ? "opacity-100" : "opacity-0 group-hover:opacity-100"} transition-opacity`}
        style={{ gap: 2 }}
      >
        {confirmingDiscard ? (
          <>
            <ActionIconBtn onClick={handleDiscardClick} title={t("git.confirmYes")}>
              <Check size={13} style={{ color: "#EF4444" }} />
            </ActionIconBtn>
            <ActionIconBtn
              onClick={(e) => {
                e.stopPropagation();
                cancelDiscard();
              }}
              title={t("git.confirmNo")}
            >
              <X size={13} style={{ color: "var(--color-muted)" }} />
            </ActionIconBtn>
          </>
        ) : (
          <>
            <ActionIconBtn
              onClick={(e) => {
                e.stopPropagation();
                onDiff();
              }}
              title="View diff"
            >
              <FileDiff size={13} style={{ color: "var(--color-muted)" }} />
            </ActionIconBtn>
            {onDiscard && (
              <ActionIconBtn onClick={handleDiscardClick} title={t("git.discardChanges")}>
                <Undo2 size={13} style={{ color: "#EF4444" }} />
              </ActionIconBtn>
            )}
            {onStage && (
              <ActionIconBtn
                onClick={(e) => {
                  e.stopPropagation();
                  onStage();
                }}
                title="Stage file"
              >
                <Plus size={13} style={{ color: "#22C55E" }} />
              </ActionIconBtn>
            )}
            {onUnstage && (
              <ActionIconBtn
                onClick={(e) => {
                  e.stopPropagation();
                  onUnstage();
                }}
                title="Unstage file"
              >
                <Minus size={13} style={{ color: "#E5C07B" }} />
              </ActionIconBtn>
            )}
          </>
        )}
      </div>
    </div>
  );
}

// ── Section ─────────────────────────────────────────────────────────

interface GitFileSectionProps {
  readonly label: string;
  readonly count: number;
  readonly files: ReadonlyArray<GitFileStatus>;
  readonly fileDiffStats: ReadonlyMap<string, FileDiffStat>;
  readonly countColor: string;
  readonly countBg: string;
  readonly selectedFile: string | null;
  readonly onSelectFile: (path: string) => void;
  readonly onDiffFile: (path: string, staged: boolean) => void;
  readonly onStageFile?: (path: string) => void;
  readonly onUnstageFile?: (path: string) => void;
  readonly onDiscardFile?: (path: string) => void;
  readonly onStageAll?: () => void;
  readonly onUnstageAll?: () => void;
  readonly onOpenFile?: (path: string) => void;
  readonly onOpenInExplorer?: (path: string) => void;
  readonly onCopyPath?: (path: string) => void;
  readonly onRemoveFile?: (path: string) => void;
  readonly onStopTracking?: (path: string) => void;
  readonly onChangeHistory?: (path: string) => void;
}

function GitFileSection({
  label,
  count,
  files,
  fileDiffStats,
  countColor,
  countBg,
  selectedFile,
  onSelectFile,
  onDiffFile,
  onStageFile,
  onUnstageFile,
  onDiscardFile,
  onStageAll,
  onUnstageAll,
  onOpenFile,
  onOpenInExplorer,
  onCopyPath,
  onRemoveFile,
  onStopTracking,
  onChangeHistory,
}: GitFileSectionProps) {
  const { t } = useTranslation();
  const [collapsed, setCollapsed] = useState(false);
  const isStaged = !!onUnstageFile;

  const handleContextMenu = useCallback(
    (e: React.MouseEvent, filePath: string) => {
      e.preventDefault();
      e.stopPropagation();
      popupGitFileContextMenu({ filePath, isStaged }, e.clientX, e.clientY, t, {
        onOpen: onOpenFile ? () => onOpenFile(filePath) : undefined,
        onOpenInExplorer: onOpenInExplorer ? () => onOpenInExplorer(filePath) : undefined,
        onCopyPath: onCopyPath ? () => onCopyPath(filePath) : undefined,
        onRemove: onRemoveFile ? () => onRemoveFile(filePath) : undefined,
        onDiscardChanges: onDiscardFile ? () => onDiscardFile(filePath) : undefined,
        onStopTracking: onStopTracking ? () => onStopTracking(filePath) : undefined,
        onChangeHistory: onChangeHistory ? () => onChangeHistory(filePath) : undefined,
        onStage: onStageFile ? () => onStageFile(filePath) : undefined,
        onUnstage: onUnstageFile ? () => onUnstageFile(filePath) : undefined,
      }).catch((err) => {
        useToastStore.getState().addToast("error", `Unable to open git menu: ${formatError(err)}`);
      });
    },
    [
      isStaged,
      onChangeHistory,
      onCopyPath,
      onDiscardFile,
      onOpenFile,
      onOpenInExplorer,
      onRemoveFile,
      onStageFile,
      onStopTracking,
      onUnstageFile,
      t,
    ],
  );

  return (
    <div className="flex flex-col" style={{ width: "100%" }}>
      {/* Section Header */}
      <div
        className="flex items-center justify-between cursor-pointer transition-colors hover:bg-hover-overlay/[0.02]"
        style={{ padding: "6px 16px" }}
        onClick={() => setCollapsed(!collapsed)}
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
            {label}
          </span>
          <span
            className="flex items-center justify-center"
            style={{
              fontSize: 9,
              fontWeight: 700,
              color: countColor,
              backgroundColor: countBg,
              borderRadius: 8,
              padding: "1px 6px",
            }}
          >
            {count}
          </span>
        </div>
        <div className="flex items-center" style={{ gap: 2 }}>
          {onStageAll && (
            <button
              onClick={(e) => {
                e.stopPropagation();
                onStageAll();
              }}
              className="flex items-center justify-center rounded transition-colors hover:bg-hover-overlay/[0.07]"
              style={{ width: 22, height: 22 }}
              title="Stage all"
            >
              <Plus size={13} style={{ color: "var(--color-muted)" }} />
            </button>
          )}
          {onUnstageAll && (
            <button
              onClick={(e) => {
                e.stopPropagation();
                onUnstageAll();
              }}
              className="flex items-center justify-center rounded transition-colors hover:bg-hover-overlay/[0.07]"
              style={{ width: 22, height: 22 }}
              title="Unstage all"
            >
              <Minus size={13} style={{ color: "var(--color-muted)" }} />
            </button>
          )}
        </div>
      </div>

      {/* File List */}
      {!collapsed && (
        <div className="flex flex-col" style={{ padding: "0 4px" }}>
          {files.map((file) => (
            <FileRow
              key={`${file.path}-${file.is_staged}`}
              file={file}
              diffStat={fileDiffStats.get(file.path)}
              isSelected={selectedFile === file.path}
              onSelect={() => onSelectFile(file.path)}
              onDiff={() => onDiffFile(file.path, isStaged)}
              onStage={onStageFile ? () => onStageFile(file.path) : undefined}
              onUnstage={onUnstageFile ? () => onUnstageFile(file.path) : undefined}
              onDiscard={onDiscardFile ? () => onDiscardFile(file.path) : undefined}
              onContextMenu={(e) => handleContextMenu(e, file.path)}
            />
          ))}
        </div>
      )}
    </div>
  );
}

// ── Exports ─────────────────────────────────────────────────────────

export { GitFileSection, FileRow, getStatusBadge, getFileName };
