import { useCallback, useState } from "react";
import { useTranslation } from "react-i18next";
import { Wrench, Check, CheckCircle, RotateCcw, Copy } from "lucide-react";
import { useHealthCheckStore } from "@/stores/health-check-store";
import { useWorkspaceStore } from "@/stores";
import { useHealthFix } from "@/hooks/use-health-fix";
import type { EnrichedIssue, IssueFixStatus, DimensionId } from "@/stores/health-check-store";

interface HealthCheckIssueListProps {
  readonly issues: ReadonlyArray<EnrichedIssue>;
}

const SEVERITY_CONFIG = {
  critical: {
    color: "#FF453A",
    bg: "#FF453A20",
    labelKey: "workspace.healthCheck.severity.critical",
    fallback: "严重",
  },
  warning: {
    color: "#FF9F0A",
    bg: "#FF9F0A20",
    labelKey: "workspace.healthCheck.severity.warning",
    fallback: "警告",
  },
  info: {
    color: "#0A84FF",
    bg: "#0A84FF20",
    labelKey: "workspace.healthCheck.severity.info",
    fallback: "建议",
  },
} as const;

/* Design-spec dimension colors (matching Pencil nodes) */
const DIMENSION_COLORS: Record<DimensionId, string> = {
  "code-standards": "#10B981",
  security: "#0A84FF",
  "perf-deps": "#A855F7",
  "tech-debt": "#06B6D4",
  maintainability: "#F59E0B",
};

export function HealthCheckIssueList({ issues }: HealthCheckIssueListProps) {
  const { t } = useTranslation();
  const selectedIssueIds = useHealthCheckStore((s) => s.selectedIssueIds);
  const toggleIssueSelection = useHealthCheckStore((s) => s.toggleIssueSelection);
  const selectAllIssues = useHealthCheckStore((s) => s.selectAllIssues);
  const clearSelection = useHealthCheckStore((s) => s.clearSelection);
  const activeIssueId = useHealthCheckStore((s) => s.activeIssueId);
  const setActiveIssueId = useHealthCheckStore((s) => s.setActiveIssueId);
  const issueFixStatuses = useHealthCheckStore((s) => s.issueFixStatuses);
  const workspacePath = useWorkspaceStore((s) => s.activeWorkspace?.path ?? "");
  const { fixSingleIssue } = useHealthFix();

  const allSelected = issues.length > 0 && issues.every((i) => selectedIssueIds.has(i.id));
  const someSelected = issues.some((i) => selectedIssueIds.has(i.id));

  const handleSelectAll = useCallback(() => {
    if (allSelected) {
      clearSelection();
    } else {
      selectAllIssues(issues.map((i) => i.id));
    }
  }, [allSelected, clearSelection, selectAllIssues, issues]);

  if (issues.length === 0) {
    return (
      <div
        className="flex flex-col items-center justify-center flex-1"
        style={{ padding: "40px 24px", gap: 8 }}
      >
        <span style={{ fontSize: 13, color: "var(--color-text-placeholder)" }}>
          {t("workspace.healthCheck.detail.noIssuesFound", "没有找到匹配的问题")}
        </span>
      </div>
    );
  }

  return (
    <>
      {/* TableHeader — design: bg:#1C1C1E80, h:36, padding:0 16 */}
      <div
        className="flex items-center shrink-0"
        style={{
          height: 36,
          padding: "0 16px",
          backgroundColor: "var(--color-surface-alt)",
        }}
      >
        <CellCheckbox
          checked={allSelected}
          indeterminate={someSelected && !allSelected}
          onChange={handleSelectAll}
          style={{ width: 32, justifyContent: "center" }}
        />
        <span style={{ ...TH_STYLE, width: 60 }}>
          {t("workspace.healthCheck.detail.colSeverity", "级别")}
        </span>
        <span style={{ ...TH_STYLE, flex: 1, minWidth: 0 }}>
          {t("workspace.healthCheck.detail.colDescription", "问题描述")}
        </span>
        <span style={{ ...TH_STYLE, width: 80 }}>
          {t("workspace.healthCheck.detail.colDimension", "维度")}
        </span>
        <span style={{ ...TH_STYLE, width: 180 }}>
          {t("workspace.healthCheck.detail.colFile", "文件路径")}
        </span>
        <span style={{ ...TH_STYLE, width: 80 }}>
          {t("workspace.healthCheck.detail.colStatus", "状态")}
        </span>
        <span style={{ ...TH_STYLE, width: 70, justifyContent: "center" }}>
          {t("workspace.healthCheck.detail.colActions", "操作")}
        </span>
      </div>

      {/* Issue rows */}
      <div className="flex flex-col flex-1 overflow-y-auto">
        {issues.map((issue) => (
          <IssueRow
            key={issue.id}
            issue={issue}
            isSelected={selectedIssueIds.has(issue.id)}
            isActive={activeIssueId === issue.id}
            fixStatus={issueFixStatuses[issue.id] ?? "pending"}
            workspacePath={workspacePath}
            onToggleSelect={() => toggleIssueSelection(issue.id)}
            onClickRow={() => setActiveIssueId(activeIssueId === issue.id ? null : issue.id)}
            onFix={() => fixSingleIssue(issue)}
          />
        ))}
      </div>
    </>
  );
}

