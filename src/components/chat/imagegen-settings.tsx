/**
 * Image-generation settings entry + popup menu.
 *
 * Surfaces image quality / size pickers next to the chat-input toolbar when
 * the imagegen creative mode is active. Per-conversation overrides live in
 * `imagegen-prefs-store` so settings in conversation A don't leak into B.
 * Designed in pencil node Gyu9J.
 */

import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Image as ImageIcon, ChevronUp, Check } from "lucide-react";
import { useSettingsStore, useImagegenPrefsStore, imagegenScopeKey } from "@/stores";
import type { ImageGenQuality, ImageGenSize } from "@/stores/settings-store";
import { Tooltip } from "@/components/ui";

const IMAGE_QUALITY_OPTIONS: ReadonlyArray<ImageGenQuality> = ["auto", "low", "medium", "high"];
const IMAGE_SIZE_OPTIONS: ReadonlyArray<ImageGenSize> = [
  "auto",
  "1024x1024",
  "1536x1024",
  "1024x1536",
  "2048x2048",
  "2048x1152",
  "3840x2160",
  "2160x3840",
];

const ROW_STYLE: React.CSSProperties = {
  height: 34,
  padding: "0 16px",
  width: "100%",
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  cursor: "pointer",
};

const SECTION_TITLE_STYLE: React.CSSProperties = {
  fontFamily: "Inter, sans-serif",
  fontSize: 10,
  fontWeight: 600,
  letterSpacing: 0.5,
  color: "var(--color-muted)",
  textTransform: "uppercase",
  padding: "8px 16px 4px 16px",
};

const OPTION_LABEL_STYLE: React.CSSProperties = {
  fontFamily: "Inter, sans-serif",
  fontSize: 12,
  fontWeight: 500,
  lineHeight: 1.3,
};

// ---------------------------------------------------------------------------
// Hook: per-scope effective quality/size with setters that write to scope
// ---------------------------------------------------------------------------

interface ImagegenScopeProps {
  readonly conversationId?: string | null;
  readonly paneId?: string | null;
}

function useImagegenScope({ conversationId, paneId }: ImagegenScopeProps) {
  const scopeKey = useMemo(
    () => imagegenScopeKey(conversationId, paneId),
    [conversationId, paneId],
  );

  const defaultQuality = useSettingsStore((s) => s.imageGenQuality);
  const defaultSize = useSettingsStore((s) => s.imageGenSize);
  const override = useImagegenPrefsStore((s) => s.overrides[scopeKey]);
  const setQualityScoped = useImagegenPrefsStore((s) => s.setQuality);
  const setSizeScoped = useImagegenPrefsStore((s) => s.setSize);

  const quality = override?.quality ?? defaultQuality;
  const size = override?.size ?? defaultSize;

  const setQuality = useCallback(
    (q: ImageGenQuality) => setQualityScoped(scopeKey, q),
    [scopeKey, setQualityScoped],
  );
  const setSize = useCallback(
    (s: ImageGenSize) => setSizeScoped(scopeKey, s),
    [scopeKey, setSizeScoped],
  );

  return { quality, size, setQuality, setSize, scopeKey };
}

function MenuOption({
  selected,
  onClick,
  children,
}: {
  readonly selected: boolean;
  readonly onClick: () => void;
  readonly children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      className="flex items-center justify-between w-full native-css-hover"
      style={
        {
          ...ROW_STYLE,
          backgroundColor: selected
            ? "color-mix(in srgb, var(--color-accent-purple) 12%, transparent)"
            : "transparent",
          "--native-hover-bg-color": !selected ? "rgba(var(--hover-overlay-rgb), 0.06)" : undefined,
          border: "none",
        } as React.CSSProperties
      }
    >
      <span
        style={{
          ...OPTION_LABEL_STYLE,
          color: selected ? "var(--color-foreground)" : "var(--color-muted-foreground)",
        }}
      >
        {children}
      </span>
      {selected && <Check size={14} color="var(--color-accent-purple)" />}
    </button>
  );
}

// ---------------------------------------------------------------------------
// Popup menu
// ---------------------------------------------------------------------------

