import type { SdkType } from "@/lib/platform-config";
import type { ApiMessage } from "@/lib/chat-request";
import type { StreamRequestContext } from "@/lib/chat-stream-registry";
import type { ChatMessage, CommandInvocationMeta } from "@/stores/chat-store";

export interface StreamImageInput {
  readonly base64: string;
  readonly mediaType: string;
}

interface BuildContextOptions {
  readonly generateId?: () => string;
  readonly now?: () => number;
}

export interface BuildStreamSendContextParams {
  readonly content: string;
  /** User-facing display text when `content` contains hidden system instructions. */
  readonly displayContent?: string;
  readonly images?: ReadonlyArray<StreamImageInput>;
  readonly conversationId: string | null;
  readonly isNewConversation: boolean;
  readonly agentType: SdkType;
  readonly modelLabel: string;
  /** Platform ID (e.g. "codex", "claude") — stored in StreamRequestContext so
   *  event handlers can reference the original platform without relying on
   *  the potentially-changed activePlatformId. */
  readonly platformId?: string;
  /** Slash-command metadata when this input was classified as an SDK command.
   *  Set by the dispatcher in use-chat-streaming. UI uses this to render a
   *  compact command card instead of a normal user bubble. */
  readonly commandInvocation?: CommandInvocationMeta;
  /** True when this message was submitted through Codex Goals mode. */
  readonly sentAsGoal?: boolean;
  /** Review-forward metadata when this input was forwarded from the Live
   *  Reviewer panel.  UI renders a collapsible review card instead of the
   *  raw injected markdown — see `lib/live-review-events.ts`. */
  readonly reviewForward?: import("@/lib/live-review-events").ReviewForwardMeta;
}

export interface BuiltStreamSendContext {
  readonly userMessage: ChatMessage;
  readonly assistantMessage: ChatMessage;
  readonly requestContext: StreamRequestContext;
}

const DEFAULT_BUILD_CONTEXT_OPTIONS: Required<BuildContextOptions> = {
  generateId: () => crypto.randomUUID(),
  now: () => Date.now(),
};

export function buildStreamSendContext(
  params: BuildStreamSendContextParams,
  options: BuildContextOptions = DEFAULT_BUILD_CONTEXT_OPTIONS,
): BuiltStreamSendContext {
  const buildOptions = {
    ...DEFAULT_BUILD_CONTEXT_OPTIONS,
    ...options,
  };

  const userMessageId = buildOptions.generateId();
  const assistantMessageId = buildOptions.generateId();
  const requestId = buildOptions.generateId();
  const timestamp = buildOptions.now();

  const userMessage: ChatMessage = {
    id: userMessageId,
    role: "user",
    content: params.content,
    ...(params.displayContent ? { displayContent: params.displayContent } : {}),
    timestamp,
    ...(params.images && params.images.length > 0
      ? {
          media: params.images.map((image) => ({ mediaType: image.mediaType, data: image.base64 })),
        }
      : {}),
    ...(params.commandInvocation ? { commandInvocation: params.commandInvocation } : {}),
    ...(params.sentAsGoal ? { sentAsGoal: true } : {}),
    ...(params.reviewForward ? { reviewForward: params.reviewForward } : {}),
  };

  const assistantMessage: ChatMessage = {
    id: assistantMessageId,
    role: params.agentType,
    content: "",
    agent: params.modelLabel,
    timestamp,
  };

  const requestContext: StreamRequestContext = {
    requestId,
    startedAt: Date.now(),
    turnStartedAt: Date.now(),
    messageId: assistantMessageId,
    conversationId: params.conversationId,
    platformId: params.platformId,
    sdk: params.agentType,
    modelLabel: params.modelLabel,
    accumulated: "",
    thinkingBlocks: [],
    thinkingPhaseActive: false,
    isNewConversation: params.isNewConversation,
    firstUserMessage: params.content,
    titleTriggered: false,
  };

  return {
    userMessage,
    assistantMessage,
    requestContext,
  };
}

