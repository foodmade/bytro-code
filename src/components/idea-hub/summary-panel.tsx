import { useCallback, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Sparkles, Target, Route, List, Pencil, Send, Calendar, AlertTriangle } from "lucide-react";
import type { Idea, CheckListItem } from "@/stores";
import { useIdeaStore } from "@/stores";
import { IdeaChecklist } from "./idea-checklist";
import { IdeaImageUpload } from "./idea-image-upload";
import { IdeaImageGallery } from "./idea-image-gallery";

interface IdeaSummaryData {
  readonly problem: string;
  readonly approach: string;
  readonly keyPoints: ReadonlyArray<string>;
  readonly complexity: string;
  readonly relatedFiles: ReadonlyArray<string>;
}

const COMPLEXITY_COLORS: Record<string, { color: string; bg: string }> = {
  low: { color: "#22C55E", bg: "#22C55E18" },
  medium: { color: "#F59E0B", bg: "#F59E0B18" },
  high: { color: "#EF4444", bg: "#EF444418" },
};

export function SummaryPanel({
  idea,
  onSendToAi,
}: {
  readonly idea: Idea;
  readonly onSendToAi: () => void;
}) {
  const { t } = useTranslation();
  const updateChecklist = useIdeaStore((s) => s.updateChecklist);
  const updatePlannedDate = useIdeaStore((s) => s.updatePlannedDate);
  const saveImage = useIdeaStore((s) => s.saveImage);
  const deleteImage = useIdeaStore((s) => s.deleteImage);
  const updateImages = useIdeaStore((s) => s.updateImages);
  const getIdea = useIdeaStore((s) => s.getIdea);

  const [localPlannedDate, setLocalPlannedDate] = useState(idea.planned_date ?? "");

  const summary: IdeaSummaryData | null = useMemo(() => {
    if (!idea.summary_json) return null;
    try {
      return JSON.parse(idea.summary_json) as IdeaSummaryData;
    } catch {
      return null;
    }
  }, [idea.summary_json]);

  const checklistItems: ReadonlyArray<CheckListItem> = useMemo(() => {
    if (!idea.checklist_json) return [];
    try {
      return JSON.parse(idea.checklist_json) as CheckListItem[];
    } catch {
      return [];
    }
  }, [idea.checklist_json]);

  const imageFilenames: ReadonlyArray<string> = useMemo(() => {
    if (!idea.images_json) return [];
    try {
      return JSON.parse(idea.images_json) as string[];
    } catch {
      return [];
    }
  }, [idea.images_json]);

  const isOverdue = useMemo(() => {
    if (!idea.planned_date) return false;
    const planned = new Date(idea.planned_date);
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    return planned < today;
  }, [idea.planned_date]);

  const handleChecklistChange = useCallback(
    async (items: ReadonlyArray<CheckListItem>) => {
      await updateChecklist(idea.id, items.length > 0 ? items : null);
      await getIdea(idea.id);
    },
    [idea.id, updateChecklist, getIdea],
  );

  const handlePlannedDateChange = useCallback(
    async (e: React.ChangeEvent<HTMLInputElement>) => {
      const value = e.target.value;
      setLocalPlannedDate(value);
      await updatePlannedDate(idea.id, value || null);
      await getIdea(idea.id);
    },
    [idea.id, updatePlannedDate, getIdea],
  );

  const handleImageUpload = useCallback(
    async (imageData: number[], ext: string) => {
      const filename = await saveImage(idea.id, imageData, ext);
      // Append the new filename to the existing images list and persist
      const existing: string[] = idea.images_json ? JSON.parse(idea.images_json) : [];
      await updateImages(idea.id, [...existing, filename]);
      await getIdea(idea.id);
    },
    [idea.id, idea.images_json, saveImage, updateImages, getIdea],
  );

  const handleImageDelete = useCallback(
    async (filename: string) => {
      await deleteImage(idea.id, filename);
      await getIdea(idea.id);
    },
    [idea.id, deleteImage, getIdea],
  );

  return (
    <div
      className="flex flex-col shrink-0"
      style={{
        width: 400,
        background:
          "linear-gradient(180deg, var(--color-surface-alt) 0%, var(--color-background) 100%)",
        borderLeft: "1px solid var(--color-border)",
        overflow: "hidden",
      }}
    >
      {/* SummaryHeader */}
      <div
        className="flex items-center shrink-0"
        style={{
          height: 44,
          padding: "0 20px",
          gap: 8,
          borderBottom: "1px solid var(--color-border)",
        }}
      >
        <Sparkles size={16} style={{ color: "#22C55E" }} />
        <span
          style={{
            fontSize: 13,
            fontWeight: 600,
            color: "var(--color-foreground)",
            fontFamily: "Inter, sans-serif",
          }}
        >
          {t("ideaHub.requirementPanel.title")}
        </span>
        {summary && (
          <div
            className="flex items-center"
            style={{
              gap: 4,
              height: 18,
              padding: "0 8px",
              borderRadius: 9,
              backgroundColor: "#22C55E18",
            }}
          >
            <span
              style={{
                width: 5,
                height: 5,
                borderRadius: "50%",
                backgroundColor: "#22C55E",
              }}
            />

            <span
              style={{
                fontSize: 9,
                fontWeight: 600,
                color: "#22C55E",
                fontFamily: "Inter, sans-serif",
              }}
            >
              Live
            </span>
          </div>
        )}
      </div>

      {/* Scrollable Content */}
      <div className="flex flex-col flex-1 overflow-y-auto" style={{ padding: 20, gap: 20 }}>
        {/* Planned Date */}
        <div className="flex flex-col" style={{ gap: 8 }}>
          <div className="flex items-center" style={{ gap: 6 }}>
            <Calendar
              size={14}
              style={{ color: isOverdue ? "#EF4444" : "var(--color-accent-purple)" }}
            />
            <span style={{ fontSize: 12, fontWeight: 600, color: "var(--color-foreground)" }}>
              {t("ideaHub.edit.plannedDate")}
            </span>
            {isOverdue && (
              <span
                className="flex items-center"
                style={{
                  gap: 3,
                  fontSize: 10,
                  color: "#EF4444",
                  fontWeight: 600,
                }}
              >
                <AlertTriangle size={10} />
                {t("ideaHub.card.overdue")}
              </span>
            )}
          </div>
          <input
            type="date"
            value={localPlannedDate}
            onChange={handlePlannedDateChange}
            style={{
              padding: "6px 10px",
              borderRadius: 6,
              border: `1px solid ${isOverdue ? "#EF444440" : "var(--color-border)"}`,
              backgroundColor: isOverdue ? "#EF444408" : "var(--color-background)",
              color: isOverdue ? "#EF4444" : "var(--color-foreground)",
              fontSize: 12,
              outline: "none",
              width: "100%",
            }}
          />
        </div>

        {/* Divider */}
        <div style={{ width: "100%", height: 1, backgroundColor: "var(--color-border)" }} />

        {/* CheckList */}
        <IdeaChecklist items={checklistItems} onChange={handleChecklistChange} />

        {/* Divider */}
        <div style={{ width: "100%", height: 1, backgroundColor: "var(--color-border)" }} />

        {/* Images */}
        <IdeaImageGallery
          filenames={imageFilenames}
          onDelete={idea.discussion_conversation_id ? undefined : handleImageDelete}
          readonly={!!idea.discussion_conversation_id}
        />

        {!idea.discussion_conversation_id && <IdeaImageUpload onUpload={handleImageUpload} />}

        {/* Divider */}
        <div style={{ width: "100%", height: 1, backgroundColor: "var(--color-border)" }} />

        {/* AI Summary Section */}
        {!summary ? (
          <div
            className="flex flex-col items-center justify-center"
            style={{ gap: 8, color: "var(--color-border-strong)", padding: "20px 0" }}
          >
            <Sparkles size={32} style={{ color: "var(--color-border-strong)" }} />
            <p style={{ fontSize: 12, textAlign: "center", margin: 0 }}>
              {t("ideaHub.card.aiDiscussing")}
            </p>
          </div>
        ) : (
          <>
            {/* Problem */}
            <div className="flex flex-col" style={{ gap: 8, width: "100%" }}>
              <div className="flex items-center" style={{ gap: 6 }}>
                <Target size={12} style={{ color: "#F59E0B" }} />
                <span
                  style={{
                    fontSize: 11,
                    fontWeight: 700,
                    color: "#F59E0B",
                    letterSpacing: 0.5,
                    fontFamily: "Inter, sans-serif",
                  }}
                >
                  Problem
                </span>
              </div>
              <p
                style={{
                  margin: 0,
                  fontSize: 12,
                  color: "var(--color-muted-foreground)",
                  lineHeight: 1.6,
                  fontFamily: "Inter, sans-serif",
                }}
              >
                {summary.problem}
              </p>
            </div>

            {/* Divider */}
            <div style={{ width: "100%", height: 1, backgroundColor: "var(--color-border)" }} />

            {/* Approach */}
            <div className="flex flex-col" style={{ gap: 8, width: "100%" }}>
              <div className="flex items-center" style={{ gap: 6 }}>
                <Route size={12} style={{ color: "#A855F7" }} />
                <span
                  style={{
                    fontSize: 11,
                    fontWeight: 700,
                    color: "#A855F7",
                    letterSpacing: 0.5,
                    fontFamily: "Inter, sans-serif",
                  }}
                >
                  Approach
                </span>
              </div>
              <p
                style={{
                  margin: 0,
                  fontSize: 12,
                  color: "var(--color-muted-foreground)",
                  lineHeight: 1.6,
                  fontFamily: "Inter, sans-serif",
                }}
              >
                {summary.approach}
              </p>
            </div>

            {/* Divider */}
            <div style={{ width: "100%", height: 1, backgroundColor: "var(--color-border)" }} />

            {/* Key Points */}
            {summary.keyPoints.length > 0 && (
              <>
                <div className="flex flex-col" style={{ gap: 8, width: "100%" }}>
                  <div className="flex items-center" style={{ gap: 6 }}>
                    <List size={12} style={{ color: "#3B82F6" }} />
                    <span
                      style={{
                        fontSize: 11,
                        fontWeight: 700,
                        color: "#3B82F6",
                        letterSpacing: 0.5,
                        fontFamily: "Inter, sans-serif",
                      }}
                    >
                      Key Points
                    </span>
                  </div>
                  <div className="flex flex-col" style={{ gap: 4 }}>
                    {summary.keyPoints.map((point, i) => (
                      <div key={i} className="flex" style={{ gap: 8, width: "100%" }}>
                        <span
                          style={{
                            fontSize: 12,
                            color: "var(--color-muted)",
                            fontFamily: "Inter, sans-serif",
                            lineHeight: 1.5,
                            flexShrink: 0,
                          }}
                        >
                          •
                        </span>
                        <span
                          style={{
                            fontSize: 12,
                            color: "var(--color-muted-foreground)",
                            lineHeight: 1.5,
                            fontFamily: "Inter, sans-serif",
                          }}
                        >
                          {point}
                        </span>
                      </div>
                    ))}
                  </div>
                </div>

                {/* Divider */}
                <div style={{ width: "100%", height: 1, backgroundColor: "var(--color-border)" }} />
              </>
            )}

            {/* Meta: Complexity + Related Files */}
            <div className="flex" style={{ gap: 16, width: "100%" }}>
              {/* Complexity */}
              {summary.complexity && (
                <div className="flex flex-col" style={{ gap: 6, flex: 1 }}>
                  <span
                    style={{
                      fontSize: 10,
                      fontWeight: 600,
                      color: "var(--color-border-strong)",
                      letterSpacing: 0.5,
                      fontFamily: "Inter, sans-serif",
                    }}
                  >
                    Complexity
                  </span>
                  <div
                    className="flex items-center"
                    style={{
                      gap: 4,
                      height: 24,
                      padding: "0 10px",
                      borderRadius: 4,
                      backgroundColor: (
                        COMPLEXITY_COLORS[summary.complexity] ?? COMPLEXITY_COLORS.medium
                      ).bg,
                      alignSelf: "flex-start",
                    }}
                  >
                    <span
                      style={{
                        width: 6,
                        height: 6,
                        borderRadius: "50%",
                        backgroundColor: (
                          COMPLEXITY_COLORS[summary.complexity] ?? COMPLEXITY_COLORS.medium
                        ).color,
                      }}
                    />

                    <span
                      style={{
                        fontSize: 11,
                        fontWeight: 600,
                        color: (COMPLEXITY_COLORS[summary.complexity] ?? COMPLEXITY_COLORS.medium)
                          .color,
                        fontFamily: "Inter, sans-serif",
                        textTransform: "capitalize",
                      }}
                    >
                      {summary.complexity}
                    </span>
                  </div>
                </div>
              )}

              {/* Related Files */}
              {summary.relatedFiles.length > 0 && (
                <div className="flex flex-col" style={{ gap: 6, flex: 1 }}>
                  <span
                    style={{
                      fontSize: 10,
                      fontWeight: 600,
                      color: "var(--color-border-strong)",
                      letterSpacing: 0.5,
                      fontFamily: "Inter, sans-serif",
                    }}
                  >
                    Related Files
                  </span>
                  <div className="flex flex-col" style={{ gap: 2 }}>
                    {summary.relatedFiles.map((file, i) => (
                      <span
                        key={i}
                        style={{
                          fontSize: 10,
                          color: "var(--color-muted)",
                          fontFamily: "'JetBrains Mono', monospace",
                          lineHeight: 1.6,
                        }}
                      >
                        {file}
                      </span>
                    ))}
                  </div>
                </div>
              )}
            </div>
          </>
        )}
      </div>

      {/* Footer - Send to AI */}
      {summary && (
        <div
          className="flex items-center justify-center shrink-0"
          style={{
            height: 60,
            padding: "0 20px",
            gap: 10,
            borderTop: "1px solid var(--color-border)",
          }}
        >
          {/* Edit Summary button */}
          <button
            className="flex items-center native-css-hover"
            style={
              {
                gap: 6,
                padding: "0 14px",
                height: 36,
                borderRadius: 8,
                border: "1px solid var(--color-border-light)",
                backgroundColor: "transparent",
                color: "var(--color-muted-foreground)",
                fontSize: 12,
                fontWeight: 500,
                cursor: "pointer",
                fontFamily: "Inter, sans-serif",
                transition: "background-color 0.15s ease",
                "--native-hover-bg-color": "#ffffff06",
              } as React.CSSProperties
            }
          >
            <Pencil size={14} />
            Edit Summary
          </button>

          {/* Send to AI button */}
          <button
            onClick={onSendToAi}
            className="flex items-center native-css-hover"
            style={
              {
                gap: 6,
                padding: "0 14px",
                height: 36,
                borderRadius: 8,
                border: "none",
                background: "linear-gradient(180deg, #22C55E 0%, #16A34A 100%)",
                color: "#0D0D0D",
                fontSize: 12,
                fontWeight: 600,
                cursor: "pointer",
                fontFamily: "Inter, sans-serif",
                transition: "opacity 0.15s ease",
                "--native-hover-opacity": "0.9",
              } as React.CSSProperties
            }
          >
            <Send size={14} />
            Send to AI
          </button>
        </div>
      )}
    </div>
  );
}
