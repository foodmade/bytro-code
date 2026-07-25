import { useCallback, useEffect, useRef, useState } from "react";
import {
  ChevronRight,
  ChevronDown,
  Folder,
  FolderOpen,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { InlineCreateInput } from "./inline-create-input";
import { getFileIcon } from "./file-icons";
import type { TreeNode, CreatingInfo, RenameInfo } from "./file-tree-types";

const FOLDER_COLORS: Record<string, string> = {
  src: "var(--color-accent-purple)",
  chat: "var(--color-accent-purple)",
  components: "#4285F4",
  layout: "#4285F4",
  lib: "#4285F4",
  hooks: "#10B981",
  "file-tree": "#10B981",
  sidecar: "#10B981",
  stores: "#FEBC2E",
  editor: "#FEBC2E",
  settings: "#EF4444",
  assets: "#F97316",
  "src-tauri": "#F97316",
};

function getFolderColor(name: string): string {
  return FOLDER_COLORS[name] ?? "#4285F4";
}

export interface FileTreeNodeProps {
  readonly node: TreeNode;
  readonly depth: number;
  readonly selectedPath: string | null;
  readonly expandedPaths: ReadonlySet<string>;
  readonly creating: CreatingInfo | null;
  readonly renaming: RenameInfo | null;
  readonly onToggle: (path: string) => void;
  readonly onSelect: (path: string) => void;
  readonly onCreateConfirm: (name: string) => void;
  readonly onCreateCancel: () => void;
  readonly onContextMenu: (e: React.MouseEvent, node: TreeNode) => void;
  readonly onRenameConfirm: (newName: string) => void;
  readonly onRenameCancel: () => void;
}

export function FileTreeNode({
  node,
  depth,
  selectedPath,
  expandedPaths,
  creating,
  renaming,
  onToggle,
  onSelect,
  onCreateConfirm,
  onCreateCancel,
  onContextMenu,
  onRenameConfirm,
  onRenameCancel,
}: FileTreeNodeProps) {
  const isExpanded = expandedPaths.has(node.path);
  const isSelected = selectedPath === node.path;
  const isRenaming = renaming !== null && renaming.path === node.path;
  const [renameValue, setRenameValue] = useState(node.name);
  const renameInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (isRenaming) {
      setRenameValue(node.name);
      setTimeout(() => {
        renameInputRef.current?.focus();
        // Select filename without extension for files
        if (!node.isDir && node.extension) {
          const dotIdx = node.name.lastIndexOf(".");
          renameInputRef.current?.setSelectionRange(0, dotIdx > 0 ? dotIdx : node.name.length);
        } else {
          renameInputRef.current?.select();
        }
      }, 0);
    }
  }, [isRenaming, node.name, node.isDir, node.extension]);

  const handleClick = useCallback(() => {
    if (node.isDir) {
      onToggle(node.path);
    } else {
      onSelect(node.path);
    }
  }, [node.path, node.isDir, onToggle, onSelect]);

  const handleRightClick = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      e.stopPropagation();
      onContextMenu(e, node);
    },
    [node, onContextMenu],
  );

  const handleRenameSubmit = useCallback(() => {
    const trimmed = renameValue.trim();
    if (trimmed && trimmed !== node.name) {
      onRenameConfirm(trimmed);
    } else {
      onRenameCancel();
    }
  }, [renameValue, node.name, onRenameConfirm, onRenameCancel]);

  const folderColor = node.isDir ? getFolderColor(node.name) : undefined;
  const showInlineCreate = creating !== null && creating.parentPath === node.path && isExpanded;

  return (
    <div>
      <button
        onClick={handleClick}
        onContextMenu={handleRightClick}
        data-file-tree-path={node.path}
        className={cn(
          "flex items-center gap-2 w-full text-[12px] font-sans hover:bg-hover-overlay/5 transition-colors group text-left",
          isSelected && "bg-card"
        )}
        style={{ paddingLeft: depth * 16 + 16, paddingTop: 6, paddingBottom: 6 }}
      >
        {node.isDir ? (
          <>
            {isExpanded ? (
              <ChevronDown size={12} className="text-text-tertiary shrink-0" />
            ) : (
              <ChevronRight size={12} className="text-text-tertiary shrink-0" />
            )}
            {isExpanded ? (
              <FolderOpen size={14} className="shrink-0" style={{ color: folderColor }} />
            ) : (
              <Folder size={14} className="shrink-0" style={{ color: folderColor }} />
            )}
          </>
        ) : (
          <>
            <span className="w-3 shrink-0" />
            {getFileIcon(node.extension, node.name)}
          </>
        )}
        {isRenaming ? (
          <input
            ref={renameInputRef}
            value={renameValue}
            onChange={(e) => setRenameValue(e.target.value)}
            onBlur={handleRenameSubmit}
            onKeyDown={(e) => {
              if (e.key === "Enter") handleRenameSubmit();
              if (e.key === "Escape") onRenameCancel();
            }}
            onClick={(e) => e.stopPropagation()}
            className="flex-1 min-w-0 bg-surface-dark border border-border-strong rounded px-1.5 py-0.5 text-[12px] text-foreground font-sans outline-none focus:border-accent-purple"
          />
        ) : (
          <span
            className={cn(
              "whitespace-nowrap group-hover:text-foreground",
              isSelected ? "text-foreground font-medium" : "text-muted-foreground",
              node.isDir && depth === 0 && "text-foreground font-semibold",
              node.isDir && depth > 0 && !isSelected && "text-muted-foreground font-medium",
            )}
            title={node.name}
          >
            {node.name}
          </span>
        )}
      </button>

      {node.isDir && isExpanded && node.children && (
        <div>
          {showInlineCreate && (
            <InlineCreateInput
              type={creating.type}
              depth={depth + 1}
              onConfirm={onCreateConfirm}
              onCancel={onCreateCancel}
            />
          )}
          {node.children.map((child) => (
            <FileTreeNode
              key={child.path}
              node={child}
              depth={depth + 1}
              selectedPath={selectedPath}
              expandedPaths={expandedPaths}
              creating={creating}
              renaming={renaming}
              onToggle={onToggle}
              onSelect={onSelect}
              onCreateConfirm={onCreateConfirm}
              onCreateCancel={onCreateCancel}
              onContextMenu={onContextMenu}
              onRenameConfirm={onRenameConfirm}
              onRenameCancel={onRenameCancel}
            />
          ))}
        </div>
      )}
    </div>
  );
}
