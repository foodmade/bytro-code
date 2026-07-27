import { create } from "zustand";
import { invoke } from "@tauri-apps/api/core";
import { useToastStore } from "./toast-store";
import { formatError } from "@/lib/format-error";
import { track } from "@/lib/tracking";
import { buildGitTokensMap } from "./git-store";

// ── Types (mirror src-tauri/src/pr/models.rs) ────────────────────────

export interface PrRepoInfo {
  readonly host: string;
  readonly owner: string;
  readonly repo: string;
  readonly platform: "github" | "unsupported";
  readonly default_branch: string;
  readonly allow_merge_commit: boolean;
  readonly allow_squash_merge: boolean;
  readonly allow_rebase_merge: boolean;
  readonly delete_branch_on_merge: boolean;
  readonly html_url: string;
  readonly warning: string | null;
}

export interface PrSummary {
  readonly number: number;
  readonly title: string;
  readonly state: "open" | "closed" | "merged";
  readonly is_draft: boolean;
  readonly author: string;
  readonly head_branch: string;
  readonly base_branch: string;
  readonly html_url: string;
  readonly updated_at: string;
}

export interface PrDetail extends PrSummary {
  readonly created_at: string;
  readonly body: string;
  readonly head_sha: string;
  readonly mergeable: boolean | null;
  readonly mergeable_state: string;
  readonly additions: number;
  readonly deletions: number;
  readonly changed_files: number;
  readonly commits: number;
}

export interface PrCheck {
  readonly name: string;
  readonly status: "queued" | "in_progress" | "completed";
  readonly conclusion: string | null;
  readonly details_url: string | null;
}

export interface PrChecksResult {
  readonly overall: "none" | "running" | "success" | "failure";
  readonly checks: ReadonlyArray<PrCheck>;
}

export interface PrMergeResult {
  readonly merged: boolean;
  readonly sha: string | null;
  readonly message: string;
  readonly branch_deleted: boolean;
}

export type PrListState = "open" | "closed" | "all";
export type MergeMethod = "merge" | "squash" | "rebase";

// ── State ────────────────────────────────────────────────────────────

interface PrState {
  readonly isModalOpen: boolean;
  readonly repoInfo: PrRepoInfo | null;
  readonly repoError: string | null;
  readonly prs: ReadonlyArray<PrSummary>;
  readonly listState: PrListState;
  readonly listError: string | null;
  readonly selectedPr: PrDetail | null;
  /** `null` means "not fetched yet" — the UI shows a loading state, not "no checks". */
  readonly checks: PrChecksResult | null;
  readonly checksError: string | null;
  readonly isLoadingChecks: boolean;
  /** PR number whose detail request is in flight — drives the row spinner. */
  readonly pendingPrNumber: number | null;
  readonly lastWorkspacePath: string | null;
  readonly isDetecting: boolean;
  readonly isLoadingList: boolean;
  readonly isLoadingDetail: boolean;
  readonly isCreating: boolean;
  readonly isMerging: boolean;

  readonly openModal: (workspacePath: string) => void;
  readonly closeModal: () => void;
  readonly detectRepo: (workspacePath: string) => Promise<void>;
  readonly loadPrs: () => Promise<void>;
  readonly setListState: (state: PrListState) => void;
  readonly selectPr: (number: number) => Promise<void>;
  readonly clearSelection: () => void;
  readonly refreshChecks: () => Promise<void>;
  readonly createPr: (input: {
    readonly title: string;
    readonly body: string;
    readonly head: string;
    readonly base: string;
    readonly draft: boolean;
  }) => Promise<PrDetail>;
  readonly mergePr: (method: MergeMethod, deleteBranch: boolean) => Promise<PrMergeResult>;
}

// ── Store ────────────────────────────────────────────────────────────

