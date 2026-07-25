/**
 * Tracks warm (persistent) CLI sessions on the frontend.
 *
 * A warm session means the sidecar's CLI process is still alive between
 * conversation turns, waiting for the next message via PromptChannel.
 * Subsequent messages are routed directly to the warm session instead
 * of spawning a new CLI process.
 *
 * Module-level Maps are used (not Zustand) because this state is consumed
 * by both `system-handlers.ts` (event listeners) and `use-chat-streaming.ts`
 * (send logic), and doesn't need to trigger React re-renders.
 */

export interface WarmSessionConfig {
  readonly model: string;
  readonly platformId: string;
  readonly cwd: string;
  readonly reasoningLevel: string;
  readonly ultracodeEnabled?: boolean;
  readonly fastModeEnabled?: boolean;
  readonly serviceTier?: string;
  readonly goalModeEnabled?: boolean;
  readonly apiKey: string;
  readonly baseUrl: string;
  readonly authMode?: "apiKey" | "oauth";
  readonly profileId?: string;
  readonly permissionMode: string;
  readonly proxyUrl?: string;
}

/** conversationId → requestId of the warm session's original request. */
const warmSessionMap = new Map<string, string>();

/** conversationId → config snapshot when the session was created. */
const warmSessionConfigMap = new Map<string, WarmSessionConfig>();

/** Register a warm session after receiving `done(sessionAlive=true)`. */
export function registerWarmSession(
  conversationId: string,
  requestId: string,
  config: WarmSessionConfig,
): void {
  warmSessionMap.set(conversationId, requestId);
  warmSessionConfigMap.set(conversationId, config);
}

/** Get the requestId for a warm session, or undefined if none exists. */
export function getWarmSessionRequestId(conversationId: string): string | undefined {
  return warmSessionMap.get(conversationId);
}

/** Check whether the warm session's config has changed (requiring invalidation).
 *
 * All fields including apiKey/baseUrl are compared.  When credentials change
 * (e.g. user switches provider profile), the warm session must be killed so
 * the sidecar restarts with the new credentials.
 *
 * IMPORTANT: The registration side (system-handlers.ts) must resolve
 * credentials identically to use-chat-streaming.ts.
 */
export function shouldInvalidateWarmSession(
  conversationId: string,
  currentConfig: WarmSessionConfig,
): boolean {
  const saved = warmSessionConfigMap.get(conversationId);
  if (!saved) {
    return true;
  }
  const diffs: string[] = [];
  if (saved.model !== currentConfig.model) diffs.push("model");
  if (saved.platformId !== currentConfig.platformId) diffs.push("platformId");
  if (saved.cwd !== currentConfig.cwd) diffs.push("cwd");
  if (saved.reasoningLevel !== currentConfig.reasoningLevel) diffs.push("reasoningLevel");
  if ((saved.ultracodeEnabled ?? false) !== (currentConfig.ultracodeEnabled ?? false)) {
    diffs.push("ultracodeEnabled");
  }
  if ((saved.fastModeEnabled ?? false) !== (currentConfig.fastModeEnabled ?? false)) {
    diffs.push("fastModeEnabled");
  }
  if ((saved.serviceTier ?? "") !== (currentConfig.serviceTier ?? "")) {
    diffs.push("serviceTier");
  }
  if ((saved.goalModeEnabled ?? false) !== (currentConfig.goalModeEnabled ?? false)) {
    diffs.push("goalModeEnabled");
  }
  if (saved.apiKey !== currentConfig.apiKey) diffs.push("apiKey");
  if (saved.baseUrl !== currentConfig.baseUrl) diffs.push("baseUrl");
  if ((saved.authMode ?? "apiKey") !== (currentConfig.authMode ?? "apiKey")) {
    diffs.push("authMode");
  }
  if ((saved.profileId ?? "") !== (currentConfig.profileId ?? "")) diffs.push("profileId");
  if (saved.permissionMode !== currentConfig.permissionMode) diffs.push("permissionMode");
  if ((saved.proxyUrl ?? "") !== (currentConfig.proxyUrl ?? "")) diffs.push("proxyUrl");
  return diffs.length > 0;
}

/** Remove a warm session (called on session_ended, abort, or config change). */
export function clearWarmSession(conversationId: string): void {
  warmSessionMap.delete(conversationId);
  warmSessionConfigMap.delete(conversationId);
}
