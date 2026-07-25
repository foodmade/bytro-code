/**
 * Custom hook for voice input state management.
 *
 * Consolidates local speech setup (check → load/authorize → ready),
 * recording control, waveform visualization, and install popup state.
 */

import { useCallback, useState } from "react";
import { useVoiceInput } from "@/hooks/use-voice-input";
import { useAudioVisualizer } from "@/hooks/use-audio-visualizer";
import { useWhisperStore, useToastStore } from "@/stores";
import { useTranslation } from "react-i18next";
import { getEditorText, updateEditorEmpty } from "./editor-helpers";

interface UseVoiceSetupOptions {
  /** Ref to the contentEditable editor element (for transcription insertion). */
  readonly editorRef: React.RefObject<HTMLDivElement | null>;
  /** Called after inserting transcription text to recalculate editor height. */
  readonly autoResize: () => void;
  /** State setter for the text input value. */
  readonly setInput: (text: string) => void;
}

export function useVoiceSetup({ editorRef, autoResize, setInput }: UseVoiceSetupOptions) {
  const { t } = useTranslation();
  const whisperPhase = useWhisperStore((s) => s.phase);
  const modelExistsOnDisk = useWhisperStore((s) => s.modelExistsOnDisk);
  const addToast = useToastStore((s) => s.addToast);
  const [showInstallPopup, setShowInstallPopup] = useState(false);
  const [autoLoading, setAutoLoading] = useState(false);

  // Transcription handler — inserts recognized text at cursor position
  const handleVoiceTranscription = useCallback(
    (text: string) => {
      const editor = editorRef.current;
      if (!editor) return;
      editor.focus();
      const sel = window.getSelection();
      if (sel && sel.rangeCount > 0) {
        const range = sel.getRangeAt(0);
        range.deleteContents();
        const textNode = document.createTextNode(text);
        range.insertNode(textNode);
        range.setStartAfter(textNode);
        range.collapse(true);
        sel.removeAllRanges();
        sel.addRange(range);
      } else {
        editor.appendChild(document.createTextNode(text));
      }
      setInput(getEditorText(editor));
      updateEditorEmpty(editor);
      autoResize();
    },
    [editorRef, autoResize, setInput],
  );

  const voiceInput = useVoiceInput({
    onTranscription: handleVoiceTranscription,
    onError: (err) => {
      if (err === "microphone_permission_denied") {
        addToast("error", t("chat.voicePermissionDenied"));
      } else if (err === "no_microphone") {
        addToast("error", t("chat.voiceNoMicrophone"));
      } else if (err === "recording_too_short") {
        addToast("warning", t("chat.voiceRecordingTooShort"));
      } else {
        addToast("error", t("chat.voiceError", { error: err }));
      }
    },
  });

  const { registerBar } = useAudioVisualizer(voiceInput.stream);
  const isVoiceRecording = voiceInput.phase === "recording";
  const isVoiceProcessing = voiceInput.phase === "processing";

  /** Load a model already present on disk and start recording on success. */
  const tryAutoLoad = useCallback(async () => {
    setAutoLoading(true);
    try {
      await useWhisperStore.getState().ensureModel();
      voiceInput.toggleRecording();
    } catch (err) {
      addToast("error", String(err));
    } finally {
      setAutoLoading(false);
    }
  }, [voiceInput, addToast]);

  /** Handle mic icon click — load local resources or show the setup popup. */
  const handleMicClick = useCallback(async () => {
    if (whisperPhase === "ready") {
      voiceInput.toggleRecording();
      return;
    }
    if (whisperPhase === "loading" || autoLoading) {
      return;
    }
    if (modelExistsOnDisk) {
      await tryAutoLoad();
      return;
    }
    if (whisperPhase === "unknown") {
      try {
        await useWhisperStore.getState().checkStatus();
        const { modelExistsOnDisk: exists, phase } = useWhisperStore.getState();
        if (phase === "ready") {
          voiceInput.toggleRecording();
          return;
        }
        if (exists) {
          await tryAutoLoad();
          return;
        }
      } catch {
        // Fall through to show install popup
      }
    }
    setShowInstallPopup(true);
  }, [whisperPhase, modelExistsOnDisk, autoLoading, voiceInput, tryAutoLoad]);

  const handleInstallPopupClose = useCallback(() => {
    setShowInstallPopup(false);
  }, []);

  const handleInstallPopupReady = useCallback(() => {
    setShowInstallPopup(false);
    voiceInput.toggleRecording();
  }, [voiceInput]);

  return {
    voiceInput,
    registerBar,
    isVoiceRecording,
    isVoiceProcessing,
    showInstallPopup,
    autoLoading,
    handleMicClick,
    handleInstallPopupClose,
    handleInstallPopupReady,
  } as const;
}
