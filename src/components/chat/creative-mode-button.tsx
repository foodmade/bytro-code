import { useState, useRef, useEffect, useCallback, useMemo } from "react";
import {
  Plus,
  Presentation,
  Image as ImageIcon,
  Palette,
  Target,
  X,
} from "lucide-react";
import { useTranslation } from "react-i18next";
import { useAppStore, useSettingsStore } from "@/stores";
import { useConversationStore } from "@/stores/conversation-store";
import { useSplitViewStore, type SplitPaneId } from "@/stores/split-view-store";
import { resolvePaneModel } from "@/lib/pane-model";
import type { PlatformConfig } from "@/lib/platform-config";
import { Tooltip } from "@/components/ui";

// ---------------------------------------------------------------------------
// CreativeModeButton — "+" button with popover mode selector
// ---------------------------------------------------------------------------

type CreativeMode = "none" | "pptx" | "imagegen";

interface ModeOption {
  readonly id: Exclude<CreativeMode, "none">;
  readonly icon: React.ReactNode;
  readonly labelKey: string;
  readonly fallback: string;
  readonly descKey: string;
  readonly descFallback: string;
  /** Mark the option non-interactive and visually subdued. */
  readonly disabled?: boolean;
  /** Hide the option unless the predicate returns true. */
  readonly visibleWhen?: (ctx: { readonly sdk: string | null }) => boolean;
}

interface GoalOption {
  readonly id: "goal";
  readonly icon: React.ReactNode;
  readonly labelKey: string;
  readonly fallback: string;
  readonly descKey: string;
  readonly descFallback: string;
  readonly visibleWhen: (ctx: { readonly sdk: string | null }) => boolean;
}

const MODE_OPTIONS: readonly ModeOption[] = [
  {
    id: "imagegen",
    icon: <ImageIcon size={16} />,
    labelKey: "creativeMode.imagegen",
    fallback: "Image Generation",
    descKey: "creativeMode.imagegenDesc",
    descFallback: "Generate images via gpt-image-2",
    visibleWhen: ({ sdk }) => sdk === "codex",
  },
  {
    id: "pptx",
    icon: <Presentation size={16} />,
    labelKey: "creativeMode.pptx",
    fallback: "Presentation Mode",
    descKey: "creativeMode.pptxDisabled",
    descFallback: "Temporarily disabled",
    disabled: true,
  },
];

const GOAL_OPTION: GoalOption = {
  id: "goal",
  icon: <Target size={16} />,
  labelKey: "creativeMode.goal",
  fallback: "Goal",
  descKey: "creativeMode.goalDesc",
  descFallback: "Set a persistent Codex goal",
  visibleWhen: ({ sdk }) => sdk === "codex",
};

interface CreativeModeButtonProps {
  readonly conversationId?: string | null;
  readonly paneId?: string | null;
}

