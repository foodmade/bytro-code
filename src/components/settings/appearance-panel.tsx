import { useMemo, useState } from "react";
import { Check, Copy, Monitor, Moon, Palette, Sun } from "lucide-react";
import { useTranslation } from "react-i18next";
import { cn } from "@/lib/utils";
import {
  CODE_FONT_OPTIONS,
  THEME_PRESETS,
  UI_FONT_OPTIONS,
  sanitizeThemeVariantSettings,
  type ResolvedTheme,
  type ThemeCustomizationSettings,
  type ThemeVariantSettings,
} from "@/lib/theme-customization";
import { useSettingsStore, type AppTheme } from "@/stores";

const BASE_THEME_OPTIONS: ReadonlyArray<{
  readonly value: AppTheme;
  readonly icon: typeof Sun;
  readonly labelKey: string;
}> = [
  { value: "light", icon: Sun, labelKey: "settings.appearance.light" },
  { value: "dark", icon: Moon, labelKey: "settings.appearance.dark" },
  { value: "system", icon: Monitor, labelKey: "settings.appearance.system" },
];

const PRESET_IDS = Object.keys(THEME_PRESETS);

export function AppearancePanel() {
  const { t } = useTranslation();
  const settings = useSettingsStore();
  const [copiedTheme, setCopiedTheme] = useState<ResolvedTheme | null>(null);

  const copyTheme = async (variant: ResolvedTheme) => {
    const payload = JSON.stringify(settings.themeCustomization[variant], null, 2);
    try {
      await navigator.clipboard.writeText(payload);
      setCopiedTheme(variant);
      window.setTimeout(() => setCopiedTheme(null), 1400);
    } catch {
      // Clipboard access can be unavailable in some webview contexts.
    }
  };

  const importTheme = (variant: ResolvedTheme) => {
    const raw = window.prompt(t("settings.appearance.importPrompt"));
    if (!raw) return;
    try {
      const parsed = JSON.parse(raw);
      settings.setThemeVariantSettings(
        variant,
        sanitizeThemeVariantSettings(parsed, settings.themeCustomization[variant]),
      );
    } catch {
      window.alert(t("settings.appearance.importInvalid"));
    }
  };

  return (
    <div className="flex flex-col gap-4">
      <section className="rounded-lg bg-card border border-border-subtle p-4 flex flex-col gap-4">
        <div className="flex flex-wrap items-start gap-3">
          <div
            className="flex items-center justify-center w-9 h-9 rounded-lg shrink-0"
            style={{ backgroundColor: "color-mix(in srgb, var(--color-accent-purple) 16%, transparent)" }}
          >
            <Palette size={16} className="text-accent-purple" />
          </div>
          <div className="flex flex-col gap-0.5 flex-1 min-w-[180px]">
            <span className="text-[14px] font-semibold text-foreground">
              {t("settings.appearance.theme")}
            </span>
            <span className="text-[12px] text-muted">
              {t("settings.appearance.themeDescription")}
            </span>
          </div>
          <div
            className="inline-flex items-center rounded-md border border-border-subtle bg-surface-alt p-0.5"
            role="group"
            aria-label={t("settings.appearance.theme")}
          >
            {BASE_THEME_OPTIONS.map(({ value, icon: Icon, labelKey }) => {
              const active = settings.theme === value;
              return (
                <button
                  key={value}
                  type="button"
                  onClick={() => settings.setTheme(value)}
                  className={cn(
                    "inline-flex h-7 items-center gap-1.5 rounded px-2.5 text-[12px] font-medium transition-colors",
                    active ? "bg-card text-foreground shadow-sm" : "text-muted hover:text-foreground",
                  )}
                >
                  <Icon size={13} />
                  <span>{t(labelKey)}</span>
                </button>
              );
            })}
          </div>
        </div>

        <ThemePreview customization={settings.themeCustomization} />
      </section>

      <div className="grid gap-4" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(300px, 1fr))" }}>
        <ThemeSection
          variant="light"
          copied={copiedTheme === "light"}
          settings={settings.themeCustomization.light}
          onCopy={() => void copyTheme("light")}
          onImport={() => importTheme("light")}
          onPreset={(preset) =>
            settings.setThemeVariantSettings("light", THEME_PRESETS[preset].light)
          }
          onChange={(updates) => settings.setThemeVariantSettings("light", updates)}
        />
        <ThemeSection
          variant="dark"
          copied={copiedTheme === "dark"}
          settings={settings.themeCustomization.dark}
          onCopy={() => void copyTheme("dark")}
          onImport={() => importTheme("dark")}
          onPreset={(preset) =>
            settings.setThemeVariantSettings("dark", THEME_PRESETS[preset].dark)
          }
          onChange={(updates) => settings.setThemeVariantSettings("dark", updates)}
        />
      </div>

      <section className="rounded-lg bg-card border border-border-subtle p-4 flex flex-col gap-3">
        <ToggleRow
          label={t("settings.appearance.pointerCursors")}
          description={t("settings.appearance.pointerCursorsDescription")}
          checked={settings.themeCustomization.pointerCursor}
          accent={settings.themeCustomization.dark.accent}
          onChange={settings.setPointerCursor}
        />
        <ToggleRow
          label={t("settings.appearance.fontSmoothing")}
          description={t("settings.appearance.fontSmoothingDescription")}
          checked={settings.themeCustomization.fontSmoothing !== false}
          accent={settings.themeCustomization.dark.accent}
          onChange={settings.setFontSmoothing}
        />
        <RangeRow
          label={t("settings.appearance.uiFontSize")}
          value={settings.themeCustomization.uiFontSize}
          min={10}
          max={24}
          accent={settings.themeCustomization.dark.accent}
          onChange={settings.setUiFontSize}
        />
        <RangeRow
          label={t("settings.appearance.codeFontSize")}
          value={settings.themeCustomization.codeFontSize}
          min={10}
          max={24}
          accent={settings.themeCustomization.dark.accent}
          onChange={settings.setCodeFontSize}
        />
      </section>
    </div>
  );
}

