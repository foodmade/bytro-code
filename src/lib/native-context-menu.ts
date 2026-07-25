import { Channel, invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";

export type NativeContextMenuItem =
  | { readonly item: "Separator" }
  | {
      readonly id?: string;
      readonly text: string;
      readonly accelerator?: string;
      readonly enabled?: boolean;
      readonly handler?: Channel<unknown>;
    };

export interface NativeContextMenuPosition {
  readonly x: number;
  readonly y: number;
}

export interface NativeContextMenuViewport {
  readonly width: number;
  readonly height: number;
  readonly padding?: number;
}

interface NativeContextMenuPopupOptions {
  readonly position?: NativeContextMenuPosition | null;
  readonly windowLabel?: string | null;
  readonly constrainToViewport?: boolean;
}

const NATIVE_CONTEXT_MENU_VIEWPORT_PADDING = 8;
const NATIVE_CONTEXT_MENU_ESTIMATED_WIDTH = 330;
const NATIVE_CONTEXT_MENU_ESTIMATED_VERTICAL_PADDING = 12;
const NATIVE_CONTEXT_MENU_ESTIMATED_ITEM_HEIGHT = 24;
const NATIVE_CONTEXT_MENU_ESTIMATED_SEPARATOR_HEIGHT = 8;

export function nativeMenuSeparator(): NativeContextMenuItem {
  return { item: "Separator" };
}

export function createNativeContextMenuItem(
  id: string,
  text: string,
  action: () => void | Promise<void>,
  options: { readonly accelerator?: string; readonly enabled?: boolean } = {},
): NativeContextMenuItem {
  const handler = new Channel<unknown>(() => {
    void action();
  });
  return {
    id,
    text,
    ...options,
    handler,
  };
}

function cleanupNativeContextMenuChannel(channel: Channel<unknown> | undefined): void {
  (channel as unknown as { cleanupCallback?: () => void } | undefined)?.cleanupCallback?.();
}

function toLogicalPosition(position: NativeContextMenuPosition | null | undefined): { Logical: NativeContextMenuPosition } | null {
  return position ? { Logical: position } : null;
}

function estimateNativeContextMenuHeight(items: readonly NativeContextMenuItem[]): number {
  return items.reduce((height, item) => (
    height + ("item" in item ? NATIVE_CONTEXT_MENU_ESTIMATED_SEPARATOR_HEIGHT : NATIVE_CONTEXT_MENU_ESTIMATED_ITEM_HEIGHT)
  ), NATIVE_CONTEXT_MENU_ESTIMATED_VERTICAL_PADDING);
}

export function constrainNativeContextMenuPosition(
  position: NativeContextMenuPosition,
  items: readonly NativeContextMenuItem[],
  viewport: NativeContextMenuViewport,
): NativeContextMenuPosition {
  const padding = viewport.padding ?? NATIVE_CONTEXT_MENU_VIEWPORT_PADDING;
  const estimatedWidth = NATIVE_CONTEXT_MENU_ESTIMATED_WIDTH;
  const estimatedHeight = estimateNativeContextMenuHeight(items);
  const maxX = Math.max(padding, viewport.width - estimatedWidth - padding);
  const maxY = Math.max(padding, viewport.height - estimatedHeight - padding);

  return {
    x: Math.min(Math.max(position.x, padding), maxX),
    y: Math.min(Math.max(position.y, padding), maxY),
  };
}

function getCurrentViewport(): NativeContextMenuViewport | null {
  return typeof window === "undefined"
    ? null
    : { width: window.innerWidth, height: window.innerHeight };
}

export async function popupNativeContextMenu(
  menuId: string,
  items: readonly NativeContextMenuItem[],
  fallbackX: number,
  fallbackY: number,
  options: NativeContextMenuPopupOptions = {},
): Promise<void> {
  const handler = new Channel<unknown>();
  const requestedPosition = options.position === undefined ? { x: fallbackX, y: fallbackY } : options.position;
  const viewport = requestedPosition && options.constrainToViewport !== false ? getCurrentViewport() : null;
  const position = requestedPosition && viewport
    ? constrainNativeContextMenuPosition(requestedPosition, items, viewport)
    : requestedPosition;
  const windowLabel = position ? options.windowLabel ?? getCurrentWindow().label : null;
  let rid: number | null = null;
  try {
    [rid] = await invoke<[number, string]>("plugin:menu|new", {
      kind: "Menu",
      options: { id: menuId, items },
      handler,
    });

    try {
      await invoke("plugin:menu|popup", {
        rid,
        kind: "Menu",
        window: windowLabel,
        at: toLogicalPosition(position),
      });
    } catch (err) {
      try {
        await invoke("plugin:menu|popup", {
          rid,
          kind: "Menu",
          window: windowLabel,
          at: null,
        });
      } catch {
        throw err;
      }
    }
  } finally {
    if (rid !== null) {
      await invoke("plugin:resources|close", { rid }).catch(() => {});
    }
    cleanupNativeContextMenuChannel(handler);
    items.forEach((item) => {
      if ("handler" in item) {
        cleanupNativeContextMenuChannel(item.handler);
      }
    });
  }
}
