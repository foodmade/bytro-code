import { create } from "zustand";
import { invoke } from "@tauri-apps/api/core";
import { useToastStore } from "./toast-store";
import { formatError } from "@/lib/format-error";

export interface CheckListItem {
  readonly id: string;
  readonly text: string;
  readonly checked: boolean;
}

export interface Idea {
  readonly id: string;
  readonly title: string;
  readonly raw_input: string;
  readonly workspace_id: string | null;
  readonly status: string;
  readonly priority: string;
  readonly tags: string;
  readonly summary_json: string | null;
  readonly linked_conversation_id: string | null;
  readonly discussion_conversation_id: string | null;
  readonly created_at: string;
  readonly updated_at: string;
  readonly sort_order: number;
  readonly checklist_json: string | null;
  readonly planned_date: string | null;
  readonly images_json: string | null;
  readonly completed_at: string | null;
}

export interface IdeaSummary {
  readonly id: string;
  readonly title: string;
  readonly raw_input: string;
  readonly workspace_id: string | null;
  readonly status: string;
  readonly priority: string;
  readonly tags: string;
  readonly has_summary: boolean;
  readonly discussion_conversation_id: string | null;
  readonly linked_conversation_id: string | null;
  readonly updated_at: string;
  readonly sort_order: number;
  readonly checklist_json: string | null;
  readonly planned_date: string | null;
  readonly images_json: string | null;
}

export interface IdeaStatusCounts {
  readonly draft: number;
  readonly discussing: number;
  readonly marked: number;
  readonly ready: number;
  readonly building: number;
  readonly done: number;
}

interface IdeaState {
  readonly ideas: ReadonlyArray<IdeaSummary>;
  readonly activeIdeaId: string | null;
  readonly activeIdea: Idea | null;
  readonly isLoading: boolean;
  readonly statusCounts: IdeaStatusCounts;
  readonly _workspaceFilter: string | null;
  readonly _statusFilter: string | null;
  readonly tagFilter: ReadonlyArray<string>;
  readonly doneIdeas: ReadonlyArray<IdeaSummary>;
  readonly isDoneSectionExpanded: boolean;

  readonly loadIdeas: (workspaceId?: string, status?: string) => Promise<void>;
  readonly createIdea: (
    title: string,
    rawInput: string,
    workspaceId?: string,
    priority?: string,
    tags?: string,
  ) => Promise<Idea>;
  readonly getIdea: (id: string) => Promise<Idea | null>;
  readonly updateIdea: (
    id: string,
    title: string,
    rawInput: string,
    tags?: string,
    priority?: string,
  ) => Promise<void>;
  readonly updateIdeaStatus: (id: string, status: string) => Promise<void>;
  readonly updateIdeaSummary: (id: string, summaryJson: string) => Promise<void>;
  readonly deleteIdea: (id: string) => Promise<void>;
  readonly searchIdeas: (query: string) => Promise<void>;
  readonly setActiveIdeaId: (id: string | null) => void;
  readonly loadStatusCounts: (workspaceId?: string) => Promise<void>;
  readonly linkDiscussion: (ideaId: string, conversationId: string) => Promise<void>;
  readonly linkConversation: (ideaId: string, conversationId: string) => Promise<void>;
  readonly reopenDiscussion: (id: string) => Promise<void>;
  readonly setTagFilter: (tags: ReadonlyArray<string>) => void;
  readonly setDoneSectionExpanded: (expanded: boolean) => void;
  readonly updateSortOrders: (updates: ReadonlyArray<{ readonly id: string; readonly sortOrder: number }>) => Promise<void>;
  readonly updateChecklist: (id: string, checklist: ReadonlyArray<CheckListItem> | null) => Promise<void>;
  readonly updatePlannedDate: (id: string, date: string | null) => Promise<void>;
  readonly saveImage: (ideaId: string, imageData: number[], ext: string) => Promise<string>;
  readonly deleteImage: (ideaId: string, filename: string) => Promise<void>;
  readonly updateImages: (ideaId: string, images: ReadonlyArray<string> | null) => Promise<void>;
  readonly completeIdea: (id: string) => Promise<void>;
  readonly uncompleteIdea: (id: string) => Promise<void>;
  readonly loadDoneIdeas: (workspaceId?: string) => Promise<void>;
  readonly getLinkedIdea: (conversationId: string) => Promise<Idea | null>;
}

