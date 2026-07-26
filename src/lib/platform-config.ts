// src/lib/platform-config.ts
// All platform-related constants, types, model lists, and UI metadata.

import {
  filterRetiredGptModels,
  isRetiredGptModel,
  normalizeRetiredGptModelId,
} from "@/lib/model-retirement";

// ======================== Types ========================

export type SdkType = "claude" | "codex" | "gemini" | "chatcmpl";

export type PlatformId =
  | "claude" | "codex" | "gemini"
  | "grok" | "deepseek" | "qwen" | "bigmodel" | "mimo" | "minimax" | "kimi"
  | "ollama";

/** Authentication method for a profile.
 *  "apiKey" (default when undefined) — user-provided Base URL + API key.
 *  "oauth" — provider subscription login. Raw provider tokens stay outside Zustand. */
export type AuthMode = "apiKey" | "oauth";
export type ProfileProxyMode = "http" | "https" | "socks5";

export interface ProfileProxyConfig {
  readonly enabled: boolean;
  readonly mode: ProfileProxyMode;
  readonly host: string;
  readonly port: string;
  readonly username?: string;
  readonly password?: string;
}

export interface CodexRateLimitWindow {
  readonly usedPercent: number;
  readonly windowDurationMins: number | null;
  readonly resetsAt: number | null;
}

export interface CodexRateLimits {
  readonly primary?: CodexRateLimitWindow;
  readonly secondary?: CodexRateLimitWindow;
}

export interface ProfileConfig {
  readonly id: string;
  readonly name: string;
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly testPassed: boolean;
  readonly proxy?: ProfileProxyConfig;
  readonly authMode?: AuthMode;
  readonly oauthAccountEmail?: string;
  readonly oauthPlan?: string;
  readonly oauthExpiresAt?: number;
  readonly oauthRateLimits?: CodexRateLimits;
}

export interface PlatformConfig {
  readonly id: PlatformId;
  readonly sdk: SdkType;
  /** Override the SDK channel used for API routing. When set, requests use this
   *  SDK's protocol instead of the platform's native one. Useful for routing
   *  Chinese model providers (Qwen/DeepSeek/BigModel) through a relay that
   *  speaks the Anthropic Messages protocol. */
  readonly sdkOverride?: SdkType;
  /** Remembered base URLs per SDK channel, so switching channels restores
   *  the user's previously configured URL for that channel. */
  readonly channelUrls?: Partial<Record<SdkType, string>>;
  readonly profiles: readonly ProfileConfig[];
  readonly activeProfileId: string;
  readonly activeModelId: string;
  readonly customModels?: readonly ModelEntry[];
}

export type ModelTier = "fable" | "flagship" | "balanced" | "fast" | "custom";

export interface ModelEntry {
  readonly id: string;
  readonly label: string;
  readonly tier: ModelTier;
  readonly category?: string;
}

export interface ActiveCredentials {
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly model: string;
  readonly sdk: SdkType;
}

export interface PlatformMeta {
  readonly id: PlatformId;
  readonly sdk: SdkType;
  readonly displayName: string;
  readonly subtitle: string;
  readonly color: string;
  readonly letter: string;
  readonly defaultBaseUrl: string;
  readonly defaultModel: string;
  readonly models: readonly ModelEntry[];
}

// ======================== Model Lists ========================

const CLAUDE_MODELS: readonly ModelEntry[] = [
  { id: "claude-opus-4-8", label: "Opus 4.8", tier: "flagship" },
  { id: "claude-opus-4-7", label: "Opus 4.7", tier: "flagship" },
  { id: "claude-opus-4-6", label: "Opus 4.6", tier: "flagship" },
  { id: "claude-fable-5", label: "Fable 5", tier: "fable" },
  { id: "claude-sonnet-5", label: "Sonnet 5", tier: "balanced" },
  { id: "claude-sonnet-4-6", label: "Sonnet 4.6", tier: "balanced" },
  { id: "claude-sonnet-4-5-20250929", label: "Sonnet 4.5", tier: "balanced" },
  { id: "claude-haiku-4-5-20251001", label: "Haiku 4.5", tier: "fast" },
];

