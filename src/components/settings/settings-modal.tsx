import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  Settings,
  X,
  SlidersHorizontal,
  Bot,
  Palette,
  Keyboard,
  RotateCcw,
  Check,
  Terminal,
  HardDrive,
  Info,
  GitBranch,
  AlertTriangle,
  RefreshCw,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { useSettingsStore, useToastStore } from "@/stores";
import { flushSettingsPersistence } from "@/stores/settings-store";
import { formatError } from "@/lib/format-error";
import type { GitPlatformId } from "@/stores/settings-store";
import {
  createDefaultPlatforms,
  clonePlatforms,
  normalizeOAuthProfiles,
  isProfileProxyConfigValid,
  type PlatformId,
  type PlatformConfig,
} from "@/lib/platform-config";

import { isWindowsPlatform } from "@/components/layout/window-controls";
import { useCliToolsStore } from "@/stores/cli-tools-store";
import { CliPathsPanel } from "./cli-paths-panel";
import { KeyboardShortcutsPanel } from "./keyboard-shortcuts-panel";
import { ModelsPanel } from "./models-panel";
import { GeneralPanel } from "./general-panel";
import { AppearancePanel } from "./appearance-panel";
import { StoragePanel } from "./storage-panel";
import { AboutPanel } from "./about-panel";
import { GitPanel } from "./git-panel";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface SettingsModalProps {
  readonly open: boolean;
  readonly onClose: () => void;
  readonly initialTab?: string;
}

type TabId =
  | "general"
  | "models"
  | "cli-paths"
  | "appearance"
  | "keys"
  | "storage"
  | "git"
  | "about";