export const usePrStore = create<PrState>((set, get) => ({
  isModalOpen: false,
  repoInfo: null,
  repoError: null,
  prs: [],
  listState: "open",
  listError: null,
  selectedPr: null,
  checks: null,
  checksError: null,
  isLoadingChecks: false,
  pendingPrNumber: null,
  lastWorkspacePath: null,
  isDetecting: false,
  isLoadingList: false,
  isLoadingDetail: false,
  isCreating: false,
  isMerging: false,

  openModal: (workspacePath: string) => {
    track("git", "pr.panel_opened");
    // Reopening in the same workspace keeps stale data visible while it
    // refreshes; a different workspace must start from a clean slate so the
    // previous repo's PRs never flash.
    const isNewWorkspace = get().lastWorkspacePath !== workspacePath;
    set({
      isModalOpen: true,
      selectedPr: null,
      checks: null,
      pendingPrNumber: null,
      lastWorkspacePath: workspacePath,
      ...(isNewWorkspace
        ? {
            repoInfo: null,
            repoError: null,
            prs: [],
            listError: null,
            listState: "open" as const,
          }
        : {}),
    });
    void get().detectRepo(workspacePath);
  },

  closeModal: () => {
    set({ isModalOpen: false, selectedPr: null, checks: null });
  },

  detectRepo: async (workspacePath: string) => {
    set({ isDetecting: true, repoError: null });
    try {
      const gitTokens = buildGitTokensMap();
      const repoInfo = await invoke<PrRepoInfo | null>("pr_detect_repo", {
        path: workspacePath,
        gitTokens,
      });
      set({ repoInfo });
      if (repoInfo?.platform === "github") {
        await get().loadPrs();
      }
    } catch (err: unknown) {
      set({ repoInfo: null, repoError: formatError(err) });
    } finally {
      set({ isDetecting: false });
    }
  },

  loadPrs: async () => {
    const { repoInfo, listState } = get();
    if (!repoInfo || repoInfo.platform !== "github") return;
    const requestedState = listState;
    const requestedRepo = repoInfo;
    set({ isLoadingList: true, listError: null });
    const isStale = () =>
      get().listState !== requestedState || get().repoInfo !== requestedRepo;
    try {
      const gitTokens = buildGitTokensMap();
      const prs = await invoke<PrSummary[]>("pr_list", {
        host: repoInfo.host,
        owner: repoInfo.owner,
        repo: repoInfo.repo,
        state: listState,
        gitTokens,
      });
      // The user may have switched filters (or the repo re-detected) while
      // this request was in flight — the newer request owns the state.
      if (isStale()) return;
      set({ prs, isLoadingList: false });
    } catch (err: unknown) {
      if (isStale()) return;
      set({ listError: formatError(err), isLoadingList: false });
    }
  },

  setListState: (listState: PrListState) => {
    if (get().listState === listState) return;
    // Clear the previous filter's rows immediately so the list shows a
    // spinner instead of data that belongs to another filter.
    set({ listState, prs: [], listError: null });
    void get().loadPrs();
  },

  selectPr: async (number: number) => {
    const { repoInfo } = get();
    if (!repoInfo) return;
    set({ isLoadingDetail: true, checks: null, checksError: null, pendingPrNumber: number });
    try {
      const gitTokens = buildGitTokensMap();
      const selectedPr = await invoke<PrDetail>("pr_get_detail", {
        host: repoInfo.host,
        owner: repoInfo.owner,
        repo: repoInfo.repo,
        number,
        gitTokens,
      });
      // A newer selection supersedes this response.
      if (get().pendingPrNumber !== number) return;
      set({ selectedPr, isLoadingDetail: false, pendingPrNumber: null });
      void get().refreshChecks();
    } catch (err: unknown) {
      if (get().pendingPrNumber !== number) return;
      set({ isLoadingDetail: false, pendingPrNumber: null });
      useToastStore.getState().addToast("error", `Failed to load pull request: ${formatError(err)}`);
    }
  },

  clearSelection: () => {
    set({ selectedPr: null, checks: null, checksError: null, pendingPrNumber: null });
  },

  refreshChecks: async () => {
    const { repoInfo, selectedPr } = get();
    if (!repoInfo || !selectedPr || !selectedPr.head_sha) return;
    set({ isLoadingChecks: true });
    // The user may switch PRs while the request is in flight — a stale
    // response must not touch state owned by the newer selection.
    const isStale = () => get().selectedPr?.number !== selectedPr.number;
    try {
      const gitTokens = buildGitTokensMap();
      const checks = await invoke<PrChecksResult>("pr_get_checks", {
        host: repoInfo.host,
        owner: repoInfo.owner,
        repo: repoInfo.repo,
        sha: selectedPr.head_sha,
        gitTokens,
      });
      if (isStale()) return;
      set({ checks, checksError: null, isLoadingChecks: false });
    } catch (err: unknown) {
      if (isStale()) return;
      // Keep any previously loaded checks visible; the error only replaces
      // the loading placeholder when nothing has been fetched yet.
      set({ checksError: formatError(err), isLoadingChecks: false });
    }
  },

  createPr: async (input) => {
    const { repoInfo } = get();
    if (!repoInfo) throw new Error("no repository detected");
    track("git", "pr.created");
    set({ isCreating: true });
    try {
      const gitTokens = buildGitTokensMap();
      const created = await invoke<PrDetail>("pr_create", {
        host: repoInfo.host,
        owner: repoInfo.owner,
        repo: repoInfo.repo,
        title: input.title,
        body: input.body,
        head: input.head,
        base: input.base,
        draft: input.draft,
        gitTokens,
      });
      set({ selectedPr: created });
      void get().loadPrs();
      void get().refreshChecks();
      return created;
    } finally {
      set({ isCreating: false });
    }
  },

  mergePr: async (method: MergeMethod, deleteBranch: boolean) => {
    const { repoInfo, selectedPr } = get();
    if (!repoInfo || !selectedPr) throw new Error("no pull request selected");
    track("git", "pr.merged", { method });
    set({ isMerging: true });
    try {
      const gitTokens = buildGitTokensMap();
      const result = await invoke<PrMergeResult>("pr_merge", {
        host: repoInfo.host,
        owner: repoInfo.owner,
        repo: repoInfo.repo,
        number: selectedPr.number,
        method,
        headBranch: selectedPr.head_branch,
        deleteBranch,
        gitTokens,
      });
      if (result.merged) {
        // Refresh both the detail (now "merged") and the list.
        void get().selectPr(selectedPr.number);
        void get().loadPrs();
      }
      return result;
    } finally {
      set({ isMerging: false });
    }
  },
}));
