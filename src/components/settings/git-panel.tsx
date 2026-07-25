import { useState } from "react";
import { useTranslation } from "react-i18next";
import { invoke } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";
import {
  Eye,
  EyeOff,
  CircleCheck,
  CircleX,
  Loader2,
  ExternalLink,
  Info,
  GitBranch,
} from "lucide-react";
import { useSettingsStore, type GitPlatformId } from "@/stores/settings-store";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface GitPanelProps {
  readonly draftGitTokens: Record<GitPlatformId, string>;
  readonly setDraftGitTokens: (tokens: Record<GitPlatformId, string>) => void;
}

interface TokenTestResult {
  readonly success: boolean;
  readonly message: string;
  readonly elapsed_ms: number;
  readonly username: string | null;
}

interface TestState {
  readonly status: "idle" | "testing" | "success" | "error";
  readonly message: string;
  readonly username: string | null;
}

// ---------------------------------------------------------------------------
// Platform config
// ---------------------------------------------------------------------------

const GIT_PLATFORMS: ReadonlyArray<{
  readonly id: GitPlatformId;
  readonly color: string;
  readonly placeholder: string;
  readonly tokenUrl: string;
}> = [
  {
    id: "github",
    color: "#24292e",
    placeholder: "ghp_xxxxxxxxxxxxxxxxxxxx",
    tokenUrl: "https://github.com/settings/tokens/new",
  },
  {
    id: "gitee",
    color: "#C71D23",
    placeholder: "xxxxxxxxxxxxxxxxxxxxxxxx",
    tokenUrl: "https://gitee.com/profile/personal_access_tokens/new",
  },
  {
    id: "gitlab",
    color: "#FC6D26",
    placeholder: "glpat-xxxxxxxxxxxxxxxxxxxx",
    tokenUrl: "https://gitlab.com/-/user_settings/personal_access_tokens",
  },
];

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function GitPanel({ draftGitTokens, setDraftGitTokens }: GitPanelProps) {
  const { t } = useTranslation();
  const [showTokens, setShowTokens] = useState<Record<GitPlatformId, boolean>>({
    github: false,
    gitee: false,
    gitlab: false,
  });
  const [testStates, setTestStates] = useState<Record<GitPlatformId, TestState>>({
    github: { status: "idle", message: "", username: null },
    gitee: { status: "idle", message: "", username: null },
    gitlab: { status: "idle", message: "", username: null },
  });

  const updateToken = (platform: GitPlatformId, token: string) => {
    setDraftGitTokens({ ...draftGitTokens, [platform]: token });
    // Reset test state when token changes
    setTestStates((prev) => ({
      ...prev,
      [platform]: { status: "idle", message: "", username: null },
    }));
  };

  const toggleShowToken = (platform: GitPlatformId) => {
    setShowTokens((prev) => ({ ...prev, [platform]: !prev[platform] }));
  };

  const handleTestConnection = async (platform: GitPlatformId) => {
    const token = draftGitTokens[platform];
    if (!token.trim()) return;

    setTestStates((prev) => ({
      ...prev,
      [platform]: { status: "testing", message: "", username: null },
    }));

    try {
      const result = await invoke<TokenTestResult>("git_test_token", {
        platform,
        token: token.trim(),
      });

      setTestStates((prev) => ({
        ...prev,
        [platform]: {
          status: result.success ? "success" : "error",
          message: result.message,
          username: result.username,
        },
      }));

      // Persist username immediately so git push/pull can use it.
      if (result.success && result.username) {
        useSettingsStore.getState().setGitUsername(platform, result.username);
      }
    } catch (err) {
      setTestStates((prev) => ({
        ...prev,
        [platform]: {
          status: "error",
          message: String(err),
          username: null,
        },
      }));
    }
  };

  return (
    <div className="flex flex-col gap-4">
      {/* Platform cards */}
      {GIT_PLATFORMS.map((platform) => {
        const token = draftGitTokens[platform.id];
        const showToken = showTokens[platform.id];
        const testState = testStates[platform.id];

        return (
          <div
            key={platform.id}
            className="rounded-lg bg-card border border-border-subtle p-4 flex flex-col gap-3"
          >
            {/* Header */}
            <div className="flex items-center gap-3">
              <div
                className="flex items-center justify-center w-9 h-9 rounded-lg"
                style={{
                  backgroundColor: `color-mix(in srgb, ${platform.color} 15%, var(--color-card))`,
                }}
              >
                <GitBranch
                  size={17}
                  aria-hidden="true"
                  style={{ color: platform.color }}
                />
              </div>
              <div className="flex flex-col gap-0.5 flex-1">
                <span className="text-[14px] font-semibold text-foreground">
                  {t(`settings.git.${platform.id}.name`)}
                </span>
                <span className="text-[12px] text-text-tertiary">
                  {t(`settings.git.${platform.id}.description`)}
                </span>
              </div>
              <button
                onClick={() => openUrl(platform.tokenUrl)}
                className="flex items-center gap-1 px-2.5 py-1.5 rounded-md text-[11px] font-medium text-muted-foreground hover:text-foreground hover:bg-border-subtle transition-colors"
              >
                <ExternalLink size={12} />
                {t("settings.git.createTokenLink")}
              </button>
            </div>

            <div className="h-px bg-border-subtle" />

            {/* Token input */}
            <div className="flex flex-col gap-2">
              <div className="flex items-center gap-2">
                <div className="flex items-center gap-2 flex-1 h-10 rounded-md bg-surface-alt border border-border-strong px-3.5">
                  <input
                    type={showToken ? "text" : "password"}
                    value={token}
                    onChange={(e) => updateToken(platform.id, e.target.value)}
                    placeholder={platform.placeholder}
                    className="flex-1 bg-transparent text-[13px] text-foreground font-mono outline-none placeholder:text-text-placeholder"
                  />
                  <button
                    onClick={() => toggleShowToken(platform.id)}
                    className="flex items-center justify-center w-7 h-7 rounded hover:bg-border-subtle transition-colors"
                  >
                    {showToken ? (
                      <EyeOff size={14} className="text-text-tertiary" />
                    ) : (
                      <Eye size={14} className="text-text-tertiary" />
                    )}
                  </button>
                </div>

                {/* Test button */}
                <button
                  onClick={() => handleTestConnection(platform.id)}
                  disabled={!token.trim() || testState.status === "testing"}
                  className="flex items-center gap-1.5 h-10 px-4 rounded-md text-[13px] font-medium text-white bg-accent-purple hover:bg-accent-purple/80 disabled:bg-accent-purple/40 disabled:cursor-not-allowed transition-colors shrink-0"
                >
                  {testState.status === "testing" && (
                    <Loader2 size={14} className="animate-spin" />
                  )}
                  {testState.status === "testing"
                    ? t("settings.git.testing")
                    : t("settings.git.testConnection")}
                </button>
              </div>

              {/* Test result */}
              {testState.status === "success" && (
                <div className="flex items-center gap-1.5 text-[12px] text-accent-success">
                  <CircleCheck size={14} />
                  <span>
                    {testState.username
                      ? t("settings.git.connected", { username: testState.username })
                      : t("settings.git.connectedNoUser", { time: testState.message })}
                  </span>
                </div>
              )}
              {testState.status === "error" && (
                <div className="flex items-center gap-1.5 text-[12px] text-red-400">
                  <CircleX size={14} />
                  <span>{t("settings.git.failed", { message: testState.message })}</span>
                </div>
              )}
            </div>
          </div>
        );
      })}

      {/* Security hint */}
      <p className="text-[11px] text-text-tertiary px-1">
        {t("settings.git.securityHint")}
      </p>

      {/* Info card */}
      <div className="rounded-lg bg-card border border-border-subtle p-4 flex items-start gap-3">
        <div
          className="flex items-center justify-center w-9 h-9 rounded-lg shrink-0"
          style={{ backgroundColor: "color-mix(in srgb, #60A5FA 15%, var(--color-card))" }}
        >
          <Info size={16} className="text-[#60A5FA]" />
        </div>
        <div className="flex flex-col gap-1">
          <span className="text-[13px] font-medium text-foreground">
            {t("settings.git.infoTitle")}
          </span>
          <span className="text-[12px] text-text-tertiary leading-relaxed">
            {t("settings.git.infoDescription")}
          </span>
        </div>
      </div>
    </div>
  );
}
