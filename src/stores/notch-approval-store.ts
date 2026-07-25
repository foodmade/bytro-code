import { create } from "zustand";
import type { NotchProvider } from "@/lib/notch-bridge";

export interface AskQuestionItem {
  readonly question: string;
  readonly header: string;
  readonly options: ReadonlyArray<{ label: string; description: string }>;
  readonly multiSelect: boolean;
}

export interface PendingNotchApproval {
  readonly kind: "approval" | "approval-bash" | "ask-question";
  readonly confirmId: string;
  readonly toolCallId: string;
  readonly toolName: string;
  readonly toolInput: string;
  readonly conversationId: string;
  readonly provider: NotchProvider;
  readonly arrivedAt: number;
  readonly questions?: ReadonlyArray<AskQuestionItem>;
}

interface NotchApprovalState {
  readonly queue: ReadonlyArray<PendingNotchApproval>;
  readonly enqueue: (item: PendingNotchApproval) => void;
  readonly dequeue: (confirmId: string) => void;
  readonly removeForConversation: (conversationId: string) => void;
  readonly peek: () => PendingNotchApproval | null;
}

export const useNotchApprovalStore = create<NotchApprovalState>((set, get) => ({
  queue: [],

  enqueue: (item) =>
    set((s) => {
      if (s.queue.some((q) => q.confirmId === item.confirmId)) return s;
      return { queue: [...s.queue, item] };
    }),

  dequeue: (confirmId) =>
    set((s) => ({
      queue: s.queue.filter((q) => q.confirmId !== confirmId),
    })),

  removeForConversation: (conversationId) =>
    set((s) => ({
      queue: s.queue.filter((q) => q.conversationId !== conversationId),
    })),

  peek: () => {
    const { queue } = get();
    return queue.length > 0 ? queue[0] : null;
  },
}));