function ThemePreview({ customization }: { readonly customization: ThemeCustomizationSettings }) {
  return (
    <div className="grid overflow-hidden rounded-md border border-border-subtle" style={{ gridTemplateColumns: "1fr 1fr" }}>
      <PreviewPane variant="light" settings={customization.light} />
      <PreviewPane variant="dark" settings={customization.dark} />
    </div>
  );
}

function PreviewPane({
  variant,
  settings,
}: {
  readonly variant: ResolvedTheme;
  readonly settings: ThemeVariantSettings;
}) {
  const isLight = variant === "light";
  return (
    <div
      className="min-w-0 p-2"
      style={{
        backgroundColor: settings.background,
        color: settings.foreground,
        borderRight: isLight ? "1px solid var(--color-border-subtle)" : undefined,
      }}
    >
      <div
        className="overflow-hidden rounded border"
        style={{
          borderColor: isLight ? "#E2E4E8" : "#2A2A30",
          backgroundColor: isLight ? "#FAFAFA" : "#111114",
          fontFamily: `"${settings.codeFontFamily}", ui-monospace, monospace`,
          fontSize: 11,
          lineHeight: 1.45,
        }}
      >
        <div className="grid" style={{ gridTemplateColumns: "1fr 1fr" }}>
          <CodeDiff side="removed" accent="#ef4444" />
          <CodeDiff side="added" accent="#22c55e" />
        </div>
        <div className="px-2 py-1" style={{ color: isLight ? "#6B7280" : "#9CA3AF" }}>
          {"};"}
        </div>
      </div>
    </div>
  );
}

