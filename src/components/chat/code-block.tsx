import { memo, useCallback, useMemo, useState, type ReactNode } from "react";
import { Copy, Check } from "lucide-react";
import hljs from "highlight.js/lib/core";
import bash from "highlight.js/lib/languages/bash";
import json from "highlight.js/lib/languages/json";

hljs.registerLanguage("bash", bash);
hljs.registerLanguage("json", json);

/** Recursively extract plain text from React children */
function extractText(node: ReactNode): string {
  if (node == null || typeof node === "boolean") return "";
  if (typeof node === "string") return node;
  if (typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(extractText).join("");
  if (typeof node === "object" && "props" in node) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return extractText((node as any).props.children);
  }
  return "";
}

interface CodeBlockProps {
  readonly language?: string;
  /** Plain-text code (used for copy-to-clipboard) */
  readonly code?: string;
  /** Syntax-highlighted React children from rehype-highlight */
  readonly children?: ReactNode;
  /** Optional max height for the code body (header stays fixed above) */
  readonly maxBodyHeight?: number;
}

/**
 * Code block with syntax highlighting, language tag, and copy button.
 * Accepts either highlighted React `children` (preserving hljs spans)
 * or a plain `code` string as fallback.
 */
export const CodeBlock = memo(function CodeBlock({ language, code, children, maxBodyHeight }: CodeBlockProps) {
  const [copied, setCopied] = useState(false);

  // For copy: extract plain text from children, or use code prop
  const plainText = code ?? extractText(children);

  const handleCopy = useCallback(() => {
    navigator.clipboard.writeText(plainText);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }, [plainText]);

  const lang = language?.replace(/^language-/, "") ?? "";

  // When only `code` is provided (no pre-highlighted children), run hljs
  const highlightedHtml = useMemo(() => {
    if (children || !code || !lang) return null;
    try {
      if (hljs.getLanguage(lang)) {
        return hljs.highlight(code, { language: lang }).value;
      }
    } catch { /* fall through */ }
    return null;
  }, [children, code, lang]);

  return (
    <div
      className="chat-code-block rounded-md overflow-hidden code-block-hover my-2"
      style={{
        backgroundColor: "var(--color-surface-alt)",
        border: "1px solid var(--color-border-light)",
      }}
    >
      {/* Header: language tag + copy button */}
      <div
        className="flex items-center justify-between"
        style={{
          height: 32,
          padding: "0 12px",
          backgroundColor: "var(--color-surface)",
          borderBottom: "1px solid rgba(var(--hover-overlay-rgb),0.06)",
        }}
      >
        <span className="text-[11px] font-mono text-muted">
          {lang || "text"}
        </span>
        <button
          onClick={handleCopy}
          className="flex items-center gap-1 text-muted hover:text-muted-foreground transition-colors"
        >
          {copied ? (
            <>
              <Check size={14} className="text-[#10B981]" />
              <span className="text-[10px] font-mono text-[#10B981]">Copied!</span>
            </>
          ) : (
            <Copy size={14} />
          )}
        </button>
      </div>

      {/* Code body */}
      <div className="chat-code-block-body" style={{ maxHeight: maxBodyHeight, overflowY: maxBodyHeight ? "auto" : undefined }}>
        <pre className="chat-code-block-pre overflow-x-auto">
          {highlightedHtml ? (
            <code
              className={`chat-code-block-code hljs text-[12px] font-mono leading-relaxed whitespace-pre language-${lang}`}
              dangerouslySetInnerHTML={{ __html: highlightedHtml }}
            />
          ) : (
            <code className="chat-code-block-code text-[12px] font-mono leading-relaxed whitespace-pre">
              {children ?? code}
            </code>
          )}
        </pre>
      </div>
    </div>
  );
});
