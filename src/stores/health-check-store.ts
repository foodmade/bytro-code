// bytro/src/stores/health-check-store.ts
import { create } from "zustand";
import { load, type Store } from "@tauri-apps/plugin-store";
import { useWorkspaceStore } from "./workspace-store";

// ---- Types ----

export type DimensionId =
  | "code-standards"
  | "security"
  | "perf-deps"
  | "tech-debt"
  | "maintainability";

export interface FileRef {
  readonly path: string;
  readonly line?: number;
  readonly codeSnippet?: string | null;
  readonly highlightLines?: ReadonlyArray<number> | null;
  readonly lineStart?: number | null;
}

export interface HealthIssue {
  readonly severity: "critical" | "warning" | "info";
  readonly message: string;
  readonly file: string | null;
  readonly files?: ReadonlyArray<FileRef> | null;
  readonly codeSnippet?: string | null;
  readonly highlightLines?: ReadonlyArray<number> | null;
  readonly lineStart?: number | null;
  readonly suggestion: string;
}

export interface DimensionResult {
  readonly score: number;
  readonly findings: ReadonlyArray<string>;
  readonly issues: ReadonlyArray<HealthIssue>;
}

export interface DimensionState {
  readonly id: DimensionId;
  readonly label: string;
  readonly status: "pending" | "running" | "completed" | "cancelled";
  readonly score: number | null;
  readonly findings: ReadonlyArray<string>;
  readonly issues: ReadonlyArray<HealthIssue>;
  readonly agentId: string | null;
}

export type HealthCheckPhase = "idle" | "scanning" | "completed" | "cancelled";

// ---- Detail page types ----

export type IssueFixStatus = "pending" | "fixing" | "fixed" | "ignored";
export type IssueSeverityFilter = "all" | "critical" | "warning" | "info";
export type HealthCheckTab = "issues" | "history";

export interface EnrichedIssue {
  readonly id: string;
  readonly dimensionId: DimensionId;
  readonly dimensionLabel: string;
  readonly severity: "critical" | "warning" | "info";
  readonly message: string;
  readonly file: string | null;
  readonly files?: ReadonlyArray<FileRef> | null;
  readonly codeSnippet?: string | null;
  readonly highlightLines?: ReadonlyArray<number> | null;
  readonly lineStart?: number | null;
  readonly suggestion: string;
}

export interface PersistedHealthCheckResult {
  readonly id: string;
  readonly workspaceId: string;
  readonly overallScore: number;
  readonly summary: string;
  readonly dimensions: ReadonlyArray<DimensionState>;
  readonly createdAt: string;
}

/** Snapshot of a workspace's health check state (saved when switching away). */
export interface WorkspaceHealthSnapshot {
  readonly phase: HealthCheckPhase;
  readonly dimensions: ReadonlyArray<DimensionState>;
  readonly overallScore: number | null;
  readonly summary: string | null;
  readonly requestId: string | null;
  readonly startTime: number | null;
  readonly endTime: number | null;
}

/** Module-level snapshot map — persists across component mounts. */
export const workspaceSnapshots = new Map<string, WorkspaceHealthSnapshot>();

interface HealthCheckState {
  // State
  readonly phase: HealthCheckPhase;
  readonly dimensions: ReadonlyArray<DimensionState>;
  readonly overallScore: number | null;
  readonly summary: string | null;
  readonly requestId: string | null;
  readonly startTime: number | null;
  readonly endTime: number | null;
  readonly lastResult: PersistedHealthCheckResult | null;
  readonly currentWorkspaceId: string | null;

  // Detail page state
  readonly selectedIssueIds: ReadonlySet<string>;
  readonly issueFixStatuses: Readonly<Record<string, IssueFixStatus>>;
  readonly fixConversationMap: Readonly<Record<string, string>>; // issueId → conversationId
  readonly activeIssueId: string | null;
  readonly severityFilter: IssueSeverityFilter;
  readonly searchQuery: string;
  readonly activeTab: HealthCheckTab;
  readonly historyResults: ReadonlyArray<PersistedHealthCheckResult>;

