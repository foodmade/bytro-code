import React, { useRef, useCallback, useEffect, useLayoutEffect } from "react";
import { useTranslation } from "react-i18next";
import { invoke } from "@tauri-apps/api/core";
import { MessageCircle, Sparkles } from "lucide-react";
import { ChatMessage, TimeDivider } from "../chat/chat-message";
import { AgentStatusPanel } from "../chat/agent-status-panel";
import { ChatInput } from "../chat/chat-input";
import { ToolConfirmDialog } from "../chat/tool-confirm-dialog";
import { AskUserQuestionDialog } from "../chat/ask-user-question-dialog";
import { useChatStore, useConversationStore, useStreamStateStore, useIdeaStore } from "@/stores";
import type { Idea } from "@/stores";
import type { PastedImage } from "../chat/image-preview";
import { useAutoScroll, useChatStreaming } from "@/hooks";

// ---------------------------------------------------------------------------
// System prompt & initial message builders (extracted from old discussion-panel)
// ---------------------------------------------------------------------------

export function buildIdeaSystemPrompt(idea: Idea): string {
  return `# Discussion Mode — Brainstorming & Requirements Research

You are operating in **Discussion Mode**, a dedicated space for idea exploration, brainstorming, and collaborative thinking. You are NOT in a coding session. Your purpose here is to be a thought partner — helping the user think deeply, challenge assumptions, and arrive at a well-considered plan.

## !! CRITICAL RESTRICTIONS — READ CAREFULLY !!

1. **THIS IS A READ-ONLY SESSION.** You must NEVER write, edit, create, or delete any files.
2. **NEVER use these tools:** Write, Edit, Bash, NotebookEdit, EnterPlanMode, ExitPlanMode. These are strictly forbidden in Discussion Mode.
3. **You MAY use read-only tools** (Read, Glob, Grep, WebSearch, WebFetch) to research the codebase and ground your analysis in facts. Reading code is encouraged; modifying it is forbidden.
4. **Do NOT generate implementation code.** You may include brief pseudo-code or code snippets within your analysis text to illustrate architectural concepts, but never produce full implementation files.

## Current Idea

**Title:** ${idea.title}
${idea.raw_input ? `**Description:** ${idea.raw_input}` : ""}

## Your Role

You are an expert software architect and product strategist. Your job is to:

1. **Deep Requirements Discovery** — Ask targeted, specific questions (2-3 per turn max) to uncover hidden requirements, edge cases, user expectations, and implicit constraints the user hasn't considered yet.
2. **Creative Brainstorming** — Propose alternative approaches, suggest improvements, and constructively challenge assumptions. Think beyond the obvious.
3. **Technical Feasibility Analysis** — Evaluate architecture options, identify technical risks, estimate complexity, and suggest proven patterns. Actively read project files to provide grounded, accurate analysis rather than generic advice.
4. **Trade-off Analysis** — When multiple approaches exist, lay out the pros/cons of each clearly. Use AskUserQuestion to present structured choices when decisions have multiple viable options.
5. **Progressive Refinement** — Build on previous turns. Summarize what has been agreed, track open questions, and guide the conversation toward a clear, actionable specification.
6. **Structured Implementation Planning** — When requirements are sufficiently clear, proactively produce a structured plan document including: context, core changes, affected file paths, step-by-step implementation approach, and verification strategy.

## Response Guidelines

- **Be thorough and substantive.** Prefer detailed, well-organized responses with headings, bullet points, and clear reasoning. Short, shallow answers are not helpful in brainstorming.
- **End each response with 1-3 follow-up questions** to drive the discussion forward and uncover areas not yet explored.
- **Respond in the same language as the user's input.** Match the user's language (Chinese, English, etc.) consistently.
- **Ground your analysis in the actual codebase.** Read relevant files to understand existing patterns, dependencies, and constraints before making recommendations.
- **Be opinionated but flexible.** Share your professional judgment on the best approach, but remain open to the user's preferences and constraints.`;
}

