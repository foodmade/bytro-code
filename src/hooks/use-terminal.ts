import { useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useTerminalStore } from "@/stores";

export function useTerminal() {
  const { sessions, activeSessionId, addSession, removeSession, setActiveSession } =
    useTerminalStore();

  const createSession = useCallback(
    async (options?: {
      title?: string;
      shell?: string;
      cwd?: string;
      rows?: number;
      cols?: number;
    }) => {
      const title = options?.title ?? "Terminal";
      try {
        const sessionId = await invoke<string>("spawn_pty", {
          shell: options?.shell ?? null,
          cwd: options?.cwd ?? null,
          rows: options?.rows ?? 24,
          cols: options?.cols ?? 80,
        });
        addSession({ id: sessionId, title, isActive: true });
        return sessionId;
      } catch (error) {
        throw new Error(
          `Failed to create terminal session: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    },
    [addSession],
  );

  const closeSession = useCallback(
    async (sessionId: string) => {
      try {
        await invoke("kill_pty", { sessionId });
      } catch {
        // Session may already be dead
      }
      removeSession(sessionId);
    },
    [removeSession],
  );

  return {
    sessions,
    activeSessionId,
    createSession,
    closeSession,
    setActiveSession,
  } as const;
}
