import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import {
  X,
  CheckCheck,
  Loader2,
  FileCode2,
  FilePlus2,
  FileX2,
  Pencil,
  Eye,
} from "lucide-react";
import { useFileChangesStore, useConversationStore } from "@/stores";
import { MarkdownRenderer } from "@/components/ui/markdown-renderer";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Returns just the filename portion of a path (cross-platform). */
function getBasename(filePath: string): string {
  return filePath.replace(/\\/g, "/").split("/").pop() ?? filePath;
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface ReviewModalProps {
  /** Called when the user wants to apply the optimization plan to the chat. */
  readonly onApply: (optimizationPlan: string) => void;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

/**
 * Modal overlay that presents the AI code review result and lets the user
 * edit the report, add notes, then confirm whether to apply the optimization.
 */
export function ReviewModal({ onApply }: ReviewModalProps) {
  const { t } = useTranslation();
  const conversationId = useConversationStore((s) => s.activeConversationId);
  const convState = useFileChangesStore((s) =>
    s.getConversationState(conversationId),
  );
  const setShowReviewModal = useFileChangesStore(
    (s) => s.setShowReviewModal,
  );

  const { showReviewModal, reviewResult, isReviewing, changes } = convState;

  // ---- local editable state ------------------------------------------------
  const [isEditing, setIsEditing] = useState(false);
  const [editedContent, setEditedContent] = useState("");
  const [userNotes, setUserNotes] = useState("");
  const notesRef = useRef<HTMLTextAreaElement>(null);

  // Sync editedContent when stream finishes
  const prevReviewingRef = useRef(isReviewing);
  useEffect(() => {
    if (prevReviewingRef.current && !isReviewing && reviewResult) {
      setEditedContent(reviewResult);
      setIsEditing(false);
      setUserNotes("");
    }
    prevReviewingRef.current = isReviewing;
  }, [isReviewing, reviewResult]);

  // Also sync when modal first opens with a completed result (no stream)
  useEffect(() => {
    if (showReviewModal && reviewResult && !isReviewing) {
      setEditedContent(reviewResult);
    }
  }, [showReviewModal, reviewResult, isReviewing]);

  // ---- handlers ------------------------------------------------------------
  const handleDismiss = useCallback(() => {
    setShowReviewModal(conversationId, false);
    setIsEditing(false);
    setUserNotes("");
  }, [setShowReviewModal, conversationId]);

  const handleApply = useCallback(() => {
    const content = isEditing ? editedContent : (reviewResult ?? "");
    if (!content) return;

    const parts: string[] = [
      t("chat.codeReview.applyPrefix"),
      "",
      content,
    ];

    if (userNotes.trim()) {
      parts.push("", "---", "", `**${t("chat.codeReview.userNotesLabel")}：** ${userNotes.trim()}`);
    }

    setShowReviewModal(conversationId, false);
    setIsEditing(false);
    setUserNotes("");
    onApply(parts.join("\n"));
  }, [editedContent, reviewResult, userNotes, isEditing, onApply, setShowReviewModal, conversationId, t]);

  // Close on Escape key
  useEffect(() => {
    if (!showReviewModal && !isReviewing) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") handleDismiss();
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [showReviewModal, isReviewing, handleDismiss]);

  if (!showReviewModal && !isReviewing) return null;

  const streamDone = !isReviewing && !!reviewResult;

  return createPortal(
    // Backdrop
    <div
      className="fixed inset-0 z-50 flex items-center justify-center"
      style={{ background: "rgba(0, 0, 0, 0.65)" }}
      onClick={handleDismiss}
    >
      {/* Modal panel */}
      <div
        role="dialog"
        aria-modal="true"
        aria-label={t("chat.codeReview.title")}
        className="relative flex flex-col"
        style={{
          width: "min(760px, 90vw)",
          maxHeight: "85vh",
          borderRadius: 12,
          background: "var(--color-card)",
          border: "1px solid var(--color-border)",
          boxShadow: "0 24px 64px rgba(0,0,0,0.5)",
          overflow: "hidden",
        }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div
          className="flex items-center justify-between flex-shrink-0"
          style={{
            padding: "16px 24px",
            borderBottom: "1px solid var(--color-border)",
            background: "var(--color-surface-alt)",
          }}
        >
          <div className="flex items-center gap-2">
            <CheckCheck size={16} className="text-accent-info" />
            <span
              className="font-sans font-semibold text-foreground"
              style={{ fontSize: 14 }}
            >
              {t("chat.codeReview.title")}
            </span>
          </div>

          <div className="flex items-center gap-1">
            {/* Edit / Preview toggle — only after stream completes */}
            {streamDone && (
              <button
                onClick={() => {
                  if (!isEditing) setEditedContent(reviewResult ?? "");
                  setIsEditing((v) => !v);
                }}
                className="flex items-center gap-1 text-muted-foreground hover:text-foreground transition-colors cursor-pointer"
                style={{ padding: "4px 8px", borderRadius: 6, fontSize: 12 }}
              >
                {isEditing ? (
                  <>
                    <Eye size={13} />
                    {t("chat.codeReview.previewRendered")}
                  </>
                ) : (
                  <>
                    <Pencil size={13} />
                    {t("chat.codeReview.editRaw")}
                  </>
                )}
              </button>
            )}
            <button
              onClick={handleDismiss}
              aria-label={t("chat.codeReview.dismiss")}
              className="flex items-center justify-center text-muted hover:text-foreground transition-colors cursor-pointer"
              style={{ padding: 4, borderRadius: 6 }}
            >
              <X size={16} />
            </button>
          </div>
        </div>

        {/* File list — shows which files are being reviewed */}
        {changes.length > 0 && (
          <div
            className="flex-shrink-0 flex flex-wrap gap-1.5"
            style={{
              padding: "10px 20px",
              borderBottom: "1px solid var(--color-border)",
              background: "var(--color-surface-alt)",
            }}
          >
            {changes.map((change) => {
              const Icon =
                change.action === "create"
                  ? FilePlus2
                  : change.action === "delete"
                    ? FileX2
                    : FileCode2;
              const iconColor =
                change.action === "create"
                  ? "#22c55e"
                  : change.action === "delete"
                    ? "#ef4444"
                    : "var(--color-accent-info)";
              return (
                <span
                  key={change.filePath}
                  title={change.filePath}
                  className="inline-flex items-center gap-1 font-mono"
                  style={{
                    padding: "2px 8px",
                    borderRadius: 5,
                    background: "var(--color-surface)",
                    border: "1px solid var(--color-border)",
                    fontSize: 11,
                    maxWidth: 220,
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                    color: "var(--color-foreground)",
                  }}
                >
                  <Icon size={11} color={iconColor} style={{ flexShrink: 0 }} />
                  {getBasename(change.filePath)}
                </span>
              );
            })}
          </div>
        )}

        {/* Body — review content */}
        <div
          className="flex-1 overflow-y-auto"
          style={{ padding: "20px 24px", minHeight: 0 }}
        >
          {isReviewing && !reviewResult ? (
            /* Initial loading spinner — before first chunk arrives */
            <div
              className="flex flex-col items-center justify-center gap-3"
              style={{ minHeight: 160 }}
            >
              <Loader2 size={28} className="text-accent-info animate-spin" />
              <span
                className="font-sans text-muted-foreground"
                style={{ fontSize: 13 }}
              >
                {t("chat.codeReview.reviewing")}
              </span>
            </div>
          ) : isEditing ? (
            /* Editable raw markdown textarea */
            <textarea
              value={editedContent}
              onChange={(e) => setEditedContent(e.target.value)}
              className="font-mono text-foreground"
              style={{
                width: "100%",
                minHeight: 300,
                padding: 12,
                borderRadius: 8,
                border: "1px solid var(--color-border)",
                background: "var(--color-surface)",
                fontSize: 13,
                lineHeight: 1.6,
                resize: "vertical",
                outline: "none",
              }}
              spellCheck={false}
            />
          ) : (
            <>
              <MarkdownRenderer content={reviewResult ?? ""} variant="compact" />
              {/* Streaming in-progress indicator */}
              {isReviewing && reviewResult && (
                <div
                  className="flex items-center gap-1.5 animate-pulse"
                  style={{ marginTop: 12, paddingBottom: 4 }}
                >
                  <Loader2 size={12} className="text-accent-info animate-spin" />
                  <span
                    className="font-sans text-muted-foreground"
                    style={{ fontSize: 12 }}
                  >
                    {t("chat.codeReview.reviewing")}
                  </span>
                </div>
              )}
            </>
          )}
        </div>

        {/* User notes input — visible after stream completes */}
        {streamDone && (
          <div
            className="flex-shrink-0"
            style={{
              padding: "12px 24px 0",
              borderTop: "1px solid var(--color-border)",
            }}
          >
            <textarea
              ref={notesRef}
              value={userNotes}
              onChange={(e) => setUserNotes(e.target.value)}
              placeholder={t("chat.codeReview.userNotesPlaceholder")}
              className="font-sans text-foreground placeholder:text-muted-foreground"
              style={{
                width: "100%",
                minHeight: 64,
                maxHeight: 140,
                padding: 10,
                borderRadius: 8,
                border: "1px solid var(--color-border)",
                background: "var(--color-surface)",
                fontSize: 13,
                lineHeight: 1.5,
                resize: "vertical",
                outline: "none",
              }}
            />
          </div>
        )}

        {/* Footer */}
        {streamDone && (
          <div
            className="flex items-center justify-end gap-3 flex-shrink-0"
            style={{ padding: "14px 24px" }}
          >
            <button
              onClick={handleDismiss}
              className="flex items-center gap-1.5 cursor-pointer text-muted-foreground hover:text-foreground transition-colors"
              style={{
                padding: "7px 14px",
                borderRadius: 6,
                border: "1px solid var(--color-border)",
                background: "transparent",
                fontSize: 13,
                fontWeight: 500,
              }}
            >
              {t("chat.codeReview.dismiss")}
            </button>
            <button
              onClick={handleApply}
              className="flex items-center gap-1.5 cursor-pointer transition-opacity hover:opacity-85"
              style={{
                padding: "7px 16px",
                borderRadius: 6,
                background:
                  "color-mix(in srgb, var(--color-accent-info) 90%, #000)",
                border: "1px solid transparent",
                color: "#fff",
                fontSize: 13,
                fontWeight: 600,
              }}
            >
              <CheckCheck size={14} />
              {t("chat.codeReview.applyOptimizations")}
            </button>
          </div>
        )}
      </div>
    </div>,
    document.body,
  );
}
