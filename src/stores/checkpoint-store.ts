import { create } from "zustand";
import { invoke } from "@tauri-apps/api/core";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface Checkpoint {
  readonly id: string;
  readonly commitId: string;
  readonly label: string;
  readonly timestamp: number;
  readonly fileCount: number;
  readonly additions: number;
  readonly deletions: number;
}

/** Raw entry returned from the Rust git_checkpoint_list command. */
interface CheckpointEntryRaw {
  readonly commit_id: string;
  readonly label: string;
  readonly conversation_id: string | null;
  readonly timestamp: number;
  readonly file_count: number;
  readonly additions: number;
  readonly deletions: number;
}

/** Per-conversation checkpoint tracking state. */
interface ConversationCheckpointState {
  readonly checkpoints: ReadonlyArray<Checkpoint>;
  readonly isCreating: boolean;
  readonly isRestoring: boolean;
  readonly isLoading: boolean;
  readonly restoreError: string | null;
}

interface CheckpointState {
  readonly checkpointsByConversation: Readonly<
    Record<string, ConversationCheckpointState>
  >;

  // Selectors
  readonly getConversationCheckpoints: (
    conversationId: string | null,
  ) => ConversationCheckpointState;

  // Actions
  readonly loadCheckpoints: (
    conversationId: string | null,
    workspacePath: string,
  ) => Promise<void>;
  readonly createCheckpoint: (
    conversationId: string | null,
    workspacePath: string,
    label: string,
    fileCount: number,
    additions: number,
    deletions: number,
  ) => Promise<void>;
  readonly restoreCheckpoint: (
    conversationId: string | null,
    workspacePath: string,
    checkpointId: string,
  ) => Promise<void>;
  readonly clearCheckpoints: (conversationId: string | null) => void;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const EMPTY_STATE: ConversationCheckpointState = {
  checkpoints: [],
  isCreating: false,
  isRestoring: false,
  isLoading: false,
  restoreError: null,
};

function convKey(conversationId: string | null): string {
  return conversationId ?? "__no_conversation__";
}

// One-time migration flag: clean up legacy per-conversation shadow branches
let migrationAttempted = false;

// One-time cleanup flag: remove checkpoints older than 7 days
let cleanupAttempted = false;

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

export const useCheckpointStore = create<CheckpointState>((set, get) => ({
  checkpointsByConversation: {},

  getConversationCheckpoints: (conversationId) => {
    const key = convKey(conversationId);
    return get().checkpointsByConversation[key] ?? EMPTY_STATE;
  },

  loadCheckpoints: async (conversationId, workspacePath) => {
    if (!workspacePath) return;

    // One-time migration: delete legacy per-conversation shadow branches
    if (!migrationAttempted) {
      migrationAttempted = true;
      invoke<number>("git_checkpoint_migrate", { path: workspacePath }).catch(
        () => {/* non-critical */},
      );
    }

    // One-time cleanup: remove checkpoints older than 7 days
    if (!cleanupAttempted) {
      cleanupAttempted = true;
      invoke<number>("git_checkpoint_cleanup", {
        path: workspacePath,
        maxAgeDays: 7,
      }).catch(() => {/* non-critical */});
    }

    const key = convKey(conversationId);
    const prev = get().checkpointsByConversation[key] ?? EMPTY_STATE;

    // Skip if already loading; allow reload if previously loaded (data may be stale)
    if (prev.isLoading) return;

    set((state) => ({
      checkpointsByConversation: {
        ...state.checkpointsByConversation,
        [key]: { ...prev, isLoading: true },
      },
    }));

    try {
      const entries = await invoke<ReadonlyArray<CheckpointEntryRaw>>(
        "git_checkpoint_list",
        {
          path: workspacePath,
          conversationId: conversationId,
          limit: 100,
        },
      );

      const checkpoints: ReadonlyArray<Checkpoint> = entries.map((e) => ({
        id: crypto.randomUUID(),
        commitId: e.commit_id,
        label: e.label,
        // Convert unix seconds to milliseconds
        timestamp: e.timestamp * 1000,
        fileCount: e.file_count,
        additions: e.additions,
        deletions: e.deletions,
      }));

      set((state) => {
        const current =
          state.checkpointsByConversation[key] ?? EMPTY_STATE;
        return {
          checkpointsByConversation: {
            ...state.checkpointsByConversation,
            [key]: {
              ...current,
              isLoading: false,
              checkpoints,
            },
          },
        };
      });
    } catch (err) {
      // Silently fail — checkpoint loading should not interrupt the user
      set((state) => {
        const current =
          state.checkpointsByConversation[key] ?? EMPTY_STATE;
        return {
          checkpointsByConversation: {
            ...state.checkpointsByConversation,
            [key]: { ...current, isLoading: false },
          },
        };
      });
      if (import.meta.env.DEV) {
        console.warn("[checkpoint] load failed:", err);
      }
    }
  },

  createCheckpoint: async (
    conversationId,
    workspacePath,
    label,
    fileCount,
    additions,
    deletions,
  ) => {
    const key = convKey(conversationId);
    const prev = get().checkpointsByConversation[key] ?? EMPTY_STATE;

    // Mark as creating
    set((state) => ({
      checkpointsByConversation: {
        ...state.checkpointsByConversation,
        [key]: { ...prev, isCreating: true },
      },
    }));

    try {
      const commitId = await invoke<string>("git_checkpoint_create", {
        path: workspacePath,
        label,
        conversationId: conversationId,
      });

      const checkpoint: Checkpoint = {
        id: crypto.randomUUID(),
        commitId,
        label,
        timestamp: Date.now(),
        fileCount,
        additions,
        deletions,
      };

      set((state) => {
        const current =
          state.checkpointsByConversation[key] ?? EMPTY_STATE;
        return {
          checkpointsByConversation: {
            ...state.checkpointsByConversation,
            [key]: {
              ...current,
              isCreating: false,
              checkpoints: [...current.checkpoints, checkpoint],
            },
          },
        };
      });
    } catch (err: unknown) {
      // Silently fail — checkpoint creation should not interrupt the user
      set((state) => {
        const current =
          state.checkpointsByConversation[key] ?? EMPTY_STATE;
        return {
          checkpointsByConversation: {
            ...state.checkpointsByConversation,
            [key]: { ...current, isCreating: false },
          },
        };
      });
      if (import.meta.env.DEV) {
        console.warn("[checkpoint] create failed:", err);
      }
    }
  },

  restoreCheckpoint: async (conversationId, workspacePath, checkpointId) => {
    const key = convKey(conversationId);
    const prev = get().checkpointsByConversation[key] ?? EMPTY_STATE;

    const checkpoint = prev.checkpoints.find((c) => c.id === checkpointId);
    if (!checkpoint) {
      set((state) => ({
        checkpointsByConversation: {
          ...state.checkpointsByConversation,
          [key]: { ...prev, restoreError: "Checkpoint not found" },
        },
      }));
      return;
    }

    set((state) => ({
      checkpointsByConversation: {
        ...state.checkpointsByConversation,
        [key]: { ...prev, isRestoring: true, restoreError: null },
      },
    }));

    try {
      await invoke("git_checkpoint_restore", {
        path: workspacePath,
        commitId: checkpoint.commitId,
        conversationId: conversationId,
      });

      // Refresh git status after restore
      try {
        const { useGitStore } = await import("./git-store");
        await Promise.all([
          useGitStore.getState().refreshGitInfo(workspacePath),
          useGitStore.getState().loadFileStatuses(workspacePath),
        ]);
      } catch {
        // Non-critical — UI will be slightly stale
      }

      // Clear cached checkpoints and reload from git to get accurate state
      get().clearCheckpoints(conversationId);
      await get().loadCheckpoints(conversationId, workspacePath);
    } catch (err: unknown) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      set((state) => {
        const current =
          state.checkpointsByConversation[key] ?? EMPTY_STATE;
        return {
          checkpointsByConversation: {
            ...state.checkpointsByConversation,
            [key]: {
              ...current,
              isRestoring: false,
              restoreError: errorMsg,
            },
          },
        };
      });
    }
  },

  clearCheckpoints: (conversationId) => {
    const key = convKey(conversationId);
    set((state) => ({
      checkpointsByConversation: {
        ...state.checkpointsByConversation,
        [key]: EMPTY_STATE,
      },
    }));
  },
}));
