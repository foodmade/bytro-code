import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import {
  EllipsisVertical,
  MessageSquare,
  Maximize2,
  ChevronRight,
  ChevronDown,
  Play,
  Square,
  FolderOpen,
  ArrowLeft,
  Pencil,
  Loader2,
} from "lucide-react";
import { useAppStore, useConversationStore, useWorkspaceStore } from "@/stores";
import { GitEntryButton } from "@/components/git/git-entry-button";
import { LiveReviewEntryButton } from "@/components/chat/live-review-entry-button";
import { usePreviewStore } from "@/stores/preview-store";
import { useDevServer, useInspector, useCompactMode } from "@/hooks";
import { PreviewPanel } from "@/components/preview/preview-panel";
import { PreviewToolbar } from "@/components/preview/preview-toolbar";
import { PreviewStatusBar } from "@/components/preview/preview-status-bar";
import { PreviewFileTree } from "@/components/preview/preview-file-tree";
import { ChatPanel } from "@/components/chat/chat-panel";
import { ErrorBoundary } from "@/components/ui";
import type { ChatStreamingOptions } from "@/hooks/use-chat-streaming";

interface MainAreaProps {
  readonly chatPanel?: React.ReactNode;
  readonly editorPanel?: React.ReactNode;
}

const ANSI_ESCAPE_SEQUENCE = new RegExp(String.raw`\u001B\[[0-9;]*[a-zA-Z]`, "g");

const PREVIEW_SYSTEM_PROMPT = `You are an expert React developer building a live-preview web application. The user can see the preview updating in real-time as you write files via Vite HMR.

## Step 1: MANDATORY — Use /frontend-design Skill First
Before writing ANY component code, you MUST call the /frontend-design skill with the project description.
- Pass the user's project description to /frontend-design to get a complete design system (colors, fonts, spacing, component styles)
- Base every component on the design output from /frontend-design
- **Do NOT skip this step and go straight to coding** — design-first ensures high-quality, cohesive UI

## Step 2: Real-Time Progressive Preview (Core Experience)
**Every time you create a visual component, you MUST immediately update App.tsx to import and render it.** The user must see each component appear in the preview the moment you finish writing it. Do NOT save App.tsx updates for the end.

### How it works:
- The preview window shows live updates via Vite HMR
- Components are ONLY visible if App.tsx (or a rendered parent) imports them
- Therefore: after every visual component → update App.tsx to show it

### Recommended build rhythm:
1. Call /frontend-design → Get complete design system
2. Create global styles (tailwind.config.js, index.css based on design) → Update App.tsx with a styled container → User sees theme colors
3. Create Header → Update App.tsx to add \`<Header />\` → User sees the nav bar
4. Create HeroSection → Update App.tsx to add \`<HeroSection />\` → User sees the hero area
5. Continue adding sections one by one, updating App.tsx each time
6. After all sections are done → Refactor App.tsx into React.lazy route structure

### Key rules:
- In early stages, App.tsx can use direct imports (no lazy needed). Refactor to lazy routes at the end.
- NEVER create a file that imports from a file you haven't created yet (causes Vite red error screen)

## Multi-Agent Parallel Strategy
Use /dispatching-parallel-agents to speed up independent work:
- **OK to parallelize**: Multiple agents writing independent leaf components (Button, Card, Input, etc.) that have no cross-imports
- **OK to parallelize**: One agent writes component code while another prepares mock data / test data
- **NEVER parallelize**: Files with dependency relationships (e.g. Layout depends on Header — write Header first)
- **NEVER parallelize**: Multiple agents editing App.tsx at the same time (will conflict)
- After parallel leaf components are done, the main agent updates App.tsx to import them all

## Project Structure
React 18 + Tailwind CSS 3 + TypeScript + Vite 5 (HMR enabled).

### File Writing Rules:
1. Write ONE COMPLETE file at a time using the Write tool. NEVER use diff/patch.
2. NEVER use \`...\` or ellipsis to skip implementation — this causes syntax errors.
3. NEVER write a file that imports from a file you haven't created yet.
4. After writing each visual component, state what the user should now see in the preview.

## Skill Usage Rules:
- **MANDATORY**: Call /frontend-design BEFORE writing any component code
- **RECOMMENDED**: Use /dispatching-parallel-agents for independent leaf components to speed up
- **ON-DEMAND**: Use /find-skills for other specialized capabilities
- **FORBIDDEN**: /writing-plans (causes pause), /brainstorming (causes pause)

## CRITICAL: @apply Rule in CSS
NEVER use \`@apply\` with custom color utility classes inside ANY \`@layer\` block. This includes:
- Custom backgrounds: \`@apply bg-surface-900\` ❌
- Custom text colors: \`@apply text-cream-100\` ❌
- Custom gradient stops: \`@apply from-apple-blue via-apple-teal to-apple-blue\` ❌ (most common failure)
- Reason: Tailwind v3 JIT has timing/resolution issues with @apply for custom color classes inside @layer, causing "class does not exist" errors
- Correct approach — use raw CSS inside @layer blocks:
  - Background: \`background-color: #0c0a08;\`
  - Gradient: \`background-image: linear-gradient(to right, #2997ff, #64d2ff, #2997ff);\`
  - Text gradient: \`-webkit-background-clip: text; color: transparent; background-image: ...;\`
- Custom classes work fine in JSX className (e.g. \`className="bg-surface-900 from-apple-blue"\`)

## Pre-installed Packages (use directly, no install needed)
react, react-dom, react-router-dom, framer-motion, zustand, axios, @tanstack/react-query, react-hook-form, zod, date-fns, lucide-react, clsx, tailwind-merge, recharts

If you need a package NOT in this list, STOP and ask the user first. Do NOT write code using uninstalled packages.

## Import Path Aliases
- \`@/\` → src/
- \`@ui/\` → src/components/ui/
- \`@store/\` → src/store/
- NEVER use relative paths deeper than \`../../\`
`;

const PREVIEW_CHAT_OPTIONS: ChatStreamingOptions = {
  systemPromptPrefix: PREVIEW_SYSTEM_PROMPT,
};

// ── Run Command Helpers ──────────────────────────────────────────────

function getRunCommandKey(workspacePath: string): string {
  return `run-command:${workspacePath}`;
}

function getBuildShortcutKey(workspacePath: string): string {
  return `build-shortcut:${workspacePath}`;
}

function getSavedRunCommand(workspacePath: string): string | null {
  try {
    return localStorage.getItem(getRunCommandKey(workspacePath));
  } catch {
    return null;
  }
}

