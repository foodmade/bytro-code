import { create } from "zustand";
import { persist, type StateStorage } from "zustand/middleware";
import { load, type Store } from "@tauri-apps/plugin-store";
import type { SelectedElement } from "@/hooks/use-inspector";
import {
  registerProxySession,
  unregisterProxySession,
} from "@/lib/preview/proxy-client";

export type DevServerStatus = "idle" | "starting" | "running" | "error";
export type DeviceMode = "desktop" | "tablet" | "mobile";
export type PreviewRuntimeOwner = "none" | "builtin" | "pty";

interface PreviewState {
  readonly projectPath: string | null;
  readonly projectName: string;
  readonly isInitializing: boolean;
  readonly initLogs: string[];

  readonly devServerStatus: DevServerStatus;
  readonly runtimeOwner: PreviewRuntimeOwner;
  readonly devServerPort: number;
  readonly viteLogs: string[];
  readonly viteErrors: string[];
  /** Monotonically increasing counter; bump to request an iframe refresh. */
  readonly refreshSignal: number;

  readonly previewUrl: string;
  /**
   * URL the iframe actually loads. For build projects this equals
   * `previewUrl` (direct connect); for plain user projects this is the
   * proxy URL `http://127.0.0.1:<port>/__bytro_preview/<sid>/`. Null while the
   * frame URL is being resolved — PreviewPanel renders a loading state
   * during that window so we don't load the upstream URL directly and
   * then swap to the proxy URL (which would cause a double-load flash).
   */
  readonly framePreviewUrl: string | null;
  readonly deviceMode: DeviceMode;

  readonly inspectorActive: boolean;

  readonly isPreviewVisible: boolean;
  readonly previewChatWidth: number;

  /** DOM element selected via the inspector, displayed above chat input. */
  readonly selectedElement: SelectedElement | null;

}

interface PreviewActions {
  readonly setProjectPath: (path: string | null) => void;
  readonly setProjectName: (name: string) => void;
  readonly setIsInitializing: (v: boolean) => void;
  readonly addInitLog: (log: string) => void;
  readonly clearInitLogs: () => void;

  readonly setDevServerStatus: (status: DevServerStatus) => void;
  readonly setRuntimeOwner: (owner: PreviewRuntimeOwner) => void;
  readonly setDevServerPort: (port: number) => void;
  readonly addViteLog: (log: string) => void;
  readonly addViteError: (error: string) => void;
  readonly clearViteErrors: () => void;
  readonly clearViteLogs: () => void;
  /** Increment the refresh signal to request an iframe reload. */
  readonly requestPreviewRefresh: () => void;
  /** Reset all runtime preview state for a fresh session (e.g. project switch). */
  readonly resetPreviewSession: () => void;

  readonly setDeviceMode: (mode: DeviceMode) => void;
  readonly setPreviewUrl: (url: string) => void;
  /** Manually override the iframe URL (used for proxy + direct-connect cases). */
  readonly setFramePreviewUrl: (url: string | null) => void;
  /**
   * Decide whether the current `previewUrl` should be loaded directly
   * (build projects) or through the proxy (plain user projects), and
   * write the resolved iframe URL into `framePreviewUrl`.
   */
  readonly ensureFrameForUrl: (targetUrl: string) => Promise<void>;
  readonly setInspectorActive: (v: boolean) => void;

  readonly setPreviewVisible: (visible: boolean) => void;
  readonly setPreviewChatWidth: (width: number) => void;

  readonly setSelectedElement: (el: SelectedElement | null) => void;
  /** Register the inspector hook's clearSelected so the store can clear both. */
  readonly registerInspectorClear: (fn: () => void) => void;
  /** Clear selected element in both the store and the inspector hook. */
  readonly clearSelectedElement: () => void;

  /** Register a callback to stop custom PTY commands (called from main-area). */
  readonly registerStopCustomRun: (fn: (() => Promise<void>) | null) => void;
  /** Stop the custom PTY command if one is running. */
  readonly stopCustomRun: () => Promise<void>;
  /** Register the unified preview runtime stop handler. */
  readonly registerStopPreviewRuntime: (fn: (() => Promise<void>) | null) => void;
  /** Stop whichever runtime currently owns the preview session. */
  readonly stopPreviewRuntime: () => Promise<void>;