const CODEX_MODELS: readonly ModelEntry[] = [
  { id: "gpt-5.6-sol", label: "GPT-5.6 Sol", tier: "flagship" },
  { id: "gpt-5.6-terra", label: "GPT-5.6 Terra", tier: "balanced" },
  { id: "gpt-5.6-luna", label: "GPT-5.6 Luna", tier: "fast" },
  { id: "gpt-5.5", label: "GPT-5.5", tier: "flagship" },
  { id: "gpt-5.4", label: "GPT-5.4", tier: "flagship" },
  { id: "gpt-5.3-codex", label: "GPT-5.3 Codex", tier: "flagship" },
];

/** Whether a Codex model supports a distinct native `max` reasoning effort. */
export function supportsCodexMaxReasoning(modelId: string): boolean {
  const normalizedModel = modelId.includes("/")
    ? modelId.slice(modelId.lastIndexOf("/") + 1)
    : modelId;
  return /^gpt-5\.6(?:[-.].*)?$/.test(normalizedModel);
}

const GEMINI_MODELS: readonly ModelEntry[] = [
  { id: "gemini-3.1-pro-preview", label: "Gemini 3.1 Pro", tier: "flagship" },
  { id: "gemini-3.1-flash-image-preview", label: "Gemini 3.1 Flash Image", tier: "flagship" },
  { id: "gemini-3-pro-image-preview", label: "Gemini 3 Pro Image", tier: "flagship" },
  { id: "gemini-2.5-pro", label: "Gemini 2.5 Pro", tier: "flagship" },
  { id: "gemini-3-flash-preview", label: "Gemini 3 Flash", tier: "balanced" },
  { id: "gemini-3.1-flash-lite-preview", label: "Gemini 3.1 Flash Lite", tier: "fast" },
  { id: "gemini-2.5-flash", label: "Gemini 2.5 Flash", tier: "fast" },
  { id: "gemini-2.5-flash-image", label: "Gemini 2.5 Flash Image", tier: "fast" },
  { id: "gemini-2.5-flash-native-audio-preview-12-2025", label: "Gemini 2.5 Flash Audio", tier: "fast" },
  { id: "gemini-2.5-flash-lite", label: "Gemini 2.5 Flash Lite", tier: "fast" },
];

const GROK_MODELS: readonly ModelEntry[] = [
  { id: "grok-3", label: "Grok 3", tier: "flagship" },
  { id: "grok-3-mini", label: "Grok 3 Mini", tier: "fast" },
];

const DEEPSEEK_MODELS: readonly ModelEntry[] = [
  { id: "deepseek-chat", label: "DeepSeek Chat", tier: "balanced" },
  { id: "deepseek-reasoner", label: "DeepSeek Reasoner", tier: "flagship" },
];

const QWEN_MODELS: readonly ModelEntry[] = [
  { id: "qwen3.5-plus", label: "Qwen3.5 Plus", tier: "flagship" },
  { id: "qwen3-max-2026-01-23", label: "Qwen3 Max", tier: "flagship" },
  { id: "qwen3-coder-next", label: "Qwen3 Coder Next", tier: "flagship" },
  { id: "qwen3-coder-plus", label: "Qwen3 Coder Plus", tier: "balanced" },
  { id: "qwen3-coder", label: "Qwen3 Coder", tier: "fast" },
  { id: "glm-5", label: "GLM-5", tier: "flagship" },
  { id: "glm-4.7", label: "GLM-4.7", tier: "flagship" },
];

const BIGMODEL_MODELS: readonly ModelEntry[] = [
  { id: "glm-5.1", label: "GLM-5.1", tier: "flagship" },
  { id: "glm-5", label: "GLM-5", tier: "flagship" },
  { id: "glm-4.7", label: "GLM-4.7", tier: "flagship" },
  { id: "glm-4.7-flashx", label: "GLM-4.7 FlashX", tier: "fast" },
  { id: "glm-4.6", label: "GLM-4.6", tier: "balanced" },
  { id: "glm-4.5-air", label: "GLM-4.5 Air", tier: "balanced" },
  { id: "glm-4.5-airx", label: "GLM-4.5 AirX", tier: "fast" },
  { id: "glm-4-long", label: "GLM-4 Long", tier: "balanced" },
];

