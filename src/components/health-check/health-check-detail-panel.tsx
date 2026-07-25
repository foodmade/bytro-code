import { useState } from "react";
import { useTranslation } from "react-i18next";
import {
  X,
  FileCode,
  File,
  Folder,
  Wrench,
  EyeOff,
  Eye,
  Maximize2,
  ArrowLeft,
  Code,
  Copy,
  Check,
} from "lucide-react";
import { useHealthCheckStore } from "@/stores/health-check-store";
import { useHealthFix } from "@/hooks/use-health-fix";
import { useAppStore, useToastStore } from "@/stores";
import { useWorkspaceStore } from "@/stores";
import { toRelativePath } from "./health-check-issue-list";
import { MarkdownRenderer } from "@/components/ui/markdown-renderer";
import type { EnrichedIssue, DimensionId, FileRef } from "@/stores/health-check-store";

interface HealthCheckDetailPanelProps {
  readonly issue: EnrichedIssue;
}

const SEVERITY_CONFIG = {
  critical: {
    color: "#FF453A",
    bg: "#FF453A10",
    labelKey: "workspace.healthCheck.severity.critical",
    fallback: "严重",
  },
  warning: {
    color: "#FF9F0A",
    bg: "#FF9F0A10",
    labelKey: "workspace.healthCheck.severity.warning",
    fallback: "警告",
  },
  info: {
    color: "#0A84FF",
    bg: "#0A84FF10",
    labelKey: "workspace.healthCheck.severity.info",
    fallback: "建议",
  },
} as const;

const DIMENSION_COLORS: Record<DimensionId, string> = {
  "code-standards": "#10B981",
  security: "#0A84FF",
  "perf-deps": "#A855F7",
  "tech-debt": "#06B6D4",
  maintainability: "#F59E0B",
};

export function HealthCheckDetailPanel({ issue }: HealthCheckDetailPanelProps) {
  const [view, setView] = useState<"detail" | "code">("detail");

  const hasFiles = issue.files && issue.files.length > 0;
  const hasAnyCode = hasFiles && issue.files!.some((f) => f.codeSnippet);

  return (
    <aside
      className="flex flex-col shrink-0"
      style={{
        width: 380,
        height: "100%",
        borderRadius: 12,
        border: "1px solid var(--color-border-light)",
        boxShadow: "var(--shadow-card)",
        backgroundColor: "var(--color-card)",
        animation: "slideInRight 0.2s ease",
        overflow: "hidden",
        position: "relative",
      }}
    >
      {/* Slide container — two pages side by side */}
      <div
        style={{
          display: "flex",
          width: "200%",
          height: "100%",
          transform: view === "code" ? "translateX(-50%)" : "translateX(0)",
          transition: "transform 0.3s cubic-bezier(0.4, 0, 0.2, 1)",
        }}
      >
        {/* Page 1: Issue detail */}
        <div style={{ width: "50%", height: "100%", display: "flex", flexDirection: "column" }}>
          <IssueDetailView
            issue={issue}
            hasAnyCode={hasAnyCode ?? false}
            onViewCode={() => setView("code")}
          />
        </div>

        {/* Page 2: Code detail */}
        <div style={{ width: "50%", height: "100%", display: "flex", flexDirection: "column" }}>
          {hasAnyCode && <CodeDetailView issue={issue} onBack={() => setView("detail")} />}
        </div>
      </div>
    </aside>
  );
}

/* ════════════════════════════════════════════════════════════════════════════
   Page 1: Issue Detail View
   ════════════════════════════════════════════════════════════════════════════ */
