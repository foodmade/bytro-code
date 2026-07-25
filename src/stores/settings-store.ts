import { create } from "zustand";
import { persist, type StateStorage } from "zustand/middleware";
import { load, type Store } from "@tauri-apps/plugin-store";
import { invoke } from "@tauri-apps/api/core";
import { stringifyShortcuts, DEFAULT_SHORTCUTS } from "@/lib/keyboard-shortcuts";
import type { PlatformId, PlatformConfig, ProfileConfig } from "@/lib/platform-config";
import {
  createDefaultPlatforms,
  PLATFORM_REGISTRY,
  sanitizeCustomModels,
  sanitizeProfileProxy,
  getChannelDefaultUrl,
  normalizeModelIdForPlatform,
} from "@/lib/platform-config";
import { track } from "@/lib/tracking";
import {
  DEFAULT_THEME_CUSTOMIZATION,
  sanitizeThemeCustomizationSettings,
  sanitizeThemeVariantSettings,
  type ResolvedTheme,
  type ThemeCustomizationSettings,
  type ThemeVariantSettings,
} from "@/lib/theme-customization";

export type ResponseLanguage = "auto" | "en" | "zh" | "ja" | "ko" | "fr" | "de" | "es";
export type AppTheme = "light" | "dark" | "system";
export type SendKeyType = "enter" | "shift_enter";
export type ReasoningLevel = "off" | "low" | "medium" | "high" | "xhigh" | "max";
export type ModelOptionsPlatformId = "claude" | "codex";
export type ModelContextSize = "standard" | "large";
export interface PlatformModelOptions {
  readonly contextSize: ModelContextSize;
  readonly fastEnabled: boolean;
  readonly ultracodeEnabled: boolean;
}
export type PlatformModelOptionsMap = Record<ModelOptionsPlatformId, PlatformModelOptions>;
export type ImageGenQuality = "low" | "medium" | "high" | "auto";
/** Caveman compression intensity. Each non-"off" level appends a different
 *  ruleset to the system prompt:
 *  - lite: drop filler/hedging only (keep articles, full sentences)
 *  - full: classic caveman — drop articles, fragments OK
 *  - ultra: extreme compression — abbreviations, arrows for causality
 *  - wenyan: Classical Chinese 文言文 (80-90% character reduction)
 *  Currently honored by the Claude provider only (Codex/Gemini/ChatCompletion
 *  are deferred to a later iteration). */
export type CavemanMode = "off" | "lite" | "full" | "ultra" | "wenyan";
/** Concrete sizes accepted by gpt-image-2 (popular presets from OpenAI docs).
 *  All satisfy the model's constraints (max edge 3840, multiples of 16,
 *  ratio ≤ 3:1, total pixels in 655360..8294400). */
export type ImageGenSize =
  | "auto"
  | "1024x1024"
  | "1536x1024"
  | "1024x1536"
  | "2048x2048"
  | "2048x1152"
  | "3840x2160"
  | "2160x3840";
export type GitPlatformId = "github" | "gitee" | "gitlab";

/** Credentials for an arbitrary (self-hosted) Git host. */
export interface GitHostCredential {
  readonly username: string;
  readonly token: string;
}

const DEFAULT_PLATFORM_MODEL_OPTIONS: PlatformModelOptionsMap = {
  claude: { contextSize: "standard", fastEnabled: false, ultracodeEnabled: false },
  codex: { contextSize: "standard", fastEnabled: false, ultracodeEnabled: false },
};

interface SettingsState {
  /** Fixed, non-sensitive error shown when saved settings could not be read. */
  readonly persistenceError: string | null;
  /** Retry reading the saved settings after a transient permission/I/O failure. */
  readonly retryPersistenceLoad: () => Promise<void>;

  // ── Platform-centric configuration ──────────────────────────────────
  readonly activePlatformId: PlatformId;
  readonly platforms: Record<PlatformId, PlatformConfig>;

  // ── Platform actions ────────────────────────────────────────────────
  readonly setActivePlatform: (id: PlatformId) => void;
  readonly setActiveProfile: (platformId: PlatformId, profileId: string) => void;
  readonly setActiveModel: (platformId: PlatformId, modelId: string) => void;
  readonly addProfile: (
    platformId: PlatformId,
    profile: Omit<ProfileConfig, "id" | "testPassed">,
  ) => void;
  readonly updateProfile: (
    platformId: PlatformId,
    profileId: string,
    updates: Partial<Pick<ProfileConfig, "name" | "baseUrl" | "apiKey" | "testPassed" | "proxy">>,
  ) => void;
  readonly removeProfile: (platformId: PlatformId, profileId: string) => void;
  /** Batch-replace entire platforms map (used by settings modal save). */
  readonly setPlatforms: (platforms: Record<PlatformId, PlatformConfig>) => void;

