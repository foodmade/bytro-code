export interface DeployProgress {
  readonly operationId: string;
  readonly stage: "building" | "collecting" | "uploading" | "finalizing" | "done";
  readonly message: string;
  readonly percent: number;
}

export interface DeployResult {
  readonly url: string;
  readonly siteId: string;
  readonly operationId: string;
}

export interface DeployInvocationArgs {
  readonly projectPath: string;
  readonly siteId: string | null;
  readonly operationId: string;
}

export interface DeployOperationPorts {
  readonly listenProgress: (
    handler: (progress: DeployProgress) => void,
  ) => Promise<() => void>;
  readonly invokeDeploy: (args: DeployInvocationArgs) => Promise<DeployResult>;
}

export type DeployOperationOutcome =
  | { readonly status: "success"; readonly result: DeployResult }
  | { readonly status: "error"; readonly error: unknown }
  | { readonly status: "cancelled" };

export interface DeployOperationHandle {
  run(): Promise<DeployOperationOutcome>;
  cancel(): void;
}

export interface DeployDialogState {
  readonly siteId: string;
  readonly deploying: boolean;
  readonly progress: DeployProgress | null;
  readonly result: DeployResult | null;
  readonly error: string | null;
}

export type DeployDialogAction =
  | { readonly type: "project-changed" }
  | { readonly type: "opened" }
  | { readonly type: "site-id-changed"; readonly siteId: string }
  | { readonly type: "started"; readonly progress: DeployProgress }
  | { readonly type: "progress"; readonly progress: DeployProgress }
  | { readonly type: "succeeded"; readonly result: DeployResult; readonly message: string }
  | { readonly type: "deployment-failed"; readonly error: string }
  | { readonly type: "display-error"; readonly error: string }
  | { readonly type: "settled" };

export const initialDeployDialogState: DeployDialogState = {
  siteId: "",
  deploying: false,
  progress: null,
  result: null,
  error: null,
};

export const INVALID_SITE_ID_ERROR_CODE = "invalid-site-id" as const;

export class InvalidSiteIdError extends Error {
  readonly code = INVALID_SITE_ID_ERROR_CODE;

  constructor() {
    super(INVALID_SITE_ID_ERROR_CODE);
    this.name = "InvalidSiteIdError";
  }
}

const SITE_ID_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;
const RESERVED_SITE_IDS = new Set(["api", "mail", "www"]);

export function createDeployOperationId(): string {
  return crypto.randomUUID().replace(/-/g, "");
}

export function normalizeOptionalSiteId(value: string): string | null {
  const normalized = value.trim();
  if (!normalized) return null;
  if (
    normalized.length < 2 ||
    normalized.length > 64 ||
    RESERVED_SITE_IDS.has(normalized) ||
    !SITE_ID_PATTERN.test(normalized)
  ) {
    throw new InvalidSiteIdError();
  }
  return normalized;
}

export function createDeployOperation(
  args: DeployInvocationArgs,
  ports: DeployOperationPorts,
  onProgress: (progress: DeployProgress) => void,
): DeployOperationHandle {
  let cancelled = false;
  let activeUnlisten: (() => void) | null = null;
  let running: Promise<DeployOperationOutcome> | null = null;

  const stopListening = () => {
    const unlisten = activeUnlisten;
    activeUnlisten = null;
    unlisten?.();
  };

  const execute = async (): Promise<DeployOperationOutcome> => {
    try {
      const unlisten = await ports.listenProgress((progress) => {
        if (!cancelled && progress.operationId === args.operationId) {
          onProgress(progress);
        }
      });
      if (cancelled) {
        unlisten();
        return { status: "cancelled" };
      }

      activeUnlisten = unlisten;
      const result = await ports.invokeDeploy(args);
      return cancelled ? { status: "cancelled" } : { status: "success", result };
    } catch (error) {
      return cancelled ? { status: "cancelled" } : { status: "error", error };
    } finally {
      stopListening();
    }
  };

  return {
    run() {
      running ??= execute();
      return running;
    },
    cancel() {
      if (cancelled) return;
      cancelled = true;
      stopListening();
    },
  };
}

export function deployDialogReducer(
  state: DeployDialogState,
  action: DeployDialogAction,
): DeployDialogState {
  switch (action.type) {
    case "project-changed":
      return initialDeployDialogState;
    case "opened":
      return { ...state, progress: null, result: null, error: null };
    case "site-id-changed":
      return { ...state, siteId: action.siteId };
    case "started":
      return {
        ...state,
        deploying: true,
        progress: action.progress,
        result: null,
        error: null,
      };
    case "progress":
      return { ...state, progress: action.progress };
    case "succeeded":
      return {
        ...state,
        siteId: action.result.siteId,
        progress: {
          operationId: action.result.operationId,
          stage: "done",
          message: action.message,
          percent: 100,
        },
        result: action.result,
        error: null,
      };
    case "deployment-failed":
      return { ...state, progress: null, error: action.error };
    case "display-error":
      return { ...state, error: action.error };
    case "settled":
      return { ...state, deploying: false };
  }
}

export function isAllowedPublishedPreviewUrl(value: string, expectedSiteId?: string): boolean {
  try {
    const url = new URL(value);
    if (url.username || url.password) return false;
    if (url.pathname !== "/" || url.search || url.hash) return false;

    const hostname = url.hostname.toLowerCase();
    const loopback =
      hostname === "localhost" ||
      hostname.endsWith(".localhost") ||
      hostname === "127.0.0.1" ||
      hostname === "[::1]";
    if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) {
      return false;
    }

    if (!expectedSiteId) return true;
    return hostname === expectedSiteId || hostname.startsWith(`${expectedSiteId}.`);
  } catch {
    return false;
  }
}

export function isDeployConfigurationError(message: string): boolean {
  const normalized = message.toLowerCase();
  return (
    normalized.includes("bytro_deploy_worker_url") ||
    normalized.includes("bytro_deploy_api_key") ||
    normalized.includes("invalid api key") ||
    normalized.includes("deploy configuration")
  );
}

export function deployErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  return "Preview publication failed.";
}
