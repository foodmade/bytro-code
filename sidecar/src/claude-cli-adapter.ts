// ---------------------------------------------------------------------------
// Local Claude Code CLI adapter
//
// The community edition talks to a user-installed `claude` executable over
// its documented stream-json protocol. This module intentionally exposes the
// small API surface that the existing handlers need so they can keep their
// NDJSON contract without depending on the proprietary Agent SDK package.
// ---------------------------------------------------------------------------

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import { createInterface } from "node:readline";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import type { Dirent } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  captureProcessTree,
  prepareCliProcessInvocation,
  reapExitedProcessTree,
  signalProcessTree,
  type ProcessTreeTarget,
} from "./cli-process.js";
import { buildMinimalCliEnvironment } from "./cli-environment.js";

const COMMUNITY_CLI_UNSUPPORTED = "unsupported_in_community_cli";

export type PermissionMode =
  | "acceptEdits"
  | "auto"
  | "bypassPermissions"
  | "default"
  | "dontAsk"
  | "plan";

export type EffortLevel = "low" | "medium" | "high" | "xhigh" | "max";

export type ThinkingConfig =
  | { readonly type: "disabled" }
  | {
      readonly type: "adaptive" | "enabled";
      readonly display?: "summarized" | "omitted";
    };

export interface HookInput extends Record<string, unknown> {
  readonly hook_event_name: string;
}

export interface StreamObserverOptions {
  readonly signal: AbortSignal;
}

/**
 * Observer for events already emitted by the Claude CLI.
 *
 * This cannot approve, deny, or rewrite a tool invocation: the CLI executes
 * tools in its own process before these stream events reach Bytro.
 */
export type StreamObserver = (
  input: HookInput,
  toolUseId: string | undefined,
  options: StreamObserverOptions,
) => Promise<void> | void;

export type CanUseTool = (
  toolName: string,
  input: Record<string, unknown>,
  options: { readonly toolUseID: string; readonly signal?: AbortSignal },
) => Promise<
  | { readonly behavior: "allow"; readonly updatedInput: Record<string, unknown> }
  | { readonly behavior: "deny"; readonly message: string }
>;

export interface SDKUserMessage extends Record<string, unknown> {
  readonly type: "user";
  readonly message: {
    readonly role: "user";
    readonly content: string | ReadonlyArray<Record<string, unknown>>;
  };
  readonly parent_tool_use_id: string | null;
  readonly session_id: string;
  readonly uuid?: string;
}

export interface SDKControlGetContextUsageResponse {
  readonly categories: ReadonlyArray<{
    readonly name: string;
    readonly tokens: number;
    readonly color: string;
    readonly isDeferred?: boolean;
  }>;
  readonly totalTokens: number;
  readonly maxTokens: number;
  readonly rawMaxTokens: number;
  readonly percentage: number;
  readonly model: string;
  readonly memoryFiles: ReadonlyArray<{
    readonly path: string;
    readonly type: string;
    readonly tokens: number;
  }>;
  readonly mcpTools: ReadonlyArray<{
    readonly name: string;
    readonly serverName: string;
    readonly tokens: number;
    readonly isLoaded?: boolean;
  }>;
  readonly deferredBuiltinTools?: ReadonlyArray<{
    readonly name: string;
    readonly tokens: number;
    readonly isLoaded: boolean;
  }>;
  readonly systemTools?: ReadonlyArray<{
    readonly name: string;
    readonly tokens: number;
  }>;
  readonly systemPromptSections?: ReadonlyArray<{
    readonly name: string;
    readonly tokens: number;
  }>;
  readonly agents: ReadonlyArray<{
    readonly agentType: string;
    readonly source: string;
    readonly tokens: number;
  }>;
  readonly slashCommands?: {
    readonly totalCommands: number;
    readonly includedCommands: number;
    readonly tokens: number;
  };
  readonly skills?: {
    readonly totalSkills: number;
    readonly includedSkills: number;
    readonly tokens: number;
    readonly skillFrontmatter: ReadonlyArray<{
      readonly name: string;
      readonly source: string;
      readonly tokens: number;
    }>;
  };
  readonly autoCompactThreshold?: number;
}

export interface AgentDefinition {
  readonly description: string;
  readonly prompt: string;
  readonly tools?: ReadonlyArray<string>;
  readonly model?: string;
}

