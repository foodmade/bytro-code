import type { TFunction } from "i18next";
import type { ConversationSummary } from "@/stores/conversation-store";
import {
  createNativeContextMenuItem,
  nativeMenuSeparator,
  popupNativeContextMenu,
  type NativeContextMenuItem,
} from "@/lib/native-context-menu";

interface ConversationContextMenuActions {
  readonly onPin: () => void | Promise<void>;
  readonly onRename: () => void | Promise<void>;
  readonly onArchive: () => void | Promise<void>;
  readonly onCopyId: () => void | Promise<void>;
  readonly onDelete: () => void | Promise<void>;
}

interface PopupConversationContextMenuOptions {
  readonly menuId: string;
  readonly conversation: ConversationSummary;
  readonly t: TFunction;
  readonly x: number;
  readonly y: number;
  readonly actions: ConversationContextMenuActions;
}

function buildConversationContextMenuItems(
  conversation: ConversationSummary,
  t: TFunction,
  actions: ConversationContextMenuActions,
): NativeContextMenuItem[] {
  const prefix = `bytro-conversation-${conversation.id}`;
  return [
    createNativeContextMenuItem(
      `${prefix}-pin`,
      conversation.is_pinned ? t("chat.contextMenu.unpin") : t("chat.contextMenu.pin"),
      actions.onPin,
      { accelerator: "CmdOrCtrl+P" },
    ),
    createNativeContextMenuItem(
      `${prefix}-rename`,
      t("chat.contextMenu.rename"),
      actions.onRename,
      { accelerator: "F2" },
    ),
    createNativeContextMenuItem(
      `${prefix}-copy-id`,
      t("chat.contextMenu.copyId"),
      actions.onCopyId,
      { accelerator: "CmdOrCtrl+C" },
    ),
    createNativeContextMenuItem(
      `${prefix}-archive`,
      conversation.is_archived ? t("chat.contextMenu.unarchive") : t("chat.contextMenu.archive"),
      actions.onArchive,
    ),
    nativeMenuSeparator(),
    createNativeContextMenuItem(
      `${prefix}-delete`,
      t("chat.contextMenu.delete"),
      actions.onDelete,
      { accelerator: "Delete" },
    ),
  ];
}

// Compatibility with the legacy component export keeps Vite HMR from crashing on stale imports.
// eslint-disable-next-line react-refresh/only-export-components
export function popupConversationContextMenu({
  menuId,
  conversation,
  t,
  x,
  y,
  actions,
}: PopupConversationContextMenuOptions): Promise<void> {
  return popupNativeContextMenu(
    menuId,
    buildConversationContextMenuItems(conversation, t, actions),
    x,
    y,
  );
}
