import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { FolderGit2, Copy, Terminal, FolderOpen, GitBranch } from "lucide-react";
import { invoke } from "@tauri-apps/api/core";
import { openPath } from "@tauri-apps/plugin-opener";
import { useIsLightTheme } from "@/hooks/use-is-light-theme";
import { useToastStore, useWorkspaceStatsStore, useTerminalStore } from "@/stores";
import type { Workspace } from "@/stores";
import type { GitInfo } from "@/stores/git-store";

interface WorkspaceHeaderProps {
  readonly workspace: Workspace | null;
  readonly gitInfo?: GitInfo | null;
}

interface TechStackItem {
  readonly name: string;
  readonly category: string;
}

interface TechBadgeStyle {
  readonly color: string;
  readonly bg: string;
  readonly border: string;
}

const TECH_COLORS: Record<string, TechBadgeStyle> = {
  TypeScript: { color: "#2563EB", bg: "#EFF6FF", border: "#BFDBFE" },
  JavaScript: { color: "#EAB308", bg: "#FEFCE8", border: "#FEF08A" },
  Rust: { color: "#EA580C", bg: "#FFF7ED", border: "#FED7AA" },
  Go: { color: "#00ADD8", bg: "#ECFEFF", border: "#A5F3FC" },
  Python: { color: "#3B82F6", bg: "#EFF6FF", border: "#BFDBFE" },
  Java: { color: "#DC2626", bg: "#FEF2F2", border: "#FECACA" },
  Ruby: { color: "#DC2626", bg: "#FEF2F2", border: "#FECACA" },
  PHP: { color: "#7C3AED", bg: "#F5F3FF", border: "#DDD6FE" },
  "C#": { color: "#7C3AED", bg: "#F5F3FF", border: "#DDD6FE" },
  Dart: { color: "#0891B2", bg: "#ECFEFF", border: "#A5F3FC" },
  Swift: { color: "#EA580C", bg: "#FFF7ED", border: "#FED7AA" },
  Kotlin: { color: "#7C3AED", bg: "#F5F3FF", border: "#DDD6FE" },
  Elixir: { color: "#7C3AED", bg: "#F5F3FF", border: "#DDD6FE" },
  Scala: { color: "#DC2626", bg: "#FEF2F2", border: "#FECACA" },
  "Node.js": { color: "#16A34A", bg: "#F0FDF4", border: "#BBF7D0" },
  Deno: { color: "#1E3A5F", bg: "#F0F9FF", border: "#BAE6FD" },
  Bun: { color: "#FBCEB1", bg: "#FFF7ED", border: "#FED7AA" },
  React: { color: "#0891B2", bg: "#ECFEFF", border: "#A5F3FC" },
  "React Native": { color: "#0891B2", bg: "#ECFEFF", border: "#A5F3FC" },
  Vue: { color: "#16A34A", bg: "#F0FDF4", border: "#BBF7D0" },
  Angular: { color: "#DC2626", bg: "#FEF2F2", border: "#FECACA" },
  Svelte: { color: "#EA580C", bg: "#FFF7ED", border: "#FED7AA" },
  Solid: { color: "#2563EB", bg: "#EFF6FF", border: "#BFDBFE" },
  "Next.js": { color: "#171717", bg: "#F5F5F5", border: "#E5E5E5" },
  Nuxt: { color: "#16A34A", bg: "#F0FDF4", border: "#BBF7D0" },
  Remix: { color: "#171717", bg: "#F5F5F5", border: "#E5E5E5" },
  Astro: { color: "#9333EA", bg: "#FDF4FF", border: "#E9D5FF" },
  Express: { color: "#475569", bg: "#F8FAFC", border: "#E2E8F0" },
  Fastify: { color: "#171717", bg: "#F5F5F5", border: "#E5E5E5" },
  Hono: { color: "#EA580C", bg: "#FFF7ED", border: "#FED7AA" },
  NestJS: { color: "#DC2626", bg: "#FEF2F2", border: "#FECACA" },
  Tauri: { color: "#FCD34D", bg: "#FFFBEB", border: "#FDE68A" },
  Electron: { color: "#0EA5E9", bg: "#F0F9FF", border: "#BAE6FD" },
  Expo: { color: "#171717", bg: "#F5F5F5", border: "#E5E5E5" },
  Flutter: { color: "#0891B2", bg: "#ECFEFF", border: "#A5F3FC" },
  "Tailwind CSS": { color: "#0891B2", bg: "#ECFEFF", border: "#A5F3FC" },
  "Actix Web": { color: "#EA580C", bg: "#FFF7ED", border: "#FED7AA" },
  Axum: { color: "#EA580C", bg: "#FFF7ED", border: "#FED7AA" },
  Rocket: { color: "#DC2626", bg: "#FEF2F2", border: "#FECACA" },
  Vite: { color: "#7C3AED", bg: "#F5F3FF", border: "#DDD6FE" },
  Webpack: { color: "#0EA5E9", bg: "#F0F9FF", border: "#BAE6FD" },
  Docker: { color: "#2563EB", bg: "#EFF6FF", border: "#BFDBFE" },
  "Cloudflare Workers": { color: "#F97316", bg: "#FFF7ED", border: "#FED7AA" },
  Prisma: { color: "#1E3A5F", bg: "#F0F9FF", border: "#BAE6FD" },
  Drizzle: { color: "#16A34A", bg: "#F0FDF4", border: "#BBF7D0" },
  SQLx: { color: "#0891B2", bg: "#ECFEFF", border: "#A5F3FC" },
  Diesel: { color: "#EA580C", bg: "#FFF7ED", border: "#FED7AA" },
};