  // ── Non-provider settings (unchanged) ──────────────────────────────
  readonly responseLanguage: ResponseLanguage;
  readonly crossSessionMemory: boolean;
  readonly thinkingEnabled: boolean;
  readonly reasoningLevel: ReasoningLevel;
  readonly platformModelOptions: PlatformModelOptionsMap;
  readonly cavemanMode: CavemanMode;
  readonly imageGenQuality: ImageGenQuality;
  readonly imageGenSize: ImageGenSize;
  /** Absolute path where AI-generated images are saved. Empty string falls
   *  back to the platform default (`<app_data_dir>/outputs`, resolved by
   *  the Rust backend). */
  readonly outputsDir: string;
  readonly proxyEnabled: boolean;
  readonly proxyUrl: string;
  readonly theme: AppTheme;
  readonly themeCustomization: ThemeCustomizationSettings;
  readonly sendKey: SendKeyType;
  readonly keyboardShortcuts: string;
  readonly whisperLanguage: string;
  readonly notificationsEnabled: boolean;
  readonly notificationSoundEnabled: boolean;
  readonly editorFontFamily: string;
  readonly editorFontSize: number;
  readonly workspaceOpenMode: "ask" | "current" | "new";
  readonly gitTokens: Record<GitPlatformId, string>;
  readonly gitUsernames: Record<GitPlatformId, string>;
  /** Credentials for arbitrary (self-hosted) Git hosts, keyed by lowercase
   *  hostname (e.g. "git.example.com"). Saved from the clone auth prompt so
   *  pushes/pulls to self-hosted GitLab/GitHub/Gitea can reuse them. */
  readonly gitHostCredentials: Record<string, GitHostCredential>;
  // ── Non-provider setters ───────────────────────────────────────────
  readonly setResponseLanguage: (lang: ResponseLanguage) => void;
  readonly setCrossSessionMemory: (enabled: boolean) => void;
  readonly setThinkingEnabled: (enabled: boolean) => void;
  readonly setReasoningLevel: (level: ReasoningLevel) => void;
  readonly setPlatformModelOptions: (
    platformId: ModelOptionsPlatformId,
    updates: Partial<PlatformModelOptions>,
  ) => void;
  readonly setPlatformContextSize: (
    platformId: ModelOptionsPlatformId,
    contextSize: ModelContextSize,
  ) => void;
  readonly setPlatformFastEnabled: (platformId: ModelOptionsPlatformId, enabled: boolean) => void;
  readonly setPlatformUltracodeEnabled: (
    platformId: ModelOptionsPlatformId,
    enabled: boolean,
  ) => void;
  readonly setCavemanMode: (mode: CavemanMode) => void;
  readonly setImageGenQuality: (quality: ImageGenQuality) => void;
  readonly setImageGenSize: (size: ImageGenSize) => void;
  readonly setOutputsDir: (dir: string) => void;
  readonly setProxyEnabled: (enabled: boolean) => void;
  readonly setProxyUrl: (url: string) => void;
  readonly setTheme: (theme: AppTheme) => void;
  readonly setThemeVariantSettings: (
    variant: ResolvedTheme,
    updates: Partial<ThemeVariantSettings>,
  ) => void;
  readonly setThemeCustomization: (customization: ThemeCustomizationSettings) => void;
  readonly setPointerCursor: (enabled: boolean) => void;
  readonly setFontSmoothing: (enabled: boolean) => void;
  readonly setUiFontSize: (size: number) => void;
  readonly setCodeFontSize: (size: number) => void;
  readonly setSendKey: (key: SendKeyType) => void;
  readonly setKeyboardShortcuts: (shortcuts: string) => void;
  readonly setWhisperLanguage: (lang: string) => void;
  readonly setNotificationsEnabled: (enabled: boolean) => void;
  readonly setNotificationSoundEnabled: (enabled: boolean) => void;
  readonly setEditorFontFamily: (font: string) => void;
  readonly setEditorFontSize: (size: number) => void;
  readonly setWorkspaceOpenMode: (mode: "ask" | "current" | "new") => void;
  readonly setGitToken: (platform: GitPlatformId, token: string) => void;
  readonly setGitUsername: (platform: GitPlatformId, username: string) => void;
  readonly setGitHostCredential: (host: string, username: string, token: string) => void;
  readonly removeGitHostCredential: (host: string) => void;
  readonly resetToDefaults: () => void;
}

