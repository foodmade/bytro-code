import { useCallback, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useChatStore, useSettingsStore, useConversationStore, usePermissionStore, useFileTreeStore, useMcpStore, useWorkspaceStore, useStreamStateStore, useAgentStatusStore, useFileChangesStore, useCliToolsStore, useAppStore, useSplitViewStore, useImagegenPrefsStore, imagegenScopeKey } from "@/stores";
import { useOllamaStore } from "@/stores/ollama-store";
import { useToolStateStore } from "@/stores/tool-state-store";
import { dispatchSlashCommand, type SlashDispatchResult } from "@/lib/slash-command-dispatcher";
import { expandBuiltinSlashCommandPrompt, getBuiltinSlashCommands, mergeSlashCommands, type BuiltinSlashCommandPlatform } from "@/lib/slash-command-builtins";
import { resolveActiveCredentials, getEffectiveSdk, PLATFORM_REGISTRY, encodeConversationModel, buildProfileProxyUrl } from "@/lib/platform-config";
import { buildApiMessages, buildProviderTransportArgs } from "@/lib/chat-request";
import { buildStreamInvokePayload, buildStreamSendContext } from "@/lib/chat-stream-send";
import { executeClientSlashCommand, getClientSlashCommands } from "@/lib/client-slash-commands";

import {
  getActiveStreamRequestContext,
  getLatestStreamRequestContextForConversation,
  setActiveStreamRequest,
  upsertStreamRequestContext,
} from "@/lib/chat-stream-registry";
import { removeRequestAndSyncStreamState } from "@/lib/chat-stream-state";
import { getGlobalRegistry, getGlobalStreamStateWriter } from "@/lib/chat-stream-manager";
import {
  getWarmSessionRequestId,
  shouldInvalidateWarmSession,
  clearWarmSession,
} from "@/lib/warm-session-tracker";
import { track } from "@/lib/tracking";
import type { SplitPaneId } from "@/stores";
import { resolvePaneModel } from "@/lib/pane-model";
import { resolveChatPaneScope } from "@/lib/chat-pane-scope";

// Track the CWD used when each conversation's session was created.
// When the user opens a different directory in Explorer, we skip session
// resumption so Claude Code starts a fresh session in the new directory.
// Bounded by the number of conversations visited in a single app session —
// typically a handful, so memory impact is negligible.
const sessionCwdMap = new Map<string, string>();

// Track the platform config used when each conversation's session was created.
// When the user switches platform OR changes apiKey/baseUrl within the same
// platform, the existing session was started with old credentials. Resuming it
// would send requests to the wrong endpoint, so we invalidate the session.
interface SessionPlatformConfig {
  readonly platformId: string;
  readonly apiKey: string;
  readonly baseUrl: string;
}
const sessionPlatformConfigMap = new Map<string, SessionPlatformConfig>();

// Track the permission mode used when each conversation's session was created.
// When the user switches permission mode mid-conversation, the existing SDK
// session may ignore the new mode. Clearing sessionId forces a fresh session
// so the new mode takes effect immediately on the next message.
const sessionPermissionModeMap = new Map<string, string>();

// Track the thinking-enabled state used when each conversation's session was
// created. Changing the thinking toggle mid-conversation may not be honoured
// by a resumed SDK session, so we force a fresh session when it changes.
const sessionThinkingMap = new Map<string, boolean>();

interface ResolvedSlashCommandPayload {
  readonly name: string;
  readonly description: string;
  readonly content: string;
}

function expandFilesystemSlashCommandPrompt(
  name: string,
  args: string,
  content: string,
): string {
  const trimmedArgs = args.trim();
  return [
    `<slash-command name="/${name}">`,
    "<command-instructions>",
    content.trim(),
    "</command-instructions>",
    trimmedArgs ? `<arguments>\n${trimmedArgs}\n</arguments>` : "",
    "Execute the local slash command described above. Do not treat the slash command token as literal user prose.",
    "</slash-command>",
  ].filter(Boolean).join("\n");
}

async function expandSlashCommandForAgent(
  dispatch: SlashDispatchResult,
  platform: BuiltinSlashCommandPlatform | null,
  cwd: string,
): Promise<string | null> {
  if (dispatch.kind !== "sdk" || platform !== "codex") return null;

  if (dispatch.info.source === "builtin") {
    // /compact and /status are handled in the sidecar via native Codex RPCs.
    // Returning null preserves the raw slash-command text on the user message,
    // while the sidecar routes by `commandInvocation` metadata instead of
    // forwarding the literal text as turn/start input.
    if (dispatch.canonicalName === "compact" || dispatch.canonicalName === "status") return null;
    return expandBuiltinSlashCommandPrompt(platform, dispatch.canonicalName, dispatch.args);
  }

  if (dispatch.info.source === "filesystem") {
    try {
      const resolved = await invoke<ResolvedSlashCommandPayload | null>("resolve_slash_command", {
        cwd: cwd || undefined,
        provider: platform,
        name: dispatch.canonicalName,
      });
      if (resolved?.content.trim()) {
        return expandFilesystemSlashCommandPrompt(
          dispatch.canonicalName,
          dispatch.args,
          resolved.content,
        );
      }
    } catch {
      // Fall through to the metadata fallback below.
    }

    if (dispatch.info.description.trim()) {
      return expandFilesystemSlashCommandPrompt(
        dispatch.canonicalName,
        dispatch.args,
        dispatch.info.description,
      );
    }
  }

  return null;
}

interface PastedImage {
  readonly id: string;
  readonly base64: string;
  readonly mediaType: string;
  readonly preview: string;
}

export interface ChatStreamingOptions {
  /** Prepended to the assembled system prompt (memory context + language). */
  readonly systemPromptPrefix?: string;
  /** When true, the agent runs with no tools — pure conversation mode. */
  readonly disableTools?: boolean;
  /** Override the global permission mode for this chat instance. */
  readonly permissionModeOverride?: string;
  /** Scoped conversation id in split mode. */
  readonly conversationId?: string | null;
  /** Scoped pane id in split mode. */
  readonly paneId?: SplitPaneId;
}

