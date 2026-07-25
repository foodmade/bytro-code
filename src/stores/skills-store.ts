import { create } from "zustand";
import { invoke } from "@tauri-apps/api/core";
import { useSettingsStore } from "./settings-store";
import { useWorkspaceStore } from "./workspace-store";
import { track } from "@/lib/tracking";

// ---------------------------------------------------------------------------
// Skills management types (mirrors Rust sidecar::skills types)
// ---------------------------------------------------------------------------

export interface InstalledSkill {
  readonly name: string;
  readonly description: string;
  readonly category: string;
  readonly source_repo: string;
  readonly commit_hash: string;
  readonly installed_at: string;
  readonly relative_path: string;
  readonly source?: string;
  readonly is_disabled: boolean;
}

export interface DiscoveredSkill {
  readonly name: string;
  readonly description: string;
  readonly category: string;
  readonly relative_path: string;
}

export interface MarketplaceSkill {
  readonly id: string;
  readonly skill_id: string;
  readonly name: string;
  readonly description: string;
  readonly category: string;
  readonly source: string;
  readonly repo_url: string;
  readonly installs: number;
  readonly detail_url: string;
  readonly install_command: string;
}

export interface SkillDetail {
  readonly meta: InstalledSkill;
  readonly content: string;
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

interface SkillsState {
  /** All installed skills */
  readonly skills: ReadonlyArray<InstalledSkill>;
  /** Whether the store has been loaded at least once */
  readonly loaded: boolean;
  /** Whether a scan/load is currently in progress */
  readonly loading: boolean;
  /** Whether an install operation is in progress */
  readonly installing: boolean;
  /** Whether a repo scan is in progress */
  readonly scanning: boolean;
  /** Whether marketplace search is in progress */
  readonly marketplaceSearching: boolean;
  /** Skills discovered from a scanned repo (before install) */
  readonly discoveredSkills: ReadonlyArray<DiscoveredSkill>;
  /** Skills returned by the public skills marketplace */
  readonly marketplaceResults: ReadonlyArray<MarketplaceSkill>;
  /** Error message from last operation */
  readonly error: string | null;
  /** Name of the skill currently being updated (null if none) */
  readonly updatingSkill: string | null;
  /** Name of the skill whose enabled state is currently being changed */
  readonly togglingSkill: string | null;

