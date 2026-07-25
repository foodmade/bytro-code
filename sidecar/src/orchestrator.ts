// ---------------------------------------------------------------------------
// Multi-model team orchestrator
// Coordinates tasks across Claude, Codex, and Gemini agents
// ---------------------------------------------------------------------------

import type { OrchestrateCommand, TeamMemberConfig, QueryCommand, SidecarEvent } from "./protocol.js";
import { handleClaudeQuery } from "./claude-handler.js";
import { handleOpenAIQuery } from "./openai-handler.js";
import { handleGeminiQuery } from "./gemini-handler.js";
import { createLogger, publicSidecarErrorMessage } from "./shared.js";

type EmitFn = (evt: object) => void;

const log = createLogger("orchestrator");

interface Subtask {
  readonly id: string;
  readonly description: string;
  readonly assignedTo: string;
}

function orchestrationPermissionMode(cmd: OrchestrateCommand): string {
  return cmd.permissionMode === "bypassPermissions"
    ? "bypassPermissions"
    : cmd.permissionMode === "acceptEdits"
      ? "acceptEdits"
      : cmd.permissionMode === "plan"
        ? "plan"
        : "default";
}

/**
 * Parse the leader's task decomposition output into subtasks.
 * Expected format: numbered list with [MemberName] prefix.
 *
 * Example:
 * 1. [coder] Implement the login form component
 * 2. [reviewer] Review the authentication flow
 */