  // Actions
  readonly start: (requestId: string) => void;
  readonly matchSubagentStarted: (agentId: string, description: string) => void;
  readonly matchSubagentCompleted: (agentId: string, result: string) => void;
  readonly completeFromFullText: (fullText: string) => void;
  readonly cancel: () => void;
  readonly reset: () => void;
  readonly setLastResult: (result: PersistedHealthCheckResult | null) => void;
  readonly switchWorkspace: (newWorkspaceId: string | null) => void;

  // Detail page actions
  readonly toggleIssueSelection: (issueId: string) => void;
  readonly selectAllIssues: (issueIds: ReadonlyArray<string>) => void;
  readonly clearSelection: () => void;
  readonly setIssueFixStatus: (issueId: string, status: IssueFixStatus) => void;
  readonly setBatchFixStatus: (issueIds: ReadonlyArray<string>, status: IssueFixStatus) => void;
  readonly linkFixConversation: (issueId: string, conversationId: string) => void;
  readonly clearFixConversation: (issueId: string) => void;
  readonly setActiveIssueId: (issueId: string | null) => void;
  readonly setSeverityFilter: (filter: IssueSeverityFilter) => void;
  readonly setSearchQuery: (query: string) => void;
  readonly setActiveTab: (tab: HealthCheckTab) => void;
  readonly setHistoryResults: (results: ReadonlyArray<PersistedHealthCheckResult>) => void;
}

// ---- Constants ----

const INITIAL_DIMENSIONS: ReadonlyArray<DimensionState> = [
  { id: "code-standards", label: "代码规范", status: "pending", score: null, findings: [], issues: [], agentId: null },
  { id: "security", label: "安全性", status: "pending", score: null, findings: [], issues: [], agentId: null },
  { id: "perf-deps", label: "性能与依赖", status: "pending", score: null, findings: [], issues: [], agentId: null },
  { id: "tech-debt", label: "技术债务", status: "pending", score: null, findings: [], issues: [], agentId: null },
  { id: "maintainability", label: "可维护性", status: "pending", score: null, findings: [], issues: [], agentId: null },
];

const DIMENSION_KEYWORDS: Record<DimensionId, ReadonlyArray<string>> = {
  "code-standards": ["代码规范", "code standard", "lint", "代码风格"],
  "security": ["安全", "security", "漏洞", "vulnerability"],
  "perf-deps": ["性能", "依赖", "performance", "dependency", "bundle"],
  "tech-debt": ["技术债", "tech debt", "死代码", "dead code", "TODO"],
  "maintainability": ["可维护", "maintainab", "耦合", "复杂度", "complexity"],
};

// ---- Helpers ----

export function matchDimension(description: string): DimensionId | null {
  const lower = description.toLowerCase();
  for (const [id, keywords] of Object.entries(DIMENSION_KEYWORDS)) {
    if (keywords.some((kw) => lower.includes(kw.toLowerCase()))) {
      return id as DimensionId;
    }
  }
  return null;
}

