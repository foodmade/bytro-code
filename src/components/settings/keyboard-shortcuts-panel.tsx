import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { RotateCcw } from "lucide-react";
import { useSettingsStore } from "@/stores";
import {
  type ShortcutAction,
  type ShortcutBinding,
  type ShortcutConfig,
  SHORTCUT_ACTIONS,
  DEFAULT_SHORTCUTS,
  parseShortcuts,
  stringifyShortcuts,
  formatShortcutParts,
  findConflict,
} from "@/lib/keyboard-shortcuts";

// i18n key for each action
const ACTION_LABEL_KEYS: Record<ShortcutAction, string> = {
  sendMessage:   "settings.shortcuts.sendMessage",
  newline:       "settings.shortcuts.newline",
  midStreamSend: "settings.shortcuts.midStreamSend",
  quickCapture:  "settings.shortcuts.quickCapture",
  voiceInput:    "settings.shortcuts.voiceInput",
  skillsMenu:    "settings.shortcuts.skillsMenu",
  newSession:    "settings.shortcuts.newSession",
  globalSearch:  "settings.shortcuts.globalSearch",
};

// ---------------------------------------------------------------------------
// Kbd-style key cap component
// ---------------------------------------------------------------------------

function KeyCap({ label }: { label: string }) {
  return (
    <span
      className="inline-flex items-center justify-center text-[11px] font-medium text-foreground"
      style={{
        minWidth: 24,
        height: 24,
        padding: "0 6px",
        borderRadius: 6,
        background: "var(--color-border)",
        border: "1px solid var(--color-border-strong)",
        boxShadow: "0 1px 0 var(--color-border-strong)",
      }}
    >
      {label}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Shortcut row
// ---------------------------------------------------------------------------

interface ShortcutRowProps {
  readonly action: ShortcutAction;
  readonly binding: ShortcutBinding;
  readonly isRecording: boolean;
  readonly onStartRecording: () => void;
  readonly onRecord: (binding: ShortcutBinding) => void;
  readonly onCancelRecording: () => void;
  readonly onReset: () => void;
  readonly isDefault: boolean;
}

function ShortcutRow({
  action,
  binding,
  isRecording,
  onStartRecording,
  onRecord,
  onCancelRecording,
  onReset,
  isDefault,
}: ShortcutRowProps) {
  const { t } = useTranslation();
  const rowRef = useRef<HTMLDivElement>(null);

  // Listen for keydown when recording
  useEffect(() => {
    if (!isRecording) return;

    const handler = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();

      // Ignore bare modifier keys
      if (["Control", "Shift", "Alt", "Meta"].includes(e.key)) return;

      // Escape cancels recording
      if (e.key === "Escape") {
        onCancelRecording();
        return;
      }

      onRecord({
        key: e.key.length === 1 ? e.key.toLowerCase() : e.key,
        ctrl: e.ctrlKey || e.metaKey || undefined,
        shift: e.shiftKey || undefined,
        alt: e.altKey || undefined,
      });
    };

    window.addEventListener("keydown", handler, true);
    return () => window.removeEventListener("keydown", handler, true);
  }, [isRecording, onRecord, onCancelRecording]);

  const parts = formatShortcutParts(binding);

  return (
    <div
      ref={rowRef}
      className="flex items-center justify-between py-2.5 px-3 rounded-lg hover:bg-border-light/30 transition-colors"
      style={{ minHeight: 44 }}
    >
      {/* Left: action label */}
      <span className="text-[13px] text-foreground font-medium">
        {t(ACTION_LABEL_KEYS[action])}
      </span>

      {/* Right: key combo + reset */}
      <div className="flex items-center gap-2">
        {/* Key combo button */}
        <button
          onClick={isRecording ? onCancelRecording : onStartRecording}
          className="flex items-center gap-1 px-2 py-1 rounded-md transition-colors cursor-pointer"
          style={{
            background: isRecording ? "var(--color-accent-purple)" : "transparent",
            border: isRecording ? "1px solid var(--color-accent-purple)" : "1px solid var(--color-border)",
            minWidth: 80,
            justifyContent: "center",
          }}
        >
          {isRecording ? (
            <span className="text-[12px] text-white animate-pulse">
              {t("settings.shortcuts.recording")}
            </span>
          ) : (
            parts.map((p, i) => <KeyCap key={i} label={p} />)
          )}
        </button>

        {/* Reset button (only visible if not default) */}
        <button
          onClick={onReset}
          disabled={isDefault}
          className="flex items-center justify-center w-6 h-6 rounded-md transition-colors"
          style={{
            opacity: isDefault ? 0.2 : 0.6,
            cursor: isDefault ? "default" : "pointer",
          }}
          title={t("settings.shortcuts.reset")}
        >
          <RotateCcw size={12} />
        </button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Panel
// ---------------------------------------------------------------------------

export function KeyboardShortcutsPanel() {
  const { t } = useTranslation();
  const shortcutsJson = useSettingsStore((s) => s.keyboardShortcuts);
  const setShortcutsJson = useSettingsStore((s) => s.setKeyboardShortcuts);

  const [config, setConfig] = useState<ShortcutConfig>(() => parseShortcuts(shortcutsJson));
  const [recordingAction, setRecordingAction] = useState<ShortcutAction | null>(null);

  // Sync from store when shortcutsJson changes externally
  useEffect(() => {
    setConfig(parseShortcuts(shortcutsJson));
  }, [shortcutsJson]);

  const handleStartRecording = useCallback((action: ShortcutAction) => {
    setRecordingAction(action);
  }, []);

  const handleCancelRecording = useCallback(() => {
    setRecordingAction(null);
  }, []);

  const handleRecord = useCallback(
    (action: ShortcutAction, binding: ShortcutBinding) => {
      const newConfig = { ...config, [action]: binding };

      // If another action has the same binding, reset it to its default
      const conflictAction = findConflict(config, action, binding);
      if (conflictAction) {
        newConfig[conflictAction] = DEFAULT_SHORTCUTS[conflictAction];
      }

      setConfig(newConfig);
      setShortcutsJson(stringifyShortcuts(newConfig));
      setRecordingAction(null);
    },
    [config, setShortcutsJson],
  );

  const handleReset = useCallback(
    (action: ShortcutAction) => {
      const newConfig = { ...config, [action]: DEFAULT_SHORTCUTS[action] };
      setConfig(newConfig);
      setShortcutsJson(stringifyShortcuts(newConfig));
    },
    [config, setShortcutsJson],
  );

  const handleResetAll = useCallback(() => {
    setConfig({ ...DEFAULT_SHORTCUTS });
    setShortcutsJson(stringifyShortcuts(DEFAULT_SHORTCUTS));
    setRecordingAction(null);
  }, [setShortcutsJson]);

  const isBindingDefault = useCallback(
    (action: ShortcutAction) => {
      const current = config[action];
      const def = DEFAULT_SHORTCUTS[action];
      return (
        current.key === def.key &&
        !!current.ctrl === !!def.ctrl &&
        !!current.shift === !!def.shift &&
        !!current.alt === !!def.alt &&
        !!current.meta === !!def.meta
      );
    },
    [config],
  );

  return (
    <div className="flex flex-col gap-4">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-[14px] font-semibold text-foreground">
            {t("settings.shortcuts.title")}
          </h3>
          <p className="text-[12px] text-muted mt-0.5">
            {t("settings.shortcuts.description")}
          </p>
        </div>
        <button
          onClick={handleResetAll}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-md text-[12px] text-muted hover:text-foreground transition-colors"
          style={{ border: "1px solid var(--color-border)" }}
        >
          <RotateCcw size={12} />
          {t("settings.shortcuts.resetAll")}
        </button>
      </div>

      {/* Shortcuts list */}
      <div
        className="flex flex-col rounded-lg"
        style={{
          border: "1px solid var(--color-border-subtle)",
          background: "var(--color-card)",
        }}
      >
        {SHORTCUT_ACTIONS.map((action, idx) => (
          <div key={action}>
            {idx > 0 && (
              <div style={{ height: 1, background: "var(--color-border-subtle)", margin: "0 12px" }} />
            )}
            <ShortcutRow
              action={action}
              binding={config[action]}
              isRecording={recordingAction === action}
              onStartRecording={() => handleStartRecording(action)}
              onRecord={(binding) => handleRecord(action, binding)}
              onCancelRecording={handleCancelRecording}
              onReset={() => handleReset(action)}
              isDefault={isBindingDefault(action)}
            />
          </div>
        ))}
      </div>
    </div>
  );
}
