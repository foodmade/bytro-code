import { useCallback } from "react";
import { useTranslation } from "react-i18next";
import { RotateCcw, Trash2 } from "lucide-react";
import type { IdeaSummary } from "@/stores";

export function DoneIdeasSection({
  ideas,
  isExpanded,
  onToggle,
  onUncomplete,
  onDelete,
  onSelect,
}: {
  readonly ideas: ReadonlyArray<IdeaSummary>;
  readonly isExpanded: boolean;
  readonly onToggle: () => void;
  readonly onUncomplete: (id: string) => void;
  readonly onDelete: (id: string) => void;
  readonly onSelect: (id: string) => void;
}) {
  const { t } = useTranslation();

  if (ideas.length === 0) return null;

  return (
    <div>
      {/* Divider */}
      <div style={{ height: 1, backgroundColor: "var(--color-border)" }} />

      {/* Toggle bar */}
      <button
        onClick={onToggle}
        className="flex items-center justify-between w-full"
        style={{
          height: 44,
          padding: "0 28px",
          border: "none",
          background: "transparent",
          cursor: "pointer",
        }}
      >
        <div className="flex items-center" style={{ gap: 10 }}>
          <span
            style={{
              fontSize: 12,
              color: "var(--color-border-strong)",
              transition: "transform 0.15s",
              transform: isExpanded ? "rotate(90deg)" : "rotate(0deg)",
            }}
          >
            ▸
          </span>
          <span
            style={{
              width: 8,
              height: 8,
              borderRadius: 4,
              backgroundColor: "#22C55E",
              flexShrink: 0,
            }}
          />

          <span
            style={{
              fontSize: 13,
              fontWeight: 600,
              color: "var(--color-muted-foreground)",
            }}
          >
            {t("ideaHub.doneSection.title")}
          </span>
          <div
            className="flex items-center justify-center"
            style={{
              height: 18,
              padding: "0 8px",
              borderRadius: 9,
              backgroundColor: "#22C55E20",
            }}
          >
            <span
              style={{
                fontSize: 10,
                fontWeight: 700,
                color: "#22C55E",
                fontFamily: "'JetBrains Mono', monospace",
                lineHeight: 1,
              }}
            >
              {ideas.length}
            </span>
          </div>
        </div>
        <span
          style={{
            fontSize: 11,
            color: "var(--color-border-strong)",
          }}
        >
          {isExpanded ? t("ideaHub.doneSection.collapse") : t("ideaHub.doneSection.expand")}
        </span>
      </button>

      {/* Expanded card list */}
      {isExpanded && (
        <div className="flex flex-wrap" style={{ gap: 8, padding: "0 28px 16px" }}>
          {ideas.map((idea) => (
            <DoneIdeaCard
              key={idea.id}
              idea={idea}
              onUncomplete={onUncomplete}
              onDelete={onDelete}
              onSelect={onSelect}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function DoneIdeaCard({
  idea,
  onUncomplete,
  onDelete,
  onSelect,
}: {
  readonly idea: IdeaSummary;
  readonly onUncomplete: (id: string) => void;
  readonly onDelete: (id: string) => void;
  readonly onSelect: (id: string) => void;
}) {
  const { t } = useTranslation();

  const handleUncomplete = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation();
      onUncomplete(idea.id);
    },
    [idea.id, onUncomplete],
  );

  const handleDelete = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation();
      onDelete(idea.id);
    },
    [idea.id, onDelete],
  );

  return (
    <div
      onClick={() => onSelect(idea.id)}
      className="group flex items-center cursor-pointer native-css-hover"
      style={
        {
          gap: 8,
          padding: "8px 12px",
          borderRadius: 8,
          backgroundColor: "var(--color-card)",
          border: "1px solid #27272a",
          maxWidth: 280,
          transition: "border-color 0.15s ease",
          "--native-hover-border-color": "var(--color-border-strong)",
        } as React.CSSProperties
      }
    >
      <span
        style={{
          width: 16,
          height: 16,
          borderRadius: "50%",
          backgroundColor: "#22C55E20",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          flexShrink: 0,
          fontSize: 10,
          color: "#22C55E",
        }}
      >
        ✓
      </span>
      <span
        className="truncate"
        style={{
          fontSize: 12,
          color: "var(--color-muted)",
          textDecoration: "line-through",
          flex: 1,
        }}
      >
        {idea.title}
      </span>
      <button
        onClick={handleUncomplete}
        title={t("ideaHub.card.uncomplete")}
        className="opacity-0 group-hover:opacity-100 transition-opacity"
        style={{
          padding: 2,
          border: "none",
          background: "transparent",
          cursor: "pointer",
          flexShrink: 0,
        }}
      >
        <RotateCcw size={12} style={{ color: "var(--color-muted)" }} />
      </button>
      <button
        onClick={handleDelete}
        title={t("ideaHub.contextMenu.delete")}
        className="opacity-0 group-hover:opacity-100 transition-opacity"
        style={{
          padding: 2,
          border: "none",
          background: "transparent",
          cursor: "pointer",
          flexShrink: 0,
        }}
      >
        <Trash2 size={12} style={{ color: "#EF4444" }} />
      </button>
    </div>
  );
}
