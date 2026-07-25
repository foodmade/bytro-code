import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useTranslation } from "react-i18next";
import {
  LayoutDashboard,
  FolderOpen,
  Sparkles,
  GitBranch,
  History,
  HeartPulse,
  Users,
  Lightbulb,
  Blocks,
  BookOpen,
  Settings,
  Loader,
  PanelLeftClose,
  PanelLeftOpen,
} from "lucide-react";
import { useConversationSwitch } from "@/hooks/use-conversation-switch";
import { useNewSessionDrag } from "@/hooks/use-new-session-drag";
import { usePressActivation } from "@/hooks/use-press-activation";
import {
  useHealthCheckStore,
  flattenIssues,
  loadPersistedIgnoredIssues,
} from "@/stores/health-check-store";

const SettingsModal = lazy(() =>
  import("@/components/settings/settings-modal").then((m) => ({ default: m.SettingsModal })),
);
const SkillsConfigDialog = lazy(() =>
  import("@/components/skills/skills-config-dialog").then((m) => ({
    default: m.SkillsConfigDialog,
  })),
);
const TeamLaunchPanel = lazy(() =>
  import("@/components/chat/team-launch-panel").then((m) => ({ default: m.TeamLaunchPanel })),
);
import { open } from "@tauri-apps/plugin-dialog";
import { invoke } from "@tauri-apps/api/core";
import {
  useAppStore,
  useWorkspaceStore,
  useConversationStore,
  useChatStore,
  useStreamStateStore,
  useTeamsStore,
  useToastStore,
} from "@/stores";
import { showWorkspaceOpenDialog } from "./workspace-open-dialog";
import { useIdeaStore } from "@/stores";
import { WorkspaceSwitcher } from "./workspace-switcher";
import { GitClonePopover } from "@/components/git/git-clone-popover";

/* ------------------------------------------------------------------ */
/*  NavItem                                                           */
/* ------------------------------------------------------------------ */

interface NavItemProps {
  readonly icon: React.ComponentType<{
    size?: number;
    style?: React.CSSProperties;
    className?: string;
  }>;
  readonly label: string;
  readonly iconColor?: string;
  readonly isActive?: boolean;
  readonly onClick?: React.MouseEventHandler<HTMLButtonElement>;
  readonly onPointerDown?: (event: React.PointerEvent<HTMLButtonElement>) => void;
  readonly collapsed: boolean;
  readonly badge?: number;
  readonly badgeColor?: string;
  readonly dot?: string;
  /** Green "running" badge with dot + count (shown when > 0) */
  readonly runBadge?: number;
  /** Extra className applied to the icon (e.g. "animate-spin") */
  readonly iconClassName?: string;
}