export interface Options {
  model?: string;
  cwd?: string;
  abortController?: AbortController;
  includePartialMessages?: boolean;
  pathToClaudeCodeExecutable?: string;
  settingSources?: ReadonlyArray<"user" | "project" | "local">;
  enableFileCheckpointing?: boolean;
  thinking?: ThinkingConfig;
  effort?: EffortLevel;
  extraArgs?: Readonly<Record<string, string | null | undefined>>;
  env?: Record<string, string | undefined>;
  stderr?: (message: string) => void;
  mcpServers?: Readonly<Record<string, unknown>>;
  systemPrompt?:
    | string
    | {
        readonly type: "preset";
        readonly preset: "claude_code";
        readonly append?: string;
      };
  allowedTools?: ReadonlyArray<string>;
  maxTurns?: number;
  permissionMode?: PermissionMode;
  allowDangerouslySkipPermissions?: boolean;
  /** Full health-check prompts to inline into the first stdin user message. */
  dimensionPrompts?: Readonly<Record<string, string>>;
  /** Observation-only callbacks for CLI stream events. */
  streamObservers?: Readonly<
    Record<
      string,
      ReadonlyArray<{
        readonly matcher?: string;
        readonly observers: ReadonlyArray<StreamObserver>;
      }>
    >
  >;
  agentProgressSummaries?: boolean;
  resume?: string;
  forkSession?: boolean;
  resumeSessionAt?: string;
  agents?: Readonly<Record<string, AgentDefinition>>;
  [key: string]: unknown;
}

export type ClaudeStreamMessage = Record<string, unknown> & {
  readonly type?: string;
};

export interface RewindFilesResult {
  readonly canRewind: boolean;
  readonly error?: string;
  readonly filesChanged?: ReadonlyArray<string>;
  readonly insertions?: number;
  readonly deletions?: number;
}

export interface SlashCommand {
  readonly name: string;
  readonly description?: string;
  readonly argumentHint?: string;
  readonly aliases?: ReadonlyArray<string>;
}

export interface Query extends AsyncIterable<ClaudeStreamMessage> {
  next(): Promise<IteratorResult<ClaudeStreamMessage>>;
  return(): Promise<IteratorResult<ClaudeStreamMessage>>;
  supportedCommands(): Promise<ReadonlyArray<SlashCommand>>;
  getContextUsage(): Promise<SDKControlGetContextUsageResponse>;
  rewindFiles(userMessageUuid: string): Promise<RewindFilesResult>;
}

export interface WarmQuery {
  query(prompt: string | AsyncIterable<SDKUserMessage>): Query;
}

interface QueueWaiter<T> {
  readonly resolve: (result: IteratorResult<T>) => void;
  readonly reject: (error: unknown) => void;
}

class AsyncMessageQueue<T> {
  private readonly items: T[] = [];
  private readonly waiters: QueueWaiter<T>[] = [];
  private ended = false;
  private failure: unknown;

  push(item: T): void {
    if (this.ended || this.failure !== undefined) return;
    const waiter = this.waiters.shift();
    if (waiter) {
      waiter.resolve({ done: false, value: item });
    } else {
      this.items.push(item);
    }
  }

  end(): void {
    if (this.ended || this.failure !== undefined) return;
    this.ended = true;
    for (const waiter of this.waiters.splice(0)) {
      waiter.resolve({ done: true, value: undefined as T });
    }
  }

  fail(error: unknown): void {
    if (this.ended || this.failure !== undefined) return;
    this.failure = error;
    for (const waiter of this.waiters.splice(0)) {
      waiter.reject(error);
    }
  }

  next(): Promise<IteratorResult<T>> {
    const item = this.items.shift();
    if (item !== undefined) {
      return Promise.resolve({ done: false, value: item });
    }
    if (this.failure !== undefined) {
      return Promise.reject(this.failure);
    }
    if (this.ended) {
      return Promise.resolve({ done: true, value: undefined as T });
    }
    return new Promise<IteratorResult<T>>((resolve, reject) => {
      this.waiters.push({ resolve, reject });
    });
  }
}

function unsupported(capability: string): Error {
  return Object.assign(new Error(COMMUNITY_CLI_UNSUPPORTED), {
    code: COMMUNITY_CLI_UNSUPPORTED,
    capability,
  });
}

