import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { FilePen, X, Calendar, Tag, Sparkles, List, Link2 } from "lucide-react";
import { useIdeaStore } from "@/stores";
import type { Idea, CheckListItem } from "@/stores";
import { IdeaChecklist } from "./idea-checklist";

/* ------------------------------------------------------------------ */
/*  Priority config                                                    */
/* ------------------------------------------------------------------ */

const PRIORITY_OPTIONS = [
  { value: "high" as const, color: "#EF4444", bg: "#EF444418", borderActive: "#EF444440" },
  { value: "medium" as const, color: "#F59E0B", bg: "#F59E0B18", borderActive: "#F59E0B40" },
  { value: "low" as const, color: "#6B7280", bg: "#6B728018", borderActive: "#6B728040" },
];

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
/*  Toolbar button config                                              */
/* ------------------------------------------------------------------ */

interface ToolbarBtn {
  readonly label: string;
  readonly weight?: string;
  readonly size: number;
  readonly mono?: boolean;
  readonly before: string;
  readonly after: string;
}

const FORMAT_BUTTONS: ReadonlyArray<ToolbarBtn> = [
  { label: "B", weight: "700", size: 12, before: "**", after: "**" },
  { label: "I", weight: "600", size: 12, before: "*", after: "*" },
  { label: "S", weight: "600", size: 12, before: "~~", after: "~~" },
];

const HEADING_BUTTONS: ReadonlyArray<ToolbarBtn> = [
  { label: "H1", weight: "700", size: 10, before: "# ", after: "" },
  { label: "H2", weight: "700", size: 10, before: "## ", after: "" },
];

const EXTRA_BUTTONS: ReadonlyArray<ToolbarBtn> = [
  { label: "list", size: 12, before: "- ", after: "" },
  { label: "</>", size: 9, mono: true, before: "`", after: "`" },
  { label: "link", size: 11, before: "[", after: "](url)" },
];

/* ------------------------------------------------------------------ */
/*  Component                                                          */
/* ------------------------------------------------------------------ */