  readonly reset: () => void;
}

const initialState: PreviewState = {
  projectPath: null,
  projectName: "",
  isInitializing: false,
  initLogs: [],

  devServerStatus: "idle",
  runtimeOwner: "none",
  devServerPort: 5173,
  viteLogs: [],
  viteErrors: [],
  refreshSignal: 0,

  previewUrl: "http://localhost:5173",
  framePreviewUrl: null,
  deviceMode: "desktop",

  inspectorActive: false,

  isPreviewVisible: false,
  previewChatWidth: 600,

  selectedElement: null,

};

// Callback ref for inspector hook's clearSelected — lives outside React state
let _inspectorClearFn: (() => void) | null = null;
// Callback ref for stopping custom PTY commands — registered by main-area
let _stopCustomRunFn: (() => Promise<void>) | null = null;
// Callback ref for stopping the current preview runtime — registered by PreviewMode
let _stopPreviewRuntimeFn: (() => Promise<void>) | null = null;
// Most recently registered proxy session id — used to clean up the prior
// session before registering a new one, preventing the per-session map
// in the Rust proxy from growing unbounded.
let _lastProxySessionId: string | null = null;

async function disposePreviousProxySession(): Promise<void> {
  const prev = _lastProxySessionId;
  if (!prev) return;
  _lastProxySessionId = null;
  try {
    await unregisterProxySession(prev);
  } catch {
    // Best-effort cleanup; if the proxy server is gone or the session
    // was already evicted, there's nothing actionable to do.
    console.warn("[preview-proxy] unregister previous session failed");
  }
}

// Tauri plugin-store backed persistence
let storeInstance: Store | null = null;
async function getStore(): Promise<Store> {
  if (!storeInstance) {
    storeInstance = await load("preview-state.json", { defaults: {}, autoSave: true });
  }
  return storeInstance;
}

const tauriStorage: StateStorage = {
  getItem: async (name: string): Promise<string | null> => {
    try {
      const store = await getStore();
      const value = await store.get<string>(name);
      return value ?? null;
    } catch {
      return null;
    }
  },
  setItem: async (name: string, value: string): Promise<void> => {
    try {
      const store = await getStore();
      await store.set(name, value);
    } catch {
      // Failed to persist — state lives in memory
    }
  },
  removeItem: async (name: string): Promise<void> => {
    try {
      const store = await getStore();
      await store.delete(name);
    } catch {
      // Failed to remove — non-critical
    }
  },
};

