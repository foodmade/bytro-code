import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Sparkles, ArrowRight, Cloud, Cpu, Brain, Languages, ChevronDown, Check, ScanSearch, Eye, FileText, ShieldCheck } from "lucide-react";
import { useConversationStore, useSettingsStore, useAppStore, useChatStore, useStreamStateStore, useAgentStatusStore, useSplitViewStore } from "@/stores";
import {
  resolveActiveCredentials,
  hasActiveProfileCredentials,
  PLATFORM_REGISTRY,
  USER_SELECTABLE_PLATFORM_IDS,
  getDisplayModelsForPlatform,
  getCustomModelsForActiveProfile,
  encodeConversationModel,
} from "@/lib/platform-config";
import { useRemoteModelsStore } from "@/stores/remote-models-store";
import type { PlatformId } from "@/lib/platform-config";
import { useIsLightTheme } from "@/hooks/use-is-light-theme";
import type { Workspace } from "@/stores";
import type { ResponseLanguage } from "@/stores/settings-store";
import { bindConversationToPreferredSessionPane } from "@/lib/session-pane-target";

const QUICK_ACTION_TAGS = [
  { id: "analyze", icon: ScanSearch, labelKey: "workspace.quickActions.analyzeStructure", color: "#4285F4", bgColor: "#4285F412", prompt: "Analyze the project structure of this codebase. Provide a high-level overview including: directory structure, main technologies used, architecture patterns, entry points, and key configuration files." },
  { id: "review", icon: Eye, labelKey: "workspace.quickActions.codeReview", color: "#10B981", bgColor: "#10B98112", prompt: "Review the recent code changes in this project. Check for potential bugs, code style issues, security concerns, and suggest improvements. Focus on the most recently modified files." },
  { id: "docs", icon: FileText, labelKey: "workspace.quickActions.generateDocs", color: "#A855F7", bgColor: "rgba(var(--theme-accent-rgb),0.071)", prompt: "Analyze the codebase and generate comprehensive documentation including: API reference, architecture overview, setup instructions, and key module descriptions. Focus on undocumented or poorly documented areas." },
  { id: "security", icon: ShieldCheck, labelKey: "workspace.quickActions.securityScan", color: "#F97316", bgColor: "#F9731612", prompt: "Perform a security audit of this project. Check for common vulnerabilities (OWASP Top 10), dependency vulnerabilities, secrets in code, insecure configurations, and authentication/authorization issues." },
] as const;

const LANG_OPTIONS: ReadonlyArray<{ id: ResponseLanguage; label: string }> = [
  { id: "auto", label: "Auto" },
  { id: "en", label: "English" },
  { id: "zh", label: "中文" },
  { id: "ja", label: "日本語" },
  { id: "ko", label: "한국어" },
  { id: "fr", label: "Français" },
  { id: "de", label: "Deutsch" },
  { id: "es", label: "Español" },
];

const LANG_LABELS: Readonly<Record<string, string>> = Object.fromEntries(
  LANG_OPTIONS.map((o) => [o.id, o.label]),
);

type DropdownKind = "provider" | "model" | "language";

/* ------------------------------------------------------------------ */
/*  Dropdown                                                          */
/* ------------------------------------------------------------------ */