function ImagegenSettingsMenu({
  onClose,
  conversationId,
  paneId,
}: {
  readonly onClose: () => void;
  readonly conversationId?: string | null;
  readonly paneId?: string | null;
}) {
  const { t } = useTranslation();
  const menuRef = useRef<HTMLDivElement>(null);
  const { quality, size, setQuality, setSize } = useImagegenScope({ conversationId, paneId });

  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        onClose();
      }
    }
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [onClose]);

  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [onClose]);

  return (
    <div
      ref={menuRef}
      className="flex flex-col"
      style={{
        position: "absolute",
        bottom: "100%",
        left: 0,
        marginBottom: 8,
        width: 280,
        borderRadius: 12,
        background: "var(--popup-bg)",
        backdropFilter: "blur(20px)",
        WebkitBackdropFilter: "blur(20px)",
        border: "1px solid var(--popup-border)",
        boxShadow: "var(--popup-shadow)",
        overflow: "hidden",
        zIndex: 50,
      }}
    >
      {/* Header */}
      <div
        className="flex items-center"
        style={{
          gap: 8,
          padding: "10px 16px",
          borderBottom: "1px solid var(--color-border-subtle)",
        }}
      >
        <ImageIcon size={14} color="var(--color-accent-purple)" />
        <span
          style={{
            fontFamily: "Inter, sans-serif",
            fontSize: 12,
            fontWeight: 600,
            color: "var(--color-foreground)",
          }}
        >
          {t("chat.imagegenSettings.title")}
        </span>
      </div>

      <div className="flex flex-col" style={{ padding: "4px 0 8px 0" }}>
        {/* Quality section */}
        <div style={SECTION_TITLE_STYLE}>{t("chat.preferences.imageQuality")}</div>
        {IMAGE_QUALITY_OPTIONS.map((q) => (
          <MenuOption key={q} selected={quality === q} onClick={() => setQuality(q)}>
            {t(`chat.preferences.imageQualities.${q}`)}
          </MenuOption>
        ))}

        {/* Divider */}
        <div
          style={{
            height: 1,
            backgroundColor: "var(--color-border-subtle)",
            width: "100%",
            margin: "6px 0",
          }}
        />

        {/* Size section */}
        <div style={SECTION_TITLE_STYLE}>{t("chat.preferences.imageSize")}</div>
        {IMAGE_SIZE_OPTIONS.map((s) => (
          <MenuOption key={s} selected={size === s} onClick={() => setSize(s)}>
            {t(`chat.preferences.imageSizes.${s}`)}
          </MenuOption>
        ))}
      </div>

      {/* Footer */}
      <div
        className="flex items-center justify-center"
        style={{
          padding: "8px 16px",
          borderTop: "1px solid var(--color-border-subtle)",
        }}
      >
        <span
          style={{
            fontFamily: "Inter, sans-serif",
            fontSize: 10,
            fontWeight: 400,
            color: "var(--color-text-tertiary)",
          }}
        >
          {t("chat.imagegenSettings.footnote")}
        </span>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Entry button
// ---------------------------------------------------------------------------

/** Compact, multi-state summary describing the currently chosen quality + size. */
function describeShort(t: (k: string) => string, q: ImageGenQuality, s: ImageGenSize): string {
  const qLabel = t(`chat.imagegenSettings.qualityShort.${q}`);
  const sLabel = s === "auto" ? t("chat.imagegenSettings.sizeShort.auto") : s.replace("x", "×");
  return `${qLabel} · ${sLabel}`;
}

interface ImagegenSettingsButtonProps {
  readonly conversationId?: string | null;
  readonly paneId?: string | null;
}

export const ImagegenSettingsButton = memo(function ImagegenSettingsButton({
  conversationId,
  paneId,
}: ImagegenSettingsButtonProps = {}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const toggle = useCallback(() => setOpen((prev) => !prev), []);
  const close = useCallback(() => setOpen(false), []);
  const { quality, size } = useImagegenScope({ conversationId, paneId });
  const customized = quality !== "auto" || size !== "auto";

  const summary = describeShort(t, quality, size);

  // Visual states match pencil node Gyu9J (idle/active).
  const idleBg = "color-mix(in srgb, var(--color-accent-purple) 8%, transparent)";
  const activeBg = "color-mix(in srgb, var(--color-accent-purple) 12%, transparent)";
  const idleBorder = "color-mix(in srgb, var(--color-accent-purple) 28%, transparent)";
  const activeBorder = "var(--color-accent-purple)";

  return (
    <div className="relative flex items-center">
      <Tooltip content={t("chat.imagegenSettings.entryTooltip")} placement="top" disabled={open}>
        <button
          type="button"
          onClick={toggle}
          aria-label={t("chat.imagegenSettings.entryTooltip")}
          className="flex items-center transition-colors cursor-pointer"
          style={{
            height: 26,
            padding: "0 10px",
            gap: 6,
            borderRadius: 13,
            border: `1px solid ${customized || open ? activeBorder : idleBorder}`,
            background: open ? activeBg : idleBg,
            color: "var(--color-accent-purple)",
          }}
        >
          <ImageIcon size={13} />
          <span
            style={{
              fontFamily: "Inter, sans-serif",
              fontSize: 11,
              fontWeight: customized ? 600 : 500,
              lineHeight: 1.2,
              whiteSpace: "nowrap",
            }}
          >
            {summary}
          </span>
          <ChevronUp
            size={11}
            style={{
              transition: "transform 150ms ease",
              transform: open ? "rotate(180deg)" : "rotate(0deg)",
            }}
          />
        </button>
      </Tooltip>
      {open && (
        <ImagegenSettingsMenu onClose={close} conversationId={conversationId} paneId={paneId} />
      )}
    </div>
  );
});
