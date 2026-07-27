import { useState, useEffect, useCallback, useMemo, useRef } from "react";
import { useTranslation } from "react-i18next";
import {
  GitBranch,
  GitPullRequest,
  RefreshCw,
  X,
  Download,
  Upload,
  Archive,
  ChevronDown,
  Loader2,
  List,
  FolderTree,
} from "lucide-react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import { useGitStore } from "@/stores/git-store";
import { useToastStore } from "@/stores/toast-store";
import { useWorkspaceStore } from "@/stores/workspace-store";
import { useAppStore } from "@/stores";
import { GitFileSection } from "./git-file-list";
import { GitFileTreeView } from "./git-file-tree";
import { GitCommitInput } from "./git-commit-input";
import { GitStatusBar } from "./git-status-bar";
import { GitHistorySection } from "./git-history-section";
import { GitCommitDetail } from "./git-commit-detail";
import { GitHistoryModal } from "./git-history-modal";
import { GitCloneAuthDialog } from "./git-clone-auth-dialog";
import { PrModal } from "./pr-modal";
import { usePrStore } from "@/stores/pr-store";
import {
  defaultGitUsernameFromUrl,
  getGitHost,
  getGitPlatformFromUrl,
  isGitAuthFailure,
  isHttpGitUrl,
  type GitAuthCredentials,
} from "@/lib/git-clone-auth";
import { useSettingsStore } from "@/stores/settings-store";

// ── Utilities ───────────────────────────────────────────────────────

