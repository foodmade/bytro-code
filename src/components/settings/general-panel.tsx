import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { invoke } from "@tauri-apps/api/core";
import {
  CircleCheck,
  CircleX,
  BrainCircuit,
  Bell,
  Volume2,
  ExternalLink,
  FolderOpen,
  Image as ImageIcon,
  RotateCcw,
} from "lucide-react";
import { formatError } from "@/lib/format-error";
import { useSettingsStore } from "@/stores";
import {
  isPermissionGranted,
  requestPermission,
} from "@tauri-apps/plugin-notification";
import { isMacPlatform } from "@/components/layout/window-controls";
import { cn } from "@/lib/utils";

import { UiLanguageSelector } from "./ui-language-selector";

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function GeneralPanel() {
  const { t } = useTranslation();
  const settings = useSettingsStore();

  // Notification permission status
  const [notifPermission, setNotifPermission] = useState<"unknown" | "checking" | "granted" | "denied">("unknown");

  // Check notification permission on mount
  useEffect(() => {
    isPermissionGranted()
      .then((granted) => setNotifPermission(granted ? "granted" : "denied"))
      .catch(() => setNotifPermission("unknown"));
  }, []);

  return (
    <div className="flex flex-col gap-4">
      {/* UI Language */}
      <div className="rounded-lg bg-card border border-border-subtle p-4">
        <UiLanguageSelector />
      </div>

      {/* Cross-session Memory */}
      <div className="rounded-lg bg-card border border-border-subtle p-4 flex flex-col gap-3">
        <div className="flex items-center gap-3">
          <div className="flex items-center justify-center w-9 h-9 rounded-lg" style={{ backgroundColor: "color-mix(in srgb, var(--color-accent-purple) 15%, var(--color-card))" }}>
            <BrainCircuit size={16} className="text-accent-purple" />
          </div>
          <div className="flex flex-col gap-0.5 flex-1">
            <span className="text-[14px] font-semibold text-foreground">{t("settings.general.crossSessionMemory")}</span>
            <span className="text-[12px] text-text-tertiary">
              {t("settings.general.crossSessionMemoryDescription")}
            </span>
          </div>
          <button
            onClick={() => settings.setCrossSessionMemory(!settings.crossSessionMemory)}
            role="switch"
            aria-checked={settings.crossSessionMemory}
            className={cn(
              "relative inline-flex h-6 w-11 shrink-0 cursor-pointer rounded-full transition-colors",
              settings.crossSessionMemory ? "bg-accent-purple" : "bg-border-strong",
            )}
          >
            <span
              className={cn(
                "pointer-events-none inline-block h-5 w-5 transform rounded-full bg-white shadow-sm transition-transform mt-0.5",
                settings.crossSessionMemory ? "translate-x-[22px]" : "translate-x-0.5",
              )}
            />
          </button>
        </div>
      </div>

      {/* AI Outputs Directory */}
      <OutputsDirCard />

      {/* Notifications */}
      <div className="rounded-lg bg-card border border-border-subtle p-4 flex flex-col gap-3">
        <div className="flex items-center gap-3">
          <div className="flex items-center justify-center w-9 h-9 rounded-lg" style={{ backgroundColor: "color-mix(in srgb, #F59E0B 15%, var(--color-card))" }}>
            <Bell size={16} className="text-[#F59E0B]" />
          </div>
          <div className="flex flex-col gap-0.5 flex-1">
            <span className="text-[14px] font-semibold text-foreground">{t("settings.general.notifications")}</span>
            <span className="text-[12px] text-text-tertiary">
              {t("settings.general.notificationsDescription")}
            </span>
          </div>
          <button
            onClick={async () => {
              const next = !settings.notificationsEnabled;
              if (next) {
                setNotifPermission("checking");
                try {
                  const granted = await isPermissionGranted();
                  if (granted) {
                    setNotifPermission("granted");
                    settings.setNotificationsEnabled(true);
                    return;
                  }
                  const result = await requestPermission();
                  if (result === "denied") {
                    setNotifPermission("denied");
                    settings.setNotificationsEnabled(false);
                    return;
                  }
                  // "granted" 或 "default"（Windows/Linux）— 用 Rust 后端二次确认
                  const recheckGranted = await isPermissionGranted();
                  setNotifPermission(recheckGranted ? "granted" : "denied");
                  settings.setNotificationsEnabled(recheckGranted);
                } catch {
                  setNotifPermission("unknown");
                  settings.setNotificationsEnabled(true);
                }
              } else {
                settings.setNotificationsEnabled(false);
              }
            }}
            role="switch"
            aria-checked={settings.notificationsEnabled}
            className={cn(
              "relative inline-flex h-6 w-11 shrink-0 cursor-pointer rounded-full transition-colors",
              settings.notificationsEnabled ? "bg-accent-purple" : "bg-border-strong",
            )}
          >
            <span
              className={cn(
                "pointer-events-none inline-block h-5 w-5 transform rounded-full bg-white shadow-sm transition-transform mt-0.5",
                settings.notificationsEnabled ? "translate-x-[22px]" : "translate-x-0.5",
              )}
            />
          </button>
        </div>

        {/* Permission status & macOS guidance */}
        {settings.notificationsEnabled && (
          <div className="flex items-center gap-2 ml-12">
            {notifPermission === "checking" && (
              <span className="text-[11px] text-text-tertiary">{t("settings.general.notificationsPermissionRequesting")}</span>
            )}
            {notifPermission === "granted" && (
              <div className="flex items-center gap-1.5">
                <CircleCheck size={12} className="text-[#10B981]" />
                <span className="text-[11px] text-[#10B981]">{t("settings.general.notificationsPermissionGranted")}</span>
              </div>
            )}
            {notifPermission === "denied" && (
              <div className="flex items-center gap-1.5 flex-wrap">
                <CircleX size={12} className="text-red-400 shrink-0" />
                <span className="text-[11px] text-red-400">{t("settings.general.notificationsPermissionDenied")}</span>
                {isMacPlatform && (
                  <button
                    onClick={async () => {
                      try {
                        const { openUrl } = await import("@tauri-apps/plugin-opener");
                        await openUrl("x-apple.systempreferences:com.apple.Notifications-Settings");
                      } catch {
                        // fallback: ignored
                      }
                    }}
                    className="inline-flex items-center gap-1 text-[11px] text-accent-purple hover:underline"
                  >
                    {t("settings.general.notificationsOpenSettings")}
                    <ExternalLink size={10} />
                  </button>
                )}
              </div>
            )}
          </div>
        )}

        {/* Notification Sound */}
        <div className="h-px bg-border-subtle" />
        <div className="flex items-center gap-3">
          <div className="flex items-center justify-center w-9 h-9 rounded-lg" style={{ backgroundColor: "color-mix(in srgb, #F59E0B 15%, var(--color-card))" }}>
            <Volume2 size={16} className="text-[#F59E0B]" />
          </div>
          <div className="flex flex-col gap-0.5 flex-1">
            <span className="text-[14px] font-semibold text-foreground">{t("settings.general.notificationSound")}</span>
            <span className="text-[12px] text-text-tertiary">
              {t("settings.general.notificationSoundDescription")}
            </span>
          </div>
          <button
            onClick={() => settings.setNotificationSoundEnabled(!settings.notificationSoundEnabled)}
            role="switch"
            aria-checked={settings.notificationSoundEnabled}
            className={cn(
              "relative inline-flex h-6 w-11 shrink-0 cursor-pointer rounded-full transition-colors",
              settings.notificationSoundEnabled ? "bg-accent-purple" : "bg-border-strong",
            )}
          >
            <span
              className={cn(
                "pointer-events-none inline-block h-5 w-5 transform rounded-full bg-white shadow-sm transition-transform mt-0.5",
                settings.notificationSoundEnabled ? "translate-x-[22px]" : "translate-x-0.5",
              )}
            />
          </button>
        </div>
      </div>

      {/* Workspace Open Mode */}
      <div className="rounded-lg bg-card border border-border-subtle p-4 flex flex-col gap-3">
        <div className="flex items-center gap-3">
          <div className="flex items-center justify-center w-9 h-9 rounded-lg" style={{ backgroundColor: "color-mix(in srgb, var(--color-accent-purple) 15%, var(--color-card))" }}>
            <FolderOpen size={16} className="text-accent-purple" />
          </div>
          <div className="flex flex-col gap-0.5 flex-1">
            <span className="text-[14px] font-semibold text-foreground">{t("settings.general.workspaceOpenMode")}</span>
            <span className="text-[12px] text-text-tertiary">
              {t("settings.general.workspaceOpenModeDescription")}
            </span>
          </div>
          <select
            value={settings.workspaceOpenMode}
            onChange={(e) => settings.setWorkspaceOpenMode(e.target.value as "ask" | "current" | "new")}
            className="bg-surface border border-border-subtle rounded-md px-3 py-1.5 text-[13px] text-foreground outline-none focus:border-accent-purple transition-colors cursor-pointer"
          >
            <option value="ask">{t("settings.general.workspaceOpenModeAsk")}</option>
            <option value="current">{t("settings.general.workspaceOpenModeCurrent")}</option>
            <option value="new">{t("settings.general.workspaceOpenModeNew")}</option>
          </select>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// AI Outputs Directory card — chooses where AI-generated images are saved.
// Empty value = use the platform default (`<app_data_dir>/outputs`), which we
// fetch lazily for display so the user can see what the actual path is.
// ---------------------------------------------------------------------------

function OutputsDirCard() {
  const { t } = useTranslation();
  const outputsDir = useSettingsStore((s) => s.outputsDir);
  const setOutputsDir = useSettingsStore((s) => s.setOutputsDir);
  const [defaultDir, setDefaultDir] = useState<string>("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>("");

  useEffect(() => {
    let cancelled = false;
    invoke<string>("get_default_outputs_dir")
      .then((p) => {
        if (!cancelled) setDefaultDir(p);
      })
      .catch(() => {
        // Non-fatal — UI will just show the user-set path or "(default)" only.
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const handlePick = useCallback(async () => {
    setError("");
    setBusy(true);
    try {
      const picked = await invoke<string | null>("pick_outputs_dir");
      if (picked) setOutputsDir(picked);
    } catch (err) {
      setError(formatError(err));
    } finally {
      setBusy(false);
    }
  }, [setOutputsDir]);

  const handleReset = useCallback(() => {
    setOutputsDir("");
    setError("");
  }, [setOutputsDir]);

  const isDefault = !outputsDir;
  const effective = outputsDir || defaultDir;

  return (
    <div className="rounded-lg bg-card border border-border-subtle p-4 flex flex-col gap-3">
      <div className="flex items-center gap-3">
        <div
          className="flex items-center justify-center w-9 h-9 rounded-lg"
          style={{
            backgroundColor:
              "color-mix(in srgb, var(--color-accent-purple) 15%, var(--color-card))",
          }}
        >
          <ImageIcon size={16} className="text-accent-purple" />
        </div>
        <div className="flex flex-col gap-0.5 flex-1">
          <span className="text-[14px] font-semibold text-foreground">
            {t("settings.general.outputsDir")}
          </span>
          <span className="text-[12px] text-text-tertiary">
            {t("settings.general.outputsDirDescription")}
          </span>
        </div>
      </div>

      <div className="flex items-center gap-2 h-10 rounded-md bg-surface-alt border border-border-strong px-3.5 ml-12">
        <FolderOpen size={14} className="text-text-tertiary shrink-0" />
        <span
          className="flex-1 text-[12px] font-mono text-foreground truncate"
          title={effective}
        >
          {effective || t("settings.general.outputsDirLoading")}
        </span>
        {isDefault && (
          <span className="text-[10px] font-medium text-text-tertiary px-1.5 py-0.5 rounded bg-surface border border-border-subtle">
            {t("settings.general.outputsDirDefaultBadge")}
          </span>
        )}
      </div>

      <div className="flex items-center gap-2 ml-12">
        <button
          onClick={handlePick}
          disabled={busy}
          className="flex items-center gap-1.5 px-3.5 py-2 rounded-md border border-border-strong text-[12px] font-medium text-foreground hover:bg-border-subtle disabled:opacity-40 transition-colors"
        >
          <FolderOpen size={14} className="text-accent-purple" />
          {busy
            ? t("settings.general.outputsDirPicking")
            : t("settings.general.outputsDirChoose")}
        </button>
        {!isDefault && (
          <button
            onClick={handleReset}
            disabled={busy}
            className="flex items-center gap-1.5 px-3.5 py-2 rounded-md border border-border-subtle text-[12px] font-medium text-text-tertiary hover:bg-border-subtle disabled:opacity-40 transition-colors"
          >
            <RotateCcw size={14} />
            {t("settings.general.outputsDirReset")}
          </button>
        )}
        {error && (
          <div className="flex items-center gap-1.5 min-w-0">
            <CircleX size={14} className="text-red-400 shrink-0" />
            <span className="text-[11px] font-mono text-red-400 truncate">
              {error}
            </span>
          </div>
        )}
      </div>
    </div>
  );
}
