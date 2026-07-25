import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  Lightbulb,
  Pencil,
  X,
  Calendar,
  ImageIcon,
  Sparkles,
  Target,
  GitMerge,
  ClipboardList,
  MessageCircle,
  Rocket,
} from "lucide-react";
import { invoke } from "@tauri-apps/api/core";
import { useIdeaStore } from "@/stores";
import type { Idea, CheckListItem } from "@/stores";
import { MarkdownRenderer } from "@/components/ui/markdown-renderer";
import { IdeaChecklist } from "./idea-checklist";

/* ------------------------------------------------------------------ */
/*  Status badge config                                                */
/* ------------------------------------------------------------------ */

const STATUS_BADGE: Record<string, { color: string; bg: string; labelKey: string }> = {
  draft: { color: "#6B7280", bg: "#6B728018", labelKey: "ideaHub.columns.draft" },
  discussing: { color: "#A855F7", bg: "rgba(var(--theme-accent-rgb),0.094)", labelKey: "ideaHub.columns.discussing" },
  marked: { color: "#A855F7", bg: "rgba(var(--theme-accent-rgb),0.094)", labelKey: "ideaHub.columns.discussing" },
  ready: { color: "#22C55E", bg: "#22C55E18", labelKey: "ideaHub.columns.ready" },
  building: { color: "#3B82F6", bg: "#3B82F618", labelKey: "ideaHub.columns.building" },
  done: { color: "#22C55E", bg: "#22C55E18", labelKey: "ideaHub.columns.done" },
};

/* ------------------------------------------------------------------ */
/*  Priority config                                                    */
/* ------------------------------------------------------------------ */

const PRIORITY_CONFIG: Record<string, { color: string; bg: string }> = {
  high: { color: "#EF4444", bg: "#EF444418" },
  medium: { color: "#F59E0B", bg: "#F59E0B18" },
  low: { color: "#6B7280", bg: "#6B728018" },
};

/* ------------------------------------------------------------------ */
/*  Tag palette                                                        */
/* ------------------------------------------------------------------ */

const TAG_PALETTE = [
  { color: "#A855F7", bg: "rgba(var(--theme-accent-rgb),0.071)" },
  { color: "#3B82F6", bg: "#3B82F612" },
  { color: "#22C55E", bg: "#22C55E12" },
  { color: "#F59E0B", bg: "#F59E0B12" },
  { color: "#EF4444", bg: "#EF444412" },
];

/* ------------------------------------------------------------------ */
/*  AI Summary type                                                    */
/* ------------------------------------------------------------------ */

interface AISummaryData {
  readonly problem: string;
  readonly approach: string;
  readonly keyPoints: ReadonlyArray<string>;
}

/* ------------------------------------------------------------------ */
/*  Component                                                          */
/* ------------------------------------------------------------------ */