/* ── Design-spec table header style ── */
const TH_STYLE: React.CSSProperties = {
  fontSize: 11,
  fontWeight: 500,
  color: "var(--color-text-placeholder)",
  fontFamily: "Inter, sans-serif",
  flexShrink: 0,
  display: "flex",
  alignItems: "center",
  height: 36,
};

/* ── Checkbox — design: 14x14, cornerRadius:3, stroke:#48484A or fill:#0A84FF ── */
function CellCheckbox({
  checked,
  indeterminate,
  onChange,
  style,
}: {
  readonly checked: boolean;
  readonly indeterminate?: boolean;
  readonly onChange: () => void;
  readonly style?: React.CSSProperties;
}) {
  return (
    <div className="flex items-center" style={{ ...style, flexShrink: 0 }}>
      <button
        onClick={(e) => {
          e.stopPropagation();
          onChange();
        }}
        style={{
          width: 14,
          height: 14,
          borderRadius: 3,
          border: checked || indeterminate ? "none" : "1px solid var(--color-border-strong)",
          backgroundColor: checked ? "#0A84FF" : "transparent",
          cursor: "pointer",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          padding: 0,
        }}
      >
        {checked && <Check size={10} style={{ color: "#fff" }} />}
        {indeterminate && !checked && (
          <div style={{ width: 8, height: 2, backgroundColor: "#0A84FF", borderRadius: 1 }} />
        )}
      </button>
    </div>
  );
}

/* ── IssueRow — strict per design ── */
/**
 * Convert MSYS/Git Bash path to Windows-style path.
 * e.g. "//f/project" → "F:/project", "/f/project" → "F:/project"
 */
function normalizeMsysPath(p: string): string {
  // //x/... → X:/...
  const msys2 = p.match(/^\/\/([a-zA-Z])\/(.*)/);
  if (msys2) return `${msys2[1].toUpperCase()}:/${msys2[2]}`;
  // /x/... (single letter after root slash — likely MSYS drive)
  const msys1 = p.match(/^\/([a-zA-Z])\/(.*)/);
  if (msys1) return `${msys1[1].toUpperCase()}:/${msys1[2]}`;
  return p;
}

export function toRelativePath(absPath: string | undefined | null, rootPath: string): string {
  if (!absPath) return "—";
  // Normalize separators
  let normalized = absPath.replace(/\\/g, "/");
  const normalizedRoot = rootPath.replace(/\\/g, "/").replace(/\/$/, "");

  // Handle MSYS/Git Bash style paths (//f/... or /f/...)
  normalized = normalizeMsysPath(normalized);

  if (normalizedRoot) {
    // Case-insensitive comparison for Windows drive letters
    const lowerNorm = normalized.toLowerCase();
    const lowerRoot = normalizedRoot.toLowerCase();
    if (lowerNorm.startsWith(lowerRoot)) {
      const rel = normalized.slice(normalizedRoot.length);
      return rel.startsWith("/") ? rel.slice(1) : rel;
    }
  }
  // Already a relative path — return as-is
  if (!normalized.startsWith("/") && !/^[a-zA-Z]:/.test(normalized)) {
    return normalized;
  }
  return normalized;
}

