import { create } from "zustand";
import { persist } from "zustand/middleware";

export type PermissionMode = "default" | "acceptEdits" | "plan" | "deep" | "bypassPermissions";

export interface PermissionModeOption {
  readonly id: PermissionMode;
  readonly label: string;
  readonly description: string;
  readonly icon: string;
}

export const PERMISSION_MODES: ReadonlyArray<PermissionModeOption> = [
  {
    id: "default",
    label: "Manual Confirm",
    description: "Manually confirm each operation, suitable for cautious use",
    icon: "shield",
  },
  {
    id: "acceptEdits",
    label: "Accept Edits",
    description: "Auto-approve file edits, prompt for other operations",
    icon: "bot",
  },
  {
    id: "plan",
    label: "Plan",
    description: "Planning mode, no tool execution, generate plans for approval",
    icon: "clipboard-list",
  },
  {
    id: "deep",
    label: "Deep",
    description: "Plan + brainstorming: deeply understand intent before planning",
    icon: "lightbulb",
  },
  {
    id: "bypassPermissions",
    label: "Bypass",
    description: "Fully automated, skip all permission checks [use with caution]",
    icon: "zap",
  },
] as const;

interface PermissionState {
  readonly mode: PermissionMode;
  readonly setMode: (mode: PermissionMode) => void;
}

/** Migrate legacy permission mode values to SDK-native names. */
const LEGACY_MODE_MAP: Record<string, PermissionMode> = {
  planning: "plan",
  agent: "acceptEdits",
  auto: "default",
};

export function migratePermissionMode(mode: string, version: number): PermissionMode {
  // Version 2 mapped legacy "auto" to the dangerous bypass mode. Downgrade
  // both values once so an upgrade can never silently retain that grant.
  if (version < 3 && (mode === "auto" || mode === "bypassPermissions")) {
    return "default";
  }
  if (version < 2) {
    return LEGACY_MODE_MAP[mode] ?? "default";
  }
  return PERMISSION_MODES.some((option) => option.id === mode)
    ? mode as PermissionMode
    : "default";
}

export const usePermissionStore = create<PermissionState>()(
  persist(
    (set) => ({
      mode: "acceptEdits",
      setMode: (mode) => set({ mode }),
    }),
    {
      name: "bytro-permissions",
      version: 3,
      migrate: (persisted: unknown, version: number) => {
        const state = persisted as Record<string, unknown>;
        if (typeof state.mode === "string") {
          state.mode = migratePermissionMode(state.mode, version);
        }
        return state as unknown as PermissionState;
      },
    },
  ),
);
