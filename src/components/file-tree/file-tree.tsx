import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { invoke } from "@tauri-apps/api/core";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import { listen } from "@tauri-apps/api/event";
import { useFileTreeStore, useAppStore, useSplitViewStore } from "@/stores";
import { formatError } from "@/lib/format-error";
import { createNativeContextMenuItem, nativeMenuSeparator, popupNativeContextMenu, type NativeContextMenuItem } from "@/lib/native-context-menu";
import { InlineCreateInput } from "./inline-create-input";
import { FileTreeNode } from "./file-tree-node";
import type { TreeNode, DirEntry, CreatingInfo, ContextMenuInfo, RenameInfo } from "./file-tree-types";

/**
 * Merge new child nodes with old ones, preserving already-loaded children
 * of expanded directories so the tree doesn't visually collapse on refresh.
 */
function getParentDirPath(path: string): string {
  const lastSep = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  return lastSep > 0 ? path.substring(0, lastSep) : "";
}

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

export interface FileTreeHandle {
  readonly collapseAll: () => void;
  readonly refresh: () => void;
  readonly startCreate: (type: "file" | "dir") => void;
}

export const FileTree = forwardRef<FileTreeHandle>(function FileTree(_props, ref) {
  const { t } = useTranslation();
  const { rootPath, selectedPath, setSelectedPath } = useFileTreeStore();
  const activeFileTab = useAppStore((s) => s.activeFileTab);
  const activeSplitFilePath = useSplitViewStore((s) => {
    const pane = s.panes.find((item) => item.id === s.activePaneId);
    return pane?.content.type === "file" || pane?.content.type === "diff"
      ? pane.content.path
      : null;
  });
  const activeFilePath = activeSplitFilePath ?? activeFileTab;
  const [tree, setTree] = useState<ReadonlyArray<TreeNode>>([]);
  const [expandedPaths, setExpandedPaths] = useState<ReadonlySet<string>>(new Set());
  const expandedPathsRef = useRef(expandedPaths);
  expandedPathsRef.current = expandedPaths;
  const [creating, setCreating] = useState<CreatingInfo | null>(null);
  const [clipboard, setClipboard] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<RenameInfo | null>(null);

  const loadChildren = useCallback(async (dirPath: string): Promise<ReadonlyArray<TreeNode>> => {
    try {
      const entries = await invoke<ReadonlyArray<DirEntry>>("read_dir_entries", {
        path: dirPath,
      });
      return entries.map((e) => ({
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
          return {
            ...node,
            children: updateNodeChildren(node.children, targetPath, children),
          };
        }
        return node;
      });
    },
    [],
  );

  const getAncestorDirs = useCallback((filePath: string): string[] => {
    if (!rootPath || !filePath.startsWith(rootPath)) return [];
    const ancestors: string[] = [];
    let current = getParentDirPath(filePath);
    while (current && current !== rootPath && current.startsWith(rootPath)) {
      ancestors.unshift(current);
      current = getParentDirPath(current);
    }
    return ancestors;
  }, [rootPath]);

  const handleToggle = useCallback(
    async (path: string) => {
      const isCurrentlyExpanded = expandedPaths.has(path);

      if (isCurrentlyExpanded) {
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

  const openFile = useAppStore((s) => s.openFile);

  const handleSelect = useCallback(
    (path: string) => {
      setSelectedPath(path);
      openFile(path);
    },
    [setSelectedPath, openFile],
  );

  const refreshTree = useCallback(async () => {
    if (!rootPath) return;
    const nodes = await loadChildren(rootPath);
    setTree((prev) => mergeChildNodes(prev, nodes));
  }, [rootPath, loadChildren]);

  const handleCreateConfirm = useCallback(
    async (name: string) => {
      if (!creating) return;
      const sep = creating.parentPath.includes("/") ? "/" : "\\";
      const newPath = creating.parentPath + sep + name;
      const type = creating.type;
      setCreating(null);

      try {
        if (type === "dir") {
          await invoke("create_dir", { path: newPath });
        } else {
          await invoke("create_file", { path: newPath });
        }
        // Refresh the parent directory
        const children = await loadChildren(creating.parentPath);
        setTree((prev) => updateNodeChildren(prev, creating.parentPath, children));
      } catch (err: unknown) {
        const msg = formatError(err);
        console.error("Failed to create:", msg);
      }
    },
    [creating, loadChildren, updateNodeChildren],
  );

  const handleCreateCancel = useCallback(() => {
    setCreating(null);
  }, []);

  const startCreate = useCallback(
    async (type: "file" | "dir") => {
      if (!rootPath) return;
      // Use the selected path's parent dir if it's a file, or the selected dir itself
      // If nothing selected, use rootPath
      let parentPath = rootPath;
      if (selectedPath) {
        // Find the node to determine if it's a dir
        const findNode = (nodes: ReadonlyArray<TreeNode>, target: string): TreeNode | null => {
          for (const n of nodes) {
            if (n.path === target) return n;
            if (n.children) {
              const found = findNode(n.children, target);
              if (found) return found;
            }
          }
          return null;
        };
        const node = findNode(tree, selectedPath);
        if (node) {
          if (node.isDir) {
            parentPath = node.path;
          } else {
            // Derive parent directory from the file's path
            const lastSep = Math.max(
              node.path.lastIndexOf("/"),
              node.path.lastIndexOf("\\"),
            );
            parentPath = lastSep > 0 ? node.path.substring(0, lastSep) : rootPath;
          }
        }
      }

      // Ensure the parent is expanded
      if (!expandedPaths.has(parentPath)) {
        const children = await loadChildren(parentPath);
        setTree((prev) => updateNodeChildren(prev, parentPath, children));
        setExpandedPaths((prev) => {
          const next = new Set(prev);
          next.add(parentPath);
          return next;
        });
      }

      setCreating({ parentPath, type });
    },
    [rootPath, selectedPath, tree, expandedPaths, loadChildren, updateNodeChildren],
  );

  const getParentDir = useCallback(
    (filePath: string): string => {
      const lastSep = Math.max(filePath.lastIndexOf("/"), filePath.lastIndexOf("\\"));
      return lastSep > 0 ? filePath.substring(0, lastSep) : (rootPath ?? "");
    },
    [rootPath],
  );

  const refreshParent = useCallback(
    async (childPath: string) => {
      const parentDir = getParentDir(childPath);
      if (parentDir === rootPath) {
        await refreshTree();
      } else if (expandedPaths.has(parentDir)) {
        const children = await loadChildren(parentDir);
        setTree((prev) => updateNodeChildren(prev, parentDir, children));
      }
    },
    [getParentDir, rootPath, expandedPaths, loadChildren, updateNodeChildren, refreshTree],
  );

  const handleCopy = useCallback((info: ContextMenuInfo) => {
    setClipboard(info.nodePath);
  }, []);

  const handlePaste = useCallback(async (info: ContextMenuInfo) => {
    if (!clipboard) return;
    const destDir = info.nodeIsDir
      ? info.nodePath
      : getParentDir(info.nodePath);
    try {
      await invoke("copy_entry", { src: clipboard, destDir });
      if (destDir === rootPath) {
        await refreshTree();
      } else if (expandedPaths.has(destDir)) {
        const children = await loadChildren(destDir);
        setTree((prev) => updateNodeChildren(prev, destDir, children));
      }
    } catch (err: unknown) {
      const msg = formatError(err);
      console.error("Paste failed:", msg);
    }
  }, [clipboard, getParentDir, rootPath, expandedPaths, loadChildren, updateNodeChildren, refreshTree]);

  const handleDelete = useCallback(async (info: ContextMenuInfo) => {
    const targetPath = info.nodePath;
    try {
      await invoke("delete_entry", { path: targetPath });
      if (selectedPath === targetPath) {
        setSelectedPath(null);
      }
      await refreshParent(targetPath);
    } catch (err: unknown) {
      const msg = formatError(err);
      console.error("Delete failed:", msg);
    }
  }, [selectedPath, setSelectedPath, refreshParent]);

  const handleStartRename = useCallback((info: ContextMenuInfo) => {
    const name = info.nodePath.split(/[\\/]/).pop() ?? "";
    setRenaming({ path: info.nodePath, oldName: name });
  }, []);

  const handleRenameConfirm = useCallback(
    async (newName: string) => {
      if (!renaming) return;
      const parentDir = getParentDir(renaming.path);
      const sep = renaming.path.includes("/") ? "/" : "\\";
      const newPath = parentDir + sep + newName;
      setRenaming(null);
      try {
        // Rust std::fs::rename works for both files and dirs
        await invoke("rename_entry", { src: renaming.path, dest: newPath });
        if (selectedPath === renaming.path) {
          setSelectedPath(newPath);
        }
        if (parentDir === rootPath) {
          await refreshTree();
        } else if (expandedPaths.has(parentDir)) {
          const children = await loadChildren(parentDir);
          setTree((prev) => updateNodeChildren(prev, parentDir, children));
        }
      } catch (err: unknown) {
        const msg = formatError(err);
        console.error("Rename failed:", msg);
      }
    },
    [renaming, getParentDir, rootPath, selectedPath, setSelectedPath, expandedPaths, loadChildren, updateNodeChildren, refreshTree],
  );

  const handleRenameCancel = useCallback(() => {
    setRenaming(null);
  }, []);

  const handleContextNewFile = useCallback((info: ContextMenuInfo) => {
    if (!info.nodeIsDir) return;
    const parentPath = info.nodePath;
    // Ensure expanded
    if (!expandedPaths.has(parentPath)) {
      loadChildren(parentPath).then((children) => {
        setTree((prev) => updateNodeChildren(prev, parentPath, children));
        setExpandedPaths((prev) => {
          const next = new Set(prev);
          next.add(parentPath);
          return next;
        });
        setCreating({ parentPath, type: "file" });
      });
    } else {
      setCreating({ parentPath, type: "file" });
    }
  }, [expandedPaths, loadChildren, updateNodeChildren]);

  const handleContextNewFolder = useCallback((info: ContextMenuInfo) => {
    if (!info.nodeIsDir) return;
    const parentPath = info.nodePath;
    if (!expandedPaths.has(parentPath)) {
      loadChildren(parentPath).then((children) => {
        setTree((prev) => updateNodeChildren(prev, parentPath, children));
        setExpandedPaths((prev) => {
          const next = new Set(prev);
          next.add(parentPath);
          return next;
        });
        setCreating({ parentPath, type: "dir" });
      });
    } else {
      setCreating({ parentPath, type: "dir" });
    }
  }, [expandedPaths, loadChildren, updateNodeChildren]);

  const handleContextMenu = useCallback(
    (e: React.MouseEvent, node: TreeNode) => {
      const info: ContextMenuInfo = { x: e.clientX, y: e.clientY, nodePath: node.path, nodeIsDir: node.isDir };
      setSelectedPath(node.path);

      const separator = nativeMenuSeparator();
      const items: NativeContextMenuItem[] = [
        createNativeContextMenuItem("bytro-file-tree-add-to-chat", t("fileTree.contextMenu.addToChat"), () => {
          if (info.nodeIsDir) {
            useAppStore.getState().addContextDir(info.nodePath);
          } else {
            useAppStore.getState().addContextFile(info.nodePath);
          }
        }),
        separator,
        ...(info.nodeIsDir
          ? [
              createNativeContextMenuItem("bytro-file-tree-new-file", t("fileTree.contextMenu.newFile"), () => handleContextNewFile(info)),
              createNativeContextMenuItem("bytro-file-tree-new-folder", t("fileTree.contextMenu.newFolder"), () => handleContextNewFolder(info)),
              separator,
            ]
          : []),
        createNativeContextMenuItem("bytro-file-tree-copy", t("fileTree.contextMenu.copy"), () => handleCopy(info), { accelerator: "CmdOrCtrl+C" }),
        createNativeContextMenuItem("bytro-file-tree-paste", t("fileTree.contextMenu.paste"), () => handlePaste(info), { accelerator: "CmdOrCtrl+V", enabled: Boolean(clipboard) }),
        separator,
        createNativeContextMenuItem("bytro-file-tree-rename", t("fileTree.contextMenu.rename"), () => handleStartRename(info)),
        createNativeContextMenuItem("bytro-file-tree-reveal-in-dir", t("fileTree.contextMenu.revealInDir"), () => {
          revealItemInDir(info.nodePath).catch(() => {});
        }),
        separator,
        createNativeContextMenuItem("bytro-file-tree-delete", t("fileTree.contextMenu.delete"), () => handleDelete(info)),
      ];

      popupNativeContextMenu("bytro-file-tree-context-menu", items, e.clientX, e.clientY).catch((err) => {
        console.error("Unable to open file tree context menu:", formatError(err));
      });
    },
    [
      clipboard,
      handleContextNewFile,
      handleContextNewFolder,
      handleCopy,
      handleDelete,
      handlePaste,
      handleStartRename,
      setSelectedPath,
      t,
    ],
  );

  useImperativeHandle(ref, () => ({
    collapseAll: () => setExpandedPaths(new Set()),
    refresh: () => { refreshTree(); },
    startCreate,
  }), [refreshTree, startCreate]);

  useEffect(() => {
    if (!rootPath) return;
    refreshTree();
  }, [rootPath, refreshTree]);

  useEffect(() => {
    if (!rootPath || !activeFilePath || !activeFilePath.startsWith(rootPath)) return;
    let cancelled = false;

    const revealActiveFile = async () => {
      const ancestors = getAncestorDirs(activeFilePath);
      for (const dir of ancestors) {
        const children = await loadChildren(dir);
        if (cancelled) return;
        setTree((prev) => updateNodeChildren(prev, dir, children));
      }
      if (cancelled) return;
      setExpandedPaths((prev) => {
        const next = new Set(prev);
        for (const dir of ancestors) next.add(dir);
        return next;
      });
      setSelectedPath(activeFilePath);
      requestAnimationFrame(() => {
        if (cancelled) return;
        const selector = `[data-file-tree-path="${CSS.escape(activeFilePath)}"]`;
        document.querySelector<HTMLElement>(selector)?.scrollIntoView({ block: "center", behavior: "smooth" });
      });
    };

    revealActiveFile();
    return () => {
      cancelled = true;
    };
  }, [activeFilePath, getAncestorDirs, loadChildren, rootPath, setSelectedPath, updateNodeChildren]);

  useEffect(() => {
    if (!rootPath) return;

    const unlisten = listen<{ path: string; change_type: string }>(
      "file-changed",
      async (event) => {
        const changedPath = event.payload.path;
        if (!changedPath.startsWith(rootPath)) return;

        const lastSep = Math.max(
          changedPath.lastIndexOf("/"),
          changedPath.lastIndexOf("\\"),
        );
        if (lastSep <= 0) return;
        const parentDir = changedPath.substring(0, lastSep);

        // Root-level changes: refresh root nodes, preserving expanded children
        if (parentDir === rootPath) {
          const nodes = await loadChildren(rootPath);
          setTree((prev) => mergeChildNodes(prev, nodes));
          return;
        }

        // Sub-directory changes: only refresh if that directory is expanded
        if (expandedPathsRef.current.has(parentDir)) {
          const children = await loadChildren(parentDir);
          setTree((prev) => updateNodeChildren(prev, parentDir, children));
        }
      },
    );

    return () => {
      unlisten.then((fn) => fn());
    };
  }, [rootPath, loadChildren, updateNodeChildren]);

  if (!rootPath) {
    return (
      <div className="flex items-center justify-center h-full text-muted-foreground text-xs">
        {t("fileTree.noFolder")}
      </div>
    );
  }

  // Flatten visible nodes for arrow key navigation
  const flattenVisibleNodes = (nodes: ReadonlyArray<TreeNode>): ReadonlyArray<TreeNode> => {
    const result: TreeNode[] = [];
    for (const node of nodes) {
      result.push(node);
      if (node.isDir && expandedPaths.has(node.path) && node.children) {
        result.push(...flattenVisibleNodes(node.children));
      }
    }
    return result;
  };

  const handleTreeKeyDown = (e: React.KeyboardEvent) => {
    const visibleNodes = flattenVisibleNodes(tree);
    if (visibleNodes.length === 0) return;

    const currentIdx = visibleNodes.findIndex((n) => n.path === selectedPath);

    switch (e.key) {
      case "ArrowDown": {
        e.preventDefault();
        const nextIdx = Math.min(currentIdx + 1, visibleNodes.length - 1);
        const next = visibleNodes[nextIdx];
        setSelectedPath(next.path);
        break;
      }
      case "ArrowUp": {
        e.preventDefault();
        const prevIdx = Math.max(currentIdx - 1, 0);
        const prev = visibleNodes[prevIdx];
        setSelectedPath(prev.path);
        break;
      }
      case "ArrowRight": {
        e.preventDefault();
        if (currentIdx >= 0) {
          const node = visibleNodes[currentIdx];
          if (node.isDir && !expandedPaths.has(node.path)) {
            handleToggle(node.path);
          }
        }
        break;
      }
      case "ArrowLeft": {
        e.preventDefault();
        if (currentIdx >= 0) {
          const node = visibleNodes[currentIdx];
          if (node.isDir && expandedPaths.has(node.path)) {
            handleToggle(node.path);
          }
        }
        break;
      }
      case "Enter": {
        e.preventDefault();
        if (currentIdx >= 0) {
          const node = visibleNodes[currentIdx];
          if (node.isDir) {
            handleToggle(node.path);
          } else {
            handleSelect(node.path);
          }
        }
        break;
      }
    }
  };

  return (
    <div className="py-1" role="tree" aria-label="File explorer" tabIndex={0} onKeyDown={handleTreeKeyDown}>
      {creating && creating.parentPath === rootPath && (
        <InlineCreateInput
          type={creating.type}
          depth={0}
          onConfirm={handleCreateConfirm}
          onCancel={handleCreateCancel}
        />
      )}
      {tree.map((node) => (
        <FileTreeNode
          key={node.path}
          node={node}
          depth={0}
          selectedPath={selectedPath}
          expandedPaths={expandedPaths}
          creating={creating}
          renaming={renaming}
          onToggle={handleToggle}
          onSelect={handleSelect}
          onCreateConfirm={handleCreateConfirm}
          onCreateCancel={handleCreateCancel}
          onContextMenu={handleContextMenu}
          onRenameConfirm={handleRenameConfirm}
          onRenameCancel={handleRenameCancel}
        />
      ))}
    </div>
  );
});