function CopyableFilePath({ displayPath }: { readonly displayPath: string }) {
  const [copied, setCopied] = useState(false);

  const handleCopy = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation();
      navigator.clipboard.writeText(displayPath).then(() => {
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      });
    },
    [displayPath],
  );

  return (
    <div
      onClick={handleCopy}
      title={displayPath}
      style={{
        display: "flex",
        alignItems: "center",
        width: 180,
        flexShrink: 0,
        height: 42,
        gap: 4,
        cursor: "pointer",
      }}
    >
      <span
        style={{
          fontSize: 11,
          color: copied ? "#30D158" : "var(--color-muted)",
          fontFamily: "Inter, sans-serif",
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
          flex: 1,
          minWidth: 0,
          transition: "color 0.2s ease",
        }}
      >
        {copied ? "Copied!" : displayPath}
      </span>
      {!copied && displayPath !== "—" && (
        <Copy size={10} style={{ color: "var(--color-text-placeholder)", flexShrink: 0 }} />
      )}
    </div>
  );
}

function IssueRow({
  issue,
  isSelected,
  isActive,
  fixStatus,
  workspacePath,
  onToggleSelect,
  onClickRow,
  onFix,
}: {
  readonly issue: EnrichedIssue;
  readonly isSelected: boolean;
  readonly isActive: boolean;
  readonly fixStatus: IssueFixStatus;
  readonly workspacePath: string;
  readonly onToggleSelect: () => void;
  readonly onClickRow: () => void;
  readonly onFix: () => void;
}) {
  const { t } = useTranslation();
  const severity = SEVERITY_CONFIG[issue.severity] ?? SEVERITY_CONFIG.info;
  const dimColor = DIMENSION_COLORS[issue.dimensionId] ?? "#888";
  const { restoreIssue } = useHealthFix();
  const displayPath = toRelativePath(issue.file, workspacePath);

  /* Design: critical rows get #FF453A08 bg tint; fixed rows opacity:0.6; ignored rows opacity:0.4 */
  const rowBg = issue.severity === "critical" ? "#FF453A08" : "transparent";
  const rowOpacity = fixStatus === "fixed" ? 0.6 : fixStatus === "ignored" ? 0.4 : 1;

  return (
    <div
      className="native-css-hover"
      style={
        {
          display: "flex",
          alignItems: "center",
          height: 42,
          padding: "0 16px",
          cursor: "pointer",
          backgroundColor: isActive ? "var(--color-surface-alt)" : rowBg,
          borderBottom: "1px solid var(--color-border-subtle)",
          opacity: rowOpacity,
          "--native-hover-bg-color": !isActive ? "var(--color-surface-alt)" : undefined,
        } as React.CSSProperties
      }
      onClick={onClickRow}
    >
      {/* Checkbox — w:32 */}
      <CellCheckbox
        checked={isSelected}
        onChange={onToggleSelect}
        style={{ width: 32, justifyContent: "center" }}
      />

      {/* Severity badge — w:60 */}
      <div style={{ display: "flex", alignItems: "center", width: 60, flexShrink: 0, height: 42 }}>
        <span
          style={{
            fontSize: 10,
            fontWeight: 600,
            color: severity.color,
            backgroundColor: severity.bg,
            padding: "2px 8px",
            borderRadius: 4,
            fontFamily: "Inter, sans-serif",
            whiteSpace: "nowrap",
          }}
        >
          {t(severity.labelKey, severity.fallback)}
        </span>
      </div>

      {/* Description — flex:1 with explicit text truncation */}
      <div
        style={{
          flex: 1,
          minWidth: 0,
          display: "flex",
          alignItems: "center",
          height: 42,
          paddingRight: 12,
        }}
      >
        <span
          style={{
            fontSize: 12,
            color: "var(--color-foreground)",
            fontFamily: "Inter, sans-serif",
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
            display: "block",
            width: "100%",
          }}
        >
          {issue.message}
        </span>
      </div>

      {/* Dimension badge — w:80 */}
      <div style={{ display: "flex", alignItems: "center", width: 80, flexShrink: 0, height: 42 }}>
        <span
          style={{
            fontSize: 10,
            fontWeight: 500,
            color: dimColor,
            backgroundColor: `${dimColor}15`,
            padding: "2px 6px",
            borderRadius: 4,
            fontFamily: "Inter, sans-serif",
            whiteSpace: "nowrap",
          }}
        >
          {issue.dimensionLabel}
        </span>
      </div>

      {/* File path — w:180, click to copy */}
      <CopyableFilePath displayPath={displayPath} />

      {/* Status badge — w:80 */}
      <div style={{ display: "flex", alignItems: "center", width: 80, flexShrink: 0, height: 42 }}>
        <FixStatusBadge status={fixStatus} />
      </div>

      {/* Action — w:70, center-aligned */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          width: 70,
          flexShrink: 0,
          height: 42,
        }}
      >
        <RowAction
          fixStatus={fixStatus}
          onFix={onFix}
          issueId={issue.id}
          restoreIssue={restoreIssue}
        />
      </div>
    </div>
  );
}

