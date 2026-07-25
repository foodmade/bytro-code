import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { invoke } from "@tauri-apps/api/core";
import {
  Search,
  Bot,
  Key,
  Link,
  EyeOff,
  Eye,
  Zap,
  CircleCheck,
  CircleX,
  ChevronDown,
  Plus,
  Trash2,
  Pencil,
  ShieldCheck,
  Network,
  Import,
  RefreshCw,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { formatError } from "@/lib/format-error";
import { useSettingsStore, useToastStore } from "@/stores";
import { flushSettingsPersistence } from "@/stores/settings-store";
import {
  USER_SELECTABLE_PLATFORM_IDS,
  USER_SELECTABLE_SDK_CHANNELS,
  PLATFORM_REGISTRY,
  DISABLED_PLATFORMS,
  getTestCommandForSdk,
  getEffectiveSdk,
  getChannelDefaultUrl,
  getDisplayModelsForPlatform,
  getCustomModelsForActiveProfile,
  createCustomModelEntry,
  isProfileConnectionHealthy,
  sanitizeProfileProxy,
  isProfileProxyConfigValid,
  buildProfileProxyUrl,
  type PlatformId,
  type PlatformConfig,
  type ProfileConfig,
  type AuthMode,
  type ProfileProxyConfig,
  type ProfileProxyMode,
} from "@/lib/platform-config";
import { groupModelsForPicker } from "@/lib/model-list-groups";
import { scanAndMergeLocalCredentials } from "@/lib/local-credential-import";
import type { ScannedCredential } from "@/lib/credential-merge";
import { useRemoteModels } from "@/hooks";
import { OllamaPanel } from "./ollama-panel";
import { OAuthPanel } from "./oauth-panel";
import { CodexOAuthPanel } from "./codex-oauth-panel";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface TestState {
  readonly status: "idle" | "testing" | "success" | "error";
  readonly message: string;
  readonly stages?: readonly ProxyTestStage[];
  readonly quality?: ProxyQualityInfo | null;
}

const IDLE_TEST: TestState = { status: "idle", message: "" };

interface ProxyTestStage {
  readonly id: "local" | "target" | string;
  readonly success: boolean;
  readonly message: string;
  readonly elapsed_ms: number;
}

interface ProxyQualityInfo {
  readonly ip: string;
  readonly quality_score?: number | null;
  readonly risk_score?: number | null;
  readonly risk_level: string;
  readonly provider?: string | null;
  readonly asn?: string | null;
  readonly isp_type?: string | null;
  readonly broadband_type?: string | null;
  readonly native_ip?: boolean | null;
  readonly country?: string | null;
  readonly region?: string | null;
  readonly city?: string | null;
  readonly isocode?: string | null;
  readonly proxy?: boolean | null;
  readonly proxy_type?: string | null;
}

interface TestResult {
  success: boolean;
  message: string;
  elapsed_ms: number;
  reply: string | null;
  stages?: ProxyTestStage[];
  quality?: ProxyQualityInfo | null;
}

export interface ModelsPanelProps {
  readonly open: boolean;
  readonly draftPlatforms: Record<PlatformId, PlatformConfig>;
  readonly updateDraftPlatform: (
    platformId: PlatformId,
    updater: (prev: PlatformConfig) => PlatformConfig,
  ) => void;
  readonly effectiveProxy?: string;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function ModelsPanel({
  open,
  draftPlatforms,
  updateDraftPlatform,
  effectiveProxy,
}: ModelsPanelProps) {
  const { t } = useTranslation();

  const [selectedView, setSelectedView] = useState<PlatformId>("claude");
  const [platformSearch, setPlatformSearch] = useState("");
  const [showModelDropdown, setShowModelDropdown] = useState(false);
  const modelDropdownBtnRef = useRef<HTMLButtonElement>(null);
  const [testStates, setTestStates] = useState<Record<string, TestState>>({});
  const [proxyTestStates, setProxyTestStates] = useState<Record<string, TestState>>({});
  const [selectedProxyQuality, setSelectedProxyQuality] = useState<ProxyQualityInfo | null>(null);
  const [showKey, setShowKey] = useState(false);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [customModelInput, setCustomModelInput] = useState("");
  const [credentialImporting, setCredentialImporting] = useState(false);

  const draftsRef = useRef(draftPlatforms);
  draftsRef.current = draftPlatforms;

  // Filter platforms by search
  const filteredPlatforms = useMemo(() => {
    if (!platformSearch.trim()) return USER_SELECTABLE_PLATFORM_IDS;
    const q = platformSearch.toLowerCase();
    return USER_SELECTABLE_PLATFORM_IDS.filter((id) => {
      const meta = PLATFORM_REGISTRY[id];
      return meta.displayName.toLowerCase().includes(q) || meta.subtitle.toLowerCase().includes(q);
    });
  }, [platformSearch]);

  const currentPlatformId = selectedView;
  const currentMeta = PLATFORM_REGISTRY[currentPlatformId] ?? PLATFORM_REGISTRY.claude;
  const currentConfig = draftPlatforms[currentPlatformId] ?? draftPlatforms.claude;
  const activeProfile =
    currentConfig.profiles.find((p) => p.id === currentConfig.activeProfileId) ??
    currentConfig.profiles[0];
  const activeProfileProxy = useMemo(
    () =>
      sanitizeProfileProxy(activeProfile?.proxy) ?? {
        enabled: false,
        mode: "http" as ProfileProxyMode,
        host: "",
        port: "",
        username: "",
        password: "",
      },
    [activeProfile?.proxy],
  );
  const effectiveSdk = getEffectiveSdk(currentConfig);
  const supportsAgentProxy = effectiveSdk === "claude" || effectiveSdk === "codex";
  const isAgentProxyValid = isProfileProxyConfigValid(activeProfileProxy);

  const codexOAuthSnapshot = useMemo(() => {
    if (currentPlatformId !== "codex" || activeProfile?.authMode !== "oauth") return null;
    if (
      !activeProfile.oauthAccountEmail &&
      !activeProfile.oauthPlan &&
      !activeProfile.oauthRateLimits
    )
      return null;
    return {
      email: activeProfile.oauthAccountEmail,
      planType: activeProfile.oauthPlan,
      rateLimits: activeProfile.oauthRateLimits,
    };
  }, [
    currentPlatformId,
    activeProfile?.authMode,
    activeProfile?.oauthAccountEmail,
    activeProfile?.oauthPlan,
    activeProfile?.oauthRateLimits,
  ]);

  const testKey = `${currentPlatformId}:${activeProfile?.id ?? ""}`;
  const currentTest = testStates[testKey] ?? IDLE_TEST;
  const proxyTestKey = `${testKey}:agent-proxy`;
  const currentProxyTest = proxyTestStates[proxyTestKey] ?? IDLE_TEST;
  const savedProfile = useSettingsStore((s) =>
    s.platforms[currentPlatformId]?.profiles.find(
      (profile) => profile.id === s.platforms[currentPlatformId]?.activeProfileId,
    ),
  );
  const savedAgentProxyUrl = buildProfileProxyUrl(savedProfile);
  const draftAgentProxyUrl = supportsAgentProxy ? buildProfileProxyUrl(activeProfile) : undefined;
  const oauthProxyUrl = currentPlatformId === "claude" ? draftAgentProxyUrl : effectiveProxy;
  const agentProxyHasUnsavedChanges = (savedAgentProxyUrl ?? "") !== (draftAgentProxyUrl ?? "");

  // Remote models support (for chatcmpl-based platforms)
  const supportsRemoteModels = currentMeta.sdk === "chatcmpl";

  // The /models listing endpoint lives under the OpenAI-compatible (chatcmpl) host.
  // When the user is on the Claude/Codex channel, activeProfile.baseUrl points at
  // /anthropic or similar — that path doesn't expose /models. Always resolve the
  // chatcmpl base URL for the model-list fetch so users see the full remote catalog
  // regardless of which channel they're currently configuring.
  const remoteListBaseUrl = useMemo(() => {
    if (!supportsRemoteModels) return "";
    const effectiveSdk = getEffectiveSdk(currentConfig);
    if (effectiveSdk === "chatcmpl") {
      return activeProfile?.baseUrl ?? getChannelDefaultUrl(currentPlatformId, "chatcmpl");
    }
    return (
      currentConfig.channelUrls?.chatcmpl ?? getChannelDefaultUrl(currentPlatformId, "chatcmpl")
    );
  }, [supportsRemoteModels, currentConfig, currentPlatformId, activeProfile?.baseUrl]);

  const remoteModelsEnabled =
    open && supportsRemoteModels && !!remoteListBaseUrl && !!activeProfile?.apiKey;
  const remoteModelsResult = useRemoteModels({
    provider: currentPlatformId,
    baseUrl: remoteListBaseUrl,
    apiKey: activeProfile?.apiKey ?? "",
    proxyUrl: effectiveProxy,
    enabled: remoteModelsEnabled,
  });

  const effectiveModels = useMemo(() => {
    const customModels = getCustomModelsForActiveProfile(currentConfig);
    if (supportsRemoteModels) {
      return getDisplayModelsForPlatform(
        currentPlatformId,
        remoteModelsResult.models,
        customModels,
      );
    }
    return getDisplayModelsForPlatform(currentPlatformId, undefined, customModels);
  }, [supportsRemoteModels, currentPlatformId, currentConfig, remoteModelsResult.models]);

  const customModels = useMemo(
    () => getCustomModelsForActiveProfile(currentConfig),
    [currentConfig],
  );
  const showCustomModels = currentPlatformId !== "ollama" && activeProfile?.authMode !== "oauth";

  const handleImportLocalCredentials = useCallback(async () => {
    if (credentialImporting) return;
    setCredentialImporting(true);
    try {
      const settings = useSettingsStore.getState();
      const result = await scanAndMergeLocalCredentials(
        settings.platforms,
        t("settings.models.scan.importedProfileName"),
        () => invoke<readonly ScannedCredential[]>("scan_local_credentials"),
      );
      if (result.importedCount === 0) {
        useToastStore.getState().addToast("info", t("settings.models.scan.noNewCredentials"));
        return;
      }

      settings.setPlatforms(result.platforms);
      await flushSettingsPersistence();
      for (const platformId of Object.keys(result.platforms) as PlatformId[]) {
        updateDraftPlatform(platformId, () => result.platforms[platformId]);
      }
      useToastStore
        .getState()
        .addToast("info", t("settings.models.scan.importedToast", { count: result.importedCount }));
    } catch (error) {
      useToastStore
        .getState()
        .addToast("error", t("settings.models.scan.failed", { error: formatError(error) }));
    } finally {
      setCredentialImporting(false);
    }
  }, [credentialImporting, t, updateDraftPlatform]);

  useEffect(() => {
    setCustomModelInput("");
  }, [currentPlatformId, activeProfile?.authMode]);

  // ---------------------------------------------------------------------------
  // Profile helpers
  // ---------------------------------------------------------------------------

  const updateActiveProfile = useCallback(
    (
      patch: Partial<
        Pick<
          ProfileConfig,
          | "name"
          | "baseUrl"
          | "apiKey"
          | "authMode"
          | "oauthAccountEmail"
          | "oauthPlan"
          | "oauthExpiresAt"
          | "oauthRateLimits"
          | "testPassed"
          | "proxy"
        >
      >,
    ) => {
      updateDraftPlatform(currentPlatformId, (prev) => ({
        ...prev,
        profiles: prev.profiles.map((p) =>
          p.id === prev.activeProfileId ? { ...p, ...patch } : p,
        ),
      }));
    },
    [currentPlatformId, updateDraftPlatform],
  );

  const updateActiveProxy = useCallback(
    (patch: Partial<ProfileProxyConfig>) => {
      setProxyTestStates((prev) => {
        if (!prev[proxyTestKey]) return prev;
        const { [proxyTestKey]: _removed, ...rest } = prev;
        return rest;
      });
      updateActiveProfile({
        proxy: {
          ...activeProfileProxy,
          ...patch,
        },
      });
    },
    [activeProfileProxy, proxyTestKey, updateActiveProfile],
  );

  const handleTestAgentProxy = useCallback(async () => {
    if (!activeProfile || !activeProfileProxy.enabled || !isAgentProxyValid) return;
    const proxyUrl = buildProfileProxyUrl({ ...activeProfile, proxy: activeProfileProxy });
    if (!proxyUrl) return;

    setProxyTestStates((prev) => ({
      ...prev,
      [proxyTestKey]: { status: "testing", message: "" },
    }));

    try {
      const result = await invoke<TestResult>("test_proxy", {
        proxyUrl,
        targetUrl:
          effectiveSdk === "codex" ? "https://api.openai.com" : "https://api.anthropic.com",
      });
      setProxyTestStates((prev) => ({
        ...prev,
        [proxyTestKey]: {
          status: result.success ? "success" : "error",
          message: result.message,
          stages: result.stages,
          quality: result.quality,
        },
      }));
    } catch (err) {
      setProxyTestStates((prev) => ({
        ...prev,
        [proxyTestKey]: {
          status: "error",
          message: `Failed: ${formatError(err)}`,
        },
      }));
    }
  }, [activeProfile, activeProfileProxy, effectiveSdk, isAgentProxyValid, proxyTestKey]);

  const getProxyStageLabel = useCallback(
    (stageId: string) => {
      if (stageId === "local") return t("settings.models.advanced.proxyStageLocal");
      return effectiveSdk === "codex"
        ? t("settings.models.advanced.proxyStageTargetCodex")
        : t("settings.models.advanced.proxyStageTargetClaude");
    },
    [effectiveSdk, t],
  );

  const getProxyStageStatusLabel = useCallback(
    (success: boolean) =>
      success
        ? t("settings.models.advanced.proxyStageOk")
        : t("settings.models.advanced.proxyStageFailed"),
    [t],
  );

  const getProxyQualityTone = useCallback((score: number | null | undefined) => {
    if (score == null) {
      return {
        color: "var(--color-text-tertiary)",
        backgroundColor: "var(--color-surface-alt)",
        borderColor: "var(--color-border-strong)",
      };
    }
    if (score >= 80) {
      return {
        color: "#10B981",
        backgroundColor: "rgba(16, 185, 129, 0.12)",
        borderColor: "rgba(16, 185, 129, 0.42)",
      };
    }
    if (score >= 60) {
      return {
        color: "#F59E0B",
        backgroundColor: "rgba(245, 158, 11, 0.12)",
        borderColor: "rgba(245, 158, 11, 0.42)",
      };
    }
    if (score >= 40) {
      return {
        color: "#F97316",
        backgroundColor: "rgba(249, 115, 22, 0.12)",
        borderColor: "rgba(249, 115, 22, 0.42)",
      };
    }
    return {
      color: "#EF4444",
      backgroundColor: "rgba(239, 68, 68, 0.12)",
      borderColor: "rgba(239, 68, 68, 0.42)",
    };
  }, []);

  const formatProxyLocation = useCallback(
    (quality: ProxyQualityInfo) =>
      [quality.city, quality.region, quality.country]
        .filter((part): part is string => typeof part === "string" && part.trim().length > 0)
        .join(" / ") || t("settings.models.advanced.qualityUnknown"),
    [t],
  );

  const setAuthMode = useCallback(
    (mode: AuthMode) => {
      const patch = { authMode: mode };
      updateDraftPlatform(currentPlatformId, (prev) => {
        const profiles = prev.profiles.map((p) =>
          p.id === prev.activeProfileId ? { ...p, ...patch } : p,
        );
        if (mode !== "oauth") {
          return { ...prev, profiles };
        }
        const baseModels = getDisplayModelsForPlatform(currentPlatformId);
        const activeModelId = baseModels.some((model) => model.id === prev.activeModelId)
          ? prev.activeModelId
          : (baseModels[0]?.id ?? PLATFORM_REGISTRY[currentPlatformId].defaultModel);
        return { ...prev, profiles, activeModelId };
      });
    },
    [currentPlatformId, updateDraftPlatform],
  );

  const commitOAuthToStore = useCallback(
    (
      profileId: string,
      patch: Partial<
        Pick<
          ProfileConfig,
          "authMode" | "oauthAccountEmail" | "oauthPlan" | "oauthExpiresAt" | "oauthRateLimits"
        >
      >,
    ) => {
      const { platforms, setPlatforms } = useSettingsStore.getState();
      const draftPlatform = draftsRef.current[currentPlatformId];
      if (!draftPlatform) return;
      const updatedProfiles = draftPlatform.profiles.map((p) =>
        p.id === profileId ? { ...p, ...patch } : p,
      );
      setPlatforms({
        ...platforms,
        [currentPlatformId]: {
          ...draftPlatform,
          activeProfileId: profileId,
          profiles: updatedProfiles,
        },
      });
    },
    [currentPlatformId],
  );

  const handleAddProfile = useCallback(() => {
    const newId = crypto.randomUUID();
    updateDraftPlatform(currentPlatformId, (prev) => ({
      ...prev,
      profiles: [
        ...prev.profiles,
        {
          id: newId,
          name: `Profile ${prev.profiles.length + 1}`,
          baseUrl: currentMeta.defaultBaseUrl,
          apiKey: "",
          testPassed: false,
        },
      ],
      activeProfileId: newId,
    }));
  }, [currentPlatformId, currentMeta.defaultBaseUrl, updateDraftPlatform]);

  const handleRemoveProfile = useCallback(
    (profileId: string) => {
      updateDraftPlatform(currentPlatformId, (prev) => {
        const remaining = prev.profiles.filter((p) => p.id !== profileId);
        if (remaining.length === 0) return prev;
        return {
          ...prev,
          profiles: remaining,
          activeProfileId:
            prev.activeProfileId === profileId ? remaining[0].id : prev.activeProfileId,
        };
      });
    },
    [currentPlatformId, updateDraftPlatform],
  );

  const handleSwitchProfile = useCallback(
    (profileId: string) => {
      updateDraftPlatform(currentPlatformId, (prev) => ({
        ...prev,
        activeProfileId: profileId,
      }));
    },
    [currentPlatformId, updateDraftPlatform],
  );

  const handleAddCustomModel = useCallback(() => {
    const entry = createCustomModelEntry(customModelInput);
    if (!entry || currentPlatformId === "ollama") return;
    updateDraftPlatform(currentPlatformId, (prev) => {
      const customModels = getCustomModelsForActiveProfile(prev);
      const displayModels = getDisplayModelsForPlatform(
        currentPlatformId,
        supportsRemoteModels ? remoteModelsResult.models : undefined,
        customModels,
      );
      const exists = displayModels.some((model) => model.id === entry.id);
      return {
        ...prev,
        activeModelId: entry.id,
        customModels: exists ? (prev.customModels ?? []) : [...(prev.customModels ?? []), entry],
      };
    });
    setCustomModelInput("");
    setShowModelDropdown(false);
  }, [
    currentPlatformId,
    customModelInput,
    remoteModelsResult.models,
    supportsRemoteModels,
    updateDraftPlatform,
  ]);

  const handleRemoveCustomModel = useCallback(
    (modelId: string) => {
      updateDraftPlatform(currentPlatformId, (prev) => {
        const nextCustomModels = (prev.customModels ?? []).filter((model) => model.id !== modelId);
        const nextModels = getDisplayModelsForPlatform(
          currentPlatformId,
          supportsRemoteModels ? remoteModelsResult.models : undefined,
          nextCustomModels,
        );
        const stillAvailable = nextModels.some((model) => model.id === prev.activeModelId);
        return {
          ...prev,
          customModels: nextCustomModels,
          activeModelId: stillAvailable
            ? prev.activeModelId
            : (nextModels[0]?.id ?? PLATFORM_REGISTRY[currentPlatformId].defaultModel),
        };
      });
    },
    [currentPlatformId, remoteModelsResult.models, supportsRemoteModels, updateDraftPlatform],
  );

  // ---------------------------------------------------------------------------
  // Test connection
  // ---------------------------------------------------------------------------

  const handleTestConnection = useCallback(async () => {
    const config = draftsRef.current[currentPlatformId];
    const profile = config.profiles.find((p) => p.id === config.activeProfileId);
    if (!profile?.apiKey) return;

    const key = `${currentPlatformId}:${profile.id}`;
    setTestStates((prev) => ({ ...prev, [key]: { status: "testing", message: "" } }));

    try {
      const effectiveTestSdk = getEffectiveSdk(config);
      const testCommand = getTestCommandForSdk(effectiveTestSdk);
      const testProxyUrl =
        effectiveTestSdk === "claude" || effectiveTestSdk === "codex"
          ? buildProfileProxyUrl(profile)
          : effectiveProxy;
      const result = await invoke<TestResult>(testCommand, {
        baseUrl: profile.baseUrl.trim() || undefined,
        apiKey: profile.apiKey.trim(),
        model: config.activeModelId,
        proxyUrl: testProxyUrl,
        platform: currentPlatformId,
      });

      if (result.success) {
        setTestStates((prev) => ({
          ...prev,
          [key]: { status: "success", message: `Connected (${result.elapsed_ms}ms)` },
        }));
        updateDraftPlatform(currentPlatformId, (prev) => ({
          ...prev,
          profiles: prev.profiles.map((p) =>
            p.id === profile.id ? { ...p, testPassed: true } : p,
          ),
        }));
      } else {
        setTestStates((prev) => ({ ...prev, [key]: { status: "error", message: result.message } }));
      }
    } catch (err) {
      setTestStates((prev) => ({
        ...prev,
        [key]: { status: "error", message: `Failed: ${formatError(err)}` },
      }));
    }
  }, [currentPlatformId, effectiveProxy, updateDraftPlatform]);

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  return (
    <>
      {/* Left: Platform Menu */}
      <div
        className="shrink-0 flex flex-col"
        style={{
          width: 200,
          backgroundColor: "var(--color-surface-alt)",
          borderRight: "1px solid var(--color-border-subtle)",
        }}
      >
        <div
          className="flex items-center gap-2 h-10 px-3"
          style={{ borderBottom: "1px solid var(--color-border-subtle)" }}
        >
          <Search size={14} style={{ color: "var(--color-border-strong)" }} />
          <input
            type="text"
            value={platformSearch}
            onChange={(e) => setPlatformSearch(e.target.value)}
            placeholder={t("settings.models.searchProviders")}
            className="flex-1 bg-transparent text-[12px] text-foreground font-sans outline-none placeholder:text-border-strong"
          />
        </div>

        <div className="flex-1 overflow-y-auto py-1">
          {filteredPlatforms.map((id) => {
            const meta = PLATFORM_REGISTRY[id];
            const isSelected = selectedView === id;
            const isDisabled = DISABLED_PLATFORMS.has(id);
            const config = draftPlatforms[id];
            const profile = config.profiles.find((p) => p.id === config.activeProfileId);
            const isConnected = isProfileConnectionHealthy(profile);

            return (
              <button
                key={id}
                title={isDisabled ? "暂未开放" : undefined}
                onClick={
                  isDisabled
                    ? undefined
                    : () => {
                        setSelectedView(id);
                        setShowModelDropdown(false);
                        setShowKey(false);
                        setShowAdvanced(false);
                      }
                }
                className="flex items-center gap-2.5 w-full px-3 transition-colors"
                style={{
                  height: 56,
                  backgroundColor: isSelected
                    ? `color-mix(in srgb, ${meta.color} 12%, var(--color-surface-alt))`
                    : "transparent",
                  borderLeft: isSelected ? `3px solid ${meta.color}` : "3px solid transparent",
                  opacity: isDisabled ? 0.4 : 1,
                  cursor: isDisabled ? "not-allowed" : "pointer",
                }}
              >
                <div
                  className="flex items-center justify-center w-8 h-8 rounded-lg shrink-0 overflow-hidden"
                  style={{
                    backgroundColor: `color-mix(in srgb, ${meta.color} 18%, var(--color-surface))`,
                  }}
                >
                  <span className="text-[14px] font-bold font-sans" style={{ color: meta.color }}>
                    {meta.letter}
                  </span>
                </div>
                <div className="flex flex-col gap-0.5 flex-1 min-w-0 text-left">
                  <span
                    className="text-[13px] font-sans truncate"
                    style={{ color: "var(--color-foreground)", fontWeight: isSelected ? 600 : 500 }}
                  >
                    {meta.displayName}
                  </span>
                  <span className="text-[10px] font-sans text-muted truncate">{meta.subtitle}</span>
                </div>
                <div
                  className="w-1.5 h-1.5 rounded-full shrink-0"
                  style={{
                    backgroundColor: isConnected ? "#10B981" : "var(--color-border-strong)",
                  }}
                />
              </button>
            );
          })}
        </div>
      </div>

      {/* Right: Config Panel */}
      <div className="flex-1 flex flex-col gap-4 overflow-y-auto min-w-0" style={{ padding: 20 }}>
        {currentPlatformId === "ollama" ? (
          <OllamaPanel
            draftPlatforms={draftPlatforms}
            updateDraftPlatform={updateDraftPlatform}
            effectiveProxy={effectiveProxy}
          />
        ) : (
          <>
            {/* Header */}
            <div className="flex items-center gap-3">
              <div
                className="flex items-center justify-center w-10 h-10 rounded-[10px] shrink-0 overflow-hidden"
                style={{
                  backgroundColor: `color-mix(in srgb, ${currentMeta.color} 18%, var(--color-surface))`,
                }}
              >
                <span
                  className="text-[18px] font-bold font-sans"
                  style={{ color: currentMeta.color }}
                >
                  {currentMeta.letter}
                </span>
              </div>
              <div className="flex flex-col gap-0.5 flex-1 min-w-0">
                <span className="text-[15px] font-semibold text-foreground font-sans">
                  {currentMeta.displayName}
                </span>
                <span className="text-[11px] text-muted font-sans">
                  {currentMeta.subtitle} &middot; SDK: {effectiveSdk}
                </span>
              </div>
              <button
                type="button"
                onClick={handleImportLocalCredentials}
                disabled={credentialImporting}
                className="flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-[11px] font-medium transition-colors disabled:opacity-50"
                style={{
                  color: "var(--color-foreground)",
                  backgroundColor: "var(--color-surface-alt)",
                  border: "1px solid var(--color-border-strong)",
                }}
                title={t("settings.models.scan.description")}
              >
                {credentialImporting ? (
                  <RefreshCw size={12} className="animate-spin" />
                ) : (
                  <Import size={12} />
                )}
                {credentialImporting
                  ? t("settings.models.scan.scanning")
                  : t("settings.models.scan.importButton")}
              </button>
              {currentTest.status === "success" && (
                <div
                  className="flex items-center gap-1.5 px-2.5 py-1 rounded-xl shrink-0"
                  style={{ backgroundColor: "color-mix(in srgb, #10B981 12%, var(--color-card))" }}
                >
                  <div className="w-1.5 h-1.5 rounded-full bg-[#10B981]" />
                  <span className="text-[10px] font-medium font-mono text-[#10B981]">
                    {t("settings.models.connected")}
                  </span>
                </div>
              )}
            </div>

            <div
              className="h-px w-full"
              style={{ backgroundColor: "var(--color-border-subtle)" }}
            />

            {/* Profile Selector */}
            <div className="flex flex-col gap-2">
              <div className="flex items-center justify-between">
                <span className="text-[13px] font-medium text-foreground font-sans">
                  {t("settings.models.profiles")}
                </span>
                <button
                  onClick={handleAddProfile}
                  className="flex items-center gap-1 px-2 py-1 rounded text-[11px] font-medium transition-colors hover:bg-border"
                  style={{ color: currentMeta.color }}
                >
                  <Plus size={11} />
                  {t("settings.models.addProfile")}
                </button>
              </div>
              <div className="flex flex-wrap gap-1.5">
                {currentConfig.profiles.map((profile) => {
                  const isActive = profile.id === currentConfig.activeProfileId;
                  return (
                    <div key={profile.id} className="flex items-center gap-0.5">
                      <button
                        onClick={() => handleSwitchProfile(profile.id)}
                        className={cn(
                          "px-2.5 py-1 rounded text-[11px] font-medium font-sans transition-colors",
                          isActive
                            ? "text-foreground"
                            : "text-muted hover:text-foreground hover:bg-border",
                        )}
                        style={
                          isActive
                            ? {
                                backgroundColor: `color-mix(in srgb, ${currentMeta.color} 15%, var(--color-surface))`,
                                border: `1px solid ${currentMeta.color}40`,
                              }
                            : { border: "1px solid var(--color-border-strong)" }
                        }
                      >
                        {profile.name}
                      </button>
                      {!isActive && currentConfig.profiles.length > 1 && (
                        <button
                          onClick={() => handleRemoveProfile(profile.id)}
                          className="p-0.5 rounded hover:bg-border transition-colors"
                          title={t("settings.models.remove")}
                        >
                          <Trash2 size={10} className="text-border-strong hover:text-red-400" />
                        </button>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>

            {/* Profile Name */}
            <div className="flex flex-col gap-2">
              <span className="text-[13px] font-medium text-foreground font-sans">
                {t("settings.models.profileName")}
              </span>
              <div
                className="flex items-center gap-2 h-10 rounded-md px-3.5"
                style={{
                  backgroundColor: "var(--color-surface-alt)",
                  border: "1px solid var(--color-border-strong)",
                }}
              >
                <Pencil
                  size={14}
                  style={{ color: "var(--color-border-strong)" }}
                  className="shrink-0"
                />
                <input
                  type="text"
                  value={activeProfile?.name ?? ""}
                  onChange={(e) => updateActiveProfile({ name: e.target.value })}
                  placeholder={t("settings.models.profileNamePlaceholder")}
                  className="flex-1 bg-transparent text-[12px] text-foreground font-sans outline-none placeholder:text-border-strong min-w-0"
                />
              </div>
            </div>

            {/* Auth Method — subscription login */}
            {(["claude", "codex"] as PlatformId[]).includes(currentPlatformId) &&
              (() => {
                const authMode: AuthMode = activeProfile?.authMode ?? "apiKey";
                const tabs: ReadonlyArray<{ id: AuthMode; labelKey: string; icon: typeof Key }> = [
                  { id: "apiKey", labelKey: "settings.models.auth.apiKey", icon: Key },
                  { id: "oauth", labelKey: "settings.models.auth.oauth", icon: ShieldCheck },
                ];
                return (
                  <div className="flex flex-col gap-2">
                    <span className="text-[13px] font-medium text-foreground font-sans">
                      {t("settings.models.auth.method")}
                    </span>
                    <div
                      className="flex items-center gap-1 p-1 rounded-md"
                      style={{
                        backgroundColor: "var(--color-surface-alt)",
                        border: "1px solid var(--color-border-strong)",
                      }}
                    >
                      {tabs.map((tab) => {
                        const isActive = authMode === tab.id;
                        const Icon = tab.icon;
                        return (
                          <button
                            key={tab.id}
                            onClick={() => setAuthMode(tab.id)}
                            className={cn(
                              "flex items-center justify-center gap-1.5 flex-1 px-3 py-1.5 rounded text-[12px] font-medium font-sans transition-colors",
                              isActive ? "text-foreground" : "text-muted hover:text-foreground",
                            )}
                            style={
                              isActive
                                ? {
                                    backgroundColor:
                                      "color-mix(in srgb, var(--color-accent-purple) 18%, var(--color-surface))",
                                    border:
                                      "1px solid color-mix(in srgb, var(--color-accent-purple) 55%, transparent)",
                                    color: "var(--color-accent-purple)",
                                  }
                                : { border: "1px solid transparent" }
                            }
                          >
                            <Icon size={13} />
                            {t(tab.labelKey)}
                          </button>
                        );
                      })}
                    </div>
                  </div>
                );
              })()}

            {/* SDK Channel — only shown for platforms that support channel override */}
            {(
              ["deepseek", "qwen", "bigmodel", "mimo", "minimax", "kimi", "ollama"] as PlatformId[]
            ).includes(currentPlatformId) && (
              <div className="flex flex-col gap-2">
                <span className="text-[13px] font-medium text-foreground font-sans">
                  {t("settings.models.sdkChannel")}
                </span>
                <div className="flex flex-wrap gap-1.5">
                  {USER_SELECTABLE_SDK_CHANNELS.map((sdk) => {
                    const isActive = getEffectiveSdk(currentConfig) === sdk;
                    const isNative = currentMeta.sdk === sdk;
                    const label = sdk === "chatcmpl" ? "ChatCmpl (OpenAI)" : "Claude";
                    return (
                      <button
                        key={sdk}
                        onClick={() => {
                          if (isActive) return;
                          updateDraftPlatform(currentPlatformId, (prev) => {
                            const currentSdk = getEffectiveSdk(prev);
                            const activeProf = prev.profiles.find(
                              (p) => p.id === prev.activeProfileId,
                            );
                            const currentUrl = activeProf?.baseUrl ?? "";
                            // Save current channel's URL, then restore target channel's URL
                            const savedUrls = { ...prev.channelUrls, [currentSdk]: currentUrl };
                            const targetUrl = savedUrls[sdk] ?? getChannelDefaultUrl(prev.id, sdk);
                            return {
                              ...prev,
                              sdkOverride: sdk === prev.sdk ? undefined : sdk,
                              channelUrls: savedUrls,
                              profiles: prev.profiles.map((p) =>
                                p.id === prev.activeProfileId ? { ...p, baseUrl: targetUrl } : p,
                              ),
                            };
                          });
                        }}
                        className={cn(
                          "px-2.5 py-1 rounded text-[11px] font-medium font-sans transition-colors",
                          isActive
                            ? "text-foreground"
                            : "text-muted hover:text-foreground hover:bg-border",
                        )}
                        style={
                          isActive
                            ? {
                                backgroundColor: `color-mix(in srgb, ${currentMeta.color} 15%, var(--color-surface))`,
                                border: `1px solid ${currentMeta.color}40`,
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
                {getEffectiveSdk(currentConfig) === "codex" && (
                  <div
                    className="flex items-start gap-2 rounded-md px-3 py-2"
                    style={{
                      backgroundColor: "color-mix(in srgb, #F59E0B 10%, var(--color-surface))",
                      border: "1px solid #F59E0B40",
                    }}
                  >
                    <span
                      style={{ color: "#F59E0B", fontSize: 14, lineHeight: "18px", flexShrink: 0 }}
                    >
                      ⚠
                    </span>
                    <span className="text-[11px] font-sans" style={{ color: "#F59E0B" }}>
                      {t("settings.models.codexVersionWarning")}
                    </span>
                  </div>
                )}
              </div>
            )}

            {currentPlatformId === "claude" && activeProfile?.authMode === "oauth" ? (
              <OAuthPanel
                provider="claude"
                profileId={activeProfile.id}
                proxyUrl={oauthProxyUrl}
                onSignedIn={(info) => {
                  const patch = {
                    oauthAccountEmail: info.accountEmail ?? undefined,
                    oauthPlan: info.subscriptionTier ?? undefined,
                    oauthExpiresAt: info.expiresAt,
                  };
                  updateActiveProfile(patch);
                  commitOAuthToStore(activeProfile.id, { authMode: "oauth", ...patch });
                }}
                onSignedOut={() => {
                  const clearPatch = {
                    oauthAccountEmail: undefined,
                    oauthPlan: undefined,
                    oauthExpiresAt: undefined,
                  };
                  updateActiveProfile(clearPatch);
                  commitOAuthToStore(activeProfile.id, { authMode: "oauth", ...clearPatch });
                }}
                onSwitchToApiKey={() => setAuthMode("apiKey")}
              />
            ) : currentPlatformId === "codex" && activeProfile?.authMode === "oauth" ? (
              <CodexOAuthPanel
                profileId={activeProfile.id}
                initialAccount={codexOAuthSnapshot}
                onSignedIn={(info) => {
                  const patch = {
                    oauthAccountEmail: info.email ?? undefined,
                    oauthPlan: info.planType ?? undefined,
                    oauthExpiresAt: undefined,
                    oauthRateLimits: info.rateLimits,
                  };
                  updateActiveProfile(patch);
                  commitOAuthToStore(activeProfile.id, { authMode: "oauth", ...patch });
                }}
                onSignedOut={() => {
                  const clearPatch = {
                    oauthAccountEmail: undefined,
                    oauthPlan: undefined,
                    oauthExpiresAt: undefined,
                    oauthRateLimits: undefined,
                  };
                  updateActiveProfile(clearPatch);
                  commitOAuthToStore(activeProfile.id, { authMode: "oauth", ...clearPatch });
                }}
                onSwitchToApiKey={() => setAuthMode("apiKey")}
              />
            ) : (
              <>
                {/* Base URL */}
                <div className="flex flex-col gap-2">
                  <div className="flex items-center justify-between">
                    <span className="text-[13px] font-medium text-foreground font-sans">
                      {t("settings.models.baseUrl")}
                    </span>
                    <span
                      className="text-[10px] font-medium font-mono"
                      style={{ color: currentMeta.color }}
                    >
                      {t("settings.models.required")}
                    </span>
                  </div>
                  <div
                    className="flex items-center gap-2 h-10 rounded-md px-3.5"
                    style={{
                      backgroundColor: "var(--color-surface-alt)",
                      border: "1px solid var(--color-border-strong)",
                    }}
                  >
                    <Link
                      size={14}
                      style={{ color: "var(--color-border-strong)" }}
                      className="shrink-0"
                    />
                    <input
                      type="text"
                      value={activeProfile?.baseUrl ?? ""}
                      onChange={(e) => updateActiveProfile({ baseUrl: e.target.value })}
                      placeholder={currentMeta.defaultBaseUrl || "https://..."}
                      className="flex-1 bg-transparent text-[12px] text-foreground font-mono outline-none placeholder:text-border-strong min-w-0"
                    />
                  </div>
                </div>

                {/* API Key */}
                <div className="flex flex-col gap-2">
                  <div className="flex items-center justify-between">
                    <span className="text-[13px] font-medium text-foreground font-sans">
                      {t("settings.models.apiKey")}
                    </span>
                    <span
                      className="text-[10px] font-medium font-mono"
                      style={{ color: currentMeta.color }}
                    >
                      {t("settings.models.required")}
                    </span>
                  </div>
                  <div
                    className="flex items-center justify-between h-10 rounded-md px-3.5"
                    style={{
                      backgroundColor: "var(--color-surface-alt)",
                      border: "1px solid var(--color-border-strong)",
                    }}
                  >
                    <div className="flex items-center gap-2 flex-1 min-w-0">
                      <Key
                        size={14}
                        style={{ color: "var(--color-border-strong)" }}
                        className="shrink-0"
                      />
                      <input
                        type={showKey ? "text" : "password"}
                        value={activeProfile?.apiKey ?? ""}
                        onChange={(e) => updateActiveProfile({ apiKey: e.target.value })}
                        placeholder="sk-..."
                        className="flex-1 bg-transparent text-[12px] text-foreground font-mono outline-none placeholder:text-border-strong min-w-0"
                      />
                    </div>
                    <button
                      onClick={() => setShowKey((prev) => !prev)}
                      className="text-border-strong hover:text-text-placeholder transition-colors shrink-0 ml-2"
                    >
                      {showKey ? <Eye size={14} /> : <EyeOff size={14} />}
                    </button>
                  </div>
                  <span className="text-[11px] text-border-strong font-sans">
                    {t("settings.models.apiKeyStorage")}
                  </span>
                </div>

                {showCustomModels && (
                  <div
                    className="rounded-md px-2.5 py-2"
                    style={{
                      backgroundColor: "var(--color-surface-alt)",
                      border: "1px solid var(--color-border-strong)",
                    }}
                  >
                    <div className="flex items-center gap-2">
                      <div className="flex items-center gap-2 min-w-[118px] shrink-0">
                        <div
                          className="flex items-center justify-center w-6 h-6 rounded-md shrink-0"
                          style={{
                            backgroundColor: `color-mix(in srgb, ${currentMeta.color} 18%, var(--color-surface))`,
                          }}
                        >
                          <Bot size={12} style={{ color: currentMeta.color }} />
                        </div>
                        <div className="flex items-center gap-1.5 min-w-0">
                          <span className="text-[12px] font-semibold text-foreground font-sans truncate">
                            {t("settings.models.custom.title")}
                          </span>
                          <span
                            className="rounded px-1.5 py-0.5 text-[10px] font-mono"
                            style={{
                              color: currentMeta.color,
                              backgroundColor: `color-mix(in srgb, ${currentMeta.color} 12%, transparent)`,
                            }}
                          >
                            {customModels.length}
                          </span>
                        </div>
                      </div>

                      <div
                        className="flex items-center gap-2 h-8 rounded-md px-2.5 flex-1 min-w-0"
                        style={{
                          backgroundColor: "var(--color-topbar)",
                          border: "1px solid var(--color-border-strong)",
                        }}
                      >
                        <input
                          type="text"
                          value={customModelInput}
                          onChange={(e) => setCustomModelInput(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === "Enter") {
                              e.preventDefault();
                              handleAddCustomModel();
                            }
                          }}
                          placeholder={t("settings.models.custom.placeholder")}
                          className="flex-1 bg-transparent text-[12px] text-foreground font-mono outline-none placeholder:text-border-strong min-w-0"
                        />
                      </div>
                      <button
                        type="button"
                        onClick={handleAddCustomModel}
                        disabled={!customModelInput.trim()}
                        className="flex items-center justify-center w-8 h-8 rounded-md transition-colors disabled:opacity-40"
                        style={{
                          color: "var(--color-foreground)",
                          backgroundColor: `color-mix(in srgb, ${currentMeta.color} 18%, var(--color-surface))`,
                          border: `1px solid color-mix(in srgb, ${currentMeta.color} 60%, transparent)`,
                        }}
                        title={t("settings.models.custom.add")}
                        aria-label={t("settings.models.custom.add")}
                      >
                        <Plus size={14} style={{ color: currentMeta.color }} />
                      </button>
                    </div>

                    {customModels.length > 0 && (
                      <div className="mt-2 flex max-h-16 flex-wrap gap-1 overflow-y-auto pr-1">
                        {customModels.map((model) => (
                          <span
                            key={model.id}
                            className="inline-flex items-center gap-1.5 rounded-md px-2 py-0.5 text-[11px] font-mono"
                            style={{
                              color: currentMeta.color,
                              backgroundColor: `color-mix(in srgb, ${currentMeta.color} 10%, var(--color-surface))`,
                              border: `1px solid color-mix(in srgb, ${currentMeta.color} 36%, transparent)`,
                            }}
                          >
                            <span className="max-w-[220px] truncate">{model.label}</span>
                            <button
                              type="button"
                              onClick={() => handleRemoveCustomModel(model.id)}
                              className="flex h-4 w-4 items-center justify-center rounded hover:bg-border-light transition-colors"
                              title={t("settings.models.custom.remove")}
                              aria-label={t("settings.models.custom.remove")}
                            >
                              <Trash2 size={11} />
                            </button>
                          </span>
                        ))}
                      </div>
                    )}
                  </div>
                )}
              </>
            )}

            {supportsAgentProxy && (
              <div
                className="flex flex-col gap-3 rounded-lg p-3.5"
                style={{
                  backgroundColor: "var(--color-surface-alt)",
                  border: "1px solid var(--color-border-strong)",
                }}
              >
                <button
                  type="button"
                  onClick={() => setShowAdvanced((prev) => !prev)}
                  className="flex items-center justify-between gap-3 text-left"
                >
                  <div className="flex items-center gap-2 min-w-0">
                    <div
                      className="flex items-center justify-center w-7 h-7 rounded-md shrink-0"
                      style={{
                        backgroundColor: `color-mix(in srgb, ${currentMeta.color} 18%, var(--color-surface))`,
                      }}
                    >
                      <Network size={14} style={{ color: currentMeta.color }} />
                    </div>
                    <div className="flex flex-col min-w-0">
                      <span className="text-[13px] font-semibold text-foreground font-sans">
                        {t("settings.models.advanced.title")}
                      </span>
                      <span className="text-[11px] text-border-strong font-sans truncate">
                        {activeProfileProxy.enabled
                          ? t("settings.models.advanced.proxyEnabledSummary", {
                              mode: activeProfileProxy.mode.toUpperCase(),
                            })
                          : t("settings.models.advanced.proxyDisabledSummary")}
                      </span>
                    </div>
                  </div>
                  <ChevronDown
                    size={14}
                    className={cn("shrink-0 transition-transform", showAdvanced && "rotate-180")}
                    style={{ color: "var(--color-border-strong)" }}
                  />
                </button>

                {showAdvanced && (
                  <>
                    <div
                      className="h-px w-full"
                      style={{ backgroundColor: "var(--color-border-subtle)" }}
                    />
                    <div className="flex items-center justify-between gap-3">
                      <div className="flex flex-col gap-0.5">
                        <span className="text-[12px] font-medium text-foreground font-sans">
                          {t("settings.models.advanced.proxy")}
                        </span>
                        <span className="text-[11px] text-border-strong font-sans">
                          {t("settings.models.advanced.proxyHelp")}
                        </span>
                      </div>
                      <button
                        type="button"
                        onClick={() => updateActiveProxy({ enabled: !activeProfileProxy.enabled })}
                        role="switch"
                        aria-checked={activeProfileProxy.enabled}
                        className={cn(
                          "relative inline-flex h-6 w-11 shrink-0 cursor-pointer rounded-full transition-colors",
                          activeProfileProxy.enabled ? "bg-accent-purple" : "bg-border-strong",
                        )}
                      >
                        <span
                          className={cn(
                            "pointer-events-none inline-block h-5 w-5 transform rounded-full bg-white shadow-sm transition-transform mt-0.5",
                            activeProfileProxy.enabled ? "translate-x-[22px]" : "translate-x-0.5",
                          )}
                        />
                      </button>
                    </div>

                    {agentProxyHasUnsavedChanges && (
                      <div
                        className="rounded-md px-3 py-2 text-[11px] font-sans"
                        style={{
                          color: "#F59E0B",
                          backgroundColor: "rgba(245, 158, 11, 0.10)",
                          border: "1px solid rgba(245, 158, 11, 0.30)",
                        }}
                      >
                        {t("settings.models.advanced.proxyUnsaved")}
                      </div>
                    )}

                    <div
                      className={cn(
                        "grid grid-cols-2 gap-2.5 transition-opacity",
                        !activeProfileProxy.enabled && "opacity-45",
                      )}
                    >
                      <label className="flex flex-col gap-1.5">
                        <span className="text-[11px] font-medium text-muted font-sans">
                          {t("settings.models.advanced.proxyMode")}
                        </span>
                        <select
                          value={activeProfileProxy.mode}
                          onChange={(e) =>
                            updateActiveProxy({ mode: e.target.value as ProfileProxyMode })
                          }
                          disabled={!activeProfileProxy.enabled}
                          className="h-9 rounded-md px-3 bg-[var(--color-topbar)] border border-border-strong text-[12px] text-foreground font-mono outline-none disabled:cursor-not-allowed"
                        >
                          <option value="http">HTTP</option>
                          <option value="https">HTTPS</option>
                          <option value="socks5">SOCKS5</option>
                        </select>
                      </label>
                      <label className="flex flex-col gap-1.5">
                        <span className="text-[11px] font-medium text-muted font-sans">
                          {t("settings.models.advanced.proxyHost")}
                        </span>
                        <input
                          type="text"
                          value={activeProfileProxy.host}
                          onChange={(e) => updateActiveProxy({ host: e.target.value })}
                          disabled={!activeProfileProxy.enabled}
                          placeholder="127.0.0.1"
                          className="h-9 rounded-md px-3 bg-[var(--color-topbar)] border border-border-strong text-[12px] text-foreground font-mono outline-none placeholder:text-border-strong disabled:cursor-not-allowed"
                        />
                      </label>
                      <label className="flex flex-col gap-1.5">
                        <span className="text-[11px] font-medium text-muted font-sans">
                          {t("settings.models.advanced.proxyPort")}
                        </span>
                        <input
                          type="text"
                          inputMode="numeric"
                          value={activeProfileProxy.port}
                          onChange={(e) =>
                            updateActiveProxy({ port: e.target.value.replace(/[^\d]/g, "") })
                          }
                          disabled={!activeProfileProxy.enabled}
                          placeholder="7890"
                          className="h-9 rounded-md px-3 bg-[var(--color-topbar)] border border-border-strong text-[12px] text-foreground font-mono outline-none placeholder:text-border-strong disabled:cursor-not-allowed"
                        />
                      </label>
                      <label className="flex flex-col gap-1.5">
                        <span className="text-[11px] font-medium text-muted font-sans">
                          {t("settings.models.advanced.proxyUsername")}
                        </span>
                        <input
                          type="text"
                          value={activeProfileProxy.username ?? ""}
                          onChange={(e) => updateActiveProxy({ username: e.target.value })}
                          disabled={!activeProfileProxy.enabled}
                          placeholder={t("settings.models.advanced.optional")}
                          className="h-9 rounded-md px-3 bg-[var(--color-topbar)] border border-border-strong text-[12px] text-foreground font-mono outline-none placeholder:text-border-strong disabled:cursor-not-allowed"
                        />
                      </label>
                      <label className="flex flex-col gap-1.5 col-span-2">
                        <span className="text-[11px] font-medium text-muted font-sans">
                          {t("settings.models.advanced.proxyPassword")}
                        </span>
                        <input
                          type="password"
                          value={activeProfileProxy.password ?? ""}
                          onChange={(e) => updateActiveProxy({ password: e.target.value })}
                          disabled={!activeProfileProxy.enabled}
                          placeholder={t("settings.models.advanced.optional")}
                          className="h-9 rounded-md px-3 bg-[var(--color-topbar)] border border-border-strong text-[12px] text-foreground font-mono outline-none placeholder:text-border-strong disabled:cursor-not-allowed"
                        />
                      </label>
                    </div>

                    {activeProfileProxy.enabled && !isAgentProxyValid && (
                      <div
                        className="flex items-start gap-1.5 rounded-md px-3 py-2"
                        style={{
                          backgroundColor: "color-mix(in srgb, #EF4444 8%, var(--color-card))",
                        }}
                      >
                        <CircleX size={14} className="text-red-400 shrink-0 mt-px" />
                        <span className="text-[11px] font-mono text-red-400">
                          {t("settings.models.advanced.proxyInvalid")}
                        </span>
                      </div>
                    )}

                    <div
                      className={cn(
                        "flex items-center gap-3 transition-opacity",
                        !activeProfileProxy.enabled && "opacity-45",
                      )}
                    >
                      <button
                        type="button"
                        onClick={handleTestAgentProxy}
                        disabled={
                          !activeProfileProxy.enabled ||
                          !isAgentProxyValid ||
                          currentProxyTest.status === "testing"
                        }
                        className="flex items-center gap-1.5 px-3.5 py-2 rounded-md border border-border-strong text-[12px] font-medium text-foreground hover:bg-border-subtle disabled:opacity-40 transition-colors"
                      >
                        <Zap size={14} style={{ color: currentMeta.color }} />
                        {currentProxyTest.status === "testing"
                          ? t("settings.models.testing")
                          : t("settings.general.testProxy")}
                      </button>
                      {currentProxyTest.status !== "idle" && (
                        <div className="flex min-w-0 flex-1 items-start gap-2">
                          <div className="flex min-w-0 flex-1 flex-col gap-1">
                            {currentProxyTest.stages?.length ? (
                              currentProxyTest.stages.map((stage) => (
                                <div key={stage.id} className="flex items-center gap-1.5 min-w-0">
                                  {stage.success ? (
                                    <CircleCheck size={14} className="text-[#10B981] shrink-0" />
                                  ) : (
                                    <CircleX size={14} className="text-red-400 shrink-0" />
                                  )}
                                  <span className="min-w-[96px] text-[11px] font-medium text-muted font-sans">
                                    {getProxyStageLabel(stage.id)}
                                  </span>
                                  <span
                                    className={cn(
                                      "text-[11px] font-medium font-sans",
                                      stage.success ? "text-[#10B981]" : "text-red-400",
                                    )}
                                  >
                                    {getProxyStageStatusLabel(stage.success)}
                                  </span>
                                </div>
                              ))
                            ) : (
                              <div className="flex items-center gap-1.5 min-w-0">
                                <Zap
                                  size={14}
                                  style={{ color: currentMeta.color }}
                                  className="shrink-0"
                                />
                                <span className="text-[11px] font-mono text-muted truncate">
                                  {currentProxyTest.message || t("settings.models.testing")}
                                </span>
                              </div>
                            )}
                          </div>
                          {currentProxyTest.quality && (
                            <button
                              type="button"
                              onClick={() =>
                                setSelectedProxyQuality(currentProxyTest.quality ?? null)
                              }
                              className="shrink-0 rounded-md border px-2 py-1 text-[11px] font-semibold font-sans transition-opacity hover:opacity-85"
                              style={getProxyQualityTone(currentProxyTest.quality.quality_score)}
                            >
                              {currentProxyTest.quality.quality_score == null
                                ? t("settings.models.advanced.qualityUnknown")
                                : t("settings.models.advanced.qualityTag", {
                                    score: currentProxyTest.quality.quality_score,
                                  })}
                            </button>
                          )}
                        </div>
                      )}
                    </div>
                  </>
                )}
              </div>
            )}

            {/* Default Model */}
            <div className="flex flex-col gap-2">
              <div className="flex items-center justify-between">
                <span className="text-[13px] font-medium text-foreground font-sans">
                  {t("settings.models.defaultModel")}
                </span>
                {supportsRemoteModels && (
                  <div className="flex items-center gap-2">
                    {remoteModelsResult.loading && (
                      <span className="text-[10px] font-mono text-muted animate-pulse">
                        {t("settings.models.loadingModels")}
                      </span>
                    )}
                    {remoteModelsResult.models.length > 0 && !remoteModelsResult.loading && (
                      <span className="text-[10px] font-mono text-[#10B981]">
                        {t("settings.models.modelsCount", {
                          count: remoteModelsResult.models.length,
                        })}
                      </span>
                    )}
                    {!remoteModelsResult.loading &&
                      remoteModelsResult.models.length === 0 &&
                      remoteModelsEnabled && (
                        <span className="text-[10px] font-mono text-red-400">
                          {t("settings.models.noRemoteModels")}
                        </span>
                      )}
                    <button
                      type="button"
                      onClick={remoteModelsResult.refresh}
                      disabled={!remoteModelsEnabled || remoteModelsResult.loading}
                      className="flex items-center gap-1 rounded px-2 py-1 text-[10px] font-medium transition-colors disabled:opacity-40"
                      style={{
                        color: currentMeta.color,
                        border: `1px solid ${currentMeta.color}50`,
                      }}
                      title={t("settings.models.refreshModels")}
                      aria-label={t("settings.models.refreshModels")}
                    >
                      <RefreshCw
                        size={11}
                        className={remoteModelsResult.loading ? "animate-spin" : undefined}
                      />
                      {t("settings.models.refreshModels")}
                    </button>
                  </div>
                )}
              </div>
              <div className="relative">
                <button
                  ref={modelDropdownBtnRef}
                  onClick={() => setShowModelDropdown((prev) => !prev)}
                  className="flex items-center justify-between w-full h-10 rounded-md px-3.5"
                  style={{
                    backgroundColor: "var(--color-surface-alt)",
                    border: "1px solid var(--color-border-strong)",
                  }}
                >
                  <div className="flex items-center gap-2">
                    <Bot size={14} style={{ color: currentMeta.color }} />
                    <span className="text-[12px] font-mono text-foreground">
                      {effectiveModels.find((m) => m.id === currentConfig.activeModelId)?.label ??
                        currentConfig.activeModelId}
                    </span>
                  </div>
                  <ChevronDown size={14} style={{ color: "var(--color-border-strong)" }} />
                </button>

                {showModelDropdown &&
                  (() => {
                    const rect = modelDropdownBtnRef.current?.getBoundingClientRect();
                    return (
                      <>
                        <div
                          className="fixed inset-0 z-[59]"
                          onClick={() => setShowModelDropdown(false)}
                        />
                        <div
                          className="fixed rounded-md overflow-hidden z-[60]"
                          style={{
                            top: rect ? rect.bottom + 4 : 0,
                            left: rect ? rect.left : 0,
                            width: rect ? rect.width : "auto",
                            backgroundColor: "var(--color-surface-alt)",
                            border: "1px solid var(--color-border-strong)",
                            boxShadow: "0 8px 24px rgba(0,0,0,0.4)",
                            maxHeight: rect
                              ? Math.min(320, window.innerHeight - rect.bottom - 8)
                              : 320,
                            overflowY: "auto",
                          }}
                        >
                          {(() => {
                            if (effectiveModels.length === 0) {
                              return (
                                <div className="px-3.5 py-3 text-[12px] font-mono text-muted">
                                  {supportsRemoteModels
                                    ? remoteModelsResult.loading
                                      ? t("settings.models.loadingModels")
                                      : t("settings.models.noRemoteModelsHint")
                                    : t("settings.models.noRemoteModelsHint")}
                                </div>
                              );
                            }
                            const groups = groupModelsForPicker(effectiveModels, {
                              pinCodex56: currentPlatformId === "codex",
                            });
                            if (groups.length <= 1) {
                              return effectiveModels.map((m) => (
                                <button
                                  key={m.id}
                                  onClick={() => {
                                    updateDraftPlatform(currentPlatformId, (prev) => ({
                                      ...prev,
                                      activeModelId: m.id,
                                    }));
                                    setShowModelDropdown(false);
                                  }}
                                  className={cn(
                                    "w-full px-3.5 py-2 text-left text-[12px] font-mono transition-colors hover:bg-border",
                                    currentConfig.activeModelId === m.id
                                      ? "text-foreground bg-border"
                                      : "text-text-tertiary",
                                  )}
                                >
                                  {m.label}
                                </button>
                              ));
                            }
                            return groups.map(({ category, items }, gi) => (
                              <div key={category}>
                                {gi > 0 && (
                                  <div
                                    className="h-px w-full"
                                    style={{ backgroundColor: "var(--color-border-subtle)" }}
                                  />
                                )}
                                <div
                                  className="px-3.5 py-1.5 text-[10px] font-semibold uppercase tracking-wider text-muted font-sans select-none"
                                  style={{ backgroundColor: "var(--color-topbar)" }}
                                >
                                  {category}
                                </div>
                                {items.map((m) => (
                                  <button
                                    key={m.id}
                                    onClick={() => {
                                      updateDraftPlatform(currentPlatformId, (prev) => ({
                                        ...prev,
                                        activeModelId: m.id,
                                      }));
                                      setShowModelDropdown(false);
                                    }}
                                    className={cn(
                                      "w-full px-3.5 py-2 text-left text-[12px] font-mono transition-colors hover:bg-border",
                                      currentConfig.activeModelId === m.id
                                        ? "text-foreground bg-border"
                                        : "text-text-tertiary",
                                    )}
                                  >
                                    {m.label}
                                  </button>
                                ))}
                              </div>
                            ));
                          })()}
                        </div>
                      </>
                    );
                  })()}
              </div>
            </div>

            {activeProfile?.authMode !== "oauth" && (
              <>
                <div
                  className="h-px w-full"
                  style={{ backgroundColor: "var(--color-border-subtle)" }}
                />

                {/* Test Connection */}
                <div className="flex flex-col gap-2">
                  <div className="flex items-center justify-between">
                    <button
                      onClick={handleTestConnection}
                      disabled={currentTest.status === "testing" || !activeProfile?.apiKey}
                      className="flex items-center gap-1.5 px-3.5 py-2 rounded-md text-[12px] font-medium text-foreground hover:bg-border disabled:opacity-40 transition-colors"
                      style={{ border: "1px solid var(--color-border-strong)" }}
                    >
                      <Zap size={14} style={{ color: currentMeta.color }} />
                      {currentTest.status === "testing"
                        ? t("settings.models.testing")
                        : t("settings.models.testConnection")}
                    </button>
                    {currentTest.status === "success" && (
                      <div className="flex items-center gap-1.5">
                        <CircleCheck size={14} className="text-[#10B981]" />
                        <span className="text-[11px] font-mono text-[#10B981]">
                          {currentTest.message || t("settings.models.connected")}
                        </span>
                      </div>
                    )}
                  </div>
                  {currentTest.status === "error" && (
                    <div
                      className="flex items-start gap-1.5 rounded-md px-3 py-2"
                      style={{
                        backgroundColor: "color-mix(in srgb, #EF4444 8%, var(--color-card))",
                      }}
                    >
                      <CircleX size={14} className="text-red-400 shrink-0 mt-px" />
                      <span className="text-[11px] font-mono text-red-400 break-words whitespace-pre-wrap">
                        {currentTest.message}
                      </span>
                    </div>
                  )}
                </div>
              </>
            )}
          </>
        )}
      </div>
      {selectedProxyQuality && (
        <div
          className="fixed inset-0 z-[70] flex items-center justify-center bg-black/50"
          onClick={() => setSelectedProxyQuality(null)}
        >
          <div
            role="dialog"
            aria-modal="true"
            className="w-[440px] max-w-[calc(100vw-32px)] rounded-xl border border-border-strong bg-card p-4 shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-start justify-between gap-3">
              <div className="flex flex-col gap-1">
                <span className="text-[14px] font-semibold text-foreground font-sans">
                  {t("settings.models.advanced.qualityTitle")}
                </span>
                <span className="text-[11px] text-muted font-mono">{selectedProxyQuality.ip}</span>
              </div>
              <button
                type="button"
                onClick={() => setSelectedProxyQuality(null)}
                className="rounded-md p-1 text-muted hover:text-foreground hover:bg-border-subtle transition-colors"
                aria-label={t("window.close")}
                title={t("window.close")}
              >
                <CircleX size={16} />
              </button>
            </div>

            <div
              className="mt-4 rounded-lg border px-3 py-2"
              style={getProxyQualityTone(selectedProxyQuality.quality_score)}
            >
              <div className="flex items-center justify-between gap-3">
                <span className="text-[12px] font-medium font-sans">
                  {t("settings.models.advanced.qualityScore")}
                </span>
                <span className="text-[20px] font-semibold font-mono">
                  {selectedProxyQuality.quality_score ?? "--"}
                </span>
              </div>
            </div>

            <div className="mt-4 grid grid-cols-2 gap-2">
              {[
                [
                  t("settings.models.advanced.qualityRisk"),
                  selectedProxyQuality.risk_score ?? "--",
                ],
                [
                  t("settings.models.advanced.qualityBroadbandType"),
                  selectedProxyQuality.broadband_type ||
                    selectedProxyQuality.proxy_type ||
                    t("settings.models.advanced.qualityUnknown"),
                ],
                [
                  t("settings.models.advanced.qualityNativeIp"),
                  selectedProxyQuality.native_ip == null
                    ? t("settings.models.advanced.qualityUnknown")
                    : selectedProxyQuality.native_ip
                      ? t("settings.models.advanced.qualityYes")
                      : t("settings.models.advanced.qualityNo"),
                ],
                [
                  t("settings.models.advanced.qualityAsn"),
                  selectedProxyQuality.asn || t("settings.models.advanced.qualityUnknown"),
                ],
              ].map(([label, value]) => (
                <div
                  key={String(label)}
                  className="rounded-md border border-border-subtle bg-surface-alt px-3 py-2"
                >
                  <div className="text-[10px] font-medium text-muted font-sans">{label}</div>
                  <div className="mt-1 truncate text-[12px] font-mono text-foreground">{value}</div>
                </div>
              ))}
              {[
                [
                  t("settings.models.advanced.qualityIspType"),
                  selectedProxyQuality.isp_type ||
                    selectedProxyQuality.provider ||
                    t("settings.models.advanced.qualityUnknown"),
                ],
                [
                  t("settings.models.advanced.qualityLocation"),
                  formatProxyLocation(selectedProxyQuality),
                ],
              ].map(([label, value]) => (
                <div
                  key={String(label)}
                  className="col-span-2 rounded-md border border-border-subtle bg-surface-alt px-3 py-2"
                >
                  <div className="text-[10px] font-medium text-muted font-sans">{label}</div>
                  <div className="mt-1 whitespace-normal break-words text-[12px] leading-5 font-mono text-foreground">
                    {value}
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}
    </>
  );
}
