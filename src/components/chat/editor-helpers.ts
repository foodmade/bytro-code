/**
 * contentEditable inline editor helpers.
 *
 * Provides DOM utilities for the rich-text chat input that embeds
 * non-editable file-chip and skill-chip elements alongside plain text.
 */

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------
export const CHIP_ATTR = "data-file-path";
const CHIP_ATTR_DIR = "data-is-dir";
export const SKILL_CHIP_ATTR = "data-skill-name";
export const SNIPPET_CHIP_ATTR = "data-selection-snippet-id";
const SNIPPET_CHIP_PATH_ATTR = "data-selection-snippet-path";
const SNIPPET_CHIP_LABEL_ATTR = "data-selection-snippet-label";
/** Mode chip — selected via the `$` quick-command menu. Mode chips are
 *  zero-width in the text stream (skipped by getEditorText) and travel as a
 *  separate `modes` list to the streaming hook, which translates each mode
 *  into a deterministic system-prompt directive. */
const MODE_CHIP_ATTR = "data-mode-name";

export interface DOMPos {
  node: Node;
  offset: number;
}

export interface MentionedFile {
  readonly path: string;
  readonly name: string;
  readonly isDir?: boolean;
}

export interface SelectionSnippet {
  readonly id: string;
  readonly filePath: string;
  readonly fileName: string;
  readonly language: string;
  readonly text: string;
  readonly label: string;
  readonly range: {
    readonly startLineNumber: number;
    readonly startColumn: number;
    readonly endLineNumber: number;
    readonly endColumn: number;
  };
}

// ---------------------------------------------------------------------------
// Chip type check helpers
// ---------------------------------------------------------------------------

/** Check if an element is any kind of chip (file, skill, or mode) */
function isChipElement(el: HTMLElement): boolean {
  return (
    el.hasAttribute(CHIP_ATTR) ||
    el.hasAttribute(SKILL_CHIP_ATTR) ||
    el.hasAttribute(SNIPPET_CHIP_ATTR) ||
    el.hasAttribute(MODE_CHIP_ATTR)
  );
}

/** Get the text length a skill chip contributes (/{name} ) */
function skillChipTextLength(el: HTMLElement): number {
  const name = el.getAttribute(SKILL_CHIP_ATTR) ?? "";
  return name.length + 2; // "/{name} "
}

// ---------------------------------------------------------------------------
// SVG icon templates — created once, cloned on demand (avoids innerHTML XSS)
// ---------------------------------------------------------------------------
const SVG_NS = "http://www.w3.org/2000/svg";

function createSvgIcon(paths: readonly string[]): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("width", "10");
  svg.setAttribute("height", "10");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", "2");
  svg.setAttribute("stroke-linecap", "round");
  svg.setAttribute("stroke-linejoin", "round");
  for (const d of paths) {
    const p = document.createElementNS(SVG_NS, "path");
    p.setAttribute("d", d);
    svg.appendChild(p);
  }
  return svg;
}

let _folderIcon: SVGSVGElement | null = null;
let _fileIcon: SVGSVGElement | null = null;
let _closeIcon: SVGSVGElement | null = null;

function getFolderIcon(): SVGSVGElement {
  if (!_folderIcon) {
    _folderIcon = createSvgIcon([
      "m6 14 1.5-2.9A2 2 0 0 1 9.24 10H20a2 2 0 0 1 1.94 2.5l-1.54 6a2 2 0 0 1-1.95 1.5H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h3.9a2 2 0 0 1 1.69.9l.81 1.2a2 2 0 0 0 1.67.9H18a2 2 0 0 1 2 2v2",
    ]);
  }
  return _folderIcon;
}

function getFileIcon(): SVGSVGElement {
  if (!_fileIcon) {
    _fileIcon = createSvgIcon([
      "M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z",
      "M14 2v4a2 2 0 0 0 2 2h4",
      "M10 9H8",
      "M16 13H8",
      "M16 17H8",
    ]);
  }
  return _fileIcon;
}

