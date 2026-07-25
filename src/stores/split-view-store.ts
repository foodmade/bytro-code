import { create } from "zustand";
import { persist, createJSONStorage, type StateStorage } from "zustand/middleware";
import { load, type Store } from "@tauri-apps/plugin-store";
import type { EditorDiffMode } from "./app-store";

export type SplitLayout = "single" | "horizontal" | "vertical" | "nested";
export interface DraftPaneModelState {
  readonly model: string;
}
export type SplitPaneId = string;
export type SplitDropZone =
  | "center"
  | "left"
  | "right"
  | "top"
  | "bottom"
  | "topLeft"
  | "topRight"
  | "bottomLeft"
  | "bottomRight";

export type SplitPaneContent =
  | { readonly type: "chat"; readonly conversationId: string | null }
  | { readonly type: "file"; readonly path: string }
  | { readonly type: "diff"; readonly path: string; readonly diff: EditorDiffMode }
  | { readonly type: "empty" };

export interface EditorGroupItem {
  readonly id: string;
  readonly content: SplitPaneContent;
}

export interface EditorGroup {
  readonly id: SplitPaneId;
  readonly activeItemId: string | null;
  readonly items: ReadonlyArray<EditorGroupItem>;
}

export interface SplitPane {
  readonly id: SplitPaneId;
  readonly content: SplitPaneContent;
  readonly conversationId: string | null;
  readonly group: EditorGroup;
}

export interface SoloMode {
  readonly conversationId: string | null;
}

export const SOLO_PANE_ID = "__solo__";

type SplitDirection = "horizontal" | "vertical";

const DEFAULT_SPLIT_RATIO = 0.5;
const DEFAULT_EDITOR_SPLIT_RATIO = 0.62;
const MIN_SPLIT_RATIO = 0.18;
const MAX_SPLIT_RATIO = 0.82;

interface SplitLeafNode {
  readonly kind: "leaf";
  readonly paneId: SplitPaneId;
  readonly content: SplitPaneContent;
  readonly conversationId: string | null;
  readonly group: EditorGroup;
}

interface SplitBranchNode {
  readonly kind: "branch";
  readonly id: string;
  readonly direction: SplitDirection;
  readonly ratio: number;
  readonly first: SplitTreeNode;
  readonly second: SplitTreeNode;
}

type SplitTreeNode = SplitLeafNode | SplitBranchNode;

interface SplitViewState {
  readonly layout: SplitLayout;
  readonly root: SplitTreeNode;
  readonly panes: ReadonlyArray<SplitPane>;
  readonly draftPaneIds: ReadonlyArray<SplitPaneId>;
  readonly draftPaneModels: Partial<Record<SplitPaneId, DraftPaneModelState>>;
  readonly activePaneId: SplitPaneId | null;
  readonly soloMode: SoloMode | null;
  readonly draggedConversationId: string | null;
  readonly draggedContent: SplitPaneContent | null;
  readonly draggedNewSession: boolean;
  readonly draggedPaneId: SplitPaneId | null;
  readonly hoveredDropZone: SplitDropZone | null;
  readonly hoveredPaneId: SplitPaneId | null;
  readonly ensureInitialized: (conversationId: string | null) => void;
  readonly syncActiveConversation: (conversationId: string | null) => void;
  readonly focusPane: (paneId: SplitPaneId) => void;
  readonly startDraggingConversation: (conversationId: string) => void;
  readonly startDraggingContent: (content: SplitPaneContent) => void;
  readonly startDraggingNewSession: () => void;
  readonly startDraggingPane: (paneId: SplitPaneId) => void;
  readonly setHoveredDropZone: (zone: SplitDropZone | null, paneId?: SplitPaneId | null) => void;
  readonly endDraggingConversation: () => void;
  readonly dropConversation: (
    conversationId: string,
    zone: SplitDropZone,
    fallbackConversationId: string | null,
    targetPaneId?: SplitPaneId | null,
  ) => SplitPaneId | null;
  readonly dropContent: (
    content: SplitPaneContent,
    zone: SplitDropZone,
    fallbackConversationId: string | null,
    targetPaneId?: SplitPaneId | null,
    splitRatio?: number,
  ) => SplitPaneId | null;
  readonly openContent: (
    content: SplitPaneContent,
    fallbackConversationId: string | null,
    targetPaneId?: SplitPaneId | null,
  ) => SplitPaneId | null;
  readonly placeDraftPane: (
    zone: SplitDropZone,
    fallbackConversationId: string | null,
    targetPaneId?: SplitPaneId | null,
  ) => SplitPaneId | null;
  readonly removePane: (
    paneId: SplitPaneId,
    fallbackConversationId: string | null,
  ) => { readonly paneId: SplitPaneId | null; readonly conversationId: string | null };
  readonly setPaneConversation: (
    paneId: SplitPaneId,
    conversationId: string | null,
  ) => void;
  readonly setPaneContent: (
    paneId: SplitPaneId,
    content: SplitPaneContent,
  ) => void;
  readonly activatePaneItem: (
    paneId: SplitPaneId,
    itemId: string,
  ) => void;
  readonly closePaneItem: (
    paneId: SplitPaneId,
    itemId: string,
    fallbackConversationId?: string | null,
  ) => { readonly paneId: SplitPaneId | null; readonly conversationId: string | null };
  readonly closeContent: (content: SplitPaneContent, fallbackConversationId?: string | null) => void;
  readonly closeEditorContent: (fallbackConversationId?: string | null) => void;
  readonly movePaneToZone: (
    sourcePaneId: SplitPaneId,
    targetPaneId: SplitPaneId,
    zone: SplitDropZone,
    fallbackConversationId: string | null,
  ) => SplitPaneId | null;
  readonly swapPaneContents: (sourcePaneId: SplitPaneId, targetPaneId: SplitPaneId) => void;
  readonly markPaneDraft: (paneId: SplitPaneId) => void;
  readonly clearPaneDraft: (paneId: SplitPaneId) => void;
  readonly bindDraftPaneToConversation: (paneId: SplitPaneId, conversationId: string) => void;
  readonly setDraftPaneModel: (paneId: SplitPaneId, model: string) => void;
  readonly clearDraftPaneModel: (paneId: SplitPaneId) => void;
  readonly cleanupClosedConversations: (
    validConversationIds: ReadonlyArray<string>,
    fallbackConversationId: string | null,
  ) => void;
  /** Remove every pane item (and solo binding) that points at a deleted
   *  conversation. cleanupClosedConversations can't do this on its own because
   *  its callers treat current pane bindings as valid — a deleted conversation
   *  that is still bound to a pane would survive forever (ghost conversation). */
  readonly purgeConversation: (
    conversationId: string,
    fallbackConversationId: string | null,
  ) => void;
  /** Replace a pane's binding from one conversation to another in place,
   *  keeping the layout intact. Used when a send discovers its pane is bound
   *  to a conversation whose DB row no longer exists and recreates it. */
  readonly rebindPaneConversation: (
    paneId: SplitPaneId,
    fromConversationId: string,
    toConversationId: string,
  ) => void;
  readonly normalizeEditorPaneOrder: (fallbackConversationId?: string | null) => void;
  readonly resizeBranch: (branchId: string, ratio: number) => void;
  readonly resetToSingle: (conversationId: string | null) => void;
  readonly enterSoloMode: (conversationId: string | null) => void;
  readonly exitSoloMode: (fallbackPaneId?: SplitPaneId | null) => void;
  readonly setSoloConversationId: (conversationId: string | null) => void;
}

const ROOT_PANE_ID = "single";

function safeRandomUUID(): string {
  try {
    if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
      return crypto.randomUUID();
    }
  } catch {
    // Continue to the next UUID fallback when the native API is unavailable.
  }
  try {
    if (typeof crypto !== "undefined" && typeof crypto.getRandomValues === "function") {
      const bytes = new Uint8Array(16);
      crypto.getRandomValues(bytes);
      bytes[6] = (bytes[6] & 0x0f) | 0x40;
      bytes[8] = (bytes[8] & 0x3f) | 0x80;
      const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
      return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
    }
  } catch {
    // Continue to the timestamp/random fallback when getRandomValues fails.
  }
  return `pane-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}-${Math.random().toString(36).slice(2, 10)}`;
}

function chatContent(conversationId: string | null): SplitPaneContent {
  return { type: "chat", conversationId };
}

function emptyContent(): SplitPaneContent {
  return { type: "empty" };
}

function conversationIdForContent(content: SplitPaneContent): string | null {
  return content.type === "chat" ? content.conversationId : null;
}

function contentItemId(content: SplitPaneContent): string | null {
  switch (content.type) {
    case "chat":
      return content.conversationId ? `chat:${content.conversationId}` : "chat:draft";
    case "file":
      return `file:${content.path}`;
    case "diff":
      return `diff:${content.path}`;
    case "empty":
      return null;
  }
}

