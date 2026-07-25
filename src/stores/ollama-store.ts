import { create } from "zustand";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { load, type Store } from "@tauri-apps/plugin-store";

// ---------------------------------------------------------------------------
// Types (matching Rust structs)
// ---------------------------------------------------------------------------

export interface OllamaStatus {
  readonly installed: boolean;
  readonly running: boolean;
  readonly version: string | null;
  readonly path: string | null;
}

export interface OllamaLocalModel {
  readonly name: string;
  readonly model: string;
  readonly size: number;
  readonly modified_at: string;
  readonly digest: string;
}

export interface OllamaCloudModel {
  readonly name: string;
  readonly description: string;
  readonly tags: string[];
  readonly pull_count: number | null;
  readonly updated_at: string | null;
}

export interface OllamaPullProgress {
  readonly model: string;
  readonly status: string;
  readonly completed: number | null;
  readonly total: number | null;
  readonly percent: number | null;
  /** Download speed in bytes per second */
  readonly speed: number | null;
}

// ---------------------------------------------------------------------------
// Store types
// ---------------------------------------------------------------------------

type OllamaPhase = "idle" | "checking" | "ready" | "not-installed" | "not-running" | "error";
type PullPhase = "idle" | "pulling" | "done" | "failed";

interface OllamaState {
  readonly phase: OllamaPhase;
  readonly status: OllamaStatus | null;
  readonly error: string | null;

  readonly localModels: readonly OllamaLocalModel[];
  readonly localModelsLoading: boolean;

  readonly cloudModels: readonly OllamaCloudModel[];
  readonly cloudSearchQuery: string;
  readonly cloudSearchLoading: boolean;

  readonly pullPhase: PullPhase;
  readonly pullProgress: OllamaPullProgress | null;
  readonly pullingModel: string | null;
  readonly pullError: string | null;

  readonly registryMirror: string;
  readonly registryMirrorLoading: boolean;

  readonly numCtx: number;

  readonly serviceLoading: boolean;

  readonly checkStatus: () => Promise<void>;
  readonly startService: () => Promise<void>;
  readonly stopService: () => Promise<void>;
  readonly fetchLocalModels: (baseUrl?: string) => Promise<void>;
  readonly searchCloudModels: (
    query: string,
    proxyUrl?: string,
    mirrorUrl?: string,
  ) => Promise<void>;
  readonly pullModel: (model: string, baseUrl?: string) => Promise<void>;
  readonly deleteModel: (model: string, baseUrl?: string) => Promise<void>;
  readonly getRegistryMirror: () => Promise<void>;
  readonly setNumCtx: (numCtx: number) => void;
  readonly reset: () => void;
}

// ---------------------------------------------------------------------------
// Local model cache (Tauri Store)
// ---------------------------------------------------------------------------

const CACHE_FILE = "ollama-cache.json";
const CACHE_KEY = "localModels";
const NUM_CTX_KEY = "numCtx";
const DEFAULT_NUM_CTX = 32768;

let cacheStore: Store | null = null;

async function getCacheStore(): Promise<Store> {
  if (!cacheStore) {
    cacheStore = await load(CACHE_FILE, { defaults: {}, autoSave: true });
  }
  return cacheStore;
}

async function loadCachedModels(): Promise<readonly OllamaLocalModel[]> {
  try {
    const store = await getCacheStore();
    const cached = await store.get<OllamaLocalModel[]>(CACHE_KEY);
    return cached ?? [];
  } catch {
    return [];
  }
}

async function saveCachedModels(models: readonly OllamaLocalModel[]): Promise<void> {
  try {
    const store = await getCacheStore();
    await store.set(CACHE_KEY, models);
  } catch {
    // Non-critical — cache miss on next launch
  }
}

async function loadNumCtx(): Promise<number> {
  try {
    const store = await getCacheStore();
    const val = await store.get<number>(NUM_CTX_KEY);
    return val ?? DEFAULT_NUM_CTX;
  } catch {
    return DEFAULT_NUM_CTX;
  }
}

async function saveNumCtx(numCtx: number): Promise<void> {
  try {
    const store = await getCacheStore();
    await store.set(NUM_CTX_KEY, numCtx);
  } catch {
    // Non-critical
  }
}

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

const INITIAL_STATE = {
  phase: "idle" as OllamaPhase,
  status: null as OllamaStatus | null,
  error: null as string | null,
  localModels: [] as readonly OllamaLocalModel[],
  localModelsLoading: false,
  cloudModels: [] as readonly OllamaCloudModel[],
  cloudSearchQuery: "",
  cloudSearchLoading: false,
  pullPhase: "idle" as PullPhase,
  pullProgress: null as OllamaPullProgress | null,
  pullingModel: null as string | null,
  pullError: null as string | null,
  registryMirror: "",
  registryMirrorLoading: false,
  numCtx: DEFAULT_NUM_CTX,
  serviceLoading: false,
};

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

