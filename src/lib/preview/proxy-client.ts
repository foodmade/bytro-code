import { invoke } from "@tauri-apps/api/core"

export interface RegisterSessionResult {
  sessionId: string
  frameUrl: string
}

export interface ProxyStatus {
  running: boolean
  port: number | null
}

interface RegisterSessionResultRaw {
  session_id: string
  frame_url: string
}

export async function registerProxySession(
  targetUrl: string,
): Promise<RegisterSessionResult> {
  const raw = await invoke<RegisterSessionResultRaw>("register_preview_session", {
    targetUrl,
  })
  return { sessionId: raw.session_id, frameUrl: raw.frame_url }
}

export async function unregisterProxySession(sessionId: string): Promise<boolean> {
  return invoke<boolean>("unregister_preview_session", { sessionId })
}