function getCloseIcon(): SVGSVGElement {
  if (!_closeIcon) {
    _closeIcon = createSvgIcon(["M18 6 6 18", "m6 6 12 12"]);
  }
  return _closeIcon;
}

// ---------------------------------------------------------------------------
// Text extraction
// ---------------------------------------------------------------------------

/** Extract plain-text from the editor, ignoring file chips, preserving skill chips as text */
export function getEditorText(editor: HTMLElement): string {
  let text = "";
  for (const node of Array.from(editor.childNodes)) {
    if (node.nodeType === Node.TEXT_NODE) {
      text += node.textContent ?? "";
    } else if (node.nodeType === Node.ELEMENT_NODE) {
      const el = node as HTMLElement;
      if (el.hasAttribute(CHIP_ATTR)) {
        // file chip — skip (files sent separately)
      } else if (el.hasAttribute(SNIPPET_CHIP_ATTR)) {
        // snippet chip — skip (snippets sent separately)
      } else if (el.hasAttribute(MODE_CHIP_ATTR)) {
        // mode chip — skip (modes travel via a separate channel)
      } else if (el.hasAttribute(SKILL_CHIP_ATTR)) {
        // skill chip — output as /{name} so it appears in the sent text
        text += `/${el.getAttribute(SKILL_CHIP_ATTR)} `;
      } else if (el.tagName === "BR") {
        text += "\n";
      } else {
        // Ensure a newline before block elements when preceded by content
        if ((el.tagName === "DIV" || el.tagName === "P") && text.length > 0 && !text.endsWith("\n")) {
          text += "\n";
        }
        text += getEditorText(el);
        if (el.tagName === "DIV" || el.tagName === "P") text += "\n";
      }
    }
  }
  return text;
}

/**
 * Extract text from the editor, inserting <file-ref> markers at file chip
 * positions instead of skipping them. This preserves the inline ordering
 * of file references relative to surrounding text.
 */