function createGroupFromContent(paneId: SplitPaneId, content: SplitPaneContent): EditorGroup {
  const itemId = contentItemId(content);
  return {
    id: paneId,
    activeItemId: itemId,
    items: itemId ? [{ id: itemId, content }] : [],
  };
}

function rehomeGroup(group: EditorGroup, paneId: SplitPaneId): EditorGroup {
  return { ...group, id: paneId };
}

function createLeafFromContent(paneId: SplitPaneId, content: SplitPaneContent, group = createGroupFromContent(paneId, content)): SplitLeafNode {
  const activeContent = activeContentForGroup(group);
  return { kind: "leaf", paneId, content: activeContent, conversationId: conversationIdForContent(activeContent), group: rehomeGroup(group, paneId) };
}

function createLeaf(paneId: SplitPaneId, conversationId: string | null): SplitLeafNode {
  return createLeafFromContent(paneId, chatContent(conversationId));
}

function contentEquals(a: SplitPaneContent, b: SplitPaneContent): boolean {
  if (a.type !== b.type) return false;
  switch (a.type) {
    case "chat":
      return b.type === "chat" && a.conversationId === b.conversationId;
    case "file":
      return b.type === "file" && a.path === b.path;
    case "diff":
      return b.type === "diff" &&
        a.path === b.path &&
        a.diff.filePath === b.diff.filePath &&
        a.diff.original === b.diff.original &&
        a.diff.modified === b.diff.modified &&
        a.diff.canWriteBack === b.diff.canWriteBack;
    case "empty":
      return b.type === "empty";
  }
}

function paneContentIsEmpty(content: SplitPaneContent): boolean {
  return content.type === "empty" || (content.type === "chat" && content.conversationId === null);
}

function paneContentIsEditor(content: SplitPaneContent): boolean {
  return content.type === "file" || content.type === "diff";
}

function paneGroupHasOccupiedContent(group: EditorGroup): boolean {
  return group.items.some((item) => !paneContentIsEmpty(item.content));
}

function nodeHasEditorContent(node: SplitTreeNode): boolean {
  if (node.kind === "leaf") {
    return node.group.items.some((item) => paneContentIsEditor(item.content));
  }
  return nodeHasEditorContent(node.first) || nodeHasEditorContent(node.second);
}

function nodeHasChatContent(node: SplitTreeNode): boolean {
  if (node.kind === "leaf") {
    return node.group.items.some((item) => item.content.type === "chat");
  }
  return nodeHasChatContent(node.first) || nodeHasChatContent(node.second);
}

function paneIsOccupied(pane: SplitPane): boolean {
  return !paneContentIsEmpty(pane.content);
}

function groupWithContent(group: EditorGroup, paneId: SplitPaneId, content: SplitPaneContent): EditorGroup {
  const itemId = contentItemId(content);
  if (!itemId) {
    return { id: paneId, activeItemId: null, items: [] };
  }
  const existingIndex = group.items.findIndex((item) => item.id === itemId);
  const item = { id: itemId, content };
  const items = existingIndex >= 0
    ? group.items.map((current, index) => index === existingIndex ? item : current)
    : [...group.items, item];
  return { id: paneId, activeItemId: itemId, items };
}

function groupWithoutItem(group: EditorGroup, itemId: string): EditorGroup {
  const items = group.items.filter((item) => item.id !== itemId);
  const activeItemId = group.activeItemId === itemId
    ? items[items.length - 1]?.id ?? null
    : group.activeItemId;
  return { ...group, activeItemId, items };
}

function groupWithoutContent(group: EditorGroup, content: SplitPaneContent): EditorGroup {
  const itemId = contentItemId(content);
  return itemId ? groupWithoutItem(group, itemId) : group;
}

function activeContentForGroup(group: EditorGroup): SplitPaneContent {
  const activeItem = group.activeItemId
    ? group.items.find((item) => item.id === group.activeItemId)
    : group.items[group.items.length - 1];
  return activeItem?.content ?? emptyContent();
}

function withLeafContent(leaf: SplitLeafNode, content: SplitPaneContent): SplitLeafNode {
  const group = groupWithContent(leaf.group, leaf.paneId, content);
  const activeContent = activeContentForGroup(group);
  return { ...leaf, content: activeContent, conversationId: conversationIdForContent(activeContent), group };
}

function withoutLeafContent(leaf: SplitLeafNode, content: SplitPaneContent): SplitLeafNode {
  const group = groupWithoutContent(leaf.group, content);
  const activeContent = activeContentForGroup(group);
  return { ...leaf, content: activeContent, conversationId: conversationIdForContent(activeContent), group };
}

function withoutLeafItem(leaf: SplitLeafNode, itemId: string): SplitLeafNode {
  const group = groupWithoutItem(leaf.group, itemId);
  const activeContent = activeContentForGroup(group);
  return { ...leaf, content: activeContent, conversationId: conversationIdForContent(activeContent), group };
}

function clampSplitRatio(ratio: number): number {
  if (!Number.isFinite(ratio)) return DEFAULT_SPLIT_RATIO;
  return Math.min(MAX_SPLIT_RATIO, Math.max(MIN_SPLIT_RATIO, ratio));
}

function createBranch(direction: SplitDirection, first: SplitTreeNode, second: SplitTreeNode, ratio = DEFAULT_SPLIT_RATIO): SplitBranchNode {
  return {
    kind: "branch",
    id: safeRandomUUID(),
    direction,
    ratio: clampSplitRatio(ratio),
    first,
    second,
  };
}

function buildSingleTree(conversationId: string | null): SplitTreeNode {
  return createLeaf(ROOT_PANE_ID, conversationId);
}

function flattenPanes(node: SplitTreeNode): SplitPane[] {
  if (node.kind === "leaf") {
    return [{ id: node.paneId, content: node.content, conversationId: node.conversationId, group: node.group }];
  }
  return [...flattenPanes(node.first), ...flattenPanes(node.second)];
}

function deriveLayout(node: SplitTreeNode): SplitLayout {
  if (node.kind === "leaf") return "single";
  if (node.first.kind === "leaf" && node.second.kind === "leaf") {
    return node.direction;
  }
  return "nested";
}

function sameGroups(a: EditorGroup, b: EditorGroup): boolean {
  if (a.id !== b.id || a.activeItemId !== b.activeItemId || a.items.length !== b.items.length) return false;
  return a.items.every((item, index) => {
    const other = b.items[index];
    return other !== undefined && item.id === other.id && contentEquals(item.content, other.content);
  });
}

function samePanes(a: ReadonlyArray<SplitPane>, b: ReadonlyArray<SplitPane>): boolean {
  if (a.length !== b.length) return false;
  return a.every((pane, index) => {
    const other = b[index];
    return other !== undefined && pane.id === other.id && contentEquals(pane.content, other.content) && sameGroups(pane.group, other.group);
  });
}

function findPaneByConversation(panes: ReadonlyArray<SplitPane>, conversationId: string | null): SplitPane | null {
  if (!conversationId) return null;
  return panes.find((pane) => pane.group.items.some((item) => item.content.type === "chat" && item.content.conversationId === conversationId)) ?? null;
}

function getFirstPaneId(node: SplitTreeNode): SplitPaneId {
  return node.kind === "leaf" ? node.paneId : getFirstPaneId(node.first);
}

function findLeaf(node: SplitTreeNode, paneId: SplitPaneId): SplitLeafNode | null {
  if (node.kind === "leaf") {
    return node.paneId === paneId ? node : null;
  }
  return findLeaf(node.first, paneId) ?? findLeaf(node.second, paneId);
}

function updateLeaf(
  node: SplitTreeNode,
  paneId: SplitPaneId,
  updater: (leaf: SplitLeafNode) => SplitLeafNode,
): { readonly node: SplitTreeNode; readonly changed: boolean } {
  if (node.kind === "leaf") {
    if (node.paneId !== paneId) {
      return { node, changed: false };
    }
    const nextLeaf = updater(node);
    return {
      node: nextLeaf,
      changed: !contentEquals(nextLeaf.content, node.content) || !sameGroups(nextLeaf.group, node.group),
    };
  }
  const nextFirst = updateLeaf(node.first, paneId, updater);
  if (nextFirst.changed) {
    return {
      node: { ...node, first: nextFirst.node },
      changed: true,
    };
  }
  const nextSecond = updateLeaf(node.second, paneId, updater);
  if (nextSecond.changed) {
    return {
      node: { ...node, second: nextSecond.node },
      changed: true,
    };
  }
  return { node, changed: false };
}

