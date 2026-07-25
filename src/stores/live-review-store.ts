import { create } from "zustand";
import { persist, type StateStorage } from "zustand/middleware";
import { load, type Store } from "@tauri-apps/plugin-store";
import type { PlatformId } from "@/lib/platform-config";
import type { ReviewScope, ReviewSeverity } from "@/lib/live-review-events";

// ---------------------------------------------------------------------------
// Live Review Store
// ---------------------------------------------------------------------------
// Independent reviewer that runs in parallel with the main chat.  Aggregates
// file changes from the main chat session into a per-conversation buffer and
// flushes the buffer into a single batched "PR-style" review whenever:
//
//   * MILESTONE — a TodoWrite item just transitioned to `completed`
//   * TURN      — the SDK Stop hook fires (the agent has finished writing)
//
// Each review batch becomes one `LiveReviewItem` keyed by a unique `reviewId`
// (NOT by file path).  The same set of files may be reviewed multiple times in
// the same conversation as the agent makes more progress; each batch is its
// own independent card with its own status / content / severity.
//
// MVP phase 1 implements **Lite mode** only:
//   - Single ChatCompletion-style call via `ai_code_review_stream`
//   - Prompt enriched with diff + full file body for every buffered file +
//     the most recent main-chat user message
// Phase 2 will add **Deep mode** (independent agentic SDK session with
// Read/Grep/Glob tools).  The store already carries `mode` so the UI can show
// the toggle today; Deep is gated behind a "coming soon" flag.
// ---------------------------------------------------------------------------

export type LiveReviewMode = "lite" | "deep";

export type LiveReviewStatus =
  | "queued"
  | "streaming"
  | "done"
  | "error"
  | "stale";

/** A snapshot of one file as it entered the review buffer.  We freeze the
 *  +N/-N counts at buffer time so the card always reflects what the reviewer
 *  was given, not whatever the file looks like now. */
export interface LiveReviewFileSnapshot {
  readonly filePath: string;
  readonly action: "edit" | "create" | "delete";
  readonly additions: number;
  readonly deletions: number;
}

/** One batched review.  Keyed by `reviewId` inside ConversationReviews so
 *  multiple reviews can coexist for the same files (e.g. milestone-1 then
 *  milestone-2 both touching the same set of files). */
export interface LiveReviewItem {
  readonly reviewId: string;
  readonly scope: ReviewScope;
  readonly status: LiveReviewStatus;
  /** Accumulated markdown body. */
  readonly content: string;
  /** Error message when status === "error". */
  readonly error: string | null;
  readonly startedAt: number;
  readonly completedAt: number | null;
  /** Files included in this batch.  Always ≥ 1. */
  readonly files: ReadonlyArray<LiveReviewFileSnapshot>;
  /** Optional milestone/turn title.  `null` when no contextual hint was
   *  available (e.g. tool-only turns where Stop hook produced no message). */
  readonly taskTitle: string | null;
  /** Human-readable reviewer identity captured at the moment this review
   *  was kicked off (e.g. "Claude · claude-sonnet-4-6").  Frozen on creation
   *  so the footer "Reviewed by X" badge and the forwarded chat metadata
   *  cannot drift if the user switches model mid-stream.  `null` when the
   *  reviewer identity could not be resolved (e.g. the platform was deleted
   *  between scheduling and execution). */
  readonly reviewerModel: string | null;
  /** Set once the user has forwarded this review to the main chat via the
   *  "Send to chat" button.  Used by the card UI to visually mark the item
   *  as handled (lower opacity, status badge, disabled send button) so the
   *  reviewer panel stays scannable when many reviews accumulate. */
  readonly forwardedAt: number | null;
  /** Reviewer-assigned severity (parsed from the trailing SEVERITY marker
   *  after the stream completes).  Drives the card accent color/badge. */
  readonly severity: ReviewSeverity;
}

interface ConversationReviews {
  readonly reviews: Readonly<Record<string /*reviewId*/, LiveReviewItem>>;
  /** reviewId list, newest first. */
  readonly order: ReadonlyArray<string>;
}

interface LiveReviewState {
  // ── Persisted user preferences (cross-conversation) ───────────────────
  /** Right-side panel width in px.  Floor 360, ceil 1200. */
  readonly panelWidth: number;
  /** Lite (default) vs Deep (phase 2). */
  readonly mode: LiveReviewMode;
  /** Reviewer model selection, independent of the main chat platform. */
  readonly providerOverride: {
    readonly platformId: PlatformId | null;
    readonly modelId: string | null;
  };