export function IdeaEditModal({
  ideaId,
  onClose,
}: {
  readonly ideaId: string;
  readonly onClose: () => void;
}) {
  const { t } = useTranslation();
  const getIdea = useIdeaStore((s) => s.getIdea);
  const updateIdea = useIdeaStore((s) => s.updateIdea);
  const updatePlannedDate = useIdeaStore((s) => s.updatePlannedDate);
  const updateChecklist = useIdeaStore((s) => s.updateChecklist);

  /* -- Form state -------------------------------------------------- */

  const [idea, setIdea] = useState<Idea | null>(null);
  const [title, setTitle] = useState("");
  const [rawInput, setRawInput] = useState("");
  const [tagInput, setTagInput] = useState("");
  const [tags, setTags] = useState<ReadonlyArray<string>>([]);
  const [priority, setPriority] = useState<"low" | "medium" | "high">("medium");
  const [plannedDate, setPlannedDate] = useState("");
  const [checklist, setChecklist] = useState<ReadonlyArray<CheckListItem>>([]);
  const [isSaving, setIsSaving] = useState(false);
  const [isSlid, setIsSlid] = useState(false);

  const titleRef = useRef<HTMLInputElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  /* -- Load idea + animate in -------------------------------------- */

  useEffect(() => {
    getIdea(ideaId).then((loaded) => {
      if (!loaded) return;
      setIdea(loaded);
      setTitle(loaded.title);
      setRawInput(loaded.raw_input);
      setPriority(loaded.priority as "low" | "medium" | "high");
      setPlannedDate(loaded.planned_date ?? "");
      try {
        const parsed = JSON.parse(loaded.tags);
        setTags(Array.isArray(parsed) ? parsed : []);
      } catch {
        setTags([]);
      }
      try {
        const parsed = JSON.parse(loaded.checklist_json ?? "[]");
        setChecklist(Array.isArray(parsed) ? parsed : []);
      } catch {
        setChecklist([]);
      }
    });
  }, [ideaId, getIdea]);

  useEffect(() => {
    requestAnimationFrame(() => {
      requestAnimationFrame(() => setIsSlid(true));
    });
    setTimeout(() => titleRef.current?.focus(), 150);
  }, []);

  const handleClose = useCallback(() => {
    setIsSlid(false);
    setTimeout(() => onClose(), 300);
  }, [onClose]);

  /* -- Tag handlers ------------------------------------------------ */

  const handleAddTag = useCallback(() => {
    const tag = tagInput.trim();
    if (tag && !tags.includes(tag)) {
      setTags((prev) => [...prev, tag]);
    }
    setTagInput("");
  }, [tagInput, tags]);

  const handleRemoveTag = useCallback((tag: string) => {
    setTags((prev) => prev.filter((t) => t !== tag));
  }, []);

  const handleTagKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "Enter") {
        e.preventDefault();
        handleAddTag();
      }
    },
    [handleAddTag],
  );

  /* -- Checklist handler ------------------------------------------- */

  const handleChecklistChange = useCallback((items: ReadonlyArray<CheckListItem>) => {
    setChecklist(items);
  }, []);

  /* -- Markdown toolbar -------------------------------------------- */

  const insertMarkdown = useCallback(
    (before: string, after: string) => {
      const ta = textareaRef.current;
      if (!ta) return;
      const start = ta.selectionStart;
      const end = ta.selectionEnd;
      const selected = rawInput.slice(start, end);
      const replacement = before + (selected || "text") + after;
      const newValue = rawInput.slice(0, start) + replacement + rawInput.slice(end);
      setRawInput(newValue);
      requestAnimationFrame(() => {
        ta.focus();
        const cursorPos = start + before.length + (selected ? selected.length : 4);
        ta.setSelectionRange(cursorPos, cursorPos);
      });
    },
    [rawInput],
  );

  /* -- Save -------------------------------------------------------- */

  const handleSave = useCallback(async () => {
    if (!idea || !title.trim() || isSaving) return;
    setIsSaving(true);
    try {
      await updateIdea(idea.id, title.trim(), rawInput, JSON.stringify(tags), priority);
      const dateValue = plannedDate || null;
      if (dateValue !== idea.planned_date) {
        await updatePlannedDate(idea.id, dateValue);
      }
      await updateChecklist(idea.id, checklist.length > 0 ? checklist : null);
      handleClose();
    } finally {
      setIsSaving(false);
    }
  }, [
    idea,
    title,
    rawInput,
    tags,
    priority,
    plannedDate,
    checklist,
    isSaving,
    updateIdea,
    updatePlannedDate,
    updateChecklist,
    handleClose,
  ]);

  if (!idea) return null;

  const canSubmit = title.trim().length > 0 && !isSaving;

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
          borderLeft: "1px solid #27272a",
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
              <FilePen size={14} style={{ color: "#A855F7" }} />
            </div>
            <span style={{ fontSize: 15, fontWeight: 700, color: "var(--color-foreground)" }}>
              {t("ideaHub.edit.title")}
            </span>
          </div>
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
            <X size={12} style={{ color: "var(--color-muted)" }} />
          </button>
        </div>

        {/* Divider */}
        <div style={{ height: 1, backgroundColor: "var(--color-border)", flexShrink: 0 }} />

        {/* ---- Scrollable content ---- */}
        <div className="flex-1 overflow-y-auto" style={{ padding: 24 }}>
          <div className="flex flex-col" style={{ gap: 16 }}>
            {/* Title section */}
            <div className="flex flex-col" style={{ gap: 8 }}>
              <span style={{ fontSize: 12, fontWeight: 600, color: "var(--color-foreground)" }}>
                {t("ideaHub.create.titleLabel")}
              </span>
              <input
                ref={titleRef}
                type="text"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder={t("ideaHub.create.titlePlaceholder")}
                className="w-full"
                style={{
                  height: 40,
                  padding: "0 14px",
                  borderRadius: 8,
                  backgroundColor: "var(--color-background)",
                  border: "1px solid #27272a",
                  color: "var(--color-foreground)",
                  fontSize: 13,
                  outline: "none",
                  fontFamily: "Inter, sans-serif",
                }}
              />
            </div>

            {/* Description section */}
            <div className="flex flex-col" style={{ gap: 8 }}>
              <span style={{ fontSize: 12, fontWeight: 600, color: "var(--color-foreground)" }}>
                {t("ideaHub.create.descLabel")}
              </span>
              <div
                style={{
                  borderRadius: 8,
                  backgroundColor: "var(--color-background)",
                  border: "1px solid #27272a",
                  overflow: "hidden",
                }}
              >
                {/* Toolbar */}
                <div className="flex items-center" style={{ height: 36, padding: "0 8px", gap: 2 }}>
                  {FORMAT_BUTTONS.map((btn) => (
                    <ToolbarButton
                      key={btn.label}
                      btn={btn}
                      onClick={() => insertMarkdown(btn.before, btn.after)}
                    />
                  ))}
                  <ToolbarSeparator />
                  {HEADING_BUTTONS.map((btn) => (
                    <ToolbarButton
                      key={btn.label}
                      btn={btn}
                      onClick={() => insertMarkdown(btn.before, btn.after)}
                    />
                  ))}
                  <ToolbarSeparator />
                  {EXTRA_BUTTONS.map((btn) => (
                    <ToolbarButton
                      key={btn.label}
                      btn={btn}
                      onClick={() => insertMarkdown(btn.before, btn.after)}
                    />
                  ))}
                </div>

                {/* Toolbar divider */}
                <div style={{ height: 1, backgroundColor: "var(--color-border)" }} />

                {/* Textarea */}
                <textarea
                  ref={textareaRef}
                  value={rawInput}
                  onChange={(e) => setRawInput(e.target.value)}
                  placeholder={t("ideaHub.create.descPlaceholder")}
                  style={{
                    width: "100%",
                    minHeight: 200,
                    padding: 14,
                    border: "none",
                    backgroundColor: "transparent",
                    color: "var(--color-foreground)",
                    fontSize: 12,
                    lineHeight: 1.7,
                    outline: "none",
                    resize: "vertical",
                    fontFamily: "Inter, sans-serif",
                  }}
                />
              </div>
            </div>

            {/* Divider */}
            <div style={{ height: 1, backgroundColor: "var(--color-border)" }} />

            {/* ---- Meta row: priority | date | tags ---- */}
            <div className="flex items-center flex-wrap" style={{ gap: 10 }}>
              {/* Priority */}
              <div className="flex items-center" style={{ gap: 6 }}>
                <span style={{ fontSize: 11, color: "var(--color-muted)" }}>
                  {t("ideaHub.capture.priority")}
                </span>
                {PRIORITY_OPTIONS.map((p) => (
                  <button
                    key={p.value}
                    onClick={() => setPriority(p.value)}
                    className="flex items-center justify-center"
                    style={{
                      height: 24,
                      padding: "0 8px",
                      borderRadius: 4,
                      border: `1px solid ${priority === p.value ? p.borderActive : "var(--color-border)"}`,
                      backgroundColor: priority === p.value ? p.bg : "transparent",
                      cursor: "pointer",
                    }}
                  >
                    <span
                      style={{
                        fontSize: 10,
                        fontWeight: priority === p.value ? 600 : 500,
                        color: priority === p.value ? p.color : "var(--color-text-tertiary)",
                      }}
                    >
                      {t(
                        `ideaHub.capture.priority${p.value.charAt(0).toUpperCase()}${p.value.slice(1)}`,
                      )}
                    </span>
                  </button>
                ))}
              </div>

              {/* Separator */}
              <div style={{ width: 1, height: 16, backgroundColor: "var(--color-border)" }} />

              {/* Date */}
              <div className="flex items-center" style={{ gap: 6 }}>
                <Calendar size={14} style={{ color: "var(--color-muted)", flexShrink: 0 }} />
                <input
                  type="date"
                  value={plannedDate}
                  onChange={(e) => setPlannedDate(e.target.value)}
                  style={{
                    height: 24,
                    padding: "0 8px",
                    borderRadius: 4,
                    backgroundColor: "var(--color-background)",
                    border: "1px solid #27272a",
                    color: plannedDate ? "var(--color-foreground)" : "var(--color-text-tertiary)",
                    fontSize: 10,
                    outline: "none",
                    fontFamily: "Inter, sans-serif",
                  }}
                />
              </div>

              {/* Separator */}
              <div style={{ width: 1, height: 16, backgroundColor: "var(--color-border)" }} />

              {/* Tags */}
              <div className="flex items-center flex-wrap" style={{ gap: 5 }}>
                <Tag size={12} style={{ color: "var(--color-muted)", flexShrink: 0 }} />
                {tags.map((tag, idx) => {
                  const palette = TAG_PALETTE[idx % TAG_PALETTE.length];
                  return (
                    <div
                      key={tag}
                      className="flex items-center"
                      style={{
                        height: 20,
                        padding: "0 6px",
                        borderRadius: 3,
                        backgroundColor: palette.bg,
                        gap: 3,
                        cursor: "pointer",
                      }}
                      onClick={() => handleRemoveTag(tag)}
                    >
                      <span style={{ fontSize: 9, fontWeight: 500, color: palette.color }}>
                        {tag}
                      </span>
                    </div>
                  );
                })}
                <div
                  className="flex items-center justify-center"
                  style={{
                    height: 20,
                    minWidth: 20,
                    padding: "0 6px",
                    borderRadius: 3,
                    border: "1px solid #3f3f46",
                  }}
                >
                  <input
                    type="text"
                    value={tagInput}
                    onChange={(e) => setTagInput(e.target.value)}
                    onKeyDown={handleTagKeyDown}
                    onBlur={handleAddTag}
                    placeholder="+"
                    style={{
                      width: tagInput ? 60 : 10,
                      border: "none",
                      backgroundColor: "transparent",
                      color: "var(--color-text-tertiary)",
                      fontSize: 10,
                      fontWeight: 500,
                      outline: "none",
                      textAlign: tagInput ? "left" : "center",
                      transition: "width 0.15s ease",
                    }}
                    onFocus={(e) => {
                      e.currentTarget.style.width = "60px";
                      e.currentTarget.style.textAlign = "left";
                    }}
                  />
                </div>
              </div>
            </div>

            {/* Divider */}
            <div style={{ height: 1, backgroundColor: "var(--color-border)" }} />

            {/* ---- Checklist section ---- */}
            <IdeaChecklist items={checklist} onChange={handleChecklistChange} />
          </div>
        </div>

        {/* ---- Bottom action bar ---- */}
        <div
          className="flex items-center justify-end shrink-0"
          style={{
            height: 64,
            padding: "0 24px",
            borderTop: "1px solid #27272a",
            gap: 10,
          }}
        >
          <button
            onClick={handleClose}
            className="flex items-center justify-center native-css-hover"
            style={
              {
                height: 36,
                padding: "0 16px",
                borderRadius: 8,
                border: "1px solid #27272a",
                backgroundColor: "transparent",
                cursor: "pointer",
                "--native-hover-border-color": "var(--color-border-strong)",
              } as React.CSSProperties
            }
          >
            <span style={{ fontSize: 12, fontWeight: 500, color: "var(--color-muted-foreground)" }}>
              {t("ideaHub.edit.cancel")}
            </span>
          </button>
          <button
            onClick={handleSave}
            disabled={!canSubmit}
            className="flex items-center native-css-hover"
            style={
              {
                height: 36,
                padding: "0 20px",
                borderRadius: 8,
                backgroundColor: canSubmit ? "#22C55E" : "var(--color-border)",
                border: "none",
                cursor: canSubmit ? "pointer" : "not-allowed",
                gap: 6,
                opacity: isSaving ? 0.7 : 1,
                "--native-hover-opacity": canSubmit ? "0.9" : undefined,
              } as React.CSSProperties
            }
          >
            <Sparkles size={14} style={{ color: "#0D0D0D" }} />
            <span
              style={{
                fontSize: 12,
                fontWeight: 600,
                color: canSubmit ? "#0D0D0D" : "var(--color-text-tertiary)",
              }}
            >
              {t("ideaHub.edit.save")}
            </span>
          </button>
        </div>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Toolbar sub-components                                             */
/* ------------------------------------------------------------------ */

const ICON_MAP: Record<string, React.ReactNode> = {
  list: <List size={12} />,
  link: <Link2 size={11} />,
};

function ToolbarButton({
  btn,
  onClick,
}: {
  readonly btn: ToolbarBtn;
  readonly onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className="flex items-center justify-center native-css-hover"
      style={
        {
          width: 28,
          height: 28,
          borderRadius: 4,
          border: "none",
          background: "transparent",
          cursor: "pointer",
          color: "var(--color-muted-foreground)",
          fontSize: btn.size,
          fontWeight: btn.weight ?? "normal",
          fontFamily: btn.mono ? "'JetBrains Mono', monospace" : undefined,
          "--native-hover-bg-color": "var(--color-border)",
        } as React.CSSProperties
      }
    >
      {ICON_MAP[btn.label] ?? btn.label}
    </button>
  );
}

function ToolbarSeparator() {
  return (
    <div
      style={{
        width: 1,
        height: 16,
        backgroundColor: "var(--color-border)",
        margin: "0 2px",
        flexShrink: 0,
      }}
    />
  );
}
