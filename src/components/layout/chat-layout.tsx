import { lazy, Suspense, useEffect, useRef, useState } from "react";
import { ErrorBoundary, LazyFallback } from "@/components/ui";
import { SplitChatWorkspace } from "@/components/chat/split-chat-workspace";
import {
  useAppStore,
  useConversationStore,
  useGoalSessionStore,
  useIdeaStore,
} from "@/stores";
import { usePreviewStore } from "@/stores/preview-store";
import { useGitStore } from "@/stores/git-store";
import { GitPanel } from "@/components/git/git-panel";
import { IdeaRequirementPanel } from "@/components/idea-hub/idea-requirement-panel";
import { SlideshowPanel } from "@/components/slideshow";
import { LiveReviewPanel } from "@/components/chat/live-review-panel";
import { GoalPanel } from "@/components/chat/goal-panel";
import { useSlideshowStore } from "@/stores/slideshow-store";
import { useLiveReviewStore } from "@/stores/live-review-store";
import { WorkspaceRail } from "./workspace-rail";
import { Sidebar } from "./sidebar";
import { MainArea } from "./main-area";
import { FileTree } from "@/components/file-tree";
import type { FileTreeHandle } from "@/components/file-tree";

const CodeEditor = lazy(async () => {
  const module = await import("@/components/editor/code-editor");
  return { default: module.CodeEditor };
});

export function ChatLayout() {
  const editorFilePath = useAppStore((state) => state.editorFilePath);
  const isGitPanelOpen = useGitStore((state) => state.isPanelOpen);
  const isPreviewVisible = usePreviewStore((state) => state.isPreviewVisible);
  const isRequirementPanelOpen = useAppStore(
    (state) => state.isRequirementPanelOpen,
  );
  const setRequirementPanelOpen = useAppStore(
    (state) => state.setRequirementPanelOpen,
  );
  const activeConversationId = useConversationStore(
    (state) => state.activeConversationId,
  );
  const ideas = useIdeaStore((state) => state.ideas);
  const fileTreeRef = useRef<FileTreeHandle>(null);
  const [hasLinkedIdea, setHasLinkedIdea] = useState(false);

  useEffect(() => {
    if (!activeConversationId) {
      setHasLinkedIdea(false);
      return;
    }
    setHasLinkedIdea(
      ideas.some(
        (idea) => idea.linked_conversation_id === activeConversationId,
      ),
    );
  }, [activeConversationId, ideas]);

  const isSlideshowOpen = useSlideshowStore((state) => state.isPanelOpen);
  const slideshowOwnerId = useSlideshowStore(
    (state) => state.ownerConversationId,
  );
  const shouldShowSlideshow =
    isSlideshowOpen && activeConversationId === slideshowOwnerId;
  const showRequirementPanel =
    hasLinkedIdea &&
    isRequirementPanelOpen &&
    !isPreviewVisible &&
    !shouldShowSlideshow;

  const isLiveReviewEnabled = useLiveReviewStore((state) =>
    activeConversationId != null
      ? state.enabledByConversation[activeConversationId] === true
      : state.pendingEnable,
  );
  const isGoalPanelOpen = useGoalSessionStore((state) =>
    activeConversationId != null
      ? state.openByConversation[activeConversationId] === true
      : state.pendingOpen,
  );
  const showGoalPanel =
    isGoalPanelOpen && !isPreviewVisible && !shouldShowSlideshow;
  const showLiveReviewPanel =
    isLiveReviewEnabled && !isPreviewVisible && !shouldShowSlideshow;

  return (
    <div className="flex flex-1 min-h-0 min-w-0">
      <WorkspaceRail />
      <Sidebar
        fileTree={<FileTree ref={fileTreeRef} />}
        fileTreeRef={fileTreeRef}
      />
      <MainArea
        chatPanel={
          <ErrorBoundary fallbackLabel="Chat">
            <SplitChatWorkspace />
          </ErrorBoundary>
        }
        editorPanel={
          <ErrorBoundary fallbackLabel="Editor">
            <Suspense fallback={<LazyFallback label="Loading Editor..." />}>
              <CodeEditor filePath={editorFilePath} />
            </Suspense>
          </ErrorBoundary>
        }
      />
      {shouldShowSlideshow && <SlideshowPanel />}
      {showRequirementPanel && (
        <IdeaRequirementPanel
          onClose={() => setRequirementPanelOpen(false)}
        />
      )}
      {isGitPanelOpen && !isPreviewVisible && (
        <div
          className="shrink-0 overflow-hidden"
          style={{ borderLeft: "1px solid var(--color-border)" }}
        >
          <GitPanel />
        </div>
      )}
      {showLiveReviewPanel && <LiveReviewPanel />}
      {showGoalPanel && <GoalPanel />}
    </div>
  );
}
