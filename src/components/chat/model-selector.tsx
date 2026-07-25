import {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { AlertTriangle, Check, ChevronDown, Search, Settings } from "lucide-react";
import { useTranslation } from "react-i18next";
import {
  DISABLED_PLATFORMS,
  PLATFORM_REGISTRY,
  USER_SELECTABLE_PLATFORM_IDS,
  encodeConversationModel,
  getCustomModelsForActiveProfile,
  getDisplayModelsForPlatform,
  hasActiveProfileCredentials,
  ollamaLocalModelsToEntries,
  type PlatformId,
} from "@/lib/platform-config";
import { resolveStoredModel } from "@/lib/pane-model";
import { cn } from "@/lib/utils";
import {
  useAppStore,
  useConversationStore,
  useSettingsStore,
  useSplitViewStore,
  type SplitPaneId,
} from "@/stores";
import { useOllamaStore } from "@/stores/ollama-store";
import { useRemoteModelsStore } from "@/stores/remote-models-store";

const DROPDOWN_WIDTH = 520;
const DROPDOWN_HEIGHT = 360;
const VIEWPORT_GUTTER = 12;

interface ModelSelectorProps {
  readonly compact?: boolean;
  readonly conversationId?: string | null;
  readonly paneId?: string;
}

function positionDropdown(anchor: DOMRect) {
  const width = Math.min(DROPDOWN_WIDTH, window.innerWidth - VIEWPORT_GUTTER * 2);
  const height = Math.min(DROPDOWN_HEIGHT, window.innerHeight - VIEWPORT_GUTTER * 2);
  const preferredTop = anchor.bottom + 8;
  const top = preferredTop + height <= window.innerHeight - VIEWPORT_GUTTER
    ? preferredTop
    : Math.max(VIEWPORT_GUTTER, anchor.top - height - 8);
  const left = Math.min(
    Math.max(VIEWPORT_GUTTER, anchor.left),
    window.innerWidth - width - VIEWPORT_GUTTER,
  );
  return { top, left, width, height };
}

export const ModelSelector = memo(function ModelSelector({
  compact,
  conversationId,
  paneId,
}: ModelSelectorProps = {}) {
  const { t } = useTranslation();
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [previewPlatformId, setPreviewPlatformId] = useState<PlatformId | null>(null);
  const [position, setPosition] = useState<ReturnType<typeof positionDropdown> | null>(null);

  const activePlatformId = useSettingsStore((state) => state.activePlatformId);
  const platforms = useSettingsStore((state) => state.platforms);
  const setActivePlatform = useSettingsStore((state) => state.setActivePlatform);
  const setActiveModel = useSettingsStore((state) => state.setActiveModel);
  const openSettings = useAppStore((state) => state.openSettings);
  const setDraftPaneModel = useSplitViewStore((state) => state.setDraftPaneModel);
  const clearDraftPaneModel = useSplitViewStore((state) => state.clearDraftPaneModel);
  const remoteProviders = useRemoteModelsStore((state) => state.providers);
  const ollamaLocalModels = useOllamaStore((state) => state.localModels);
  const checkOllama = useOllamaStore((state) => state.checkStatus);
  const fetchOllamaModels = useOllamaStore((state) => state.fetchLocalModels);

  const scopedConversation = useConversationStore(
    useCallback(
      (state) =>
        conversationId
          ? state.conversations.find((conversation) => conversation.id === conversationId) ?? null
          : null,
      [conversationId],
    ),
  );
  const draftPaneModel = useSplitViewStore(
    useCallback(
      (state) =>
        paneId
          ? state.draftPaneModels[paneId as SplitPaneId] ?? null
          : null,
      [paneId],
    ),
  );
  const ensureConversationLoaded = useConversationStore(
    (state) => state.ensureConversationLoaded,
  );

  useEffect(() => {
    if (conversationId && !scopedConversation) {
      void ensureConversationLoaded(conversationId);
    }
  }, [conversationId, scopedConversation, ensureConversationLoaded]);

  const scopedModel = useMemo(() => {
    const stored = scopedConversation?.model ?? draftPaneModel?.model;
    return stored ? resolveStoredModel(stored) : null;
  }, [draftPaneModel?.model, scopedConversation?.model]);

  const requiresLocalSelection = scopedModel?.requiresLocalSelection === true;
  const effectivePlatformId = scopedModel?.platformId ?? activePlatformId;
  const effectiveModelId = scopedModel?.platformId
    ? scopedModel.modelId
    : platforms[effectivePlatformId].activeModelId;
  const panelPlatformId = previewPlatformId ?? effectivePlatformId;

  const visiblePlatforms = useMemo(() => {
    const ids = USER_SELECTABLE_PLATFORM_IDS.filter((id) => {
      if (DISABLED_PLATFORMS.has(id)) return false;
      return (
        id === activePlatformId ||
        id === effectivePlatformId ||
        hasActiveProfileCredentials(platforms[id])
      );
    });
    return ids.length > 0 ? ids : [activePlatformId];
  }, [activePlatformId, effectivePlatformId, platforms]);

  const modelsForPlatform = useCallback(
    (platformId: PlatformId) => {
      if (platformId === "ollama") {
        return ollamaLocalModelsToEntries(ollamaLocalModels);
      }
      return getDisplayModelsForPlatform(
        platformId,
        remoteProviders[platformId]?.models,
        getCustomModelsForActiveProfile(platforms[platformId]),
      );
    },
    [ollamaLocalModels, platforms, remoteProviders],
  );

  const panelModels = useMemo(() => {
    const query = search.trim().toLowerCase();
    const models = modelsForPlatform(panelPlatformId);
    if (!query) return models;
    return models.filter(
      (model) =>
        model.label.toLowerCase().includes(query) ||
        model.id.toLowerCase().includes(query),
    );
  }, [modelsForPlatform, panelPlatformId, search]);

  const activeModels = modelsForPlatform(effectivePlatformId);
  const activeModel = activeModels.find((model) => model.id === effectiveModelId);
  const activeMeta = PLATFORM_REGISTRY[effectivePlatformId];
  const triggerLabel = requiresLocalSelection
    ? t("modelSelector.selectLocalModel", "Select local model")
    : activeModel?.label ?? effectiveModelId;

  const updatePosition = useCallback(() => {
    const anchor = triggerRef.current?.getBoundingClientRect();
    if (anchor) setPosition(positionDropdown(anchor));
  }, []);

  useEffect(() => {
    if (!open) return;
    updatePosition();
    const handlePointerDown = (event: MouseEvent) => {
      const target = event.target as Node;
      if (
        !triggerRef.current?.contains(target) &&
        !panelRef.current?.contains(target)
      ) {
        setOpen(false);
      }
    };
    window.addEventListener("resize", updatePosition);
    window.addEventListener("scroll", updatePosition, true);
    document.addEventListener("mousedown", handlePointerDown);
    return () => {
      window.removeEventListener("resize", updatePosition);
      window.removeEventListener("scroll", updatePosition, true);
      document.removeEventListener("mousedown", handlePointerDown);
    };
  }, [open, updatePosition]);

  useEffect(() => {
    if (!open || panelPlatformId !== "ollama") return;
    void checkOllama().then(() => fetchOllamaModels());
  }, [checkOllama, fetchOllamaModels, open, panelPlatformId]);

  const selectModel = useCallback(
    (platformId: PlatformId, modelId: string) => {
      const encoded = encodeConversationModel(platformId, modelId);
      const isPaneScoped = paneId !== undefined;
      const isDraftPane = isPaneScoped && conversationId === null;
      const activeConversationId =
        useConversationStore.getState().activeConversationId;
      const targetConversationId = isDraftPane
        ? null
        : (conversationId ?? activeConversationId);

      if (isDraftPane && paneId) {
        setDraftPaneModel(paneId as SplitPaneId, encoded);
      } else if (
        !isPaneScoped &&
        (!conversationId || targetConversationId === activeConversationId)
      ) {
        if (platformId !== activePlatformId) setActivePlatform(platformId);
        setActiveModel(platformId, modelId);
      } else if (isPaneScoped && paneId) {
        clearDraftPaneModel(paneId as SplitPaneId);
      }

      if (targetConversationId) {
        useConversationStore
          .getState()
          .updateConversationModel(targetConversationId, encoded);
      }

      setOpen(false);
      setSearch("");
      setPreviewPlatformId(null);
    },
    [
      activePlatformId,
      clearDraftPaneModel,
      conversationId,
      paneId,
      setActiveModel,
      setActivePlatform,
      setDraftPaneModel,
    ],
  );

  const selectedPanelModelId =
    !requiresLocalSelection && panelPlatformId === effectivePlatformId
      ? effectiveModelId
      : "";

  return (
    <div className="relative min-w-0">
      <button
        ref={triggerRef}
        type="button"
        onClick={() => {
          setOpen((value) => !value);
          setPreviewPlatformId(effectivePlatformId);
        }}
        className={cn(
          "flex min-w-0 items-center gap-2 rounded-lg border transition-colors hover:bg-border-light",
          compact ? "h-8 px-2" : "h-9 px-3",
        )}
        style={{
          borderColor: requiresLocalSelection
            ? "var(--color-accent-warning)"
            : "var(--color-border)",
          backgroundColor: "var(--color-surface)",
        }}
        aria-expanded={open}
        aria-haspopup="dialog"
      >
        {requiresLocalSelection ? (
          <AlertTriangle size={14} className="shrink-0 text-amber-500" />
        ) : (
          <span
            className="flex h-4 w-4 shrink-0 items-center justify-center rounded text-[9px] font-bold"
            style={{ color: activeMeta.color }}
          >
            {activeMeta.letter}
          </span>
        )}
        <span className="min-w-0 truncate text-[12px] font-medium text-foreground">
          {triggerLabel}
        </span>
        <ChevronDown
          size={13}
          className={cn("shrink-0 text-muted transition-transform", open && "rotate-180")}
        />
      </button>

      {open && position && typeof document !== "undefined" &&
        createPortal(
          <div
            ref={panelRef}
            role="dialog"
            aria-label={t("modelSelector.title", "Model selection")}
            className="z-50 flex overflow-hidden"
            style={{
              position: "fixed",
              ...position,
              background: "var(--popup-bg)",
              border: "1px solid var(--popup-border)",
              borderRadius: 16,
              boxShadow: "var(--popup-shadow)",
              backdropFilter: "blur(20px)",
            }}
          >
            <div
              className="flex w-[180px] shrink-0 flex-col"
              style={{ borderRight: "1px solid var(--color-border-subtle)" }}
            >
              <div className="px-3 py-2 text-[10px] font-semibold uppercase tracking-[1.5px] text-muted">
                {t("modelSelector.platform", "Platform")}
              </div>
              <div className="flex-1 overflow-y-auto">
                {visiblePlatforms.map((platformId) => {
                  const meta = PLATFORM_REGISTRY[platformId];
                  const selected = panelPlatformId === platformId;
                  return (
                    <button
                      key={platformId}
                      type="button"
                      onMouseEnter={() => setPreviewPlatformId(platformId)}
                      onFocus={() => setPreviewPlatformId(platformId)}
                      onClick={() => setPreviewPlatformId(platformId)}
                      className="flex h-11 w-full items-center gap-2.5 px-3 text-left transition-colors hover:bg-border-light"
                      style={{
                        backgroundColor: selected
                          ? `color-mix(in srgb, ${meta.color} 12%, transparent)`
                          : "transparent",
                        borderLeft: selected
                          ? `3px solid ${meta.color}`
                          : "3px solid transparent",
                      }}
                    >
                      <span
                        className="flex h-5 w-5 shrink-0 items-center justify-center text-xs font-bold"
                        style={{ color: meta.color }}
                      >
                        {meta.letter}
                      </span>
                      <span className="truncate text-[12px] font-medium text-foreground">
                        {meta.displayName}
                      </span>
                    </button>
                  );
                })}
              </div>
              <button
                type="button"
                onClick={() => {
                  setOpen(false);
                  openSettings("models");
                }}
                className="flex h-10 items-center gap-2.5 border-t border-border-subtle px-3 text-[12px] text-muted-foreground transition-colors hover:bg-border-light"
              >
                <Settings size={14} />
                {t("modelSelector.configureModels")}
              </button>
            </div>

            <div className="flex min-w-0 flex-1 flex-col">
              <div className="flex h-11 shrink-0 items-center gap-2 border-b border-border-subtle px-3">
                <Search size={14} className="text-muted" />
                <input
                  value={search}
                  onChange={(event) => setSearch(event.target.value)}
                  placeholder={t("modelSelector.searchModels", "Search models")}
                  className="min-w-0 flex-1 bg-transparent text-[12px] text-foreground outline-none placeholder:text-muted"
                  autoFocus
                />
              </div>
              <div className="flex-1 overflow-y-auto py-1">
                {panelModels.length === 0 ? (
                  <div className="flex h-full items-center justify-center px-6 text-center text-[12px] text-muted">
                    {t("modelSelector.noModels", "No local models available")}
                  </div>
                ) : (
                  panelModels.map((model) => {
                    const selected = selectedPanelModelId === model.id;
                    return (
                      <button
                        key={model.id}
                        type="button"
                        onClick={() => selectModel(panelPlatformId, model.id)}
                        className="flex w-full items-center gap-3 px-4 py-2.5 text-left transition-colors hover:bg-border-light"
                      >
                        <div className="min-w-0 flex-1">
                          <div className="truncate text-[12px] font-medium text-foreground">
                            {model.label}
                          </div>
                          <div className="truncate text-[10px] font-mono text-muted">
                            {model.id}
                          </div>
                        </div>
                        {selected && (
                          <Check
                            size={14}
                            className="shrink-0"
                            style={{ color: PLATFORM_REGISTRY[panelPlatformId].color }}
                          />
                        )}
                      </button>
                    );
                  })
                )}
              </div>
            </div>
          </div>,
          document.body,
        )}
    </div>
  );
});