export function CreativeModeButton({ conversationId, paneId }: CreativeModeButtonProps = {}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const popoverRef = useRef<HTMLDivElement>(null);
  const btnRef = useRef<HTMLButtonElement>(null);

  const creativeMode = useAppStore((s) => s.creativeMode);
  const setCreativeMode = useAppStore((s) => s.setCreativeMode);
  const goalModeEnabled = useAppStore((s) => s.goalModeEnabled);
  const setGoalModeEnabled = useAppStore((s) => s.setGoalModeEnabled);

  // Resolve effective SDK for the active conversation/pane (matches the gating
  // chat-streaming uses for `openai_images` MCP). Subscribing to the underlying
  // state keeps the popover reactive when the user switches model mid-session.
  const activePlatformId = useSettingsStore((s) => s.activePlatformId);
  const platforms = useSettingsStore((s) => s.platforms);
  const conversationModel = useConversationStore((s) =>
    conversationId ? (s.conversations.find((c) => c.id === conversationId)?.model ?? null) : null,
  );
  const draftPaneModel = useSplitViewStore((s) =>
    paneId ? (s.draftPaneModels[paneId as SplitPaneId] ?? null) : null,
  );
  const resolvedSdk = useMemo<string | null>(() => {
    const resolved = resolvePaneModel({
      paneId: (paneId as SplitPaneId | null | undefined) ?? null,
      conversationId: conversationId ?? null,
    });
    const platformId = resolved.platformId ?? activePlatformId;
    return (
      (platforms[platformId as keyof typeof platforms] as PlatformConfig | undefined)?.sdk ?? null
    );
    // conversationModel/draftPaneModel kept in deps so the memo invalidates when
    // the user switches models (resolvePaneModel reads them via getState).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [paneId, conversationId, conversationModel, draftPaneModel, activePlatformId, platforms]);

  const visibleOptions = useMemo<readonly ModeOption[]>(
    () => MODE_OPTIONS.filter((o) => !o.visibleWhen || o.visibleWhen({ sdk: resolvedSdk })),
    [resolvedSdk],
  );
  const isGoalVisible = GOAL_OPTION.visibleWhen({ sdk: resolvedSdk });

  // If the currently selected mode is no longer visible (e.g. user switched
  // away from a codex model while imagegen was active), demote to none.
  useEffect(() => {
    if (creativeMode === "none") return;
    if (!visibleOptions.some((o) => o.id === creativeMode)) {
      setCreativeMode("none");
    }
  }, [creativeMode, visibleOptions, setCreativeMode]);

  // NOTE: goalModeEnabled is deliberately NOT auto-reset when this pane's SDK
  // can't use it. It is a global setting, and every mounted CreativeModeButton
  // runs its effects — in split view a claude pane would instantly disable the
  // goal mode a codex pane just enabled. The send path already gates it per
  // request, so a stale-enabled flag on a non-matching platform is harmless.

  const isActive = creativeMode !== "none";
  const activeOption = MODE_OPTIONS.find((o) => o.id === creativeMode);

  // Close popover on outside click
  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (
        popoverRef.current &&
        !popoverRef.current.contains(e.target as Node) &&
        !btnRef.current?.contains(e.target as Node)
      ) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open]);

  const handleSelect = useCallback(
    (mode: CreativeMode, disabled?: boolean) => {
      if (disabled) return;
      setCreativeMode(mode === creativeMode ? "none" : mode);
      setOpen(false);
    },
    [creativeMode, setCreativeMode],
  );

  const handleToggleGoal = useCallback(() => {
    setGoalModeEnabled(!goalModeEnabled);
    setOpen(false);
  }, [goalModeEnabled, setGoalModeEnabled]);

  return (
    <div style={{ position: "relative" }}>
      {/* Trigger button */}
      <Tooltip
        content={t("creativeMode.title", { defaultValue: "Creative Mode" })}
        placement="top"
        disabled={open}
      >
        <button
          ref={btnRef}
          type="button"
          onClick={() => setOpen(!open)}
          className={
            isActive
              ? "text-accent-purple hover:text-accent-purple transition-colors"
              : "text-muted hover:text-muted-foreground transition-colors"
          }
          style={{
            background: "none",
            border: "none",
            padding: 0,
            cursor: "pointer",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          {creativeMode !== "none" && activeOption ? (
            <span style={{ display: "flex" }}>{activeOption.icon}</span>
          ) : (
            <Plus size={16} />
          )}
        </button>
      </Tooltip>

      {/* Popover */}
      {open && (
        <div
          ref={popoverRef}
          style={{
            position: "absolute",
            bottom: "calc(100% + 8px)",
            left: 0,
            width: 220,
            borderRadius: 12,
            backgroundColor: "var(--color-card)",
            border: "1px solid var(--color-border-strong)",
            padding: 6,
            boxShadow: "0 8px 24px rgba(0,0,0,0.4)",
            zIndex: 50,
            display: "flex",
            flexDirection: "column",
            gap: 2,
          }}
        >
          <span
            style={{
              fontSize: 10,
              fontWeight: 600,
              color: "var(--color-muted)",
              letterSpacing: 0.5,
              padding: "4px 10px 6px",
            }}
          >
            {t("creativeMode.title", { defaultValue: "Creative Mode" })}
          </span>

          {visibleOptions.map((opt) => {
            const selected = creativeMode === opt.id;
            const disabled = !!opt.disabled;
            return (
              <button
                key={opt.id}
                type="button"
                onClick={() => handleSelect(opt.id, disabled)}
                aria-disabled={disabled}
                className={
                  selected
                    ? "creative-mode-option creative-mode-option--selected"
                    : "creative-mode-option"
                }
                style={disabled ? { opacity: 0.45, cursor: "not-allowed" } : undefined}
              >
                <span
                  style={{
                    color: selected
                      ? "var(--color-accent-purple)"
                      : "var(--color-muted-foreground)",
                    display: "flex",
                  }}
                >
                  {opt.icon}
                </span>
                <span style={{ display: "flex", flexDirection: "column", gap: 2, minWidth: 0 }}>
                  <span style={{ fontSize: 12, fontWeight: 500, color: "var(--color-foreground)" }}>
                    {t(opt.labelKey, { defaultValue: opt.fallback })}
                  </span>
                  <span style={{ fontSize: 10, color: "var(--color-muted)" }}>
                    {t(opt.descKey, { defaultValue: opt.descFallback })}
                  </span>
                </span>
              </button>
            );
          })}

          {isGoalVisible && (
            <button
              type="button"
              onClick={handleToggleGoal}
              className={
                goalModeEnabled
                  ? "creative-mode-option creative-mode-option--selected"
                  : "creative-mode-option"
              }
            >
              <span
                style={{
                  color: goalModeEnabled
                    ? "var(--color-accent-purple)"
                    : "var(--color-muted-foreground)",
                  display: "flex",
                }}
              >
                {GOAL_OPTION.icon}
              </span>
              <span style={{ display: "flex", flexDirection: "column", gap: 2, minWidth: 0 }}>
                <span style={{ fontSize: 12, fontWeight: 500, color: "var(--color-foreground)" }}>
                  {t(GOAL_OPTION.labelKey, { defaultValue: GOAL_OPTION.fallback })}
                </span>
                <span style={{ fontSize: 10, color: "var(--color-muted)" }}>
                  {t(GOAL_OPTION.descKey, { defaultValue: GOAL_OPTION.descFallback })}
                </span>
              </span>
            </button>
          )}

        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// CreativeModeBadge — displayed inside the input area when a mode is active
// ---------------------------------------------------------------------------

export function CreativeModeBadge() {
  const { t } = useTranslation();
  const creativeMode = useAppStore((s) => s.creativeMode);
  const setCreativeMode = useAppStore((s) => s.setCreativeMode);
  const goalModeEnabled = useAppStore((s) => s.goalModeEnabled);
  const setGoalModeEnabled = useAppStore((s) => s.setGoalModeEnabled);

  const opt = MODE_OPTIONS.find((o) => o.id === creativeMode);

  if (creativeMode === "none" && !goalModeEnabled) return null;

  const renderBadge = (key: string, icon: React.ReactNode, label: string, onClose: () => void) => (
    <div
      key={key}
      className="creative-mode-badge"
      style={{
        cursor: "default",
      }}
    >
      <span style={{ display: "flex", color: "var(--color-accent-purple)", flexShrink: 0 }}>
        {icon}
      </span>
      <span
        style={{
          fontSize: 12,
          fontWeight: 500,
          color: "var(--color-accent-purple)",
          lineHeight: 1,
        }}
      >
        {label}
      </span>
      <button
        type="button"
        onClick={onClose}
        style={{
          border: "none",
          background: "none",
          padding: 0,
          cursor: "pointer",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          width: 14,
          height: 14,
          color: "var(--color-accent-purple)",
          opacity: 0.5,
        }}
      >
        <X size={12} />
      </button>
    </div>
  );

  const badges: React.ReactNode[] = [];

  if (opt && creativeMode !== "none") {
    const badgeIcon =
      creativeMode === "pptx" ? (
        <Presentation size={14} />
      ) : creativeMode === "imagegen" ? (
        <ImageIcon size={14} />
      ) : (
        <Palette size={14} />
      );
    badges.push(
      renderBadge(creativeMode, badgeIcon, t(opt.labelKey, { defaultValue: opt.fallback }), () =>
        setCreativeMode("none"),
      ),
    );
  }

  if (goalModeEnabled) {
    badges.push(
      renderBadge(
        "goal",
        <Target size={14} />,
        t(GOAL_OPTION.labelKey, { defaultValue: GOAL_OPTION.fallback }),
        () => setGoalModeEnabled(false),
      ),
    );
  }

  return (
    <div
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 6,
        flexWrap: "nowrap",
        minWidth: 0,
      }}
    >
      {badges}
    </div>
  );
}
