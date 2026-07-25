import { useCallback, useEffect, useRef, useState } from "react";

// ---------------------------------------------------------------------------
// useAudioVisualizer — provides real-time frequency data from a MediaStream
// Uses Web Audio API AnalyserNode for waveform visualization.
//
// Rendering bypasses React: the hook exposes a `registerBar(i, el)` callback
// so the VoiceWaveform component registers each bar's DOM node once; every
// RAF tick then writes `element.style.setProperty("--h", value)` directly
// and CSS `transform: scaleY(var(--h))` animates it on the GPU compositor.
//
// Visual model (Siri-style organic flow):
//   • 20 half-side frequency groups mirrored into 40 bars (centre → edges)
//   • EMA (α = 0.35) smooths raw FFT energy across frames
//   • Idle breathing baseline keeps waveform alive when the mic is silent
// ---------------------------------------------------------------------------

const BAR_COUNT = 40;
const HALF_COUNT = BAR_COUNT / 2; // 20 mirrored groups
const FFT_SIZE = 128; // 64 frequency bins
const USE_BINS = 32; // focus on human-voice band (~0-6kHz @ 48kHz sr)
const BINS_PER_GROUP = USE_BINS / HALF_COUNT; // 1.6

const EMA_ALPHA = 0.35;
const PEAK_WEIGHT = 0.7;
const MEAN_WEIGHT = 1 - PEAK_WEIGHT;

// Idle breathing baseline (bar still moves gently when silent).
const BREATH_BASE = 0.08;
const BREATH_AMP = 0.04;
const BREATH_PERIOD_MS = 1600;
const BREATH_PHASE_OFFSET = 0.35; // rad per bar — avoids unison breathing

export interface AudioVisualizerState {
  /** Whether the visualizer is actively running. */
  readonly active: boolean;
  /** Register / unregister a bar DOM element at its logical index. */
  readonly registerBar: (index: number, el: HTMLElement | null) => void;
}

export function useAudioVisualizer(
  stream: MediaStream | null,
): AudioVisualizerState {
  const [active, setActive] = useState(false);

  const analyserRef = useRef<AnalyserNode | null>(null);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const sourceRef = useRef<MediaStreamAudioSourceNode | null>(null);
  const rafRef = useRef<number>(0);
  const dataArrayRef = useRef<Uint8Array | null>(null);

  // Half-side EMA-smoothed amplitudes (0..1), length 20.
  const barsRef = useRef<Float32Array>(new Float32Array(HALF_COUNT));
  // DOM element slots, indexed [0..39].
  const elementsRef = useRef<(HTMLElement | null)[]>(
    new Array<HTMLElement | null>(BAR_COUNT).fill(null),
  );

  const registerBar = useCallback(
    (index: number, el: HTMLElement | null) => {
      if (index < 0 || index >= BAR_COUNT) return;
      elementsRef.current[index] = el;
    },
    [],
  );

  const cleanup = useCallback(() => {
    if (rafRef.current) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = 0;
    }
    if (sourceRef.current) {
      sourceRef.current.disconnect();
      sourceRef.current = null;
    }
    if (analyserRef.current) {
      analyserRef.current.disconnect();
      analyserRef.current = null;
    }
    if (audioCtxRef.current) {
      audioCtxRef.current.close().catch(() => {});
      audioCtxRef.current = null;
    }
    dataArrayRef.current = null;
    barsRef.current.fill(0);
    // Reset live DOM so bars transition back to the idle baseline.
    for (let j = 0; j < BAR_COUNT; j++) {
      const el = elementsRef.current[j];
      if (el) el.style.setProperty("--h", "0");
    }
    setActive(false);
  }, []);

  useEffect(() => {
    if (!stream) {
      cleanup();
      return;
    }

    const audioCtx = new AudioContext();
    audioCtxRef.current = audioCtx;

    const analyser = audioCtx.createAnalyser();
    analyser.fftSize = FFT_SIZE;
    analyser.smoothingTimeConstant = 0.7;
    analyserRef.current = analyser;

    const source = audioCtx.createMediaStreamSource(stream);
    source.connect(analyser);
    sourceRef.current = source;

    const bufferLength = analyser.frequencyBinCount; // 64
    const dataArray = new Uint8Array(bufferLength);
    dataArrayRef.current = dataArray;

    setActive(true);

    function tick() {
      const analyserNode = analyserRef.current;
      const data = dataArrayRef.current;
      if (!analyserNode || !data) return;

      analyserNode.getByteFrequencyData(data);

      const bars = barsRef.current;
      const now = performance.now();

      // 1. Collapse FFT bins into 20 half-side groups with peak-biased energy.
      for (let i = 0; i < HALF_COUNT; i++) {
        const start = Math.floor(i * BINS_PER_GROUP);
        const rawEnd = Math.floor((i + 1) * BINS_PER_GROUP);
        const end = Math.min(USE_BINS, Math.max(start + 1, rawEnd));
        let peak = 0;
        let sum = 0;
        let count = 0;
        for (let k = start; k < end; k++) {
          const v = data[k];
          if (v > peak) peak = v;
          sum += v;
          count++;
        }
        const mean = count > 0 ? sum / count : 0;
        const raw = (peak * PEAK_WEIGHT + mean * MEAN_WEIGHT) / 255;
        bars[i] = bars[i] * (1 - EMA_ALPHA) + raw * EMA_ALPHA;
      }

      // 2. Mirror-write to 40 DOM bars:
      //    j=0 → group 19 (edge), j=19/20 → group 0 (centre), j=39 → group 19
      const centre = (BAR_COUNT - 1) / 2; // 19.5
      const breathFreq = now / BREATH_PERIOD_MS;
      for (let j = 0; j < BAR_COUNT; j++) {
        const groupIdx = Math.min(
          HALF_COUNT - 1,
          Math.floor(Math.abs(j - centre)),
        );
        const ema = bars[groupIdx];
        const breath =
          BREATH_BASE + BREATH_AMP * Math.sin(breathFreq + j * BREATH_PHASE_OFFSET);
        const display = ema > breath ? ema : breath;
        const el = elementsRef.current[j];
        if (el) el.style.setProperty("--h", display.toFixed(3));
      }

      rafRef.current = requestAnimationFrame(tick);
    }

    rafRef.current = requestAnimationFrame(tick);

    return cleanup;
  }, [stream, cleanup]);

  return { active, registerBar };
}