function parseSubtasks(
  leaderOutput: string,
  team: ReadonlyArray<TeamMemberConfig>,
): ReadonlyArray<Subtask> {
  const subtasks: Subtask[] = [];
  const lines = leaderOutput.split("\n");

  for (const line of lines) {
    const trimmed = line.trim();
    // Match patterns like: "1. [name] description" or "- [name] description"
    const match = trimmed.match(/^(?:\d+[.)]\s*|-\s*)\[([^\]]+)\]\s*(.+)/);
    if (match) {
      const assignee = match[1].trim().toLowerCase();
      const description = match[2].trim();
      // Find the team member (case-insensitive)
      const member = team.find((m) => m.name.toLowerCase() === assignee);
      if (member) {
        subtasks.push({
          id: `st-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
          description,
          assignedTo: member.name,
        });
      }
    }
  }

  // If parsing failed, assign the whole task to the first non-leader member
  if (subtasks.length === 0) {
    const worker = team.find((m) => m.role !== "leader");
    if (worker) {
      subtasks.push({
        id: `st-${Date.now()}-fallback`,
        description: leaderOutput.slice(0, 500),
        assignedTo: worker.name,
      });
    }
  }

  return subtasks;
}

/**
 * Execute a subtask by delegating to the appropriate handler.
 * Returns the agent's text output.
 */
async function executeSubtask(
  member: TeamMemberConfig,
  subtask: Subtask,
  cmd: OrchestrateCommand,
  emit: EmitFn,
  activeAbortControllers: Map<string, AbortController>,
): Promise<string> {
  return new Promise<string>((resolve) => {
    let fullText = "";

    const subEmit: EmitFn = (evt: object) => {
      const e = evt as SidecarEvent;
      if (e.evt === "text_delta") {
        fullText += e.delta;
        // Forward text deltas with orchestration request id
        emit({ evt: "text_delta", id: cmd.id, delta: `[${member.name}] ${e.delta}` });
      }
      if (e.evt === "complete") {
        fullText = e.fullText || fullText;
      }
      if (e.evt === "done") {
        resolve(fullText);
      }
      if (e.evt === "error") {
        resolve(`Error: ${e.error}`);
      }
      // Forward tool events with the orchestration id
      if (e.evt === "tool_start" || e.evt === "tool_result" || e.evt === "permission_request" || e.evt === "tool_denied") {
        emit({ ...e, id: cmd.id });
      }
      // Forward media events with the orchestration id
      if (e.evt === "media") {
        emit({ ...e, id: cmd.id });
      }
    };

    const queryCmd: QueryCommand = {
      cmd: "query",
      id: `${cmd.id}-${subtask.id}`,
      agent: member.agent,
      prompt: subtask.description,
      model: member.model,
      systemPrompt: `You are ${member.name}, a ${member.role} on a multi-agent team. Complete the following task precisely and concisely.`,
      permissionMode: orchestrationPermissionMode(cmd),
      cwd: cmd.cwd,
      sessionId: null,
      apiKey: member.agent === "claude"
        ? cmd.keys.anthropicKey
        : member.agent === "codex"
          ? cmd.keys.openaiKey
          : cmd.keys.geminiKey,
    };

    const handler = member.agent === "codex"
      ? handleOpenAIQuery
      : member.agent === "gemini"
        ? handleGeminiQuery
        : handleClaudeQuery;

    handler(queryCmd, subEmit, activeAbortControllers).catch((err) => {
      resolve(`Error executing subtask: ${err instanceof Error ? err.message : String(err)}`);
    });
  });
}

export async function handleOrchestrate(
  cmd: OrchestrateCommand,
  emit: EmitFn,
  activeAbortControllers: Map<string, AbortController>,
): Promise<void> {
  const { id, task, team } = cmd;
  const permissionMode = orchestrationPermissionMode(cmd);

  try {
    emit({ evt: "orchestrate_start", id, teamSize: team.length });

    // 1. Find the leader
    const leader = team.find((m) => m.role === "leader");
    if (!leader) {
      emit({ evt: "error", id, error: "No leader role defined in team configuration." });
      return;
    }

    // 2. Leader analyzes and decomposes the task
    const leaderPrompt = `You are the team leader. Analyze this task and break it down into subtasks for your team members.

Team members:
${team.filter((m) => m.role !== "leader").map((m) => `- [${m.name}] Role: ${m.role}, Model: ${m.agent}/${m.model}`).join("\n")}

Task: ${task}

Respond with a numbered list of subtasks. Each line MUST start with the member name in brackets:
1. [member_name] Description of the subtask
2. [member_name] Description of another subtask

Be specific and actionable. Assign subtasks based on each member's role.`;

    let leaderOutput = "";
    const leaderEmit: EmitFn = (evt: object) => {
      const e = evt as SidecarEvent;
      if (e.evt === "text_delta") {
        leaderOutput += e.delta;
        emit({ evt: "text_delta", id, delta: e.delta });
      }
      if (e.evt === "complete") {
        leaderOutput = e.fullText || leaderOutput;
      }
    };

    const leaderQueryCmd: QueryCommand = {
      cmd: "query",
      id: `${id}-leader`,
      agent: leader.agent,
      prompt: leaderPrompt,
      model: leader.model,
      systemPrompt: "You are a team leader who decomposes tasks into subtasks for team members.",
      permissionMode,
      cwd: cmd.cwd,
      sessionId: null,
      apiKey: leader.agent === "claude"
        ? cmd.keys.anthropicKey
        : leader.agent === "codex"
          ? cmd.keys.openaiKey
          : cmd.keys.geminiKey,
    };

    const leaderHandler = leader.agent === "codex"
      ? handleOpenAIQuery
      : leader.agent === "gemini"
        ? handleGeminiQuery
        : handleClaudeQuery;

    await new Promise<void>((resolve) => {
      const wrappedEmit: EmitFn = (evt: object) => {
        leaderEmit(evt);
        const e = evt as SidecarEvent;
        if (e.evt === "done" || e.evt === "error") {
          resolve();
        }
      };
      leaderHandler(leaderQueryCmd, wrappedEmit, activeAbortControllers).catch(() => resolve());
    });

    // 3. Parse subtasks
    const subtasks = parseSubtasks(leaderOutput, team);

    if (subtasks.length === 0) {
      emit({ evt: "error", id, error: "Leader failed to produce valid subtask assignments." });
      return;
    }

    // 4. Execute subtasks (in parallel where possible)
    const results: Array<{ subtask: Subtask; result: string; success: boolean }> = [];

    // Emit subtask_start for each
    for (const subtask of subtasks) {
      const member = team.find((m) => m.name === subtask.assignedTo);
      emit({
        evt: "subtask_start",
        id,
        subtaskId: subtask.id,
        assignedTo: subtask.assignedTo,
        agent: member?.agent ?? "unknown",
        description: subtask.description,
      });
    }

    // Execute all subtasks in parallel
    const promises = subtasks.map(async (subtask) => {
      const member = team.find((m) => m.name === subtask.assignedTo);
      if (!member) {
        return { subtask, result: `Member "${subtask.assignedTo}" not found`, success: false };
      }

      try {
        const result = await executeSubtask(member, subtask, cmd, emit, activeAbortControllers);
        emit({
          evt: "subtask_complete",
          id,
          subtaskId: subtask.id,
          assignedTo: subtask.assignedTo,
          result: result.slice(0, 500),
          success: true,
        });
        return { subtask, result, success: true };
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : String(err);
        emit({
          evt: "subtask_complete",
          id,
          subtaskId: subtask.id,
          assignedTo: subtask.assignedTo,
          result: errorMsg,
          success: false,
        });
        return { subtask, result: errorMsg, success: false };
      }
    });

    const settled = await Promise.all(promises);
    results.push(...settled);

    // 5. Leader summarizes results
    const summaryPrompt = `You are the team leader. Your team has completed their subtasks. Summarize the results.

Original task: ${task}

Results:
${results.map((r) => `- [${r.subtask.assignedTo}] ${r.subtask.description}\n  Status: ${r.success ? "Success" : "Failed"}\n  Output: ${r.result.slice(0, 300)}`).join("\n\n")}

Provide a concise summary of what was accomplished and any remaining issues.`;

    let summaryText = "";
    const summaryEmit: EmitFn = (evt: object) => {
      const e = evt as SidecarEvent;
      if (e.evt === "text_delta") {
        summaryText += e.delta;
        emit({ evt: "text_delta", id, delta: e.delta });
      }
      if (e.evt === "complete") {
        summaryText = e.fullText || summaryText;
      }
    };

    const summaryQueryCmd: QueryCommand = {
      cmd: "query",
      id: `${id}-summary`,
      agent: leader.agent,
      prompt: summaryPrompt,
      model: leader.model,
      systemPrompt: "You are a team leader summarizing completed work.",
      permissionMode,
      cwd: cmd.cwd,
      sessionId: null,
      apiKey: leader.agent === "claude"
        ? cmd.keys.anthropicKey
        : leader.agent === "codex"
          ? cmd.keys.openaiKey
          : cmd.keys.geminiKey,
    };

    await new Promise<void>((resolve) => {
      const wrappedEmit: EmitFn = (evt: object) => {
        summaryEmit(evt);
        const e = evt as SidecarEvent;
        if (e.evt === "done" || e.evt === "error") {
          resolve();
        }
      };
      leaderHandler(summaryQueryCmd, wrappedEmit, activeAbortControllers).catch(() => resolve());
    });

    emit({ evt: "orchestrate_complete", id, summary: summaryText });
    emit({ evt: "done", id });
  } catch (err: unknown) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    log(`Orchestration error: ${errorMsg}`);
    emit({ evt: "error", id, error: publicSidecarErrorMessage(err) });
  }
}
