import { useCallback } from "react";
import { useRemoteModelsStore } from "@/stores/remote-models-store";
import type { ModelEntry } from "@/lib/platform-config";

interface UseRemoteModelsOptions {
  /** Provider key (e.g. "zenmux", "deepseek") */
  readonly provider: string;
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly proxyUrl?: string;
  readonly enabled?: boolean;
}

interface UseRemoteModelsReturn {
  readonly models: ReadonlyArray<ModelEntry>;
  readonly loading: boolean;
  readonly error: string | null;
  readonly refresh: () => void;
}

export function useRemoteModels({
  provider,
  baseUrl,
  apiKey,
  proxyUrl,
  enabled = true,
}: UseRemoteModelsOptions): UseRemoteModelsReturn {
  const store = useRemoteModelsStore();
  const providerState = store.providers[provider];
  const models = providerState?.models ?? [];
  const loading = providerState?.loading ?? false;
  const error = providerState?.error ?? null;

  const refresh = useCallback(() => {
    if (!baseUrl || !enabled) return;
    store.fetchModels(provider, baseUrl, apiKey, proxyUrl, true);
  }, [store, provider, baseUrl, apiKey, proxyUrl, enabled]);

  return { models, loading, error, refresh };
}
