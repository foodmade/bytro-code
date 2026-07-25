import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { FileText, X, Loader2 } from "lucide-react";
import { invoke } from "@tauri-apps/api/core";
import { useTranslation } from "react-i18next";
import { MarkdownRenderer } from "@/components/ui/markdown-renderer";

interface PlanDetailModalProps {
  readonly planFilePath: string;
  readonly onClose: () => void;
}

export function PlanDetailModal({ planFilePath, onClose }: PlanDetailModalProps) {
  const { t } = useTranslation();
  const dialogRef = useRef<HTMLDivElement>(null);
  const [content, setContent] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Read plan file from disk
  useEffect(() => {
    let cancelled = false;
    invoke<string>("read_file_content", { path: planFilePath })
      .then((text) => {
        if (!cancelled) setContent(text);
      })
      .catch((err) => {
        if (!cancelled) setError(String(err));
      });
    return () => { cancelled = true; };
  }, [planFilePath]);

  useEffect(() => {
    dialogRef.current?.focus();
  }, []);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [onClose]);

  const handleBackdropClick = useCallback(() => onClose(), [onClose]);

  // Extract filename from path
  const fileName = planFilePath.replace(/\\/g, "/").split("/").pop() ?? "plan.md";

  return createPortal(
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center"
      style={{ backgroundColor: "rgba(0, 0, 0, 0.6)" }}
      onClick={handleBackdropClick}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label={t("toolConfirm.planDetail")}
        tabIndex={-1}
        className="flex flex-col overflow-hidden outline-none"
        onClick={(e) => e.stopPropagation()}
        style={{
          width: 720,
          maxHeight: "75vh",
          borderRadius: 12,
          backgroundColor: "var(--color-card)",
          border: "1px solid var(--color-border)",
          boxShadow: "0 8px 32px rgba(0,0,0,0.5)",
          animation: "popupEnter 200ms cubic-bezier(0.32, 0.72, 0, 1) forwards",
        }}
      >
        {/* Header */}
        <div
          className="flex items-center justify-between shrink-0"
          style={{ padding: "14px 20px" }}
        >
          <div className="flex items-center gap-2">
            <FileText size={16} style={{ color: "var(--color-accent-purple)" }} />
            <span
              className="font-semibold"
              style={{ color: "var(--color-foreground)", fontFamily: "Inter", fontSize: 14 }}
            >
              {t("toolConfirm.planDetail")}
            </span>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="flex items-center justify-center transition-opacity hover:opacity-80"
          >
            <X size={16} style={{ color: "var(--color-muted)" }} />
          </button>
        </div>

        {/* Separator */}
        <div className="shrink-0" style={{ height: 1, backgroundColor: "var(--color-border)" }} />

        {/* Content — scrollable */}
        <div
          className="flex-1 overflow-y-auto"
          style={{ padding: "20px 24px" }}
        >
          {content === null && !error && (
            <div className="flex items-center justify-center py-8">
              <Loader2 size={20} className="animate-spin" style={{ color: "var(--color-muted)" }} />
            </div>
          )}
          {error && (
            <span style={{ color: "#EF4444", fontFamily: "Inter", fontSize: 13 }}>
              {error}
            </span>
          )}
          {content !== null && (
            <MarkdownRenderer content={content} variant="chat" />
          )}
        </div>

        {/* Separator */}
        <div className="shrink-0" style={{ height: 1, backgroundColor: "var(--color-border)" }} />

        {/* Footer */}
        <div
          className="flex items-center justify-between shrink-0"
          style={{ padding: "12px 20px" }}
        >
          <div className="flex items-center gap-1.5">
            <FileText size={12} style={{ color: "var(--color-muted)" }} />
            <span style={{ color: "var(--color-muted)", fontFamily: "Inter", fontSize: 11 }}>
              {fileName}
            </span>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="flex items-center justify-center transition-opacity hover:opacity-80"
            style={{
              padding: "6px 16px",
              borderRadius: 6,
              backgroundColor: "var(--color-surface)",
              border: "1px solid var(--color-border-strong)",
            }}
          >
            <span
              className="font-medium"
              style={{ color: "var(--color-foreground)", fontFamily: "Inter", fontSize: 12 }}
            >
              {t("toolConfirm.close")}
            </span>
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
