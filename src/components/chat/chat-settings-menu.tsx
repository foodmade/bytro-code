import { useRef, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  SlidersHorizontal,
  Languages,
  Moon,
  TextCursorInput,
  CodeXml,
  ChevronRight,
  Feather,
} from "lucide-react";
import { useSettingsStore } from "@/stores";
import type { ResponseLanguage, AppTheme, CavemanMode } from "@/stores/settings-store";
import { Tooltip } from "@/components/ui";

const CAVEMAN_OPTIONS: ReadonlyArray<CavemanMode> = ["off", "lite", "full", "ultra", "wenyan"];

// ---------------------------------------------------------------------------
// Shared styles from Pencil node d96Wc
// ---------------------------------------------------------------------------

const LABEL_STYLE: React.CSSProperties = {
  fontFamily: "Inter, sans-serif",
  fontSize: 12,
  fontWeight: 500,
  color: "var(--color-foreground)",
  lineHeight: 1.3,
};

const VALUE_STYLE: React.CSSProperties = {
  fontFamily: "Inter, sans-serif",
  fontSize: 11,
  fontWeight: 500,
  color: "var(--color-accent-purple)",
  lineHeight: 1.3,
};

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

/** Toggle switch matching Pencil toggleOn/toggleOff design */
function Toggle({ on, onToggle }: { readonly on: boolean; readonly onToggle: () => void }) {
  return (
    <button
      onClick={onToggle}
      className="flex items-center shrink-0 transition-colors"
      style={{
        width: 34,
        height: 18,
        borderRadius: 9,
        padding: "0 3px",
        backgroundColor: on ? "var(--color-accent-purple)" : "var(--toggle-off-bg)",
        justifyContent: on ? "flex-end" : "flex-start",
        display: "flex",
        cursor: "pointer",
      }}
      aria-checked={on}
      role="switch"
    >
      <div
        style={{
          width: 14,
          height: 14,
          borderRadius: "50%",
          backgroundColor: on ? "#FFFFFF" : "var(--toggle-off-knob)",
          transition: "background-color 150ms ease, transform 150ms ease",
        }}
      />
    </button>
  );
}

/** A menu row with icon + label on left, right content on right. height 38, padding 0 16 */
function MenuRow({
  icon,
  label,
  children,
  onClick,
}: {
  readonly icon: React.ReactNode;
  readonly label: string;
  readonly children: React.ReactNode;
  readonly onClick?: () => void;
}) {
  return (
    <div
      className="flex items-center justify-between native-css-hover"
      style={
        {
          height: 38,
          padding: "0 16px",
          width: "100%",
          backgroundColor: "transparent",
          cursor: onClick ? "pointer" : "default",
          "--native-hover-bg-color": "rgba(var(--hover-overlay-rgb), 0.06)",
        } as React.CSSProperties
      }
      onClick={onClick}
    >
      <div className="flex items-center" style={{ gap: 10 }}>
        {icon}
        <span style={LABEL_STYLE}>{label}</span>
      </div>
      {children}
    </div>
  );
}

