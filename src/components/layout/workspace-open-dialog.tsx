import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { HelpCircle } from "lucide-react";
import { useSettingsStore } from "@/stores";

// ---------------------------------------------------------------------------
// Promise-based dialog for choosing how to open a workspace
// ---------------------------------------------------------------------------

export type WorkspaceOpenChoice = "current" | "new" | "cancel";

let resolveChoice: ((choice: WorkspaceOpenChoice) => void) | null = null;
let dialogState: {
  setOpen: (open: boolean) => void;
  setName: (name: string) => void;
} | null = null;

/**
 * Show the "Open in current window / new window" dialog.
 * Returns a promise that resolves when the user picks an option.
 * If the user previously checked "don't ask again", resolves immediately
 * with their remembered choice.
 */
export function showWorkspaceOpenDialog(
  workspaceName: string,
): Promise<WorkspaceOpenChoice> {
  const mode = useSettingsStore.getState().workspaceOpenMode;

  if (mode === "current") return Promise.resolve("current");
  if (mode === "new") return Promise.resolve("new");

  return new Promise((resolve) => {
    resolveChoice = resolve;
    if (dialogState) {
      dialogState.setName(workspaceName);
      dialogState.setOpen(true);
    } else {
      resolve("current");
    }
  });
}

// ---------------------------------------------------------------------------
// Dialog component — must be mounted once near the app root
// ---------------------------------------------------------------------------

export function WorkspaceOpenDialog() {
  const { t } = useTranslation();
  const [isOpen, setIsOpen] = useState(false);
  const [workspaceName, setWorkspaceName] = useState("");
  const [dontAskAgain, setDontAskAgain] = useState(false);
  const backdropRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    dialogState = { setOpen: setIsOpen, setName: setWorkspaceName };
    return () => {
      dialogState = null;
    };
  }, []);

  const choose = useCallback(
    (choice: WorkspaceOpenChoice) => {
      if (dontAskAgain && choice !== "cancel") {
        useSettingsStore.getState().setWorkspaceOpenMode(choice);
      }
      setIsOpen(false);
      setDontAskAgain(false);
      resolveChoice?.(choice);
      resolveChoice = null;
    },
    [dontAskAgain],
  );

  const handleBackdropClick = useCallback(
    (e: React.MouseEvent) => {
      if (e.target === backdropRef.current) choose("cancel");
    },
    [choose],
  );

  useEffect(() => {
    if (!isOpen) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") choose("cancel");
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [isOpen, choose]);

  if (!isOpen) return null;

  return (
    <div
      ref={backdropRef}
      onClick={handleBackdropClick}
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 9999,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        backgroundColor: "rgba(0,0,0,0.5)",
      }}
    >
      <div
        className="animate-popup-enter"
        style={{
          width: 420,
          backgroundColor: "var(--color-surface)",
          border: "1px solid var(--color-border)",
          borderRadius: 10,
          boxShadow: "var(--shadow-popup)",
          padding: "20px 24px",
          display: "flex",
          flexDirection: "column",
          gap: 16,
        }}
      >
        {/* Header: icon + title */}
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <div
            style={{
              width: 36,
              height: 36,
              borderRadius: "50%",
              backgroundColor: "color-mix(in srgb, var(--color-accent-blue) 15%, var(--color-surface))",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              flexShrink: 0,
            }}
          >
            <HelpCircle size={20} style={{ color: "var(--color-accent-blue)" }} />
          </div>
          <div>
            <div
              style={{
                fontSize: 15,
                fontWeight: 600,
                color: "var(--color-foreground)",
              }}
            >
              {t("workspace.openDialog.title", "Open Project")}
            </div>
            <div
              style={{
                fontSize: 13,
                color: "var(--color-muted)",
                marginTop: 2,
              }}
            >
              {t("workspace.openDialog.description", 'How would you like to open "{{name}}"?', {
                name: workspaceName,
              })}
            </div>
          </div>
        </div>

        {/* Don't ask again checkbox */}
        <label
          style={{
            display: "flex",
            alignItems: "center",
            gap: 6,
            cursor: "pointer",
            userSelect: "none",
          }}
        >
          <input
            type="checkbox"
            checked={dontAskAgain}
            onChange={(e) => setDontAskAgain(e.target.checked)}
            style={{
              width: 14,
              height: 14,
              accentColor: "var(--color-accent-purple)",
              cursor: "pointer",
            }}
          />
          <span style={{ fontSize: 12, color: "var(--color-muted)" }}>
            {t("workspace.openDialog.dontAskAgain", "Don't ask again")}
          </span>
        </label>

        {/* Action buttons */}
        <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
            <button
              onClick={() => choose("cancel")}
              style={{
                padding: "6px 14px",
                fontSize: 13,
                fontWeight: 500,
                color: "var(--color-muted)",
                backgroundColor: "transparent",
                border: "none",
                borderRadius: 6,
                cursor: "pointer",
              }}
              className="hover:bg-hover-overlay/[0.06]"
            >
              {t("workspace.openDialog.cancelBtn", "Cancel")}
            </button>

            <button
              onClick={() => choose("new")}
              style={{
                padding: "6px 14px",
                fontSize: 13,
                fontWeight: 500,
                color: "var(--color-foreground)",
                backgroundColor: "transparent",
                border: "1px solid var(--color-border)",
                borderRadius: 6,
                cursor: "pointer",
              }}
              className="hover:bg-hover-overlay/[0.06]"
            >
              {t("workspace.openDialog.newWindowBtn", "New Window")}
            </button>

            <button
              onClick={() => choose("current")}
              style={{
                padding: "6px 14px",
                fontSize: 13,
                fontWeight: 500,
                color: "#fff",
                backgroundColor: "var(--color-accent-purple)",
                border: "none",
                borderRadius: 6,
                cursor: "pointer",
              }}
              className="hover:opacity-90"
            >
              {t("workspace.openDialog.currentWindowBtn", "This Window")}
            </button>
          </div>
      </div>
    </div>
  );
}