export const useOllamaStore = create<OllamaState>()((set, get) => ({
  ...INITIAL_STATE,

  checkStatus: async () => {
    set({ phase: "checking", error: null });
    try {
      const status = await invoke<OllamaStatus>("check_ollama_status");
      if (!status.installed) {
        set({ phase: "not-installed", status });
      } else if (!status.running) {
        set({ phase: "not-running", status });
      } else {
        set({ phase: "ready", status });
      }
    } catch (e) {
      set({ phase: "error", error: String(e) });
    }
  },

  fetchLocalModels: async (baseUrl?: string) => {
    set({ localModelsLoading: true });
    try {
      const models = await invoke<OllamaLocalModel[]>("ollama_list_local_models", {
        baseUrl: baseUrl ?? null,
      });
      set({ localModels: models, localModelsLoading: false });
      saveCachedModels(models);
    } catch (e) {
      set({ localModelsLoading: false, error: String(e) });
    }
  },

  searchCloudModels: async (query: string, proxyUrl?: string, mirrorUrl?: string) => {
    set({ cloudSearchLoading: true, cloudSearchQuery: query });
    try {
      const models = await invoke<OllamaCloudModel[]>("ollama_search_models", {
        query,
        proxyUrl: proxyUrl ?? null,
        mirrorUrl: mirrorUrl ?? null,
      });
      set({ cloudModels: models, cloudSearchLoading: false });
    } catch (e) {
      set({ cloudModels: [], cloudSearchLoading: false, error: String(e) });
    }
  },

  pullModel: async (model: string, baseUrl?: string) => {
    set({
      pullPhase: "pulling",
      pullingModel: model,
      pullProgress: null,
      pullError: null,
    });

    let unlisten: UnlistenFn | null = null;

    try {
      // Listen for progress events
      unlisten = await listen<OllamaPullProgress>("ollama-pull-progress", (event) => {
        const progress = event.payload;
        set({ pullProgress: progress });

        if (progress.status === "complete") {
          set({ pullPhase: "done", pullingModel: null });
        }
      });

      await invoke<string>("ollama_pull_model", {
        model,
        baseUrl: baseUrl ?? null,
      });

      // Refresh local models after pull
      if (get().phase === "ready") {
        await get().fetchLocalModels(baseUrl);
      }
    } catch (e) {
      const rawError = String(e);
      let pullError = rawError;

      // Detect manifest error and provide mirror-aware hint
      if (rawError.includes("[manifest]")) {
        const mirror = get().registryMirror;
        pullError = rawError.replace(" [manifest]", "");
        if (mirror) {
          pullError += ` (${mirror})`;
        }
      }

      set({ pullPhase: "failed", pullError, pullingModel: null });
    } finally {
      if (unlisten) {
        unlisten();
      }
    }
  },

  deleteModel: async (model: string, baseUrl?: string) => {
    try {
      await invoke<string>("ollama_delete_model", {
        model,
        baseUrl: baseUrl ?? null,
      });
      // Refresh local models after delete
      await get().fetchLocalModels(baseUrl);
    } catch (e) {
      set({ error: String(e) });
    }
  },

  getRegistryMirror: async () => {
    set({ registryMirrorLoading: true });
    try {
      const mirror = await invoke<string>("get_ollama_registry_mirror");
      set({ registryMirror: mirror, registryMirrorLoading: false });
    } catch {
      set({ registryMirrorLoading: false });
    }
  },

  startService: async () => {
    set({ serviceLoading: true });
    try {
      await invoke<string>("start_ollama");
      await get().checkStatus();
    } catch (e) {
      set({ error: String(e) });
    } finally {
      set({ serviceLoading: false });
    }
  },

  stopService: async () => {
    set({ serviceLoading: true });
    try {
      await invoke<string>("stop_ollama");
      await get().checkStatus();
    } catch (e) {
      set({ error: String(e) });
    } finally {
      set({ serviceLoading: false });
    }
  },

  setNumCtx: (numCtx: number) => {
    set({ numCtx });
    saveNumCtx(numCtx);
  },

  reset: () => set(INITIAL_STATE),
}));

// Hydrate cached models and numCtx on startup.
loadCachedModels().then((cached) => {
  if (cached.length > 0 && useOllamaStore.getState().localModels.length === 0) {
    useOllamaStore.setState({ localModels: cached });
  }
});
loadNumCtx().then((numCtx) => {
  useOllamaStore.setState({ numCtx });
});
