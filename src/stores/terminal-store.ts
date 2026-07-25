import { create } from "zustand";

interface TerminalSession {
  readonly id: string;
  readonly title: string;
  readonly isActive: boolean;
}

interface TerminalState {
  readonly sessions: ReadonlyArray<TerminalSession>;
  readonly activeSessionId: string | null;
  readonly popupOpen: boolean;
  readonly popupCwd: string | null;
  readonly addSession: (session: TerminalSession) => void;
  readonly removeSession: (id: string) => void;
  readonly setActiveSession: (id: string) => void;
  readonly openPopup: (cwd: string) => void;
  readonly closePopup: () => void;
}

export const useTerminalStore = create<TerminalState>((set) => ({
  sessions: [],
  activeSessionId: null,
  popupOpen: false,
  popupCwd: null,
  addSession: (session) =>
    set((state) => ({
      sessions: [...state.sessions, session],
      activeSessionId: session.id,
    })),
  removeSession: (id) =>
    set((state) => ({
      sessions: state.sessions.filter((s) => s.id !== id),
      activeSessionId:
        state.activeSessionId === id
          ? state.sessions.find((s) => s.id !== id)?.id ?? null
          : state.activeSessionId,
    })),
  setActiveSession: (id) => set({ activeSessionId: id }),
  openPopup: (cwd) => set({ popupOpen: true, popupCwd: cwd }),
  closePopup: () => set({ popupOpen: false, popupCwd: null }),
}));
