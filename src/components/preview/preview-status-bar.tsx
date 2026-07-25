import { useState, useRef, useEffect, useCallback } from "react"
import { usePreviewStore } from "@/stores"
import { useDevServer } from "@/hooks"
import { ChevronUp, ChevronDown, RotateCcw, Trash2, Play, Square } from "lucide-react"

export function PreviewStatusBar() {
  const devServerStatus = usePreviewStore((s) => s.devServerStatus)
  const devServerPort = usePreviewStore((s) => s.devServerPort)
  const errorCount = usePreviewStore((s) => s.viteErrors.length)
  const lastLog = usePreviewStore(
    (s) => s.viteLogs[s.viteLogs.length - 1] ?? ""
  )
  const [expanded, setExpanded] = useState(false)
  const stopPreviewRuntime = usePreviewStore((s) => s.stopPreviewRuntime)
  const { start, restart } = useDevServer()

  const isRunning = devServerStatus === "running"
  const isStarting = devServerStatus === "starting"

  // Unified stop: stop exactly the runtime that currently owns the preview.
  const stop = useCallback(() => {
    void stopPreviewRuntime()
  }, [stopPreviewRuntime])

  // Force start: if stuck in "starting", use restart to break out
  const handleForceStart = useCallback(() => {
    if (isStarting) {
      restart()
    } else {
      start()
    }
  }, [isStarting, restart, start])

  const statusColor =
    isRunning
      ? "var(--color-success, #22c55e)"
      : isStarting
        ? "var(--color-warning, #eab308)"
        : devServerStatus === "error"
          ? "var(--color-error, #ef4444)"
          : "var(--color-text-placeholder, #6b7280)"

  const statusText =
    isRunning
      ? `Running :${devServerPort}`
      : isStarting
        ? "Starting..."
        : devServerStatus === "error"
          ? "Error"
          : "Stopped"

  return (
    <div style={{ borderTop: "1px solid var(--color-border)" }}>
      {/* Expanded log panel */}
      {expanded && <LogPanel />}

      {/* Status bar */}
      <div
        className="flex items-center gap-3 px-3 py-1 text-xs"
        style={{
          backgroundColor: "var(--color-surface-alt)",
          color: "var(--color-text-placeholder)",
        }}
      >
        {/* Start / Stop button */}
        {isRunning ? (
          <button
            onClick={stop}
            className="flex items-center gap-1 px-1.5 py-0.5 rounded hover:opacity-80"
            style={{ color: "var(--color-error, #ef4444)" }}
            title="Stop Dev Server"
          >
            <Square size={10} fill="currentColor" />
            <span>Stop</span>
          </button>
        ) : (
          <button
            onClick={handleForceStart}
            className="flex items-center gap-1 px-1.5 py-0.5 rounded hover:opacity-80"
            style={{ color: "var(--color-success, #22c55e)" }}
            title={isStarting ? "Force Restart Dev Server" : "Start Dev Server"}
          >
            {isStarting ? <RotateCcw size={10} /> : <Play size={10} fill="currentColor" />}
            <span>{isStarting ? "Restart" : "Start"}</span>
          </button>
        )}

        <div className="flex items-center gap-1.5">
          <div
            className="w-2 h-2 rounded-full"
            style={{ backgroundColor: statusColor }}
          />
          <span>{statusText}</span>
        </div>

        {errorCount > 0 && (
          <button
            onClick={() => setExpanded((v) => !v)}
            className="flex items-center gap-1"
            style={{ color: "var(--color-error, #ef4444)" }}
          >
            {errorCount} error{errorCount > 1 ? "s" : ""}
            {expanded ? <ChevronDown size={12} /> : <ChevronUp size={12} />}
          </button>
        )}

        <span className="flex-1 truncate opacity-60">{lastLog}</span>

        <button
          onClick={() => setExpanded((v) => !v)}
          className="p-0.5 rounded opacity-60 hover:opacity-100"
          title={expanded ? "Hide Logs" : "Show Logs"}
        >
          {expanded ? <ChevronDown size={12} /> : <ChevronUp size={12} />}
        </button>
      </div>
    </div>
  )
}

function LogPanel() {
  const viteLogs = usePreviewStore((s) => s.viteLogs)
  const viteErrors = usePreviewStore((s) => s.viteErrors)
  const clearViteErrors = usePreviewStore((s) => s.clearViteErrors)
  const { restart } = useDevServer()
  const scrollRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight
    }
  }, [viteLogs.length, viteErrors.length])

  return (
    <div
      className="flex flex-col"
      style={{
        height: "180px",
        backgroundColor: "var(--color-background)",
        borderTop: "1px solid var(--color-border)",
      }}
    >
      {/* Panel header */}
      <div
        className="flex items-center gap-2 px-3 py-1 text-xs shrink-0"
        style={{
          borderBottom: "1px solid var(--color-border)",
          color: "var(--color-text-tertiary)",
        }}
      >
        <span className="font-medium">Vite Output</span>
        <div className="flex-1" />
        {viteErrors.length > 0 && (
          <>
            <button
              onClick={() => clearViteErrors()}
              className="flex items-center gap-1 px-1.5 py-0.5 rounded hover:opacity-80"
              style={{ color: "var(--color-text-placeholder)" }}
              title="Clear Errors"
            >
              <Trash2 size={11} />
              <span>Clear</span>
            </button>
            <button
              onClick={restart}
              className="flex items-center gap-1 px-1.5 py-0.5 rounded hover:opacity-80"
              style={{ color: "var(--color-accent-blue)" }}
              title="Restart Vite"
            >
              <RotateCcw size={11} />
              <span>Restart</span>
            </button>
          </>
        )}
      </div>

      {/* Scrollable log output */}
      <div
        ref={scrollRef}
        className="flex-1 overflow-auto px-3 py-1 font-mono text-xs"
        style={{ color: "var(--color-text-tertiary)" }}
      >
        {viteLogs.map((log, i) => (
          <div key={`log-${i}`} className="py-0.5 whitespace-pre-wrap break-all">
            {log}
          </div>
        ))}
        {viteErrors.map((err, i) => (
          <div
            key={`err-${i}`}
            className="py-0.5 whitespace-pre-wrap break-all"
            style={{ color: "var(--color-error, #ef4444)" }}
          >
            {err}
          </div>
        ))}
      </div>
    </div>
  )
}
