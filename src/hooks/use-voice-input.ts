import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useSettingsStore } from "@/stores";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type VoiceInputPhase =
  | "idle"
  | "requesting"
  | "recording"
  | "processing"
  | "error";

interface TranscriptionResult {
  readonly text: string;
  readonly language: string;
  readonly durationMs: number;
  readonly processingMs: number;
}

interface UseVoiceInputOptions {
  readonly onTranscription: (text: string) => void;
  /** Called with interim (partial) transcription text during recording */
  readonly onInterimText?: (text: string) => void;
  readonly onError?: (error: string) => void;
}

export interface VoiceInputState {
  readonly phase: VoiceInputPhase;
  readonly error: string | null;
  readonly durationMs: number;
  /** Interim transcription text updated periodically during recording */
  readonly interimText: string;
  /** The active MediaStream when recording, for audio visualization */
  readonly stream: MediaStream | null;
  readonly toggleRecording: () => void;
  readonly cancelRecording: () => void;
}

// ---------------------------------------------------------------------------
// WAV encoder
// ---------------------------------------------------------------------------

function encodeWav(samples: Float32Array, sampleRate: number): ArrayBuffer {
  const numSamples = samples.length;
  const buffer = new ArrayBuffer(44 + numSamples * 2);
  const view = new DataView(buffer);

  // RIFF header
  writeString(view, 0, "RIFF");
  view.setUint32(4, 36 + numSamples * 2, true);
  writeString(view, 8, "WAVE");

  // fmt sub-chunk
  writeString(view, 12, "fmt ");
  view.setUint32(16, 16, true); // sub-chunk size
  view.setUint16(20, 1, true); // PCM format
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true); // byte rate
  view.setUint16(32, 2, true); // block align
  view.setUint16(34, 16, true); // bits per sample

  // data sub-chunk
  writeString(view, 36, "data");
  view.setUint32(40, numSamples * 2, true);

  // Write PCM samples as 16-bit integers
  let offset = 44;
  for (let i = 0; i < numSamples; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    const val = s < 0 ? s * 0x8000 : s * 0x7fff;
    view.setInt16(offset, val, true);
    offset += 2;
  }

  return buffer;
}

function writeString(view: DataView, offset: number, str: string) {
  for (let i = 0; i < str.length; i++) {
    view.setUint8(offset + i, str.charCodeAt(i));
  }
}

function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const TARGET_SAMPLE_RATE = 16000;
const MIN_DURATION_MS = 500;
const MAX_DURATION_MS = 5 * 60 * 1000; // 5 minutes
const INTERIM_INTERVAL_MS = 3000; // interim transcription every 3 seconds
// Voice activity detection: auto-stop after SILENCE_TIMEOUT_MS of silence
// once the user has started speaking. RMS threshold empirically tuned for
// consumer microphones with typical ambient noise.
const VAD_RMS_THRESHOLD = 0.02;
const SILENCE_TIMEOUT_MS = 3000;

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

