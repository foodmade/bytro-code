/**
 * Voice recording UI components — waveform visualization and recording panel.
 */

import { memo, useCallback } from "react";
import { useTranslation } from "react-i18next";
import { Paperclip, Code, Mic, Settings } from "lucide-react";

// ---------------------------------------------------------------------------
// Helper functions
// ---------------------------------------------------------------------------

/** Format duration in mm:ss */
export function formatVoiceDuration(ms: number): string {
  const totalSec = Math.floor(ms / 1000);
  const min = Math.floor(totalSec / 60);
  const sec = totalSec % 60;
  return `${min}:${sec.toString().padStart(2, "0")}`;
}

// ---------------------------------------------------------------------------
// Waveform visualization — 40 bars responding to audio
// Each bar's height is driven by a CSS custom property `--h` written directly
// by useAudioVisualizer's RAF loop; React is not in the hot path.
// ---------------------------------------------------------------------------

const BAR_COUNT = 40;

export const VoiceWaveform = memo(function VoiceWaveform({
  registerBar,
}: {
  readonly registerBar: (index: number, el: HTMLElement | null) => void;
}) {
  return (
    <div className="voice-waveform">
      {Array.from({ length: BAR_COUNT }).map((_, i) => (
        <span
          key={i}
          ref={(el) => registerBar(i, el)}
          className="voice-waveform-bar entering"
          style={{ animationDelay: `${i * 15}ms` }}
        />
      ))}
    </div>
  );
});

// ---------------------------------------------------------------------------
// Voice recording panel — replaces editor + toolbar during recording
// ---------------------------------------------------------------------------

interface VoiceRecordingPanelProps {
  readonly registerBar: (index: number, el: HTMLElement | null) => void;
  readonly interimText: string;
  readonly durationMs: number;
  readonly onToggleRecording: () => void;
  readonly onAttachClick: () => void;
}

export const VoiceRecordingPanel = memo(function VoiceRecordingPanel({
  registerBar,
  interimText,
  durationMs,
  onToggleRecording,
  onAttachClick,
}: VoiceRecordingPanelProps) {
  const { t } = useTranslation();

  const handleStopClick = useCallback(() => {
    onToggleRecording();
  }, [onToggleRecording]);

  return (
    <>
      {/* Waveform visualization */}
      <VoiceWaveform registerBar={registerBar} />

      {/* Real-time transcript area */}
      <div className="flex items-center w-full" style={{ minHeight: 20 }}>
        {interimText ? (
          <>
            <span style={{ color: "var(--color-foreground)", fontSize: 13, lineHeight: 1.5 }}>{interimText}</span>
            <div className="voice-cursor" />
          </>
        ) : (
          <span style={{ color: "var(--color-text-placeholder)", fontSize: 13, fontStyle: "italic" }}>
            {t("chat.voiceListening")}
          </span>
        )}
      </div>

      {/* Voice bottom bar */}
      <div className="flex items-center justify-between gap-2 min-w-0">
        <div className="flex items-center" style={{ gap: 8 }}>
          <button
            onClick={onAttachClick}
            className="transition-colors"
            style={{ color: "var(--color-text-placeholder)" }}
            title={t("chat.attachFiles")}
          >
            <Paperclip size={16} />
          </button>
          <button
            disabled
            style={{ color: "var(--color-text-placeholder)", opacity: 0.4 }}
          >
            <Code size={16} />
          </button>
          <div className="voice-mic-active-wrap">
            <div className="voice-mic-pulse-ring" />
            <Mic size={14} style={{ color: "var(--color-voice-rec)" }} />
          </div>
          <button
            className="transition-colors"
            style={{ color: "var(--color-text-placeholder)" }}
            title={t("chat.chatPreferences")}
          >
            <Settings size={16} />
          </button>
        </div>

        <div className="flex items-center" style={{ gap: 10 }}>
          <div className="voice-duration-badge">
            <div className="voice-rec-dot" />
            <span style={{
              color: "var(--color-voice-rec)",
              fontSize: 11,
              fontWeight: 600,
              fontFamily: "'JetBrains Mono', monospace",
            }}>
              {formatVoiceDuration(durationMs)}
            </span>
          </div>
          <button
            onClick={handleStopClick}
            className="voice-stop-btn"
            aria-label={t("chat.voiceClickToStop")}
          >
            <div style={{
              width: 10,
              height: 10,
              borderRadius: 2,
              background: "#FFFFFF",
            }} />
          </button>
        </div>
      </div>
    </>
  );
});
