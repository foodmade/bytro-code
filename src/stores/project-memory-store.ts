import { create } from "zustand";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { UnlistenFn } from "@tauri-apps/api/event";
import { resolveActiveCredentials, getEffectiveSdk, buildProfileProxyUrl } from "@/lib/platform-config";
import { buildProviderTransportArgs } from "@/lib/chat-request";
import { usePermissionStore } from "./permission-store";

export type MemoryInitPhase =
  | "idle"
  | "missing"
  | "generating"
  | "done"
  | "error";

interface ProjectMemoryState {
  readonly phase: MemoryInitPhase;
  readonly error: string | null;
  readonly dismissedPaths: ReadonlySet<string>;

  readonly checkMemoryFiles: (workspacePath: string) => Promise<void>;
  readonly initializeMemoryFiles: (workspacePath: string) => Promise<void>;
  readonly dismiss: (workspacePath: string) => void;
}

/** Compute the Bytro-owned project memory directory. */
function computeMemoryDir(workspacePath: string): string {
  const sep = workspacePath.includes("\\") ? "\\" : "/";
  return [workspacePath, ".bytro-community", "memory"].join(sep);
}

function buildMemoryPrompt(memoryDir: string): string {
  const sep = memoryDir.includes("\\") ? "\\" : "/";
  const memoryMdPath = `${memoryDir}${sep}MEMORY.md`;

  return [
    "Please analyze the current project and generate this Bytro project memory file:",
    "",
    `${memoryMdPath} — containing:`,
    "   - Project overview (name, purpose, what it does)",
    "   - Tech stack summary (languages, frameworks, build tools)",
    "   - Project directory structure with brief explanations",
    "   - Key commands (build, test, run, lint, deploy)",
    "   - Coding conventions and patterns observed",
    "   - Important files and their roles",
    "   - Any special considerations or gotchas",
    "   - Keep it concise but informative (under 200 lines)",
    "",
    "Write only this Bytro-owned file directly using tools. Do not create or modify CLAUDE.md,",
    "provider configuration, or provider-owned project directories.",
    "Do not output the full file contents in the conversation.",
    "Use the language of the project's README or documentation. If no README exists, use English.",
  ].join("\n");
}

export const useProjectMemoryStore = create<ProjectMemoryState>((set, get) => ({
  phase: "idle",
  error: null,
  dismissedPaths: new Set<string>(),

  checkMemoryFiles: async (workspacePath: string) => {
    if (!workspacePath) return;

    // Skip if already dismissed for this workspace
    if (get().dismissedPaths.has(workspacePath)) {
      set({ phase: "idle", error: null });
      return;
    }

    try {
      const sep = workspacePath.includes("\\") ? "\\" : "/";
      const memoryMdPath = `${computeMemoryDir(workspacePath)}${sep}MEMORY.md`;
      const exists = await invoke<boolean>("path_exists", { path: memoryMdPath });

      if (exists) {
        set({ phase: "idle", error: null });
      } else {
        set({ phase: "missing", error: null });
      }
    } catch {
      // Don't block on detection errors
      set({ phase: "idle", error: null });
    }
  },

  initializeMemoryFiles: async (workspacePath: string) => {
    const { phase } = get();
    // Guard against re-entry
    if (phase !== "missing" && phase !== "error") return;

    set({ phase: "generating", error: null });

    const unlistens: UnlistenFn[] = [];

    try {
      // 1. Prepare the Bytro-owned project memory directory.
      const memoryDir = computeMemoryDir(workspacePath);

      // Ensure the memory directory exists (create_dir fails if it already
      // exists, which is fine — we just ignore the error).
      await invoke("create_dir", { path: memoryDir }).catch(() => {});

      // 2. Get current provider settings
      const { useSettingsStore } = await import("./settings-store");
      const settingsState = useSettingsStore.getState();
      const platformConfig = settingsState.platforms[settingsState.activePlatformId];
      const creds = resolveActiveCredentials(platformConfig);

      // 3. Build prompt
      const prompt = buildMemoryPrompt(memoryDir);
      const requestId = `__memory_init__${crypto.randomUUID()}`;

      // 4. Set up event listeners (isolated from chat stream registry)
      const completionPromise = new Promise<void>((resolve, reject) => {
        const cleanup = () => {
          for (const unlisten of unlistens) unlisten();
          unlistens.length = 0;
        };

        // Listen for completion
        listen<{ request_id: string }>("chat-done", (e) => {
          if (e.payload.request_id !== requestId) return;
          cleanup();
          resolve();
        }).then((u) => unlistens.push(u));

        // Listen for errors
        listen<{ request_id: string; error: string }>("chat-error", (e) => {
          if (e.payload.request_id !== requestId) return;
          cleanup();
          reject(new Error(e.payload.error));
        }).then((u) => unlistens.push(u));
      });

      // 5. Send via stream_chat pipeline (SDK → CLI)
      const agentType = getEffectiveSdk(platformConfig);
      const transportArgs = buildProviderTransportArgs(agentType, {
        baseUrl: creds?.baseUrl ?? "",
        apiKey: creds?.apiKey ?? "",
      });
      const activeProfile = platformConfig.profiles.find((p) => p.id === platformConfig.activeProfileId);
      const agentProxyUrl =
        agentType === "claude" || agentType === "codex"
          ? buildProfileProxyUrl(activeProfile)
          : undefined;

      await invoke("stream_chat", {
        requestId,
        agent: agentType,
        messages: [{ role: "user", content: prompt }],
        model: creds?.model ?? platformConfig.activeModelId,
        ...transportArgs,
        permissionMode: usePermissionStore.getState().mode,
        thinkingEnabled: false,
        cwd: workspacePath,
        proxyUrl: agentProxyUrl,
        platform: settingsState.activePlatformId,
      });

      // 6. Wait for AI to finish
      await completionPromise;

      // 7. Verify the Bytro memory file was created.
      const sep = workspacePath.includes("\\") ? "\\" : "/";
      const memoryMdPath = `${memoryDir}${sep}MEMORY.md`;
      const exists = await invoke<boolean>("path_exists", { path: memoryMdPath });

      if (!exists) {
        set({ phase: "error", error: "AI completed but Bytro project memory was not created" });
        return;
      }

      // Done
      set({ phase: "done", error: null });

      // Auto-hide after 3 seconds
      setTimeout(() => {
        if (get().phase === "done") {
          set({ phase: "idle" });
        }
      }, 3000);
    } catch (err: unknown) {
      // Cleanup listeners on error
      for (const unlisten of unlistens) unlisten();

      const message = err instanceof Error ? err.message : String(err);
      set({ phase: "error", error: message });
    }
  },

  dismiss: (workspacePath: string) => {
    const current = get().dismissedPaths;
    const next = new Set(current);
    next.add(workspacePath);
    set({ phase: "idle", error: null, dismissedPaths: next });
  },
}));
