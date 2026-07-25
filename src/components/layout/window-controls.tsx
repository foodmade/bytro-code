import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { Minus, Square, X, Maximize2 } from "lucide-react";

function detectPlatform(): "mac" | "windows" | "linux" {
  // Prefer NavigatorUAData (modern Chromium / WebView2)
  const uaPlatform = (navigator as { userAgentData?: { platform?: string } }).userAgentData?.platform
    ?? navigator.platform
    ?? "";
  const p = uaPlatform.toLowerCase();
  if (p.startsWith("mac")) return "mac";
  if (p.startsWith("win")) return "windows";
  return "linux";
}

const detectedPlatform = detectPlatform();

export const isMacPlatform = detectedPlatform === "mac";
export const isWindowsPlatform = detectedPlatform === "windows";

/* ─── Windows / Linux controls (right side): ─ □ ✕ ─── */
function WindowsControls() {
  const [maximized, setMaximized] = useState(false);

  let appWindow: ReturnType<typeof getCurrentWindow> | null = null;
  try {
    appWindow = getCurrentWindow();
  } catch {
    // Not running inside Tauri (e.g. opened in a regular browser)
  }

  useEffect(() => {
    if (!appWindow) return;
    let cancelled = false;
    appWindow.isMaximized().then((v) => {
      if (!cancelled) setMaximized(v);
    });

    const unlisten = appWindow.onResized(async () => {
      const m = await appWindow!.isMaximized();
      if (!cancelled) setMaximized(m);
    });

    return () => {
      cancelled = true;
      unlisten.then((fn) => fn());
    };
  }, [appWindow]);

  const { t } = useTranslation();
  const handleMinimize = useCallback(() => appWindow?.minimize(), [appWindow]);
  const handleMaximize = useCallback(() => appWindow?.toggleMaximize(), [appWindow]);
  const handleClose = useCallback(() => appWindow?.close(), [appWindow]);

  return (
    <div className="flex items-center h-full no-press-scale">
      {/* Minimize */}
      <button
        onClick={handleMinimize}
        className="no-press-scale flex items-center justify-center transition-colors hover:bg-hover-overlay/[0.08]"
        style={{ width: 46, height: 40 }}
        aria-label={t("window.minimize")}
      >
        <Minus size={14} className="text-muted-foreground transition-colors" />
      </button>

      {/* Maximize / Restore */}
      <button
        onClick={handleMaximize}
        className="no-press-scale flex items-center justify-center transition-colors hover:bg-hover-overlay/[0.08]"
        style={{ width: 46, height: 40 }}
        aria-label={maximized ? t("window.restore") : t("window.maximize")}
      >
        {maximized ? (
          <Maximize2 size={12} className="text-muted-foreground transition-colors" />
        ) : (
          <Square size={11} className="text-muted-foreground transition-colors" />
        )}
      </button>

      {/* Close — group class enables child color change on hover */}
      <button
        onClick={handleClose}
        className="group no-press-scale flex items-center justify-center transition-colors hover:bg-[#e81123]"
        style={{ width: 46, height: 40 }}
        aria-label={t("window.close")}
      >
        <X size={14} className="text-muted-foreground transition-colors group-hover:text-white" />
      </button>
    </div>
  );
}

/**
 * Platform-aware window controls.
 * - Windows: custom minimize / maximize / close buttons (decorations: false)
 * - macOS / Linux: returns null (uses native title bar with decorations: true)
 */
export function WindowControls() {
  if (!isWindowsPlatform) return null;
  return <WindowsControls />;
}