const MIMO_MODELS: readonly ModelEntry[] = [
  { id: "mimo-v2-pro", label: "MiMO v2 Pro", tier: "flagship" },
  { id: "mimo-v2-omni", label: "MiMO v2 Omni", tier: "balanced" },
];

const KIMI_MODELS: readonly ModelEntry[] = [
  { id: "kimi-k2.5", label: "Kimi K2.5", tier: "flagship" },
  { id: "kimi-k2-thinking", label: "Kimi K2 Thinking", tier: "flagship" },
];

const MINIMAX_MODELS: readonly ModelEntry[] = [
  { id: "MiniMax-M2.7", label: "MiniMax M2.7", tier: "flagship" },
  { id: "MiniMax-M2.7-highspeed", label: "MiniMax M2.7 Highspeed", tier: "fast" },
  { id: "MiniMax-M2.5", label: "MiniMax M2.5", tier: "balanced" },
  { id: "MiniMax-M2.5-highspeed", label: "MiniMax M2.5 Highspeed", tier: "fast" },
];

const OLLAMA_MODELS: readonly ModelEntry[] = [];

// ======================== Platform Registry ========================

export const PLATFORM_REGISTRY: Record<PlatformId, PlatformMeta> = {
  claude: {
    id: "claude",
    sdk: "claude",
    displayName: "Claude",
    subtitle: "Anthropic",
    color: "#A855F7",
    letter: "C",
    defaultBaseUrl: "https://api.anthropic.com",
    defaultModel: "claude-opus-4-7",
    models: CLAUDE_MODELS,
  },
  codex: {
    id: "codex",
    sdk: "codex",
    displayName: "Codex",
    subtitle: "OpenAI",
    color: "#10B981",
    letter: "O",
    defaultBaseUrl: "https://api.openai.com/v1",
    defaultModel: "gpt-5.6-sol",
    models: CODEX_MODELS,
  },
  gemini: {
    id: "gemini",
    sdk: "gemini",
    displayName: "Gemini",
    subtitle: "Google",
    color: "#4285F4",
    letter: "G",
    defaultBaseUrl: "",
    defaultModel: "gemini-3-flash-preview",
    models: GEMINI_MODELS,
  },
  grok: {
    id: "grok",
    sdk: "chatcmpl",
    displayName: "Grok",
    subtitle: "xAI",
    color: "#EF4444",
    letter: "G",
    defaultBaseUrl: "https://api.x.ai/v1",
    defaultModel: "grok-3",
    models: GROK_MODELS,
  },
  deepseek: {
    id: "deepseek",
    sdk: "chatcmpl",
    displayName: "DeepSeek",
    subtitle: "DeepSeek",
    color: "#06B6D4",
    letter: "D",
    defaultBaseUrl: "https://api.deepseek.com",
    defaultModel: "deepseek-chat",
    models: DEEPSEEK_MODELS,
  },
  qwen: {
    id: "qwen",
    sdk: "chatcmpl",
    displayName: "Qwen",
    subtitle: "Alibaba",
    color: "#6366F1",
    letter: "Q",
    defaultBaseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    defaultModel: "qwen3.5-plus",
    models: QWEN_MODELS,
  },
  bigmodel: {
    id: "bigmodel",
    sdk: "chatcmpl",
    displayName: "BigModel",
    subtitle: "智谱",
    color: "#3B82F6",
    letter: "B",
    defaultBaseUrl: "https://open.bigmodel.cn/api/paas/v4",
    defaultModel: "glm-4.7",
    models: BIGMODEL_MODELS,
  },
  mimo: {
    id: "mimo",
    sdk: "chatcmpl",
    displayName: "MiMO",
    subtitle: "Xiaomi",
    color: "#FF6900",
    letter: "M",
    defaultBaseUrl: "https://api.xiaomimimo.com/v1",
    defaultModel: "mimo-v2-pro",
    models: MIMO_MODELS,
  },
  minimax: {
    id: "minimax",
    sdk: "chatcmpl",
    displayName: "MiniMax",
    subtitle: "MiniMax",
    color: "#8B5CF6",
    letter: "M",
    defaultBaseUrl: "https://api.minimaxi.com/v1",
    defaultModel: "MiniMax-M2.7",
    models: MINIMAX_MODELS,
  },
  kimi: {
    id: "kimi",
    sdk: "chatcmpl",
    displayName: "Kimi",
    subtitle: "Moonshot",
    color: "#1890FF",
    letter: "K",
    defaultBaseUrl: "https://api.kimi.com/coding/",
    defaultModel: "kimi-k2.5",
    models: KIMI_MODELS,
  },
  ollama: {
    id: "ollama",
    sdk: "chatcmpl",
    displayName: "Ollama",
    subtitle: "Local",
    color: "#FFFFFF",
    letter: "O",
    defaultBaseUrl: "http://localhost:11434",
    defaultModel: "",
    models: OLLAMA_MODELS,
  },
};

