import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { ChevronRight, ChevronDown, Folder, FolderOpen } from "lucide-react";
import { getFileIcon } from "@/components/file-tree/file-icons";

interface TreeNode {
  readonly name: string;
  readonly path: string;
  readonly isDir: boolean;
  readonly extension: string | null;
  readonly children: ReadonlyArray<TreeNode> | null;
}

interface DirEntry {
  readonly name: string;
  readonly path: string;
  readonly is_dir: boolean;
  readonly extension: string | null;
}

/** Directories to hide from the preview file tree */
const HIDDEN_DIRS = new Set(["node_modules", ".git", "dist", ".vite"]);

/**
 * Merge new child nodes with old ones, preserving already-loaded children
 * of expanded directories so the tree doesn't visually collapse on refresh.
 */
function mergeChildNodes(
  oldChildren: ReadonlyArray<TreeNode> | null,
  newChildren: ReadonlyArray<TreeNode>,
): ReadonlyArray<TreeNode> {
  if (!oldChildren) return newChildren;
  const oldMap = new Map<string, TreeNode>();
  for (const node of oldChildren) {
    oldMap.set(node.path, node);
  }
  return newChildren.map((newNode) => {
    const oldNode = oldMap.get(newNode.path);
    if (oldNode && oldNode.children !== null && newNode.isDir) {
      return { ...newNode, children: oldNode.children };
    }
    return newNode;
  });
}

/** Files to de-emphasize (config files at root) */
const CONFIG_FILES = new Set([
  "package-lock.json",
  "tsconfig.node.json",
  "postcss.config.js",
  "postcss.config.cjs",
]);

interface PreviewFileTreeProps {
  readonly rootPath: string;
  readonly onFileSelect?: (path: string) => void;
  readonly selectedFile?: string | null;
}

export function PreviewFileTree({ rootPath, onFileSelect, selectedFile }: PreviewFileTreeProps) {
  const [tree, setTree] = useState<ReadonlyArray<TreeNode>>([]);
  const [expandedPaths, setExpandedPaths] = useState<ReadonlySet<string>>(new Set());
  const expandedPathsRef = useRef(expandedPaths);
  expandedPathsRef.current = expandedPaths;

  const loadChildren = useCallback(async (dirPath: string): Promise<ReadonlyArray<TreeNode>> => {
    try {
      const entries = await invoke<ReadonlyArray<DirEntry>>("read_dir_entries", {
        path: dirPath,
      });
      return entries
        .filter((e) => !HIDDEN_DIRS.has(e.name))
        .map((e) => ({
          name: e.name,
          path: e.path,
          isDir: e.is_dir,
          extension: e.extension,
          children: null,
        }));
    } catch {
      return [];
    }
  }, []);

  const updateNodeChildren = useCallback(
    (
      nodes: ReadonlyArray<TreeNode>,
      targetPath: string,
      children: ReadonlyArray<TreeNode>,
    ): ReadonlyArray<TreeNode> => {
      return nodes.map((node) => {
        if (node.path === targetPath) {
          return { ...node, children: mergeChildNodes(node.children, children) };
        }
        if (node.children) {
          return { ...node, children: updateNodeChildren(node.children, targetPath, children) };
        }
        return node;
      });
    },
    [],
  );

  const handleToggle = useCallback(
    async (path: string) => {
      if (expandedPaths.has(path)) {
        setExpandedPaths((prev) => {
          const next = new Set(prev);
          next.delete(path);
          return next;
        });
      } else {
        const children = await loadChildren(path);
        setTree((prev) => updateNodeChildren(prev, path, children));
        setExpandedPaths((prev) => {
          const next = new Set(prev);
          next.add(path);
          return next;
        });
      }
    },
    [expandedPaths, loadChildren, updateNodeChildren],
  );

  const handleSelect = useCallback(
    (path: string) => {
      onFileSelect?.(path);
    },
    [onFileSelect],
  );

  // Initial load + auto-expand src
  useEffect(() => {
    if (!rootPath) return;
    loadChildren(rootPath).then((nodes) => {
      setTree(nodes);
      // Auto-expand the "src" directory
      const srcNode = nodes.find((n) => n.isDir && n.name === "src");
      if (srcNode) {
        loadChildren(srcNode.path).then((srcChildren) => {
          setTree((prev) => updateNodeChildren(prev, srcNode.path, srcChildren));
          setExpandedPaths(new Set([srcNode.path]));
        });
      }
    });
  }, [rootPath, loadChildren, updateNodeChildren]);

  // Watch for file changes
  useEffect(() => {
    if (!rootPath) return;

    const unlisten = listen<{ path: string; change_type: string }>(
      "file-changed",
      async (event) => {
        const changedPath = event.payload.path;
        if (!changedPath.startsWith(rootPath)) return;

        const lastSep = Math.max(changedPath.lastIndexOf("/"), changedPath.lastIndexOf("\\"));
        if (lastSep <= 0) return;
        const parentDir = changedPath.substring(0, lastSep);

        if (parentDir === rootPath) {
          const nodes = await loadChildren(rootPath);
          setTree((prev) => mergeChildNodes(prev, nodes));
          return;
        }

        if (expandedPathsRef.current.has(parentDir)) {
          const children = await loadChildren(parentDir);
          setTree((prev) => updateNodeChildren(prev, parentDir, children));
        }
      },
    );

    return () => {
      unlisten.then((fn) => fn()).catch(() => {});
    };
  }, [rootPath, loadChildren, updateNodeChildren]);

  return (
    <div className="py-1 overflow-y-auto h-full" style={{ fontSize: 12 }}>
      {tree.map((node) => (
        <TreeNodeRow
          key={node.path}
          node={node}
          depth={0}
          expandedPaths={expandedPaths}
          selectedFile={selectedFile ?? null}
          onToggle={handleToggle}
          onSelect={handleSelect}
        />
      ))}
    </div>
  );
}