export function useChatStreaming(options?: ChatStreamingOptions) {
  const sendingRef = useRef(false);

  // Keep a ref to options so that useCallback closures always read the latest
  // value without needing options in the dependency array (which would recreate
  // the callbacks and break memoisation of consumers).
  const optionsRef = useRef(options);
  optionsRef.current = options;

  // Use the application-wide registry and writer (owned by chat-stream-manager)
  // instead of component-scoped refs. This ensures event listeners keep working
  // even when ChatPanel unmounts (e.g. switching to Idea Hub or Workspace).
  const registry = getGlobalRegistry();
  const streamStateWriter = getGlobalStreamStateWriter();

  const handleSendInner = useCallback(async (
    content: string,
    images?: ReadonlyArray<PastedImage>,
    displayContent?: string,
    _modes?: ReadonlyArray<string>,
    metadata?: import("@/lib/live-review-events").ChatMessageMetadata,
  ) => {

    const store = useChatStore.getState();
    const convStore = useConversationStore.getState();
    const currentOptions = optionsRef.current;
    const paneScope = resolveChatPaneScope(currentOptions);

    // Clear file changes from the previous turn before starting a new one
    useFileChangesStore.getState().clearChanges(paneScope.conversationId);
    const settingsState = useSettingsStore.getState();
    const { platforms, platformModelOptions } = settingsState;

    const modelSelection = resolvePaneModel({
      paneId: paneScope.paneId ?? undefined,
      conversationId: paneScope.conversationId,
    });
    if (modelSelection.requiresLocalSelection || !modelSelection.platformId) {
      store.addMessage({
        id: crypto.randomUUID(),
        role: "system",
        content:
          "This conversation used a hosted model that is unavailable in the community build. Select a local model profile to continue.",
        timestamp: Date.now(),
      });
      useAppStore.getState().openSettings("models");
      return false;
    }
    const resolvedPlatformId = modelSelection.platformId;
    const platformConfig = platforms[resolvedPlatformId];
    let agentType: import("@/lib/platform-config").SdkType;
    let selectedModel: string;
    let modelLabel: string;
    let apiKey: string;
    let baseUrl: string;

    const activeProfile = platformConfig?.profiles.find(
      (p) => p.id === platformConfig.activeProfileId,
    );
    const activeProfileAgentProxyUrl = buildProfileProxyUrl(activeProfile);
    const isClaudeOAuthProfile =
      resolvedPlatformId === "claude" && activeProfile?.authMode === "oauth";
    const isCodexOAuthProfile =
      resolvedPlatformId === "codex" && activeProfile?.authMode === "oauth";
    const authMode: "apiKey" | "oauth" = isClaudeOAuthProfile || isCodexOAuthProfile ? "oauth" : "apiKey";
    const authProfileId = authMode === "oauth" ? activeProfile?.id : undefined;
    const oauthProvider = authMode === "oauth" ? resolvedPlatformId : undefined;

    if (isClaudeOAuthProfile && activeProfile) {
      // The WebView carries only a provider/profile reference. Rust resolves
      // the OAuth token immediately before writing the local sidecar command.
      agentType = "claude";
      const meta = PLATFORM_REGISTRY[resolvedPlatformId];
      selectedModel =
        modelSelection.modelId || platformConfig.activeModelId || meta.defaultModel;
      modelLabel = meta.models.find((m) => m.id === selectedModel)?.label ?? selectedModel;
      baseUrl = "";
      apiKey = "";
    } else if (isCodexOAuthProfile) {
      agentType = "codex";
      const meta = PLATFORM_REGISTRY[resolvedPlatformId];
      selectedModel =
        modelSelection.modelId || platformConfig.activeModelId || meta.defaultModel;
      modelLabel = meta.models.find((m) => m.id === selectedModel)?.label ?? selectedModel;
      apiKey = "";
      baseUrl = "";
    } else {
      // Regular platform credentials
      const creds = resolveActiveCredentials(platformConfig);
      agentType = getEffectiveSdk(platformConfig);
      selectedModel = modelSelection.modelId || creds?.model || platformConfig.activeModelId;
      const meta = PLATFORM_REGISTRY[resolvedPlatformId];
      modelLabel = meta.models.find((m) => m.id === selectedModel)?.label ?? selectedModel;
      apiKey = creds?.apiKey ?? "";
      baseUrl = creds?.baseUrl ?? "";
    }
    const agentProxyUrl =
      agentType === "claude" || agentType === "codex"
        ? activeProfileAgentProxyUrl
        : undefined;

    // ── CLI dependency check ───────────────────────────────────────────
    // For SDK channels that require a CLI tool (claude/codex/gemini),
    // verify the tool is installed before sending. Uses cached scan
    // results to avoid redundant scanning.
    const cliCheck = useCliToolsStore.getState().checkSdkDependency(agentType);
    if (cliCheck && !cliCheck.installed) {
      // Ensure cache is loaded (first message in session)
      if (!useCliToolsStore.getState().loaded) {
        await useCliToolsStore.getState().loadTools();
        const recheckResult = useCliToolsStore.getState().checkSdkDependency(agentType);
        if (recheckResult && !recheckResult.installed) {
          store.addMessage({
            id: crypto.randomUUID(),
            role: "system",
            content: "",
            timestamp: Date.now(),
            cliMissing: {
              sdk: agentType,
              displayName: recheckResult.displayName,
            },
          });
          return false;
        }
        // Tool was found after loading — continue
      } else {
        store.addMessage({
          id: crypto.randomUUID(),
          role: "system",
          content: "",
          timestamp: Date.now(),
          cliMissing: {
            sdk: agentType,
            displayName: cliCheck.displayName,
          },
        });
        return false;
      }
    }
    // ── End CLI dependency check ───────────────────────────────────────

    // 1. Ensure we have an active conversation
    let convId = paneScope.conversationId;
    const targetPaneId = paneScope.paneId;

    // Ghost-conversation guard: a pane (or activeConversationId) can still
    // reference a conversation whose DB row is gone — deleted while the pane
    // stayed bound. Sending with that id skips row creation, so the turn never
    // persists and the conversation never appears in any list while its stream
    // keeps running. Verify existence and fall back to the new-conversation
    // path when the row is missing.
    let ghostConvId: string | null = null;
    if (convId) {
      try {
        const existing = await invoke<unknown>("get_conversation_summary", { conversationId: convId });
        if (!existing) {
          ghostConvId = convId;
          convId = null;
        }
      } catch {
        // Verification is best-effort — never block sending on it.
        console.error("[ghost-guard] conversation existence check failed");
      }
    }

    const isNew = !convId;
    const storedModel = encodeConversationModel(resolvedPlatformId, selectedModel);
    if (!convId) {
      try {
        const workspaceId = useWorkspaceStore.getState().activeWorkspaceId ?? undefined;
        const conv = await convStore.createConversation(storedModel, workspaceId);
        convId = conv.id;

        const splitState = useSplitViewStore.getState();
        if (targetPaneId && splitState.draftPaneIds.includes(targetPaneId)) {
          splitState.bindDraftPaneToConversation(targetPaneId, convId);
        } else if (ghostConvId && targetPaneId) {
          // Swap the stale binding for the freshly created conversation so the
          // pane the user is typing in follows the new row.
          splitState.rebindPaneConversation(targetPaneId, ghostConvId, convId);
        }
        if (ghostConvId) {
          // Drop any snapshot left over from the deleted conversation.
          store.clearSnapshot(ghostConvId);
        }

        // Promote any draft-scoped imagegen overrides to the new conversation
        // so the user's pre-send quality/size choices stick.
        const draftKey = imagegenScopeKey(null, targetPaneId);
        useImagegenPrefsStore.getState().promote(draftKey, convId);

      } catch {
        console.error("[chat] conversation creation failed");
        return false;
      }
    } else if (convId) {
      const currentConv = convStore.conversations.find((c) => c.id === convId);
      if (currentConv && currentConv.model !== storedModel) {
        convStore.updateConversationModel(convId, storedModel).catch(() => {
          console.error("[model-sync] conversation model update failed");
        });
        if (targetPaneId) {
          useSplitViewStore.getState().clearDraftPaneModel(targetPaneId);
        }
      }
    }

    const commandCwd = useWorkspaceStore.getState().activeWorkspace?.path
      || useFileTreeStore.getState().rootPath
      || "";
    const builtinSlashPlatform: BuiltinSlashCommandPlatform | null = agentType === "claude" || agentType === "codex" ? agentType : null;
    const sdkCommands = mergeSlashCommands(
      getBuiltinSlashCommands(builtinSlashPlatform),
      useToolStateStore
        .getState()
        .getSlashCommandsForPlatform(builtinSlashPlatform),
    );
    const dispatch = dispatchSlashCommand(content, sdkCommands);

    // ── Client-side slash commands ─────────────────────────────────────
    // Commands the CLI can't run headlessly (/status, /help) are answered
    // locally from host state — no sidecar round-trip, no streaming.
    if (dispatch.kind === "client") {
      const clientUserMsg = {
        id: crypto.randomUUID(),
        role: "user" as const,
        content,
        timestamp: Date.now(),
        commandInvocation: {
          canonicalName: dispatch.commandName,
          typedName: dispatch.commandName,
          args: dispatch.args,
          description: getClientSlashCommands().find((c) => c.name === dispatch.commandName)?.description ?? "",
        },
      };
      store.addMessage(clientUserMsg);
      if (convId) store.persistMessage(convId, clientUserMsg);

      const body = await executeClientSlashCommand(dispatch.handler, {
        platformId: resolvedPlatformId,
        modelId: selectedModel,
        modelLabel,
        conversationId: convId,
        cwd: commandCwd,
        permissionMode: currentOptions?.permissionModeOverride ?? usePermissionStore.getState().mode,
        commands: mergeSlashCommands(sdkCommands, getClientSlashCommands()),
      });
      const clientResultMsg = {
        id: crypto.randomUUID(),
        role: "system" as const,
        content: body,
        timestamp: Date.now(),
      };
      store.addMessage(clientResultMsg);
      if (convId) store.persistMessage(convId, clientResultMsg);
      return true;
    }
    // ── End client-side slash commands ─────────────────────────────────

    const commandApiContent = await expandSlashCommandForAgent(
      dispatch,
      builtinSlashPlatform,
      commandCwd,
    );
    const apiBaseContent = commandApiContent ?? content;
    const commandInvocation = dispatch.kind === "sdk"
      ? {
          canonicalName: dispatch.canonicalName,
          typedName: dispatch.typedName,
          argumentHint: dispatch.info.argumentHint,
          args: dispatch.args,
          description: dispatch.info.description,
        }
      : undefined;

    const isCompactCommand = commandInvocation?.canonicalName === "compact";

    // Imagegen creative-mode injection — directive prepended to THIS turn's
    // user content (not systemPrompt). Codex passes `developer_instructions:
    // null` and ignores systemPrompt entirely, so only the user message
    // survives across all SDK paths.
    //
    // We mutate a separate `apiContent` (not `content`) so the directive
    // applies to this turn only — baking it into the persisted message
    // would cause every subsequent turn to resend it as history.
    let apiContent = apiBaseContent;
    if (useAppStore.getState().creativeMode === "imagegen") {
      const imagegenDirective = [
        "<force_imagegen_mode>",
        "The user explicitly enabled image-generation mode for THIS message.",
        "You MUST use the openai_images MCP for any image creation:",
        "  - `mcp__openai_images__generate_image` — new images from a prompt",
        "  - `mcp__openai_images__edit_image` — edit / restyle / inpaint",
        "",
        "ABSOLUTE PROHIBITIONS for this turn:",
        "  - Do NOT use Playwright, Puppeteer, headless Chrome, or any browser screenshot path.",
        "  - Do NOT write SVG / HTML / CSS files and render them as images.",
        "  - Do NOT call any image-related skill (e.g. /imagegen) — call the MCP tools directly.",
        "  - Do NOT propose alternatives like 'export the existing HTML to PNG' — generate fresh images via the MCP.",
        "",
        "Guidelines:",
        "  - Default quality: high. Default size: auto unless the user requests a specific aspect ratio.",
        "  - For multiple images, fire parallel n=1 calls.",
        "  - The MCP returns absolute file paths; reference them with `![alt](absolute/path)` in your reply.",
        "</force_imagegen_mode>",
      ].join("\n");
      apiContent = `${imagegenDirective}\n\n${apiBaseContent}`;
    }

    // ── Warm session routing ───────────────────────────────────────────
    // If there's an existing warm session for this conversation and the
    // config hasn't changed, route the message via send_user_input instead
    // of spawning a new CLI process.
    if (convId) {
      const warmRid = getWarmSessionRequestId(convId);
      if (warmRid) {
        const workspacePath = useWorkspaceStore.getState().activeWorkspace?.path ?? "";
        const currentConfig = {
          model: selectedModel,
          platformId: resolvedPlatformId,
          cwd: workspacePath,
          reasoningLevel: settingsState.reasoningLevel ?? "off",
          // Gated on platformId (not agentType/effective SDK) to match the
          // sidecar's shouldEnableReasoning platform check — a third-party
          // platform routed through the Claude SDK must not carry ultracode.
          ultracodeEnabled: resolvedPlatformId === "claude" ? settingsState.platformModelOptions.claude.ultracodeEnabled : undefined,
          fastModeEnabled: resolvedPlatformId === "claude" ? settingsState.platformModelOptions.claude.fastEnabled : undefined,
          serviceTier: agentType === "codex" && platformModelOptions.codex.fastEnabled ? "fast" : undefined,
          goalModeEnabled: agentType === "codex" && useAppStore.getState().goalModeEnabled,
          apiKey,
          baseUrl,
          authMode,
          profileId: authProfileId,
          permissionMode: currentOptions?.permissionModeOverride ?? usePermissionStore.getState().mode,
          proxyUrl: agentProxyUrl ?? "",
        };

        if (shouldInvalidateWarmSession(convId, currentConfig)) {
          // Config changed — kill the warm session process, fall through to
          // normal flow.  We preserve session_id so the next cold query uses
          // `resume = oldSessionId` — this continues the same JSONL file
          // instead of orphaning it and creating a ghost "CLI Session".
          clearWarmSession(convId);
          try {
            await invoke("kill_session", { conversationId: convId });
          } catch {
            // Warm session may already be dead — ignore
          }
        } else {
          // Config matches — route to warm session.
          // Only add the user message and register a stub stream context
          // here. The sidecar will emit a `new_turn` event which creates
          // the assistant placeholder and activates the streaming UI —
          // doing it here too would produce a duplicate empty bubble.
          useFileChangesStore.getState().clearChanges(convId);

          const userMsg = {
            id: crypto.randomUUID(),
            role: "user" as const,
            content,
            displayContent: displayContent || undefined,
            timestamp: Date.now(),
            ...(images && images.length > 0
              ? { media: images.map((i) => ({ mediaType: i.mediaType, data: i.base64 })) }
              : {}),
            ...(commandInvocation ? { commandInvocation } : {}),
          };
          store.addMessage(userMsg);
          if (convId) {
            store.persistMessage(convId, userMsg);
          }

          // Register a stub context so the new_turn handler can find it.
          // messageId is a temporary placeholder — new_turn will replace
          // it with the real assistant message ID.
          upsertStreamRequestContext(registry, {
            requestId: warmRid,
            startedAt: Date.now(),
            messageId: `warm-pending-${warmRid}`,
            conversationId: convId,
            platformId: resolvedPlatformId,
            sdk: agentType,
            modelLabel,
            accumulated: "",
            thinkingBlocks: [],
            thinkingPhaseActive: false,
            isNewConversation: false,
            firstUserMessage: content,
            titleTriggered: true,
            warmSessionConfig: currentConfig,
          });
          setActiveStreamRequest(registry, warmRid);

          try {
            // Pre-turn checkpoint for warm session — fire-and-forget to avoid
            // blocking the send path. The git operation will almost certainly
            // finish before the AI starts modifying files (local git << network RTT).
            if (workspacePath) {
              invoke("git_checkpoint_create", {
                path: workspacePath,
                label: "Pre-turn snapshot",
                conversationId: convId,
              }).catch(() => { /* non-critical */ });
            }

            const imagePayload = images?.map((i) => ({
              media_type: i.mediaType,
              data: i.base64,
            }));
            const currentReasoningLevel = useSettingsStore.getState().reasoningLevel;
            if (isCompactCommand) {
              useAgentStatusStore.getState().setCompacting("manual", 0, convId);
            }
            await invoke("send_user_input", {
              requestId: warmRid,
              content: apiContent,
              images: imagePayload?.length ? imagePayload : undefined,
              reasoningLevel: currentReasoningLevel !== "off" ? currentReasoningLevel : undefined,
              commandInvocation,
              proxyUrl: agentProxyUrl,
            });
            return true;
          } catch {
            console.error("[warm-session] queued message delivery failed");
            useAgentStatusStore.getState().clearCompacting(convId, true);
            removeRequestAndSyncStreamState(registry, warmRid, streamStateWriter, convId);
            clearWarmSession(convId);

            // Show the error visibly in the chat as an assistant error message
            const errorMsgObj = {
              id: crypto.randomUUID(),
              role: "claude" as const,
              content: "**Warm session error:** The session could not continue. Sending your message again will start a new session.",
              timestamp: Date.now(),
            };
            store.addMessage(errorMsgObj);
            return false;
          }
        }
      }
    }
    // ── End warm session routing ───────────────────────────────────────

    // 2. Fetch memory context + session ID concurrently to reduce first-token latency.
    //    These two async operations are independent — neither depends on the other's result.
    const _memoryPromise = (convId && settingsState.crossSessionMemory)
      ? (async () => {
          return store.fetchMemoryContext(convId, content);
        })()
      : Promise.resolve("");
    const _sessionIdPromise = convId
      ? (async () => {
          try {
            return await convStore.getSessionId(convId);
          } catch {
            return null;
          }
        })()
      : Promise.resolve(null as string | null);
    const [_memoryResult, _resolvedSessionId] = await Promise.all([_memoryPromise, _sessionIdPromise]);
    let systemPrompt = _memoryResult;

    // 3. Inject response language instruction when a specific language is selected
    const responseLanguage = settingsState.responseLanguage;
    const LANG_INSTRUCTIONS: Record<string, string> = {
      zh: "CRITICAL REQUIREMENT: You MUST respond entirely in Chinese (简体中文). All explanations, comments, descriptions, and conversational text must be written in Chinese. When using extended thinking (thinking/reasoning mode), you MUST also think and reason in Chinese (简体中文). Your internal thought process, analysis, and reasoning must all be conducted in Chinese, not English.",
      ja: "CRITICAL REQUIREMENT: You MUST respond entirely in Japanese (日本語). All explanations, comments, descriptions, and conversational text must be written in Japanese. When using extended thinking (thinking/reasoning mode), you MUST also think and reason in Japanese (日本語). Your internal thought process, analysis, and reasoning must all be conducted in Japanese, not English.",
      ko: "CRITICAL REQUIREMENT: You MUST respond entirely in Korean (한국어). All explanations, comments, descriptions, and conversational text must be written in Korean. When using extended thinking (thinking/reasoning mode), you MUST also think and reason in Korean (한국어). Your internal thought process, analysis, and reasoning must all be conducted in Korean, not English.",
      fr: "CRITICAL REQUIREMENT: You MUST respond entirely in French (Français). All explanations, comments, descriptions, and conversational text must be written in French. When using extended thinking (thinking/reasoning mode), you MUST also think and reason in French (Français). Your internal thought process, analysis, and reasoning must all be conducted in French, not English.",
      de: "CRITICAL REQUIREMENT: You MUST respond entirely in German (Deutsch). All explanations, comments, descriptions, and conversational text must be written in German. When using extended thinking (thinking/reasoning mode), you MUST also think and reason in German (Deutsch). Your internal thought process, analysis, and reasoning must all be conducted in German, not English.",
      es: "CRITICAL REQUIREMENT: You MUST respond entirely in Spanish (Español). All explanations, comments, descriptions, and conversational text must be written in Spanish. When using extended thinking (thinking/reasoning mode), you MUST also think and reason in Spanish (Español). Your internal thought process, analysis, and reasoning must all be conducted in Spanish, not English.",
    };
    const langBody = LANG_INSTRUCTIONS[responseLanguage];
    if (langBody) {
      const langInstruction = [
        "<response_language>",
        langBody,
        "Code identifiers, technical terms in code blocks, and file paths may remain in English, but all surrounding text and explanations must be in the specified language.",
        "This is a strict requirement — do not use English for any non-code text.",
        "</response_language>",
      ].join("\n");
      systemPrompt = systemPrompt
        ? `${langInstruction}\n\n${systemPrompt}`
        : langInstruction;
    }

    // 3b. Inject custom system prompt prefix (e.g. idea discussion context)
    if (currentOptions?.systemPromptPrefix) {
      systemPrompt = currentOptions.systemPromptPrefix + (systemPrompt ? "\n\n" + systemPrompt : "");
    }

    // 3c. Inject slideshow generation prompt when PPTX creative mode is active.
    //     Currently disabled in the UI (CreativeModeButton's pptx option is
    //     non-interactive); kept here so re-enabling it in the future only
    //     requires flipping the option flag.
    if (useAppStore.getState().creativeMode === "pptx") {
      const pptxPrompt = [
        "<slideshow_generation>",
        "IMPORTANT: The user has enabled Presentation Mode. You MUST output a structured JSON block in a ```slideshow fenced code block directly in your chat response. The application will render a live slide preview in a side panel automatically.",
        "",
        "CRITICAL RULES — READ CAREFULLY:",
        "- Do NOT use the /pptx skill or any pptx-related skills",
        "- Do NOT create any files (.cjs, .js, .pptx, .html, etc.)",
        "- Do NOT install any npm packages or run any scripts",
        "- Do NOT use any tools or commands — ONLY output text with the JSON code block",
        "- Your ENTIRE response should be the ```slideshow JSON block followed by a brief description",
        "",
        "Output format — wrap JSON in a ```slideshow code fence:",
        "```slideshow",
        '{',
        '  "title": "Presentation Title",',
        '  "theme": { "backgroundColor": "#0f172a", "titleColor": "#f1f5f9", "textColor": "#94a3b8", "accentColor": "#3b82f6", "fontFamily": "Inter" },',
        '  "slides": [ ... ]',
        '}',
        "```",
        "",
        "JSON schema:",
        "- title: presentation title (string)",
        '- theme: { backgroundColor, titleColor, textColor, accentColor, fontFamily } — choose a professional, harmonious palette',
        '- slides: array of { layout, elements, icon?, imageKeyword?, notes? }',
        "",
        'Layout types: "title" (cover page), "section" (chapter divider), "content" (title + body), "two-column" (title + two columns)',
        'Element types: { type: "title", text, level?: 1|2 }, { type: "paragraph", text }, { type: "bullets", items: [{ text, level?: 0|1 }] }',
        "",
        "Visual enhancements (REQUIRED — makes slides look professional):",
        '- icon: lucide icon name for slide decoration. MUST use one of these exact names: "rocket", "brain", "bar-chart-3", "lightbulb", "shield", "globe", "zap", "target", "layers", "code", "palette", "users", "trending-up", "heart", "star", "settings", "search", "book-open", "graduation-cap", "briefcase", "database", "cpu", "wifi", "lock", "eye", "message-circle", "calendar", "map-pin", "award", "flag", "compass", "sparkles", "check-circle", "arrow-right", "line-chart", "pie-chart", "monitor", "smartphone", "cloud", "server", "package", "gem", "crown", "trophy".',
        '- imageKeyword: any English keyword — used to generate a decorative gradient background (e.g. "technology"). Add to title and section slides.',
        "",
        "Content rules:",
        "- 5-12 slides per presentation",
        "- Start with a title slide, end with a summary slide",
        "- Keep text concise: max 5-6 bullet points per slide, each under 15 words",
        "- Use professional, cohesive color schemes (consider: dark navy+blue, dark+emerald, warm gray+orange, etc.)",
        "- ALWAYS include icon on EVERY slide — pick an icon matching the slide topic",
        "- Add imageKeyword on title and section slides for richer backgrounds",
        "- After the code block, briefly describe what was generated",
        "</slideshow_generation>",
      ].join("\n");
      systemPrompt = systemPrompt
        ? `${systemPrompt}\n\n${pptxPrompt}`
        : pptxPrompt;
    }

    // In deep mode, auto-inject brainstorming skill instruction so the
    //     model explores design intent before jumping into implementation.
    //     For Claude this triggers the Skill tool; for Codex it guides the
    //     model to read the brainstorming SKILL.md from the lazy-loaded index.
    //     NOTE: Only deep mode triggers this — plain plan mode does NOT.
    {
      const effectivePermMode = currentOptions?.permissionModeOverride ?? usePermissionStore.getState().mode;
      if (effectivePermMode === "deep") {
        const planSkillInstruction = [
          "<plan_mode_skill>",
          "You are in PLAN mode. Before writing any implementation code, you MUST first use the /brainstorming skill to explore the user's intent, requirements, constraints, and design options.",
          "Do NOT skip brainstorming. Do NOT jump directly to writing a plan or code.",
          "The brainstorming process will naturally lead to a design that you can then turn into an implementation plan.",
          "</plan_mode_skill>",
        ].join("\n");
        systemPrompt = systemPrompt
          ? `${systemPrompt}\n\n${planSkillInstruction}`
          : planSkillInstruction;
      }
    }

    // 4. Build API messages BEFORE adding new messages to the store
    const apiMessages = buildApiMessages(store.messages, apiContent);

    const goalModeEnabled = agentType === "codex" && useAppStore.getState().goalModeEnabled;

    const streamContext = buildStreamSendContext({
      reviewForward: metadata?.reviewForward,
      content,
      displayContent,
      images,
      conversationId: convId,
      isNewConversation: isNew,
      agentType,
      modelLabel,
      platformId: resolvedPlatformId,
      commandInvocation,
      sentAsGoal: goalModeEnabled,
    });
    // 5. Add user message to store + persist
    const userMsg = streamContext.userMessage;
    store.addMessage(userMsg);
    if (convId) {
      store.persistMessage(convId, userMsg);
    }

    // 6. Add empty assistant placeholder with SDK-specific role
    const assistantId = streamContext.assistantMessage.id;
    store.addMessage(streamContext.assistantMessage);

    const rid = streamContext.requestContext.requestId;
    upsertStreamRequestContext(registry, streamContext.requestContext);
    setActiveStreamRequest(registry, rid);
    useStreamStateStore.getState().setStreamingMessageId(assistantId);
    useStreamStateStore.getState().setStreamingConversationId(convId);
    useStreamStateStore.getState().setStreaming(true);

    const permissionMode = currentOptions?.permissionModeOverride ?? usePermissionStore.getState().mode;

    // Use workspace path as the working directory for AI tools, falling back to Explorer
    const workspacePath = useWorkspaceStore.getState().activeWorkspace?.path;
    const explorerCwd = workspacePath || useFileTreeStore.getState().rootPath;

    const serviceTier = agentType === "codex" && settingsState.platformModelOptions.codex.fastEnabled
      ? "fast"
      : undefined;
    // Snapshot config at request creation time for warm session registration.
    // This ensures chat-done uses the correct config even if the user switches
    // platform/workspace/permissions mid-stream.
    streamContext.requestContext.warmSessionConfig = {
      model: selectedModel,
      platformId: resolvedPlatformId,
      cwd: workspacePath ?? "",
      reasoningLevel: settingsState.reasoningLevel ?? "off",
      ultracodeEnabled: resolvedPlatformId === "claude" ? settingsState.platformModelOptions.claude.ultracodeEnabled : undefined,
      fastModeEnabled: resolvedPlatformId === "claude" ? settingsState.platformModelOptions.claude.fastEnabled : undefined,
      serviceTier,
      goalModeEnabled,
      apiKey,
      baseUrl,
      authMode,
      profileId: authProfileId,
      permissionMode,
      proxyUrl: agentProxyUrl ?? "",
    };

    // Session ID was resolved concurrently with memory context above (step 2).
    // Session_id is always preserved across config changes (CWD, platform,
    // permission, thinking) — the SDK resumes the JSONL while the new
    // settings are applied by the freshly spawned CLI process.
    const sessionId = _resolvedSessionId;

    // Pending-fork detection: a forked conversation has no session_id of its own
    // yet but carries fork lineage. On its first turn, resume the SOURCE session
    // with forkSession=true so the SDK branches into a fresh JSONL (history
    // truncated at the anchor via resumeSessionAt). Later turns resume the
    // conversation's own session normally (session_id no longer null).
    let effectiveSessionId: string | null = sessionId;
    let forkSessionFlag: boolean | undefined;
    let resumeSessionAtId: string | undefined;
    if (convId && !sessionId) {
      const forkCtx = await convStore.getForkContext(convId);
      if (forkCtx) {
        effectiveSessionId = forkCtx.forkedFromSessionId;
        forkSessionFlag = true;
        resumeSessionAtId = forkCtx.forkedFromMessageId ?? undefined;
      }
    }
    if (convId) {
      // Track CWD for activity heatmap and warm session invalidation.
      // We no longer clear sessionId on CWD change — the next query uses
      // `resume = oldSessionId` so the same JSONL file continues. The new
      // CLI process starts in the new CWD via the `cwd` invoke parameter.
      const currentCwd = explorerCwd ?? "";
      sessionCwdMap.set(convId, currentCwd);

      // Track platform config for warm session invalidation.
      // Session_id is preserved across platform/credential changes — the
      // SDK reads conversation history from the old JSONL (resume) while
      // the new credentials are passed separately in the invoke payload.
      const currentPlatformConfig: SessionPlatformConfig = {
        platformId: resolvedPlatformId,
        apiKey,
        baseUrl,
      };
      sessionPlatformConfigMap.set(convId, currentPlatformConfig);

      // Track permission mode for warm session invalidation.
      // Session_id is preserved — the new permissionMode is passed in the
      // invoke payload and applied by the freshly spawned CLI process.
      sessionPermissionModeMap.set(convId, permissionMode);

      // Track thinking toggle for warm session invalidation.
      // Session_id is preserved — the new thinkingEnabled setting is passed
      // in the invoke payload and applied by the freshly spawned CLI process.
      const currentThinking = useSettingsStore.getState().thinkingEnabled;
      sessionThinkingMap.set(convId, currentThinking);
    }
    const transportArgs = buildProviderTransportArgs(agentType, { baseUrl, apiKey });

    // Include user-configured MCP servers for Claude and Codex agents.
    const mcpState = useMcpStore.getState();
    const isMcpAgent = agentType === "claude" || agentType === "codex";
    const mcpServers =
      isMcpAgent && Object.keys(mcpState.servers).length > 0
        ? { ...mcpState.servers }
        : undefined;

    const settingsSnapshot = useSettingsStore.getState();
    const thinkingEnabled = settingsSnapshot.thinkingEnabled;
    const reasoningLevel = settingsSnapshot.reasoningLevel;
    const ultracodeEnabled = settingsSnapshot.platformModelOptions.claude.ultracodeEnabled;
    const fastModeEnabled = settingsSnapshot.platformModelOptions.claude.fastEnabled;
    // Caveman mode: passed through to sidecar; Claude handler appends caveman
    // ruleset to system prompt when "full". Codex/Gemini are no-ops for now.
    const cavemanMode = settingsSnapshot.cavemanMode;
    // Imagegen quality/size are per-conversation (with global defaults as
    // fallback) so changes in conversation A don't leak into conversation B.
    const imagegenScope = imagegenScopeKey(convId, targetPaneId);
    const imagegenOverride = useImagegenPrefsStore.getState().overrides[imagegenScope];
    const imageGenQuality = imagegenOverride?.quality ?? settingsSnapshot.imageGenQuality;
    const imageGenSize = imagegenOverride?.size ?? settingsSnapshot.imageGenSize;
    const outputsDir = settingsSnapshot.outputsDir;

    const invokePayload = buildStreamInvokePayload({
      requestId: rid,
      agentType,
      messages: apiMessages,
      model: selectedModel,
      baseUrl: transportArgs.baseUrl,
      apiKey: authMode === "oauth" ? undefined : transportArgs.apiKey,
      authMode,
      profileId: authProfileId,
      oauthProvider,
      systemPrompt,
      permissionMode,
      sessionId: effectiveSessionId,
      forkSession: forkSessionFlag,
      resumeSessionAt: resumeSessionAtId,
      images,
      proxyUrl: agentProxyUrl,
      cwd: explorerCwd || undefined,
      mcpServers,
      conversationId: convId,
      disableTools: currentOptions?.disableTools,
      thinkingEnabled,
      reasoningLevel: reasoningLevel !== "off" ? reasoningLevel : undefined,
      ultracode: resolvedPlatformId === "claude" ? ultracodeEnabled : undefined,
      fastMode: resolvedPlatformId === "claude" ? fastModeEnabled : undefined,
      imageGenQuality: agentType === "codex" ? imageGenQuality : undefined,
      imageGenSize: agentType === "codex" ? imageGenSize : undefined,
      outputsDir: outputsDir || undefined,
      serviceTier,
      goalModeEnabled: goalModeEnabled || undefined,
      platform: resolvedPlatformId,
      numCtx: resolvedPlatformId === "ollama" ? useOllamaStore.getState().numCtx : undefined,
      commandInvocation,
      cavemanMode,
    });
    // ── Pre-turn checkpoint — fire-and-forget ──────────────────────
    // Capture the working directory state BEFORE the AI modifies files.
    // This ensures that user's manual edits between turns are preserved
    // when reverting — the post-turn checkpoint's parent will be this
    // pre-turn snapshot instead of the previous turn's final state.
    // Fire-and-forget: local git ops finish well before AI's first file
    // edit arrives over the network. Non-blocking to reduce first-token latency.
    if (convId && workspacePath) {
      invoke("git_checkpoint_create", {
        path: workspacePath,
        label: "Pre-turn snapshot",
        conversationId: convId,
      }).catch(() => { /* non-critical */ });
    }

    if (isCompactCommand) {
      useAgentStatusStore.getState().setCompacting("manual", 0, convId);
    }

    try {
      // 30s timeout protects against Rust-side hangs (deadlock, stuck sidecar spawn).
      // stream_chat only does ensure_running + send_command, so 30s is very generous.
      const INVOKE_TIMEOUT_MS = 30_000;
      let timedOut = false;
      await Promise.race([
        invoke("stream_chat", invokePayload),
        new Promise<never>((_, reject) =>
          setTimeout(() => {
            timedOut = true;
            reject(new Error("stream_chat invoke timed out"));
          }, INVOKE_TIMEOUT_MS),
        ),
      ]).catch((err) => {
        if (timedOut) {
          invoke("abort_chat", { requestId: rid }).catch(() => {});
        }
        throw err;
      });
      // ── Activity heatmap tracking — fire-and-forget ────────────────
      // Never awaited: handleSend's resolution gates the input-box clear in
      // ChatInput, and get_git_file_changes can take seconds on large repos.
      void (async () => {
        try {
          const lastUsage = useAgentStatusStore.getState().lastUsage;
          const tokenUsage =
            (lastUsage?.inputTokens ?? 0) +
            (lastUsage?.outputTokens ?? 0) +
            (lastUsage?.cacheReadTokens ?? 0) +
            (lastUsage?.cacheCreationTokens ?? 0);
          const cwd = sessionCwdMap.get(convId ?? "") ?? "";
          let fileChanges = 0;
          if (cwd) {
            fileChanges = await invoke<number>("get_git_file_changes", { cwd });
          }
          const today = new Date().toISOString().slice(0, 10);
          const activityConvId = convId ?? "";

          const workspaceId = useWorkspaceStore.getState().activeProjectId;

          await invoke("upsert_session_activity", {
            workspaceId,
            date: today,
            conversationId: activityConvId,
            chatCount: 1,
            tokenUsage,
            fileChanges,
          });

        } catch {
          // Best effort — activity tracking should never block chat
        }
      })();
      // ── End activity heatmap tracking ──────────────────────────────
    } catch {
      useAgentStatusStore.getState().clearCompacting(convId, true);
      removeRequestAndSyncStreamState(registry, rid, streamStateWriter, convId);
      store.updateMessageContent(
        assistantId,
        "Failed: The chat request could not be started. Please retry.",
      );
      return false;
    }
    return true;
  }, [registry, streamStateWriter]);

  const handleSend = useCallback(async (
    content: string,
    images?: ReadonlyArray<PastedImage>,
    displayContent?: string,
    modes?: ReadonlyArray<string>,
    metadata?: import("@/lib/live-review-events").ChatMessageMetadata,
  ) => {
    const paneScope = resolveChatPaneScope(optionsRef.current);
    const currentModel = resolvePaneModel({
      paneId: paneScope.paneId ?? undefined,
      conversationId: paneScope.conversationId,
    });
    track("chat", "chat.message_sent", {
      model: currentModel.modelId,
      provider: currentModel.platformId ?? "unconfigured",
    });

    // Guard against double-submit (rapid Enter key, double-click)
    if (sendingRef.current) return false;
    sendingRef.current = true;

    try {
      return await handleSendInner(content, images, displayContent, modes, metadata);
    } finally {
      sendingRef.current = false;
    }
  }, [handleSendInner]);

  // Stop/abort handler
  const handleStop = useCallback(() => {
    const store = useChatStore.getState();
    const paneScope = resolveChatPaneScope(optionsRef.current);
    const conversationId = paneScope.conversationId;
    const target = conversationId
      ? getLatestStreamRequestContextForConversation(registry, conversationId)
      : getActiveStreamRequestContext(registry);
    const rid = target?.requestId ?? null;
    if (rid) {
      invoke("abort_chat", { requestId: rid }).catch(() => {
        console.error("[chat] active request cancellation failed");
      });
    }
    const removed = rid
      ? removeRequestAndSyncStreamState(registry, rid, streamStateWriter, conversationId)
      : undefined;
    const convId = removed?.conversationId;
    if (convId) {
      useAgentStatusStore.getState().clearCompacting(convId, true);
      store.clearSnapshot(convId);
      // Clean up any warm session for this conversation
      clearWarmSession(convId);
    }
    const nextActive = getActiveStreamRequestContext(registry);
    setActiveStreamRequest(registry, nextActive?.requestId ?? null);

    // Defensive: if no request was found in the registry but store still
    // reports streaming, force-reset the streaming state so the UI unblocks.
    if (!rid && useStreamStateStore.getState().isStreaming) {
      useStreamStateStore.getState().setStreaming(false);
    }
  }, [registry, streamStateWriter]);

  // Mid-stream message handler — queues a user message into an active Claude
  // conversation via the sidecar's PromptChannel. The message is displayed in
  // the chat immediately, but the stream state is NOT modified. The sidecar
  // emits a `new_turn` event when it's ready to process the queued message,
  // at which point the frontend creates a new assistant placeholder.
  const handleSendMidStream = useCallback(async (
    content: string,
    images?: ReadonlyArray<PastedImage>,
    displayContent?: string,
    _modes?: ReadonlyArray<string>,
    metadata?: import("@/lib/live-review-events").ChatMessageMetadata,
  ) => {
    const store = useChatStore.getState();
    const paneScope = resolveChatPaneScope(optionsRef.current);
    const conversationId = paneScope.conversationId;

    // Find the active request for this conversation
    const target = conversationId
      ? getLatestStreamRequestContextForConversation(registry, conversationId)
      : getActiveStreamRequestContext(registry);

    if (!target) {
      console.warn("[chat] mid-stream message ignored because no active request exists");
      return false;
    }

    const rid = target.requestId;
    const midStreamProxyUrl = target.warmSessionConfig?.proxyUrl || undefined;

    // Mirror the cold/warm-start dispatcher so mid-stream slash commands
    // (e.g. /compact) carry the same `commandInvocation` metadata downstream.
    // Reuses target.platformId so the active conversation's command palette
    // is consulted, not whatever platform happens to be active globally.
    const midStreamPlatform: BuiltinSlashCommandPlatform | null =
      target.sdk === "claude" || target.sdk === "codex" ? target.sdk : null;
    const midStreamSdkCommands = mergeSlashCommands(
      getBuiltinSlashCommands(midStreamPlatform),
      useToolStateStore
        .getState()
        .getSlashCommandsForPlatform(midStreamPlatform),
    );
    const midStreamDispatch = dispatchSlashCommand(content, midStreamSdkCommands);

    // Client-side commands work mid-stream too — answer locally without
    // touching the in-flight turn (see the cold-path handler for details).
    if (midStreamDispatch.kind === "client") {
      const clientUserMsg = {
        id: crypto.randomUUID(),
        role: "user" as const,
        content,
        timestamp: Date.now(),
        midStream: true,
        commandInvocation: {
          canonicalName: midStreamDispatch.commandName,
          typedName: midStreamDispatch.commandName,
          args: midStreamDispatch.args,
          description: getClientSlashCommands().find((c) => c.name === midStreamDispatch.commandName)?.description ?? "",
        },
      };
      store.addMessage(clientUserMsg);
      if (conversationId) store.persistMessage(conversationId, clientUserMsg);
      const body = await executeClientSlashCommand(midStreamDispatch.handler, {
        platformId: target.platformId ?? useSettingsStore.getState().activePlatformId,
        modelId: target.modelLabel ?? "",
        modelLabel: target.modelLabel ?? "",
        conversationId: conversationId ?? null,
        cwd: useWorkspaceStore.getState().activeWorkspace?.path ?? "",
        permissionMode: usePermissionStore.getState().mode,
        commands: mergeSlashCommands(midStreamSdkCommands, getClientSlashCommands()),
      });
      const clientResultMsg = {
        id: crypto.randomUUID(),
        role: "system" as const,
        content: body,
        timestamp: Date.now(),
      };
      store.addMessage(clientResultMsg);
      if (conversationId) store.persistMessage(conversationId, clientResultMsg);
      return true;
    }

    const midStreamCommandInvocation = midStreamDispatch.kind === "sdk"
      ? {
          canonicalName: midStreamDispatch.canonicalName,
          typedName: midStreamDispatch.typedName,
          argumentHint: midStreamDispatch.info.argumentHint,
          args: midStreamDispatch.args,
          description: midStreamDispatch.info.description,
        }
      : undefined;
    const isCompactCommand = midStreamCommandInvocation?.canonicalName === "compact";

    // Add the user's mid-stream message to the chat store (visible immediately)
    store.addMessage({
      id: crypto.randomUUID(),
      role: "user",
      content,
      displayContent: displayContent || undefined,
      timestamp: Date.now(),
      midStream: true,
      ...(images && images.length > 0
        ? { media: images.map((i) => ({ mediaType: i.mediaType, data: i.base64 })) }
        : {}),
      ...(midStreamCommandInvocation ? { commandInvocation: midStreamCommandInvocation } : {}),
      ...(metadata?.reviewForward ? { reviewForward: metadata.reviewForward } : {}),
    });

    // Send the message to the sidecar's PromptChannel queue.
    // The sidecar will yield it to the SDK after the current turn completes.
    const imagePayload = images?.map((i) => ({
      media_type: i.mediaType,
      data: i.base64,
    }));
    try {
      const midStreamReasoningLevel = useSettingsStore.getState().reasoningLevel;
      if (isCompactCommand) {
        useAgentStatusStore.getState().setCompacting("manual", 0, conversationId, true);
      }
      await invoke("send_user_input", {
        requestId: rid,
        content,
        images: imagePayload?.length ? imagePayload : undefined,
        reasoningLevel: midStreamReasoningLevel !== "off" ? midStreamReasoningLevel : undefined,
        commandInvocation: midStreamCommandInvocation,
        proxyUrl: midStreamProxyUrl,
      });
      return true;
    } catch {
      if (isCompactCommand) {
        useAgentStatusStore.getState().clearCompacting(conversationId, true);
      }
      console.error("[chat] mid-stream message delivery failed");
      return false;
    }
  }, [registry]);

  return { handleSend, handleStop, handleSendMidStream };
}
