import { useState, useCallback, useRef, useEffect, memo } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useTranslation } from "react-i18next";
import { Check, ChevronDown, Sparkles, Loader2, X } from "lucide-react";
import {
  useChatStore,
  useGitStore,
  useWorkspaceStore,
  useToastStore,
} from "@/stores";
import { formatError } from "@/lib/format-error";
import { resolveOneShotAiTarget, generateOneShotViaSidecar } from "@/lib/ai-one-shot";

// ---------------------------------------------------------------------------
// OAuth subscription path — generate via the sidecar chat pipeline
// ---------------------------------------------------------------------------

// Keep in sync with COMMIT_SYSTEM_PROMPT in src-tauri/src/anthropic.rs.
// The Rust HTTP path can't use subscription OAuth tokens (sk-ant-oat* only
// works through the Claude Code CLI; Codex tokens live in the CLI's
// auth.json), so OAuth profiles route through stream_chat instead.
const COMMIT_SYSTEM_PROMPT = `You are a git commit message generator. Based on the conversation context and file changes provided, generate a concise git commit message in conventional commit format.

Rules:
- Format: <type>: <description>
- Types: feat, fix, refactor, docs, test, chore, perf, ci, style
- Description should be concise (under 72 characters for the first line)
- If the changes are complex, add a blank line followed by a brief body (2-3 bullet points max)
- Use the same language as the conversation context
- Reply with ONLY the commit message, no additional text, no quotes, no markdown fences`;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type AiButtonPhase = "idle" | "loading" | "success" | "error";

interface GitCommitInputProps {
  readonly isLoading: boolean;
  readonly onCommit: (message: string) => void | Promise<void>;
  readonly onCommitAndPush: (message: string) => void | Promise<void>;
}

// ---------------------------------------------------------------------------
// Constants — match Pencil node e5gbg exactly
// ---------------------------------------------------------------------------

const GRADIENT = "linear-gradient(135deg, #7C3AED 0%, #A855F7 35%, #EC4899 70%, #F97316 100%)";

const GLOW_IDLE = "0 0 10px 2px rgba(var(--theme-accent-rgb),0.400), 0 0 6px 0px #EC489944, 0 1px 3px 0px #7C3AED88";
const GLOW_HOVER = "0 0 16px 3px rgba(var(--theme-accent-rgb),0.600), 0 0 10px 0px #EC489966, 0 1px 6px 0px #7C3AEDaa";

const PARTICLE_COLORS = ["#A855F7", "#EC4899", "#F97316", "#4ADE80"];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function spawnParticles(container: HTMLElement, count: number): void {
  for (let i = 0; i < count; i++) {
    const dot = document.createElement("span");
    const angle = (Math.PI * 2 * i) / count + (Math.random() - 0.5) * 0.5;
    const dist = 15 + Math.random() * 15;
    dot.className = "ai-gen-particle";
    Object.assign(dot.style, {
      position: "absolute",
      width: "4px",
      height: "4px",
      borderRadius: "50%",
      top: "50%",
      left: "50%",
      marginTop: "-2px",
      marginLeft: "-2px",
      backgroundColor: PARTICLE_COLORS[i % PARTICLE_COLORS.length],
      zIndex: "10",
      pointerEvents: "none",
    } as CSSStyleDeclaration);
    dot.style.setProperty("--px", `${Math.cos(angle) * dist}px`);
    dot.style.setProperty("--py", `${Math.sin(angle) * dist}px`);
    container.appendChild(dot);
    setTimeout(() => dot.remove(), 550);
  }
}

// ---------------------------------------------------------------------------
// CommitMenuItem
// ---------------------------------------------------------------------------

