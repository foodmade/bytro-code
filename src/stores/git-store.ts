import { create } from "zustand";
import { invoke } from "@tauri-apps/api/core";
import { useToastStore } from "./toast-store";
import { useSettingsStore } from "./settings-store";
import { formatError } from "@/lib/format-error";
import { track } from "@/lib/tracking";
import { isGitAuthFailure, type GitAuthCredentials } from "@/lib/git-clone-auth";

/** Build a flat token map for the Rust backend, including usernames. */
export function buildGitTokensMap(): Record<string, string> {
  const { gitTokens, gitUsernames, gitHostCredentials } = useSettingsStore.getState();
  const map: Record<string, string> = {
    ...gitTokens,
    github_username: gitUsernames.github,
    gitee_username: gitUsernames.gitee,
    gitlab_username: gitUsernames.gitlab,
  };
  // Self-hosted host credentials (saved from the clone auth prompt). Encoded
  // so the Rust side can match any host beyond the three built-in platforms:
  //   "host:<host>"          → token / password
  //   "host-username:<host>" → username
  for (const [host, cred] of Object.entries(gitHostCredentials)) {
    if (!cred?.token) continue;
    map[`host:${host}`] = cred.token;
    if (cred.username) map[`host-username:${host}`] = cred.username;
  }
  return map;
}

// ── Types ────────────────────────────────────────────────────────────

export interface GitInfo {
  readonly branch: string | null;
  readonly modified_count: number;
  readonly untracked_count: number;
  readonly ahead: number;
  readonly behind: number;
  readonly is_git_repo: boolean;
  readonly detached_head: boolean;
  readonly merge_in_progress: boolean;
}

export interface GitFileStatus {
  readonly path: string;
  readonly status: string;
  readonly is_staged: boolean;
  readonly old_path: string | null;
}

export interface GitDiffResult {
  readonly files: ReadonlyArray<GitDiffFile>;
  readonly total_additions: number;
  readonly total_deletions: number;
}

export interface GitDiffFile {
  readonly path: string;
  readonly old_path: string | null;
  readonly hunks: ReadonlyArray<GitDiffHunk>;
  readonly additions: number;
  readonly deletions: number;
  readonly is_binary: boolean;
}

export interface GitDiffHunk {
  readonly header: string;
  readonly lines: ReadonlyArray<GitDiffLine>;
}

export interface GitDiffLine {
  readonly content: string;
  readonly line_type: string;
  readonly old_lineno: number | null;
  readonly new_lineno: number | null;
}

export interface GitLogEntry {
  readonly id: string;
  readonly full_id: string;
  readonly message: string;
  readonly author: string;
  readonly email: string;
  readonly timestamp: number;
  readonly parent_count: number;
}

export interface CommitFileChange {
  readonly path: string;
  readonly old_path: string | null;
  readonly status: string;
  readonly additions: number;
  readonly deletions: number;
  readonly is_binary: boolean;
}

export interface CommitDetail {
  readonly id: string;
  readonly full_id: string;
  readonly message: string;
  readonly author: string;
  readonly email: string;
  readonly timestamp: number;
  readonly parent_ids: ReadonlyArray<string>;
  readonly files: ReadonlyArray<CommitFileChange>;
  readonly total_additions: number;
  readonly total_deletions: number;
}

export interface GitBranchInfo {
  readonly name: string;
  readonly is_current: boolean;
  readonly is_remote: boolean;
  readonly upstream: string | null;
  readonly ahead: number;
  readonly behind: number;
}

export interface GitStashEntry {
  readonly index: number;
  readonly message: string;
}

export interface GitPullResult {
  readonly fast_forward: boolean;
  readonly conflicts: boolean;
  readonly updated_files: number;
}

export interface FileDiffStat {
  readonly additions: number;
  readonly deletions: number;
}

// ── State ────────────────────────────────────────────────────────────

