import { useEffect } from "react";
import { listen } from "@tauri-apps/api/event";
import { useGitStore } from "@/stores/git-store";
import { useWorkspaceStore } from "@/stores/workspace-store";
import { GitBranch } from "lucide-react";
import { Tooltip } from "@/components/ui";

export function GitEntryButton(_props: { readonly compact?: boolean } = {}) {
  const gitInfo = useGitStore((s) => s.gitInfo);
  const togglePanel = useGitStore((s) => s.togglePanel);
  const refreshGitInfo = useGitStore((s) => s.refreshGitInfo);
  const workspacePath = useWorkspaceStore((s) => s.activeWorkspace)?.path ?? null;

  // Auto-refresh badge count when workspace files change
  useEffect(() => {
    if (!workspacePath) return;

    let debounceTimer: ReturnType<typeof setTimeout> | null = null;

    const unlisten = listen<{ path: string; change_type: string }>("file-changed", (event) => {
      const changedPath = event.payload.path;
      if (!changedPath.startsWith(workspacePath)) return;
      const charAfter = changedPath[workspacePath.length];
      if (charAfter !== undefined && charAfter !== "/" && charAfter !== "\\") return;
      const relative = changedPath.slice(workspacePath.length);
      if (
        relative.includes("/.git/") ||
        relative.includes("\\.git\\") ||
        relative.endsWith("/.git") ||
        relative.endsWith("\\.git")
      )
        return;

      if (debounceTimer) clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => {
        refreshGitInfo(workspacePath);
      }, 800);
    });

    return () => {
      if (debounceTimer) clearTimeout(debounceTimer);
      unlisten.then((fn) => fn());
    };
  }, [workspacePath, refreshGitInfo]);

  if (!gitInfo || !gitInfo.is_git_repo) return null;

  const changeCount = gitInfo.modified_count + gitInfo.untracked_count;

  const hoverBg = "rgba(var(--hover-overlay-rgb), 0.10)";
  const tooltipText = changeCount > 0 ? `Git — ${changeCount} 处变更` : "Git";

  return (
    <Tooltip content={tooltipText}>
      <button
        type="button"
        onClick={togglePanel}
        className="flex items-center justify-center cursor-pointer native-css-hover"
        aria-label="Git"
        style={
          {
            position: "relative",
            width: 32,
            height: 32,
            borderRadius: 8,
            backgroundColor: "transparent",
            border: "none",
            color: "var(--color-muted-foreground)",
            "--native-hover-bg-color": hoverBg,
          } as React.CSSProperties
        }
      >
        <GitBranch size={14} />
        {changeCount > 0 && (
          <span
            className="flex items-center justify-center"
            style={{
              position: "absolute",
              top: -5,
              right: -5,
              minWidth: 16,
              height: 16,
              padding: "0 4px",
              borderRadius: 8,
              fontSize: 9,
              fontWeight: 700,
              color: "#292524",
              backgroundColor: "#E5C07B",
              boxShadow: "0 0 0 1.5px var(--color-background)",
              fontFamily: "var(--font-sans)",
            }}
          >
            {changeCount > 99 ? "99+" : changeCount}
          </span>
        )}
      </button>
    </Tooltip>
  );
}
