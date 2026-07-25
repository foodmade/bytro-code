import { useCallback } from "react";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { useHealthCheckStore } from "@/stores/health-check-store";
import { useAppStore, useSettingsStore, useWorkspaceStore, useConversationStore, useChatStore, useStreamStateStore, useAgentStatusStore, useSplitViewStore } from "@/stores";
import { encodeConversationModel, resolveActiveCredentials } from "@/lib/platform-config";
import type { EnrichedIssue } from "@/stores/health-check-store";
import type { DonePayload, ErrorPayload } from "@/lib/stream-handlers/types";

export function useHealthFix() {
  const setPendingQuickAction = useAppStore((s) => s.setPendingQuickAction);
  const setActiveView = useAppStore((s) => s.setActiveView);
  const setIssueFixStatus = useHealthCheckStore((s) => s.setIssueFixStatus);
  const setBatchFixStatus = useHealthCheckStore((s) => s.setBatchFixStatus);
  const clearSelection = useHealthCheckStore((s) => s.clearSelection);
  const linkFixConversation = useHealthCheckStore((s) => s.linkFixConversation);

  const fixSingleIssue = useCallback(
    async (issue: EnrichedIssue) => {
      // 0. Save current conversation state before switching (quick-actions pattern)
      const chatState = useChatStore.getState();
      const currentConvId = useConversationStore.getState().activeConversationId;
      if (currentConvId) {
        useAgentStatusStore.getState().cacheAgentStatus(currentConvId);
        if (useStreamStateStore.getState().isStreaming || chatState.messages.length > 0) {
          chatState.saveSnapshot(currentConvId);
        }
      }
      useConversationStore.getState().setActiveConversationId(null);
      chatState.clearMessages();

      // 1. Create conversation explicitly (idea-hub pattern)
      const settingsState = useSettingsStore.getState();
      const workspaceId = useWorkspaceStore.getState().activeWorkspaceId ?? undefined;
      const platformId = settingsState.activePlatformId;
      const platformConfig = settingsState.platforms[platformId];
      const creds = resolveActiveCredentials(platformConfig);
      const model = encodeConversationModel(platformId, creds?.model ?? platformConfig.activeModelId);

      let conv;
      try {
        conv = await useConversationStore.getState().createConversation(model, workspaceId, "health-check");
      } catch (err) {
        console.error("[health-fix] Failed to create conversation:", err);
        return;
      }

      // 2. Link issue → conversation
      linkFixConversation(issue.id, conv.id);

      // 3. Set status to "fixing"
      setIssueFixStatus(issue.id, "fixing");

      // 4. Build prompt and display text
      const prompt = buildFixPrompt(issue);
      const display = buildFixDisplayText(issue);

      // 5. Register completion watcher BEFORE navigation
      setupFixCompletionWatcher([issue.id], conv.id);

      // 6. Bind the new conversation to the active split pane BEFORE navigating.
      // Without this, SplitChatWorkspace's first render uses the persisted
      // pane.conversationId (the previous conversation), and ChatPanel ends up
      // reading messages from that stale snapshot. The resulting non-empty
      // messages render the input variant that lacks `autoSendPrompt`, and the
      // subsequent `syncActiveConversation` re-render trips chat-panel.tsx's
      // `consumedConvIdRef` block to re-read `pendingQuickAction` (now null,
      // because the prior render's effect already cleared it) — wiping the
      // stored prompt and cancelling ChatInput's pending auto-send timer.
      useSplitViewStore.getState().syncActiveConversation(conv.id);

      // 7. Navigate to chat with prompt.
      // Bind to conv.id so a later "new session" can't re-trigger this prompt
      // (ChatPanel only consumes when its conversationId matches).
      setPendingQuickAction({ display, prompt, conversationId: conv.id });
      setActiveView("chat");
    },
    [setIssueFixStatus, linkFixConversation, setPendingQuickAction, setActiveView],
  );

  const fixBatchIssues = useCallback(
    async (issues: ReadonlyArray<EnrichedIssue>) => {
      if (issues.length === 0) return;

      // Save current conversation state before switching (quick-actions pattern)
      const chatState = useChatStore.getState();
      const currentConvId = useConversationStore.getState().activeConversationId;
      if (currentConvId) {
        useAgentStatusStore.getState().cacheAgentStatus(currentConvId);
        if (useStreamStateStore.getState().isStreaming || chatState.messages.length > 0) {
          chatState.saveSnapshot(currentConvId);
        }
      }
      useConversationStore.getState().setActiveConversationId(null);
      chatState.clearMessages();

      const settingsState = useSettingsStore.getState();
      const workspaceId = useWorkspaceStore.getState().activeWorkspaceId ?? undefined;
      const platformId = settingsState.activePlatformId;
      const platformConfig = settingsState.platforms[platformId];
      const creds = resolveActiveCredentials(platformConfig);
      const model = encodeConversationModel(platformId, creds?.model ?? platformConfig.activeModelId);

      let conv;
      try {
        conv = await useConversationStore.getState().createConversation(model, workspaceId, "health-check");
      } catch (err) {
        console.error("[health-fix] Failed to create conversation:", err);
        return;
      }

      const ids = issues.map((i) => i.id);
      for (const id of ids) {
        linkFixConversation(id, conv.id);
      }

      setBatchFixStatus(ids, "fixing");
      clearSelection();

      const prompt = buildBatchFixPrompt(issues);
      const criticalCount = issues.filter((i) => i.severity === "critical").length;
      const display = criticalCount > 0
        ? `批量修复 ${issues.length} 个问题（${criticalCount} 个严重）`
        : `批量修复 ${issues.length} 个问题`;

      setupFixCompletionWatcher(ids, conv.id);

      // Bind the new conversation to the active split pane before navigating
      // to avoid the stale-snapshot race condition (see fixSingleIssue above).
      useSplitViewStore.getState().syncActiveConversation(conv.id);

      // Bind to conv.id so a later "new session" can't re-trigger this prompt.
      setPendingQuickAction({ display, prompt, conversationId: conv.id });
      setActiveView("chat");
    },
    [setBatchFixStatus, clearSelection, linkFixConversation, setPendingQuickAction, setActiveView],
  );

  const ignoreIssue = useCallback(
    (issueId: string) => {
      setIssueFixStatus(issueId, "ignored");
    },
    [setIssueFixStatus],
  );

  const restoreIssue = useCallback(
    (issueId: string) => {
      setIssueFixStatus(issueId, "pending");
    },
    [setIssueFixStatus],
  );

  const ignoreBatch = useCallback(
    (ids: ReadonlyArray<string>) => {
      setBatchFixStatus(ids, "ignored");
      clearSelection();
    },
    [setBatchFixStatus, clearSelection],
  );

  return { fixSingleIssue, fixBatchIssues, ignoreIssue, restoreIssue, ignoreBatch };
}

