import type { TFunction } from "i18next";
import {
  createNativeContextMenuItem,
  nativeMenuSeparator,
  popupNativeContextMenu,
  type NativeContextMenuItem,
} from "@/lib/native-context-menu";

interface TabContextMenuActions {
  readonly onPin: () => void | Promise<void>;
  readonly onRename: () => void | Promise<void>;
  readonly onCloseSession: () => void | Promise<void>;
  readonly onCloseOthers: () => void | Promise<void>;
  readonly onCloseAll: () => void | Promise<void>;
  readonly onDelete: () => void | Promise<void>;
}

interface PopupTabContextMenuOptions {
  readonly conversationId: string;
  readonly isPinned: boolean;
  readonly t: TFunction;
  readonly x: number;
  readonly y: number;
  readonly actions: TabContextMenuActions;
}

function buildTabContextMenuItems(
  isPinned: boolean,
  t: TFunction,
  actions: TabContextMenuActions,
): NativeContextMenuItem[] {
  return [
    createNativeContextMenuItem(
      "tab-pin",
      isPinned ? t("chat.contextMenu.unpin") : t("chat.contextMenu.pin"),
      actions.onPin,
    ),
    createNativeContextMenuItem("tab-rename", t("chat.contextMenu.rename"), actions.onRename),
    nativeMenuSeparator(),
    createNativeContextMenuItem(
      "tab-close",
      t("chat.contextMenu.closeSession"),
      actions.onCloseSession,
    ),
    createNativeContextMenuItem(
      "tab-close-others",
      t("chat.contextMenu.closeOthers"),
      actions.onCloseOthers,
    ),
    createNativeContextMenuItem(
      "tab-close-all",
      t("chat.contextMenu.closeAll"),
      actions.onCloseAll,
    ),
    nativeMenuSeparator(),
    createNativeContextMenuItem("tab-delete", t("chat.contextMenu.delete"), actions.onDelete),
  ];
}

export function popupTabContextMenu({
  conversationId,
  isPinned,
  t,
  x,
  y,
  actions,
}: PopupTabContextMenuOptions): Promise<void> {
  return popupNativeContextMenu(
    `bytro-tab-${conversationId}`,
    buildTabContextMenuItems(isPinned, t, actions),
    x,
    y,
  );
}
