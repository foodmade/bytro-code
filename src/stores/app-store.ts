import { create } from "zustand";
import { track } from "@/lib/tracking";
import { useConversationStore } from "./conversation-store";
import { useSplitViewStore } from "./split-view-store";

export type ActiveView = "welcome" | "onboarding" | "workspace" | "chat" | "editor" | "diff" | "ideas" | "teams" | "health-check";
export type ChatEntrySource = "newChat" | "sessions";
export type SidebarTab = "explorer" | "history";

/** A pending quick-action can be a plain string or a structured object
 *  that separates the user-visible display text from the full prompt sent to the AI.
 *
 *  `conversationId` (optional, object form only) binds the action to a specific
 *  conversation. ChatPanel only consumes the pending action when its current
 *  conversation matches; this prevents the prompt from being auto-fired into a
 *  later, unrelated conversation the user opens after the original task. */
export type PendingQuickAction = string | {
  readonly display: string;
  readonly prompt: string;
  readonly conversationId?: string;
};

export interface EditorDiffMode {
  readonly filePath: string;
  readonly original: string;
  readonly modified: string;
  readonly canWriteBack?: boolean;
  readonly relativePath?: string;
  readonly staged?: boolean;
}

interface AppState {
  readonly sidebarWidth: number;
  readonly isSidebarVisible: boolean;
  readonly isRailCollapsed: boolean;
  readonly isTerminalVisible: boolean;
  readonly terminalHeight: number;
  readonly activeView: ActiveView;
  readonly previousView: ActiveView | null;
  readonly sidebarTab: SidebarTab;
  readonly editorFilePath: string | null;
  readonly editorDiffMode: EditorDiffMode | null;
  readonly chatPanelWidth: number;
  /** File paths open as tabs inside the chat panel (VS Code style) */
  readonly openedFileTabs: ReadonlyArray<string>;
  /** Which file tab is currently active (null = chat messages are shown) */
  readonly activeFileTab: string | null;
  readonly isMcpConfigOpen: boolean;
  readonly isSkillsConfigOpen: boolean;
  readonly isSettingsOpen: boolean;
  readonly settingsInitialTab: string | null;
  readonly pendingQuickAction: PendingQuickAction | null;
  readonly isGlobalSearchOpen: boolean;
  readonly isQuickCaptureOpen: boolean;
  readonly chatEntrySource: ChatEntrySource;
  readonly setSidebarWidth: (width: number) => void;
  readonly toggleSidebar: () => void;
  readonly toggleRailCollapsed: () => void;
  readonly toggleTerminal: () => void;
  readonly setTerminalHeight: (height: number) => void;
  readonly setActiveView: (view: ActiveView) => void;
  readonly goBack: () => void;
  readonly setSidebarTab: (tab: SidebarTab) => void;
  readonly openFile: (path: string) => void;
  readonly closeFileTab: (path: string) => void;
  readonly removeFileTabState: (path: string) => void;
  readonly switchToFileTab: (path: string | null) => void;
  readonly setActiveFileTab: (path: string | null, options?: { readonly preserveEditorPath?: boolean }) => void;
  readonly openDiff: (diff: EditorDiffMode) => void;
  readonly openDiffTab: (diff: EditorDiffMode) => void;
  readonly closeDiff: () => void;
  /** Diff data registry for file tabs opened in diff mode */
  readonly openedDiffTabs: Map<string, EditorDiffMode>;
  /** Git/file diffs rendered as overlays inside the normal editor. Keyed by editor file path. */
  readonly fileDiffOverlays: Map<string, EditorDiffMode>;
  readonly setFileDiffOverlay: (path: string, diff: EditorDiffMode) => void;
  readonly clearFileDiffOverlay: (path: string) => void;
  readonly closeEditor: () => void;
  readonly setChatPanelWidth: (width: number) => void;
  readonly setMcpConfigOpen: (open: boolean) => void;
  readonly setSkillsConfigOpen: (open: boolean) => void;
  readonly openSettings: (tab?: string) => void;
  readonly closeSettings: () => void;
  readonly setPendingQuickAction: (prompt: PendingQuickAction | null) => void;
  readonly setGlobalSearchOpen: (open: boolean) => void;
  readonly setQuickCaptureOpen: (open: boolean) => void;
  readonly setChatEntrySource: (source: ChatEntrySource) => void;
  /** Whether the requirement panel is visible alongside the chat area */
  readonly isRequirementPanelOpen: boolean;
  readonly setRequirementPanelOpen: (open: boolean) => void;
  /** File paths attached to the next message as context */
  readonly contextFiles: ReadonlyArray<string>;
  readonly addContextFile: (path: string) => void;
  readonly removeContextFile: (path: string) => void;
  readonly clearContextFiles: () => void;
  /** Directory paths attached to the next message as context */
  readonly contextDirs: ReadonlyArray<string>;
  readonly addContextDir: (path: string) => void;
  readonly removeContextDir: (path: string) => void;
  /** Current creative mode selected from the "+" button */
  readonly creativeMode: "none" | "pptx" | "imagegen";
  readonly setCreativeMode: (mode: "none" | "pptx" | "imagegen") => void;
  /** Whether Codex Goals mode is enabled for the next turn. */
  readonly goalModeEnabled: boolean;
  readonly setGoalModeEnabled: (enabled: boolean) => void;
}