function CodeDiff({ side, accent }: { readonly side: "added" | "removed"; readonly accent: string }) {
  const bg = side === "added" ? "rgba(34, 197, 94, 0.13)" : "rgba(239, 68, 68, 0.13)";
  const sign = side === "added" ? "+" : "-";
  const values = side === "added" ? ["sidebar-elevated", "#0ee5a7", "68"] : ["sidebar", "#2563eb", "42"];
  return (
    <div className="min-w-0 border-r last:border-r-0" style={{ borderColor: "rgba(127,127,127,0.18)" }}>
      {values.map((value, index) => (
        <div key={value} className="flex min-w-0 gap-1 px-1.5" style={{ backgroundColor: bg }}>
          <span style={{ color: accent, width: 10, textAlign: "right" }}>{index + 1}</span>
          <span style={{ color: accent }}>{sign}</span>
          <span className="truncate">
            {index === 0 ? "surface: " : index === 1 ? "accent: " : "contrast: "}
            <span style={{ color: index === 1 ? accent : undefined }}>"{value}"</span>
          </span>
        </div>
      ))}
    </div>
  );
}

function ThemeSection({
  variant,
  settings,
  copied,
  onChange,
  onCopy,
  onImport,
  onPreset,
}: {
  readonly variant: ResolvedTheme;
  readonly settings: ThemeVariantSettings;
  readonly copied: boolean;
  readonly onChange: (updates: Partial<ThemeVariantSettings>) => void;
  readonly onCopy: () => void;
  readonly onImport: () => void;
  readonly onPreset: (preset: string) => void;
}) {
  const { t } = useTranslation();
  const preset = useMemo(
    () =>
      PRESET_IDS.find((id) => {
        const candidate = THEME_PRESETS[id][variant];
        return (
          candidate.accent.toUpperCase() === settings.accent.toUpperCase() &&
          candidate.background.toUpperCase() === settings.background.toUpperCase() &&
          candidate.foreground.toUpperCase() === settings.foreground.toUpperCase() &&
          candidate.contrast === settings.contrast
        );
      }) ?? "custom",
    [settings, variant],
  );

  return (
    <section className="rounded-lg bg-card border border-border-subtle p-4 flex flex-col gap-3">
      <div className="flex items-center gap-2">
        <span className="text-[13px] font-semibold text-foreground flex-1">
          {t(`settings.appearance.${variant}Theme`)}
        </span>
        <button
          type="button"
          className="text-[11px] text-muted hover:text-foreground transition-colors"
          onClick={onImport}
        >
          {t("settings.appearance.import")}
        </button>
        <button
          type="button"
          className="inline-flex items-center gap-1 text-[11px] text-muted hover:text-foreground transition-colors"
          onClick={onCopy}
        >
          {copied ? <Check size={12} /> : <Copy size={12} />}
          <span>{copied ? t("settings.appearance.copied") : t("settings.appearance.copyTheme")}</span>
        </button>
        <select
          value={preset}
          onChange={(event) => {
            if (event.target.value !== "custom") onPreset(event.target.value);
          }}
          className="h-7 min-w-[132px] max-w-[164px] rounded-md border border-border-subtle bg-surface px-2 text-[12px] text-foreground outline-none focus:border-accent-purple"
        >
          <option value="custom">{t("settings.appearance.custom")}</option>
          {PRESET_IDS.map((id) => (
            <option key={id} value={id}>
              {t(`settings.appearance.presets.${id}`)}
            </option>
          ))}
        </select>
      </div>

      <ColorRow
        label={t("settings.appearance.accent")}
        value={settings.accent}
        onChange={(accent) => onChange({ accent })}
      />
      <ColorRow
        label={t("settings.appearance.background")}
        value={settings.background}
        onChange={(background) => onChange({ background })}
      />
      <ColorRow
        label={t("settings.appearance.foreground")}
        value={settings.foreground}
        onChange={(foreground) => onChange({ foreground })}
      />
      <SelectRow
        label={t("settings.appearance.uiFont")}
        value={settings.uiFontFamily}
        options={UI_FONT_OPTIONS}
        onChange={(uiFontFamily) => onChange({ uiFontFamily })}
      />
      <SelectRow
        label={t("settings.appearance.codeFont")}
        value={settings.codeFontFamily}
        options={CODE_FONT_OPTIONS}
        onChange={(codeFontFamily) => onChange({ codeFontFamily })}
      />
      <ToggleRow
        label={t("settings.appearance.translucentSidebar")}
        checked={settings.translucentSidebar}
        accent={settings.accent}
        onChange={(translucentSidebar) => onChange({ translucentSidebar })}
      />
      <RangeRow
        label={t("settings.appearance.contrast")}
        value={settings.contrast}
        min={0}
        max={100}
        accent={settings.accent}
        suffix=""
        onChange={(contrast) => onChange({ contrast })}
      />
    </section>
  );
}

