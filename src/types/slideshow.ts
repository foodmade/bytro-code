// ---------------------------------------------------------------------------
// Slideshow / Presentation data types
// Used by the PPTX creative mode to represent structured slide data
// ---------------------------------------------------------------------------

/** A single bullet point in a list */
export interface SlideBulletItem {
  readonly text: string;
  readonly level?: number; // 0 = top-level, 1 = sub-bullet
}

/** Slide title element */
export interface SlideTitle {
  readonly type: "title";
  readonly text: string;
  readonly level?: 1 | 2; // 1 = main title, 2 = subtitle
}

/** Slide paragraph element */
export interface SlideParagraph {
  readonly type: "paragraph";
  readonly text: string;
}

/** Slide bullet list element */
export interface SlideBulletList {
  readonly type: "bullets";
  readonly items: readonly SlideBulletItem[];
}

/** Union of all possible slide elements */
export type SlideElement = SlideTitle | SlideParagraph | SlideBulletList;

/** Layout type for a slide */
export type SlideLayout = "title" | "section" | "content" | "two-column";

/** A single slide */
export interface Slide {
  readonly layout: SlideLayout;
  readonly elements: readonly SlideElement[];
  readonly notes?: string;
  /** Lucide icon name for visual decoration (e.g. "rocket", "brain") */
  readonly icon?: string;
  /** Unsplash search keyword for a stock photo (e.g. "technology") */
  readonly imageKeyword?: string;
}

/** Theme parameters chosen by the AI */
export interface SlideshowTheme {
  readonly backgroundColor?: string;
  readonly titleColor?: string;
  readonly textColor?: string;
  readonly accentColor?: string;
  readonly fontFamily?: string;
}

/** The complete slideshow document */
export interface SlideshowData {
  readonly title: string;
  readonly theme?: SlideshowTheme;
  readonly slides: readonly Slide[];
}

/** Patch that replaces a single slide at a specific index */
export interface SlideshowPatch {
  readonly slideIndex: number;
  readonly slide: Slide;
  readonly theme?: SlideshowTheme;
}