/** Horizontal divider: padding 0 16, 1px line #222 */
function Divider() {
  return (
    <div style={{ padding: "0 16px", width: "100%" }}>
      <div style={{ height: 1, backgroundColor: "var(--color-border-subtle)", width: "100%" }} />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Language labels
// ---------------------------------------------------------------------------

const LANGUAGE_LABELS: Record<ResponseLanguage, string> = {
  auto: "Auto",
  en: "EN",
  zh: "中文",
  ja: "日本語",
  ko: "한국어",
  fr: "FR",
  de: "DE",
  es: "ES",
};

const LANGUAGE_OPTIONS: ReadonlyArray<ResponseLanguage> = [
  "auto",
  "en",
  "zh",
  "ja",
  "ko",
  "fr",
  "de",
  "es",
];

const THEME_OPTIONS: ReadonlyArray<AppTheme> = ["light", "dark", "system"];

// ---------------------------------------------------------------------------
// ChatSettingsMenu
// ---------------------------------------------------------------------------

export function ChatSettingsMenu({
  onClose,
}: {
  readonly onClose: () => void;
  readonly conversationId?: string | null;
  readonly paneId?: string | null;
}) {
  const { t } = useTranslation();
  const menuRef = useRef<HTMLDivElement>(null);

  // Settings state
  const responseLanguage = useSettingsStore((s) => s.responseLanguage);
  const setResponseLanguage = useSettingsStore((s) => s.setResponseLanguage);
  const theme = useSettingsStore((s) => s.theme);
  const setTheme = useSettingsStore((s) => s.setTheme);
  const cavemanMode = useSettingsStore((s) => s.cavemanMode);
  const setCavemanMode = useSettingsStore((s) => s.setCavemanMode);
  // Local state for sub-menu pickers
  const [showLangPicker, setShowLangPicker] = useState(false);
  const [showThemePicker, setShowThemePicker] = useState(false);
  const [showCavemanPicker, setShowCavemanPicker] = useState(false);

  // Click outside to close
  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        onClose();
      }
    }
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [onClose]);

  // Escape to close
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [onClose]);

  if (showThemePicker) {
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
          borderRadius: 16,
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
          <Moon size={14} color="var(--color-muted)" />
          <span
            style={{
              fontFamily: "Inter, sans-serif",
              fontSize: 12,
              fontWeight: 600,
              color: "var(--color-muted-foreground)",
            }}
          >
            {t("chat.preferences.theme")}
          </span>
        </div>
        {/* Theme options */}
        <div className="flex flex-col" style={{ padding: "6px 0" }}>
          {THEME_OPTIONS.map((themeOption) => (
            <button
              key={themeOption}
              className="flex items-center justify-between settings-menu-option"
              style={{ height: 36, padding: "0 16px", width: "100%" }}
              onClick={() => {
                setTheme(themeOption);
                setShowThemePicker(false);
              }}
            >
              <span style={LABEL_STYLE}>{t(`settings.appearance.${themeOption}`)}</span>
              {theme === themeOption && (
                <div
                  style={{
                    width: 6,
                    height: 6,
                    borderRadius: "50%",
                    backgroundColor: "var(--color-accent-purple)",
                  }}
                />
              )}
            </button>
          ))}
        </div>
      </div>
    );
  }

  if (showLangPicker) {
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
          borderRadius: 16,
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
          <Languages size={14} color="var(--color-muted)" />
          <span
            style={{
              fontFamily: "Inter, sans-serif",
              fontSize: 12,
              fontWeight: 600,
              color: "var(--color-muted-foreground)",
            }}
          >
            {t("chat.preferences.responseLanguage")}
          </span>
        </div>
        {/* Language options */}
        <div className="flex flex-col" style={{ padding: "6px 0" }}>
          {LANGUAGE_OPTIONS.map((lang) => (
            <button
              key={lang}
              className="flex items-center justify-between settings-menu-option"
              style={{ height: 36, padding: "0 16px", width: "100%" }}
              onClick={() => {
                setResponseLanguage(lang);
                setShowLangPicker(false);
              }}
            >
              <span style={LABEL_STYLE}>{LANGUAGE_LABELS[lang]}</span>
              {responseLanguage === lang && (
                <div
                  style={{
                    width: 6,
                    height: 6,
                    borderRadius: "50%",
                    backgroundColor: "var(--color-accent-purple)",
                  }}
                />
              )}
            </button>
          ))}
        </div>
      </div>
    );
  }

  if (showCavemanPicker) {
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
          borderRadius: 16,
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
          <Feather size={14} color="var(--color-muted)" />
          <span
            style={{
              fontFamily: "Inter, sans-serif",
              fontSize: 12,
              fontWeight: 600,
              color: "var(--color-muted-foreground)",
            }}
          >
            {t("chat.preferences.cavemanMode")}
          </span>
        </div>
        {/* Caveman level options — each level has its own tooltip on the
            right so users can compare verbosity levels without committing. */}
        <div className="flex flex-col" style={{ padding: "6px 0" }}>
          {CAVEMAN_OPTIONS.map((level) => (
            <Tooltip
              key={level}
              content={t(`chat.preferences.cavemanLevelHint.${level}`)}
              placement="right"
              maxWidth={280}
              wrapperStyle={{ display: "block", width: "100%" }}
            >
              <button
                className="flex items-center justify-between settings-menu-option"
                style={{ height: 36, padding: "0 16px", width: "100%" }}
                onClick={() => {
                  setCavemanMode(level);
                  setShowCavemanPicker(false);
                }}
              >
                <span style={LABEL_STYLE}>{t(`settings.general.cavemanLevel.${level}`)}</span>
                {cavemanMode === level && (
                  <div
                    style={{
                      width: 6,
                      height: 6,
                      borderRadius: "50%",
                      backgroundColor: "var(--color-accent-purple)",
                    }}
                  />
                )}
              </button>
            </Tooltip>
          ))}
        </div>
      </div>
    );
  }

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
        backgroundColor: "var(--color-card)",
        border: "1px solid var(--color-border-light)",
        boxShadow: "0 -8px 24px rgba(0,0,0,0.25)",
        overflow: "hidden",
        zIndex: 50,
      }}
    >
      {/* menuHeader (oVZSI) */}
      <div
        className="flex items-center"
        style={{
          gap: 8,
          padding: "10px 16px",
          borderBottom: "1px solid var(--color-border-subtle)",
        }}
      >
        <SlidersHorizontal size={14} color="var(--color-muted)" />
        <span
          style={{
            fontFamily: "Inter, sans-serif",
            fontSize: 12,
            fontWeight: 600,
            color: "var(--color-muted-foreground)",
          }}
        >
          {t("chat.preferences.title")}
        </span>
      </div>

      {/* menuBody (2I01l) */}
      <div className="flex flex-col" style={{ padding: "6px 0" }}>
        {/* Response Language (8Wz4i) */}
        <MenuRow
          icon={<Languages size={14} color="var(--color-muted)" />}
          label={t("chat.preferences.responseLanguage")}
          onClick={() => setShowLangPicker(true)}
        >
          <button
            className="flex items-center hover:opacity-80 transition-opacity"
            style={{ gap: 6 }}
            onClick={() => setShowLangPicker(true)}
          >
            <span style={VALUE_STYLE}>{LANGUAGE_LABELS[responseLanguage]}</span>
            <ChevronRight size={12} color="var(--color-border-strong)" />
          </button>
        </MenuRow>

        {/* Theme (WiIWl) */}
        <MenuRow
          icon={<Moon size={14} color="var(--color-muted)" />}
          label={t("chat.preferences.theme")}
          onClick={() => setShowThemePicker(true)}
        >
          <button
            className="flex items-center hover:opacity-80 transition-opacity"
            style={{ gap: 6 }}
            onClick={() => setShowThemePicker(true)}
          >
            <span style={VALUE_STYLE}>{t(`settings.appearance.${theme}`)}</span>
            <ChevronRight size={12} color="var(--color-border-strong)" />
          </button>
        </MenuRow>

        {/* Caveman Mode (Concise Mode) — tooltip on the right explains the
            feature so users don't have to guess from the label alone. */}
        <Tooltip
          content={t("chat.preferences.cavemanModeHint")}
          placement="right"
          maxWidth={280}
          wrapperStyle={{ display: "block", width: "100%" }}
        >
          <MenuRow
            icon={<Feather size={14} color="var(--color-muted)" />}
            label={t("chat.preferences.cavemanMode")}
            onClick={() => setShowCavemanPicker(true)}
          >
            <button
              className="flex items-center hover:opacity-80 transition-opacity"
              style={{ gap: 6 }}
              onClick={() => setShowCavemanPicker(true)}
            >
              <span style={VALUE_STYLE}>{t(`settings.general.cavemanLevel.${cavemanMode}`)}</span>
              <ChevronRight size={12} color="var(--color-border-strong)" />
            </button>
          </MenuRow>
        </Tooltip>

        <Divider />

        {/* Stream Response (DnVbI) — placeholder, always on */}
        <MenuRow
          icon={<TextCursorInput size={14} color="var(--color-muted)" />}
          label={t("chat.preferences.streamResponse")}
        >
          <Toggle on={true} onToggle={() => {}} />
        </MenuRow>

        {/* Code Highlight (LCFOI) — placeholder, always on */}
        <MenuRow
          icon={<CodeXml size={14} color="var(--color-muted)" />}
          label={t("chat.preferences.codeHighlight")}
        >
          <Toggle on={true} onToggle={() => {}} />
        </MenuRow>
      </div>

      {/* menuFooter (a4Vad) */}
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
            color: "var(--color-border-strong)",
          }}
        >
          {t("chat.preferences.openSettings")}
        </span>
      </div>
    </div>
  );
}