const DEFAULTS = {
  activePlatformId: "claude" as PlatformId,
  platforms: createDefaultPlatforms(),
  responseLanguage: "zh" as ResponseLanguage,
  crossSessionMemory: false,
  thinkingEnabled: true,
  reasoningLevel: "medium" as ReasoningLevel,
  platformModelOptions: DEFAULT_PLATFORM_MODEL_OPTIONS,
  cavemanMode: "off" as CavemanMode,
  imageGenQuality: "low" as ImageGenQuality,
  imageGenSize: "auto" as ImageGenSize,
  outputsDir: "",
  proxyEnabled: false,
  proxyUrl: "",
  theme: "system" as AppTheme,
  themeCustomization: DEFAULT_THEME_CUSTOMIZATION,
  sendKey: "enter" as SendKeyType,
  keyboardShortcuts: stringifyShortcuts(DEFAULT_SHORTCUTS),
  whisperLanguage: "auto",
  notificationsEnabled: true,
  notificationSoundEnabled: true,
  editorFontFamily: "JetBrains Mono",
  editorFontSize: 14,
  workspaceOpenMode: "ask" as const,
  gitTokens: { github: "", gitee: "", gitlab: "" } as Record<GitPlatformId, string>,
  gitUsernames: { github: "", gitee: "", gitlab: "" } as Record<GitPlatformId, string>,
  gitHostCredentials: {} as Record<string, GitHostCredential>,
} as const;

// ── Tauri Store Storage Adapter ──────────────────────────────────────
const STORE_FILE = "settings.json";
export const SETTINGS_PERSISTENCE_READ_ERROR =
  "Saved settings could not be read. Bytro will not overwrite them until you retry successfully.";

let storeInstance: Store | null = null;
let storeLoadPromise: Promise<Store> | null = null;
let settingsWriteQueue: Promise<void> = Promise.resolve();
let latestSettingsPersistenceError: unknown = null;
let settingsReadState: "pending" | "ready" | "failed" = "pending";
let settingsReadError: Error | null = null;

function failSettingsRead(): void {
  settingsReadState = "failed";
  settingsReadError = new Error(SETTINGS_PERSISTENCE_READ_ERROR);
  latestSettingsPersistenceError = settingsReadError;
}

function completeSettingsRead(): void {
  settingsReadState = "ready";
  if (latestSettingsPersistenceError === settingsReadError) {
    latestSettingsPersistenceError = null;
  }
  settingsReadError = null;
}

async function getStore(): Promise<Store> {
  if (storeInstance) {
    return storeInstance;
  }
  if (!storeLoadPromise) {
    storeLoadPromise = (async () => {
      await invoke("harden_settings_store");
      const store = await load(STORE_FILE, { defaults: {}, autoSave: false });
      storeInstance = store;
      return store;
    })().catch((error) => {
      storeLoadPromise = null;
      throw error;
    });
  }
  return storeLoadPromise;
}

async function saveAndHarden(store: Store): Promise<void> {
  await store.save();
  await invoke("harden_settings_store");
}

function enqueueSettingsWrite(operation: (store: Store) => Promise<void>): Promise<void> {
  const queued = settingsWriteQueue.then(async () => {
    const store = await getStore();
    await operation(store);
    await saveAndHarden(store);
  });

  // A failed write is returned to its caller, but must not poison later writes.
  settingsWriteQueue = queued.then(
    () => {
      latestSettingsPersistenceError = null;
    },
    (error) => {
      latestSettingsPersistenceError = error;
    },
  );
  return queued;
}

/** Wait until every settings mutation queued before this call is durable. */
export async function flushSettingsPersistence(): Promise<void> {
  if (settingsReadState === "pending") {
    await useSettingsStore.persist.rehydrate();
  }
  await settingsWriteQueue;
  if (settingsReadState !== "ready") {
    throw settingsReadError ?? new Error(SETTINGS_PERSISTENCE_READ_ERROR);
  }
  if (latestSettingsPersistenceError) {
    throw latestSettingsPersistenceError;
  }
}

const tauriStorage: StateStorage = {
  getItem: async (name: string): Promise<string | null> => {
    try {
      const store = await getStore();
      const value = await store.get<unknown>(name);
      if (
        value !== null &&
        value !== undefined &&
        (typeof value !== "object" ||
          !("state" in value) ||
          typeof value.state !== "object" ||
          value.state === null)
      ) {
        failSettingsRead();
        return null;
      }
      completeSettingsRead();
      return (value as string | null | undefined) ?? null;
    } catch {
      failSettingsRead();
      return null;
    }
  },
  setItem: async (name: string, value: string): Promise<void> => {
    if (settingsReadState !== "ready") {
      latestSettingsPersistenceError =
        settingsReadError ?? new Error(SETTINGS_PERSISTENCE_READ_ERROR);
      return;
    }
    try {
      await enqueueSettingsWrite((store) => store.set(name, value));
    } catch {
      // Failed to persist — state lives in memory
    }
  },
  removeItem: async (name: string): Promise<void> => {
    if (settingsReadState !== "ready") {
      latestSettingsPersistenceError =
        settingsReadError ?? new Error(SETTINGS_PERSISTENCE_READ_ERROR);
      return;
    }
    try {
      await enqueueSettingsWrite(async (store) => {
        await store.delete(name);
      });
    } catch {
      // Failed to remove — non-critical
    }
  },
};

