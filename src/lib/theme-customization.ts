export type ResolvedTheme = "light" | "dark";

export interface ThemeVariantSettings {
  readonly accent: string;
  readonly background: string;
  readonly foreground: string;
  readonly uiFontFamily: string;
  readonly codeFontFamily: string;
  readonly translucentSidebar: boolean;
  readonly contrast: number;
}

export interface ThemeCustomizationSettings {
  readonly light: ThemeVariantSettings;
  readonly dark: ThemeVariantSettings;
  readonly pointerCursor: boolean;
  readonly fontSmoothing: boolean;
  readonly uiFontSize: number;
  readonly codeFontSize: number;
}

export const UI_FONT_OPTIONS = [
  "Inter",
  "system-ui",
  "Plus Jakarta Sans",
  "DM Sans",
  "Manrope",
  "Outfit",
  "Sora",
] as const;

export const CODE_FONT_OPTIONS = [
  "JetBrains Mono",
  "SF Mono",
  "Fira Code",
  "Cascadia Code",
  "Source Code Pro",
  "Menlo",
  "Monaco",
  "Consolas",
] as const;

export const DEFAULT_THEME_CUSTOMIZATION: ThemeCustomizationSettings = {
  light: {
    accent: "#2085ff",
    background: "#FAF9F5",
    foreground: "#0d0d0d",
    uiFontFamily: "Inter",
    codeFontFamily: "JetBrains Mono",
    translucentSidebar: true,
    contrast: 45,
  },
  dark: {
    accent: "#339cff",
    background: "#202124",
    foreground: "#ffffff",
    uiFontFamily: "Inter",
    codeFontFamily: "JetBrains Mono",
    translucentSidebar: true,
    contrast: 48,
  },
  pointerCursor: false,
  fontSmoothing: true,
  uiFontSize: 14,
  codeFontSize: 14,
};

export const THEME_PRESETS: Record<
  string,
  Readonly<Record<ResolvedTheme, Pick<ThemeVariantSettings, "accent" | "background" | "foreground" | "contrast">>>
> = {
  default: {
    light: {
      accent: DEFAULT_THEME_CUSTOMIZATION.light.accent,
      background: DEFAULT_THEME_CUSTOMIZATION.light.background,
      foreground: DEFAULT_THEME_CUSTOMIZATION.light.foreground,
      contrast: DEFAULT_THEME_CUSTOMIZATION.light.contrast,
    },
    dark: {
      accent: DEFAULT_THEME_CUSTOMIZATION.dark.accent,
      background: DEFAULT_THEME_CUSTOMIZATION.dark.background,
      foreground: DEFAULT_THEME_CUSTOMIZATION.dark.foreground,
      contrast: DEFAULT_THEME_CUSTOMIZATION.dark.contrast,
    },
  },
  codex: {
    light: { accent: "#2085FF", background: "#FFFFFF", foreground: "#0D0D0D", contrast: 45 },
    dark: { accent: "#339CFF", background: "#202124", foreground: "#FFFFFF", contrast: 48 },
  },
  catppuccin: {
    light: { accent: "#8839EF", background: "#EFF1F5", foreground: "#4C4F69", contrast: 45 },
    dark: { accent: "#CBA6F7", background: "#1E1E2E", foreground: "#CDD6F4", contrast: 60 },
  },
  dracula: {
    light: { accent: "#7C4DFF", background: "#F8F8F2", foreground: "#282A36", contrast: 48 },
    dark: { accent: "#FF79C6", background: "#282A36", foreground: "#F8F8F2", contrast: 60 },
  },
  github: {
    light: { accent: "#0969DA", background: "#FFFFFF", foreground: "#24292F", contrast: 48 },
    dark: { accent: "#58A6FF", background: "#0D1117", foreground: "#C9D1D9", contrast: 62 },
  },
  nord: {
    light: { accent: "#5E81AC", background: "#ECEFF4", foreground: "#2E3440", contrast: 46 },
    dark: { accent: "#88C0D0", background: "#2E3440", foreground: "#ECEFF4", contrast: 58 },
  },
  tokyoNight: {
    light: { accent: "#34548A", background: "#D5D6DB", foreground: "#343B58", contrast: 52 },
    dark: { accent: "#7AA2F7", background: "#1A1B26", foreground: "#C0CAF5", contrast: 62 },
  },
  rosePine: {
    light: { accent: "#907AA9", background: "#FAF4ED", foreground: "#575279", contrast: 44 },
    dark: { accent: "#C4A7E7", background: "#191724", foreground: "#E0DEF4", contrast: 58 },
  },
  everforest: {
    light: { accent: "#3A94C5", background: "#FDF6E3", foreground: "#5C6A72", contrast: 47 },
    dark: { accent: "#A7C080", background: "#2D353B", foreground: "#D3C6AA", contrast: 57 },
  },
  graphite: {
    light: { accent: "#3B82F6", background: "#F4F6F8", foreground: "#1F2937", contrast: 50 },
    dark: { accent: "#8AB4F8", background: "#202124", foreground: "#E8EAED", contrast: 58 },
  },
  ayu: {
    light: { accent: "#D18616", background: "#FAF6ED", foreground: "#25303B", contrast: 46 },
    dark: { accent: "#FFB454", background: "#0F1419", foreground: "#E6E1CF", contrast: 60 },
  },
  solarized: {
    light: { accent: "#268BD2", background: "#FDF6E3", foreground: "#586E75", contrast: 47 },
    dark: { accent: "#2AA198", background: "#002B36", foreground: "#93A1A1", contrast: 58 },
  },
  monokai: {
    light: { accent: "#B36B00", background: "#F7F3E8", foreground: "#3B332F", contrast: 48 },
    dark: { accent: "#A6E22E", background: "#272822", foreground: "#F8F8F2", contrast: 60 },
  },
  gruvbox: {
    light: { accent: "#B57614", background: "#FBF1C7", foreground: "#3C3836", contrast: 48 },
    dark: { accent: "#FABD2F", background: "#282828", foreground: "#EBDBB2", contrast: 59 },
  },
  kanagawa: {
    light: { accent: "#6A5ACD", background: "#F2ECDE", foreground: "#54546D", contrast: 47 },
    dark: { accent: "#7E9CD8", background: "#1F1F28", foreground: "#DCD7BA", contrast: 59 },
  },
  material: {
    light: { accent: "#00796B", background: "#FAFBFC", foreground: "#263238", contrast: 49 },
    dark: { accent: "#80CBC4", background: "#101820", foreground: "#EEFFFF", contrast: 60 },
  },
};