function normalizeEditorNodeOrder(node: SplitTreeNode): { readonly node: SplitTreeNode; readonly changed: boolean } {
  if (node.kind === "leaf") {
    return { node, changed: false };
  }

  const first = normalizeEditorNodeOrder(node.first);
  const second = normalizeEditorNodeOrder(node.second);
  let nextNode: SplitBranchNode = {
    ...node,
    first: first.node,
    second: second.node,
  };
  let changed = first.changed || second.changed;

  if (
    nextNode.direction === "horizontal" &&
    !nodeHasEditorContent(nextNode.first) &&
    nodeHasChatContent(nextNode.first) &&
    nodeHasEditorContent(nextNode.second)
  ) {
    nextNode = {
      ...nextNode,
      first: nextNode.second,
      second: nextNode.first,
      ratio: clampSplitRatio(1 - nextNode.ratio),
    };
    changed = true;
  }

  return { node: changed ? nextNode : node, changed };
}

function updateBranchRatio(
  node: SplitTreeNode,
  branchId: string,
  ratio: number,
): { readonly node: SplitTreeNode; readonly changed: boolean } {
  if (node.kind === "leaf") {
    return { node, changed: false };
  }
  if (node.id === branchId) {
    const nextRatio = clampSplitRatio(ratio);
    return {
      node: nextRatio === node.ratio ? node : { ...node, ratio: nextRatio },
      changed: nextRatio !== node.ratio,
    };
  }
  const nextFirst = updateBranchRatio(node.first, branchId, ratio);
  if (nextFirst.changed) {
    return { node: { ...node, first: nextFirst.node }, changed: true };
  }
  const nextSecond = updateBranchRatio(node.second, branchId, ratio);
  if (nextSecond.changed) {
    return { node: { ...node, second: nextSecond.node }, changed: true };
  }
  return { node, changed: false };
}

function clearMatchingContent(node: SplitTreeNode, content: SplitPaneContent): SplitTreeNode {
  if (node.kind === "leaf") {
    return node.group.items.some((item) => contentEquals(item.content, content)) ? withoutLeafContent(node, content) : node;
  }
  const nextFirst = clearMatchingContent(node.first, content);
  const nextSecond = clearMatchingContent(node.second, content);
  if (nextFirst === node.first && nextSecond === node.second) {
    return node;
  }
  return { ...node, first: nextFirst, second: nextSecond };
}

function pruneEmptyLeaves(
  node: SplitTreeNode,
  draftPaneIds: ReadonlyArray<SplitPaneId> = [],
): SplitTreeNode | null {
  if (node.kind === "leaf") {
    if (node.group.items.length === 0) return null;
    return !draftPaneIds.includes(node.paneId) && !paneGroupHasOccupiedContent(node.group) ? null : node;
  }

  const first = pruneEmptyLeaves(node.first, draftPaneIds);
  const second = pruneEmptyLeaves(node.second, draftPaneIds);
  if (!first) return second;
  if (!second) return first;
  if (first === node.first && second === node.second) return node;
  return { ...node, first, second };
}

function clearEditorContent(node: SplitTreeNode): SplitTreeNode {
  if (node.kind === "leaf") {
    const group = node.group.items.reduce(
      (current, item) => paneContentIsEditor(item.content) ? groupWithoutItem(current, item.id) : current,
      node.group,
    );
    const activeContent = activeContentForGroup(group);
    return { ...node, content: activeContent, conversationId: conversationIdForContent(activeContent), group };
  }
  const first = clearEditorContent(node.first);
  const second = clearEditorContent(node.second);
  if (first === node.first && second === node.second) return node;
  return { ...node, first, second };
}

function splitLeaf(
  node: SplitTreeNode,
  paneId: SplitPaneId,
  direction: SplitDirection,
  insertBefore: boolean,
  newContent: SplitPaneContent,
  newGroup?: EditorGroup,
  ratio = DEFAULT_SPLIT_RATIO,
): { readonly node: SplitTreeNode; readonly newPaneId: SplitPaneId | null; readonly changed: boolean } {
  if (node.kind === "leaf") {
    if (node.paneId !== paneId) {
      return { node, newPaneId: null, changed: false };
    }
    const newPaneId = safeRandomUUID();
    const newLeaf = createLeafFromContent(newPaneId, newContent, newGroup ? rehomeGroup(newGroup, newPaneId) : undefined);
    const branch = insertBefore
      ? createBranch(direction, newLeaf, node, ratio)
      : createBranch(direction, node, newLeaf, ratio);
    return { node: branch, newPaneId, changed: true };
  }
  const nextFirst = splitLeaf(node.first, paneId, direction, insertBefore, newContent, newGroup, ratio);
  if (nextFirst.changed) {
    return {
      node: { ...node, first: nextFirst.node },
      newPaneId: nextFirst.newPaneId,
      changed: true,
    };
  }
  const nextSecond = splitLeaf(node.second, paneId, direction, insertBefore, newContent, newGroup, ratio);
  if (nextSecond.changed) {
    return {
      node: { ...node, second: nextSecond.node },
      newPaneId: nextSecond.newPaneId,
      changed: true,
    };
  }
  return { node, newPaneId: null, changed: false };
}

function removeLeaf(node: SplitTreeNode, paneId: SplitPaneId): { readonly node: SplitTreeNode | null; readonly removed: boolean } {
  if (node.kind === "leaf") {
    return node.paneId === paneId
      ? { node: null, removed: true }
      : { node, removed: false };
  }

  const nextFirst = removeLeaf(node.first, paneId);
  if (nextFirst.removed) {
    if (nextFirst.node === null) {
      return { node: node.second, removed: true };
    }
    return {
      node: { ...node, first: nextFirst.node },
      removed: true,
    };
  }

  const nextSecond = removeLeaf(node.second, paneId);
  if (nextSecond.removed) {
    if (nextSecond.node === null) {
      return { node: node.first, removed: true };
    }
    return {
      node: { ...node, second: nextSecond.node },
      removed: true,
    };
  }

  return { node, removed: false };
}

function normalizeZone(zone: SplitDropZone): SplitDropZone {
  switch (zone) {
    case "topLeft":
      return "left";
    case "topRight":
      return "right";
    case "bottomLeft":
      return "left";
    case "bottomRight":
      return "right";
    default:
      return zone;
  }
}

function directionForZone(zone: SplitDropZone): SplitDirection | null {
  const normalized = normalizeZone(zone);
  if (normalized === "left" || normalized === "right") return "horizontal";
  if (normalized === "top" || normalized === "bottom") return "vertical";
  return null;
}

function insertBeforeForZone(zone: SplitDropZone): boolean {
  const normalized = normalizeZone(zone);
  return normalized === "left" || normalized === "top";
}

function dedupePaneIds(ids: ReadonlyArray<SplitPaneId>): SplitPaneId[] {
  const result: SplitPaneId[] = [];
  for (const id of ids) {
    if (!result.includes(id)) {
      result.push(id);
    }
  }
  return result;
}

function omitPaneModel(
  draftPaneModels: Partial<Record<SplitPaneId, DraftPaneModelState>>,
  paneId: SplitPaneId,
): Partial<Record<SplitPaneId, DraftPaneModelState>> {
  if (!(paneId in draftPaneModels)) {
    return draftPaneModels;
  }
  const next = { ...draftPaneModels };
  delete next[paneId];
  return next;
}

function pickTargetPaneId(state: Pick<SplitViewState, "activePaneId" | "panes">, targetPaneIdOverride?: SplitPaneId | null): SplitPaneId | null {
  return targetPaneIdOverride
    ?? state.activePaneId
    ?? state.panes[0]?.id
    ?? null;
}

function ensureRootWithFallback(state: SplitViewState, fallbackConversationId: string | null): { readonly root: SplitTreeNode; readonly panes: SplitPane[] } {
  if (state.panes.length > 0) {
    return { root: state.root, panes: [...state.panes] };
  }
  const root = buildSingleTree(fallbackConversationId);
  return { root, panes: flattenPanes(root) };
}

function cleanDraftState(
  draftPaneIds: ReadonlyArray<SplitPaneId>,
  draftPaneModels: Partial<Record<SplitPaneId, DraftPaneModelState>>,
  validPaneIds: ReadonlyArray<SplitPaneId>,
): { readonly draftPaneIds: SplitPaneId[]; readonly draftPaneModels: Partial<Record<SplitPaneId, DraftPaneModelState>> } {
  const validSet = new Set(validPaneIds);
  const nextDraftPaneIds = dedupePaneIds(draftPaneIds.filter((paneId) => validSet.has(paneId)));
  const nextDraftPaneModels = Object.fromEntries(
    Object.entries(draftPaneModels).filter(([paneId]) => validSet.has(paneId)),
  ) as Partial<Record<SplitPaneId, DraftPaneModelState>>;
  return {
    draftPaneIds: nextDraftPaneIds,
    draftPaneModels: nextDraftPaneModels,
  };
}

