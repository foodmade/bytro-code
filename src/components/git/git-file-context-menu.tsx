import {
  createNativeContextMenuItem,
  nativeMenuSeparator,
  popupNativeContextMenu,
  type NativeContextMenuItem,
} from "@/lib/native-context-menu";

export interface GitFileContextMenuInfo {
  readonly filePath: string;
  readonly isStaged: boolean;
}

type GitMenuTranslate = (key: string) => string;

interface GitFileContextMenuActions {
  readonly onOpen?: () => void;
  readonly onOpenInExplorer?: () => void;
  readonly onCopyPath?: () => void;
  readonly onRemove?: () => void;
  readonly onDiscardChanges?: () => void;
  readonly onStopTracking?: () => void;
  readonly onChangeHistory?: () => void;
  readonly onStage?: () => void;
  readonly onUnstage?: () => void;
}

function gitFileMenuItem(
  id: string,
  label: string,
  action: (() => void) | undefined,
): NativeContextMenuItem {
  return createNativeContextMenuItem(id, label, () => action?.(), { enabled: Boolean(action) });
}

export function popupGitFileContextMenu(
  info: GitFileContextMenuInfo,
  x: number,
  y: number,
  t: GitMenuTranslate,
  actions: GitFileContextMenuActions,
): Promise<void> {
  const items: NativeContextMenuItem[] = [
    gitFileMenuItem("bytro-git-file-open", t("git.fileCtx.open"), actions.onOpen),
    gitFileMenuItem("bytro-git-file-open-in-explorer", t("git.fileCtx.openInExplorer"), actions.onOpenInExplorer),
    gitFileMenuItem("bytro-git-file-copy-path", t("git.fileCtx.copyPath"), actions.onCopyPath),
    nativeMenuSeparator(),
  ];

  if (info.isStaged) {
    items.push(
      gitFileMenuItem("bytro-git-file-unstage", t("git.fileCtx.unstage"), actions.onUnstage),
      nativeMenuSeparator(),
      gitFileMenuItem("bytro-git-file-change-history", t("git.fileCtx.changeHistory"), actions.onChangeHistory),
    );
  } else {
    items.push(
      gitFileMenuItem("bytro-git-file-stage", t("git.fileCtx.stage"), actions.onStage),
      gitFileMenuItem("bytro-git-file-remove", t("git.fileCtx.remove"), actions.onRemove),
      gitFileMenuItem("bytro-git-file-discard-changes", t("git.fileCtx.discardChanges"), actions.onDiscardChanges),
      gitFileMenuItem("bytro-git-file-stop-tracking", t("git.fileCtx.stopTracking"), actions.onStopTracking),
      nativeMenuSeparator(),
      gitFileMenuItem("bytro-git-file-change-history", t("git.fileCtx.changeHistory"), actions.onChangeHistory),
    );
  }

  return popupNativeContextMenu("bytro-git-file-context-menu", items, x, y);
}
