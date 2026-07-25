import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { useAppStore, useIdeaStore, useWorkspaceStore, useConversationStore } from "@/stores";
import type { IdeaSummary } from "@/stores";
import { WorkspaceRail } from "@/components/layout/workspace-rail";
import { IdeaToolbar } from "./idea-toolbar";
import { KanbanBoard } from "./kanban-board";
import { IdeaDetail } from "./idea-detail";
import { IdeaEditModal } from "./idea-edit-modal";
import { IdeaPreviewPanel } from "./idea-preview-panel";

type SubView = "kanban" | "detail";

export function IdeaHubLayout() {
  const { t } = useTranslation();
  const activeWorkspaceId = useWorkspaceStore((s) => s.activeWorkspaceId);
  const ideas = useIdeaStore((s) => s.ideas);
  const isLoading = useIdeaStore((s) => s.isLoading);
  const statusCounts = useIdeaStore((s) => s.statusCounts);
  const loadIdeas = useIdeaStore((s) => s.loadIdeas);
  const loadStatusCounts = useIdeaStore((s) => s.loadStatusCounts);
  const deleteIdea = useIdeaStore((s) => s.deleteIdea);
  const updateIdeaStatus = useIdeaStore((s) => s.updateIdeaStatus);
  const searchIdeas = useIdeaStore((s) => s.searchIdeas);
  const setActiveIdeaId = useIdeaStore((s) => s.setActiveIdeaId);
  const activeIdeaId = useIdeaStore((s) => s.activeIdeaId);
  const setQuickCaptureOpen = useAppStore((s) => s.setQuickCaptureOpen);
  const completeIdea = useIdeaStore((s) => s.completeIdea);
  const loadDoneIdeas = useIdeaStore((s) => s.loadDoneIdeas);
  const tagFilter = useIdeaStore((s) => s.tagFilter);
  const setActiveView = useAppStore((s) => s.setActiveView);
  const goBack = useAppStore((s) => s.goBack);

  const [subView, setSubView] = useState<SubView>("kanban");
  const [statusFilter, setStatusFilter] = useState("");
  const [autoStartDiscussion, setAutoStartDiscussion] = useState(false);
  const [editingIdeaId, setEditingIdeaId] = useState<string | null>(null);
  const [previewIdeaId, setPreviewIdeaId] = useState<string | null>(null);

  // Load ideas on mount or workspace change
  useEffect(() => {
    loadIdeas(activeWorkspaceId ?? undefined);
    loadStatusCounts(activeWorkspaceId ?? undefined);
    loadDoneIdeas(activeWorkspaceId ?? undefined);
  }, [activeWorkspaceId, loadIdeas, loadStatusCounts, loadDoneIdeas]);

  const handleSearch = useCallback(
    (query: string) => {
      if (query.trim()) {
        searchIdeas(query);
      } else {
        loadIdeas(activeWorkspaceId ?? undefined, statusFilter || undefined);
      }
    },
    [searchIdeas, loadIdeas, activeWorkspaceId, statusFilter],
  );

  const handleFilterStatus = useCallback(
    (status: string) => {
      setStatusFilter(status);
      loadIdeas(activeWorkspaceId ?? undefined, status || undefined);
    },
    [loadIdeas, activeWorkspaceId],
  );

  const handleNewIdea = useCallback(() => {
    setQuickCaptureOpen(true);
  }, [setQuickCaptureOpen]);

  const handleDelete = useCallback(
    (id: string) => {
      deleteIdea(id);
    },
    [deleteIdea],
  );

  const handleSelect = useCallback(
    (id: string) => {
      setPreviewIdeaId(id);
    },
    [],
  );

  const handleAction = useCallback(
    (idea: IdeaSummary) => {
      switch (idea.status) {
        case "draft":
          // Open discussion: set status to discussing, navigate to detail, auto-start AI
          updateIdeaStatus(idea.id, "discussing");
          setActiveIdeaId(idea.id);
          setAutoStartDiscussion(true);
          setSubView("detail");
          break;
        case "discussing":
        case "marked":
          // Continue discussion
          setActiveIdeaId(idea.id);
          setAutoStartDiscussion(false);
          setSubView("detail");
          break;
        case "ready":
          // Send to AI - open detail which has send-to-AI button
          setActiveIdeaId(idea.id);
          setSubView("detail");
          break;
        case "building":
          // View progress - switch to chat view with linked conversation
          if (idea.linked_conversation_id) {
            useConversationStore.getState().switchConversation(idea.linked_conversation_id);
            setActiveView("chat");
          }
          break;
      }
    },
    [updateIdeaStatus, setActiveIdeaId, setActiveView],
  );

  const handleGoToDiscussion = useCallback(
    (id: string) => {
      const idea = useIdeaStore.getState().ideas.find((i) => i.id === id);
      setActiveIdeaId(id);
      if (idea?.status === "draft") {
        updateIdeaStatus(id, "discussing");
        setAutoStartDiscussion(true);
      } else {
        setAutoStartDiscussion(false);
      }
      setSubView("detail");
    },
    [setActiveIdeaId, updateIdeaStatus],
  );

  const handleComplete = useCallback(
    (id: string) => { completeIdea(id); },
    [completeIdea],
  );

  const handleEdit = useCallback(
    (id: string) => { setEditingIdeaId(id); },
    [],
  );

  const handleEditClose = useCallback(() => {
    setEditingIdeaId(null);
    loadIdeas(activeWorkspaceId ?? undefined, statusFilter || undefined);
  }, [loadIdeas, activeWorkspaceId, statusFilter]);

  const handlePreviewClose = useCallback(() => {
    setPreviewIdeaId(null);
    // Reload in case checklist was toggled in preview
    loadIdeas(activeWorkspaceId ?? undefined, statusFilter || undefined);
    loadStatusCounts(activeWorkspaceId ?? undefined);
  }, [loadIdeas, loadStatusCounts, activeWorkspaceId, statusFilter]);

  const handlePreviewGoToDiscussion = useCallback(
    (id: string) => {
      const idea = useIdeaStore.getState().ideas.find((i) => i.id === id);
      setPreviewIdeaId(null);
      setActiveIdeaId(id);
      if (idea?.status === "draft") {
        updateIdeaStatus(id, "discussing");
        setAutoStartDiscussion(true);
      } else {
        setAutoStartDiscussion(false);
      }
      setSubView("detail");
    },
    [setActiveIdeaId, updateIdeaStatus],
  );

  const handlePreviewSendToAi = useCallback(
    (id: string) => {
      setPreviewIdeaId(null);
      setActiveIdeaId(id);
      setSubView("detail");
    },
    [setActiveIdeaId],
  );

  const filteredIdeas = useMemo(() => {
    if (tagFilter.length === 0) return ideas;
    return ideas.filter((idea) => {
      try {
        const tags: string[] = JSON.parse(idea.tags);
        return tagFilter.some((ft) => tags.includes(ft));
      } catch {
        return false;
      }
    });
  }, [ideas, tagFilter]);

  const handleBackToKanban = useCallback(() => {
    setSubView("kanban");
    setActiveIdeaId(null);
    setAutoStartDiscussion(false);
    // Reload in case changes were made in detail view
    loadIdeas(activeWorkspaceId ?? undefined, statusFilter || undefined);
    loadStatusCounts(activeWorkspaceId ?? undefined);
  }, [setActiveIdeaId, loadIdeas, loadStatusCounts, activeWorkspaceId, statusFilter]);

  return (
    <div className="flex flex-1 min-h-0 min-w-0">
      <WorkspaceRail />

      <div
        className="flex flex-col flex-1 min-w-0"
        style={{ backgroundColor: "var(--color-background)" }}
      >
        {subView === "kanban" && (
          <>
            <IdeaToolbar
              onSearch={handleSearch}
              onFilterStatus={handleFilterStatus}
              onNewIdea={handleNewIdea}
              onBack={goBack}
              currentStatus={statusFilter}
              activeCount={statusCounts.draft + statusCounts.discussing + statusCounts.marked + statusCounts.ready + statusCounts.building}
            />

            {isLoading ? (
              <div
                className="flex items-center justify-center flex-1"
                style={{ color: "var(--color-muted)", fontSize: 13 }}
              >
                {t("ideaHub.loadingIdeas")}
              </div>
            ) : (
              <KanbanBoard
                ideas={filteredIdeas}
                statusCounts={statusCounts}
                onAction={handleAction}
                onDelete={handleDelete}
                onSelect={handleSelect}
                onGoToDiscussion={handleGoToDiscussion}
                onComplete={handleComplete}
                onEdit={handleEdit}
              />
            )}
          </>
        )}

        {subView === "detail" && activeIdeaId && (
          <IdeaDetail
            ideaId={activeIdeaId}
            onBack={handleBackToKanban}
            autoStartDiscussion={autoStartDiscussion}
          />
        )}

        {editingIdeaId && (
          <IdeaEditModal
            ideaId={editingIdeaId}
            onClose={handleEditClose}
          />
        )}

        {previewIdeaId && (
          <IdeaPreviewPanel
            ideaId={previewIdeaId}
            onClose={handlePreviewClose}
            onEdit={handleEdit}
            onGoToDiscussion={handlePreviewGoToDiscussion}
            onSendToAi={handlePreviewSendToAi}
          />
        )}
      </div>
    </div>
  );
}
