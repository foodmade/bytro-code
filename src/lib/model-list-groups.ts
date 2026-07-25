type TieredModel = {
  readonly id: string;
  readonly tier: string;
};

export type ModelListGroup<T extends TieredModel> = {
  readonly category: string;
  readonly items: readonly T[];
};

const CODEX_5_6_ORDER = new Map<string, number>([
  ["gpt-5.6-sol", 0],
  ["gpt-5.6-terra", 1],
  ["gpt-5.6-luna", 2],
]);

function codex56Rank(modelId: string): number | undefined {
  const normalizedModel = modelId.includes("/")
    ? modelId.slice(modelId.lastIndexOf("/") + 1)
    : modelId;
  return CODEX_5_6_ORDER.get(normalizedModel);
}

/** Group a picker model list while keeping selected model families together. */
export function groupModelsForPicker<T extends TieredModel>(
  models: readonly T[],
  options: {
    readonly pinCodex56?: boolean;
    readonly prioritizeFable?: boolean;
  } = {},
): readonly ModelListGroup<T>[] {
  const pinned: T[] = [];
  const remaining: T[] = [];

  for (const model of models) {
    if (options.pinCodex56 && codex56Rank(model.id) !== undefined) {
      pinned.push(model);
    } else {
      remaining.push(model);
    }
  }

  pinned.sort((a, b) => (codex56Rank(a.id) ?? 0) - (codex56Rank(b.id) ?? 0));

  const tierMap = new Map<string, T[]>();
  for (const model of remaining) {
    const existing = tierMap.get(model.tier);
    if (existing) {
      existing.push(model);
    } else {
      tierMap.set(model.tier, [model]);
    }
  }

  const tierGroups = Array.from(tierMap.entries());
  if (options.prioritizeFable) {
    tierGroups.sort(([a], [b]) => (a === "fable" ? -1 : 0) - (b === "fable" ? -1 : 0));
  }

  const groups: ModelListGroup<T>[] = tierGroups.map(([category, items]) => ({
    category,
    items,
  }));

  if (pinned.length > 0) {
    groups.unshift({ category: "GPT-5.6", items: pinned });
  }

  return groups;
}
