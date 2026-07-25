import { memo, useCallback, useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import { HardDrive, Info, Loader2, RefreshCw, X } from "lucide-react";
import { useWhisperStore, useToastStore } from "@/stores";
import { useClickOutside } from "@/hooks";

// ---------------------------------------------------------------------------
// VoiceInstallPopup — local speech setup and model detection.
// ---------------------------------------------------------------------------

interface VoiceInstallPopupProps {
  readonly onClose: () => void;
  readonly onReady: () => void;
}

export const VoiceInstallPopup = memo(function VoiceInstallPopup({
  onClose,
  onReady,
}: VoiceInstallPopupProps) {
  const { t } = useTranslation();
  const phase = useWhisperStore((s) => s.phase);
  const error = useWhisperStore((s) => s.error);
  const addToast = useToastStore((s) => s.addToast);
  const popupRef = useRef<HTMLDivElement>(null);

  useClickOutside(popupRef, onClose);

  // Set up Tauri status listeners.
  useEffect(() => {
    const unlisten = useWhisperStore.getState().initListeners();
    return () => {
      unlisten.then((fn) => fn());
    };
  }, []);

  // Listen for model ready
  useEffect(() => {
    if (phase === "ready") {
      onReady();
    }
  }, [phase, onReady]);

  const handleInstall = useCallback(async () => {
    try {
      await useWhisperStore.getState().ensureModel();
    } catch (err) {
      addToast("error", String(err));
    }
  }, [addToast]);

  const isLoading = phase === "loading";
  const isError = phase === "error";

  return (
    <div
      ref={popupRef}
      className="voice-install-popup"
      style={{
        position: "absolute",
        bottom: "calc(100% + 12px)",
        left: 0,
        width: 360,
        zIndex: 50,
      }}
    >
      <div className="voice-install-card">
        {/* Header */}
        <div className="flex items-center justify-between w-full">
          <div className="flex items-center gap-3">
            <div className="voice-install-icon-wrap">
              {isLoading ? (
                <Loader2 size={20} className="animate-spin" style={{ color: "#A855F7" }} />
              ) : (
                <HardDrive size={20} style={{ color: "#A855F7" }} />
              )}
            </div>
            <div className="flex flex-col gap-1">
              <span style={{ color: "#EEEEEE", fontSize: 15, fontWeight: 600 }}>
                {isLoading ? t("chat.voiceModelLoading") : t("chat.voiceInstallTitle")}
              </span>
              <span style={{ color: "#777777", fontSize: 12 }}>
                {isLoading ? t("chat.voiceSetupChecking") : t("chat.voiceInstallSubtitle")}
              </span>
            </div>
          </div>
          {!isLoading && (
            <button onClick={onClose} className="voice-install-close-btn" aria-label="Close">
              <X size={14} style={{ color: "#555555" }} />
            </button>
          )}
        </div>

        {/* State 1: Install prompt */}
        {!isLoading && !isError && (
          <>
            <p style={{ color: "#999999", fontSize: 13, lineHeight: 1.5, margin: 0 }}>
              {t("chat.voiceInstallDesc")}
            </p>

            {/* Info badge */}
            <div className="voice-install-info-badge">
              <Info size={14} style={{ color: "#4ADE80", flexShrink: 0 }} />
              <span style={{ color: "#4ADE80", fontSize: 12, fontWeight: 500 }}>
                {t("chat.voiceInstallOnce")}
              </span>
            </div>

            {/* Local setup check */}
            <button onClick={handleInstall} className="voice-install-btn">
              <HardDrive size={16} style={{ color: "#FFFFFF" }} />
              <span style={{ color: "#FFFFFF", fontSize: 14, fontWeight: 600 }}>
                {t("chat.voiceInstallBtn")}
              </span>
            </button>
          </>
        )}

        {/* State 2: checking/loading a local setup */}
        {isLoading && (
          <>
            <p style={{ color: "#999999", fontSize: 13, lineHeight: 1.5, margin: 0 }}>
              {t("chat.voiceSetupCheckingDesc")}
            </p>
            <div className="voice-install-info-badge">
              <Info size={14} style={{ color: "#4ADE80", flexShrink: 0 }} />
              <span style={{ color: "#4ADE80", fontSize: 12, fontWeight: 500 }}>
                {t("chat.voiceInstallPatience")}
              </span>
            </div>
          </>
        )}

        {/* Error state */}
        {isError && (
          <>
            <p style={{ color: "#EF4444", fontSize: 13, margin: 0 }}>{error || "Unknown error"}</p>
            <button onClick={handleInstall} className="voice-install-btn">
              <RefreshCw size={16} style={{ color: "#FFFFFF" }} />
              <span style={{ color: "#FFFFFF", fontSize: 14, fontWeight: 600 }}>
                {t("chat.voiceRetryInstall")}
              </span>
            </button>
          </>
        )}
      </div>
    </div>
  );
});