// ── Migration safety ─────────────────────────────────────────────────
type SettingsData = Omit<
  SettingsState,
  | "persistenceError"
  | "retryPersistenceLoad"
  | "setActivePlatform"
  | "setActiveProfile"
  | "setActiveModel"
  | "addProfile"
  | "updateProfile"
  | "removeProfile"
  | "setPlatforms"
  | "setResponseLanguage"
  | "setCrossSessionMemory"
  | "setThinkingEnabled"
  | "setReasoningLevel"
  | "setPlatformModelOptions"
  | "setPlatformContextSize"
  | "setPlatformFastEnabled"
  | "setPlatformUltracodeEnabled"
  | "setCavemanMode"
  | "setImageGenQuality"
  | "setImageGenSize"
  | "setOutputsDir"
  | "setProxyEnabled"
  | "setProxyUrl"
  | "setTheme"
  | "setThemeVariantSettings"
  | "setThemeCustomization"
  | "setPointerCursor"
  | "setFontSmoothing"
  | "setUiFontSize"
  | "setCodeFontSize"
  | "setSendKey"
  | "setKeyboardShortcuts"
  | "setWhisperLanguage"
  | "setNotificationsEnabled"
  | "setNotificationSoundEnabled"
  | "setEditorFontFamily"
  | "setEditorFontSize"
  | "setGitToken"
  | "setGitUsername"
  | "setGitHostCredential"
  | "removeGitHostCredential"
  | "resetToDefaults"
>;

function normalizeRetiredPlatformSelections(
  platforms: Record<PlatformId, PlatformConfig>,
): Record<PlatformId, PlatformConfig> {
  let result = platforms;
  for (const id of Object.keys(platforms) as PlatformId[]) {
    const platform = platforms[id];
    const activeModelId = normalizeModelIdForPlatform(id, platform.activeModelId);
    if (activeModelId === platform.activeModelId) continue;
    if (result === platforms) result = { ...platforms };
    result[id] = { ...platform, activeModelId };
  }
  return result;
}