const TABS: ReadonlyArray<{
  id: TabId;
  labelKey: string;
  icon: typeof Settings;
}> = [
  { id: "general", labelKey: "settings.tabs.general", icon: SlidersHorizontal },
  { id: "models", labelKey: "settings.tabs.models", icon: Bot },
  { id: "cli-paths", labelKey: "settings.tabs.cliPaths", icon: Terminal },
  { id: "appearance", labelKey: "settings.tabs.appearance", icon: Palette },
  { id: "keys", labelKey: "settings.tabs.shortcuts", icon: Keyboard },
  { id: "storage", labelKey: "settings.tabs.storage", icon: HardDrive },
  { id: "git", labelKey: "settings.tabs.git", icon: GitBranch },
  { id: "about", labelKey: "settings.tabs.about", icon: Info },
];

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function SettingsModal({ open, onClose, initialTab }: SettingsModalProps) {
  const { t } = useTranslation();
  const settings = useSettingsStore();
  const [activeTab, setActiveTab] = useState<TabId>((initialTab as TabId) ?? "models");

  // Reset active tab when modal opens with a specific initialTab
  useEffect(() => {
    if (open && initialTab) {
      setActiveTab(initialTab as TabId);
    }
  }, [open, initialTab]);

  // Platform config drafts
  const [draftPlatforms, setDraftPlatforms] = useState<Record<PlatformId, PlatformConfig>>(() =>
    clonePlatforms(settings.platforms),
  );

  const [cliDetecting, setCliDetecting] = useState(false);
  const [isSaving, setIsSaving] = useState(false);

  // Git token drafts
  const [draftGitTokens, setDraftGitTokens] = useState<Record<GitPlatformId, string>>(() => ({
    ...settings.gitTokens,
  }));

  // Sync drafts from store when modal opens
  useEffect(() => {
    if (open) {
      setDraftPlatforms(clonePlatforms(settings.platforms));
      setDraftGitTokens({ ...settings.gitTokens });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // Update a single platform's draft immutably
  const updateDraftPlatform = useCallback(
    (platformId: PlatformId, updater: (prev: PlatformConfig) => PlatformConfig) => {
      setDraftPlatforms((prev) => ({
        ...prev,
        [platformId]: updater(prev[platformId]),
      }));
    },
    [],
  );

  // ---------------------------------------------------------------------------
  // Save / Reset
  // ---------------------------------------------------------------------------

  const areProfileProxiesValid = Object.values(draftPlatforms).every((platform) =>
    platform.profiles.every((profile) => isProfileProxyConfigValid(profile.proxy)),
  );
  const canSave = areProfileProxiesValid;

  const handleSave = useCallback(async () => {
    if (!areProfileProxiesValid || isSaving) {
      return;
    }
    setIsSaving(true);
    try {
      // 仅规范化 OAuth 模式下的模型选择，保留 API Key 配置，
      // 避免用户切回 API Key 模式后需要重新填写本地设置。
      settings.setPlatforms(normalizeOAuthProfiles(draftPlatforms));
      for (const pid of ["github", "gitee", "gitlab"] as const) {
        settings.setGitToken(pid, draftGitTokens[pid]);
      }
      await flushSettingsPersistence();
      onClose();
    } catch (error) {
      useToastStore
        .getState()
        .addToast("error", t("settings.footer.saveFailed", { error: formatError(error) }));
    } finally {
      setIsSaving(false);
    }
  }, [areProfileProxiesValid, draftPlatforms, draftGitTokens, isSaving, onClose, settings, t]);

  const handleReset = useCallback(() => {
    settings.resetToDefaults();
    setDraftPlatforms(createDefaultPlatforms());
    setDraftGitTokens({ github: "", gitee: "", gitlab: "" });
  }, [settings]);

  // ---------------------------------------------------------------------------
  // Focus trap
  // ---------------------------------------------------------------------------

  const dialogRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        if (!isSaving) onClose();
        return;
      }

      if (e.key !== "Tab") return;
      const dialog = dialogRef.current;
      if (!dialog) return;

      const focusable = dialog.querySelectorAll<HTMLElement>(
        'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
      );
      if (focusable.length === 0) return;

      const first = focusable[0];
      const last = focusable[focusable.length - 1];

      if (e.shiftKey) {
        if (document.activeElement === first) {
          e.preventDefault();
          last.focus();
        }
      } else {
        if (document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }
    };

    document.addEventListener("keydown", handleKeyDown);
    const timer = setTimeout(() => {
      dialogRef.current?.focus();
    }, 0);

    return () => {
      document.removeEventListener("keydown", handleKeyDown);
      clearTimeout(timer);
    };
  }, [isSaving, open, onClose]);

  if (!open) return null;

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div
        className="absolute inset-0 bg-black/60"
        onClick={isSaving ? undefined : onClose}
        aria-hidden="true"
      />

      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label="Settings"
        tabIndex={-1}
        className="relative w-[900px] max-w-[90vw] h-[880px] max-h-[90vh] rounded-xl flex flex-col overflow-hidden outline-none"
        style={{
          backgroundColor: "var(--color-surface-raised)",
          border: "1px solid var(--color-border-light)",
          boxShadow: "0 16px 48px rgba(0,0,0,0.3)",
        }}
      >
        {/* Header */}
        <div
          className="flex items-center justify-between h-14 px-6 shrink-0"
          style={{ borderBottom: "1px solid var(--color-border-subtle)" }}
        >
          <div className="flex items-center gap-2.5">
            <Settings size={18} className="text-accent-purple" />
            <span className="text-[16px] font-semibold text-foreground font-sans">
              {t("settings.title")}
            </span>
          </div>
          <button
            onClick={onClose}
            disabled={isSaving}
            aria-label={t("settings.close")}
            className="flex items-center justify-center w-7 h-7 rounded-md hover:bg-border-light transition-colors disabled:opacity-50"
            style={{ backgroundColor: "var(--color-border)" }}
          >
            <X size={14} className="text-text-placeholder" />
          </button>
        </div>

        {settings.persistenceError && (
          <div
            role="alert"
            className="mx-6 mt-4 flex items-center gap-3 rounded-lg px-3 py-2 text-[12px]"
            style={{
              color: "var(--color-accent-danger)",
              backgroundColor: "color-mix(in srgb, var(--color-accent-danger) 8%, transparent)",
              border: "1px solid color-mix(in srgb, var(--color-accent-danger) 30%, transparent)",
            }}
          >
            <AlertTriangle size={15} className="shrink-0" />
            <span className="flex-1">{settings.persistenceError}</span>
            <button
              type="button"
              onClick={() => void settings.retryPersistenceLoad().catch(() => {})}
              className="flex items-center gap-1 rounded-md px-2 py-1 font-semibold hover:bg-border-light"
            >
              <RefreshCw size={12} />
              Retry
            </button>
          </div>
        )}

        {/* Sidebar + Content */}
        <div className="flex flex-1 min-h-0">
          {/* Vertical sidebar navigation */}
          <nav
            className="flex flex-col w-[180px] shrink-0 py-3 px-2 overflow-y-auto"
            style={{
              backgroundColor: "var(--color-background)",
              borderRight: "1px solid var(--color-border-subtle)",
            }}
            role="tablist"
            aria-label="Settings sections"
            aria-orientation="vertical"
          >
            {TABS.map((tab, idx) => {
              const Icon = tab.icon;
              const isActive = activeTab === tab.id;
              return (
                <button
                  key={tab.id}
                  role="tab"
                  aria-selected={isActive}
                  aria-controls={`settings-panel-${tab.id}`}
                  id={`settings-tab-${tab.id}`}
                  tabIndex={isActive ? 0 : -1}
                  onClick={() => setActiveTab(tab.id)}
                  onKeyDown={(e) => {
                    let nextIdx = idx;
                    if (e.key === "ArrowDown") {
                      e.preventDefault();
                      nextIdx = (idx + 1) % TABS.length;
                    } else if (e.key === "ArrowUp") {
                      e.preventDefault();
                      nextIdx = (idx - 1 + TABS.length) % TABS.length;
                    } else {
                      return;
                    }
                    setActiveTab(TABS[nextIdx].id);
                    document.getElementById(`settings-tab-${TABS[nextIdx].id}`)?.focus();
                  }}
                  className={cn(
                    "flex items-center gap-2.5 w-full py-2 px-3 rounded-lg text-[13px] font-medium text-left transition-colors",
                    isActive
                      ? "font-semibold"
                      : "hover:bg-[color-mix(in_srgb,var(--color-foreground)_5%,transparent)]",
                  )}
                  style={
                    isActive
                      ? {
                          backgroundColor:
                            "color-mix(in srgb, var(--color-accent-purple) 10%, transparent)",
                          color: "var(--color-accent-purple)",
                        }
                      : { color: "var(--color-muted-foreground)" }
                  }
                >
                  <Icon
                    size={16}
                    className="shrink-0"
                    style={{
                      color: isActive ? "var(--color-accent-purple)" : "var(--color-muted)",
                    }}
                  />
                  {t(tab.labelKey)}
                </button>
              );
            })}
          </nav>

          {/* Content area */}
          <div
            className={cn(
              "flex-1 min-h-0 min-w-0",
              activeTab === "models" ? "flex" : "p-4 overflow-y-auto",
            )}
            role="tabpanel"
            id={`settings-panel-${activeTab}`}
            aria-labelledby={`settings-tab-${activeTab}`}
          >
            {activeTab === "models" && (
              <ModelsPanel
                open={open}
                draftPlatforms={draftPlatforms}
                updateDraftPlatform={updateDraftPlatform}
              />
            )}

            {activeTab === "general" && <GeneralPanel />}

            {activeTab === "cli-paths" && (
              <CliPathsPanel
                isWindows={isWindowsPlatform}
                detecting={cliDetecting}
                onDetect={async () => {
                  setCliDetecting(true);
                  try {
                    await useCliToolsStore.getState().loadTools(true);
                  } catch {
                    // detection failed silently
                  } finally {
                    setCliDetecting(false);
                  }
                }}
              />
            )}

            {activeTab === "appearance" && <AppearancePanel />}

            {activeTab === "keys" && <KeyboardShortcutsPanel />}

            {activeTab === "storage" && <StoragePanel />}

            {activeTab === "git" && (
              <GitPanel draftGitTokens={draftGitTokens} setDraftGitTokens={setDraftGitTokens} />
            )}

            {activeTab === "about" && <AboutPanel />}
          </div>
        </div>

        {/* Footer */}
        <div
          className="flex items-center justify-between h-16 px-6 shrink-0"
          style={{ borderTop: "1px solid var(--color-border-subtle)" }}
        >
          <button
            onClick={handleReset}
            disabled={isSaving}
            className="flex items-center gap-1.5 px-3.5 py-2 rounded-md text-[12px] font-medium text-text-placeholder hover:text-muted-foreground transition-colors"
          >
            <RotateCcw size={14} style={{ color: "var(--color-muted)" }} />
            {t("settings.footer.resetToDefault")}
          </button>
          <div className="flex items-center gap-3">
            <button
              onClick={onClose}
              disabled={isSaving}
              className="px-5 py-2 rounded-md text-[13px] font-medium text-muted-foreground hover:bg-border transition-colors"
              style={{ border: "1px solid var(--color-border-strong)" }}
            >
              {t("settings.footer.cancel")}
            </button>
            <button
              onClick={handleSave}
              disabled={!canSave || isSaving}
              className={cn(
                "flex items-center gap-1.5 px-5 py-2 rounded-md text-[13px] font-semibold text-white transition-colors",
                canSave && !isSaving
                  ? "bg-accent-purple hover:bg-accent-purple/80"
                  : "bg-accent-purple/40 cursor-not-allowed",
              )}
            >
              <Check size={14} />
              {isSaving ? t("settings.footer.saving") : t("settings.footer.saveChanges")}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