/** Platforms that are not yet available and should be shown as disabled. */
export const DISABLED_PLATFORMS: ReadonlySet<PlatformId> = new Set(["grok"]);

/** All platform IDs, with disabled ones sorted to the end. */
export const ALL_PLATFORM_IDS: readonly PlatformId[] = (
  Object.keys(PLATFORM_REGISTRY) as PlatformId[]
).sort((a, b) => {
  const aDisabled = DISABLED_PLATFORMS.has(a) ? 1 : 0;
  const bDisabled = DISABLED_PLATFORMS.has(b) ? 1 : 0;
  return aDisabled - bDisabled;
});

/** Platform IDs that should appear in model/provider pickers. */
export const USER_SELECTABLE_PLATFORM_IDS: readonly PlatformId[] = ALL_PLATFORM_IDS;

/** SDK channels exposed in channel override pickers. Codex remains a platform,
 *  but is no longer offered as an override channel for other providers. */
export const USER_SELECTABLE_SDK_CHANNELS: readonly SdkType[] = ["claude", "chatcmpl"];

// ======================== Helpers ========================

export function normalizeModelIdForPlatform(
  platformId: PlatformId,
  modelId: string,
): string {
  return isRetiredGptModel(modelId)
    ? PLATFORM_REGISTRY[platformId].defaultModel
    : modelId;
}

/** Platforms that default to routing through Claude SDK (Anthropic protocol). */
const CLAUDE_ROUTE_DEFAULTS: ReadonlySet<PlatformId> = new Set([
  "qwen",
  "deepseek",
  "bigmodel",
  "mimo",
  "minimax",
  "kimi",
]);

/** Default base URLs per platform per SDK channel. */
export const CHANNEL_BASE_URLS: Partial<Record<PlatformId, Partial<Record<SdkType, string>>>> = {
  deepseek: {
    claude: "https://api.deepseek.com/anthropic",
    codex: "https://api.deepseek.com",
    chatcmpl: "https://api.deepseek.com",
  },
  qwen: {
    claude: "https://dashscope.aliyuncs.com/apps/anthropic",
    codex: "https://coding.dashscope.aliyuncs.com/v1",
    chatcmpl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
  },
  bigmodel: {
    claude: "https://open.bigmodel.cn/api/anthropic",
    codex: "https://open.bigmodel.cn/api/paas/v4/",
    chatcmpl: "https://open.bigmodel.cn/api/paas/v4",
  },
  mimo: {
    claude: "https://api.xiaomimimo.com/anthropic",
    codex: "https://api.xiaomimimo.com/v1",
    chatcmpl: "https://api.xiaomimimo.com/v1",
  },
  minimax: {
    claude: "https://api.minimaxi.com/anthropic",
    codex: "https://api.minimaxi.com/v1",
    chatcmpl: "https://api.minimaxi.com/v1",
  },
  kimi: {
    claude: "https://api.kimi.com/coding/",
    codex: "https://api.kimi.com/coding/",
    chatcmpl: "https://api.kimi.com/coding/",
  },
  ollama: {
    claude: "http://localhost:11434",
    chatcmpl: "http://localhost:11434/v1",
  },
};

/** Get the default base URL for a given platform + SDK channel. */
export function getChannelDefaultUrl(platformId: PlatformId, sdk: SdkType): string {
  return CHANNEL_BASE_URLS[platformId]?.[sdk] ?? PLATFORM_REGISTRY[platformId].defaultBaseUrl;
}

/** Get the effective SDK for API routing, respecting sdkOverride. */
export function getEffectiveSdk(platform: PlatformConfig): SdkType {
  return platform.sdkOverride ?? platform.sdk;
}