const EMPTY_COUNTS: IdeaStatusCounts = { draft: 0, discussing: 0, marked: 0, ready: 0, building: 0, done: 0 };

export const useIdeaStore = create<IdeaState>((set, get) => ({
  ideas: [],
  activeIdeaId: null,
  activeIdea: null,
  isLoading: false,
  statusCounts: EMPTY_COUNTS,
  _workspaceFilter: null,
  _statusFilter: null,
  tagFilter: [],
  doneIdeas: [],
  isDoneSectionExpanded: false,

  loadIdeas: async (workspaceId?: string, status?: string) => {
    const effectiveWs = workspaceId !== undefined ? workspaceId : (get()._workspaceFilter ?? undefined);
    const effectiveStatus = status !== undefined ? status : (get()._statusFilter ?? undefined);
    const isWorkspaceSwitch = workspaceId !== undefined && workspaceId !== get()._workspaceFilter;

    if (workspaceId !== undefined) {
      set({ _workspaceFilter: workspaceId ?? null });
    }
    if (status !== undefined) {
      set({ _statusFilter: status ?? null });
    }

    set({ isLoading: true, ...(isWorkspaceSwitch ? { ideas: [] } : {}) });

    try {
      const ideas = await invoke<IdeaSummary[]>("list_ideas", {
        limit: 200,
        offset: 0,
        workspaceId: effectiveWs ?? null,
        status: effectiveStatus ?? null,
      });
      set({ ideas, isLoading: false });
    } catch (err: unknown) {
      set({ isLoading: false });
      useToastStore.getState().addToast("error", `Failed to load ideas: ${formatError(err)}`);
    }
  },

  createIdea: async (title, rawInput, workspaceId, priority, tags) => {
    const idea = await invoke<Idea>("create_idea", {
      title,
      rawInput,
      workspaceId: workspaceId ?? null,
      priority: priority ?? null,
      tags: tags ?? null,
    });
    await get().loadIdeas();
    await get().loadStatusCounts();
    return idea;
  },

  getIdea: async (id: string) => {
    try {
      const idea = await invoke<Idea | null>("get_idea", { ideaId: id });
      if (idea) {
        set({ activeIdea: idea });
      }
      return idea;
    } catch (err: unknown) {
      useToastStore.getState().addToast("error", `Failed to load idea: ${formatError(err)}`);
      return null;
    }
  },

  updateIdea: async (id, title, rawInput, tags, priority) => {
    await invoke("update_idea", {
      ideaId: id,
      title,
      rawInput,
      tags: tags ?? null,
      priority: priority ?? null,
    });
    await get().loadIdeas();
  },

  updateIdeaStatus: async (id, status) => {
    await invoke("update_idea_status", { ideaId: id, status });
    await get().loadIdeas();
    await get().loadStatusCounts();
  },

  updateIdeaSummary: async (id, summaryJson) => {
    await invoke("update_idea_summary", { ideaId: id, summaryJson });
    await get().loadIdeas();
  },

  deleteIdea: async (id: string) => {
    // Clean up images before deleting the idea
    try {
      const idea = await invoke<Idea | null>("get_idea", { ideaId: id });
      if (idea?.images_json) {
        const filenames: string[] = JSON.parse(idea.images_json);
        for (const filename of filenames) {
          try {
            await invoke("delete_idea_image", { filename });
          } catch {
            // Silently skip individual image cleanup failures
          }
        }
      }
    } catch {
      // Continue with deletion even if image cleanup fails
    }
    await invoke("delete_idea", { ideaId: id });
    const { activeIdeaId } = get();
    if (activeIdeaId === id) {
      set({ activeIdeaId: null, activeIdea: null });
    }
    await get().loadIdeas();
    await get().loadStatusCounts();
    await get().loadDoneIdeas();
  },

  searchIdeas: async (query: string) => {
    const wsFilter = get()._workspaceFilter;
    try {
      set({ isLoading: true });
      const ideas = await invoke<IdeaSummary[]>("search_ideas", {
        query,
        workspaceId: wsFilter ?? null,
        limit: 100,
      });
      set({ ideas, isLoading: false });
    } catch (err: unknown) {
      set({ isLoading: false });
      useToastStore.getState().addToast("error", `Search failed: ${formatError(err)}`);
    }
  },

  setActiveIdeaId: (id: string | null) => {
    set({ activeIdeaId: id, activeIdea: null });
    if (id) {
      get().getIdea(id);
    }
  },

  loadStatusCounts: async (workspaceId?: string) => {
    const effectiveWs = workspaceId ?? get()._workspaceFilter ?? undefined;
    try {
      const counts = await invoke<IdeaStatusCounts>("count_ideas_by_status", {
        workspaceId: effectiveWs ?? null,
      });
      set({ statusCounts: counts });
    } catch {
      // Silently fail — counts are non-critical
    }
  },

  linkDiscussion: async (ideaId, conversationId) => {
    await invoke("link_idea_discussion", { ideaId, conversationId });
    await get().loadIdeas();
  },

  linkConversation: async (ideaId, conversationId) => {
    await invoke("link_idea_conversation", { ideaId, conversationId });
    await get().loadIdeas();
  },

  reopenDiscussion: async (id) => {
    await invoke("update_idea_status", { ideaId: id, status: "discussing" });
    await get().loadIdeas();
    await get().loadStatusCounts();
  },

  setTagFilter: (tags) => {
    set({ tagFilter: tags });
  },

  setDoneSectionExpanded: (expanded) => {
    set({ isDoneSectionExpanded: expanded });
  },

  updateSortOrders: async (updates) => {
    const mapped = updates.map((u) => [u.id, u.sortOrder] as [string, number]);
    await invoke("update_idea_sort_orders", { updates: mapped });
    await get().loadIdeas();
  },

  updateChecklist: async (id, checklist) => {
    const json = checklist ? JSON.stringify(checklist) : null;
    await invoke("update_idea_checklist", { ideaId: id, checklistJson: json });
    const { activeIdeaId } = get();
    if (activeIdeaId === id) {
      await get().getIdea(id);
    }
    await get().loadIdeas();
  },

  updatePlannedDate: async (id, date) => {
    await invoke("update_idea_planned_date", { ideaId: id, plannedDate: date });
    const { activeIdeaId } = get();
    if (activeIdeaId === id) {
      await get().getIdea(id);
    }
    await get().loadIdeas();
  },

  saveImage: async (ideaId, imageData, ext) => {
    const filename = await invoke<string>("save_idea_image", {
      ideaId,
      imageData,
      fileExtension: ext,
    });
    return filename;
  },

  deleteImage: async (ideaId, filename) => {
    await invoke("delete_idea_image", { filename });
    const idea = get().activeIdea;
    if (idea && idea.id === ideaId && idea.images_json) {
      const images: string[] = JSON.parse(idea.images_json);
      const updated = images.filter((f) => f !== filename);
      await invoke("update_idea_images", {
        ideaId,
        imagesJson: updated.length > 0 ? JSON.stringify(updated) : null,
      });
      await get().getIdea(ideaId);
      await get().loadIdeas();
    }
  },

  updateImages: async (ideaId, images) => {
    const json = images && images.length > 0 ? JSON.stringify(images) : null;
    await invoke("update_idea_images", { ideaId, imagesJson: json });
    const { activeIdeaId } = get();
    if (activeIdeaId === ideaId) {
      await get().getIdea(ideaId);
    }
    await get().loadIdeas();
  },

  completeIdea: async (id) => {
    await invoke("complete_idea", { ideaId: id });
    await get().loadIdeas();
    await get().loadStatusCounts();
    await get().loadDoneIdeas();
  },

  uncompleteIdea: async (id) => {
    await invoke("uncomplete_idea", { ideaId: id });
    await get().loadIdeas();
    await get().loadStatusCounts();
    await get().loadDoneIdeas();
  },

  loadDoneIdeas: async (workspaceId?: string) => {
    const effectiveWs = workspaceId ?? get()._workspaceFilter ?? undefined;
    try {
      const ideas = await invoke<IdeaSummary[]>("list_ideas", {
        limit: 200,
        offset: 0,
        workspaceId: effectiveWs ?? null,
        status: "done",
      });
      set({ doneIdeas: ideas });
    } catch {
      // Silently fail
    }
  },

  getLinkedIdea: async (conversationId: string) => {
    try {
      const all = get().ideas;
      const found = all.find((i) => i.linked_conversation_id === conversationId);
      if (found) {
        const idea = await invoke<Idea | null>("get_idea", { ideaId: found.id });
        return idea;
      }
      return null;
    } catch {
      return null;
    }
  },
}));
