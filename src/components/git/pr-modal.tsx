import { useState, useEffect, useCallback, useMemo } from "react";
import { useTranslation } from "react-i18next";
import {
  GitPullRequest,
  GitMerge,
  X,
  RefreshCw,
  Plus,
  ExternalLink,
  CheckCircle2,
  XCircle,
  Clock,
  Loader2,
  AlertTriangle,
  ArrowLeft,
  GitBranch,
  Sparkles,
  Info,
} from "lucide-react";
import { invoke } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";
import { resolveOneShotAiTarget, generateOneShotViaSidecar } from "@/lib/ai-one-shot";
import { isGitAuthFailure } from "@/lib/git-clone-auth";
import type { GitFileStatus } from "@/stores/git-store";
import {
  usePrStore,
  type PrSummary,
  type PrDetail,
  type PrChecksResult,
  type PrCheck,
  type PrListState,
  type MergeMethod,
} from "@/stores/pr-store";
import { useGitStore, buildGitTokensMap } from "@/stores/git-store";
import { useToastStore } from "@/stores/toast-store";
import { formatError } from "@/lib/format-error";

// ── AI PR description generation ─────────────────────────────────────

// Keep in sync with PR_SYSTEM_PROMPT_TEMPLATE in src-tauri/src/anthropic.rs
// (the API-key path uses the Rust copy).
const PR_SYSTEM_PROMPT_TEMPLATE = `You are a pull request description generator. Based on the branch commits and code changes provided, write a pull request title and description.

Rules:
- First line: the PR title — concise, under 80 characters, may use a conventional-commit prefix (feat/fix/refactor/...)
- Then one blank line, then the description body in Markdown
- The body: a short summary paragraph, then a bullet list of the key changes
- Write the title and body in {language}
- Reply with ONLY the title and description, no extra commentary, no markdown fences`;

const PR_AI_LANG_KEY = "pr-ai-language";
type PrAiLanguage = "zh" | "en";

function getStoredAiLanguage(): PrAiLanguage {
  try {
    return window.localStorage.getItem(PR_AI_LANG_KEY) === "en" ? "en" : "zh";
  } catch {
    return "zh";
  }
}

interface BranchDiffFile {
  readonly path: string;
  readonly additions: number;
  readonly deletions: number;
}

interface GitBranchSummary {
  readonly head_branch: string;
  readonly base_branch: string;
  readonly commits: ReadonlyArray<string>;
  readonly files: ReadonlyArray<BranchDiffFile>;
  readonly total_additions: number;
  readonly total_deletions: number;
  readonly patch_excerpt: string;
  readonly uncommitted_files: ReadonlyArray<BranchDiffFile>;
  readonly uncommitted_additions: number;
  readonly uncommitted_deletions: number;
  readonly uncommitted_patch_excerpt: string;
}

function formatFileStats(files: ReadonlyArray<BranchDiffFile>): string {
  return files.map((f) => `${f.path} (+${f.additions} -${f.deletions})`).join("\n");
}

/** Uncommitted working-tree changes are the user's intended PR content when
 *  present (they usually haven't branched/committed yet) — make them the
 *  primary generation material and demote branch commits to context.
 *  Only a clean working tree falls back to the committed branch diff. */
function buildBranchSummaryContent(summary: GitBranchSummary): string {
  const commits = summary.commits.map((c) => `- ${c}`).join("\n");

  if (summary.uncommitted_files.length > 0) {
    return [
      `Branch: ${summary.head_branch} → ${summary.base_branch}`,
      `\nUncommitted working-tree changes — this is the intended content of the PR, describe THESE changes (+${summary.uncommitted_additions} -${summary.uncommitted_deletions}):\n${formatFileStats(summary.uncommitted_files)}`,
      summary.uncommitted_patch_excerpt
        ? `\nDiff of the uncommitted changes:\n${summary.uncommitted_patch_excerpt}`
        : "",
      commits
        ? `\nFor context only — commits already on this branch (do NOT describe these):\n${commits}`
        : "",
    ].join("\n");
  }

  return [
    `Branch: ${summary.head_branch} → ${summary.base_branch}`,
    `\nCommits:\n${commits}`,
    `\nChanged files (+${summary.total_additions} -${summary.total_deletions}):\n${formatFileStats(summary.files)}`,
    summary.patch_excerpt ? `\nDiff excerpt:\n${summary.patch_excerpt}` : "",
  ].join("\n");
}

