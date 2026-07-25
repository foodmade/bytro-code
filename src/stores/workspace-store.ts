import { create } from "zustand";
import { invoke } from "@tauri-apps/api/core";
import { useConversationStore } from "./conversation-store";
import { useFileTreeStore } from "./file-tree-store";
import { useGitStore } from "./git-store";
import { useToastStore } from "./toast-store";
import { formatError } from "@/lib/format-error";

export interface WorkspaceSummary {
  readonly id: string;
  readonly name: string;
  readonly path: string;
  readonly last_opened_at: string;
  readonly is_pinned: boolean;
  readonly conversation_count: number;
}

export interface Workspace {
  readonly id: string;
  readonly name: string;
  readonly path: string;
  readonly created_at: string;
  readonly last_opened_at: string;
  readonly is_pinned: boolean;
}

interface WorkspaceState {
  readonly workspaces: ReadonlyArray<WorkspaceSummary>;
  readonly activeWorkspaceId: string | null;
  readonly activeWorkspace: Workspace | null;
  /** Stable project ID backed by the Bytro workspace database record. */
  readonly activeProjectId: string;
  readonly isLoading: boolean;

  readonly loadWorkspaces: () => Promise<void>;
  readonly openWorkspace: (id: string) => Promise<void>;
  readonly addWorkspace: (path: string) => Promise<Workspace>;
  readonly removeWorkspace: (id: string) => Promise<void>;
  readonly pinWorkspace: (id: string, pinned: boolean) => Promise<void>;
  readonly renameWorkspace: (id: string, name: string) => Promise<void>;
  readonly setActiveWorkspaceId: (id: string | null) => void;
}

function extractFolderName(path: string): string {
  const sep = path.includes("\\") ? "\\" : "/";
  const parts = path.split(sep).filter(Boolean);
  return parts[parts.length - 1] || "workspace";
}

export const useWorkspaceStore = create<WorkspaceState>((set, get) => ({
  workspaces: [],
  activeWorkspaceId: null,
  activeWorkspace: null,
  activeProjectId: "",
  isLoading: false,

  loadWorkspaces: async () => {
    set({ isLoading: true });
    try {
      const workspaces = await invoke<WorkspaceSummary[]>("list_workspaces");
      set({ workspaces, isLoading: false });
    } catch (err: unknown) {
      set({ isLoading: false });
      useToastStore.getState().addToast("error", `Failed to load workspaces: ${formatError(err)}`);
    }
  },

  openWorkspace: async (id: string) => {
    try {
      await invoke("open_workspace", { workspaceId: id });
      const workspace = await invoke<Workspace | null>("get_workspace", { workspaceId: id });
      set({
        activeWorkspaceId: id,
        activeWorkspace: workspace,
        activeProjectId: workspace?.id ?? "",
      });
      useConversationStore.getState().resetForWorkspaceSwitch(id);
      if (workspace) {
        useFileTreeStore.getState().setRootPath(workspace.path);
        invoke("watch_dir", { path: workspace.path }).catch(() => {});
        useGitStore.getState().refreshGitInfo(workspace.path);

        // Check if project memory files (CLAUDE.md) exist
        import("./project-memory-store")
          .then(({ useProjectMemoryStore }) => {
            useProjectMemoryStore.getState().checkMemoryFiles(workspace.path);
          })
          .catch(() => {});
      }
    } catch (err: unknown) {
      useToastStore.getState().addToast("error", `Failed to open workspace: ${formatError(err)}`);
    }
  },

  addWorkspace: async (path: string) => {
    const name = extractFolderName(path);
    try {
      const workspace = await invoke<Workspace>("create_workspace", { name, path });
      set({
        activeWorkspaceId: workspace.id,
        activeWorkspace: workspace,
        activeProjectId: workspace.id,
      });
      useConversationStore.getState().resetForWorkspaceSwitch(workspace.id);
      await get().loadWorkspaces();
      useFileTreeStore.getState().setRootPath(workspace.path);
      invoke("watch_dir", { path: workspace.path }).catch(() => {});
      useGitStore.getState().refreshGitInfo(workspace.path);

      return workspace;
    } catch (err: unknown) {
      useToastStore.getState().addToast("error", `Failed to add workspace: ${formatError(err)}`);
      throw err;
    }
  },

  removeWorkspace: async (id: string) => {
    try {
      await invoke("delete_workspace", { workspaceId: id });
      const { activeWorkspaceId } = get();
      if (activeWorkspaceId === id) {
        set({ activeWorkspaceId: null, activeWorkspace: null, activeProjectId: "" });
        useGitStore.getState().clearGitInfo();
      }
      await get().loadWorkspaces();
    } catch (err: unknown) {
      useToastStore.getState().addToast("error", `Failed to remove workspace: ${formatError(err)}`);
    }
  },

  pinWorkspace: async (id: string, pinned: boolean) => {
    try {
      await invoke("pin_workspace", { workspaceId: id, pinned });
      await get().loadWorkspaces();
    } catch (err: unknown) {
      useToastStore.getState().addToast("error", `Failed to pin workspace: ${formatError(err)}`);
    }
  },

  renameWorkspace: async (id: string, name: string) => {
    try {
      await invoke("rename_workspace", { workspaceId: id, name });
      const { activeWorkspace } = get();
      if (activeWorkspace && activeWorkspace.id === id) {
        set({ activeWorkspace: { ...activeWorkspace, name } });
      }
      await get().loadWorkspaces();
    } catch (err: unknown) {
      useToastStore.getState().addToast("error", `Failed to rename workspace: ${formatError(err)}`);
    }
  },

  setActiveWorkspaceId: (id: string | null) => {
    set({ activeWorkspaceId: id });
  },
}));
