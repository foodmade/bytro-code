import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { ChevronDown, FolderOpen, Check, Pin } from "lucide-react";
import { open } from "@tauri-apps/plugin-dialog";
import { invoke } from "@tauri-apps/api/core";
import { useWorkspaceStore, useAppStore, useToastStore } from "@/stores";
import { usePressActivation } from "@/hooks/use-press-activation";
import type { WorkspaceSummary } from "@/stores/workspace-store";
import {
  createNativeContextMenuItem,
  nativeMenuSeparator,
  popupNativeContextMenu,
  type NativeContextMenuItem,
} from "@/lib/native-context-menu";
import { showWorkspaceOpenDialog } from "./workspace-open-dialog";

/* ------------------------------------------------------------------ */
/*  WorkspaceSwitcher                                                  */
/* ------------------------------------------------------------------ */

interface WorkspaceSwitcherProps {
  readonly collapsed: boolean;
}

export function WorkspaceSwitcher({ collapsed }: WorkspaceSwitcherProps) {
  const { t } = useTranslation();
  const workspaces = useWorkspaceStore((s) => s.workspaces);
  const activeId = useWorkspaceStore((s) => s.activeWorkspaceId);
  const activeWorkspace = useWorkspaceStore((s) => s.activeWorkspace);
  const openWorkspace = useWorkspaceStore((s) => s.openWorkspace);
  const addWorkspace = useWorkspaceStore((s) => s.addWorkspace);
  const setActiveView = useAppStore((s) => s.setActiveView);
  const addToast = useToastStore((s) => s.addToast);

  const [isOpen, setIsOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  // Close dropdown on outside click
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setIsOpen(false);
      }
    };
    if (isOpen) {
      document.addEventListener("mousedown", handleClickOutside);
    }
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [isOpen]);

  // Close when collapsing sidebar
  useEffect(() => {
    if (collapsed) setIsOpen(false);
  }, [collapsed]);

  const handleSwitchWorkspace = useCallback(
    async (ws: WorkspaceSummary) => {
      if (ws.id === activeId) {
        setIsOpen(false);
        return;
      }

      setIsOpen(false);
      const choice = await showWorkspaceOpenDialog(ws.name);
      if (choice === "new") {
        try {
          await invoke<string>("create_workspace_window", {
            workspaceId: ws.id,
            workspaceName: ws.name,
          });
        } catch {
          console.warn("[workspace-open][switcher] new workspace window failed to open");
          addToast("error", "新窗口打开失败，请重试");
        }
        return;
      }
      if (choice === "cancel") return;

      // "current"
      await openWorkspace(ws.id);
      setActiveView("workspace");
      invoke("update_window_workspace", {
        workspaceId: ws.id,
        workspaceName: ws.name,
      }).catch(() => {});
    },
    [activeId, addToast, openWorkspace, setActiveView],
  );

  const handleOpenProject = useCallback(async () => {
    setIsOpen(false);
    try {
      const selected = await open({ directory: true, multiple: false });
      if (!selected) return;

      const folderName = (selected as string).split(/[\\/]/).pop() ?? "Project";
      const choice = await showWorkspaceOpenDialog(folderName);
      console.warn("[workspace-open][switcher] open project choice", {
        selectedPath: selected as string,
        folderName,
        choice,
      });
      if (choice === "cancel") return;

      if (choice === "new") {
        const folderNameForWs =
          (selected as string).split(/[\\/]/).filter(Boolean).pop() ?? "workspace";
        const ws = await invoke<{ id: string; name: string; path: string }>("create_workspace", {
          name: folderNameForWs,
          path: selected as string,
        });
        console.warn("[workspace-open][switcher] workspace resolved for new window", ws);
        const label = await invoke<string>("create_workspace_window", {
          workspaceId: ws.id,
          workspaceName: ws.name,
        });
        console.warn("[workspace-open][switcher] project opened in new window", {
          workspaceId: ws.id,
          workspaceName: ws.name,
          label,
        });
        useWorkspaceStore.getState().loadWorkspaces();
        return;
      }

      // "current"
      const ws = await addWorkspace(selected as string);
      setActiveView("workspace");
      if (ws) {
        invoke("update_window_workspace", {
          workspaceId: ws.id,
          workspaceName: ws.name,
        }).catch(() => {});
      }
    } catch {
      console.warn("[workspace-open][switcher] project failed to open");
      addToast("error", "打开项目失败，请重试");
    }
  }, [addToast, addWorkspace, setActiveView]);

  // Split workspaces into pinned and recent
  const pinned = workspaces.filter((ws) => ws.is_pinned);
  const recent = workspaces.filter((ws) => !ws.is_pinned).slice(0, 8);

  const currentName = activeWorkspace?.name ?? t("workspace.noProject", "No Project");
  const togglePressActivation = usePressActivation<HTMLButtonElement>(() => {
    setIsOpen((prev) => !prev);
  });

  /* ---- Collapsed ---- */
  if (collapsed) {
    return (
      <div
        ref={containerRef}
        className="flex items-center justify-center"
        style={{ width: "100%", height: 44, position: "relative" }}
      >
        <button
          onClick={togglePressActivation.onClick}
          onPointerDown={togglePressActivation.onPointerDown}
          title={currentName}
          className="flex items-center justify-center hover:bg-hover-overlay/[0.06]"
          style={{
            width: 36,
            height: 36,
            borderRadius: 8,
            border: "none",
            cursor: "pointer",
            padding: 0,
          }}
        >
          <FolderOpen size={18} style={{ color: "#A855F7" }} />
        </button>

        {isOpen && (
          <SwitcherDropdown
            pinned={pinned}
            recent={recent}
            activeId={activeId}
            onSwitch={handleSwitchWorkspace}
            onOpenProject={handleOpenProject}
            onClose={() => setIsOpen(false)}
            position="right"
          />
        )}
      </div>
    );
  }

  /* ---- Expanded ---- */
  return (
    <div ref={containerRef} style={{ position: "relative", width: "100%" }}>
      <button
        onClick={togglePressActivation.onClick}
        onPointerDown={togglePressActivation.onPointerDown}
        className="flex items-center w-full hover:bg-hover-overlay/[0.06]"
        style={{
          height: 44,
          borderRadius: 8,
          padding: "0 8px",
          border: "none",
          cursor: "pointer",
          gap: 8,
        }}
      >
        <FolderOpen size={16} style={{ color: "#A855F7", flexShrink: 0 }} />
        <span
          className="truncate flex-1"
          style={{
            fontSize: 14,
            fontWeight: 600,
            color: "var(--color-foreground)",
            fontFamily: "Inter, sans-serif",
            textAlign: "left",
          }}
        >
          {currentName}
        </span>
        <ChevronDown
          size={14}
          style={{
            color: "var(--color-muted)",
            flexShrink: 0,
            transform: isOpen ? "rotate(180deg)" : undefined,
            transition: "transform 0.15s ease",
          }}
        />
      </button>

      {isOpen && (
        <SwitcherDropdown
          pinned={pinned}
          recent={recent}
          activeId={activeId}
          onSwitch={handleSwitchWorkspace}
          onOpenProject={handleOpenProject}
          onClose={() => setIsOpen(false)}
          position="below"
        />
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Dropdown                                                           */
/* ------------------------------------------------------------------ */

interface SwitcherDropdownProps {
  readonly pinned: ReadonlyArray<WorkspaceSummary>;
  readonly recent: ReadonlyArray<WorkspaceSummary>;
  readonly activeId: string | null;
  readonly onSwitch: (ws: WorkspaceSummary) => void;
  readonly onOpenProject: () => void;
  readonly onClose: () => void;
  readonly position: "below" | "right";
}

function SwitcherDropdown({
  pinned,
  recent,
  activeId,
  onSwitch,
  onOpenProject,
  onClose,
  position,
}: SwitcherDropdownProps) {
  const { t } = useTranslation();
  const pinWorkspace = useWorkspaceStore((s) => s.pinWorkspace);
  const removeWorkspace = useWorkspaceStore((s) => s.removeWorkspace);
  const renameWorkspace = useWorkspaceStore((s) => s.renameWorkspace);

  const [renamingId, setRenamingId] = useState<string | null>(null);
  const openProjectPressActivation = usePressActivation<HTMLButtonElement>(() => {
    onOpenProject();
  });

  const handleContextMenu = useCallback(
    (e: React.MouseEvent, ws: WorkspaceSummary) => {
      e.preventDefault();
      e.stopPropagation();
      const items: NativeContextMenuItem[] = [
        createNativeContextMenuItem(
          `bytro-workspace-${ws.id}-pin`,
          ws.is_pinned ? t("workspace.unpin", "Unpin") : t("workspace.pin", "Pin to Top"),
          () => pinWorkspace(ws.id, !ws.is_pinned),
        ),
        createNativeContextMenuItem(
          `bytro-workspace-${ws.id}-rename`,
          t("workspace.rename", "Rename"),
          () => setRenamingId(ws.id),
        ),
        nativeMenuSeparator(),
        createNativeContextMenuItem(
          `bytro-workspace-${ws.id}-remove`,
          t("workspace.removeWorkspace", "Remove Workspace"),
          async () => {
            await removeWorkspace(ws.id);
            onClose();
          },
        ),
      ];

      popupNativeContextMenu(
        "bytro-workspace-switcher-context-menu",
        items,
        e.clientX,
        e.clientY,
      ).catch(() => {
        console.error("[workspace-switcher] context menu failed to open");
      });
    },
    [onClose, pinWorkspace, removeWorkspace, t],
  );

  const handleRename = useCallback(
    async (id: string, newName: string) => {
      const trimmed = newName.trim();
      if (trimmed) {
        await renameWorkspace(id, trimmed);
      }
      setRenamingId(null);
    },
    [renameWorkspace],
  );

  const positionStyle: React.CSSProperties =
    position === "below"
      ? { top: "100%", left: 0, right: 0, marginTop: 4 }
      : { top: 0, left: "100%", marginLeft: 8, width: 220 };

  const hasItems = pinned.length > 0 || recent.length > 0;

  return (
    <>
      <div
        className={position === "below" ? "animate-popup-enter-below" : "animate-popup-enter"}
        style={{
          position: "absolute",
          ...positionStyle,
          borderRadius: 12,
          background: "var(--popup-bg)",
          border: "1px solid var(--popup-border)",
          boxShadow: "var(--shadow-popup)",
          zIndex: 200,
          overflow: "hidden",
          maxHeight: 360,
          display: "flex",
          flexDirection: "column",
        }}
      >
        {hasItems && (
          <div style={{ overflowY: "auto", flex: 1 }}>
            {/* Pinned */}
            {pinned.length > 0 && (
              <>
                <SectionHeader label={t("workspace.pinned", "Pinned")} />
                {pinned.map((ws) => (
                  <WorkspaceItem
                    key={ws.id}
                    ws={ws}
                    isActive={ws.id === activeId}
                    isPinned
                    isRenaming={renamingId === ws.id}
                    onSelect={() => onSwitch(ws)}
                    onContextMenu={(e) => handleContextMenu(e, ws)}
                    onRename={(name) => handleRename(ws.id, name)}
                    onCancelRename={() => setRenamingId(null)}
                  />
                ))}
                <div
                  style={{
                    height: 1,
                    backgroundColor: "var(--popup-border)",
                    margin: "4px 0",
                  }}
                />
              </>
            )}

            {/* Recent */}
            {recent.length > 0 && (
              <>
                <SectionHeader label={t("workspace.recent", "Recent")} />
                {recent.map((ws) => (
                  <WorkspaceItem
                    key={ws.id}
                    ws={ws}
                    isActive={ws.id === activeId}
                    isRenaming={renamingId === ws.id}
                    onSelect={() => onSwitch(ws)}
                    onContextMenu={(e) => handleContextMenu(e, ws)}
                    onRename={(name) => handleRename(ws.id, name)}
                    onCancelRename={() => setRenamingId(null)}
                  />
                ))}
              </>
            )}
          </div>
        )}

        {!hasItems && (
          <div
            style={{
              padding: "16px 14px",
              fontSize: 12,
              color: "var(--color-muted)",
              textAlign: "center",
            }}
          >
            {t("workspace.noWorkspaces", "No recent projects")}
          </div>
        )}

        {/* Open Project action */}
        <div
          style={{
            borderTop: "1px solid var(--popup-border)",
          }}
        >
          <button
            onClick={openProjectPressActivation.onClick}
            onPointerDown={openProjectPressActivation.onPointerDown}
            className="flex items-center w-full hover:bg-hover-overlay/[0.06]"
            style={{
              padding: "8px 14px",
              gap: 8,
              border: "none",
              cursor: "pointer",
            }}
          >
            <FolderOpen size={14} style={{ color: "var(--color-muted)", flexShrink: 0 }} />
            <span
              style={{
                fontSize: 12,
                color: "var(--color-muted-foreground)",
                fontFamily: "Inter, sans-serif",
              }}
            >
              {t("workspace.openProject", "Open Project...")}
            </span>
          </button>
        </div>
      </div>
    </>
  );
}

/* ------------------------------------------------------------------ */
/*  Sub-components                                                     */
/* ------------------------------------------------------------------ */

function SectionHeader({ label }: { readonly label: string }) {
  return (
    <div
      style={{
        padding: "8px 14px 4px",
        fontSize: 11,
        fontWeight: 600,
        color: "var(--color-muted)",
        fontFamily: "Inter, sans-serif",
      }}
    >
      {label}
    </div>
  );
}

interface WorkspaceItemProps {
  readonly ws: WorkspaceSummary;
  readonly isActive: boolean;
  readonly isPinned?: boolean;
  readonly isRenaming: boolean;
  readonly onSelect: () => void;
  readonly onContextMenu: (e: React.MouseEvent) => void;
  readonly onRename: (name: string) => void;
  readonly onCancelRename: () => void;
}

function WorkspaceItem({
  ws,
  isActive,
  isPinned,
  isRenaming,
  onSelect,
  onContextMenu,
  onRename,
  onCancelRename,
}: WorkspaceItemProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [renameValue, setRenameValue] = useState(ws.name);
  const selectPressActivation = usePressActivation<HTMLButtonElement>(() => {
    onSelect();
  });

  useEffect(() => {
    if (isRenaming && inputRef.current) {
      setRenameValue(ws.name);
      inputRef.current.focus();
      inputRef.current.select();
    }
  }, [isRenaming, ws.name]);

  const commitRename = useCallback(() => {
    onRename(renameValue);
  }, [onRename, renameValue]);

  if (isRenaming) {
    return (
      <div className="flex items-center w-full" style={{ padding: "4px 14px", gap: 8 }}>
        {isPinned ? (
          <Pin size={13} style={{ color: "#F59E0B", flexShrink: 0 }} />
        ) : (
          <div style={{ width: 13, flexShrink: 0 }} />
        )}
        <input
          ref={inputRef}
          value={renameValue}
          onChange={(e) => setRenameValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") commitRename();
            if (e.key === "Escape") onCancelRename();
          }}
          onBlur={commitRename}
          className="flex-1"
          style={{
            fontSize: 13,
            fontWeight: 400,
            color: "var(--color-foreground)",
            fontFamily: "Inter, sans-serif",
            background: "var(--color-background)",
            border: "1px solid var(--color-border-strong)",
            borderRadius: 4,
            padding: "2px 6px",
            outline: "none",
          }}
        />
      </div>
    );
  }

  return (
    <button
      onClick={selectPressActivation.onClick}
      onPointerDown={selectPressActivation.onPointerDown}
      onContextMenu={onContextMenu}
      className={`flex items-center w-full ${
        isActive ? "bg-purple-500/[0.08]" : "hover:bg-hover-overlay/[0.06]"
      }`}
      style={{
        padding: "6px 14px",
        gap: 8,
        border: "none",
        cursor: "pointer",
      }}
    >
      {isPinned ? (
        <Pin size={13} style={{ color: "#F59E0B", flexShrink: 0 }} />
      ) : (
        <div style={{ width: 13, flexShrink: 0 }} />
      )}
      <span
        className="truncate flex-1"
        style={{
          fontSize: 13,
          fontWeight: isActive ? 500 : 400,
          color: isActive ? "var(--color-foreground)" : "var(--color-muted-foreground)",
          fontFamily: "Inter, sans-serif",
          textAlign: "left",
        }}
      >
        {ws.name}
      </span>
      {isActive && <Check size={14} style={{ color: "#A855F7", flexShrink: 0 }} />}
    </button>
  );
}
