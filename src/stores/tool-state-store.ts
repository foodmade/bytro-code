import { create } from "zustand";
import type {
  PendingAskUserQuestion,
  McpServerInfo,
  SlashCommandInfo,
} from "./chat-types";

/** Key used for questions whose conversationId is undefined. */
const GLOBAL_KEY = "__global__";

interface ToolState {
  /** Map of conversationId → pending question. Supports concurrent questions across sessions. */
  readonly pendingAskUserQuestions: Readonly<Record<string, PendingAskUserQuestion>>;
  readonly mcpServers: ReadonlyArray<McpServerInfo>;
  /** Slash commands keyed by platformId (e.g. "claude", "codex", "gemini").
   *  Each platform maintains its own list — sourced from the SDK
   *  (Query.supportedCommands(), Claude only) and/or the filesystem scan
   *  of `~/.{provider}/commands/*.md`. The chat dropdown and the
   *  slash-command dispatcher both read by platform so switching models
   *  immediately swaps the visible/active command set. */
  readonly slashCommandsByPlatform: Readonly<Record<string, ReadonlyArray<SlashCommandInfo>>>;
  readonly addPendingAskUserQuestion: (pending: PendingAskUserQuestion) => void;
  readonly removePendingAskUserQuestion: (conversationId: string | undefined) => void;
  readonly getPendingAskUserQuestion: (conversationId: string | undefined) => PendingAskUserQuestion | null;
  readonly setMcpServers: (servers: ReadonlyArray<McpServerInfo>) => void;
  /** Replace the slash-command list for a given platform. */
  readonly setSlashCommandsForPlatform: (
    platformId: string,
    commands: ReadonlyArray<SlashCommandInfo>,
  ) => void;
  /** Read slash commands for a platform (empty array when not yet known). */
  readonly getSlashCommandsForPlatform: (
    platformId: string | null | undefined,
  ) => ReadonlyArray<SlashCommandInfo>;
  readonly resetToolState: () => void;
}

const EMPTY_COMMANDS: ReadonlyArray<SlashCommandInfo> = Object.freeze([]);

export const useToolStateStore = create<ToolState>((set, get) => ({
  pendingAskUserQuestions: {},
  mcpServers: [],
  slashCommandsByPlatform: {},
  addPendingAskUserQuestion: (pending) =>
    set((state) => ({
      pendingAskUserQuestions: {
        ...state.pendingAskUserQuestions,
        [pending.conversationId ?? GLOBAL_KEY]: pending,
      },
    })),
  removePendingAskUserQuestion: (conversationId) =>
    set((state) => {
      const key = conversationId ?? GLOBAL_KEY;
      const rest = { ...state.pendingAskUserQuestions };
      delete rest[key];
      return { pendingAskUserQuestions: rest };
    }),
  getPendingAskUserQuestion: (conversationId) => {
    const map = get().pendingAskUserQuestions;
    return map[conversationId ?? GLOBAL_KEY] ?? null;
  },
  setMcpServers: (servers) => set({ mcpServers: servers }),
  setSlashCommandsForPlatform: (platformId, commands) =>
    set((state) => ({
      slashCommandsByPlatform: {
        ...state.slashCommandsByPlatform,
        [platformId]: commands,
      },
    })),
  getSlashCommandsForPlatform: (platformId) => {
    if (!platformId) return EMPTY_COMMANDS;
    return get().slashCommandsByPlatform[platformId] ?? EMPTY_COMMANDS;
  },
  resetToolState: () =>
    set({ pendingAskUserQuestions: {}, mcpServers: [], slashCommandsByPlatform: {} }),
}));