function sanitizeMigratedState(state: Record<string, unknown>): SettingsData {
  const result: Record<string, unknown> = {};
  for (const key of Object.keys(DEFAULTS)) {
    const val = state[key];
    result[key] = val !== undefined && val !== null ? val : DEFAULTS[key as keyof typeof DEFAULTS];
  }

  const VALID_THEMES: ReadonlySet<string> = new Set(["light", "dark", "system"]);
  if (typeof result.theme !== "string" || !VALID_THEMES.has(result.theme)) {
    result.theme = DEFAULTS.theme;
  }

  result.themeCustomization = sanitizeThemeCustomizationSettings(result.themeCustomization, {
    editorFontFamily: result.editorFontFamily,
    editorFontSize: result.editorFontSize,
  });

  // Validate activePlatformId is a known platform; reset to default if invalid.
  const pid = result.activePlatformId as string | undefined;
  if (!pid || !(pid in PLATFORM_REGISTRY)) {
    result.activePlatformId = DEFAULTS.activePlatformId;
  }

  const platformModelOptions = result.platformModelOptions as Record<string, unknown> | undefined;
  const validatedPlatformModelOptions: PlatformModelOptionsMap = {
    ...DEFAULT_PLATFORM_MODEL_OPTIONS,
  };
  if (platformModelOptions && typeof platformModelOptions === "object") {
    for (const platformId of Object.keys(
      DEFAULT_PLATFORM_MODEL_OPTIONS,
    ) as ModelOptionsPlatformId[]) {
      const option = platformModelOptions[platformId] as Partial<PlatformModelOptions> | undefined;
      if (option && typeof option === "object") {
        validatedPlatformModelOptions[platformId] = {
          contextSize: option.contextSize === "large" ? "large" : "standard",
          fastEnabled: option.fastEnabled === true,
          ultracodeEnabled: option.ultracodeEnabled === true,
        };
      }
    }
  }
  result.platformModelOptions = validatedPlatformModelOptions;

  // Validate cavemanMode against the current allow-list. Defends against
  // cross-version rollbacks, manual edits to the store file, and any future
  // deletion of a level — all of which would otherwise leave the segmented
  // control without an active button (functionally a no-op since the sidecar
  // already returns "" for unknown levels, but visually broken).
  const VALID_CAVEMAN_MODES: ReadonlySet<string> = new Set([
    "off",
    "lite",
    "full",
    "ultra",
    "wenyan",
  ]);
  if (typeof result.cavemanMode !== "string" || !VALID_CAVEMAN_MODES.has(result.cavemanMode)) {
    result.cavemanMode = DEFAULTS.cavemanMode;
  }

  // Deep-validate platforms structure to guard against corrupted persistence.
  // Start from defaults so new platforms are always included, then overlay
  // valid persisted data to preserve user configuration.
  const platforms = result.platforms as Record<string, unknown> | undefined;
  if (!platforms || typeof platforms !== "object") {
    result.platforms = DEFAULTS.platforms;
  } else {
    const defaults = DEFAULTS.platforms;
    const validated = { ...defaults };
    for (const id of Object.keys(defaults) as PlatformId[]) {
      const p = platforms[id] as Record<string, unknown> | undefined;
      if (p && Array.isArray(p.profiles) && p.profiles.length > 0) {
        validated[id] = {
          ...defaults[id],
          ...(p as unknown as PlatformConfig),
          customModels: sanitizeCustomModels(p.customModels),
        };
        validated[id] = {
          ...validated[id],
          profiles: validated[id].profiles.map((profile) => ({
            ...profile,
            proxy: sanitizeProfileProxy(profile.proxy),
          })),
        };
        if (validated[id].sdk !== "codex" && validated[id].sdkOverride === "codex") {
          const fallbackSdk = defaults[id].sdkOverride ?? undefined;
          const fallbackUrl = getChannelDefaultUrl(id, fallbackSdk ?? validated[id].sdk);
          validated[id] = {
            ...validated[id],
            sdkOverride: fallbackSdk,
            profiles: validated[id].profiles.map((profile) =>
              profile.id === validated[id].activeProfileId
                ? { ...profile, baseUrl: fallbackUrl }
                : profile,
            ),
          };
        }
      }
    }
    // Force Ollama to use its native chatcmpl SDK — the Claude route is
    // incompatible (36K system prompt overwhelms local models).  Clear any
    // persisted sdkOverride:"claude" and fix baseUrl to include /v1.
    const ollamaCfg = validated.ollama as PlatformConfig | undefined;
    if (ollamaCfg) {
      let needsUpdate = false;
      let patched = ollamaCfg;
      if (patched.sdkOverride === "claude") {
        patched = { ...patched, sdkOverride: undefined };
        needsUpdate = true;
      }
      // Fix persisted baseUrl missing /v1 suffix (OpenAI SDK needs it)
      if (patched.profiles?.length) {
        const fixedProfiles = patched.profiles.map((p) => {
          if (p.baseUrl === "http://localhost:11434") {
            needsUpdate = true;
            return { ...p, baseUrl: "http://localhost:11434/v1" };
          }
          return p;
        });
        if (needsUpdate) {
          patched = { ...patched, profiles: fixedProfiles };
        }
      }
      if (needsUpdate) {
        validated.ollama = patched;
      }
    }

    result.platforms = normalizeRetiredPlatformSelections(validated);
  }

  return result as SettingsData;
}