function saveRunCommand(workspacePath: string, command: string): void {
  try {
    localStorage.setItem(getRunCommandKey(workspacePath), command);
  } catch {
    // localStorage not available
  }
}

function getSavedBuildShortcut(workspacePath: string): string | null {
  try {
    return localStorage.getItem(getBuildShortcutKey(workspacePath));
  } catch {
    return null;
  }
}

function saveBuildShortcut(workspacePath: string, shortcutId: string): void {
  try {
    localStorage.setItem(getBuildShortcutKey(workspacePath), shortcutId);
  } catch {
    // localStorage not available
  }
}

interface ProjectShortcut {
  readonly id: string;
  readonly label: string;
  readonly command: string;
  readonly source: string;
  readonly kind: string;
  readonly recommended: boolean;
}

const CUSTOM_SHORTCUT_ID = "__custom__";

// ── Module-level state for custom PTY sessions ─────────────────────
// These live outside React so they survive FullChatHeader remounts
// (normal view ↔ PreviewMode switches destroy/recreate the component).
let _customRunSessionId: string | null = null;
let _customPortDetected = false;

function getShortcutAccent(kind: string): {
  readonly color: string;
  readonly bg: string;
  readonly border: string;
} {
  switch (kind) {
    case "build":
      return { color: "#f59e0b", bg: "rgba(245,158,11,0.12)", border: "rgba(245,158,11,0.18)" };
    case "test":
      return { color: "#60a5fa", bg: "rgba(96,165,250,0.12)", border: "rgba(96,165,250,0.18)" };
    case "check":
      return { color: "#a78bfa", bg: "rgba(167,139,250,0.12)", border: "rgba(167,139,250,0.18)" };
    default:
      return { color: "#34d399", bg: "rgba(52,211,153,0.12)", border: "rgba(52,211,153,0.18)" };
  }
}

// ── Build Shortcut Popover ───────────────────────────────────────────

function BuildShortcutPopover({
  anchorRef,
  onClose,
  shortcuts,
  selectedShortcutId,
  isLoading,
  onSelectShortcut,
  onRunShortcut,
  onRunCustom,
  initialCommand,
}: {
  readonly anchorRef: React.RefObject<HTMLButtonElement | null>;
  readonly onClose: () => void;
  readonly shortcuts: ReadonlyArray<ProjectShortcut>;
  readonly selectedShortcutId: string | null;
  readonly isLoading: boolean;
  readonly onSelectShortcut: (shortcutId: string) => void;
  readonly onRunShortcut: (shortcut: ProjectShortcut) => void;
  readonly onRunCustom: (command: string) => void;
  readonly initialCommand: string;
}) {
  const { t } = useTranslation();
  const [command, setCommand] = useState(initialCommand);
  const popoverRef = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState<{ top: number; right: number } | null>(null);

  // Calculate position based on anchor element
  useEffect(() => {
    if (!anchorRef.current) return;
    const rect = anchorRef.current.getBoundingClientRect();
    setPosition({
      top: rect.bottom + 6,
      right: window.innerWidth - rect.right,
    });
  }, [anchorRef]);

  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (
        popoverRef.current &&
        !popoverRef.current.contains(e.target as Node) &&
        anchorRef.current &&
        !anchorRef.current.contains(e.target as Node)
      ) {
        onClose();
      }
    };
    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("mousedown", handleClickOutside);
    document.addEventListener("keydown", handleEscape);
    return () => {
      document.removeEventListener("mousedown", handleClickOutside);
      document.removeEventListener("keydown", handleEscape);
    };
  }, [onClose, anchorRef]);

  const handleRunShortcut = useCallback(
    (shortcut: ProjectShortcut) => {
      // Click-to-run: select + run + close in a single tap, IDE-style.
      onSelectShortcut(shortcut.id);
      onRunShortcut(shortcut);
      onClose();
    },
    [onSelectShortcut, onRunShortcut, onClose],
  );

  const handleRunManual = useCallback(() => {
    const trimmed = command.trim();
    if (trimmed) {
      onSelectShortcut(CUSTOM_SHORTCUT_ID);
      onRunCustom(trimmed);
      onClose();
    }
  }, [command, onRunCustom, onSelectShortcut, onClose]);

  const handleCmdKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "Enter") {
        e.preventDefault();
        handleRunManual();
      }
    },
    [handleRunManual],
  );

  if (!position) return null;

  return (
    <div
      ref={popoverRef}
      className="fixed z-50 build-shortcut-popover"
      style={{
        top: position.top,
        right: position.right,
        width: 320,
      }}
    >
      <div className="build-shortcut-popover-header">
        <div className="build-shortcut-popover-title">{t("mainArea.buildMenuTitle")}</div>
      </div>

      <div className="build-shortcut-list">
        {isLoading ? (
          <div className="build-shortcut-empty">{t("mainArea.buildMenuScanning")}</div>
        ) : shortcuts.length === 0 ? (
          <div className="build-shortcut-empty">{t("mainArea.buildMenuEmpty")}</div>
        ) : (
          shortcuts.map((shortcut) => {
            const accent = getShortcutAccent(shortcut.kind);
            const isSelected = shortcut.id === selectedShortcutId;
            return (
              <button
                key={shortcut.id}
                type="button"
                onClick={() => handleRunShortcut(shortcut)}
                className={`build-shortcut-item${isSelected ? " is-selected" : ""}`}
                style={{
                  ["--shortcut-accent" as string]: accent.color,
                  ["--shortcut-accent-bg" as string]: accent.bg,
                  ["--shortcut-accent-border" as string]: accent.border,
                }}
              >
                <div className="build-shortcut-item-main">
                  <div className="build-shortcut-item-title-row">
                    <span className="build-shortcut-item-title">{shortcut.label}</span>
                  </div>
                  <div className="build-shortcut-item-command">{shortcut.command}</div>
                </div>
                {isSelected && <div className="build-shortcut-item-marker" />}
              </button>
            );
          })
        )}
      </div>

      <div className="build-shortcut-custom">
        <div className="flex items-center" style={{ gap: 8 }}>
          <input
            value={command}
            onChange={(e) => setCommand(e.target.value)}
            onKeyDown={handleCmdKeyDown}
            placeholder={t("mainArea.buildCustomPlaceholder")}
            className="flex-1 font-mono outline-none"
            style={{
              fontSize: 12,
              padding: "6px 10px",
              borderRadius: 6,
              backgroundColor: "var(--color-surface-inset)",
              border: "1px solid var(--color-border)",
              color: "var(--color-foreground)",
            }}
          />
          <button
            onClick={handleRunManual}
            disabled={!command.trim()}
            className="shrink-0 font-sans transition-colors"
            style={{
              fontSize: 12,
              fontWeight: 600,
              padding: "6px 12px",
              borderRadius: 6,
              color: "#fff",
              backgroundColor: "#22c55e",
              border: "none",
              cursor: command.trim() ? "pointer" : "default",
              opacity: command.trim() ? 1 : 0.5,
            }}
          >
            {t("mainArea.buildRunCustom")}
          </button>
        </div>
      </div>
    </div>
  );
}