export function buildClaudeSpawnEnv(
  source: Record<string, string | undefined> | undefined,
): NodeJS.ProcessEnv {
  const explicit = source ?? process.env;
  const env = buildMinimalCliEnvironment(explicit, [
    "ANTHROPIC_API_KEY",
    "ANTHROPIC_AUTH_TOKEN",
    "ANTHROPIC_BASE_URL",
    "ANTHROPIC_MODEL",
    "ANTHROPIC_DEFAULT_OPUS_MODEL",
    "ANTHROPIC_DEFAULT_SONNET_MODEL",
    "ANTHROPIC_DEFAULT_HAIKU_MODEL",
    "CLAUDE_CODE_OAUTH_TOKEN",
    "CLAUDE_CODE_SKIP_FAST_MODE_ORG_CHECK",
    "CLAUDE_CODE_ATTRIBUTION_HEADER",
    "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC",
    "DISABLE_PROMPT_CACHING",
    "ENABLE_PROMPT_CACHING_1H",
    "ENABLE_TOOL_SEARCH",
    "HTTP_PROXY",
    "HTTPS_PROXY",
    "ALL_PROXY",
    "http_proxy",
    "https_proxy",
    "all_proxy",
  ]);
  // Community boundary: provider API traffic remains enabled, but Claude Code
  // must not auto-update itself or send nonessential telemetry/error/bug data.
  // These forced values intentionally override caller-supplied environment.
  env.DISABLE_AUTOUPDATER = "1";
  env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = "1";
  env.DISABLE_TELEMETRY = "1";
  env.DISABLE_ERROR_REPORTING = "1";
  env.DISABLE_BUG_COMMAND = "1";
  return env;
}

function appendOption(
  args: string[],
  flag: string,
  value: string | undefined,
): void {
  if (value !== undefined && value !== "") {
    args.push(flag, value);
  }
}

interface RuntimeConfigPaths {
  readonly mcpConfig?: string;
  readonly settings?: string;
  readonly systemPrompt?: string;
  readonly appendSystemPrompt?: string;
}

export interface PreparedClaudeLaunch {
  readonly args: ReadonlyArray<string>;
  readonly permissionModeDegraded: boolean;
  cleanup(): void;
}

function requestedPermissionMode(options: Options): PermissionMode {
  return options.permissionMode ?? "default";
}

function effectivePermissionMode(options: Options): PermissionMode {
  // The local CLI cannot call Bytro's in-process approval callback. In
  // headless mode, "default" could otherwise wait for an unavailable prompt.
  // `dontAsk` is the explicit safe fallback: tools that require approval are
  // denied rather than silently executed or left hanging.
  return requestedPermissionMode(options) === "default" ? "dontAsk" : requestedPermissionMode(options);
}

function buildClaudeArgs(
  options: Options,
  runtimeConfig: RuntimeConfigPaths,
): string[] {
  if (options.agents && Object.keys(options.agents).length > 0) {
    throw new Error(
      "Custom Claude agent definitions cannot be passed securely; include agent instructions in the stdin prompt instead.",
    );
  }
  const args = [
    "-p",
    "--input-format",
    "stream-json",
    "--output-format",
    "stream-json",
    "--verbose",
    "--include-partial-messages",
    "--include-hook-events",
  ];

  appendOption(args, "--model", options.model);

  appendOption(args, "--system-prompt-file", runtimeConfig.systemPrompt);
  appendOption(
    args,
    "--append-system-prompt-file",
    runtimeConfig.appendSystemPrompt,
  );

  if (options.settingSources && options.settingSources.length > 0) {
    args.push("--setting-sources", options.settingSources.join(","));
  } else if (options.settingSources?.length === 0) {
    args.push("--safe-mode");
  }

  if (options.allowedTools) {
    args.push("--tools", options.allowedTools.join(","));
  }

  if (options.maxTurns !== undefined) {
    args.push("--max-turns", String(options.maxTurns));
  }

  if (options.thinking) {
    args.push(
      "--thinking",
      options.thinking.type === "enabled" ? "adaptive" : options.thinking.type,
    );
    if (options.thinking.type !== "disabled" && options.thinking.display) {
      args.push("--thinking-display", options.thinking.display);
    }
  }
  appendOption(args, "--effort", options.effort);

  if (runtimeConfig.settings) args.push("--settings", runtimeConfig.settings);

  if (runtimeConfig.mcpConfig) {
    args.push("--mcp-config", runtimeConfig.mcpConfig);
  }

  if (options.resume) {
    args.push("--resume", options.resume);
    if (options.forkSession) args.push("--fork-session");
    appendOption(args, "--resume-session-at", options.resumeSessionAt);
  }

  const permissionMode = effectivePermissionMode(options);
  args.push("--permission-mode", permissionMode);
  if (
    permissionMode === "bypassPermissions" &&
    options.allowDangerouslySkipPermissions === true
  ) {
    args.push(
      "--allow-dangerously-skip-permissions",
      "--dangerously-skip-permissions",
    );
  }

  return args;
}

