/**
 * Types, interfaces, and state reducer for the ChatInput component.
 */

import type { PastedImage } from "./image-preview";
import type { ChatMessageMetadata } from "@/lib/live-review-events";

export type { ChatMessageMetadata };

// ---------------------------------------------------------------------------
// Dropdown state reducer — consolidates mention + slash into atomic updates
// ---------------------------------------------------------------------------

export interface DropdownState {
  readonly mentionShow: boolean;
  readonly mentionQuery: string;
  readonly mentionIndex: number;
  readonly slashShow: boolean;
  readonly slashQuery: string;
  readonly slashIndex: number;
}

export type DropdownAction =
  | { type: "MENTION_OPEN"; query: string }
  | { type: "MENTION_UPDATE_QUERY"; query: string }
  | { type: "MENTION_SET_INDEX"; index: number }
  | { type: "MENTION_CLOSE" }
  | { type: "SLASH_OPEN"; query: string }
  | { type: "SLASH_SET_INDEX"; index: number }
  | { type: "SLASH_CLOSE" }
  | { type: "CLOSE_ALL" };

export const DROPDOWN_INITIAL: DropdownState = {
  mentionShow: false,
  mentionQuery: "",
  mentionIndex: 0,
  slashShow: false,
  slashQuery: "",
  slashIndex: 0,
};

export function dropdownReducer(state: DropdownState, action: DropdownAction): DropdownState {
  switch (action.type) {
    case "MENTION_OPEN":
      return { ...state, mentionShow: true, mentionQuery: action.query, mentionIndex: 0, slashShow: false, slashQuery: "" };
    case "MENTION_UPDATE_QUERY":
      return { ...state, mentionQuery: action.query };
    case "MENTION_SET_INDEX":
      return { ...state, mentionIndex: action.index };
    case "MENTION_CLOSE":
      return { ...state, mentionShow: false, mentionQuery: "", mentionIndex: 0 };
    case "SLASH_OPEN":
      return { ...state, slashShow: true, slashQuery: action.query, slashIndex: 0 };
    case "SLASH_SET_INDEX":
      return { ...state, slashIndex: action.index };
    case "SLASH_CLOSE":
      return { ...state, slashShow: false, slashQuery: "", slashIndex: 0 };
    case "CLOSE_ALL":
      return DROPDOWN_INITIAL;
    default:
      return state;
  }
}

// ---------------------------------------------------------------------------
// Component interfaces
// ---------------------------------------------------------------------------

export interface AttachedFile {
  readonly id: string;
  readonly name: string;
  readonly content?: string;
  readonly path?: string;
}

export interface ChatInputProps {
  /** Send the user message. The trailing `metadata` parameter is reserved
   *  for structured-input forwards (Live Reviewer card, future agentic
   *  forwards, etc.) — passing a `reviewForward` here causes the message
   *  to render as a compact card instead of a normal bubble. */
  readonly onSend: (
    message: string,
    images?: ReadonlyArray<PastedImage>,
    displayContent?: string,
    modes?: ReadonlyArray<string>,
    metadata?: ChatMessageMetadata,
  ) => boolean | void | Promise<boolean | void>;
  readonly onStop?: () => void;
  /** Send a mid-stream message into an active conversation (Ctrl+Enter). */
  readonly onSendMidStream?: (
    message: string,
    images?: ReadonlyArray<PastedImage>,
    displayContent?: string,
    modes?: ReadonlyArray<string>,
    metadata?: ChatMessageMetadata,
  ) => boolean | void | Promise<boolean | void>;
  readonly isStreaming?: boolean;
  /** When set, the prompt is sent automatically on mount (used by quick actions). */
  readonly autoSendPrompt?: string;
  /** Quoted text to prepend to the message when sending. */
  readonly quotedText?: string | null;
  /** Called after the quote is consumed on send. */
  readonly onClearQuote?: () => void;
  /** Active conversation ID — used to save/restore per-conversation input drafts. */
  readonly conversationId?: string | null;
  /** Active pane ID in split mode — used for pane-scoped model selection. */
  readonly paneId?: string;
}