/* ── Design-spec: different action per status ── */
function RowAction({
  fixStatus,
  onFix,
  issueId,
  restoreIssue,
}: {
  readonly fixStatus: IssueFixStatus;
  readonly onFix: () => void;
  readonly issueId: string;
  readonly restoreIssue: (id: string) => void;
}) {
  const { t } = useTranslation();
  /* Fixed → circle-check icon (design: r4action) */
  if (fixStatus === "fixed") {
    return <CheckCircle size={16} style={{ color: "#30D158" }} />;
  }

  /* Ignored → "恢复" button (design: r6undoBtn, bg:#3A3A3C, color:#EBEBF599, cornerRadius:5, padding:4 10) */
  if (fixStatus === "ignored") {
    return (
      <button
        onClick={(e) => {
          e.stopPropagation();
          restoreIssue(issueId);
        }}
        className="flex items-center"
        style={{
          padding: "4px 10px",
          borderRadius: 5,
          border: "none",
          backgroundColor: "var(--color-surface-raised)",
          color: "var(--color-muted)",
          fontSize: 10,
          fontWeight: 500,
          cursor: "pointer",
          fontFamily: "Inter, sans-serif",
        }}
      >
        <span>{t("workspace.healthCheck.detail.restore", "恢复")}</span>
      </button>
    );
  }

  /* Fixing → spinner */
  if (fixStatus === "fixing") {
    return <RotateCcw size={14} className="animate-spin" style={{ color: "#FF9F0A" }} />;
  }

  /* Pending → green fix button (design: cornerRadius:5, bg:#30D158, gap:4, padding:4 10) */
  return (
    <button
      onClick={(e) => {
        e.stopPropagation();
        onFix();
      }}
      className="flex items-center"
      style={{
        gap: 4,
        padding: "4px 10px",
        borderRadius: 5,
        border: "none",
        backgroundColor: "#30D158",
        color: "#FFFFFF",
        fontSize: 10,
        fontWeight: 600,
        cursor: "pointer",
        fontFamily: "Inter, sans-serif",
      }}
    >
      <Wrench size={11} />
      <span>{t("workspace.healthCheck.detail.fix", "修复")}</span>
    </button>
  );
}

function FixStatusBadge({ status }: { readonly status: IssueFixStatus }) {
  const { t } = useTranslation();
  const config = {
    pending: {
      labelKey: "workspace.healthCheck.status.pending",
      fallback: "待修复",
      color: "#FF9F0A",
      bg: "#FF9F0A15",
    },
    fixing: {
      labelKey: "workspace.healthCheck.status.fixing",
      fallback: "修复中",
      color: "#FF9F0A",
      bg: "#FF9F0A15",
    },
    fixed: {
      labelKey: "workspace.healthCheck.status.fixed",
      fallback: "已修复",
      color: "#30D158",
      bg: "#30D15815",
    },
    ignored: {
      labelKey: "workspace.healthCheck.status.ignored",
      fallback: "已忽略",
      color: "var(--color-text-placeholder)",
      bg: "var(--color-surface-raised)",
    },
  } as const;

  const c = config[status];
  return (
    <span
      style={{
        fontSize: 10,
        fontWeight: 500,
        color: c.color,
        backgroundColor: c.bg,
        padding: "2px 8px",
        borderRadius: 4,
        fontFamily: "Inter, sans-serif",
      }}
    >
      {t(c.labelKey, c.fallback)}
    </span>
  );
}
