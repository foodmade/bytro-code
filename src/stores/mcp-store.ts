import { create } from "zustand";
import { invoke } from "@tauri-apps/api/core";
import { track } from "@/lib/tracking";

// ---------------------------------------------------------------------------
// MCP server configuration types (mirrors sidecar protocol)
// ---------------------------------------------------------------------------

export interface McpServerConfigStdio {
  readonly type?: "stdio";
  readonly command: string;
  readonly args?: ReadonlyArray<string>;
  readonly env?: Readonly<Record<string, string>>;
  readonly alwaysLoad?: boolean;
  readonly timeout?: number;
}

export interface McpServerConfigSse {
  readonly type: "sse";
  readonly url: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly alwaysLoad?: boolean;
  readonly timeout?: number;
}

export interface McpServerConfigHttp {
  readonly type: "http";
  readonly url: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly alwaysLoad?: boolean;
  readonly timeout?: number;
}

export type McpServerConfig = McpServerConfigStdio | McpServerConfigSse | McpServerConfigHttp;

export interface McpMarketplaceInput {
  readonly name?: string;
  readonly type?: "positional" | "named" | string;
  readonly value?: string;
  readonly default?: string;
  readonly description?: string;
  readonly placeholder?: string;
  readonly format?: "string" | "number" | "boolean" | "filepath" | string;
  readonly isRequired?: boolean;
  readonly isSecret?: boolean;
  readonly valueHint?: string;
  readonly variables?: Readonly<Record<string, McpMarketplaceInput>>;
}

export interface McpMarketplaceTransport {
  readonly type: "stdio" | "sse" | "streamable-http" | string;
  readonly url?: string;
  readonly headers?: ReadonlyArray<McpMarketplaceInput>;
  readonly variables?: Readonly<Record<string, McpMarketplaceInput>>;
}

export interface McpMarketplacePackage {
  readonly registryType: string;
  readonly identifier: string;
  readonly version?: string;
  readonly runtimeHint?: string;
  readonly runtimeArguments?: ReadonlyArray<McpMarketplaceInput>;
  readonly packageArguments?: ReadonlyArray<McpMarketplaceInput>;
  readonly environmentVariables?: ReadonlyArray<McpMarketplaceInput>;
  readonly transport?: McpMarketplaceTransport;
}

export interface McpMarketplaceRepository {
  readonly url?: string;
  readonly source?: string;
  readonly subfolder?: string;
}

export interface McpMarketplaceIcon {
  readonly src: string;
  readonly mimeType?: string;
  readonly sizes?: ReadonlyArray<string>;
  readonly theme?: "light" | "dark" | string;
}

export interface McpMarketplaceServerInfo {
  readonly name: string;
  readonly title?: string;
  readonly description: string;
  readonly version: string;
  readonly icons?: ReadonlyArray<McpMarketplaceIcon> | null;
  readonly packages?: ReadonlyArray<McpMarketplacePackage>;
  readonly remotes?: ReadonlyArray<McpMarketplaceTransport>;
  readonly repository?: McpMarketplaceRepository;
  readonly websiteUrl?: string;
}

export interface McpMarketplaceServer {
  readonly server: McpMarketplaceServerInfo;
  readonly _meta?: {
    readonly "io.modelcontextprotocol.registry/official"?: {
      readonly status?: string;
      readonly publishedAt?: string;
      readonly updatedAt?: string;
      readonly isLatest?: boolean;
    };
  };
}

export interface McpMarketplaceSearchResult {
  readonly servers: ReadonlyArray<McpMarketplaceServer>;
  readonly nextCursor?: string | null;
  readonly count?: number;
}

/** Result of verifying a single MCP server connection */
export interface McpVerifyResult {
  readonly ok: boolean;
  readonly message: string;
}

export interface McpToolInfo {
  readonly name: string;
  readonly title?: string;
  readonly description?: string;
  readonly inputSchema?: unknown;
  readonly outputSchema?: unknown;
  readonly icons?: unknown;
}

