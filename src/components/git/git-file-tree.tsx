import {
  ChevronRight,
  Folder,
  FolderOpen,
  ChevronDown,
  Plus,
  Minus,
} from "lucide-react";
import { useState, useMemo, useCallback } from "react";
import { useTranslation } from "react-i18next";
import type { GitFileStatus, FileDiffStat } from "@/stores/git-store";
import { formatError } from "@/lib/format-error";
import { useToastStore } from "@/stores/toast-store";
import { FileRow } from "./git-file-list";
import { popupGitFileContextMenu } from "./git-file-context-menu";

// ── Types ──────────────────────────────────────────────────────────

interface GitTreeNode {
  readonly name: string;
  readonly path: string;
  readonly isDir: boolean;
  readonly children: ReadonlyArray<GitTreeNode>;
  readonly file?: GitFileStatus;
  readonly fileCount: number;
}

// ── Folder colors (matching file-tree-node.tsx palette) ────────────

const FOLDER_COLORS: Record<string, string> = {
  src: "#42A5F5",
  lib: "#42A5F5",
  components: "#AB47BC",
  hooks: "#26A69A",
  stores: "#FFA726",
  store: "#FFA726",
  utils: "#78909C",
  types: "#5C6BC0",
  styles: "#EC407A",
  assets: "#66BB6A",
  public: "#66BB6A",
  config: "#78909C",
  scripts: "#78909C",
  test: "#EF5350",
  tests: "#EF5350",
  __tests__: "#EF5350",
  i18n: "#26C6DA",
  locales: "#26C6DA",
};

function getFolderColor(name: string): string {
  const lowerName = name.toLowerCase();
  // For compacted paths like "src/components", check the last segment
  const lastSegment = lowerName.includes("/") ? lowerName.split("/").pop()! : lowerName;
  return FOLDER_COLORS[lastSegment] ?? "var(--color-muted)";
}

// ── Build tree from flat file list ─────────────────────────────────