function Breadcrumb({ filePath }: { readonly filePath: string }) {
  const sep = filePath.includes("\\") ? "\\" : "/";
  const parts = filePath.split(sep);
  const visible = parts.length > 4 ? parts.slice(-4) : parts;

  return (
    <div className="flex items-center shrink-0 overflow-hidden gap-1 px-4 py-1.5 bg-topbar border-b border-border">
      {visible.map((part, i) => (
        <span key={i} className="flex items-center gap-1 shrink-0">
          {i > 0 && <ChevronRight size={10} className="text-text-placeholder shrink-0" />}
          <span
            className="text-[11px] font-sans"
            style={{
              color:
                i === visible.length - 1
                  ? "var(--color-muted-foreground)"
                  : "var(--color-text-tertiary)",
              fontWeight: i === visible.length - 1 ? 500 : 400,
            }}
          >
            {part}
          </span>
        </span>
      ))}
    </div>
  );
}

function EditorChatResizeHandle({ onResize }: { readonly onResize: (delta: number) => void }) {
  const isDragging = useRef(false);
  const lastX = useRef(0);

  const handleMouseDown = useCallback(
    (e: React.MouseEvent) => {
      isDragging.current = true;
      lastX.current = e.clientX;

      const handleMouseMove = (ev: MouseEvent) => {
        if (!isDragging.current) return;
        const delta = ev.clientX - lastX.current;
        lastX.current = ev.clientX;
        onResize(-delta);
      };

      const handleMouseUp = () => {
        isDragging.current = false;
        document.removeEventListener("mousemove", handleMouseMove);
        document.removeEventListener("mouseup", handleMouseUp);
        document.body.style.cursor = "";
        document.body.style.userSelect = "";
      };

      document.addEventListener("mousemove", handleMouseMove);
      document.addEventListener("mouseup", handleMouseUp);
      document.body.style.cursor = "col-resize";
      document.body.style.userSelect = "none";
    },
    [onResize],
  );

  return (
    <div
      className="no-press-scale shrink-0 cursor-col-resize hover:bg-accent-purple/30 active:bg-accent-purple/50 transition-colors flex items-center justify-center group"
      style={{ width: 5, position: "relative" }}
      onMouseDown={handleMouseDown}
    >
      {/* Wider invisible hit area for easier grabbing */}
      <div className="absolute inset-y-0 -left-2 -right-2" style={{ cursor: "col-resize" }} />
      <div className="w-px h-full bg-border-light group-hover:bg-accent-purple/50 transition-colors" />
    </div>
  );
}

function SplitChatHeader() {
  const { t } = useTranslation();
  const closeEditor = useAppStore((s) => s.closeEditor);
  const isSidebarVisible = useAppStore((s) => s.isSidebarVisible);
  const toggleSidebar = useAppStore((s) => s.toggleSidebar);
  const setActiveView = useAppStore((s) => s.setActiveView);
  const handleBackToWorkspace = useCallback(() => {
    setActiveView("workspace");
  }, [setActiveView]);

  return (
    <div
      data-tauri-drag-region
      className="flex items-center justify-between shrink-0 h-[44px] px-4 border-b border-border"
    >
      <div className="flex items-center gap-2">
        <button
          onClick={handleBackToWorkspace}
          className="flex items-center justify-center shrink-0 transition-colors hover:bg-hover-overlay/[0.06]"
          title={t("workspace.backToWorkspace", "Back to Workspace")}
          style={{
            width: 24,
            height: 24,
            borderRadius: 4,
            background: "none",
            border: "none",
            cursor: "pointer",
          }}
        >
          <ArrowLeft size={14} style={{ color: "var(--color-accent-purple)" }} />
        </button>
        {!isSidebarVisible && (
          <button
            onClick={toggleSidebar}
            className="flex items-center justify-center shrink-0 transition-all duration-150 hover:bg-border/30 hover:text-foreground"
            title={t("workspace.expandSidebar")}
            style={{
              width: 24,
              height: 24,
              borderRadius: 4,
              border: "none",
              cursor: "pointer",
            }}
          >
            <FolderOpen size={14} className="text-text-tertiary transition-colors" />
          </button>
        )}
        <MessageSquare size={14} className="text-accent-purple" />
        <span className="text-[13px] font-semibold text-foreground font-sans">
          {t("mainArea.chat")}
        </span>
      </div>
      <div className="flex items-center gap-2">
        <button
          onClick={closeEditor}
          className="text-text-tertiary hover:text-muted-foreground transition-colors"
          title={t("mainArea.maximizeChat")}
        >
          <Maximize2 size={14} />
        </button>
        <button className="text-text-tertiary hover:text-muted-foreground transition-colors">
          <EllipsisVertical size={14} />
        </button>
      </div>
    </div>
  );
}

