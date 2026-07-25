import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { LazyMotion, domAnimation } from "motion/react";
import { useWorkspaceStore, useConversationStore, useGitStore } from "@/stores";
import { ProjectMemoryBanner } from "@/components/chat/project-memory-banner";
import { WorkspaceHeader } from "./workspace-header";
import { WorkspaceSessionsSection } from "./workspace-sessions-section";
import { WorkspaceNewSessionCard } from "./workspace-new-session-card";
import { WorkspaceHealthCard } from "./workspace-health-card";
import { WorkspaceActivityHeatmap } from "./workspace-activity-heatmap";
import { WorkspaceStatsSection } from "./workspace-stats-section";
import { WorkspaceEntryProvider } from "./workspace-entry-context";

/**
 * Responsive thresholds based on the actual content-area width
 * (measured from the container ref, not the full viewport).
 *
 * The design (SjD6W) targets 1280 px content width.
 * When the content area shrinks we progressively hide cards
 * instead of wrapping rows — keeping the 3-row grid intact.
 */
const HIDE_HEATMAP_BP = 1060;
const HIDE_SIDE_CARDS_BP = 860;

export function WorkspaceMainView() {
  const workspace = useWorkspaceStore((s) => s.activeWorkspace);
  const gitInfo = useGitStore((s) => s.gitInfo);
  const loadConversations = useConversationStore((s) => s.loadConversations);
  const { t } = useTranslation();

  const containerRef = useRef<HTMLDivElement>(null);
  const [contentWidth, setContentWidth] = useState(1440);

  // Bumps once per "entry" into the workspace (first mount, or switching to a
  // different workspace) so cards know when to replay their entrance
  // animations. Guarded against StrictMode's double-invoked effects via the
  // lastEntryIdRef equality check.
  const [entryToken, setEntryToken] = useState(0);
  const lastEntryIdRef = useRef<string | undefined>(undefined);
  useEffect(() => {
    const currentId = workspace?.id;
    if (currentId !== lastEntryIdRef.current) {
      lastEntryIdRef.current = currentId;
      setEntryToken((t) => t + 1);
    }
  }, [workspace?.id]);

  const measure = useCallback(() => {
    if (containerRef.current) {
      setContentWidth(containerRef.current.clientWidth);
    }
  }, []);

  useEffect(() => {
    measure();
    const ro = new ResizeObserver(measure);
    if (containerRef.current) ro.observe(containerRef.current);
    return () => ro.disconnect();
  }, [measure]);

  const showHeatmap = contentWidth >= HIDE_HEATMAP_BP;
  const showSideCards = contentWidth >= HIDE_SIDE_CARDS_BP;

  useEffect(() => {
    if (workspace) {
      loadConversations(workspace.id);
    }
  }, [workspace, loadConversations]);

  if (!workspace) {
    return (
      <div
        className="flex-1 flex items-center justify-center"
        style={{ backgroundColor: "var(--color-background)" }}
      >
        <span style={{ fontSize: 14, color: "var(--color-muted)" }}>
          {t("workspace.selectWorkspace")}
        </span>
      </div>
    );
  }

  const rowBase: React.CSSProperties = {
    gap: 16,
    alignItems: "stretch",
    flexWrap: "nowrap",
  };

  return (
    <LazyMotion features={domAnimation}>
      <WorkspaceEntryProvider value={entryToken}>
        <div
          ref={containerRef}
          className="flex-1 min-w-0 flex flex-col"
          style={{
            backgroundColor: "var(--color-background)",
            overflowX: "hidden",
            overflowY: "auto",
          }}
        >
          <div
            className="flex flex-col flex-1 min-h-0"
            style={{
              maxWidth: 1600,
              width: "100%",
              minWidth: 0,
              margin: "0 auto",
              padding: "clamp(20px, 4vh, 36px) clamp(16px, 3%, 40px)",
              gap: "clamp(12px, 2vh, 24px)",
            }}
          >
            {/* Header */}
            <div className="shrink-0">
              <WorkspaceHeader workspace={workspace} gitInfo={gitInfo} />
            </div>

            <ProjectMemoryBanner />

            {/* Row 1: New Session + Health */}
            <div className="flex min-h-0 min-w-0" style={{ ...rowBase, flex: 5, minHeight: 200 }}>
              <div className="min-w-0" style={{ flex: "1 1 0%", minWidth: 0 }}>
                <WorkspaceNewSessionCard workspace={workspace} />
              </div>
              {showSideCards && (
                <div
                  className="min-w-0"
                  style={{ width: "clamp(280px, 28%, 420px)", flexShrink: 0 }}
                >
                  <WorkspaceHealthCard />
                </div>
              )}
            </div>

            {/* Row 2: Sessions + local activity heatmap */}
            <div className="flex min-h-0 min-w-0" style={{ ...rowBase, flex: 3.5, minHeight: 160 }}>
              <div className="min-w-0" style={{ flex: "1 1 320px", minWidth: 0 }}>
                <WorkspaceSessionsSection workspaceId={workspace.id} />
              </div>
              {showHeatmap && (
                <div
                  className="min-w-0"
                  style={{ width: "clamp(320px, 35%, 600px)", flexShrink: 0 }}
                >
                  <WorkspaceActivityHeatmap />
                </div>
              )}
            </div>

            {/* Row 3: Stats — 3 equal cards */}
            <div className="flex min-h-0 min-w-0" style={{ ...rowBase, flex: 1.5, minHeight: 80 }}>
              <WorkspaceStatsSection workspacePath={workspace.path} />
            </div>
          </div>
        </div>
      </WorkspaceEntryProvider>
    </LazyMotion>
  );
}