export function IdeaPreviewPanel({
  ideaId,
  onClose,
  onEdit,
  onGoToDiscussion,
  onSendToAi,
}: {
  readonly ideaId: string;
  readonly onClose: () => void;
  readonly onEdit?: (id: string) => void;
  readonly onGoToDiscussion?: (id: string) => void;
  readonly onSendToAi?: (id: string) => void;
}) {
  const { t } = useTranslation();
  const getIdea = useIdeaStore((s) => s.getIdea);
  const updateChecklist = useIdeaStore((s) => s.updateChecklist);

  const [idea, setIdea] = useState<Idea | null>(null);
  const [isSlid, setIsSlid] = useState(false);

  /* -- Load idea --------------------------------------------------- */

  useEffect(() => {
    getIdea(ideaId).then((loaded) => {
      if (loaded) setIdea(loaded);
    });
  }, [ideaId, getIdea]);

  /* -- Slide animation --------------------------------------------- */

  useEffect(() => {
    requestAnimationFrame(() => {
      requestAnimationFrame(() => setIsSlid(true));
    });
  }, []);

  const handleClose = useCallback(() => {
    setIsSlid(false);
    setTimeout(() => onClose(), 300);
  }, [onClose]);

  /* -- Parsed data ------------------------------------------------- */

  const tags: ReadonlyArray<string> = useMemo(() => {
    if (!idea?.tags) return [];
    try {
      const parsed = JSON.parse(idea.tags);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }, [idea?.tags]);

  const checklistItems: ReadonlyArray<CheckListItem> = useMemo(() => {
    if (!idea?.checklist_json) return [];
    try {
      const parsed = JSON.parse(idea.checklist_json);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }, [idea?.checklist_json]);

  const images: ReadonlyArray<string> = useMemo(() => {
    if (!idea?.images_json) return [];
    try {
      const parsed = JSON.parse(idea.images_json);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }, [idea?.images_json]);

  const summary: AISummaryData | null = useMemo(() => {
    if (!idea?.summary_json) return null;
    try {
      return JSON.parse(idea.summary_json) as AISummaryData;
    } catch {
      return null;
    }
  }, [idea?.summary_json]);

  const formattedDate = useMemo(() => {
    if (!idea?.planned_date) return null;
    return idea.planned_date;
  }, [idea?.planned_date]);

  /* -- Checklist change (toggle, edit, delete, reorder) ------------- */

  const handleChecklistChange = useCallback(
    async (items: ReadonlyArray<CheckListItem>) => {
      if (!idea) return;
      await updateChecklist(idea.id, items.length > 0 ? items : null);
      const refreshed = await getIdea(idea.id);
      if (refreshed) setIdea(refreshed);
    },
    [idea, updateChecklist, getIdea],
  );

  /* -- Resolve image paths ----------------------------------------- */

  const [imagePaths, setImagePaths] = useState<Record<string, string>>({});

  useEffect(() => {
    let cancelled = false;
    async function resolve() {
      const paths: Record<string, string> = {};
      for (const filename of images) {
        try {
          const dataUrl = await invoke<string>("read_idea_image_base64", { filename });
          paths[filename] = dataUrl;
        } catch {
          // skip failed
        }
      }
      if (!cancelled) setImagePaths(paths);
    }
    if (images.length > 0) resolve();
    return () => {
      cancelled = true;
    };
  }, [images]);

  /* -- Status info ------------------------------------------------- */

  const statusInfo = STATUS_BADGE[idea?.status ?? "draft"] ?? STATUS_BADGE.draft;
  const priorityInfo = PRIORITY_CONFIG[idea?.priority ?? "medium"] ?? PRIORITY_CONFIG.medium;

  /* -- Action bar logic -------------------------------------------- */

  const canDiscuss =
    idea?.status === "draft" || idea?.status === "discussing" || idea?.status === "marked";
  const canSendToAi = (idea?.status === "ready" || idea?.status === "marked") && idea?.summary_json;

  if (!idea) {
    return (
      <div
        className="fixed inset-0 z-50 flex justify-end"
        style={{ backgroundColor: "rgba(0,0,0,0.4)" }}
        onClick={handleClose}
      >
        <div
          className="flex items-center justify-center"
          style={{
            width: 500,
            height: "100%",
            backgroundColor: "var(--color-surface)",
            color: "var(--color-muted)",
            fontSize: 13,
          }}
        >
          Loading...
        </div>
      </div>
    );
  }

  return (
    /* Backdrop */
    <div
      className="fixed inset-0 z-50 flex justify-end"
      style={{
        backgroundColor: isSlid ? "rgba(0,0,0,0.4)" : "rgba(0,0,0,0)",
        transition: "background-color 0.3s ease",
      }}
      onClick={handleClose}
    >
      {/* Panel */}
      <div
        onClick={(e) => e.stopPropagation()}
        className="flex flex-col"
        style={{
          width: 500,
          height: "100%",
          backgroundColor: "var(--color-surface)",
          borderLeft: "1px solid var(--color-border)",
          transform: isSlid ? "translateX(0)" : "translateX(100%)",
          transition: "transform 0.3s ease",
        }}
      >
        {/* ---- Header ---- */}
        <div
          className="flex items-center justify-between shrink-0"
          style={{ height: 56, padding: "0 24px" }}
        >
          <div className="flex items-center" style={{ gap: 10 }}>
            <div
              className="flex items-center justify-center shrink-0"
              style={{
                width: 28,
                height: 28,
                borderRadius: 8,
                backgroundColor: "rgba(var(--theme-accent-rgb),0.094)",
              }}
            >
              <Lightbulb size={14} style={{ color: "#A855F7" }} />
            </div>
            <span style={{ fontSize: 15, fontWeight: 700, color: "var(--color-foreground)" }}>
              {t("ideaHub.preview.title")}
            </span>
            {/* Status badge */}
            <div
              className="flex items-center"
              style={{
                height: 20,
                padding: "0 8px",
                borderRadius: 4,
                backgroundColor: statusInfo.bg,
                gap: 4,
              }}
            >
              <div
                style={{
                  width: 5,
                  height: 5,
                  borderRadius: 3,
                  backgroundColor: statusInfo.color,
                  flexShrink: 0,
                }}
              />

              <span
                style={{
                  fontSize: 9,
                  fontWeight: 600,
                  color: statusInfo.color,
                }}
              >
                {t(statusInfo.labelKey)}
              </span>
            </div>
          </div>

          <div className="flex items-center" style={{ gap: 8 }}>
            {/* Edit button */}
            {onEdit && (
              <button
                onClick={() => {
                  handleClose();
                  setTimeout(() => onEdit(idea.id), 320);
                }}
                className="flex items-center native-css-hover"
                style={
                  {
                    height: 30,
                    padding: "0 12px",
                    borderRadius: 6,
                    backgroundColor: "var(--color-border)",
                    border: "none",
                    cursor: "pointer",
                    gap: 5,
                    "--native-hover-bg-color": "var(--color-border-strong)",
                  } as React.CSSProperties
                }
              >
                <Pencil size={12} style={{ color: "var(--color-muted-foreground)" }} />
                <span style={{ fontSize: 11, color: "var(--color-muted-foreground)" }}>
                  {t("ideaHub.card.edit")}
                </span>
              </button>
            )}
            {/* Close button */}
            <button
              onClick={handleClose}
              className="flex items-center justify-center native-css-hover"
              style={
                {
                  width: 30,
                  height: 30,
                  borderRadius: 6,
                  backgroundColor: "var(--color-border)",
                  border: "none",
                  cursor: "pointer",
                  "--native-hover-bg-color": "var(--color-border-strong)",
                } as React.CSSProperties
              }
            >
              <X size={12} style={{ color: "var(--color-muted-foreground)" }} />
            </button>
          </div>
        </div>

        {/* Divider */}
        <div style={{ height: 1, backgroundColor: "var(--color-border)", flexShrink: 0 }} />

        {/* ---- Scrollable content ---- */}
        <div className="flex-1 overflow-y-auto" style={{ padding: 24 }}>
          <div className="flex flex-col" style={{ gap: 18 }}>
            {/* Title */}
            <span
              style={{
                fontSize: 17,
                fontWeight: 700,
                color: "var(--color-foreground)",
                lineHeight: 1.4,
              }}
            >
              {idea.title}
            </span>

            {/* Description — rendered as Markdown */}
            {idea.raw_input && (
              <div
                style={{
                  fontSize: 12,
                  color: "var(--color-muted-foreground)",
                  lineHeight: 1.7,
                }}
              >
                <MarkdownRenderer content={idea.raw_input} variant="compact" />
              </div>
            )}

            {/* ---- Meta card ---- */}
            <div
              className="flex items-center flex-wrap"
              style={{
                padding: "10px 14px",
                borderRadius: 8,
                backgroundColor: "var(--color-card)",
                border: "1px solid var(--color-border)",
                gap: 10,
              }}
            >
              {/* Priority */}
              <div
                className="flex items-center"
                style={{
                  height: 22,
                  padding: "0 7px",
                  borderRadius: 4,
                  backgroundColor: priorityInfo.bg,
                  gap: 3,
                }}
              >
                <div
                  style={{
                    width: 5,
                    height: 5,
                    borderRadius: 3,
                    backgroundColor: priorityInfo.color,
                    flexShrink: 0,
                  }}
                />

                <span style={{ fontSize: 10, fontWeight: 600, color: priorityInfo.color }}>
                  {idea.priority === "high"
                    ? t("ideaHub.card.priorityHigh")
                    : idea.priority === "low"
                      ? t("ideaHub.card.priorityLow")
                      : t("ideaHub.card.priorityMedium")}
                </span>
              </div>

              {/* Separator */}
              <div
                style={{ width: 1, height: 14, backgroundColor: "var(--color-border-strong)" }}
              />

              {/* Date */}
              {formattedDate && (
                <>
                  <div className="flex items-center" style={{ gap: 4 }}>
                    <Calendar size={12} style={{ color: "var(--color-muted)", flexShrink: 0 }} />
                    <span
                      style={{
                        fontSize: 10,
                        color: "var(--color-foreground)",
                        fontFamily: "'JetBrains Mono', monospace",
                      }}
                    >
                      {formattedDate}
                    </span>
                  </div>
                  <div
                    style={{ width: 1, height: 14, backgroundColor: "var(--color-border-strong)" }}
                  />
                </>
              )}

              {/* Tags */}
              {tags.map((tag, idx) => {
                const palette = TAG_PALETTE[idx % TAG_PALETTE.length];
                return (
                  <div
                    key={tag}
                    className="flex items-center justify-center"
                    style={{
                      height: 20,
                      padding: "0 6px",
                      borderRadius: 3,
                      backgroundColor: palette.bg,
                    }}
                  >
                    <span style={{ fontSize: 9, fontWeight: 500, color: palette.color }}>
                      {tag}
                    </span>
                  </div>
                );
              })}
            </div>

            {/* ---- Checklist card ---- */}
            {checklistItems.length > 0 && (
              <div
                style={{
                  borderRadius: 12,
                  backgroundColor: "var(--color-card)",
                  border: "1px solid var(--color-border)",
                  padding: 16,
                }}
              >
                <IdeaChecklist items={checklistItems} onChange={handleChecklistChange} />
              </div>
            )}

            {/* ---- Images card ---- */}
            {images.length > 0 && (
              <div
                style={{
                  borderRadius: 12,
                  backgroundColor: "var(--color-card)",
                  border: "1px solid var(--color-border)",
                  padding: 16,
                }}
              >
                <div className="flex flex-col" style={{ gap: 10 }}>
                  {/* Header */}
                  <div className="flex items-center" style={{ gap: 6 }}>
                    <ImageIcon size={14} style={{ color: "#F59E0B", flexShrink: 0 }} />
                    <span
                      style={{ fontSize: 12, fontWeight: 600, color: "var(--color-foreground)" }}
                    >
                      {t("ideaHub.create.refImages")}
                    </span>
                    <span
                      style={{
                        fontSize: 10,
                        color: "var(--color-muted)",
                        fontFamily: "'JetBrains Mono', monospace",
                      }}
                    >
                      {images.length}
                    </span>
                  </div>

                  {/* Thumbnails */}
                  <div className="flex flex-wrap" style={{ gap: 8 }}>
                    {images.map((img) => (
                      <div
                        key={img}
                        className="flex items-center justify-center shrink-0"
                        style={{
                          width: 100,
                          height: 72,
                          borderRadius: 8,
                          backgroundColor: "var(--color-border)",
                          overflow: "hidden",
                        }}
                      >
                        {imagePaths[img] ? (
                          <img
                            src={imagePaths[img]}
                            alt=""
                            style={{
                              width: "100%",
                              height: "100%",
                              objectFit: "cover",
                            }}
                          />
                        ) : (
                          <ImageIcon size={24} style={{ color: "var(--color-text-tertiary)" }} />
                        )}
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            )}

            {/* ---- AI Summary card ---- */}
            {summary && (
              <div
                style={{
                  borderRadius: 12,
                  backgroundColor: "var(--color-card)",
                  border: "1px solid #22C55E30",
                  padding: 16,
                }}
              >
                <div className="flex flex-col" style={{ gap: 14 }}>
                  {/* Header */}
                  <div className="flex items-center" style={{ gap: 6 }}>
                    <Sparkles size={14} style={{ color: "#22C55E", flexShrink: 0 }} />
                    <span
                      style={{ fontSize: 12, fontWeight: 600, color: "var(--color-foreground)" }}
                    >
                      AI {t("ideaHub.card.aiSummary")}
                    </span>
                    <div
                      className="flex items-center"
                      style={{
                        height: 16,
                        padding: "0 6px",
                        borderRadius: 8,
                        backgroundColor: "#22C55E18",
                        gap: 3,
                      }}
                    >
                      <div
                        style={{
                          width: 4,
                          height: 4,
                          borderRadius: 2,
                          backgroundColor: "#22C55E",
                          flexShrink: 0,
                        }}
                      />

                      <span style={{ fontSize: 8, fontWeight: 600, color: "#22C55E" }}>Live</span>
                    </div>
                  </div>

                  {/* Problem */}
                  {summary.problem && (
                    <div className="flex flex-col" style={{ gap: 4 }}>
                      <div className="flex items-center" style={{ gap: 4 }}>
                        <Target size={12} style={{ color: "#F59E0B", flexShrink: 0 }} />
                        <span style={{ fontSize: 10, fontWeight: 700, color: "#F59E0B" }}>
                          Problem
                        </span>
                      </div>
                      <span
                        style={{
                          fontSize: 11,
                          color: "var(--color-muted-foreground)",
                          lineHeight: 1.6,
                        }}
                      >
                        {summary.problem}
                      </span>
                    </div>
                  )}

                  {/* Approach */}
                  {summary.approach && (
                    <div className="flex flex-col" style={{ gap: 4 }}>
                      <div className="flex items-center" style={{ gap: 4 }}>
                        <GitMerge size={12} style={{ color: "#A855F7", flexShrink: 0 }} />
                        <span style={{ fontSize: 10, fontWeight: 700, color: "#A855F7" }}>
                          Approach
                        </span>
                      </div>
                      <span
                        style={{
                          fontSize: 11,
                          color: "var(--color-muted-foreground)",
                          lineHeight: 1.6,
                        }}
                      >
                        {summary.approach}
                      </span>
                    </div>
                  )}

                  {/* Key Points */}
                  {summary.keyPoints && summary.keyPoints.length > 0 && (
                    <div className="flex flex-col" style={{ gap: 4 }}>
                      <div className="flex items-center" style={{ gap: 4 }}>
                        <ClipboardList size={12} style={{ color: "#3B82F6", flexShrink: 0 }} />
                        <span style={{ fontSize: 10, fontWeight: 700, color: "#3B82F6" }}>
                          Key Points
                        </span>
                      </div>
                      {summary.keyPoints.map((point, idx) => (
                        <div key={idx} className="flex items-center" style={{ gap: 6 }}>
                          <span style={{ fontSize: 11, color: "var(--color-border-strong)" }}>
                            •
                          </span>
                          <span
                            style={{
                              fontSize: 11,
                              color: "var(--color-muted-foreground)",
                              lineHeight: 1.5,
                            }}
                          >
                            {point}
                          </span>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            )}
          </div>
        </div>

        {/* ---- Bottom action bar ---- */}
        <div
          className="flex items-center justify-end shrink-0"
          style={{
            height: 64,
            padding: "0 24px",
            borderTop: "1px solid var(--color-border)",
            gap: 10,
          }}
        >
          {/* Continue discussion / Start discussion */}
          {canDiscuss && onGoToDiscussion && (
            <button
              onClick={() => {
                handleClose();
                setTimeout(() => onGoToDiscussion(idea.id), 320);
              }}
              className="flex items-center native-css-hover"
              style={
                {
                  height: 36,
                  padding: "0 16px",
                  borderRadius: 8,
                  backgroundColor: "rgba(var(--theme-accent-rgb),0.094)",
                  border: "1px solid rgba(var(--theme-accent-rgb),0.251)",
                  cursor: "pointer",
                  gap: 6,
                  "--native-hover-bg-color": "rgba(var(--theme-accent-rgb),0.157)",
                } as React.CSSProperties
              }
            >
              <MessageCircle size={14} style={{ color: "#A855F7", flexShrink: 0 }} />
              <span style={{ fontSize: 12, fontWeight: 500, color: "#A855F7" }}>
                {idea.status === "draft"
                  ? t("ideaHub.preview.startDiscussion")
                  : t("ideaHub.preview.continueDiscussion")}
              </span>
            </button>
          )}

          {/* Reopen discussion — for ready status */}
          {idea.status === "ready" && onGoToDiscussion && (
            <button
              onClick={() => {
                handleClose();
                setTimeout(() => onGoToDiscussion(idea.id), 320);
              }}
              className="flex items-center native-css-hover"
              style={
                {
                  height: 36,
                  padding: "0 16px",
                  borderRadius: 8,
                  backgroundColor: "rgba(var(--theme-accent-rgb),0.094)",
                  border: "1px solid rgba(var(--theme-accent-rgb),0.251)",
                  cursor: "pointer",
                  gap: 6,
                  "--native-hover-bg-color": "rgba(var(--theme-accent-rgb),0.157)",
                } as React.CSSProperties
              }
            >
              <MessageCircle size={14} style={{ color: "#A855F7", flexShrink: 0 }} />
              <span style={{ fontSize: 12, fontWeight: 500, color: "#A855F7" }}>
                {t("ideaHub.preview.continueDiscussion")}
              </span>
            </button>
          )}

          {/* Send to AI — for ready with summary */}
          {canSendToAi && onSendToAi && (
            <button
              onClick={() => {
                handleClose();
                setTimeout(() => onSendToAi(idea.id), 320);
              }}
              className="flex items-center native-css-hover"
              style={
                {
                  height: 36,
                  padding: "0 16px",
                  borderRadius: 8,
                  backgroundColor: "#22C55E",
                  border: "none",
                  cursor: "pointer",
                  gap: 6,
                  "--native-hover-opacity": "0.9",
                } as React.CSSProperties
              }
            >
              <Rocket size={14} style={{ color: "#0D0D0D" }} />
              <span style={{ fontSize: 12, fontWeight: 600, color: "#0D0D0D" }}>
                {t("ideaHub.preview.sendToAi")}
              </span>
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
