import { useTranslation } from "react-i18next";
import { FileText, X, Loader2, CheckCircle2, AlertCircle } from "lucide-react";
import { useProjectMemoryStore } from "@/stores/project-memory-store";
import { useWorkspaceStore } from "@/stores";

export function ProjectMemoryBanner() {
  const { t } = useTranslation();
  const phase = useProjectMemoryStore((s) => s.phase);
  const error = useProjectMemoryStore((s) => s.error);
  const dismissedPaths = useProjectMemoryStore((s) => s.dismissedPaths);
  const initializeMemoryFiles = useProjectMemoryStore((s) => s.initializeMemoryFiles);
  const dismiss = useProjectMemoryStore((s) => s.dismiss);
  const workspacePath = useWorkspaceStore((s) => s.activeWorkspace?.path ?? "");

  // Don't render when idle, no workspace, or dismissed
  if (phase === "idle" || !workspacePath || dismissedPaths.has(workspacePath)) {
    return null;
  }

  return (
    <div
      className="flex items-center justify-center"
      style={{ width: "100%", height: 20, gap: 8 }}
    >
      <div className="flex items-center" style={{ gap: 8 }}>
        {/* ── "missing" state ── */}
        {phase === "missing" && (
          <>
            <FileText size={12} color="#52525b" className="shrink-0" />
            <span
              style={{
                fontSize: 11,
                fontFamily: "Inter, sans-serif",
                fontWeight: 400,
                color: "#52525b",
              }}
            >
              {t("projectMemory.missing")}
            </span>
            <button
              onClick={() => initializeMemoryFiles(workspacePath)}
              className="cursor-pointer"
              style={{
                display: "flex",
                alignItems: "center",
                gap: 4,
                background: "none",
                border: "none",
                padding: 0,
                fontSize: 11,
                fontFamily: "Inter, sans-serif",
                fontWeight: 500,
                color: "#71717a",
              }}
            >
              {t("projectMemory.initialize")}
            </button>
            <button
              onClick={() => dismiss(workspacePath)}
              className="cursor-pointer"
              style={{
                background: "none",
                border: "none",
                padding: 0,
                display: "flex",
                alignItems: "center",
              }}
            >
              <X size={10} color="#3f3f46" />
            </button>
          </>
        )}

        {/* ── generating state ── */}
        {phase === "generating" && (
          <>
            <Loader2 size={12} color="#52525b" className="animate-spin shrink-0" />
            <span
              style={{
                fontSize: 11,
                fontFamily: "Inter, sans-serif",
                fontWeight: 400,
                color: "#52525b",
              }}
            >
              {t("projectMemory.generating")}
            </span>
          </>
        )}

        {/* ── done state ── */}
        {phase === "done" && (
          <>
            <CheckCircle2 size={12} color="#22c55e" className="shrink-0" />
            <span
              style={{
                fontSize: 11,
                fontFamily: "Inter, sans-serif",
                fontWeight: 400,
                color: "#52525b",
              }}
            >
              {t("projectMemory.done")}
            </span>
          </>
        )}

        {/* ── error state ── */}
        {phase === "error" && (
          <>
            <AlertCircle size={12} color="#ef4444" className="shrink-0" />
            <span
              className="truncate"
              style={{
                fontSize: 11,
                fontFamily: "Inter, sans-serif",
                fontWeight: 400,
                color: "#52525b",
                maxWidth: 400,
              }}
            >
              {t("projectMemory.error", { message: error ?? "Unknown error" })}
            </span>
            <button
              onClick={() => initializeMemoryFiles(workspacePath)}
              className="cursor-pointer"
              style={{
                background: "none",
                border: "none",
                padding: 0,
                fontSize: 11,
                fontFamily: "Inter, sans-serif",
                fontWeight: 500,
                color: "#71717a",
              }}
            >
              {t("projectMemory.retry")}
            </button>
            <button
              onClick={() => dismiss(workspacePath)}
              className="cursor-pointer"
              style={{
                background: "none",
                border: "none",
                padding: 0,
                display: "flex",
                alignItems: "center",
              }}
            >
              <X size={10} color="#3f3f46" />
            </button>
          </>
        )}
      </div>
    </div>
  );
}
