import { create } from "zustand";
import { persist, type StateStorage } from "zustand/middleware";
import { load, type Store } from "@tauri-apps/plugin-store";
import type { GoalSnapshot } from "@/components/chat/goal-utils";

export interface GoalActivityItem {
  readonly id: string;
  readonly conversationId: string;
  readonly timestamp: number;
  readonly kind: "goal" | "progress" | "checkpoint" | "blocked" | "system";
  readonly message: string;
}

interface GoalSessionState {
  readonly panelWidth: number;
  readonly openByConversation: Readonly<Record<string, boolean>>;
  readonly pendingOpen: boolean;
  readonly goalsByConversation: Readonly<Record<string, GoalSnapshot>>;
  readonly activityByConversation: Readonly<Record<string, ReadonlyArray<GoalActivityItem>>>;

  readonly setPanelWidth: (width: number) => void;
  readonly setPanelOpen: (conversationId: string | null, open: boolean) => void;
  readonly togglePanelOpen: (conversationId: string | null) => void;
  readonly bindPendingToConversation: (conversationId: string) => void;
  readonly upsertGoalSnapshot: (snapshot: GoalSnapshot) => void;
  readonly addActivity: (item: Omit<GoalActivityItem, "id" | "timestamp"> & { readonly timestamp?: number }) => void;
  readonly clearConversation: (conversationId: string) => void;
}

const PANEL_WIDTH_MIN = 320;
const PANEL_WIDTH_MAX = 560;
const PANEL_WIDTH_DEFAULT = 360;
const ACTIVITY_LIMIT = 20;

function clampPanelWidth(width: number): number {
  if (!Number.isFinite(width)) return PANEL_WIDTH_DEFAULT;
  return Math.max(PANEL_WIDTH_MIN, Math.min(PANEL_WIDTH_MAX, Math.round(width)));
}

function makeActivityId(): string {
  try {
    return crypto.randomUUID();
  } catch {
    return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  }
}

const STORE_FILE = "goal-panel-prefs.json";
let storeInstance: Store | null = null;

async function getStore(): Promise<Store> {
  if (!storeInstance) {
    storeInstance = await load(STORE_FILE, { defaults: {}, autoSave: true });
  }
  return storeInstance;
}

const tauriStorage: StateStorage = {
  getItem: async (name) => {
    try {
      const store = await getStore();
      return await store.get<string>(name) ?? null;
    } catch {
      return null;
    }
  },
  setItem: async (name, value) => {
    try {
      const store = await getStore();
      await store.set(name, value);
    } catch {
      // 偏好持久化失败不应影响会话功能。
    }
  },
  removeItem: async (name) => {
    try {
      const store = await getStore();
      await store.delete(name);
    } catch {
      // ignore
    }
  },
};

export const useGoalSessionStore = create<GoalSessionState>()(
  persist(
    (set, get) => ({
      panelWidth: PANEL_WIDTH_DEFAULT,
      openByConversation: {},
      pendingOpen: false,
      goalsByConversation: {},
      activityByConversation: {},

      setPanelWidth: (width) => set({ panelWidth: clampPanelWidth(width) }),

      setPanelOpen: (conversationId, open) => {
        if (!conversationId) {
          set((state) => state.pendingOpen === open ? state : { pendingOpen: open });
          return;
        }
        set((state) => {
          const current = state.openByConversation[conversationId] === true;
          if (current === open) return state;
          if (!open) {
            const { [conversationId]: _removed, ...rest } = state.openByConversation;
            void _removed;
            return { openByConversation: rest };
          }
          return {
            openByConversation: {
              ...state.openByConversation,
              [conversationId]: true,
            },
          };
        });
      },

      togglePanelOpen: (conversationId) => {
        const state = get();
        const current = conversationId
          ? state.openByConversation[conversationId] === true
          : state.pendingOpen;
        get().setPanelOpen(conversationId, !current);
      },

      bindPendingToConversation: (conversationId) => {
        if (!conversationId) return;
        set((state) => {
          if (!state.pendingOpen) return state.pendingOpen === false ? state : { pendingOpen: false };
          return {
            pendingOpen: false,
            openByConversation: {
              ...state.openByConversation,
              [conversationId]: true,
            },
          };
        });
      },

      upsertGoalSnapshot: (snapshot) =>
        set((state) => {
          const previous = state.goalsByConversation[snapshot.conversationId];
          const next: GoalSnapshot = {
            ...previous,
            ...snapshot,
            objective: snapshot.objective || previous?.objective || "",
            updatedAt: snapshot.updatedAt || Date.now(),
          };
          return {
            goalsByConversation: {
              ...state.goalsByConversation,
              [snapshot.conversationId]: next,
            },
          };
        }),

      addActivity: (item) =>
        set((state) => {
          const prev = state.activityByConversation[item.conversationId] ?? [];
          const next: GoalActivityItem = {
            id: makeActivityId(),
            timestamp: item.timestamp ?? Date.now(),
            ...item,
          };
          return {
            activityByConversation: {
              ...state.activityByConversation,
              [item.conversationId]: [next, ...prev].slice(0, ACTIVITY_LIMIT),
            },
          };
        }),

      clearConversation: (conversationId) =>
        set((state) => {
          const { [conversationId]: _goal, ...goals } = state.goalsByConversation;
          const { [conversationId]: _open, ...open } = state.openByConversation;
          const { [conversationId]: _activity, ...activity } = state.activityByConversation;
          void _goal; void _open; void _activity;
          return {
            goalsByConversation: goals,
            openByConversation: open,
            activityByConversation: activity,
          };
        }),
    }),
    {
      name: "goal-panel-prefs",
      storage: {
        getItem: async (name) => {
          const raw = await tauriStorage.getItem(name);
          if (!raw) return null;
          try {
            return JSON.parse(raw);
          } catch {
            return null;
          }
        },
        setItem: async (name, value) => {
          await tauriStorage.setItem(name, JSON.stringify(value));
        },
        removeItem: tauriStorage.removeItem,
      },
      partialize: (state) => ({ panelWidth: state.panelWidth }) as unknown as GoalSessionState,
      merge: (persisted, current) => {
        const parsed = persisted as Partial<GoalSessionState> | undefined;
        return {
          ...current,
          panelWidth: clampPanelWidth(parsed?.panelWidth ?? current.panelWidth),
        };
      },
    },
  ),
);
