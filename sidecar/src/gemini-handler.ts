// ---------------------------------------------------------------------------
// Gemini CLI handler — ACP (Agent Client Protocol) mode
// Architecture: Sidecar → spawn `node <gemini-cli> --acp` → JSON-RPC 2.0
//   over NDJSON stdio → notifications → sidecar protocol
//
// Warm sessions: The ACP process is kept alive for the duration of the
// session. session/prompt is called for each turn within the same process.
// No per-turn process spawn overhead, true warm sessions like Claude/Codex.
//
// Key ACP methods:
//   - initialize: handshake + capabilities
//   - session/new: create session with cwd
//   - session/prompt: send user message (blocking until turn complete)
//   - session/cancel: cancel active prompt (notification)
//   - session/request_permission: server→client blocking permission request
//   - session/update: server→client notification (text, thinking, tools, usage)
// ---------------------------------------------------------------------------

import { GeminiRpcChannel } from "./gemini-rpc.js";
import type { QueryCommand } from "./protocol.js";
import {
  createLogger,
  makeToolCallId,
  truncate,
  buildEffectivePrompt,
  getContextWindowForModel,
  defaultToolDisplay,
  publicSidecarErrorMessage,
} from "./shared.js";
import type { EmitFn } from "./shared.js";
import type { CommandInvocationPayload } from "./protocol.js";
import {
  registerWarmSession, removeWarmSession, hashCredentials, activePromptChannels,
  type SessionChannel,
} from "./persistent-session-registry.js";
import { pendingConfirmations } from "./permissions.js";
import { validateProviderBaseUrl } from "./endpoint-validation.js";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, extname, join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { buildMinimalCliEnvironment } from "./cli-environment.js";

const log = createLogger("gemini");

// ---------------------------------------------------------------------------
// CLI path resolution — cached after first successful lookup
// ---------------------------------------------------------------------------

const ENTRY_POINTS = ["dist/index.js", "bundle/gemini.js"];

let cachedCliPath: string | undefined;

function resolveGeminiCLI(_cwd: string): string {
  if (cachedCliPath !== undefined) {
    if (existsSync(cachedCliPath)) return cachedCliPath;
    log("[resolve] cached Gemini CLI path no longer exists");
    cachedCliPath = undefined;
  }

  const resolved = resolveGeminiCliFromEnvironment(process.env);
  if (resolved) {
    cachedCliPath = resolved;
    return resolved;
  }

  throw new Error(
    "Gemini CLI not found. Set GEMINI_CLI_PATH to its JavaScript entry point " +
    "or launch Bytro with `gemini` available on the original PATH.",
  );
}

function geminiEntryFromPath(candidate: string): string | undefined {
  if (!existsSync(candidate)) return undefined;
  if ([".js", ".mjs", ".cjs"].includes(extname(candidate).toLowerCase())) {
    return candidate;
  }
  try {
    const real = realpathSync(candidate);
    if ([".js", ".mjs", ".cjs"].includes(extname(real).toLowerCase())) {
      return real;
    }
  } catch {
    // Continue with npm-shim-relative resolution.
  }
  const packageRoot = join(
    dirname(candidate),
    "node_modules",
    "@google",
    "gemini-cli",
  );
  for (const entry of ENTRY_POINTS) {
    const anchored = join(packageRoot, entry);
    if (existsSync(anchored)) return anchored;
  }
  return undefined;
}