export function buildInitialUserMessage(idea: Idea): string {
  const parts: string[] = [];

  parts.push(idea.title);

  if (idea.raw_input) {
    parts.push(`\n${idea.raw_input}`);
  }

  return parts.join("");
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const TIME_DIVIDER_GAP_MS = 5 * 60 * 1000;
const SCROLL_TOP_THRESHOLD = 80;

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

interface IdeaChatPanelProps {
  readonly idea: Idea;
  readonly autoSendPrompt?: string;
}

export function IdeaChatPanel({ idea, autoSendPrompt }: IdeaChatPanelProps) {
  const messages = useChatStore((s) => s.messages);
  const isStreaming = useStreamStateStore((s) => s.isStreaming);
  const streamingMessageId = useStreamStateStore((s) => s.streamingMessageId);
  const hasMoreMessages = useChatStore((s) => s.hasMoreMessages);
  const isLoadingOlder = useChatStore((s) => s.isLoadingOlder);
  const loadOlderMessages = useChatStore((s) => s.loadOlderMessages);
  const activeConversationId = useConversationStore((s) => s.activeConversationId);

  const linkDiscussion = useIdeaStore((s) => s.linkDiscussion);
  const updateIdeaStatus = useIdeaStore((s) => s.updateIdeaStatus);

  const { scrollRef, setScrollRef } = useAutoScroll(messages, isLoadingOlder);

  // Build the system prompt from the idea context
  const systemPrompt = buildIdeaSystemPrompt(idea);
  const { handleSend, handleStop } = useChatStreaming({
    systemPromptPrefix: systemPrompt,
    permissionModeOverride: "acceptEdits",
  });

  // Scroll position restoration for prepending older messages
  const prevMessageCountRef = useRef(messages.length);
  const prevScrollHeightRef = useRef(0);

  // Track the previous conversation to restore on unmount
  const prevConvIdRef = useRef<string | null>(null);
  const mountedRef = useRef(false);
  const autoSendFiredRef = useRef(false);

  // ---------------------------------------------------------------------------
  // Conversation lifecycle: mount/unmount
  // ---------------------------------------------------------------------------
  useEffect(() => {
    mountedRef.current = true;
    autoSendFiredRef.current = false;
    const chatStore = useChatStore.getState();
    const convStore = useConversationStore.getState();

    // Save current conversation state before switching
    const prevId = convStore.activeConversationId;
    prevConvIdRef.current = prevId;
    if (prevId) {
      chatStore.saveSnapshot(prevId);
    }

    const init = async () => {
      let discussionConvId = idea.discussion_conversation_id;

      // Create a new conversation if the idea doesn't have one yet
      if (!discussionConvId) {
        try {
          const conv = await convStore.createConversation(
            "claude",
            idea.workspace_id ?? undefined,
          );
          discussionConvId = conv.id;

          await invoke("rename_conversation", {
            conversationId: conv.id,
            title: `Idea Discussion: ${idea.title}`,
          });

          await linkDiscussion(idea.id, conv.id);

          if (idea.status === "draft") {
            await updateIdeaStatus(idea.id, "discussing");
          }
        } catch (err) {
          console.error("Failed to create discussion conversation:", err);
          return;
        }
      }

      if (!mountedRef.current) return;

      // Switch to the discussion conversation
      convStore.setActiveConversationId(discussionConvId);
      await chatStore.loadMessages(discussionConvId);

      // Auto-send the initial prompt AFTER the conversation is fully ready
      if (autoSendPrompt && !autoSendFiredRef.current && mountedRef.current) {
        autoSendFiredRef.current = true;

        // Load idea reference images to send with the initial message
        let ideaImages: PastedImage[] | undefined;
        if (idea.images_json) {
          try {
            const filenames: string[] = JSON.parse(idea.images_json);
            const loaded: PastedImage[] = [];
            for (const filename of filenames) {
              try {
                const dataUrl = await invoke<string>("read_idea_image_base64", { filename });
                // dataUrl format: "data:image/png;base64,..."
                const match = dataUrl.match(/^data:(image\/\w+);base64,(.+)$/);
                if (match) {
                  loaded.push({
                    id: filename,
                    base64: match[2],
                    mediaType: match[1],
                    preview: dataUrl,
                  });
                }
              } catch {
                // skip failed images
              }
            }
            if (loaded.length > 0) ideaImages = loaded;
          } catch {
            // invalid images_json
          }
        }

        // Increased delay to let the conversation store fully settle
        // and event listeners register before sending the first message
        setTimeout(() => {
          if (mountedRef.current) {
            const currentConvId = useConversationStore.getState().activeConversationId;
            if (currentConvId) {
              handleSend(autoSendPrompt, ideaImages);
            }
          }
        }, 300);
      }
    };

    init();

    return () => {
      mountedRef.current = false;

      const cs = useChatStore.getState();
      const cv = useConversationStore.getState();

      // Save the idea conversation's state
      const currentConvId = cv.activeConversationId;
      if (currentConvId) {
        cs.saveSnapshot(currentConvId);
      }

      // Restore previous conversation
      const prev = prevConvIdRef.current;
      cv.setActiveConversationId(prev);
      if (prev) {
        cs.loadMessages(prev);
      } else {
        cs.clearMessages();
      }
    };
  }, [idea.id]); // eslint-disable-line react-hooks/exhaustive-deps

  // ---------------------------------------------------------------------------
  // Scroll position restoration for older messages
  // ---------------------------------------------------------------------------
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;

    const newCount = messages.length;
    const prevCount = prevMessageCountRef.current;

    if (newCount > prevCount && prevScrollHeightRef.current > 0) {
      const heightDelta = el.scrollHeight - prevScrollHeightRef.current;
      if (heightDelta > 0) {
        el.scrollTop += heightDelta;
      }
      prevScrollHeightRef.current = 0;
    }

    prevMessageCountRef.current = newCount;
  }, [messages, scrollRef]);

  // ---------------------------------------------------------------------------
  // Scroll-to-top: load older messages
  // ---------------------------------------------------------------------------
  const handleScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el || !hasMoreMessages || isLoadingOlder || !activeConversationId) return;

    if (el.scrollTop < SCROLL_TOP_THRESHOLD) {
      prevScrollHeightRef.current = el.scrollHeight;
      loadOlderMessages(activeConversationId);
    }
  }, [scrollRef, hasMoreMessages, isLoadingOlder, activeConversationId, loadOlderMessages]);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;

    el.addEventListener("scroll", handleScroll);
    return () => el.removeEventListener("scroll", handleScroll);
  }, [scrollRef, handleScroll]);

  // ---------------------------------------------------------------------------
  // Render messages
  // ---------------------------------------------------------------------------
  const renderMessages = () => {
    const elements: React.ReactNode[] = [];

    if (isLoadingOlder) {
      elements.push(
        <div key="loading-older" className="flex items-center justify-center py-3">
          <div className="w-4 h-4 border-2 border-border-strong border-t-transparent rounded-full animate-spin" />
          <span className="ml-2 text-[12px] text-muted">Loading...</span>
        </div>,
      );
    } else if (hasMoreMessages) {
      elements.push(
        <div key="has-more" className="flex items-center justify-center py-2">
          <span className="text-[11px] text-muted">Scroll up to load more</span>
        </div>,
      );
    }

    let lastTimestamp = 0;

    for (const msg of messages) {
      if (lastTimestamp > 0 && msg.timestamp - lastTimestamp > TIME_DIVIDER_GAP_MS) {
        elements.push(
          <TimeDivider key={`div-${msg.timestamp}`} timestamp={msg.timestamp} />,
        );
      }

      const isMsgStreaming = isStreaming && msg.id === streamingMessageId;

      // In discussion mode, tool UI is hidden — skip empty streaming messages
      // regardless of tool call state so shimmer loading shows instead
      if (isMsgStreaming && msg.content === "") {
        lastTimestamp = msg.timestamp;
        continue;
      }

      elements.push(
        <ChatMessage
          key={msg.id}
          role={msg.role}
          content={msg.content}
          modelTag={msg.agent}
          timestamp={msg.timestamp}
          isStreaming={isMsgStreaming}
          media={msg.media}
        />,
      );

      lastTimestamp = msg.timestamp;
    }

    if (isStreaming && streamingMessageId) {
      const streamingMsg = messages.find((m) => m.id === streamingMessageId);
      if (streamingMsg && streamingMsg.content === "") {
        elements.push(
          <DiscussionLoading key={`loading-${streamingMsg.role}`} />,
        );
      }
    }

    return elements;
  };

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------
  return (
    <div className="flex flex-col flex-1 min-w-0 overflow-hidden" style={{ backgroundColor: "var(--color-background)" }}>
      {/* Discussion header */}
      <div
        className="flex items-center shrink-0"
        style={{
          height: 44,
          padding: "0 24px",
          gap: 10,
          borderBottom: "1px solid var(--color-border)",
        }}
      >
        <MessageCircle size={16} style={{ color: "var(--color-accent-purple)" }} />
        <span
          style={{
            fontSize: 13,
            fontWeight: 600,
            color: "var(--color-foreground)",
            fontFamily: "Inter, sans-serif",
          }}
        >
          Discussion
        </span>
        <span style={{ fontSize: 13, color: "var(--color-muted)" }}>&middot;</span>
        <span
          style={{
            fontSize: 12,
            color: "var(--color-muted-foreground)",
            fontFamily: "Inter, sans-serif",
          }}
        >
          {messages.length} messages
        </span>
      </div>

      {/* Chat messages area + floating status panel */}
      <div className="flex-1 relative overflow-hidden min-w-0">
        <AgentStatusPanel />

        <div
          ref={setScrollRef}
          className="h-full w-full overflow-y-auto overflow-x-hidden"
          style={{ padding: "20px 24px 120px" }}
        >
          {messages.length > 0 ? (
            <div className="chat-messages-column">
              {renderMessages()}
            </div>
          ) : (
            <div className="flex flex-col items-center justify-center h-full min-h-[200px]" style={{ gap: 8 }}>
              <MessageCircle size={32} style={{ color: "var(--color-border-strong)" }} />
              <p style={{ fontSize: 13, color: "var(--color-muted-foreground)", margin: 0 }}>
                Start a discussion about this idea
              </p>
              <p style={{ fontSize: 11, color: "var(--color-muted)", margin: 0 }}>
                AI will help you refine and develop your thoughts
              </p>
            </div>
          )}
        </div>
      </div>

      {/* Input area — dialogs inside wrapper so they slide out from input, matching normal chat */}
      <div className="floating-input-container" style={{ padding: "8px 24px 16px 24px" }}>
        <div className="floating-input-wrapper">
          <ToolConfirmDialog />
          <AskUserQuestionDialog />
          <ChatInput
            onSend={handleSend}
            onStop={handleStop}
            isStreaming={isStreaming}
          />
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Discussion-mode loading indicator with shimmer wave animation
// ---------------------------------------------------------------------------

const SHIMMER_TEXTS = [
  "ideaHub.discussion.analyzing",
  "ideaHub.discussion.brainstorming",
  "ideaHub.discussion.thinking",
];

function DiscussionLoading() {
  const { t } = useTranslation();
  // Cycle through shimmer texts every 3s
  const textIdx = useRef(0);
  const [text, setText] = React.useState(SHIMMER_TEXTS[0]);

  React.useEffect(() => {
    const interval = setInterval(() => {
      textIdx.current = (textIdx.current + 1) % SHIMMER_TEXTS.length;
      setText(SHIMMER_TEXTS[textIdx.current]);
    }, 3000);
    return () => clearInterval(interval);
  }, []);

  return (
    <div className="flex gap-3 animate-fade-in" style={{ padding: "4px 0" }}>
      {/* Avatar */}
      <div
        className="flex items-center justify-center w-8 h-8 rounded-full shrink-0"
        style={{ backgroundColor: "color-mix(in srgb, var(--color-accent-purple) 10%, transparent)" }}
      >
        <Sparkles size={14} style={{ color: "var(--color-accent-purple)" }} />
      </div>

      {/* Shimmer text bubble */}
      <div
        style={{
          backgroundColor: "var(--color-card)",
          borderRadius: "4px 16px 16px 16px",
          padding: "14px 20px",
          position: "relative",
          overflow: "hidden",
        }}
      >
        <span
          className="discussion-shimmer-text"
          style={{
            fontSize: 13,
            fontWeight: 500,
            color: "var(--color-muted-foreground)",
            fontFamily: "Inter, sans-serif",
            position: "relative",
            zIndex: 1,
          }}
        >
          {t(text)}
        </span>

        {/* Shimmer wave overlay */}
        <div
          className="discussion-shimmer-wave"
          style={{
            position: "absolute",
            top: 0,
            left: 0,
            right: 0,
            bottom: 0,
            pointerEvents: "none",
          }}
        />
      </div>
    </div>
  );
}
