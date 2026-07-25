import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ShieldAlert,
  X,
  Minus,
  ClipboardCheck,
  FileText,
  Check,
  Terminal,
  FilePlus2,
  FileX2,
  PencilLine,
} from "lucide-react";
import { invoke } from "@tauri-apps/api/core";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import { useChatStore } from "@/stores/chat-store";
import type { ChatMessage } from "@/stores/chat-store";
import { getFileIcon } from "@/components/file-tree/file-icons";
import { PlanDetailModal } from "./plan-detail-modal";
import {
  findPendingConfirmation,
  getFileConfirmationPreview,
  type FileConfirmationPreview,
} from "./tool-confirmation-utils";

// ---------------------------------------------------------------------------
// Extract the plan file path from the message history.
// Strategy: search backwards for the most recent Write/Edit tool call
// targeting a .claude/plans/ path and return the file path.
// The actual content will be read from disk at display time.
// ---------------------------------------------------------------------------

function findPlanFilePath(messages: ReadonlyArray<ChatMessage>): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (!msg.toolCalls) continue;
    for (const tc of msg.toolCalls) {
      if (tc.toolName !== "Write" && tc.toolName !== "write_file"
        && tc.toolName !== "Edit") continue;
      if (tc.status === "error" || tc.status === "denied") continue;
      try {
        const input = JSON.parse(tc.toolInput) as Record<string, unknown>;
        const filePath = ((input.file_path ?? input.path ?? "") as string);
        const normalized = filePath.replace(/\\/g, "/");
        if (normalized.includes(".claude/plans/")) {
          return filePath;
        }
      } catch { /* skip parse errors */ }
    }
  }
  return "";
}

// ---------------------------------------------------------------------------
// Human-readable description for a tool call.
// ---------------------------------------------------------------------------

