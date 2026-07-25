import { useCallback, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { MessageSquareQuote, Copy, Check, X } from "lucide-react";

interface SelectionToolbarProps {
  readonly position: { readonly x: number; readonly y: number };
  readonly selectedText: string;
  readonly onQuote: (text: string) => void;
}

const VIEWPORT_PADDING = 4;

export function SelectionToolbar({ position, selectedText, onQuote }: SelectionToolbarProps) {
  const { t } = useTranslation();
  const toolbarRef = useRef<HTMLDivElement>(null);
  const [adjustedPos, setAdjustedPos] = useState(position);
  const [copied, setCopied] = useState(false);
  const [copyFailed, setCopyFailed] = useState(false);

  // Adjust position before paint to avoid viewport overflow and flickering
  useLayoutEffect(() => {
    const el = toolbarRef.current;
    if (!el) return;

    const rect = el.getBoundingClientRect();
    let { x, y } = position;

    if (x + rect.width > window.innerWidth - VIEWPORT_PADDING) {
      x = window.innerWidth - rect.width - VIEWPORT_PADDING;
    }
    if (x < VIEWPORT_PADDING) {
      x = VIEWPORT_PADDING;
    }
    if (y < VIEWPORT_PADDING) {
      y = VIEWPORT_PADDING;
    }
    if (y + rect.height > window.innerHeight - VIEWPORT_PADDING) {
      y = window.innerHeight - rect.height - VIEWPORT_PADDING;
    }

    setAdjustedPos({ x, y });
  }, [position]);

  const handleQuote = useCallback(() => {
    onQuote(selectedText);
    window.getSelection()?.removeAllRanges();
  }, [selectedText, onQuote]);

  const handleCopy = useCallback(async () => {
    let success = false;
    try {
      await navigator.clipboard.writeText(selectedText);
      success = true;
    } catch {
      // Fallback for non-HTTPS / restricted contexts
      try {
        const textarea = document.createElement("textarea");
        textarea.value = selectedText;
        textarea.style.position = "fixed";
        textarea.style.opacity = "0";
        document.body.appendChild(textarea);
        textarea.select();
        success = document.execCommand("copy");
        document.body.removeChild(textarea);
      } catch {
        success = false;
      }
    }
    if (success) {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } else {
      setCopyFailed(true);
      setTimeout(() => setCopyFailed(false), 1500);
    }
  }, [selectedText]);

  const toolbar = (
    <div
      ref={toolbarRef}
      className="animate-fade-in-up"
      style={{
        position: "fixed",
        left: adjustedPos.x,
        top: adjustedPos.y,
        zIndex: 200,
        display: "flex",
        alignItems: "center",
        gap: 2,
        padding: "4px 6px",
        borderRadius: 8,
        backgroundColor: "var(--color-card)",
        border: "1px solid var(--color-border-light)",
        boxShadow: "0 8px 24px rgba(0,0,0,0.4)",
      }}
    >
      <button
        onClick={handleQuote}
        className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-md text-[12px] font-medium font-sans transition-colors hover:bg-border-subtle"
        style={{ color: "var(--color-accent-purple)" }}
        title={t("chat.selectionToolbar.quote")}
      >
        <MessageSquareQuote size={14} />
        <span>{t("chat.selectionToolbar.quote")}</span>
      </button>

      <div className="w-px h-4" style={{ backgroundColor: "var(--color-border-subtle)" }} />

      <button
        onClick={handleCopy}
        className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-md text-[12px] font-medium font-sans transition-colors hover:bg-border-subtle"
        style={{ color: copied ? "#10B981" : copyFailed ? "#EF4444" : "var(--color-muted)" }}
        title={t("chat.selectionToolbar.copy")}
      >
        {copied ? <Check size={14} /> : copyFailed ? <X size={14} /> : <Copy size={14} />}
        <span>{copied ? t("chat.selectionToolbar.copied") : t("chat.selectionToolbar.copy")}</span>
      </button>
    </div>
  );

  return createPortal(toolbar, document.body);
}