export const usePreviewStore = create<PreviewState & PreviewActions>()(
  persist(
    (set, get) => ({
      ...initialState,

      setProjectPath: (path) => set({ projectPath: path }),
      setProjectName: (name) => set({ projectName: name }),
      setIsInitializing: (v) => set({ isInitializing: v }),
      addInitLog: (log) =>
        set((s) => ({ initLogs: [...s.initLogs.slice(-99), log] })),
      clearInitLogs: () => set({ initLogs: [] }),

      setDevServerStatus: (status) => set({ devServerStatus: status }),
      setRuntimeOwner: (owner) => set({ runtimeOwner: owner }),
      setDevServerPort: (port) => {
        const url = `http://localhost:${port}`;
        // Clear framePreviewUrl synchronously so PreviewPanel keeps showing
        // its loading state instead of briefly loading `previewUrl` direct.
        set({ devServerPort: port, previewUrl: url, framePreviewUrl: null });
        void get().ensureFrameForUrl(url);
      },
      addViteLog: (log) =>
        set((s) => ({ viteLogs: [...s.viteLogs.slice(-199), log] })),
      addViteError: (error) =>
        set((s) => ({ viteErrors: [...s.viteErrors.slice(-49), error] })),
      clearViteErrors: () => set({ viteErrors: [] }),
      clearViteLogs: () => set({ viteLogs: [] }),
      requestPreviewRefresh: () =>
        set((s) => ({ refreshSignal: s.refreshSignal + 1 })),
      resetPreviewSession: () => {
        void disposePreviousProxySession();
        set({
          devServerStatus: "idle",
          runtimeOwner: "none",
          devServerPort: 5173,
          viteLogs: [],
          viteErrors: [],
          refreshSignal: 0,
          previewUrl: "http://localhost:5173",
          framePreviewUrl: null,
          inspectorActive: false,
          selectedElement: null,
        });
      },

      setDeviceMode: (mode) => set({ deviceMode: mode }),
      setPreviewUrl: (url) => {
        // Clear framePreviewUrl synchronously to avoid an iframe double-load
        // (first the raw URL, then the proxy URL once `ensureFrameForUrl`
        // resolves).
        set({ previewUrl: url, framePreviewUrl: null });
        void get().ensureFrameForUrl(url);
      },
      setFramePreviewUrl: (url) => set({ framePreviewUrl: url }),
      ensureFrameForUrl: async (targetUrl) => {
        // Decide direct vs proxy by runtimeOwner — the only reliable signal
        // for "who is the dev server right now":
        //   "builtin" → started by the build-project flow; its Vite already
        //                injects the inspector via inspectorPlugin(), so the
        //                iframe loads the upstream URL directly.
        //   "pty" / "none" → user-launched dev server (or unknown); must go
        //                through the local reverse proxy so we can inject
        //                the inspector script.
        // Note: previewStore.projectPath is persisted across sessions and
        // can be stale (a different project than the one currently running),
        // so we MUST NOT use it for this decision.
        const owner = get().runtimeOwner;
        const directConnect = owner === "builtin";

        if (directConnect) {
          // Direct connect doesn't use a proxy session, but a previously
          // registered one (from a prior project) should still be cleaned up.
          await disposePreviousProxySession();
          if (get().previewUrl === targetUrl) {
            set({ framePreviewUrl: targetUrl });
          }
          return;
        }

        // Drop the prior session before registering a new one so the
        // backend's session map stays bounded.
        await disposePreviousProxySession();

        try {
          const { sessionId, frameUrl } = await registerProxySession(targetUrl);
          _lastProxySessionId = sessionId;
          // Guard against races: only commit if previewUrl still matches.
          if (get().previewUrl === targetUrl) {
            set({ framePreviewUrl: frameUrl });
          }
        } catch (e) {
          console.warn(
            "[preview-proxy] registerProxySession failed; falling back to direct iframe load",
            e,
          );
          if (get().previewUrl === targetUrl) {
            set({ framePreviewUrl: targetUrl });
          }
        }
      },
      setInspectorActive: (v) => set({ inspectorActive: v }),

      setPreviewVisible: (visible) => set({ isPreviewVisible: visible }),
      setPreviewChatWidth: (width) =>
        set({ previewChatWidth: Math.max(360, Math.min(800, width)) }),

      setSelectedElement: (el) => set({ selectedElement: el }),
      registerInspectorClear: (fn) => { _inspectorClearFn = fn; },
      clearSelectedElement: () => {
        _inspectorClearFn?.();
        set({ selectedElement: null });
      },

      registerStopCustomRun: (fn) => {
        _stopCustomRunFn = fn;
      },
      stopCustomRun: async () => {
        await _stopCustomRunFn?.();
      },
      registerStopPreviewRuntime: (fn) => {
        _stopPreviewRuntimeFn = fn;
      },
      stopPreviewRuntime: async () => {
        await _stopPreviewRuntimeFn?.();
      },

      reset: () => set(initialState),
    }),
    {
      name: "preview-store",
      storage: tauriStorage as never,
      // Only persist project identity and preferences, not runtime state.
      // isPreviewVisible is NOT persisted — it is determined dynamically
      // by checking the .bytro-preview marker when a workspace is opened.
      partialize: (state) => ({
        projectPath: state.projectPath,
        projectName: state.projectName,
        deviceMode: state.deviceMode,
      }),
    }
  ),
);
