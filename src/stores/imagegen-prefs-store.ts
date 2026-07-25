/**
 * Per-conversation imagegen quality / size overrides.
 *
 * Settings live alongside the conversation, not in the global `settings-store`.
 * This means changing the quality/size in conversation A no longer leaks into
 * conversation B; each conversation maintains its own overrides on top of the
 * global defaults.
 *
 * Drafts (no conversationId yet) are keyed by `draft:<paneId>`. When the draft
 * is bound to a real conversation, call `promote(draftKey, conversationId)` so
 * the user's pre-send selections stick to the new conversation.
 *
 * Memory-only: overrides are not persisted across app restart. The global
 * `settings-store` defaults remain the persistent baseline.
 */

import { create } from "zustand";
import type { ImageGenQuality, ImageGenSize } from "./settings-store";

export type ImagegenScopeKey = string;

interface Override {
  readonly quality?: ImageGenQuality;
  readonly size?: ImageGenSize;
}

interface ImagegenPrefsState {
  readonly overrides: Readonly<Record<ImagegenScopeKey, Override>>;
  readonly setQuality: (key: ImagegenScopeKey, quality: ImageGenQuality) => void;
  readonly setSize: (key: ImagegenScopeKey, size: ImageGenSize) => void;
  readonly clearScope: (key: ImagegenScopeKey) => void;
  /** Move overrides under `from` to `to` (used when a draft binds to a conv). */
  readonly promote: (from: ImagegenScopeKey, to: ImagegenScopeKey) => void;
}

export const useImagegenPrefsStore = create<ImagegenPrefsState>((set) => ({
  overrides: {},
  setQuality: (key, quality) =>
    set((state) => ({
      overrides: { ...state.overrides, [key]: { ...state.overrides[key], quality } },
    })),
  setSize: (key, size) =>
    set((state) => ({
      overrides: { ...state.overrides, [key]: { ...state.overrides[key], size } },
    })),
  clearScope: (key) =>
    set((state) => {
      if (!(key in state.overrides)) return state;
      const next = { ...state.overrides };
      delete next[key];
      return { overrides: next };
    }),
  promote: (from, to) =>
    set((state) => {
      const fromOverride = state.overrides[from];
      if (!fromOverride) return state;
      const next = { ...state.overrides, [to]: { ...state.overrides[to], ...fromOverride } };
      delete next[from];
      return { overrides: next };
    }),
}));

/** Compute the storage key for the given chat scope.
 *  - committed conversation → conversation id
 *  - draft (no conversation yet) → `draft:<paneId>` (or `draft:default`) */
export function imagegenScopeKey(
  conversationId: string | null | undefined,
  paneId: string | null | undefined,
): ImagegenScopeKey {
  if (conversationId) return conversationId;
  return `draft:${paneId ?? "default"}`;
}
