import {
  decodeConversationModel,
  encodeConversationModel,
  type PlatformId,
} from "@/lib/platform-config";
import { useConversationStore } from "@/stores/conversation-store";
import { useSettingsStore } from "@/stores/settings-store";
import {
  useSplitViewStore,
  type DraftPaneModelState,
  type SplitPaneId,
} from "@/stores/split-view-store";

export interface ResolvedPaneModel {
  readonly model: string;
  readonly modelId: string;
  readonly platformId: PlatformId | null;
  /**
   * Older builds stored hosted selections as `official:<model>` (and, before
   * that, as an unqualified model id). Community builds cannot execute those
   * selections; callers must ask the user to choose a configured local
   * provider instead of silently substituting credentials.
   */
  readonly requiresLocalSelection: boolean;
}

export function resolveStoredModel(model: string): ResolvedPaneModel {
  const decoded = decodeConversationModel(model);
  return {
    model,
    modelId: decoded.modelId,
    platformId: decoded.platformId,
    requiresLocalSelection: decoded.platformId === null,
  };
}

export function resolveGlobalModel(): ResolvedPaneModel {
  const settings = useSettingsStore.getState();
  const platformId = settings.activePlatformId;
  const modelId = settings.platforms[platformId].activeModelId;
  return {
    model: encodeConversationModel(platformId, modelId),
    modelId,
    platformId,
    requiresLocalSelection: false,
  };
}

export function resolveDraftPaneModelState(paneId: SplitPaneId): DraftPaneModelState | null {
  return useSplitViewStore.getState().draftPaneModels[paneId] ?? null;
}

export function resolvePaneModel({
  paneId,
  conversationId,
}: {
  readonly paneId?: SplitPaneId | null;
  readonly conversationId?: string | null;
}): ResolvedPaneModel {
  // A bound conversation is authoritative. Draft state is only used before a
  // conversation exists.
  if (conversationId) {
    const conversation = useConversationStore
      .getState()
      .conversations.find((entry) => entry.id === conversationId);
    if (conversation?.model) {
      return resolveStoredModel(conversation.model);
    }
  }

  if (paneId) {
    const draftPaneModel = resolveDraftPaneModelState(paneId);
    if (draftPaneModel) {
      return resolveStoredModel(draftPaneModel.model);
    }
  }

  return resolveGlobalModel();
}
