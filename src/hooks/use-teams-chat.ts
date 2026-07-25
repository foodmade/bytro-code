import { useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import {
  useTeamsStore,
  useSettingsStore,
  useWorkspaceStore,
  useMcpStore,
  usePermissionStore,
} from "@/stores";
import { buildProfileProxyUrl, resolveActiveCredentials } from "@/lib/platform-config";
import { buildTeamsAuthInvokeArgs } from "@/lib/teams-auth-reference";
import type { TeamsAgentConfig } from "@/stores";

// ---------------------------------------------------------------------------
// Prompt generation — build an initialization prompt from agent roles
// ---------------------------------------------------------------------------

function buildInitPrompt(agents: ReadonlyArray<TeamsAgentConfig>, customPrompt?: string): string {
  const roleList = agents
    .map((a) => `- **${a.name}** (role: ${a.role}): ${a.description}`)
    .join("\n");

  const lines = [
    "Create a collaborative team with the following members:",
    "",
    roleList,
    "",
    "## Instructions",
    "1. First, use the TeamCreate tool to create a new team.",
    "2. Then use the Task tool with the `team_name` parameter to spawn EACH team member listed above.",
    "   - Spawn ALL members IN PARALLEL (multiple Task calls in ONE response).",
    "   - Use the EXACT name shown for each member (e.g. name=\"dev\", name=\"reviewer\").",
    "   - Do NOT specify a model parameter — teammates will inherit the current model automatically.",
    "   - Use subagent_type=\"general-purpose\" for all teammates.",
    "3. After ALL team members have been successfully spawned, you MUST include the exact text `[TEAMS_READY]` in your response. This is a required machine-readable signal.",
    "4. After outputting `[TEAMS_READY]`, briefly inform the user that the team is ready. List the available members and remind them they can use @agent_name to address specific members.",
    "5. Then wait for the user to provide a task. Do NOT start any work until the user gives instructions.",
    "6. Do NOT include `[TEAMS_READY]` until every single team member has been spawned.",
    "7. When the user later assigns tasks, coordinate using SendMessage and TaskCreate/TaskUpdate tools.",
    "8. Resume existing teammates (via Task with resume) rather than creating new agents.",
  ];

  if (customPrompt?.trim()) {
    lines.push("", "## Custom Instructions from User", customPrompt.trim());
  }

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Directed message formatting — @agentName → [DIRECTED:agentName] prefix
// ---------------------------------------------------------------------------

/**
 * Parse @agentName from the start of a message and wrap it in a
 * machine-readable `[DIRECTED:agentName]` prefix for the sidecar.
 * If no @mention is found, returns the message as-is.
 */
function formatForRouting(task: string): { formatted: string; targetAgent?: string } {
  const match = task.match(/^@(\S+)\s+([\s\S]+)$/);
  if (match) {
    const [, targetAgent, content] = match;
    return { formatted: `[DIRECTED:${targetAgent}] ${content}`, targetAgent };
  }
  return { formatted: task };
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

/**
 * Hook for teams mode lifecycle.
 *
 * - `launchTeam`  — send init prompt to backend, create session in "initializing" state.
 * - `sendTask`    — send a user task to the running session.
 * - `abortTeam`   — abort the running session.
 */
export function useTeamsChat() {
  /**
   * Launch a team: generate an init prompt from agent configs, call the backend,
   * and create the session in "initializing" state. The frontend will switch to
   * TeamsView once the `teams-start` event confirms initialization.
   */
  const launchTeam = useCallback(async (
    agents: ReadonlyArray<TeamsAgentConfig>,
    customPrompt?: string,
    teamModelId?: string,
  ) => {
    const settings = useSettingsStore.getState();
    const workspace = useWorkspaceStore.getState();
    const mcpStore = useMcpStore.getState();
    const claudeCredentials = resolveActiveCredentials(settings.platforms.claude);
    const claudeProfile = settings.platforms.claude.profiles.find(
      (profile) => profile.id === settings.platforms.claude.activeProfileId,
    );
    const authArgs = buildTeamsAuthInvokeArgs(claudeProfile, claudeCredentials);

    if (!teamModelId || !authArgs) {
      throw new Error("teamModelId is required");
    }

    const requestId = crypto.randomUUID();

    // Create session in "initializing" phase immediately
    useTeamsStore.getState().createSession(requestId, agents);

    const activeWs = workspace.workspaces.find((w) => w.id === workspace.activeWorkspaceId);
    const cwd = activeWs?.path ?? "";

    const serverKeys = Object.keys(mcpStore.servers);
    const mcpServers = serverKeys.length > 0 ? mcpStore.servers : undefined;

    // Build the initialization prompt from agent roles (with optional custom instructions)
    const initPrompt = buildInitPrompt(agents, customPrompt);

    try {
      await invoke("stream_teams_chat", {
        requestId,
        task: initPrompt,
        agents: agents.map((a) => ({
          name: a.name,
          role: a.role,
          description: a.description,
          prompt: a.prompt,
          tools: a.tools ? [...a.tools] : undefined,
          model: a.model ?? undefined,
        })),
        cwd: cwd || undefined,
        permissionMode: usePermissionStore.getState().mode,
        ...authArgs,
        proxyUrl: buildProfileProxyUrl(claudeProfile),
        provider: "claude",
        model: teamModelId,
        mcpServers: mcpServers ?? undefined,
        responseLanguage: settings.responseLanguage !== "auto" ? settings.responseLanguage : undefined,
      });
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      useTeamsStore.getState().setSessionError(errorMsg);
    }
  }, []);

  /** Send a follow-up user task to the running session via user_input. */
  const sendTask = useCallback(async (
    task: string,
    images?: ReadonlyArray<{ media_type: string; data: string }>,
  ) => {
    const teamsStore = useTeamsStore.getState();
    const session = teamsStore.session;
    if (!session || session.phase === "initializing" || session.phase === "error") return;

    // Parse @agentName and format for routing
    const { formatted, targetAgent } = formatForRouting(task);

    // Determine initial message status — "queued" when team is busy, "sent" otherwise
    const isTeamBusy = session.phase === "running";
    const msgId = crypto.randomUUID();

    const now = Date.now();

    // Record the user message in the session's message history
    teamsStore.addMessage({
      id: msgId,
      sender: "user",
      targetAgent,
      content: task,
      timestamp: now,
      type: "user_message",
      status: isTeamBusy ? "queued" : "sent",
    });

    // Also add as a visible log entry in the target agent's card (or main)
    const logTarget = targetAgent ?? "main";
    teamsStore.appendAgentLogEntry(logTarget, {
      type: "user_message",
      timestamp: now,
      content: task,
      metadata: { sender: "user", targetAgent },
    });

    // Transition to "running" from "ready" or "done" (resuming after idle).
    if (session.phase === "ready" || session.phase === "done") {
      teamsStore.startRunning(session.requestId, task);
    }

    try {
      const teamsReasoningLevel = useSettingsStore.getState().reasoningLevel;
      await invoke("send_user_input", {
        requestId: session.requestId,
        content: formatted,
        images: images && images.length > 0 ? [...images] : null,
        reasoningLevel: teamsReasoningLevel !== "off" ? teamsReasoningLevel : undefined,
      });
      // If team was busy, the message is queued in the PromptChannel;
      // it will be processed when the current turn completes.
      // If team was idle, mark as sent immediately.
      if (!isTeamBusy) {
        teamsStore.updateMessageStatus(msgId, "sent");
      }
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      useTeamsStore.getState().setSessionError(errorMsg);
    }
  }, []);

  const abortTeam = useCallback(async () => {
    const session = useTeamsStore.getState().session;
    if (!session) return;

    try {
      await invoke("abort_chat", { requestId: session.requestId });
    } catch {
      // Ignore abort errors
    }
    useTeamsStore.getState().setSessionError("Team session aborted by user");
  }, []);

  return { launchTeam, sendTask, abortTeam };
}
