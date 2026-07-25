import { X, GitCommit, User, Clock, FileText, Plus, Minus } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { CommitDetail } from "@/stores/git-store";

// ── Helpers ──────────────────────────────────────────────────────────

function formatTimestamp(timestamp: number): string {
  const date = new Date(timestamp * 1000);
  const yyyy = date.getFullYear();
  const mm = String(date.getMonth() + 1).padStart(2, "0");
  const dd = String(date.getDate()).padStart(2, "0");
  const hh = String(date.getHours()).padStart(2, "0");
  const min = String(date.getMinutes()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd} ${hh}:${min}`;
}

function getStatusColor(status: string): string {
  switch (status) {
    case "added":
      return "#22C55E";
    case "deleted":
      return "#EF4444";
    case "modified":
      return "#E5C07B";
    case "renamed":
      return "#3B82F6";
    case "copied":
      return "#A855F7";
    default:
      return "var(--color-muted)";
  }
}

function getStatusLabel(status: string): string {
  switch (status) {
    case "added":
      return "A";
    case "deleted":
      return "D";
    case "modified":
      return "M";
    case "renamed":
      return "R";
    case "copied":
      return "C";
    default:
      return "?";
  }
}

// ── File Change Row ──────────────────────────────────────────────────

function FileChangeRow({
  path,
  oldPath,
  status,
  additions,
  deletions,
}: {
  readonly path: string;
  readonly oldPath: string | null;
  readonly status: string;
  readonly additions: number;
  readonly deletions: number;
}) {
  const fileName = path.split("/").pop() ?? path;
  const dir = path.slice(0, path.length - fileName.length);
  const statusColor = getStatusColor(status);

  return (
    <div
      className="flex items-center group transition-colors native-css-hover"
      style={
        {
          padding: "4px 12px",
          gap: 8,
          borderRadius: 4,
          "--native-hover-bg-color": "rgba(var(--hover-overlay-rgb),0.03)",
        } as React.CSSProperties
      }
    >
      {/* Status badge */}
      <span
        className="text-[9px] font-bold font-mono shrink-0 flex items-center justify-center"
        style={{
          width: 16,
          height: 16,
          borderRadius: 3,
          backgroundColor: `${statusColor}20`,
          color: statusColor,
        }}
      >
        {getStatusLabel(status)}
      </span>

      {/* File path */}
      <div className="flex-1 min-w-0 flex items-baseline" style={{ gap: 0 }}>
        {dir && (
          <span className="text-[11px] font-mono truncate" style={{ color: "var(--color-muted)" }}>
            {dir}
          </span>
        )}
        <span
          className="text-[11px] font-mono shrink-0"
          style={{ color: "var(--color-muted-foreground)" }}
        >
          {fileName}
        </span>
        {status === "renamed" && oldPath && (
          <span className="text-[10px] font-mono ml-1" style={{ color: "var(--color-muted)" }}>
            {" ← " + oldPath.split("/").pop()}
          </span>
        )}
      </div>

      {/* Stats */}
      <div className="flex items-center shrink-0" style={{ gap: 6 }}>
        {additions > 0 && (
          <span
            className="flex items-center text-[10px] font-mono"
            style={{ gap: 1, color: "#22C55E" }}
          >
            <Plus size={9} />
            {additions}
          </span>
        )}
        {deletions > 0 && (
          <span
            className="flex items-center text-[10px] font-mono"
            style={{ gap: 1, color: "#EF4444" }}
          >
            <Minus size={9} />
            {deletions}
          </span>
        )}
      </div>
    </div>
  );
}

// ── Commit Detail View ───────────────────────────────────────────────

interface GitCommitDetailProps {
  readonly detail: CommitDetail;
  readonly onClose: () => void;
}

export function GitCommitDetail({ detail, onClose }: GitCommitDetailProps) {
  const { t } = useTranslation();
  const firstLine = detail.message.split("\n")[0];
  const bodyLines = detail.message.split("\n").slice(1).join("\n").trim();

  return (
    <div className="flex flex-col h-full overflow-hidden">
      {/* Header */}
      <div
        className="flex items-center justify-between shrink-0"
        style={{
          height: 40,
          padding: "0 12px",
          borderBottom: "1px solid var(--color-border)",
        }}
      >
        <div className="flex items-center" style={{ gap: 6 }}>
          <GitCommit size={14} style={{ color: "#A855F7" }} />
          <span
            className="text-[12px] font-semibold font-sans"
            style={{ color: "var(--color-foreground)" }}
          >
            {t("git.detail.title")}
          </span>
        </div>
        <button
          onClick={onClose}
          className="flex items-center justify-center rounded transition-colors hover:bg-hover-overlay/[0.06]"
          style={{ width: 24, height: 24 }}
        >
          <X size={13} className="text-muted" />
        </button>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto min-h-0" style={{ padding: "12px 0" }}>
        {/* Commit message */}
        <div style={{ padding: "0 12px", marginBottom: 12 }}>
          <p
            className="text-[13px] font-sans font-semibold"
            style={{
              color: "var(--color-foreground)",
              margin: 0,
              lineHeight: 1.5,
              wordBreak: "break-word",
            }}
          >
            {firstLine}
          </p>
          {bodyLines && (
            <p
              className="text-[11px] font-sans"
              style={{
                color: "var(--color-muted-foreground)",
                margin: "6px 0 0",
                lineHeight: 1.5,
                whiteSpace: "pre-wrap",
                wordBreak: "break-word",
              }}
            >
              {bodyLines}
            </p>
          )}
        </div>

        {/* Meta info */}
        <div
          className="flex flex-col"
          style={{
            padding: "8px 12px",
            gap: 6,
            borderTop: "1px solid var(--color-border-light)",
            borderBottom: "1px solid var(--color-border-light)",
          }}
        >
          {/* SHA */}
          <div className="flex items-center" style={{ gap: 6 }}>
            <GitCommit size={11} style={{ color: "var(--color-muted)" }} />
            <span className="text-[10px] font-mono" style={{ color: "#A855F7" }}>
              {detail.full_id}
            </span>
          </div>
          {/* Author */}
          <div className="flex items-center" style={{ gap: 6 }}>
            <User size={11} style={{ color: "var(--color-muted)" }} />
            <span
              className="text-[11px] font-sans"
              style={{ color: "var(--color-muted-foreground)" }}
            >
              {detail.author}
              {detail.email && (
                <span style={{ color: "var(--color-muted)" }}> &lt;{detail.email}&gt;</span>
              )}
            </span>
          </div>
          {/* Time */}
          <div className="flex items-center" style={{ gap: 6 }}>
            <Clock size={11} style={{ color: "var(--color-muted)" }} />
            <span
              className="text-[11px] font-sans"
              style={{ color: "var(--color-muted-foreground)" }}
            >
              {formatTimestamp(detail.timestamp)}
            </span>
          </div>
          {/* Parents */}
          {detail.parent_ids.length > 0 && (
            <div className="flex items-center" style={{ gap: 6 }}>
              <GitCommit size={11} style={{ color: "var(--color-muted)" }} />
              <span className="text-[10px] font-mono" style={{ color: "var(--color-muted)" }}>
                {t("git.detail.parents")}: {detail.parent_ids.join(", ")}
              </span>
            </div>
          )}
        </div>

        {/* Changed files */}
        <div style={{ marginTop: 8 }}>
          <div className="flex items-center justify-between" style={{ padding: "4px 12px" }}>
            <div className="flex items-center" style={{ gap: 6 }}>
              <FileText size={11} style={{ color: "var(--color-muted)" }} />
              <span
                className="text-[11px] font-semibold font-sans"
                style={{ color: "var(--color-muted)" }}
              >
                {t("git.detail.changedFiles")}
              </span>
              <span
                className="text-[9px] font-bold font-mono"
                style={{
                  color: "#A855F7",
                  backgroundColor: "rgba(var(--theme-accent-rgb),0.125)",
                  borderRadius: 8,
                  padding: "1px 5px",
                }}
              >
                {detail.files.length}
              </span>
            </div>
            <div className="flex items-center" style={{ gap: 8 }}>
              <span
                className="flex items-center text-[10px] font-mono"
                style={{ gap: 2, color: "#22C55E" }}
              >
                <Plus size={9} />
                {detail.total_additions}
              </span>
              <span
                className="flex items-center text-[10px] font-mono"
                style={{ gap: 2, color: "#EF4444" }}
              >
                <Minus size={9} />
                {detail.total_deletions}
              </span>
            </div>
          </div>

          <div className="flex flex-col" style={{ gap: 1, marginTop: 4 }}>
            {detail.files.map((file) => (
              <FileChangeRow
                key={file.path}
                path={file.path}
                oldPath={file.old_path}
                status={file.status}
                additions={file.additions}
                deletions={file.deletions}
              />
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
