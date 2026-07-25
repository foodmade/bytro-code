import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { FolderOpen, FileText, ChevronRight, FolderPlus } from "lucide-react";
import { cn } from "@/lib/utils";
import type { DirEntry } from "@/types";

interface FileMentionDropdownProps {
  readonly query: string;
  readonly rootPath: string;
  readonly onSelect: (file: { path: string; name: string; isDir?: boolean }) => void;
  readonly onNavigateDir: (dirPath: string) => void;
  readonly activeIndex: number;
  readonly navigateTo: string | null;
  readonly onFilteredEntriesChange: (entries: ReadonlyArray<DirEntry>) => void;
}

const EXT_COLORS: Record<string, string> = {
  ts: "#3178C6",
  tsx: "#3178C6",
  js: "#F7DF1E",
  jsx: "#F7DF1E",
  rs: "#DEA584",
  json: "#A8A8A8",
  md: "#519ABA",
  css: "#563D7C",
  html: "#E34C26",
  toml: "#9C4121",
  yaml: "#CB171E",
  yml: "#CB171E",
  py: "#3572A5",
  go: "#00ADD8",
};

export function FileMentionDropdown({
  query,
  rootPath,
  onSelect,
  onNavigateDir,
  activeIndex,
  navigateTo,
  onFilteredEntriesChange,
}: FileMentionDropdownProps) {
  // Normalize query: replace non-breaking spaces (\u00A0) that contentEditable
  // may insert with regular spaces, then trim trailing whitespace.
  // This prevents phantom trailing spaces from causing "no match" in search.
  const normalizedQuery = query.replace(/\u00A0/g, " ").trim();

  const [currentDir, setCurrentDir] = useState(rootPath);
  const [entries, setEntries] = useState<ReadonlyArray<DirEntry>>([]);
  const [searchResults, setSearchResults] = useState<ReadonlyArray<DirEntry>>([]);
  const [loading, setLoading] = useState(false);
  const listRef = useRef<HTMLDivElement>(null);
  const searchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Search mode: normalizedQuery is non-empty, show recursive results instead of dir listing
  const isSearchMode = normalizedQuery.length > 0;

  // Reset currentDir when rootPath changes
  useEffect(() => {
    setCurrentDir(rootPath);
  }, [rootPath]);

  // Navigate to a specific directory when requested by parent (keyboard nav)
  useEffect(() => {
    if (navigateTo) {
      setCurrentDir(navigateTo);
    }
  }, [navigateTo]);

  // Fetch directory entries (browse mode)
  useEffect(() => {
    if (!currentDir || isSearchMode) return;

    let cancelled = false;
    setLoading(true);

    invoke<DirEntry[]>("read_dir_entries", { path: currentDir })
      .then((result) => {
        if (!cancelled) {
          setEntries(result);
          setLoading(false);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setEntries([]);
          setLoading(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [currentDir, isSearchMode]);

  // Recursive search (search mode) — debounced
  useEffect(() => {
    if (!isSearchMode) {
      setSearchResults([]);
      return;
    }

    if (searchTimerRef.current) {
      clearTimeout(searchTimerRef.current);
    }

    setLoading(true);

    searchTimerRef.current = setTimeout(() => {
      let cancelled = false;

      invoke<DirEntry[]>("search_files", { root: rootPath, query: normalizedQuery, limit: 30 })
        .then((result) => {
          if (!cancelled) {
            setSearchResults(result);
            setLoading(false);
          }
        })
        .catch(() => {
          if (!cancelled) {
            setSearchResults([]);
            setLoading(false);
          }
        });

      return () => {
        cancelled = true;
      };
    }, 150);

    return () => {
      if (searchTimerRef.current) {
        clearTimeout(searchTimerRef.current);
      }
    };
  }, [normalizedQuery, rootPath, isSearchMode]);

  // In browse mode, filter local entries; in search mode, use recursive results
  const filtered = isSearchMode
    ? searchResults
    : entries.filter((e) =>
        e.name.toLowerCase().includes(normalizedQuery.toLowerCase()),
      );

  // Notify parent of filtered entries for keyboard navigation
  useEffect(() => {
    onFilteredEntriesChange(filtered);
  }, [entries, searchResults, query]); // eslint-disable-line react-hooks/exhaustive-deps

  // Scroll active item into view
  useEffect(() => {
    if (!listRef.current) return;
    const item = listRef.current.children[activeIndex] as HTMLElement | undefined;
    if (item) {
      item.scrollIntoView({ block: "nearest" });
    }
  }, [activeIndex]);

  // Build breadcrumb segments from rootPath to currentDir
  const buildBreadcrumbs = useCallback(() => {
    const normalizedRoot = rootPath.replace(/\\/g, "/");
    const normalizedCurrent = currentDir.replace(/\\/g, "/");

    if (normalizedCurrent === normalizedRoot) {
      const lastSegment = normalizedRoot.split("/").filter(Boolean).pop() ?? ".";
      return [{ label: lastSegment, path: rootPath }];
    }

    const relative = normalizedCurrent.slice(normalizedRoot.length).replace(/^\//, "");
    const segments = relative.split("/").filter(Boolean);

    const crumbs = [
      { label: normalizedRoot.split("/").filter(Boolean).pop() ?? ".", path: rootPath },
    ];

    let accumulated = normalizedRoot;
    for (const seg of segments) {
      accumulated = accumulated + "/" + seg;
      // Restore original separator for path
      const originalPath = accumulated.replace(/\//g, rootPath.includes("\\") ? "\\" : "/");
      crumbs.push({ label: seg, path: originalPath });
    }

    return crumbs;
  }, [rootPath, currentDir]);

  const breadcrumbs = buildBreadcrumbs();

  // Compute relative path from rootPath for display in search mode
  const getRelativePath = useCallback(
    (fullPath: string) => {
      const normRoot = rootPath.replace(/\\/g, "/");
      const normFull = fullPath.replace(/\\/g, "/");
      if (normFull.startsWith(normRoot)) {
        return normFull.slice(normRoot.length).replace(/^\//, "");
      }
      return normFull;
    },
    [rootPath],
  );

  const handleEntryClick = useCallback(
    (entry: DirEntry) => {
      if (entry.is_dir) {
        onNavigateDir(entry.path);
      } else {
        onSelect({ path: entry.path, name: entry.name });
      }
    },
    [onSelect, onNavigateDir],
  );

  const handleSelectDir = useCallback(
    (e: React.MouseEvent, entry: DirEntry) => {
      e.stopPropagation();
      onSelect({ path: entry.path, name: entry.name, isDir: true });
    },
    [onSelect],
  );

  return (
    <div
      className="absolute bottom-full left-0 mb-2 w-full max-w-[480px] rounded-lg border border-border-light bg-card shadow-[0_8px_24px_rgba(0,0,0,0.4)] z-50 overflow-hidden"
      style={{ maxHeight: 320 }}
    >
      {/* Header: breadcrumbs in browse mode, search indicator in search mode */}
      {isSearchMode ? (
        <div className="flex items-center gap-1.5 px-3 py-2 border-b border-border-subtle">
          <FileText size={10} className="text-text-tertiary" />
          <span className="text-[10px] font-mono text-text-tertiary">
            Searching for &quot;{normalizedQuery}&quot;
          </span>
          {!loading && (
            <span className="text-[10px] font-mono text-text-placeholder ml-auto">
              {filtered.length} result{filtered.length !== 1 ? "s" : ""}
            </span>
          )}
        </div>
      ) : (
        <div className="flex items-center gap-1 px-3 py-2 border-b border-border-subtle overflow-x-auto">
          {breadcrumbs.map((crumb, i) => (
            <div key={crumb.path} className="flex items-center gap-1 shrink-0">
              {i > 0 && <ChevronRight size={10} className="text-text-placeholder" />}
              <button
                onClick={() => setCurrentDir(crumb.path)}
                className={cn(
                  "text-[10px] font-mono px-1 py-0.5 rounded transition-colors",
                  i === breadcrumbs.length - 1
                    ? "text-muted-foreground bg-border-subtle"
                    : "text-text-tertiary hover:text-text-tertiary hover:bg-border-subtle",
                )}
              >
                {crumb.label}
              </button>
            </div>
          ))}
        </div>
      )}

      {/* File list */}
      <div ref={listRef} className="overflow-y-auto" style={{ maxHeight: 268 }}>
        {loading && (
          <div className="px-3 py-4 text-center text-[11px] text-text-tertiary font-sans">
            Loading...
          </div>
        )}

        {!loading && filtered.length === 0 && (
          <div className="px-3 py-4 text-center text-[11px] text-text-tertiary font-sans">
            No matching files
          </div>
        )}

        {!loading &&
          filtered.map((entry, i) => {
            const isActive = i === activeIndex;
            const extColor = entry.extension ? EXT_COLORS[entry.extension] : undefined;

            return (
              <button
                key={entry.path}
                onClick={() => handleEntryClick(entry)}
                className={cn(
                  "flex items-center w-full px-3 py-1.5 gap-2.5 transition-colors text-left",
                  isActive ? "bg-accent-purple/10" : "hover:bg-border-subtle",
                )}
              >
                {entry.is_dir ? (
                  <FolderOpen size={14} className="text-[#F59E0B] shrink-0" />
                ) : (
                  <FileText size={14} className="text-text-tertiary shrink-0" />
                )}
                <div className="flex flex-col min-w-0 flex-1">
                  <span
                    className={cn(
                      "text-[12px] font-sans truncate",
                      isActive ? "text-foreground" : "text-foreground",
                    )}
                  >
                    {entry.name}
                  </span>
                  {isSearchMode && (
                    <span className="text-[10px] font-mono text-text-tertiary truncate">
                      {getRelativePath(entry.path)}
                    </span>
                  )}
                </div>
                {entry.extension && !entry.is_dir && (
                  <span
                    className="text-[9px] font-mono px-1.5 py-0.5 rounded shrink-0"
                    style={{
                      backgroundColor: extColor ? `${extColor}20` : "var(--color-border-strong)",
                      color: extColor ?? "var(--color-text-placeholder)",
                    }}
                  >
                    .{entry.extension}
                  </span>
                )}
                {entry.is_dir && (
                  <>
                    <span
                      role="button"
                      tabIndex={-1}
                      onClick={(e) => handleSelectDir(e, entry)}
                      className="p-0.5 rounded hover:bg-border-strong transition-colors shrink-0 cursor-pointer"
                      title="Select folder"
                    >
                      <FolderPlus size={12} className="text-[#F59E0B]" />
                    </span>
                    <ChevronRight size={12} className="text-text-tertiary shrink-0" />
                  </>
                )}
              </button>
            );
          })}
      </div>
    </div>
  );
}