interface GitState {
  readonly gitInfo: GitInfo | null;
  readonly fileStatuses: ReadonlyArray<GitFileStatus>;
  readonly fileDiffStats: ReadonlyMap<string, FileDiffStat>;
  readonly diffResult: GitDiffResult | null;
  readonly currentFileDiff: GitDiffFile | null;
  readonly logEntries: ReadonlyArray<GitLogEntry>;
  readonly branches: ReadonlyArray<GitBranchInfo>;
  readonly stashList: ReadonlyArray<GitStashEntry>;
  readonly commitDetail: CommitDetail | null;
  readonly isPanelOpen: boolean;
  readonly activeTab: "changes" | "log" | "branches" | "stash";
  readonly isLoading: boolean;
  readonly isPulling: boolean;
  readonly isPushing: boolean;
  readonly isStashing: boolean;
  readonly fileViewMode: "list" | "tree";

  // Read operations
  readonly refreshGitInfo: (path: string) => Promise<void>;
  readonly fetchRemote: (path: string) => Promise<void>;
  readonly loadCommitDetail: (path: string, commitId: string) => Promise<void>;
  readonly clearCommitDetail: () => void;
  readonly loadFileStatuses: (path: string) => Promise<void>;
  readonly loadDiff: (path: string, staged: boolean) => Promise<void>;
  readonly loadFileDiff: (path: string, filePath: string, staged: boolean) => Promise<void>;
  readonly loadLog: (path: string, limit?: number) => Promise<void>;
  readonly loadBranches: (path: string) => Promise<void>;
  readonly loadStashList: (path: string) => Promise<void>;

  // Write operations
  readonly stageFiles: (path: string, files: string[]) => Promise<void>;
  readonly unstageFiles: (path: string, files: string[]) => Promise<void>;
  readonly discardFiles: (path: string, files: string[]) => Promise<void>;
  readonly commit: (path: string, message: string) => Promise<string>;
  readonly createBranch: (path: string, name: string) => Promise<void>;
  readonly switchBranch: (path: string, name: string) => Promise<void>;
  readonly pull: (path: string, credentials?: GitAuthCredentials) => Promise<GitPullResult>;
  readonly push: (path: string, credentials?: GitAuthCredentials) => Promise<void>;
  readonly stashSave: (path: string, message?: string) => Promise<void>;
  readonly stashPop: (path: string, index: number) => Promise<void>;
  readonly createTag: (path: string, name: string, commitId: string) => Promise<void>;
  readonly createBranchFromCommit: (path: string, name: string, commitId: string) => Promise<void>;
  readonly checkoutCommit: (path: string, commitId: string) => Promise<void>;
  readonly resetToCommit: (path: string, commitId: string, mode: string) => Promise<void>;
  readonly archiveCommit: (path: string, commitId: string, outputPath: string) => Promise<void>;
  readonly formatPatch: (path: string, commitId: string, outputPath: string) => Promise<void>;

  // UI
  readonly togglePanel: () => void;
  readonly setActiveTab: (tab: "changes" | "log" | "branches" | "stash") => void;
  readonly setFileViewMode: (mode: "list" | "tree") => void;
  readonly clearGitInfo: () => void;
}

const GIT_FILE_VIEW_MODE_KEY = "git-file-view-mode";

function getStorage(): Storage | null {
  if (typeof window === "undefined") {
    return null;
  }

  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

function getStoredFileViewMode(): "list" | "tree" {
  const storedMode = getStorage()?.getItem(GIT_FILE_VIEW_MODE_KEY);
  return storedMode === "list" || storedMode === "tree" ? storedMode : "tree";
}

/**
 * Detect "this directory isn't a git repository" errors raised by libgit2 so
 * we can swallow them quietly.  They appear during normal use whenever the
 * user opens a project that hasn't been `git init`-ed — toasting three of
 * them on workspace open is noise, not signal.  Real git errors (corrupt
 * repo, permission denied, network timeouts on push/pull) still surface.
 */
function isNotARepoError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return (
    msg.includes("could not find repository") ||
    msg.includes("code=NotFound") ||
    msg.includes("not a git repository")
  );
}