// ── Store ────────────────────────────────────────────────────────────
export const useSettingsStore = create<SettingsState>()(
  persist(
    (set, get) => ({
      ...DEFAULTS,
      persistenceError: null,
      retryPersistenceLoad: async () => {
        await useSettingsStore.persist.rehydrate();
        if (settingsReadState !== "ready") {
          throw settingsReadError ?? new Error(SETTINGS_PERSISTENCE_READ_ERROR);
        }
      },

      // ── Platform actions ────────────────────────────────────────────
      setActivePlatform: (id) => {
        track("settings", "settings.provider_switched", { provider: id });
        set({ activePlatformId: id });
        const modelId = get().platforms[id]?.activeModelId;
        if (modelId) {
          invoke("set_last_used_model", { platformId: id, modelId, isOfficial: false }).catch(
            (e) => {
              console.error("[model-memory] save failed:", e);
            },
          );
        }
      },

      setActiveProfile: (platformId, profileId) =>
        set((state) => ({
          platforms: {
            ...state.platforms,
            [platformId]: {
              ...state.platforms[platformId],
              activeProfileId: profileId,
            },
          },
        })),

      setActiveModel: (platformId, modelId) => {
        const nextModelId = normalizeModelIdForPlatform(platformId, modelId);
        track("settings", "settings.model_changed", { model: nextModelId });
        set((state) => ({
          platforms: {
            ...state.platforms,
            [platformId]: {
              ...state.platforms[platformId],
              activeModelId: nextModelId,
            },
          },
        }));
        invoke("set_last_used_model", {
          platformId,
          modelId: nextModelId,
          isOfficial: false,
        }).catch((e) => {
          console.error("[model-memory] save failed:", e);
        });
      },

      addProfile: (platformId, profile) =>
        set((state) => {
          const newProfile: ProfileConfig = {
            ...profile,
            id: crypto.randomUUID(),
            testPassed: false,
          };
          const platform = state.platforms[platformId];
          return {
            platforms: {
              ...state.platforms,
              [platformId]: {
                ...platform,
                profiles: [...platform.profiles, newProfile],
              },
            },
          };
        }),

      updateProfile: (platformId, profileId, updates) =>
        set((state) => {
          const platform = state.platforms[platformId];
          return {
            platforms: {
              ...state.platforms,
              [platformId]: {
                ...platform,
                profiles: platform.profiles.map((p) =>
                  p.id === profileId ? { ...p, ...updates } : p,
                ),
              },
            },
          };
        }),

      removeProfile: (platformId, profileId) =>
        set((state) => {
          const platform = state.platforms[platformId];
          const remaining = platform.profiles.filter((p) => p.id !== profileId);
          if (remaining.length === 0) return state;
          const newActiveProfileId =
            platform.activeProfileId === profileId ? remaining[0].id : platform.activeProfileId;
          return {
            platforms: {
              ...state.platforms,
              [platformId]: {
                ...platform,
                profiles: remaining,
                activeProfileId: newActiveProfileId,
              },
            },
          };
        }),

      setPlatforms: (platforms) =>
        set({
          platforms: normalizeRetiredPlatformSelections(platforms),
        }),

      // ── Non-provider setters ───────────────────────────────────────
      setResponseLanguage: (lang) => set({ responseLanguage: lang }),
      setCrossSessionMemory: (enabled) => set({ crossSessionMemory: enabled }),
      setThinkingEnabled: (enabled) =>
        set((state) => ({
          thinkingEnabled: enabled,
          reasoningLevel: enabled
            ? state.reasoningLevel === "off"
              ? "medium"
              : state.reasoningLevel
            : "off",
        })),
      setReasoningLevel: (level) =>
        set({ reasoningLevel: level, thinkingEnabled: level !== "off" }),
      setPlatformModelOptions: (platformId, updates) =>
        set((state) => ({
          platformModelOptions: {
            ...state.platformModelOptions,
            [platformId]: {
              ...state.platformModelOptions[platformId],
              ...updates,
            },
          },
        })),
      setPlatformContextSize: (platformId, contextSize) =>
        set((state) => ({
          platformModelOptions: {
            ...state.platformModelOptions,
            [platformId]: {
              ...state.platformModelOptions[platformId],
              contextSize,
            },
          },
        })),
      setPlatformFastEnabled: (platformId, enabled) =>
        set((state) => ({
          platformModelOptions: {
            ...state.platformModelOptions,
            [platformId]: {
              ...state.platformModelOptions[platformId],
              fastEnabled: enabled,
            },
          },
        })),
      setPlatformUltracodeEnabled: (platformId, enabled) =>
        set((state) => ({
          platformModelOptions: {
            ...state.platformModelOptions,
            [platformId]: {
              ...state.platformModelOptions[platformId],
              ultracodeEnabled: enabled,
            },
          },
        })),
      setCavemanMode: (mode) => set({ cavemanMode: mode }),
      setImageGenQuality: (quality) => set({ imageGenQuality: quality }),
      setImageGenSize: (size) => set({ imageGenSize: size }),
      setOutputsDir: (dir) => set({ outputsDir: dir }),
      setProxyEnabled: (enabled) => set({ proxyEnabled: enabled }),
      setProxyUrl: (url) => set({ proxyUrl: url }),
      setTheme: (theme) => {
        track("settings", "settings.theme_switched", { theme });
        set({ theme });
      },
      setThemeVariantSettings: (variant, updates) =>
        set((state) => {
          const nextVariant = sanitizeThemeVariantSettings(
            { ...state.themeCustomization[variant], ...updates },
            state.themeCustomization[variant],
          );
          return {
            themeCustomization: {
              ...state.themeCustomization,
              [variant]: nextVariant,
            },
            ...(updates.codeFontFamily ? { editorFontFamily: nextVariant.codeFontFamily } : {}),
          };
        }),
      setThemeCustomization: (customization) =>
        set((state) => {
          const next = sanitizeThemeCustomizationSettings(customization, {
            editorFontFamily: state.editorFontFamily,
            editorFontSize: state.editorFontSize,
          });
          return {
            themeCustomization: next,
            editorFontFamily: next[state.theme === "light" ? "light" : "dark"].codeFontFamily,
            editorFontSize: next.codeFontSize,
          };
        }),
      setPointerCursor: (enabled) =>
        set((state) => ({
          themeCustomization: { ...state.themeCustomization, pointerCursor: enabled },
        })),
      setFontSmoothing: (enabled) =>
        set((state) => ({
          themeCustomization: { ...state.themeCustomization, fontSmoothing: enabled },
        })),
      setUiFontSize: (size) =>
        set((state) => ({
          themeCustomization: {
            ...state.themeCustomization,
            uiFontSize: Math.min(24, Math.max(10, Math.round(size))),
          },
        })),
      setCodeFontSize: (size) =>
        set((state) => {
          const nextSize = Math.min(24, Math.max(10, Math.round(size)));
          return {
            themeCustomization: { ...state.themeCustomization, codeFontSize: nextSize },
            editorFontSize: nextSize,
          };
        }),
      setSendKey: (key) => set({ sendKey: key }),
      setKeyboardShortcuts: (shortcuts) => set({ keyboardShortcuts: shortcuts }),
      setWhisperLanguage: (lang) => set({ whisperLanguage: lang }),
      setNotificationsEnabled: (enabled) => set({ notificationsEnabled: enabled }),
      setNotificationSoundEnabled: (enabled) => set({ notificationSoundEnabled: enabled }),
      setEditorFontFamily: (font) => set({ editorFontFamily: font }),
      setEditorFontSize: (size) => set({ editorFontSize: size }),
      setWorkspaceOpenMode: (mode) => set({ workspaceOpenMode: mode }),
      setGitToken: (platform, token) =>
        set((state) => ({
          gitTokens: { ...state.gitTokens, [platform]: token },
        })),
      setGitUsername: (platform, username) =>
        set((state) => ({
          gitUsernames: { ...state.gitUsernames, [platform]: username },
        })),
      setGitHostCredential: (host, username, token) =>
        set((state) => {
          const key = host.trim().toLowerCase();
          if (!key) return {};
          return {
            gitHostCredentials: {
              ...state.gitHostCredentials,
              [key]: { username: username.trim(), token },
            },
          };
        }),
      removeGitHostCredential: (host) =>
        set((state) => {
          const key = host.trim().toLowerCase();
          if (!(key in state.gitHostCredentials)) return {};
          const next = { ...state.gitHostCredentials };
          delete next[key];
          return { gitHostCredentials: next };
        }),
      resetToDefaults: () => set({ ...DEFAULTS }),
    }),
    {
      name: "bytro-settings",
      version: 53,
      storage: tauriStorage as never,
      partialize: (state) =>
        Object.fromEntries(
          Object.keys(DEFAULTS).map((key) => [key, state[key as keyof typeof DEFAULTS]]),
        ) as unknown as SettingsData,
      onRehydrateStorage: () => () => {
        const persistenceError =
          settingsReadState === "failed" ? SETTINGS_PERSISTENCE_READ_ERROR : null;
        if (useSettingsStore.getState().persistenceError !== persistenceError) {
          useSettingsStore.setState({ persistenceError });
        }
      },
      migrate: (persisted, version) => {
        const state = persisted as Record<string, unknown>;

        // v27 → v28: Complete platform-centric rewrite.
        // Old provider fields are dropped; users must re-configure.
        if (version < 28) {
          state.activePlatformId = DEFAULTS.activePlatformId;
          state.platforms = DEFAULTS.platforms;
        }

        // v28 → v29: Add reasoningLevel, migrate from thinkingEnabled boolean.
        if (version < 29) {
          const wasEnabled = state.thinkingEnabled !== false;
          state.reasoningLevel = wasEnabled ? "medium" : "off";
        }

        // v31 → v32: Align ReasoningLevel with SDK EffortLevel.
        // "minimal" → "low" (xhigh is now a valid level, no longer mapped to max)
        if (version < 32) {
          const level = state.reasoningLevel as string | undefined;
          if (level === "minimal") state.reasoningLevel = "low";
        }

        // v39 → v40: Opus 4.6 / Sonnet 4.6 context 1M is now GA; the
        // legacy `context-1m-2025-08-07` beta retires 2026-04-30.
        // Migrate persisted "-1m" model IDs to their base IDs.
        if (version < 40) {
          const platforms = state.platforms as Record<string, Record<string, unknown>> | undefined;
          if (platforms && typeof platforms === "object") {
            for (const cfg of Object.values(platforms)) {
              const modelId = cfg.activeModelId as string | undefined;
              if (typeof modelId === "string" && modelId.endsWith("-1m")) {
                cfg.activeModelId = modelId.slice(0, -"-1m".length);
              }
            }
          }
        }

        // v41 → v42: add `outputsDir` (AI image save directory). Empty string
        // means "use the platform default" — `sanitizeMigratedState` already
        // backfills missing keys from DEFAULTS, so no explicit assignment is
        // needed; this case is documented for posterity.
        // if (version < 42) { /* no-op */ }

        // v42 → v43: add `cavemanMode`. Existing users default to "off" so
        // behavior is unchanged until they explicitly enable it. Backfill
        // happens automatically via `sanitizeMigratedState`; documented here
        // so the version bump has a paper trail.
        // if (version < 43) { /* no-op */ }

        // v43 → v44: add platform-level model options for Claude/Codex.
        // `sanitizeMigratedState` validates and backfills missing nested keys.
        // if (version < 44) { /* no-op */ }

        // v44 → v45: add platform-level custom models. Existing platform
        // configs are backfilled and validated by `sanitizeMigratedState`.
        // if (version < 45) { /* no-op */ }

        // v45 → v46: add per-profile Claude/Codex agent proxy settings.
        // `sanitizeMigratedState` validates and backfills profile proxy fields.
        // if (version < 46) { /* no-op */ }

        // v46 → v47: remove the deprecated app-wide proxy setting from the
        // settings UI. Clear persisted values so old installs do not keep
        // routing app requests through an invisible global proxy.
        if (version < 47) {
          state.proxyEnabled = false;
          state.proxyUrl = "";
        }

        // v47 -> v48: Codex-style appearance customization. Existing editor
        // font preferences seed the new code font controls.
        if (version < 48) {
          state.themeCustomization = sanitizeThemeCustomizationSettings(state.themeCustomization, {
            editorFontFamily: state.editorFontFamily,
            editorFontSize: state.editorFontSize,
          });
        }

        // v48 -> v49: add font smoothing preference. Existing installs keep
        // macOS-style antialiasing enabled by default.
        if (version < 49) {
          state.themeCustomization = sanitizeThemeCustomizationSettings(state.themeCustomization, {
            editorFontFamily: state.editorFontFamily,
            editorFontSize: state.editorFontSize,
          });
        }

        // v49 -> v50: add `gitHostCredentials` for self-hosted Git host
        // credentials. `sanitizeMigratedState` backfills the empty default
        // automatically; documented here so the version bump has a paper trail.
        // if (version < 50) { /* no-op */ }

        // v50 -> v51: soften the default light-theme background from stark
        // white (#ffffff) to a warm paper tone, closer to Claude Desktop's
        // look. Only migrate installs still on the fully untouched old
        // default (all four light seed values unchanged) — anyone who
        // customized accent/background/foreground/contrast, even back to
        // white deliberately, keeps their explicit choice.
        if (version < 51) {
          const light = (
            state.themeCustomization as { light?: Record<string, unknown> } | undefined
          )?.light;
          const stillDefault =
            typeof light?.background === "string" &&
            light.background.toUpperCase() === "#FFFFFF" &&
            typeof light?.accent === "string" &&
            light.accent.toUpperCase() === "#2085FF" &&
            typeof light?.foreground === "string" &&
            light.foreground.toUpperCase() === "#0D0D0D" &&
            light?.contrast === 45;
          if (light && stillDefault) {
            light.background = DEFAULT_THEME_CUSTOMIZATION.light.background;
          }
        }

        // v51 -> v52: lighten the default dark-theme background from a
        // near-black (#18181b, contrast 60) to a softer charcoal
        // (#202124, contrast 48), closer to the Codex/ChatGPT family of dark
        // themes — the old combination pushed inset surfaces close to pure
        // black. Only migrate installs still on the fully untouched old
        // dark default — anyone who customized accent/background/
        // foreground/contrast keeps their explicit choice.
        if (version < 52) {
          const dark = (state.themeCustomization as { dark?: Record<string, unknown> } | undefined)
            ?.dark;
          const stillDefault =
            typeof dark?.background === "string" &&
            dark.background.toUpperCase() === "#18181B" &&
            typeof dark?.accent === "string" &&
            dark.accent.toUpperCase() === "#339CFF" &&
            typeof dark?.foreground === "string" &&
            dark.foreground.toUpperCase() === "#FFFFFF" &&
            dark?.contrast === 60;
          if (dark && stillDefault) {
            dark.background = DEFAULT_THEME_CUSTOMIZATION.dark.background;
            dark.contrast = DEFAULT_THEME_CUSTOMIZATION.dark.contrast;
          }
        }

        // v52 -> v53: fully retire GPT-5.1/5.2. Persisted custom selections
        // must not bypass the reduced model lists on any platform.
        if (version < 53) {
          const platforms = state.platforms as Record<string, Record<string, unknown>> | undefined;
          if (platforms && typeof platforms === "object") {
            for (const id of Object.keys(PLATFORM_REGISTRY) as PlatformId[]) {
              const platform = platforms[id];
              const modelId = platform?.activeModelId;
              if (typeof modelId === "string") {
                platform.activeModelId = normalizeModelIdForPlatform(id, modelId);
              }
            }
          }
        }

        return sanitizeMigratedState(state);
      },
    },
  ),
);