export function resolveGeminiCliFromEnvironment(
  environment: NodeJS.ProcessEnv,
  platform: NodeJS.Platform = process.platform,
): string | undefined {
  const explicit = environment.GEMINI_CLI_PATH?.trim();
  if (explicit) {
    return geminiEntryFromPath(explicit);
  }

  const pathValue = environment.PATH ?? environment.Path ?? "";
  const pathDelimiter = platform === "win32" ? ";" : ":";
  const executableNames = platform === "win32"
    ? ["gemini.cmd", "gemini.exe", "gemini.bat", "gemini"]
    : ["gemini"];
  for (const directory of pathValue.split(pathDelimiter).filter(Boolean)) {
    for (const executableName of executableNames) {
      const resolved = geminiEntryFromPath(join(directory, executableName));
      if (resolved) return resolved;
    }
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Temp directory & Gemini home management
// ---------------------------------------------------------------------------

function createTempDir(): string {
  return mkdtempSync(join(tmpdir(), "gemini-sidecar-"));
}

function cleanupTempDir(tempDir: string | undefined): void {
  if (tempDir) {
    try { rmSync(tempDir, { recursive: true, force: true }); } catch { /* best-effort */ }
  }
}

/**
 * Write auth settings to force API key authentication (bypass OAuth).
 * Returns the path to use as GEMINI_CLI_HOME.
 */
function createTempGeminiHome(tempDir: string): string {
  const geminiDir = join(tempDir, ".gemini");
  mkdirSync(geminiDir, { recursive: true });
  writeFileSync(
    join(geminiDir, "settings.json"),
    JSON.stringify({ security: { auth: { selectedType: "gemini-api-key" } } }),
  );
  return tempDir;
}


// ---------------------------------------------------------------------------
// Permission mode helpers
// ---------------------------------------------------------------------------

/** Should we auto-approve all permissions without prompting the user? */
function isAutoApproveMode(mode: string): boolean {
  return mode === "bypassPermissions";
}

// ---------------------------------------------------------------------------
// Bash/shell tool detection — used for permission filtering
// ---------------------------------------------------------------------------

function isBashTool(toolName: string): boolean {
  return toolName === "run_shell_command";
}

// ---------------------------------------------------------------------------
// Sub-agent tool detection — Gemini CLI built-in sub-agents
// ---------------------------------------------------------------------------

/** Known Gemini CLI sub-agent tool names. */
const GEMINI_SUBAGENT_TOOLS = new Set([
  "codebase_investigator",
  "cli_help",
  "generalist",
]);

function isSubagentTool(toolName: string): boolean {
  return GEMINI_SUBAGENT_TOOLS.has(toolName);
}

/** Human-readable label for sub-agent tools. */
function subagentDisplayName(toolName: string): string {
  switch (toolName) {
    case "codebase_investigator": return "Codebase Investigator";
    case "cli_help": return "CLI Help";
    case "generalist": return "Generalist";
    default: return toolName;
  }
}

/** Extract the task description from sub-agent tool parameters. */
function subagentDescription(parameters: unknown): string {
  if (typeof parameters !== "object" || parameters === null) return "";
  const obj = parameters as Record<string, unknown>;
  // codebase_investigator uses "objective", others may use "prompt" or "task"
  return typeof obj.objective === "string" ? obj.objective
    : typeof obj.prompt === "string" ? obj.prompt
    : typeof obj.task === "string" ? obj.task
    : "";
}

// ---------------------------------------------------------------------------
// Per-session state (ACP mode)
// ---------------------------------------------------------------------------

interface GeminiSessionState {
  activeRequestId: string;
  conversationId: string | undefined;
  model: string;
  fullText: string;
  sessionEmitted: boolean;
  turnDoneEmitted: boolean;
  lastThoughtSubject: string;
  toolUseRegistry: Map<string, { toolName: string; toolInput: string }>;
  /** ACP session ID from session/new response */
  acpSessionId: string | undefined;
}

function resetTurnState(state: GeminiSessionState): void {
  state.fullText = "";
  state.toolUseRegistry.clear();
  state.lastThoughtSubject = "";
  state.turnDoneEmitted = false;
}

// ---------------------------------------------------------------------------
// File change inference helpers
// ---------------------------------------------------------------------------

function inferFileChangeAction(toolName: string): "edit" | "create" | "delete" | null {
  switch (toolName) {
    case "replace": return "edit";
    case "write_file": return "create";
    default: return null;
  }
}

function extractFilePath(toolInput: string): string | null {
  try {
    const parsed = JSON.parse(toolInput);
    return typeof parsed.file_path === "string" ? parsed.file_path
      : typeof parsed.path === "string" ? parsed.path
      : typeof parsed.filename === "string" ? parsed.filename
      : null;
  } catch { return null; }
}

// ---------------------------------------------------------------------------
// ACP notification processing — maps session/update to sidecar events
// ---------------------------------------------------------------------------

let _acpNotifLogCount = 0;

function processAcpNotification(
  method: string,
  params: Record<string, unknown>,
  state: GeminiSessionState,
  emit: EmitFn,
): void {
  if (method !== "session/update") {
    log(`[acp-notification] unhandled method=${method}`);
    return;
  }

  const id = state.activeRequestId;
  // ACP spec nests the real fields inside params.update
  const update = (params.update as Record<string, unknown> | undefined) ?? params;
  const updateType = (update.sessionUpdate as string | undefined)
    ?? (params.sessionUpdate as string | undefined);

  // Dump the first few notifications' raw shape to diagnose protocol mismatches
  if (_acpNotifLogCount < 5) {
    _acpNotifLogCount++;
    log(`[acp-notification-raw #${_acpNotifLogCount}] ${JSON.stringify(params).slice(0, 600)}`);
  }

  switch (updateType) {
    case "agent_message_chunk": {
      // ACP: content is a ContentBlock { type: "text", text: "..." } OR direct string
      const content = update.content as Record<string, unknown> | string | undefined;
      let delta: string | undefined;
      if (typeof content === "string") delta = content;
      else if (content && typeof content === "object") delta = content.text as string | undefined;
      if (!delta) delta = update.text as string | undefined;
      if (delta) {
        state.fullText += delta;
        emit({ evt: "text_delta", id, delta });
      }
      break;
    }

    case "agent_thought_chunk": {
      const content = update.content as Record<string, unknown> | string | undefined;
      let delta: string | undefined;
      if (typeof content === "string") delta = content;
      else if (content && typeof content === "object") delta = content.text as string | undefined;
      if (!delta) delta = update.text as string | undefined;
      if (delta) {
        const subject = (update.thoughtId as string) ?? "";
        const startNew = subject !== state.lastThoughtSubject;
        if (subject) state.lastThoughtSubject = subject;
        emit({ evt: "thinking_delta", id, delta, kind: "raw", startNewBlock: startNew });
      }
      break;
    }

    case "tool_call": {
      // ACP: tool_call fields are inlined on update, not under update.toolCall
      const toolCall = (update.toolCall as Record<string, unknown> | undefined) ?? update;
      if (!toolCall) break;
      const toolCallId = (toolCall.toolCallId as string) || makeToolCallId("gem");
      const toolName = (toolCall.title as string) || (toolCall.kind as string) || "unknown";
      const toolInput = typeof toolCall.rawInput === "string"
        ? toolCall.rawInput
        : JSON.stringify(toolCall.rawInput ?? {});
      state.toolUseRegistry.set(toolCallId, { toolName, toolInput });
      emit({ evt: "tool_start", id, toolCallId, toolName, toolInput });

      if (isSubagentTool(toolName)) {
        const rawInput = typeof toolCall.rawInput === "object" ? toolCall.rawInput : {};
        const desc = subagentDescription(rawInput);
        emit({
          evt: "subagent_started", id,
          agentId: toolCallId,
          agentType: toolName,
          name: subagentDisplayName(toolName),
          description: desc.length > 200 ? desc.slice(0, 197) + "..." : desc,
          prompt: desc,
        });
      }
      break;
    }

    case "tool_call_update": {
      const toolCall = (update.toolCall as Record<string, unknown> | undefined) ?? update;
      if (!toolCall) break;
      const toolCallId = (toolCall.toolCallId as string) || makeToolCallId("gem");
      const registered = state.toolUseRegistry.get(toolCallId);
      state.toolUseRegistry.delete(toolCallId);
      const toolName = registered?.toolName ?? (toolCall.title as string) ?? "";
      const toolInput = registered?.toolInput ?? "";

      // Extract result text from content array
      let resultText = "";
      const content = toolCall.content as Array<Record<string, unknown>> | undefined;
      if (Array.isArray(content)) {
        resultText = content
          .filter((c) => c.type === "text")
          .map((c) => c.text as string)
          .join("\n");
      }

      const success = (toolCall.status as string) !== "error";
      emit({
        evt: "tool_result", id, toolCallId, toolName, toolInput,
        success, result: truncate(resultText), display: defaultToolDisplay(success),
      });

      // Infer file changes
      if (success && toolName) {
        const action = inferFileChangeAction(toolName);
        const filePath = action ? extractFilePath(toolInput) : null;
        if (action && filePath) {
          let additions = 0, deletions = 0;
          try {
            const parsed = JSON.parse(toolInput);
            if (action === "edit") {
              additions = typeof parsed.new_string === "string" ? parsed.new_string.split("\n").length : 0;
              deletions = typeof parsed.old_string === "string" ? parsed.old_string.split("\n").length : 0;
            } else if (action === "create") {
              additions = typeof parsed.content === "string" ? parsed.content.split("\n").length : 0;
            }
          } catch { /* best-effort */ }
          emit({ evt: "file_changed", id, filePath, action, toolName, additions, deletions });
        }
      }

      if (toolName && isSubagentTool(toolName)) {
        emit({ evt: "subagent_stopped", id, agentId: toolCallId });
      }
      break;
    }

    case "plan": {
      // Format plan entries as text output
      const entries = update.entries as Array<Record<string, unknown>> | undefined;
      if (Array.isArray(entries) && entries.length > 0) {
        const planText = entries
          .map((e) => {
            const status = e.status === "completed" ? "[x]" : "[ ]";
            return `${status} ${e.content ?? ""}`;
          })
          .join("\n");
        if (planText) {
          state.fullText += planText + "\n";
          emit({ evt: "text_delta", id, delta: planText + "\n" });
        }
      }
      break;
    }

    case "usage_update": {
      const usage = update.usage as Record<string, unknown> | undefined;
      if (usage) {
        emit({
          evt: "usage", id,
          inputTokens: (usage.inputTokens as number) ?? (usage.promptTokenCount as number) ?? 0,
          outputTokens: (usage.outputTokens as number) ?? (usage.candidatesTokenCount as number) ?? 0,
          cacheReadTokens: 0,
          cacheCreationTokens: 0,
          totalCostUsd: 0,
          contextWindow: getContextWindowForModel(state.model),
          model: state.model,
        });
      }
      break;
    }

    default:
      log(`[acp-notification] unhandled sessionUpdate=${updateType}`);
      break;
  }
}

// ---------------------------------------------------------------------------
// ACP permission handler — session/request_permission (blocking server request)
// ---------------------------------------------------------------------------

function handleAcpPermission(
  rpcId: number,
  params: Record<string, unknown>,
  state: GeminiSessionState,
  emit: EmitFn,
  rpc: GeminiRpcChannel,
  permissionMode: string,
): void {
  const toolCall = params.toolCall as Record<string, unknown> | undefined;
  const options = params.options as Array<Record<string, unknown>> | undefined;
  const toolName = (toolCall?.title as string) || (toolCall?.kind as string) || "unknown";
  const toolInput = typeof toolCall?.rawInput === "string"
    ? toolCall.rawInput
    : JSON.stringify(toolCall?.rawInput ?? {});
  const toolCallId = (toolCall?.toolCallId as string) || makeToolCallId("perm");

  // ACP spec PermissionOptionKind enum:
  //   allow_once | allow_always | reject_once | reject_always
  // Prefer "_once" variants (least aggressive); fall back to any allow/reject
  // kind so future ACP extensions still work. The literal fallback matches
  // ACP-spec optionIds that most agents use verbatim.
  const findOptionIdByKind = (
    predicate: (k: string) => boolean,
  ): string | undefined => {
    const found = options?.find((o) => typeof o.kind === "string" && predicate(o.kind as string));
    return typeof found?.optionId === "string" ? (found.optionId as string) : undefined;
  };

  const allowOptionId =
    findOptionIdByKind((k) => k === "allow_once") ??
    findOptionIdByKind((k) => k.startsWith("allow")) ??
    "allow_once";

  const denyOptionId =
    findOptionIdByKind((k) => k === "reject_once") ??
    findOptionIdByKind((k) => k.startsWith("reject")) ??
    "reject_once";

  // Auto-approve in bypass mode
  if (isAutoApproveMode(permissionMode)) {
    log(`[acp-permission] auto-approve: mode=${permissionMode} tool=${toolName}`);
    rpc.respond(rpcId, { outcome: { outcome: "selected", optionId: allowOptionId } });
    return;
  }

  // Auto-approve non-bash tools in acceptEdits mode
  if (permissionMode === "acceptEdits" && !isBashTool(toolName)) {
    log(`[acp-permission] auto-approve non-bash: mode=${permissionMode} tool=${toolName}`);
    rpc.respond(rpcId, { outcome: { outcome: "selected", optionId: allowOptionId } });
    return;
  }

  // Route to frontend for user confirmation
  const confirmId = `cfm-${randomUUID()}`;
  log(`[acp-permission] requesting user confirmation: confirmId=${confirmId} tool=${toolName}`);

  pendingConfirmations.set(confirmId, {
    resolve: (approved: boolean) => {
      const optionId = approved ? allowOptionId : denyOptionId;
      log(`[acp-permission] user responded: confirmId=${confirmId} approved=${approved} optionId=${optionId}`);
      rpc.respond(rpcId, { outcome: { outcome: "selected", optionId } });
    },
  });

  emit({
    evt: "permission_request",
    id: state.activeRequestId,
    confirmId,
    toolCallId,
    toolName,
    toolInput,
  });
}

// ---------------------------------------------------------------------------
// GeminiAcpChannel — async message queue for warm session routing
// ---------------------------------------------------------------------------

interface ChannelMessage {
  readonly content: string;
  readonly images?: ReadonlyArray<{ media_type: string; data: string }>;
  readonly requestId?: string;
  readonly routedFromQuery?: boolean;
  readonly reasoningLevel?: string;
  readonly commandInvocation?: CommandInvocationPayload;
}

class GeminiAcpChannel implements SessionChannel {
  private _queue: ChannelMessage[] = [];
  private _resolve: ((msg: ChannelMessage | null) => void) | null = null;
  private _closed = false;

  push(
    content: string,
    images?: ReadonlyArray<{ media_type: string; data: string }>,
    requestId?: string,
    routedFromQuery?: boolean,
    reasoningLevel?: string,
    commandInvocation?: CommandInvocationPayload,
  ): void {
    if (this._closed) return;
    const msg: ChannelMessage = { content, images, requestId, routedFromQuery, reasoningLevel, commandInvocation };
    if (this._resolve) {
      const resolve = this._resolve;
      this._resolve = null;
      resolve(msg);
    } else {
      this._queue.push(msg);
    }
  }

  close(): void {
    this._closed = true;
    if (this._resolve) {
      const resolve = this._resolve;
      this._resolve = null;
      resolve(null);
    }
  }

  nextMessage(): Promise<ChannelMessage | null> {
    if (this._queue.length > 0) return Promise.resolve(this._queue.shift()!);
    if (this._closed) return Promise.resolve(null);
    return new Promise<ChannelMessage | null>((resolve) => { this._resolve = resolve; });
  }
}

// ---------------------------------------------------------------------------
// Resolve node binary for spawning Gemini CLI in ACP mode
// ---------------------------------------------------------------------------

let cachedNodePath: string | undefined;

function resolveNodeBinary(): string {
  if (cachedNodePath && existsSync(cachedNodePath)) return cachedNodePath;

  // 1. process.execPath — the node that runs us
  if (process.execPath && existsSync(process.execPath)) {
    cachedNodePath = process.execPath;
    return cachedNodePath;
  }

  return "node"; // original PATH fallback
}

export function buildGeminiSpawnEnv(
  explicit: Record<string, string | undefined>,
  ambient: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  return buildMinimalCliEnvironment(explicit, [
    "GOOGLE_API_KEY",
    "GEMINI_API_KEY",
    "GEMINI_CLI_HOME",
    "GOOGLE_GEMINI_BASE_URL",
    "GEMINI_MODEL",
  ], ambient) as Record<string, string>;
}

// ---------------------------------------------------------------------------
// Main query handler — ACP mode
// ---------------------------------------------------------------------------

export async function handleGeminiQuery(
  cmd: QueryCommand,
  emit: EmitFn,
  activeAbortControllers: Map<string, AbortController>,
): Promise<void> {
  const { id, model, permissionMode, cwd, conversationId, apiKey, baseUrl } = cmd;

  const sessionAbort = new AbortController();
  const firstTurnAbort = new AbortController();
  activeAbortControllers.set(id, firstTurnAbort);

  const isPersistent = !!conversationId;
  let tempDir: string | undefined;
  let rpc: GeminiRpcChannel | undefined;
  // Hoisted so finally can always detach listeners, even on error paths.
  let unsubNotification: (() => void) | undefined;
  let unsubServerReq: (() => void) | undefined;
  // Hoisted so finally can detach the sessionAbort listener.
  let sessionAbortHandler: (() => void) | undefined;

  try {
    // ---- Validate API key ----
    const resolvedApiKey = apiKey || process.env.GOOGLE_API_KEY || process.env.GEMINI_API_KEY;
    if (!resolvedApiKey) {
      emit({ evt: "error", id, error: "Gemini API key is not configured. Go to Settings > Models to set it." });
      emit({ evt: "done", id });
      return;
    }

    // ---- Resolve CLI path ----
    let cliPath: string;
    try {
      cliPath = resolveGeminiCLI(cwd);
      log(`Resolved Gemini CLI at: ${cliPath}`);
    } catch (findErr: unknown) {
      log(`[resolve] Gemini CLI lookup failed: ${String(findErr)}`);
      emit({ evt: "error", id, error: publicSidecarErrorMessage(findErr) });
      emit({ evt: "done", id });
      return;
    }

    // ---- Resolve model ----
    // Note: `effectivePrompt` is built AFTER `initialize` so we know whether
    // the agent supports image prompt blocks (see the prompt capability check
    // below). If the agent supports images natively, we skip the placeholder
    // text that `buildEffectivePrompt` would otherwise inject.
    const resolvedModel = model || "gemini-2.5-flash";

    // ---- Temp directory for auth settings ----
    tempDir = createTempDir();
    const tempGeminiHome = createTempGeminiHome(tempDir);

    // ---- Environment ----
    const env = buildGeminiSpawnEnv({
      GEMINI_API_KEY: resolvedApiKey,
      GEMINI_CLI_HOME: tempGeminiHome,
    });
    if (baseUrl) {
      env.GOOGLE_GEMINI_BASE_URL = validateProviderBaseUrl(baseUrl);
    }
    // Pass model via env — ACP initialize doesn't accept model directly
    if (resolvedModel) env.GEMINI_MODEL = resolvedModel;

    // ---- Spawn ACP process ----
    const nodeBin = resolveNodeBinary();
    rpc = new GeminiRpcChannel(nodeBin, cliPath, env, cwd);

    // ---- Session state ----
    const state: GeminiSessionState = {
      activeRequestId: id,
      conversationId,
      model: resolvedModel,
      fullText: "",
      sessionEmitted: false,
      turnDoneEmitted: false,
      lastThoughtSubject: "",
      toolUseRegistry: new Map(),
      acpSessionId: undefined,
    };

    // ---- Register listeners (detached in finally) ----
    unsubNotification = rpc.onNotification((method, params) => {
      processAcpNotification(method, params, state, emit);
    });

    unsubServerReq = rpc.onServerRequest((rpcId, method, params) => {
      if (method === "session/request_permission") {
        handleAcpPermission(rpcId, params, state, emit, rpc!, permissionMode ?? "default");
      } else {
        log(`[acp] unhandled server request: method=${method}`);
      }
    });

    // ---- 1. Initialize ----
    log(`[acp] Sending initialize...`);
    const initResult = await rpc.request("initialize", {
      protocolVersion: 1,
      clientCapabilities: {
        fs: { readTextFile: false, writeTextFile: false },
        terminal: false,
      },
      clientInfo: { name: "bytro", version: "1.8.0" },
    }) as Record<string, unknown> | undefined;
    log(`[acp] initialize response: ${JSON.stringify(initResult ?? {}).slice(0, 300)}`);

    // Inspect agent prompt capabilities — per ACP spec an agent must declare
    // support for image content blocks via `agentCapabilities.promptCapabilities.image`.
    // Only if the agent explicitly advertises image support do we forward raw
    // image blocks; otherwise we fall back to the legacy placeholder text so
    // the user's intent ("I sent an image") is still communicated to the model.
    const supportsImages = (() => {
      const agentCaps = initResult?.agentCapabilities as Record<string, unknown> | undefined;
      const promptCaps = agentCaps?.promptCapabilities as Record<string, unknown> | undefined;
      return promptCaps?.image === true;
    })();
    log(`[acp] agent supportsImages=${supportsImages}`);

    // ---- 2. Create session ----
    log(`[acp] Sending session/new...`);
    const sessionResult = await rpc.request("session/new", {
      cwd,
      mcpServers: [],
    }) as Record<string, unknown>;
    const acpSessionId = sessionResult.sessionId as string;
    state.acpSessionId = acpSessionId;
    log(`[acp] session/new response: sessionId=${acpSessionId}`);

    // Emit session event
    emit({ evt: "session", id, sessionId: `gem-${acpSessionId}` });
    state.sessionEmitted = true;
    emit({ evt: "user_message_uuid", id, uuid: randomUUID() });

    // Wire sessionAbort → session/cancel so external kills (warm-session
    // replacement or killWarmSession) propagate cleanly to the ACP server
    // instead of relying on child-process termination in the finally block.
    sessionAbortHandler = () => {
      if (rpc?.alive && state.acpSessionId) {
        log(`[acp] sessionAbort triggered, sending session/cancel`);
        try { rpc.notify("session/cancel", { sessionId: state.acpSessionId }); }
        catch { /* best-effort */ }
      }
    };
    sessionAbort.signal.addEventListener("abort", sessionAbortHandler, { once: true });

    // ---- Build prompt blocks (text + optional image blocks) ----
    // Placeholder text is only injected if the agent cannot accept image blocks.
    const effectivePrompt = buildEffectivePrompt(cmd, {
      includeImages: !supportsImages,
      model: resolvedModel,
    });
    const buildPromptBlocks = (
      text: string,
      images: ReadonlyArray<{ media_type: string; data: string }> | undefined,
    ): Array<Record<string, unknown>> => {
      const blocks: Array<Record<string, unknown>> = [{ type: "text", text }];
      if (supportsImages && images && images.length > 0) {
        for (const img of images) {
          if (typeof img?.media_type === "string" && typeof img?.data === "string") {
            blocks.push({ type: "image", mimeType: img.media_type, data: img.data });
          }
        }
      }
      return blocks;
    };

    // ---- 3. Send first prompt ----
    log(`[acp] Sending session/prompt (first turn)...`);

    // Handle abort — send session/cancel notification
    const abortHandler = () => {
      if (rpc?.alive && state.acpSessionId) {
        log(`[acp] Abort triggered, sending session/cancel`);
        rpc.notify("session/cancel", { sessionId: state.acpSessionId });
      }
    };
    firstTurnAbort.signal.addEventListener("abort", abortHandler, { once: true });

    let firstTurnSucceeded = false;
    try {
      const promptResult = await rpc.request("session/prompt", {
        sessionId: acpSessionId,
        prompt: buildPromptBlocks(effectivePrompt, cmd.images),
      }, 30 * 60_000) as Record<string, unknown>;
      log(`[acp] session/prompt done: stopReason=${promptResult?.stopReason}`);
      firstTurnSucceeded = true;

      // Extract usage from prompt response if not already emitted
      const usage = promptResult?.usage as Record<string, unknown> | undefined;
      if (usage) {
        emit({
          evt: "usage", id,
          inputTokens: (usage.inputTokens as number) ?? 0,
          outputTokens: (usage.outputTokens as number) ?? 0,
          cacheReadTokens: 0, cacheCreationTokens: 0, totalCostUsd: 0,
          contextWindow: getContextWindowForModel(resolvedModel),
          model: resolvedModel,
        });
      }
    } catch (err) {
      if (!firstTurnAbort.signal.aborted) {
        const msg = err instanceof Error ? err.message : String(err);
        log(`[acp] first turn error: ${msg}`);
        emit({ evt: "error", id, error: publicSidecarErrorMessage(err) });
      }
    } finally {
      firstTurnAbort.signal.removeEventListener("abort", abortHandler);
    }

    // ---- Emit turn done ----
    if (!state.turnDoneEmitted) {
      state.turnDoneEmitted = true;
      emit({ evt: "complete", id, fullText: state.fullText });
      // Mirror Claude SDK's Stop hook so the live-reviewer can flush its
      // per-turn file buffer into a batched PR-style review.  Without this
      // emit, file edits accumulate silently with no flush trigger.
      if (firstTurnSucceeded) {
        const trimmed = state.fullText.trim();
        emit({
          evt: "turn_finished",
          id,
          lastAssistantMessage: trimmed.length > 0 ? trimmed : null,
        });
      }
    }

    // ---- 4. Warm session loop ----
    const firstTurnAborted = firstTurnAbort.signal.aborted;
    if (isPersistent && (firstTurnSucceeded || firstTurnAborted) && conversationId && rpc.alive && !sessionAbort.signal.aborted) {
      emit({ evt: "done", id, sessionAlive: true, conversationId });

      const channel = new GeminiAcpChannel();
      activePromptChannels.set(id, channel);

      registerWarmSession({
        conversationId,
        requestId: id,
        channel,
        abortController: sessionAbort,
        model: resolvedModel,
        platform: cmd.platform ?? "",
        cwd,
        credentialHash: hashCredentials(apiKey ?? "", baseUrl ?? ""),
        permissionMode: permissionMode ?? "",
        mcpServerKeys: cmd.mcpServers ? Object.keys(cmd.mcpServers).sort().join(",") : "",
        lastActivityMs: Date.now(),
        agent: "gemini",
      });
      log(`[acp] Registered warm session: conv=${conversationId}, acpSessionId=${acpSessionId}`);

      // ---- Warm session loop ----
      while (!sessionAbort.signal.aborted && rpc.alive) {
        const nextMsg = await Promise.race([
          channel.nextMessage(),
          rpc.waitForExit().then(() => null),
        ]);
        if (!nextMsg || sessionAbort.signal.aborted || !rpc.alive) break;

        const newRequestId = nextMsg.requestId ?? randomUUID();
        log(`[acp-warm] Follow-up: conv=${conversationId}, requestId=${newRequestId}`);

        state.activeRequestId = newRequestId;
        if (!activeAbortControllers.has(newRequestId)) {
          activeAbortControllers.set(newRequestId, new AbortController());
        }
        const turnAbort = activeAbortControllers.get(newRequestId)!;
        resetTurnState(state);

        if (!nextMsg.routedFromQuery) {
          emit({ evt: "new_turn", id: newRequestId, commandName: nextMsg.commandInvocation?.canonicalName });
          emit({ evt: "user_message_uuid", id: newRequestId, uuid: randomUUID() });
        }

        // Abort handler for this turn
        const turnAbortHandler = () => {
          if (rpc?.alive && state.acpSessionId) {
            rpc.notify("session/cancel", { sessionId: state.acpSessionId });
          }
        };
        turnAbort.signal.addEventListener("abort", turnAbortHandler, { once: true });

        let turnSucceeded = false;
        try {
          const result = await rpc.request("session/prompt", {
            sessionId: acpSessionId,
            prompt: buildPromptBlocks(nextMsg.content, nextMsg.images),
          }, 30 * 60_000) as Record<string, unknown>;
          turnSucceeded = true;

          const turnUsage = result?.usage as Record<string, unknown> | undefined;
          if (turnUsage) {
            emit({
              evt: "usage", id: newRequestId,
              inputTokens: (turnUsage.inputTokens as number) ?? 0,
              outputTokens: (turnUsage.outputTokens as number) ?? 0,
              cacheReadTokens: 0, cacheCreationTokens: 0, totalCostUsd: 0,
              contextWindow: getContextWindowForModel(resolvedModel),
              model: resolvedModel,
            });
          }
        } catch (err) {
          if (!turnAbort.signal.aborted) {
            const msg = err instanceof Error ? err.message : String(err);
            log(`[acp-warm] turn error: ${msg}`);
            emit({
              evt: "error",
              id: newRequestId,
              error: publicSidecarErrorMessage(err),
            });
          }
        } finally {
          turnAbort.signal.removeEventListener("abort", turnAbortHandler);
        }

        if (!state.turnDoneEmitted) {
          state.turnDoneEmitted = true;
          emit({ evt: "complete", id: newRequestId, fullText: state.fullText });
          // Mirror Claude SDK's Stop hook for warm-session follow-up turns.
          if (turnSucceeded) {
            const trimmed = state.fullText.trim();
            emit({
              evt: "turn_finished",
              id: newRequestId,
              lastAssistantMessage: trimmed.length > 0 ? trimmed : null,
            });
          }
        }

        const turnWasAborted = turnAbort.signal.aborted;
        const sessionAlive = turnSucceeded || turnWasAborted;
        emit({ evt: "done", id: newRequestId, sessionAlive, conversationId });

        // Re-register channel under new requestId
        activePromptChannels.delete(id);
        activePromptChannels.set(newRequestId, channel);

        if (!turnSucceeded && !turnWasAborted) {
          log(`[acp-warm] Turn failed, exiting warm session loop`);
          break;
        }
      }

      log(`[acp] Warm session loop ended: conv=${conversationId}`);
      removeWarmSession(conversationId);
      // Listener detach, rpc.close() and tempDir cleanup are centralized in
      // the `finally` block so every exit path goes through the same teardown.
      return;
    }

    // Non-persistent: emit done. Teardown handled in `finally`.
    emit({ evt: "done", id });

  } catch (err: unknown) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    log(`[acp] Query error: ${errorMsg}`);
    if (!firstTurnAbort.signal.aborted) {
      emit({ evt: "error", id, error: publicSidecarErrorMessage(err) });
    }
    emit({ evt: "done", id });
  } finally {
    activeAbortControllers.delete(id);
    if (!isPersistent) {
      activePromptChannels.delete(id);
    }
    // Detach RPC listeners symmetrically for every exit path — prevents
    // stray emits from tail notifications arriving after "done".
    try { unsubNotification?.(); } catch { /* idempotent */ }
    try { unsubServerReq?.(); } catch { /* idempotent */ }
    // Remove sessionAbort handler — it is `{ once: true }` so this is only
    // needed when the signal never fired (normal exit).
    if (sessionAbortHandler) {
      try { sessionAbort.signal.removeEventListener("abort", sessionAbortHandler); }
      catch { /* ignore */ }
    }
    if (rpc) {
      await rpc.close().catch(() => {});
      rpc = undefined;
    }
    // Always clean up tempDir: the child process has exited by this point
    // (rpc.close awaited), so the GEMINI_CLI_HOME directory is no longer in
    // use. Previously this was gated on !isPersistent, which leaked one temp
    // dir per persistent session.
    cleanupTempDir(tempDir);
  }
}
