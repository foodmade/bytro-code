import { lazy, Suspense, useEffect, useLayoutEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { APP_NAME } from "@/lib/app-constants";
import { TopBar } from "@/components/layout";
import { LazyFallback, ToastContainer } from "@/components/ui";
import { McpConfigDialog } from "@/components/mcp-config-dialog";
import { WelcomePage } from "@/components/welcome/welcome-page";
import { WorkspaceLayout } from "@/components/layout/workspace-layout";
import { ChatLayout } from "@/components/layout/chat-layout";
import {
  useAppStore,
  useSettingsStore,
  useMcpStore,
  useWorkspaceStore,
  useConversationStore,
  useNodeRuntimeStore,
  useWindowFocusStore,
  useChatStore,
  useStreamStateStore,
  useAgentStatusStore,
  useSkillsStore,
  usePreviewStore,
  useToastStore,
} from "@/stores";
import {
  getCustomModelsForActiveProfile,
  getDisplayModelsForPlatform,
} from "@/lib/platform-config";
import { useRemoteModelsStore } from "@/stores/remote-models-store";
import type { PlatformId } from "@/lib/platform-config";
import { useOnboardingStore } from "@/stores/onboarding-store";
import { useNotchBroadcaster } from "@/hooks/use-notch-broadcaster";
import { useConversationSwitch } from "@/hooks/use-conversation-switch";
import { initGlobalStreamManager } from "@/lib/chat-stream-manager";
import { matchesShortcut, parseShortcuts } from "@/lib/keyboard-shortcuts";
import { createThemeCssVariables, type ResolvedTheme } from "@/lib/theme-customization";
import { initUiLanguage, i18n } from "@/i18n";
import { isMacPlatform } from "@/components/layout/window-controls";
import { TerminalPopup } from "@/components/terminal/terminal-popup";
import { WorkspaceOpenDialog } from "@/components/layout/workspace-open-dialog";
import "./App.css";

const IdeaHubLayout = lazy(() =>
  import("@/components/idea-hub/idea-hub-layout").then((m) => ({ default: m.IdeaHubLayout })),
);

const QuickCaptureModal = lazy(() =>
  import("@/components/idea-hub/quick-capture-modal").then((m) => ({
    default: m.QuickCaptureModal,
  })),
);

const GlobalSearchDialog = lazy(() =>
  import("@/components/global-search/global-search-dialog").then((m) => ({
    default: m.GlobalSearchDialog,
  })),
);

const TeamsView = lazy(() =>
  import("@/components/teams/TeamsView").then((m) => ({ default: m.TeamsView })),
);

const OnboardingPage = lazy(() =>
  import("@/components/onboarding/onboarding-page").then((m) => ({ default: m.OnboardingPage })),
);

const HealthCheckView = lazy(() => import("@/components/health-check/health-check-layout"));

interface TrayOpenConversationPayload {
  readonly conversation_id: string;
  readonly workspace_id: string | null;
}

function App() {
  useNotchBroadcaster();

  const activePlatformId = useSettingsStore((s) => s.activePlatformId);
  const theme = useSettingsStore((s) => s.theme);
  const themeCustomization = useSettingsStore((s) => s.themeCustomization);
  const settingsPersistenceError = useSettingsStore((s) => s.persistenceError);
  const mcpPersistenceError = useMcpStore((s) => s.loadError);
  const activeView = useAppStore((s) => s.activeView);
  const isMcpConfigOpen = useAppStore((s) => s.isMcpConfigOpen);
  const setMcpConfigOpen = useAppStore((s) => s.setMcpConfigOpen);
  const setActiveView = useAppStore((s) => s.setActiveView);
  const isQuickCaptureOpen = useAppStore((s) => s.isQuickCaptureOpen);
  const setQuickCaptureOpen = useAppStore((s) => s.setQuickCaptureOpen);
  const isGlobalSearchOpen = useAppStore((s) => s.isGlobalSearchOpen);
  const setGlobalSearchOpen = useAppStore((s) => s.setGlobalSearchOpen);
  const workspace = useWorkspaceStore((s) => s.activeWorkspace);
  const activeConvId = useConversationStore((s) => s.activeConversationId);
  const conversations = useConversationStore((s) => s.conversations);
  const { handleCreate: handleCreateSession } = useConversationSwitch();
  // Set platform attribute on html for CSS platform targeting (vibrancy, titlebar inset)
  useEffect(() => {
    document.documentElement.dataset.platform = isMacPlatform ? "mac" : "other";
  }, []);

  // Disable browser default context menu in production (custom menus still work)
  useEffect(() => {
    if (import.meta.env.PROD) {
      const handler = (e: MouseEvent) => e.preventDefault();
      document.addEventListener("contextmenu", handler);
      return () => document.removeEventListener("contextmenu", handler);
    }
  }, []);

  useEffect(() => {
    if (settingsPersistenceError) {
      useToastStore.getState().addToast("error", settingsPersistenceError);
    }
  }, [settingsPersistenceError]);

  useEffect(() => {
    if (mcpPersistenceError) {
      useToastStore.getState().addToast("error", mcpPersistenceError);
    }
  }, [mcpPersistenceError]);

  // Dynamic native window title based on active view / context.
  // Always include the project (workspace) name so multiple windows are
  // easily distinguishable in the taskbar / dock.
  useEffect(() => {
    const wsName = workspace?.name;
    const suffix = wsName ? `${wsName} — ${APP_NAME}` : APP_NAME;
    let title = suffix;
    if (activeView === "chat" || activeView === "editor") {
      const conv = activeConvId ? conversations.find((c) => c.id === activeConvId) : null;
      const convTitle = conv?.title ?? "New Session";
      title = `${convTitle} — ${suffix}`;
    } else if (activeView === "workspace") {
      title = suffix;
    } else if (activeView === "ideas") {
      title = `Idea Hub — ${suffix}`;
    } else if (activeView === "teams") {
      title = `Teams — ${suffix}`;
    } else if (activeView === "health-check") {
      title = `Health Check — ${suffix}`;
    } else if (activeView === "onboarding") {
      title = `Setup — ${APP_NAME}`;
    }
    try {
      const resolvedNativeTheme =
        theme === "system"
          ? window.matchMedia("(prefers-color-scheme: dark)").matches
            ? "dark"
            : "light"
          : theme;

      getCurrentWindow()
        .setTitle(title)
        .then(() => {
          if (!isMacPlatform) return;
          return invoke("set_native_theme", { theme: resolvedNativeTheme });
        })
        .catch(() => {});
    } catch {
      /* non-Tauri */
    }
  }, [activeView, activeConvId, conversations, workspace, theme]);

  // Load MCP server configs from disk on startup
  useEffect(() => {
    useMcpStore.getState().load();
  }, []);

  // Reload skills whenever the active workspace or provider changes,
  // so project-level and provider-specific skills are discovered.
  const activeWorkspacePath = useWorkspaceStore((s) => s.activeWorkspace?.path);
  useEffect(() => {
    useSkillsStore.getState().load();
  }, [activePlatformId, activeWorkspacePath]);

  // Initialize UI language from persistent storage
  useEffect(() => {
    initUiLanguage();
  }, []);

  // Initialize global stream event listeners at app level so they survive
  // view switches (chat → workspace → idea hub → teams → back to chat).
  // These listeners MUST outlive any individual component.
  useEffect(() => {
    let cleanup: (() => void) | null = null;
    initGlobalStreamManager().then((fn) => {
      cleanup = fn;
    });
    return () => {
      cleanup?.();
    };
  }, []);

  useEffect(() => {
    let unlisten: (() => void) | null = null;
    try {
      const win = getCurrentWindow();
      win
        .onFocusChanged(({ payload: focused }) => {
          useWindowFocusStore.getState().setFocused(focused);
        })
        .then((fn) => {
          unlisten = fn;
        });
    } catch {
      /* non-Tauri env */
    }
    return () => {
      unlisten?.();
    };
  }, []);

  useEffect(() => {
    let unlisten: (() => void) | null = null;
    let cancelled = false;

    listen<TrayOpenConversationPayload>("tray-open-conversation", async ({ payload }) => {
      const conversationId = payload.conversation_id;
      if (!conversationId) return;

      const workspaceId = payload.workspace_id;
      const workspaceStore = useWorkspaceStore.getState();
      if (workspaceId && workspaceStore.activeWorkspaceId !== workspaceId) {
        await workspaceStore.openWorkspace(workspaceId);
      }

      const conversationStore = useConversationStore.getState();
      await conversationStore.ensureConversationLoaded(conversationId);

      const currentConvId = useConversationStore.getState().activeConversationId;
      if (currentConvId === conversationId) {
        useAppStore.getState().setActiveView("chat");
        return;
      }

      const chatState = useChatStore.getState();
      if (currentConvId) {
        useAgentStatusStore.getState().cacheAgentStatus(currentConvId);
        if (useStreamStateStore.getState().isStreaming || chatState.messages.length > 0) {
          chatState.saveSnapshot(currentConvId);
        }
      }

      useAgentStatusStore.getState().resetLiveStatus({
        lastUsage: null,
        subagents: [],
        todos: [],
      });

      useConversationStore.getState().switchConversation(conversationId);
      await useChatStore.getState().loadMessages(conversationId);
      useAppStore.getState().setActiveView("chat");
    })
      .then((fn) => {
        if (cancelled) {
          fn();
          return;
        }
        unlisten = fn;
      })
      .catch(() => {
        console.error("[tray] failed to register conversation listener");
      });

    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, []);

  // Initialize workspace state on startup
  useEffect(() => {
    const init = async () => {
      // Check onboarding FIRST — if never completed, show the guided setup
      // regardless of whether workspaces already exist.
      const onboardingCompleted = await useOnboardingStore.getState().checkOnboardingCompleted();
      if (!onboardingCompleted) {
        setActiveView("onboarding");
        return;
      }

      const wsStore = useWorkspaceStore.getState();
      await wsStore.loadWorkspaces();

      // Check if this window was opened with a specific workspace
      // (secondary window created via create_workspace_window).
      // Uses IPC instead of URL params — reliable in both dev and prod mode.
      const targetWorkspaceId = await invoke<string | null>("get_window_workspace");

      if (targetWorkspaceId) {
        await wsStore.openWorkspace(targetWorkspaceId);
        setActiveView("workspace");
        return;
      }

      const workspaces = useWorkspaceStore.getState().workspaces;

      if (workspaces.length > 0) {
        // Open the most recently used workspace
        await wsStore.openWorkspace(workspaces[0].id);
        setActiveView("workspace");
        // Register main window's workspace binding.
        const ws = useWorkspaceStore.getState().activeWorkspace;
        if (ws) {
          invoke("update_window_workspace", {
            workspaceId: ws.id,
            workspaceName: ws.name,
          }).catch(() => {});
        }
      } else {
        // Onboarding done but no workspaces: check for orphaned conversations
        try {
          const orphanCount = await invoke<number>("count_orphaned_conversations");
          if (orphanCount > 0) {
            // Create a "General" workspace for orphaned conversations
            const generalWs = await invoke<{ id: string; name: string; path: string }>(
              "create_workspace",
              { name: "General", path: "__general__" },
            );
            await invoke("assign_orphaned_conversations", { workspaceId: generalWs.id });
            await wsStore.loadWorkspaces();
            await wsStore.openWorkspace(generalWs.id);
            setActiveView("workspace");
          } else {
            setActiveView("welcome");
          }
        } catch {
          setActiveView("welcome");
        }
      }
    };
    init();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Restore last-used model from SQLite on startup.
  // Must wait for Zustand persist hydration to finish first, otherwise
  // settings.json values will overwrite what we restore from SQLite.
  useEffect(() => {
    const restore = async () => {
      // Wait for settings store hydration (async Tauri plugin-store)
      if (!useSettingsStore.persist.hasHydrated()) {
        await new Promise<void>((resolve) => {
          const unsub = useSettingsStore.persist.onFinishHydration(() => {
            unsub();
            resolve();
          });
        });
      }
      try {
        const result = await invoke<{
          platform_id: string;
          model_id: string;
          is_official: boolean;
        } | null>("get_last_used_model");
        if (!result) {
          return;
        }

        // Community builds never restore hosted/official models. Keep the
        // current local selection and require an explicit profile choice.
        if (result.is_official) {
          useToastStore
            .getState()
            .addToast(
              "info",
              i18n.t(
                "settings.models.selectLocalModel",
                "Select a local model profile to continue.",
              ),
            );
          return;
        }

        const { platform_id, model_id } = result;
        const settings = useSettingsStore.getState();
        const platformId = platform_id as PlatformId;
        if (!settings.platforms[platformId]) {
          return;
        }
        const remoteCache = useRemoteModelsStore.getState().providers[platformId]?.models;
        const models = getDisplayModelsForPlatform(
          platformId,
          remoteCache,
          getCustomModelsForActiveProfile(settings.platforms[platformId]),
        );
        if (!models.some((m) => m.id === model_id)) {
          return;
        }
        if (settings.activePlatformId !== platformId) {
          settings.setActivePlatform(platformId);
        }
        if (settings.platforms[platformId].activeModelId !== model_id) {
          settings.setActiveModel(platformId, model_id);
        }
      } catch {
        console.error("[model-memory] restore failed");
      }
    };
    restore();
  }, []);

  useEffect(() => {
    const el = document.documentElement;
    // Enable transition only during the switch, then remove to avoid
    // constant WebKit style-recalc overhead on the html element.
    el.classList.add("provider-transitioning");
    el.dataset.provider = activePlatformId;
    const timer = setTimeout(() => el.classList.remove("provider-transitioning"), 450);
    return () => clearTimeout(timer);
  }, [activePlatformId]);

  // Resolve "system" theme to the actual OS preference and listen for changes.
  // useLayoutEffect ensures the theme is applied before the browser paints,
  // preventing a flash of the wrong theme on the native title bar (macOS/Linux).
  useLayoutEffect(() => {
    // When followSystem is true, Tauri window theme is set to null so the OS
    // controls it. Native macOS title bar refresh still needs the resolved
    // light/dark theme so the appearance cache updates correctly.
    const applyTheme = (resolved: ResolvedTheme, followSystem = false) => {
      const root = document.documentElement;
      root.dataset.theme = resolved;
      root.dataset.themeMode = theme;
      root.dataset.pointerCursor = themeCustomization.pointerCursor ? "true" : "false";
      root.dataset.fontSmoothing = themeCustomization.fontSmoothing !== false ? "true" : "false";
      const variables = createThemeCssVariables(themeCustomization, resolved);
      for (const [name, value] of Object.entries(variables)) {
        root.style.setProperty(name, value);
      }
      try {
        const win = getCurrentWindow();
        const nativeTheme = resolved;
        if (followSystem) {
          // Keep the native title bar fully controlled by macOS / Tauri.
          // Avoid reapplying vibrancy effects because newer macOS versions
          // can leave overlay title bars stuck on the previous appearance.
          void win.setTheme(null).then(() => {
            // macOS Tahoe (26+): apply after Tauri finishes so we don't race.
            if (isMacPlatform) {
              return invoke("set_native_theme", { theme: nativeTheme });
            }
          });
        } else {
          const tauriTheme = resolved === "dark" ? ("dark" as const) : ("light" as const);
          // Chain: first let Tauri set its theme, then override the native
          // title bar via our Rust command so Liquid Glass picks it up.
          void win.setTheme(tauriTheme).then(() => {
            if (isMacPlatform) {
              return invoke("set_native_theme", { theme: nativeTheme });
            }
          });
        }
      } catch {
        /* non-Tauri */
      }
    };

    if (theme === "system") {
      // Reset Tauri window theme to null so it follows the OS.
      // This unblocks the WebView's prefers-color-scheme media query
      // which was locked by a previous explicit setTheme() call.
      try {
        const win = getCurrentWindow();
        win
          .setTheme(null)
          .then(() => {
            return win.theme();
          })
          .then((sysTheme) => {
            applyTheme(sysTheme === "light" ? "light" : "dark", true);
          })
          .catch(() => {
            const mq = window.matchMedia("(prefers-color-scheme: dark)");
            applyTheme(mq.matches ? "dark" : "light", true);
          });
      } catch {
        const mq = window.matchMedia("(prefers-color-scheme: dark)");
        applyTheme(mq.matches ? "dark" : "light", true);
      }

      // Listen for OS theme changes while in "system" mode
      const mq = window.matchMedia("(prefers-color-scheme: dark)");
      const handler = (e: MediaQueryListEvent) => {
        applyTheme(e.matches ? "dark" : "light", true);
      };
      mq.addEventListener("change", handler);
      return () => mq.removeEventListener("change", handler);
    }

    applyTheme(theme);
  }, [theme, themeCustomization]);

  // Stop dev server on page refresh / navigation away.
  // This is a safety net — the Rust-side PID file provides the ultimate fallback.
  useEffect(() => {
    const handleBeforeUnload = () => {
      void usePreviewStore.getState().stopPreviewRuntime();
      invoke("stop_dev_server").catch(() => {});
    };
    window.addEventListener("beforeunload", handleBeforeUnload);
    return () => window.removeEventListener("beforeunload", handleBeforeUnload);
  }, []);

  // Global keyboard shortcuts: Quick Capture, New Session, Global Search
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      // 生产构建禁用浏览器原生刷新（F5 / Ctrl+R / Cmd+R），避免整站重载丢失会话状态
      // 开发环境保留刷新能力以便调试
      if (import.meta.env.PROD) {
        if (e.key === "F5") {
          e.preventDefault();
          return;
        }
        if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === "r") {
          e.preventDefault();
          return;
        }
      }
      const shortcuts = parseShortcuts(useSettingsStore.getState().keyboardShortcuts);
      if (matchesShortcut(e, shortcuts.globalSearch)) {
        e.preventDefault();
        const current = useAppStore.getState().isGlobalSearchOpen;
        setGlobalSearchOpen(!current);
        return;
      }
      if (matchesShortcut(e, shortcuts.quickCapture)) {
        e.preventDefault();
        setQuickCaptureOpen(true);
      }
      if (matchesShortcut(e, shortcuts.newSession)) {
        e.preventDefault();
        const currentView = useAppStore.getState().activeView;
        if (currentView !== "chat" && currentView !== "editor" && currentView !== "workspace")
          return;

        handleCreateSession();
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [handleCreateSession, setQuickCaptureOpen, setGlobalSearchOpen]);

  // Initialize Node.js runtime listeners and fetch initial status
  useEffect(() => {
    let cleanup: (() => void) | null = null;
    const rtStore = useNodeRuntimeStore.getState();

    rtStore.initListeners().then((unsub) => {
      cleanup = unsub;
      // Re-fetch status AFTER listeners are registered to avoid missing
      // events that were emitted before the listener was set up.
      rtStore.checkStatus();
    });

    // Also fetch immediately so UI doesn't flash "unknown" while listeners init
    rtStore.checkStatus();

    return () => {
      cleanup?.();
    };
  }, []);

  return (
    <div className="flex flex-col h-screen w-screen bg-background text-foreground overflow-hidden">
      {activeView !== "onboarding" && <TopBar />}

      {/* Ideas view (full screen, hides everything else) */}
      {activeView === "ideas" && (
        <Suspense fallback={<LazyFallback label="Loading Idea Hub..." />}>
          <IdeaHubLayout />
        </Suspense>
      )}

      {/* Main content area */}
      <div
        className="flex flex-1 min-h-0 min-w-0"
        style={activeView === "ideas" ? { display: "none" } : undefined}
      >
        {activeView === "onboarding" && (
          <Suspense fallback={<LazyFallback label="Loading..." />}>
            <OnboardingPage />
          </Suspense>
        )}
        {activeView === "welcome" && <WelcomePage />}
        {activeView === "workspace" && <WorkspaceLayout />}
        {(activeView === "chat" || activeView === "editor") && <ChatLayout />}
        {activeView === "teams" && (
          <Suspense fallback={<LazyFallback label="Loading Teams..." />}>
            <TeamsView />
          </Suspense>
        )}
        {activeView === "health-check" && (
          <Suspense fallback={<LazyFallback label="Loading Health Check..." />}>
            <HealthCheckView />
          </Suspense>
        )}
      </div>

      <ToastContainer />
      <McpConfigDialog open={isMcpConfigOpen} onClose={() => setMcpConfigOpen(false)} />
      <TerminalPopup />
      <WorkspaceOpenDialog />
      {isQuickCaptureOpen && (
        <Suspense fallback={null}>
          <QuickCaptureModal />
        </Suspense>
      )}
      {isGlobalSearchOpen && (
        <Suspense fallback={null}>
          <GlobalSearchDialog />
        </Suspense>
      )}
    </div>
  );
}

export default App;
