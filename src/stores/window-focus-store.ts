import { create } from "zustand";

interface WindowFocusState {
  readonly isMainWindowFocused: boolean;
  readonly setFocused: (focused: boolean) => void;
}

export const useWindowFocusStore = create<WindowFocusState>((set) => ({
  isMainWindowFocused: true,
  setFocused: (focused) => set({ isMainWindowFocused: focused }),
}));