const HEX_COLOR_RE = /^#[0-9a-fA-F]{6}$/;

interface Rgb {
  readonly r: number;
  readonly g: number;
  readonly b: number;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function sanitizeHexColor(value: unknown, fallback: string): string {
  if (typeof value !== "string") return fallback;
  const normalized = value.trim();
  return HEX_COLOR_RE.test(normalized) ? normalized.toUpperCase() : fallback;
}

function sanitizeFontFamily(value: unknown, fallback: string): string {
  if (typeof value !== "string") return fallback;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > 80) return fallback;
  return trimmed.replace(/["']/g, "");
}

function sanitizeNumber(value: unknown, fallback: number, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return clamp(Math.round(value), min, max);
}

export function sanitizeThemeVariantSettings(
  value: unknown,
  fallback: ThemeVariantSettings,
): ThemeVariantSettings {
  const raw = value && typeof value === "object" ? value as Record<string, unknown> : {};
  return {
    accent: sanitizeHexColor(raw.accent, fallback.accent),
    background: sanitizeHexColor(raw.background, fallback.background),
    foreground: sanitizeHexColor(raw.foreground, fallback.foreground),
    uiFontFamily: sanitizeFontFamily(raw.uiFontFamily, fallback.uiFontFamily),
    codeFontFamily: sanitizeFontFamily(raw.codeFontFamily, fallback.codeFontFamily),
    translucentSidebar:
      typeof raw.translucentSidebar === "boolean"
        ? raw.translucentSidebar
        : fallback.translucentSidebar,
    contrast: sanitizeNumber(raw.contrast, fallback.contrast, 0, 100),
  };
}

export function sanitizeThemeCustomizationSettings(
  value: unknown,
  legacy?: Readonly<{ editorFontFamily?: unknown; editorFontSize?: unknown }>,
): ThemeCustomizationSettings {
  const raw = value && typeof value === "object" ? value as Record<string, unknown> : {};
  const legacyCodeFont = sanitizeFontFamily(
    legacy?.editorFontFamily,
    DEFAULT_THEME_CUSTOMIZATION.dark.codeFontFamily,
  );
  const legacyCodeSize = sanitizeNumber(
    legacy?.editorFontSize,
    DEFAULT_THEME_CUSTOMIZATION.codeFontSize,
    10,
    24,
  );
  const fallback: ThemeCustomizationSettings = {
    ...DEFAULT_THEME_CUSTOMIZATION,
    light: { ...DEFAULT_THEME_CUSTOMIZATION.light, codeFontFamily: legacyCodeFont },
    dark: { ...DEFAULT_THEME_CUSTOMIZATION.dark, codeFontFamily: legacyCodeFont },
    codeFontSize: legacyCodeSize,
  };

  return {
    light: sanitizeThemeVariantSettings(raw.light, fallback.light),
    dark: sanitizeThemeVariantSettings(raw.dark, fallback.dark),
    pointerCursor:
      typeof raw.pointerCursor === "boolean" ? raw.pointerCursor : fallback.pointerCursor,
    fontSmoothing:
      typeof raw.fontSmoothing === "boolean" ? raw.fontSmoothing : fallback.fontSmoothing,
    uiFontSize: sanitizeNumber(raw.uiFontSize, fallback.uiFontSize, 10, 24),
    codeFontSize: sanitizeNumber(raw.codeFontSize, fallback.codeFontSize, 10, 24),
  };
}

function hexToRgb(hex: string): Rgb {
  const clean = sanitizeHexColor(hex, "#000000").slice(1);
  return {
    r: Number.parseInt(clean.slice(0, 2), 16),
    g: Number.parseInt(clean.slice(2, 4), 16),
    b: Number.parseInt(clean.slice(4, 6), 16),
  };
}

function rgbToHex({ r, g, b }: Rgb): string {
  const toHex = (value: number) => clamp(Math.round(value), 0, 255).toString(16).padStart(2, "0");
  return `#${toHex(r)}${toHex(g)}${toHex(b)}`.toUpperCase();
}

function mix(a: string, b: string, amountB: number): string {
  const ca = hexToRgb(a);
  const cb = hexToRgb(b);
  const bWeight = clamp(amountB, 0, 1);
  const aWeight = 1 - bWeight;
  return rgbToHex({
    r: ca.r * aWeight + cb.r * bWeight,
    g: ca.g * aWeight + cb.g * bWeight,
    b: ca.b * aWeight + cb.b * bWeight,
  });
}

function rgba(hex: string, alpha: number): string {
  const c = hexToRgb(hex);
  return `rgba(${c.r}, ${c.g}, ${c.b}, ${clamp(alpha, 0, 1).toFixed(2)})`;
}

function rgbTriplet(hex: string): string {
  const c = hexToRgb(hex);
  return `${c.r}, ${c.g}, ${c.b}`;
}

function relativeLuminance(hex: string): number {
  const { r, g, b } = hexToRgb(hex);
  const channel = (value: number) => {
    const normalized = value / 255;
    return normalized <= 0.03928
      ? normalized / 12.92
      : ((normalized + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

function readableOn(hex: string): string {
  return relativeLuminance(hex) > 0.48 ? "#111111" : "#FFFFFF";
}

function readableAccent(hex: string, bg: string, fg: string): string {
  return relativeLuminance(hex) > relativeLuminance(bg)
    ? mix(hex, fg, 0.16)
    : mix(hex, fg, 0.24);
}

export function fontStack(fontFamily: string, kind: "ui" | "code"): string {
  const fallback =
    kind === "ui"
      ? "system-ui, -apple-system, BlinkMacSystemFont, sans-serif"
      : "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace";
  const font = sanitizeFontFamily(fontFamily, kind === "ui" ? "Inter" : "JetBrains Mono");
  if (font === "system-ui") return fallback;
  if (font === "SF Mono") return `"SF Mono", ${fallback}`;
  return `"${font} Variable", "${font}", ${fallback}`;
}

export function createThemeCssVariables(
  customization: ThemeCustomizationSettings,
  resolved: ResolvedTheme,
): Record<string, string> {
  const theme = customization[resolved];
  const isLight = resolved === "light";
  const contrast = theme.contrast / 100;
  const bg = theme.background;
  const fg = theme.foreground;
  const baseOpposite = isLight ? "#000000" : "#ffffff";
  const surface = mix(bg, baseOpposite, isLight ? 0.025 + contrast * 0.035 : 0.035 + contrast * 0.045);
  const surfaceAlt = mix(bg, baseOpposite, isLight ? 0.045 + contrast * 0.035 : 0.02 + contrast * 0.035);
  const surfaceDark = mix(bg, isLight ? "#000000" : "#000000", isLight ? 0.10 + contrast * 0.04 : 0.16 + contrast * 0.08);
  const surfaceInset = mix(bg, isLight ? "#000000" : "#000000", isLight ? 0.07 + contrast * 0.04 : 0.08 + contrast * 0.06);
  const raised = mix(bg, baseOpposite, isLight ? 0.01 + contrast * 0.025 : 0.065 + contrast * 0.055);
  const border = mix(bg, fg, isLight ? 0.10 + contrast * 0.13 : 0.10 + contrast * 0.12);
  const borderStrong = mix(bg, fg, isLight ? 0.22 + contrast * 0.15 : 0.20 + contrast * 0.18);
  const muted = mix(bg, fg, isLight ? 0.56 : 0.58);
  const mutedForeground = mix(bg, fg, isLight ? 0.68 : 0.72);
  const success = isLight ? "#168A56" : "#6BCB8E";
  const danger = isLight ? "#C2414B" : "#F87171";
  const warning = isLight ? "#B7791F" : "#F5B84B";
  const info = readableAccent(theme.accent, bg, fg);
  const sidebarSolid = surface;
  const sidebarTranslucent = rgba(surface, theme.translucentSidebar ? 0.78 : 1);
  const accentSoft = rgba(theme.accent, isLight ? 0.12 : 0.16);
  const accentSofter = rgba(theme.accent, isLight ? 0.075 : 0.105);
  const hoverOverlayRgb = isLight ? "0, 0, 0" : "255, 255, 255";
  const popupBg = rgba(isLight ? mix(bg, "#FFFFFF", 0.78) : mix(bg, "#000000", 0.10), 0.96);
  const popupBorder = rgba(fg, isLight ? 0.11 : 0.09);
  const cardShadow = isLight
    ? "0 0 0 0.5px rgba(0, 0, 0, 0.045), 0 1px 2px rgba(0, 0, 0, 0.04), 0 10px 26px rgba(0, 0, 0, 0.07)"
    : "0 0 0 0.5px rgba(255, 255, 255, 0.04), 0 1px 3px rgba(0, 0, 0, 0.22), 0 10px 30px rgba(0, 0, 0, 0.32)";
  const floatShadow = isLight
    ? "0 0 0 0.5px rgba(0, 0, 0, 0.055), 0 8px 24px rgba(15, 23, 42, 0.10), 0 20px 54px rgba(15, 23, 42, 0.14)"
    : "0 0 0 0.5px rgba(255, 255, 255, 0.06), 0 8px 28px rgba(0, 0, 0, 0.34), 0 20px 60px rgba(0, 0, 0, 0.48)";
  const userBubble = isLight ? mix(theme.accent, "#FFFFFF", 0.82) : mix(theme.accent, bg, 0.68);
  const userBubbleBorder = mix(userBubble, theme.accent, isLight ? 0.28 : 0.36);
  const userBubbleText = readableOn(userBubble);
  const mcpPurpleSoft = isLight ? mix(theme.accent, "#FFFFFF", 0.88) : mix(theme.accent, bg, 0.78);
  const mcpBlueSoft = isLight ? mix(info, "#FFFFFF", 0.86) : mix(info, bg, 0.78);
  const mcpGreenBg = rgba(success, isLight ? 0.14 : 0.16);
  const mcpRedBg = rgba(danger, isLight ? 0.13 : 0.16);
  const mcpAmberBg = rgba(warning, isLight ? 0.15 : 0.17);

  return {
    "--hover-overlay-rgb": hoverOverlayRgb,
    "--popup-bg": popupBg,
    "--popup-border": popupBorder,
    "--popup-shadow": floatShadow,
    "--toggle-off-bg": isLight ? mix(bg, fg, 0.18) : mix(bg, fg, 0.16),
    "--toggle-off-knob": isLight ? "#FFFFFF" : mix(bg, fg, 0.48),
    "--color-background": bg,
    "--color-foreground": fg,
    "--color-surface": surface,
    "--color-surface-alt": surfaceAlt,
    "--color-surface-dark": surfaceDark,
    "--color-surface-inset": surfaceInset,
    "--color-surface-raised": raised,
    "--color-topbar": bg,
    "--color-card": isLight ? mix(bg, "#ffffff", 0.4) : mix(bg, fg, 0.06),
    "--color-border": border,
    "--color-border-subtle": mix(bg, fg, isLight ? 0.075 + contrast * 0.09 : 0.075 + contrast * 0.1),
    "--color-border-light": mix(bg, fg, isLight ? 0.15 + contrast * 0.12 : 0.14 + contrast * 0.14),
    "--color-border-strong": borderStrong,
    "--color-accent-purple": theme.accent,
    "--color-accent-blue": theme.accent,
    "--color-accent-purple-10": rgba(theme.accent, 0.10),
    "--color-accent-soft": accentSoft,
    "--color-accent-softer": accentSofter,
    "--color-on-accent": readableOn(theme.accent),
    "--color-accent-info": info,
    "--color-accent-success": success,
    "--color-accent-danger": danger,
    "--color-accent-amber": warning,
    "--color-accent-amber-muted": rgba(warning, isLight ? 0.13 : 0.16),
    "--color-muted": muted,
    "--color-muted-foreground": mutedForeground,
    "--color-text-tertiary": mix(bg, fg, isLight ? 0.58 : 0.62),
    "--color-text-placeholder": mix(bg, fg, isLight ? 0.48 : 0.52),
    "--color-text-dim": mix(bg, fg, isLight ? 0.42 : 0.36),
    "--font-sans": fontStack(theme.uiFontFamily, "ui"),
    "--font-mono": fontStack(theme.codeFontFamily, "code"),
    "--bytro-ui-font-size": `${customization.uiFontSize}px`,
    "--bytro-code-font-size": `${customization.codeFontSize}px`,
    "--shadow-card": cardShadow,
    "--shadow-popup": floatShadow,
    "--shadow-float": floatShadow,
    "--shadow-message": cardShadow,
    "--shadow-tooltip": isLight ? "0 4px 20px rgba(15, 23, 42, 0.14)" : "0 4px 20px rgba(0, 0, 0, 0.64)",
    "--color-hover-overlay": isLight ? "#000000" : "#FFFFFF",
    "--color-user-bubble": userBubble,
    "--color-user-bubble-border": userBubbleBorder,
    "--color-user-bubble-text": userBubbleText,
    "--color-git-entry-bg": isLight ? mix(theme.accent, "#FFFFFF", 0.88) : mix(theme.accent, bg, 0.82),
    "--color-git-entry-bg-active": isLight ? mix(theme.accent, "#FFFFFF", 0.78) : mix(theme.accent, bg, 0.68),
    "--theme-sidebar-bg-solid": sidebarSolid,
    "--theme-sidebar-bg-translucent": sidebarTranslucent,
    "--bytro-editor-bg": bg,
    "--bytro-editor-fg": fg,
    "--bytro-editor-chrome-bg": surface,
    "--bytro-editor-toolbar-bg": bg,
    "--bytro-editor-tab-bg": surface,
    "--bytro-editor-tab-active-bg": bg,
    "--bytro-editor-tab-hover-bg": raised,
    "--bytro-editor-border": border,
    "--bytro-editor-border-subtle": mix(bg, fg, isLight ? 0.08 : 0.12),
    "--bytro-editor-scrollbar-thumb": mix(bg, fg, isLight ? 0.30 : 0.22),
    "--bytro-editor-scrollbar-thumb-hover": mix(bg, fg, isLight ? 0.42 : 0.34),
    "--bytro-editor-gutter-bg": bg,
    "--bytro-editor-gutter-border": mix(bg, fg, isLight ? 0.07 : 0.10),
    "--bytro-editor-line-number": mix(bg, fg, isLight ? 0.48 : 0.42),
    "--bytro-editor-line-number-active": fg,
    "--bytro-editor-line-highlight-bg": mix(bg, fg, isLight ? 0.035 : 0.055),
    "--bytro-editor-widget-bg": surface,
    "--bytro-editor-widget-fg": fg,
    "--bytro-editor-widget-border": borderStrong,
    "--bytro-editor-widget-shadow": floatShadow,
    "--bytro-editor-widget-row-hover-bg": rgba(fg, isLight ? 0.055 : 0.075),
    "--bytro-editor-widget-row-active-bg": rgba(theme.accent, isLight ? 0.12 : 0.18),
    "--bytro-editor-widget-highlight": info,
    "--bytro-editor-widget-muted": muted,
    "--bytro-editor-widget-code-bg": surfaceInset,
    "--bytro-editor-menu-bg": surface,
    "--bytro-editor-menu-border": borderStrong,
    "--bytro-editor-menu-separator": border,
    "--bytro-editor-menu-row-hover-bg": accentSofter,
    "--bytro-editor-menu-row-focus-bg": mix(theme.accent, bg, isLight ? 0.14 : 0.20),
    "--bytro-editor-indent-guide": rgba(fg, isLight ? 0.10 : 0.12),
    "--bytro-editor-indent-guide-active": rgba(theme.accent, isLight ? 0.28 : 0.34),
    "--bytro-editor-token-comment": mix(bg, fg, isLight ? 0.50 : 0.54),
    "--bytro-editor-token-keyword": isLight ? mix(theme.accent, "#5B21B6", 0.32) : mix(theme.accent, "#FFFFFF", 0.24),
    "--bytro-editor-token-string": success,
    "--bytro-editor-token-number": warning,
    "--bytro-editor-token-type": info,
    "--bytro-editor-token-function": mix(theme.accent, fg, isLight ? 0.24 : 0.30),
    "--bytro-editor-token-property": mix(info, fg, isLight ? 0.18 : 0.24),
    "--bytro-editor-token-operator": mix(bg, fg, isLight ? 0.64 : 0.78),
    "--bytro-editor-token-delimiter": muted,
    "--mcp-card": mix(surface, bg, isLight ? 0.28 : 0.18),
    "--mcp-elevated": raised,
    "--mcp-input": surfaceInset,
    "--mcp-input-hover": raised,
    "--mcp-sunken": surfaceDark,
    "--mcp-chip": surfaceInset,
    "--mcp-btn": raised,
    "--mcp-btn-hover": mix(raised, fg, isLight ? 0.08 : 0.10),
    "--mcp-border": border,
    "--mcp-border-hover": borderStrong,
    "--mcp-divider": border,
    "--mcp-text-strong": fg,
    "--mcp-text": mutedForeground,
    "--mcp-text-muted": muted,
    "--mcp-text-faint": mix(bg, fg, isLight ? 0.42 : 0.46),
    "--mcp-text-faintest": mix(bg, fg, isLight ? 0.30 : 0.34),
    "--mcp-text-hover": fg,
    "--mcp-purple-soft": mcpPurpleSoft,
    "--mcp-purple-soft-hover": mix(mcpPurpleSoft, theme.accent, isLight ? 0.10 : 0.16),
    "--mcp-purple-icon-bg": mcpPurpleSoft,
    "--mcp-purple-border": mix(theme.accent, bg, isLight ? 0.42 : 0.54),
    "--mcp-purple-border-soft": rgba(theme.accent, isLight ? 0.24 : 0.28),
    "--mcp-purple-text": readableAccent(theme.accent, bg, fg),
    "--mcp-purple-chip": rgba(theme.accent, isLight ? 0.12 : 0.16),
    "--mcp-purple-chip-hover": rgba(theme.accent, isLight ? 0.18 : 0.23),
    "--mcp-purple-strong": theme.accent,
    "--mcp-blue-soft": mcpBlueSoft,
    "--mcp-blue-border": mix(info, bg, isLight ? 0.46 : 0.56),
    "--mcp-blue-text": info,
    "--mcp-green-text": success,
    "--mcp-green-bg": mcpGreenBg,
    "--mcp-green-border": rgba(success, isLight ? 0.30 : 0.34),
    "--mcp-red": danger,
    "--mcp-red-soft": mix(danger, fg, isLight ? 0.10 : 0.18),
    "--mcp-red-bg": mcpRedBg,
    "--mcp-red-border": rgba(danger, isLight ? 0.28 : 0.34),
    "--mcp-amber": warning,
    "--mcp-amber-text": warning,
    "--mcp-amber-text-soft": mix(warning, fg, isLight ? 0.18 : 0.28),
    "--mcp-amber-bg": mcpAmberBg,
    "--mcp-amber-bg-icon": rgba(warning, isLight ? 0.18 : 0.22),
    "--mcp-amber-border": rgba(warning, isLight ? 0.32 : 0.36),
    "--mcp-amber-badge-border": rgba(warning, isLight ? 0.36 : 0.42),
    "--mcp-amber-badge-hover": rgba(warning, isLight ? 0.22 : 0.28),
    "--theme-accent-rgb": rgbTriplet(theme.accent),
  };
}