export function useVoiceInput(options: UseVoiceInputOptions): VoiceInputState {
  const { onTranscription, onInterimText, onError } = options;

  const [phase, setPhase] = useState<VoiceInputPhase>("idle");
  const [error, setError] = useState<string | null>(null);
  const [durationMs, setDurationMs] = useState(0);
  const [activeStream, setActiveStream] = useState<MediaStream | null>(null);
  const [interimText, setInterimText] = useState("");

  const streamRef = useRef<MediaStream | null>(null);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const chunksRef = useRef<Float32Array[]>([]);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const startTimeRef = useRef<number>(0);
  const processorRef = useRef<ScriptProcessorNode | null>(null);
  const sourceRef = useRef<MediaStreamAudioSourceNode | null>(null);
  const interimTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const interimBusyRef = useRef(false);
  // Latest interim transcription text — snapshot used as fallback if final
  // recognition fails or returns empty (e.g. Apple Speech throttles concurrent
  // requests when interim is still in-flight at stop time).
  const interimTextRef = useRef("");
  // Voice activity detection: track last-speech timestamp (ms) and whether
  // the user has ever spoken this recording. Auto-stop kicks in only after
  // at least one voiced frame, so pressing-and-pausing isn't cut off prematurely.
  const lastVoiceAtRef = useRef<number>(0);
  const hasSpokenRef = useRef(false);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      stopMediaStream();
      clearTimer();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const clearTimer = useCallback(() => {
    if (timerRef.current) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }
    if (interimTimerRef.current) {
      clearInterval(interimTimerRef.current);
      interimTimerRef.current = null;
    }
    interimBusyRef.current = false;
  }, []);

  const stopMediaStream = useCallback(() => {
    if (processorRef.current) {
      processorRef.current.disconnect();
      processorRef.current = null;
    }
    if (sourceRef.current) {
      sourceRef.current.disconnect();
      sourceRef.current = null;
    }
    if (audioCtxRef.current) {
      audioCtxRef.current.close().catch(() => {});
      audioCtxRef.current = null;
    }
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
    }
    setActiveStream(null);
  }, []);

  /** Send accumulated audio for interim transcription (non-blocking). */
  const runInterimTranscription = useCallback(async (actualSampleRate: number) => {
    if (interimBusyRef.current) return; // previous interim still running
    const chunks = chunksRef.current;
    if (chunks.length === 0) return;

    // Snapshot current chunks (don't clear — we need them for final)
    const totalLength = chunks.reduce((acc, c) => acc + c.length, 0);
    if (totalLength < TARGET_SAMPLE_RATE) return; // less than 1s, skip

    const merged = new Float32Array(totalLength);
    let offset = 0;
    for (const chunk of chunks) {
      merged.set(chunk, offset);
      offset += chunk.length;
    }

    let samples = merged;
    if (actualSampleRate !== TARGET_SAMPLE_RATE) {
      samples = resample(merged, actualSampleRate, TARGET_SAMPLE_RATE);
    }

    const wavBuffer = encodeWav(samples, TARGET_SAMPLE_RATE);
    const base64Data = arrayBufferToBase64(wavBuffer);

    interimBusyRef.current = true;
    try {
      const whisperLanguage = useSettingsStore.getState().whisperLanguage;
      const result = await invoke<TranscriptionResult>("transcribe_audio", {
        audioData: base64Data,
        language: whisperLanguage === "auto" ? null : whisperLanguage,
      });
      if (result.text) {
        interimTextRef.current = result.text;
        setInterimText(result.text);
        onInterimText?.(result.text);
      }
    } catch {
      // Interim failure is non-fatal, just skip
    } finally {
      interimBusyRef.current = false;
    }
  }, [onInterimText]);

  const startRecording = useCallback(async () => {
    setPhase("requesting");
    setError(null);
    setDurationMs(0);
    chunksRef.current = [];
    interimTextRef.current = "";
    lastVoiceAtRef.current = 0;
    hasSpokenRef.current = false;

    try {
      if (!navigator.mediaDevices?.getUserMedia) {
        throw new Error(
          "microphone_not_supported"
        );
      }

      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          channelCount: 1,
          echoCancellation: true,
          noiseSuppression: true,
        },
      });
      streamRef.current = stream;
      setActiveStream(stream);

      // Create AudioContext — attempt 16kHz, fall back to device default
      let audioCtx: AudioContext;
      try {
        audioCtx = new AudioContext({ sampleRate: TARGET_SAMPLE_RATE });
      } catch {
        audioCtx = new AudioContext();
      }
      audioCtxRef.current = audioCtx;

      const source = audioCtx.createMediaStreamSource(stream);
      sourceRef.current = source;

      const processor = audioCtx.createScriptProcessor(4096, 1, 1);
      processorRef.current = processor;

      processor.onaudioprocess = (e) => {
        const data = e.inputBuffer.getChannelData(0);
        chunksRef.current.push(new Float32Array(data));
        // RMS-based voice activity detection — updates lastVoiceAt so the
        // duration timer can auto-stop after sustained silence.
        let sumSq = 0;
        for (let i = 0; i < data.length; i++) {
          sumSq += data[i] * data[i];
        }
        const rms = Math.sqrt(sumSq / data.length);
        if (rms > VAD_RMS_THRESHOLD) {
          lastVoiceAtRef.current = Date.now();
          hasSpokenRef.current = true;
        }
      };

      source.connect(processor);
      processor.connect(audioCtx.destination);

      startTimeRef.current = Date.now();
      setPhase("recording");

      // Duration timer
      timerRef.current = setInterval(() => {
        const elapsed = Date.now() - startTimeRef.current;
        setDurationMs(elapsed);

        // Auto-stop at max duration
        if (elapsed >= MAX_DURATION_MS) {
          stopAndProcess();
          return;
        }

        // Auto-stop on sustained silence — only after the user has actually
        // spoken and the recording is past the minimum length, so silent
        // pauses before speaking don't cut the session off.
        if (
          hasSpokenRef.current &&
          elapsed >= MIN_DURATION_MS &&
          Date.now() - lastVoiceAtRef.current >= SILENCE_TIMEOUT_MS
        ) {
          stopAndProcess();
        }
      }, 100);

      // Interim transcription timer — every 3s, transcribe accumulated audio
      setInterimText("");
      interimTimerRef.current = setInterval(() => {
        runInterimTranscription(audioCtx.sampleRate);
      }, INTERIM_INTERVAL_MS);
    } catch (err) {
      const msg =
        err instanceof DOMException && err.name === "NotAllowedError"
          ? "microphone_permission_denied"
          : err instanceof DOMException && err.name === "NotFoundError"
            ? "no_microphone"
            : String(err);
      setPhase("error");
      setError(msg);
      onError?.(msg);
      stopMediaStream();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [onError, stopMediaStream]);

  const stopAndProcess = useCallback(async () => {
    clearTimer();
    const elapsed = Date.now() - startTimeRef.current;
    const actualSampleRate = audioCtxRef.current?.sampleRate ?? TARGET_SAMPLE_RATE;

    stopMediaStream();

    if (elapsed < MIN_DURATION_MS) {
      setPhase("error");
      setError("recording_too_short");
      onError?.("recording_too_short");
      return;
    }

    setPhase("processing");

    // Merge all chunks
    const chunks = chunksRef.current;
    const totalLength = chunks.reduce((acc, c) => acc + c.length, 0);
    const merged = new Float32Array(totalLength);
    let offset = 0;
    for (const chunk of chunks) {
      merged.set(chunk, offset);
      offset += chunk.length;
    }
    chunksRef.current = [];

    // Resample if needed
    let samples = merged;
    if (actualSampleRate !== TARGET_SAMPLE_RATE) {
      samples = resample(merged, actualSampleRate, TARGET_SAMPLE_RATE);
    }

    // Encode to WAV and convert to base64
    const wavBuffer = encodeWav(samples, TARGET_SAMPLE_RATE);
    const base64Data = arrayBufferToBase64(wavBuffer);

    // Wait for any in-flight interim transcription to finish before issuing
    // the final request — running both concurrently causes Apple Speech to
    // throttle one of them (empty or error), which would lose the user's
    // spoken text entirely.
    const interimWaitDeadline = Date.now() + 4000;
    while (interimBusyRef.current && Date.now() < interimWaitDeadline) {
      await new Promise((r) => setTimeout(r, 50));
    }

    const interimFallback = interimTextRef.current;

    try {
      const whisperLanguage = useSettingsStore.getState().whisperLanguage;
      const result = await invoke<TranscriptionResult>("transcribe_audio", {
        audioData: base64Data,
        language: whisperLanguage === "auto" ? null : whisperLanguage,
      });

      setPhase("idle");
      setDurationMs(0);
      setInterimText("");
      interimTextRef.current = "";
      const finalText = result.text?.trim() ? result.text : interimFallback;
      if (finalText) {
        onTranscription(finalText);
      }
    } catch (err) {
      // Final recognition failed — fall back to the last interim text so the
      // user doesn't lose what they already saw on screen.
      if (interimFallback) {
        setPhase("idle");
        setDurationMs(0);
        setInterimText("");
        interimTextRef.current = "";
        onTranscription(interimFallback);
      } else {
        setPhase("error");
        setError(String(err));
        onError?.(String(err));
      }
    }
  }, [clearTimer, stopMediaStream, onTranscription, onError]);

  const cancelRecording = useCallback(() => {
    clearTimer();
    stopMediaStream();
    chunksRef.current = [];
    setPhase("idle");
    setDurationMs(0);
    setError(null);
    setInterimText("");
    interimTextRef.current = "";
    lastVoiceAtRef.current = 0;
    hasSpokenRef.current = false;
  }, [clearTimer, stopMediaStream]);

  const toggleRecording = useCallback(() => {
    if (phase === "recording") {
      stopAndProcess();
    } else if (phase === "idle" || phase === "error") {
      startRecording();
    }
  }, [phase, stopAndProcess, startRecording]);

  return {
    phase,
    error,
    durationMs,
    interimText,
    stream: activeStream,
    toggleRecording,
    cancelRecording,
  };
}

// ---------------------------------------------------------------------------
// Resampler
// ---------------------------------------------------------------------------

function resample(
  samples: Float32Array,
  fromRate: number,
  toRate: number,
): Float32Array {
  if (fromRate === toRate) return samples;
  const ratio = fromRate / toRate;
  const outputLen = Math.round(samples.length / ratio);
  const output = new Float32Array(outputLen);
  for (let i = 0; i < outputLen; i++) {
    const srcPos = i * ratio;
    const idx = Math.floor(srcPos);
    const frac = srcPos - idx;
    const s0 = samples[Math.min(idx, samples.length - 1)];
    const s1 = samples[Math.min(idx + 1, samples.length - 1)];
    output[i] = s0 + (s1 - s0) * frac;
  }
  return output;
}
