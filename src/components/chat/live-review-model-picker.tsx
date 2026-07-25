import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { ChevronDown, Check } from "lucide-react";
import { useLiveReviewStore } from "@/stores/live-review-store";
import { useSettingsStore } from "@/stores/settings-store";
import { useRemoteModelsStore } from "@/stores/remote-models-store";
import {
  USER_SELECTABLE_PLATFORM_IDS,
  DISABLED_PLATFORMS,
  PLATFORM_REGISTRY,
  getDisplayModelsForPlatform,
  getCustomModelsForActiveProfile,
  resolveActiveCredentials,
  type PlatformId,
} from "@/lib/platform-config";

// ---------------------------------------------------------------------------
// LiveReviewModelPicker — lightweight independent model selector for the
// reviewer.  Does NOT touch the main chat platform/model.
// ---------------------------------------------------------------------------

const ROW_BG_SELECTED_REST = "color-mix(in srgb, var(--color-accent-purple) 12%, transparent)";
const ROW_BG_SELECTED_HOVER = "color-mix(in srgb, var(--color-accent-purple) 22%, transparent)";
const ROW_BG_HOVER = "color-mix(in srgb, var(--color-accent-purple)  8%, transparent)";

function rowHoverVars(selected: boolean, disabled = false): React.CSSProperties {
  if (disabled) return {};
  return {
    "--native-hover-bg-color": selected ? ROW_BG_SELECTED_HOVER : ROW_BG_HOVER,
  } as React.CSSProperties;
}