function buildGitFileTree(files: ReadonlyArray<GitFileStatus>): ReadonlyArray<GitTreeNode> {
  if (files.length === 0) return [];

  const dirChildren = new Map<string, GitTreeNode[]>();
  dirChildren.set("", []);

  for (const file of files) {
    const normalizedPath = file.path.replace(/\\/g, "/");
    const parts = normalizedPath.split("/");
    let currentDir = "";

    // Ensure all parent directories exist
    for (let i = 0; i < parts.length - 1; i++) {
      const parentDir = currentDir;
      currentDir = currentDir ? `${currentDir}/${parts[i]}` : parts[i];
      if (!dirChildren.has(currentDir)) {
        dirChildren.set(currentDir, []);
        dirChildren.get(parentDir)!.push({
          name: parts[i],
          path: currentDir,
          isDir: true,
          children: [],
          fileCount: 0,
        });
      }
    }

    // Add file to parent directory
    const parentDir = parts.length > 1 ? parts.slice(0, -1).join("/") : "";
    dirChildren.get(parentDir)!.push({
      name: parts[parts.length - 1],
      path: normalizedPath,
      isDir: false,
      children: [],
      file,
      fileCount: 1,
    });
  }

  // Resolve children & compute fileCount bottom-up
  function resolveNode(node: GitTreeNode): GitTreeNode {
    if (!node.isDir) return node;
    const rawChildren = dirChildren.get(node.path) ?? [];
    const resolved = rawChildren.map(resolveNode);
    const sorted = resolved.sort((a, b) => {
      if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
    const fileCount = sorted.reduce((sum, child) => sum + child.fileCount, 0);
    return { ...node, children: sorted, fileCount };
  }

  const rootChildren = (dirChildren.get("") ?? []).map(resolveNode);
  const sorted = rootChildren.sort((a, b) => {
    if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
    return a.name.localeCompare(b.name);
  });

  return sorted.map(compactNode);
}

/** Merge single-child directory chains: a/b/c → one node "a/b/c" */
function compactNode(node: GitTreeNode): GitTreeNode {
  if (!node.isDir) return node;
  let current = node;
  while (current.children.length === 1 && current.children[0].isDir) {
    const child = current.children[0];
    current = {
      ...child,
      name: `${current.name}/${child.name}`,
    };
  }
  return {
    ...current,
    children: current.children.map(compactNode),
  };
}

/** Collect all directory paths from a tree (for default-expand-all) */
function collectDirPaths(nodes: ReadonlyArray<GitTreeNode>): Set<string> {
  const paths = new Set<string>();
  function walk(node: GitTreeNode) {
    if (node.isDir) {
      paths.add(node.path);
      for (const child of node.children) walk(child);
    }
  }
  for (const n of nodes) walk(n);
  return paths;
}

// ── Directory Row ──────────────────────────────────────────────────

function GitTreeDirRow({
  node,
  depth,
  isExpanded,
  onToggle,
}: {
  readonly node: GitTreeNode;
  readonly depth: number;
  readonly isExpanded: boolean;
  readonly onToggle: () => void;
}) {
  const folderColor = getFolderColor(node.name);
  const FolderIcon = isExpanded ? FolderOpen : Folder;

  return (
    <div
      onClick={onToggle}
      className="flex items-center cursor-pointer group transition-colors hover:bg-hover-overlay/[0.03]"
      style={{
        padding: "4px 12px",
        paddingLeft: depth * 16 + 12,
        borderRadius: 4,
      }}
    >
      <ChevronRight
        size={12}
        style={{
          color: "var(--color-muted)",
          transform: isExpanded ? "rotate(90deg)" : undefined,
          transition: "transform 150ms",
          flexShrink: 0,
          marginRight: 4,
        }}
      />
      <FolderIcon
        size={14}
        style={{ color: folderColor, flexShrink: 0, marginRight: 6 }}
      />
      <span
        className="truncate text-[12px] font-mono"
        style={{ color: "var(--color-muted-foreground)" }}
        title={node.path}
      >
        {node.name}
      </span>
      <span
        className="text-[10px] font-mono shrink-0"
        style={{
          color: "var(--color-muted)",
          marginLeft: 6,
        }}
      >
        {node.fileCount}
      </span>
    </div>
  );
}

// ── File Row wrapper (adds indentation) ────────────────────────────

function GitTreeFileRow({
  node,
  depth,
  diffStat,
  isSelected,
  onSelect,
  onDiff,
  onStage,
  onUnstage,
  onDiscard,
  onContextMenu,
}: {
  readonly node: GitTreeNode;
  readonly depth: number;
  readonly diffStat?: FileDiffStat;
  readonly isSelected: boolean;
  readonly onSelect: () => void;
  readonly onDiff: () => void;
  readonly onStage?: () => void;
  readonly onUnstage?: () => void;
  readonly onDiscard?: () => void;
  readonly onContextMenu?: (e: React.MouseEvent) => void;
}) {
  if (!node.file) return null;

  return (
    <div style={{ paddingLeft: depth * 16 }}>
      <FileRow
        file={node.file}
        diffStat={diffStat}
        isSelected={isSelected}
        onSelect={onSelect}
        onDiff={onDiff}
        onStage={onStage}
        onUnstage={onUnstage}
        onDiscard={onDiscard}
        onContextMenu={onContextMenu}
      />
    </div>
  );
}

// ── Recursive tree renderer ────────────────────────────────────────

function TreeNodes({
  nodes,
  depth,
  expandedDirs,
  onToggleDir,
  fileDiffStats,
  selectedFile,
  isStaged,
  onSelectFile,
  onDiffFile,
  onStageFile,
  onUnstageFile,
  onDiscardFile,
  onContextMenu,
}: {
  readonly nodes: ReadonlyArray<GitTreeNode>;
  readonly depth: number;
  readonly expandedDirs: Set<string>;
  readonly onToggleDir: (path: string) => void;
  readonly fileDiffStats: ReadonlyMap<string, FileDiffStat>;
  readonly selectedFile: string | null;
  readonly isStaged: boolean;
  readonly onSelectFile: (path: string) => void;
  readonly onDiffFile: (path: string, staged: boolean) => void;
  readonly onStageFile?: (path: string) => void;
  readonly onUnstageFile?: (path: string) => void;
  readonly onDiscardFile?: (path: string) => void;
  readonly onContextMenu: (e: React.MouseEvent, filePath: string) => void;
}) {
  return (
    <>
      {nodes.map((node) => {
        if (node.isDir) {
          const isExpanded = expandedDirs.has(node.path);
          return (
            <div key={node.path}>
              <GitTreeDirRow
                node={node}
                depth={depth}
                isExpanded={isExpanded}
                onToggle={() => onToggleDir(node.path)}
              />
              {isExpanded && (
                <TreeNodes
                  nodes={node.children}
                  depth={depth + 1}
                  expandedDirs={expandedDirs}
                  onToggleDir={onToggleDir}
                  fileDiffStats={fileDiffStats}
                  selectedFile={selectedFile}
                  isStaged={isStaged}
                  onSelectFile={onSelectFile}
                  onDiffFile={onDiffFile}
                  onStageFile={onStageFile}
                  onUnstageFile={onUnstageFile}
                  onDiscardFile={onDiscardFile}
                  onContextMenu={onContextMenu}
                />
              )}
            </div>
          );
        }

        return (
          <GitTreeFileRow
            key={node.path}
            node={node}
            depth={depth}
            diffStat={fileDiffStats.get(node.file?.path ?? "")}
            isSelected={selectedFile === node.file?.path}
            onSelect={() => onSelectFile(node.file!.path)}
            onDiff={() => onDiffFile(node.file!.path, isStaged)}
            onStage={onStageFile ? () => onStageFile(node.file!.path) : undefined}
            onUnstage={onUnstageFile ? () => onUnstageFile(node.file!.path) : undefined}
            onDiscard={onDiscardFile ? () => onDiscardFile(node.file!.path) : undefined}
            onContextMenu={(e) => onContextMenu(e, node.file!.path)}
          />
        );
      })}
    </>
  );
}

// ── GitFileTreeView (drop-in replacement for GitFileSection) ───────

interface GitFileTreeViewProps {
  readonly label: string;
  readonly count: number;
  readonly files: ReadonlyArray<GitFileStatus>;
  readonly fileDiffStats: ReadonlyMap<string, FileDiffStat>;
  readonly countColor: string;
  readonly countBg: string;
  readonly selectedFile: string | null;
  readonly onSelectFile: (path: string) => void;
  readonly onDiffFile: (path: string, staged: boolean) => void;
  readonly onStageFile?: (path: string) => void;
  readonly onUnstageFile?: (path: string) => void;
  readonly onDiscardFile?: (path: string) => void;
  readonly onStageAll?: () => void;
  readonly onUnstageAll?: () => void;
  readonly onOpenFile?: (path: string) => void;
  readonly onOpenInExplorer?: (path: string) => void;
  readonly onCopyPath?: (path: string) => void;
  readonly onRemoveFile?: (path: string) => void;
  readonly onStopTracking?: (path: string) => void;
  readonly onChangeHistory?: (path: string) => void;
}

function GitFileTreeView({
  label,
  count,
  files,
  fileDiffStats,
  countColor,
  countBg,
  selectedFile,
  onSelectFile,
  onDiffFile,
  onStageFile,
  onUnstageFile,
  onDiscardFile,
  onStageAll,
  onUnstageAll,
  onOpenFile,
  onOpenInExplorer,
  onCopyPath,
  onRemoveFile,
  onStopTracking,
  onChangeHistory,
}: GitFileTreeViewProps) {
  const { t } = useTranslation();
  const isStaged = !!onUnstageFile;
  const [collapsed, setCollapsed] = useState(false);

  const tree = useMemo(() => buildGitFileTree(files), [files]);

  // Default: all directories expanded
  const [expandedDirs, setExpandedDirs] = useState<Set<string>>(() => collectDirPaths(tree));

  // When the tree changes (files added/removed), ensure new dirs are expanded
  useMemo(() => {
    const allDirs = collectDirPaths(tree);
    setExpandedDirs((prev) => {
      const merged = new Set(prev);
      for (const d of allDirs) merged.add(d);
      return merged;
    });
  }, [tree]);

  const toggleDir = useCallback((path: string) => {
    setExpandedDirs((prev) => {
      const next = new Set(prev);
      if (next.has(path)) {
        next.delete(path);
      } else {
        next.add(path);
      }
      return next;
    });
  }, []);

  const handleContextMenu = useCallback((e: React.MouseEvent, filePath: string) => {
    e.preventDefault();
    e.stopPropagation();
    popupGitFileContextMenu(
      { filePath, isStaged },
      e.clientX,
      e.clientY,
      t,
      {
        onOpen: onOpenFile ? () => onOpenFile(filePath) : undefined,
        onOpenInExplorer: onOpenInExplorer ? () => onOpenInExplorer(filePath) : undefined,
        onCopyPath: onCopyPath ? () => onCopyPath(filePath) : undefined,
        onRemove: onRemoveFile ? () => onRemoveFile(filePath) : undefined,
        onDiscardChanges: onDiscardFile ? () => onDiscardFile(filePath) : undefined,
        onStopTracking: onStopTracking ? () => onStopTracking(filePath) : undefined,
        onChangeHistory: onChangeHistory ? () => onChangeHistory(filePath) : undefined,
        onStage: onStageFile ? () => onStageFile(filePath) : undefined,
        onUnstage: onUnstageFile ? () => onUnstageFile(filePath) : undefined,
      },
    ).catch((err) => {
      useToastStore.getState().addToast("error", `Unable to open git menu: ${formatError(err)}`);
    });
  }, [
    isStaged,
    onChangeHistory,
    onCopyPath,
    onDiscardFile,
    onOpenFile,
    onOpenInExplorer,
    onRemoveFile,
    onStageFile,
    onStopTracking,
    onUnstageFile,
    t,
  ]);

  return (
    <div className="flex flex-col" style={{ width: "100%" }}>
      {/* Section Header (same as GitFileSection) */}
      <div
        className="flex items-center justify-between cursor-pointer transition-colors hover:bg-hover-overlay/[0.02]"
        style={{ padding: "6px 16px" }}
        onClick={() => setCollapsed(!collapsed)}
      >
        <div className="flex items-center" style={{ gap: 6 }}>
          <ChevronDown
            size={12}
            style={{
              color: "var(--color-muted)",
              transform: collapsed ? "rotate(-90deg)" : undefined,
              transition: "transform 150ms",
            }}
          />
          <span
            className="text-[11px] font-semibold font-sans"
            style={{ color: "var(--color-muted)" }}
          >
            {label}
          </span>
          <span
            className="flex items-center justify-center"
            style={{
              fontSize: 9,
              fontWeight: 700,
              color: countColor,
              backgroundColor: countBg,
              borderRadius: 8,
              padding: "1px 6px",
            }}
          >
            {count}
          </span>
        </div>
        <div className="flex items-center" style={{ gap: 2 }}>
          {onStageAll && (
            <button
              onClick={(e) => { e.stopPropagation(); onStageAll(); }}
              className="flex items-center justify-center rounded transition-colors hover:bg-hover-overlay/[0.07]"
              style={{ width: 22, height: 22 }}
              title="Stage all"
            >
              <Plus size={13} style={{ color: "var(--color-muted)" }} />
            </button>
          )}
          {onUnstageAll && (
            <button
              onClick={(e) => { e.stopPropagation(); onUnstageAll(); }}
              className="flex items-center justify-center rounded transition-colors hover:bg-hover-overlay/[0.07]"
              style={{ width: 22, height: 22 }}
              title="Unstage all"
            >
              <Minus size={13} style={{ color: "var(--color-muted)" }} />
            </button>
          )}
        </div>
      </div>

      {/* Tree content */}
      {!collapsed && (
        <div className="flex flex-col" style={{ padding: "0 4px" }}>
          <TreeNodes
            nodes={tree}
            depth={0}
            expandedDirs={expandedDirs}
            onToggleDir={toggleDir}
            fileDiffStats={fileDiffStats}
            selectedFile={selectedFile}
            isStaged={isStaged}
            onSelectFile={onSelectFile}
            onDiffFile={onDiffFile}
            onStageFile={onStageFile}
            onUnstageFile={onUnstageFile}
            onDiscardFile={onDiscardFile}
            onContextMenu={handleContextMenu}
          />
        </div>
      )}

    </div>
  );
}

export { GitFileTreeView, buildGitFileTree };
export type { GitTreeNode };
