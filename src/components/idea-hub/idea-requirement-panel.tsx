import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { X, Lightbulb, Calendar, AlertTriangle, Tag } from "lucide-react";
import { useIdeaStore, useConversationStore } from "@/stores";
import type { Idea, CheckListItem } from "@/stores";
import { IdeaChecklist } from "./idea-checklist";
import { IdeaImageGallery } from "./idea-image-gallery";

const PRIORITY_COLORS: Record<string, { color: string; bg: string }> = {
  high: { color: "#EF4444", bg: "#EF444418" },
  medium: { color: "#F59E0B", bg: "#F59E0B18" },
  low: { color: "#6B7280", bg: "#6B728018" },
};

export function IdeaRequirementPanel({
  onClose,
}: {
  readonly onClose: () => void;
}) {
  const { t } = useTranslation();
  const activeConversationId = useConversationStore((s) => s.activeConversationId);
  const getLinkedIdea = useIdeaStore((s) => s.getLinkedIdea);
  const updateChecklist = useIdeaStore((s) => s.updateChecklist);
  const getIdea = useIdeaStore((s) => s.getIdea);

  const [linkedIdea, setLinkedIdea] = useState<Idea | null>(null);

  useEffect(() => {
    if (!activeConversationId) {
      setLinkedIdea(null);
      return;
    }
    let cancelled = false;
    getLinkedIdea(activeConversationId).then((idea) => {
      if (!cancelled) setLinkedIdea(idea);
    });
    return () => { cancelled = true; };
  }, [activeConversationId, getLinkedIdea]);

  const checklistItems: ReadonlyArray<CheckListItem> = useMemo(() => {
    if (!linkedIdea?.checklist_json) return [];
    try {
      return JSON.parse(linkedIdea.checklist_json) as CheckListItem[];
    } catch {
      return [];
    }
  }, [linkedIdea?.checklist_json]);

  const imageFilenames: ReadonlyArray<string> = useMemo(() => {
    if (!linkedIdea?.images_json) return [];
    try {
      return JSON.parse(linkedIdea.images_json) as string[];
    } catch {
      return [];
    }
  }, [linkedIdea?.images_json]);

  const tags: ReadonlyArray<string> = useMemo(() => {
    if (!linkedIdea?.tags) return [];
    try {
      return JSON.parse(linkedIdea.tags) as string[];
    } catch {
      return [];
    }
  }, [linkedIdea?.tags]);

  const isOverdue = useMemo(() => {
    if (!linkedIdea?.planned_date) return false;
    const planned = new Date(linkedIdea.planned_date);
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    return planned < today;
  }, [linkedIdea?.planned_date]);

  const handleChecklistChange = useCallback(
    async (items: ReadonlyArray<CheckListItem>) => {
      if (!linkedIdea) return;
      await updateChecklist(linkedIdea.id, items.length > 0 ? items : null);
      const refreshed = await getIdea(linkedIdea.id);
      if (refreshed) setLinkedIdea(refreshed);
    },
    [linkedIdea, updateChecklist, getIdea],
  );

  if (!linkedIdea) return null;

  const priorityConfig = PRIORITY_COLORS[linkedIdea.priority] ?? PRIORITY_COLORS.medium;

  return (
    <div
      className="flex flex-col shrink-0"
      style={{
        width: 320,
        borderLeft: "1px solid var(--color-border)",
        backgroundColor: "var(--color-background)",
        overflow: "hidden",
      }}
    >
      {/* Header */}
      <div
        className="flex items-center justify-between shrink-0"
        style={{
          height: 44,
          padding: "0 16px",
          borderBottom: "1px solid var(--color-border)",
        }}
      >
        <div className="flex items-center" style={{ gap: 8 }}>
          <Lightbulb size={14} style={{ color: "#F59E0B" }} />
          <span
            style={{
              fontSize: 12,
              fontWeight: 600,
              color: "var(--color-foreground)",
            }}
          >
            {t("ideaHub.requirementPanel.title")}
          </span>
        </div>
        <button
          onClick={onClose}
          style={{
            border: "none",
            background: "transparent",
            cursor: "pointer",
            padding: 4,
            borderRadius: 4,
            display: "flex",
          }}
        >
          <X size={14} style={{ color: "var(--color-muted)" }} />
        </button>
      </div>

      {/* Content */}
      <div
        className="flex flex-col flex-1 overflow-y-auto"
        style={{ padding: 16, gap: 16 }}
      >
        {/* Title */}
        <span
          style={{
            fontSize: 14,
            fontWeight: 600,
            color: "var(--color-foreground)",
            lineHeight: 1.4,
          }}
        >
          {linkedIdea.title}
        </span>

        {/* Description */}
        {linkedIdea.raw_input && (
          <p
            style={{
              margin: 0,
              fontSize: 12,
              color: "var(--color-muted-foreground)",
              lineHeight: 1.6,
            }}
          >
            {linkedIdea.raw_input}
          </p>
        )}

        {/* Meta row: priority + planned date */}
        <div className="flex items-center flex-wrap" style={{ gap: 8 }}>
          {/* Priority */}
          <span
            style={{
              fontSize: 10,
              fontWeight: 600,
              padding: "2px 8px",
              borderRadius: 4,
              backgroundColor: priorityConfig.bg,
              color: priorityConfig.color,
              textTransform: "capitalize",
            }}
          >
            {linkedIdea.priority}
          </span>

          {/* Planned date */}
          {linkedIdea.planned_date && (
            <span
              className="flex items-center"
              style={{
                gap: 4,
                fontSize: 10,
                color: isOverdue ? "#EF4444" : "var(--color-muted)",
              }}
            >
              {isOverdue && <AlertTriangle size={10} />}
              <Calendar size={10} />
              {linkedIdea.planned_date}
            </span>
          )}

          {/* Status */}
          <span
            style={{
              fontSize: 10,
              fontWeight: 500,
              padding: "2px 8px",
              borderRadius: 4,
              backgroundColor: "var(--color-accent-purple)18",
              color: "var(--color-accent-purple)",
              textTransform: "capitalize",
            }}
          >
            {linkedIdea.status}
          </span>
        </div>

        {/* Tags */}
        {tags.length > 0 && (
          <div className="flex items-center flex-wrap" style={{ gap: 4 }}>
            <Tag size={10} style={{ color: "var(--color-muted)", marginRight: 2 }} />
            {tags.map((tag) => (
              <span
                key={tag}
                style={{
                  fontSize: 10,
                  padding: "1px 6px",
                  borderRadius: 3,
                  backgroundColor: "rgba(var(--theme-accent-rgb),0.071)",
                  color: "#A855F7",
                }}
              >
                {tag}
              </span>
            ))}
          </div>
        )}

        {/* Divider */}
        <div style={{ height: 1, backgroundColor: "var(--color-border)" }} />

        {/* Checklist */}
        {checklistItems.length > 0 && (
          <>
            <IdeaChecklist
              items={checklistItems}
              onChange={handleChecklistChange}
            />
            <div style={{ height: 1, backgroundColor: "var(--color-border)" }} />
          </>
        )}

        {/* Images */}
        {imageFilenames.length > 0 && (
          <IdeaImageGallery filenames={imageFilenames} readonly />
        )}

        {/* AI Summary */}
        {linkedIdea.summary_json && (() => {
          try {
            const s = JSON.parse(linkedIdea.summary_json);
            return (
              <div className="flex flex-col" style={{ gap: 8 }}>
                <span style={{ fontSize: 11, fontWeight: 600, color: "var(--color-foreground)" }}>
                  AI Summary
                </span>
                {s.problem && (
                  <p style={{ margin: 0, fontSize: 11, color: "var(--color-muted-foreground)", lineHeight: 1.5 }}>
                    <strong style={{ color: "var(--color-foreground)" }}>Problem:</strong> {s.problem}
                  </p>
                )}
                {s.approach && (
                  <p style={{ margin: 0, fontSize: 11, color: "var(--color-muted-foreground)", lineHeight: 1.5 }}>
                    <strong style={{ color: "var(--color-foreground)" }}>Approach:</strong> {s.approach}
                  </p>
                )}
              </div>
            );
          } catch {
            return null;
          }
        })()}
      </div>
    </div>
  );
}
