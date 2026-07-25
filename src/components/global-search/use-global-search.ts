import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useTranslation } from "react-i18next";
import { useWorkspaceStore } from "@/stores";
import type { DirEntry } from "@/types";
import { type SearchResultItem, searchCommands } from "./command-registry";
import { useAppStore } from "@/stores/app-store";

export type SearchTab = "all" | "files" | "functions" | "commands";

interface UseGlobalSearchResult {
  readonly results: ReadonlyArray<SearchResultItem>;
  readonly isLoading: boolean;
  readonly totalCount: number;
}

export function useGlobalSearch(query: string, activeTab: SearchTab): UseGlobalSearchResult {
  const { t } = useTranslation();
  const [fileResults, setFileResults] = useState<ReadonlyArray<SearchResultItem>>([]);
  const [commandResults, setCommandResults] = useState<ReadonlyArray<SearchResultItem>>([]);
  const [isLoading, setIsLoading] = useState(false);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const abortRef = useRef(0);

  // File search with debounce
  const searchFiles = useCallback(
    async (q: string, requestId: number) => {
      const root = useWorkspaceStore.getState().activeWorkspace?.path;
      if (!root || !q.trim()) {
        setFileResults([]);
        return;
      }

      setIsLoading(true);
      try {
        const entries = await invoke<DirEntry[]>("search_files", {
          root,
          query: q.trim(),
          limit: 50,
        });

        // Only update if this is still the latest request
        if (abortRef.current !== requestId) return;

        setFileResults(
          entries
            .filter((e) => e.is_file)
            .map((entry) => {
              const relativePath = entry.path.replace(root, "").replace(/\\/g, "/").replace(/^\//, "");
              const dirPath = relativePath.includes("/")
                ? relativePath.substring(0, relativePath.lastIndexOf("/") + 1)
                : "";
              return {
                id: `file-${entry.path}`,
                category: "file" as const,
                title: entry.name,
                subtitle: dirPath,
                icon: entry.is_dir ? "folder" : getFileIcon(entry.extension),
                action: () => {
                  useAppStore.getState().openFile(entry.path);
                  useAppStore.getState().setGlobalSearchOpen(false);
                },
              };
            }),
        );
      } catch {
        if (abortRef.current === requestId) {
          setFileResults([]);
        }
      } finally {
        if (abortRef.current === requestId) {
          setIsLoading(false);
        }
      }
    },
    [],
  );

  // Search commands (synchronous, no debounce needed)
  useEffect(() => {
    if (activeTab === "all" || activeTab === "commands") {
      setCommandResults(searchCommands(query, t));
    } else {
      setCommandResults([]);
    }
  }, [query, activeTab, t]);

  // Debounced file search
  useEffect(() => {
    if (activeTab !== "all" && activeTab !== "files") {
      setFileResults([]);
      return;
    }

    if (debounceRef.current) {
      clearTimeout(debounceRef.current);
    }

    if (!query.trim()) {
      setFileResults([]);
      setIsLoading(false);
      return;
    }

    const requestId = ++abortRef.current;
    debounceRef.current = setTimeout(() => {
      searchFiles(query, requestId);
    }, 200);

    return () => {
      if (debounceRef.current) {
        clearTimeout(debounceRef.current);
      }
    };
  }, [query, activeTab, searchFiles]);

  // Combine results based on active tab
  const results = useMemo<ReadonlyArray<SearchResultItem>>(() => {
    switch (activeTab) {
      case "files":
        return fileResults;
      case "commands":
        return commandResults;
      case "functions":
        return [];
      case "all":
      default:
        return [...fileResults, ...commandResults];
    }
  }, [activeTab, fileResults, commandResults]);

  return {
    results,
    isLoading,
    totalCount: results.length,
  };
}

function getFileIcon(extension: string | null): string {
  switch (extension) {
    case "ts":
    case "tsx":
      return "file-code";
    case "js":
    case "jsx":
      return "file-code";
    case "rs":
      return "file-code";
    case "json":
      return "file-json";
    case "md":
      return "file-text";
    case "css":
    case "scss":
      return "file-code";
    case "html":
      return "file-code";
    default:
      return "file";
  }
}