function NavItem({
  icon: Icon,
  label,
  iconColor = "var(--color-muted)",
  isActive,
  onClick,
  onPointerDown,
  collapsed,
  badge,
  badgeColor = "#F59E0B",
  dot,
  runBadge,
  iconClassName,
}: NavItemProps) {
  const pressActivation = usePressActivation<HTMLButtonElement>(onClick);
  const handlePointerDown = useCallback(
    (event: React.PointerEvent<HTMLButtonElement>) => {
      pressActivation.onPointerDown(event);
      onPointerDown?.(event);
    },
    [onPointerDown, pressActivation],
  );

  if (collapsed) {
    return (
      <button
        onClick={pressActivation.onClick}
        onPointerDown={handlePointerDown}
        title={label}
        className={`flex items-center justify-center${!isActive ? " hover:bg-hover-overlay/[0.06]" : ""}`}
        style={{
          width: "100%",
          height: 36,
          minHeight: 36,
          flexShrink: 0,
          border: "none",
          cursor: onClick ? "pointer" : "default",
          borderRadius: 6,
        }}
      >
        <div style={{ position: "relative", display: "inline-flex" }}>
          {isActive ? (
            <div
              className="flex items-center justify-center"
              style={{
                width: 36,
                height: 36,
                borderRadius: 8,
                backgroundColor: "rgba(var(--theme-accent-rgb),0.094)",
              }}
            >
              <Icon size={18} style={{ color: "#A855F7" }} className={iconClassName} />
            </div>
          ) : (
            <Icon size={18} style={{ color: iconColor }} className={iconClassName} />
          )}
          {badge != null && badge > 0 && (
            <div
              className="flex items-center justify-center"
              style={{
                position: "absolute",
                top: -4,
                right: -6,
                minWidth: 14,
                height: 14,
                borderRadius: 7,
                backgroundColor: badgeColor,
                padding: "0 3px",
              }}
            >
              <span
                style={{
                  fontSize: 8,
                  fontWeight: 700,
                  color: "#000000",
                  fontFamily: "Inter, sans-serif",
                }}
              >
                {badge}
              </span>
            </div>
          )}
          {runBadge != null && runBadge > 0 && !badge && (
            <div
              className="flex items-center justify-center"
              style={{
                position: "absolute",
                top: -4,
                right: -6,
                minWidth: 14,
                height: 14,
                borderRadius: 7,
                backgroundColor: "#10B98120",
                padding: "0 3px",
              }}
            >
              <span
                style={{
                  fontSize: 8,
                  fontWeight: 700,
                  color: "#10B981",
                  fontFamily: "Inter, sans-serif",
                }}
              >
                {runBadge}
              </span>
            </div>
          )}
        </div>
      </button>
    );
  }

  /* Expanded */
  return (
    <button
      onClick={pressActivation.onClick}
      onPointerDown={handlePointerDown}
      className={`flex items-center w-full${!isActive ? " hover:bg-hover-overlay/[0.06]" : ""}`}
      style={{
        height: 34,
        minHeight: 34,
        flexShrink: 0,
        borderRadius: 8,
        padding: "0 10px",
        backgroundColor: isActive ? "rgba(var(--theme-accent-rgb),0.125)" : undefined,
        border: "none",
        cursor: onClick ? "pointer" : "default",
      }}
    >
      <div className="flex items-center min-w-0 flex-1" style={{ gap: 10 }}>
        <Icon
          size={16}
          style={{ color: isActive ? "#A855F7" : iconColor, flexShrink: 0 }}
          className={iconClassName}
        />
        <span
          className="truncate"
          style={{
            fontSize: 13,
            fontWeight: isActive ? 500 : 400,
            fontFamily: "Inter, sans-serif",
            color: isActive ? "var(--color-foreground)" : "var(--color-muted-foreground)",
            textAlign: "left",
          }}
        >
          {label}
        </span>
      </div>
      {badge != null && badge > 0 && (
        <div
          className="flex items-center justify-center shrink-0"
          style={{
            width: 20,
            height: 18,
            borderRadius: 9,
            backgroundColor: badgeColor,
          }}
        >
          <span
            style={{
              fontSize: 10,
              fontWeight: 700,
              color: "#000000",
              fontFamily: "Inter, sans-serif",
            }}
          >
            {badge}
          </span>
        </div>
      )}
      {dot && (
        <div
          className="shrink-0"
          style={{ width: 6, height: 6, borderRadius: "50%", backgroundColor: dot }}
        />
      )}
      {runBadge != null && runBadge > 0 && (
        <div
          className="flex items-center justify-center shrink-0"
          style={{
            height: 18,
            borderRadius: 9,
            backgroundColor: "#10B98120",
            padding: "2px 8px",
            gap: 4,
          }}
        >
          <div
            style={{
              width: 6,
              height: 6,
              borderRadius: "50%",
              backgroundColor: "#10B981",
            }}
          />
          <span
            style={{
              fontSize: 10,
              fontWeight: 700,
              color: "#10B981",
              fontFamily: "Inter, sans-serif",
            }}
          >
            {runBadge}
          </span>
        </div>
      )}
    </button>
  );
}

/* ------------------------------------------------------------------ */
/*  Section helpers                                                   */
/* ------------------------------------------------------------------ */

function SectionLabel({ label }: { readonly label: string }) {
  return (
    <span
      style={{
        fontSize: 11,
        fontWeight: 600,
        color: "var(--color-muted)",
        fontFamily: "Inter, sans-serif",
      }}
    >
      {label}
    </span>
  );
}

function Spacer({ height }: { readonly height: number }) {
  return <div style={{ height, flexShrink: 0 }} />;
}