function FullChatHeader() {
  const { t } = useTranslation();
  const renameConversation = useConversationStore((s) => s.renameConversation);
  const isSidebarVisible = useAppStore((s) => s.isSidebarVisible);
  const toggleSidebar = useAppStore((s) => s.toggleSidebar);
  const [isEditing, setIsEditing] = useState(false);
  const [editTitle, setEditTitle] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const isCancelledRef = useRef(false);
  const [headerEl, setHeaderEl] = useState<HTMLDivElement | null>(null);
  const isCompact = useCompactMode(headerEl);

  const setPreviewVisible = usePreviewStore((s) => s.setPreviewVisible);
  const devServerStatus = usePreviewStore((s) => s.devServerStatus);
  const setDevServerStatus = usePreviewStore((s) => s.setDevServerStatus);
  const setRuntimeOwner = usePreviewStore((s) => s.setRuntimeOwner);
  const registerStopPreviewRuntime = usePreviewStore((s) => s.registerStopPreviewRuntime);
  const workspacePath = useWorkspaceStore((s) => s.activeWorkspace?.path);
  const isPreviewRunning = devServerStatus === "running" || devServerStatus === "starting";
  const { start, stop } = useDevServer();
  const addViteError = usePreviewStore((s) => s.addViteError);
  const [isRunPopoverOpen, setIsRunPopoverOpen] = useState(false);
  const [isShortcutScanLoading, setIsShortcutScanLoading] = useState(false);
  const [projectShortcuts, setProjectShortcuts] = useState<ReadonlyArray<ProjectShortcut>>([]);
  const [selectedShortcutId, setSelectedShortcutId] = useState<string | null>(null);
  // Initialize from module-level state so remounted instances pick up the
  // running state from a previous FullChatHeader that was unmounted.
  const [customRunning, setCustomRunning] = useState(() => _customRunSessionId !== null);
  const runBtnRef = useRef<HTMLButtonElement>(null);
  // Track which terminal session is running our custom command.
  // Uses module-level _customRunSessionId as the source of truth
  // (refs are lost when the component remounts during view switches).
  const runSessionIdRef = useRef<string | null>(_customRunSessionId);
  const setRunSessionId = useCallback((id: string | null) => {
    runSessionIdRef.current = id;
    _customRunSessionId = id;
  }, []);
  // Track whether a port has been detected (dev server is running)
  const portDetectedRef = useRef(_customPortDetected);
  const setPortDetected = useCallback((v: boolean) => {
    portDetectedRef.current = v;
    _customPortDetected = v;
  }, []);
  // Cleanup function for the port detection listener (managed outside useEffect)
  const portListenerCleanupRef = useRef<(() => void) | null>(null);

  // Check if the workspace has the .bytro-preview marker (build project).
  // IMPORTANT: reset synchronously before the async check to prevent a stale
  // `true` from the previous workspace being visible during the IPC round-trip.
  const [isBuildProject, setIsBuildProject] = useState(false);
  const prevWorkspaceRef = useRef<string | undefined>(undefined);
  const selectedShortcut = useMemo(
    () => projectShortcuts.find((shortcut) => shortcut.id === selectedShortcutId) ?? null,
    [projectShortcuts, selectedShortcutId],
  );

  useEffect(() => {
    const prev = prevWorkspaceRef.current;
    prevWorkspaceRef.current = workspacePath;

    // Reset immediately so handleRunClick never sees a stale value
    setIsBuildProject(false);

    // When switching workspaces, clean up all running services from the
    // previous workspace to avoid zombie processes and stale previews.
    if (prev && prev !== workspacePath) {
      const ps = usePreviewStore.getState();
      void ps.stopPreviewRuntime().finally(() => {
        setPreviewVisible(false);
      });
    }

    if (!workspacePath) return;

    invoke<boolean>("is_preview_project", { projectPath: workspacePath })
      .then((isBuild) => {
        setIsBuildProject(isBuild);
        // Sync preview store's projectPath with the active workspace so that
        // start_dev_server always runs in the correct directory.
        if (isBuild) {
          const current = usePreviewStore.getState().projectPath;
          if (current !== workspacePath) {
            usePreviewStore.getState().setProjectPath(workspacePath);
          }
        }
      })
      .catch(() => setIsBuildProject(false));
  }, [workspacePath, setPreviewVisible]);

  useEffect(() => {
    if (!workspacePath || isBuildProject) {
      setIsShortcutScanLoading(false);
      setProjectShortcuts([]);
      setSelectedShortcutId(null);
      return;
    }

    let cancelled = false;
    setIsShortcutScanLoading(true);

    invoke<ProjectShortcut[]>("scan_project_run_shortcuts", { projectPath: workspacePath })
      .then((shortcuts) => {
        if (cancelled) return;
        setProjectShortcuts(shortcuts);
        const savedId = getSavedBuildShortcut(workspacePath);
        const resolvedSelection =
          savedId === CUSTOM_SHORTCUT_ID && getSavedRunCommand(workspacePath)
            ? CUSTOM_SHORTCUT_ID
            : savedId && shortcuts.some((shortcut) => shortcut.id === savedId)
              ? savedId
              : (shortcuts.find((shortcut) => shortcut.recommended)?.id ??
                shortcuts[0]?.id ??
                (getSavedRunCommand(workspacePath) ? CUSTOM_SHORTCUT_ID : null));
        setSelectedShortcutId(resolvedSelection);
      })
      .catch(() => {
        if (cancelled) return;
        console.error("[preview] failed to scan project shortcuts");
        setProjectShortcuts([]);
        setSelectedShortcutId(getSavedRunCommand(workspacePath) ? CUSTOM_SHORTCUT_ID : null);
      })
      .finally(() => {
        if (!cancelled) setIsShortcutScanLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [workspacePath, isBuildProject]);

  const selectShortcut = useCallback(
    (shortcutId: string) => {
      setSelectedShortcutId(shortcutId);
      if (workspacePath) {
        saveBuildShortcut(workspacePath, shortcutId);
      }
    },
    [workspacePath],
  );

  const handleTogglePreview = useCallback(() => {
    if (isPreviewRunning) {
      void usePreviewStore
        .getState()
        .stopPreviewRuntime()
        .finally(() => {
          setPreviewVisible(false);
        });
    } else {
      setPreviewVisible(true);
      void start();
    }
  }, [isPreviewRunning, start, setPreviewVisible]);

  // Listen for pty-output to detect when a short-lived command finishes (shell prompt returns).
  // Skipped when a port has been detected (dev server keeps running and its output
  // contains ">" chars that would cause false-positive prompt matches).
  useEffect(() => {
    if (!customRunning || !runSessionIdRef.current) return;

    const sessionId = runSessionIdRef.current;
    let unlisten: (() => void) | null = null;
    let buffer = "";
    // Skip initial output for 3s to avoid matching the shell's own prompt
    // or echoed cd/command lines. Timeline: T=0 spawn, T=300ms cd sent,
    // T=500ms actual command sent, T=1-2s npm/vite startup output.
    const startTime = Date.now();
    const SKIP_WINDOW_MS = 3000;

    const setup = async () => {
      unlisten = await listen<{ session_id: string; data: string }>("pty-output", ({ payload }) => {
        if (payload.session_id !== sessionId) return;
        // Once a port is detected, the process is a long-running dev server — skip prompt detection
        if (portDetectedRef.current) return;
        // Ignore output during the startup window
        if (Date.now() - startTime < SKIP_WINDOW_MS) return;
        buffer = (buffer + payload.data).slice(-200);
        const clean = buffer.replace(ANSI_ESCAPE_SEQUENCE, "");
        // Match Windows prompt: line starting with drive letter path ending with ">"
        // Match Unix prompt: line ending with "$" or "#"
        if (/^[A-Z]:\\[^>]*>\s*$/m.test(clean) || /[$#]\s*$/m.test(clean)) {
          setCustomRunning(false);
          setRunSessionId(null);
          setPortDetected(false);
          const ps = usePreviewStore.getState();
          if (ps.runtimeOwner === "pty") {
            portListenerCleanupRef.current?.();
            portListenerCleanupRef.current = null;
            ps.resetPreviewSession();
          }
        }
      });
    };
    setup();

    return () => {
      unlisten?.();
    };
  }, [customRunning, setRunSessionId]);

  // Also listen for pty-exit to reset running state
  useEffect(() => {
    if (!customRunning || !runSessionIdRef.current) return;

    const sessionId = runSessionIdRef.current;
    let unlisten: (() => void) | null = null;

    const setup = async () => {
      unlisten = await listen<{ session_id: string }>("pty-exit", ({ payload }) => {
        if (payload.session_id === sessionId) {
          setCustomRunning(false);
          setRunSessionId(null);
          setPortDetected(false);
          portListenerCleanupRef.current?.();
          portListenerCleanupRef.current = null;
          const ps = usePreviewStore.getState();
          if (ps.runtimeOwner === "pty") {
            ps.resetPreviewSession();
          }
        }
      });
    };
    setup();

    return () => {
      unlisten?.();
    };
  }, [customRunning, setRunSessionId]);

  const executeCustomCommand = useCallback(
    async (command: string, shortcutId = CUSTOM_SHORTCUT_ID) => {
      if (!workspacePath) return;
      saveRunCommand(workspacePath, command);
      saveBuildShortcut(workspacePath, shortcutId);
      setSelectedShortcutId(shortcutId);
      setIsRunPopoverOpen(false);

      // Kill existing PTY session before spawning a new one to prevent zombie processes
      const oldSession = runSessionIdRef.current;
      if (oldSession) {
        await invoke("kill_pty", { sessionId: oldSession }).catch(() => {});
        setRunSessionId(null);
        setPortDetected(false);
        const ps = usePreviewStore.getState();
        if (ps.runtimeOwner === "pty") {
          ps.resetPreviewSession();
        }
      }

      // Clean up any previous port detection listener
      portListenerCleanupRef.current?.();
      portListenerCleanupRef.current = null;

      try {
        const sessionId = await invoke<string>("spawn_pty", {
          shell: null,
          cwd: workspacePath,
          rows: 24,
          cols: 80,
        });

        setRunSessionId(sessionId);
        setPortDetected(false);

        // Register port detection listener BEFORE setting state to avoid
        // race conditions with useEffect-based registration (async listen()
        // could miss events if customRunning is reset before listener is ready).
        const unlisten = await listen<{ session_id: string; port: number; url: string }>(
          "pty-port-detected",
          ({ payload }) => {
            if (payload.session_id !== sessionId) return;
            if (portDetectedRef.current) return;
            setPortDetected(true);
            // Reinforce running state — prevents prompt detection from
            // resetting the button before port detection fires
            setCustomRunning(true);
            const ps = usePreviewStore.getState();
            // Set runtimeOwner first so the proxy decision in ensureFrameForUrl
            // (triggered by setPreviewUrl/setDevServerPort) sees the correct
            // owner. Otherwise it may inherit a stale "builtin" from a prior
            // session and skip the proxy.
            ps.setRuntimeOwner("pty");
            ps.setPreviewUrl(payload.url);
            ps.setDevServerPort(payload.port);
            ps.setDevServerStatus("running");
            ps.setPreviewVisible(true);
          },
        );
        portListenerCleanupRef.current = () => {
          unlisten();
        };

        // Set running state immediately so UI shows Stop button
        setCustomRunning(true);

        // Small delay to let PTY fully initialize, then ensure cwd and send command.
        // On Windows, portable-pty's cwd may not reliably switch drives, so we
        // explicitly send "cd /d <path>" before the user command.
        setTimeout(() => {
          const isWin = navigator.platform.startsWith("Win");
          const cdCmd = isWin ? `cd /d "${workspacePath}"\r` : `cd "${workspacePath}"\r`;
          invoke("write_pty", { sessionId, data: cdCmd }).catch(() => {});
          // Send the actual command after cd completes
          setTimeout(() => {
            invoke("write_pty", { sessionId, data: `${command}\r` }).catch(() => {});
          }, 200);
        }, 300);
      } catch {
        console.error("[preview] failed to start custom runtime");
      }
    },
    [workspacePath, setRunSessionId, setPortDetected],
  );

  const runShortcut = useCallback(
    (shortcut: ProjectShortcut) => {
      selectShortcut(shortcut.id);
      void executeCustomCommand(shortcut.command, shortcut.id);
    },
    [executeCustomCommand, selectShortcut],
  );

  const handleStopCustom = useCallback(async () => {
    const sessionId = runSessionIdRef.current;
    try {
      if (sessionId) {
        // Kill PTY session immediately via taskkill /T /F on Windows.
        // DO NOT send Ctrl+C first — it would kill the shell before
        // taskkill can enumerate its child tree, leaving node/vite as
        // orphan processes that keep occupying the port.
        await invoke("kill_pty", { sessionId });
      }
    } catch {
      console.error("[preview] failed to stop custom runtime");
      addViteError("Failed to stop preview runtime");
    } finally {
      setCustomRunning(false);
      setRunSessionId(null);
      setPortDetected(false);
      portListenerCleanupRef.current?.();
      portListenerCleanupRef.current = null;

      const ps = usePreviewStore.getState();
      if (ps.runtimeOwner === "pty") {
        setRuntimeOwner("none");
        if (ps.devServerStatus === "running" || ps.devServerStatus === "starting") {
          setDevServerStatus("idle");
        }
      }
    }
  }, [addViteError, setDevServerStatus, setPortDetected, setRunSessionId, setRuntimeOwner]);

  const handleStopPreviewRuntime = useCallback(async () => {
    const ps = usePreviewStore.getState();
    const owner = ps.runtimeOwner;
    const isActive = ps.devServerStatus === "running" || ps.devServerStatus === "starting";

    try {
      if (owner === "builtin") {
        await stop();
      } else if (owner === "pty") {
        await handleStopCustom();
      } else if (isActive || runSessionIdRef.current) {
        await invoke("stop_dev_server").catch(() => {});
        await handleStopCustom();
      }
    } finally {
      usePreviewStore.getState().resetPreviewSession();
    }
  }, [handleStopCustom, stop]);

  // Register handleStopCustom so PreviewMode and PreviewStatusBar can call it
  const registerStopCustomRun = usePreviewStore((s) => s.registerStopCustomRun);
  useEffect(() => {
    registerStopCustomRun(handleStopCustom);
    return () => registerStopCustomRun(null);
  }, [registerStopCustomRun, handleStopCustom]);

  useEffect(() => {
    registerStopPreviewRuntime(handleStopPreviewRuntime);
    return () => registerStopPreviewRuntime(null);
  }, [handleStopPreviewRuntime, registerStopPreviewRuntime]);

  const handleRunClick = useCallback(() => {
    const savedCommand = workspacePath ? getSavedRunCommand(workspacePath) : null;
    if (isBuildProject) {
      handleTogglePreview();
      return;
    }

    if (customRunning) {
      void handleStopCustom();
      return;
    }

    if (!workspacePath) return;
    if (selectedShortcut) {
      runShortcut(selectedShortcut);
      return;
    }

    if (selectedShortcutId === CUSTOM_SHORTCUT_ID && savedCommand) {
      void executeCustomCommand(savedCommand);
    } else if (!selectedShortcutId && savedCommand) {
      void executeCustomCommand(savedCommand);
    } else {
      setIsRunPopoverOpen(true);
    }
  }, [
    isBuildProject,
    handleTogglePreview,
    customRunning,
    handleStopCustom,
    workspacePath,
    executeCustomCommand,
    selectedShortcut,
    selectedShortcutId,
    runShortcut,
  ]);

  const handleRunContextMenu = useCallback(
    (e: React.MouseEvent) => {
      if (isBuildProject) return;
      e.preventDefault();
      setIsRunPopoverOpen(true);
    },
    [isBuildProject],
  );

  const isRunning = isBuildProject ? isPreviewRunning : customRunning;

  const activeConvId = useConversationStore((s) => s.activeConversationId);
  const activeTitle = useConversationStore((s) => {
    if (!s.activeConversationId) return undefined;
    return s.conversations.find((c) => c.id === s.activeConversationId)?.title;
  });
  const title = activeTitle ?? t("chat.newSession");

  const handleStartEdit = useCallback(() => {
    if (!activeConvId) return;
    setEditTitle(activeTitle ?? "");
    setIsEditing(true);
  }, [activeConvId, activeTitle]);

  const handleSubmitRename = useCallback(() => {
    if (isCancelledRef.current) {
      isCancelledRef.current = false;
      return;
    }
    const trimmed = editTitle.trim();
    if (trimmed && trimmed !== activeTitle && activeConvId) {
      renameConversation(activeConvId, trimmed);
    }
    setIsEditing(false);
  }, [editTitle, activeTitle, activeConvId, renameConversation]);

  const handleCancelEdit = useCallback(() => {
    isCancelledRef.current = true;
    setIsEditing(false);
  }, []);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "Enter") {
        e.preventDefault();
        handleSubmitRename();
      } else if (e.key === "Escape") {
        e.preventDefault();
        handleCancelEdit();
      }
    },
    [handleSubmitRename, handleCancelEdit],
  );

  useEffect(() => {
    if (isEditing && inputRef.current) {
      inputRef.current.focus();
      inputRef.current.select();
    }
  }, [isEditing]);

  return (
    <div
      ref={setHeaderEl}
      data-tauri-drag-region
      className="flex items-center justify-between shrink-0 overflow-hidden"
      style={{
        height: 52,
        padding: "0 16px",
        borderBottom: "1px solid var(--color-border)",
      }}
    >
      {/* Left: back + sidebar toggle + title + badge */}
      <div className="flex items-center min-w-0" style={{ gap: 8 }}>
        {!isSidebarVisible && (
          <button
            onClick={toggleSidebar}
            className="flex items-center justify-center shrink-0 transition-all duration-150 hover:bg-border/30 hover:text-foreground"
            title={t("workspace.expandSidebar")}
            style={{
              width: 28,
              height: 28,
              borderRadius: 6,
              border: "none",
              cursor: "pointer",
            }}
          >
            <FolderOpen size={16} className="text-text-tertiary transition-colors" />
          </button>
        )}
        {isEditing ? (
          <input
            ref={inputRef}
            value={editTitle}
            onChange={(e) => setEditTitle(e.target.value)}
            onBlur={handleSubmitRename}
            onKeyDown={handleKeyDown}
            maxLength={100}
            className="font-sans min-w-0 bg-transparent border-b border-accent-purple outline-none"
            style={{
              fontSize: 14,
              fontWeight: 600,
              color: "var(--color-foreground)",
              padding: "2px 0",
            }}
          />
        ) : (
          <span
            className={`font-sans truncate transition-opacity inline-flex items-center gap-1.5 ${activeConvId ? "cursor-pointer group/title hover:opacity-70" : ""}`}
            style={{
              fontSize: 14,
              fontWeight: 600,
              color: "var(--color-foreground)",
            }}
            onClick={activeConvId ? handleStartEdit : undefined}
            title={activeConvId ? t("chat.contextMenu.rename") : undefined}
          >
            {title}
            {activeConvId && (
              <Pencil
                size={12}
                className="shrink-0 opacity-0 group-hover/title:opacity-60 transition-opacity"
                style={{ color: "var(--color-muted)" }}
              />
            )}
          </span>
        )}
      </div>

      {/* Right: Run + Git — per design qXpQ1 */}
      <div className="flex items-center shrink-0" style={{ gap: 14 }}>
        {workspacePath && (
          <>
            <div
              className={`build-action-shell${isRunning ? " is-running" : ""}${isRunPopoverOpen ? " is-open" : ""}`}
            >
              <button
                ref={runBtnRef}
                onClick={handleRunClick}
                onContextMenu={handleRunContextMenu}
                className="build-action-primary"
                title={
                  isRunning
                    ? isBuildProject
                      ? t("mainArea.previewStop")
                      : t("mainArea.stop")
                    : t("mainArea.build")
                }
              >
                {isRunning ? (
                  <Square size={13} style={{ fill: "currentColor" }} />
                ) : (
                  <Play size={13} style={{ fill: "currentColor" }} />
                )}
                {!isBuildProject && selectedShortcut && (
                  <span className="build-action-badge">{selectedShortcut.label}</span>
                )}
                {!isBuildProject &&
                  !selectedShortcut &&
                  selectedShortcutId === CUSTOM_SHORTCUT_ID && (
                    <span className="build-action-badge">{t("mainArea.buildCustomShort")}</span>
                  )}
              </button>
              {!isBuildProject && (
                <button
                  type="button"
                  onClick={() => setIsRunPopoverOpen((open) => !open)}
                  className="build-action-trigger"
                  title={t("mainArea.buildSelectScript")}
                >
                  {isShortcutScanLoading ? (
                    <Loader2 size={13} className="animate-spin" />
                  ) : (
                    <ChevronDown size={13} />
                  )}
                </button>
              )}
            </div>
          </>
        )}
        {isRunPopoverOpen && workspacePath && (
          <BuildShortcutPopover
            anchorRef={runBtnRef}
            shortcuts={projectShortcuts}
            selectedShortcutId={selectedShortcutId}
            isLoading={isShortcutScanLoading}
            initialCommand={getSavedRunCommand(workspacePath) ?? ""}
            onSelectShortcut={selectShortcut}
            onClose={() => setIsRunPopoverOpen(false)}
            onRunShortcut={runShortcut}
            onRunCustom={(command) => {
              void executeCustomCommand(command);
            }}
          />
        )}
        <LiveReviewEntryButton compact={isCompact} />
        <GitEntryButton compact={isCompact} />
      </div>
    </div>
  );
}

const MIN_CHAT_RATIO = 0.4; // Chat area must occupy at least 40% of total width

function PreviewMode() {
  // Preview state
  const isPreviewVisible = usePreviewStore((s) => s.isPreviewVisible);
  const projectPath = usePreviewStore((s) => s.projectPath);
  const previewChatWidth = usePreviewStore((s) => s.previewChatWidth);
  const setPreviewChatWidth = usePreviewStore((s) => s.setPreviewChatWidth);
  const setPreviewVisible = usePreviewStore((s) => s.setPreviewVisible);
  const stopPreviewRuntime = usePreviewStore((s) => s.stopPreviewRuntime);

  // Container ref for percentage-based width constraints
  const containerRef = useRef<HTMLDivElement>(null);

  // Dev server lifecycle
  const { start, syncStatus } = useDevServer();
  const iframeRef = useRef<HTMLIFrameElement>(null);

  // File tree
  const [fileTreeVisible, setFileTreeVisible] = useState(false);
  const [selectedFile, setSelectedFile] = useState<string | null>(null);
  const toggleFileTree = useCallback(() => setFileTreeVisible((v) => !v), []);
  const handleFileSelect = useCallback((path: string) => setSelectedFile(path), []);

  // DOM Inspector
  const setSelectedElement = usePreviewStore((s) => s.setSelectedElement);
  const registerInspectorClear = usePreviewStore((s) => s.registerInspectorClear);
  const {
    active: inspectorActive,
    selected,
    toggle: toggleInspector,
    clearSelected,
  } = useInspector(iframeRef);

  // Register inspector's clearSelected so the store can clear both sides
  useEffect(() => {
    registerInspectorClear(clearSelected);
  }, [registerInspectorClear, clearSelected]);

  // Sync selected element to store for ChatPanel to consume
  useEffect(() => {
    setSelectedElement(selected);
  }, [selected, setSelectedElement]);

  // Sync dev server status from Rust backend then auto-start if idle.
  // Skip auto-start when the preview was opened by port detection (PTY-based
  // dev server) — in that case devServerStatus is already "running" and we
  // must NOT call syncStatus() which would overwrite it with "idle" from the
  // Rust backend (which only tracks the built-in dev server).
  const initDone = useRef(false);
  useEffect(() => {
    if (!isPreviewVisible || !projectPath || initDone.current) return;
    initDone.current = true;

    // If already running (e.g., port detection set this), don't interfere
    const { devServerStatus: current, runtimeOwner: owner } = usePreviewStore.getState();
    if (owner === "pty" || current === "running") {
      return;
    }

    // Wait for syncStatus to complete before deciding whether to auto-start
    syncStatus()
      .then(() => {
        const { devServerStatus: actual } = usePreviewStore.getState();
        if (actual === "idle" || actual === "error") {
          start();
        }
      })
      .catch(() => {
        // syncStatus failed — try starting anyway since backend may be clean
        const { devServerStatus: actual } = usePreviewStore.getState();
        if (actual === "idle" || actual === "error") {
          start();
        }
      });
  }, [isPreviewVisible, projectPath, syncStatus, start]);

  // Reset init flag when preview is hidden or project changes so re-opening
  // (or switching to a new build project) can restart the dev server.
  const prevProjectRef = useRef(projectPath);
  useEffect(() => {
    if (!isPreviewVisible) {
      initDone.current = false;
    }
    if (prevProjectRef.current !== projectPath) {
      prevProjectRef.current = projectPath;
      initDone.current = false;
    }
  }, [isPreviewVisible, projectPath]);

  // Stop dev server when leaving chat view
  const activeView = useAppStore((s) => s.activeView);
  useEffect(() => {
    if (activeView !== "chat" && activeView !== "editor") {
      const { devServerStatus: currentStatus, runtimeOwner: owner } = usePreviewStore.getState();
      if (currentStatus === "running" || currentStatus === "starting" || owner !== "none") {
        void stopPreviewRuntime();
      }
    }
  }, [activeView, stopPreviewRuntime]);

  // Safety net: stop dev server when PreviewMode unmounts
  useEffect(() => {
    return () => {
      const ps = usePreviewStore.getState();
      if (
        ps.devServerStatus === "running" ||
        ps.devServerStatus === "starting" ||
        ps.runtimeOwner !== "none"
      ) {
        void ps.stopPreviewRuntime();
      }
    };
  }, []);

  const reloadIframe = useCallback(() => {
    // Drop the current frame URL so PreviewPanel unmounts the iframe and
    // shows the loading placeholder, then re-resolve the frame URL. For
    // proxy-mode previews `ensureFrameForUrl` mints a fresh session id, so
    // even an unchanged target reloads cleanly. For build projects (direct
    // connect) the URL is the same but the unmount/remount cycle still
    // forces a reload via React.
    const ps = usePreviewStore.getState();
    const url = ps.previewUrl;
    ps.setFramePreviewUrl(null);
    void ps.ensureFrameForUrl(url);
  }, []);

  const handleRefresh = reloadIframe;

  // Auto-refresh iframe when Vite errors are resolved (signal from useViteErrorFeedback)
  const refreshSignal = usePreviewStore((s) => s.refreshSignal);
  useEffect(() => {
    if (refreshSignal > 0) {
      const timer = setTimeout(reloadIframe, 500);
      return () => clearTimeout(timer);
    }
  }, [refreshSignal, reloadIframe]);

  const setPreviewUrl = usePreviewStore((s) => s.setPreviewUrl);

  const handleNavigate = useCallback(
    (url: string) => {
      setPreviewUrl(url);
      // store 内部异步触发 ensureFrameForUrl,React 会在 framePreviewUrl 变化后
      // 自动让 iframe 加载新代理 URL(常规项目)或新原始 URL(构建项目)。
      // 同 URL 想强制刷新走 reloadIframe 按钮。
    },
    [setPreviewUrl],
  );

  const handleClosePreview = useCallback(() => {
    void stopPreviewRuntime().finally(() => {
      setPreviewVisible(false);
    });
  }, [setPreviewVisible, stopPreviewRuntime]);

  // Resize handle for preview mode (negative delta = chat gets wider)
  const handlePreviewResize = useCallback(
    (delta: number) => {
      const current = usePreviewStore.getState().previewChatWidth;
      const containerWidth = containerRef.current?.offsetWidth ?? 0;
      const minChatWidth = Math.max(360, Math.floor(containerWidth * MIN_CHAT_RATIO));
      const newWidth = Math.max(minChatWidth, current - delta);
      setPreviewChatWidth(newWidth);
    },
    [setPreviewChatWidth],
  );

  // Chat streaming options for preview mode (system prompt only, element context is sent in user message)
  const previewChatStreamingOptions = useMemo(() => {
    if (!isPreviewVisible) return undefined;
    return PREVIEW_CHAT_OPTIONS;
  }, [isPreviewVisible]);

  return (
    <div ref={containerRef} className="flex flex-1 min-w-0 overflow-hidden">
      {/* Chat section (left) — at least 40% of container */}
      <div
        className="flex flex-col min-w-0 overflow-hidden"
        style={{
          width: previewChatWidth,
          minWidth: "40%",
          backgroundColor: "var(--color-background)",
        }}
      >
        <FullChatHeader />
        <div className="flex-1 overflow-hidden min-w-0">
          <ErrorBoundary fallbackLabel="Chat">
            <ChatPanel chatStreamingOptions={previewChatStreamingOptions} />
          </ErrorBoundary>
        </div>
      </div>

      {/* Resize handle */}
      <EditorChatResizeHandle onResize={handlePreviewResize} />

      {/* Preview section (right) */}
      <div className="flex flex-col flex-1 min-w-0 overflow-hidden">
        <PreviewToolbar
          onRefresh={handleRefresh}
          onNavigate={handleNavigate}
          inspectorActive={inspectorActive}
          onToggleInspector={toggleInspector}
          fileTreeVisible={fileTreeVisible}
          onToggleFileTree={toggleFileTree}
          onClose={handleClosePreview}
        />
        <div className="flex flex-1 overflow-hidden">
          {fileTreeVisible && projectPath && (
            <div
              className="flex flex-col overflow-hidden"
              style={{
                width: 200,
                minWidth: 160,
                borderRight: "1px solid var(--color-border)",
                backgroundColor: "var(--color-surface-alt)",
              }}
            >
              <div
                className="px-2 py-1.5 text-[11px] font-medium uppercase tracking-wider"
                style={{
                  color: "var(--color-text-placeholder)",
                  borderBottom: "1px solid var(--color-border)",
                }}
              >
                Files
              </div>
              <PreviewFileTree
                rootPath={projectPath}
                onFileSelect={handleFileSelect}
                selectedFile={selectedFile}
              />
            </div>
          )}
          <PreviewPanel ref={iframeRef} key={projectPath ?? "default"} />
        </div>
        <PreviewStatusBar />
      </div>
    </div>
  );
}

export function MainArea({ chatPanel, editorPanel }: MainAreaProps) {
  const editorFilePath = useAppStore((s) => s.editorFilePath);
  const activeView = useAppStore((s) => s.activeView);
  const chatPanelWidth = useAppStore((s) => s.chatPanelWidth);
  const setChatPanelWidth = useAppStore((s) => s.setChatPanelWidth);
  // Split view only for diff/legacy editor mode — file tabs open inside the chat panel
  const isEditorOpen = activeView === "editor" && editorFilePath !== null;
  const isPreviewVisible = usePreviewStore((s) => s.isPreviewVisible);

  // Preview is only auto-opened from the welcome page's build-project flow
  // (which calls setPreviewVisible(true) explicitly). All other entries into
  // chat view leave preview in its current store state — the user can toggle
  // it manually via the header button.

  const handleResize = useCallback(
    (delta: number) => {
      const current = useAppStore.getState().chatPanelWidth;
      setChatPanelWidth(current + delta);
    },
    [setChatPanelWidth],
  );

  return (
    <main
      className="flex flex-1 min-w-0 overflow-hidden"
      style={{ backgroundColor: "var(--color-background)" }}
    >
      {isPreviewVisible ? (
        <PreviewMode />
      ) : (
        <>
          {/* Editor Area — hidden when no file open */}
          <div
            className="flex flex-col min-w-0 overflow-hidden"
            style={{
              flex: isEditorOpen ? 1 : 0,
              width: isEditorOpen ? undefined : 0,
              opacity: isEditorOpen ? 1 : 0,
              transition: "none",
              backgroundColor: "var(--color-surface-inset)",
              pointerEvents: isEditorOpen ? "auto" : "none",
            }}
          >
            {editorFilePath && <Breadcrumb filePath={editorFilePath} />}
            <div className="flex-1 overflow-hidden">{editorPanel}</div>
          </div>

          {/* Resize Handle — only when editor is open */}
          {isEditorOpen && <EditorChatResizeHandle onResize={handleResize} />}

          {/* Chat Panel — full width or sidebar */}
          <div
            className="flex flex-col min-w-0 overflow-hidden chat-panel-animate"
            style={{
              width: isEditorOpen ? chatPanelWidth : undefined,
              minWidth: isEditorOpen ? 280 : undefined,
              flex: isEditorOpen ? "none" : 1,
              backgroundColor: "var(--color-background)",
              borderLeft: isEditorOpen ? "1px solid var(--color-border)" : undefined,
            }}
          >
            {isEditorOpen ? <SplitChatHeader /> : <FullChatHeader />}
            <div className="flex-1 overflow-hidden min-w-0">{chatPanel}</div>
          </div>
        </>
      )}
    </main>
  );
}