/** First line → title (markdown heading markers stripped), rest → body. */
function parseGeneratedPr(text: string): { title: string; body: string } {
  const trimmed = text.trim();
  const newlineIdx = trimmed.indexOf("\n");
  if (newlineIdx === -1) {
    return { title: trimmed.replace(/^#+\s*/, ""), body: "" };
  }
  return {
    title: trimmed.slice(0, newlineIdx).trim().replace(/^#+\s*/, ""),
    body: trimmed.slice(newlineIdx + 1).trim(),
  };
}

// ── Helpers ──────────────────────────────────────────────────────────

function formatRelativeTime(iso: string): string {
  const ts = Date.parse(iso);
  if (Number.isNaN(ts)) return "";
  const diff = Date.now() / 1000 - ts / 1000;
  if (diff < 60) return "<1m";
  if (diff < 3600) return `${Math.floor(diff / 60)}m`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h`;
  if (diff < 604800) return `${Math.floor(diff / 86400)}d`;
  if (diff < 2592000) return `${Math.floor(diff / 604800)}w`;
  return `${Math.floor(diff / 2592000)}mo`;
}

function stateColor(state: PrSummary["state"], isDraft: boolean): string {
  if (isDraft) return "var(--color-muted)";
  if (state === "open") return "#22C55E";
  if (state === "merged") return "#A855F7";
  return "#EF4444";
}

// ── CI status indicators ─────────────────────────────────────────────

function ChecksIcon({ overall, size = 13 }: { readonly overall: PrChecksResult["overall"]; readonly size?: number }) {
  if (overall === "success") return <CheckCircle2 size={size} style={{ color: "#22C55E" }} />;
  if (overall === "failure") return <XCircle size={size} style={{ color: "#EF4444" }} />;
  if (overall === "running") return <Loader2 size={size} className="animate-spin" style={{ color: "#E5C07B" }} />;
  return <Clock size={size} style={{ color: "var(--color-muted)" }} />;
}

function CheckRow({ check }: { readonly check: PrCheck }) {
  const icon =
    check.status !== "completed" ? (
      <Loader2 size={12} className="animate-spin" style={{ color: "#E5C07B" }} />
    ) : check.conclusion === "success" ? (
      <CheckCircle2 size={12} style={{ color: "#22C55E" }} />
    ) : check.conclusion === "neutral" || check.conclusion === "skipped" ? (
      <Clock size={12} style={{ color: "var(--color-muted)" }} />
    ) : (
      <XCircle size={12} style={{ color: "#EF4444" }} />
    );

  return (
    <div className="flex items-center justify-between" style={{ padding: "4px 0", gap: 8 }}>
      <div className="flex items-center min-w-0" style={{ gap: 6 }}>
        <span className="shrink-0">{icon}</span>
        <span
          className="text-[11px] font-mono truncate"
          style={{ color: "var(--color-muted-foreground)" }}
        >
          {check.name}
        </span>
        <span className="text-[10px] font-mono shrink-0" style={{ color: "var(--color-muted)" }}>
          {check.status !== "completed" ? check.status : (check.conclusion ?? "")}
        </span>
      </div>
      {check.details_url && (
        <button
          onClick={() => openUrl(check.details_url as string)}
          className="flex items-center justify-center rounded transition-colors hover:bg-hover-overlay/[0.06] shrink-0"
          style={{ width: 20, height: 20 }}
        >
          <ExternalLink size={11} style={{ color: "var(--color-muted)" }} />
        </button>
      )}
    </div>
  );
}

// ── PR list row ──────────────────────────────────────────────────────

function PrRow({
  pr,
  isSelected,
  isPending,
  onSelect,
}: {
  readonly pr: PrSummary;
  readonly isSelected: boolean;
  readonly isPending: boolean;
  readonly onSelect: () => void;
}) {
  const { t } = useTranslation();
  return (
    <button
      onClick={onSelect}
      className="flex flex-col w-full text-left native-css-hover"
      style={
        {
          padding: "8px 12px",
          gap: 3,
          border: "none",
          cursor: "pointer",
          backgroundColor:
            isSelected || isPending ? "var(--color-border-subtle)" : "transparent",
          "--native-hover-bg-color": "var(--color-border-subtle)",
        } as React.CSSProperties
      }
    >
      <div className="flex items-center" style={{ gap: 6 }}>
        <GitPullRequest
          size={12}
          className="shrink-0"
          style={{ color: stateColor(pr.state, pr.is_draft) }}
        />
        <span
          className="flex-1 min-w-0 text-[12px] font-sans truncate"
          style={{ color: "var(--color-foreground)" }}
        >
          {pr.title}
        </span>
        {isPending && (
          <Loader2
            size={11}
            className="animate-spin shrink-0"
            style={{ color: "var(--color-muted)" }}
          />
        )}
      </div>
      <div className="flex items-center" style={{ gap: 6, paddingLeft: 18 }}>
        <span className="text-[10px] font-mono" style={{ color: "var(--color-muted)" }}>
          #{pr.number}
        </span>
        {pr.is_draft && (
          <span
            className="text-[9px] font-sans font-semibold"
            style={{
              color: "var(--color-muted)",
              backgroundColor: "var(--color-border-light)",
              borderRadius: 4,
              padding: "0 5px",
            }}
          >
            {t("git.pr.draft")}
          </span>
        )}
        <span className="text-[10px] font-mono truncate" style={{ color: "var(--color-muted)" }}>
          {pr.author}
        </span>
        <span className="text-[10px] font-mono shrink-0" style={{ color: "var(--color-muted)" }}>
          {formatRelativeTime(pr.updated_at)}
        </span>
      </div>
    </button>
  );
}

// ── Create form ──────────────────────────────────────────────────────

function PrCreateForm({
  workspacePath,
  currentBranch,
  defaultBase,
  onCancel,
  onCreated,
}: {
  readonly workspacePath: string;
  readonly currentBranch: string;
  readonly defaultBase: string;
  readonly onCancel: () => void;
  readonly onCreated: () => void;
}) {
  const { t } = useTranslation();
  const createPr = usePrStore((s) => s.createPr);
  const isCreating = usePrStore((s) => s.isCreating);
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [base, setBase] = useState(defaultBase);
  const [draft, setDraft] = useState(false);
  const [aiLanguage, setAiLanguage] = useState<PrAiLanguage>(getStoredAiLanguage);
  const [isGeneratingAi, setIsGeneratingAi] = useState(false);
  const [summaryPreview, setSummaryPreview] = useState<GitBranchSummary | null>(null);
  const [newBranchName, setNewBranchName] = useState("");
  const [isCreatingBranch, setIsCreatingBranch] = useState(false);
  const [submitPhase, setSubmitPhase] = useState<"idle" | "committing" | "pushing" | "creating">(
    "idle",
  );
  const gitAhead = useGitStore((s) => s.gitInfo?.ahead ?? 0);
  const branches = useGitStore((s) => s.branches);

  const effectiveBase = base.trim() || defaultBase;
  const isSameBranch = currentBranch === effectiveBase;
  const uncommittedCount = summaryPreview?.uncommitted_files.length ?? 0;
  const currentBranchInfo = branches.find((b) => b.is_current);
  const isUnpushed =
    gitAhead > 0 ||
    (branches.length > 0 && currentBranchInfo != null && !currentBranchInfo.upstream);

  // The base is picked from origin's real branches — free-typing a branch
  // GitHub doesn't know would only fail at the very end of the one-click
  // flow (after commit+push already ran) or silently diff against the
  // wrong branch.
  const baseOptions = useMemo(() => {
    const names = new Set<string>([defaultBase]);
    for (const b of branches) {
      if (!b.is_remote || !b.name.startsWith("origin/")) continue;
      const name = b.name.slice("origin/".length);
      if (name && name !== "HEAD") names.add(name);
    }
    return Array.from(names);
  }, [branches, defaultBase]);

  // Refresh the branch list so the picker reflects origin's current state.
  useEffect(() => {
    void useGitStore.getState().loadBranches(workspacePath);
  }, [workspacePath]);

  // Probe the working tree so the form can announce what "Create" will do
  // (auto-commit / auto-push) before the user hits it. Re-runs when the
  // selected base changes so the committed-diff context stays accurate.
  useEffect(() => {
    let cancelled = false;
    invoke<GitBranchSummary>("git_branch_summary", {
      path: workspacePath,
      base: effectiveBase,
    })
      .then((summary) => {
        if (!cancelled) setSummaryPreview(summary);
      })
      .catch(() => {
        // Best-effort: a missing base branch must not block the form.
      });
    return () => {
      cancelled = true;
    };
  }, [workspacePath, effectiveBase, currentBranch]);

  // Re-sync the form's warnings and the git panel after a partial failure
  // (e.g. commit succeeded but push failed) or a completed run.
  const refreshWorkTreeState = useCallback(() => {
    invoke<GitBranchSummary>("git_branch_summary", {
      path: workspacePath,
      base: effectiveBase,
    })
      .then(setSummaryPreview)
      .catch(() => {});
    const git = useGitStore.getState();
    void git.refreshGitInfo(workspacePath);
    void git.loadFileStatuses(workspacePath);
    void git.loadBranches(workspacePath);
  }, [workspacePath, effectiveBase]);

  const handleCreateBranch = useCallback(async () => {
    const name = newBranchName.trim();
    if (!name || isCreatingBranch) return;
    setIsCreatingBranch(true);
    try {
      const git = useGitStore.getState();
      await git.createBranch(workspacePath, name);
      await git.switchBranch(workspacePath, name);
      setNewBranchName("");
    } finally {
      setIsCreatingBranch(false);
    }
  }, [newBranchName, isCreatingBranch, workspacePath]);

  const handleSetAiLanguage = useCallback((lang: PrAiLanguage) => {
    setAiLanguage(lang);
    try {
      window.localStorage.setItem(PR_AI_LANG_KEY, lang);
    } catch {
      // Preference persistence is best-effort.
    }
  }, []);

  const handleGenerateAi = useCallback(async () => {
    if (isGeneratingAi) return;
    const resolved = resolveOneShotAiTarget();
    if (!resolved.ok) {
      useToastStore.getState().addToast(
        "warning",
        resolved.reason === "no-model" ? t("git.pr.ai.selectModel") : t("git.apiKeyRequired"),
      );
      return;
    }
    setIsGeneratingAi(true);
    try {
      const summary = await invoke<GitBranchSummary>("git_branch_summary", {
        path: workspacePath,
        base: base.trim() || defaultBase,
      });
      const userContent = buildBranchSummaryContent(summary);
      const target = resolved.target;
      let result: string;
      if (target.authMode === "oauth") {
        const languageName =
          aiLanguage === "en" ? "English" : "Simplified Chinese (简体中文)";
        result = await generateOneShotViaSidecar({
          target,
          systemPrompt: PR_SYSTEM_PROMPT_TEMPLATE.replace("{language}", languageName),
          userContent,
          timeoutMessage: "PR description generation timed out",
        });
      } else {
        result = await invoke<string>("generate_pr_description", {
          sdk: target.sdk,
          baseUrl: target.baseUrl,
          apiKey: target.apiKey,
          model: target.model,
          proxyUrl: target.proxyUrl ?? null,
          language: aiLanguage,
          branchSummary: userContent,
        });
      }
      const parsed = parseGeneratedPr(result);
      if (parsed.title) setTitle(parsed.title);
      if (parsed.body) setBody(parsed.body);
    } catch (err: unknown) {
      useToastStore.getState().addToast("error", `${t("git.pr.ai.failed")}: ${formatError(err)}`);
    } finally {
      setIsGeneratingAi(false);
    }
  }, [isGeneratingAi, workspacePath, base, defaultBase, aiLanguage, t]);

  // One-click submit: commit outstanding work (PR title as the commit
  // message) → push → create the PR. Steps that aren't needed are skipped.
  const handleSubmit = useCallback(async () => {
    if (!title.trim() || submitPhase !== "idle" || isCreating || isSameBranch || isGeneratingAi)
      return;
    let phase: "committing" | "pushing" | "creating" = "creating";
    try {
      if (uncommittedCount > 0) {
        phase = "committing";
        setSubmitPhase(phase);
        const statuses = await invoke<GitFileStatus[]>("get_git_status", {
          path: workspacePath,
        });
        const unstaged = statuses.filter((f) => !f.is_staged).map((f) => f.path);
        if (unstaged.length > 0) {
          await invoke("git_stage_files", { path: workspacePath, files: unstaged });
        }
        if (statuses.length > 0) {
          await invoke<string>("git_commit", { path: workspacePath, message: title.trim() });
        }
      }

      if (uncommittedCount > 0 || isUnpushed) {
        phase = "pushing";
        setSubmitPhase(phase);
        await invoke("git_push", {
          path: workspacePath,
          gitTokens: buildGitTokensMap(),
          credentials: null,
        });
      }

      phase = "creating";
      setSubmitPhase(phase);
      await createPr({
        title: title.trim(),
        body,
        head: currentBranch,
        base: base.trim() || defaultBase,
        draft,
      });
      useToastStore.getState().addToast("info", t("git.pr.createSuccess"));
      onCreated();
    } catch (err: unknown) {
      const message =
        phase === "committing"
          ? `${t("git.pr.commitFailed")}: ${formatError(err)}`
          : phase === "pushing"
            ? isGitAuthFailure(err)
              ? t("git.pr.pushAuthFailed")
              : `${t("git.pr.pushFailed")}: ${formatError(err)}`
            : `${t("git.pr.createFailed")}: ${formatError(err)}`;
      useToastStore.getState().addToast("error", message);
    } finally {
      setSubmitPhase("idle");
      // Whatever happened, resync the warnings and the git panel with the
      // repo's new state (a commit/push may have landed before a failure).
      refreshWorkTreeState();
    }
  }, [
    title,
    body,
    base,
    draft,
    currentBranch,
    defaultBase,
    submitPhase,
    isCreating,
    isSameBranch,
    isGeneratingAi,
    uncommittedCount,
    isUnpushed,
    workspacePath,
    createPr,
    onCreated,
    refreshWorkTreeState,
    t,
  ]);

  const inputStyle: React.CSSProperties = {
    backgroundColor: "var(--color-background)",
    border: "1px solid var(--color-border)",
    borderRadius: 6,
    padding: "6px 10px",
    fontSize: 12,
    color: "var(--color-foreground)",
    outline: "none",
    width: "100%",
  };

  return (
    <div className="flex flex-col flex-1 min-h-0 overflow-y-auto" style={{ padding: 16, gap: 12 }}>
      <div className="flex items-center" style={{ gap: 8 }}>
        <GitPullRequest size={14} style={{ color: "var(--color-accent-purple)" }} />
        <span className="text-[13px] font-semibold" style={{ color: "var(--color-foreground)" }}>
          {t("git.pr.createTitle")}
        </span>
      </div>

      {/* head → base + AI generation controls */}
      <div className="flex items-center justify-between flex-wrap" style={{ gap: 8 }}>
        <div className="flex items-center flex-wrap" style={{ gap: 6 }}>
          <GitBranch size={12} style={{ color: "var(--color-muted)" }} />
          <span
            className="text-[11px] font-mono"
            style={{
              color: "var(--color-accent-purple)",
              backgroundColor: "color-mix(in srgb, var(--color-accent-purple) 12%, transparent)",
              borderRadius: 4,
              padding: "1px 6px",
            }}
          >
            {currentBranch}
          </span>
          <span className="text-[11px]" style={{ color: "var(--color-muted)" }}>
            →
          </span>
          <select
            value={effectiveBase}
            onChange={(e) => setBase(e.target.value)}
            className="font-mono"
            title={t("git.pr.baseBranchTitle")}
            style={{ ...inputStyle, width: 160, padding: "3px 8px", fontSize: 11 }}
          >
            {baseOptions.map((name) => (
              <option key={name} value={name}>
                {name === defaultBase ? `${name} · ${t("git.pr.defaultBranch")}` : name}
              </option>
            ))}
          </select>
        </div>
        <div className="flex items-center" style={{ gap: 6 }}>
          {(
            [
              { value: "zh", label: "中文" },
              { value: "en", label: "EN" },
            ] as const
          ).map(({ value, label }) => (
            <button
              key={value}
              onClick={() => handleSetAiLanguage(value)}
              disabled={isGeneratingAi}
              className="rounded transition-colors disabled:opacity-50"
              style={{
                padding: "2px 8px",
                fontSize: 10,
                cursor: "pointer",
                color: aiLanguage === value ? "var(--color-accent-purple)" : "var(--color-muted)",
                backgroundColor:
                  aiLanguage === value ? "rgba(var(--theme-accent-rgb),0.08)" : "transparent",
                border: `1px solid ${aiLanguage === value ? "var(--color-accent-purple)" : "var(--color-border)"}`,
              }}
              title={t("git.pr.ai.languageTitle")}
            >
              {label}
            </button>
          ))}
          <button
            onClick={handleGenerateAi}
            disabled={isGeneratingAi || submitPhase !== "idle"}
            className="flex items-center rounded transition-colors hover:bg-hover-overlay/[0.06] disabled:opacity-50"
            style={{
              gap: 4,
              padding: "3px 10px",
              fontSize: 11,
              fontWeight: 600,
              color: "var(--color-accent-purple)",
              border: "1px solid var(--color-accent-purple)",
              cursor: "pointer",
            }}
            title={t("git.pr.ai.generateTitle")}
          >
            {isGeneratingAi ? (
              <Loader2 size={11} className="animate-spin" />
            ) : (
              <Sparkles size={11} />
            )}
            {isGeneratingAi ? t("git.pr.ai.generating") : t("git.pr.ai.generate")}
          </button>
        </div>
      </div>

      {/* Pre-flight warnings: the PR content lives in the working tree until
          the user branches / commits / pushes — surface that before "Create". */}
      {isSameBranch && (
        <div
          className="flex flex-col"
          style={{
            gap: 8,
            padding: "8px 10px",
            borderRadius: 6,
            border: "1px solid #EF444455",
            backgroundColor: "#EF444412",
          }}
        >
          <div className="flex items-center" style={{ gap: 6 }}>
            <AlertTriangle size={12} className="shrink-0" style={{ color: "#EF4444" }} />
            <span className="text-[11px]" style={{ color: "#EF4444" }}>
              {t("git.pr.sameBranch")}
            </span>
          </div>
          <div className="flex items-center" style={{ gap: 6 }}>
            <input
              value={newBranchName}
              onChange={(e) => setNewBranchName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") void handleCreateBranch();
              }}
              placeholder={t("git.pr.newBranchPlaceholder")}
              className="font-mono"
              style={{ ...inputStyle, width: 200, padding: "3px 8px", fontSize: 11 }}
            />
            <button
              onClick={() => void handleCreateBranch()}
              disabled={!newBranchName.trim() || isCreatingBranch}
              className="flex items-center rounded transition-colors disabled:opacity-50"
              style={{
                gap: 4,
                padding: "3px 10px",
                fontSize: 11,
                color: "var(--color-foreground)",
                border: "1px solid var(--color-border)",
                cursor: "pointer",
              }}
            >
              {isCreatingBranch ? (
                <Loader2 size={11} className="animate-spin" />
              ) : (
                <GitBranch size={11} />
              )}
              {t("git.pr.createBranch")}
            </button>
          </div>
        </div>
      )}
      {uncommittedCount > 0 && (
        <div
          className="flex items-center"
          style={{
            gap: 6,
            padding: "8px 10px",
            borderRadius: 6,
            border: "1px solid var(--color-border)",
            backgroundColor: "var(--color-background)",
          }}
        >
          <Info size={12} className="shrink-0" style={{ color: "var(--color-accent-purple)" }} />
          <span className="text-[11px]" style={{ color: "var(--color-muted-foreground)" }}>
            {t("git.pr.uncommittedWarning", { count: uncommittedCount })}
          </span>
        </div>
      )}
      {!isSameBranch && uncommittedCount === 0 && isUnpushed && (
        <div
          className="flex items-center"
          style={{
            gap: 6,
            padding: "8px 10px",
            borderRadius: 6,
            border: "1px solid var(--color-border)",
            backgroundColor: "var(--color-background)",
          }}
        >
          <Info size={12} className="shrink-0" style={{ color: "var(--color-accent-purple)" }} />
          <span className="text-[11px]" style={{ color: "var(--color-muted-foreground)" }}>
            {t("git.pr.unpushedWarning")}
          </span>
        </div>
      )}

      <input
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        placeholder={t("git.pr.titlePlaceholder")}
        style={inputStyle}
        autoFocus
      />
      <textarea
        value={body}
        onChange={(e) => setBody(e.target.value)}
        placeholder={t("git.pr.bodyPlaceholder")}
        rows={8}
        style={{ ...inputStyle, resize: "vertical", fontFamily: "inherit", minHeight: 120 }}
      />

      <label className="flex items-center cursor-pointer" style={{ gap: 6 }}>
        <input type="checkbox" checked={draft} onChange={(e) => setDraft(e.target.checked)} />
        <span className="text-[11px]" style={{ color: "var(--color-muted-foreground)" }}>
          {t("git.pr.createAsDraft")}
        </span>
      </label>

      <div className="flex items-center" style={{ gap: 8 }}>
        <button
          onClick={handleSubmit}
          disabled={!title.trim() || submitPhase !== "idle" || isCreating || isSameBranch}
          title={isSameBranch ? t("git.pr.sameBranch") : undefined}
          className="flex items-center justify-center rounded transition-colors disabled:opacity-50"
          style={{
            gap: 6,
            padding: "6px 14px",
            fontSize: 12,
            fontWeight: 600,
            color: "#fff",
            backgroundColor: "var(--color-accent-purple)",
            border: "none",
            cursor: "pointer",
          }}
        >
          {submitPhase !== "idle" || isCreating ? (
            <Loader2 size={12} className="animate-spin" />
          ) : (
            <Plus size={12} />
          )}
          {submitPhase === "committing"
            ? t("git.pr.committing")
            : submitPhase === "pushing"
              ? t("git.pr.pushing")
              : submitPhase === "creating" || isCreating
                ? t("git.pr.creating")
                : uncommittedCount > 0
                  ? t("git.pr.commitAndCreate")
                  : isUnpushed
                    ? t("git.pr.pushAndCreate")
                    : t("git.pr.create")}
        </button>
        <button
          onClick={onCancel}
          disabled={submitPhase !== "idle" || isCreating}
          className="rounded transition-colors hover:bg-hover-overlay/[0.06]"
          style={{
            padding: "6px 14px",
            fontSize: 12,
            color: "var(--color-muted-foreground)",
            backgroundColor: "transparent",
            border: "1px solid var(--color-border)",
            cursor: "pointer",
          }}
        >
          {t("git.pr.cancel")}
        </button>
      </div>
    </div>
  );
}

// ── Detail view ──────────────────────────────────────────────────────

function PrDetailView({ pr, onBack }: { readonly pr: PrDetail; readonly onBack: () => void }) {
  const { t } = useTranslation();
  const repoInfo = usePrStore((s) => s.repoInfo);
  const checks = usePrStore((s) => s.checks);
  const checksError = usePrStore((s) => s.checksError);
  const isLoadingChecks = usePrStore((s) => s.isLoadingChecks);
  const refreshChecks = usePrStore((s) => s.refreshChecks);
  const selectPr = usePrStore((s) => s.selectPr);
  const mergePr = usePrStore((s) => s.mergePr);
  const isMerging = usePrStore((s) => s.isMerging);

  const allowedMethods = useMemo<ReadonlyArray<MergeMethod>>(() => {
    if (!repoInfo) return ["merge", "squash", "rebase"];
    const methods: MergeMethod[] = [];
    if (repoInfo.allow_merge_commit) methods.push("merge");
    if (repoInfo.allow_squash_merge) methods.push("squash");
    if (repoInfo.allow_rebase_merge) methods.push("rebase");
    return methods.length > 0 ? methods : ["merge"];
  }, [repoInfo]);

  const [method, setMethod] = useState<MergeMethod>(allowedMethods[0]);
  const [deleteBranch, setDeleteBranch] = useState(true);

  // Poll CI status while the detail view is open; anything still running
  // refreshes faster than a settled state.
  useEffect(() => {
    const interval = setInterval(
      () => void refreshChecks(),
      checks?.overall === "running" ? 30_000 : 90_000,
    );
    return () => clearInterval(interval);
  }, [refreshChecks, checks?.overall]);

  const mergeBlockReason = useMemo<string | null>(() => {
    if (pr.state !== "open") return null;
    if (pr.is_draft) return t("git.pr.blockedDraft");
    if (pr.mergeable === false) return t("git.pr.blockedConflicts");
    // Until CI state is known, merging is gated — an unknown status must not
    // read as "no checks configured".
    if (!checks && !checksError) return t("git.pr.blockedChecksLoading");
    if (!checks && checksError) return t("git.pr.blockedChecksUnavailable");
    if (checks?.overall === "failure") return t("git.pr.blockedChecksFailed");
    if (checks?.overall === "running") return t("git.pr.blockedChecksRunning");
    return null;
  }, [pr, checks, checksError, t]);

  const canMerge = pr.state === "open" && mergeBlockReason === null;

  const handleMerge = useCallback(async () => {
    if (!canMerge || isMerging) return;
    try {
      const result = await mergePr(method, deleteBranch);
      if (result.merged) {
        useToastStore.getState().addToast("info", t("git.pr.mergeSuccess"));
      } else {
        useToastStore.getState().addToast("error", `${t("git.pr.mergeFailed")}: ${result.message}`);
      }
    } catch (err: unknown) {
      useToastStore.getState().addToast("error", `${t("git.pr.mergeFailed")}: ${formatError(err)}`);
    }
  }, [canMerge, isMerging, mergePr, method, deleteBranch, t]);

  return (
    <div className="flex flex-col flex-1 min-h-0 overflow-y-auto" style={{ padding: 16, gap: 12 }}>
      {/* Title row */}
      <div className="flex items-start justify-between" style={{ gap: 8 }}>
        <div className="flex items-start min-w-0" style={{ gap: 8 }}>
          <button
            onClick={onBack}
            className="flex items-center justify-center rounded transition-colors hover:bg-hover-overlay/[0.06] shrink-0 md:hidden"
            style={{ width: 24, height: 24 }}
          >
            <ArrowLeft size={13} style={{ color: "var(--color-muted)" }} />
          </button>
          <GitPullRequest
            size={15}
            className="shrink-0"
            style={{ color: stateColor(pr.state, pr.is_draft), marginTop: 2 }}
          />
          <div className="flex flex-col min-w-0" style={{ gap: 2 }}>
            <span className="text-[13px] font-semibold" style={{ color: "var(--color-foreground)" }}>
              {pr.title}{" "}
              <span className="font-mono font-normal" style={{ color: "var(--color-muted)" }}>
                #{pr.number}
              </span>
            </span>
            <div className="flex items-center flex-wrap" style={{ gap: 6 }}>
              <span
                className="text-[9px] font-sans font-semibold uppercase"
                style={{
                  color: stateColor(pr.state, pr.is_draft),
                  backgroundColor: `color-mix(in srgb, ${stateColor(pr.state, pr.is_draft)} 14%, transparent)`,
                  borderRadius: 4,
                  padding: "1px 6px",
                }}
              >
                {pr.is_draft && pr.state === "open" ? t("git.pr.draft") : t(`git.pr.state.${pr.state}`)}
              </span>
              <span className="text-[10px] font-mono" style={{ color: "var(--color-muted)" }}>
                {pr.author}
              </span>
              <span className="text-[10px] font-mono" style={{ color: "var(--color-muted)" }}>
                {pr.head_branch} → {pr.base_branch}
              </span>
              <span className="text-[10px] font-mono" style={{ color: "#22C55E" }}>
                +{pr.additions}
              </span>
              <span className="text-[10px] font-mono" style={{ color: "#EF4444" }}>
                -{pr.deletions}
              </span>
            </div>
          </div>
        </div>
        <button
          onClick={() => openUrl(pr.html_url)}
          className="flex items-center justify-center rounded transition-colors hover:bg-hover-overlay/[0.06] shrink-0"
          style={{ width: 26, height: 26 }}
          title={t("git.pr.openInBrowser")}
        >
          <ExternalLink size={13} style={{ color: "var(--color-muted)" }} />
        </button>
      </div>

      {/* Body */}
      {pr.body && (
        <div
          className="text-[12px] whitespace-pre-wrap"
          style={{
            color: "var(--color-muted-foreground)",
            backgroundColor: "var(--color-background)",
            border: "1px solid var(--color-border)",
            borderRadius: 6,
            padding: 12,
            maxHeight: 220,
            overflowY: "auto",
          }}
        >
          {pr.body}
        </div>
      )}

      {/* CI checks */}
      <div
        style={{
          backgroundColor: "var(--color-background)",
          border: "1px solid var(--color-border)",
          borderRadius: 6,
          padding: "10px 12px",
        }}
      >
        <div className="flex items-center justify-between" style={{ marginBottom: 4 }}>
          <div className="flex items-center" style={{ gap: 6 }}>
            {!checks && !checksError ? (
              <Loader2 size={13} className="animate-spin" style={{ color: "var(--color-muted)" }} />
            ) : (
              <ChecksIcon overall={checks?.overall ?? "none"} />
            )}
            <span
              className="text-[11px] font-semibold"
              style={{ color: "var(--color-foreground)" }}
            >
              {t("git.pr.checks")}
            </span>
          </div>
          <button
            onClick={() => void refreshChecks()}
            disabled={isLoadingChecks}
            className="flex items-center justify-center rounded transition-colors hover:bg-hover-overlay/[0.06] disabled:opacity-50"
            style={{ width: 22, height: 22 }}
            title={t("git.refresh")}
          >
            <RefreshCw
              size={11}
              className={isLoadingChecks ? "animate-spin" : undefined}
              style={{ color: "var(--color-muted)" }}
            />
          </button>
        </div>
        {!checks && !checksError ? (
          <span className="text-[11px]" style={{ color: "var(--color-muted)" }}>
            {t("git.pr.loadingChecks")}
          </span>
        ) : !checks && checksError ? (
          <div className="flex items-center" style={{ gap: 6 }}>
            <AlertTriangle size={12} className="shrink-0" style={{ color: "#E5C07B" }} />
            <span className="text-[11px]" style={{ color: "#E5C07B" }}>
              {t("git.pr.checksFailed")}
            </span>
          </div>
        ) : checks && checks.checks.length === 0 ? (
          <span className="text-[11px]" style={{ color: "var(--color-muted)" }}>
            {t("git.pr.noChecks")}
          </span>
        ) : (
          checks?.checks.map((check, i) => <CheckRow key={`${check.name}-${i}`} check={check} />)
        )}
      </div>

      {/* Merge section */}
      {pr.state === "open" && (
        <div
          className="flex flex-col"
          style={{
            gap: 8,
            backgroundColor: "var(--color-background)",
            border: "1px solid var(--color-border)",
            borderRadius: 6,
            padding: "10px 12px",
          }}
        >
          <div className="flex items-center flex-wrap" style={{ gap: 6 }}>
            {allowedMethods.map((m) => (
              <button
                key={m}
                onClick={() => setMethod(m)}
                className="rounded transition-colors"
                style={{
                  padding: "3px 10px",
                  fontSize: 11,
                  cursor: "pointer",
                  color: method === m ? "var(--color-accent-purple)" : "var(--color-muted)",
                  backgroundColor:
                    method === m ? "rgba(var(--theme-accent-rgb),0.08)" : "transparent",
                  border: `1px solid ${method === m ? "var(--color-accent-purple)" : "var(--color-border)"}`,
                }}
              >
                {t(`git.pr.method.${m}`)}
              </button>
            ))}
          </div>
          <label className="flex items-center cursor-pointer" style={{ gap: 6 }}>
            <input
              type="checkbox"
              checked={deleteBranch}
              onChange={(e) => setDeleteBranch(e.target.checked)}
            />
            <span className="text-[11px]" style={{ color: "var(--color-muted-foreground)" }}>
              {t("git.pr.deleteBranch")}
            </span>
          </label>
          {mergeBlockReason && (
            <div className="flex items-center" style={{ gap: 6 }}>
              <AlertTriangle size={12} style={{ color: "#E5C07B" }} />
              <span className="text-[11px]" style={{ color: "#E5C07B" }}>
                {mergeBlockReason}
              </span>
            </div>
          )}
          <button
            onClick={handleMerge}
            disabled={!canMerge || isMerging}
            className="flex items-center justify-center rounded transition-colors disabled:opacity-50"
            style={{
              gap: 6,
              padding: "6px 14px",
              fontSize: 12,
              fontWeight: 600,
              color: "#fff",
              backgroundColor: "#A855F7",
              border: "none",
              cursor: canMerge ? "pointer" : "not-allowed",
              alignSelf: "flex-start",
            }}
          >
            {isMerging ? (
              <Loader2 size={12} className="animate-spin" />
            ) : (
              <GitMerge size={12} />
            )}
            {isMerging ? t("git.pr.merging") : t("git.pr.merge")}
          </button>
        </div>
      )}

      {/* Refresh detail (mergeable is computed async by GitHub) */}
      {pr.state === "open" && pr.mergeable === null && (
        <button
          onClick={() => void selectPr(pr.number)}
          className="flex items-center rounded transition-colors hover:bg-hover-overlay/[0.06]"
          style={{
            gap: 6,
            padding: "4px 10px",
            fontSize: 11,
            color: "var(--color-muted)",
            backgroundColor: "transparent",
            border: "1px solid var(--color-border)",
            cursor: "pointer",
            alignSelf: "flex-start",
          }}
        >
          <RefreshCw size={11} />
          {t("git.pr.recheckMergeable")}
        </button>
      )}
    </div>
  );
}

// ── Main modal ───────────────────────────────────────────────────────

export function PrModal({ workspacePath }: { readonly workspacePath: string }) {
  const { t } = useTranslation();
  const closeModal = usePrStore((s) => s.closeModal);
  const repoInfo = usePrStore((s) => s.repoInfo);
  const repoError = usePrStore((s) => s.repoError);
  const prs = usePrStore((s) => s.prs);
  const listState = usePrStore((s) => s.listState);
  const setListState = usePrStore((s) => s.setListState);
  const listError = usePrStore((s) => s.listError);
  const selectedPr = usePrStore((s) => s.selectedPr);
  const selectPr = usePrStore((s) => s.selectPr);
  const clearSelection = usePrStore((s) => s.clearSelection);
  const loadPrs = usePrStore((s) => s.loadPrs);
  const detectRepo = usePrStore((s) => s.detectRepo);
  const pendingPrNumber = usePrStore((s) => s.pendingPrNumber);
  const isDetecting = usePrStore((s) => s.isDetecting);
  const isLoadingList = usePrStore((s) => s.isLoadingList);
  const isLoadingDetail = usePrStore((s) => s.isLoadingDetail);
  const currentBranch = useGitStore((s) => s.gitInfo?.branch ?? "");

  const [isCreateOpen, setIsCreateOpen] = useState(false);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") closeModal();
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [closeModal]);

  const isGithub = repoInfo?.platform === "github";

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center"
      style={{ backgroundColor: "rgba(0,0,0,0.5)" }}
      onClick={(e) => {
        if (e.target === e.currentTarget) closeModal();
      }}
    >
      <div
        className="flex flex-col overflow-hidden"
        style={{
          width: "min(960px, 92vw)",
          height: "min(680px, 88vh)",
          borderRadius: "var(--radius-lg)",
          backgroundColor: "var(--color-surface)",
          border: "1px solid var(--color-border)",
          boxShadow: "var(--shadow-float)",
        }}
      >
        {/* Header */}
        <div
          className="flex items-center justify-between shrink-0"
          style={{ height: 44, padding: "0 16px", borderBottom: "1px solid var(--color-border)" }}
        >
          <div className="flex items-center min-w-0" style={{ gap: 8 }}>
            <GitPullRequest size={15} style={{ color: "var(--color-accent-purple)" }} />
            <span
              className="text-[13px] font-semibold font-sans"
              style={{ color: "var(--color-foreground)" }}
            >
              {t("git.pr.title")}
            </span>
            {repoInfo && (
              <span
                className="text-[11px] font-mono truncate"
                style={{
                  color: "var(--color-accent-purple)",
                  backgroundColor:
                    "color-mix(in srgb, var(--color-accent-purple) 12%, transparent)",
                  borderRadius: 4,
                  padding: "1px 6px",
                }}
              >
                {repoInfo.owner}/{repoInfo.repo}
              </span>
            )}
          </div>
          <div className="flex items-center" style={{ gap: 2 }}>
            {isGithub && (
              <button
                onClick={() => {
                  clearSelection();
                  setIsCreateOpen(true);
                }}
                className="flex items-center rounded transition-colors hover:bg-hover-overlay/[0.06]"
                style={{
                  gap: 4,
                  padding: "3px 10px",
                  fontSize: 11,
                  fontWeight: 600,
                  color: "var(--color-accent-purple)",
                  border: "1px solid var(--color-accent-purple)",
                  cursor: "pointer",
                  marginRight: 6,
                }}
                disabled={!currentBranch}
                title={currentBranch ? undefined : t("git.pr.noBranch")}
              >
                <Plus size={11} />
                {t("git.pr.newPr")}
              </button>
            )}
            <button
              onClick={() => void (isGithub ? loadPrs() : detectRepo(workspacePath))}
              className="flex items-center justify-center rounded transition-colors hover:bg-hover-overlay/[0.06]"
              style={{ width: 28, height: 28 }}
              title={t("git.refresh")}
            >
              <RefreshCw
                size={13}
                className={isDetecting || isLoadingList ? "animate-spin" : undefined}
                style={{ color: "var(--color-muted)" }}
              />
            </button>
            <button
              onClick={closeModal}
              className="flex items-center justify-center rounded transition-colors hover:bg-hover-overlay/[0.06]"
              style={{ width: 28, height: 28 }}
              title={t("git.closePanel")}
            >
              <X size={14} className="text-muted" />
            </button>
          </div>
        </div>

        {/* Body */}
        {isDetecting && !repoInfo ? (
          <div
            className="flex flex-col items-center justify-center flex-1"
            style={{ gap: 8 }}
          >
            <Loader2 size={18} className="animate-spin" style={{ color: "var(--color-muted)" }} />
            <span className="text-[12px]" style={{ color: "var(--color-muted)" }}>
              {t("git.pr.detecting")}
            </span>
          </div>
        ) : !repoInfo ? (
          <div
            className="flex flex-col items-center justify-center flex-1"
            style={{ gap: 8, padding: 24, color: "var(--color-muted)", fontSize: 12 }}
          >
            <GitPullRequest size={24} />
            <span>{repoError ?? t("git.pr.noRemote")}</span>
          </div>
        ) : !isGithub ? (
          <div
            className="flex flex-col items-center justify-center flex-1"
            style={{ gap: 8, padding: 24, color: "var(--color-muted)", fontSize: 12 }}
          >
            <GitPullRequest size={24} />
            <span>{t("git.pr.notSupported", { host: repoInfo.host })}</span>
          </div>
        ) : (
          <div className="flex flex-1 min-h-0">
            {/* Left: list */}
            <div
              className="flex flex-col shrink-0 min-h-0"
              style={{ width: 300, borderRight: "1px solid var(--color-border)" }}
            >
              {/* State filter */}
              <div
                className="flex items-center shrink-0"
                style={{ gap: 4, padding: "8px 12px", borderBottom: "1px solid var(--color-border)" }}
              >
                {(["open", "closed", "all"] as const).map((s) => (
                  <button
                    key={s}
                    onClick={() => setListState(s as PrListState)}
                    className="rounded transition-colors"
                    style={{
                      padding: "2px 10px",
                      fontSize: 11,
                      cursor: "pointer",
                      color: listState === s ? "var(--color-accent-purple)" : "var(--color-muted)",
                      backgroundColor:
                        listState === s ? "rgba(var(--theme-accent-rgb),0.08)" : "transparent",
                      border: "none",
                    }}
                  >
                    {t(`git.pr.filter.${s}`)}
                  </button>
                ))}
              </div>
              {/* Rows */}
              <div className="flex-1 overflow-y-auto min-h-0">
                {listError ? (
                  <div
                    className="flex flex-col items-center justify-center"
                    style={{ padding: 20, gap: 8 }}
                  >
                    <AlertTriangle size={16} style={{ color: "#E5C07B" }} />
                    <span
                      className="text-[11px] text-center"
                      style={{ color: "var(--color-muted)" }}
                    >
                      {t("git.pr.loadFailed")}
                    </span>
                    <span
                      className="text-[10px] text-center"
                      style={{ color: "var(--color-muted)", maxWidth: 240 }}
                    >
                      {listError}
                    </span>
                    <button
                      onClick={() => void loadPrs()}
                      className="flex items-center rounded transition-colors hover:bg-hover-overlay/[0.06]"
                      style={{
                        gap: 4,
                        padding: "3px 10px",
                        fontSize: 11,
                        color: "var(--color-muted-foreground)",
                        border: "1px solid var(--color-border)",
                        cursor: "pointer",
                      }}
                    >
                      <RefreshCw size={11} />
                      {t("git.pr.retry")}
                    </button>
                  </div>
                ) : isLoadingList && prs.length === 0 ? (
                  <div
                    className="flex flex-col items-center justify-center"
                    style={{ padding: 20, gap: 8 }}
                  >
                    <Loader2
                      size={14}
                      className="animate-spin"
                      style={{ color: "var(--color-muted)" }}
                    />
                    <span className="text-[11px]" style={{ color: "var(--color-muted)" }}>
                      {t("git.pr.loading")}
                    </span>
                  </div>
                ) : prs.length === 0 ? (
                  <div
                    className="flex items-center justify-center"
                    style={{ padding: 20, color: "var(--color-muted)", fontSize: 11 }}
                  >
                    {t("git.pr.noPrs")}
                  </div>
                ) : (
                  prs.map((pr) => (
                    <PrRow
                      key={pr.number}
                      pr={pr}
                      isSelected={selectedPr?.number === pr.number}
                      isPending={pendingPrNumber === pr.number}
                      onSelect={() => {
                        setIsCreateOpen(false);
                        void selectPr(pr.number);
                      }}
                    />
                  ))
                )}
              </div>
              {repoInfo.warning && (
                <div
                  className="flex items-start shrink-0"
                  style={{
                    gap: 6,
                    padding: "8px 12px",
                    borderTop: "1px solid var(--color-border)",
                  }}
                >
                  <AlertTriangle size={11} className="shrink-0" style={{ color: "#E5C07B", marginTop: 1 }} />
                  <span className="text-[10px]" style={{ color: "var(--color-muted)" }}>
                    {repoInfo.warning}
                  </span>
                </div>
              )}
            </div>

            {/* Right: detail / create / placeholder */}
            {isCreateOpen ? (
              <PrCreateForm
                workspacePath={workspacePath}
                currentBranch={currentBranch}
                defaultBase={repoInfo.default_branch}
                onCancel={() => setIsCreateOpen(false)}
                onCreated={() => setIsCreateOpen(false)}
              />
            ) : isLoadingDetail ? (
              <div
                className="flex flex-col items-center justify-center flex-1"
                style={{ gap: 8 }}
              >
                <Loader2 size={16} className="animate-spin" style={{ color: "var(--color-muted)" }} />
                <span className="text-[11px]" style={{ color: "var(--color-muted)" }}>
                  {t("git.pr.loadingDetail")}
                </span>
              </div>
            ) : selectedPr ? (
              <PrDetailView pr={selectedPr} onBack={clearSelection} />
            ) : (
              <div
                className="flex items-center justify-center flex-1"
                style={{ color: "var(--color-muted)", fontSize: 12 }}
              >
                {t("git.pr.selectPr")}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
