import { create } from "zustand";
import { invoke } from "@tauri-apps/api/core";

export interface WorkspaceStats {
  readonly totalLines: number;
  readonly totalFiles: number;
  readonly totalCommits: number;
  readonly linesTrend: number;
  readonly filesTrend: number;
  readonly commitsTrend: number;
}

interface RawStats {
  total_lines: number;
  total_files: number;
  total_commits: number;
  lines_trend: number;
  files_trend: number;
  commits_trend: number;
}

interface WorkspaceStatsState {
  stats: WorkspaceStats | null;
  isLoading: boolean;
  error: string | null;
  fetchStats: (path: string) => Promise<void>;
  clear: () => void;
}

export const useWorkspaceStatsStore = create<WorkspaceStatsState>((set, get) => ({
  stats: null,
  isLoading: false,
  error: null,

  fetchStats: async (path: string) => {
    const isFirst = get().stats === null;
    if (isFirst) set({ isLoading: true });

    try {
      const raw = await invoke<RawStats>("get_workspace_stats", { path });
      set({
        stats: {
          totalLines: raw.total_lines,
          totalFiles: raw.total_files,
          totalCommits: raw.total_commits,
          linesTrend: raw.lines_trend,
          filesTrend: raw.files_trend,
          commitsTrend: raw.commits_trend,
        },
        isLoading: false,
        error: null,
      });
    } catch (err) {
      set({ isLoading: false, error: String(err) });
    }
  },

  clear: () => set({ stats: null, isLoading: false, error: null }),
}));