interface TreeNodeRowProps {
  readonly node: TreeNode;
  readonly depth: number;
  readonly expandedPaths: ReadonlySet<string>;
  readonly selectedFile: string | null;
  readonly onToggle: (path: string) => void;
  readonly onSelect: (path: string) => void;
}

function TreeNodeRow({
  node,
  depth,
  expandedPaths,
  selectedFile,
  onToggle,
  onSelect,
}: TreeNodeRowProps) {
  const isExpanded = expandedPaths.has(node.path);
  const isSelected = selectedFile === node.path;
  const isConfigFile = CONFIG_FILES.has(node.name);

  const handleClick = () => {
    if (node.isDir) {
      onToggle(node.path);
    } else {
      onSelect(node.path);
    }
  };

  return (
    <div>
      <button
        onClick={handleClick}
        className="flex items-center gap-1.5 w-full text-left native-css-hover"
        style={
          {
            paddingLeft: depth * 14 + 8,
            paddingTop: 3,
            paddingBottom: 3,
            backgroundColor: isSelected ? "rgba(59, 130, 246, 0.12)" : "transparent",
            color: isConfigFile
              ? "var(--color-text-placeholder)"
              : isSelected
                ? "var(--color-foreground)"
                : "var(--color-text-secondary, #aaa)",
            "--native-hover-bg-color": !isSelected ? "rgba(255, 255, 255, 0.04)" : undefined,
          } as React.CSSProperties
        }
      >
        {node.isDir ? (
          <>
            {isExpanded ? (
              <ChevronDown
                size={11}
                style={{ color: "var(--color-text-placeholder)", flexShrink: 0 }}
              />
            ) : (
              <ChevronRight
                size={11}
                style={{ color: "var(--color-text-placeholder)", flexShrink: 0 }}
              />
            )}
            {isExpanded ? (
              <FolderOpen size={13} style={{ color: "#4285F4", flexShrink: 0 }} />
            ) : (
              <Folder size={13} style={{ color: "#4285F4", flexShrink: 0 }} />
            )}
          </>
        ) : (
          <>
            <span style={{ width: 11, flexShrink: 0 }} />
            {getFileIcon(node.extension, node.name)}
          </>
        )}
        <span className="truncate" style={{ fontWeight: node.isDir ? 500 : 400 }}>
          {node.name}
        </span>
      </button>

      {node.isDir && isExpanded && node.children && (
        <div>
          {node.children.map((child) => (
            <TreeNodeRow
              key={child.path}
              node={child}
              depth={depth + 1}
              expandedPaths={expandedPaths}
              selectedFile={selectedFile}
              onToggle={onToggle}
              onSelect={onSelect}
            />
          ))}
        </div>
      )}
    </div>
  );
}