// ── Store ────────────────────────────────────────────────────────────

export const useGitStore = create<GitState>((set, get) => ({
  gitInfo: null,
  fileStatuses: [],
  fileDiffStats: new Map(),
  diffResult: null,
  currentFileDiff: null,
  logEntries: [],
  branches: [],
  stashList: [],
  commitDetail: null,
  isPanelOpen: false,
  activeTab: "changes",
  isLoading: false,
  isPulling: false,
  isPushing: false,
  isStashing: false,
  fileViewMode: getStoredFileViewMode(),

  // ── Read Operations ──────────────────────────────────────────────

  refreshGitInfo: async (path: string) => {
    try {
      const gitInfo = await invoke<GitInfo>("get_git_info", { path });
      // Only update if the actual values changed to avoid unnecessary re-renders.
      const old = get().gitInfo;
      const unchanged = old
        && old.branch === gitInfo.branch
        && old.modified_count === gitInfo.modified_count
        && old.untracked_count === gitInfo.untracked_count
        && old.ahead === gitInfo.ahead
        && old.behind === gitInfo.behind
        && old.is_git_repo === gitInfo.is_git_repo
        && old.detached_head === gitInfo.detached_head
        && old.merge_in_progress === gitInfo.merge_in_progress;
      if (!unchanged) {
        set({ gitInfo });
      }
    } catch {
      if (get().gitInfo !== null) {
        set({ gitInfo: null });
      }
    }
  },

  fetchRemote: async (path: string) => {
    try {
      const gitTokens = buildGitTokensMap();
      await invoke("git_fetch", { path, gitTokens });
      await get().refreshGitInfo(path);
    } catch {
      // Silently ignore fetch errors (network issues, no remote, etc.)
    }
  },

  loadCommitDetail: async (path: string, commitId: string) => {
    try {
      const commitDetail = await invoke<CommitDetail>("get_commit_detail", { path, commitId });
      set({ commitDetail });
    } catch (err: unknown) {
      if (isNotARepoError(err)) return;
      useToastStore.getState().addToast(
        "error",
        `Failed to load commit detail: ${formatError(err)}`,
      );
    }
  },

  clearCommitDetail: () => {
    set({ commitDetail: null });
  },

  loadFileStatuses: async (path: string) => {
    try {
      // Phase 1: Load file statuses first so the panel can render immediately
      const fileStatuses = await invoke<GitFileStatus[]>("get_git_status", { path });
      set({ fileStatuses });

      const [unstagedDiff, stagedDiff] = await Promise.all([
        invoke<GitDiffResult>("get_git_diff", { path, staged: false }).catch(() => null),
        invoke<GitDiffResult>("get_git_diff", { path, staged: true }).catch(() => null),
      ]);

      const stats = new Map<string, FileDiffStat>();
      for (const file of unstagedDiff?.files ?? []) {
        stats.set(file.path, { additions: file.additions, deletions: file.deletions });
      }
      for (const file of stagedDiff?.files ?? []) {
        const existing = stats.get(file.path);
        if (existing) {
          stats.set(file.path, {
            additions: existing.additions + file.additions,
            deletions: existing.deletions + file.deletions,
          });
        } else {
          stats.set(file.path, { additions: file.additions, deletions: file.deletions });
        }
      }

      // Only update fileDiffStats if the contents actually changed to avoid
      // unnecessary re-renders (new Map() always creates a new reference).
      const oldStats = get().fileDiffStats;
      const diffStatsChanged = stats.size !== oldStats.size || (() => {
        for (const [k, v] of stats) {
          const o = oldStats.get(k);
          if (!o || o.additions !== v.additions || o.deletions !== v.deletions) return true;
        }
        return false;
      })();

      if (diffStatsChanged) {
        set({ fileDiffStats: stats });
      }
    } catch (err: unknown) {
      if (isNotARepoError(err)) {
        // Reset cached state so the panel reflects "no repo" cleanly
        set({ fileStatuses: [], fileDiffStats: new Map() });
        return;
      }
      useToastStore.getState().addToast(
        "error",
        `Failed to load git status: ${formatError(err)}`,
      );
    }
  },

  loadDiff: async (path: string, staged: boolean) => {
    try {
      const diffResult = await invoke<GitDiffResult>("get_git_diff", { path, staged });
      set({ diffResult });
    } catch (err: unknown) {
      if (isNotARepoError(err)) return;
      useToastStore.getState().addToast(
        "error",
        `Failed to load diff: ${formatError(err)}`,
      );
    }
  },

  loadFileDiff: async (path: string, filePath: string, staged: boolean) => {
    try {
      const currentFileDiff = await invoke<GitDiffFile>("get_file_diff", { path, filePath, staged });
      set({ currentFileDiff });
    } catch (err: unknown) {
      if (isNotARepoError(err)) return;
      useToastStore.getState().addToast(
        "error",
        `Failed to load file diff: ${formatError(err)}`,
      );
    }
  },

  loadLog: async (path: string, limit?: number) => {
    try {
      const logEntries = await invoke<GitLogEntry[]>("get_git_log", { path, limit: limit ?? null });
      set({ logEntries });
    } catch (err: unknown) {
      if (isNotARepoError(err)) {
        set({ logEntries: [] });
        return;
      }
      useToastStore.getState().addToast(
        "error",
        `Failed to load git log: ${formatError(err)}`,
      );
    }
  },

  loadBranches: async (path: string) => {
    try {
      const branches = await invoke<GitBranchInfo[]>("get_git_branches", { path });
      set({ branches });
    } catch (err: unknown) {
      if (isNotARepoError(err)) {
        set({ branches: [] });
        return;
      }
      useToastStore.getState().addToast(
        "error",
        `Failed to load branches: ${formatError(err)}`,
      );
    }
  },

  loadStashList: async (path: string) => {
    try {
      const stashList = await invoke<GitStashEntry[]>("get_git_stash_list", { path });
      set({ stashList });
    } catch (err: unknown) {
      if (isNotARepoError(err)) {
        set({ stashList: [] });
        return;
      }
      useToastStore.getState().addToast(
        "error",
        `Failed to load stash list: ${formatError(err)}`,
      );
    }
  },

  // ── Write Operations ─────────────────────────────────────────────

  stageFiles: async (path: string, files: string[]) => {
    set({ isLoading: true });
    try {
      await invoke("git_stage_files", { path, files });
      await get().loadFileStatuses(path);
    } catch (err: unknown) {
      useToastStore.getState().addToast(
        "error",
        `Failed to stage files: ${formatError(err)}`,
      );
      throw err;
    } finally {
      set({ isLoading: false });
    }
  },

  unstageFiles: async (path: string, files: string[]) => {
    set({ isLoading: true });
    try {
      await invoke("git_unstage_files", { path, files });
      await get().loadFileStatuses(path);
    } catch (err: unknown) {
      useToastStore.getState().addToast(
        "error",
        `Failed to unstage files: ${formatError(err)}`,
      );
    } finally {
      set({ isLoading: false });
    }
  },

  discardFiles: async (path: string, files: string[]) => {
    set({ isLoading: true });
    try {
      await invoke("git_discard_files", { path, files });
      await Promise.all([get().loadFileStatuses(path), get().refreshGitInfo(path)]);
    } catch (err: unknown) {
      useToastStore.getState().addToast(
        "error",
        `Failed to discard files: ${formatError(err)}`,
      );
    } finally {
      set({ isLoading: false });
    }
  },

  commit: async (path: string, message: string) => {
    track("git", "git.committed");
    set({ isLoading: true });
    try {
      const hash = await invoke<string>("git_commit", { path, message });
      await Promise.all([get().loadFileStatuses(path), get().refreshGitInfo(path)]);
      useToastStore.getState().addToast("info", `Committed: ${hash}`);
      return hash;
    } catch (err: unknown) {
      useToastStore.getState().addToast(
        "error",
        `Failed to commit: ${formatError(err)}`,
      );
      throw err;
    } finally {
      set({ isLoading: false });
    }
  },

  createBranch: async (path: string, name: string) => {
    set({ isLoading: true });
    try {
      await invoke("git_create_branch", { path, name });
      await get().loadBranches(path);
      useToastStore.getState().addToast("info", `Branch created: ${name}`);
    } catch (err: unknown) {
      useToastStore.getState().addToast(
        "error",
        `Failed to create branch: ${formatError(err)}`,
      );
    } finally {
      set({ isLoading: false });
    }
  },

  switchBranch: async (path: string, name: string) => {
    track("git", "git.branch_switched", { branch: name });
    set({ isLoading: true });
    try {
      await invoke("git_switch_branch", { path, name });
      await Promise.all([get().refreshGitInfo(path), get().loadFileStatuses(path)]);
      useToastStore.getState().addToast("info", `Switched to: ${name}`);
    } catch (err: unknown) {
      useToastStore.getState().addToast(
        "error",
        `Failed to switch branch: ${formatError(err)}`,
      );
    } finally {
      set({ isLoading: false });
    }
  },

  pull: async (path: string, credentials?: GitAuthCredentials) => {
    set({ isLoading: true, isPulling: true });
    try {
      const gitTokens = buildGitTokensMap();
      const result = await invoke<GitPullResult>("git_pull", {
        path,
        gitTokens,
        credentials: credentials ?? null,
      });
      await Promise.all([get().refreshGitInfo(path), get().loadFileStatuses(path)]);
      if (result.conflicts) {
        useToastStore.getState().addToast("warning", "Pull completed with merge conflicts");
      } else {
        useToastStore.getState().addToast("info", "Pull completed");
      }
      return result;
    } catch (err: unknown) {
      // Authentication failures are handled by the caller (git-panel prompts
      // for credentials), so don't double-toast here — just rethrow.
      if (!isGitAuthFailure(err)) {
        useToastStore.getState().addToast(
          "error",
          `Pull failed: ${formatError(err)}`,
        );
      }
      throw err;
    } finally {
      set({ isLoading: false, isPulling: false });
    }
  },

  push: async (path: string, credentials?: GitAuthCredentials) => {
    set({ isLoading: true, isPushing: true });
    try {
      const gitTokens = buildGitTokensMap();
      await invoke("git_push", { path, gitTokens, credentials: credentials ?? null });
      await get().refreshGitInfo(path);
      useToastStore.getState().addToast("info", "Push completed");
    } catch (err: unknown) {
      // Authentication failures are handled by the caller (git-panel prompts
      // for credentials), so don't double-toast here — just rethrow.
      if (!isGitAuthFailure(err)) {
        useToastStore.getState().addToast(
          "error",
          `Push failed: ${formatError(err)}`,
        );
      }
      throw err;
    } finally {
      set({ isLoading: false, isPushing: false });
    }
  },

  stashSave: async (path: string, message?: string) => {
    set({ isLoading: true, isStashing: true });
    try {
      await invoke("git_stash_save", { path, message: message ?? null });
      await Promise.all([get().refreshGitInfo(path), get().loadFileStatuses(path), get().loadStashList(path)]);
      useToastStore.getState().addToast("info", "Changes stashed");
    } catch (err: unknown) {
      useToastStore.getState().addToast(
        "error",
        `Stash save failed: ${formatError(err)}`,
      );
    } finally {
      set({ isLoading: false, isStashing: false });
    }
  },

  stashPop: async (path: string, index: number) => {
    set({ isLoading: true });
    try {
      await invoke("git_stash_pop", { path, index });
      await Promise.all([get().refreshGitInfo(path), get().loadFileStatuses(path), get().loadStashList(path)]);
      useToastStore.getState().addToast("info", "Stash popped");
    } catch (err: unknown) {
      useToastStore.getState().addToast(
        "error",
        `Stash pop failed: ${formatError(err)}`,
      );
    } finally {
      set({ isLoading: false });
    }
  },

  // ── Advanced Operations ──────────────────────────────────────────

  createTag: async (path: string, name: string, commitId: string) => {
    try {
      await invoke("git_create_tag", { path, name, commitId });
      useToastStore.getState().addToast("info", `Tag created: ${name}`);
    } catch (err: unknown) {
      useToastStore.getState().addToast(
        "error",
        `Failed to create tag: ${formatError(err)}`,
      );
    }
  },

  createBranchFromCommit: async (path: string, name: string, commitId: string) => {
    try {
      await invoke("git_create_branch_from_commit", { path, name, commitId });
      await get().loadBranches(path);
      useToastStore.getState().addToast("info", `Branch created: ${name}`);
    } catch (err: unknown) {
      useToastStore.getState().addToast(
        "error",
        `Failed to create branch: ${formatError(err)}`,
      );
    }
  },

  checkoutCommit: async (path: string, commitId: string) => {
    set({ isLoading: true });
    try {
      await invoke("git_checkout_commit", { path, commitId });
      await Promise.all([get().refreshGitInfo(path), get().loadFileStatuses(path), get().loadLog(path, 50)]);
      useToastStore.getState().addToast("info", `Checked out: ${commitId.slice(0, 7)}`);
    } catch (err: unknown) {
      useToastStore.getState().addToast(
        "error",
        `Failed to checkout: ${formatError(err)}`,
      );
    } finally {
      set({ isLoading: false });
    }
  },

  resetToCommit: async (path: string, commitId: string, mode: string) => {
    set({ isLoading: true });
    try {
      await invoke("git_reset_to_commit", { path, commitId, mode });
      await Promise.all([get().refreshGitInfo(path), get().loadFileStatuses(path), get().loadLog(path, 50)]);
      useToastStore.getState().addToast("info", `Reset (${mode}) to ${commitId.slice(0, 7)}`);
    } catch (err: unknown) {
      useToastStore.getState().addToast(
        "error",
        `Failed to reset: ${formatError(err)}`,
      );
    } finally {
      set({ isLoading: false });
    }
  },

  archiveCommit: async (path: string, commitId: string, outputPath: string) => {
    try {
      await invoke("git_archive_commit", { path, commitId, outputPath });
      useToastStore.getState().addToast("info", `Archive saved`);
    } catch (err: unknown) {
      useToastStore.getState().addToast(
        "error",
        `Failed to archive: ${formatError(err)}`,
      );
    }
  },

  formatPatch: async (path: string, commitId: string, outputPath: string) => {
    try {
      await invoke("git_format_patch", { path, commitId, outputPath });
      useToastStore.getState().addToast("info", `Patch saved`);
    } catch (err: unknown) {
      useToastStore.getState().addToast(
        "error",
        `Failed to create patch: ${formatError(err)}`,
      );
    }
  },

  // ── UI ───────────────────────────────────────────────────────────

  togglePanel: () => {
    set((state) => ({ isPanelOpen: !state.isPanelOpen }));
  },

  setActiveTab: (tab: "changes" | "log" | "branches" | "stash") => {
    set({ activeTab: tab });
  },

  setFileViewMode: (mode: "list" | "tree") => {
    getStorage()?.setItem(GIT_FILE_VIEW_MODE_KEY, mode);
    set({ fileViewMode: mode });
  },

  clearGitInfo: () => {
    set({
      gitInfo: null,
      fileStatuses: [],
      fileDiffStats: new Map(),
      diffResult: null,
      currentFileDiff: null,
      commitDetail: null,
      logEntries: [],
      branches: [],
      stashList: [],
    });
  },
}));
