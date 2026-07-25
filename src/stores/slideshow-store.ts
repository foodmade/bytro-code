import { create } from "zustand";
import type { Slide, SlideshowData, SlideshowPatch } from "@/types/slideshow";
import { extractSlideshowJson, parseSlideshowJson } from "@/lib/slideshow-parser";

// ── Helpers ─────────────────────────────────────────────────────────

/** Apply a single-slide patch to an existing slideshow, returning a new copy. */
function applyPatch(existing: SlideshowData, patch: SlideshowPatch): SlideshowData {
  const slides: Slide[] = [...existing.slides];
  const { slideIndex, slide, theme } = patch;

  if (slideIndex >= 0 && slideIndex < slides.length) {
    slides[slideIndex] = slide;
  } else if (slideIndex === slides.length) {
    slides.push(slide);
  }
  // Out-of-range: silently ignore

  return {
    ...existing,
    slides,
    theme: theme ? { ...existing.theme, ...theme } : existing.theme,
  };
}

// ── Types ────────────────────────────────────────────────────────────

export interface SelectedSlideElement {
  readonly slideIndex: number;
  readonly elementIndex: number;
  readonly elementType: string;
  readonly textPreview: string;
  /** Sub-index within a bullets element (individual bullet item) */
  readonly subIndex?: number;
}

interface SlideshowState {
  /** Whether the slideshow panel is visible */
  readonly isPanelOpen: boolean;
  /** The conversation that owns the slideshow panel */
  readonly ownerConversationId: string | null;
  /** The message ID containing the slideshow data */
  readonly sourceMessageId: string | null;
  /** Parsed slideshow data (may be partial during streaming) */
  readonly slideshowData: SlideshowData | null;
  /** Currently selected slide index for preview */
  readonly activeSlideIndex: number;
  /** Raw JSON string (for re-parsing during streaming) */
  readonly rawJson: string;
  /** Whether data is still streaming (JSON may be incomplete) */
  readonly isStreaming: boolean;
  /** Parse error message if JSON is malformed after stream ends */
  readonly parseError: string | null;
  /** Currently selected element in the slide preview */
  readonly selectedSlideElement: SelectedSlideElement | null;

  // ── Actions ──────────────────────────────────────────────────────

  readonly openPanel: (conversationId: string, messageId: string) => void;
  readonly closePanel: () => void;
  /** Feed raw JSON (from message content) and whether the stream is still active */
  readonly updateFromContent: (content: string, streaming: boolean) => void;
  /** Load directly from raw JSON string (no fences). Used by card to populate store for historical data. */
  readonly loadFromRawJson: (rawJson: string) => void;
  readonly setActiveSlideIndex: (index: number) => void;
  readonly selectSlideElement: (el: SelectedSlideElement) => void;
  readonly clearSlideElement: () => void;
  /** Directly update a text element in slideshowData (for inline editing) */
  readonly updateElementText: (slideIndex: number, elementIndex: number, text: string, subIndex?: number) => void;
  readonly reset: () => void;
}

// ── Store ─────────────────────────────────────────────────────────────

const INITIAL: Pick<
  SlideshowState,
  | "isPanelOpen"
  | "ownerConversationId"
  | "sourceMessageId"
  | "slideshowData"
  | "activeSlideIndex"
  | "rawJson"
  | "isStreaming"
  | "parseError"
  | "selectedSlideElement"
> = {
  isPanelOpen: false,
  ownerConversationId: null,
  sourceMessageId: null,
  slideshowData: null,
  activeSlideIndex: 0,
  rawJson: "",
  isStreaming: false,
  parseError: null,
  selectedSlideElement: null,
};

export const useSlideshowStore = create<SlideshowState>((set, get) => ({
  ...INITIAL,

  openPanel: (conversationId, messageId) =>
    set({
      isPanelOpen: true,
      ownerConversationId: conversationId,
      sourceMessageId: messageId,
    }),

  closePanel: () =>
    set({ isPanelOpen: false }),

  updateFromContent: (content, streaming) => {
    const { found, rawJson, isComplete } = extractSlideshowJson(content);
    if (!found) return;

    const prev = get();
    // Avoid unnecessary re-parses when raw JSON hasn't changed
    if (rawJson === prev.rawJson && streaming === prev.isStreaming) return;

    const shouldBeLenient = !isComplete || streaming;
    let { data, patch, error } = parseSlideshowJson(rawJson, shouldBeLenient);

    // When strict parse fails (stream ended, JSON malformed), fallback
    // to lenient parse to recover as many slides as possible.
    if (!data && !patch && !shouldBeLenient) {
      const lenientResult = parseSlideshowJson(rawJson, true);
      data = lenientResult.data;
      patch = lenientResult.patch;
      if (data || patch) {
        error = "JSON malformed, showing partial result";
      }
    }

    // Determine the new slideshowData
    let newData: SlideshowData | null = null;
    if (data) {
      // Full document — direct replacement (existing behavior)
      newData = data;
    } else if (patch && prev.slideshowData) {
      // Patch — merge into existing data
      newData = applyPatch(prev.slideshowData, patch);
    }

    set({
      rawJson,
      isStreaming: streaming,
      slideshowData: newData ?? prev.slideshowData,
      parseError: !streaming && isComplete ? error : null,
    });
  },

  loadFromRawJson: (rawJson) => {
    const trimmed = rawJson.trim();
    if (!trimmed) return;
    const { data, patch } = parseSlideshowJson(trimmed, true);
    if (data) {
      set({
        slideshowData: data,
        rawJson: trimmed,
        isStreaming: false,
        parseError: null,
      });
    } else if (patch) {
      // Historical patch — can only apply if existing data is present
      const prev = get();
      if (prev.slideshowData) {
        set({
          slideshowData: applyPatch(prev.slideshowData, patch),
          rawJson: trimmed,
          isStreaming: false,
          parseError: null,
        });
      }
    }
  },

  setActiveSlideIndex: (index) =>
    set({ activeSlideIndex: index }),

  selectSlideElement: (el) =>
    set({ selectedSlideElement: el }),

  clearSlideElement: () =>
    set({ selectedSlideElement: null }),

  updateElementText: (slideIndex, elementIndex, text, subIndex) => {
    const { slideshowData } = get();
    if (!slideshowData) return;
    const slide = slideshowData.slides[slideIndex];
    if (!slide) return;
    const el = slide.elements[elementIndex];
    if (!el) return;

    let newElement;
    if (subIndex != null && el.type === "bullets") {
      const items = el.items.map((item, i) =>
        i === subIndex ? { ...item, text } : item,
      );
      newElement = { ...el, items };
    } else {
      newElement = { ...el, text };
    }

    const newSlide: Slide = {
      ...slide,
      elements: slide.elements.map((e, i) => (i === elementIndex ? newElement : e)),
    };
    set({ slideshowData: applyPatch(slideshowData, { slideIndex, slide: newSlide }) });
  },

  reset: () => set(INITIAL),
}));