function SectionBreak({ collapsed }: { readonly collapsed: boolean }) {
  if (collapsed) {
    return (
      <>
        <div style={{ height: 12, flexShrink: 0 }} />
        <div
          style={{
            height: 1,
            width: 28,
            backgroundColor: "var(--color-border)",
            alignSelf: "center",
            flexShrink: 0,
          }}
        />
        <div style={{ height: 12, flexShrink: 0 }} />
      </>
    );
  }
  return <div style={{ height: 20, flexShrink: 0 }} />;
}

/* ------------------------------------------------------------------ */
/*  Rail                                                              */
/* ------------------------------------------------------------------ */

export function WorkspaceRail() {
  const { t } = useTranslation();
  const { handleCreateInPane } = useConversationSwitch();
  const activeView = useAppStore((s) => s.activeView);
  const setActiveView = useAppStore((s) => s.setActiveView);
  const setMcpConfigOpen = useAppStore((s) => s.setMcpConfigOpen);
  const setSkillsConfigOpen = useAppStore((s) => s.setSkillsConfigOpen);
  const isSkillsConfigOpen = useAppStore((s) => s.isSkillsConfigOpen);
  const isSettingsOpen = useAppStore((s) => s.isSettingsOpen);
  const settingsInitialTab = useAppStore((s) => s.settingsInitialTab);
  const openSettings = useAppStore((s) => s.openSettings);
  const closeSettings = useAppStore((s) => s.closeSettings);
  const collapsed = useAppStore((s) => s.isRailCollapsed);
  const toggleCollapsed = useAppStore((s) => s.toggleRailCollapsed);
  const addWorkspace = useWorkspaceStore((s) => s.addWorkspace);
  const addToast = useToastStore((s) => s.addToast);
  const ideaStatusCounts = useIdeaStore((s) => s.statusCounts);
  const loadIdeaStatusCounts = useIdeaStore((s) => s.loadStatusCounts);
  const ideaPendingCount = (ideaStatusCounts.draft ?? 0) + (ideaStatusCounts.discussing ?? 0);
  const activeWorkspaceId = useWorkspaceStore((s) => s.activeWorkspaceId);

  // Running sessions count: active streaming + background streaming snapshots
  const isStreaming = useStreamStateStore((s) => s.isStreaming);
  const snapshots = useChatStore((s) => s._snapshots);
  const activeConversationId = useConversationStore((s) => s.activeConversationId);
  const runningSessionCount = useMemo(() => {
    // Exclude the active conversation's snapshot to prevent double-counting
    // (live isStreaming already accounts for the foreground stream)
    const bgStreaming = Object.entries(snapshots).filter(
      ([convId, s]) => s.isStreaming && convId !== activeConversationId,
    ).length;
    return (isStreaming ? 1 : 0) + bgStreaming;
  }, [isStreaming, snapshots, activeConversationId]);

  const teamSession = useTeamsStore((s) => s.session);

  // Health check badge: critical (red) > warning (yellow) > none
  const healthDimensions = useHealthCheckStore((s) => s.dimensions);
  const healthLastResult = useHealthCheckStore((s) => s.lastResult);
  const healthPhase = useHealthCheckStore((s) => s.phase);
  const issueFixStatuses = useHealthCheckStore((s) => s.issueFixStatuses);
  const { healthBadgeCount, healthBadgeColor } = useMemo(() => {
    const dims =
      healthPhase === "completed"
        ? healthDimensions
        : (healthLastResult?.dimensions ?? healthDimensions);
    const issues = flattenIssues(dims).filter((i) => {
      const status = issueFixStatuses[i.id];
      return status !== "ignored" && status !== "fixed";
    });
    const critical = issues.filter((i) => i.severity === "critical").length;
    if (critical > 0) return { healthBadgeCount: critical, healthBadgeColor: "#FF453A" };
    const warning = issues.filter((i) => i.severity === "warning").length;
    if (warning > 0) return { healthBadgeCount: warning, healthBadgeColor: "#FF9F0A" };
    return { healthBadgeCount: 0, healthBadgeColor: "#FF9F0A" };
  }, [healthDimensions, healthLastResult, healthPhase, issueFixStatuses]);

  const [teamLaunchOpen, setTeamLaunchOpen] = useState(false);
  const [gitCloneOpen, setGitCloneOpen] = useState(false);
  const gitCloneBtnRef = useRef<HTMLDivElement>(null);
  const teamBtnRef = useRef<HTMLDivElement>(null);
  const [teamPanelPos, setTeamPanelPos] = useState({ top: 0, left: 0 });

  // Load idea status counts eagerly so badge shows without visiting Idea Hub
  useEffect(() => {
    loadIdeaStatusCounts(activeWorkspaceId ?? undefined);
  }, [loadIdeaStatusCounts, activeWorkspaceId]);

  // Load persisted ignored issues eagerly so health badge excludes them
  useEffect(() => {
    if (activeWorkspaceId) {
      loadPersistedIgnoredIssues(activeWorkspaceId);
    }
  }, [activeWorkspaceId]);

  // Close team launch popover when navigating to teams view
  useEffect(() => {
    if (activeView === "teams") {
      setTeamLaunchOpen(false);
    }
  }, [activeView]);

  // Calculate team launch panel position based on anchor element
  useLayoutEffect(() => {
    if (!teamLaunchOpen || !teamBtnRef.current) return;
    const rect = teamBtnRef.current.getBoundingClientRect();
    const panelHeight = 420;
    let top = rect.top;
    if (top + panelHeight > window.innerHeight - 10) {
      top = window.innerHeight - panelHeight - 10;
    }
    setTeamPanelPos({
      top: Math.max(10, top),
      left: rect.right + 8,
    });
  }, [teamLaunchOpen, collapsed]);

  const handleOpenProject = useCallback(async () => {
    try {
      const selected = await open({ directory: true, multiple: false });
      if (!selected) return;

      const folderName = (selected as string).split(/[\\/]/).pop() ?? "Project";
      const choice = await showWorkspaceOpenDialog(folderName);
      console.warn("[workspace-open][rail] open project choice", {
        selectedPath: selected as string,
        folderName,
        choice,
      });
      if (choice === "cancel") return;

      if (choice === "new") {
        const folderNameForWs =
          (selected as string).split(/[\\/]/).filter(Boolean).pop() ?? "workspace";
        const ws = await invoke<{ id: string; name: string; path: string }>("create_workspace", {
          name: folderNameForWs,
          path: selected as string,
        });
        console.warn("[workspace-open][rail] workspace resolved for new window", ws);
        const label = await invoke<string>("create_workspace_window", {
          workspaceId: ws.id,
          workspaceName: ws.name,
        });
        console.warn("[workspace-open][rail] project opened in new window", {
          workspaceId: ws.id,
          workspaceName: ws.name,
          label,
        });
        useWorkspaceStore.getState().loadWorkspaces();
        return;
      }

      // "current"
      const ws = await addWorkspace(selected as string);
      setActiveView("workspace");
      if (ws) {
        invoke("update_window_workspace", {
          workspaceId: ws.id,
          workspaceName: ws.name,
        }).catch(() => {});
      }
    } catch {
      console.warn("[workspace-open][rail] project failed to open");
      addToast("error", "打开项目失败，请重试");
    }
  }, [addToast, addWorkspace, setActiveView]);

  const handleCreateProject = useCallback(() => {
    setActiveView("welcome");
  }, [setActiveView]);

  const handleTeamsClick = useCallback(() => {
    // If there's an active team session past initializing, go directly to teams view
    if (teamSession && teamSession.phase !== "initializing") {
      setActiveView("teams");
      return;
    }
    // No session or still initializing — toggle the launch panel popover
    setTeamLaunchOpen((prev) => !prev);
  }, [teamSession, setActiveView]);

  const handleSessions = useCallback(async () => {
    const convStore = useConversationStore.getState();
    const currentConvId = convStore.activeConversationId;

    // If no active conversation, fallback to the first one
    if (!currentConvId) {
      const conversations = convStore.conversations;
      const firstConv = conversations[0];
      if (firstConv) {
        convStore.switchConversation(firstConv.id);
        await useChatStore.getState().loadMessages(firstConv.id);
      }
    }

    setActiveView("chat");
  }, [setActiveView]);

  const {
    dragPreview: newSessionDragPreview,
    handleClick: handleSessionsClick,
    handlePointerDown: handleSessionsPointerDown,
  } = useNewSessionDrag({
    title: t("chat.newSession"),
    onCreateClick: () => {
      void handleSessions();
    },
    onCreateAtPane: handleCreateInPane,
  });

  const isChatView = activeView === "chat" || activeView === "editor" || activeView === "diff";
  const isSessionsActive = isChatView;
  return (
    <aside
      className="flex flex-col shrink-0 vibrancy-sidebar"
      style={{
        width: collapsed ? 52 : 200,
        height: "100%",
        paddingTop: 20,
        paddingBottom: 20,
        paddingLeft: collapsed ? 0 : 12,
        paddingRight: collapsed ? 0 : 12,
        backgroundColor: "var(--color-surface)",
        borderRight: "1px solid var(--color-border)",
        transition: "width 0.25s var(--ease-spring-gentle, ease)",
      }}
    >
      {/* Workspace switcher (replaces logo) */}
      <div className="shrink-0">
        <WorkspaceSwitcher collapsed={collapsed} />
      </div>

      {/* Spacer after switcher */}
      <Spacer height={16} />

      {/* Nav sections (scrollable) */}
      <div
        className="flex flex-col flex-1 min-h-0"
        style={{ overflowY: "auto", overflowX: "hidden" }}
      >
        {/* === Overview === */}
        {!collapsed && <SectionLabel label={t("nav.sectionOverview", "Overview")} />}
        {!collapsed && <Spacer height={6} />}
        <NavItem
          icon={LayoutDashboard}
          label={t("nav.workspace", "Workspace")}
          iconColor="#A855F7"
          isActive={activeView === "workspace"}
          onClick={() => setActiveView("workspace")}
          collapsed={collapsed}
        />
        <NavItem
          icon={runningSessionCount > 0 ? Loader : History}
          label={t("nav.sessions", "Sessions")}
          iconColor={runningSessionCount > 0 ? "#10B981" : undefined}
          iconClassName={runningSessionCount > 0 ? "animate-spin" : undefined}
          isActive={isSessionsActive}
          onClick={handleSessionsClick}
          onPointerDown={handleSessionsPointerDown}
          collapsed={collapsed}
          runBadge={runningSessionCount > 0 ? runningSessionCount : undefined}
        />

        <SectionBreak collapsed={collapsed} />

        {/* === Project === */}
        {!collapsed && <SectionLabel label={t("nav.sectionProject", "Project")} />}
        {!collapsed && <Spacer height={6} />}
        <NavItem
          icon={FolderOpen}
          label={t("workspace.openProject", "Open Project")}
          iconColor="#A855F7"
          onClick={handleOpenProject}
          collapsed={collapsed}
        />
        <NavItem
          icon={Sparkles}
          label={t("workspace.createProject", "Create Project")}
          iconColor="#F59E0B"
          onClick={handleCreateProject}
          collapsed={collapsed}
        />
        <div ref={gitCloneBtnRef}>
          <NavItem
            icon={GitBranch}
            label={t("workspace.gitClone", "Git Clone")}
            iconColor="#A855F7"
            isActive={gitCloneOpen}
            onClick={() => setGitCloneOpen((prev) => !prev)}
            collapsed={collapsed}
          />
        </div>

        <SectionBreak collapsed={collapsed} />

        {/* === Monitor === */}
        {!collapsed && <SectionLabel label={t("nav.sectionMonitor", "Monitor")} />}
        {!collapsed && <Spacer height={6} />}
        <NavItem
          icon={HeartPulse}
          label={t("nav.health", "Health")}
          isActive={activeView === "health-check"}
          onClick={() => setActiveView("health-check")}
          collapsed={collapsed}
          badge={healthBadgeCount > 0 ? healthBadgeCount : undefined}
          badgeColor={healthBadgeColor}
        />
        <SectionBreak collapsed={collapsed} />

        {/* === Tools === */}
        {!collapsed && <SectionLabel label={t("nav.sectionTools", "Tools")} />}
        {!collapsed && <Spacer height={6} />}
        <div ref={teamBtnRef}>
          <NavItem
            icon={Users}
            label={t("nav.teams", "Teams")}
            isActive={activeView === "teams" || teamLaunchOpen}
            onClick={handleTeamsClick}
            collapsed={collapsed}
          />
        </div>
        <NavItem
          icon={Lightbulb}
          label={t("workspace.ideaHub", "Idea Hub")}
          isActive={activeView === "ideas"}
          onClick={() => setActiveView("ideas")}
          collapsed={collapsed}
          badge={ideaPendingCount > 0 ? ideaPendingCount : undefined}
        />

        <SectionBreak collapsed={collapsed} />

        {/* === Config === */}
        {!collapsed && <SectionLabel label={t("nav.sectionConfig", "Config")} />}
        {!collapsed && <Spacer height={6} />}
        <NavItem
          icon={Blocks}
          label={t("workspace.mcpService", "MCP")}
          onClick={() => setMcpConfigOpen(true)}
          collapsed={collapsed}
        />
        <NavItem
          icon={BookOpen}
          label={t("nav.skills", "Skills")}
          onClick={() => setSkillsConfigOpen(true)}
          collapsed={collapsed}
        />
        <NavItem
          icon={Settings}
          label={t("workspace.settings", "Settings")}
          onClick={() => openSettings()}
          collapsed={collapsed}
        />
      </div>

      {/* Bottom: divider + local navigation control */}
      <div className="shrink-0 flex flex-col" style={{ width: "100%" }}>
        <div
          style={{
            height: 1,
            backgroundColor: "var(--color-border)",
            width: collapsed ? 28 : "100%",
            alignSelf: "center",
          }}
        />
        <Spacer height={8} />
        <button
          type="button"
          onClick={toggleCollapsed}
          className="flex items-center justify-center hover:bg-hover-overlay/[0.06]"
          style={{
            width: collapsed ? 32 : "100%",
            height: 34,
            alignSelf: "center",
            gap: 8,
            border: "none",
            borderRadius: 8,
            color: "var(--color-muted-foreground)",
            cursor: "pointer",
          }}
          title={collapsed ? t("workspace.expandSidebar") : t("workspace.collapseSidebar")}
        >
          {collapsed ? <PanelLeftOpen size={16} /> : <PanelLeftClose size={16} />}
          {!collapsed && (
            <span style={{ fontSize: 12 }}>{t("workspace.collapseSidebar")}</span>
          )}
        </button>
      </div>

      {/* Modals & Popovers */}
      {isSettingsOpen && (
        <Suspense fallback={null}>
          <SettingsModal
            open={isSettingsOpen}
            onClose={closeSettings}
            initialTab={settingsInitialTab ?? undefined}
          />
        </Suspense>
      )}
      {isSkillsConfigOpen && (
        <Suspense fallback={null}>
          <SkillsConfigDialog
            open={isSkillsConfigOpen}
            onClose={() => setSkillsConfigOpen(false)}
          />
        </Suspense>
      )}
      {newSessionDragPreview && (
        <div
          className="split-drag-preview"
          style={{
            left: newSessionDragPreview.x,
            top: newSessionDragPreview.y,
          }}
        >
          <span className="split-drag-preview-badge">新会话</span>
          <span className="split-drag-preview-title">{newSessionDragPreview.title}</span>
        </div>
      )}
      <GitClonePopover
        open={gitCloneOpen}
        onClose={() => setGitCloneOpen(false)}
        anchorRef={gitCloneBtnRef}
      />
      {teamLaunchOpen && (
        <Suspense fallback={null}>
          <TeamLaunchPanel
            onClose={() => setTeamLaunchOpen(false)}
            containerStyle={{
              position: "fixed",
              top: teamPanelPos.top,
              left: teamPanelPos.left,
              bottom: "auto",
              marginBottom: 0,
              maxHeight: `calc(100vh - ${teamPanelPos.top}px - 10px)`,
              zIndex: 100,
              boxShadow: "0 8px 32px rgba(0,0,0,0.3)",
            }}
          />
        </Suspense>
      )}
    </aside>
  );
}
