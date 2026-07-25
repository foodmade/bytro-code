import type { SplitDropZone, SplitPaneId } from "@/stores";

export interface ResolvedSplitTarget {
  readonly zone: SplitDropZone;
  readonly paneId: SplitPaneId | null;
  readonly mode: "split" | "replace";
}

interface ResolveSplitTargetOptions {
  readonly allowCenter?: boolean;
}

const WORKSPACE_SELECTOR = ".split-chat-workspace-body";
const PANE_SELECTOR = ".split-chat-pane[data-pane-id]";

function pointInsideRect(x: number, y: number, rect: DOMRect): boolean {
  return x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom;
}

export function resolvePaneZone(
  x: number,
  y: number,
  paneRect: DOMRect,
  options: ResolveSplitTargetOptions = {},
): SplitDropZone {
  const { allowCenter = false } = options;
  const width = Math.max(paneRect.width, 1);
  const height = Math.max(paneRect.height, 1);
  const centerInsetX = Math.min(72, Math.max(32, width * 0.14));
  const centerInsetY = Math.min(72, Math.max(32, height * 0.14));
  const dx = x - (paneRect.left + width / 2);
  const dy = y - (paneRect.top + height / 2);

  if (allowCenter && Math.abs(dx) <= centerInsetX && Math.abs(dy) <= centerInsetY) {
    return "center";
  }

  const normalizedDx = dx / width;
  const normalizedDy = dy / height;
  if (Math.abs(normalizedDx) >= Math.abs(normalizedDy)) {
    return normalizedDx < 0 ? "left" : "right";
  }
  return normalizedDy < 0 ? "top" : "bottom";
}

export function resolveSplitTargetAtPoint(
  x: number,
  y: number,
  options: ResolveSplitTargetOptions = {},
): ResolvedSplitTarget | null {
  const { allowCenter = false } = options;
  const workspaceEl = document.querySelector<HTMLElement>(WORKSPACE_SELECTOR);
  if (!workspaceEl) {
    return null;
  }

  const workspaceRect = workspaceEl.getBoundingClientRect();
  if (!pointInsideRect(x, y, workspaceRect)) {
    return null;
  }

  const paneElements = Array.from(workspaceEl.querySelectorAll<HTMLElement>(PANE_SELECTOR));
  if (paneElements.length === 0) {
    return null;
  }
  for (const paneEl of paneElements) {
    const paneId = paneEl.dataset.paneId as SplitPaneId | undefined;
    if (!paneId) continue;
    const paneRect = paneEl.getBoundingClientRect();
    if (!pointInsideRect(x, y, paneRect)) continue;

    const zone = resolvePaneZone(x, y, paneRect, { allowCenter });

    return {
      zone,
      paneId,
      mode: zone === "center" ? "replace" : "split",
    };
  }

  return null;
}