export function LiveReviewModelPicker() {
  const { t } = useTranslation();
  const providerOverride = useLiveReviewStore((s) => s.providerOverride);
  const setProviderOverride = useLiveReviewStore((s) => s.setProviderOverride);
  const mainPlatformId = useSettingsStore((s) => s.activePlatformId);
  const platforms = useSettingsStore((s) => s.platforms);
  // Remote (chatcmpl) model cache — keeps the picker in sync with the latest
  // provider catalog (e.g. DeepSeek, Qwen) instead of the bundled fallback
  // list, mirroring `model-selector.tsx`.
  const remoteProviders = useRemoteModelsStore((s) => s.providers);
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const popupRef = useRef<HTMLDivElement>(null);

  // Close on outside click / Escape
  useEffect(() => {
    if (!open) return;
    const onClick = (e: MouseEvent) => {
      if (
        popupRef.current &&
        !popupRef.current.contains(e.target as Node) &&
        triggerRef.current &&
        !triggerRef.current.contains(e.target as Node)
      ) {
        setOpen(false);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onClick);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onClick);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  // ── Compute current label ──────────────────────────────────────────────
  // Guard against persisted `platformId` values that reference a platform
  // which no longer exists
  //      in `PLATFORM_REGISTRY` (deprecated / removed since the value was
  //      written).  Both must fall back to the "use main" label instead of
  //      throwing on `undefined.defaultModel`.
  const overridePlatformMeta =
    providerOverride.platformId
      ? (PLATFORM_REGISTRY[providerOverride.platformId] ?? null)
      : null;
  const isUsingMain = !overridePlatformMeta;

  // Trigger shows ONLY the model name (no platform prefix); the platform is
  // signalled by the colored dot to the left of the trigger.  This is the
  // pencil-redesign convention and saves the horizontal space that used to
  // make the toolbar overlap the title at narrow panel widths.
  let triggerLabel: string;
  let triggerColor = "var(--color-muted-foreground)";
  if (overridePlatformMeta && providerOverride.platformId) {
    const modelId = providerOverride.modelId ?? overridePlatformMeta.defaultModel;
    const modelsForPlatform = getDisplayModelsForPlatform(
      providerOverride.platformId,
      remoteProviders[providerOverride.platformId]?.models,
      getCustomModelsForActiveProfile(platforms[providerOverride.platformId]),
    );
    const modelEntry = modelsForPlatform.find((m) => m.id === modelId);
    triggerLabel = modelEntry?.label ?? modelId;
    triggerColor = overridePlatformMeta.color;
  } else {
    triggerLabel = t("chat.codeReview.liveReview.useMainModel");
  }

  // ── Selection handler ────────────────────────────────────────────────
  const handleSelectMain = useCallback(() => {
    setProviderOverride(null, null);
    setOpen(false);
  }, [setProviderOverride]);

  const handleSelect = useCallback(
    (platformId: PlatformId, modelId: string) => {
      setProviderOverride(platformId, modelId);
      setOpen(false);
    },
    [setProviderOverride],
  );

  return (
    <div style={{ position: "relative", flexShrink: 0 }}>
      <button
        ref={triggerRef}
        type="button"
        onClick={() => setOpen((v) => !v)}
        title={t("chat.codeReview.liveReview.modelLabel")}
        style={{
          display: "flex",
          alignItems: "center",
          gap: 6,
          height: 28,
          maxWidth: 200,
          padding: "0 10px 0 8px",
          borderRadius: 8,
          border: "1px solid var(--color-border)",
          backgroundColor: "var(--color-surface)",
          fontFamily: "var(--font-sans)",
          fontSize: 11,
          fontWeight: 500,
          color: "var(--color-foreground)",
          cursor: "pointer",
        }}
      >
        {/* Platform color dot — replaces the redundant "Claude · " prefix
            so the trigger stays narrow and the panel header doesn't overlap
            the title region at small widths. */}
        <span
          aria-hidden="true"
          style={{
            width: 6,
            height: 6,
            borderRadius: "50%",
            backgroundColor: triggerColor,
            flexShrink: 0,
          }}
        />
        <span
          style={{
            whiteSpace: "nowrap",
            overflow: "hidden",
            textOverflow: "ellipsis",
            maxWidth: 160,
          }}
        >
          {triggerLabel}
        </span>
        <ChevronDown size={12} style={{ flexShrink: 0, color: "var(--color-muted)" }} />
      </button>

      {open && (
        <div
          ref={popupRef}
          style={{
            position: "absolute",
            top: "calc(100% + 4px)",
            right: 0,
            width: 260,
            maxHeight: 400,
            overflowY: "auto",
            zIndex: 100,
            backgroundColor: "var(--color-surface)",
            border: "1px solid var(--color-border)",
            borderRadius: "var(--radius-md)",
            boxShadow: "var(--shadow-popup)",
            padding: 4,
          }}
        >
          {/* Same as main chat */}
          <button
            type="button"
            onClick={handleSelectMain}
            className="native-css-hover"
            style={
              {
                width: "100%",
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                padding: "6px 10px",
                borderRadius: "var(--radius-sm)",
                border: "none",
                backgroundColor: isUsingMain ? ROW_BG_SELECTED_REST : "transparent",
                cursor: "pointer",
                fontFamily: "var(--font-sans)",
                fontSize: 12,
                color: "var(--color-foreground)",
                textAlign: "left",
                ...rowHoverVars(isUsingMain),
              } as React.CSSProperties
            }
          >
            <span>
              {t("chat.codeReview.liveReview.useMainModel")}
              {(() => {
                // Resolve the parenthetical label that hints at *which* model
                // the main chat is currently bound to.  Same defensive lookup
                // as the trigger: a persisted `activePlatformId` may reference
                // a platform that has since been removed from the registry,
                // in which case we drop the hint rather than crash.
                const mainHint = PLATFORM_REGISTRY[mainPlatformId]?.displayName ?? null;
                if (!mainHint) return null;
                return (
                  <span
                    style={{
                      marginLeft: 6,
                      fontSize: 10,
                      color: "var(--color-muted)",
                    }}
                  >
                    ({mainHint})
                  </span>
                );
              })()}
            </span>
            {isUsingMain && <Check size={12} style={{ color: "var(--color-accent-purple)" }} />}
          </button>

          <div
            style={{
              height: 1,
              margin: "4px 6px",
              backgroundColor: "var(--color-border)",
            }}
          />

          {USER_SELECTABLE_PLATFORM_IDS.map((platformId) => {
            if (DISABLED_PLATFORMS.has(platformId)) return null;
            const meta = PLATFORM_REGISTRY[platformId];
            const platformConfig = platforms[platformId];
            // Show ONLY platforms the user has actually configured (i.e. an
            // active profile carries a non-empty API key).  Listing the full
            // PLATFORM_REGISTRY made the popup a wall of unselectable models.
            // The reviewer routes through `ai_code_review_stream` which needs
            // real credentials anyway, so unconfigured rows would just error.
            if (!platformConfig || !resolveActiveCredentials(platformConfig)) return null;
            const models = getDisplayModelsForPlatform(
              platformId,
              remoteProviders[platformId]?.models,
              getCustomModelsForActiveProfile(platformConfig),
            );
            // Honour the user's pinned/active model from main settings as a hint
            const pinnedModel = platformConfig?.activeModelId;

            return (
              <div key={platformId} style={{ marginTop: 4 }}>
                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 6,
                    padding: "4px 10px",
                    fontFamily: "var(--font-sans)",
                    fontSize: 10,
                    fontWeight: 600,
                    textTransform: "uppercase",
                    letterSpacing: "0.04em",
                    color: meta.color,
                  }}
                >
                  <span
                    style={{
                      width: 6,
                      height: 6,
                      borderRadius: "50%",
                      backgroundColor: meta.color,
                    }}
                  />
                  {meta.displayName}
                </div>
                {models.map((m) => {
                  const selected =
                    providerOverride.platformId === platformId &&
                    (providerOverride.modelId ?? meta.defaultModel) === m.id;
                  const isPinned = pinnedModel === m.id;
                  return (
                    <button
                      key={`${platformId}::${m.id}`}
                      type="button"
                      onClick={() => handleSelect(platformId, m.id)}
                      className="native-css-hover"
                      style={
                        {
                          width: "100%",
                          display: "flex",
                          alignItems: "center",
                          justifyContent: "space-between",
                          padding: "5px 10px 5px 22px",
                          borderRadius: "var(--radius-sm)",
                          border: "none",
                          backgroundColor: selected ? ROW_BG_SELECTED_REST : "transparent",
                          cursor: "pointer",
                          fontFamily: "var(--font-mono)",
                          fontSize: 11,
                          color: "var(--color-foreground)",
                          textAlign: "left",
                          ...rowHoverVars(selected),
                        } as React.CSSProperties
                      }
                    >
                      <span
                        style={{
                          whiteSpace: "nowrap",
                          overflow: "hidden",
                          textOverflow: "ellipsis",
                          flex: 1,
                          minWidth: 0,
                        }}
                      >
                        {m.label || m.id}
                        {isPinned && (
                          <span
                            style={{
                              marginLeft: 6,
                              fontSize: 9,
                              color: "var(--color-muted)",
                              fontFamily: "var(--font-sans)",
                            }}
                          >
                            ★
                          </span>
                        )}
                      </span>
                      {selected && (
                        <Check
                          size={11}
                          style={{ color: meta.color, flexShrink: 0, marginLeft: 6 }}
                        />
                      )}
                    </button>
                  );
                })}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// LiveReviewModeToggle — segmented control for Lite vs Deep
// ---------------------------------------------------------------------------

export function LiveReviewModeToggle() {
  const { t } = useTranslation();
  const mode = useLiveReviewStore((s) => s.mode);
  const setMode = useLiveReviewStore((s) => s.setMode);

  return (
    <div
      style={{
        display: "inline-flex",
        alignItems: "center",
        height: 28,
        padding: 3,
        borderRadius: 8,
        border: "1px solid var(--color-border)",
        backgroundColor: "var(--color-surface)",
      }}
    >
      <button
        type="button"
        onClick={() => setMode("lite")}
        title={t("chat.codeReview.liveReview.modeLiteDesc")}
        style={{
          height: "100%",
          padding: "0 10px",
          display: "inline-flex",
          alignItems: "center",
          justifyContent: "center",
          borderRadius: 6,
          border: "none",
          fontFamily: "var(--font-sans)",
          fontSize: 11,
          fontWeight: mode === "lite" ? 600 : 500,
          cursor: "pointer",
          backgroundColor:
            mode === "lite"
              ? "color-mix(in srgb, var(--color-accent-purple) 15%, transparent)"
              : "transparent",
          color: mode === "lite" ? "var(--color-accent-purple)" : "var(--color-muted-foreground)",
        }}
      >
        {t("chat.codeReview.liveReview.modeLite")}
      </button>
      <button
        type="button"
        // Phase 2: Deep mode is gated.  Clicking shows a tooltip but does not
        // switch the mode (silently no-op).
        onClick={() => {
          // no-op: deep mode coming next iteration
        }}
        title={t("chat.codeReview.liveReview.modeDeepComingSoon")}
        disabled
        style={{
          height: "100%",
          padding: "0 10px",
          display: "inline-flex",
          alignItems: "center",
          justifyContent: "center",
          borderRadius: 6,
          border: "none",
          fontFamily: "var(--font-sans)",
          fontSize: 11,
          fontWeight: 500,
          cursor: "not-allowed",
          backgroundColor: "transparent",
          color: "var(--color-muted)",
          opacity: 0.6,
        }}
      >
        {t("chat.codeReview.liveReview.modeDeep")}
      </button>
    </div>
  );
}
