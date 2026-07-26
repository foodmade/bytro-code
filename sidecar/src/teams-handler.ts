// ---------------------------------------------------------------------------
// Teams Handler — Claude CLI multi-agent orchestration
//
// The parent orchestrator dispatches tasks to general-purpose agents through
// stdin prompts, and hooks capture per-agent tool operations for real-time
// streaming to the frontend. Agent definitions are never placed in argv.
// ---------------------------------------------------------------------------

import { query } from "@anthropic-ai/claude-agent-sdk";
import type { HookCallback, Options } from "@anthropic-ai/claude-agent-sdk";
import { createHash } from "node:crypto";
import type { TeamsQueryCommand, TodoItem } from "./protocol.js";
import { buildPermissionConfig } from "./permissions.js";
import {
  truncate,
  findClaudeCodePath,
  computeTodoDiff,
  defaultToolDisplay,
  buildProcessEnvWithManagedPath,
  summarizeDiagnosticText,
} from "./shared.js";
import type { EmitFn } from "./shared.js";
import {
  applyCredentials,
  restoreCredentials,
  acquireCredentialLock,
} from "./credential-strategy.js";
import {
  PromptChannel,
  buildRedactedCliError,
  collectCliDiagnosticSecrets,
  redactCliDiagnostic,
} from "./claude-handler.js";
import { activePromptChannels } from "./persistent-session-registry.js";
import { filterValidMcpServers } from "./mcp-validator.js";
import { PromptStream } from "./teams-prompt-stream.js";
import { buildOrchestratorPrompt, formatDirectedMessage } from "./teams-prompt.js";
import { resolveAgentName, extractTaskResultSummary } from "./teams-agent-resolver.js";
import {
  createTaskTrackerState,
  updateTaskTrackerFromLifecycle,
  updateTaskTrackerFromTool,
} from "./task-tracker.js";
import {
  activeSubagentWatchers,
  findSubagentFilePath,
  startSubagentWatcher,
  pollSubagentFile,
  stopSubagentWatcher,
  stopAllSubagentWatchers,
} from "./teams-subagent-watcher.js";
import { readNewInboxMessages, formatInboxMessages } from "./teams-inbox.js";
import type { InboxMonitor } from "./teams-inbox.js";

type HookObserver = (...args: Parameters<HookCallback>) => Promise<void>;

function asObservationHook(observer: HookObserver): HookCallback {
  return async (...args) => {
    await observer(...args);
    return { continue: true };
  };
}

// ---------------------------------------------------------------------------
// Internal interfaces
// ---------------------------------------------------------------------------

/**
 * Maps agent session_id → agent name.
 * Populated from SubagentStart hooks; used to route tool events to specific agents.
 */
interface AgentSessionMap {
  /** session_id → agent name */
  readonly sessionToName: Map<string, string>;
  /** agent_id (from CLI stream events) → agent name */
  readonly agentIdToName: Map<string, string>;
}

/**
 * Mutable state shared between handleTeamsQuery and PromptStream.
 * Enables multi-turn support: the promptStream generator reads resolvedSessionId
 * and resets fullText between turns.
 */
interface TeamsStreamState {
  /** CLI session ID captured from the first stream message. */
  resolvedSessionId: string;
  /** Accumulated text from the orchestrator's current turn. */
  fullText: string;
  /** Whether the [TEAMS_READY] sentinel has been detected. */
  teamsReadyEmitted: boolean;
}

// ---------------------------------------------------------------------------
// Main handler
// ---------------------------------------------------------------------------

