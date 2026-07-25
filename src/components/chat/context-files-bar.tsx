import { useCallback } from "react";
import { useTranslation } from "react-i18next";
import { Paperclip, X, Folder } from "lucide-react";
import { useAppStore } from "@/stores";

/**
 * Compact bar showing files and directories attached as context for the next message.
 * Each item is displayed as a pill with a remove button.
 */
export function ContextFilesBar() {
  const { t } = useTranslation();
  const contextFiles = useAppStore((s) => s.contextFiles);
  const contextDirs = useAppStore((s) => s.contextDirs);
  const removeContextFile = useAppStore((s) => s.removeContextFile);
  const removeContextDir = useAppStore((s) => s.removeContextDir);

  const getName = useCallback((fullPath: string) => {
    const parts = fullPath.split(/[\\/]/);
    return parts[parts.length - 1] || fullPath;
  }, []);

  if (contextFiles.length === 0 && contextDirs.length === 0) return null;

  return (
    <div
      className="flex items-center w-full"
      style={{ padding: "4px 4px", gap: 6 }}
    >
      <Paperclip size={13} style={{ color: "var(--color-accent-purple)", flexShrink: 0 }} />
      <span
        style={{
          fontFamily: "var(--font-sans)",
          fontSize: 11,
          fontWeight: 600,
          color: "var(--color-muted)",
          whiteSpace: "nowrap",
        }}
      >
        {t("chat.contextFiles.label")}
      </span>
      <div className="flex items-center flex-wrap" style={{ gap: 4, overflow: "hidden" }}>
        {contextDirs.map((dirPath) => (
          <span
            key={`dir:${dirPath}`}
            className="flex items-center shrink-0"
            style={{
              fontFamily: "var(--font-mono)",
              fontSize: 10,
              fontWeight: 400,
              color: "var(--color-accent-purple)",
              backgroundColor: "rgba(var(--theme-accent-rgb),0.08)",
              border: "1px solid rgba(var(--theme-accent-rgb),0.2)",
              borderRadius: 4,
              padding: "2px 6px 2px 6px",
              gap: 4,
              maxWidth: 180,
            }}
          >
            <Folder size={11} style={{ color: "var(--color-accent-purple)", flexShrink: 0 }} />
            <span className="truncate">{getName(dirPath)}</span>
            <button
              onClick={() => removeContextDir(dirPath)}
              className="shrink-0 hover:opacity-80 transition-opacity"
              style={{
                background: "none",
                border: "none",
                cursor: "pointer",
                padding: 0,
                lineHeight: 0,
              }}
            >
              <X size={10} style={{ color: "var(--color-muted)" }} />
            </button>
          </span>
        ))}
        {contextFiles.map((filePath) => (
          <span
            key={filePath}
            className="flex items-center shrink-0"
            style={{
              fontFamily: "var(--font-mono)",
              fontSize: 10,
              fontWeight: 400,
              color: "var(--color-accent-purple)",
              backgroundColor: "rgba(var(--theme-accent-rgb),0.08)",
              border: "1px solid rgba(var(--theme-accent-rgb),0.2)",
              borderRadius: 4,
              padding: "2px 6px 2px 8px",
              gap: 4,
              maxWidth: 180,
            }}
          >
            <span className="truncate">{getName(filePath)}</span>
            <button
              onClick={() => removeContextFile(filePath)}
              className="shrink-0 hover:opacity-80 transition-opacity"
              style={{
                background: "none",
                border: "none",
                cursor: "pointer",
                padding: 0,
                lineHeight: 0,
              }}
            >
              <X size={10} style={{ color: "var(--color-muted)" }} />
            </button>
          </span>
        ))}
      </div>
    </div>
  );
}
