import { forwardRef } from "react"
import { usePreviewStore } from "@/stores"

const DEVICE_SIZES: Record<string, { width: string; height: string }> = {
  desktop: { width: "100%", height: "100%" },
  tablet: { width: "768px", height: "1024px" },
  mobile: { width: "375px", height: "812px" },
}

export const PreviewPanel = forwardRef<HTMLIFrameElement>(
  function PreviewPanel(_, ref) {
    const { framePreviewUrl, deviceMode, devServerStatus } = usePreviewStore()

    if (devServerStatus !== "running") {
      return (
        <div className="flex-1 flex items-center justify-center" style={{ backgroundColor: "var(--color-background)", color: "var(--color-text-tertiary)" }}>
          {devServerStatus === "starting" ? (
            <div className="text-center">
              <div className="animate-spin w-8 h-8 border-2 border-t-transparent rounded-full mx-auto mb-3" style={{ borderColor: "var(--color-accent-blue)", borderTopColor: "transparent" }} />
              <p>Starting Vite...</p>
            </div>
          ) : devServerStatus === "error" ? (
            <p style={{ color: "var(--color-error, #EF4444)" }}>Vite failed to start. Check status bar for details.</p>
          ) : (
            <p>Waiting for dev server...</p>
          )}
        </div>
      )
    }

    // Defer mounting the iframe until the proxy session has been registered
    // (or `setPreviewUrl` decided this is a build project and copied the
    // direct URL into framePreviewUrl synchronously). Loading the upstream
    // URL directly during the brief async window would cause an inspector-
    // less first paint followed by a reload to the proxy URL.
    if (!framePreviewUrl) {
      return (
        <div className="flex-1 flex items-center justify-center" style={{ backgroundColor: "var(--color-background)", color: "var(--color-text-tertiary)" }}>
          <div className="text-center">
            <div className="animate-spin w-6 h-6 border-2 border-t-transparent rounded-full mx-auto mb-3" style={{ borderColor: "var(--color-accent-blue)", borderTopColor: "transparent" }} />
            <p>Preparing preview...</p>
          </div>
        </div>
      )
    }

    const size = DEVICE_SIZES[deviceMode]

    return (
      <div className="flex-1 flex items-start justify-center overflow-auto p-2" style={{ backgroundColor: "var(--color-background)" }}>
        <div
          style={{
            width: size.width,
            height: size.height,
            maxWidth: "100%",
            maxHeight: "100%",
          }}
          className="bg-white rounded-lg overflow-hidden shadow-2xl"
        >
          <iframe
            ref={ref}
            src={framePreviewUrl}
            sandbox="allow-scripts allow-same-origin allow-forms allow-popups"
            allow="clipboard-read; clipboard-write"
            className="w-full h-full border-0"
            title="Preview"
          />
        </div>
      </div>
    )
  }
)
