import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useSettingsStore } from "@/stores/settings-store";
import { useConversationStore } from "@/stores/conversation-store";
import {
  buildActiveProfileProxyUrl,
  resolveActiveCredentials,
  getEffectiveSdk,
  type SdkType,
} from "@/lib/platform-config";
import { resolvePaneModel } from "@/lib/pane-model";
import { buildStreamInvokePayload } from "@/lib/chat-stream-send";
import type { CompletePayload, ErrorPayload } from "@/lib/stream-handlers/types";

// ---------------------------------------------------------------------------
// One-shot AI text generation shared by the commit-message and PR-description
// generators: resolve the active model/credentials once, then run a single
// tool-less turn either through the sidecar (OAuth subscriptions) or the Rust
// HTTP path (API keys — callers invoke their dedicated Rust command).
// ---------------------------------------------------------------------------

export interface OneShotAiTarget {
  readonly sdk: SdkType;
  /** Platform id ("claude" / "codex" / ...) — REQUIRED for the sidecar's
   *  credential strategy to recognize OAuth tokens (sk-ant-oat* is only
   *  routed to CLAUDE_CODE_OAUTH_TOKEN when platform === "claude"). */
  readonly platform: string;
  readonly model: string | null;
  readonly apiKey: string | null;
  readonly baseUrl: string | null;
  readonly authMode: "apiKey" | "oauth";
  readonly profileId: string | undefined;
  readonly proxyUrl: string | undefined;
}

export type ResolveOneShotAiResult =
  | { readonly ok: true; readonly target: OneShotAiTarget }
  | { readonly ok: false; readonly reason: "no-model" | "no-api-key" };

/** Resolve the pane's active model into a one-shot generation target.
 *  Subscription (OAuth) profiles route through the sidecar chat pipeline;
 *  everything else uses API-key credentials. */
export function resolveOneShotAiTarget(): ResolveOneShotAiResult {
  const settings = useSettingsStore.getState();
  const activeConversationId = useConversationStore.getState().activeConversationId;
  const modelSelection = resolvePaneModel({ conversationId: activeConversationId });
  if (modelSelection.requiresLocalSelection || !modelSelection.platformId) {
    return { ok: false, reason: "no-model" };
  }
  const platform = modelSelection.platformId;
  const platformConfig = settings.platforms[platform];

  let sdk: SdkType;
  let baseUrl: string | null = null;
  let apiKey: string | null = null;
  let model = modelSelection.modelId || platformConfig.activeModelId;
  let authMode: "apiKey" | "oauth" = "apiKey";
  let profileId: string | undefined;

  const activeProfile = platformConfig?.profiles.find(
    (p) => p.id === platformConfig.activeProfileId,
  );
  const isOAuthSubscription =
    activeProfile?.authMode === "oauth" && (platform === "claude" || platform === "codex");

  if (isOAuthSubscription && activeProfile) {
    sdk = getEffectiveSdk(platformConfig);
    authMode = "oauth";
    profileId = activeProfile.id;
    model = modelSelection.modelId || platformConfig.activeModelId || model;
  } else {
    const creds = resolveActiveCredentials(platformConfig);
    sdk = getEffectiveSdk(platformConfig);
    baseUrl = creds?.baseUrl || null;
    apiKey = creds?.apiKey || null;
    model = modelSelection.modelId || (creds?.model ?? platformConfig.activeModelId) || model;
  }

  if (authMode !== "oauth" && !apiKey?.trim()) {
    return { ok: false, reason: "no-api-key" };
  }

  const proxyUrl =
    sdk === "claude"
      ? buildActiveProfileProxyUrl(platformConfig)
      : settings.proxyEnabled && settings.proxyUrl
        ? settings.proxyUrl
        : undefined;

  return {
    ok: true,
    target: { sdk, platform, model: model || null, apiKey, baseUrl, authMode, profileId, proxyUrl },
  };
}

const ONE_SHOT_DEFAULT_TIMEOUT_MS = 90_000;

/** One-shot text generation through the sidecar (same pattern as
 *  use-health-check): isolated requestId, disableTools so the handler runs a
 *  single tool-less turn, result read from the chat-complete event. */
export async function generateOneShotViaSidecar(params: {
  readonly target: OneShotAiTarget;
  readonly systemPrompt: string;
  readonly userContent: string;
  readonly timeoutMs?: number;
  readonly timeoutMessage?: string;
}): Promise<string> {
  const { target } = params;
  const requestId = crypto.randomUUID();
  let resolveResult!: (value: string) => void;
  let rejectResult!: (error: Error) => void;
  const result = new Promise<string>((resolve, reject) => {
    resolveResult = resolve;
    rejectResult = reject;
  });

  // Register listeners BEFORE invoking so the completion event can't be missed.
  const unlistens = await Promise.all([
    listen<CompletePayload>("chat-complete", (e) => {
      if (e.payload.request_id !== requestId) return;
      const text = e.payload.full_text.trim();
      if (text) resolveResult(text);
      else rejectResult(new Error("Empty response"));
    }),
    listen<ErrorPayload>("chat-error", (e) => {
      if (e.payload.request_id !== requestId) return;
      rejectResult(new Error(e.payload.error));
    }),
  ]);

  let timer: number | undefined;
  try {
    const payload = buildStreamInvokePayload({
      requestId,
      agentType: target.sdk,
      messages: [{ role: "user", content: params.userContent }],
      model: target.model || "",
      baseUrl: target.baseUrl || "",
      apiKey: target.apiKey || "",
      authMode: target.authMode,
      profileId: target.profileId,
      oauthProvider: target.platform,
      systemPrompt: params.systemPrompt,
      permissionMode: "default",
      sessionId: null,
      proxyUrl: target.proxyUrl,
      platform: target.platform,
      disableTools: true,
    });
    await invoke("stream_chat", payload);
    const timeoutMs = params.timeoutMs ?? ONE_SHOT_DEFAULT_TIMEOUT_MS;
    const timeout = new Promise<never>((_, reject) => {
      timer = window.setTimeout(() => {
        invoke("abort_chat", { requestId }).catch(() => {});
        reject(new Error(params.timeoutMessage ?? "AI generation timed out"));
      }, timeoutMs);
    });
    return await Promise.race([result, timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    unlistens.forEach((fn) => fn());
  }
}