function describeToolAction(
  toolName: string,
  toolInput: string,
  t: TFunction,
): {
  readonly title: string;
  readonly description: string;
} {
  try {
    const input = JSON.parse(toolInput) as Record<string, unknown>;
    switch (toolName) {
      case "Bash":
      case "execute_command":
        return {
          title: t("toolConfirm.tool.bash"),
          description: (input.command as string) ?? toolInput,
        };
      case "Read":
      case "read_file":
        return {
          title: t("toolConfirm.tool.readFile"),
          description: (input.file_path as string) ?? (input.path as string) ?? toolInput,
        };
      case "Write":
      case "write_file":
      case "create_file":
        return {
          title: t("toolConfirm.tool.writeFile"),
          description: (input.file_path as string) ?? (input.path as string) ?? toolInput,
        };
      case "Edit":
      case "replace":
        return {
          title: t("toolConfirm.tool.editFile"),
          description: (input.file_path as string) ?? (input.path as string) ?? toolInput,
        };
      case "Delete":
      case "delete_file":
      case "remove_file":
        return {
          title: t("toolConfirm.tool.deleteFile"),
          description: (input.file_path as string) ?? (input.path as string) ?? toolInput,
        };
      case "Glob":
        return {
          title: t("toolConfirm.tool.searchFiles"),
          description: (input.pattern as string) ?? toolInput,
        };
      case "Grep":
        return {
          title: t("toolConfirm.tool.searchContents"),
          description: t("toolConfirm.tool.patternPrefix", { pattern: (input.pattern as string) ?? toolInput }),
        };
      case "WebFetch":
        return {
          title: t("toolConfirm.tool.fetchWeb"),
          description: (input.url as string) ?? toolInput,
        };
      case "WebSearch":
        return {
          title: t("toolConfirm.tool.searchWeb"),
          description: (input.query as string) ?? toolInput,
        };
      case "Task":
        return {
          title: t("toolConfirm.tool.launchSubAgent"),
          description: (input.description as string) ?? (input.prompt as string)?.slice(0, 120) ?? toolInput,
        };
      case "EnterPlanMode":
        return {
          title: t("toolConfirm.tool.enterPlanMode"),
          description: t("toolConfirm.tool.enterPlanModeDesc"),
        };
      case "ExitPlanMode": {
        const prompts = input.allowedPrompts as Array<{ prompt?: string }> | undefined;
        const promptSummary = prompts?.length
          ? prompts.map((p) => p.prompt ?? "").filter(Boolean).join(", ")
          : "";
        return {
          title: t("toolConfirm.tool.exitPlanMode"),
          description: promptSummary
            ? t("toolConfirm.tool.exitPlanModePermissions", { permissions: promptSummary })
            : t("toolConfirm.tool.exitPlanModeDesc"),
        };
      }
      case "TodoWrite": {
        const todos = input.todos as Array<{ content?: string }> | undefined;
        return {
          title: t("toolConfirm.tool.updateTodoList"),
          description: todos?.length
            ? t("toolConfirm.tool.updateTodoItems", {
                count: todos.length,
                items: todos.map((td) => td.content ?? "").filter(Boolean).join(", ").slice(0, 160),
              })
            : t("toolConfirm.tool.updateTaskList"),
        };
      }
      case "TaskCreate":
        return {
          title: t("toolConfirm.tool.createTask"),
          description: (input.subject as string) ?? (input.description as string) ?? toolInput,
        };
      case "TaskUpdate": {
        const taskId = input.taskId as string | undefined;
        const status = input.status as string | undefined;
        return {
          title: t("toolConfirm.tool.updateTask"),
          description: status && taskId
            ? t("toolConfirm.tool.updateTaskStatus", { taskId, status })
            : (input.subject as string) ?? taskId ?? toolInput,
        };
      }
      case "TaskGet":
        return {
          title: t("toolConfirm.tool.getTask"),
          description: (input.taskId as string) ?? toolInput,
        };
      case "TaskList":
        return {
          title: t("toolConfirm.tool.listTasks"),
          description: t("toolConfirm.tool.listTasksDesc"),
        };
      case "AskUserQuestion": {
        const questions = input.questions as Array<{ question?: string }> | undefined;
        const q = questions?.[0]?.question ?? "";
        return {
          title: t("toolConfirm.tool.askUserQuestion"),
          description: q || t("toolConfirm.tool.requestingUserInput"),
        };
      }
      case "SendMessage": {
        const recipient = input.recipient as string | undefined;
        const summary = input.summary as string | undefined;
        let description: string;
        if (recipient && summary) {
          description = t("toolConfirm.tool.sendMessageToWithSummary", { recipient, summary });
        } else if (recipient) {
          description = t("toolConfirm.tool.sendMessageTo", { recipient });
        } else {
          description = summary ?? t("toolConfirm.tool.sendMessageDefault");
        }
        return {
          title: t("toolConfirm.tool.sendMessage"),
          description,
        };
      }
      case "TeamCreate":
        return {
          title: t("toolConfirm.tool.createTeam"),
          description: (input.team_name as string) ?? t("toolConfirm.tool.createTeamDefault"),
        };
      case "TeamDelete":
        return {
          title: t("toolConfirm.tool.deleteTeam"),
          description: t("toolConfirm.tool.deleteTeamDesc"),
        };
      case "Skill":
        return {
          title: t("toolConfirm.tool.runSkill"),
          description: (input.skill as string) ?? toolInput,
        };
      case "NotebookEdit":
        return {
          title: t("toolConfirm.tool.editNotebook"),
          description: (input.notebook_path as string) ?? toolInput,
        };
      case "Workflow":
        return {
          title: t("toolConfirm.tool.workflow"),
          description: (input.name as string) ?? (input.description as string) ?? (input.scriptPath as string) ?? t("toolConfirm.tool.workflowDesc"),
        };
      case "CronCreate":
        return {
          title: t("toolConfirm.tool.createCron"),
          description: (input.cron as string) ?? (input.prompt as string) ?? toolInput,
        };
      case "CronDelete":
        return {
          title: t("toolConfirm.tool.deleteCron"),
          description: (input.id as string) ?? toolInput,
        };
      case "CronList":
        return {
          title: t("toolConfirm.tool.listCrons"),
          description: t("toolConfirm.tool.listCronsDesc"),
        };
      case "ScheduleWakeup":
        return {
          title: t("toolConfirm.tool.scheduleWakeup"),
          description: (input.reason as string) ?? (input.prompt as string) ?? toolInput,
        };
      case "Monitor":
        return {
          title: t("toolConfirm.tool.monitor"),
          description: (input.description as string) ?? (input.command as string) ?? toolInput,
        };
      case "PushNotification":
        return {
          title: t("toolConfirm.tool.pushNotification"),
          description: (input.message as string) ?? toolInput,
        };
      case "REPL":
        return {
          title: t("toolConfirm.tool.repl"),
          description: (input.description as string) ?? (input.code as string)?.slice(0, 160) ?? toolInput,
        };
      case "RemoteTrigger":
        return {
          title: t("toolConfirm.tool.remoteTrigger"),
          description: (input.action as string) ?? (input.trigger_id as string) ?? toolInput,
        };
      default: {
        // MCP server elicitation — toolName is "MCP:<serverName>"
        if (toolName.startsWith("MCP:")) {
          const serverName = toolName.slice(4);
          return {
            title: t("toolConfirm.tool.mcpElicitation", { serverName }),
            description: (input.message as string) ?? toolInput,
          };
        }
        // For unknown tools, try to extract meaningful fields instead of raw JSON
        const keys = Object.keys(input);
        if (keys.length > 0) {
          const summaryText = keys
            .slice(0, 3)
            .map((k) => {
              const v = input[k];
              const val = typeof v === "string" ? v : JSON.stringify(v);
              return `${k}: ${val.length > 60 ? val.slice(0, 57) + "..." : val}`;
            })
            .join("\n");
          return {
            title: t("toolConfirm.tool.runTool", { toolName }),
            description: summaryText,
          };
        }
        return {
          title: t("toolConfirm.tool.runTool", { toolName }),
          description: toolInput.slice(0, 200),
        };
      }
    }
  } catch {
    return {
      title: t("toolConfirm.tool.runTool", { toolName }),
      description: toolInput.slice(0, 200),
    };
  }
}