// ── Persistence (Tauri Store adapter) ───────────────────────────────
const SPLIT_VIEW_STORE_FILE = "split-view.json";
let splitViewStoreInstance: Store | null = null;

async function getSplitViewStore(): Promise<Store> {
  if (!splitViewStoreInstance) {
    splitViewStoreInstance = await load(SPLIT_VIEW_STORE_FILE, { defaults: {}, autoSave: true });
  }
  return splitViewStoreInstance;
}

const tauriStorage: StateStorage = {
  getItem: async (name) => {
    try {
      const store = await getSplitViewStore();
      const value = await store.get<string>(name);
      return value ?? null;
    } catch {
      return null;
    }
  },
  setItem: async (name, value) => {
    try {
      const store = await getSplitViewStore();
      await store.set(name, value);
    } catch {
      // Non-critical; state remains in memory.
    }
  },
  removeItem: async (name) => {
    try {
      const store = await getSplitViewStore();
      await store.delete(name);
    } catch {
      // Non-critical.
    }
  },
};

function parsePersistedContent(node: Record<string, unknown>): SplitPaneContent | null {
  const rawContent = node.content;
  if (!rawContent || typeof rawContent !== "object") {
    return node.conversationId === null || typeof node.conversationId === "string"
      ? chatContent(node.conversationId)
      : null;
  }
  const content = rawContent as Record<string, unknown>;
  switch (content.type) {
    case "chat":
      return content.conversationId === null || typeof content.conversationId === "string"
        ? chatContent(content.conversationId)
        : null;
    case "file":
      return typeof content.path === "string" ? { type: "file", path: content.path } : null;
    case "diff": {
      const diff = content.diff as Partial<EditorDiffMode> | undefined;
      if (typeof content.path !== "string" || !diff || typeof diff.filePath !== "string" || typeof diff.original !== "string" || typeof diff.modified !== "string") {
        return null;
      }
      return {
        type: "diff",
        path: content.path,
        diff: {
          filePath: diff.filePath,
          original: diff.original,
          modified: diff.modified,
          canWriteBack: diff.canWriteBack,
        },
      };
    }
    case "empty":
      return emptyContent();
    default:
      return null;
  }
}

function parsePersistedGroup(rawGroup: unknown, paneId: SplitPaneId, fallbackContent: SplitPaneContent): EditorGroup {
  if (!rawGroup || typeof rawGroup !== "object") return createGroupFromContent(paneId, fallbackContent);
  const group = rawGroup as Record<string, unknown>;
  if (!Array.isArray(group.items)) return createGroupFromContent(paneId, fallbackContent);
  const items: EditorGroupItem[] = [];
  for (const rawItem of group.items) {
    if (!rawItem || typeof rawItem !== "object") continue;
    const item = rawItem as Record<string, unknown>;
    if (typeof item.id !== "string") continue;
    const content = parsePersistedContent(item);
    if (!content) continue;
    items.push({ id: item.id, content });
  }
  if (items.length === 0) return createGroupFromContent(paneId, fallbackContent);
  const activeItemId = typeof group.activeItemId === "string" && items.some((item) => item.id === group.activeItemId)
    ? group.activeItemId
    : items[items.length - 1]!.id;
  return { id: paneId, activeItemId, items };
}

function normalizePersistedSplitNode(node: unknown, seen: Set<string>, depth = 0): SplitTreeNode | null {
  if (depth > 16 || !node || typeof node !== "object") return null;
  const n = node as Record<string, unknown>;
  if (n.kind === "leaf") {
    if (typeof n.paneId !== "string" || n.paneId.length === 0) return null;
    if (seen.has(n.paneId)) return null;
    const content = parsePersistedContent(n);
    if (!content) return null;
    const group = parsePersistedGroup(n.group, n.paneId, content);
    seen.add(n.paneId);
    return createLeafFromContent(n.paneId, content, group);
  }
  if (n.kind === "branch") {
    if (n.direction !== "horizontal" && n.direction !== "vertical") return null;
    if (typeof n.id !== "string") return null;
    const first = normalizePersistedSplitNode(n.first, seen, depth + 1);
    const second = normalizePersistedSplitNode(n.second, seen, depth + 1);
    if (!first || !second) return null;
    return {
      kind: "branch",
      id: n.id,
      direction: n.direction,
      ratio: clampSplitRatio(typeof n.ratio === "number" ? n.ratio : DEFAULT_SPLIT_RATIO),
      first,
      second,
    };
  }
  return null;
}

// soloMode is intentionally excluded from persistence: it's a transient overlay
// state ("temporary single-screen on top of an in-memory split"). Persisting it
// across restarts caused users to silently get stuck in solo mode (no UI cue,
// drag-to-split silently failed). The field still appears on the runtime state
// type but is always re-initialized to null on rehydrate; see
// mergePersistedSplitView below.
type PersistedSplitView = Pick<SplitViewState, "root" | "draftPaneIds" | "draftPaneModels" | "activePaneId">;

function isValidDraftModel(value: unknown): value is DraftPaneModelState {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return typeof v.model === "string";
}

export interface MergedSplitViewSlice {
  readonly root: SplitTreeNode;
  readonly panes: ReadonlyArray<SplitPane>;
  readonly layout: SplitLayout;
  readonly draftPaneIds: ReadonlyArray<SplitPaneId>;
  readonly draftPaneModels: Partial<Record<SplitPaneId, DraftPaneModelState>>;
  readonly activePaneId: SplitPaneId | null;
  readonly soloMode: SoloMode | null;
}

/**
 * Pure merge logic for the persisted split-view state. Exported for unit
 * testing; the persist middleware wraps this with the current state to preserve
 * non-persisted transient fields.
 */
export function mergePersistedSplitView(persisted: unknown): MergedSplitViewSlice | null {
  if (!persisted || typeof persisted !== "object") return null;
  const raw = persisted as Partial<PersistedSplitView> & { readonly soloMode?: unknown };
  const seen = new Set<string>();
  const root = normalizePersistedSplitNode(raw.root, seen);
  if (!root) return null;
  const panes = flattenPanes(root);
  // soloMode is never restored from persistence even if a previous version
  // wrote it — see PersistedSplitView. This recovers users who got stuck in
  // solo on an old build.
  const soloMode: SoloMode | null = null;
  const validPaneIds = new Set<string>(panes.map((pane) => pane.id));

  // A draft state (both the draft flag and the cached draft model) is only
  // legitimate when the pane is actually unbound. If a pane now owns a
  // conversation, any persisted draft entry is stale — carrying it across a
  // restart silently overrode the user's real model choice.
  const draftEligiblePaneIds = new Set<string>();
  for (const pane of panes) {
    if (pane.conversationId === null) draftEligiblePaneIds.add(pane.id);
  }

  const draftPaneIds = Array.isArray(raw.draftPaneIds)
    ? dedupePaneIds(
        raw.draftPaneIds.filter(
          (id): id is SplitPaneId => typeof id === "string" && draftEligiblePaneIds.has(id),
        ),
      )
    : [];

  const draftPaneModels: Partial<Record<SplitPaneId, DraftPaneModelState>> = {};
  if (raw.draftPaneModels && typeof raw.draftPaneModels === "object") {
    for (const [paneId, value] of Object.entries(raw.draftPaneModels)) {
      if (draftEligiblePaneIds.has(paneId) && isValidDraftModel(value)) {
        draftPaneModels[paneId] = { model: value.model };
      }
    }
  }

  const activePaneId =
    typeof raw.activePaneId === "string" && validPaneIds.has(raw.activePaneId)
      ? raw.activePaneId
      : panes[0]?.id ?? null;

  return {
    root,
    panes,
    layout: deriveLayout(root),
    draftPaneIds,
    draftPaneModels,
    activePaneId,
    soloMode,
  };
}

