import { create } from "zustand";

export type ToastLevel = "error" | "warning" | "info";

export interface Toast {
  readonly id: string;
  readonly level: ToastLevel;
  readonly message: string;
  readonly timestamp: number;
}

interface ToastState {
  readonly toasts: ReadonlyArray<Toast>;
  readonly addToast: (level: ToastLevel, message: string) => void;
  readonly dismissToast: (id: string) => void;
}

const MAX_TOASTS = 5;
const TOAST_TTL = 6000;

export const useToastStore = create<ToastState>((set, get) => ({
  toasts: [],

  addToast: (level, message) => {
    const id = crypto.randomUUID();
    const toast: Toast = { id, level, message, timestamp: Date.now() };

    set({
      toasts: [...get().toasts.slice(-(MAX_TOASTS - 1)), toast],
    });

    // Auto-dismiss after TTL
    setTimeout(() => {
      get().dismissToast(id);
    }, TOAST_TTL);
  },

  dismissToast: (id) => {
    set({ toasts: get().toasts.filter((t) => t.id !== id) });
  },
}));
