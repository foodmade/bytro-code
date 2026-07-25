import {
  decodeConversationModel,
  getEffectiveSdk,
  type PlatformConfig,
} from "@/lib/platform-config";

export type AgentProviderId = "claude" | "codex";

interface DraftModelLike {
  readonly model: string;
}

interface ModelProviderContext {
  readonly activePlatformId?: string | null;
  readonly platforms: Readonly<Record<string, PlatformConfig | undefined>>;
  readonly conversationModel?: string | null;
  readonly draftPaneModel?: DraftModelLike | null;
}

export function toAgentProviderId(
  sdk: string | null | undefined,
): AgentProviderId | null {
  return sdk === "claude" || sdk === "codex" ? sdk : null;
}

export function resolveModelSdkForContext({
  activePlatformId,
  platforms,
  conversationModel,
  draftPaneModel,
}: ModelProviderContext): string | null {
  const scopedModel = conversationModel ?? draftPaneModel?.model ?? null;
  if (scopedModel) {
    const decoded = decodeConversationModel(scopedModel);
    if (!decoded.platformId) return null;
    const platform = platforms[decoded.platformId];
    return platform ? getEffectiveSdk(platform) : decoded.platformId;
  }

  if (!activePlatformId) return null;
  const platform = platforms[activePlatformId];
  return platform ? getEffectiveSdk(platform) : activePlatformId;
}

export function resolveAgentProviderForModel(
  context: ModelProviderContext,
): AgentProviderId | null {
  return toAgentProviderId(resolveModelSdkForContext(context));
}
