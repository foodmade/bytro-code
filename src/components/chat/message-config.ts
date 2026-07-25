import type { AgentRole } from "@/types";

// ---------------------------------------------------------------------------
// Agent visual configuration
// ---------------------------------------------------------------------------

export interface AgentConfig {
  readonly label: string;
  readonly avatar: string;
  /** Optional platform icon URL — when set, rendered as <img> instead of text initial. */
  readonly iconUrl?: string;
  readonly avatarBg: string;
  readonly avatarTextColor: string;
  readonly nameColor: string;
  readonly modelColor: string;
  readonly brandColor: string;
}

export const FALLBACK_CONFIG: AgentConfig = {
  label: "Agent",
  avatar: "?",
  avatarBg: "#1A1A1A",
  avatarTextColor: "#888888",
  nameColor: "#888888",
  modelColor: "#555555",
  brandColor: "#888888",
};

// ---------------------------------------------------------------------------
// Provider-specific overrides keyed by modelTag prefix (case-insensitive).
// When a provider shares an agent role with another (e.g. DeepSeek and Qwen
// both use role "claude"), these overrides ensure each provider gets its own
// avatar, label, and color scheme.
// ---------------------------------------------------------------------------

const PROVIDER_OVERRIDES: ReadonlyArray<{
  readonly prefix: string;
  readonly config: AgentConfig;
}> = [
  {
    prefix: "qwen",
    config: {
      label: "Qwen",
      avatar: "Q",
      avatarBg: "#1A1A3E",
      avatarTextColor: "#6366F1",
      nameColor: "#A5B4FC",
      modelColor: "#4338CA",
      brandColor: "#6366F1",
    },
  },
  {
    prefix: "deepseek",
    config: {
      label: "DeepSeek",
      avatar: "D",
      avatarBg: "#0F2028",
      avatarTextColor: "#06B6D4",
      nameColor: "#67E8F9",
      modelColor: "#0E7490",
      brandColor: "#06B6D4",
    },
  },
  {
    prefix: "glm",
    config: {
      label: "BigModel",
      avatar: "B",
      avatarBg: "#0F1A2E",
      avatarTextColor: "#3B82F6",
      nameColor: "#93C5FD",
      modelColor: "#1D4ED8",
      brandColor: "#3B82F6",
    },
  },
  {
    prefix: "grok",
    config: {
      label: "Grok",
      avatar: "G",
      avatarBg: "#2A1215",
      avatarTextColor: "#EF4444",
      nameColor: "#FCA5A5",
      modelColor: "#991B1B",
      brandColor: "#EF4444",
    },
  },
];

/**
 * Resolve the visual config for an agent message.
 * When the role is generic (e.g. "chatcmpl"), attempt to detect the actual
 * provider from the modelTag and return a provider-specific config.
 */
export function resolveAgentConfig(role: AgentRole, modelTag?: string): AgentConfig {
  const base = AGENT_CONFIG[role] ?? FALLBACK_CONFIG;
  if (!modelTag) return base;

  const lower = modelTag.toLowerCase();
  for (const override of PROVIDER_OVERRIDES) {
    if (lower.startsWith(override.prefix)) {
      return override.config;
    }
  }
  return base;
}

export const AGENT_CONFIG: Partial<Record<AgentRole, AgentConfig>> = {
  user: {
    label: "You",
    avatar: "Y",
    avatarBg: "var(--color-border-light)",
    avatarTextColor: "#E0E0E0",
    nameColor: "#E0E0E0",
    modelColor: "",
    brandColor: "",
  },
  claude: {
    label: "Claude",
    avatar: "C",
    avatarBg: "#2D1B4E",
    avatarTextColor: "#A855F7",
    nameColor: "#C4B5FD",
    modelColor: "#6B4FA0",
    brandColor: "#A855F7",
  },
  codex: {
    label: "Codex",
    avatar: "X",
    avatarBg: "#0F2922",
    avatarTextColor: "#10B981",
    nameColor: "#6EE7B7",
    modelColor: "#166534",
    brandColor: "#10B981",
  },
  gemini: {
    label: "Gemini",
    avatar: "G",
    avatarBg: "#1B2B4E",
    avatarTextColor: "#4285F4",
    nameColor: "#93B4F4",
    modelColor: "#3B5998",
    brandColor: "#4285F4",
  },
  chatcmpl: {
    label: "Assistant",
    avatar: "A",
    avatarBg: "#0F2922",
    avatarTextColor: "#10B981",
    nameColor: "#6EE7B7",
    modelColor: "#166534",
    brandColor: "#10B981",
  },
  system: {
    label: "System",
    avatar: "S",
    avatarBg: "#1B2B4E",
    avatarTextColor: "#4285F4",
    nameColor: "#93B4F4",
    modelColor: "#3B5998",
    brandColor: "#4285F4",
  },
};

