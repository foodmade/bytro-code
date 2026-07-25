import { useCallback, useEffect } from "react";
import { useTranslation } from "react-i18next";
import {
  PanelLeft,
  FolderOpen,
  FilePlus,
  FolderPlus,
  RefreshCw,
  ChevronsDownUp,
} from "lucide-react";
import { useAppStore, useFileTreeStore } from "@/stores";

import { IconButton } from "@/components/ui";
import type { FileTreeHandle } from "@/components/file-tree";

const SIDEBAR_MIN_WIDTH = 200;
const SIDEBAR_MAX_WIDTH_RATIO = 0.5;
const SIDEBAR_RESERVED_MAIN_WIDTH = 420;

function getMaxSidebarWidth(): number {
  if (typeof window === "undefined") return 520;
  return Math.max(
    SIDEBAR_MIN_WIDTH,
    Math.min(window.innerWidth * SIDEBAR_MAX_WIDTH_RATIO, window.innerWidth - SIDEBAR_RESERVED_MAIN_WIDTH),
  );
}

function clampSidebarWidth(width: number): number {
  return Math.max(SIDEBAR_MIN_WIDTH, Math.min(getMaxSidebarWidth(), width));
}

interface SidebarProps {
  readonly fileTree?: React.ReactNode;
  readonly fileTreeRef?: React.RefObject<FileTreeHandle | null>;
}

function ResizeHandle({ onResize }: { readonly onResize: (width: number) => void }) {
  const handlePointerDown = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      event.preventDefault();
      event.currentTarget.setPointerCapture(event.pointerId);
      const target = event.currentTarget;
      const startX = event.clientX;
      const startWidth = useAppStore.getState().sidebarWidth;
      document.body.style.cursor = "col-resize";
      document.body.style.userSelect = "none";

      const handlePointerMove = (nextEvent: PointerEvent) => {
        onResize(startWidth + nextEvent.clientX - startX);
      };

      const stopDragging = (nextEvent: PointerEvent) => {
        document.removeEventListener("pointermove", handlePointerMove);
        document.removeEventListener("pointerup", stopDragging);
        document.removeEventListener("pointercancel", stopDragging);
        if (target.hasPointerCapture(nextEvent.pointerId)) {
          target.releasePointerCapture(nextEvent.pointerId);
        }
        document.body.style.cursor = "";
        document.body.style.userSelect = "";
      };

      document.addEventListener("pointermove", handlePointerMove);
      document.addEventListener("pointerup", stopDragging);
      document.addEventListener("pointercancel", stopDragging);
    },
    [onResize],
  );

  return (
    <div
      className="no-press-scale cursor-col-resize hover:bg-accent-purple/30 active:bg-accent-purple/50 transition-colors shrink-0 group"
      style={{ width: 5, position: "relative", touchAction: "none" }}
      onPointerDown={handlePointerDown}
    >
      <div
        className="absolute inset-y-0 -left-2 -right-2"
        style={{ cursor: "col-resize" }}
      />
      <div className="w-px h-full bg-border mx-auto group-hover:bg-accent-purple/50 transition-colors" />
    </div>
  );
}

function ExplorerActionBar({
  fileTreeRef,
}: {
  readonly fileTreeRef?: React.RefObject<FileTreeHandle | null>;
}) {
  const { t } = useTranslation();
  const rootPath = useFileTreeStore((s) => s.rootPath);
  const folderName = rootPath ? rootPath.split(/[\\/]/).pop() ?? "project" : "";

  return (
    <div
      className="flex items-center justify-between shrink-0 px-3 py-2 border-b border-border"
    >
      <div className="flex items-center gap-1.5 min-w-0">
        <FolderOpen size={14} className="text-accent-purple shrink-0" />
        <span className="text-[11px] font-medium text-foreground truncate">
          {folderName}
        </span>
      </div>
      <div className="flex items-center gap-1 shrink-0">
        <IconButton
          icon={<FilePlus size={14} />}
          variant="muted"
          disabled={!rootPath}
          onClick={() => fileTreeRef?.current?.startCreate("file")}
          title={t("sidebar.newFile")}
        />
        <IconButton
          icon={<FolderPlus size={14} />}
          variant="muted"
          disabled={!rootPath}
          onClick={() => fileTreeRef?.current?.startCreate("dir")}
          title={t("sidebar.newFolder")}
        />
        <IconButton
          icon={<RefreshCw size={14} />}
          variant="muted"
          disabled={!rootPath}
          onClick={() => fileTreeRef?.current?.refresh()}
          title={t("sidebar.refresh")}
        />
        <IconButton
          icon={<ChevronsDownUp size={14} />}
          variant="muted"
          disabled={!rootPath}
          onClick={() => fileTreeRef?.current?.collapseAll()}
          title={t("sidebar.collapseAll")}
        />
      </div>
    </div>
  );
}

export function Sidebar({ fileTree, fileTreeRef }: SidebarProps) {
  const { t } = useTranslation();
  const { sidebarWidth, setSidebarWidth, isSidebarVisible, toggleSidebar } = useAppStore();

  const handleResize = useCallback(
    (width: number) => {
      setSidebarWidth(clampSidebarWidth(width));
    },
    [setSidebarWidth],
  );

  useEffect(() => {
    if (!isSidebarVisible) return;
    const clampToViewport = () => {
      const currentWidth = useAppStore.getState().sidebarWidth;
      const nextWidth = clampSidebarWidth(currentWidth);
      if (nextWidth !== currentWidth) {
        setSidebarWidth(nextWidth);
      }
    };
    clampToViewport();
    window.addEventListener("resize", clampToViewport);
    return () => window.removeEventListener("resize", clampToViewport);
  }, [isSidebarVisible, setSidebarWidth]);

  const clampedWidth = clampSidebarWidth(sidebarWidth);

  if (!isSidebarVisible) {
    return null;
  }

  return (
    <>
      <aside
        className="flex flex-col bg-surface-alt border-r border-border shrink-0 overflow-hidden"
        style={{ width: clampedWidth }}
      >
        {/* Header — Explorer only, History moved to SessionTabBar */}
        <div
          className="flex items-center shrink-0 h-[52px] border-b border-border"
        >
          <div className="flex items-center justify-center h-full flex-1 text-foreground"
            style={{ borderBottom: "2px solid var(--color-accent-purple)" }}
          >
            <span
              className="text-[11px] font-sans font-semibold"
              style={{ letterSpacing: 0.5 }}
            >
              {t("sidebar.explorer")}
            </span>
          </div>
          <IconButton
            icon={<PanelLeft size={14} />}
            variant="muted"
            onClick={toggleSidebar}
            className="h-full"
            style={{ width: 40 }}
            aria-label={t("sidebar.closeSidebar")}
          />
        </div>

        {/* Explorer panel */}
        <div className="flex flex-col flex-1 min-h-0">
          <ExplorerActionBar fileTreeRef={fileTreeRef} />
          <div className="flex-1 overflow-y-auto overflow-x-auto">
            <div className="min-w-fit">
              {fileTree}
            </div>
          </div>
        </div>
      </aside>
      <ResizeHandle onResize={handleResize} />
    </>
  );
}