export function getEditorTextWithFileRefs(editor: HTMLElement): string {
  let text = "";
  for (const node of Array.from(editor.childNodes)) {
    if (node.nodeType === Node.TEXT_NODE) {
      text += node.textContent ?? "";
    } else if (node.nodeType === Node.ELEMENT_NODE) {
      const el = node as HTMLElement;
      if (el.hasAttribute(CHIP_ATTR)) {
        const path = el.getAttribute(CHIP_ATTR) ?? "";
        const isDir = el.hasAttribute(CHIP_ATTR_DIR);
        const escapedPath = path.replace(/&/g, "&amp;").replace(/"/g, "&quot;");
        text += `<file-ref path="${escapedPath}" kind="${isDir ? "directory" : "file"}"/>`;
      } else if (el.hasAttribute(SNIPPET_CHIP_ATTR)) {
        const id = el.getAttribute(SNIPPET_CHIP_ATTR) ?? "";
        const path = el.getAttribute(SNIPPET_CHIP_PATH_ATTR) ?? "";
        const label = el.getAttribute(SNIPPET_CHIP_LABEL_ATTR) ?? "";
        const escapedId = id.replace(/&/g, "&amp;").replace(/"/g, "&quot;");
        const escapedPath = path.replace(/&/g, "&amp;").replace(/"/g, "&quot;");
        const escapedLabel = label.replace(/&/g, "&amp;").replace(/"/g, "&quot;");
        text += `<selection-ref id="${escapedId}" path="${escapedPath}" label="${escapedLabel}"/>`;
      } else if (el.hasAttribute(MODE_CHIP_ATTR)) {
        // mode chip — skip (modes travel via a separate channel)
      } else if (el.hasAttribute(SKILL_CHIP_ATTR)) {
        text += `/${el.getAttribute(SKILL_CHIP_ATTR)} `;
      } else if (el.tagName === "BR") {
        text += "\n";
      } else {
        // Ensure a newline before block elements when preceded by content
        if ((el.tagName === "DIV" || el.tagName === "P") && text.length > 0 && !text.endsWith("\n")) {
          text += "\n";
        }
        text += getEditorTextWithFileRefs(el);
        if (el.tagName === "DIV" || el.tagName === "P") text += "\n";
      }
    }
  }
  return text;
}

// ---------------------------------------------------------------------------
// DOM ↔ text-offset conversion
// ---------------------------------------------------------------------------

/** Convert a text-only offset to a DOM node + offset, skipping file chip elements */
function textOffsetToDOM(editor: HTMLElement, textOffset: number): DOMPos | null {
  return textOffsetToDOMRecursive(editor, textOffset).result;
}

/** Internal recursive helper for nested elements */
function textOffsetToDOMRecursive(
  parent: HTMLElement,
  startRemaining: number,
): { result: DOMPos | null; remaining: number } {
  let remaining = startRemaining;
  for (const child of Array.from(parent.childNodes)) {
    if (child.nodeType === Node.TEXT_NODE) {
      const len = (child.textContent ?? "").length;
      if (remaining <= len) return { result: { node: child, offset: remaining }, remaining: 0 };
      remaining -= len;
    } else if (child.nodeType === Node.ELEMENT_NODE) {
      const el = child as HTMLElement;
      if (el.hasAttribute(CHIP_ATTR)) continue; // file chip — 0 width
      if (el.hasAttribute(MODE_CHIP_ATTR)) continue; // mode chip — 0 width
      if (el.hasAttribute(SKILL_CHIP_ATTR)) {
        const sLen = skillChipTextLength(el);
        if (remaining <= sLen) {
          const idx = Array.from(parent.childNodes).indexOf(child as ChildNode);
          return { result: { node: parent, offset: idx + 1 }, remaining: 0 };
        }
        remaining -= sLen;
        continue;
      }
      if (el.tagName === "BR") {
        if (remaining === 0) {
          const idx = Array.from(parent.childNodes).indexOf(child as ChildNode);
          return { result: { node: parent, offset: idx }, remaining: 0 };
        }
        remaining -= 1;
      } else {
        const nested = textOffsetToDOMRecursive(el, remaining);
        if (nested.result) return nested;
        remaining = nested.remaining;
        if (el.tagName === "DIV" || el.tagName === "P") remaining -= 1;
      }
    }
  }
  return { result: null, remaining };
}

// ---------------------------------------------------------------------------
// Cursor position (optimised — no cloneContents / temporary DOM)
// ---------------------------------------------------------------------------

/**
 * Get cursor position as a text-only offset (file chips = 0 width,
 * skill chips = /{name} length).
 *
 * Walks the editor's DOM tree up to the cursor anchor, accumulating
 * text length. Avoids `Range.cloneContents()` and temporary DOM nodes,
 * reducing GC pressure on every keystroke.
 */
export function getEditorCursorPos(editor: HTMLElement): number {
  const sel = window.getSelection();
  if (!sel || !sel.rangeCount) return 0;
  const { startContainer, startOffset } = sel.getRangeAt(0);
  return countTextBefore(editor, startContainer, startOffset);
}

/** Count text-only characters from the start of `root` up to `(target, offset)`. */
function countTextBefore(root: HTMLElement, target: Node, targetOffset: number): number {
  let count = 0;
  const done = walkUntil(root, target, targetOffset, (_n, len) => {
    count += len;
    return _n === target;
  });
  if (!done && target === root) {
    let i = 0;
    for (const child of Array.from(root.childNodes)) {
      if (i >= targetOffset) break;
      count += nodeTextLength(child);
      i++;
    }
  }
  return count;
}

/**
 * Depth-first walk, calling `visitor(node, partialLength)` for each text/BR/skill-chip
 * node encountered. Visitor receives the partial length to add and returns
 * `true` when we should stop.
 */
function walkUntil(
  parent: Node,
  target: Node,
  targetOffset: number,
  visitor: (node: Node, len: number) => boolean,
): boolean {
  for (const child of Array.from(parent.childNodes)) {
    if (child === target) {
      if (child.nodeType === Node.TEXT_NODE) {
        visitor(child, targetOffset);
      }
      return true;
    }

    if (child.nodeType === Node.TEXT_NODE) {
      const len = (child.textContent ?? "").length;
      if (visitor(child, len)) return true;
    } else if (child.nodeType === Node.ELEMENT_NODE) {
      const el = child as HTMLElement;
      if (el.hasAttribute(CHIP_ATTR)) continue; // file chip — 0 width
      if (el.hasAttribute(MODE_CHIP_ATTR)) continue; // mode chip — 0 width
      if (el.hasAttribute(SKILL_CHIP_ATTR)) {
        // skill chip — contributes /{name} text
        const sLen = skillChipTextLength(el);
        if (visitor(child, sLen)) return true;
        continue;
      }
      if (el.tagName === "BR") {
        if (visitor(child, 1)) return true;
      } else {
        if (el.contains(target)) {
          const found = walkUntil(el, target, targetOffset, visitor);
          if (found) return true;
        } else {
          const len = nodeTextLength(el);
          visitor(el, len);
          if (el.tagName === "DIV" || el.tagName === "P") visitor(el, 1);
        }
      }
    }
  }
  return false;
}

/** Total text-only length of a node subtree (file chips = 0, skill chips = /{name} ). */
function nodeTextLength(node: Node): number {
  if (node.nodeType === Node.TEXT_NODE) return (node.textContent ?? "").length;
  if (node.nodeType !== Node.ELEMENT_NODE) return 0;
  const el = node as HTMLElement;
  if (el.hasAttribute(CHIP_ATTR)) return 0;
  if (el.hasAttribute(SNIPPET_CHIP_ATTR)) return 0;
  if (el.hasAttribute(MODE_CHIP_ATTR)) return 0;
  if (el.hasAttribute(SKILL_CHIP_ATTR)) return skillChipTextLength(el);
  if (el.tagName === "BR") return 1;
  let len = 0;
  for (const child of Array.from(el.childNodes)) {
    len += nodeTextLength(child);
  }
  if (el.tagName === "DIV" || el.tagName === "P") len += 1;
  return len;
}

// ---------------------------------------------------------------------------
// Selection helpers
// ---------------------------------------------------------------------------

/** Select a range by text offsets */
export function setEditorSelection(editor: HTMLElement, start: number, end: number): void {
  const startPos = textOffsetToDOM(editor, start);
  const endPos = textOffsetToDOM(editor, end);
  if (!startPos || !endPos) return;
  const sel = window.getSelection();
  if (!sel) return;
  const r = document.createRange();
  r.setStart(startPos.node, startPos.offset);
  r.setEnd(endPos.node, endPos.offset);
  sel.removeAllRanges();
  sel.addRange(r);
}

// ---------------------------------------------------------------------------
// Chip DOM creation (theme-aware via CSS classes, no inline colors)
// ---------------------------------------------------------------------------

/** Create a file chip DOM element for inline display in contentEditable */
export function createChipElement(file: { path: string; name: string; isDir?: boolean }): HTMLSpanElement {
  const chip = document.createElement("span");
  chip.setAttribute(CHIP_ATTR, file.path);
  if (file.isDir) chip.setAttribute(CHIP_ATTR_DIR, "true");
  chip.setAttribute("contenteditable", "false");
  chip.className = file.isDir
    ? "inline-file-chip inline-file-chip--dir"
    : "inline-file-chip inline-file-chip--file";

  // Icon
  const icon = document.createElement("span");
  icon.className = "inline-file-chip__icon";
  icon.appendChild(
    (file.isDir ? getFolderIcon() : getFileIcon()).cloneNode(true),
  );
  chip.appendChild(icon);

  // Name
  const nameSpan = document.createElement("span");
  nameSpan.className = "inline-file-chip__name";
  nameSpan.textContent = file.name;
  chip.appendChild(nameSpan);

  // Close button
  const closeBtn = document.createElement("span");
  closeBtn.className = "chip-close-btn";
  closeBtn.appendChild(getCloseIcon().cloneNode(true));
  chip.appendChild(closeBtn);

  return chip;
}

export function createSnippetChipElement(snippet: SelectionSnippet): HTMLSpanElement {
  const chip = document.createElement("span");
  chip.setAttribute(SNIPPET_CHIP_ATTR, snippet.id);
  chip.setAttribute(SNIPPET_CHIP_PATH_ATTR, snippet.filePath);
  chip.setAttribute(SNIPPET_CHIP_LABEL_ATTR, snippet.label);
  chip.setAttribute("contenteditable", "false");
  chip.className = "inline-file-chip inline-snippet-chip";
  chip.title = snippet.filePath;

  const icon = document.createElement("span");
  icon.className = "inline-file-chip__icon";
  icon.appendChild(getFileIcon().cloneNode(true));
  chip.appendChild(icon);

  const nameSpan = document.createElement("span");
  nameSpan.className = "inline-file-chip__name";
  nameSpan.textContent = snippet.label;
  chip.appendChild(nameSpan);

  const closeBtn = document.createElement("span");
  closeBtn.className = "chip-close-btn";
  closeBtn.appendChild(getCloseIcon().cloneNode(true));
  chip.appendChild(closeBtn);

  return chip;
}

/** Create a skill chip DOM element for inline display in contentEditable */
export function createSkillChipElement(name: string): HTMLSpanElement {
  const chip = document.createElement("span");
  chip.setAttribute(SKILL_CHIP_ATTR, name);
  chip.setAttribute("contenteditable", "false");
  chip.className = "inline-skill-chip";

  // Icon
  const icon = document.createElement("span");
  icon.className = "inline-skill-chip__icon";
  icon.textContent = "\u26A1";
  chip.appendChild(icon);

  // Name
  const nameSpan = document.createElement("span");
  nameSpan.className = "inline-skill-chip__name";
  nameSpan.textContent = name;
  chip.appendChild(nameSpan);

  // Close button
  const closeBtn = document.createElement("span");
  closeBtn.className = "chip-close-btn";
  closeBtn.appendChild(getCloseIcon().cloneNode(true));
  chip.appendChild(closeBtn);

  return chip;
}

// ---------------------------------------------------------------------------
// Chip queries
// ---------------------------------------------------------------------------

/** Find the chip element (file or skill, if any) immediately before the cursor */
export function chipBeforeCursor(): HTMLElement | null {
  const sel = window.getSelection();
  if (!sel || !sel.isCollapsed || !sel.rangeCount) return null;
  const { startContainer, startOffset } = sel.getRangeAt(0);
  if (startContainer.nodeType === Node.TEXT_NODE && startOffset === 0) {
    const prev = startContainer.previousSibling;
    if (prev && prev.nodeType === Node.ELEMENT_NODE && isChipElement(prev as HTMLElement)) {
      return prev as HTMLElement;
    }
  }
  if (startContainer.nodeType === Node.ELEMENT_NODE && startOffset > 0) {
    const prevChild = startContainer.childNodes[startOffset - 1];
    if (prevChild && prevChild.nodeType === Node.ELEMENT_NODE && isChipElement(prevChild as HTMLElement)) {
      return prevChild as HTMLElement;
    }
  }
  return null;
}

/** Update the data-empty attribute for placeholder display.
 *  Accepts an optional pre-computed text to avoid a redundant DOM walk
 *  when the caller already has the result of getEditorText(). */
export function updateEditorEmpty(editor: HTMLElement, precomputedText?: string): void {
  const text = precomputedText ?? getEditorText(editor);
  const hasChips = editor.querySelectorAll(`[${CHIP_ATTR}],[${SKILL_CHIP_ATTR}],[${SNIPPET_CHIP_ATTR}],[${MODE_CHIP_ATTR}]`).length > 0;
  if (text.length === 0 && !hasChips) {
    editor.setAttribute("data-empty", "true");
  } else {
    editor.removeAttribute("data-empty");
  }
}
