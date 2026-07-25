import { create } from "zustand";
import { invoke } from "@tauri-apps/api/core";
import type { SdkType } from "@/lib/platform-config";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface CliToolStatus {
  name: string;
  installed: boolean;
  version: string | null;
  install_command: string;
  path: string | null;
}

/** Maps SDK types that require a locally installed CLI tool to its scan pattern. */
const SDK_TO_CLI_PATTERN: Partial<Record<SdkType, string>> = {
  codex: "codex",
  gemini: "gemini",
  claude: "claude",
  // chatcmpl uses HTTP APIs directly — no CLI required
};

/** Human-readable display names for CLI tools. */
const CLI_DISPLAY_NAMES: Record<string, string> = {
  codex: "Codex CLI",
  gemini: "Gemini CLI",
  claude: "Claude Code",
};

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

interface CliToolsState {
  /** Cached scan results from check_cli_tools. */
  readonly tools: readonly CliToolStatus[];
  /** Whether the cache has been populated at least once. */
  readonly loaded: boolean;

  /** Populate the cache. Skips if already loaded unless force=true. */
  readonly loadTools: (force?: boolean) => Promise<readonly CliToolStatus[]>;

  /** Update cache with externally-obtained scan results (e.g. from CLI setup dialog). */
  readonly setTools: (tools: CliToolStatus[]) => void;

  /** Check if the CLI dependency for a given SDK type is installed.
   *  Returns null if no CLI is required. */
  readonly checkSdkDependency: (sdk: SdkType) => {
    installed: boolean;
    displayName: string;
  } | null;
}

export const useCliToolsStore = create<CliToolsState>()((set, get) => ({
  tools: [],
  loaded: false,

  loadTools: async (force = false) => {
    if (get().loaded && !force) return get().tools;
    try {
      const tools = await invoke<CliToolStatus[]>("check_cli_tools");
      set({ tools, loaded: true });
      return tools;
    } catch {
      return get().tools;
    }
  },

  setTools: (tools) => {
    set({ tools, loaded: true });
  },

  checkSdkDependency: (sdk) => {
    const pattern = SDK_TO_CLI_PATTERN[sdk];
    if (!pattern) return null; // No CLI needed

    const { tools } = get();
    const tool = tools.find((t) => t.name.toLowerCase().includes(pattern));
    const installed = tool?.installed ?? false;

    return {
      installed,
      displayName: CLI_DISPLAY_NAMES[pattern] ?? pattern,
    };
  },
}));