export interface BuildStreamInvokePayloadParams {
  readonly requestId: string;
  readonly agentType: SdkType;
  readonly messages: ReadonlyArray<ApiMessage>;
  readonly model: string;
  readonly baseUrl?: string;
  readonly apiKey?: string;
  readonly authMode?: "apiKey" | "oauth";
  readonly profileId?: string;
  /** Rust-owned OAuth token lookup reference. Never contains credential data. */
  readonly oauthProvider?: string;
  readonly systemPrompt: string;
  readonly permissionMode: string;
  readonly sessionId: string | null;
  readonly images?: ReadonlyArray<StreamImageInput>;
  readonly proxyUrl?: string;
  readonly cwd?: string;
  readonly mcpServers?: Readonly<Record<string, unknown>>;
  readonly conversationId?: string | null;
  readonly disableTools?: boolean;
  /** Whether extended thinking / reasoning is enabled (legacy). */
  readonly thinkingEnabled?: boolean;
  /** Reasoning effort level: "off" | "low" | "medium" | "high" | "max". */
  readonly reasoningLevel?: string;
  readonly ultracode?: boolean;
  /** Claude fast mode — enables Claude Code's fast mode (Opus 4.6+) via the
   *  SDK `fastMode` session setting. Claude only; ignored by other agents. */
  readonly fastMode?: boolean;
  /** Default quality for openai_images MCP tool: "low" | "medium" | "high" | "auto". */
  readonly imageGenQuality?: string;
  /** Default size for openai_images MCP tool. One of the popular gpt-image-2
   *  presets, e.g. "1024x1024" / "2048x2048" / "3840x2160" / "auto". */
  readonly imageGenSize?: string;
  /** Absolute directory where AI-generated images are saved. Empty / undefined
   *  lets the Rust backend fall back to `<app_data_dir>/outputs`. */
  readonly outputsDir?: string;
  /** Codex App Server service tier override, e.g. "fast". */
  readonly serviceTier?: string;
  /** Enable Codex App Server Goals mode for this request. */
  readonly goalModeEnabled?: boolean;
  /** Platform identifier for credential routing in the sidecar. */
  readonly platform?: string;
  /** Health-check dimension prompts — injected by PreToolUse hook in the sidecar. */
  readonly dimensionPrompts?: Readonly<Record<string, string>>;
  /** Ollama num_ctx override. */
  readonly numCtx?: number;
  /** Slash-command metadata routed through to the sidecar. Codex uses this to
   *  detect /compact and route via `thread/compact/start` RPC instead of
   *  sending the literal text as a turn input. */
  readonly commandInvocation?: CommandInvocationMeta;
  /** Caveman compression mode — "off" or "full". Sidecar appends caveman
   *  ruleset to the system prompt when "full" (Claude only for now). */
  readonly cavemanMode?: "off" | "lite" | "full" | "ultra" | "wenyan";
  /** Conversation fork: resume the source session but write to a NEW session id
   *  (SDK `forkSession`). Set on a forked conversation's first turn. Claude only. */
  readonly forkSession?: boolean;
  /** Conversation fork anchor — resume only up to and including this message uuid
   *  (SDK `resumeSessionAt`). Pairs with `forkSession`. */
  readonly resumeSessionAt?: string;
}

export interface StreamInvokePayload extends Record<string, unknown> {
  readonly requestId: string;
  readonly agent: SdkType;
  readonly messages: ReadonlyArray<ApiMessage>;
  readonly model?: string;
  readonly baseUrl?: string;
  readonly apiKey?: string;
  readonly authMode?: "apiKey" | "oauth";
  readonly profileId?: string;
  readonly oauthProvider?: string;
  readonly system?: string;
  readonly permissionMode: string;
  readonly sessionId: string | null;
  readonly images?: ReadonlyArray<{ readonly media_type: string; readonly data: string }>;
  readonly proxyUrl?: string;
  readonly cwd?: string;
  readonly mcpServers?: Readonly<Record<string, unknown>>;
  readonly conversationId?: string | null;
  readonly disableTools?: boolean;
  readonly thinkingEnabled?: boolean;
  readonly reasoningLevel?: string;
  readonly ultracode?: boolean;
  readonly fastMode?: boolean;
  readonly imageGenQuality?: string;
  readonly imageGenSize?: string;
  readonly outputsDir?: string;
  readonly serviceTier?: string;
  readonly goalModeEnabled?: boolean;
  readonly platform?: string;
  readonly dimensionPrompts?: Readonly<Record<string, string>>;
  /** Ollama num_ctx override. */
  readonly numCtx?: number;
  /** Slash-command metadata — see BuildStreamInvokePayloadParams.commandInvocation. */
  readonly commandInvocation?: CommandInvocationMeta;
  /** Caveman compression mode — see BuildStreamInvokePayloadParams.cavemanMode. */
  readonly cavemanMode?: "off" | "lite" | "full" | "ultra" | "wenyan";
  /** Conversation fork — see BuildStreamInvokePayloadParams.forkSession. */
  readonly forkSession?: boolean;
  /** Conversation fork anchor — see BuildStreamInvokePayloadParams.resumeSessionAt. */
  readonly resumeSessionAt?: string;
}

export function buildStreamInvokePayload(
  params: BuildStreamInvokePayloadParams,
): StreamInvokePayload {
  return {
    requestId: params.requestId,
    agent: params.agentType,
    messages: params.messages,
    model: params.model || undefined,
    baseUrl: params.baseUrl,
    apiKey: params.authMode === "oauth" ? undefined : params.apiKey,
    authMode: params.authMode,
    profileId: params.profileId,
    ...(params.authMode === "oauth"
      ? { oauthProvider: params.oauthProvider }
      : {}),
    system: params.systemPrompt || undefined,
    permissionMode: params.permissionMode,
    sessionId: params.sessionId,
    images: params.images?.map((img) => ({ media_type: img.mediaType, data: img.base64 })),
    proxyUrl: params.proxyUrl,
    cwd: params.cwd,
    mcpServers: params.mcpServers,
    conversationId: params.conversationId ?? undefined,
    disableTools: params.disableTools ?? undefined,
    thinkingEnabled: params.thinkingEnabled,
    reasoningLevel: params.reasoningLevel,
    ultracode: params.ultracode,
    fastMode: params.fastMode,
    imageGenQuality: params.imageGenQuality,
    imageGenSize: params.imageGenSize,
    outputsDir: params.outputsDir,
    serviceTier: params.serviceTier,
    goalModeEnabled: params.goalModeEnabled,
    platform: params.platform,
    dimensionPrompts: params.dimensionPrompts,
    numCtx: params.numCtx,
    commandInvocation: params.commandInvocation,
    cavemanMode: params.cavemanMode,
    forkSession: params.forkSession,
    resumeSessionAt: params.resumeSessionAt,
  };
}