/** Get models for a platform. */
export function getModelsForPlatform(platformId: PlatformId): readonly ModelEntry[] {
  return PLATFORM_REGISTRY[platformId].models;
}

/**
 * Resolve the user-facing model list for a platform. For chatcmpl-based
 * providers (DeepSeek, Qwen, Kimi, …) we prefer the remote-fetched catalog
 * when the caller passes it in, so every picker stays consistent with the
 * provider's /models endpoint instead of falling back to the bundled
 * hardcoded list. For non-chatcmpl providers (Claude, Codex, Gemini) the
 * bundled list is authoritative because their APIs don't expose /models.
 */
export function getDisplayModelsForPlatform(
  platformId: PlatformId,
  remoteCache?: ReadonlyArray<ModelEntry>,
  customModels?: ReadonlyArray<ModelEntry>,
): readonly ModelEntry[] {
  const meta = PLATFORM_REGISTRY[platformId];
  const unfilteredBaseModels = meta.sdk === "chatcmpl" && remoteCache && remoteCache.length > 0
    ? remoteCache
    : meta.models;
  const baseModels = filterRetiredGptModels(unfilteredBaseModels);
  if (platformId === "ollama" || !customModels || customModels.length === 0) {
    return baseModels;
  }

  const seen = new Set(baseModels.map((model) => model.id));
  const merged = [...baseModels];
  for (const model of sanitizeCustomModels(customModels)) {
    if (seen.has(model.id)) continue;
    seen.add(model.id);
    merged.push(model);
  }
  return merged;
}

export function createCustomModelEntry(modelId: string): ModelEntry | null {
  const id = modelId.trim();
  if (!id || isRetiredGptModel(id)) return null;
  return {
    id,
    label: id,
    tier: "custom",
    category: "Custom",
  };
}

export function sanitizeCustomModels(value: unknown): readonly ModelEntry[] {
  if (!Array.isArray(value)) return [];
  const result: ModelEntry[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    let entry: ModelEntry | null = null;
    if (typeof item === "string") {
      entry = createCustomModelEntry(item);
    } else if (item && typeof item === "object") {
      const raw = item as { id?: unknown; label?: unknown };
      const modelId = typeof raw.id === "string" ? raw.id : "";
      entry = createCustomModelEntry(modelId);
      if (entry && typeof raw.label === "string" && raw.label.trim()) {
        entry = { ...entry, label: raw.label.trim() };
      }
    }
    if (!entry || seen.has(entry.id)) continue;
    seen.add(entry.id);
    result.push(entry);
  }
  return result;
}

export function sanitizeProfileProxy(value: unknown): ProfileProxyConfig | undefined {
  if (!value || typeof value !== "object") return undefined;
  const raw = value as Partial<Record<keyof ProfileProxyConfig, unknown>>;
  const mode = raw.mode === "https" || raw.mode === "socks5" ? raw.mode : "http";
  const proxy: ProfileProxyConfig = {
    enabled: raw.enabled === true,
    mode,
    host: typeof raw.host === "string" ? raw.host : "",
    port: typeof raw.port === "string" ? raw.port : "",
    username: typeof raw.username === "string" ? raw.username : "",
    password: typeof raw.password === "string" ? raw.password : "",
  };
  if (
    !proxy.enabled &&
    !proxy.host.trim() &&
    !proxy.port.trim() &&
    !proxy.username?.trim() &&
    !proxy.password?.trim()
  ) {
    return undefined;
  }
  return proxy;
}

export function isProfileProxyConfigValid(proxy: ProfileProxyConfig | undefined): boolean {
  if (!proxy?.enabled) return true;
  const port = Number(proxy.port);
  return (
    proxy.host.trim().length > 0 &&
    Number.isInteger(port) &&
    port > 0 &&
    port <= 65535
  );
}

export function buildProfileProxyUrl(profile: ProfileConfig | null | undefined): string | undefined {
  const proxy = sanitizeProfileProxy(profile?.proxy);
  if (!proxy?.enabled || !isProfileProxyConfigValid(proxy)) return undefined;

  const host = proxy.host.trim();
  const port = proxy.port.trim();
  const username = proxy.username?.trim() ?? "";
  const password = proxy.password ?? "";
  const auth = username
    ? `${encodeURIComponent(username)}${password ? `:${encodeURIComponent(password)}` : ""}@`
    : "";
  return `${proxy.mode}://${auth}${host}:${port}`;
}