/* ── Fix completion watcher ─────────────────────────────────────────────────
 * Listens for Tauri chat-done / chat-error events to auto-transition
 * issue fix status. Self-cleaning: listeners are removed after the first
 * matching event or after a 10-minute timeout.
 * ────────────────────────────────────────────────────────────────────────── */

function setupFixCompletionWatcher(
  issueIds: ReadonlyArray<string>,
  conversationId: string,
): void {
  let unlistenDone: UnlistenFn | null = null;
  let unlistenError: UnlistenFn | null = null;
  let cleaned = false;

  const cleanup = () => {
    if (cleaned) return;
    cleaned = true;
    unlistenDone?.();
    unlistenError?.();
    clearTimeout(timeoutId);
  };

  const handleCompletion = (success: boolean) => {
    cleanup();
    const store = useHealthCheckStore.getState();
    for (const issueId of issueIds) {
      if (store.issueFixStatuses[issueId] === "fixing") {
        store.setIssueFixStatus(issueId, success ? "fixed" : "pending");
      }
      store.clearFixConversation(issueId);
    }
  };

  // Safety timeout: 10 minutes
  const timeoutId = setTimeout(() => {
    console.warn("[health-fix] Fix watcher timed out for conversation:", conversationId);
    handleCompletion(false);
  }, 10 * 60 * 1000);

  // Listen for chat-done (DonePayload carries conversation_id for Claude sessions)
  listen<DonePayload>("chat-done", (e) => {
    if (e.payload.conversation_id === conversationId) {
      handleCompletion(true);
      return;
    }
    // Fallback for non-Claude providers that don't emit conversation_id
    const activeConvId = useConversationStore.getState().activeConversationId;
    if (activeConvId === conversationId && !e.payload.conversation_id) {
      handleCompletion(true);
    }
  }).then((fn) => { unlistenDone = fn; });

  // Listen for chat-error (ErrorPayload has no conversation_id)
  listen<ErrorPayload>("chat-error", () => {
    const activeConvId = useConversationStore.getState().activeConversationId;
    if (activeConvId === conversationId) {
      handleCompletion(false);
    }
  }).then((fn) => { unlistenError = fn; });
}

