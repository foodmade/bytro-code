import { useState, useEffect } from "react";
import { getVersion } from "@tauri-apps/api/app";
import logoPng from "@/assets/logo.png";
import { useAppStore, useWorkspaceStore, useConversationStore } from "@/stores";
import { APP_NAME } from "@/lib/app-constants";
import { WindowControls, isWindowsPlatform } from "./window-controls";

function BarLeft({ displayVersion }: { displayVersion: string }) {
  const workspace = useWorkspaceStore((s) => s.activeWorkspace);

  return (
    <div className="flex items-center h-full shrink-0" style={{ gap: 12 }} data-tauri-drag-region>
      <img src={logoPng} alt={APP_NAME} width={18} height={18} className="shrink-0 rounded-[3px]" />
      <span
        className="font-sans shrink-0"
        style={{ fontSize: 13, fontWeight: 600, color: "var(--color-foreground)" }}
      >
        {APP_NAME}
      </span>
      {workspace?.name && (
        <>
          <span
            className="shrink-0"
            style={{ fontSize: 12, color: "var(--color-border-strong)" }}
          >
            /
          </span>
          <span
            className="font-sans shrink-0 truncate max-w-[200px]"
            style={{ fontSize: 12, fontWeight: 500, color: "var(--color-muted-foreground)" }}
          >
            {workspace.name}
          </span>
        </>
      )}
      {displayVersion && (
        <span
          className="font-mono shrink-0"
          style={{ fontSize: 10, fontWeight: 500, color: "var(--color-muted)" }}
        >
          v{displayVersion}
        </span>
      )}
    </div>
  );
}

function BarCenter() {
  const activeView = useAppStore((s) => s.activeView);
  const activeConvId = useConversationStore((s) => s.activeConversationId);
  const conversations = useConversationStore((s) => s.conversations);

  const activeConv = activeConvId
    ? conversations.find((c) => c.id === activeConvId)
    : null;

  if (activeView === "workspace") {
    return null;
  }

  if (activeView === "chat" || activeView === "editor") {
    const title = activeConv?.title ?? "New Session";
    return (
      <span
        className="text-[12px] font-medium font-sans truncate max-w-[400px]"
        style={{ color: "var(--color-muted-foreground)" }}
      >
        {title}
      </span>
    );
  }

  return null;
}

export function TopBar() {
  const [appVersion, setAppVersion] = useState("");
  useEffect(() => {
    getVersion().then(setAppVersion).catch(() => {});
  }, []);

  // macOS: no separate drag region needed — each view's header handles dragging
  if (!isWindowsPlatform) {
    return null;
  }

  return (
    <header
      className="relative flex items-center select-none shrink-0 bg-topbar"
      style={{
        height: 40,
        paddingLeft: 16,
        paddingRight: 0,
        borderBottom: "1px solid var(--color-border)",
      }}
      data-tauri-drag-region
    >
      {/* BarLeft: logo + name + project + version */}
      <BarLeft displayVersion={appVersion} />

      {/* BarCenter: context text – absolutely centered in header */}
      <div
        className="absolute inset-0 flex items-center justify-center pointer-events-none"
        data-tauri-drag-region
      >
        <BarCenter />
      </div>

      <div className="flex items-center h-full shrink-0 ml-auto">
        <WindowControls />
      </div>
    </header>
  );
}