function getActiveProfile(platform: PlatformConfig | null | undefined): ProfileConfig | undefined {
  return platform?.profiles.find((profile) => profile.id === platform.activeProfileId);
}

export function buildActiveProfileProxyUrl(platform: PlatformConfig | null | undefined): string | undefined {
  return buildProfileProxyUrl(getActiveProfile(platform));
}

export function getCustomModelsForActiveProfile(
  platform: PlatformConfig | null | undefined,
): readonly ModelEntry[] {
  if (!platform || platform.id === "ollama") return [];
  const profile = platform.profiles.find((p) => p.id === platform.activeProfileId);
  if (profile?.authMode === "oauth") return [];
  return sanitizeCustomModels(platform.customModels);
}

/** Convert Ollama local models to the generic ModelEntry format used by model selectors. */
export function ollamaLocalModelsToEntries(
  localModels: readonly { readonly name: string }[],
): readonly ModelEntry[] {
  return filterRetiredGptModels(
    localModels.map((m) => ({
      id: m.name,
      label: m.name,
      tier: "balanced" as ModelTier,
    })),
  );
}

/** Create initial default PlatformConfig for a given platform. */
export function createDefaultPlatformConfig(platformId: PlatformId): PlatformConfig {
  const meta = PLATFORM_REGISTRY[platformId];
  const defaultProfileId = "default";
  const override = CLAUDE_ROUTE_DEFAULTS.has(platformId) ? "claude" as SdkType : undefined;
  const channelMap = CHANNEL_BASE_URLS[platformId];
  const effectiveSdk = override ?? meta.sdk;
  const defaultUrl = getChannelDefaultUrl(platformId, effectiveSdk) ?? meta.defaultBaseUrl;
  return {
    id: platformId,
    sdk: meta.sdk,
    sdkOverride: override,
    channelUrls: channelMap ? { ...channelMap } : undefined,
    profiles: [
      {
        id: defaultProfileId,
        name: "Default API",
        baseUrl: defaultUrl,
        apiKey: platformId === "ollama" ? "ollama" : "",
        testPassed: false,
      },
    ],
    activeProfileId: defaultProfileId,
    activeModelId: meta.defaultModel,
    customModels: [],
  };
}

/** Encode platformId + modelId into a compound string for per-conversation storage.
 *  Format: "platformId:modelId" (e.g. "bigmodel:glm-5") */
export function encodeConversationModel(platformId: string, modelId: string): string {
  return `${platformId}:${modelId}`;
}

/** Decode a stored conversation model string.
 *  Handles both compound "platformId:modelId" format and legacy bare "modelId" format. */
export function decodeConversationModel(stored: string): { platformId: PlatformId | null; modelId: string } {
  const colonIdx = stored.indexOf(":");
  if (colonIdx > 0) {
    const prefix = stored.slice(0, colonIdx);
    const modelId = normalizeRetiredGptModelId(stored.slice(colonIdx + 1));
    // Verify the prefix is a valid platform ID
    if (ALL_PLATFORM_IDS.includes(prefix as PlatformId)) {
      return { platformId: prefix as PlatformId, modelId };
    }
    // Legacy hosted selections cannot be resolved without a local profile.
    if (prefix === "official") {
      return { platformId: null, modelId };
    }
  }
  // Legacy bare IDs are ambiguous: they may have come from the removed hosted
  // catalog. Community builds require an explicit local provider selection.
  const modelId = normalizeRetiredGptModelId(stored);
  return { platformId: null, modelId };
}

/** Create the full default platforms map. */
export function createDefaultPlatforms(): Record<PlatformId, PlatformConfig> {
  return Object.fromEntries(
    ALL_PLATFORM_IDS.map((id) => [id, createDefaultPlatformConfig(id)]),
  ) as Record<PlatformId, PlatformConfig>;
}