export const useSplitViewStore = create<SplitViewState>()(
  persist(
    (set, get) => ({
  layout: "single",
  root: buildSingleTree(null),
  panes: flattenPanes(buildSingleTree(null)),
  draftPaneIds: [],
  draftPaneModels: {},
  activePaneId: ROOT_PANE_ID,
  soloMode: null,
  draggedConversationId: null,
  draggedContent: null,
  draggedNewSession: false,
  draggedPaneId: null,
  hoveredDropZone: null,
  hoveredPaneId: null,

  ensureInitialized: (conversationId) => {
    const state = get();
    const occupied = state.panes.some(paneIsOccupied) || state.draftPaneIds.length > 0;
    if (occupied) return;
    const root = buildSingleTree(conversationId);
    const panes = flattenPanes(root);
    if (samePanes(state.panes, panes) && state.activePaneId === panes[0]?.id) {
      return;
    }
    set({
      root,
      panes,
      layout: deriveLayout(root),
      draftPaneIds: [],
      draftPaneModels: {},
      activePaneId: panes[0]?.id ?? null,
    });
  },

  syncActiveConversation: (conversationId) => {
    if (!conversationId) return;
    const state = get();
    const existingPane = findPaneByConversation(state.panes, conversationId);
    if (existingPane) {
      const itemId = `chat:${conversationId}`;
      const nextRoot = updateLeaf(state.root, existingPane.id, (leaf) => {
        const group = { ...leaf.group, activeItemId: itemId };
        const activeContent = activeContentForGroup(group);
        return { ...leaf, group, content: activeContent, conversationId: conversationIdForContent(activeContent) };
      }).node;
      const nextPanes = flattenPanes(nextRoot);
      if (state.activePaneId === existingPane.id && samePanes(state.panes, nextPanes)) return;
      set({ root: nextRoot, panes: nextPanes, layout: deriveLayout(nextRoot), activePaneId: existingPane.id });
      return;
    }

    const activePane = state.activePaneId ? state.panes.find((pane) => pane.id === state.activePaneId) : null;
    const targetPaneId = activePane && !paneContentIsEditor(activePane.content)
      ? activePane.id
      : state.panes.find((pane) => !paneContentIsEditor(pane.content))?.id ?? null;
    if (!targetPaneId) return;
    const nextRoot = updateLeaf(state.root, targetPaneId, (leaf) => withLeafContent(leaf, chatContent(conversationId))).node;
    const nextPanes = flattenPanes(nextRoot);
    if (samePanes(state.panes, nextPanes)) {
      return;
    }
    set({
      root: nextRoot,
      panes: nextPanes,
      layout: deriveLayout(nextRoot),
      // Pane is transitioning from draft → bound. Drop any stale draft model
      // state so the conversation's own model stays authoritative.
      draftPaneIds: state.draftPaneIds.filter((id) => id !== targetPaneId),
      draftPaneModels: omitPaneModel(state.draftPaneModels, targetPaneId),
    });
  },

  focusPane: (paneId) => {
    if (get().activePaneId === paneId) return;
    set({ activePaneId: paneId });
  },

  startDraggingConversation: (conversationId) => {
    const state = get();
    if (
      state.draggedConversationId === conversationId &&
      state.draggedContent?.type === "chat" &&
      state.draggedContent.conversationId === conversationId &&
      state.draggedNewSession === false &&
      state.draggedPaneId === null &&
      state.hoveredDropZone === null &&
      state.hoveredPaneId === null
    ) return;
    set({
      draggedConversationId: conversationId,
      draggedContent: chatContent(conversationId),
      draggedNewSession: false,
      draggedPaneId: null,
      hoveredDropZone: null,
      hoveredPaneId: null,
    });
  },

  startDraggingContent: (content) => {
    const state = get();
    if (
      state.draggedContent && contentEquals(state.draggedContent, content) &&
      state.draggedNewSession === false &&
      state.draggedPaneId === null &&
      state.hoveredDropZone === null &&
      state.hoveredPaneId === null
    ) return;
    set({
      draggedConversationId: conversationIdForContent(content),
      draggedContent: content,
      draggedNewSession: false,
      draggedPaneId: null,
      hoveredDropZone: null,
      hoveredPaneId: null,
    });
  },

  startDraggingNewSession: () => {
    const state = get();
    if (
      state.draggedNewSession &&
      state.draggedConversationId === null &&
      state.draggedContent === null &&
      state.draggedPaneId === null &&
      state.hoveredDropZone === null &&
      state.hoveredPaneId === null
    ) return;
    set({
      draggedConversationId: null,
      draggedContent: null,
      draggedNewSession: true,
      draggedPaneId: null,
      hoveredDropZone: null,
      hoveredPaneId: null,
    });
  },

  startDraggingPane: (paneId) => {
    const state = get();
    if (
      state.draggedPaneId === paneId &&
      state.draggedConversationId === null &&
      state.draggedContent === null &&
      state.draggedNewSession === false &&
      state.hoveredDropZone === null &&
      state.hoveredPaneId === null
    ) return;
    set({
      draggedPaneId: paneId,
      draggedConversationId: null,
      draggedContent: null,
      draggedNewSession: false,
      hoveredDropZone: null,
      hoveredPaneId: null,
    });
  },

  setHoveredDropZone: (zone, paneId = null) => {
    const state = get();
    if (state.hoveredDropZone === zone && state.hoveredPaneId === paneId) return;
    set({ hoveredDropZone: zone, hoveredPaneId: paneId });
  },

  endDraggingConversation: () => {
    const state = get();
    if (
      state.draggedConversationId === null &&
      state.draggedContent === null &&
      state.draggedNewSession === false &&
      state.draggedPaneId === null &&
      state.hoveredDropZone === null &&
      state.hoveredPaneId === null
    ) return;
    set({
      draggedConversationId: null,
      draggedContent: null,
      draggedNewSession: false,
      draggedPaneId: null,
      hoveredDropZone: null,
      hoveredPaneId: null,
    });
  },

  dropConversation: (conversationId, zone, fallbackConversationId, targetPaneIdOverride = null) => {
    return get().dropContent(chatContent(conversationId), zone, fallbackConversationId, targetPaneIdOverride);
  },

  dropContent: (content, zone, fallbackConversationId, targetPaneIdOverride = null, splitRatio = DEFAULT_SPLIT_RATIO) => {
    const state = get();
    if (state.soloMode) {
      const soloConvId = state.soloMode.conversationId;
      const newRoot = buildSingleTree(soloConvId);
      set({
        root: newRoot,
        panes: flattenPanes(newRoot),
        layout: deriveLayout(newRoot),
        soloMode: null,
        activePaneId: ROOT_PANE_ID,
        draftPaneIds: state.draftPaneIds.filter((id) => id !== SOLO_PANE_ID),
        draftPaneModels: omitPaneModel(state.draftPaneModels, SOLO_PANE_ID),
        hoveredDropZone: null,
        hoveredPaneId: null,
      });
      const effectiveTarget = targetPaneIdOverride === SOLO_PANE_ID ? null : targetPaneIdOverride;
      const effectiveFallback = soloConvId ?? fallbackConversationId;
      return get().dropContent(content, zone, effectiveFallback, effectiveTarget, splitRatio);
    }

    const safeTargetOverride = targetPaneIdOverride === SOLO_PANE_ID ? null : targetPaneIdOverride;
    const { root, panes } = ensureRootWithFallback(state, fallbackConversationId);
    const targetPaneId = pickTargetPaneId({ ...state, panes }, safeTargetOverride) ?? getFirstPaneId(root);
    const normalizedZone = normalizeZone(zone);
    const existingPane = panes.find((pane) => contentEquals(pane.content, content)) ?? null;
    let nextRoot = existingPane ? clearMatchingContent(root, content) : root;

    if (normalizedZone === "center") {
      nextRoot = updateLeaf(nextRoot, targetPaneId, (leaf) => withLeafContent(leaf, content)).node;
      const nextPanes = flattenPanes(nextRoot);
      set({
        root: nextRoot,
        panes: nextPanes,
        layout: deriveLayout(nextRoot),
        draftPaneIds: state.draftPaneIds.filter((id) => id !== targetPaneId),
        draftPaneModels: omitPaneModel(state.draftPaneModels, targetPaneId),
        activePaneId: targetPaneId,
        hoveredDropZone: null,
        hoveredPaneId: null,
      });
      return targetPaneId;
    }

    const direction = directionForZone(normalizedZone);
    if (!direction) {
      return null;
    }
    const splitResult = splitLeaf(nextRoot, targetPaneId, direction, insertBeforeForZone(normalizedZone), content, undefined, splitRatio);
    if (!splitResult.changed || !splitResult.newPaneId) {
      return null;
    }
    const nextPanes = flattenPanes(splitResult.node);
    set({
      root: splitResult.node,
      panes: nextPanes,
      layout: deriveLayout(splitResult.node),
      draftPaneIds: state.draftPaneIds.filter((id) => id !== splitResult.newPaneId),
      draftPaneModels: omitPaneModel(state.draftPaneModels, splitResult.newPaneId),
      activePaneId: splitResult.newPaneId,
      hoveredDropZone: null,
      hoveredPaneId: null,
    });
    return splitResult.newPaneId;
  },

  openContent: (content, fallbackConversationId, targetPaneIdOverride = null) => {
    const state = get();
    if (state.soloMode && paneContentIsEditor(content)) {
      return get().dropContent(content, "left", fallbackConversationId, SOLO_PANE_ID, DEFAULT_EDITOR_SPLIT_RATIO);
    }
    const activePane = state.activePaneId ? state.panes.find((pane) => pane.id === state.activePaneId) : null;
    const editorPane = state.panes.find((pane) => paneContentIsEditor(pane.content)) ?? null;
    const targetPaneId = targetPaneIdOverride ?? (paneContentIsEditor(content) && activePane && !paneContentIsEditor(activePane.content) && editorPane ? editorPane.id : state.activePaneId);
    if (!targetPaneId) {
      const root = createLeafFromContent(ROOT_PANE_ID, content);
      const panes = flattenPanes(root);
      set({ root, panes, layout: deriveLayout(root), activePaneId: ROOT_PANE_ID });
      return ROOT_PANE_ID;
    }
    const target = state.panes.find((pane) => pane.id === targetPaneId) ?? null;
    if (paneContentIsEditor(content) && target && !paneContentIsEditor(target.content) && !paneContentIsEmpty(target.content)) {
      return get().dropContent(content, "left", fallbackConversationId, targetPaneId, DEFAULT_EDITOR_SPLIT_RATIO);
    }
    get().setPaneContent(targetPaneId, content);
    return targetPaneId;
  },

  placeDraftPane: (zone, fallbackConversationId, targetPaneIdOverride = null) => {
    const state = get();
    // See dropConversation: same promotion-on-solo flow, so dragging a NEW
    // session over a solo overlay creates a real split with the visible solo
    // conversation as one side and the new draft as the other.
    if (state.soloMode) {
      const soloConvId = state.soloMode.conversationId;
      const newRoot = buildSingleTree(soloConvId);
      set({
        root: newRoot,
        panes: flattenPanes(newRoot),
        layout: deriveLayout(newRoot),
        soloMode: null,
        activePaneId: ROOT_PANE_ID,
        draftPaneIds: state.draftPaneIds.filter((id) => id !== SOLO_PANE_ID),
        draftPaneModels: omitPaneModel(state.draftPaneModels, SOLO_PANE_ID),
        hoveredDropZone: null,
        hoveredPaneId: null,
      });
      const effectiveTarget = targetPaneIdOverride === SOLO_PANE_ID ? null : targetPaneIdOverride;
      const effectiveFallback = soloConvId ?? fallbackConversationId;
      return get().placeDraftPane(zone, effectiveFallback, effectiveTarget);
    }
    const safeTargetOverride = targetPaneIdOverride === SOLO_PANE_ID ? null : targetPaneIdOverride;
    const { root, panes } = ensureRootWithFallback(state, fallbackConversationId);
    const targetPaneId = pickTargetPaneId({ ...state, panes }, safeTargetOverride) ?? getFirstPaneId(root);
    const normalizedZone = normalizeZone(zone);

    if (normalizedZone === "center") {
      const nextRoot = updateLeaf(root, targetPaneId, (leaf) => withLeafContent(leaf, chatContent(null))).node;
      const nextPanes = flattenPanes(nextRoot);
      const nextDraftPaneIds = dedupePaneIds([...state.draftPaneIds.filter((id) => id !== targetPaneId), targetPaneId]);
      set({
        root: nextRoot,
        panes: nextPanes,
        layout: deriveLayout(nextRoot),
        draftPaneIds: nextDraftPaneIds,
        draftPaneModels: state.draftPaneModels,
        activePaneId: targetPaneId,
        hoveredDropZone: null,
        hoveredPaneId: null,
      });
      return targetPaneId;
    }

    const direction = directionForZone(normalizedZone);
    if (!direction) {
      return null;
    }
    const splitResult = splitLeaf(root, targetPaneId, direction, insertBeforeForZone(normalizedZone), chatContent(null));
    if (!splitResult.changed || !splitResult.newPaneId) {
      return null;
    }
    const nextPanes = flattenPanes(splitResult.node);
    const nextDraftPaneIds = dedupePaneIds([...state.draftPaneIds, splitResult.newPaneId]);
    set({
      root: splitResult.node,
      panes: nextPanes,
      layout: deriveLayout(splitResult.node),
      draftPaneIds: nextDraftPaneIds,
      draftPaneModels: state.draftPaneModels,
      activePaneId: splitResult.newPaneId,
      hoveredDropZone: null,
      hoveredPaneId: null,
    });
    return splitResult.newPaneId;
  },

  removePane: (paneId, fallbackConversationId) => {
    const state = get();
    const removeResult = removeLeaf(state.root, paneId);
    const nextRoot = removeResult.node ?? buildSingleTree(fallbackConversationId);
    const nextPanes = flattenPanes(nextRoot);
    const { draftPaneIds, draftPaneModels } = cleanDraftState(
      state.draftPaneIds.filter((id) => id !== paneId),
      omitPaneModel(state.draftPaneModels, paneId),
      nextPanes.map((pane) => pane.id),
    );
    const nextActivePaneId = state.activePaneId && state.activePaneId !== paneId && nextPanes.some((pane) => pane.id === state.activePaneId)
      ? state.activePaneId
      : nextPanes[Math.min(nextPanes.length - 1, Math.max(0, state.panes.findIndex((pane) => pane.id === paneId)))]?.id
        ?? nextPanes[0]?.id
        ?? null;

    set({
      root: nextRoot,
      panes: nextPanes,
      layout: deriveLayout(nextRoot),
      draftPaneIds,
      draftPaneModels,
      activePaneId: nextActivePaneId,
      hoveredDropZone: null,
      hoveredPaneId: null,
    });

    const resultPane = nextActivePaneId
      ? nextPanes.find((pane) => pane.id === nextActivePaneId) ?? null
      : nextPanes[0] ?? null;
    return {
      paneId: resultPane?.id ?? null,
      conversationId: resultPane?.conversationId ?? null,
    };
  },

  setPaneConversation: (paneId, conversationId) => {
    get().setPaneContent(paneId, chatContent(conversationId));
  },

  setPaneContent: (paneId, content) => {
    const state = get();
    const nextRoot = updateLeaf(state.root, paneId, (leaf) => withLeafContent(leaf, content)).node;
    const nextPanes = flattenPanes(nextRoot);
    if (samePanes(state.panes, nextPanes)) return;
    const clearDraft = !(content.type === "chat" && content.conversationId === null);
    set({
      root: nextRoot,
      panes: nextPanes,
      layout: deriveLayout(nextRoot),
      draftPaneIds: clearDraft
        ? state.draftPaneIds.filter((id) => id !== paneId)
        : state.draftPaneIds,
      draftPaneModels: clearDraft
        ? omitPaneModel(state.draftPaneModels, paneId)
        : state.draftPaneModels,
      activePaneId: paneId,
    });
  },

  activatePaneItem: (paneId, itemId) => {
    const state = get();
    const nextRoot = updateLeaf(state.root, paneId, (leaf) => {
      const group = { ...leaf.group, activeItemId: itemId };
      const activeContent = activeContentForGroup(group);
      return { ...leaf, group, content: activeContent, conversationId: conversationIdForContent(activeContent) };
    }).node;
    const nextPanes = flattenPanes(nextRoot);
    if (samePanes(state.panes, nextPanes) && state.activePaneId === paneId) return;
    set({ root: nextRoot, panes: nextPanes, layout: deriveLayout(nextRoot), activePaneId: paneId });
  },

  closePaneItem: (paneId, itemId, fallbackConversationId = null) => {
    const state = get();
    const paneIndex = state.panes.findIndex((pane) => pane.id === paneId);
    const updatedRoot = updateLeaf(state.root, paneId, (leaf) => withoutLeafItem(leaf, itemId)).node;
    const prunedRoot = pruneEmptyLeaves(updatedRoot, state.draftPaneIds);
    const nextRoot = prunedRoot ?? buildSingleTree(fallbackConversationId);
    const nextPanes = flattenPanes(nextRoot);
    const targetPane = nextPanes.find((pane) => pane.id === paneId) ?? null;
    const nextActivePaneId = targetPane && targetPane.group.items.length > 0
      ? paneId
      : state.activePaneId && nextPanes.some((pane) => pane.id === state.activePaneId)
        ? state.activePaneId
        : nextPanes[Math.min(nextPanes.length - 1, Math.max(0, paneIndex))]?.id ?? nextPanes[0]?.id ?? null;
    const { draftPaneIds, draftPaneModels } = cleanDraftState(
      state.draftPaneIds,
      state.draftPaneModels,
      nextPanes.map((pane) => pane.id),
    );
    set({
      root: nextRoot,
      panes: nextPanes,
      layout: deriveLayout(nextRoot),
      draftPaneIds,
      draftPaneModels,
      activePaneId: nextActivePaneId,
    });
    const resultPane = nextActivePaneId ? nextPanes.find((pane) => pane.id === nextActivePaneId) ?? null : null;
    return { paneId: resultPane?.id ?? null, conversationId: resultPane?.conversationId ?? null };
  },

  closeContent: (content, fallbackConversationId = null) => {
    const state = get();
    let nextRoot = state.root;
    for (const pane of state.panes) {
      if (pane.group.items.some((item) => contentEquals(item.content, content))) {
        nextRoot = updateLeaf(nextRoot, pane.id, (leaf) => withoutLeafContent(leaf, content)).node;
      }
    }
    const prunedRoot = pruneEmptyLeaves(nextRoot, state.draftPaneIds);
    nextRoot = prunedRoot ?? buildSingleTree(fallbackConversationId);
    const nextPanes = flattenPanes(nextRoot);
    if (samePanes(state.panes, nextPanes)) return;
    const { draftPaneIds, draftPaneModels } = cleanDraftState(
      state.draftPaneIds,
      state.draftPaneModels,
      nextPanes.map((pane) => pane.id),
    );
    const activePaneId = state.activePaneId && nextPanes.some((pane) => pane.id === state.activePaneId)
      ? state.activePaneId
      : nextPanes[0]?.id ?? null;
    set({ root: nextRoot, panes: nextPanes, layout: deriveLayout(nextRoot), draftPaneIds, draftPaneModels, activePaneId });
  },

  closeEditorContent: (fallbackConversationId = null) => {
    const state = get();
    let nextRoot = clearEditorContent(state.root);
    nextRoot = pruneEmptyLeaves(nextRoot, state.draftPaneIds) ?? buildSingleTree(fallbackConversationId);
    const nextPanes = flattenPanes(nextRoot);
    if (samePanes(state.panes, nextPanes)) return;
    const { draftPaneIds, draftPaneModels } = cleanDraftState(
      state.draftPaneIds,
      state.draftPaneModels,
      nextPanes.map((pane) => pane.id),
    );
    const activePaneId = state.activePaneId && nextPanes.some((pane) => pane.id === state.activePaneId)
      ? state.activePaneId
      : nextPanes[0]?.id ?? null;
    set({ root: nextRoot, panes: nextPanes, layout: deriveLayout(nextRoot), draftPaneIds, draftPaneModels, activePaneId });
  },

  movePaneToZone: (sourcePaneId, targetPaneId, zone, fallbackConversationId) => {
    if (sourcePaneId === targetPaneId) return null;
    if (sourcePaneId === SOLO_PANE_ID || targetPaneId === SOLO_PANE_ID) return null;
    const state = get();
    const sourceLeaf = findLeaf(state.root, sourcePaneId);
    if (!sourceLeaf || paneContentIsEmpty(sourceLeaf.content)) {
      return null;
    }

    const normalizedZone = normalizeZone(zone);
    if (normalizedZone === "center") {
      return null;
    }

    const direction = directionForZone(normalizedZone);
    if (!direction) {
      return null;
    }

    const clearedRoot = clearMatchingContent(state.root, sourceLeaf.content);
    const splitResult = splitLeaf(
      clearedRoot,
      targetPaneId,
      direction,
      insertBeforeForZone(normalizedZone),
      sourceLeaf.content,
      sourceLeaf.group,
    );
    if (!splitResult.changed || !splitResult.newPaneId) {
      return null;
    }

    const removedResult = removeLeaf(splitResult.node, sourcePaneId);
    const nextRoot = removedResult.node ?? buildSingleTree(fallbackConversationId);
    const nextPanes = flattenPanes(nextRoot);
    const { draftPaneIds, draftPaneModels } = cleanDraftState(
      state.draftPaneIds,
      state.draftPaneModels,
      nextPanes.map((pane) => pane.id),
    );

    set({
      root: nextRoot,
      panes: nextPanes,
      layout: deriveLayout(nextRoot),
      draftPaneIds,
      draftPaneModels,
      activePaneId: splitResult.newPaneId,
      hoveredDropZone: null,
      hoveredPaneId: null,
    });

    return splitResult.newPaneId;
  },

  swapPaneContents: (sourcePaneId, targetPaneId) => {
    if (sourcePaneId === targetPaneId) return;
    const state = get();
    const sourceLeaf = findLeaf(state.root, sourcePaneId);
    const targetLeaf = findLeaf(state.root, targetPaneId);
    if (!sourceLeaf || !targetLeaf) return;
    let nextRoot = updateLeaf(state.root, sourcePaneId, () => createLeafFromContent(sourcePaneId, targetLeaf.content, targetLeaf.group)).node;
    nextRoot = updateLeaf(nextRoot, targetPaneId, () => createLeafFromContent(targetPaneId, sourceLeaf.content, sourceLeaf.group)).node;
    const nextPanes = flattenPanes(nextRoot);
    const sourceIsDraft = state.draftPaneIds.includes(sourcePaneId);
    const targetIsDraft = state.draftPaneIds.includes(targetPaneId);
    const nextDraftPaneIds = state.draftPaneIds.filter((id) => id !== sourcePaneId && id !== targetPaneId);
    if (sourceIsDraft) nextDraftPaneIds.push(targetPaneId);
    if (targetIsDraft) nextDraftPaneIds.push(sourcePaneId);
    const sourceDraftModel = state.draftPaneModels[sourcePaneId];
    const targetDraftModel = state.draftPaneModels[targetPaneId];
    const nextDraftPaneModels = omitPaneModel(
      omitPaneModel(state.draftPaneModels, sourcePaneId),
      targetPaneId,
    );
    if (sourceDraftModel) nextDraftPaneModels[targetPaneId] = sourceDraftModel;
    if (targetDraftModel) nextDraftPaneModels[sourcePaneId] = targetDraftModel;

    set({
      root: nextRoot,
      panes: nextPanes,
      layout: deriveLayout(nextRoot),
      draftPaneIds: dedupePaneIds(nextDraftPaneIds),
      draftPaneModels: nextDraftPaneModels,
      activePaneId: targetPaneId,
      hoveredDropZone: null,
      hoveredPaneId: null,
    });
  },

  markPaneDraft: (paneId) => {
    const state = get();
    const nextRoot = updateLeaf(state.root, paneId, (leaf) => withLeafContent(leaf, chatContent(null))).node;
    const nextPanes = flattenPanes(nextRoot);
    const nextDraftPaneIds = dedupePaneIds([...state.draftPaneIds, paneId]);
    set({
      root: nextRoot,
      panes: nextPanes,
      layout: deriveLayout(nextRoot),
      draftPaneIds: nextDraftPaneIds,
    });
  },

  clearPaneDraft: (paneId) => {
    const state = get();
    if (!state.draftPaneIds.includes(paneId)) return;
    set({
      draftPaneIds: state.draftPaneIds.filter((id) => id !== paneId),
      draftPaneModels: omitPaneModel(state.draftPaneModels, paneId),
    });
  },

  bindDraftPaneToConversation: (paneId, conversationId) => {
    const state = get();
    // SOLO virtual pane is not in the root tree — update soloMode directly
    // so ChatPanel (which reads soloMode.conversationId) re-renders with the
    // newly created conversation id.
    if (paneId === SOLO_PANE_ID) {
      set({
        soloMode: { conversationId },
        draftPaneIds: state.draftPaneIds.filter((id) => id !== paneId),
        draftPaneModels: omitPaneModel(state.draftPaneModels, paneId),
      });
      return;
    }
    const nextRoot = updateLeaf(state.root, paneId, (leaf) => withLeafContent(leaf, chatContent(conversationId))).node;
    const nextPanes = flattenPanes(nextRoot);
    set({
      root: nextRoot,
      panes: nextPanes,
      layout: deriveLayout(nextRoot),
      draftPaneIds: state.draftPaneIds.filter((id) => id !== paneId),
      draftPaneModels: omitPaneModel(state.draftPaneModels, paneId),
    });
  },

  setDraftPaneModel: (paneId, model) => {
    const state = get();
    const existing = state.draftPaneModels[paneId];
    if (existing?.model === model) {
      return;
    }
    set({
      draftPaneModels: {
        ...state.draftPaneModels,
        [paneId]: { model },
      },
    });
  },

  clearDraftPaneModel: (paneId) => {
    const state = get();
    if (!(paneId in state.draftPaneModels)) return;
    set({ draftPaneModels: omitPaneModel(state.draftPaneModels, paneId) });
  },

  normalizeEditorPaneOrder: (fallbackConversationId = null) => {
    const state = get();
    const normalized = normalizeEditorNodeOrder(state.root);
    const prunedRoot = pruneEmptyLeaves(normalized.node, state.draftPaneIds) ?? buildSingleTree(fallbackConversationId);
    const nextPanes = flattenPanes(prunedRoot);
    if (!normalized.changed && samePanes(state.panes, nextPanes)) return;
    const { draftPaneIds, draftPaneModels } = cleanDraftState(
      state.draftPaneIds,
      state.draftPaneModels,
      nextPanes.map((pane) => pane.id),
    );
    const activePaneId = state.activePaneId && nextPanes.some((pane) => pane.id === state.activePaneId)
      ? state.activePaneId
      : nextPanes[0]?.id ?? null;
    set({
      root: prunedRoot,
      panes: nextPanes,
      layout: deriveLayout(prunedRoot),
      draftPaneIds,
      draftPaneModels,
      activePaneId,
    });
  },

  resizeBranch: (branchId, ratio) => {
    const state = get();
    const result = updateBranchRatio(state.root, branchId, ratio);
    if (!result.changed) return;
    set({ root: result.node, panes: flattenPanes(result.node), layout: deriveLayout(result.node) });
  },

  cleanupClosedConversations: (validConversationIds, fallbackConversationId) => {
    const state = get();
    const validSet = new Set(validConversationIds);
    let nextRoot = state.root;
    for (const pane of state.panes) {
      const staleChatItems = pane.group.items.filter((item) => item.content.type === "chat" && item.content.conversationId && !validSet.has(item.content.conversationId));
      for (const item of staleChatItems) {
        nextRoot = updateLeaf(nextRoot, pane.id, (leaf) => withoutLeafItem(leaf, item.id)).node;
      }
    }
    nextRoot = pruneEmptyLeaves(nextRoot, state.draftPaneIds) ?? buildSingleTree(fallbackConversationId);
    let nextPanes = flattenPanes(nextRoot);

    // Validate soloMode: if its conversation no longer exists, exit solo.
    let nextSoloMode = state.soloMode;
    if (nextSoloMode && nextSoloMode.conversationId && !validSet.has(nextSoloMode.conversationId)) {
      nextSoloMode = null;
    }

    const occupied = nextPanes.some(paneIsOccupied) || state.draftPaneIds.length > 0;
    if (!occupied) {
      nextRoot = buildSingleTree(fallbackConversationId);
      nextPanes = flattenPanes(nextRoot);
    }
    const extraValidPaneIds = nextSoloMode ? [SOLO_PANE_ID] : [];
    const { draftPaneIds, draftPaneModels } = cleanDraftState(
      state.draftPaneIds,
      state.draftPaneModels,
      [...nextPanes.map((pane) => pane.id), ...extraValidPaneIds],
    );
    const paneIdSet = new Set(nextPanes.map((pane) => pane.id));
    const nextActivePaneId = nextSoloMode
      ? SOLO_PANE_ID
      : state.activePaneId && (paneIdSet.has(state.activePaneId) || state.activePaneId === SOLO_PANE_ID)
        ? (paneIdSet.has(state.activePaneId) ? state.activePaneId : nextPanes[0]?.id ?? null)
        : nextPanes[0]?.id ?? null;

    if (
      samePanes(state.panes, nextPanes) &&
      state.activePaneId === nextActivePaneId &&
      state.draftPaneIds.length === draftPaneIds.length &&
      state.draftPaneIds.every((id, index) => id === draftPaneIds[index]) &&
      state.soloMode === nextSoloMode
    ) {
      return;
    }

    set({
      root: nextRoot,
      panes: nextPanes,
      layout: deriveLayout(nextRoot),
      draftPaneIds,
      draftPaneModels,
      activePaneId: nextActivePaneId,
      soloMode: nextSoloMode,
      hoveredPaneId: null,
    });
  },

  purgeConversation: (conversationId, fallbackConversationId) => {
    const state = get();
    // Whitelist = every current binding except the purged conversation, so
    // cleanupClosedConversations removes exactly that one (its own callers
    // always whitelist current pane bindings, which is why it can't be used
    // directly for deletions).
    const validIds: string[] = [];
    for (const pane of state.panes) {
      for (const item of pane.group.items) {
        if (item.content.type === "chat" && item.content.conversationId && item.content.conversationId !== conversationId) {
          validIds.push(item.content.conversationId);
        }
      }
    }
    if (state.soloMode?.conversationId && state.soloMode.conversationId !== conversationId) {
      validIds.push(state.soloMode.conversationId);
    }
    get().cleanupClosedConversations(validIds, fallbackConversationId);
  },

  rebindPaneConversation: (paneId, fromConversationId, toConversationId) => {
    if (paneId === SOLO_PANE_ID) {
      const solo = get().soloMode;
      if (solo && solo.conversationId === fromConversationId) {
        set({ soloMode: { conversationId: toConversationId } });
      }
      return;
    }
    const state = get();
    const fromItemId = contentItemId(chatContent(fromConversationId));
    const result = updateLeaf(state.root, paneId, (leaf) => {
      // Only rebind when the pane actually holds the stale conversation.
      if (!fromItemId || !leaf.group.items.some((item) => item.id === fromItemId)) {
        return leaf;
      }
      const stripped = groupWithoutItem(leaf.group, fromItemId);
      const group = groupWithContent(stripped, leaf.paneId, chatContent(toConversationId));
      const activeContent = activeContentForGroup(group);
      return { ...leaf, group, content: activeContent, conversationId: conversationIdForContent(activeContent) };
    });
    if (!result.changed) return;
    set({ root: result.node, panes: flattenPanes(result.node), layout: deriveLayout(result.node) });
  },

  resetToSingle: (conversationId) => {
    const root = buildSingleTree(conversationId);
    const panes = flattenPanes(root);
    set({
      root,
      panes,
      layout: deriveLayout(root),
      draftPaneIds: [],
      draftPaneModels: {},
      activePaneId: panes[0]?.id ?? null,
      soloMode: null,
      hoveredDropZone: null,
      hoveredPaneId: null,
    });
  },

  enterSoloMode: (conversationId) => {
    const state = get();
    if (state.soloMode && state.soloMode.conversationId === conversationId && state.activePaneId === SOLO_PANE_ID) {
      return;
    }
    // Entering solo overlay for a bound conversation: drop any stale SOLO
    // draft-model entry so conversation.model stays authoritative.
    // For conversationId === null we're starting a fresh draft — keep the
    // draft state the caller is about to set up.
    const clearSoloDraft = conversationId !== null;
    set({
      soloMode: { conversationId },
      activePaneId: SOLO_PANE_ID,
      hoveredDropZone: null,
      hoveredPaneId: null,
      ...(clearSoloDraft
        ? {
            draftPaneIds: state.draftPaneIds.filter((id) => id !== SOLO_PANE_ID),
            draftPaneModels: omitPaneModel(state.draftPaneModels, SOLO_PANE_ID),
          }
        : {}),
    });
  },

  exitSoloMode: (fallbackPaneId = null) => {
    const state = get();
    if (!state.soloMode) return;
    const paneIds = new Set(state.panes.map((pane) => pane.id));
    const nextActivePaneId = fallbackPaneId && paneIds.has(fallbackPaneId)
      ? fallbackPaneId
      : state.panes[0]?.id ?? null;
    set({
      soloMode: null,
      activePaneId: nextActivePaneId,
      draftPaneIds: state.draftPaneIds.filter((id) => id !== SOLO_PANE_ID),
      draftPaneModels: omitPaneModel(state.draftPaneModels, SOLO_PANE_ID),
      hoveredDropZone: null,
      hoveredPaneId: null,
    });
  },

  setSoloConversationId: (conversationId) => {
    const state = get();
    if (!state.soloMode) return;
    if (state.soloMode.conversationId === conversationId) return;
    // Switching SOLO to a bound conversation: drop any stale SOLO draft
    // model so conversation.model stays authoritative.
    const clearSoloDraft = conversationId !== null;
    set({
      soloMode: { conversationId },
      ...(clearSoloDraft
        ? {
            draftPaneIds: state.draftPaneIds.filter((id) => id !== SOLO_PANE_ID),
            draftPaneModels: omitPaneModel(state.draftPaneModels, SOLO_PANE_ID),
          }
        : {}),
    });
  },
    }),
    {
      name: "bytro-split-view",
      version: 1,
      storage: createJSONStorage(() => tauriStorage),
      partialize: (state): PersistedSplitView => ({
        root: state.root,
        draftPaneIds: [...state.draftPaneIds],
        draftPaneModels: { ...state.draftPaneModels },
        activePaneId: state.activePaneId,
        // soloMode intentionally not persisted — it's a transient overlay and
        // cross-restart persistence stranded users in solo without any UI cue.
      }),
      merge: (persisted, current) => {
        const merged = mergePersistedSplitView(persisted);
        if (!merged) return current;
        return {
          ...current,
          ...merged,
          draggedConversationId: null,
          draggedContent: null,
          draggedNewSession: false,
          draggedPaneId: null,
          hoveredDropZone: null,
          hoveredPaneId: null,
        };
      },
    },
  ),
);