export function parseDimensionResult(result: string): DimensionResult | null {
  // The Task tool wraps agent output in a JSON structure like:
  //   [{"type":"text","text":"...\n```\n{\"score\":75,...}\n```"}],"totalDurationMs":...
  // Two challenges:
  //   1. Inner quotes/newlines are JSON-escaped (\" and \n)
  //   2. Agent may pretty-print JSON and/or wrap it in markdown code blocks

  // Strategy 1: Extract agent text from JSON wrapper, then search
  const agentText = extractAgentText(result);
  if (agentText) {
    const found = findScoreJsonInText(agentText);
    if (found) return found;
  }

  // Strategy 2: Direct search in raw result (in case it's raw text)
  const direct = findScoreJsonInText(result);
  if (direct) return direct;

  // Strategy 3: Brute-force unescape and search
  if (result.includes('\\"score')) {
    const unescaped = result.replace(/\\"/g, '"').replace(/\\n/g, "\n");
    const unescapedResult = findScoreJsonInText(unescaped);
    if (unescapedResult) return unescapedResult;
  }

  // Strategy 4: Fallback — extract score from narrative/markdown text.
  // If the sub-agent ignored JSON output rules and wrote a markdown report,
  // try to salvage a score from patterns like "Score: 75" or "评分：75/100".
  return extractScoreFromNarrative(agentText ?? result);
}

/**
 * Fallback: extract a score from narrative/markdown text when JSON parsing fails.
 * Looks for patterns like "Score: 75", "评分：75/100", "Overall Score: 80" etc.
 * Returns a minimal DimensionResult with score and any extractable findings.
 */
function extractScoreFromNarrative(text: string): DimensionResult | null {
  // Common patterns for scores in narrative text
  const scorePatterns = [
    /(?:overall\s+)?score\s*[:：]\s*(\d{1,3})\s*(?:\/\s*100)?/i,
    /(?:综合)?评分\s*[:：]\s*(\d{1,3})\s*(?:\/\s*100|分)?/i,
    /(?:总分|得分)\s*[:：]\s*(\d{1,3})\s*(?:\/\s*100|分)?/i,
    /(\d{1,3})\s*(?:\/\s*100|out\s+of\s+100)/i,
  ];

  let score: number | null = null;
  for (const pattern of scorePatterns) {
    const m = pattern.exec(text);
    if (m) {
      const val = parseInt(m[1], 10);
      if (val >= 0 && val <= 100) {
        score = val;
        break;
      }
    }
  }
  if (score === null) return null;

  // Try to extract findings from markdown headings or bullet points
  const bulletPattern = /^[-*•]\s+(.{5,80})$/gm;
  let bulletMatch: RegExpExecArray | null;
  const findings: string[] = [];
  while ((bulletMatch = bulletPattern.exec(text)) !== null && findings.length < 5) {
    const line = bulletMatch[1].trim();
    // Skip lines that look like metadata or code
    if (line.startsWith("http") || line.startsWith("```") || line.includes("=")) continue;
    findings.push(line.length > 50 ? line.slice(0, 47) + "..." : line);
  }

  return { score, findings, issues: [] };
}

/**
 * Extract agent text from the Task tool JSON wrapper.
 * The wrapper has a "text":"<escaped-content>" field — we use JSON.parse
 * to properly unescape it (handles \", \n, \\ etc. correctly).
 */
function extractAgentText(result: string): string | null {
  const marker = '"text":"';
  const idx = result.indexOf(marker);
  if (idx === -1) return null;

  const start = idx + marker.length;
  let escaped = false;
  for (let i = start; i < result.length; i++) {
    if (escaped) { escaped = false; continue; }
    if (result[i] === "\\") { escaped = true; continue; }
    if (result[i] === '"') {
      // Found the closing quote of the "text" value
      const raw = result.substring(start, i);
      try {
        return JSON.parse('"' + raw + '"');
      } catch {
        return null;
      }
    }
  }
  return null;
}

/** Placeholder values from the prompt template — skip these during parsing. */
const TEMPLATE_FINDINGS = new Set([
  "发现1", "发现2", "实际发现的问题1", "实际发现的问题2",
]);

function isTemplateResult(parsed: { findings: string[] }): boolean {
  return parsed.findings.length > 0 && parsed.findings.every((f) => TEMPLATE_FINDINGS.has(f));
}

/**
 * Search text for a JSON object with "score" + "findings" fields.
 * Handles both compact ({"score":75,...}) and pretty-printed ({ \n "score": 75, ... }).
 */
function findScoreJsonInText(text: string): DimensionResult | null {
  const pattern = /\{\s*"score"/g;
  const positions: number[] = [];
  let m: RegExpExecArray | null;
  while ((m = pattern.exec(text)) !== null) {
    positions.push(m.index);
  }

  // Try from last to first (prefer the actual result over template examples)
  for (let i = positions.length - 1; i >= 0; i--) {
    const jsonStr = extractBalancedBraces(text, positions[i]);
    if (!jsonStr) continue;

    try {
      const parsed = JSON.parse(jsonStr);
      if (typeof parsed.score === "number" && Array.isArray(parsed.findings)) {
        if (isTemplateResult(parsed)) continue;
        return {
          score: parsed.score,
          findings: parsed.findings,
          issues: Array.isArray(parsed.issues) ? parsed.issues : [],
        };
      }
    } catch {
      /* this match didn't work, keep searching */
    }
  }
  return null;
}

/** Extract a balanced JSON object starting at `start` (which must be `{`). */
function extractBalancedBraces(text: string, start: number): string | null {
  let depth = 0;
  let inString = false;
  let escape = false;

  for (let i = start; i < text.length; i++) {
    const ch = text[i];

    if (escape) { escape = false; continue; }
    if (ch === "\\") { escape = true; continue; }
    if (ch === '"') { inString = !inString; continue; }
    if (inString) continue;

    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return text.substring(start, i + 1);
    }
  }
  return null;
}

interface OverallResult {
  readonly overallScore: number;
  readonly summary: string;
  readonly dimensionScores: Partial<Record<DimensionId, number>> | null;
}

export function parseOverallResult(fullText: string): OverallResult | null {
  // Search for JSON containing "overallScore" anywhere in the text.
  // The orchestrator may emit the JSON on the same line as preceding text
  // (no newline separator), so we can't rely on line.startsWith("{").
  const pattern = /\{\s*"overallScore"/g;
  const positions: number[] = [];
  let m: RegExpExecArray | null;
  while ((m = pattern.exec(fullText)) !== null) {
    positions.push(m.index);
  }

  // Try from last to first (prefer the final output)
  for (let i = positions.length - 1; i >= 0; i--) {
    const jsonStr = extractBalancedBraces(fullText, positions[i]);
    if (!jsonStr) continue;
    try {
      const parsed = JSON.parse(jsonStr);
      if (typeof parsed.overallScore === "number") {
        let dimensionScores: Partial<Record<DimensionId, number>> | null = null;
        if (parsed.dimensions && typeof parsed.dimensions === "object") {
          dimensionScores = {};
          for (const key of Object.keys(parsed.dimensions)) {
            const score = parsed.dimensions[key];
            if (typeof score === "number" && INITIAL_DIMENSIONS.some((d) => d.id === key)) {
              dimensionScores[key as DimensionId] = score;
            }
          }
        }
        return {
          overallScore: parsed.overallScore,
          summary: typeof parsed.summary === "string" ? parsed.summary : "",
          dimensionScores,
        };
      }
    } catch {
      /* continue searching */
    }
  }
  return null;
}

/** Flatten all dimension issues into an enriched array with stable IDs. */
export function flattenIssues(dimensions: ReadonlyArray<DimensionState>): ReadonlyArray<EnrichedIssue> {
  const result: EnrichedIssue[] = [];
  for (const dim of dimensions) {
    for (let i = 0; i < dim.issues.length; i++) {
      const issue = dim.issues[i];
      result.push({
        id: `${dim.id}-${i}`,
        dimensionId: dim.id,
        dimensionLabel: dim.label,
        severity: issue.severity,
        message: issue.message,
        file: issue.file,
        files: issue.files,
        codeSnippet: issue.codeSnippet,
        highlightLines: issue.highlightLines,
        lineStart: issue.lineStart,
        suggestion: issue.suggestion,
      });
    }
  }
  return result;
}

// ---- Store ----

export const useHealthCheckStore = create<HealthCheckState>((set, get) => ({
  phase: "idle",
  dimensions: INITIAL_DIMENSIONS,
  overallScore: null,
  summary: null,
  requestId: null,
  startTime: null,
  endTime: null,
  lastResult: null,
  currentWorkspaceId: null,

  // Detail page initial state
  selectedIssueIds: new Set<string>(),
  issueFixStatuses: {},
  fixConversationMap: {},
  activeIssueId: null,
  severityFilter: "all",
  searchQuery: "",
  activeTab: "issues",
  historyResults: [],

  start: (requestId) => {
    set({
      phase: "scanning",
      dimensions: INITIAL_DIMENSIONS,
      overallScore: null,
      summary: null,
      requestId,
      startTime: Date.now(),
      endTime: null,
    });
  },

  matchSubagentStarted: (agentId, description) => {
    const dimId = matchDimension(description);
    if (!dimId) return;

    set({
      dimensions: get().dimensions.map((d) =>
        d.id === dimId ? { ...d, status: "running" as const, agentId } : d,
      ),
    });
  },

  matchSubagentCompleted: (agentId, result) => {
    const dims = get().dimensions;

    // Parse result — try JSON first, then fallback to narrative extraction
    const parsed = parseDimensionResult(result);
    if (!parsed) {
      console.warn("[health-check] parseDimensionResult returned null, len:", result.length);
      return;
    }

    // Strategy 1: match by agentId (works when SubagentCompleted carries agent_id)
    let targetDim = dims.find((d) => d.agentId === agentId);

    // Strategy 2: match by result content keywords
    // SubagentCompleted carries tool_use_id (not agent_id), so Strategy 1
    // usually fails. Fall back to keyword matching against the result text.
    if (!targetDim) {
      const dimId = matchDimension(result);
      if (dimId) {
        targetDim = dims.find(
          (d) => d.id === dimId && (d.status === "running" || d.status === "pending"),
        );
      }
    }

    // Strategy 3: last resort — first running dimension
    if (!targetDim) {
      targetDim = dims.find((d) => d.status === "running");
    }

    if (!targetDim) return;

    set({
      dimensions: dims.map((d) =>
        d.id === targetDim!.id
          ? {
              ...d,
              status: "completed" as const,
              score: parsed.score,
              findings: parsed.findings,
              issues: parsed.issues,
            }
          : d,
      ),
    });
  },

  completeFromFullText: (fullText) => {
    if (!fullText.trim()) {
      const anyDimensionCompleted = get().dimensions.some((d) => d.score !== null);
      if (!anyDimensionCompleted) {
        console.warn("[health-check] empty response with no completed dimensions — treating as failure");
        get().cancel();
        return;
      }
    }

    const result = parseOverallResult(fullText);
    const currentDims = get().dimensions;

    // Backfill dimension scores from orchestrator output for any dimensions
    // that SubagentCompleted events failed to populate (e.g. due to truncation).
    // Dimensions already populated by matchSubagentCompleted keep their
    // findings/issues; only missing scores get backfilled.
    const updatedDims = currentDims.map((d) => {
      if (d.score !== null) {
        // Already populated by matchSubagentCompleted — preserve findings/issues
        return d.status !== "completed" ? { ...d, status: "completed" as const } : d;
      }
      const backfillScore = result?.dimensionScores?.[d.id];
      return backfillScore != null
        ? { ...d, status: "completed" as const, score: backfillScore }
        : { ...d, status: "completed" as const };
    });

    set({
      phase: "completed",
      overallScore: result?.overallScore ?? null,
      summary: result?.summary ?? null,
      dimensions: updatedDims,
      endTime: Date.now(),
    });
  },

  cancel: () => {
    set({
      phase: "cancelled",
      endTime: Date.now(),
      dimensions: get().dimensions.map((d) =>
        d.status === "pending" || d.status === "running"
          ? { ...d, status: "cancelled" as const }
          : d,
      ),
    });
  },

  reset: () => {
    set({
      phase: "idle",
      dimensions: INITIAL_DIMENSIONS,
      overallScore: null,
      summary: null,
      requestId: null,
      startTime: null,
      endTime: null,
    });
  },

  setLastResult: (result) => {
    set({ lastResult: result });
  },

  switchWorkspace: (newWorkspaceId) => {
    const state = get();
    const prevId = state.currentWorkspaceId;

    if (prevId === newWorkspaceId) return;

    // Save current live state for the previous workspace (if not idle)
    if (prevId != null && state.phase !== "idle") {
      workspaceSnapshots.set(prevId, {
        phase: state.phase,
        dimensions: state.dimensions,
        overallScore: state.overallScore,
        summary: state.summary,
        requestId: state.requestId,
        startTime: state.startTime,
        endTime: state.endTime,
      });
    } else if (prevId != null) {
      workspaceSnapshots.delete(prevId);
    }

    // Restore snapshot for new workspace, or reset to idle
    const snap = newWorkspaceId ? workspaceSnapshots.get(newWorkspaceId) : null;
    if (snap) {
      workspaceSnapshots.delete(newWorkspaceId!);
      set({
        phase: snap.phase,
        dimensions: snap.dimensions,
        overallScore: snap.overallScore,
        summary: snap.summary,
        requestId: snap.requestId,
        startTime: snap.startTime,
        endTime: snap.endTime,
        lastResult: null,
        currentWorkspaceId: newWorkspaceId,
      });
    } else {
      set({
        phase: "idle",
        dimensions: INITIAL_DIMENSIONS,
        overallScore: null,
        summary: null,
        requestId: null,
        startTime: null,
        endTime: null,
        lastResult: null,
        currentWorkspaceId: newWorkspaceId,
      });
    }
  },

  // Detail page actions
  toggleIssueSelection: (issueId) => {
    const current = get().selectedIssueIds;
    const next = new Set(current);
    if (next.has(issueId)) {
      next.delete(issueId);
    } else {
      next.add(issueId);
    }
    set({ selectedIssueIds: next });
  },

  selectAllIssues: (issueIds) => {
    set({ selectedIssueIds: new Set(issueIds) });
  },

  clearSelection: () => {
    set({ selectedIssueIds: new Set<string>() });
  },

  setIssueFixStatus: (issueId, status) => {
    const newStatuses = { ...get().issueFixStatuses, [issueId]: status };
    set({ issueFixStatuses: newStatuses });
    const wsId = useWorkspaceStore.getState().activeWorkspaceId;
    if (wsId) persistIgnoredIssues(wsId, newStatuses);
  },

  setBatchFixStatus: (issueIds, status) => {
    const current = { ...get().issueFixStatuses };
    for (const id of issueIds) {
      current[id] = status;
    }
    set({ issueFixStatuses: current });
    const wsId = useWorkspaceStore.getState().activeWorkspaceId;
    if (wsId) persistIgnoredIssues(wsId, current);
  },

  linkFixConversation: (issueId, conversationId) => {
    set({ fixConversationMap: { ...get().fixConversationMap, [issueId]: conversationId } });
  },

  clearFixConversation: (issueId) => {
    const current = { ...get().fixConversationMap };
    delete current[issueId];
    set({ fixConversationMap: current });
  },

  setActiveIssueId: (issueId) => {
    set({ activeIssueId: issueId });
  },

  setSeverityFilter: (filter) => {
    set({ severityFilter: filter });
  },

  setSearchQuery: (query) => {
    set({ searchQuery: query });
  },

  setActiveTab: (tab) => {
    set({ activeTab: tab });
  },

  setHistoryResults: (results) => {
    set({ historyResults: results });
  },
}));

// ---- Ignored issues persistence (Tauri plugin-store) ----

let ignoredStore: Store | null = null;

async function getIgnoredStore(): Promise<Store> {
  if (!ignoredStore) {
    ignoredStore = await load("health-ignored.json", { defaults: {}, autoSave: true });
  }
  return ignoredStore;
}

/** Persist ignored issue IDs for a workspace (fire-and-forget). */
async function persistIgnoredIssues(
  workspaceId: string,
  statuses: Readonly<Record<string, IssueFixStatus>>,
): Promise<void> {
  const ignoredIds = Object.entries(statuses)
    .filter(([, s]) => s === "ignored")
    .map(([id]) => id);
  try {
    const store = await getIgnoredStore();
    await store.set(workspaceId, ignoredIds);
  } catch {
    // Best-effort persistence
  }
}

/** Load persisted ignored issue IDs and merge into the store. */
export async function loadPersistedIgnoredIssues(workspaceId: string): Promise<void> {
  try {
    const store = await getIgnoredStore();
    const ids = await store.get<string[]>(workspaceId);
    if (ids && ids.length > 0) {
      const current = { ...useHealthCheckStore.getState().issueFixStatuses };
      for (const id of ids) {
        if (!current[id]) {
          current[id] = "ignored";
        }
      }
      useHealthCheckStore.setState({ issueFixStatuses: current });
    }
  } catch {
    // Best-effort load
  }
}