function CommitMenuItem({
  label,
  shortcut,
  onClick,
  active,
}: {
  readonly label: string;
  readonly shortcut?: string;
  readonly onClick: () => void;
  readonly active?: boolean;
}) {
  return (
    <button
      onClick={onClick}
      className="flex items-center justify-between native-css-hover"
      style={
        {
          padding: "7px 10px",
          borderRadius: 5,
          cursor: "pointer",
          backgroundColor: active ? "var(--color-border-subtle)" : "transparent",
          border: "none",
          "--native-hover-bg-color": "var(--color-border-subtle)",
        } as React.CSSProperties
      }
    >
      <div className="flex items-center" style={{ gap: 8 }}>
        <Check
          size={12}
          style={{
            color: active ? "var(--color-accent-purple)" : "transparent",
            transition: "color 150ms",
          }}
        />
        <span
          className="text-[12px] font-medium font-sans"
          style={{ color: "var(--color-foreground)" }}
        >
          {label}
        </span>
      </div>
      {shortcut && (
        <span className="text-[10px] font-mono" style={{ color: "var(--color-muted)" }}>
          {shortcut}
        </span>
      )}
    </button>
  );
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export const GitCommitInput = memo(function GitCommitInput({
  isLoading,
  onCommit,
  onCommitAndPush,
}: GitCommitInputProps) {
  const { t } = useTranslation();

  // Core state
  const [message, setMessage] = useState("");
  const [isFocused, setIsFocused] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [commitMode, setCommitMode] = useState<"commit" | "commit-and-push">("commit");
  const menuRef = useRef<HTMLDivElement>(null);
  const menuBtnRef = useRef<HTMLButtonElement>(null);
  const [isGenerating, setIsGenerating] = useState(false);

  // AI button state machine
  const [aiPhase, setAiPhase] = useState<AiButtonPhase>("idle");
  const [aiHover, setAiHover] = useState(false);
  const [aiPressed, setAiPressed] = useState(false);
  const [hasError, setHasError] = useState(false);
  const [shakeKey, setShakeKey] = useState(0);

  // Refs
  const btnRef = useRef<HTMLButtonElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const typewriterRef = useRef<number | null>(null);
  const inputWrapperRef = useRef<HTMLDivElement>(null);
  const composingRef = useRef(false);
  // Track ephemeral timeouts so they can be cancelled on unmount.
  const pendingTimers = useRef<ReturnType<typeof setTimeout>[]>([]);

  // Cleanup typewriter + pending timeouts on unmount
  useEffect(() => {
    return () => {
      if (typewriterRef.current !== null) clearInterval(typewriterRef.current);
      for (const id of pendingTimers.current) clearTimeout(id);
      pendingTimers.current = [];
    };
  }, []);

  // Auto-resize textarea to fit content (skip during IME composition)
  useEffect(() => {
    if (composingRef.current) return;
    const el = textareaRef.current;
    if (!el) return;
    if (!message) {
      el.style.height = "20px";
      return;
    }
    el.style.height = "0";
    el.style.height = `${el.scrollHeight}px`;
  }, [message]);

  // ── Commit ──────────────────────────────────────────────────────────

  const handleCommit = useCallback(async () => {
    const trimmed = message.trim();
    if (!trimmed || isLoading || isGenerating) return;
    try {
      await onCommit(trimmed);
      setMessage("");
    } catch {
      // Error already handled by the store's toast
    }
  }, [message, isLoading, isGenerating, onCommit]);

  const handleCommitAndPush = useCallback(async () => {
    const trimmed = message.trim();
    if (!trimmed || isLoading || isGenerating) return;
    try {
      await onCommitAndPush(trimmed);
      setMessage("");
      setMenuOpen(false);
    } catch {
      // Error already handled by the store's toast
    }
  }, [message, isLoading, isGenerating, onCommitAndPush]);

  // Close menu on click outside
  useEffect(() => {
    if (!menuOpen) return;
    const handleClickOutside = (e: MouseEvent) => {
      if (
        menuRef.current &&
        !menuRef.current.contains(e.target as Node) &&
        menuBtnRef.current &&
        !menuBtnRef.current.contains(e.target as Node)
      ) {
        setMenuOpen(false);
      }
    };
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [menuOpen]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        handleCommit();
      }
    },
    [handleCommit],
  );

  // ── Typewriter effect (25ms/char per spec) ──────────────────────────

  const typewrite = useCallback((text: string) => {
    if (typewriterRef.current !== null) clearInterval(typewriterRef.current);
    let i = 0;
    setMessage("");
    setIsGenerating(true);
    typewriterRef.current = window.setInterval(() => {
      if (i < text.length) {
        setMessage(text.slice(0, i + 1));
        i++;
      } else {
        if (typewriterRef.current !== null) {
          clearInterval(typewriterRef.current);
          typewriterRef.current = null;
        }
        setIsGenerating(false);
      }
    }, 25);
  }, []);

  // ── AI Generate ─────────────────────────────────────────────────────

  const handleGenerateMessage = useCallback(async () => {
    if (aiPhase === "loading" || isLoading) return;

    const resolved = resolveOneShotAiTarget();
    if (!resolved.ok) {
      useToastStore.getState().addToast(
        "warning",
        resolved.reason === "no-model"
          ? "Select a local model profile before generating a commit message."
          : t("git.apiKeyRequired"),
      );
      return;
    }
    const target = resolved.target;

    setHasError(false);
    setAiPhase("loading");
    setIsGenerating(true);

    try {
      const chatMessages = useChatStore.getState().messages;
      const fileStatuses = useGitStore.getState().fileStatuses;
      const workspace = useWorkspaceStore.getState().activeWorkspace;
      const workspacePath = workspace?.path ?? null;

      const chatContext = chatMessages
        .slice(-20)
        .map((m) => {
          const c = m.content.length > 300 ? m.content.slice(0, 300) + "..." : m.content;
          return `[${m.role}]: ${c}`;
        })
        .join("\n")
        .slice(0, 4000);

      let diffSummary = fileStatuses
        .map((f) => `${f.status} ${f.is_staged ? "(staged)" : "(unstaged)"} ${f.path}`)
        .join("\n");

      if (workspacePath) {
        try {
          const [unstagedDiff, stagedDiff] = await Promise.all([
            invoke<{ files: Array<{ path: string; additions: number; deletions: number }> }>(
              "get_git_diff",
              { path: workspacePath, staged: false },
            ).catch(() => null),
            invoke<{ files: Array<{ path: string; additions: number; deletions: number }> }>(
              "get_git_diff",
              { path: workspacePath, staged: true },
            ).catch(() => null),
          ]);
          const allFiles = [...(stagedDiff?.files ?? []), ...(unstagedDiff?.files ?? [])];
          if (allFiles.length > 0) {
            diffSummary = allFiles
              .map((f) => `${f.path} (+${f.additions} -${f.deletions})`)
              .join("\n");
          }
        } catch {
          // fallback
        }
      }
      diffSummary = diffSummary.slice(0, 4000);

      let result: string;
      if (target.authMode === "oauth") {
        result = await generateOneShotViaSidecar({
          target,
          systemPrompt: COMMIT_SYSTEM_PROMPT,
          userContent: `Conversation context:\n${chatContext}\n\nChanged files:\n${diffSummary}`,
          timeoutMessage: "Commit message generation timed out",
        });
      } else {
        result = await invoke<string>("generate_commit_message", {
          sdk: target.sdk,
          baseUrl: target.baseUrl,
          apiKey: target.apiKey,
          model: target.model,
          proxyUrl: target.proxyUrl ?? null,
          chatContext,
          diffSummary,
        });
      }

      // ── Success ──
      setAiPhase("success");
      if (btnRef.current) spawnParticles(btnRef.current, 8);
      typewrite(result);

      // Border flash on input wrapper
      const wrapper = inputWrapperRef.current;
      if (wrapper) {
        wrapper.style.borderColor = "#A855F7";
        wrapper.style.boxShadow = "0 0 0 2px rgba(var(--theme-accent-rgb),0.251)";
        pendingTimers.current.push(
          setTimeout(() => {
            wrapper.style.borderColor = "";
            wrapper.style.boxShadow = "";
          }, 400),
        );
      }

      pendingTimers.current.push(setTimeout(() => setAiPhase("idle"), 800));
    } catch (err: unknown) {
      // ── Error ──
      setAiPhase("error");
      setHasError(true);
      setIsGenerating(false);
      setShakeKey((k) => k + 1);
      useToastStore.getState().addToast("error", `${t("git.generateFailed")}: ${formatError(err)}`);
      pendingTimers.current.push(setTimeout(() => setAiPhase("idle"), 1500));
    }
  }, [aiPhase, isLoading, t, typewrite]);

  // ── Derived styles ──────────────────────────────────────────────────

  const btnShadow = (() => {
    if (aiPhase === "loading") return undefined; // CSS class handles pulsing glow
    if (aiHover) return GLOW_HOVER;
    return GLOW_IDLE;
  })();

  const btnScale = (() => {
    if (aiPressed && aiPhase === "idle") return "scale(0.92)";
    if (aiHover && aiPhase === "idle") return "scale(1.12)";
    return "scale(1)";
  })();

  // ── Icon ────────────────────────────────────────────────────────────

  const renderIcon = () => {
    const base: React.CSSProperties = { color: "#FFFFFF", position: "relative", zIndex: 3 };
    switch (aiPhase) {
      case "loading":
        return <Loader2 size={14} className="animate-spin" style={base} />;
      case "success":
        return <Check size={14} className="ai-gen-check-bounce" style={base} />;
      case "error":
        return <X size={14} style={base} />;
      default:
        return <Sparkles size={14} className="ai-gen-sparkle-pulse" style={base} />;
    }
  };

  const canCommit = message.trim().length > 0 && !isLoading && !isGenerating;

  // ── Render ──────────────────────────────────────────────────────────

  return (
    <div
      className="flex flex-col shrink-0"
      style={{ gap: 8, padding: 12, borderTop: "1px solid var(--color-border-subtle)" }}
    >
      {/* CommitInput — flex row matching Pencil node ZSz1X */}
      <div
        ref={inputWrapperRef}
        className="flex items-start"
        style={{
          gap: 8,
          padding: "8px 12px",
          borderRadius: 6,
          backgroundColor: "var(--color-surface-alt)",
          border: `1px solid ${isFocused ? "rgba(var(--theme-accent-rgb),0.376)" : "var(--color-border-subtle)"}`,
          boxShadow: isFocused ? "0 0 0 2px rgba(var(--theme-accent-rgb),0.082)" : "none",
          transition: "border-color 200ms, box-shadow 400ms",
        }}
      >
        {/* Message textarea — fills remaining space */}
        <textarea
          ref={textareaRef}
          value={message}
          onChange={(e) => {
            setMessage(e.target.value);
            // During IME composition, manually resize since the useEffect skips it
            if (composingRef.current) {
              const el = e.target;
              el.style.height = "0";
              el.style.height = `${el.scrollHeight}px`;
            }
          }}
          onCompositionStart={() => {
            composingRef.current = true;
          }}
          onCompositionEnd={(e) => {
            composingRef.current = false;
            setMessage((e.target as HTMLTextAreaElement).value);
            // Trigger resize after composition ends
            const el = textareaRef.current;
            if (el) {
              el.style.height = "0";
              el.style.height = `${el.scrollHeight}px`;
            }
          }}
          onKeyDown={handleKeyDown}
          onFocus={() => setIsFocused(true)}
          onBlur={() => setIsFocused(false)}
          placeholder={aiPhase === "loading" ? t("git.aiAnalyzing") : t("git.commitPlaceholder")}
          rows={1}
          className="font-sans text-[12px]"
          style={{
            flex: 1,
            minWidth: 0,
            resize: "none",
            minHeight: 20,
            maxHeight: 160,
            padding: 0,
            overflow: "auto",
            color: aiPhase === "loading" ? "#A855F7" : "var(--color-foreground)",
            backgroundColor: "transparent",
            border: "none",
            outline: "none",
            lineHeight: "20px",
            transition: "color 200ms, height 100ms ease-out",
          }}
        />

        {/* AiGenBtn — 28x28, matches Pencil node e5gbg */}
        <button
          ref={btnRef}
          key={shakeKey}
          onClick={handleGenerateMessage}
          onMouseEnter={() => setAiHover(true)}
          onMouseLeave={() => {
            setAiHover(false);
            setAiPressed(false);
          }}
          onPointerDown={() => setAiPressed(true)}
          onPointerUp={() => setAiPressed(false)}
          disabled={aiPhase === "loading" || isLoading}
          className={[
            "flex items-center justify-center ai-gen-btn",
            aiPhase === "loading" ? "ai-gen-loading" : "",
            aiPhase === "error" ? "ai-gen-error-shake" : "",
          ].join(" ")}
          style={{
            width: 28,
            height: 28,
            borderRadius: 6,
            background:
              aiPhase === "error" ? "linear-gradient(135deg, #EF4444, #EF4444)" : GRADIENT,
            boxShadow: btnShadow,
            transform: btnScale,
            cursor: aiPhase === "loading" ? "wait" : "pointer",
            transition:
              "transform 200ms cubic-bezier(0.34, 1.56, 0.64, 1), background 200ms ease, box-shadow 200ms ease-out",
            /* Glass border — inner box-shadow simulates gradient stroke
               since borderImage breaks borderRadius */
            outline: "none",
            border: "none",
            boxSizing: "border-box",
          }}
          title={hasError ? t("git.retryGenerate") : t("git.generateCommitMessage")}
        >
          {/* Glass border via inset shadow */}
          <span
            aria-hidden
            style={{
              position: "absolute",
              inset: 0,
              borderRadius: 6,
              boxShadow: "inset 0 0 0 1px rgba(255,255,255,0.22)",
              pointerEvents: "none",
              zIndex: 1,
            }}
          />

          {renderIcon()}

          {/* Error indicator dot (top-right, 6px) */}
          {hasError && aiPhase === "idle" && (
            <span
              className="ai-gen-error-dot"
              style={{
                position: "absolute",
                top: -2,
                right: -2,
                width: 6,
                height: 6,
                borderRadius: "50%",
                backgroundColor: "#EF4444",
                zIndex: 10,
              }}
            />
          )}
        </button>
      </div>

      {/* CommitBtnRow — matches Pencil node hE33Z */}
      <div className="flex items-center" style={{ gap: 8, position: "relative" }}>
        <button
          onClick={commitMode === "commit" ? handleCommit : handleCommitAndPush}
          disabled={!canCommit}
          className="flex items-center justify-center native-css-hover"
          style={
            {
              flex: 1,
              gap: 6,
              padding: "8px 0",
              borderRadius: 6,
              backgroundColor: canCommit ? "#A855F7" : "rgba(var(--theme-accent-rgb),0.251)",
              boxShadow: "none",
              cursor: canCommit ? "pointer" : "not-allowed",
              "--native-hover-bg-color": canCommit ? "#B96BFF" : undefined,
              "--native-hover-shadow": canCommit ? "0 0 12px rgba(var(--theme-accent-rgb),0.251)" : undefined,
            } as React.CSSProperties
          }
        >
          <Check size={14} style={{ color: "#FFFFFF" }} />
          <span className="text-[12px] font-semibold font-sans" style={{ color: "#FFFFFF" }}>
            {isLoading
              ? t("git.committing")
              : commitMode === "commit"
                ? t("git.commitOnly")
                : t("git.commitAndPush")}
          </span>
        </button>
        <button
          ref={menuBtnRef}
          onClick={() => setMenuOpen((v) => !v)}
          className="flex items-center justify-center native-css-hover"
          style={
            {
              padding: "8px 12px",
              borderRadius: 6,
              backgroundColor: menuOpen
                ? "var(--color-surface-raised)"
                : "var(--color-surface-alt)",
              border: `1px solid ${
                menuOpen ? "var(--color-border-light)" : "var(--color-border-subtle)"
              }`,
              "--native-hover-bg-color": "var(--color-surface-raised)",
              "--native-hover-border-color": "var(--color-border-light)",
            } as React.CSSProperties
          }
          title={t("git.commitOnly")}
        >
          <ChevronDown
            size={12}
            style={{
              color: menuOpen ? "var(--color-muted-foreground)" : "var(--color-muted)",
              transform: menuOpen ? "rotate(180deg)" : undefined,
              transition: "color 150ms, transform 150ms",
            }}
          />
        </button>

        {/* Dropdown menu */}
        {menuOpen && (
          <div
            ref={menuRef}
            className="flex flex-col"
            style={{
              position: "absolute",
              bottom: "calc(100% + 4px)",
              right: 0,
              minWidth: 180,
              padding: 4,
              borderRadius: 8,
              backgroundColor: "var(--color-surface-raised)",
              border: "1px solid var(--color-border-light)",
              boxShadow: "0 4px 16px rgba(0,0,0,0.25)",
              zIndex: 50,
            }}
          >
            <CommitMenuItem
              label={t("git.commitOnly")}
              shortcut="Ctrl+Enter"
              onClick={() => {
                setCommitMode("commit");
                setMenuOpen(false);
              }}
              active={commitMode === "commit"}
            />
            <CommitMenuItem
              label={t("git.commitAndPush")}
              onClick={() => {
                setCommitMode("commit-and-push");
                setMenuOpen(false);
              }}
              active={commitMode === "commit-and-push"}
            />
          </div>
        )}
      </div>
    </div>
  );
});
