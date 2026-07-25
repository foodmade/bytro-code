import { useEffect } from "react";
import { AlertCircle, CheckCircle2, RefreshCw, Terminal } from "lucide-react";
import { useTranslation } from "react-i18next";
import { useCliToolsStore } from "@/stores/cli-tools-store";

interface CliPathItem {
  readonly id: string;
  readonly label: string;
  readonly descriptionKey: string;
  readonly pattern: string;
  readonly envVar: string;
  readonly windowsOnly?: boolean;
}

const CLI_PATH_ITEMS: readonly CliPathItem[] = [
  {
    id: "nodejs",
    label: "Node.js",
    descriptionKey: "settings.cliPaths.nodeDescription",
    pattern: "node",
    envVar: "BYTRO_NODE_PATH",
  },
  {
    id: "claude",
    label: "Claude CLI",
    descriptionKey: "settings.cliPaths.claudeDescription",
    pattern: "claude",
    envVar: "CLAUDE_CLI_PATH",
  },
  {
    id: "codex",
    label: "Codex CLI",
    descriptionKey: "settings.cliPaths.codexDescription",
    pattern: "codex",
    envVar: "CODEX_CLI_PATH",
  },
  {
    id: "gemini",
    label: "Gemini CLI",
    descriptionKey: "settings.cliPaths.geminiDescription",
    pattern: "gemini",
    envVar: "GEMINI_CLI_PATH",
  },
  {
    id: "git-bash",
    label: "Git Bash",
    descriptionKey: "settings.cliPaths.gitBashDescription",
    pattern: "git bash",
    envVar: "BYTRO_GIT_BASH_PATH",
    windowsOnly: true,
  },
];

export interface CliPathsPanelProps {
  readonly detecting: boolean;
  readonly onDetect: () => void;
  readonly isWindows: boolean;
}

export function CliPathsPanel({ detecting, onDetect, isWindows }: CliPathsPanelProps) {
  const { t } = useTranslation();
  const tools = useCliToolsStore((state) => state.tools);

  useEffect(() => {
    void useCliToolsStore.getState().loadTools();
  }, []);

  const visibleItems = CLI_PATH_ITEMS.filter((item) => !item.windowsOnly || isWindows);

  return (
    <div className="flex flex-col gap-4">
      <div className="rounded-lg bg-card border border-border-subtle p-4 flex flex-col gap-4">
        <div className="flex items-center justify-between gap-4">
          <div className="flex items-center gap-3 min-w-0">
            <div className="flex items-center justify-center w-9 h-9 rounded-lg bg-[#1B2E4E] shrink-0">
              <Terminal size={16} className="text-[#60A5FA]" />
            </div>
            <div className="flex flex-col gap-0.5 min-w-0">
              <span className="text-[14px] font-semibold text-foreground">
                {t("settings.cliPaths.title", "Local CLI paths")}
              </span>
              <span className="text-[12px] text-muted-foreground">
                {t(
                  "settings.cliPaths.communitySubtitle",
                  "Bytro detects local tools only. It never downloads, updates, or removes them.",
                )}
              </span>
            </div>
          </div>
          <button
            type="button"
            onClick={onDetect}
            disabled={detecting}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-md border border-border-strong text-[12px] font-medium text-foreground hover:bg-border-subtle disabled:opacity-40 transition-colors shrink-0"
          >
            <RefreshCw
              size={13}
              className={detecting ? "animate-spin" : ""}
              style={{ color: "#60A5FA" }}
            />
            {detecting
              ? t("settings.cliPaths.detecting", "Detecting...")
              : t("settings.cliPaths.autoDetect", "Detect again")}
          </button>
        </div>

        <div className="h-px bg-border-subtle" />

        {visibleItems.map((item) => {
          const tool = tools.find((candidate) =>
            candidate.name.toLowerCase().includes(item.pattern),
          );
          const installed = tool?.installed === true;
          const version = tool?.version?.trim() || null;
          const path = tool?.path?.trim() || "";

          return (
            <div key={item.id} className="flex flex-col gap-2">
              <div className="flex items-center gap-2 min-w-0">
                {installed ? (
                  <CheckCircle2 size={14} className="text-emerald-500 shrink-0" />
                ) : (
                  <AlertCircle size={14} className="text-amber-500 shrink-0" />
                )}
                <span className="text-[13px] font-medium text-foreground">{item.label}</span>
                {version && (
                  <span className="text-[10px] font-mono px-1.5 py-px rounded bg-surface-alt text-muted-foreground border border-border-subtle truncate">
                    {version.startsWith("v") ? version : `v${version}`}
                  </span>
                )}
                <span className="text-[11px] text-muted truncate">{t(item.descriptionKey)}</span>
              </div>

              <div className="flex items-center gap-2 h-10 rounded-md bg-surface-alt border border-border-strong px-3.5">
                <Terminal
                  size={14}
                  className="shrink-0"
                  style={{
                    color: installed ? "#60A5FA" : "var(--color-border-strong)",
                  }}
                />
                <span
                  className="flex-1 min-w-0 truncate text-[12px] text-foreground font-mono"
                  title={path || tool?.install_command}
                >
                  {path ||
                    t(
                      "settings.cliPaths.notDetected",
                      "Not detected in the launch environment or PATH",
                    )}
                </span>
                <code className="text-[10px] text-muted-foreground shrink-0">{item.envVar}</code>
              </div>
            </div>
          );
        })}

        <span className="text-[11px] text-muted-foreground leading-5">
          {t(
            "settings.cliPaths.communityHint",
            "Set an explicit path variable in the environment used to launch Bytro, or add the executable to your system PATH, then detect again.",
          )}
        </span>
      </div>
    </div>
  );
}
