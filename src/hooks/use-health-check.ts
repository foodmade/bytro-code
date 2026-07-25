// bytro/src/hooks/use-health-check.ts
import { useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import {
  useHealthCheckStore,
  workspaceSnapshots,
  parseOverallResult,
} from "@/stores/health-check-store";
import { usePermissionStore, useSettingsStore, useWorkspaceStore } from "@/stores";
import { buildHealthCheckSystemPrompt, buildHealthCheckPrompt, buildDimensionPromptsMap } from "@/lib/health-check-prompt";
import { resolveActiveCredentials, getEffectiveSdk, buildProfileProxyUrl, type SdkType } from "@/lib/platform-config";
import { resolveGlobalModel } from "@/lib/pane-model";
import { buildStreamInvokePayload } from "@/lib/chat-stream-send";
import { track } from "@/lib/tracking";
import type {
  SubagentStartedPayload,
  SubagentCompletedPayload,
  CompletePayload,
  ErrorPayload,
} from "@/lib/stream-handlers/types";

// ---- Module-level listener state (persists across component mounts) ----

let listenerCleanup: (() => void) | null = null;

function cleanupListeners() {
  listenerCleanup?.();
  listenerCleanup = null;
}

/**
 * Complete a health check that finished while its workspace was backgrounded.
 * Updates the snapshot so the user sees the completed state when switching back.
 */
function completeBackgroundCheck(workspaceId: string, fullText: string): void {
  const snap = workspaceSnapshots.get(workspaceId);
  if (!snap) return;

  const result = parseOverallResult(fullText);
  const updatedDims = snap.dimensions.map((d) => {
    if (d.score !== null) {
      return d.status !== "completed" ? { ...d, status: "completed" as const } : d;
    }
    const backfillScore = result?.dimensionScores?.[d.id];
    return backfillScore != null
      ? { ...d, status: "completed" as const, score: backfillScore }
      : { ...d, status: "completed" as const };
  });

  workspaceSnapshots.set(workspaceId, {
    ...snap,
    phase: "completed",
    overallScore: result?.overallScore ?? null,
    summary: result?.summary ?? null,
    dimensions: updatedDims,
    endTime: Date.now(),
  });

  // Also persist to DB
  if (result?.overallScore != null) {
    invoke("save_health_check_result", {
      workspaceId,
      overallScore: result.overallScore,
      summary: result.summary ?? "",
      dimensions: JSON.stringify(updatedDims),
    }).catch(() => {});
  }
}

function cancelBackgroundCheck(workspaceId: string): void {
  const snap = workspaceSnapshots.get(workspaceId);
  if (!snap) return;

  workspaceSnapshots.set(workspaceId, {
    ...snap,
    phase: "cancelled",
    endTime: Date.now(),
    dimensions: snap.dimensions.map((d) =>
      d.status === "pending" || d.status === "running"
        ? { ...d, status: "cancelled" as const }
        : d,
    ),
  });
}

async function registerListeners(requestId: string, workspaceId: string): Promise<void> {
  cleanupListeners();

  const isActiveCheck = () => useHealthCheckStore.getState().requestId === requestId;

  const unlistens = await Promise.all([
    listen<SubagentStartedPayload>("chat-subagent-started", (e) => {
      if (e.payload.request_id !== requestId) return;
      if (!isActiveCheck()) return;
      useHealthCheckStore.getState().matchSubagentStarted(
        e.payload.agent_id,
        e.payload.description ?? "",
      );
    }),
    listen<SubagentCompletedPayload>("chat-subagent-completed", (e) => {
      if (e.payload.request_id !== requestId) return;
      if (!isActiveCheck()) return;
      useHealthCheckStore.getState().matchSubagentCompleted(
        e.payload.tool_use_id,
        e.payload.result,
      );
    }),
    listen<CompletePayload>("chat-complete", (e) => {
      if (e.payload.request_id !== requestId) return;
      const store = useHealthCheckStore.getState();
      if (store.requestId === requestId) {
        store.completeFromFullText(e.payload.full_text);
        persistResult(workspaceId).catch(() => {});
      } else {
        // Health check completed while workspace was backgrounded
        completeBackgroundCheck(workspaceId, e.payload.full_text);
      }
      cleanupListeners();
    }),
    listen<ErrorPayload>("chat-error", (e) => {
      if (e.payload.request_id !== requestId) return;
      const store = useHealthCheckStore.getState();
      if (store.requestId === requestId) {
        store.cancel();
      } else {
        cancelBackgroundCheck(workspaceId);
      }
      cleanupListeners();
    }),
  ]);

  listenerCleanup = () => unlistens.forEach((fn) => fn());
}

// ---- Hook ----

export function useHealthCheck() {
  const startCheck = useCallback(async () => {
    const workspace = useWorkspaceStore.getState().activeWorkspace;
    if (!workspace) return;

    track("health_check", "health_check.started");
    const requestId = crypto.randomUUID();
    useHealthCheckStore.getState().start(requestId);

    // Register module-level listeners (persist across component mounts)
    await registerListeners(requestId, workspace.id);

    // Resolve local API-key and provider OAuth profiles the same way as chat.
    const settings = useSettingsStore.getState();
    const modelSelection = resolveGlobalModel();
    const resolvedPlatformId = modelSelection.platformId ?? settings.activePlatformId;
    const platformConfig = settings.platforms[resolvedPlatformId];
    const activeProfile = platformConfig?.profiles.find(
      (p) => p.id === platformConfig.activeProfileId,
    );
    const activeProfileAgentProxyUrl = buildProfileProxyUrl(activeProfile);
    const isClaudeOAuthProfile =
      resolvedPlatformId === "claude" && activeProfile?.authMode === "oauth";
    const isCodexOAuthProfile =
      resolvedPlatformId === "codex" && activeProfile?.authMode === "oauth";

    try {
      let agentType: SdkType;
      let selectedModel: string;
      let apiKey: string;
      let baseUrl: string;
      const authMode: "apiKey" | "oauth" =
        isClaudeOAuthProfile || isCodexOAuthProfile ? "oauth" : "apiKey";
      const authProfileId = authMode === "oauth" ? activeProfile?.id : undefined;
      const oauthProvider = authMode === "oauth" ? resolvedPlatformId : undefined;

      if (isClaudeOAuthProfile && activeProfile) {
        // Rust resolves this provider/profile reference immediately before
        // writing the local sidecar command.
        agentType = "claude";
        selectedModel = modelSelection.modelId || platformConfig.activeModelId;
        baseUrl = "";
        apiKey = "";
      } else if (isCodexOAuthProfile) {
        agentType = "codex";
        selectedModel = modelSelection.modelId || platformConfig.activeModelId;
        apiKey = "";
        baseUrl = "";
      } else {
        const creds = resolveActiveCredentials(platformConfig);
        agentType = getEffectiveSdk(platformConfig);
        selectedModel = creds?.model ?? platformConfig.activeModelId;
        apiKey = creds?.apiKey ?? "";
        baseUrl = creds?.baseUrl ?? "";
      }

      // Orchestrator model: it only dispatches 5 sub-agent tool calls and
      // aggregates scores, so a fast model is sufficient. We must NOT hardcode
      // a model ID. A fixed ID (previously "claude-sonnet-4-20250514") is
      // rejected by accounts/subscriptions that don't expose that exact model
      // — the Claude Code CLI returns "There's an issue with the selected
      // model … It may not exist or you may not have access to it.", the
      // orchestrator request fails, and the whole health-check silently aborts
      // with no score (observed on Claude OAuth subscription profiles).
      // Always fall back to the user's currently selected (already-validated)
      // model instead.
      const orchestratorModel = selectedModel;

      const agentProxyUrl =
        agentType === "claude" || agentType === "codex"
          ? activeProfileAgentProxyUrl
          : undefined;

      const invokePayload = buildStreamInvokePayload({
        requestId,
        agentType,
        messages: [{ role: "user", content: buildHealthCheckPrompt() }],
        model: orchestratorModel,
        baseUrl: baseUrl || undefined,
        apiKey: authMode === "oauth" ? undefined : apiKey || undefined,
        authMode,
        profileId: authProfileId,
        oauthProvider,
        systemPrompt: buildHealthCheckSystemPrompt(),
        permissionMode: usePermissionStore.getState().mode,
        sessionId: null,
        cwd: workspace.path,
        proxyUrl: agentProxyUrl,
        disableTools: false,
        thinkingEnabled: false,
        dimensionPrompts: buildDimensionPromptsMap(),
        platform: resolvedPlatformId,
      });

      await invoke("stream_chat", invokePayload);
    } catch (err) {
      console.error("[health-check] stream_chat failed:", err);
      useHealthCheckStore.getState().cancel();
      cleanupListeners();
    }
  }, []);

  const cancelCheck = useCallback(async () => {
    const requestId = useHealthCheckStore.getState().requestId;
    if (!requestId) return;

    try {
      await invoke("abort_chat", { requestId });
    } catch {
      // Best-effort abort
    }
    useHealthCheckStore.getState().cancel();
    cleanupListeners();
  }, []);

  // No cleanup on unmount — listeners are intentionally module-level
  // so they persist when navigating between views.

  return { startCheck, cancelCheck };
}

// ---- Persistence helpers ----

async function persistResult(workspaceId: string): Promise<void> {
  const { overallScore, summary, dimensions } = useHealthCheckStore.getState();
  if (overallScore == null) return;

  try {
    await invoke("save_health_check_result", {
      workspaceId,
      overallScore,
      summary: summary ?? "",
      dimensions: JSON.stringify(dimensions),
    });
  } catch {
    // Best-effort persistence — failure is non-critical
  }
}

export async function loadHealthCheckHistory(workspaceId: string, limit = 20): Promise<void> {
  try {
    const results = await invoke<Array<{
      id: string;
      workspace_id: string;
      overall_score: number;
      summary: string;
      dimensions: string;
      created_at: string;
    }>>("list_health_check_results", { workspaceId, limit });

    useHealthCheckStore.getState().setHistoryResults(
      results.map((r) => ({
        id: r.id,
        workspaceId: r.workspace_id,
        overallScore: r.overall_score,
        summary: r.summary,
        dimensions: JSON.parse(r.dimensions),
        createdAt: r.created_at,
      })),
    );
  } catch {
    useHealthCheckStore.getState().setHistoryResults([]);
  }
}

export async function loadLastHealthCheckResult(workspaceId: string): Promise<void> {
  try {
    const result = await invoke<{
      id: string;
      workspace_id: string;
      overall_score: number;
      summary: string;
      dimensions: string;
      created_at: string;
    } | null>("get_last_health_check_result", { workspaceId });

    if (result) {
      useHealthCheckStore.getState().setLastResult({
        id: result.id,
        workspaceId: result.workspace_id,
        overallScore: result.overall_score,
        summary: result.summary,
        dimensions: JSON.parse(result.dimensions),
        createdAt: result.created_at,
      });
    } else {
      useHealthCheckStore.getState().setLastResult(null);
    }
  } catch {
    useHealthCheckStore.getState().setLastResult(null);
  }
}
