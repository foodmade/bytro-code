import { useCallback, useEffect, useReducer, useRef } from "react";
import { createPortal } from "react-dom";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { openUrl } from "@tauri-apps/plugin-opener";
import {
  AlertTriangle,
  CheckCircle2,
  CloudUpload,
  ExternalLink,
  Loader2,
  Server,
  ShieldCheck,
  X,
} from "lucide-react";
import { useTranslation } from "react-i18next";
import {
  createDeployOperation,
  createDeployOperationId,
  deployDialogReducer,
  deployErrorMessage,
  initialDeployDialogState,
  InvalidSiteIdError,
  isAllowedPublishedPreviewUrl,
  isDeployConfigurationError,
  normalizeOptionalSiteId,
  type DeployOperationHandle,
  type DeployProgress,
  type DeployResult,
} from "@/lib/preview/deploy";

interface DeployDialogProps {
  readonly open: boolean;
  readonly projectName: string;
  readonly projectPath: string | null;
  readonly onClose: () => void;
}

export function DeployDialog({ open, projectName, projectPath, onClose }: DeployDialogProps) {
  const { t } = useTranslation();
  const [state, dispatch] = useReducer(deployDialogReducer, initialDeployDialogState);
  const { siteId, deploying, progress, result, error } = state;
  const activeOperationRef = useRef<DeployOperationHandle | null>(null);

  useEffect(() => {
    activeOperationRef.current?.cancel();
    activeOperationRef.current = null;
    dispatch({ type: "project-changed" });
  }, [projectPath]);

  useEffect(() => {
    if (!open) return;
    dispatch({ type: "opened" });
  }, [open]);

  useEffect(() => {
    return () => {
      activeOperationRef.current?.cancel();
      activeOperationRef.current = null;
    };
  }, []);

  useEffect(() => {
    if (!open) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !deploying) onClose();
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [deploying, onClose, open]);

  const handlePublish = useCallback(async () => {
    if (!projectPath || deploying) return;

    let normalizedSiteId: string | null;
    try {
      normalizedSiteId = normalizeOptionalSiteId(siteId);
    } catch (cause) {
      dispatch({
        type: "display-error",
        error:
          cause instanceof InvalidSiteIdError
            ? t("previewDeploy.invalidSiteId")
            : deployErrorMessage(cause),
      });
      return;
    }

    const operationId = createDeployOperationId();
    dispatch({
      type: "started",
      progress: {
        operationId,
        stage: "building",
        message: t("previewDeploy.preparing"),
        percent: 0,
      },
    });

    const operation = createDeployOperation(
      { projectPath, siteId: normalizedSiteId, operationId },
      {
        listenProgress: async (onProgress) =>
          listen<DeployProgress>("deploy-progress", (event) => onProgress(event.payload)),
        invokeDeploy: (args) => invoke<DeployResult>("deploy_preview_site", { ...args }),
      },
      (nextProgress) => dispatch({ type: "progress", progress: nextProgress }),
    );
    activeOperationRef.current = operation;

    try {
      const outcome = await operation.run();
      if (activeOperationRef.current !== operation || outcome.status === "cancelled") {
        return;
      }
      if (outcome.status === "error") {
        throw outcome.error;
      }

      const deployed = outcome.result;
      if (
        deployed.operationId !== operationId ||
        !isAllowedPublishedPreviewUrl(deployed.url, deployed.siteId)
      ) {
        throw new Error(t("previewDeploy.invalidResult"));
      }

      dispatch({
        type: "succeeded",
        result: deployed,
        message: t("previewDeploy.complete"),
      });
    } catch (cause) {
      if (activeOperationRef.current === operation) {
        dispatch({ type: "deployment-failed", error: deployErrorMessage(cause) });
      }
    } finally {
      if (activeOperationRef.current === operation) {
        activeOperationRef.current = null;
        dispatch({ type: "settled" });
      }
    }
  }, [deploying, projectPath, siteId, t]);

  const handleOpenResult = useCallback(async () => {
    if (!result || !isAllowedPublishedPreviewUrl(result.url, result.siteId)) return;
    try {
      await openUrl(result.url);
    } catch (cause) {
      dispatch({ type: "display-error", error: deployErrorMessage(cause) });
    }
  }, [result]);

  if (!open) return null;

  const percent = Math.max(0, Math.min(100, progress?.percent ?? 0));
  const showConfigHint = error ? isDeployConfigurationError(error) : false;

  return createPortal(
    <div
      className="fixed inset-0 flex items-center justify-center"
      style={{
        zIndex: 1200,
        padding: 24,
        background: "rgba(5, 7, 12, 0.72)",
        backdropFilter: "blur(8px)",
      }}
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !deploying) onClose();
      }}
    >
      <section
        role="dialog"
        aria-modal="true"
        aria-labelledby="preview-deploy-title"
        className="relative w-full overflow-hidden"
        style={{
          maxWidth: 560,
          borderRadius: 14,
          border: "1px solid var(--color-border-strong)",
          background: "var(--color-card)",
          boxShadow: "0 28px 80px rgba(0, 0, 0, 0.42)",
        }}
      >
        <div
          aria-hidden="true"
          style={{
            height: 3,
            background: "linear-gradient(90deg, #F59E0B 0%, #F97316 52%, #22C55E 100%)",
          }}
        />

        <div className="flex flex-col" style={{ padding: 24, gap: 20 }}>
          <header className="flex items-start justify-between gap-5">
            <div className="flex items-start gap-3.5 min-w-0">
              <div
                className="flex items-center justify-center shrink-0"
                style={{
                  width: 42,
                  height: 42,
                  borderRadius: 10,
                  color: "#F59E0B",
                  background: "color-mix(in srgb, #F59E0B 13%, transparent)",
                  border: "1px solid color-mix(in srgb, #F59E0B 30%, transparent)",
                }}
              >
                <CloudUpload size={21} />
              </div>
              <div className="min-w-0">
                <div
                  className="font-mono uppercase"
                  style={{
                    color: "#F59E0B",
                    fontSize: 10,
                    fontWeight: 700,
                    letterSpacing: "0.14em",
                  }}
                >
                  {t("previewDeploy.eyebrow")}
                </div>
                <h2
                  id="preview-deploy-title"
                  className="text-foreground"
                  style={{ margin: "4px 0 0", fontSize: 18, fontWeight: 650 }}
                >
                  {t("previewDeploy.title")}
                </h2>
              </div>
            </div>
            <button
              type="button"
              onClick={onClose}
              disabled={deploying}
              className="flex items-center justify-center shrink-0 disabled:opacity-35"
              style={{
                width: 30,
                height: 30,
                borderRadius: 7,
                color: "var(--color-muted)",
                background: "var(--color-surface-alt)",
              }}
              aria-label={t("previewDeploy.close")}
            >
              <X size={15} />
            </button>
          </header>

          <div
            className="flex items-start gap-3"
            style={{
              padding: "12px 14px",
              borderRadius: 9,
              border: "1px solid var(--color-border)",
              background: "var(--color-surface-alt)",
            }}
          >
            <ShieldCheck size={17} style={{ color: "#22C55E", marginTop: 1 }} />
            <p
              className="text-muted-foreground"
              style={{ margin: 0, fontSize: 12, lineHeight: 1.55 }}
            >
              {t("previewDeploy.boundary")}
            </p>
          </div>

          <div className="grid gap-3">
            <label className="grid gap-1.5">
              <span
                className="font-mono uppercase text-muted"
                style={{ fontSize: 10, letterSpacing: "0.08em" }}
              >
                {t("previewDeploy.project")}
              </span>
              <div
                className="flex items-center gap-2.5 min-w-0"
                style={{
                  height: 38,
                  padding: "0 12px",
                  borderRadius: 8,
                  border: "1px solid var(--color-border)",
                  background: "var(--color-background)",
                }}
              >
                <Server size={14} style={{ color: "var(--color-muted)" }} />
                <span
                  className="truncate text-foreground"
                  style={{ fontSize: 12, fontWeight: 550 }}
                  title={projectPath ?? ""}
                >
                  {projectName || projectPath || t("previewDeploy.noProject")}
                </span>
              </div>
            </label>

            <label className="grid gap-1.5">
              <span
                className="font-mono uppercase text-muted"
                style={{ fontSize: 10, letterSpacing: "0.08em" }}
              >
                {t("previewDeploy.siteId")}
              </span>
              <input
                value={siteId}
                onChange={(event) =>
                  dispatch({ type: "site-id-changed", siteId: event.target.value })
                }
                disabled={deploying}
                spellCheck={false}
                autoCapitalize="none"
                autoComplete="off"
                placeholder={t("previewDeploy.siteIdPlaceholder")}
                className="w-full text-foreground outline-none disabled:opacity-50"
                style={{
                  height: 38,
                  padding: "0 12px",
                  borderRadius: 8,
                  border: "1px solid var(--color-border-strong)",
                  background: "var(--color-background)",
                  fontFamily: "'JetBrains Mono', monospace",
                  fontSize: 12,
                }}
              />
              <span className="text-muted" style={{ fontSize: 10, lineHeight: 1.45 }}>
                {t("previewDeploy.siteIdHint")}
              </span>
            </label>
          </div>

          {(deploying || progress) && (
            <div className="grid gap-2">
              <div className="flex items-center justify-between gap-4">
                <div className="flex items-center gap-2 min-w-0">
                  {deploying ? (
                    <Loader2
                      size={13}
                      className="animate-spin shrink-0"
                      style={{ color: "#F59E0B" }}
                    />
                  ) : (
                    <CheckCircle2 size={13} className="shrink-0" style={{ color: "#22C55E" }} />
                  )}
                  <span className="truncate text-muted-foreground" style={{ fontSize: 11 }}>
                    {progress?.message}
                  </span>
                </div>
                <span className="font-mono text-muted" style={{ fontSize: 10 }}>
                  {percent}%
                </span>
              </div>
              <div
                style={{
                  height: 5,
                  borderRadius: 999,
                  overflow: "hidden",
                  background: "var(--color-border)",
                }}
              >
                <div
                  style={{
                    width: `${percent}%`,
                    height: "100%",
                    borderRadius: 999,
                    background: result ? "#22C55E" : "#F59E0B",
                    transition: "width 180ms ease",
                  }}
                />
              </div>
            </div>
          )}

          {error && (
            <div
              className="flex items-start gap-2.5"
              style={{
                padding: "11px 12px",
                borderRadius: 8,
                color: "#FCA5A5",
                background: "color-mix(in srgb, #EF4444 10%, transparent)",
                border: "1px solid color-mix(in srgb, #EF4444 24%, transparent)",
              }}
            >
              <AlertTriangle size={15} className="shrink-0" style={{ marginTop: 1 }} />
              <div className="grid gap-1">
                <span style={{ fontSize: 11, lineHeight: 1.45 }}>{error}</span>
                {showConfigHint && (
                  <span className="text-muted" style={{ fontSize: 10, lineHeight: 1.45 }}>
                    {t("previewDeploy.configHint")}
                  </span>
                )}
              </div>
            </div>
          )}

          {result && (
            <div
              className="grid gap-2"
              style={{
                padding: "12px 14px",
                borderRadius: 9,
                background: "color-mix(in srgb, #22C55E 8%, transparent)",
                border: "1px solid color-mix(in srgb, #22C55E 23%, transparent)",
              }}
            >
              <span style={{ color: "#86EFAC", fontSize: 11, fontWeight: 650 }}>
                {t("previewDeploy.published")}
              </span>
              <span
                className="truncate font-mono"
                style={{ color: "var(--color-foreground)", fontSize: 11 }}
                title={result.url}
              >
                {result.url}
              </span>
            </div>
          )}

          <footer className="flex items-center justify-end gap-2">
            <button
              type="button"
              onClick={onClose}
              disabled={deploying}
              className="disabled:opacity-35"
              style={{
                height: 34,
                padding: "0 14px",
                borderRadius: 8,
                border: "1px solid var(--color-border-strong)",
                color: "var(--color-muted-foreground)",
                background: "transparent",
                fontSize: 12,
                fontWeight: 550,
              }}
            >
              {t("previewDeploy.close")}
            </button>
            {result ? (
              <button
                type="button"
                onClick={handleOpenResult}
                className="flex items-center gap-2"
                style={{
                  height: 34,
                  padding: "0 14px",
                  borderRadius: 8,
                  color: "#052E16",
                  background: "#4ADE80",
                  fontSize: 12,
                  fontWeight: 700,
                }}
              >
                <ExternalLink size={13} />
                {t("previewDeploy.open")}
              </button>
            ) : (
              <button
                type="button"
                onClick={handlePublish}
                disabled={deploying || !projectPath}
                className="flex items-center gap-2 disabled:opacity-40"
                style={{
                  height: 34,
                  padding: "0 15px",
                  borderRadius: 8,
                  color: "#1C1003",
                  background: "#F59E0B",
                  fontSize: 12,
                  fontWeight: 700,
                }}
              >
                {deploying ? (
                  <Loader2 size={13} className="animate-spin" />
                ) : (
                  <CloudUpload size={13} />
                )}
                {deploying ? t("previewDeploy.publishing") : t("previewDeploy.publish")}
              </button>
            )}
          </footer>
        </div>
      </section>
    </div>,
    document.body,
  );
}
