import { useState, useCallback, type KeyboardEvent } from "react";
import { usePreviewStore } from "@/stores";
import {
  RefreshCw,
  Monitor,
  Tablet,
  Smartphone,
  MousePointerClick,
  FolderTree,
  ExternalLink,
  Globe,
  CloudUpload,
  X,
} from "lucide-react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { useTranslation } from "react-i18next";
import type { DeviceMode } from "@/stores/preview-store";
import { DeployDialog } from "./deploy-dialog";

interface PreviewToolbarProps {
  readonly onRefresh: () => void;
  readonly onNavigate: (url: string) => void;
  readonly inspectorActive?: boolean;
  readonly onToggleInspector?: () => void;
  readonly fileTreeVisible?: boolean;
  readonly onToggleFileTree?: () => void;
  readonly onClose?: () => void;
}

export function PreviewToolbar({
  onRefresh,
  onNavigate,
  inspectorActive = false,
  onToggleInspector,
  fileTreeVisible = false,
  onToggleFileTree,
  onClose,
}: PreviewToolbarProps) {
  const { t } = useTranslation();
  const { previewUrl, deviceMode, setDeviceMode, devServerStatus, projectPath, projectName } =
    usePreviewStore();

  const [urlInput, setUrlInput] = useState(previewUrl);
  const [isEditing, setIsEditing] = useState(false);
  const [deployOpen, setDeployOpen] = useState(false);

  const toolbarBg = "var(--color-surface-alt)";
  const toolbarBorder = "var(--color-border)";
  const controlBg = "var(--color-surface)";
  const controlBorder = "var(--color-border)";
  const accentBg = "color-mix(in srgb, var(--color-accent-purple) 12%, transparent)";
  const accentBorder = "color-mix(in srgb, var(--color-accent-purple) 28%, transparent)";
  const accentText = "var(--color-accent-purple)";
  const mutedText = "var(--color-muted)";
  const foregroundText = "var(--color-foreground)";
  const subtext = "var(--color-muted-foreground)";

  const devices: { mode: DeviceMode; icon: React.ReactNode; label: string }[] = [
    { mode: "desktop", icon: <Monitor size={14} />, label: "Desktop" },
    { mode: "tablet", icon: <Tablet size={14} />, label: "Tablet" },
    { mode: "mobile", icon: <Smartphone size={14} />, label: "Mobile" },
  ];

  const isRunning = devServerStatus === "running";

  const handleUrlFocus = useCallback(() => {
    setIsEditing(true);
    setUrlInput(previewUrl);
  }, [previewUrl]);

  const handleUrlBlur = useCallback(() => {
    setIsEditing(false);
  }, []);

  const handleUrlKeyDown = useCallback(
    (e: KeyboardEvent<HTMLInputElement>) => {
      if (e.key === "Enter") {
        e.currentTarget.blur();
        const trimmed = urlInput.trim();
        if (trimmed) {
          const url = trimmed.startsWith("http") ? trimmed : `http://${trimmed}`;
          onNavigate(url);
        }
      } else if (e.key === "Escape") {
        setUrlInput(previewUrl);
        e.currentTarget.blur();
      }
    },
    [urlInput, previewUrl, onNavigate],
  );

  const handleOpenExternal = useCallback(() => {
    openUrl(previewUrl).catch(() => {
      // Fallback: noop if opener plugin fails
    });
  }, [previewUrl]);

  return (
    <div
      className="flex items-center shrink-0 overflow-x-auto scrollbar-none"
      style={{
        height: 40,
        padding: "0 12px",
        gap: 8,
        backgroundColor: toolbarBg,
        borderBottom: `1px solid ${toolbarBorder}`,
      }}
    >
      {/* Inspector toggle */}
      <button
        onClick={onToggleInspector}
        disabled={!isRunning}
        className="flex items-center justify-center shrink-0 disabled:opacity-40 cursor-pointer"
        style={{
          width: 32,
          height: 28,
          borderRadius: 6,
          backgroundColor: inspectorActive ? accentBg : "transparent",
          border: inspectorActive ? `1px solid ${accentBorder}` : "1px solid transparent",
          color: inspectorActive ? accentText : mutedText,
          transition: "all 150ms ease",
        }}
        title={inspectorActive ? "Exit Inspector" : "Inspect Element"}
      >
        <MousePointerClick size={16} />
      </button>

      {/* File tree toggle */}
      <button
        onClick={onToggleFileTree}
        disabled={!isRunning}
        className="flex items-center justify-center shrink-0 disabled:opacity-40 cursor-pointer"
        style={{
          width: 28,
          height: 28,
          borderRadius: 6,
          backgroundColor: fileTreeVisible ? accentBg : "transparent",
          border: fileTreeVisible ? `1px solid ${accentBorder}` : "1px solid transparent",
          color: fileTreeVisible ? accentText : mutedText,
          transition: "all 150ms ease",
        }}
        title={fileTreeVisible ? "Hide Files" : "Show Files"}
      >
        <FolderTree size={14} />
      </button>

      {/* URL bar */}
      <div
        className="flex items-center flex-1 min-w-0"
        style={{
          height: 28,
          borderRadius: 6,
          backgroundColor: controlBg,
          border: isEditing ? `1px solid ${accentText}` : `1px solid ${controlBorder}`,
          padding: "0 10px",
          gap: 6,
          boxShadow: isEditing
            ? "0 0 0 3px color-mix(in srgb, var(--color-accent-purple) 12%, transparent)"
            : "none",
          transition: "border-color 150ms ease, box-shadow 150ms ease",
        }}
      >
        <Globe size={14} style={{ color: subtext, flexShrink: 0 }} />
        <input
          type="text"
          value={isEditing ? urlInput : previewUrl}
          onChange={(e) => setUrlInput(e.target.value)}
          onFocus={handleUrlFocus}
          onBlur={handleUrlBlur}
          onKeyDown={handleUrlKeyDown}
          disabled={!isRunning}
          className="flex-1 min-w-0 bg-transparent outline-none truncate disabled:opacity-40"
          style={{
            color: foregroundText,
            fontFamily: "'JetBrains Mono', monospace",
            fontSize: 12,
            border: "none",
            padding: 0,
          }}
          title="Enter URL and press Enter to navigate"
        />
      </div>

      {/* Refresh */}
      <button
        onClick={onRefresh}
        disabled={!isRunning}
        className="flex items-center justify-center shrink-0 disabled:opacity-40 cursor-pointer"
        style={{
          width: 28,
          height: 28,
          borderRadius: 6,
          color: mutedText,
          transition: "color 150ms ease",
        }}
        title="Refresh"
      >
        <RefreshCw size={14} />
      </button>

      {/* Responsive controls */}
      <div
        className="flex items-center shrink-0"
        style={{
          height: 28,
          borderRadius: 6,
          backgroundColor: controlBg,
          border: `1px solid ${controlBorder}`,
          padding: "0 4px",
          gap: 2,
        }}
      >
        {devices.map(({ mode, icon, label }) => (
          <button
            key={mode}
            onClick={() => setDeviceMode(mode)}
            className="flex items-center justify-center cursor-pointer"
            style={{
              width: 28,
              height: 24,
              borderRadius: 4,
              backgroundColor: deviceMode === mode ? accentBg : "transparent",
              color: deviceMode === mode ? accentText : mutedText,
              transition: "all 150ms ease",
            }}
            title={label}
          >
            {icon}
          </button>
        ))}
      </div>

      {/* Publish through the user's self-hosted Worker */}
      <button
        onClick={() => setDeployOpen(true)}
        disabled={!isRunning || !projectPath}
        className="flex items-center justify-center shrink-0 disabled:opacity-40 cursor-pointer"
        style={{
          width: 28,
          height: 28,
          borderRadius: 6,
          color: "#F59E0B",
          backgroundColor: "color-mix(in srgb, #F59E0B 9%, transparent)",
          border: "1px solid color-mix(in srgb, #F59E0B 20%, transparent)",
          transition: "all 150ms ease",
        }}
        title={t("previewDeploy.toolbar")}
      >
        <CloudUpload size={14} />
      </button>

      {/* External link */}
      <button
        onClick={handleOpenExternal}
        disabled={!isRunning}
        className="flex items-center justify-center shrink-0 disabled:opacity-40 cursor-pointer"
        style={{
          width: 28,
          height: 28,
          borderRadius: 6,
          color: mutedText,
          transition: "color 150ms ease",
        }}
        title="Open in Browser"
      >
        <ExternalLink size={14} />
      </button>

      {/* Close preview */}
      {onClose && (
        <button
          onClick={onClose}
          className="flex items-center justify-center shrink-0 cursor-pointer"
          style={{
            width: 28,
            height: 28,
            borderRadius: 6,
            color: mutedText,
            transition: "color 150ms ease",
          }}
          title="Close Preview"
        >
          <X size={14} />
        </button>
      )}

      <DeployDialog
        open={deployOpen}
        projectName={projectName}
        projectPath={projectPath}
        onClose={() => setDeployOpen(false)}
      />
    </div>
  );
}