export async function handleTeamsQuery(
  cmd: TeamsQueryCommand,
  emit: EmitFn,
  activeAbortControllers: Map<string, AbortController>,
): Promise<void> {
  const {
    id,
    task,
    agents,
    cwd,
    permissionMode,
    apiKey,
    baseUrl,
    proxyUrl,
    platform,
    responseLanguage,
  } = cmd;
  const model = cmd.model ?? "claude-opus-4-7";
  const diagnosticSecrets = collectCliDiagnosticSecrets({
    apiKey,
    baseUrl,
    proxyUrl,
    mcpServers: cmd.mcpServers,
  });
  const stderrBuffer: string[] = [];

  // Generate a stable team name from the request ID for this session.
  const teamName = `team-${id.slice(0, 8)}`;

  process.stderr.write(
    `[teams-handler] handleTeamsQuery (TRUE TEAMS MODE):\n` +
      `  request  = ${summarizeDiagnosticText(id, "teams.request")}\n` +
      `  agents   = ${agents.length}\n` +
      `  task     = ${summarizeDiagnosticText(task, "teams.task")}\n` +
      `  model    = ${model}\n`,
  );

  // Acquire credential lock to prevent concurrent requests with different
  // providers from interleaving env-var mutations.
  const releaseCredentialLock = await acquireCredentialLock();
  const savedEnv = await applyCredentials(platform, apiKey, baseUrl, model, proxyUrl);
  let credentialReleased = false;
  const releaseCredentials = (): void => {
    if (credentialReleased) return;
    credentialReleased = true;
    restoreCredentials(savedEnv);
    releaseCredentialLock();
  };
  const abortController = new AbortController();
  activeAbortControllers.set(id, abortController);

  // Agent session tracking
  const agentMap: AgentSessionMap = {
    sessionToName: new Map(),
    agentIdToName: new Map(),
  };

  // Persistent set of ALL agent names ever seen (including dynamic members).
  // Unlike agentMap, this is NEVER pruned — entries survive SubagentStop deletion.
  const knownAgentNames = new Set<string>();

  // Mutable state — shared with PromptStream for multi-turn support.
  const streamState: TeamsStreamState = {
    resolvedSessionId: "",
    fullText: "",
    teamsReadyEmitted: false,
  };

  /** Constant agent name for the main orchestrator process. */
  const MAIN_AGENT_NAME = "main";

  /** Auto-nudge counters */
  const MAX_PRE_READY_NUDGES = 5;
  let preReadyNudgeCount = 0;
  const MAX_POST_READY_NUDGES = 30;
  let postReadyNudgeCount = 0;

  /** Track active teammate count */
  let activeTeammateCount = 0;

  /** Inbox monitor — declared before try so finally block can clean it up. */
  let inboxMonitor: InboxMonitor | null = null;

  // Emit teams_start — include the main orchestrator as an agent
  emit({
    evt: "teams_start",
    id,
    agentCount: agents.length + 1,
    agents: [
      { name: MAIN_AGENT_NAME, role: "orchestrator" },
      ...agents.map((a) => ({ name: a.name, role: a.role })),
    ],
  });

  try {
    const claudePath = findClaudeCodePath(cmd.claudeBinaryPath);
    if (!claudePath) {
      console.error("[teams-handler] Claude Code was not found on PATH or CLAUDE_CLI_PATH");
      emit({ evt: "teams_error", id, error: "Claude Code is not installed." });
      emit({ evt: "done", id });
      return;
    }

    const permConfig = buildPermissionConfig(permissionMode, id, emit);
    // Build the orchestrator prompt
    const orchestratorPrompt = buildOrchestratorPrompt(
      agents,
      task,
      teamName,
      responseLanguage,
      model,
    );

    // Mutable state for tracking
    const toolUseRegistry = new Map<string, { toolName: string; toolInput: string }>();
    const taskToolToAgent = new Map<string, string>();
    const pendingTaskDescriptions = new Map<string, string[]>();
    const pendingAgentNameQueue: string[] = [];
    const taskTrackerState = createTaskTrackerState();
    let previousTodos: ReadonlyArray<TodoItem> = [];

    /** Depth counter for subagent execution. */
    let subagentExecutionDepth = 0;

    // ------------------------------------------------------------------
    // Observation-only CLI stream callbacks
    // ------------------------------------------------------------------

    const subagentStartObserver: HookObserver = async (input, _toolUseID, _options) => {
      if (input.hook_event_name === "SubagentStart") {
        const raw = input as Record<string, unknown>;
        const agentId = typeof raw.agent_id === "string" ? raw.agent_id : "";
        const agentType = typeof raw.agent_type === "string" ? raw.agent_type : "";
        const sessionId = typeof raw.session_id === "string" ? raw.session_id : undefined;

        const queue = pendingTaskDescriptions.get(agentType);
        let description = queue?.shift();
        if (queue && queue.length === 0) pendingTaskDescriptions.delete(agentType);

        // Cross-queue fallback
        if (!description) {
          for (const [key, q] of pendingTaskDescriptions) {
            const idx = q.findIndex((d) => d.startsWith("[AGENT_NAME:"));
            if (idx !== -1) {
              description = q.splice(idx, 1)[0];
              if (q.length === 0) pendingTaskDescriptions.delete(key);
              break;
            }
          }
        }

        const primaryResolved = resolveAgentName(description, agentType, agents);
        const backupName = !primaryResolved ? pendingAgentNameQueue.shift() : undefined;
        const resolvedName =
          primaryResolved ?? backupName ?? (agentType || `agent-${agentId.slice(0, 8)}`);

        const nameQueueIdx = pendingAgentNameQueue.indexOf(resolvedName);
        if (nameQueueIdx !== -1) pendingAgentNameQueue.splice(nameQueueIdx, 1);

        if (agentId) {
          agentMap.agentIdToName.set(agentId, resolvedName);
          knownAgentNames.add(resolvedName);
          if (sessionId) {
            agentMap.sessionToName.set(sessionId, resolvedName);
          }
          activeTeammateCount++;
          process.stderr.write(
            `[teams-handler][SubagentStart] agent="${resolvedName}" agentId="${agentId}" ` +
              `activeTeammates=${activeTeammateCount}\n`,
          );
          emit({
            evt: "teams_agent_status",
            id,
            agentName: resolvedName,
            status: "spawned",
            message: description,
          });

          // Start watching subagent's JSONL file for real-time streaming.
          if (streamState.resolvedSessionId && agentId) {
            const capturedSessionId = streamState.resolvedSessionId;
            const capturedAgentId = agentId;
            const capturedName = resolvedName;

            const tryStartWatcher = (): boolean => {
              if (activeSubagentWatchers.has(capturedAgentId)) return true;
              const subagentFile = findSubagentFilePath(capturedSessionId, capturedAgentId);
              if (subagentFile) {
                startSubagentWatcher(capturedAgentId, capturedName, subagentFile, id, emit);
                return true;
              }
              return false;
            };

            if (!tryStartWatcher()) {
              const MAX_RETRIES = 15;
              const RETRY_DELAY_MS = 2000;
              (async () => {
                for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
                  await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS));
                  if (!agentMap.agentIdToName.has(capturedAgentId)) break;
                  if (abortController.signal.aborted) break;
                  if (tryStartWatcher()) {
                    process.stderr.write(
                      `[teams-handler] Found subagent file on retry ${attempt}\n`,
                    );
                    return;
                  }
                }
                process.stderr.write(
                  `[teams-handler] Could not find subagent file after ${MAX_RETRIES} retries\n`,
                );
              })();
            }
          }
        }
      }
    };

    const subagentStopObserver: HookObserver = async (input, _toolUseID, _options) => {
      if (input.hook_event_name === "SubagentStop") {
        const raw = input as Record<string, unknown>;
        const agentId = typeof raw.agent_id === "string" ? raw.agent_id : "";
        const agentName = agentMap.agentIdToName.get(agentId);
        await pollSubagentFile(agentId, id, emit);
        if (agentName) {
          activeTeammateCount = Math.max(0, activeTeammateCount - 1);
          emit({ evt: "teams_agent_status", id, agentName, status: "stopped" });
          process.stderr.write(
            `[teams-handler] SubagentStop: agent "${agentName}" (${agentId}) stopped. ` +
              `activeTeammates=${activeTeammateCount}. They may have sent SendMessage to the leader.\n`,
          );
          agentMap.agentIdToName.delete(agentId);

          if (streamState.teamsReadyEmitted && postReadyNudgeCount < MAX_POST_READY_NUDGES) {
            postReadyNudgeCount++;
            const stoppedName = agentName;
            const remaining = activeTeammateCount;
            process.stderr.write(
              `[teams-handler][NUDGE] SubagentStop for "${stoppedName}". ` +
                `remaining=${remaining}, nudge=${postReadyNudgeCount}/${MAX_POST_READY_NUDGES}\n`,
            );
            setTimeout(() => {
              if (abortController.signal.aborted) return;
              if (promptStream.isDoneFlag) return;

              const newMessages = inboxMonitor
                ? readNewInboxMessages(inboxMonitor, teamName, agents, knownAgentNames)
                : [];

              if (newMessages.length > 0) {
                process.stderr.write(
                  `[teams-handler][NUDGE] Injecting ${newMessages.length} actual message(s) after "${stoppedName}" stopped\n`,
                );
                const msgText = formatInboxMessages(newMessages);
                const suffix =
                  remaining === 0
                    ? "\n\nAll teammates have finished. Summarize the final results and report to the user."
                    : `\n\n${remaining} teammate(s) still working. Continue monitoring.`;
                promptStream.enqueue(msgText + suffix, streamState.resolvedSessionId);
              } else if (remaining === 0) {
                promptStream.enqueue(
                  `Teammate "${stoppedName}" has finished their work.` +
                    " All teammates have finished. Summarize the final results and report to the user.",
                  streamState.resolvedSessionId,
                );
              }
            }, 3000);
          }
        }
        stopSubagentWatcher(agentId);
      }
    };

    const preTaskObserver: HookObserver = async (input, _toolUseID, _options) => {
      const raw = input as Record<string, unknown>;
      const toolInput = raw.tool_input as Record<string, unknown> | undefined;
      const desc = typeof toolInput?.description === "string" ? toolInput.description : undefined;
      const subType =
        typeof toolInput?.subagent_type === "string" ? toolInput.subagent_type : undefined;
      const taskName = typeof toolInput?.name === "string" ? toolInput.name : undefined;

      if (desc && subType) {
        const effectiveDesc = taskName ? `[AGENT_NAME:${taskName}] ${desc}` : desc;
        const queue = pendingTaskDescriptions.get(subType);
        if (queue) {
          queue.push(effectiveDesc);
        } else {
          pendingTaskDescriptions.set(subType, [effectiveDesc]);
        }
      }
      if (taskName) {
        pendingAgentNameQueue.push(taskName);
      }

    };

    const todoWriteObserver: HookObserver = async (input, _toolUseID, _options) => {
      const raw = input as Record<string, unknown>;
      const toolInput = raw.tool_input as Record<string, unknown> | undefined;
      if (Array.isArray(toolInput?.todos)) {
        const newTodos = toolInput.todos as ReadonlyArray<TodoItem>;
        const diff = computeTodoDiff(previousTodos, newTodos);
        previousTodos = newTodos;
        emit({ evt: "todo_updated", id, todos: newTodos, diff });
      }
    };

    const taskToolObserver: HookObserver = async (input, _toolUseID, _options) => {
      const raw = input as Record<string, unknown>;
      const toolName = typeof raw.tool_name === "string" ? raw.tool_name : "";
      const toolInput = raw.tool_input as Record<string, unknown> | undefined;
      const update = updateTaskTrackerFromTool(
        taskTrackerState,
        previousTodos,
        toolName,
        toolInput,
        raw.tool_response,
      );
      if (update) {
        previousTodos = update.todos;
        emit({ evt: "todo_updated", id, todos: update.todos, diff: update.diff });
      }
    };

    const fileChangeObserver: HookObserver = async (input, _toolUseID, _options) => {
      const raw = input as Record<string, unknown>;
      const toolName = typeof raw.tool_name === "string" ? raw.tool_name : "";
      const toolInput = raw.tool_input as Record<string, unknown> | undefined;
      if (!toolInput) return;

      const filePath = typeof toolInput.file_path === "string" ? toolInput.file_path : "";
      if (!filePath) return;

      let action: "edit" | "create" | "delete" = "edit";
      let additions = 0;
      let deletions = 0;

      if (toolName === "Edit") {
        const oldStr = typeof toolInput.old_string === "string" ? toolInput.old_string : "";
        const newStr = typeof toolInput.new_string === "string" ? toolInput.new_string : "";
        additions = newStr.split("\n").length;
        deletions = oldStr.split("\n").length;
        if (!oldStr && newStr) {
          additions = newStr.split("\n").length;
          deletions = 0;
        }
      } else if (toolName === "Write") {
        action = "create";
        const content = typeof toolInput.content === "string" ? toolInput.content : "";
        additions = content.split("\n").length;
        deletions = 0;
      }

      emit({ evt: "file_changed", id, filePath, action, toolName, additions, deletions });
    };

    // ------------------------------------------------------------------
    // Build SDK options
    // ------------------------------------------------------------------

    const options: Options = {
      model,
      cwd,
      abortController,
      includePartialMessages: true,
      pathToClaudeCodeExecutable: claudePath,
      settingSources: ["user", "project", "local"],
      hooks: {
        SubagentStart: [{ hooks: [asObservationHook(subagentStartObserver)] }],
        SubagentStop: [{ hooks: [asObservationHook(subagentStopObserver)] }],
        PreToolUse: [{ matcher: "^(Task|Agent)$", hooks: [asObservationHook(preTaskObserver)] }],
        PostToolUse: [
          { matcher: "TodoWrite", hooks: [asObservationHook(todoWriteObserver)] },
          { matcher: "^(TaskCreate|TaskUpdate|TaskGet|TaskList)$", hooks: [asObservationHook(taskToolObserver)] },
          { matcher: "Edit|Write", hooks: [asObservationHook(fileChangeObserver)] },
        ],
        TaskCreated: [
          {
            hooks: [
              asObservationHook(async (input) => {
                const update = updateTaskTrackerFromLifecycle(
                  taskTrackerState,
                  previousTodos,
                  "created",
                  input as Record<string, unknown>,
                );
                if (update) {
                  previousTodos = update.todos;
                  emit({ evt: "todo_updated", id, todos: update.todos, diff: update.diff });
                }
              }),
            ],
          },
        ],
        TaskCompleted: [
          {
            hooks: [
              asObservationHook(async (input) => {
                const update = updateTaskTrackerFromLifecycle(
                  taskTrackerState,
                  previousTodos,
                  "completed",
                  input as Record<string, unknown>,
                );
                if (update) {
                  previousTodos = update.todos;
                  emit({ evt: "todo_updated", id, todos: update.todos, diff: update.diff });
                }
              }),
            ],
          },
        ],
      },
    };
    options.env = {
      ...buildProcessEnvWithManagedPath(undefined),
      CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: "1",
    };
    (options as Record<string, unknown>).stderr = (message: string) => {
      const summary = summarizeDiagnosticText(message, "teams.stderr");
      process.stderr.write(`[teams-cli] ${summary}\n`);
      stderrBuffer.push(summary);
      if (stderrBuffer.length > 64) {
        stderrBuffer.splice(0, stderrBuffer.length - 64);
      }
    };

    if (cmd.mcpServers && Object.keys(cmd.mcpServers).length > 0) {
      const { valid, skipped } = filterValidMcpServers(cmd.mcpServers);
      for (const s of skipped) {
        process.stderr.write(
          `[teams:mcp-validate] ${summarizeDiagnosticText(
            `${s.name}:${s.reason}`,
            "teams.mcp_skipped",
          )}\n`,
        );
      }
      if (Object.keys(valid).length > 0) {
        (options as Record<string, unknown>).mcpServers = valid;
      }
    }

    // Use SDK-native permissionMode instead of custom allowedTools mapping.
    options.permissionMode = permConfig.permissionMode;
    if (permConfig.allowDangerouslySkipPermissions) {
      options.allowDangerouslySkipPermissions = true;
    }
    if (permConfig.canUseTool) {
      options.canUseTool = permConfig.canUseTool;
    }

    options.systemPrompt = {
      type: "preset" as const,
      preset: "claude_code" as const,
      append: orchestratorPrompt,
    };

    // ------------------------------------------------------------------
    // PromptStream + PromptChannel setup
    // ------------------------------------------------------------------

    const promptStream = new PromptStream();

    const promptChannel = new PromptChannel(1_800_000); // 30 min keepalive for teams
    activePromptChannels.set(id, promptChannel);

    // Bridge: PromptChannel → PromptStream (with @mention formatting)
    const bridgePromise = (async () => {
      while (true) {
        const channelMsg = await promptChannel.waitForMessage();
        if (channelMsg === null) {
          process.stderr.write(
            `[teams-handler] Bridge: PromptChannel returned null (closed/timeout), closing PromptStream\n`,
          );
          promptStream.done();
          break;
        }
        const msg = formatDirectedMessage(channelMsg.text, emit, id);
        const imageCount = channelMsg.images?.length ?? 0;
        process.stderr.write(
          `[teams-handler] Bridge: forwarding user message to PromptStream (${msg.length} chars, ${imageCount} images)\n`,
        );
        streamState.fullText = "";
        emit({ evt: "new_turn", id });
        promptStream.enqueue(msg, streamState.resolvedSessionId, channelMsg.images);
      }
    })();
    bridgePromise.catch((err) => {
      const safeError = redactCliDiagnostic(String(err), diagnosticSecrets);
      process.stderr.write(
        `[teams-handler] ${summarizeDiagnosticText(safeError, "teams.bridge_error")}\n`,
      );
    });

    // ------------------------------------------------------------------
    // Inbox monitor
    // ------------------------------------------------------------------

    let inboxPollCount = 0;
    inboxMonitor = {
      timer: setInterval(() => {
        if (!inboxMonitor) return;
        if (abortController.signal.aborted) return;
        if (!streamState.teamsReadyEmitted) return;
        if (promptStream.isDoneFlag) return;

        inboxPollCount++;
        if (inboxPollCount % 10 === 1) {
          process.stderr.write(
            `[inbox-monitor] Poll #${inboxPollCount} heartbeat: ` +
              `leaderInbox=${inboxMonitor.leaderInboxName ?? "(undiscovered)"}, ` +
              `seenKeys=${inboxMonitor.seenKeys.size}, ` +
              `knownAgents=[${[...knownAgentNames].join(",")}], ` +
              `promptDone=${promptStream.isDoneFlag}\n`,
          );
        }

        const newMessages = readNewInboxMessages(inboxMonitor, teamName, agents, knownAgentNames);
        if (newMessages.length > 0) {
          process.stderr.write(
            `[inbox-monitor] Polling found ${newMessages.length} new message(s) from: ` +
              `[${newMessages.map((m) => m.from).join(", ")}]\n`,
          );
          promptStream.enqueue(formatInboxMessages(newMessages), streamState.resolvedSessionId);
        }
      }, 3000),
      seenKeys: new Set(),
      leaderInboxName: null,
    };

    // ------------------------------------------------------------------
    // Run query
    // ------------------------------------------------------------------

    promptStream.enqueue(task);

    process.stderr.write(`[teams-handler] Starting query with PromptStream (V2 pattern)\n`);
    const result = query({ prompt: promptStream, options });

    let sdkMsgSeq = 0;
    let launchFailed = false;

    const finishWithLaunchError = (error: string): void => {
      if (launchFailed) return;
      launchFailed = true;
      emit({
        evt: "teams_error",
        id,
        error: buildRedactedCliError(error, stderrBuffer, diagnosticSecrets),
      });
      promptStream.done();
      promptChannel.close();
      abortController.abort();
    };

    const processTeamsMsg = (raw: Record<string, unknown>): void => {
      sdkMsgSeq++;
      const msgType = raw.type as string;
      const isNoisyDelta =
        msgType === "stream_event" &&
        (raw.event as Record<string, unknown> | undefined)?.type === "content_block_delta";
      if (!isNoisyDelta) {
        const keys = Object.keys(raw);
        const serialized = JSON.stringify(raw);
        const digest = createHash("sha256").update(serialized).digest("hex").slice(0, 16);
        process.stderr.write(
          `[teams-handler][MSG #${sdkMsgSeq}] type="${msgType}" keys=[${keys.join(",")}] ` +
            `len=${Buffer.byteLength(serialized, "utf8")} sha256=${digest}\n`,
        );
      }

      if ("session_id" in raw && raw.session_id) {
        streamState.resolvedSessionId = raw.session_id as string;
        emit({ evt: "session", id, sessionId: raw.session_id as string });
      }

      switch (raw.type) {
        case "stream_event": {
          const event = (raw as { event: Record<string, unknown> }).event;
          if (event.type === "content_block_delta") {
            if (subagentExecutionDepth > 0) break;
            const delta = event.delta as
              | { type: string; text?: string; thinking?: string }
              | undefined;
            if (delta?.type === "text_delta") {
              streamState.fullText += delta.text ?? "";
              emit({
                evt: "teams_agent_delta",
                id,
                agentName: MAIN_AGENT_NAME,
                delta: delta.text ?? "",
              });

              if (
                !streamState.teamsReadyEmitted &&
                streamState.fullText.includes("[TEAMS_READY]")
              ) {
                streamState.teamsReadyEmitted = true;
                process.stderr.write(
                  `[teams-handler] [TEAMS_READY] sentinel detected — team ready, keeping session alive for follow-up turns\n`,
                );
                emit({
                  evt: "teams_ready",
                  id,
                  agents: [
                    { name: MAIN_AGENT_NAME, role: "orchestrator" },
                    ...agents.map((a) => ({ name: a.name, role: a.role })),
                  ],
                });
              }
            }
            if (delta?.type === "thinking_delta") {
              emit({
                evt: "teams_agent_thinking",
                id,
                agentName: MAIN_AGENT_NAME,
                delta: delta.thinking ?? "",
              });
            }
          }

          if (event.type === "message_start") {
            const message = event.message as Record<string, unknown> | undefined;
            const usage = message?.usage as Record<string, number> | undefined;
            if (usage) {
              emit({
                evt: "stream_usage",
                id,
                inputTokens: usage.input_tokens ?? 0,
                outputTokens: usage.output_tokens ?? 0,
                cacheReadTokens: usage.cache_read_input_tokens ?? 0,
                cacheCreationTokens: usage.cache_creation_input_tokens ?? 0,
              });
            }
          }

          if (event.type === "message_delta") {
            const usage = (event as Record<string, unknown>).usage as
              | Record<string, number>
              | undefined;
            if (usage) {
              emit({
                evt: "stream_usage",
                id,
                inputTokens: 0,
                outputTokens: usage.output_tokens ?? 0,
                cacheReadTokens: 0,
                cacheCreationTokens: 0,
              });
            }
          }
          break;
        }

        case "assistant": {
          if (subagentExecutionDepth > 0) break;

          const message = raw.message as { content?: unknown } | undefined;
          const content = message?.content;
          if (!Array.isArray(content)) break;

          for (const block of content) {
            const typedBlock = block as Record<string, unknown>;
            if (typedBlock.type !== "tool_use") continue;

            const toolInput = JSON.stringify(typedBlock.input);
            const blockId = typedBlock.id as string;
            const blockName = typedBlock.name as string;

            toolUseRegistry.set(blockId, { toolName: blockName, toolInput });

            if (
              [
                "SendMessage",
                "TeamCreate",
                "TeamDelete",
                "TaskCreate",
                "TaskList",
                "TaskUpdate",
              ].includes(blockName)
            ) {
              process.stderr.write(
                `[teams-handler][TOOL] Leader calling ${blockName}: ` +
                  `${summarizeDiagnosticText(toolInput, "teams.tool_input")}\n`,
              );
            }

            if (blockName === "Task" || blockName === "Agent") {
              subagentExecutionDepth++;
              const parsedInput = typedBlock.input as Record<string, unknown> | undefined;
              const desc =
                typeof parsedInput?.description === "string" ? parsedInput.description : "";
              const subType =
                typeof parsedInput?.subagent_type === "string" ? parsedInput.subagent_type : "";
              const targetAgent = resolveAgentName(desc, subType, agents);
              if (targetAgent) {
                taskToolToAgent.set(blockId, targetAgent);
              }
            }

            emit({
              evt: "teams_agent_tool_start",
              id,
              agentName: MAIN_AGENT_NAME,
              toolCallId: blockId,
              toolName: blockName,
              toolInput,
            });
          }
          break;
        }

        case "user": {
          const message = raw.message as { content?: unknown } | undefined;
          const content = message?.content;
          if (!Array.isArray(content)) break;

          for (const block of content) {
            const typedBlock = block as Record<string, unknown>;

            if (
              typedBlock.type === "text" &&
              typeof typedBlock.text === "string" &&
              typedBlock.text
            ) {
              process.stderr.write(
                `[teams-handler] ${summarizeDiagnosticText(typedBlock.text, "teams.user_text")}\n`,
              );
              emit({
                evt: "teams_agent_delta",
                id,
                agentName: MAIN_AGENT_NAME,
                delta: typedBlock.text as string,
              });
              continue;
            }

            if (typedBlock.type !== "tool_result") continue;

            const toolUseId = (typedBlock.tool_use_id as string) ?? "";
            const registered = toolUseRegistry.get(toolUseId);

            if (!registered) continue;

            const resultText =
              typeof typedBlock.content === "string"
                ? typedBlock.content
                : JSON.stringify(typedBlock.content);
            const isTaskTool = registered.toolName === "Task" || registered.toolName === "Agent";
            const targetAgent = isTaskTool ? taskToolToAgent.get(toolUseId) : undefined;

            if (isTaskTool) {
              subagentExecutionDepth = Math.max(0, subagentExecutionDepth - 1);
            }

            emit({
              evt: "teams_agent_tool_result",
              id,
              agentName: MAIN_AGENT_NAME,
              toolCallId: toolUseId,
              toolName: registered.toolName,
              toolInput: registered.toolInput,
              success: !typedBlock.is_error,
              result: truncate(resultText),
              display: defaultToolDisplay(!typedBlock.is_error),
            });

            if (isTaskTool && targetAgent) {
              const summary = extractTaskResultSummary(resultText);
              if (summary) {
                emit({
                  evt: "teams_agent_delta",
                  id,
                  agentName: targetAgent,
                  delta: summary,
                });
              }
            }

            toolUseRegistry.delete(toolUseId);
            if (targetAgent) taskToolToAgent.delete(toolUseId);
          }
          break;
        }

        case "result": {
          const resultText = typeof raw.result === "string" ? raw.result : "";
          const isResultError = raw.is_error === true || typeof raw.api_error_status === "number";
          process.stderr.write(
            `[teams-handler][RESULT] ===== RESULT received =====\n` +
              `  teamsReady=${streamState.teamsReadyEmitted}\n` +
              `  activeTeammates=${activeTeammateCount}\n` +
              `  preReadyNudges=${preReadyNudgeCount}/${MAX_PRE_READY_NUDGES}\n` +
              `  postReadyNudges=${postReadyNudgeCount}/${MAX_POST_READY_NUDGES}\n` +
              `  sessionEstablished=${streamState.resolvedSessionId.length > 0}\n` +
              `  result=${summarizeDiagnosticText(resultText, "teams.result")}\n` +
              `  promptStreamDone=${promptStream.isDoneFlag}\n` +
              `  aborted=${abortController.signal.aborted}\n`,
          );
          try {
            const usage = raw.usage as
              | {
                  input_tokens?: number;
                  output_tokens?: number;
                  cache_read_input_tokens?: number;
                  cache_creation_input_tokens?: number;
                }
              | undefined;
            const totalCost = (raw.total_cost_usd as number) ?? 0;
            if (usage) {
              const modelUsage = raw.modelUsage as
                | Record<string, { contextWindow?: number }>
                | undefined;
              const contextWindow = modelUsage?.[model]?.contextWindow ?? 0;
              emit({
                evt: "usage",
                id,
                inputTokens: usage.input_tokens ?? 0,
                outputTokens: usage.output_tokens ?? 0,
                cacheReadTokens: usage.cache_read_input_tokens ?? 0,
                cacheCreationTokens: usage.cache_creation_input_tokens ?? 0,
                totalCostUsd: totalCost,
                contextWindow,
                model,
              });
            }
          } catch {
            // Non-critical
          }

          if (!streamState.fullText) {
            streamState.fullText = resultText;
          }

          if (isResultError) {
            const status =
              typeof raw.api_error_status === "number"
                ? `HTTP ${raw.api_error_status}`
                : "API Error";
            finishWithLaunchError(resultText || status);
            break;
          }

          if (!streamState.teamsReadyEmitted && preReadyNudgeCount < MAX_PRE_READY_NUDGES) {
            preReadyNudgeCount++;
            process.stderr.write(
              `[teams-handler] result received but [TEAMS_READY] not yet detected ` +
                `(nudge ${preReadyNudgeCount}/${MAX_PRE_READY_NUDGES}). Auto-nudging.\n`,
            );
            promptStream.enqueue(
              "Continue. You have not finished setting up the team yet. " +
                "If you haven't created the team yet, use TeamCreate first. " +
                "Then spawn ALL remaining team members using the Task tool with team_name parameter. " +
                "Put all Task calls in ONE response for parallel execution. " +
                "Output [TEAMS_READY] when ALL members are ready.",
              streamState.resolvedSessionId,
            );
          }
          break;
        }

        case "system": {
          if (raw.subtype === "init") {
            const tools = Array.isArray(raw.tools) ? (raw.tools as string[]) : [];
            const teamsTools = tools.filter((t) =>
              [
                "TeamCreate",
                "TeamDelete",
                "SendMessage",
                "TaskCreate",
                "TaskList",
                "TaskUpdate",
                "TaskOutput",
              ].includes(t),
            );
            process.stderr.write(
              `[teams-handler][SYSTEM_INIT] total tools=${tools.length}, ` +
                `teamsTools=[${teamsTools.join(",")}] (${teamsTools.length} found), ` +
                `model=${typeof raw.model === "string" ? raw.model : "(unknown)"}\n`,
            );
            if (teamsTools.length === 0) {
              process.stderr.write(
                `[teams-handler][SYSTEM_INIT] WARNING: No Teams tools found! ` +
                  `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=${process.env.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS ?? "(unset)"}\n` +
                  `  All tools: [${tools.slice(0, 30).join(", ")}${tools.length > 30 ? "..." : ""}]\n`,
              );
            }
            // Teams mode: keep the simplified slash-command list (names only).
            // SDK enrichment via Query.supportedCommands() is plumbed through the
            // main claude-handler path; teams is a specialized flow where the
            // orchestrator drives subagents — slash-command UX isn't the focus.
            const teamsSimplifiedNames = Array.isArray(raw.slash_commands)
              ? (raw.slash_commands as string[])
              : [];
            emit({
              evt: "system_init",
              id,
              tools: Array.isArray(raw.tools) ? (raw.tools as string[]) : [],
              mcpServers: Array.isArray(raw.mcp_servers)
                ? (raw.mcp_servers as Array<{ name: string; status: string }>)
                : [],
              model: typeof raw.model === "string" ? raw.model : model,
              slashCommands: teamsSimplifiedNames.map((n) => ({ name: n, description: "" })),
            });
          } else if (raw.subtype === "status") {
            const status = typeof raw.status === "string" ? raw.status : "starting";
            emit({
              evt: "teams_startup_status",
              id,
              status,
              message: status,
            });
          } else if (raw.subtype === "api_retry") {
            const attempt = typeof raw.attempt === "number" ? raw.attempt : undefined;
            const maxAttempts = typeof raw.max_retries === "number" ? raw.max_retries : undefined;
            const retryDelayMs =
              typeof raw.retry_delay_ms === "number" ? raw.retry_delay_ms : undefined;
            const errorStatus = typeof raw.error_status === "number" ? raw.error_status : undefined;
            const error = typeof raw.error === "string" ? raw.error : "api_retry";
            const message = redactCliDiagnostic(
              errorStatus ? `HTTP ${errorStatus}: ${error}` : error,
              diagnosticSecrets,
            );
            emit({
              evt: "teams_startup_status",
              id,
              status: "api_retry",
              message,
              attempt,
              maxAttempts,
              retryDelayMs,
              errorStatus,
            });
            if (attempt !== undefined && maxAttempts !== undefined && attempt >= maxAttempts) {
              finishWithLaunchError(message);
            }
          } else if (raw.subtype === "task_updated") {
            const update = updateTaskTrackerFromLifecycle(
              taskTrackerState,
              previousTodos,
              "updated",
              raw,
            );
            if (update) {
              previousTodos = update.todos;
              emit({ evt: "todo_updated", id, todos: update.todos, diff: update.diff });
            }
            const patch =
              raw.patch && typeof raw.patch === "object" ? JSON.stringify(raw.patch) : "{}";
            process.stderr.write(
              `[teams-handler] task_id=${summarizeDiagnosticText(String(raw.task_id ?? ""), "teams.task_id")} ` +
                `patch=${summarizeDiagnosticText(patch, "teams.task_patch")}\n`,
            );
          } else if (raw.subtype === "task_started") {
            const taskName = typeof raw.name === "string" ? raw.name : undefined;
            const taskDesc = typeof raw.description === "string" ? raw.description : undefined;
            const taskType = typeof raw.task_type === "string" ? raw.task_type : undefined;
            process.stderr.write(
              `[teams-handler][task_started] name=${summarizeDiagnosticText(taskName ?? "", "teams.task_name")} ` +
                `task_type=${summarizeDiagnosticText(taskType ?? "", "teams.task_type")} ` +
                `desc=${summarizeDiagnosticText(taskDesc ?? "", "teams.task_description")}\n`,
            );
            if (taskName) {
              emit({
                evt: "teams_agent_status",
                id,
                agentName: taskName,
                status: "spawned",
                message: taskDesc ?? `Teammate ${taskName} started`,
              });
            }
          }
          break;
        }

        default: {
          const msgType = raw.type as string;
          const msgSubtype = raw.subtype as string | undefined;
          process.stderr.write(
            `[teams-handler] UNHANDLED msg type="${msgType}" subtype="${msgSubtype ?? ""}" keys=[${Object.keys(raw).join(",")}]\n`,
          );

          if (typeof raw.content === "string" && raw.content.length > 0) {
            emit({ evt: "teams_agent_delta", id, agentName: MAIN_AGENT_NAME, delta: raw.content });
          }
          if (typeof raw.message === "string" && raw.message.length > 0) {
            emit({ evt: "teams_agent_delta", id, agentName: MAIN_AGENT_NAME, delta: raw.message });
          }
          break;
        }
      }
    };

    // ------------------------------------------------------------------
    // Unified session loop
    // ------------------------------------------------------------------

    process.stderr.write(`[teams-handler] Entering for-await loop on SDK query result...\n`);
    for await (const msg of result) {
      // The CLI process has inherited its private options.env by the time the
      // first message arrives; release the global mutation lock immediately.
      releaseCredentials();
      if (abortController.signal.aborted) {
        process.stderr.write(`[teams-handler] for-await: aborted, breaking\n`);
        break;
      }
      processTeamsMsg(msg as Record<string, unknown>);
    }
    process.stderr.write(
      `[teams-handler] ===== for-await loop EXITED =====\n` +
        `  totalMsgs=${sdkMsgSeq}\n` +
        `  aborted=${abortController.signal.aborted}\n` +
        `  promptStreamDone=${promptStream.isDoneFlag}\n` +
        `  teamsReady=${streamState.teamsReadyEmitted}\n` +
        `  activeTeammates=${activeTeammateCount}\n`,
    );

    promptStream.done();
    promptChannel.close();

    process.stderr.write(
      `[teams-handler] Session loop ended. ` +
        `aborted=${abortController.signal.aborted}, ` +
        `teamsReady=${streamState.teamsReadyEmitted}, ` +
        `sessionEstablished=${streamState.resolvedSessionId.length > 0}\n`,
    );

    if (!launchFailed) {
      emit({ evt: "teams_complete", id, summary: "Team session completed." });
    }
  } catch (err: unknown) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    const safeError = buildRedactedCliError(errorMsg, stderrBuffer, diagnosticSecrets);
    process.stderr.write(`[teams-handler] ${summarizeDiagnosticText(safeError, "teams.error")}\n`);
    if (!abortController.signal.aborted) {
      if (streamState.fullText) {
        emit({ evt: "teams_complete", id, summary: "Team session completed with errors." });
      } else {
        emit({ evt: "teams_error", id, error: safeError });
      }
    }
  } finally {
    activeAbortControllers.delete(id);
    releaseCredentials();

    stopAllSubagentWatchers();

    if (inboxMonitor) {
      clearInterval(inboxMonitor.timer);
      inboxMonitor = null;
    }

    const ch = activePromptChannels.get(id);
    if (ch) {
      ch.close();
      activePromptChannels.delete(id);
    }
  }
}
