import { useTranslation } from "react-i18next"
import { Loader2, AlertCircle, RefreshCw } from "lucide-react"
import { useNodeRuntimeStore } from "@/stores/node-runtime-store"

export function NodeRuntimeBanner() {
  const { t } = useTranslation()
  const phase = useNodeRuntimeStore((s) => s.phase)
  const error = useNodeRuntimeStore((s) => s.error)
  const ensureRuntime = useNodeRuntimeStore((s) => s.ensureRuntime)

  const handleRetry = () => {
    void ensureRuntime()
  }

  if (phase === "ready" || phase === "unknown") {
    return null
  }

  return (
    <div className="mx-4 mt-2 mb-0 px-3 py-2 rounded-md border text-[12px] font-sans flex items-center gap-2
      bg-bg-secondary border-border-default text-text-secondary">

      {phase === "checking" && (
        <>
          <Loader2 size={14} className="animate-spin shrink-0 text-text-tertiary" />
          <span>{t("nodeRuntime.checking")}</span>
        </>
      )}

      {phase === "error" && (
        <div className="flex items-center gap-2 w-full">
          <AlertCircle size={14} className="shrink-0 text-red-400" />
          <span className="flex-1 truncate">
            {t("nodeRuntime.error", { message: error ?? "Unknown error" })}
          </span>
          <button
            onClick={handleRetry}
            className="shrink-0 flex items-center gap-1 px-2 py-0.5 rounded
              text-[11px] bg-bg-tertiary hover:bg-bg-quaternary
              text-text-secondary hover:text-text-primary
              border border-border-default transition-colors cursor-pointer"
          >
            <RefreshCw size={11} />
            {t("nodeRuntime.retry")}
          </button>
        </div>
      )}
    </div>
  )
}
