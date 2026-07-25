import { supportsCodexMaxReasoning } from "@/lib/platform-config";
import type { ReasoningLevel } from "@/stores/settings-store";

interface PeakReasoningVisualOptions {
  readonly sdk: string | null | undefined;
  readonly modelId: string;
  readonly reasoningLevel: ReasoningLevel;
  readonly ultracodeEnabled: boolean;
}

/** Whether the resolved model is in its peak-performance visual state. */
export function isPeakReasoningVisualActive({
  sdk,
  modelId,
  reasoningLevel,
  ultracodeEnabled,
}: PeakReasoningVisualOptions): boolean {
  if (sdk === "claude") return ultracodeEnabled;
  return sdk === "codex" && reasoningLevel === "max" && supportsCodexMaxReasoning(modelId);
}
