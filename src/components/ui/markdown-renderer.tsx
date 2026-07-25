import { memo, useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeHighlight from "rehype-highlight";
import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { ImageOff } from "lucide-react";
import { useTranslation } from "react-i18next";
import { useToastStore } from "@/stores/toast-store";
import { openToolFile, resolveToolFilePath } from "@/lib/file-open";
import { looksLikeFilePath } from "@/lib/file-path-detect";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface MarkdownRendererProps {
  /** The markdown string to render */
  readonly content: string;
  /**
   * "chat" — full-featured rendering for agent chat messages (13px body text,
   *   CodeBlock component for fenced code, tables, blockquotes, headings, etc.)
   * "compact" — lighter rendering for team direct messages (12px body text,
   *   simple pre/code blocks)
   */
  readonly variant?: "chat" | "compact";
  /**
   * Optional CodeBlock component for rendering fenced code blocks.
   * Only used in "chat" variant. Receives `language` and highlighted
   * React `children` from rehype-highlight. When omitted, fenced code
   * falls back to a simple <pre> element.
   */
  readonly codeBlock?: (props: { language: string; children: ReactNode }) => ReactNode;
  readonly lightweight?: boolean;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

function closeDanglingCodeFence(markdown: string): string {
  // `[ \t]*` tolerates indented fences (kept in sync with
  // hasBalancedStreamingFences in chat-message-segments). The fence marker
  // stays capture group 2 because the indent is non-capturing.
  const fences = [...markdown.matchAll(/(^|\n)[ \t]*(`{3,}|~{3,})([^\n]*)/g)];
  if (fences.length === 0 || fences.length % 2 === 0) return markdown;

  const lastFence = fences[fences.length - 1]?.[2];
  if (!lastFence) return markdown;
  return markdown.endsWith("\n") ? `${markdown}${lastFence}` : `${markdown}\n${lastFence}`;
}

export const MarkdownRenderer = memo(function MarkdownRenderer({
  content,
  variant = "chat",
  codeBlock: CodeBlock,
  lightweight = false,
}: MarkdownRendererProps) {
  const isCompact = variant === "compact";
  const bodySize = isCompact ? "text-[12px]" : "text-[14px]";
  // Streaming output still needs Markdown parsing. `lightweight` only skips
  // highlight.js work so partial responses do not flip from plaintext to
  // formatted Markdown when the turn completes.
  const renderedContent = useMemo(
    () => (lightweight ? closeDanglingCodeFence(content) : content),
    [content, lightweight],
  );
  const remarkPlugins = useMemo(() => [remarkGfm], []);
  const rehypePlugins = useMemo(
    () => (lightweight ? [] : [rehypeHighlight]),
    [lightweight],
  );
  return (
    <ReactMarkdown
      remarkPlugins={remarkPlugins}
      rehypePlugins={rehypePlugins}
      components={{
        // ---- Code ----
        pre({ children }) {
          if (!isCompact && CodeBlock) {
            const codeChild = Array.isArray(children) ? children[0] : children;
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const codeProps = (codeChild as any)?.props as Record<string, unknown> | undefined;
            const className = (codeProps?.className as string) ?? "";
            const lang = className.replace(/^.*language-/, "").split(" ")[0];
            // Pass highlighted React children so syntax colors are preserved
            const highlightedChildren = codeProps?.children as ReactNode;
            return <>{CodeBlock({ language: lang, children: highlightedChildren })}</>;
          }
          return (
            <pre
              className="rounded p-2 my-1 overflow-x-auto text-[11px] font-mono"
              style={{ backgroundColor: "var(--color-surface-alt)" }}
            >
              {children}
            </pre>
          );
        },
        code({ className, children }) {
          const isBlock = className?.includes("hljs") || className?.includes("language-");
          if (isBlock) {
            return (
              <code className={`${className ?? ""} ${isCompact ? "text-[11px]" : ""} font-mono`}>
                {children}
              </code>
            );
          }
          // Inline code whose content looks like a workspace file path becomes
          // clickable (chat variant only — opening relies on a workspace root).
          if (!isCompact) {
            const filePath = extractInlineCodeText(children);
            if (filePath && looksLikeFilePath(filePath)) {
              return <ClickableFilePath text={filePath.trim()} />;
            }
          }
          return isCompact ? (
            <code className="bg-topbar px-1 rounded text-[11px] font-mono">
              {children}
            </code>
          ) : (
            <code
              className="px-1.5 py-0.5 rounded text-[13px] font-mono break-all"
              style={{ backgroundColor: "rgba(110,118,129,0.15)", color: "var(--color-muted-foreground)" }}
            >
              {children}
            </code>
          );
        },

        // ---- Image ----
        // Markdown images can reference absolute paths the agent wrote to
        // disk (e.g. `![](/abs/path/x.png)`). Letting the browser fetch them
        // through the Vite dev server triggers the asset transform pipeline,
        // which loudly errors when the file is later deleted. Convert to a
        // Tauri asset URL (bypasses Vite) and degrade to a broken-image
        // placeholder on load failure.
        img({ src, alt, title }) {
          return <SafeMarkdownImage src={src} alt={alt} title={title} />;
        },

        // ---- Text ----
        p({ children }) {
          return isCompact ? (
            <p className="mb-1 last:mb-0 whitespace-pre-wrap">{children}</p>
          ) : (
            <p
              className={`mb-2 last:mb-0 ${bodySize} font-sans text-foreground break-words whitespace-pre-line`}
              style={{ lineHeight: 1.5, overflowWrap: "anywhere" }}
            >
              {children}
            </p>
          );
        },

        // ---- Lists ----
        ul({ children }) {
          return isCompact ? (
            <ul className="ml-4 list-disc list-inside">{children}</ul>
          ) : (
            <ul className="list-disc list-inside pl-4 mb-2 space-y-1">{children}</ul>
          );
        },
        ol({ children }) {
          return isCompact ? (
            <ol className="ml-4 list-decimal list-inside">{children}</ol>
          ) : (
            <ol className="list-decimal list-inside pl-4 mb-2 space-y-1">{children}</ol>
          );
        },
        li({ children }) {
          return isCompact ? (
            <li className="mb-0.5">{children}</li>
          ) : (
            <li className={`${bodySize} text-foreground`} style={{ lineHeight: 1.5 }}>
              {children}
            </li>
          );
        },

        // ---- Headings ----
        h1({ children }) {
          return isCompact ? (
            <h1 className="text-[13px] font-semibold mb-1">{children}</h1>
          ) : (
            <h1 className="text-[16px] font-bold text-foreground mb-2 mt-4 first:mt-0">
              {children}
            </h1>
          );
        },
        h2({ children }) {
          return isCompact ? (
            <h2 className="text-[13px] font-semibold mb-1">{children}</h2>
          ) : (
            <h2 className="text-[14px] font-bold text-foreground mb-2 mt-3 first:mt-0">
              {children}
            </h2>
          );
        },
        h3({ children }) {
          return isCompact ? (
            <h3 className="text-[13px] font-semibold mb-1">{children}</h3>
          ) : (
            <h3 className="text-[14px] font-bold text-foreground mb-1 mt-2 first:mt-0">
              {children}
            </h3>
          );
        },

        // ---- Inline ----
        strong({ children }) {
          return <strong className="font-semibold">{children}</strong>;
        },
        em({ children }) {
          return <em className="italic">{children}</em>;
        },

        // ---- Block elements (chat-only features render as simple fallbacks in compact) ----
        blockquote({ children }) {
          return isCompact ? (
            <blockquote className="pl-3 my-1 italic text-muted-foreground border-l-2 border-border-light">
              {children}
            </blockquote>
          ) : (
            <blockquote
              className="pl-3 my-2 italic text-text-tertiary"
              style={{ borderLeft: "2px solid rgba(var(--theme-accent-rgb),0.5)" }}
            >
              {children}
            </blockquote>
          );
        },
        table({ children }) {
          return (
            <div className="overflow-x-auto my-2">
              <table
                className="w-full text-[13px] border-collapse"
                style={{ border: "1px solid var(--color-border-light)" }}
              >
                {children}
              </table>
            </div>
          );
        },
        th({ children }) {
          return (
            <th
              className="px-3 py-1.5 text-left font-semibold text-foreground"
              style={{
                border: "1px solid var(--color-border-light)",
                backgroundColor: "rgba(var(--hover-overlay-rgb),0.03)",
              }}
            >
              {children}
            </th>
          );
        },
        td({ children }) {
          return (
            <td
              className="px-3 py-1.5 text-foreground"
              style={{ border: "1px solid var(--color-border-light)" }}
            >
              {children}
            </td>
          );
        },
        a({ href, children }) {
          return (
            <a
              href={href}
              target="_blank"
              rel="noopener noreferrer"
              className="text-accent-purple hover:underline"
            >
              {children}
            </a>
          );
        },
        hr() {
          return (
            <hr
              style={{ borderColor: "var(--color-border-light)" }}
              className="my-3"
            />
          );
        },
      }}
    >
      {renderedContent}
    </ReactMarkdown>
  );
});

// ---------------------------------------------------------------------------
// ClickableFilePath — renders an inline-code file path as a clickable chip that
// opens the file in the editor. Existence is verified on click (path_exists);
// a missing file surfaces a toast instead of opening a blank tab.
// ---------------------------------------------------------------------------

function extractInlineCodeText(children: ReactNode): string | null {
  if (typeof children === "string") return children;
  if (Array.isArray(children) && children.length === 1 && typeof children[0] === "string") {
    return children[0];
  }
  return null;
}

function ClickableFilePath({ text }: { readonly text: string }) {
  const { t } = useTranslation();

  const handleOpen = useCallback(async () => {
    const warnMissing = () =>
      useToastStore
        .getState()
        .addToast("warning", t("chat.openPath.fileNotFound", { path: text }));
    try {
      const resolved = await resolveToolFilePath(text);
      const exists = await invoke<boolean>("path_exists", { path: resolved });
      if (!exists) {
        warnMissing();
        return;
      }
      await openToolFile(resolved);
    } catch {
      warnMissing();
    }
  }, [text, t]);

  return (
    <code
      role="button"
      tabIndex={0}
      onClick={() => void handleOpen()}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          void handleOpen();
        }
      }}
      className="bytro-md-filepath px-1.5 py-0.5 rounded text-[13px] font-mono break-all"
      title={t("chat.openPath.openTooltip")}
    >
      {text}
    </code>
  );
}

export function TailFadeText({
  content,
  tailLength,
}: {
  readonly content: string;
  readonly tailLength: number;
}) {
  const chars = Array.from(content);
  const tailStart = Math.max(0, chars.length - tailLength);
  const stable = chars.slice(0, tailStart).join("");
  const tail = chars.slice(tailStart);

  return (
    <>
      {stable}
      {tail.map((char, index) => {
        const absoluteIndex = tailStart + index;
        if (/\s/.test(char)) {
          return <span key={`space-${absoluteIndex}`}>{char}</span>;
        }
        return (
          <span key={`tail-${absoluteIndex}`} className="streaming-tail-char">
            {char}
          </span>
        );
      })}
    </>
  );
}

// ---------------------------------------------------------------------------
// SafeMarkdownImage — routes any non-web image src through Tauri's asset
// protocol so the Vite dev server never sees the request. Letting Vite handle
// a filesystem path triggers its asset/CSS transform pipeline, which crashes
// the dev overlay with ENOENT when the file has been deleted (and even when
// it exists, surfaces unrelated CSS analysis errors).
//
// Resolution rules:
//   1. http/https/data/blob/asset/tauri/file → pass through unchanged
//   2. Absolute filesystem path → convertFileSrc(src)
//   3. Relative path → render the broken-image placeholder
//      (a relative path is meaningless without a base, and we deliberately
//      refuse to assume the agent's cwd / workspace dir as the base — image
//      providers are expected to write absolute paths into chat markdown)
//
// Every failure mode degrades to the broken-image placeholder; nothing falls
// back to the raw path that would invoke the dev server.
// ---------------------------------------------------------------------------

function isAbsoluteFilesystemPath(src: string): boolean {
  // POSIX absolute path
  if (src.startsWith("/")) return true;
  // Windows drive letter (C:\ or C:/)
  if (/^[a-zA-Z]:[\\/]/.test(src)) return true;
  // Windows UNC path (\\server\share)
  if (src.startsWith("\\\\")) return true;
  return false;
}

function SafeMarkdownImage({
  src,
  alt,
  title,
}: {
  readonly src?: string;
  readonly alt?: string;
  readonly title?: string;
}) {
  const safeSrc = useMemo<string | undefined>(() => {
    if (!src) return undefined;
    // 1. Already a URL the browser can fetch directly without Vite intercepting
    if (/^(https?:|data:|blob:|asset:|tauri:|file:)/i.test(src)) return src;
    // 2. Absolute filesystem path → Tauri asset protocol
    if (isAbsoluteFilesystemPath(src)) {
      try {
        return convertFileSrc(src);
      } catch {
        return undefined;
      }
    }
    // 3. Relative path — refuse to emit; we have no defensible base directory
    return undefined;
  }, [src]);

  const [errored, setErrored] = useState(false);
  // Reset the error flag whenever the resolved src changes so streaming
  // markdown updates (which rapidly mutate the same component instance) can
  // recover once a valid path arrives.
  useEffect(() => {
    setErrored(false);
  }, [safeSrc]);

  if (!src) return null;

  if (!safeSrc || errored) {
    return (
      <span
        className="inline-flex items-center gap-1 align-middle"
        style={{
          padding: "2px 6px",
          borderRadius: 4,
          border: "1px dashed var(--color-border-strong)",
          color: "var(--color-muted)",
          fontSize: 11,
          fontFamily: "var(--font-mono)",
        }}
        title={src}
      >
        <ImageOff size={12} />
        <span className="truncate max-w-[240px]">{alt || src}</span>
      </span>
    );
  }

  return (
    <img
      src={safeSrc}
      alt={alt}
      title={title}
      className="max-w-full h-auto rounded my-2"
      onError={() => setErrored(true)}
    />
  );
}