  // ── Per-conversation enable state (NOT persisted) ─────────────────────
  readonly enabledByConversation: Readonly<Record<string, boolean>>;
  /** Sticky enable intent for "the next conversation that gets created".
   *  Used when the user clicks the toggle on a brand-new conversation that
   *  has not yet been persisted (activeConversationId === null).  Once the
   *  first user message creates a real conversationId, the entry-button
   *  effect calls `bindPendingToConversation` to migrate this flag onto
   *  that id and clear the pending slot. */
  readonly pendingEnable: boolean;

  // ── Ephemeral per-conversation reviews ────────────────────────────────
  readonly reviewsByConversation: Readonly<Record<string, ConversationReviews>>;

  // ── Selectors ─────────────────────────────────────────────────────────
  readonly getConversationReviews: (
    conversationId: string | null,
  ) => ConversationReviews;
  readonly isEnabledFor: (conversationId: string | null) => boolean;

  // ── Actions ───────────────────────────────────────────────────────────
  readonly setEnabledFor: (conversationId: string | null, enabled: boolean) => void;
  /** Migrate `pendingEnable` onto a freshly-created conversationId.  Called
   *  from the entry button's effect once `activeConversationId` flips from
   *  `null` to a real id.  Idempotent: clears `pendingEnable` afterwards. */
  readonly bindPendingToConversation: (conversationId: string) => void;
  readonly setPanelWidth: (w: number) => void;
  readonly setMode: (m: LiveReviewMode) => void;
  readonly setProviderOverride: (
    platformId: PlatformId | null,
    modelId: string | null,
  ) => void;
  /** Insert a brand-new review record into the conversation, placing its id
   *  at the front of the order list. */
  readonly addReview: (
    conversationId: string,
    item: LiveReviewItem,
  ) => void;
  readonly appendDelta: (
    conversationId: string,
    reviewId: string,
    delta: string,
  ) => void;
  readonly markDone: (
    conversationId: string,
    reviewId: string,
  ) => void;
  readonly markError: (
    conversationId: string,
    reviewId: string,
    message: string,
  ) => void;
  readonly markStale: (
    conversationId: string,
    reviewId: string,
  ) => void;
  readonly markForwarded: (
    conversationId: string,
    reviewId: string,
  ) => void;
  readonly setSeverityAndContent: (
    conversationId: string,
    reviewId: string,
    severity: ReviewSeverity,
    content: string,
  ) => void;
  readonly removeReview: (conversationId: string, reviewId: string) => void;
  readonly clearConversation: (conversationId: string) => void;
}

const EMPTY_CONVERSATION_REVIEWS: ConversationReviews = {
  reviews: {},
  order: [],
};

const PANEL_WIDTH_MIN = 360;
const PANEL_WIDTH_MAX = 1200;
const PANEL_WIDTH_DEFAULT = 480;

function clampPanelWidth(w: number): number {
  if (!Number.isFinite(w)) return PANEL_WIDTH_DEFAULT;
  return Math.max(PANEL_WIDTH_MIN, Math.min(PANEL_WIDTH_MAX, Math.round(w)));
}

// ── Tauri Store Storage Adapter ────────────────────────────────────────────

const STORE_FILE = "live-review.json";
let storeInstance: Store | null = null;

async function getStore(): Promise<Store> {
  if (!storeInstance) {
    storeInstance = await load(STORE_FILE, { defaults: {}, autoSave: true });
  }
  return storeInstance;
}

const tauriStorage: StateStorage = {
  getItem: async (name: string) => {
    try {
      const store = await getStore();
      const value = await store.get<string>(name);
      return value ?? null;
    } catch {
      return null;
    }
  },
  setItem: async (name: string, value: string) => {
    try {
      const store = await getStore();
      await store.set(name, value);
    } catch {
      // Tauri store unavailable — silently ignore
    }
  },
  removeItem: async (name: string) => {
    try {
      const store = await getStore();
      await store.delete(name);
    } catch {
      // ignore
    }
  },
};

// ---------------------------------------------------------------------------