function OptionDropdown({
  items,
  activeId,
  onSelect,
  onClose,
  isLight,
}: {
  readonly items: ReadonlyArray<{ id: string; label: string; color?: string; letter?: string; logo?: string }>;
  readonly activeId: string;
  readonly onSelect: (id: string) => void;
  readonly onClose: () => void;
  readonly isLight: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        onClose();
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [onClose]);

  return (
    <div
      ref={ref}
      className="absolute right-0 z-50 flex flex-col"
      style={{
        top: "100%",
        marginTop: 4,
        minWidth: 180,
        maxHeight: 260,
        overflowY: "auto",
        borderRadius: 10,
        background: isLight
          ? "var(--color-card)"
          : "linear-gradient(180deg, #1E1A30, #141218)",
        border: isLight
          ? "1px solid var(--color-border)"
          : "1px solid rgba(var(--theme-accent-rgb),0.2)",
        boxShadow: isLight
          ? "0 8px 24px rgba(0,0,0,0.12)"
          : "0 8px 24px rgba(0,0,0,0.5)",
        padding: "4px 0",
      }}
    >
      {items.map((item) => {
        const isActive = item.id === activeId;
        return (
          <button
            key={item.id}
            onClick={() => {
              onSelect(item.id);
              onClose();
            }}
            className="flex items-center w-full transition-colors hover:bg-hover-overlay/[0.06]"
            style={{
              gap: 8,
              padding: "6px 12px",
              border: "none",
              cursor: "pointer",
            }}
          >
            {item.logo ? (
              <img
                src={item.logo}
                alt=""
                style={{ width: 16, height: 16, objectFit: "contain", borderRadius: 3 }}
              />
            ) : item.letter ? (
              <div
                className="flex items-center justify-center shrink-0"
                style={{
                  width: 16,
                  height: 16,
                  borderRadius: 3,
                  backgroundColor: isLight ? `${item.color}15` : `${item.color}25`,
                  fontSize: 9,
                  fontWeight: 700,
                  color: item.color,
                  fontFamily: "Inter, sans-serif",
                }}
              >
                {item.letter}
              </div>
            ) : null}
            <span
              className="flex-1 text-left truncate"
              style={{
                fontSize: 12,
                fontWeight: isActive ? 600 : 400,
                color: isActive ? "var(--color-foreground)" : "var(--color-muted-foreground)",
                fontFamily: "Inter, sans-serif",
              }}
            >
              {item.label}
            </span>
            {isActive && (
              <Check size={12} style={{ color: "#A855F7", flexShrink: 0 }} />
            )}
          </button>
        );
      })}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Main card                                                         */
/* ------------------------------------------------------------------ */

export function WorkspaceNewSessionCard({ workspace }: { readonly workspace: Workspace | null }) {
  const { t } = useTranslation();
  const createConversation = useConversationStore((s) => s.createConversation);
  const setActiveView = useAppStore((s) => s.setActiveView);
  const isLight = useIsLightTheme();

  // Hide quick action tags when card height is insufficient
  const cardRef = useRef<HTMLDivElement>(null);
  const [hideQuickActions, setHideQuickActions] = useState(false);

  useEffect(() => {
    const el = cardRef.current;
    if (!el) return;
    const HIDE_THRESHOLD = 300;
    const SHOW_THRESHOLD = 320;
    const ro = new ResizeObserver(([entry]) => {
      const h = entry.contentRect.height;
      setHideQuickActions((prev) => {
        if (prev && h >= SHOW_THRESHOLD) return false;
        if (!prev && h < HIDE_THRESHOLD) return true;
        return prev;
      });
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const activePlatformId = useSettingsStore((s) => s.activePlatformId);
  const setActivePlatform = useSettingsStore((s) => s.setActivePlatform);
  const reasoningLevel = useSettingsStore((s) => s.reasoningLevel);
  const setReasoningLevel = useSettingsStore((s) => s.setReasoningLevel);
  const isThinkingOn = reasoningLevel !== "off";
  const responseLanguage = useSettingsStore((s) => s.responseLanguage);
  const setResponseLanguage = useSettingsStore((s) => s.setResponseLanguage);

  const [openDropdown, setOpenDropdown] = useState<DropdownKind | null>(null);

  // Configured platforms include both API-key and local OAuth profiles.
  const configuredPlatforms = useMemo(() => {
    const state = useSettingsStore.getState();
    const configured = USER_SELECTABLE_PLATFORM_IDS.filter((id) => {
      return hasActiveProfileCredentials(state.platforms[id]);
    });
    if (!configured.includes(activePlatformId) && USER_SELECTABLE_PLATFORM_IDS.includes(activePlatformId)) {
      return [...configured, activePlatformId];
    }
    return configured;
  }, [activePlatformId]);

  // Models for current platform — prefer remote-fetched catalog when available
  // so chatcmpl providers (DeepSeek/Qwen/Kimi/…) show their full live model list.
  const remoteProviderModels = useRemoteModelsStore(
    useCallback((s) => s.providers[activePlatformId]?.models, [activePlatformId]),
  );
  const activePlatformConfig = useSettingsStore((s) => s.platforms[activePlatformId]);
  const models = useMemo(
    () => getDisplayModelsForPlatform(
      activePlatformId,
      remoteProviderModels,
      getCustomModelsForActiveProfile(activePlatformConfig),
    ),
    [activePlatformId, activePlatformConfig, remoteProviderModels],
  );

  // Reactively subscribe to model value so UI updates on selection
  const currentModelId = useSettingsStore((s) => s.platforms[activePlatformId]?.activeModelId ?? "");

  const currentModelEntry = models.find((m) => m.id === currentModelId);

  const displayModelLabel = currentModelEntry?.label ?? currentModelId;

  const platformMeta = PLATFORM_REGISTRY[activePlatformId] ?? PLATFORM_REGISTRY.claude;
  const providerDisplayName = platformMeta.displayName;

  const langLabel = LANG_LABELS[responseLanguage] ?? responseLanguage;

  const toggleDropdown = useCallback((kind: DropdownKind) => {
    setOpenDropdown((prev) => (prev === kind ? null : kind));
  }, []);

  const setPendingQuickAction = useAppStore((s) => s.setPendingQuickAction);

  const resolveModelForConversation = useCallback(() => {
    const settingsState = useSettingsStore.getState();
    const platformId = settingsState.activePlatformId;
    const platformConfig = settingsState.platforms[platformId];
    const creds = resolveActiveCredentials(platformConfig);
    return encodeConversationModel(platformId, creds?.model ?? platformConfig.activeModelId);
  }, []);

  const handleQuickAction = useCallback(
    async (prompt: string) => {
      if (!workspace) return;

      const chatState = useChatStore.getState();
      const currentConvId = useConversationStore.getState().activeConversationId;
      if (currentConvId) {
        useAgentStatusStore.getState().cacheAgentStatus(currentConvId);
        if (useStreamStateStore.getState().isStreaming || chatState.messages.length > 0) {
          chatState.saveSnapshot(currentConvId);
        }
      }

      useConversationStore.getState().setActiveConversationId(null);
      chatState.clearMessages();
      const model = resolveModelForConversation();
      const conv = await createConversation(model, workspace.id);
      const splitState = useSplitViewStore.getState();
      if (splitState.layout !== "single") {
        const targetPaneId = bindConversationToPreferredSessionPane(conv.id);
        if (!targetPaneId) {
          splitState.enterSoloMode(conv.id);
        }
      }
      setPendingQuickAction(prompt);
      setActiveView("chat");
    },
    [workspace, createConversation, setActiveView, setPendingQuickAction, resolveModelForConversation],
  );

  const handleNewSession = useCallback(async () => {
    if (!workspace) return;

    const chatState = useChatStore.getState();
    const currentConvId = useConversationStore.getState().activeConversationId;
    if (currentConvId) {
      useAgentStatusStore.getState().cacheAgentStatus(currentConvId);
      if (useStreamStateStore.getState().isStreaming || chatState.messages.length > 0) {
        chatState.saveSnapshot(currentConvId);
      }
    }

    useConversationStore.getState().setActiveConversationId(null);
    chatState.clearMessages();
    const model = resolveModelForConversation();
    const conv = await createConversation(model, workspace.id);
    const splitState = useSplitViewStore.getState();
    if (splitState.layout !== "single") {
      const targetPaneId = bindConversationToPreferredSessionPane(conv.id);
      if (!targetPaneId) {
        splitState.enterSoloMode(conv.id);
      }
    }
    setActiveView("chat");
  }, [workspace, createConversation, setActiveView, resolveModelForConversation]);

  const handleProviderSelect = useCallback(
    (id: string) => {
      setActivePlatform(id as PlatformId);
    },
    [setActivePlatform],
  );

  const handleModelSelect = useCallback(
    (id: string) => {
      useSettingsStore.getState().setActiveModel(activePlatformId, id);
    },
    [activePlatformId],
  );

  const handleLanguageSelect = useCallback(
    (id: string) => {
      setResponseLanguage(id as ResponseLanguage);
    },
    [setResponseLanguage],
  );

  const optLabelStyle: React.CSSProperties = {
    fontSize: 12,
    fontWeight: 400,
    color: "var(--color-muted-foreground)",
    fontFamily: "Inter, sans-serif",
  };

  const optValueStyle: React.CSSProperties = {
    fontSize: 12,
    fontWeight: 500,
    color: "var(--color-foreground)",
    fontFamily: "Inter, sans-serif",
  };

  // Map data for dropdowns
  const providerItems = useMemo(() => {
    const items: Array<{ id: string; label: string; color?: string; letter?: string; logo?: string }> = [];

    for (const id of configuredPlatforms) {
      const meta = PLATFORM_REGISTRY[id];
      items.push({
        id: meta.id,
        label: meta.displayName,
        color: meta.color,
        letter: meta.letter,
      });
    }

    return items;
  }, [configuredPlatforms]);

  const modelItems = useMemo(
    () => models.map((m) => ({ id: m.id, label: m.label })),
    [models],
  );

  const langItems = useMemo(
    () => LANG_OPTIONS.map((o) => ({ id: o.id, label: o.label })),
    [],
  );

  return (
    <div
      ref={cardRef}
      className="flex flex-col flex-1 min-w-0"
      style={{
        borderRadius: 16,
        background: isLight
          ? "linear-gradient(170deg, #EDE5F8 0%, var(--color-surface-alt) 50%)"
          : "linear-gradient(170deg, #2a1f3d 0%, #222226 50%)",
        padding: "20px 20px 16px 20px",
        justifyContent: "space-between",
        height: "100%",
        minWidth: 0,
        overflow: "visible",
      }}
    >
      {/* Top: icon + title + subtitle */}
      <div className="flex flex-col" style={{ gap: 6 }}>
        <div className="flex items-center" style={{ gap: 8 }}>
          <Sparkles size={20} style={{ color: "#A855F7" }} />
          <span
            style={{
              fontSize: 18,
              fontWeight: 700,
              color: "var(--color-foreground)",
              fontFamily: "Inter, sans-serif",
            }}
          >
            {t("workspace.newSessionTitle", "New Session")}
          </span>
        </div>
        <span
          style={{
            fontSize: 12,
            fontWeight: 400,
            color: "var(--color-muted)",
            fontFamily: "Inter, sans-serif",
          }}
        >
          {t("workspace.newSessionSubtitle", "配置并开始新的对话")}
        </span>
      </div>

      {/* Quick Action Tags — hidden smoothly when card height is too small */}
      <div
        style={{
          maxHeight: hideQuickActions ? 0 : 100,
          opacity: hideQuickActions ? 0 : 1,
          overflow: "hidden",
          transition: "max-height 0.3s ease, opacity 0.2s ease",
        }}
      >
        <div className="flex items-center flex-wrap" style={{ gap: 8 }}>
          {QUICK_ACTION_TAGS.map((tag) => {
            const Icon = tag.icon;
            return (
              <button
                key={tag.id}
                onClick={() => handleQuickAction(tag.prompt)}
                className="flex items-center transition-opacity hover:opacity-70"
                style={{
                  gap: 6,
                  padding: "5px 10px",
                  borderRadius: 14,
                  backgroundColor: tag.bgColor,
                  border: "none",
                  cursor: "pointer",
                }}
              >
                <Icon size={12} style={{ color: tag.color, flexShrink: 0 }} />
                <span
                  style={{
                    fontSize: 11,
                    fontWeight: 500,
                    color: tag.color,
                    fontFamily: "Inter, sans-serif",
                    whiteSpace: "nowrap",
                  }}
                >
                  {t(tag.labelKey)}
                </span>
              </button>
            );
          })}
        </div>
      </div>

      {/* Bottom: options + action */}
      <div className="flex flex-col" style={{ gap: 12 }}>
        {/* Options rows */}
        <div className="flex flex-col" style={{ gap: 6 }}>
          {/* Provider */}
          <div className="relative" style={{ height: 24 }}>
            <button
              onClick={() => toggleDropdown("provider")}
              className="flex items-center justify-between w-full hover:opacity-80 transition-opacity"
              style={{ height: 24, border: "none", cursor: "pointer" }}
            >
              <div className="flex items-center" style={{ gap: 8 }}>
                <Cloud size={14} style={{ color: "var(--color-muted-foreground)" }} />
                <span style={optLabelStyle}>{t("workspace.sessionConfig.provider")}</span>
              </div>
              <div className="flex items-center" style={{ gap: 6 }}>
                <span style={optValueStyle}>{providerDisplayName}</span>
                <ChevronDown
                  size={12}
                  style={{
                    color: "var(--color-muted)",
                    transform: openDropdown === "provider" ? "rotate(180deg)" : undefined,
                    transition: "transform 0.15s ease",
                  }}
                />
              </div>
            </button>
            {openDropdown === "provider" && (
              <OptionDropdown
                items={providerItems}
                activeId={activePlatformId}
                onSelect={handleProviderSelect}
                onClose={() => setOpenDropdown(null)}
                isLight={isLight}
              />
            )}
          </div>

          {/* Model */}
          <div className="relative" style={{ height: 24 }}>
            <button
              onClick={() => toggleDropdown("model")}
              className="flex items-center justify-between w-full hover:opacity-80 transition-opacity"
              style={{ height: 24, border: "none", cursor: "pointer" }}
            >
              <div className="flex items-center" style={{ gap: 8 }}>
                <Cpu size={14} style={{ color: "var(--color-muted-foreground)" }} />
                <span style={optLabelStyle}>Model</span>
              </div>
              <div className="flex items-center" style={{ gap: 6 }}>
                <span className="truncate" style={{ ...optValueStyle, maxWidth: 160 }}>
                  {displayModelLabel}
                </span>
                <ChevronDown
                  size={12}
                  style={{
                    color: "var(--color-muted)",
                    transform: openDropdown === "model" ? "rotate(180deg)" : undefined,
                    transition: "transform 0.15s ease",
                  }}
                />
              </div>
            </button>
            {openDropdown === "model" && (
              <OptionDropdown
                items={modelItems}
                activeId={currentModelId}
                onSelect={handleModelSelect}
                onClose={() => setOpenDropdown(null)}
                isLight={isLight}
              />
            )}
          </div>

          {/* Extended Thinking */}
          <div className="flex items-center justify-between" style={{ height: 24 }}>
            <div className="flex items-center" style={{ gap: 8 }}>
              <Brain size={14} style={{ color: "var(--color-muted-foreground)" }} />
              <span style={optLabelStyle}>{t("workspace.sessionConfig.extendedThinking")}</span>
            </div>
            <button
              onClick={() => setReasoningLevel(isThinkingOn ? "off" : "medium")}
              style={{
                width: 36,
                height: 20,
                borderRadius: 10,
                backgroundColor: isThinkingOn ? "#A855F7" : "var(--color-border-strong)",
                padding: 2,
                display: "flex",
                alignItems: "center",
                justifyContent: isThinkingOn ? "flex-end" : "flex-start",
                cursor: "pointer",
                border: "none",
                transition: "background-color 0.2s ease",
              }}
            >
              <div
                style={{
                  width: 16,
                  height: 16,
                  borderRadius: "50%",
                  backgroundColor: "#ffffff",
                  transition: "transform 0.2s ease",
                }}
              />
            </button>
          </div>

          {/* Response Language */}
          <div className="relative" style={{ height: 24 }}>
            <button
              onClick={() => toggleDropdown("language")}
              className="flex items-center justify-between w-full hover:opacity-80 transition-opacity"
              style={{ height: 24, border: "none", cursor: "pointer" }}
            >
              <div className="flex items-center" style={{ gap: 8 }}>
                <Languages size={14} style={{ color: "var(--color-muted-foreground)" }} />
                <span style={optLabelStyle}>{t("workspace.sessionConfig.responseLanguage")}</span>
              </div>
              <div className="flex items-center" style={{ gap: 6 }}>
                <span style={optValueStyle}>{langLabel}</span>
                <ChevronDown
                  size={12}
                  style={{
                    color: "var(--color-muted)",
                    transform: openDropdown === "language" ? "rotate(180deg)" : undefined,
                    transition: "transform 0.15s ease",
                  }}
                />
              </div>
            </button>
            {openDropdown === "language" && (
              <OptionDropdown
                items={langItems}
                activeId={responseLanguage}
                onSelect={handleLanguageSelect}
                onClose={() => setOpenDropdown(null)}
                isLight={isLight}
              />
            )}
          </div>
        </div>

        {/* Action button — full-width gradient */}
        <button
          onClick={handleNewSession}
          className="flex items-center justify-center w-full ns-start-btn"
          style={{
            gap: 8,
            height: 38,
            borderRadius: 10,
            background: "linear-gradient(90deg, #A855F7, #7C3AED)",
            border: "none",
            cursor: "pointer",
            transition: "opacity 0.15s ease, transform 0.15s ease",
            flexShrink: 0,
          }}
        >
          <span
            style={{
              fontSize: 13,
              fontWeight: 600,
              color: "#FFFFFF",
              fontFamily: "Inter, sans-serif",
            }}
          >
            {t("workspace.startSession", "开始会话")}
          </span>
          <ArrowRight size={14} style={{ color: "rgba(255,255,255,0.8)" }} />
        </button>
      </div>
    </div>
  );
}