function parsesAsJson(value: string | null | undefined): boolean {
  if (!value) return false;
  try {
    JSON.parse(value);
    return true;
  } catch {
    return false;
  }
}

const CLAUDE_RUNTIME_PREFIX = "bytro-community-claude-";
const ORPHAN_RUNTIME_GRACE_MS = 5_000;
let staleRuntimeCleanupDone = false;
const CREDENTIAL_SETTINGS_ENV_KEYS = [
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_BASE_URL",
  "ANTHROPIC_MODEL",
  "ANTHROPIC_DEFAULT_OPUS_MODEL",
  "ANTHROPIC_DEFAULT_SONNET_MODEL",
  "ANTHROPIC_DEFAULT_HAIKU_MODEL",
  "CLAUDE_CODE_OAUTH_TOKEN",
] as const;

function isProcessAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * Remove only orphaned runtime directories created by this adapter, owned by
 * the current user, and associated with a process that is no longer running.
 * A short grace window avoids racing a just-exited owner while ensuring a
 * sidecar crash does not leave credential-bearing files behind for hours.
 */
export function cleanupStaleClaudeRuntimeDirs(now = Date.now()): void {
  const currentUid =
    typeof process.getuid === "function" ? process.getuid() : undefined;
  let entries: Dirent[];
  try {
    entries = readdirSync(tmpdir(), { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
    const match = new RegExp(
      `^${CLAUDE_RUNTIME_PREFIX.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(\\d+)-`,
    ).exec(entry.name);
    if (!match) continue;

    const ownerPid = Number(match[1]);
    if (ownerPid === process.pid || isProcessAlive(ownerPid)) continue;

    const candidate = join(tmpdir(), entry.name);
    try {
      const metadata = lstatSync(candidate);
      if (!metadata.isDirectory() || metadata.isSymbolicLink()) continue;
      if (currentUid !== undefined && metadata.uid !== currentUid) continue;
      if (now - metadata.mtimeMs < ORPHAN_RUNTIME_GRACE_MS) continue;
      rmSync(candidate, { recursive: true, force: true });
    } catch {
      // Cleanup is best-effort and never blocks a query.
    }
  }
}

/**
 * Prepare CLI arguments and any private, short-lived config files.
 *
 * MCP definitions can contain bearer tokens in headers/env. Passing their JSON
 * directly in argv exposes those credentials to process listings. The adapter
 * therefore writes them to a random OS-temp directory (0700) and file (0600)
 * and places only the file path in argv. On Windows, the per-user TEMP
 * directory's profile ACL is the primary boundary; POSIX mode calls are best
 * effort there.
 */
export function prepareClaudeLaunch(options: Options): PreparedClaudeLaunch {
  let runtimeDir: string | undefined;

  const ensureRuntimeDir = (): string => {
    if (runtimeDir) return runtimeDir;
    if (!staleRuntimeCleanupDone) {
      staleRuntimeCleanupDone = true;
      cleanupStaleClaudeRuntimeDirs();
    }
    runtimeDir = mkdtempSync(
      join(tmpdir(), `${CLAUDE_RUNTIME_PREFIX}${process.pid}-`),
    );
    try {
      chmodSync(runtimeDir, 0o700);
    } catch {
      // Windows permissions are inherited from the user's profile TEMP ACL.
    }
    return runtimeDir;
  };

  const writePrivateConfig = (name: string, content: string): string => {
    const filePath = join(ensureRuntimeDir(), `${name}-${randomUUID()}.json`);
    writeFileSync(filePath, content, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
    try {
      chmodSync(filePath, 0o600);
    } catch {
      // Windows permissions are inherited from the private parent directory.
    }
    return filePath;
  };

  try {
    const mcpConfig = options.mcpServers
      ? writePrivateConfig(
          "mcp",
          JSON.stringify({ mcpServers: options.mcpServers }),
        )
      : undefined;

    const inlineSettings = options.extraArgs?.settings;
    let settingsSource: unknown = {};
    if (inlineSettings) {
      if (parsesAsJson(inlineSettings)) {
        settingsSource = JSON.parse(inlineSettings) as unknown;
      } else {
        const settingsPath = resolve(inlineSettings);
        if (!existsSync(settingsPath) || !statSync(settingsPath).isFile()) {
          throw new Error(
            "Claude settings must be valid JSON or an existing file path.",
          );
        }
        try {
          settingsSource = JSON.parse(
            readFileSync(settingsPath, "utf8"),
          ) as unknown;
        } catch {
          throw new Error("Claude settings file must contain valid JSON.");
        }
      }
    }
    if (
      !settingsSource ||
      typeof settingsSource !== "object" ||
      Array.isArray(settingsSource)
    ) {
      throw new Error("Claude settings must be a JSON object.");
    }

    const settingsObject: Record<string, unknown> = {
      ...(settingsSource as Record<string, unknown>),
    };
    const existingEnv =
      settingsObject.env &&
      typeof settingsObject.env === "object" &&
      !Array.isArray(settingsObject.env)
        ? (settingsObject.env as Record<string, unknown>)
        : {};
    const sanitizedSettingsEnv: Record<string, unknown> = {
      ...existingEnv,
    };
    for (const key of CREDENTIAL_SETTINGS_ENV_KEYS) {
      delete sanitizedSettingsEnv[key];
    }
    if (Object.keys(sanitizedSettingsEnv).length > 0) {
      settingsObject.env = sanitizedSettingsEnv;
    } else {
      delete settingsObject.env;
    }
    const settings = inlineSettings
      ? writePrivateConfig(
          "settings",
          JSON.stringify(settingsObject),
        )
      : undefined;
    const systemPrompt =
      typeof options.systemPrompt === "string" && options.systemPrompt
        ? writePrivateConfig("system-prompt", options.systemPrompt)
        : undefined;
    const appendSystemPrompt =
      typeof options.systemPrompt === "object" && options.systemPrompt.append
        ? writePrivateConfig(
            "append-system-prompt",
            options.systemPrompt.append,
          )
        : undefined;

    return {
      args: buildClaudeArgs(options, {
        mcpConfig,
        settings,
        systemPrompt,
        appendSystemPrompt,
      }),
      permissionModeDegraded:
        effectivePermissionMode(options) !== requestedPermissionMode(options),
      cleanup: () => {
        if (!runtimeDir) return;
        rmSync(runtimeDir, { recursive: true, force: true });
        runtimeDir = undefined;
      },
    };
  } catch (error) {
    if (runtimeDir) {
      rmSync(runtimeDir, { recursive: true, force: true });
      runtimeDir = undefined;
    }
    throw error;
  }
}

function makeUserMessage(prompt: string, sessionId = ""): SDKUserMessage {
  return {
    type: "user",
    message: {
      role: "user",
      content: [{ type: "text", text: prompt }],
    },
    parent_tool_use_id: null,
    session_id: sessionId,
    uuid: randomUUID(),
  };
}

const MAX_DIMENSION_PROMPTS = 16;
const MAX_DIMENSION_NAME_LENGTH = 128;
const MAX_DIMENSION_PROMPT_LENGTH = 64 * 1024;
const MAX_DIMENSION_PROMPTS_TOTAL_LENGTH = 256 * 1024;

export function buildDimensionPromptInstructions(
  dimensionPrompts: Readonly<Record<string, string>> | undefined,
): string | null {
  if (!dimensionPrompts) return null;
  const entries: Array<{ description: string; prompt: string }> = [];
  let totalLength = 0;
  for (const [description, prompt] of Object.entries(dimensionPrompts)) {
    if (
      entries.length >= MAX_DIMENSION_PROMPTS ||
      typeof prompt !== "string"
    ) {
      break;
    }
    const safeDescription = description.trim();
    if (
      !safeDescription ||
      safeDescription.length > MAX_DIMENSION_NAME_LENGTH ||
      !prompt.trim() ||
      prompt.length > MAX_DIMENSION_PROMPT_LENGTH
    ) {
      continue;
    }
    totalLength += safeDescription.length + prompt.length;
    if (totalLength > MAX_DIMENSION_PROMPTS_TOTAL_LENGTH) {
      throw new Error("Health-check dimension prompts exceed the safe limit");
    }
    entries.push({ description: safeDescription, prompt });
  }
  if (entries.length === 0) return null;
  return [
    "<bytro_health_check_task_prompts>",
    "The JSON mapping below is authoritative. For every Task or Agent tool call whose description exactly matches an entry, copy that entry's complete prompt string into the tool's prompt argument. Do not pass only the short dimension name. Stream observers cannot rewrite tool calls after the CLI emits them.",
    JSON.stringify(entries),
    "</bytro_health_check_task_prompts>",
  ].join("\n");
}

function inlineDimensionPrompts(
  message: SDKUserMessage,
  dimensionPrompts: Readonly<Record<string, string>> | undefined,
): SDKUserMessage {
  const instructions = buildDimensionPromptInstructions(dimensionPrompts);
  if (!instructions) return message;
  const content = message.message.content;
  if (typeof content === "string") {
    return {
      ...message,
      message: {
        ...message.message,
        content: `${instructions}\n\n${content}`,
      },
    };
  }
  const blocks = [...content];
  const textIndex = blocks.findIndex(
    (block) => block.type === "text" && typeof block.text === "string",
  );
  if (textIndex >= 0) {
    const textBlock = blocks[textIndex];
    blocks[textIndex] = {
      ...textBlock,
      text: `${instructions}\n\n${String(textBlock.text)}`,
    };
  } else {
    blocks.unshift({ type: "text", text: instructions });
  }
  return {
    ...message,
    message: {
      ...message.message,
      content: blocks,
    },
  };
}

async function writeInput(
  child: ChildProcessWithoutNullStreams,
  prompt: string | AsyncIterable<SDKUserMessage>,
  dimensionPrompts?: Readonly<Record<string, string>>,
): Promise<void> {
  let isFirstMessage = true;
  const writeMessage = async (message: SDKUserMessage): Promise<void> => {
    if (child.stdin.destroyed) return;
    const prepared = isFirstMessage
      ? inlineDimensionPrompts(message, dimensionPrompts)
      : message;
    isFirstMessage = false;
    const line = `${JSON.stringify(prepared)}\n`;
    if (!child.stdin.write(line)) {
      await once(child.stdin, "drain");
    }
  };

  try {
    if (typeof prompt === "string") {
      await writeMessage(makeUserMessage(prompt));
    } else {
      for await (const message of prompt) {
        if (child.stdin.destroyed) break;
        await writeMessage(message);
      }
    }
  } catch (error) {
    const code = (error as NodeJS.ErrnoException)?.code;
    if (code !== "EPIPE" && code !== "ERR_STREAM_DESTROYED") throw error;
  } finally {
    if (!child.stdin.destroyed) child.stdin.end();
  }
}

function matcherAccepts(matcher: string | undefined, toolName: string): boolean {
  if (!matcher) return true;
  try {
    return new RegExp(matcher).test(toolName);
  } catch {
    return matcher === toolName;
  }
}

class LocalClaudeQuery implements Query {
  private readonly queue = new AsyncMessageQueue<ClaudeStreamMessage>();
  private readonly toolUses = new Map<
    string,
    { readonly name: string; readonly input: Record<string, unknown> }
  >();
  private readonly observedToolStarts = new Set<string>();
  private child: ChildProcessWithoutNullStreams | undefined;
  private processTree: ProcessTreeTarget | undefined;
  private stopped = false;
  private forceKillTimer: NodeJS.Timeout | undefined;
  private closeFallbackTimer: NodeJS.Timeout | undefined;
  private outputLines: ReturnType<typeof createInterface> | undefined;
  private resolveChildClose:
    | ((result: readonly [number | null, NodeJS.Signals | null]) => void)
    | undefined;

  constructor(
    private readonly prompt: string | AsyncIterable<SDKUserMessage>,
    private readonly options: Options,
  ) {
    void this.run();
  }

  [Symbol.asyncIterator](): Query {
    return this;
  }

  next(): Promise<IteratorResult<ClaudeStreamMessage>> {
    return this.queue.next();
  }

  async return(): Promise<IteratorResult<ClaudeStreamMessage>> {
    this.stop();
    this.queue.end();
    return { done: true, value: undefined as unknown as ClaudeStreamMessage };
  }

  supportedCommands(): Promise<ReadonlyArray<SlashCommand>> {
    return Promise.reject(unsupported("supportedCommands"));
  }

  getContextUsage(): Promise<SDKControlGetContextUsageResponse> {
    return Promise.reject(unsupported("getContextUsage"));
  }

  rewindFiles(_userMessageUuid: string): Promise<RewindFilesResult> {
    return Promise.reject(unsupported("rewindFiles"));
  }

  private stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    this.queue.end();
    const child = this.child;
    if (child) this.terminateChild(child);
  }

  private terminateChild(child: ChildProcessWithoutNullStreams): void {
    if (child.exitCode !== null) return;
    if (!child.stdin.destroyed) child.stdin.destroy();
    this.outputLines?.close();
    signalProcessTree(child, "SIGTERM");

    if (!this.forceKillTimer) {
      this.forceKillTimer = setTimeout(() => {
        if (child.exitCode === null) {
          signalProcessTree(child, "SIGKILL");
          child.stdin.destroy();
          child.stdout.destroy();
          child.stderr.destroy();
        }
        this.closeFallbackTimer = setTimeout(() => {
          this.resolveChildClose?.([child.exitCode, null]);
        }, 1_000);
        this.closeFallbackTimer.unref();
      }, 1_500);
      this.forceKillTimer.unref();
    }
  }

  private async notifyStreamObservers(
    eventName: string,
    input: HookInput,
    toolUseId?: string,
    toolName = "",
  ): Promise<void> {
    const groups = this.options.streamObservers?.[eventName] ?? [];
    for (const group of groups) {
      if (!matcherAccepts(group.matcher, toolName)) continue;
      for (const observer of group.observers) {
        try {
          await observer(input, toolUseId, {
            signal:
              this.options.abortController?.signal ??
              new AbortController().signal,
          });
        } catch (error) {
          this.options.stderr?.(
            `[bytro-community] ${eventName} observer failed: ${
              error instanceof Error ? error.message : String(error)
            }\n`,
          );
        }
      }
    }
  }

  private async observeMessage(message: ClaudeStreamMessage): Promise<void> {
    if (message.type === "assistant") {
      const content = (
        message.message as { content?: unknown } | undefined
      )?.content;
      if (!Array.isArray(content)) return;
      for (const rawBlock of content) {
        const block = rawBlock as Record<string, unknown>;
        if (
          block.type !== "tool_use" ||
          typeof block.id !== "string" ||
          typeof block.name !== "string" ||
          this.observedToolStarts.has(block.id)
        ) {
          continue;
        }
        const input =
          block.input && typeof block.input === "object"
            ? (block.input as Record<string, unknown>)
            : {};
        this.observedToolStarts.add(block.id);
        this.toolUses.set(block.id, { name: block.name, input });
        await this.notifyStreamObservers(
          "PreToolUse",
          {
            hook_event_name: "PreToolUse",
            tool_name: block.name,
            tool_input: input,
            tool_use_id: block.id,
          },
          block.id,
          block.name,
        );
      }
      return;
    }

    if (message.type === "user") {
      const content = (
        message.message as { content?: unknown } | undefined
      )?.content;
      if (!Array.isArray(content)) return;
      for (const rawBlock of content) {
        const block = rawBlock as Record<string, unknown>;
        if (
          block.type !== "tool_result" ||
          typeof block.tool_use_id !== "string"
        ) {
          continue;
        }
        const tool = this.toolUses.get(block.tool_use_id);
        if (!tool) continue;
        await this.notifyStreamObservers(
          "PostToolUse",
          {
            hook_event_name: "PostToolUse",
            tool_name: tool.name,
            tool_input: tool.input,
            tool_response: block.content,
            tool_use_id: block.tool_use_id,
          },
          block.tool_use_id,
          tool.name,
        );
        this.toolUses.delete(block.tool_use_id);
      }
      return;
    }

    if (message.type !== "system") {
      if (message.type === "result") {
        await this.notifyStreamObservers("Stop", {
          hook_event_name: "Stop",
          last_assistant_message:
            typeof message.result === "string" ? message.result : "",
        });
      }
      return;
    }

    const subtype = message.subtype;
    if (subtype === "task_started") {
      await this.notifyStreamObservers("TaskCreated", {
        ...message,
        hook_event_name: "TaskCreated",
      });
    } else if (
      subtype === "task_completed" ||
      subtype === "task_notification"
    ) {
      await this.notifyStreamObservers("TaskCompleted", {
        ...message,
        hook_event_name: "TaskCompleted",
      });
    } else if (
      subtype === "subagent_started" ||
      subtype === "subagent_start"
    ) {
      await this.notifyStreamObservers("SubagentStart", {
        ...message,
        hook_event_name: "SubagentStart",
      });
    } else if (
      subtype === "subagent_stopped" ||
      subtype === "subagent_stop"
    ) {
      await this.notifyStreamObservers("SubagentStop", {
        ...message,
        hook_event_name: "SubagentStop",
      });
    }
  }

  private async run(): Promise<void> {
    const executable = this.options.pathToClaudeCodeExecutable;
    if (!executable) {
      this.queue.fail(
        new Error(
          "Claude Code is not installed. Set CLAUDE_CLI_PATH or install `claude` on PATH.",
        ),
      );
      return;
    }

    let launch: PreparedClaudeLaunch;
    try {
      launch = prepareClaudeLaunch(this.options);
    } catch (error) {
      this.queue.fail(error);
      return;
    }

    if (launch.permissionModeDegraded) {
      const message =
        "Bytro UI approvals are unavailable in the community CLI adapter; " +
        'permission mode "default" was safely downgraded to "dontAsk".';
      this.options.stderr?.(`[bytro-community] ${message}\n`);
      this.queue.push({
        type: "system",
        subtype: "status",
        status: "permission_mode_degraded",
        message,
      });
    }

    let child: ChildProcessWithoutNullStreams;
    try {
      const invocation = prepareCliProcessInvocation(
        executable,
        launch.args,
        buildClaudeSpawnEnv(this.options.env),
      );
      child = spawn(invocation.executable, [...invocation.args], {
        cwd: this.options.cwd || undefined,
        env: invocation.env,
        stdio: ["pipe", "pipe", "pipe"],
        detached: invocation.detached,
        windowsHide: true,
        windowsVerbatimArguments: invocation.windowsVerbatimArguments,
      });
    } catch (error) {
      launch.cleanup();
      this.queue.fail(error);
      return;
    }
    this.child = child;
    this.processTree = captureProcessTree(child);
    let descendantsReaped = false;
    const reapDescendants = (): void => {
      if (descendantsReaped || !this.processTree) return;
      descendantsReaped = true;
      reapExitedProcessTree(this.processTree);
    };
    const closeResult = new Promise<
      readonly [number | null, NodeJS.Signals | null]
    >((resolve) => {
      let settled = false;
      this.resolveChildClose = (result) => {
        if (settled) return;
        settled = true;
        resolve(result);
      };
      child.once("close", (code, signal) => {
        reapDescendants();
        this.resolveChildClose?.([code, signal]);
      });
    });
    if (this.stopped) this.terminateChild(child);

    const abortSignal = this.options.abortController?.signal;
    const abort = (): void => this.stop();
    if (abortSignal?.aborted) {
      abort();
    } else {
      abortSignal?.addEventListener("abort", abort, { once: true });
    }

    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
      if (stderr.length > 16_384) stderr = stderr.slice(-16_384);
      this.options.stderr?.(chunk);
    });

    const lines = createInterface({
      input: child.stdout,
      crlfDelay: Infinity,
    });
    this.outputLines = lines;
    if (this.stopped) lines.close();
    let spawnError: Error | undefined;
    child.once("error", (error) => {
      reapDescendants();
      spawnError = error;
      this.queue.fail(error);
      // Node normally follows "error" with "close", but destroying the stdio
      // streams and resolving our close gate also covers platform-specific
      // spawn failures that would otherwise leave the async iterator waiting.
      lines.close();
      child.stdin.destroy();
      child.stdout.destroy();
      child.stderr.destroy();
      this.resolveChildClose?.([child.exitCode, null]);
    });

    void writeInput(
      child,
      this.prompt,
      this.options.dimensionPrompts,
    ).catch((error) => {
      if (!this.stopped) {
        this.options.stderr?.(
          `[bytro-community] Claude stdin failed: ${
            error instanceof Error ? error.message : String(error)
          }\n`,
        );
        this.stop();
      }
    });

    try {
      for await (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        let message: ClaudeStreamMessage;
        try {
          message = JSON.parse(trimmed) as ClaudeStreamMessage;
        } catch {
          this.options.stderr?.(
            `[bytro-community] Ignoring non-JSON Claude output: ${trimmed.slice(0, 300)}\n`,
          );
          continue;
        }
        await this.observeMessage(message);
        this.queue.push(message);
      }

      const [code, signal] = await closeResult;
      if (spawnError) {
        this.queue.fail(spawnError);
      } else if (
        code !== 0 &&
        !this.stopped &&
        !this.options.abortController?.signal.aborted
      ) {
        const detail = stderr.trim();
        this.queue.fail(
          new Error(
            `Claude CLI exited with code ${String(code)}${
              signal ? ` (${signal})` : ""
            }${detail ? `: ${detail}` : ""}`,
          ),
        );
      } else {
        this.queue.end();
      }
    } catch (error) {
      if (this.stopped || this.options.abortController?.signal.aborted) {
        this.queue.end();
      } else {
        this.queue.fail(error);
      }
    } finally {
      abortSignal?.removeEventListener("abort", abort);
      if (this.forceKillTimer) clearTimeout(this.forceKillTimer);
      if (this.closeFallbackTimer) clearTimeout(this.closeFallbackTimer);
      this.forceKillTimer = undefined;
      this.closeFallbackTimer = undefined;
      this.resolveChildClose = undefined;
      this.outputLines?.close();
      this.outputLines = undefined;
      this.processTree = undefined;
      launch.cleanup();
    }
  }
}

export function query({
  prompt,
  options,
}: {
  readonly prompt: string | AsyncIterable<SDKUserMessage>;
  readonly options: Options;
}): Query {
  return new LocalClaudeQuery(prompt, options);
}