export const useAppStore = create<AppState>((set, get) => ({
  sidebarWidth: 280,
  isSidebarVisible: false,
  isRailCollapsed: false,
  isTerminalVisible: true,
  terminalHeight: 220,
  activeView: "welcome",
  previousView: null,
  sidebarTab: "history",
  editorFilePath: null,
  editorDiffMode: null,
  chatPanelWidth: 400,
  openedFileTabs: [],
  activeFileTab: null,
  openedDiffTabs: new Map(),
  fileDiffOverlays: new Map(),
  isMcpConfigOpen: false,
  isSkillsConfigOpen: false,
  isSettingsOpen: false,
  settingsInitialTab: null,
  pendingQuickAction: null,
  isGlobalSearchOpen: false,
  isQuickCaptureOpen: false,
  chatEntrySource: "newChat",
  isRequirementPanelOpen: true,
  setSidebarWidth: (width) => set({ sidebarWidth: width }),
  toggleSidebar: () =>
    set((state) => ({ isSidebarVisible: !state.isSidebarVisible })),
  toggleRailCollapsed: () =>
    set((state) => ({ isRailCollapsed: !state.isRailCollapsed })),
  toggleTerminal: () =>
    set((state) => ({ isTerminalVisible: !state.isTerminalVisible })),
  setTerminalHeight: (height) => set({ terminalHeight: height }),
  setActiveView: (view) => {
    track("navigation", "navigation.view_switched", { to: view });
    if (view === "ideas" && get().activeView !== "ideas") {
      track("idea_hub", "idea_hub.opened");
    }

    set((state) => ({
      previousView: state.activeView,
      activeView: view,
    }));
  },
  goBack: () =>
    set((state) => ({
      activeView: state.previousView ?? "workspace",
      previousView: null,
    })),
  setSidebarTab: (tab) => set({ sidebarTab: tab }),
  openFile: (path) => {
    useSplitViewStore.getState().openContent(
      { type: "file", path },
      useConversationStore.getState().activeConversationId,
    );
    set((state) => ({
      editorFilePath: path,
      editorDiffMode: null,
      activeView: "chat",
      isRailCollapsed: true,
      openedFileTabs: state.openedFileTabs.includes(path)
        ? state.openedFileTabs
        : [...state.openedFileTabs, path],
      activeFileTab: path,
    }));
  },
  closeFileTab: (path) => {
    const state = get();
    const splitState = useSplitViewStore.getState();
    const diff = state.openedDiffTabs.get(path);
    splitState.closeContent(diff ? { type: "diff", path, diff } : { type: "file", path }, useConversationStore.getState().activeConversationId);
    get().removeFileTabState(path);
  },
  removeFileTabState: (path) => {
    const state = get();
    const remaining = state.openedFileTabs.filter((p) => p !== path);
    const activeFileTab = state.activeFileTab === path
      ? (remaining.length > 0 ? remaining[remaining.length - 1] : null)
      : state.activeFileTab;
    const newDiffTabs = new Map(state.openedDiffTabs);
    newDiffTabs.delete(path);
    const newFileDiffOverlays = new Map(state.fileDiffOverlays);
    newFileDiffOverlays.delete(path);
    const splitHasEditor = useSplitViewStore.getState().panes.some(
      (pane) => pane.group.items.some((item) => item.content.type === "file" || item.content.type === "diff"),
    );
    set({
      openedFileTabs: remaining,
      activeFileTab,
      editorFilePath: activeFileTab ?? (splitHasEditor ? state.editorFilePath : null),
      openedDiffTabs: newDiffTabs,
      fileDiffOverlays: newFileDiffOverlays,
    });
  },
  switchToFileTab: (path) => {
    if (path) {
      const diff = get().openedDiffTabs.get(path);
      useSplitViewStore.getState().openContent(
        diff ? { type: "diff", path, diff } : { type: "file", path },
        useConversationStore.getState().activeConversationId,
      );
      set({ activeFileTab: path, editorFilePath: path });
      return;
    }
    const splitHasEditor = useSplitViewStore.getState().panes.some(
      (pane) => pane.group.items.some((item) => item.content.type === "file" || item.content.type === "diff"),
    );
    set((state) => ({
      activeFileTab: null,
      editorFilePath: splitHasEditor ? state.editorFilePath : null,
    }));
  },
  setActiveFileTab: (path, options) => set((state) => ({
    activeFileTab: path,
    editorFilePath: path ?? (options?.preserveEditorPath ? state.editorFilePath : null),
  })),
  openDiff: (diff) => set({ editorFilePath: diff.filePath, editorDiffMode: diff, activeView: "editor", isRailCollapsed: true }),
  openDiffTab: (diff) => {
    useSplitViewStore.getState().openContent(
      { type: "diff", path: diff.filePath, diff },
      useConversationStore.getState().activeConversationId,
    );
    set((state) => {
      const newDiffTabs = new Map(state.openedDiffTabs);
      newDiffTabs.set(diff.filePath, diff);
      return {
        activeView: "chat",
        openedFileTabs: state.openedFileTabs.includes(diff.filePath)
          ? state.openedFileTabs
          : [...state.openedFileTabs, diff.filePath],
        openedDiffTabs: newDiffTabs,
        activeFileTab: diff.filePath,
        editorFilePath: diff.filePath,
      };
    });
  },
  closeDiff: () => set((state) => ({ editorDiffMode: null, editorFilePath: state.editorFilePath })),
  setFileDiffOverlay: (path, diff) => set((state) => {
    const fileDiffOverlays = new Map(state.fileDiffOverlays);
    fileDiffOverlays.set(path, diff);
    return { fileDiffOverlays };
  }),
  clearFileDiffOverlay: (path) => set((state) => {
    if (!state.fileDiffOverlays.has(path)) return state;
    const fileDiffOverlays = new Map(state.fileDiffOverlays);
    fileDiffOverlays.delete(path);
    return { fileDiffOverlays };
  }),
  closeEditor: () => {
    useSplitViewStore.getState().closeEditorContent(useConversationStore.getState().activeConversationId);
    set({
      editorFilePath: null,
      editorDiffMode: null,
      openedFileTabs: [],
      activeFileTab: null,
      openedDiffTabs: new Map(),
      fileDiffOverlays: new Map(),
      activeView: "chat",
      isRailCollapsed: true,
    });
  },
  setChatPanelWidth: (width) => set({ chatPanelWidth: Math.max(300, Math.min(600, width)) }),
  setMcpConfigOpen: (open) => set({ isMcpConfigOpen: open }),
  setSkillsConfigOpen: (open) => set({ isSkillsConfigOpen: open }),
  openSettings: (tab) => set({ isSettingsOpen: true, settingsInitialTab: tab ?? null }),
  closeSettings: () => set({ isSettingsOpen: false, settingsInitialTab: null }),
  setPendingQuickAction: (prompt) => set({ pendingQuickAction: prompt }),
  setGlobalSearchOpen: (open) => set({ isGlobalSearchOpen: open }),
  setQuickCaptureOpen: (open) => set({ isQuickCaptureOpen: open }),
  setChatEntrySource: (source) => set({ chatEntrySource: source }),
  setRequirementPanelOpen: (open) => set({ isRequirementPanelOpen: open }),
  contextFiles: [],
  addContextFile: (path) =>
    set((state) => ({
      contextFiles: state.contextFiles.includes(path)
        ? state.contextFiles
        : [...state.contextFiles, path],
    })),
  removeContextFile: (path) =>
    set((state) => ({
      contextFiles: state.contextFiles.filter((p) => p !== path),
    })),
  clearContextFiles: () => set({ contextFiles: [], contextDirs: [] }),
  contextDirs: [],
  addContextDir: (path) =>
    set((state) => ({
      contextDirs: state.contextDirs.includes(path)
        ? state.contextDirs
        : [...state.contextDirs, path],
    })),
  removeContextDir: (path) =>
    set((state) => ({
      contextDirs: state.contextDirs.filter((p) => p !== path),
    })),
  creativeMode: "none",
  setCreativeMode: (mode) => set({ creativeMode: mode }),
  goalModeEnabled: false,
  setGoalModeEnabled: (enabled) => set({ goalModeEnabled: enabled }),
}));