export const useLiveReviewStore = create<LiveReviewState>()(
  persist(
    (set, get) => ({
      panelWidth: PANEL_WIDTH_DEFAULT,
      mode: "lite",
      providerOverride: {
        platformId: null,
        modelId: null,
      },
      enabledByConversation: {},
      pendingEnable: false,
      reviewsByConversation: {},

      getConversationReviews: (conversationId) => {
        if (!conversationId) return EMPTY_CONVERSATION_REVIEWS;
        return (
          get().reviewsByConversation[conversationId] ??
          EMPTY_CONVERSATION_REVIEWS
        );
      },

      isEnabledFor: (conversationId) => {
        // Brand-new chat: surface the pending intent so the toggle renders as
        // "on" right after the user clicks it, before the conversationId
        // exists.  Once the first message creates a real id, the button's
        // effect migrates the flag and this branch stops applying.
        if (!conversationId) return get().pendingEnable;
        return get().enabledByConversation[conversationId] === true;
      },

      setEnabledFor: (conversationId, enabled) => {
        if (!conversationId) {
          // No conversationId yet — store the intent in the pending slot so
          // we can apply it the moment a real id appears.
          set((state) =>
            state.pendingEnable === enabled ? state : { pendingEnable: enabled },
          );
          return;
        }
        set((state) => {
          const current = state.enabledByConversation[conversationId] === true;
          if (current === enabled) return state;
          if (!enabled) {
            const { [conversationId]: _omit, ...rest } = state.enabledByConversation;
            void _omit;
            return { enabledByConversation: rest };
          }
          return {
            enabledByConversation: {
              ...state.enabledByConversation,
              [conversationId]: true,
            },
          };
        });
      },

      bindPendingToConversation: (conversationId) => {
        if (!conversationId) return;
        set((state) => {
          if (!state.pendingEnable) {
            // Pending intent was "off" or never set — nothing to migrate.
            // Still clear the slot so a stale `false` doesn't accumulate
            // (no-op when already false thanks to Object.is compare).
            return state.pendingEnable === false
              ? state
              : { pendingEnable: false };
          }
          const already = state.enabledByConversation[conversationId] === true;
          return {
            pendingEnable: false,
            enabledByConversation: already
              ? state.enabledByConversation
              : { ...state.enabledByConversation, [conversationId]: true },
          };
        });
      },
      setPanelWidth: (w) => set({ panelWidth: clampPanelWidth(w) }),
      setMode: (m) => set({ mode: m }),
      setProviderOverride: (platformId, modelId) =>
        set({
          providerOverride: {
            platformId,
            modelId: platformId ? modelId : null,
          },
        }),

      addReview: (conversationId, item) =>
        set((state) => {
          const conv =
            state.reviewsByConversation[conversationId] ??
            EMPTY_CONVERSATION_REVIEWS;
          // Defensive: don't double-insert the same id (would corrupt order).
          if (conv.reviews[item.reviewId]) {
            return {
              reviewsByConversation: {
                ...state.reviewsByConversation,
                [conversationId]: {
                  reviews: { ...conv.reviews, [item.reviewId]: item },
                  order: conv.order,
                },
              },
            };
          }
          return {
            reviewsByConversation: {
              ...state.reviewsByConversation,
              [conversationId]: {
                reviews: { ...conv.reviews, [item.reviewId]: item },
                order: [item.reviewId, ...conv.order],
              },
            },
          };
        }),

      appendDelta: (conversationId, reviewId, delta) =>
        set((state) => {
          const conv = state.reviewsByConversation[conversationId];
          if (!conv) return state;
          const item = conv.reviews[reviewId];
          if (!item) return state;
          if (item.status === "done" || item.status === "error" || item.status === "stale") {
            return state;
          }
          return {
            reviewsByConversation: {
              ...state.reviewsByConversation,
              [conversationId]: {
                ...conv,
                reviews: {
                  ...conv.reviews,
                  [reviewId]: {
                    ...item,
                    status: "streaming",
                    content: item.content + delta,
                  },
                },
              },
            },
          };
        }),

      markDone: (conversationId, reviewId) =>
        set((state) => {
          const conv = state.reviewsByConversation[conversationId];
          if (!conv) return state;
          const item = conv.reviews[reviewId];
          if (!item) return state;
          return {
            reviewsByConversation: {
              ...state.reviewsByConversation,
              [conversationId]: {
                ...conv,
                reviews: {
                  ...conv.reviews,
                  [reviewId]: {
                    ...item,
                    status: "done",
                    completedAt: Date.now(),
                  },
                },
              },
            },
          };
        }),

      markError: (conversationId, reviewId, message) =>
        set((state) => {
          const conv = state.reviewsByConversation[conversationId];
          if (!conv) return state;
          const item = conv.reviews[reviewId];
          if (!item) return state;
          return {
            reviewsByConversation: {
              ...state.reviewsByConversation,
              [conversationId]: {
                ...conv,
                reviews: {
                  ...conv.reviews,
                  [reviewId]: {
                    ...item,
                    status: "error",
                    error: message,
                    completedAt: Date.now(),
                  },
                },
              },
            },
          };
        }),

      markStale: (conversationId, reviewId) =>
        set((state) => {
          const conv = state.reviewsByConversation[conversationId];
          if (!conv) return state;
          const item = conv.reviews[reviewId];
          if (!item) return state;
          if (item.status === "done" || item.status === "error") return state;
          return {
            reviewsByConversation: {
              ...state.reviewsByConversation,
              [conversationId]: {
                ...conv,
                reviews: {
                  ...conv.reviews,
                  [reviewId]: { ...item, status: "stale" },
                },
              },
            },
          };
        }),

      setSeverityAndContent: (conversationId, reviewId, severity, content) =>
        set((state) => {
          const conv = state.reviewsByConversation[conversationId];
          if (!conv) return state;
          const item = conv.reviews[reviewId];
          if (!item) return state;
          if (item.severity === severity && item.content === content) return state;
          return {
            reviewsByConversation: {
              ...state.reviewsByConversation,
              [conversationId]: {
                ...conv,
                reviews: {
                  ...conv.reviews,
                  [reviewId]: { ...item, severity, content },
                },
              },
            },
          };
        }),

      markForwarded: (conversationId, reviewId) =>
        set((state) => {
          const conv = state.reviewsByConversation[conversationId];
          if (!conv) return state;
          const item = conv.reviews[reviewId];
          if (!item) return state;
          if (item.forwardedAt) return state;
          return {
            reviewsByConversation: {
              ...state.reviewsByConversation,
              [conversationId]: {
                ...conv,
                reviews: {
                  ...conv.reviews,
                  [reviewId]: { ...item, forwardedAt: Date.now() },
                },
              },
            },
          };
        }),

      removeReview: (conversationId, reviewId) =>
        set((state) => {
          const conv = state.reviewsByConversation[conversationId];
          if (!conv) return state;
          if (!(reviewId in conv.reviews)) return state;
          const { [reviewId]: _, ...rest } = conv.reviews;
          return {
            reviewsByConversation: {
              ...state.reviewsByConversation,
              [conversationId]: {
                reviews: rest,
                order: conv.order.filter((rid) => rid !== reviewId),
              },
            },
          };
        }),

      clearConversation: (conversationId) =>
        set((state) => {
          if (!(conversationId in state.reviewsByConversation)) return state;
          const { [conversationId]: _, ...rest } = state.reviewsByConversation;
          return { reviewsByConversation: rest };
        }),
    }),
    {
      name: "live-review-prefs",
      storage: {
        getItem: async (name) => {
          const raw = await tauriStorage.getItem(name);
          if (!raw) return null;
          try {
            return JSON.parse(raw);
          } catch {
            return null;
          }
        },
        setItem: async (name, value) => {
          await tauriStorage.setItem(name, JSON.stringify(value));
        },
        removeItem: async (name) => {
          await tauriStorage.removeItem(name);
        },
      },
      partialize: (state) =>
        ({
          panelWidth: state.panelWidth,
          mode: state.mode,
          providerOverride: state.providerOverride,
        }) as unknown as LiveReviewState,
      // A previous hosted-only override has no platform id. Downgrade it to
      // "use main model" instead of retaining an unusable selection.
      merge: (persisted, current) => {
        const persistedAny = (persisted ?? {}) as Partial<LiveReviewState>;
        const persistedOverride = persistedAny.providerOverride as
          | Partial<LiveReviewState["providerOverride"]>
          | undefined;
        const platformId = persistedOverride?.platformId ?? null;
        const merged: LiveReviewState = {
          ...current,
          ...persistedAny,
          providerOverride: {
            platformId,
            modelId: platformId ? (persistedOverride?.modelId ?? null) : null,
          },
        };
        return merged;
      },
    },
  ),
);