const DEFAULT_BADGE_STYLE: TechBadgeStyle = { color: "#475569", bg: "#F8FAFC", border: "#E2E8F0" };

function getTechStyle(name: string): TechBadgeStyle {
  return TECH_COLORS[name] ?? DEFAULT_BADGE_STYLE;
}

function getGreetingKey(): string {
  const hour = new Date().getHours();
  if (hour < 6) return "workspace.greeting.night";
  if (hour < 12) return "workspace.greeting.morning";
  if (hour < 18) return "workspace.greeting.afternoon";
  return "workspace.greeting.evening";
}

function HeaderActionButton({
  icon: Icon,
  label,
  onClick,
}: {
  readonly icon: React.ComponentType<{ size?: number; style?: React.CSSProperties }>;
  readonly label: string;
  readonly onClick?: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className="flex items-center transition-colors native-css-hover"
      style={
        {
          gap: 5,
          padding: "5px 10px",
          borderRadius: 6,
          border: "1px solid var(--color-border)",
          background: "transparent",
          cursor: "pointer",
          "--native-hover-bg-color": "var(--color-surface-alt)",
        } as React.CSSProperties
      }
    >
      <Icon size={13} style={{ color: "var(--color-muted)" }} />
      <span style={{ fontSize: 12, color: "var(--color-muted)", fontFamily: "Inter, sans-serif" }}>
        {label}
      </span>
    </button>
  );
}