function IssueDetailView({
  issue,
  hasAnyCode,
  onViewCode,
}: {
  readonly issue: EnrichedIssue;
  readonly hasAnyCode: boolean;
  readonly onViewCode: () => void;
}) {
  const { t } = useTranslation();
  const setActiveIssueId = useHealthCheckStore((s) => s.setActiveIssueId);
  const issueFixStatuses = useHealthCheckStore((s) => s.issueFixStatuses);
  const openFile = useAppStore((s) => s.openFile);
  const workspacePath = useWorkspaceStore((s) => s.activeWorkspace?.path ?? "");
  const { fixSingleIssue, ignoreIssue, restoreIssue } = useHealthFix();

  const severity = SEVERITY_CONFIG[issue.severity];
  const dimColor = DIMENSION_COLORS[issue.dimensionId] ?? "#888";
  const fixStatus = issueFixStatuses[issue.id] ?? "pending";
  const hasFiles = issue.files && issue.files.length > 0;
  const folderPath = hasFiles ? getCommonFolder(issue.files!, workspacePath) : null;

  return (
    <>
      {/* Header — design Ax9oA */}
      <div
        className="flex items-center shrink-0"
        style={{
          height: 48,
          padding: "0 16px",
          borderBottom: "1px solid var(--color-border)",
          justifyContent: "space-between",
        }}
      >
        <div className="flex items-center" style={{ gap: 8 }}>
          <div
            style={{
              width: 8,
              height: 8,
              borderRadius: 4,
              backgroundColor: severity.color,
              flexShrink: 0,
            }}
          />

          <span
            style={{
              fontSize: 14,
              fontWeight: 600,
              color: "var(--color-foreground)",
              fontFamily: "Inter, sans-serif",
            }}
          >
            {t("workspace.healthCheck.detail.issueDetail", "问题详情")}
          </span>
        </div>
        <button onClick={() => setActiveIssueId(null)} style={ICON_BTN_STYLE}>
          <X size={16} />
        </button>
      </div>

      {/* Scrollable body — design ZhASB */}
      <div className="flex flex-col flex-1 overflow-y-auto" style={{ padding: 16, gap: 16 }}>
        {/* Description — design FVxoY */}
        <div className="flex flex-col" style={{ gap: 6 }}>
          <SectionLabel>{t("workspace.healthCheck.detail.description", "问题描述")}</SectionLabel>
          <p
            style={{
              fontSize: 13,
              color: "var(--color-foreground)",
              lineHeight: 1.5,
              margin: 0,
              fontFamily: "Inter, sans-serif",
            }}
          >
            {issue.message}
          </p>
        </div>

        {/* Meta cards — design chlc4: gap:12 */}
        <div className="flex" style={{ gap: 12 }}>
          <div
            className="flex flex-col items-center flex-1"
            style={{ padding: "10px 12px", borderRadius: 8, backgroundColor: severity.bg, gap: 4 }}
          >
            <span
              style={{
                fontSize: 10,
                color: "var(--color-text-placeholder)",
                fontFamily: "Inter, sans-serif",
                fontWeight: 500,
              }}
            >
              {t("workspace.healthCheck.detail.severityLabel", "严重程度")}
            </span>
            <span
              style={{
                fontSize: 12,
                fontWeight: 600,
                color: severity.color,
                fontFamily: "Inter, sans-serif",
              }}
            >
              {t(severity.labelKey, severity.fallback)}
            </span>
          </div>
          <div
            className="flex flex-col items-center flex-1"
            style={{
              padding: "10px 12px",
              borderRadius: 8,
              backgroundColor: `${dimColor}10`,
              gap: 4,
            }}
          >
            <span
              style={{
                fontSize: 10,
                color: "var(--color-text-placeholder)",
                fontFamily: "Inter, sans-serif",
                fontWeight: 500,
              }}
            >
              {t("workspace.healthCheck.detail.dimensionLabel", "所属维度")}
            </span>
            <span
              style={{
                fontSize: 12,
                fontWeight: 600,
                color: dimColor,
                fontFamily: "Inter, sans-serif",
              }}
            >
              {issue.dimensionLabel}
            </span>
          </div>
        </div>

        {/* File section — design qTYWx */}
        {(hasFiles || issue.file) && (
          <div className="flex flex-col" style={{ gap: 6 }}>
            <SectionLabel>
              {t("workspace.healthCheck.detail.involvedFiles", "涉及文件")}
            </SectionLabel>
            {folderPath && (
              <div className="flex items-center" style={{ gap: 6, paddingBottom: 4 }}>
                <Folder size={13} style={{ color: "#F59E0B80", flexShrink: 0 }} />
                <span
                  style={{
                    fontSize: 11,
                    color: "var(--color-text-placeholder)",
                    fontFamily: "Inter, sans-serif",
                  }}
                >
                  {folderPath.replace(/\//g, " / ")}
                </span>
              </div>
            )}
            <div
              style={{ borderRadius: 8, backgroundColor: "var(--color-surface)", padding: "4px 0" }}
            >
              {hasFiles
                ? issue.files!.map((f, idx) => (
                    <FileRow
                      key={idx}
                      fileRef={f}
                      workspacePath={workspacePath}
                      folderPrefix={folderPath}
                    />
                  ))
                : issue.file && (
                    <FileRow
                      fileRef={{ path: issue.file }}
                      workspacePath={workspacePath}
                      folderPrefix={null}
                    />
                  )}
            </div>
          </div>
        )}

        {/* Code preview — design BN4IN */}
        {(() => {
          // Prefer issue-level codeSnippet; fallback to first file's codeSnippet
          const previewSnippet =
            issue.codeSnippet ??
            (hasFiles ? issue.files!.find((f) => f.codeSnippet)?.codeSnippet : null);
          const previewHighlight = issue.codeSnippet
            ? issue.highlightLines
            : hasFiles
              ? issue.files!.find((f) => f.codeSnippet)?.highlightLines
              : null;
          const previewLineStart = issue.codeSnippet
            ? issue.lineStart
            : hasFiles
              ? issue.files!.find((f) => f.codeSnippet)?.lineStart
              : null;
          if (!previewSnippet) return null;
          return (
            <div className="flex flex-col" style={{ gap: 6 }}>
              <div className="flex items-center" style={{ justifyContent: "space-between" }}>
                <SectionLabel>
                  {t("workspace.healthCheck.detail.relatedCode", "相关代码")}
                </SectionLabel>
                {hasAnyCode && (
                  <button
                    onClick={onViewCode}
                    className="flex items-center"
                    style={VIEW_ALL_BTN_STYLE}
                  >
                    <span>{t("workspace.healthCheck.detail.viewAll", "查看全部")}</span>
                    <Maximize2 size={10} />
                  </button>
                )}
              </div>
              <CodeBlock
                snippet={previewSnippet}
                highlightLines={previewHighlight}
                lineStart={previewLineStart}
              />
            </div>
          );
        })()}

        {/* Suggestion — design oKQSw */}
        {issue.suggestion && (
          <div className="flex flex-col" style={{ gap: 6 }}>
            <SectionLabel>{t("workspace.healthCheck.suggestionLabel", "修复建议")}</SectionLabel>
            <div
              style={{
                fontSize: 12,
                color: "var(--color-muted-foreground)",
                lineHeight: 1.5,
                fontFamily: "Inter, sans-serif",
              }}
            >
              <MarkdownRenderer content={issue.suggestion} variant="compact" />
            </div>
          </div>
        )}
      </div>

      {/* Footer actions — design zn27U */}
      <div
        className="flex flex-col shrink-0"
        style={{ padding: "12px 16px", borderTop: "1px solid var(--color-border-light)", gap: 8 }}
      >
        <button
          onClick={() => fixSingleIssue(issue)}
          className="flex items-center justify-center"
          style={{
            width: "100%",
            height: 36,
            gap: 6,
            borderRadius: 8,
            border: "none",
            backgroundColor: "#30D158",
            color: "#FFFFFF",
            fontSize: 13,
            fontWeight: 600,
            cursor: "pointer",
            fontFamily: "Inter, sans-serif",
          }}
        >
          <Wrench size={14} />
          <span>{t("workspace.healthCheck.detail.aiFix", "AI 自动修复")}</span>
        </button>
        <div className="flex" style={{ gap: 8 }}>
          <button
            onClick={() =>
              fixStatus === "ignored" ? restoreIssue(issue.id) : ignoreIssue(issue.id)
            }
            className="flex items-center justify-center flex-1"
            style={{
              height: 32,
              gap: 5,
              borderRadius: 8,
              border: "none",
              backgroundColor: "var(--color-surface-raised)",
              color: fixStatus === "ignored" ? "#FF9F0A" : "var(--color-muted)",
              fontSize: 12,
              fontWeight: 500,
              cursor: "pointer",
              fontFamily: "Inter, sans-serif",
            }}
          >
            {fixStatus === "ignored" ? <Eye size={12} /> : <EyeOff size={12} />}
            <span>
              {fixStatus === "ignored"
                ? t("workspace.healthCheck.detail.restore", "恢复")
                : t("workspace.healthCheck.detail.ignore", "忽略此项")}
            </span>
          </button>
          <button
            onClick={() => {
              if (!issue.file) return;
              const resolved = resolveFilePath(issue.file, workspacePath);
              openFile(resolved);
            }}
            className="flex items-center justify-center flex-1"
            style={{
              height: 32,
              gap: 5,
              borderRadius: 8,
              border: "none",
              backgroundColor: "var(--color-surface-raised)",
              color: "var(--color-muted)",
              fontSize: 12,
              fontWeight: 500,
              cursor: "pointer",
              fontFamily: "Inter, sans-serif",
            }}
          >
            <Eye size={12} />
            <span>{t("workspace.healthCheck.detail.preview", "预览变更")}</span>
          </button>
        </div>
      </div>
    </>
  );
}

/* ════════════════════════════════════════════════════════════════════════════
   Page 2: Code Detail View — design U048q
   ════════════════════════════════════════════════════════════════════════════ */
function CodeDetailView({
  issue,
  onBack,
}: {
  readonly issue: EnrichedIssue;
  readonly onBack: () => void;
}) {
  const { t } = useTranslation();
  const workspacePath = useWorkspaceStore((s) => s.activeWorkspace?.path ?? "");
  const filesWithCode = (issue.files ?? []).filter((f) => f.codeSnippet);
  const fileCount = issue.files?.length ?? 0;

  return (
    <>
      {/* Header — design DNMm4 */}
      <div
        className="flex items-center shrink-0"
        style={{
          height: 48,
          padding: "0 16px",
          backgroundColor: "var(--color-card)",
          borderBottom: "1px solid var(--color-border)",
          justifyContent: "space-between",
        }}
      >
        {/* Back button */}
        <button
          onClick={onBack}
          className="flex items-center"
          style={{
            gap: 6,
            border: "none",
            backgroundColor: "transparent",
            color: "var(--color-text-placeholder)",
            cursor: "pointer",
            padding: 0,
            fontFamily: "Inter, sans-serif",
          }}
        >
          <ArrowLeft size={14} />
          <span style={{ fontSize: 13 }}>{t("workspace.healthCheck.detail.back", "返回")}</span>
        </button>

        {/* Title area — design Y6tBf */}
        <div className="flex items-center" style={{ gap: 8 }}>
          <Code size={14} style={{ color: "#0A84FF" }} />
          <span
            style={{
              fontSize: 14,
              fontWeight: 600,
              color: "var(--color-foreground)",
              fontFamily: "Inter, sans-serif",
            }}
          >
            {t("workspace.healthCheck.detail.relatedCode", "相关代码")}
          </span>
          <div
            style={{
              padding: "2px 6px",
              borderRadius: 4,
              backgroundColor: "var(--color-surface-alt)",
            }}
          >
            <span
              style={{
                fontSize: 10,
                fontWeight: 500,
                color: "var(--color-text-placeholder)",
                fontFamily: "Inter, sans-serif",
              }}
            >
              {fileCount} {t("workspace.healthCheck.detail.filesCount", "个文件")}
            </span>
          </div>
        </div>
      </div>

      {/* Scroll body — design bq8OL */}
      <div
        className="flex flex-col flex-1 overflow-y-auto"
        style={{ padding: "16px 20px", gap: 20 }}
      >
        {filesWithCode.map((fileRef, idx) => (
          <FileCodeBlock
            key={idx}
            fileRef={fileRef}
            workspacePath={workspacePath}
            issueSeverity={issue.severity}
          />
        ))}

        {/* Show files without code as a simple list if any */}
        {issue.files && issue.files.some((f) => !f.codeSnippet) && (
          <div className="flex flex-col" style={{ gap: 6 }}>
            {issue.files
              .filter((f) => !f.codeSnippet)
              .map((f, idx) => {
                const relPath = toRelativePath(f.path, workspacePath);
                const fileName = relPath.split("/").pop() ?? relPath;
                return (
                  <div
                    key={idx}
                    className="flex items-center"
                    style={{
                      gap: 8,
                      padding: "6px 12px",
                      borderRadius: 8,
                      backgroundColor: "var(--color-surface)",
                      border: "1px solid var(--color-border-subtle)",
                    }}
                  >
                    <File size={12} style={{ color: "#10B981", flexShrink: 0 }} />
                    <span
                      style={{
                        fontSize: 12,
                        color: "var(--color-muted-foreground)",
                        fontFamily: "Inter, sans-serif",
                        fontWeight: 500,
                      }}
                    >
                      {fileName}
                    </span>
                    {f.line != null && (
                      <span
                        style={{
                          fontSize: 12,
                          color: "var(--color-text-placeholder)",
                          fontFamily: "Inter, sans-serif",
                        }}
                      >
                        :{f.line}
                      </span>
                    )}
                  </div>
                );
              })}
          </div>
        )}
      </div>
    </>
  );
}

/* ── FileCodeBlock — one code block per file (design Zjcce) ── */
function FileCodeBlock({
  fileRef,
  workspacePath,
  issueSeverity,
}: {
  readonly fileRef: FileRef;
  readonly workspacePath: string;
  readonly issueSeverity: "critical" | "warning" | "info";
}) {
  const { t } = useTranslation();
  const relPath = toRelativePath(fileRef.path, workspacePath);
  const fileName = relPath.split("/").pop() ?? relPath;
  const lines = (fileRef.codeSnippet ?? "").split("\n");
  const hlSet = new Set(fileRef.highlightLines ?? []);
  const hlCount = fileRef.highlightLines?.length ?? 0;

  // Color per severity
  const sevColor =
    issueSeverity === "critical" ? "#FF453A" : issueSeverity === "warning" ? "#F59E0B" : "#10B981";
  const hlTextColor =
    issueSeverity === "critical" ? "#FF6B6B" : issueSeverity === "warning" ? "#F59E0B" : "#10B981";
  const hlBg =
    issueSeverity === "critical"
      ? "#FF453A12"
      : issueSeverity === "warning"
        ? "#F59E0B10"
        : "#10B98110";
  const hlBorderColor =
    issueSeverity === "critical"
      ? "#FF453A30"
      : issueSeverity === "warning"
        ? "#F59E0B30"
        : "#10B98130";

  // Badge text — i18n
  const severityBadgeLabel =
    issueSeverity === "critical"
      ? t("workspace.healthCheck.badge.issues", {
          count: hlCount,
          defaultValue: "{{count}} 个问题",
        })
      : issueSeverity === "warning"
        ? t("workspace.healthCheck.badge.warnings", {
            count: hlCount,
            defaultValue: "{{count}} 个警告",
          })
        : t("workspace.healthCheck.badge.suggestions", {
            count: hlCount,
            defaultValue: "{{count}} 个建议",
          });
  const badgeText =
    hlCount > 0 ? severityBadgeLabel : t("workspace.healthCheck.badge.reference", "参考");
  const badgeColor = hlCount > 0 ? sevColor : "#10B981";
  const badgeBg = hlCount > 0 ? `${sevColor}20` : "#10B98120";

  return (
    <div
      style={{
        borderRadius: 8,
        backgroundColor: "var(--color-surface)",
        border: "1px solid var(--color-border-subtle)",
        overflow: "hidden",
      }}
    >
      {/* Block header — design Q2gQX */}
      <div
        className="flex items-center"
        style={{
          height: 34,
          padding: "0 12px",
          justifyContent: "space-between",
          borderBottom: "1px solid var(--color-border-subtle)",
        }}
      >
        <div className="flex items-center" style={{ gap: 6 }}>
          <FileCode size={12} style={{ color: "#0A84FF" }} />
          <span
            style={{
              fontSize: 12,
              fontWeight: 500,
              color: "var(--color-muted-foreground)",
              fontFamily: "Inter, sans-serif",
            }}
          >
            {fileName}
          </span>
        </div>
        <div style={{ padding: "2px 6px", borderRadius: 4, backgroundColor: badgeBg }}>
          <span
            style={{
              fontSize: 10,
              fontWeight: 500,
              color: badgeColor,
              fontFamily: "Inter, sans-serif",
            }}
          >
            {badgeText}
          </span>
        </div>
      </div>

      {/* Code body — design 2mzem */}
      {(() => {
        const maxLn =
          fileRef.lineStart != null ? fileRef.lineStart + lines.length - 1 : lines.length;
        const gw = String(maxLn).length * 8 + 8;
        return (
          <div
            style={{
              padding: "10px 14px",
              display: "flex",
              flexDirection: "column",
              gap: 2,
              overflowX: "auto",
            }}
          >
            {lines.map((line, idx) => {
              const lineNum = extractLineNumber(line, fileRef.lineStart, idx);
              const isHighlighted = lineNum != null && hlSet.has(lineNum);
              const displayNum =
                lineNum ?? (fileRef.lineStart != null ? fileRef.lineStart + idx : idx + 1);

              if (isHighlighted) {
                return (
                  <div
                    key={idx}
                    className="flex items-center"
                    style={{
                      borderRadius: 3,
                      backgroundColor: hlBg,
                      padding: "2px 6px",
                      borderLeft: `2px solid ${hlBorderColor}`,
                    }}
                  >
                    <span
                      style={{
                        width: gw,
                        fontSize: 10,
                        color: `${hlTextColor}60`,
                        fontFamily: "Inter, sans-serif",
                        textAlign: "right",
                        paddingRight: 8,
                        flexShrink: 0,
                        userSelect: "none",
                      }}
                    >
                      {displayNum}
                    </span>
                    <span
                      style={{
                        fontSize: 11,
                        color: hlTextColor,
                        fontFamily: "Inter, sans-serif",
                        whiteSpace: "pre",
                      }}
                    >
                      {line}
                    </span>
                  </div>
                );
              }

              // Comment lines (// or #)
              const isComment = /^\s*(\/\/|#)/.test(line);
              const textColor = !line.trim()
                ? "var(--color-text-placeholder)"
                : isComment
                  ? "var(--color-text-placeholder)"
                  : "var(--color-muted-foreground)";

              return (
                <div key={idx} className="flex items-center">
                  <span
                    style={{
                      width: gw,
                      fontSize: 10,
                      color: "var(--color-text-placeholder)",
                      fontFamily: "Inter, sans-serif",
                      textAlign: "right",
                      paddingRight: 8,
                      flexShrink: 0,
                      userSelect: "none",
                    }}
                  >
                    {displayNum}
                  </span>
                  <span
                    style={{
                      fontSize: 11,
                      color: textColor,
                      fontFamily: "Inter, sans-serif",
                      whiteSpace: "pre",
                    }}
                  >
                    {line || " "}
                  </span>
                </div>
              );
            })}
          </div>
        );
      })()}
    </div>
  );
}

/* ════════════════════════════════════════════════════════════════════════════
   Shared components
   ════════════════════════════════════════════════════════════════════════════ */

function SectionLabel({ children }: { readonly children: React.ReactNode }) {
  return (
    <span
      style={{
        fontSize: 11,
        fontWeight: 500,
        color: "var(--color-text-placeholder)",
        display: "block",
        fontFamily: "Inter, sans-serif",
      }}
    >
      {children}
    </span>
  );
}

function FileRow({
  fileRef,
  workspacePath,
  folderPrefix,
}: {
  readonly fileRef: FileRef;
  readonly workspacePath: string;
  readonly folderPrefix: string | null;
}) {
  const [copied, setCopied] = useState(false);
  const relPath = toRelativePath(fileRef.path, workspacePath);
  let displayName = relPath;
  if (folderPrefix && relPath.startsWith(folderPrefix + "/")) {
    displayName = relPath.slice(folderPrefix.length + 1);
  }

  const handleCopy = async () => {
    const resolved = resolveFilePath(fileRef.path, workspacePath);
    try {
      await navigator.clipboard.writeText(resolved);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      useToastStore.getState().addToast("error", "Failed to copy path");
    }
  };

  const CopyIcon = copied ? Check : Copy;
  const iconColor = copied ? "#10B981" : "var(--color-text-placeholder)";

  return (
    <button
      onClick={handleCopy}
      className="flex items-center native-css-hover"
      style={
        {
          width: "100%",
          height: 30,
          padding: "0 12px",
          borderRadius: 4,
          border: "none",
          backgroundColor: "transparent",
          cursor: "pointer",
          justifyContent: "space-between",
          "--native-hover-bg-color": "var(--color-surface-alt)",
        } as React.CSSProperties
      }
    >
      <div className="flex items-center" style={{ gap: 8, minWidth: 0 }}>
        <FileCode size={13} style={{ color: "var(--color-text-placeholder)", flexShrink: 0 }} />
        <span
          style={{
            fontSize: 12,
            color: "var(--color-muted-foreground)",
            fontFamily: "Inter, sans-serif",
          }}
        >
          {displayName}
        </span>
        {fileRef.line != null && (
          <span
            style={{
              fontSize: 12,
              color: "var(--color-text-placeholder)",
              fontFamily: "Inter, sans-serif",
            }}
          >
            :{fileRef.line}
          </span>
        )}
      </div>
      <CopyIcon size={11} style={{ color: iconColor, flexShrink: 0, transition: "color 0.2s" }} />
    </button>
  );
}

/* ── CodeBlock — small preview (design s2xZY) ── */
function CodeBlock({
  snippet,
  highlightLines,
  lineStart,
}: {
  readonly snippet: string;
  readonly highlightLines?: ReadonlyArray<number> | null;
  readonly lineStart?: number | null;
}) {
  const lines = snippet.split("\n");
  const hlSet = new Set(highlightLines ?? []);

  // Compute max line number width for alignment
  const maxLineNum = lineStart != null ? lineStart + lines.length - 1 : lines.length;
  const gutterWidth = String(maxLineNum).length * 8 + 8;

  return (
    <div
      style={{
        borderRadius: 8,
        backgroundColor: "var(--color-surface-alt)",
        padding: 12,
        display: "flex",
        flexDirection: "column",
        gap: 2,
        overflow: "hidden",
        overflowX: "auto",
      }}
    >
      {lines.map((line, idx) => {
        const lineNum = extractLineNumber(line, lineStart, idx);
        const isHighlighted = lineNum != null && hlSet.has(lineNum);
        const displayNum = lineNum ?? (lineStart != null ? lineStart + idx : idx + 1);

        return isHighlighted ? (
          <div
            key={idx}
            className="flex"
            style={{ borderRadius: 3, backgroundColor: "#FF453A15", padding: "2px 0" }}
          >
            <span
              style={{
                width: gutterWidth,
                fontSize: 10,
                color: "#FF453A60",
                fontFamily: "Inter, sans-serif",
                textAlign: "right",
                paddingRight: 8,
                flexShrink: 0,
                userSelect: "none",
              }}
            >
              {displayNum}
            </span>
            <span
              style={{
                fontSize: 11,
                color: "#FF453A",
                fontFamily: "Inter, sans-serif",
                whiteSpace: "pre",
              }}
            >
              {line}
            </span>
          </div>
        ) : (
          <div key={idx} className="flex">
            <span
              style={{
                width: gutterWidth,
                fontSize: 10,
                color: "var(--color-text-placeholder)",
                fontFamily: "Inter, sans-serif",
                textAlign: "right",
                paddingRight: 8,
                flexShrink: 0,
                userSelect: "none",
              }}
            >
              {displayNum}
            </span>
            <span
              style={{
                fontSize: 11,
                color: "var(--color-text-placeholder)",
                fontFamily: "Inter, sans-serif",
                whiteSpace: "pre",
              }}
            >
              {line}
            </span>
          </div>
        );
      })}
    </div>
  );
}

/* ── Styles ── */
const ICON_BTN_STYLE: React.CSSProperties = {
  border: "none",
  backgroundColor: "transparent",
  color: "var(--color-text-placeholder)",
  cursor: "pointer",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  padding: 0,
};

const VIEW_ALL_BTN_STYLE: React.CSSProperties = {
  gap: 4,
  padding: "3px 8px",
  borderRadius: 4,
  border: "none",
  backgroundColor: "#0A84FF15",
  color: "#0A84FF",
  fontSize: 10,
  fontWeight: 500,
  cursor: "pointer",
  fontFamily: "Inter, sans-serif",
};

/* ── Helpers ── */

/** Normalize MSYS/Git Bash drive paths to Windows paths (e.g. /f/... → F:/...). */
function normalizeMsysPathLocal(p: string): string {
  const msys2 = p.match(/^\/\/([a-zA-Z])\/(.*)/);
  if (msys2) return `${msys2[1].toUpperCase()}:/${msys2[2]}`;
  const msys1 = p.match(/^\/([a-zA-Z])\/(.*)/);
  if (msys1) return `${msys1[1].toUpperCase()}:/${msys1[2]}`;
  return p;
}

/** Resolve a possibly-relative file path to an absolute one using the workspace root. */
function resolveFilePath(filePath: string, workspacePath: string): string {
  if (!filePath) return filePath;

  // Normalize MSYS/Git Bash paths first (e.g. /f/project/... → F:/project/...)
  let resolved = normalizeMsysPathLocal(filePath);

  // Already absolute (Windows drive letter)
  if (/^[A-Za-z]:[\\/]/.test(resolved)) {
    return resolved;
  }

  // Strip leading slash — on Windows a bare "/src/..." is relative, not absolute
  if (resolved.startsWith("/")) {
    resolved = resolved.slice(1);
  }

  if (!workspacePath) return resolved;
  const sep = workspacePath.includes("\\") ? "\\" : "/";
  const base = workspacePath.replace(/[\\/]+$/, "");
  return `${base}${sep}${resolved.replace(/\//g, sep)}`;
}

function extractLineNumber(
  line: string,
  lineStart: number | null | undefined,
  idx: number,
): number | null {
  const match = line.match(/^\s*(\d+)\s/);
  if (match) return parseInt(match[1], 10);
  if (lineStart != null) return lineStart + idx;
  return null;
}

function getCommonFolder(files: ReadonlyArray<FileRef>, workspacePath: string): string | null {
  if (files.length === 0) return null;
  const paths = files.map((f) => toRelativePath(f.path, workspacePath)).filter((p) => p !== "—");
  if (paths.length === 0) return null;

  const parts0 = paths[0].split("/");
  parts0.pop();
  if (parts0.length === 0) return null;

  let common = parts0;
  for (let i = 1; i < paths.length; i++) {
    const parts = paths[i].split("/");
    parts.pop();
    const newCommon: string[] = [];
    for (let j = 0; j < Math.min(common.length, parts.length); j++) {
      if (common[j] === parts[j]) newCommon.push(common[j]);
      else break;
    }
    common = newCommon;
    if (common.length === 0) return null;
  }
  return common.length > 0 ? common.join("/") : null;
}