/* ── Display text for chat UI ──────────────────────────────────────────── */

function buildFixDisplayText(issue: EnrichedIssue): string {
  const severityLabel =
    issue.severity === "critical" ? "严重" :
    issue.severity === "warning" ? "警告" : "建议";

  const parts = [`[${severityLabel}] ${issue.dimensionLabel}: ${issue.message.slice(0, 80)}`];
  if (issue.file) {
    parts.push(`文件: ${issue.file}`);
  } else if (issue.files && issue.files.length > 0) {
    parts.push(`涉及 ${issue.files.length} 个文件`);
  }
  if (issue.suggestion) {
    parts.push(`建议: ${issue.suggestion.slice(0, 60)}`);
  }
  return parts.join("\n");
}

/* ── Prompt builders ───────────────────────────────────────────────────── */

function buildFixPrompt(issue: EnrichedIssue): string {
  const parts: string[] = [
    `请修复以下项目体检发现的问题：`,
    ``,
    `**维度**: ${issue.dimensionLabel}`,
    `**严重程度**: ${issue.severity}`,
    `**问题描述**: ${issue.message}`,
  ];

  if (issue.file) {
    parts.push(`**主要文件**: ${issue.file}`);
  }

  // Issue-level code snippet (overview)
  if (issue.codeSnippet) {
    parts.push(``);
    parts.push(`**问题代码概览**:`);
    parts.push("```");
    parts.push(issue.codeSnippet);
    parts.push("```");
    if (issue.lineStart != null) {
      parts.push(`(起始行: ${issue.lineStart})`);
    }
  }

  // Per-file code snippets (detailed context)
  if (issue.files && issue.files.length > 0) {
    parts.push(``);
    parts.push(`**涉及文件详情**:`);
    for (const f of issue.files) {
      const lineInfo = f.line != null ? `:${f.line}` : "";
      parts.push(``);
      parts.push(`### ${f.path}${lineInfo}`);
      if (f.codeSnippet) {
        const lineStartInfo = f.lineStart != null ? ` (起始行: ${f.lineStart})` : "";
        parts.push("```");
        parts.push(f.codeSnippet);
        parts.push("```");
        if (lineStartInfo) parts.push(lineStartInfo);
        if (f.highlightLines && f.highlightLines.length > 0) {
          const hlLineNums = f.highlightLines.map((hl) =>
            f.lineStart != null ? f.lineStart + hl - 1 : hl,
          );
          parts.push(`关键行: ${hlLineNums.join(", ")}`);
        }
      }
    }
  }

  if (issue.suggestion) {
    parts.push(``);
    parts.push(`**修复建议**: ${issue.suggestion}`);
  }

  parts.push(``);
  parts.push(`请分析问题根因并提供修复方案。如果可以直接修改代码，请直接修复。`);

  return parts.join("\n");
}

function buildBatchFixPrompt(issues: ReadonlyArray<EnrichedIssue>): string {
  const parts: string[] = [
    `请修复以下项目体检发现的 ${issues.length} 个问题：`,
    ``,
  ];

  for (let i = 0; i < issues.length; i++) {
    const issue = issues[i];
    parts.push(`### 问题 ${i + 1}: ${issue.message}`);
    parts.push(`- 维度: ${issue.dimensionLabel}`);
    parts.push(`- 严重程度: ${issue.severity}`);
    if (issue.file) parts.push(`- 文件: ${issue.file}`);

    // Per-file details with code snippets
    if (issue.files && issue.files.length > 0) {
      parts.push(`- 涉及文件:`);
      for (const f of issue.files) {
        const lineInfo = f.line != null ? `:${f.line}` : "";
        parts.push(`  - \`${f.path}${lineInfo}\``);
        if (f.codeSnippet) {
          parts.push("  ```");
          for (const line of f.codeSnippet.split("\n")) {
            parts.push(`  ${line}`);
          }
          parts.push("  ```");
        }
      }
    }

    if (issue.codeSnippet) {
      parts.push(`- 代码片段:`);
      parts.push("  ```");
      for (const line of issue.codeSnippet.split("\n")) {
        parts.push(`  ${line}`);
      }
      parts.push("  ```");
    }

    if (issue.suggestion) parts.push(`- 建议: ${issue.suggestion}`);
    parts.push(``);
  }

  parts.push(`请逐一分析并修复这些问题。优先处理严重问题。`);

  return parts.join("\n");
}