export function WorkspaceHeader({ workspace, gitInfo }: WorkspaceHeaderProps) {
  const { t } = useTranslation();
  const isLight = useIsLightTheme();
  const stats = useWorkspaceStatsStore((s) => s.stats);
  const [techStack, setTechStack] = useState<readonly TechStackItem[]>([]);

  useEffect(() => {
    if (!workspace?.path) {
      setTechStack([]);
      return;
    }
    invoke<TechStackItem[]>("detect_tech_stack", { path: workspace.path })
      .then(setTechStack)
      .catch(() => setTechStack([]));
  }, [workspace?.path]);

  const handleCopyPath = useCallback(() => {
    if (!workspace) return;
    navigator.clipboard.writeText(workspace.path);
    useToastStore.getState().addToast("info", t("workspace.actionButtons.pathCopied"));
  }, [workspace, t]);

  const handleTerminal = useCallback(() => {
    if (!workspace) return;
    useTerminalStore.getState().openPopup(workspace.path);
  }, [workspace]);

  const handleOpenDir = useCallback(() => {
    if (!workspace) return;
    openPath(workspace.path).catch(() => {});
  }, [workspace]);

  if (!workspace) return null;

  return (
    <div className="flex flex-col" style={{ gap: 8 }}>
      {/* Top row: icon + workspace name | action buttons */}
      <div
        className="flex items-center justify-between w-full"
        style={{ gap: 12, rowGap: 8, flexWrap: "wrap" }}
      >
        <div className="flex items-center" style={{ gap: 10 }}>
          <FolderGit2 size={18} style={{ color: "#A855F7" }} />
          <span
            style={{
              fontSize: 14,
              fontWeight: 600,
              color: "var(--color-muted)",
              fontFamily: "Inter, sans-serif",
            }}
          >
            {workspace.name}
          </span>
        </div>
        <div
          className="flex items-center"
          style={{ gap: 8, flexWrap: "wrap", justifyContent: "flex-end" }}
        >
          <HeaderActionButton
            icon={Copy}
            label={t("workspace.actionButtons.copyPath")}
            onClick={handleCopyPath}
          />
          <HeaderActionButton
            icon={Terminal}
            label={t("workspace.actionButtons.terminal")}
            onClick={handleTerminal}
          />
          <HeaderActionButton
            icon={FolderOpen}
            label={t("workspace.actionButtons.openDirectory")}
            onClick={handleOpenDir}
          />
        </div>
      </div>

      {/* Greeting */}
      <span
        style={{
          fontSize: 24,
          fontWeight: 700,
          color: "var(--color-foreground)",
          fontFamily: "Inter, sans-serif",
        }}
      >
        {t(getGreetingKey())}
      </span>

      {/* Subtitle: branch · files · lines · tech tags */}
      <div className="flex items-center" style={{ gap: 12, rowGap: 8, flexWrap: "wrap" }}>
        {gitInfo && gitInfo.is_git_repo && (
          <div
            className="flex items-center"
            style={{
              gap: 5,
              padding: "2px 8px",
              borderRadius: 4,
              backgroundColor: "var(--color-surface-alt)",
            }}
          >
            <GitBranch size={11} style={{ color: "var(--color-muted)" }} />
            <span
              style={{
                fontSize: 12,
                fontWeight: 500,
                color: "var(--color-muted)",
                fontFamily: "'JetBrains Mono', monospace",
              }}
            >
              {gitInfo.branch ?? "detached"}
            </span>
          </div>
        )}

        {stats && (
          <>
            <span style={{ fontSize: 12, color: "var(--color-muted)" }}>&middot;</span>
            <span
              style={{
                fontSize: 12,
                color: "var(--color-muted-foreground)",
                fontFamily: "Inter, sans-serif",
              }}
            >
              {stats.totalFiles.toLocaleString()} {t("workspace.stats.files", "files")}
            </span>
            <span style={{ fontSize: 12, color: "var(--color-muted)" }}>&middot;</span>
            <span
              style={{
                fontSize: 12,
                color: "var(--color-muted-foreground)",
                fontFamily: "Inter, sans-serif",
              }}
            >
              {stats.totalLines.toLocaleString()} {t("workspace.stats.lines", "lines")}
            </span>
          </>
        )}

        {techStack.length > 0 && (
          <>
            <span style={{ fontSize: 12, color: "var(--color-muted)" }}>&middot;</span>
            <div className="flex items-center" style={{ gap: 6, flexWrap: "wrap" }}>
              {techStack.slice(0, 5).map((tech) => {
                const s = getTechStyle(tech.name);
                return (
                  <div
                    key={tech.name}
                    className="flex items-center"
                    style={{
                      padding: "2px 8px",
                      borderRadius: 4,
                      backgroundColor: isLight ? s.bg : s.color + "12",
                      border: isLight ? `1px solid ${s.border}` : "none",
                    }}
                  >
                    <span
                      style={{
                        fontSize: 11,
                        fontWeight: 500,
                        color: s.color,
                        fontFamily: "Inter, sans-serif",
                      }}
                    >
                      {tech.name}
                    </span>
                  </div>
                );
              })}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