// ---------------------------------------------------------------------------
// Time formatting
// ---------------------------------------------------------------------------

export function formatTime(ts: number): string {
  const d = new Date(ts);
  return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false });
}

export function formatRelativeTime(input: string | number): string {
  const ts = typeof input === "string" ? new Date(input).getTime() : input;
  const diff = Date.now() - ts;
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "now";
  if (mins < 60) return `${mins}m`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h`;
  const days = Math.floor(hrs / 24);
  if (days < 7) return `${days}d`;
  return new Date(ts).toLocaleDateString();
}

// ---------------------------------------------------------------------------
// Parse <file> / <directory> attachment blocks from user messages
// ---------------------------------------------------------------------------

export interface AttachmentBlock {
  readonly kind: "file" | "directory";
  readonly path: string;
  readonly content: string;
  readonly source?: "file" | "pasted-text";
}

export interface SelectionSnippetRef {
  readonly id: string;
  readonly path: string;
  readonly label: string;
}

export interface ElementContext {
  readonly tagName: string;
  readonly xpath: string;
}

export interface SlideElementContext {
  readonly page: number;
  readonly elementType: string;
  readonly textPreview: string;
}

/** A segment of parsed user content — either plain text or a file/directory reference. */
export type ContentSegment =
  | { readonly type: "text"; readonly text: string }
  | { readonly type: "attachment"; readonly attachment: AttachmentBlock }
  | { readonly type: "selection"; readonly selection: SelectionSnippetRef };

export interface ParsedUserContent {
  readonly segments: ReadonlyArray<ContentSegment>;
  readonly attachments: ReadonlyArray<AttachmentBlock>;
  readonly selections: ReadonlyArray<SelectionSnippetRef>;
  readonly text: string;
  readonly elementContext: ElementContext | null;
  readonly slideElementContext: SlideElementContext | null;
  /** Active `$mode` chips at submit time, parsed out of <mode-chip name="..."/> markers
   *  embedded in displayContent by the streaming hook. Rendered as purple chips above
   *  the message body so the user can see what mode was active for that turn. */
  readonly modes: ReadonlyArray<string>;
}

/** Matches the element context block injected by formatElementPrompt */
const ELEMENT_CONTEXT_RE =
  /\n?I want to modify this element \(xpath: `([^`]+)`\):\n```html\n[\s\S]*?```(?:\n\nCurrent key styles:\n```json\n[\s\S]*?```)?\n*/;

/** Matches the slide element marker injected by handleSend */
const SLIDE_ELEMENT_RE =
  /^<slide-element page="(\d+)" type="([^"]*)" text="([^"]*)"\s*\/>\n*/;

/** Matches mode chip markers injected by use-chat-streaming when the user
 *  submitted with `$mode` chips active. Rendered as visible chips above the
 *  message body. May appear multiple times separated by spaces. */
const MODE_CHIP_RE = /<mode-chip\s+name="([^"]*?)"\s*\/>/g;

/**
 * Combined regex that matches both full attachment blocks and lightweight
 * file-ref markers. Used for ordered segment parsing.
 */
