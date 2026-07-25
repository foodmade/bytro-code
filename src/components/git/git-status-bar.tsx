import { GitBranch } from "lucide-react";
import type { GitInfo } from "@/stores/git-store";

interface GitStatusBarProps {
  readonly gitInfo: GitInfo;
}

export function GitStatusBar({ gitInfo }: GitStatusBarProps) {
  return (
    <div
      className="flex items-center justify-between shrink-0"
      style={{
        height: 28,
        padding: "0 16px",
        borderTop: "1px solid var(--color-border)",
      }}
    >
      {/* Left: branch + sync + changes */}
      <div className="flex items-center" style={{ gap: 16 }}>
        {/* Branch */}
        <div className="flex items-center" style={{ gap: 5 }}>
          <GitBranch size={12} style={{ color: "var(--color-accent-purple)" }} />
          <span
            className="text-[10px] font-medium font-mono"
            style={{ color: "var(--color-accent-purple)" }}
          >
            {gitInfo.branch ?? "detached"}
          </span>
        </div>

        {/* Sync */}
        <div className="flex items-center" style={{ gap: 8 }}>
          <span
            className="text-[10px] font-mono"
            style={{ color: gitInfo.ahead > 0 ? "var(--color-accent-purple)" : "var(--color-muted)" }}
          >
            {"\u2191"}{gitInfo.ahead}
          </span>
          <span
            className="text-[10px] font-mono"
            style={{ color: gitInfo.behind > 0 ? "#E5C07B" : "var(--color-muted)" }}
          >
            {"\u2193"}{gitInfo.behind}
          </span>
        </div>

        {/* Changes */}
        <div className="flex items-center" style={{ gap: 8 }}>
          {gitInfo.modified_count > 0 && (
            <span
              className="text-[10px] font-mono"
              style={{ color: "#E5C07B" }}
            >
              M:{gitInfo.modified_count}
            </span>
          )}
          {gitInfo.untracked_count > 0 && (
            <span
              className="text-[10px] font-mono"
              style={{ color: "#22C55E" }}
            >
              U:{gitInfo.untracked_count}
            </span>
          )}
        </div>
      </div>
    </div>
  );
}
