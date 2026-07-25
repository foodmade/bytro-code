export const RETIRED_GPT_FALLBACK_MODEL = "gpt-5.6-sol";

const RETIRED_GPT_MODEL_PATTERN = /^gpt-5\.(?:1|2)(?:$|[-.])/i;

export function getUnqualifiedModelId(modelId: string): string {
  const colonIndex = modelId.lastIndexOf(":");
  const unscoped = colonIndex >= 0 ? modelId.slice(colonIndex + 1) : modelId;
  const slashIndex = unscoped.lastIndexOf("/");
  return slashIndex >= 0 ? unscoped.slice(slashIndex + 1) : unscoped;
}

export function isRetiredGptModel(modelId: string | null | undefined): boolean {
  return (
    typeof modelId === "string" &&
    RETIRED_GPT_MODEL_PATTERN.test(getUnqualifiedModelId(modelId.trim()))
  );
}

export function normalizeRetiredGptModelId(modelId: string): string {
  return isRetiredGptModel(modelId) ? RETIRED_GPT_FALLBACK_MODEL : modelId;
}

export function filterRetiredGptModels<T extends { readonly id: string }>(
  models: readonly T[],
): readonly T[] {
  const filtered = models.filter((model) => !isRetiredGptModel(model.id));
  return filtered.length === models.length ? models : filtered;
}

export function findGptRetirementFallback<T extends { readonly id: string }>(
  models: readonly T[],
): T | undefined {
  return (
    models.find((model) => getUnqualifiedModelId(model.id) === RETIRED_GPT_FALLBACK_MODEL) ??
    models[0]
  );
}

export function findAvailableGptRetirementFallback<
  T extends { readonly id: string; readonly allowTrial: boolean },
>(models: readonly T[], buy: boolean): T | undefined {
  return findGptRetirementFallback(
    filterRetiredGptModels(models.filter((model) => model.allowTrial || buy)),
  );
}
