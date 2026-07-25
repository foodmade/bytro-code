import { create } from "zustand";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

// ---------------------------------------------------------------------------
// Types — must match Rust serde output exactly
// ---------------------------------------------------------------------------

export type WhisperModelPhase =
  | "unknown"
  | "not_ready"
  | "loading"
  | "ready"
  | "transcribing"
  | "error";

interface WhisperStatusPayload {
  readonly type: string;
  readonly message?: string;
}

interface WhisperStatusInfo {
  readonly status: WhisperStatusPayload;
  readonly modelPath: string | null;
  readonly modelExistsOnDisk: boolean;
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

interface WhisperStoreState {
  readonly phase: WhisperModelPhase;
  readonly modelPath: string | null;
  readonly error: string | null;
  readonly modelExistsOnDisk: boolean;

  readonly ensureModel: (proxyUrl?: string | null) => Promise<void>;
  readonly checkStatus: () => Promise<void>;
  readonly initListeners: () => Promise<UnlistenFn>;
}

function mapStatusToPhase(status: WhisperStatusPayload): WhisperModelPhase {
  switch (status.type) {
    case "notReady":
      return "not_ready";
    case "loading":
      return "loading";
    case "ready":
      return "ready";
    case "transcribing":
      return "transcribing";
    case "error":
      return "error";
    default:
      return "unknown";
  }
}

function applyInfo(info: WhisperStatusInfo) {
  const phase = mapStatusToPhase(info.status);
  return {
    phase,
    modelPath: info.modelPath ?? null,
    error: phase === "error" ? (info.status.message ?? "Unknown error") : null,
    modelExistsOnDisk: info.modelExistsOnDisk ?? false,
  };
}

export const useWhisperStore = create<WhisperStoreState>()((set) => ({
  phase: "unknown",
  modelPath: null,
  error: null,
  modelExistsOnDisk: false,

  ensureModel: async (proxyUrl?: string | null) => {
    try {
      set({ phase: "loading", error: null });
      const info = await invoke<WhisperStatusInfo>("whisper_ensure_model", {
        proxyUrl: proxyUrl ?? null,
      });
      set(applyInfo(info));
      if (info.status.type === "error") {
        throw new Error(info.status.message ?? "Whisper model setup failed");
      }
    } catch (err) {
      set({ phase: "error", error: String(err) });
      throw err;
    }
  },

  checkStatus: async () => {
    try {
      const info = await invoke<WhisperStatusInfo>("whisper_get_status");
      set(applyInfo(info));
    } catch (err) {
      set({ phase: "error", error: String(err) });
    }
  },

  initListeners: async () => {
    const unlistenStatus = await listen<WhisperStatusInfo>("whisper-status", (event) => {
      set(applyInfo(event.payload));
    });

    return () => {
      unlistenStatus();
    };
  },
}));
