import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { invoke } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";
import {
  Search,
  Download,
  Trash2,
  RefreshCw,
  ChevronDown,
  ChevronRight,
  AlertTriangle,
  Check,
  Loader2,
  HardDrive,
  Cloud,
  Play,
  Square,
  Link,
  Zap,
  CircleCheck,
  CircleX,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { formatError } from "@/lib/format-error";
import { isRetiredGptModel } from "@/lib/model-retirement";
import {
  PLATFORM_REGISTRY,
  getEffectiveSdk,
  getChannelDefaultUrl,
  getTestCommandForSdk,
  type PlatformId,
  type PlatformConfig,
  type SdkType,
} from "@/lib/platform-config";
import { useOllamaStore, type OllamaCloudModel } from "@/stores/ollama-store";

// ---------------------------------------------------------------------------
// Context length slider constants
// ---------------------------------------------------------------------------

const CTX_STEPS = [4096, 8192, 16384, 32768, 65536, 131072, 262144] as const;
const CTX_LABELS = ["4k", "8k", "16k", "32k", "64k", "128k", "256k"] as const;

function ctxValueToIndex(value: number): number {
  const idx = CTX_STEPS.indexOf(value as (typeof CTX_STEPS)[number]);
  return idx >= 0 ? idx : 3; // default to 32k
}

function ctxIndexToValue(index: number): number {
  return CTX_STEPS[index] ?? 32768;
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface OllamaPanelProps {
  readonly draftPlatforms: Record<PlatformId, PlatformConfig>;
  readonly updateDraftPlatform: (
    platformId: PlatformId,
    updater: (prev: PlatformConfig) => PlatformConfig,
  ) => void;
  readonly effectiveProxy: string | undefined;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatBytes(bytes: number): string {
  if (bytes === 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  const val = bytes / Math.pow(1024, i);
  return `${val.toFixed(i > 1 ? 1 : 0)} ${units[i]}`;
}

function formatPullCount(count: number | null): string {
  if (count === null || count === undefined) return "";
  if (count >= 1_000_000) return `${(count / 1_000_000).toFixed(1)}M`;
  if (count >= 1_000) return `${(count / 1_000).toFixed(1)}K`;
  return String(count);
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function OllamaPanel({
  draftPlatforms,
  updateDraftPlatform,
  effectiveProxy,
}: OllamaPanelProps) {
  const { t } = useTranslation();
  const meta = PLATFORM_REGISTRY.ollama;
  const config = draftPlatforms.ollama;
  const activeProfile = config.profiles.find((p) => p.id === config.activeProfileId) ?? config.profiles[0];

  const {
    phase,
    status,
    error,
    localModels,
    localModelsLoading,
    cloudModels,
    cloudSearchQuery,
    cloudSearchLoading,
    pullPhase,
    pullProgress,
    pullingModel,
    pullError,
    registryMirror,
    numCtx,
    serviceLoading,
    checkStatus,
    startService,
    stopService,
    fetchLocalModels,
    searchCloudModels,
    pullModel,
    deleteModel,
    getRegistryMirror,
    setNumCtx,
  } = useOllamaStore();

  // Expanded tags state (local, not in store)
  const [expandedModels, setExpandedModels] = useState<Set<string>>(new Set());
  const [deleteConfirm, setDeleteConfirm] = useState<string | null>(null);
  const [searchInput, setSearchInput] = useState("");
  const [activeTab, setActiveTab] = useState<"local" | "cloud">("local");
  const [testState, setTestState] = useState<{ status: "idle" | "testing" | "success" | "error"; message: string }>({ status: "idle", message: "" });

  // Auto-detect Ollama on mount + load mirror config
  useEffect(() => {
    checkStatus();
    getRegistryMirror();
  }, [checkStatus, getRegistryMirror]);

  // Auto-fetch local models when ready
  useEffect(() => {
    if (phase === "ready") {
      fetchLocalModels(activeProfile?.baseUrl);
    }
  }, [phase, fetchLocalModels, activeProfile?.baseUrl]);

  // Debounced cloud search
  useEffect(() => {
    if (activeTab !== "cloud") return;
    const timer = setTimeout(() => {
      searchCloudModels(searchInput, effectiveProxy, registryMirror || undefined);
    }, 300);
    return () => clearTimeout(timer);
  }, [searchInput, activeTab, searchCloudModels, effectiveProxy, registryMirror]);

  const toggleExpand = useCallback((modelName: string) => {
    setExpandedModels((prev) => {
      const next = new Set(prev);
      if (next.has(modelName)) next.delete(modelName);
      else next.add(modelName);
      return next;
    });
  }, []);

  const handleUseModel = useCallback(
    (modelId: string) => {
      if (isRetiredGptModel(modelId)) return;
      updateDraftPlatform("ollama", (prev) => ({ ...prev, activeModelId: modelId }));
    },
    [updateDraftPlatform],
  );

  const handleDelete = useCallback(
    async (modelName: string) => {
      await deleteModel(modelName, activeProfile?.baseUrl);
      setDeleteConfirm(null);
    },
    [deleteModel, activeProfile?.baseUrl],
  );

  const handlePull = useCallback(
    (model: string) => {
      if (isRetiredGptModel(model)) return;
      pullModel(model, activeProfile?.baseUrl);
    },
    [pullModel, activeProfile?.baseUrl],
  );

  const handleTestConnection = useCallback(async () => {
    if (!activeProfile) return;
    setTestState({ status: "testing", message: "" });
    try {
      const testCommand = getTestCommandForSdk(getEffectiveSdk(config));
      const result = await invoke<{ success: boolean; message: string; elapsed_ms: number }>(testCommand, {
        baseUrl: (activeProfile.baseUrl || "").trim() || undefined,
        apiKey: (activeProfile.apiKey || "ollama").trim(),
        model: config.activeModelId,
        proxyUrl: effectiveProxy,
        platform: "ollama",
      });
      if (result.success) {
        setTestState({ status: "success", message: `Connected (${result.elapsed_ms}ms)` });
        updateDraftPlatform("ollama", (prev) => ({
          ...prev,
          profiles: prev.profiles.map((p) =>
            p.id === activeProfile.id ? { ...p, testPassed: true } : p,
          ),
        }));
      } else {
        setTestState({ status: "error", message: result.message });
      }
    } catch (err) {
      setTestState({ status: "error", message: `Failed: ${formatError(err)}` });
    }
  }, [config, activeProfile, effectiveProxy, updateDraftPlatform]);

  // Local models that are installed (just names for quick lookup)
  const availableLocalModels = useMemo(
    () => localModels.filter((model) => !isRetiredGptModel(model.name)),
    [localModels],
  );
  const availableCloudModels = useMemo(
    () => cloudModels.filter((model) => !isRetiredGptModel(model.name)),
    [cloudModels],
  );
  const installedNames = useMemo(
    () => new Set(availableLocalModels.map((model) => model.name)),
    [availableLocalModels],
  );

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  return (
    <div className="flex flex-col gap-4">
      {/* Header */}
      <div className="flex items-center gap-3">
        <div
          className="flex items-center justify-center w-10 h-10 rounded-[10px] shrink-0 overflow-hidden"
          style={{ backgroundColor: "color-mix(in srgb, #FFFFFF 12%, var(--color-surface))" }}
        >
          <span className="text-[18px] font-bold font-sans" style={{ color: meta.color }}>O</span>
        </div>
        <div className="flex flex-col gap-0.5 flex-1 min-w-0">
          <span className="text-[15px] font-semibold text-foreground font-sans">Ollama</span>
          <span className="text-[12px] text-muted font-sans">
            {status?.version ? t("settings.models.ollama.version", { version: status.version }) : t("settings.models.ollama.localModels")}
          </span>
        </div>
        {/* Stop service button */}
        {phase === "ready" && (
          <button
            onClick={stopService}
            disabled={serviceLoading}
            className="text-[11px] px-2.5 py-1 rounded-full font-sans font-medium flex items-center gap-1.5 transition-colors hover:opacity-80"
            style={{ backgroundColor: "color-mix(in srgb, #EF4444 15%, transparent)", color: "#EF4444" }}
          >
            {serviceLoading ? (
              <Loader2 className="w-3 h-3 animate-spin" />
            ) : (
              <Square className="w-2.5 h-2.5 fill-current" />
            )}
            {serviceLoading ? t("settings.models.ollama.stoppingService") : t("settings.models.ollama.stopService")}
          </button>
        )}
        {phase === "not-running" && (
          <span className="text-[11px] px-2 py-0.5 rounded-full font-sans" style={{ backgroundColor: "color-mix(in srgb, var(--color-accent-amber) 20%, transparent)", color: "var(--color-accent-amber)" }}>
            {t("settings.models.ollama.statusStopped")}
          </span>
        )}
        {phase === "not-installed" && (
          <span className="text-[11px] px-2 py-0.5 rounded-full font-sans" style={{ backgroundColor: "color-mix(in srgb, var(--color-error, #ef4444) 20%, transparent)", color: "var(--color-error, #ef4444)" }}>
            {t("settings.models.ollama.statusNotInstalled")}
          </span>
        )}
      </div>

      {/* ─── Context Length Slider ─── */}
      <div className="flex flex-col gap-2 px-1">
        <div className="flex items-center gap-2">
          <span className="text-[13px] font-medium text-foreground font-sans">
            {t("settings.models.ollama.contextLength")}
          </span>
        </div>
        <span className="text-[11px] text-muted font-sans leading-relaxed">
          {t("settings.models.ollama.contextLengthHint")}
        </span>
        <div className="flex flex-col gap-1.5 mt-0.5">
          <input
            type="range"
            min={0}
            max={CTX_STEPS.length - 1}
            step={1}
            value={ctxValueToIndex(numCtx)}
            onChange={(e) => setNumCtx(ctxIndexToValue(Number(e.target.value)))}
            className="w-full h-1.5 rounded-full appearance-none cursor-pointer"
            style={{
              background: `linear-gradient(to right, var(--color-accent-purple) ${(ctxValueToIndex(numCtx) / (CTX_STEPS.length - 1)) * 100}%, var(--color-border) ${(ctxValueToIndex(numCtx) / (CTX_STEPS.length - 1)) * 100}%)`,
              accentColor: "var(--color-accent-purple)",
            }}
          />
          <div className="flex justify-between px-0.5">
            {CTX_LABELS.map((label, i) => (
              <span
                key={label}
                className="text-[11px] font-mono cursor-pointer select-none"
                style={{ color: ctxValueToIndex(numCtx) === i ? "var(--color-foreground)" : "var(--color-muted)" }}
                onClick={() => setNumCtx(ctxIndexToValue(i))}
              >
                {label}
              </span>
            ))}
          </div>
        </div>
      </div>

      {/* ─── SDK Channel Selector ─── */}
      <div className="flex flex-col gap-2 px-1">
        <span className="text-[13px] font-medium text-foreground font-sans">
          {t("settings.models.sdkChannel")}
        </span>
        <div className="flex flex-wrap gap-1.5">
          {(["claude", "chatcmpl"] as SdkType[]).map((sdk) => {
            const isActive = getEffectiveSdk(config) === sdk;
            const isNative = meta.sdk === sdk;
            const label = sdk === "chatcmpl" ? "ChatCmpl (OpenAI)" : "Claude";
            return (
              <button
                key={sdk}
                onClick={() => {
                  if (isActive) return;
                  updateDraftPlatform("ollama", (prev) => {
                    const currentSdk = getEffectiveSdk(prev);
                    const prof = prev.profiles.find((p) => p.id === prev.activeProfileId);
                    const currentUrl = prof?.baseUrl ?? "";
                    const savedUrls = { ...prev.channelUrls, [currentSdk]: currentUrl };
                    const targetUrl = savedUrls[sdk] ?? getChannelDefaultUrl("ollama", sdk);
                    return {
                      ...prev,
                      sdkOverride: sdk === prev.sdk ? undefined : sdk,
                      channelUrls: savedUrls,
                      profiles: prev.profiles.map((p) =>
                        p.id === prev.activeProfileId ? { ...p, baseUrl: targetUrl } : p,
                      ),
                    };
                  });
                  setTestState({ status: "idle", message: "" });
                }}
                className={cn(
                  "px-2.5 py-1 rounded text-[11px] font-medium font-sans transition-colors",
                  isActive ? "text-foreground" : "text-muted hover:text-foreground hover:bg-border",
                )}
                style={
                  isActive
                    ? {
                        backgroundColor: "color-mix(in srgb, #FFFFFF 15%, var(--color-surface))",
                        border: "1px solid #FFFFFF40",
                      }
                    : { border: "1px solid var(--color-border-strong)" }
                }
              >
                {label}
                {isNative ? ` (${t("settings.models.sdkNative")})` : ""}
              </button>
            );
          })}
        </div>
        <span className="text-[11px] text-border-strong font-sans">
          {t("settings.models.sdkChannelHint")}
        </span>
        {getEffectiveSdk(config) === "claude" && (
          <div
            className="flex items-start gap-2 rounded-md px-3 py-2"
            style={{
              backgroundColor: "color-mix(in srgb, var(--color-accent-info) 10%, var(--color-surface))",
              border: "1px solid color-mix(in srgb, var(--color-accent-info) 30%, transparent)",
            }}
          >
            <span style={{ color: "var(--color-accent-info)", fontSize: 14, lineHeight: "18px", flexShrink: 0 }}>ℹ</span>
            <span className="text-[11px] font-sans" style={{ color: "var(--color-accent-info)" }}>
              {t("settings.models.ollama.claudeChannelHint")}
            </span>
          </div>
        )}
      </div>

      {/* ─── Base URL ─── */}
      <div className="flex flex-col gap-2 px-1">
        <span className="text-[13px] font-medium text-foreground font-sans">
          {t("settings.models.baseUrl")}
        </span>
        <div
          className="flex items-center gap-2 h-10 rounded-md px-3.5"
          style={{ backgroundColor: "var(--color-surface-alt)", border: "1px solid var(--color-border-strong)" }}
        >
          <Link size={14} style={{ color: "var(--color-border-strong)" }} className="shrink-0" />
          <input
            type="text"
            value={activeProfile?.baseUrl ?? ""}
            onChange={(e) =>
              updateDraftPlatform("ollama", (prev) => ({
                ...prev,
                profiles: prev.profiles.map((p) =>
                  p.id === prev.activeProfileId ? { ...p, baseUrl: e.target.value } : p,
                ),
              }))
            }
            placeholder={getChannelDefaultUrl("ollama", getEffectiveSdk(config))}
            className="flex-1 bg-transparent text-[12px] text-foreground font-mono outline-none placeholder:text-border-strong min-w-0"
          />
        </div>
      </div>

      {/* ─── Connection Test ─── */}
      <div className="flex flex-col gap-2 px-1">
        <div className="flex items-center justify-between">
          <button
            onClick={handleTestConnection}
            disabled={testState.status === "testing"}
            className="flex items-center gap-1.5 px-3.5 py-2 rounded-md text-[12px] font-medium text-foreground hover:bg-border disabled:opacity-40 transition-colors"
            style={{ border: "1px solid var(--color-border-strong)" }}
          >
            <Zap size={14} style={{ color: meta.color }} />
            {testState.status === "testing" ? t("settings.models.testing") : t("settings.models.testConnection")}
          </button>
          {testState.status === "success" && (
            <div className="flex items-center gap-1.5">
              <CircleCheck size={14} className="text-[#10B981]" />
              <span className="text-[11px] font-mono text-[#10B981]">
                {testState.message || t("settings.models.connected")}
              </span>
            </div>
          )}
        </div>
        {testState.status === "error" && (
          <div
            className="flex items-start gap-1.5 rounded-md px-3 py-2"
            style={{ backgroundColor: "color-mix(in srgb, #EF4444 8%, var(--color-card))" }}
          >
            <CircleX size={14} className="text-red-400 shrink-0 mt-px" />
            <span className="text-[11px] font-mono text-red-400 break-words whitespace-pre-wrap">
              {testState.message}
            </span>
          </div>
        )}
      </div>

      <div className="h-px w-full" style={{ backgroundColor: "var(--color-border-subtle)" }} />

      {/* ─── Detecting ─── */}
      {(phase === "idle" || phase === "checking") && (
        <div className="flex items-center gap-3 py-8 justify-center text-muted">
          <Loader2 className="w-5 h-5 animate-spin" />
          <span className="text-[13px] font-sans">{t("settings.models.ollama.detecting")}</span>
        </div>
      )}

      {/* ─── Error ─── */}
      {phase === "error" && (
        <div className="flex flex-col items-center gap-3 py-8">
          <AlertTriangle className="w-8 h-8 text-red-400" />
          <span className="text-[13px] text-muted font-sans">
            {t("settings.models.ollama.detectError", { error })}
          </span>
          <button
            onClick={checkStatus}
            className="px-4 py-1.5 text-[13px] rounded-md font-sans"
            style={{ backgroundColor: "var(--color-accent-purple)", color: "white" }}
          >
            {t("settings.models.ollama.retryDetect")}
          </button>
        </div>
      )}

      {/* ─── Not Installed ─── */}
      {phase === "not-installed" && (
        <div className="flex flex-col items-center gap-4 py-8 px-6 rounded-lg" style={{ backgroundColor: "var(--color-card)" }}>
          <div className="w-12 h-12 rounded-full flex items-center justify-center" style={{ backgroundColor: "color-mix(in srgb, var(--color-accent-amber) 15%, transparent)" }}>
            <AlertTriangle className="w-6 h-6" style={{ color: "var(--color-accent-amber)" }} />
          </div>
          <div className="text-center">
            <p className="text-[14px] font-medium text-foreground font-sans">{t("settings.models.ollama.notInstalled")}</p>
            <p className="text-[12px] text-muted font-sans mt-1">{t("settings.models.ollama.notInstalledHint")}</p>
          </div>
          <button
            onClick={() => openUrl("https://ollama.com").catch(() => {})}
            className="px-5 py-2 text-[13px] rounded-md font-sans font-medium transition-colors"
            style={{ backgroundColor: "var(--color-accent-purple)", color: "white" }}
          >
            {t("settings.models.ollama.installButton")}
          </button>
          <p className="text-[11px] text-muted font-sans">
            {t("settings.models.ollama.manualInstallHint")}
          </p>
        </div>
      )}

      {/* ─── Not Running ─── */}
      {phase === "not-running" && (
        <div className="flex flex-col items-center gap-4 py-8 px-6 rounded-lg" style={{ backgroundColor: "var(--color-card)" }}>
          <div className="w-12 h-12 rounded-full flex items-center justify-center" style={{ backgroundColor: "color-mix(in srgb, var(--color-accent-amber) 15%, transparent)" }}>
            <Play className="w-6 h-6" style={{ color: "var(--color-accent-amber)" }} />
          </div>
          <div className="text-center">
            <p className="text-[14px] font-medium text-foreground font-sans">{t("settings.models.ollama.notRunning")}</p>
            <p className="text-[12px] text-muted font-sans mt-1">{t("settings.models.ollama.notRunningHint")}</p>
          </div>
          <button
            onClick={startService}
            disabled={serviceLoading}
            className="flex items-center gap-2 px-5 py-2 text-[13px] rounded-md font-sans font-medium transition-colors"
            style={{ backgroundColor: "var(--color-accent-purple)", color: "white" }}
          >
            {serviceLoading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Play className="w-4 h-4" />}
            {serviceLoading ? t("settings.models.ollama.startingService") : t("settings.models.ollama.startService")}
          </button>
          <button
            onClick={checkStatus}
            className="px-4 py-1.5 text-[13px] rounded-md font-sans text-muted transition-colors hover:text-foreground"
            style={{ border: "1px solid var(--color-border)" }}
          >
            {t("settings.models.ollama.retryDetect")}
          </button>
        </div>
      )}

      {/* ─── Ready: Model Manager ─── */}
      {phase === "ready" && (
        <>
          {/* Tab switcher */}
          <div className="flex gap-1 p-1 rounded-lg" style={{ backgroundColor: "var(--color-background)" }}>
            <button
              onClick={() => setActiveTab("local")}
              className={cn(
                "flex-1 flex items-center justify-center gap-1.5 py-1.5 text-[13px] font-sans rounded-md transition-colors",
                activeTab === "local" ? "font-medium" : "text-muted",
              )}
              style={activeTab === "local" ? { backgroundColor: "var(--color-surface)", color: "var(--color-foreground)" } : undefined}
            >
              <HardDrive className="w-3.5 h-3.5" />
              {t("settings.models.ollama.localModels")}
              {localModels.length > 0 && (
                <span className="text-[11px] px-1.5 py-0.5 rounded-full" style={{ backgroundColor: "var(--color-background)" }}>
                  {localModels.length}
                </span>
              )}
            </button>
            <button
              onClick={() => setActiveTab("cloud")}
              className={cn(
                "flex-1 flex items-center justify-center gap-1.5 py-1.5 text-[13px] font-sans rounded-md transition-colors",
                activeTab === "cloud" ? "font-medium" : "text-muted",
              )}
              style={activeTab === "cloud" ? { backgroundColor: "var(--color-surface)", color: "var(--color-foreground)" } : undefined}
            >
              <Cloud className="w-3.5 h-3.5" />
              {t("settings.models.ollama.cloudModels")}
            </button>
          </div>

          {/* ─── Pull Progress Bar ─── */}
          {pullPhase === "pulling" && pullProgress && (
            <div className="flex flex-col gap-1.5 px-3 py-2.5 rounded-lg" style={{ backgroundColor: "var(--color-card)" }}>
              <div className="flex items-center justify-between">
                <span className="text-[12px] text-muted font-sans">
                  {t("settings.models.ollama.downloading", { model: pullingModel ?? pullProgress.model })}
                </span>
                <span className="text-[12px] font-mono text-foreground">
                  {pullProgress.percent != null ? `${pullProgress.percent.toFixed(1)}%` : ""}
                </span>
              </div>
              <div className="w-full h-1.5 rounded-full overflow-hidden" style={{ backgroundColor: "var(--color-background)" }}>
                <div
                  className="h-full rounded-full transition-all duration-300"
                  style={{
                    width: `${pullProgress.percent ?? 0}%`,
                    backgroundColor: "var(--color-accent-purple)",
                  }}
                />
              </div>
              <div className="flex items-center justify-between">
                <span className="text-[11px] text-muted font-sans">{pullProgress.status}</span>
                <span className="text-[11px] text-muted font-mono">
                  {pullProgress.completed != null && pullProgress.total != null
                    ? `${formatBytes(pullProgress.completed)} / ${formatBytes(pullProgress.total)}`
                    : ""}
                  {pullProgress.speed != null && pullProgress.speed > 0
                    ? ` · ${formatBytes(pullProgress.speed)}/s`
                    : ""}
                </span>
              </div>
            </div>
          )}

          {pullPhase === "failed" && pullError && (
            <div className="flex flex-col gap-1.5 px-3 py-2 rounded-lg" style={{ backgroundColor: "color-mix(in srgb, var(--color-error, #ef4444) 10%, var(--color-card))" }}>
              <div className="flex items-center gap-2">
                <AlertTriangle className="w-4 h-4 text-red-400 shrink-0" />
                <span className="text-[12px] text-red-400 font-sans">{t("settings.models.ollama.downloadFailed", { error: pullError })}</span>
              </div>
            </div>
          )}

          {/* ─── Local Models Tab ─── */}
          {activeTab === "local" && (
            <div className="flex flex-col gap-2">
              <div className="flex items-center justify-between">
                <span className="text-[13px] font-medium text-foreground font-sans">
                  {t("settings.models.ollama.localModels")}
                </span>
                <button
                  onClick={() => fetchLocalModels(activeProfile?.baseUrl)}
                  disabled={localModelsLoading}
                  className="p-1.5 rounded-md transition-colors hover:bg-surface"
                  title={t("settings.models.ollama.refreshModels")}
                >
                  <RefreshCw className={cn("w-3.5 h-3.5 text-muted", localModelsLoading && "animate-spin")} />
                </button>
              </div>

              {availableLocalModels.length === 0 && !localModelsLoading && (
                <p className="text-[12px] text-muted font-sans py-4 text-center">
                  {t("settings.models.ollama.noLocalModels")}
                </p>
              )}

              {localModelsLoading && (
                <div className="flex items-center justify-center gap-2 py-4">
                  <Loader2 className="w-4 h-4 animate-spin text-muted" />
                </div>
              )}

              <div className="flex flex-col gap-1">
                {availableLocalModels.map((model) => (
                  <div
                    key={model.name}
                    className="flex items-center gap-3 px-3 py-2 rounded-lg transition-colors hover:bg-surface group"
                    style={{ backgroundColor: config.activeModelId === model.name ? "var(--color-surface)" : undefined }}
                  >
                    <div className="flex-1 min-w-0">
                      <span className="text-[13px] font-sans text-foreground block truncate">{model.name}</span>
                      <span className="text-[11px] text-muted font-sans">{formatBytes(model.size)}</span>
                    </div>
                    <div className="flex items-center gap-1.5 opacity-0 group-hover:opacity-100 transition-opacity">
                      {config.activeModelId === model.name ? (
                        <span className="text-[11px] px-2 py-0.5 rounded font-sans" style={{ color: "var(--color-accent-green)" }}>
                          <Check className="w-3.5 h-3.5" />
                        </span>
                      ) : (
                        <button
                          onClick={() => handleUseModel(model.name)}
                          className="px-2 py-0.5 text-[11px] rounded font-sans transition-colors"
                          style={{ backgroundColor: "var(--color-accent-purple)", color: "white" }}
                        >
                          {t("settings.models.ollama.useModel")}
                        </button>
                      )}
                      {deleteConfirm === model.name ? (
                        <div className="flex items-center gap-1">
                          <button
                            onClick={() => handleDelete(model.name)}
                            className="px-2 py-0.5 text-[11px] rounded font-sans bg-red-500 text-white"
                          >
                            {t("settings.models.ollama.confirm")}
                          </button>
                          <button
                            onClick={() => setDeleteConfirm(null)}
                            className="px-2 py-0.5 text-[11px] rounded font-sans text-muted"
                          >
                            ✕
                          </button>
                        </div>
                      ) : (
                        <button
                          onClick={() => setDeleteConfirm(model.name)}
                          className="p-1 rounded transition-colors hover:bg-red-500/10"
                        >
                          <Trash2 className="w-3.5 h-3.5 text-muted hover:text-red-400" />
                        </button>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* ─── Cloud Models Tab ─── */}
          {activeTab === "cloud" && (
            <div className="flex flex-col gap-3">
              {/* Search */}
              <div className="relative">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted" />
                <input
                  type="text"
                  value={searchInput}
                  onChange={(e) => setSearchInput(e.target.value)}
                  placeholder={t("settings.models.ollama.searchModels")}
                  className="w-full pl-9 pr-3 py-2 text-[13px] rounded-lg border font-sans"
                  style={{
                    backgroundColor: "var(--color-background)",
                    borderColor: "var(--color-border)",
                    color: "var(--color-foreground)",
                  }}
                />
                {cloudSearchLoading && (
                  <Loader2 className="absolute right-3 top-1/2 -translate-y-1/2 w-4 h-4 animate-spin text-muted" />
                )}
              </div>

              {/* Results */}
              {availableCloudModels.length === 0 && !cloudSearchLoading && cloudSearchQuery && (
                <p className="text-[12px] text-muted font-sans py-4 text-center">
                  {t("settings.models.ollama.noResults")}
                </p>
              )}

              <div className="flex flex-col gap-1 max-h-[400px] overflow-y-auto">
                {availableCloudModels.map((model) => (
                  <CloudModelCard
                    key={model.name}
                    model={model}
                    expanded={expandedModels.has(model.name)}
                    installedNames={installedNames}
                    pullingModel={pullingModel}
                    onToggleExpand={() => toggleExpand(model.name)}
                    onPull={handlePull}
                    t={t}
                  />
                ))}
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Cloud Model Card sub-component
// ---------------------------------------------------------------------------

function CloudModelCard({
  model,
  expanded,
  installedNames,
  pullingModel,
  onToggleExpand,
  onPull,
  t,
}: {
  readonly model: OllamaCloudModel;
  readonly expanded: boolean;
  readonly installedNames: Set<string>;
  readonly pullingModel: string | null;
  readonly onToggleExpand: () => void;
  readonly onPull: (model: string) => void;
  readonly t: (key: string, opts?: Record<string, unknown>) => string;
}) {
  const isPulling = pullingModel !== null;

  return (
    <div className="rounded-lg transition-colors" style={{ backgroundColor: "var(--color-card)" }}>
      <button
        onClick={onToggleExpand}
        className="flex items-center gap-3 w-full px-3 py-2.5 text-left transition-colors hover:bg-surface rounded-lg"
      >
        {expanded ? (
          <ChevronDown className="w-3.5 h-3.5 text-muted shrink-0" />
        ) : (
          <ChevronRight className="w-3.5 h-3.5 text-muted shrink-0" />
        )}
        <div className="flex-1 min-w-0">
          <span className="text-[13px] font-sans font-medium text-foreground block truncate">{model.name}</span>
          {model.description && (
            <span className="text-[11px] text-muted font-sans line-clamp-1">{model.description}</span>
          )}
        </div>
        {model.pull_count != null && model.pull_count > 0 && (
          <span className="text-[11px] text-muted font-sans shrink-0">
            {t("settings.models.ollama.pulls", { count: formatPullCount(model.pull_count) })}
          </span>
        )}
      </button>

      {expanded && model.tags.length > 0 && (
        <div className="px-3 pb-2.5 pt-0 flex flex-wrap gap-1.5">
          {model.tags.map((tag) => {
            const fullName = `${model.name}:${tag}`;
            const isInstalled = installedNames.has(fullName);
            const isThisPulling = pullingModel === fullName;

            return (
              <button
                key={tag}
                onClick={() => {
                  if (!isInstalled && !isPulling) onPull(fullName);
                }}
                disabled={isInstalled || isPulling}
                className={cn(
                  "inline-flex items-center gap-1.5 px-2.5 py-1 text-[12px] rounded-md font-sans transition-colors",
                  isInstalled
                    ? "opacity-60 cursor-default"
                    : isPulling
                      ? "opacity-50 cursor-wait"
                      : "hover:opacity-80 cursor-pointer",
                )}
                style={{
                  backgroundColor: isInstalled
                    ? "color-mix(in srgb, var(--color-accent-green) 15%, var(--color-background))"
                    : "var(--color-background)",
                  color: isInstalled ? "var(--color-accent-green)" : "var(--color-foreground)",
                }}
              >
                {isThisPulling ? (
                  <Loader2 className="w-3 h-3 animate-spin" />
                ) : isInstalled ? (
                  <Check className="w-3 h-3" />
                ) : (
                  <Download className="w-3 h-3" />
                )}
                {tag}
              </button>
            );
          })}
        </div>
      )}

      {expanded && model.tags.length === 0 && (
        <p className="px-3 pb-2.5 text-[11px] text-muted font-sans">{t("settings.models.ollama.noTagsAvailable")}</p>
      )}
    </div>
  );
}
