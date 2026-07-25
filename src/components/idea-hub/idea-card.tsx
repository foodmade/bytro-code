import { useCallback, useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { Eye, Pencil, CircleCheck, Trash2, Check, MessageCircle } from "lucide-react";
import type { IdeaSummary, CheckListItem } from "@/stores";
import { stripMarkdown } from "@/lib/notifications";

/* ------------------------------------------------------------------ */
/*  Priority config                                                    */
/* ------------------------------------------------------------------ */

const PRIORITY_CONFIG: Record<string, { color: string; bg: string }> = {
  high: { color: "#EF4444", bg: "#EF444418" },
  medium: { color: "#F59E0B", bg: "#F59E0B18" },
  low: { color: "#6B7280", bg: "#6B728018" },
};

/* ------------------------------------------------------------------ */
/*  Tag colors                                                         */
/* ------------------------------------------------------------------ */

const TAG_PALETTE = [
  { color: "#A855F7", bg: "rgba(var(--theme-accent-rgb),0.071)" },
  { color: "#3B82F6", bg: "#3B82F612" },
  { color: "#22C55E", bg: "#22C55E12" },
  { color: "#F59E0B", bg: "#F59E0B12" },
  { color: "#EF4444", bg: "#EF444412" },
];

function getTagStyle(_tag: string, idx: number): { color: string; bg: string } {
  return TAG_PALETTE[idx % TAG_PALETTE.length];
}

/* ------------------------------------------------------------------ */
/*  Context menu item                                                  */
/* ------------------------------------------------------------------ */

function ContextMenuItem({
  icon,
  label,
  color,
  onClick,
}: {
  readonly icon: React.ReactNode;
  readonly label: string;
  readonly color: string;
  readonly onClick: () => void;
}) {
  return (
    <div
      role="menuitem"
      onClick={(e) => {
        e.stopPropagation();
        onClick();
      }}
      className="flex items-center cursor-pointer native-css-hover"
      style={
        {
          height: 36,
          padding: "0 12px",
          gap: 10,
          borderRadius: 6,
          backgroundColor: "transparent",
          transition: "background-color 0.1s ease",
          "--native-hover-bg-color": "var(--color-border-subtle)",
        } as React.CSSProperties
      }
    >
      {icon}
      <span style={{ fontSize: 13, color, userSelect: "none" }}>{label}</span>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Context menu                                                       */
/* ------------------------------------------------------------------ */

function IdeaContextMenu({
  x,
  y,
  idea,
  onClose,
  onSelect,
  onEdit,
  onGoToDiscussion,
  onComplete,
  onDelete,
  t,
}: {
  readonly x: number;
  readonly y: number;
  readonly idea: IdeaSummary;
  readonly onClose: () => void;
  readonly onSelect: (id: string) => void;
  readonly onEdit?: (id: string) => void;
  readonly onGoToDiscussion?: (id: string) => void;
  readonly onComplete?: (id: string) => void;
  readonly onDelete: (id: string) => void;
  readonly t: (key: string) => string;
}) {
  /* -- Viewport clamp ------------------------------------------------ */
  const menuW = 192;
  const showDiscussion = !!onGoToDiscussion && idea.status !== "building" && idea.status !== "done";
  const showComplete = !!onComplete;
  const itemCount = 3 + (showDiscussion ? 1 : 0) + (showComplete ? 1 : 0); // viewDetail + edit + delete + optional
  const menuH = itemCount * 38 + /* divider */ 1 + /* padding */ 8;
  const left = x + menuW > window.innerWidth ? x - menuW : x;
  const top = y + menuH > window.innerHeight ? y - menuH : y;

  /* -- Escape key ---------------------------------------------------- */
  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [onClose]);

  return createPortal(
    <>
      {/* Backdrop */}
      <div
        style={{ position: "fixed", inset: 0, zIndex: 9998 }}
        onClick={(e) => {
          e.stopPropagation();
          onClose();
        }}
        onContextMenu={(e) => {
          e.preventDefault();
          e.stopPropagation();
          onClose();
        }}
      />

      {/* Menu */}
      <div
        role="menu"
        style={{
          position: "fixed",
          left,
          top,
          zIndex: 9999,
          width: menuW,
          padding: 4,
          borderRadius: 8,
          backgroundColor: "var(--color-surface-alt)",
          border: "1px solid var(--color-border-subtle)",
          display: "flex",
          flexDirection: "column",
          gap: 2,
          boxShadow: "0 4px 16px 2px #00000060, 0 1px 3px #00000040",
          animation: "contextMenuIn 0.12s ease-out",
        }}
      >
        {/* View Details */}
        <ContextMenuItem
          icon={<Eye size={16} style={{ color: "var(--color-muted-foreground)", flexShrink: 0 }} />}
          label={t("ideaHub.contextMenu.viewDetail")}
          color="var(--color-foreground)"
          onClick={() => {
            onClose();
            onSelect(idea.id);
          }}
        />

        {/* Edit */}
        {onEdit && (
          <ContextMenuItem
            icon={
              <Pencil size={16} style={{ color: "var(--color-muted-foreground)", flexShrink: 0 }} />
            }
            label={t("ideaHub.contextMenu.edit")}
            color="var(--color-foreground)"
            onClick={() => {
              onClose();
              onEdit(idea.id);
            }}
          />
        )}

        {/* Start Discussion */}
        {showDiscussion && (
          <ContextMenuItem
            icon={<MessageCircle size={16} style={{ color: "#A855F7", flexShrink: 0 }} />}
            label={t("ideaHub.contextMenu.startDiscussion")}
            color="#A855F7"
            onClick={() => {
              onClose();
              onGoToDiscussion!(idea.id);
            }}
          />
        )}

        {/* Mark as Done */}
        {showComplete && (
          <ContextMenuItem
            icon={<CircleCheck size={16} style={{ color: "#22C55E", flexShrink: 0 }} />}
            label={t("ideaHub.contextMenu.markDone")}
            color="#22C55E"
            onClick={() => {
              onClose();
              onComplete!(idea.id);
            }}
          />
        )}

        {/* Divider */}
        <div style={{ height: 1, backgroundColor: "var(--color-border-subtle)", margin: "0" }} />

        {/* Delete */}
        <ContextMenuItem
          icon={<Trash2 size={16} style={{ color: "#EF4444", flexShrink: 0 }} />}
          label={t("ideaHub.contextMenu.delete")}
          color="#EF4444"
          onClick={() => {
            onClose();
            onDelete(idea.id);
          }}
        />
      </div>
    </>,
    document.body,
  );
}

/* ------------------------------------------------------------------ */
/*  Component                                                          */
/* ------------------------------------------------------------------ */

export function IdeaCard({
  idea,
  onAction: _onAction,
  onDelete,
  onSelect,
  onGoToDiscussion,
  onComplete,
  onEdit,
}: {
  readonly idea: IdeaSummary;
  readonly onAction: (idea: IdeaSummary) => void;
  readonly onDelete: (id: string) => void;
  readonly onSelect: (id: string) => void;
  readonly onGoToDiscussion?: (id: string) => void;
  readonly onComplete?: (id: string) => void;
  readonly onEdit?: (id: string) => void;
}) {
  const { t } = useTranslation();
  const priorityConfig = PRIORITY_CONFIG[idea.priority] ?? PRIORITY_CONFIG.medium;

  const [contextMenu, setContextMenu] = useState<{ x: number; y: number } | null>(null);

  const tags: ReadonlyArray<string> = useMemo(() => {
    try {
      const parsed = JSON.parse(idea.tags);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }, [idea.tags]);

  const checklistInfo = useMemo(() => {
    if (!idea.checklist_json) return null;
    try {
      const items: CheckListItem[] = JSON.parse(idea.checklist_json);
      if (!Array.isArray(items) || items.length === 0) return null;
      const done = items.filter((i) => i.checked).length;
      return { done, total: items.length };
    } catch {
      return null;
    }
  }, [idea.checklist_json]);

  const isOverdue = useMemo(() => {
    if (!idea.planned_date) return false;
    return new Date(idea.planned_date) < new Date();
  }, [idea.planned_date]);

  const formattedDate = useMemo(() => {
    if (!idea.planned_date) return null;
    const d = new Date(idea.planned_date);
    const mm = String(d.getMonth() + 1).padStart(2, "0");
    const dd = String(d.getDate()).padStart(2, "0");
    return `${mm}-${dd}`;
  }, [idea.planned_date]);

  const summarySnippet = useMemo(() => {
    if (!idea.has_summary) return null;
    return t("ideaHub.card.aiSummaryAvailable");
  }, [idea.has_summary, t]);

  /* -- Handlers ---------------------------------------------------- */

  const handleContextMenu = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setContextMenu({ x: e.clientX, y: e.clientY });
  }, []);

  const handleCloseContextMenu = useCallback(() => {
    setContextMenu(null);
  }, []);

  const handleComplete = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation();
      onComplete?.(idea.id);
    },
    [idea.id, onComplete],
  );

  /* -- Border color per status ------------------------------------- */
  const isBuilding = idea.status === "building";
  const borderColor = isBuilding ? "#3B82F640" : "var(--color-border)";

  return (
    <div
      onClick={() => onSelect(idea.id)}
      onContextMenu={handleContextMenu}
      className="group flex flex-col cursor-pointer native-css-hover"
      style={
        {
          padding: 16,
          borderRadius: 12,
          backgroundColor: "var(--color-card)",
          border: `1px solid ${borderColor}`,
          gap: 10,
          "--native-hover-border-color": isBuilding ? "#3B82F670" : "var(--color-border-strong)",
        } as React.CSSProperties
      }
    >
      {/* Title */}
      <span
        style={{
          fontSize: 13,
          fontWeight: 600,
          color: "var(--color-foreground)",
          lineHeight: 1.4,
        }}
      >
        {idea.title}
      </span>

      {/* Description — show for draft/discussing/marked */}
      {(idea.status === "draft" || idea.status === "discussing" || idea.status === "marked") &&
        idea.raw_input && (
          <span
            style={{
              fontSize: 11,
              color: "var(--color-muted)",
              lineHeight: 1.5,
              display: "-webkit-box",
              WebkitLineClamp: 2,
              WebkitBoxOrient: "vertical",
              overflow: "hidden",
            }}
          >
            {stripMarkdown(idea.raw_input).slice(0, 120)}
          </span>
        )}

      {/* Checklist progress bar — if exists */}
      {checklistInfo && (
        <div className="flex items-center" style={{ gap: 6, width: "100%" }}>
          <div
            style={{
              width: 60,
              height: 3,
              borderRadius: 2,
              backgroundColor: "var(--color-border)",
              overflow: "hidden",
              flexShrink: 0,
            }}
          >
            <div
              style={{
                width: `${(checklistInfo.done / checklistInfo.total) * 100}%`,
                height: "100%",
                borderRadius: 2,
                backgroundColor: isBuilding ? "#3B82F6" : "#A855F7",
              }}
            />
          </div>
          <span
            style={{
              fontSize: 9,
              color: "var(--color-muted-foreground)",
              fontFamily: "'JetBrains Mono', monospace",
            }}
          >
            {checklistInfo.done}/{checklistInfo.total}
          </span>
        </div>
      )}

      {/* AI Summary snippet — ready cards */}
      {idea.status === "ready" && idea.has_summary && (
        <div
          style={{
            padding: "8px 12px",
            borderRadius: 8,
            backgroundColor: "#22C55E08",
            border: "1px solid #22C55E20",
            display: "flex",
            flexDirection: "column",
            gap: 4,
          }}
        >
          <span
            style={{
              fontSize: 9,
              fontWeight: 700,
              color: "#22C55E",
            }}
          >
            AI {t("ideaHub.card.aiSummary")}
          </span>
          <span
            style={{
              fontSize: 10,
              color: "var(--color-muted)",
              lineHeight: 1.5,
              display: "-webkit-box",
              WebkitLineClamp: 2,
              WebkitBoxOrient: "vertical",
              overflow: "hidden",
            }}
          >
            {summarySnippet}
          </span>
        </div>
      )}

      {/* Bottom row: meta (left) + actions (right) */}
      <div className="flex items-center justify-between" style={{ width: "100%" }}>
        {/* Left: priority + tags + date */}
        <div className="flex items-center" style={{ gap: 6 }}>
          {/* Priority badge */}
          <div
            className="flex items-center justify-center"
            style={{
              height: 18,
              padding: "0 6px",
              borderRadius: 4,
              backgroundColor: priorityConfig.bg,
            }}
          >
            <span
              style={{
                fontSize: 9,
                fontWeight: 600,
                color: priorityConfig.color,
                textTransform: "capitalize",
              }}
            >
              {idea.priority === "high"
                ? t("ideaHub.card.priorityHigh")
                : idea.priority === "low"
                  ? t("ideaHub.card.priorityLow")
                  : t("ideaHub.card.priorityMedium")}
            </span>
          </div>

          {/* Tags */}
          {tags.slice(0, 2).map((tag, idx) => (
            <div
              key={tag}
              className="flex items-center justify-center"
              style={{
                height: 18,
                padding: "0 6px",
                borderRadius: 4,
                backgroundColor: getTagStyle(tag, idx).bg,
              }}
            >
              <span
                style={{
                  fontSize: 9,
                  color: getTagStyle(tag, idx).color,
                }}
              >
                {tag}
              </span>
            </div>
          ))}

          {/* Date */}
          {formattedDate && (
            <span
              style={{
                fontSize: 9,
                color: isOverdue ? "#EF4444" : "var(--color-muted-foreground)",
                fontFamily: "'JetBrains Mono', monospace",
              }}
            >
              {formattedDate}
            </span>
          )}
        </div>

        {/* Right: complete button for building status */}
        <div className="flex items-center" style={{ gap: 4 }}>
          {idea.status === "building" && onComplete && (
            <button
              onClick={handleComplete}
              title={t("ideaHub.card.complete")}
              className="flex items-center native-css-hover"
              style={
                {
                  gap: 4,
                  padding: "0 10px",
                  height: 22,
                  borderRadius: 6,
                  border: "1px solid #22C55E40",
                  backgroundColor: "#22C55E18",
                  cursor: "pointer",
                  fontSize: 9,
                  fontWeight: 600,
                  color: "#22C55E",
                  "--native-hover-bg-color": "#22C55E28",
                } as React.CSSProperties
              }
            >
              <Check size={9} />
              {t("ideaHub.card.complete")}
            </button>
          )}
        </div>
      </div>

      {/* Context menu */}
      {contextMenu && (
        <IdeaContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          idea={idea}
          onClose={handleCloseContextMenu}
          onSelect={onSelect}
          onEdit={onEdit}
          onGoToDiscussion={onGoToDiscussion}
          onComplete={onComplete}
          onDelete={onDelete}
          t={t}
        />
      )}
    </div>
  );
}
