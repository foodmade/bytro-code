import { create } from "zustand"
import { invoke } from "@tauri-apps/api/core"
import { listen, type UnlistenFn } from "@tauri-apps/api/event"

// ---------------------------------------------------------------------------
// Types — must match Rust serde output exactly
// ---------------------------------------------------------------------------

export type NodeRuntimePhase =
  | "unknown"
  | "checking"
  | "ready"
  | "error"

export type NodeSource = "system" | "configured"

/**
 * Rust `NodeRuntimeStatus` is a tagged enum: `#[serde(tag = "type")]`.
 * It serialises to objects like `{"type":"ready","nodePath":"…","source":"system"}`.
 */
interface NodeRuntimeStatusPayload {
  readonly type: string
  readonly nodePath?: string
  readonly source?: NodeSource
  readonly message?: string
  readonly progress?: number
}

/**
 * Matches Rust `NodeRuntimeInfo` with `#[serde(rename_all = "camelCase")]`.
 * Field names are camelCase, NOT snake_case.
 */
interface NodeRuntimeInfo {
  readonly status: NodeRuntimeStatusPayload
  readonly nodePath: string | null
  readonly npmPath: string | null
  readonly source: NodeSource | null
  readonly version: string | null
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

interface NodeRuntimeState {
  readonly phase: NodeRuntimePhase
  readonly nodePath: string | null
  readonly npmPath: string | null
  readonly source: NodeSource | null
  readonly version: string | null
  readonly error: string | null

  readonly ensureRuntime: () => Promise<void>
  readonly detectRuntime: () => Promise<void>
  readonly checkStatus: () => Promise<void>
  readonly initListeners: () => Promise<UnlistenFn>
}

/** Map the tagged-enum `status.type` string to a frontend phase. */
function mapStatusToPhase(status: NodeRuntimeStatusPayload): NodeRuntimePhase {
  switch (status.type) {
    case "checking":
      return "checking"
    case "ready":
      return "ready"
    case "error":
      return "error"
    default:
      return "unknown"
  }
}

function mapSource(source: string | null | undefined): NodeSource | null {
  if (source === "system") return "system"
  if (source === "configured") return "configured"
  return null
}

/** Apply a NodeRuntimeInfo payload to the store. */
function applyInfo(info: NodeRuntimeInfo) {
  const phase = mapStatusToPhase(info.status)
  return {
    phase,
    nodePath: info.nodePath ?? null,
    npmPath: info.npmPath ?? null,
    source: mapSource(info.source),
    version: info.version ?? null,
    error: phase === "error" ? (info.status.message ?? "Unknown error") : null,
  }
}

export const useNodeRuntimeStore = create<NodeRuntimeState>()((set) => ({
  phase: "unknown",
  nodePath: null,
  npmPath: null,
  source: null,
  version: null,
  error: null,

  ensureRuntime: async () => {
    try {
      const info = await invoke<NodeRuntimeInfo>("ensure_node_runtime", {
        proxyUrl: null,
      })
      set(applyInfo(info))
      // If the backend returned an error status, throw so callers can handle it
      if (info.status.type === "error") {
        throw new Error(info.status.message ?? "Node.js runtime setup failed")
      }
    } catch (err) {
      set({ phase: "error", error: String(err) })
      // Re-throw so callers can preserve the actionable local-runtime error.
      throw err
    }
  },

  detectRuntime: async () => {
    try {
      const info = await invoke<NodeRuntimeInfo>("detect_node_runtime")
      set(applyInfo(info))
    } catch (err) {
      set({ phase: "error", error: String(err) })
    }
  },

  checkStatus: async () => {
    try {
      const info = await invoke<NodeRuntimeInfo>("get_node_runtime_status")
      set(applyInfo(info))
    } catch (err) {
      set({ phase: "error", error: String(err) })
    }
  },

  initListeners: async () => {
    const unlistenStatus = await listen<NodeRuntimeInfo>("node-runtime-status", (event) => {
      set(applyInfo(event.payload))
    })

    return () => {
      unlistenStatus()
    }
  },
}))