function ColorRow({
  label,
  value,
  onChange,
}: {
  readonly label: string;
  readonly value: string;
  readonly onChange: (value: string) => void;
}) {
  return (
    <div className="flex items-center gap-3 min-h-8">
      <span className="text-[12px] text-foreground flex-1">{label}</span>
      <label className="relative h-6 w-6 shrink-0 overflow-hidden rounded-full border border-border-subtle">
        <input
          type="color"
          value={value}
          onChange={(event) => onChange(event.target.value)}
          className="absolute inset-[-4px] h-10 w-10 cursor-pointer border-0 p-0"
          aria-label={label}
        />
      </label>
      <span
        className="min-w-[88px] rounded-md border border-border-subtle bg-surface px-2 py-1 text-right text-[11px] font-mono text-foreground"
      >
        {value.toUpperCase()}
      </span>
    </div>
  );
}

function SelectRow<T extends string>({
  label,
  value,
  options,
  onChange,
}: {
  readonly label: string;
  readonly value: T | string;
  readonly options: readonly T[];
  readonly onChange: (value: T) => void;
}) {
  return (
    <div className="flex items-center gap-3 min-h-8">
      <span className="text-[12px] text-foreground flex-1">{label}</span>
      <select
        value={value}
        onChange={(event) => onChange(event.target.value as T)}
        className="h-7 max-w-[170px] rounded-md border border-border-subtle bg-surface px-2 text-[12px] text-foreground outline-none focus:border-accent-purple"
      >
        {options.map((option) => (
          <option key={option} value={option}>
            {option === "system-ui" ? "System UI" : option}
          </option>
        ))}
      </select>
    </div>
  );
}

function ToggleRow({
  label,
  description,
  checked,
  accent,
  onChange,
}: {
  readonly label: string;
  readonly description?: string;
  readonly checked: boolean;
  readonly accent: string;
  readonly onChange: (checked: boolean) => void;
}) {
  return (
    <div className="flex items-center gap-3 min-h-8">
      <div className="flex flex-col flex-1 min-w-0">
        <span className="text-[12px] text-foreground">{label}</span>
        {description && <span className="text-[11px] text-muted truncate">{description}</span>}
      </div>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        onClick={() => onChange(!checked)}
        className="relative h-5 w-9 rounded-full transition-colors"
        style={{ backgroundColor: checked ? accent : "var(--toggle-off-bg)" }}
      >
        <span
          className="absolute top-0.5 h-4 w-4 rounded-full bg-white transition-transform"
          style={{ left: 2, transform: checked ? "translateX(16px)" : "translateX(0)" }}
        />
      </button>
    </div>
  );
}

function RangeRow({
  label,
  value,
  min,
  max,
  accent,
  suffix = "px",
  onChange,
}: {
  readonly label: string;
  readonly value: number;
  readonly min: number;
  readonly max: number;
  readonly accent: string;
  readonly suffix?: string;
  readonly onChange: (value: number) => void;
}) {
  return (
    <div className="flex items-center gap-3 min-h-8">
      <span className="text-[12px] text-foreground flex-1">{label}</span>
      <input
        type="range"
        min={min}
        max={max}
        step={1}
        value={value}
        onChange={(event) => onChange(Number(event.target.value))}
        className="w-28"
        style={{ accentColor: accent }}
      />
      <span className="w-10 text-right text-[12px] text-muted">
        {value}
        {suffix}
      </span>
    </div>
  );
}