/** Deep-clone platforms map for draft editing. */
export function clonePlatforms(
  platforms: Record<PlatformId, PlatformConfig>,
): Record<PlatformId, PlatformConfig> {
  const result = {} as Record<PlatformId, PlatformConfig>;
  for (const key of Object.keys(platforms) as PlatformId[]) {
    const p = platforms[key];
    result[key] = {
      ...p,
      profiles: p.profiles.map((pr) => ({ ...pr, proxy: sanitizeProfileProxy(pr.proxy) })),
      channelUrls: p.channelUrls ? { ...p.channelUrls } : undefined,
      customModels: sanitizeCustomModels(p.customModels),
    };
  }
  return result;
}

/** Derive the Tauri test command from SDK type. */
export function getTestCommandForSdk(sdk: SdkType): string {
  switch (sdk) {
    case "claude": return "test_connection";
    case "codex": return "test_openai_connection";
    case "gemini": return "test_gemini_connection";
    case "chatcmpl": return "test_openai_connection";
    default: {
      const _exhaustive: never = sdk;
      throw new Error(`Unknown SDK type: ${_exhaustive}`);
    }
  }
}

/** Resolve the active credentials for a platform. Returns null if no API key configured.
 *  The returned `sdk` reflects `sdkOverride` when set, so callers get the
 *  effective routing SDK automatically. */
export function resolveActiveCredentials(
  platform: PlatformConfig,
): ActiveCredentials | null {
  if (!platform) return null;
  const profile = platform.profiles.find((p) => p.id === platform.activeProfileId);
  if (!profile || profile.authMode === "oauth" || !profile.apiKey.trim()) return null;
  return {
    baseUrl: profile.baseUrl,
    apiKey: profile.apiKey,
    model: normalizeModelIdForPlatform(platform.id, platform.activeModelId),
    sdk: getEffectiveSdk(platform),
  };
}

/** True when an OAuth profile has sign-in metadata that indicates a usable subscription login. */
function isOAuthProfileConnected(
  profile: ProfileConfig | null | undefined,
  now = Date.now(),
): boolean {
  if (profile?.authMode !== "oauth") return false;
  if (typeof profile.oauthExpiresAt === "number") {
    return profile.oauthExpiresAt > now;
  }
  return Boolean(profile.oauthAccountEmail || profile.oauthPlan);
}

/** True when the active profile can be offered to the user as configured. */
export function hasActiveProfileCredentials(
  platform: PlatformConfig | null | undefined,
  now = Date.now(),
): boolean {
  if (!platform) return false;
  const profile = platform.profiles.find((p) => p.id === platform.activeProfileId);
  if (!profile) return false;
  if (profile.authMode === "oauth") {
    return isOAuthProfileConnected(profile, now);
  }
  return profile.apiKey.trim().length > 0;
}

/** True when the active profile should show a connected status indicator. */
export function isProfileConnectionHealthy(
  profile: ProfileConfig | null | undefined,
  now = Date.now(),
): boolean {
  if (!profile) return false;
  if (profile.authMode === "oauth") {
    return isOAuthProfileConnected(profile, now);
  }
  return profile.testPassed;
}

// ======================== OAuth Profile Normalisation ========================

/** 规范化 OAuth 模式下的模型选择，但不删除 API Key 配置。
 *  凭据解析由 `authMode` 控制，因此用户切回 API Key 模式时不需要重新填写 Base URL 和 Key。 */
export function normalizeOAuthProfiles(
  platforms: Record<PlatformId, PlatformConfig>,
): Record<PlatformId, PlatformConfig> {
  const result: Partial<Record<PlatformId, PlatformConfig>> = {};
  for (const id of Object.keys(platforms) as PlatformId[]) {
    const platform = platforms[id];
    const nextProfiles = platform.profiles.map((p) => ({ ...p }));
    const activeProfile = nextProfiles.find((p) => p.id === platform.activeProfileId);
    const baseModels = getDisplayModelsForPlatform(id);
    const activeModelId = activeProfile?.authMode === "oauth" &&
      baseModels.length > 0 &&
      !baseModels.some((model) => model.id === platform.activeModelId)
      ? baseModels[0].id
      : platform.activeModelId;
    result[id] = {
      ...platform,
      profiles: nextProfiles,
      activeModelId,
      customModels: sanitizeCustomModels(platform.customModels),
    };
  }
  return result as Record<PlatformId, PlatformConfig>;
}