export interface McpToolsResult {
  readonly ok: boolean;
  readonly message: string;
  readonly tools: ReadonlyArray<McpToolInfo>;
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

export const MCP_CONFIG_READ_ERROR =
  "Saved MCP configuration could not be read. Bytro will not overwrite it until you retry successfully.";

interface McpState {
  /** MCP server configurations keyed by server name (user-managed) */
  readonly servers: Readonly<Record<string, McpServerConfig>>;
  /** Whether the store has been loaded from disk */
  readonly loaded: boolean;
  /** Fixed, non-sensitive error when the on-disk configuration is unreadable. */
  readonly loadError: string | null;
  /** Per-server verification status (keyed by server name) */
  readonly verifyStatus: Readonly<
    Record<string, { loading: boolean; result: McpVerifyResult | null }>
  >;
  /** Per-server tool listing status (keyed by server name) */
  readonly toolsStatus: Readonly<
    Record<string, { loading: boolean; result: McpToolsResult | null }>
  >;
  /** MCP servers returned by the public registry marketplace */
  readonly marketplaceServers: ReadonlyArray<McpMarketplaceServer>;
  /** Whether marketplace search is currently in progress */
  readonly marketplaceSearching: boolean;
  /** Pagination cursor for the current marketplace query */
  readonly marketplaceNextCursor: string | null;
  /** Last marketplace search error */
  readonly marketplaceError: string | null;
  /** Load MCP config from disk (Rust command) */
  readonly load: () => Promise<void>;
  /** Save current MCP config to disk (Rust command) */
  readonly save: () => Promise<void>;
  /** Add or update a server configuration */
  readonly setServer: (name: string, config: McpServerConfig) => Promise<void>;
  /** Remove a server configuration */
  readonly removeServer: (name: string) => Promise<void>;
  /** Verify a single MCP server connection */
  readonly verifyServer: (name: string, config: McpServerConfig) => Promise<McpVerifyResult>;
  /** Clear verify status for a specific server */
  readonly clearVerifyStatus: (name: string) => void;
  /** Load tools exposed by an installed MCP server */
  readonly listServerTools: (name: string, config: McpServerConfig) => Promise<McpToolsResult>;
  /** Search public MCP marketplace by name/keyword */
  readonly searchMarketplace: (query?: string, append?: boolean) => Promise<void>;
  /** Lookup MCP marketplace entries without changing the visible marketplace list */
  readonly lookupMarketplace: (
    query?: string,
    limit?: number,
  ) => Promise<ReadonlyArray<McpMarketplaceServer>>;
  /** Clear public MCP marketplace search results */
  readonly clearMarketplace: () => void;
}

let mcpSaveQueue: Promise<void> = Promise.resolve();

function persistMcpServers(servers: Readonly<Record<string, McpServerConfig>>): Promise<void> {
  const queued = mcpSaveQueue.then(() => invoke<void>("save_mcp_servers", { servers }));
  mcpSaveQueue = queued.catch(() => {});
  return queued;
}

export const useMcpStore = create<McpState>((set, get) => ({
  servers: {},
  loaded: false,
  loadError: null,
  verifyStatus: {},
  toolsStatus: {},
  marketplaceServers: [],
  marketplaceSearching: false,
  marketplaceNextCursor: null,
  marketplaceError: null,

  load: async () => {
    try {
      const data = await invoke<Record<string, McpServerConfig>>("load_mcp_servers");
      set({ servers: data ?? {}, loaded: true, loadError: null });
    } catch {
      // Preserve the in-memory snapshot and block writes. Treating an unreadable
      // file as empty could overwrite recoverable user credentials.
      set({ loaded: true, loadError: MCP_CONFIG_READ_ERROR });
    }
  },

  save: async () => {
    if (!get().loaded || get().loadError) {
      throw new Error(get().loadError ?? MCP_CONFIG_READ_ERROR);
    }
    await persistMcpServers(get().servers);
  },

  setServer: async (name, config) => {
    if (!get().loaded || get().loadError) {
      throw new Error(get().loadError ?? MCP_CONFIG_READ_ERROR);
    }
    track("mcp", "mcp.server_added", { type: config.type ?? "stdio" });
    set((state) => ({
      servers: { ...state.servers, [name]: config },
    }));
    await get().save();
  },

  removeServer: async (name) => {
    if (!get().loaded || get().loadError) {
      throw new Error(get().loadError ?? MCP_CONFIG_READ_ERROR);
    }
    set((state) => {
      const { [name]: _, ...rest } = state.servers;
      return { servers: rest };
    });
    await get().save();
  },

  verifyServer: async (name, config) => {
    set((state) => ({
      verifyStatus: { ...state.verifyStatus, [name]: { loading: true, result: null } },
    }));
    try {
      const result = await invoke<McpVerifyResult>("verify_mcp_server", { name, config });
      set((state) => ({
        verifyStatus: { ...state.verifyStatus, [name]: { loading: false, result } },
      }));
      return result;
    } catch (err) {
      const result: McpVerifyResult = {
        ok: false,
        message: `Verification failed: ${err}`,
      };
      set((state) => ({
        verifyStatus: { ...state.verifyStatus, [name]: { loading: false, result } },
      }));
      return result;
    }
  },

  clearVerifyStatus: (name) => {
    set((state) => {
      const { [name]: _, ...rest } = state.verifyStatus;
      return { verifyStatus: rest };
    });
  },

  listServerTools: async (name, config) => {
    set((state) => ({
      toolsStatus: { ...state.toolsStatus, [name]: { loading: true, result: null } },
    }));
    try {
      const result = await invoke<McpToolsResult>("list_mcp_tools", { name, config });
      set((state) => ({
        toolsStatus: { ...state.toolsStatus, [name]: { loading: false, result } },
      }));
      return result;
    } catch (err) {
      const result: McpToolsResult = {
        ok: false,
        message: `Failed to list tools: ${err}`,
        tools: [],
      };
      set((state) => ({
        toolsStatus: { ...state.toolsStatus, [name]: { loading: false, result } },
      }));
      return result;
    }
  },

  searchMarketplace: async (query = "", append = false) => {
    const cursor = append ? get().marketplaceNextCursor : null;
    if (append && !cursor) return;

    set({ marketplaceSearching: true, marketplaceError: null });
    try {
      const result = await invoke<McpMarketplaceSearchResult>("search_mcp_marketplace", {
        query,
        cursor,
        limit: 30,
      });
      set((state) => ({
        marketplaceServers: append
          ? [...state.marketplaceServers, ...(result.servers ?? [])]
          : (result.servers ?? []),
        marketplaceNextCursor: result.nextCursor ?? null,
        marketplaceSearching: false,
      }));
    } catch (err) {
      set({ marketplaceSearching: false, marketplaceError: `Marketplace search failed: ${err}` });
    }
  },

  lookupMarketplace: async (query = "", limit = 10) => {
    try {
      const result = await invoke<McpMarketplaceSearchResult>("search_mcp_marketplace", {
        query,
        cursor: null,
        limit,
      });
      return result.servers ?? [];
    } catch {
      return [];
    }
  },

  clearMarketplace: () => {
    set({ marketplaceServers: [], marketplaceNextCursor: null, marketplaceError: null });
  },
}));