  /** Load installed skills from disk (always re-scans). Optionally override the provider. */
  readonly load: (overrideProvider?: string | null) => Promise<void>;
  /** Scan a repo for available skills */
  readonly scanRepo: (repoUrl: string) => Promise<void>;
  /** Search public skills marketplace by name/keyword */
  readonly searchMarketplace: (query: string) => Promise<void>;
  /** Install skills from a repo */
  readonly installFromRepo: (
    repoUrl: string,
    skillNames?: ReadonlyArray<string>,
    overrideProvider?: string,
  ) => Promise<void>;
  /** Remove an installed skill */
  readonly removeSkill: (name: string, overrideProvider?: string) => Promise<void>;
  /** Update an installed skill from its source repo */
  readonly updateSkill: (name: string, overrideProvider?: string) => Promise<void>;
  /** Enable or disable an installed skill */
  readonly setSkillDisabled: (
    name: string,
    disabled: boolean,
    overrideProvider?: string,
  ) => Promise<InstalledSkill | null>;
  /** Get detailed info about a skill */
  readonly getDetail: (
    name: string,
    source?: string,
    overrideProvider?: string,
  ) => Promise<SkillDetail>;
  /** Save edited SKILL.md content */
  readonly saveContent: (
    name: string,
    content: string,
    source?: string,
    overrideProvider?: string,
  ) => Promise<void>;
  /** Clear discovered skills */
  readonly clearDiscovered: () => void;
  /** Clear marketplace search results */
  readonly clearMarketplaceResults: () => void;
  /** Clear error */
  readonly clearError: () => void;
}

let skillsLoadRequestId = 0;

export const useSkillsStore = create<SkillsState>((set, get) => ({
  skills: [],
  loaded: false,
  loading: false,
  installing: false,
  scanning: false,
  marketplaceSearching: false,
  discoveredSkills: [],
  marketplaceResults: [],
  error: null,
  updatingSkill: null,
  togglingSkill: null,

  load: async (overrideProvider?: string | null) => {
    const requestId = ++skillsLoadRequestId;
    set({ loading: true, error: null });
    try {
      const provider =
        overrideProvider === undefined
          ? useSettingsStore.getState().activePlatformId
          : overrideProvider;
      if (!provider) {
        if (requestId === skillsLoadRequestId) {
          set({ skills: [], loaded: true, loading: false, error: null });
        }
        return;
      }
      const cwd = useWorkspaceStore.getState().activeWorkspace?.path;
      const skills = await invoke<ReadonlyArray<InstalledSkill>>("scan_installed_skills", {
        cwd: cwd || undefined,
        provider,
      });
      if (requestId === skillsLoadRequestId) {
        set({ skills, loaded: true, loading: false, error: null });
      }
    } catch (err) {
      if (requestId === skillsLoadRequestId) {
        set({ skills: [], loaded: true, loading: false, error: formatError(err) });
      }
    }
  },

  scanRepo: async (repoUrl: string) => {
    set({ scanning: true, discoveredSkills: [], error: null });
    try {
      const discovered = await invoke<ReadonlyArray<DiscoveredSkill>>("scan_repo_skills", {
        repoUrl,
      });
      set({ discoveredSkills: discovered, scanning: false });
    } catch (err) {
      set({ scanning: false, error: formatError(err) });
    }
  },

  searchMarketplace: async (query: string) => {
    const trimmed = query.trim();
    if (!trimmed) {
      set({ marketplaceResults: [], marketplaceSearching: false, error: null });
      return;
    }

    set({ marketplaceSearching: true, marketplaceResults: [], error: null });
    try {
      const results = await invoke<ReadonlyArray<MarketplaceSkill>>("search_marketplace_skills", {
        query: trimmed,
        limit: 30,
      });
      set({ marketplaceResults: results, marketplaceSearching: false });
    } catch (err) {
      set({ marketplaceSearching: false, error: formatError(err) });
    }
  },

  installFromRepo: async (
    repoUrl: string,
    skillNames?: ReadonlyArray<string>,
    overrideProvider?: string,
  ) => {
    track("skills", "skills.installed", { skillName: skillNames?.join(", ") ?? repoUrl });
    set({ installing: true, error: null });
    try {
      const provider = overrideProvider || useSettingsStore.getState().activePlatformId;
      await invoke<ReadonlyArray<InstalledSkill>>("install_skill_from_repo", {
        repoUrl,
        skillNames: skillNames ? [...skillNames] : null,
        provider: provider || undefined,
      });
      // Refresh the list after install
      await get().load(overrideProvider);
      set({ installing: false, discoveredSkills: [] });
    } catch (err) {
      set({ installing: false, error: formatError(err) });
    }
  },

  removeSkill: async (name: string, overrideProvider?: string) => {
    try {
      const provider = overrideProvider || useSettingsStore.getState().activePlatformId;
      const cwd = useWorkspaceStore.getState().activeWorkspace?.path;
      // Find the skill to get its source
      const skill = get().skills.find((s) => s.name === name);
      await invoke("remove_skill", {
        name,
        provider: provider || undefined,
        source: skill?.source || undefined,
        cwd: cwd || undefined,
      });
      // Refresh the list
      await get().load(overrideProvider);
    } catch (err) {
      set({ error: formatError(err) });
    }
  },

  updateSkill: async (name: string, overrideProvider?: string) => {
    set({ updatingSkill: name, error: null });
    try {
      const provider = overrideProvider || useSettingsStore.getState().activePlatformId;
      await invoke<InstalledSkill>("update_skill", {
        name,
        provider: provider || undefined,
      });
      await get().load(overrideProvider);
      set({ updatingSkill: null });
    } catch (err) {
      set({ updatingSkill: null, error: formatError(err) });
    }
  },

  setSkillDisabled: async (name: string, disabled: boolean, overrideProvider?: string) => {
    set({ togglingSkill: name, error: null });
    try {
      const provider = overrideProvider || useSettingsStore.getState().activePlatformId;
      const cwd = useWorkspaceStore.getState().activeWorkspace?.path;
      const skill = get().skills.find((s) => s.name === name);
      const updated = await invoke<InstalledSkill>("set_skill_disabled", {
        name,
        disabled,
        provider: provider || undefined,
        source: skill?.source || undefined,
        cwd: cwd || undefined,
      });
      await get().load(overrideProvider);
      set({ togglingSkill: null });
      return updated;
    } catch (err) {
      set({ togglingSkill: null, error: formatError(err) });
      return null;
    }
  },

  getDetail: async (name: string, source?: string, overrideProvider?: string) => {
    const provider = overrideProvider || useSettingsStore.getState().activePlatformId;
    const cwd = useWorkspaceStore.getState().activeWorkspace?.path;
    return invoke<SkillDetail>("get_skill_detail", {
      name,
      provider: provider || undefined,
      source: source || undefined,
      cwd: cwd || undefined,
    });
  },

  saveContent: async (
    name: string,
    content: string,
    source?: string,
    overrideProvider?: string,
  ) => {
    const provider = overrideProvider || useSettingsStore.getState().activePlatformId;
    const cwd = useWorkspaceStore.getState().activeWorkspace?.path;
    await invoke("save_skill_content", {
      name,
      provider: provider || undefined,
      content,
      source: source || undefined,
      cwd: cwd || undefined,
    });
  },

  clearDiscovered: () => set({ discoveredSkills: [] }),
  clearMarketplaceResults: () => set({ marketplaceResults: [] }),
  clearError: () => set({ error: null }),
}));

function formatError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