const COMBINED_RE =
  /<(file|directory)\s+path="([^"]*)"(?:\s+source="([^"]*)")?>\n?([\s\S]*?)\n?<\/\1>|<file-ref\s+path="([^"]*?)"\s+kind="([^"]*?)"(?:\s+source="([^"]*)")?\/>|<selection-ref\s+id="([^"]*?)"(?:\s+path="([^"]*?)")?(?:\s+label="([^"]*?)")?\s*\/>/g;

function parseAttachmentSource(value: string | undefined): AttachmentBlock["source"] {
  return value === "pasted-text" || value === "file" ? value : undefined;
}

export function parseUserContent(raw: string): ParsedUserContent {
  const segments: ContentSegment[] = [];
  const attachments: AttachmentBlock[] = [];
  const selections: SelectionSnippetRef[] = [];
  let elementContext: ElementContext | null = null;
  let slideElementContext: SlideElementContext | null = null;
  const modes: string[] = [];
  const seenModes = new Set<string>();

  // Extract element context
  const elMatch = raw.match(ELEMENT_CONTEXT_RE);
  let cleaned = raw;
  if (elMatch) {
    const xpath = elMatch[1];
    const lastSeg = xpath.split("/").pop() ?? "";
    const tagName = lastSeg.replace(/\[.*$/, "").toLowerCase() || "element";
    elementContext = { tagName, xpath };
    cleaned = cleaned.replace(ELEMENT_CONTEXT_RE, "");
  }

  // Extract slide element context
  const slideMatch = cleaned.match(SLIDE_ELEMENT_RE);
  if (slideMatch) {
    slideElementContext = {
      page: Number(slideMatch[1]),
      elementType: slideMatch[2],
      textPreview: slideMatch[3],
    };
    cleaned = cleaned.replace(SLIDE_ELEMENT_RE, "");
  }

  // Extract mode chip markers (deduplicating in insertion order)
  cleaned = cleaned.replace(MODE_CHIP_RE, (_, name: string) => {
    const id = name.trim();
    if (id && !seenModes.has(id)) {
      seenModes.add(id);
      modes.push(id);
    }
    return "";
  });
  // The marker line typically ends with "\n" — strip leading whitespace left
  // behind so we don't render an empty paragraph above the message text.
  cleaned = cleaned.replace(/^\s*\n/, "");

  // Parse segments in order, handling both full blocks and file-ref markers
  let lastIndex = 0;
  const regex = new RegExp(COMBINED_RE.source, "g");
  let match: RegExpExecArray | null;

  while ((match = regex.exec(cleaned)) !== null) {
    // Add text before this match
    if (match.index > lastIndex) {
      const textBefore = cleaned.slice(lastIndex, match.index);
      const trimmedText = textBefore.replace(/^\n\n|\n\n$/g, "").trim();
      if (trimmedText) {
        segments.push({ type: "text", text: trimmedText });
      }
    }

    if (match[8]) {
      const selection = {
        id: match[8].replace(/&amp;/g, "&").replace(/&quot;/g, '"'),
        path: (match[9] ?? "").replace(/&amp;/g, "&").replace(/&quot;/g, '"'),
        label: (match[10] ?? "").replace(/&amp;/g, "&").replace(/&quot;/g, '"'),
      };
      selections.push(selection);
      segments.push({ type: "selection", selection });
    } else {
      const source = parseAttachmentSource(match[1] ? match[3] : match[7]);
      const att: AttachmentBlock = match[1]
        ? {
            kind: match[1] as "file" | "directory",
            path: match[2].replace(/&amp;/g, "&").replace(/&quot;/g, '"'),
            content: (match[4] ?? "").trim(),
            ...(source ? { source } : {}),
          }
        : {
            kind: (match[6] ?? "file") as "file" | "directory",
            path: (match[5] ?? "").replace(/&amp;/g, "&").replace(/&quot;/g, '"'),
            content: "",
            ...(source ? { source } : {}),
          };
      attachments.push(att);
      segments.push({ type: "attachment", attachment: att });
    }

    lastIndex = match.index + match[0].length;
  }

  // Add remaining text
  if (lastIndex < cleaned.length) {
    const remaining = cleaned.slice(lastIndex).replace(/^\n\n/, "").trim();
    if (remaining) {
      segments.push({ type: "text", text: remaining });
    }
  }

  // Build combined text (all text segments joined)
  const text = segments
    .filter((s): s is { readonly type: "text"; readonly text: string } => s.type === "text")
    .map((s) => s.text)
    .join(" ")
    .trim();

  return { segments, attachments, selections, text, elementContext, slideElementContext, modes };
}

/** Extract the file/folder name from a full path */
export function baseName(fullPath: string): string {
  const normalized = fullPath.replace(/\\/g, "/");
  return normalized.split("/").filter(Boolean).pop() ?? fullPath;
}