// Smoothly animates a number toward `target` using requestAnimationFrame
// + easeOutExpo. Returns the interpolated integer value each frame.
// Duration scales with the magnitude of the change (bounded) so a delta
// of 100 lines feels weightier than a delta of 2.
// `flashKey` increments whenever an animation starts — consumers can
// key a CSS animation off it to flash/scale on change.
function useAnimatedNumber(target: number): { value: number; flashKey: number } {
  const [value, setValue] = useState(target);
  const fromRef = useRef(target);
  const targetRef = useRef(target);
  const rafRef = useRef<number | null>(null);
  const [flashKey, setFlashKey] = useState(0);

  useEffect(() => {
    if (target === targetRef.current) return;
    fromRef.current = value;
    targetRef.current = target;
    // Scale duration with delta magnitude so small changes feel snappy
    // and large changes breathe. Bounded to [650ms, 1400ms].
    const delta = Math.abs(target - fromRef.current);
    const duration = Math.min(1400, Math.max(650, 650 + delta * 12));
    const startedAt = performance.now();
    setFlashKey((k) => k + 1);
    const tick = (now: number) => {
      const elapsed = now - startedAt;
      const t = Math.min(1, elapsed / duration);
      // easeOutExpo — decelerates gracefully near the end
      const eased = t === 1 ? 1 : 1 - Math.pow(2, -10 * t);
      const next = Math.round(fromRef.current + (target - fromRef.current) * eased);
      setValue(next);
      if (t < 1) {
        rafRef.current = requestAnimationFrame(tick);
      }
    };
    if (rafRef.current != null) cancelAnimationFrame(rafRef.current);
    rafRef.current = requestAnimationFrame(tick);
    return () => {
      if (rafRef.current != null) cancelAnimationFrame(rafRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [target]);

  return { value, flashKey };
}

function isAbsoluteFilePath(filePath: string): boolean {
  return filePath.startsWith("/") || /^[A-Za-z]:[\\/]/.test(filePath);
}

function joinWorkspacePath(workspacePath: string, filePath: string): string {
  const sep = workspacePath.includes("\\") ? "\\" : "/";
  return `${workspacePath.replace(/[\\/]$/, "")}${sep}${filePath}`;
}

function getWorkspacePathCandidates(workspacePath: string, filePath: string): readonly string[] {
  if (isAbsoluteFilePath(filePath)) return [filePath];
  const sep = workspacePath.includes("\\") ? "\\" : "/";
  const workspaceRoot = workspacePath.replace(/[\\/]$/, "");
  const primary = joinWorkspacePath(workspacePath, filePath);
  const workspaceName = workspaceRoot.split(/[\\/]/).pop();
  const firstSegment = filePath.split(/[\\/]/)[0];
  const candidates = [primary];
  if (workspaceName && firstSegment === workspaceName) {
    const parentIndex = Math.max(workspaceRoot.lastIndexOf("/"), workspaceRoot.lastIndexOf("\\"));
    const parent = parentIndex >= 0 ? workspaceRoot.slice(0, parentIndex) : "";
    if (parent) candidates.push(`${parent}${sep}${filePath}`);
  }
  return Array.from(new Set(candidates));
}

async function pathExists(path: string): Promise<boolean> {
  try {
    return await invoke<boolean>("path_exists", { path });
  } catch {
    return false;
  }
}

async function contentMatches(path: string, expectedContent: string | undefined): Promise<boolean> {
  if (expectedContent === undefined) return true;
  try {
    return (await invoke<string>("read_file_content", { path })) === expectedContent;
  } catch {
    return false;
  }
}

async function resolveWorkspacePath(
  workspacePath: string,
  filePath: string,
  options?: { readonly allowFallback?: boolean; readonly expectedContent?: string },
): Promise<string> {
  const [primary = filePath, ...fallbacks] = getWorkspacePathCandidates(workspacePath, filePath);
  if (await pathExists(primary)) return primary;
  if (!options?.allowFallback) return primary;

  for (const candidate of fallbacks) {
    try {
      if (
        (await pathExists(candidate)) &&
        (await contentMatches(candidate, options.expectedContent))
      ) {
        return candidate;
      }
    } catch {
      // Fall back to the primary candidate if path probing fails.
    }
  }
  return primary;
}

// ── Panel Header ────────────────────────────────────────────────────

function PanelHeader({
  onClose,
  onRefresh,
  isRefreshing,
  fileViewMode,
  onSetFileViewMode,
}: {
  readonly onClose: () => void;
  readonly onRefresh: () => void;
  readonly isRefreshing: boolean;
  readonly fileViewMode: "list" | "tree";
  readonly onSetFileViewMode: (mode: "list" | "tree") => void;
}) {
  const { t } = useTranslation();
  return (
    <div
      className="flex items-center justify-between shrink-0"
      style={{
        height: 52,
        padding: "0 16px",
        borderBottom: "1px solid var(--color-border)",
      }}
    >
      <div className="flex items-center" style={{ gap: 8 }}>
        <GitBranch size={16} style={{ color: "var(--color-accent-purple)" }} />
        <span
          className="text-[13px] font-semibold font-sans"
          style={{ color: "var(--color-foreground)" }}
        >
          {t("git.title")}
        </span>
      </div>
      <div className="flex items-center" style={{ gap: 2 }}>
        <button
          onClick={() => onSetFileViewMode("tree")}
          className="flex items-center justify-center rounded transition-colors"
          style={{
            width: 28,
            height: 28,
            backgroundColor:
              fileViewMode === "tree" ? "rgba(var(--theme-accent-rgb),0.08)" : undefined,
          }}
          title={t("git.viewTree")}
        >
          <FolderTree
            size={14}
            style={{
              color: fileViewMode === "tree" ? "var(--color-accent-purple)" : "var(--color-muted)",
            }}
          />
        </button>
        <button
          onClick={() => onSetFileViewMode("list")}
          className="flex items-center justify-center rounded transition-colors"
          style={{
            width: 28,
            height: 28,
            backgroundColor:
              fileViewMode === "list" ? "rgba(var(--theme-accent-rgb),0.08)" : undefined,
          }}
          title={t("git.viewList")}
        >
          <List
            size={14}
            style={{
              color: fileViewMode === "list" ? "var(--color-accent-purple)" : "var(--color-muted)",
            }}
          />
        </button>
        <div style={{ width: 2 }} />
        <button
          onClick={onRefresh}
          disabled={isRefreshing}
          className="flex items-center justify-center rounded transition-colors hover:bg-hover-overlay/[0.06] disabled:opacity-50"
          style={{ width: 28, height: 28 }}
          title={t("git.refresh")}
        >
          <RefreshCw
            size={14}
            className={`text-muted transition-colors group-hover:text-muted-foreground${isRefreshing ? " animate-spin" : ""}`}
          />
        </button>
        <button
          onClick={onClose}
          className="flex items-center justify-center rounded transition-colors hover:bg-hover-overlay/[0.06]"
          style={{ width: 28, height: 28 }}
          title={t("git.closePanel")}
        >
          <X size={14} className="text-muted" />
        </button>
      </div>
    </div>
  );
}

// ── Branch Item ─────────────────────────────────────────────────────

function BranchItem({
  name,
  isCurrent,
  ahead,
  behind,
  onClick,
}: {
  readonly name: string;
  readonly isCurrent: boolean;
  readonly ahead: number;
  readonly behind: number;
  readonly onClick: () => void;
}) {
  const { t } = useTranslation();

  return (
    <button
      onClick={isCurrent ? undefined : onClick}
      className="flex items-center justify-between native-css-hover"
      style={
        {
          padding: "5px 8px",
          borderRadius: 5,
          cursor: isCurrent ? "default" : "pointer",
          backgroundColor: isCurrent ? "var(--color-border-subtle)" : "transparent",
          border: "none",
          "--native-hover-bg-color": !isCurrent ? "var(--color-border-subtle)" : undefined,
        } as React.CSSProperties
      }
    >
      <div className="flex items-center min-w-0" style={{ gap: 6 }}>
        <GitBranch
          size={12}
          style={{ color: isCurrent ? "#22C55E" : "var(--color-muted)", flexShrink: 0 }}
        />
        <span
          className="text-[11px] font-mono truncate"
          style={{ color: isCurrent ? "var(--color-foreground)" : "var(--color-muted-foreground)" }}
        >
          {name}
        </span>
        {isCurrent && (
          <span
            className="text-[9px] font-sans font-semibold shrink-0"
            style={{
              color: "#22C55E",
              backgroundColor: "#22C55E20",
              borderRadius: 4,
              padding: "1px 5px",
            }}
          >
            {t("git.currentBranch")}
          </span>
        )}
      </div>
      {!isCurrent && (ahead > 0 || behind > 0) && (
        <div className="flex items-center shrink-0" style={{ gap: 6 }}>
          {ahead > 0 && (
            <span className="text-[9px] font-mono" style={{ color: "var(--color-muted)" }}>
              ↑{ahead}
            </span>
          )}
          {behind > 0 && (
            <span className="text-[9px] font-mono" style={{ color: "#E5C07B" }}>
              ↓{behind}
            </span>
          )}
        </div>
      )}
    </button>
  );
}

// ── Branch Bar ──────────────────────────────────────────────────────

function BranchBar({ onSwitchBranch }: { readonly onSwitchBranch: (name: string) => void }) {
  const { t } = useTranslation();
  const gitInfo = useGitStore((s) => s.gitInfo);
  const branches = useGitStore((s) => s.branches);
  const fileDiffStats = useGitStore((s) => s.fileDiffStats);
  const [open, setOpen] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLDivElement>(null);

  const { totalAdditions, totalDeletions } = useMemo(() => {
    let add = 0;
    let del = 0;
    for (const stat of fileDiffStats.values()) {
      add += stat.additions;
      del += stat.deletions;
    }
    return { totalAdditions: add, totalDeletions: del };
  }, [fileDiffStats]);

  const animatedAdd = useAnimatedNumber(totalAdditions);
  const animatedDel = useAnimatedNumber(totalDeletions);

  useEffect(() => {
    if (!open) return;
    const handleClickOutside = (e: MouseEvent) => {
      if (
        dropdownRef.current &&
        !dropdownRef.current.contains(e.target as Node) &&
        triggerRef.current &&
        !triggerRef.current.contains(e.target as Node)
      ) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [open]);

  if (!gitInfo) return null;

  const localBranches = branches.filter((b) => !b.is_remote);
  const remoteBranches = branches.filter((b) => b.is_remote);

  const handleSwitch = (name: string) => {
    setOpen(false);
    onSwitchBranch(name);
  };

  return (
    <div
      className="flex items-center justify-between shrink-0"
      style={{
        padding: "10px 16px",
        borderBottom: "1px solid var(--color-border)",
        position: "relative",
      }}
    >
      <div
        ref={triggerRef}
        className="flex items-center cursor-pointer"
        style={{ gap: 8 }}
        onClick={() => setOpen((v) => !v)}
        title={t("git.switchBranch")}
      >
        <GitBranch size={14} style={{ color: "#22C55E" }} />
        <span
          className="text-[12px] font-medium font-mono"
          style={{ color: "var(--color-foreground)" }}
        >
          {gitInfo.branch ?? t("git.detached")}
        </span>
        <ChevronDown
          size={12}
          style={{
            color: "var(--color-muted)",
            transform: open ? "rotate(180deg)" : undefined,
            transition: "transform 150ms",
          }}
        />
      </div>
      {(totalAdditions > 0 || totalDeletions > 0) && (
        <div
          className="flex items-center"
          style={{ gap: 6 }}
          title={t("git.totalDiffStats", "Total changes: +{{add}} -{{del}}", {
            add: totalAdditions,
            del: totalDeletions,
          })}
        >
          {totalAdditions > 0 && (
            <span
              key={`add-${animatedAdd.flashKey}`}
              className="diff-stat-flash text-[11px] font-mono font-medium"
              style={{ color: "#22C55E" }}
            >
              +{animatedAdd.value}
            </span>
          )}
          {totalDeletions > 0 && (
            <span
              key={`del-${animatedDel.flashKey}`}
              className="diff-stat-flash text-[11px] font-mono font-medium"
              style={{ color: "#EF4444" }}
            >
              -{animatedDel.value}
            </span>
          )}
        </div>
      )}

      {/* Branch dropdown */}
      {open && (
        <div
          ref={dropdownRef}
          className="flex flex-col"
          style={{
            position: "absolute",
            top: "calc(100% + 2px)",
            left: 12,
            right: 12,
            maxHeight: 280,
            overflowY: "auto",
            padding: 4,
            borderRadius: 8,
            backgroundColor: "var(--color-surface-raised)",
            border: "1px solid var(--color-border-light)",
            boxShadow: "0 4px 16px rgba(0,0,0,0.25)",
            zIndex: 50,
          }}
        >
          {localBranches.length > 0 && (
            <>
              <span
                className="text-[10px] font-semibold font-sans"
                style={{ color: "var(--color-muted)", padding: "6px 8px 2px" }}
              >
                {t("git.localBranches")}
              </span>
              {localBranches.map((b) => (
                <BranchItem
                  key={b.name}
                  name={b.name}
                  isCurrent={b.is_current}
                  ahead={b.ahead}
                  behind={b.behind}
                  onClick={() => handleSwitch(b.name)}
                />
              ))}
            </>
          )}
          {remoteBranches.length > 0 && (
            <>
              <span
                className="text-[10px] font-semibold font-sans"
                style={{
                  color: "var(--color-muted)",
                  padding: localBranches.length > 0 ? "8px 8px 2px" : "6px 8px 2px",
                }}
              >
                {t("git.remoteBranches")}
              </span>
              {remoteBranches.map((b) => (
                <BranchItem
                  key={b.name}
                  name={b.name}
                  isCurrent={false}
                  ahead={0}
                  behind={0}
                  onClick={() => handleSwitch(b.name)}
                />
              ))}
            </>
          )}
        </div>
      )}
    </div>
  );
}

// ── Quick Action Button ─────────────────────────────────────────────

function QuickActionBtn({
  onClick,
  icon,
  label,
  badge,
  loading,
}: {
  readonly onClick: () => void;
  readonly icon: React.ReactNode;
  readonly label: string;
  readonly badge?: number;
  readonly loading?: boolean;
}) {
  return (
    <button
      onClick={onClick}
      disabled={loading}
      className="flex items-center justify-center native-css-hover"
      style={
        {
          flex: 1,
          gap: 6,
          padding: "6px 0",
          borderRadius: 6,
          backgroundColor: "var(--color-card)",
          border: "1px solid var(--color-border-light)",
          cursor: loading ? "not-allowed" : "pointer",
          opacity: loading ? 0.7 : 1,
          position: "relative",
          "--native-hover-bg-color": !loading ? "var(--color-border-subtle)" : undefined,
          "--native-hover-border-color": !loading ? "var(--color-border-strong)" : undefined,
        } as React.CSSProperties
      }
    >
      <span
        className="native-css-hover-target"
        style={
          {
            color: "var(--color-muted)",
            "--native-hover-color": !loading ? "var(--color-muted-foreground)" : undefined,
          } as React.CSSProperties
        }
      >
        {loading ? <Loader2 size={13} className="animate-spin" /> : icon}
      </span>
      <span
        className="text-[11px] font-medium font-sans native-css-hover-target"
        style={
          {
            color: loading ? "var(--color-muted)" : "var(--color-muted-foreground)",
            "--native-hover-color": !loading ? "var(--color-foreground)" : undefined,
          } as React.CSSProperties
        }
      >
        {label}
      </span>
      {!loading && badge != null && badge > 0 && (
        <span
          className="flex items-center justify-center text-[9px] font-bold font-mono"
          style={{
            position: "absolute",
            top: -5,
            right: -5,
            minWidth: 16,
            height: 16,
            borderRadius: 8,
            padding: "0 4px",
            backgroundColor: "#A855F7",
            color: "#FFFFFF",
          }}
        >
          {badge}
        </span>
      )}
    </button>
  );
}

// ── Quick Actions ───────────────────────────────────────────────────

function QuickActions({
  onPull,
  onPush,
  onStash,
  onOpenPr,
  isPulling,
  isPushing,
  isStashing,
}: {
  readonly onPull: () => void;
  readonly onPush: () => void;
  readonly onStash: () => void;
  readonly onOpenPr: () => void;
  readonly isPulling: boolean;
  readonly isPushing: boolean;
  readonly isStashing: boolean;
}) {
  const { t } = useTranslation();
  const ahead = useGitStore((s) => s.gitInfo?.ahead ?? 0);
  const behind = useGitStore((s) => s.gitInfo?.behind ?? 0);
  return (
    <div
      className="flex items-center shrink-0"
      style={{
        gap: 8,
        padding: "8px 12px",
        borderBottom: "1px solid var(--color-border)",
      }}
    >
      {(
        [
          {
            action: onPull,
            icon: <Download size={13} />,
            label: t("git.pull"),
            badge: behind,
            loading: isPulling,
          },
          {
            action: onPush,
            icon: <Upload size={13} />,
            label: t("git.push"),
            badge: ahead,
            loading: isPushing,
          },
          {
            action: onStash,
            icon: <Archive size={13} />,
            label: t("git.stash"),
            badge: undefined,
            loading: isStashing,
          },
          {
            action: onOpenPr,
            icon: <GitPullRequest size={13} />,
            label: t("git.pr.short"),
            badge: undefined,
            loading: false,
          },
        ] as const
      ).map(({ action, icon, label, badge, loading }) => (
        <QuickActionBtn
          key={label}
          onClick={action}
          icon={icon}
          label={label}
          badge={badge}
          loading={loading}
        />
      ))}
    </div>
  );
}

// ── Main Panel ──────────────────────────────────────────────────────

export function GitPanel() {
  const { t } = useTranslation();
  const workspace = useWorkspaceStore((s) => s.activeWorkspace);
  const gitInfo = useGitStore((s) => s.gitInfo);
  const fileStatuses = useGitStore((s) => s.fileStatuses);
  const fileDiffStats = useGitStore((s) => s.fileDiffStats);
  const isLoading = useGitStore((s) => s.isLoading);
  const togglePanel = useGitStore((s) => s.togglePanel);
  const fileViewMode = useGitStore((s) => s.fileViewMode);
  const setFileViewMode = useGitStore((s) => s.setFileViewMode);

  const refreshGitInfo = useGitStore((s) => s.refreshGitInfo);
  const fetchRemote = useGitStore((s) => s.fetchRemote);
  const loadFileStatuses = useGitStore((s) => s.loadFileStatuses);
  const stageFiles = useGitStore((s) => s.stageFiles);
  const unstageFiles = useGitStore((s) => s.unstageFiles);
  const discardFiles = useGitStore((s) => s.discardFiles);
  const commit = useGitStore((s) => s.commit);
  const pull = useGitStore((s) => s.pull);
  const push = useGitStore((s) => s.push);
  const stashSave = useGitStore((s) => s.stashSave);
  const isPulling = useGitStore((s) => s.isPulling);
  const isPushing = useGitStore((s) => s.isPushing);
  const isStashing = useGitStore((s) => s.isStashing);
  const logEntries = useGitStore((s) => s.logEntries);
  const loadLog = useGitStore((s) => s.loadLog);
  const loadBranches = useGitStore((s) => s.loadBranches);
  const commitDetail = useGitStore((s) => s.commitDetail);
  const loadCommitDetail = useGitStore((s) => s.loadCommitDetail);
  const clearCommitDetail = useGitStore((s) => s.clearCommitDetail);
  const switchBranch = useGitStore((s) => s.switchBranch);

  const workspacePath = workspace?.path ?? null;

  // Load local data progressively when panel opens to avoid blocking the UI.
  // Network operations are reserved for explicit user actions.
  useEffect(() => {
    if (!workspacePath) return;
    // Critical: load file statuses first (drives the main panel view)
    loadFileStatuses(workspacePath);
    // Deferred: load history & branches after the status list has had a chance to render
    const deferTimer = setTimeout(() => {
      loadLog(workspacePath, 50);
      loadBranches(workspacePath);
    }, 80);
    return () => {
      clearTimeout(deferTimer);
    };
  }, [workspacePath, loadFileStatuses, loadLog, loadBranches]);

  // Auto-refresh when workspace files change (e.g. external editor saves)
  useEffect(() => {
    if (!workspacePath) return;

    let debounceTimer: ReturnType<typeof setTimeout> | null = null;

    const unlisten = listen<{ path: string; change_type: string }>("file-changed", (event) => {
      const changedPath = event.payload.path;
      if (!changedPath.startsWith(workspacePath)) return;
      const charAfter = changedPath[workspacePath.length];
      if (charAfter !== undefined && charAfter !== "/" && charAfter !== "\\") return;
      const relative = changedPath.slice(workspacePath.length);
      if (
        relative.includes("/.git/") ||
        relative.includes("\\.git\\") ||
        relative.endsWith("/.git") ||
        relative.endsWith("\\.git")
      )
        return;

      if (debounceTimer) clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => {
        loadFileStatuses(workspacePath);
        refreshGitInfo(workspacePath);
      }, 500);
    });

    return () => {
      if (debounceTimer) clearTimeout(debounceTimer);
      unlisten.then((fn) => fn());
    };
  }, [workspacePath, loadFileStatuses, refreshGitInfo]);

  const changesFiles = useMemo(() => fileStatuses.filter((f) => !f.is_staged), [fileStatuses]);
  const stagedFiles = useMemo(() => fileStatuses.filter((f) => f.is_staged), [fileStatuses]);

  // Keep a ref to changesFiles so commit callbacks don't depend on the array identity
  const changesFilesRef = useRef(changesFiles);
  changesFilesRef.current = changesFiles;

  const [selectedFile, setSelectedFile] = useState<string | null>(null);
  const [selectedCommit, setSelectedCommit] = useState<string | null>(null);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [historyModalFile, setHistoryModalFile] = useState<string | null>(null);

  // Credential prompt for push/pull HTTPS auth failures. Reuses the same dialog
  // as clone; `pendingAuthAction` records which operation to retry on submit.
  const [authDialogOpen, setAuthDialogOpen] = useState(false);
  const [authRepoUrl, setAuthRepoUrl] = useState("");
  const [authError, setAuthError] = useState("");
  const [isVerifyingAuth, setIsVerifyingAuth] = useState(false);
  const pendingAuthAction = useRef<"push" | "pull" | null>(null);

  const handleRefresh = useCallback(async () => {
    if (!workspacePath || isRefreshing) return;
    setIsRefreshing(true);
    try {
      // Fetch only after the user explicitly requests a refresh. This can
      // perform network I/O and update remote-tracking refs.
      await fetchRemote(workspacePath);
      await Promise.all([
        refreshGitInfo(workspacePath),
        loadFileStatuses(workspacePath),
        loadLog(workspacePath, 50),
        loadBranches(workspacePath),
      ]);
      useToastStore.getState().addToast("info", t("git.refreshCompleted", "Refresh completed"));
    } catch {
      useToastStore.getState().addToast("error", t("git.refreshFailed", "Refresh failed"));
    } finally {
      setIsRefreshing(false);
    }
  }, [
    workspacePath,
    isRefreshing,
    fetchRemote,
    refreshGitInfo,
    loadFileStatuses,
    loadLog,
    loadBranches,
    t,
  ]);

  const handleSwitchBranch = useCallback(
    (name: string) => {
      if (!workspacePath) return;
      switchBranch(workspacePath, name).then(() => {
        loadLog(workspacePath, 50);
        loadBranches(workspacePath);
      });
    },
    [workspacePath, switchBranch, loadLog, loadBranches],
  );

  const handleDiffFile = useCallback(
    async (filePath: string, staged: boolean) => {
      if (!workspacePath) return;
      try {
        const contents = await invoke<{ original: string; modified: string }>("get_diff_contents", {
          path: workspacePath,
          filePath,
          staged,
        });
        const status =
          fileStatuses.find((file) => file.path === filePath && file.is_staged === staged)
            ?.status ?? fileStatuses.find((file) => file.path === filePath)?.status;
        const fullPath = await resolveWorkspacePath(workspacePath, filePath, {
          allowFallback: status !== "deleted",
          expectedContent: staged ? undefined : contents.modified,
        });
        const appStore = useAppStore.getState();
        appStore.setFileDiffOverlay(fullPath, {
          filePath: fullPath,
          original: contents.original,
          modified: contents.modified,
          canWriteBack: !staged,
          relativePath: filePath,
          staged,
        });
        appStore.openFile(fullPath);
        setSelectedFile(filePath);
      } catch (err) {
        useToastStore.getState().addToast("error", `Failed to load diff: ${err}`);
      }
    },
    [fileStatuses, workspacePath],
  );

  const handleStageFile = useCallback(
    (filePath: string) => {
      if (!workspacePath) return;
      stageFiles(workspacePath, [filePath]);
    },
    [workspacePath, stageFiles],
  );

  const handleUnstageFile = useCallback(
    (filePath: string) => {
      if (!workspacePath) return;
      unstageFiles(workspacePath, [filePath]);
    },
    [workspacePath, unstageFiles],
  );

  const handleDiscardFile = useCallback(
    (filePath: string) => {
      if (!workspacePath) return;
      discardFiles(workspacePath, [filePath]);
    },
    [workspacePath, discardFiles],
  );

  // ── Context menu handlers ──────────────────────────────────────────

  const handleOpenFile = useCallback(
    async (filePath: string) => {
      if (!workspacePath) return;
      const status = fileStatuses.find((file) => file.path === filePath)?.status;
      const fullPath = await resolveWorkspacePath(workspacePath, filePath, {
        allowFallback: status !== "deleted",
      });
      useAppStore.getState().openFile(fullPath);
    },
    [fileStatuses, workspacePath],
  );

  const handleOpenInExplorer = useCallback(
    async (filePath: string) => {
      if (!workspacePath) return;
      const status = fileStatuses.find((file) => file.path === filePath)?.status;
      const fullPath = await resolveWorkspacePath(workspacePath, filePath, {
        allowFallback: status !== "deleted",
      });
      revealItemInDir(fullPath).catch((err) => {
        useToastStore.getState().addToast("error", `${err}`);
      });
    },
    [fileStatuses, workspacePath],
  );

  const handleCopyPath = useCallback(
    (filePath: string) => {
      navigator.clipboard
        .writeText(filePath)
        .then(() => {
          useToastStore.getState().addToast("info", t("git.fileCtx.pathCopied"));
        })
        .catch(() => {});
    },
    [t],
  );

  const handleRemoveFile = useCallback(
    async (filePath: string) => {
      if (!workspacePath) return;
      const fullPath = await resolveWorkspacePath(workspacePath, filePath, {
        allowFallback: false,
      });
      invoke("delete_entry", { path: fullPath })
        .then(() => loadFileStatuses(workspacePath))
        .catch((err) => {
          useToastStore.getState().addToast("error", `${err}`);
        });
    },
    [workspacePath, loadFileStatuses],
  );

  const handleStopTracking = useCallback(
    (filePath: string) => {
      if (!workspacePath) return;
      invoke("git_rm_cached", { path: workspacePath, files: [filePath] })
        .then(() => loadFileStatuses(workspacePath))
        .catch((err) => {
          useToastStore.getState().addToast("error", `${err}`);
        });
    },
    [workspacePath, loadFileStatuses],
  );

  const handleChangeHistory = useCallback(
    (filePath: string) => {
      if (!workspacePath) return;
      setHistoryModalFile(filePath);
    },
    [workspacePath],
  );

  const handleStageAll = useCallback(() => {
    if (!workspacePath) return;
    const paths = changesFiles.map((f) => f.path);
    if (paths.length > 0) stageFiles(workspacePath, [...paths]);
  }, [workspacePath, changesFiles, stageFiles]);

  const handleUnstageAll = useCallback(() => {
    if (!workspacePath) return;
    const paths = stagedFiles.map((f) => f.path);
    if (paths.length > 0) unstageFiles(workspacePath, [...paths]);
  }, [workspacePath, stagedFiles, unstageFiles]);

  const handleCommit = useCallback(
    async (message: string) => {
      if (!workspacePath) return;
      const unstaged = changesFilesRef.current.map((f) => f.path);
      if (unstaged.length > 0) {
        await stageFiles(workspacePath, [...unstaged]);
      }
      await commit(workspacePath, message);
    },
    [workspacePath, stageFiles, commit],
  );

  // When push/pull fails with an authentication error, resolve the remote URL
  // and either prompt for credentials (HTTPS) or surface a toast (SSH — which a
  // username/password can't fix). Non-auth errors are rethrown so the store's
  // existing toast remains the single source of feedback.
  const openAuthForFailure = useCallback(
    async (action: "push" | "pull", err: unknown) => {
      if (!isGitAuthFailure(err) || !workspacePath) throw err;
      const url = await invoke<string | null>("git_get_remote_url", {
        path: workspacePath,
      }).catch(() => null);
      const authFailedMsg = t(
        "gitClone.auth.authFailed",
        "Authentication failed. Check your username and password or token.",
      );
      if (url && !isHttpGitUrl(url)) {
        useToastStore.getState().addToast("error", authFailedMsg);
        return;
      }
      pendingAuthAction.current = action;
      setAuthRepoUrl(url ?? "");
      setAuthError(authFailedMsg);
      setIsVerifyingAuth(false);
      setAuthDialogOpen(true);
    },
    [workspacePath, t],
  );

  // Retry the pending push/pull with the entered credentials. On success,
  // optionally persist them (same platform/host logic as the clone prompt) so
  // subsequent operations authenticate silently. On failure, keep the dialog
  // open and show the error.
  const handleAuthSubmit = useCallback(
    async (credentials: GitAuthCredentials, remember: boolean) => {
      const action = pendingAuthAction.current;
      if (!workspacePath || !action) return;
      setIsVerifyingAuth(true);
      setAuthError("");
      try {
        if (action === "push") {
          await push(workspacePath, credentials);
        } else {
          await pull(workspacePath, credentials);
        }
        if (remember) {
          const settings = useSettingsStore.getState();
          const platform = getGitPlatformFromUrl(authRepoUrl);
          if (platform) {
            settings.setGitToken(platform, credentials.password);
            if (credentials.username) settings.setGitUsername(platform, credentials.username);
          } else {
            const host = getGitHost(authRepoUrl);
            if (host) {
              settings.setGitHostCredential(host, credentials.username ?? "", credentials.password);
            }
          }
        }
        setAuthDialogOpen(false);
        pendingAuthAction.current = null;
      } catch (err) {
        setAuthError(
          isGitAuthFailure(err)
            ? t("gitClone.auth.invalid", "Unable to authenticate with these credentials.")
            : String(err),
        );
      } finally {
        setIsVerifyingAuth(false);
      }
    },
    [workspacePath, authRepoUrl, push, pull, t],
  );

  const handleCommitAndPush = useCallback(
    async (message: string) => {
      if (!workspacePath) return;
      const unstaged = changesFilesRef.current.map((f) => f.path);
      if (unstaged.length > 0) {
        await stageFiles(workspacePath, [...unstaged]);
      }
      await commit(workspacePath, message);
      try {
        await push(workspacePath);
      } catch (err) {
        // Only the push leg can hit auth failure; commit errors already threw above.
        await openAuthForFailure("push", err);
      }
    },
    [workspacePath, stageFiles, commit, push, openAuthForFailure],
  );

  const handlePull = useCallback(() => {
    if (!workspacePath) return;
    pull(workspacePath).catch((err) => {
      openAuthForFailure("pull", err).catch(() => {
        // Non-auth errors already surfaced by the store toast.
      });
    });
  }, [workspacePath, pull, openAuthForFailure]);

  const handlePush = useCallback(() => {
    if (!workspacePath) return;
    push(workspacePath).catch((err) => {
      openAuthForFailure("push", err).catch(() => {
        // Non-auth errors already surfaced by the store toast.
      });
    });
  }, [workspacePath, push, openAuthForFailure]);

  const handleStash = useCallback(() => {
    if (!workspacePath) return;
    stashSave(workspacePath);
  }, [workspacePath, stashSave]);

  const openPrModal = usePrStore((s) => s.openModal);
  const isPrModalOpen = usePrStore((s) => s.isModalOpen);
  const handleOpenPr = useCallback(() => {
    if (!workspacePath) return;
    openPrModal(workspacePath);
  }, [workspacePath, openPrModal]);

  const handleSelectCommit = useCallback(
    (commitId: string) => {
      setSelectedCommit(commitId);
      if (!workspacePath) return;
      loadCommitDetail(workspacePath, commitId);
    },
    [workspacePath, loadCommitDetail],
  );

  const handleViewDetail = useCallback(
    (commitId: string) => {
      if (!workspacePath) return;
      loadCommitDetail(workspacePath, commitId);
    },
    [workspacePath, loadCommitDetail],
  );

  if (!gitInfo || !gitInfo.is_git_repo) {
    return (
      <div
        className="flex flex-col items-center justify-center h-full"
        style={{ color: "var(--color-muted)", fontSize: 13 }}
      >
        {t("git.noChanges")}
      </div>
    );
  }

  return (
    <div className="flex h-full overflow-hidden">
      {/* Left: Commit detail view */}
      {commitDetail && (
        <div className="flex-1 min-w-0 overflow-hidden">
          <GitCommitDetail detail={commitDetail} onClose={clearCommitDetail} />
        </div>
      )}

      {/* Right: Git Panel (320px) */}
      <div
        className="flex flex-col shrink-0 overflow-hidden"
        style={{
          width: 320,
          height: "100%",
          background: "var(--color-background)",
          borderLeft: commitDetail ? "1px solid var(--color-border)" : undefined,
        }}
      >
        <PanelHeader
          onClose={togglePanel}
          onRefresh={handleRefresh}
          isRefreshing={isRefreshing}
          fileViewMode={fileViewMode}
          onSetFileViewMode={setFileViewMode}
        />
        <BranchBar onSwitchBranch={handleSwitchBranch} />
        <QuickActions
          onPull={handlePull}
          onPush={handlePush}
          onStash={handleStash}
          onOpenPr={handleOpenPr}
          isPulling={isPulling}
          isPushing={isPushing}
          isStashing={isStashing}
        />

        {/* Scrollable file lists */}
        <div className="flex-1 overflow-y-auto min-h-0">
          {changesFiles.length > 0 &&
            (fileViewMode === "tree" ? (
              <GitFileTreeView
                label={t("git.changes")}
                count={changesFiles.length}
                files={changesFiles}
                fileDiffStats={fileDiffStats}
                countColor="#E5C07B"
                countBg="var(--color-border-light)"
                selectedFile={selectedFile}
                onSelectFile={setSelectedFile}
                onDiffFile={handleDiffFile}
                onStageFile={handleStageFile}
                onDiscardFile={handleDiscardFile}
                onStageAll={handleStageAll}
                onOpenFile={handleOpenFile}
                onOpenInExplorer={handleOpenInExplorer}
                onCopyPath={handleCopyPath}
                onRemoveFile={handleRemoveFile}
                onStopTracking={handleStopTracking}
                onChangeHistory={handleChangeHistory}
              />
            ) : (
              <GitFileSection
                label={t("git.changes")}
                count={changesFiles.length}
                files={changesFiles}
                fileDiffStats={fileDiffStats}
                countColor="#E5C07B"
                countBg="var(--color-border-light)"
                selectedFile={selectedFile}
                onSelectFile={setSelectedFile}
                onDiffFile={handleDiffFile}
                onStageFile={handleStageFile}
                onDiscardFile={handleDiscardFile}
                onStageAll={handleStageAll}
                onOpenFile={handleOpenFile}
                onOpenInExplorer={handleOpenInExplorer}
                onCopyPath={handleCopyPath}
                onRemoveFile={handleRemoveFile}
                onStopTracking={handleStopTracking}
                onChangeHistory={handleChangeHistory}
              />
            ))}
          {stagedFiles.length > 0 &&
            (fileViewMode === "tree" ? (
              <GitFileTreeView
                label={t("git.staged")}
                count={stagedFiles.length}
                files={stagedFiles}
                fileDiffStats={fileDiffStats}
                countColor="#22C55E"
                countBg="#22C55E20"
                selectedFile={selectedFile}
                onSelectFile={setSelectedFile}
                onDiffFile={handleDiffFile}
                onUnstageFile={handleUnstageFile}
                onUnstageAll={handleUnstageAll}
                onOpenFile={handleOpenFile}
                onOpenInExplorer={handleOpenInExplorer}
                onCopyPath={handleCopyPath}
                onChangeHistory={handleChangeHistory}
              />
            ) : (
              <GitFileSection
                label={t("git.staged")}
                count={stagedFiles.length}
                files={stagedFiles}
                fileDiffStats={fileDiffStats}
                countColor="#22C55E"
                countBg="#22C55E20"
                selectedFile={selectedFile}
                onSelectFile={setSelectedFile}
                onDiffFile={handleDiffFile}
                onUnstageFile={handleUnstageFile}
                onUnstageAll={handleUnstageAll}
                onOpenFile={handleOpenFile}
                onOpenInExplorer={handleOpenInExplorer}
                onCopyPath={handleCopyPath}
                onChangeHistory={handleChangeHistory}
              />
            ))}
          {changesFiles.length === 0 && stagedFiles.length === 0 && (
            <div
              className="flex items-center justify-center"
              style={{ padding: 32, color: "var(--color-muted)", fontSize: 12 }}
            >
              {t("git.noChanges")}
            </div>
          )}
        </div>

        {/* History section (collapsible, pinned to bottom) */}
        {logEntries.length > 0 && (
          <GitHistorySection
            entries={logEntries}
            selectedCommit={selectedCommit}
            onSelectCommit={handleSelectCommit}
            onViewDetail={handleViewDetail}
          />
        )}

        {/* Commit section */}
        <GitCommitInput
          isLoading={isLoading}
          onCommit={handleCommit}
          onCommitAndPush={handleCommitAndPush}
        />

        {/* Status bar */}
        <GitStatusBar gitInfo={gitInfo} />
      </div>

      {/* History modal */}
      {historyModalFile && workspacePath && (
        <GitHistoryModal
          workspacePath={workspacePath}
          filePath={historyModalFile}
          onClose={() => setHistoryModalFile(null)}
        />
      )}

      {/* Pull request modal */}
      {isPrModalOpen && workspacePath && <PrModal workspacePath={workspacePath} />}

      {/* Credential prompt for push/pull HTTPS authentication failures */}
      <GitCloneAuthDialog
        open={authDialogOpen}
        repoUrl={authRepoUrl}
        defaultUsername={defaultGitUsernameFromUrl(authRepoUrl)}
        canRemember={isHttpGitUrl(authRepoUrl)}
        error={authError}
        isSubmitting={isVerifyingAuth}
        onCancel={() => {
          if (isVerifyingAuth) return;
          setAuthDialogOpen(false);
          pendingAuthAction.current = null;
        }}
        onSubmit={handleAuthSubmit}
      />
    </div>
  );
}