function renderFilePreviewSnippet({
  label,
  text,
  tone,
  lines,
  t,
}: {
  readonly label: string;
  readonly text: string;
  readonly tone: "before" | "after";
  readonly lines: number;
  readonly t: TFunction;
}) {
  return (
    <section
      className={`tool-confirm-file-snippet tool-confirm-file-snippet-${tone}`}
      data-tool-confirm-file-section={tone}
    >
      <div className="tool-confirm-file-snippet-head">
        <span>{label}</span>
        <span>{t("toolConfirm.file.lines", { count: lines })}</span>
      </div>
      <pre className="tool-confirm-file-pre">
        {text || t("toolConfirm.file.emptyPreview")}
      </pre>
    </section>
  );
}

function formatSignedLineDelta(value: number): string {
  if (value > 0) return `+${value}`;
  if (value < 0) return `${value}`;
  return "0";
}

function renderFileConfirmationSummary(preview: FileConfirmationPreview, t: TFunction) {
  const languageLabel = preview.extension ? preview.extension.toUpperCase() : "TEXT";
  const oldLineCount = preview.kind === "edited" ? preview.removed : 0;
  const newLineCount = preview.kind === "deleted" ? 0 : preview.added;
  const netLineDelta = newLineCount - oldLineCount;
  const changeText = preview.kind === "deleted"
    ? t("toolConfirm.file.deleted")
    : preview.kind === "edited"
      ? `+${preview.added} / -${preview.removed}`
      : `+${preview.added}`;

  return (
    <div
      className="tool-file-artifact-summary tool-confirm-file-summary-rail"
      data-tool-confirm-file-summary="true"
      aria-label={t("toolConfirm.file.summary")}
    >
      <span className="tool-file-artifact-summary-label">
        {t("toolConfirm.file.summary")}
      </span>
      <span className="tool-file-artifact-chip" data-tool-confirm-file-summary-chip="language">
        <span>{t("toolConfirm.file.language")}</span>
        <strong>{languageLabel}</strong>
      </span>
      {preview.kind !== "deleted" && (
        <span className="tool-file-artifact-chip" data-tool-confirm-file-summary-chip="line-delta">
          <span>{t("toolConfirm.file.lineDelta")}</span>
          <strong>{oldLineCount} -&gt; {newLineCount}</strong>
        </span>
      )}
      <span className="tool-file-artifact-chip" data-tool-confirm-file-summary-chip="change">
        <span>{t("toolConfirm.file.change")}</span>
        <strong>{changeText}</strong>
      </span>
      {preview.kind === "edited" && (
        <span className="tool-file-artifact-chip" data-tool-confirm-file-summary-chip="net-change">
          <span>{t("toolConfirm.file.netChange")}</span>
          <strong>{formatSignedLineDelta(netLineDelta)}</strong>
        </span>
      )}
    </div>
  );
}

