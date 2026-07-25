import { useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useFileTreeStore } from "@/stores";
import type { DirEntry } from "@/types";

export function useFileTree() {
  const { rootPath, nodes, selectedPath, setRootPath, setNodes, setSelectedPath } =
    useFileTreeStore();

  const loadDirectory = useCallback(
    async (path: string) => {
      try {
        const entries = await invoke<ReadonlyArray<DirEntry>>("read_dir_entries", {
          path,
        });
        const mapped = entries.map((e) => ({
          name: e.name,
          path: e.path,
          isDir: e.is_dir,
          isFile: e.is_file,
          size: e.size,
        }));
        setNodes(mapped);
        setRootPath(path);
      } catch (error) {
        throw new Error(
          `Failed to load directory: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    },
    [setNodes, setRootPath],
  );

  return {
    rootPath,
    nodes,
    selectedPath,
    loadDirectory,
    setSelectedPath,
  } as const;
}
