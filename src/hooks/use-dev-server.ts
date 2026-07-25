import { useEffect, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { usePreviewStore, type DevServerStatus } from "@/stores";

interface DevServerInfo {
  readonly status: DevServerStatus | { Error: string };
  readonly port: number;
  readonly project_path: string | null;
}

/** Map the Rust enum variant to the flat frontend status string. */
function normalizeStatus(raw: DevServerInfo["status"]): DevServerStatus {
  if (typeof raw === "string") {
    // "Idle" | "Starting" | "Running" | "Stopping"
    const lower = raw.toLowerCase();
    if (lower === "stopping") return "idle";
    return lower as DevServerStatus;
  }
  // { Error: "message" }
  return "error";
}

export function useDevServer() {
  const {
    projectPath,
    devServerStatus,
    runtimeOwner,
    setDevServerStatus,
    setRuntimeOwner,
    setDevServerPort,
    addViteLog,
    addViteError,
  } = usePreviewStore();

  // Listen for Vite log events
  useEffect(() => {
    const unlisteners: Promise<() => void>[] = [];

    unlisteners.push(
      listen<string>("vite-log", ({ payload }) => {
        addViteLog(payload);
      }),
    );
    unlisteners.push(
      listen<string>("vite-error", ({ payload }) => {
        addViteError(payload);
      }),
    );

    return () => {
      unlisteners.forEach((p) => p.then((fn) => fn()).catch(() => {}));
    };
  }, [addViteLog, addViteError]);

  const start = useCallback(async () => {
    if (!projectPath) return;
    try {
      setDevServerStatus("starting");
      setRuntimeOwner("builtin");
      const port = await invoke<number>("start_dev_server", {
        projectPath,
      });
      setDevServerPort(port);
      setDevServerStatus("running");
    } catch {
      console.error("[preview] failed to start dev server");
      setRuntimeOwner("none");
      setDevServerStatus("error");
      addViteError("Failed to start preview runtime");
    }
  }, [projectPath, setDevServerStatus, setRuntimeOwner, setDevServerPort, addViteError]);

  const stop = useCallback(async () => {
    try {
      await invoke("stop_dev_server");
      if (usePreviewStore.getState().runtimeOwner === "builtin") {
        setRuntimeOwner("none");
      }
      setDevServerStatus("idle");
    } catch {
      console.error("[preview] failed to stop dev server");
      addViteError("Failed to stop preview runtime");
    }
  }, [setDevServerStatus, setRuntimeOwner, addViteError]);

  const restart = useCallback(async () => {
    if (!projectPath) return;
    try {
      setDevServerStatus("starting");
      setRuntimeOwner("builtin");
      const port = await invoke<number>("restart_dev_server", {
        projectPath,
      });
      setDevServerPort(port);
      setDevServerStatus("running");
    } catch {
      setRuntimeOwner("none");
      setDevServerStatus("error");
      addViteError("Failed to restart preview runtime");
    }
  }, [projectPath, setDevServerStatus, setRuntimeOwner, setDevServerPort, addViteError]);

  /** Query the Rust backend for the real dev server state and sync the store. */
  const syncStatus = useCallback(async () => {
    if (runtimeOwner === "pty") return;
    try {
      const info = await invoke<DevServerInfo>("get_dev_server_status");
      const status = normalizeStatus(info.status);
      setDevServerStatus(status);
      if (status === "running") {
        setDevServerPort(info.port);
        setRuntimeOwner("builtin");
      } else if (usePreviewStore.getState().runtimeOwner === "builtin") {
        setRuntimeOwner("none");
      }
    } catch {
      // Backend unreachable — leave current state
    }
  }, [runtimeOwner, setDevServerStatus, setRuntimeOwner, setDevServerPort]);

  return { start, stop, restart, syncStatus, status: devServerStatus };
}
