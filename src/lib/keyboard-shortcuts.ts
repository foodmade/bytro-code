// ---------------------------------------------------------------------------
// Keyboard shortcut types, defaults, and helpers
// ---------------------------------------------------------------------------

export interface ShortcutBinding {
  readonly key: string;   // KeyboardEvent.key value, e.g. "Enter", "I"
  readonly ctrl?: boolean;
  readonly shift?: boolean;
  readonly alt?: boolean;
  readonly meta?: boolean;
}

/** All configurable shortcut action IDs */
export type ShortcutAction =
  | "sendMessage"
  | "newline"
  | "midStreamSend"
  | "quickCapture"
  | "voiceInput"
  | "skillsMenu"
  | "newSession"
  | "globalSearch";

export type ShortcutConfig = Record<ShortcutAction, ShortcutBinding>;

export const SHORTCUT_ACTIONS: ReadonlyArray<ShortcutAction> = [
  "sendMessage",
  "newline",
  "midStreamSend",
  "quickCapture",
  "voiceInput",
  "skillsMenu",
  "newSession",
  "globalSearch",
];

export const DEFAULT_SHORTCUTS: ShortcutConfig = {
  sendMessage:   { key: "Enter" },
  newline:       { key: "Enter", shift: true },
  midStreamSend: { key: "Enter", ctrl: true },
  quickCapture:  { key: "I", ctrl: true, shift: true },
  voiceInput:    { key: "m", ctrl: true, shift: true },
  skillsMenu:    { key: "k", ctrl: true },
  newSession:    { key: "n", ctrl: true },
  globalSearch:  { key: "f", ctrl: true, shift: true },
};

// ---------------------------------------------------------------------------
// Matching
// ---------------------------------------------------------------------------

/** Check whether a keyboard event matches a shortcut binding. */
export function matchesShortcut(
  e: Pick<KeyboardEvent, "key" | "ctrlKey" | "shiftKey" | "altKey" | "metaKey">,
  binding: ShortcutBinding,
): boolean {
  if (!e.key || !binding.key) return false;

  // For midStreamSend we accept either ctrlKey or metaKey (Cmd on Mac)
  const ctrlMatch = binding.ctrl
    ? (e.ctrlKey || e.metaKey)
    : (!e.ctrlKey && !e.metaKey);

  // Compare keys case-insensitively — when Shift is held, e.key is
  // uppercase (e.g. "M") but the binding stores lowercase ("m").
  const keyMatch = e.key.length === 1 && binding.key.length === 1
    ? e.key.toLowerCase() === binding.key.toLowerCase()
    : e.key === binding.key;

  return (
    keyMatch &&
    ctrlMatch &&
    !!e.shiftKey === !!binding.shift &&
    !!e.altKey === !!binding.alt
  );
}

// ---------------------------------------------------------------------------
// Formatting for display
// ---------------------------------------------------------------------------

const IS_MAC = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.userAgent);

function modLabel(mod: string): string {
  if (IS_MAC) {
    switch (mod) {
      case "ctrl":  return "⌘";
      case "shift": return "⇧";
      case "alt":   return "⌥";
      case "meta":  return "⌘";
      default:      return mod;
    }
  }
  switch (mod) {
    case "ctrl":  return "Ctrl";
    case "shift": return "Shift";
    case "alt":   return "Alt";
    case "meta":  return "Win";
    default:      return mod;
  }
}

function keyLabel(key: string): string {
  if (key === " ") return "Space";
  if (key.length === 1) return key.toUpperCase();
  return key; // "Enter", "Tab", "Escape", etc.
}

/** Return an array of display labels for each part of the shortcut, e.g. ["⌘", "⇧", "I"] */
export function formatShortcutParts(binding: ShortcutBinding): string[] {
  const parts: string[] = [];
  if (binding.ctrl)  parts.push(modLabel("ctrl"));
  if (binding.shift) parts.push(modLabel("shift"));
  if (binding.alt)   parts.push(modLabel("alt"));
  if (binding.meta && !binding.ctrl) parts.push(modLabel("meta"));
  parts.push(keyLabel(binding.key));
  return parts;
}

/** Format shortcut as a single joined string, e.g. "⌘+⇧+I" */
export function formatShortcut(binding: ShortcutBinding): string {
  return formatShortcutParts(binding).join(IS_MAC ? "" : "+");
}

// ---------------------------------------------------------------------------
// Equality / conflict detection
// ---------------------------------------------------------------------------

function bindingsEqual(a: ShortcutBinding, b: ShortcutBinding): boolean {
  return (
    a.key === b.key &&
    !!a.ctrl === !!b.ctrl &&
    !!a.shift === !!b.shift &&
    !!a.alt === !!b.alt &&
    !!a.meta === !!b.meta
  );
}

/**
 * Find which other action (if any) conflicts with the given binding.
 * Returns the conflicting action ID, or null.
 */
export function findConflict(
  config: ShortcutConfig,
  action: ShortcutAction,
  binding: ShortcutBinding,
): ShortcutAction | null {
  for (const id of SHORTCUT_ACTIONS) {
    if (id === action) continue;
    if (bindingsEqual(config[id], binding)) return id;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Serialization helpers
// ---------------------------------------------------------------------------

export function parseShortcuts(json: string): ShortcutConfig {
  try {
    const parsed = JSON.parse(json);
    // Validate: ensure every action key exists and has at least a `key` field
    const result = { ...DEFAULT_SHORTCUTS };
    for (const action of SHORTCUT_ACTIONS) {
      if (parsed[action] && typeof parsed[action].key === "string") {
        result[action] = parsed[action];
      }
    }
    return result;
  } catch {
    return { ...DEFAULT_SHORTCUTS };
  }
}

export function stringifyShortcuts(config: ShortcutConfig): string {
  return JSON.stringify(config);
}
