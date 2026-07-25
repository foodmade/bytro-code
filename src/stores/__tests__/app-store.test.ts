import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { useAppStore } from "@/stores/app-store";
import { useSplitViewStore } from "@/stores/split-view-store";

function resetStores() {
  useSplitViewStore.getState().resetToSingle(null);
  useAppStore.setState({
    editorFilePath: null,
    editorDiffMode: null,
    openedFileTabs: [],
    activeFileTab: null,
    openedDiffTabs: new Map(),
  });
}

describe("useAppStore", () => {
  beforeEach(() => {
    resetStores();
  });

  afterEach(() => {
    resetStores();
  });

  it("preserves editorFilePath when clearing the active file tab while a split editor exists", () => {
    const splitStore = useSplitViewStore.getState();
    splitStore.ensureInitialized("conv-a");
    splitStore.openContent({ type: "file", path: "/tmp/demo.ts" }, "conv-a");

    useAppStore.setState({ editorFilePath: "/tmp/demo.ts", activeFileTab: "/tmp/demo.ts" });

    useAppStore.getState().switchToFileTab(null);

    const state = useAppStore.getState();
    expect(state.activeFileTab).toBeNull();
    expect(state.editorFilePath).toBe("/tmp/demo.ts");
  });

  it("clears editorFilePath when clearing the active file tab without split editors", () => {
    useSplitViewStore.getState().ensureInitialized("conv-a");
    useAppStore.setState({ editorFilePath: "/tmp/demo.ts", activeFileTab: "/tmp/demo.ts" });

    useAppStore.getState().switchToFileTab(null);

    const state = useAppStore.getState();
    expect(state.activeFileTab).toBeNull();
    expect(state.editorFilePath).toBeNull();
  });

  it("removes split editor panes when closing the editor", () => {
    const splitStore = useSplitViewStore.getState();
    splitStore.ensureInitialized("conv-a");
    splitStore.openContent({ type: "file", path: "/tmp/demo.ts" }, "conv-a");
    useAppStore.setState({
      editorFilePath: "/tmp/demo.ts",
      activeFileTab: "/tmp/demo.ts",
      openedFileTabs: ["/tmp/demo.ts"],
    });

    useAppStore.getState().closeEditor();

    const appState = useAppStore.getState();
    const splitState = useSplitViewStore.getState();
    expect(appState.editorFilePath).toBeNull();
    expect(appState.activeFileTab).toBeNull();
    expect(appState.openedFileTabs).toEqual([]);
    expect(splitState.layout).toBe("single");
    expect(splitState.panes).toHaveLength(1);
    expect(splitState.panes[0]?.content).toEqual({ type: "chat", conversationId: "conv-a" });
  });

  it("collapses the split when closing the final global file tab", () => {
    const appStore = useAppStore.getState();
    useSplitViewStore.getState().ensureInitialized("conv-a");

    appStore.openFile("/tmp/demo.ts");
    appStore.closeFileTab("/tmp/demo.ts");

    const appState = useAppStore.getState();
    const splitState = useSplitViewStore.getState();
    expect(appState.editorFilePath).toBeNull();
    expect(appState.activeFileTab).toBeNull();
    expect(appState.openedFileTabs).toEqual([]);
    expect(splitState.layout).toBe("single");
    expect(splitState.panes).toHaveLength(1);
    expect(splitState.panes[0]?.content).toEqual({ type: "chat", conversationId: "conv-a" });
    expect(splitState.activePaneId).toBe(splitState.panes[0]?.id);
  });

  it("removes only app file tab state without closing split content", () => {
    const splitStore = useSplitViewStore.getState();
    splitStore.ensureInitialized("conv-a");
    splitStore.openContent({ type: "file", path: "/tmp/one.ts" }, "conv-a");
    splitStore.openContent({ type: "file", path: "/tmp/two.ts" }, "conv-a");
    useAppStore.setState({
      editorFilePath: "/tmp/two.ts",
      activeFileTab: "/tmp/two.ts",
      openedFileTabs: ["/tmp/one.ts", "/tmp/two.ts"],
    });

    useAppStore.getState().removeFileTabState("/tmp/two.ts");

    const appState = useAppStore.getState();
    const splitState = useSplitViewStore.getState();
    expect(appState.openedFileTabs).toEqual(["/tmp/one.ts"]);
    expect(appState.activeFileTab).toBe("/tmp/one.ts");
    expect(appState.editorFilePath).toBe("/tmp/one.ts");
    expect(splitState.panes.some((pane) => pane.group.items.some((item) => item.id === "file:/tmp/two.ts"))).toBe(true);
  });

  it("clears file tab state when removing the last file tab", () => {
    useSplitViewStore.getState().ensureInitialized("conv-a");
    useAppStore.setState({
      editorFilePath: "/tmp/one.ts",
      activeFileTab: "/tmp/one.ts",
      openedFileTabs: ["/tmp/one.ts"],
    });

    useAppStore.getState().removeFileTabState("/tmp/one.ts");

    const appState = useAppStore.getState();
    expect(appState.openedFileTabs).toEqual([]);
    expect(appState.activeFileTab).toBeNull();
    expect(appState.editorFilePath).toBeNull();
  });

  it("removes diff tab state", () => {
    const diff = { filePath: "/tmp/one.ts", original: "a", modified: "b" };
    useSplitViewStore.getState().ensureInitialized("conv-a");
    useAppStore.setState({
      editorFilePath: "/tmp/one.ts",
      activeFileTab: "/tmp/one.ts",
      openedFileTabs: ["/tmp/one.ts"],
      openedDiffTabs: new Map([["/tmp/one.ts", diff]]),
    });

    useAppStore.getState().removeFileTabState("/tmp/one.ts");

    const appState = useAppStore.getState();
    expect(appState.openedFileTabs).toEqual([]);
    expect(appState.openedDiffTabs.has("/tmp/one.ts")).toBe(false);
  });
});
