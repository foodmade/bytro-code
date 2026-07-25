import { create } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";
import { invoke } from "@tauri-apps/api/core";
import type { ModelEntry, ModelTier } from "@/lib/platform-config";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type { ModelEntry } from "@/lib/platform-config";

interface RemoteModel {
  readonly id: string;
  readonly display_name: string;
  readonly context_length: number | null;
}

interface FetchModelsResult {
  readonly success: boolean;
  readonly models: ReadonlyArray<RemoteModel>;
  readonly message: string;
}

interface ProviderModelsState {
  readonly models: ReadonlyArray<ModelEntry>;
  readonly loading: boolean;
  readonly error: string | null;
  /** Timestamp of last successful fetch (0 = never fetched) */
  readonly fetchedAt: number;
}

const EMPTY_STATE: ProviderModelsState = {
  models: [],
  loading: false,
  error: null,
  fetchedAt: 0,
};

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

interface RemoteModelsStore {
  /** Per-provider cached state, keyed by provider name (e.g. "zenmux", "deepseek") */
  readonly providers: Record<string, ProviderModelsState>;

  /** Fetch models for a provider (skips if already fetched unless force=true) */
  readonly fetchModels: (
    provider: string,
    baseUrl: string,
    apiKey: string,
    proxyUrl?: string,
    force?: boolean,
  ) => Promise<void>;

  /** Get cached models for a provider (returns empty array if not fetched) */
  readonly getModels: (provider: string) => ReadonlyArray<ModelEntry>;

  /** Check if a provider has fetched models */
  readonly hasFetched: (provider: string) => boolean;

  /** Check if a provider is currently loading */
  readonly isLoading: (provider: string) => boolean;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function deriveTier(id: string): ModelTier {
  const lower = id.toLowerCase();
  if (lower.includes("opus")) return "flagship";
  if (lower.includes("haiku") || lower.includes("3.5-haiku")) return "fast";
  return "balanced";
}

/** Well-known provider prefix → display name mapping */
const PROVIDER_DISPLAY_NAMES: Readonly<Record<string, string>> = {
  openai: "OpenAI",
  anthropic: "Anthropic",
  google: "Google",
  deepseek: "DeepSeek",
  meta: "Meta",
  mistral: "Mistral",
  xiaomi: "Xiaomi",
  zai: "Z.AI",
  kwaikat: "KwaiKAT",
  cohere: "Cohere",
  qwen: "Qwen",
  yi: "Yi",
  zhipu: "Zhipu",
  baichuan: "Baichuan",
  minimax: "MiniMax",
  kimi: "Kimi",
  moonshot: "Moonshot",
  stepfun: "StepFun",
  "01ai": "01.AI",
};

function normalizeProviderKey(raw: string): string {
  return raw.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function resolveDisplayName(raw: string): string {
  const key = normalizeProviderKey(raw);
  return PROVIDER_DISPLAY_NAMES[key] ?? raw.charAt(0).toUpperCase() + raw.slice(1);
}

function extractCategory(id: string, displayName: string): string | undefined {
  // 1) Try id prefix: "openai/gpt-4o" → "openai"
  const slashIdx = id.indexOf("/");
  if (slashIdx > 0) {
    return resolveDisplayName(id.slice(0, slashIdx));
  }
  // 2) Try display_name prefix: "OpenAI: GPT-4o" → "OpenAI"
  const colonIdx = displayName.indexOf(":");
  if (colonIdx > 0) {
    return resolveDisplayName(displayName.slice(0, colonIdx).trim());
  }
  return undefined;
}

function stripProviderPrefix(text: string): string {
  // Strip "Provider: " prefix from display names
  const colonIdx = text.indexOf(":");
  if (colonIdx > 0 && colonIdx < 30) {
    return text.slice(colonIdx + 1).trim();
  }
  return text;
}

function humanizeId(id: string): string {
  // Strip provider prefix for display label
  const base = id.includes("/") ? id.slice(id.indexOf("/") + 1) : id;
  return base
    .split(/[-_]/)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

function toModelEntry(m: RemoteModel): ModelEntry {
  const rawLabel =
    m.display_name && m.display_name !== m.id
      ? m.display_name
      : humanizeId(m.id);
  const category = extractCategory(m.id, rawLabel);
  // Strip provider prefix from label when we already have a category
  const label = category ? stripProviderPrefix(rawLabel) : rawLabel;
  return { id: m.id, label, tier: deriveTier(m.id), ...(category ? { category } : {}) };
}

// ---------------------------------------------------------------------------
// Create store
// ---------------------------------------------------------------------------

export const useRemoteModelsStore = create<RemoteModelsStore>()(
  persist(
    (set, get) => ({
      providers: {},

      fetchModels: async (provider, baseUrl, apiKey, proxyUrl, force = false) => {
        if (!baseUrl) return;

        const current = get().providers[provider];
        // Skip if already fetched and not forcing
        if (!force && current?.fetchedAt && current.fetchedAt > 0 && current.models.length > 0) return;
        // Skip if already loading
        if (current?.loading) return;

        set((state) => ({
          providers: {
            ...state.providers,
            [provider]: {
              ...(state.providers[provider] ?? EMPTY_STATE),
              loading: true,
              error: null,
            },
          },
        }));

        try {
          const result = await invoke<FetchModelsResult>("fetch_remote_models", {
            baseUrl,
            apiKey: apiKey || "",
            proxyUrl: proxyUrl || null,
          });

          if (result.success && result.models.length > 0) {
            // Replace cached list with fresh remote result so the user always
            // sees the up-to-date catalog after a refresh.
            set((state) => ({
              providers: {
                ...state.providers,
                [provider]: {
                  models: result.models.map(toModelEntry),
                  loading: false,
                  error: null,
                  fetchedAt: Date.now(),
                },
              },
            }));
          } else if (result.success) {
            // Successful response but empty list — keep prior cached models so
            // the UI stays usable; just record the empty fetch result.
            set((state) => ({
              providers: {
                ...state.providers,
                [provider]: {
                  ...(state.providers[provider] ?? EMPTY_STATE),
                  loading: false,
                  error: null,
                },
              },
            }));
          } else {
            set((state) => ({
              providers: {
                ...state.providers,
                [provider]: {
                  ...(state.providers[provider] ?? EMPTY_STATE),
                  loading: false,
                  error: result.message,
                },
              },
            }));
          }
        } catch (err) {
          set((state) => ({
            providers: {
              ...state.providers,
              [provider]: {
                ...(state.providers[provider] ?? EMPTY_STATE),
                loading: false,
                error: err instanceof Error ? err.message : String(err),
              },
            },
          }));
        }
      },

      getModels: (provider) => {
        return get().providers[provider]?.models ?? [];
      },

      hasFetched: (provider) => {
        return (get().providers[provider]?.fetchedAt ?? 0) > 0;
      },

      isLoading: (provider) => {
        return get().providers[provider]?.loading ?? false;
      },
    }),
    {
      name: "bytro-remote-models",
      version: 1,
      storage: createJSONStorage(() => localStorage),
      // Only persist the per-provider models cache — never persist transient
      // loading/error state (those should reset on app reload).
      partialize: (state) => ({
        providers: Object.fromEntries(
          Object.entries(state.providers).map(([key, value]) => [
            key,
            {
              models: value.models,
              fetchedAt: value.fetchedAt,
              loading: false,
              error: null,
            },
          ]),
        ),
      }),
    },
  ),
);