export function renderFileConfirmationPreviewCard(preview: FileConfirmationPreview, t: TFunction) {
  const AccentIcon = preview.kind === "created"
    ? FilePlus2
    : preview.kind === "deleted"
      ? FileX2
      : PencilLine;
  const label = preview.kind === "created"
    ? t("toolConfirm.file.created")
    : preview.kind === "deleted"
      ? t("toolConfirm.file.deleted")
      : t("toolConfirm.file.edited");
  const summary = preview.kind === "created"
    ? t("toolConfirm.file.createdSummary", { count: preview.added })
    : preview.kind === "deleted"
      ? t("toolConfirm.file.deletedSummary")
      : t("toolConfirm.file.editedSummary", {
          added: preview.added,
          removed: preview.removed,
        });

  return (
    <div
      className={`tool-confirm-file-card tool-confirm-file-${preview.kind}`}
      data-tool-confirm-file-preview="true"
      data-tool-confirm-file-kind={preview.kind}
      data-tool-confirm-file-path={preview.filePath}
    >
      <div className="tool-confirm-file-header">
        <div className="tool-confirm-file-icon">
          {getFileIcon(preview.extension || null, preview.fileName)}
          <AccentIcon size={10} className="tool-confirm-file-accent" />
        </div>
        <div className="tool-confirm-file-title">
          <div className="tool-confirm-file-title-row">
            <span className="tool-confirm-file-label">{label}</span>
            <strong className="tool-confirm-file-name">{preview.fileName || preview.filePath}</strong>
            {preview.extension && <span className="tool-confirm-file-lang">{preview.extension}</span>}
            {preview.kind !== "deleted" && (
              <span className="tool-confirm-file-stat tool-confirm-file-stat-added">
                +{preview.added}
              </span>
            )}
            {preview.kind === "edited" && (
              <span className="tool-confirm-file-stat tool-confirm-file-stat-removed">
                -{preview.removed}
              </span>
            )}
          </div>
          <span className="tool-confirm-file-summary">{summary}</span>
          <span className="tool-confirm-file-path" title={preview.filePath}>
            {preview.filePath}
          </span>
        </div>
      </div>

      {renderFileConfirmationSummary(preview, t)}

      {preview.kind === "deleted" ? (
        <div className="tool-confirm-file-delete-note">
          {t("toolConfirm.file.deleteNote")}
        </div>
      ) : (
        <div className="tool-confirm-file-preview" data-tool-confirm-file-content="true">
          {preview.kind === "edited" && (
            renderFilePreviewSnippet({
              label: t("toolConfirm.file.before"),
              text: preview.oldText,
              tone: "before",
              lines: preview.removed,
              t,
            })
          )}
          {renderFilePreviewSnippet({
            label: preview.kind === "edited" ? t("toolConfirm.file.after") : t("toolConfirm.file.content"),
            text: preview.newText,
            tone: "after",
            lines: preview.added,
            t,
          })}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// ToolConfirmDialog — modal dialog following VGt63 design from Pencil.
// ---------------------------------------------------------------------------

type Choice = "allow" | "deny";

export function ToolConfirmDialog() {
  const { t } = useTranslation();
  const pending = useChatStore((s) => findPendingConfirmation(s.messages));
  const planFilePath = useChatStore((s) => findPlanFilePath(s.messages));

  const pendingId = pending?.id ?? null;
  const pendingConfirmId = pending?.confirmId ?? null;

  const [selected, setSelected] = useState<Choice>("allow");
  const [submitting, setSubmitting] = useState(false);
  const [minimized, setMinimized] = useState(false);
  const [closing, setClosing] = useState(false);
  const [showPlanDetail, setShowPlanDetail] = useState(false);
  const dialogRef = useRef<HTMLDivElement>(null);

  // Reset selection and submitting guard when a new confirmation appears
  useEffect(() => {
    if (pendingId !== null) {
      setSelected("allow");
      setSubmitting(false);
      setMinimized(false);
      setClosing(false);
      setShowPlanDetail(false);
    }
  }, [pendingId]);

  const action = useMemo(
    () => (pending ? describeToolAction(pending.toolName, pending.toolInput, t) : null),
    [pending, t],
  );
  const filePreview = useMemo(
    () => (pending ? getFileConfirmationPreview(pending.toolName, pending.toolInput) : null),
    [pending],
  );

  const handleConfirm = useCallback(() => {
    if (!pendingConfirmId || !pendingId || submitting) return;
    setSubmitting(true);
    const approved = selected === "allow";
    useChatStore.getState().resolveToolCallConfirmation(pendingId, approved);
    invoke("respond_tool_confirmation", {
      confirmId: pendingConfirmId,
      approved,
    }).catch(() => {
      // IPC failed — the sidecar never received the decision, so roll the
      // optimistic resolve back to pending and let the dialog re-appear.
      setSubmitting(false);
      useChatStore.getState().revertToolCallToPending(pendingId);
    });
  }, [pendingId, pendingConfirmId, selected, submitting]);

  const handleSkip = useCallback(() => {
    if (!pendingConfirmId || !pendingId || submitting) return;
    setSubmitting(true);
    useChatStore.getState().resolveToolCallConfirmation(pendingId, false);
    invoke("respond_tool_confirmation", {
      confirmId: pendingConfirmId,
      approved: false,
    }).catch(() => {
      // IPC failed — roll back so the user is not left with a phantom denial.
      setSubmitting(false);
      useChatStore.getState().revertToolCallToPending(pendingId);
    });
  }, [pendingId, pendingConfirmId, submitting]);

  const handleMinimize = useCallback(() => {
    setMinimized(true);
  }, []);

  const handleRestore = useCallback(() => {
    setMinimized(false);
  }, []);

  const handleAnimatedAction = useCallback((action: () => void) => {
    if (submitting || closing) return;
    setClosing(true);
    setTimeout(action, 280);
  }, [submitting, closing]);

  // Keyboard handling: Escape to minimize (not dismiss), focus trap
  useEffect(() => {
    if (!pending) return;

    // Auto-focus the dialog when not minimized
    if (!minimized) {
      dialogRef.current?.focus();
    }

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        if (minimized) return;
        handleMinimize();
        return;
      }
      // The listener is attached to `document`, so without this guard a stray
      // Enter/Arrow typed in the chat input (or any other panel) would toggle
      // the selection or approve the pending tool — including sensitive
      // ExitPlanMode permission grants. Selection/confirm shortcuts only apply
      // while focus is inside the dialog (it auto-focuses on open).
      if (!dialogRef.current?.contains(document.activeElement)) return;
      if (e.key === "ArrowUp" || e.key === "ArrowDown") {
        e.preventDefault();
        setSelected((prev) => (prev === "allow" ? "deny" : "allow"));
        return;
      }
      if (e.key === "Enter") {
        e.preventDefault();
        handleConfirm();
        return;
      }
      // Focus trap — keep Tab cycling within the dialog
      if (!minimized && e.key === "Tab" && dialogRef.current) {
        const focusable = dialogRef.current.querySelectorAll<HTMLElement>(
          'button:not([disabled]), [tabindex]:not([tabindex="-1"])',
        );
        if (!focusable.length) return;
        const first = focusable[0];
        const last = focusable[focusable.length - 1];
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }
    };

    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [pending, handleMinimize, handleConfirm, minimized]);

  if (!pending || !action) return null;


  // ── Collapsed inline bar (in-place, no position change) ──
  if (minimized) {
    return (
      <div
        className="w-full cursor-pointer transition-all hover:brightness-110"
        style={{ marginBottom: 8 }}
        onClick={handleRestore}
      >
        <div
          className="flex items-center gap-2.5"
          style={{
            padding: "10px 16px",
            borderRadius: 12,
            backgroundColor: "var(--color-card)",
            border: "1px solid var(--color-border)",
          }}
        >
          <Terminal size={16} style={{ color: "#FF8400" }} />
          <span
            className="font-semibold truncate"
            style={{ color: "var(--color-foreground)", fontFamily: "Inter", fontSize: 13 }}
          >
            {t("toolConfirm.pendingApproval")}
          </span>
          <span
            className="truncate"
            style={{
              color: "var(--color-text-placeholder)",
              fontFamily: "Inter",
              fontSize: 12,
              maxWidth: 200,
            }}
          >
            {action.title}
          </span>
          <div className="flex-1" />
          <div
            className="shrink-0 animate-pulse"
            style={{
              width: 8,
              height: 8,
              borderRadius: 4,
              backgroundColor: "#FF8400",
            }}
          />
        </div>
      </div>
    );
  }

  // ── ExitPlanMode: Lightweight floating approval bar ──
  if (pending.toolName === "ExitPlanMode") {
    return (
      <>
        <div
          ref={dialogRef}
          role="dialog"
          aria-label={t("toolConfirm.planApproval")}
          tabIndex={-1}
          className={`outline-none w-full ${closing ? "dialog-slide-exit" : "dialog-slide-enter"}`}
          style={{ marginBottom: 8 }}
        >
          <div
            className="flex items-center gap-3"
            style={{ padding: "4px 0" }}
          >
            {/* Left: icon + label + badge */}
            <ClipboardCheck size={14} className="shrink-0" style={{ color: "var(--color-accent-purple)" }} />
            <span
              className="font-semibold shrink-0"
              style={{ color: "var(--color-foreground)", fontFamily: "Inter", fontSize: 12 }}
            >
              {t("toolConfirm.planApproval")}
            </span>
            <span
              className="font-medium shrink-0"
              style={{
                padding: "2px 6px",
                borderRadius: 6,
                backgroundColor: "rgba(var(--theme-accent-rgb),0.082)",
                color: "var(--color-accent-purple)",
                fontFamily: "Inter",
                fontSize: 9,
              }}
            >
              {t("toolConfirm.planModeBadge")}
            </span>

            {/* Spacer */}
            <div className="flex-1" />

            {/* View plan link */}
            {planFilePath && (
              <button
                type="button"
                onClick={() => setShowPlanDetail(true)}
                className="flex items-center gap-1 shrink-0 transition-opacity hover:opacity-70"
                style={{ padding: "4px 8px", borderRadius: 6 }}
              >
                <FileText size={12} style={{ color: "var(--color-muted)" }} />
                <span style={{ color: "var(--color-muted)", fontFamily: "Inter", fontSize: 11 }}>
                  {t("toolConfirm.viewPlan")}
                </span>
              </button>
            )}

            {/* Separator */}
            <div className="shrink-0" style={{ width: 1, height: 16, backgroundColor: "var(--color-border)" }} />

            {/* Reject */}
            <button
              type="button"
              onClick={() => handleAnimatedAction(handleSkip)}
              disabled={submitting}
              className="flex items-center justify-center shrink-0 transition-opacity hover:opacity-80"
              style={{
                padding: "5px 12px",
                borderRadius: 6,
                border: "1px solid var(--color-border-strong)",
                opacity: submitting ? 0.5 : 1,
              }}
            >
              <span
                className="font-medium"
                style={{ color: "var(--color-muted-foreground)", fontFamily: "Inter", fontSize: 11 }}
              >
                {t("toolConfirm.reject")}
              </span>
            </button>

            {/* Approve */}
            <button
              type="button"
              onClick={handleConfirm}
              disabled={submitting}
              className={`flex items-center justify-center gap-1 shrink-0 transition-opacity hover:brightness-110 ${submitting ? "" : "approve-btn-glow"}`}
              style={{
                padding: "5px 14px",
                borderRadius: 6,
                background: "linear-gradient(180deg, #10B981 0%, #059669 100%)",
                opacity: submitting ? 0.5 : 1,
              }}
            >
              <Check size={12} style={{ color: "#FFFFFF" }} />
              <span
                className="font-semibold"
                style={{ color: "#FFFFFF", fontFamily: "Inter", fontSize: 11 }}
              >
                {t("toolConfirm.approveExecution")}
              </span>
            </button>
          </div>
        </div>

        {/* Plan Detail Modal (portaled to body) */}
        {showPlanDetail && planFilePath && (
          <PlanDetailModal
            planFilePath={planFilePath}
            onClose={() => setShowPlanDetail(false)}
          />
        )}
      </>
    );
  }

  // ── Full dialog (generic tools) — bottom-anchored card matching AGu8S ──
  const toolBadge = pending.toolName;

  return (
    <div
      ref={dialogRef}
      role="dialog"
      aria-modal="true"
      aria-label={t("toolConfirm.ariaLabel")}
      tabIndex={-1}
      className={`outline-none w-full ${closing ? "dialog-slide-exit" : "dialog-slide-enter"}`}
      style={{ marginBottom: 8 }}
    >
      <div
        className="flex flex-col overflow-hidden"
        style={{
          borderRadius: 12,
          backgroundColor: "var(--color-card)",
          border: "1px solid var(--color-border)",
          padding: "16px 20px",
          gap: 14,
        }}
      >
        {/* Header */}
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2.5">
            <Terminal size={18} style={{ color: "#FF8400" }} />
            <span
              className="font-semibold"
              style={{ color: "var(--color-foreground)", fontFamily: "Inter", fontSize: 14 }}
            >
              {t("toolConfirm.preConfirmTitle")}
            </span>
            <span
              className="font-medium"
              style={{
                padding: "2px 8px",
                borderRadius: 10,
                backgroundColor: "#FF840018",
                color: "#4285F4",
                fontFamily: "Inter",
                fontSize: 10,
              }}
            >
              {toolBadge}
            </span>
          </div>
          <div className="flex items-center gap-1">
            <button
              type="button"
              onClick={handleMinimize}
              disabled={submitting}
              className="flex items-center justify-center transition-opacity hover:opacity-80"
              title={t("toolConfirm.minimize")}
            >
              <Minus size={16} style={{ color: "var(--color-muted)" }} />
            </button>
            <button
              type="button"
              onClick={() => handleAnimatedAction(handleSkip)}
              disabled={submitting}
              className="flex items-center justify-center transition-opacity hover:opacity-80"
            >
              <X size={16} style={{ color: "var(--color-muted)" }} />
            </button>
          </div>
        </div>

        {/* Description */}
        <span
          style={{
            color: "var(--color-muted-foreground)",
            fontFamily: "Inter",
            fontSize: 13,
            lineHeight: 1.5,
          }}
        >
          {t("toolConfirm.preConfirmDesc")}
        </span>

        {filePreview && renderFileConfirmationPreviewCard(filePreview, t)}

        {/* Options */}
        <div className="flex flex-col gap-2">
          {/* Allow option */}
          <button
            type="button"
            onClick={() => setSelected("allow")}
            disabled={submitting}
            className="flex items-center gap-2.5 w-full text-left transition-colors"
            style={{
              padding: "10px 14px",
              borderRadius: 8,
              backgroundColor: "var(--color-surface)",
              border: `${selected === "allow" ? "1.5px" : "1px"} solid ${selected === "allow" ? "#22C55E" : "var(--color-border-strong)"}`,
            }}
          >
            <div
              className="flex items-center justify-center shrink-0"
              style={{
                width: 16,
                height: 16,
                borderRadius: 8,
                border: `2px solid #22C55E`,
              }}
            >
              {selected === "allow" && (
                <div style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: "#22C55E" }} />
              )}
            </div>
            <div className="flex flex-col gap-0.5">
              <span
                className="font-medium"
                style={{ color: "var(--color-foreground)", fontFamily: "Inter", fontSize: 13 }}
              >
                {t("toolConfirm.allowExec")}
              </span>
              <span
                style={{ color: "var(--color-muted)", fontFamily: "Inter", fontSize: 11 }}
              >
                {t("toolConfirm.allowExecDesc")}
              </span>
            </div>
          </button>

          {/* Deny option */}
          <button
            type="button"
            onClick={() => setSelected("deny")}
            disabled={submitting}
            className="flex items-center gap-2.5 w-full text-left transition-colors"
            style={{
              padding: "10px 14px",
              borderRadius: 8,
              backgroundColor: "var(--color-surface)",
              border: `${selected === "deny" ? "1.5px" : "1px"} solid ${selected === "deny" ? "#EF4444" : "var(--color-border-strong)"}`,
            }}
          >
            <div
              className="flex items-center justify-center shrink-0"
              style={{
                width: 16,
                height: 16,
                borderRadius: 8,
                border: `1.5px solid #EF4444`,
              }}
            >
              {selected === "deny" && (
                <div style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: "#EF4444" }} />
              )}
            </div>
            <div className="flex flex-col gap-0.5">
              <span
                className="font-medium"
                style={{ color: "var(--color-foreground)", fontFamily: "Inter", fontSize: 13 }}
              >
                {t("toolConfirm.denyExec")}
              </span>
              <span
                style={{ color: "var(--color-muted)", fontFamily: "Inter", fontSize: 11 }}
              >
                {t("toolConfirm.denyExecDesc")}
              </span>
            </div>
          </button>

          {!filePreview && (
            <div
              className="flex items-center gap-2.5"
              style={{
                padding: "10px 14px",
                borderRadius: 8,
                backgroundColor: "var(--color-surface)",
                border: "1px solid var(--color-border-strong)",
              }}
            >
              <div className="flex flex-col gap-0.5 min-w-0">
                <span
                  className="font-medium"
                  style={{ color: "var(--color-foreground)", fontFamily: "Inter", fontSize: 13 }}
                >
                  {t("toolConfirm.runCommand")}
                </span>
                <pre
                  className="whitespace-pre-wrap break-all"
                  style={{
                    color: "var(--color-foreground)",
                    fontFamily: "JetBrains Mono, monospace",
                    fontSize: 11,
                    lineHeight: 1.4,
                    maxHeight: 80,
                    overflow: "auto",
                    margin: 0,
                  }}
                >
                  {action.description}
                </pre>
              </div>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-1">
            <ShieldAlert size={12} style={{ color: "#FF8400" }} />
            <span
              style={{ color: "var(--color-muted)", fontFamily: "Inter", fontSize: 11 }}
            >
              {t("toolConfirm.confirmHint")}
            </span>
          </div>
          <button
            type="button"
            onClick={handleConfirm}
            disabled={submitting}
            className="flex items-center justify-center gap-1.5 transition-opacity hover:brightness-110"
            style={{
              padding: "8px 24px",
              borderRadius: 8,
              background: "linear-gradient(180deg, #4285F4 0%, #3B78E7 100%)",
              opacity: submitting ? 0.5 : 1,
            }}
          >
            <Check size={14} style={{ color: "#FFFFFF" }} />
            <span
              className="font-semibold"
              style={{ color: "#FFFFFF", fontFamily: "Inter", fontSize: 13 }}
            >
              {t("toolConfirm.confirmSelection")}
            </span>
          </button>
        </div>
      </div>
    </div>
  );
}
