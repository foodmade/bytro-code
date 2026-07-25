import { useCallback, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  DndContext,
  DragOverlay,
  closestCorners,
  PointerSensor,
  useSensor,
  useSensors,
  useDroppable,
  type DragStartEvent,
  type DragEndEvent,
  type DragOverEvent,
} from "@dnd-kit/core";
import {
  SortableContext,
  verticalListSortingStrategy,
  arrayMove,
} from "@dnd-kit/sortable";
import { Ellipsis } from "lucide-react";
import type { IdeaSummary, IdeaStatusCounts } from "@/stores";
import { useIdeaStore } from "@/stores";
import { IdeaCard } from "./idea-card";
import { SortableIdeaCard } from "./sortable-idea-card";
import { DoneIdeasSection } from "./done-ideas-section";

interface KanbanColumnConfig {
  readonly key: string;
  readonly labelKey: string;
  readonly dotColor: string;
  readonly countBg: string;
  readonly countColor: string;
}

const COLUMNS: ReadonlyArray<KanbanColumnConfig> = [
  { key: "draft", labelKey: "ideaHub.columns.draft", dotColor: "#6B7280", countBg: "#6B728020", countColor: "#6B7280" },
  { key: "discussing", labelKey: "ideaHub.columns.discussing", dotColor: "#A855F7", countBg: "rgba(var(--theme-accent-rgb),0.125)", countColor: "#A855F7" },
  { key: "ready", labelKey: "ideaHub.columns.ready", dotColor: "#22C55E", countBg: "#22C55E20", countColor: "#22C55E" },
  { key: "building", labelKey: "ideaHub.columns.building", dotColor: "#3B82F6", countBg: "#3B82F620", countColor: "#3B82F6" },
];

const COLUMN_KEYS = COLUMNS.map((c) => c.key);

export function KanbanBoard({
  ideas,
  statusCounts,
  onAction,
  onDelete,
  onSelect,
  onGoToDiscussion,
  onComplete,
  onEdit,
}: {
  readonly ideas: ReadonlyArray<IdeaSummary>;
  readonly statusCounts: IdeaStatusCounts;
  readonly onAction: (idea: IdeaSummary) => void;
  readonly onDelete: (id: string) => void;
  readonly onSelect: (id: string) => void;
  readonly onGoToDiscussion?: (id: string) => void;
  readonly onComplete?: (id: string) => void;
  readonly onEdit?: (id: string) => void;
}) {
  const updateIdeaStatus = useIdeaStore((s) => s.updateIdeaStatus);
  const updateSortOrders = useIdeaStore((s) => s.updateSortOrders);
  const uncompleteIdea = useIdeaStore((s) => s.uncompleteIdea);
  const doneIdeas = useIdeaStore((s) => s.doneIdeas);
  const isDoneSectionExpanded = useIdeaStore((s) => s.isDoneSectionExpanded);
  const setDoneSectionExpanded = useIdeaStore((s) => s.setDoneSectionExpanded);
  const loadDoneIdeas = useIdeaStore((s) => s.loadDoneIdeas);

  const [activeId, setActiveId] = useState<string | null>(null);
  const [originalColumn, setOriginalColumn] = useState<string | null>(null);
  const [localGroups, setLocalGroups] = useState<Record<string, IdeaSummary[]> | null>(null);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
  );

  const groupedIdeas = useMemo(() => {
    if (localGroups) return localGroups;
    const groups: Record<string, IdeaSummary[]> = {
      draft: [],
      discussing: [],
      ready: [],
      building: [],
    };
    for (const idea of ideas) {
      const bucket = idea.status === "marked" ? "discussing" : idea.status;
      const group = groups[bucket];
      if (group) {
        group.push(idea);
      }
    }
    return groups;
  }, [ideas, localGroups]);

  const activeIdea = useMemo(
    () => (activeId ? ideas.find((i) => i.id === activeId) ?? null : null),
    [activeId, ideas],
  );

  const countMap: Record<string, number> = useMemo(() => ({
    draft: statusCounts.draft,
    discussing: statusCounts.discussing + statusCounts.marked,
    ready: statusCounts.ready,
    building: statusCounts.building,
  }), [statusCounts]);

  const findColumnForId = useCallback(
    (id: string): string | null => {
      const source = localGroups ?? groupedIdeas;
      for (const key of COLUMN_KEYS) {
        if (source[key]?.some((i) => i.id === id)) return key;
      }
      return null;
    },
    [groupedIdeas, localGroups],
  );

  const handleDragStart = useCallback((event: DragStartEvent) => {
    const id = String(event.active.id);
    setActiveId(id);
    for (const key of COLUMN_KEYS) {
      if (groupedIdeas[key]?.some((i) => i.id === id)) {
        setOriginalColumn(key);
        break;
      }
    }
    setLocalGroups({ ...groupedIdeas });
  }, [groupedIdeas]);

  const handleDragOver = useCallback(
    (event: DragOverEvent) => {
      const { active, over } = event;
      if (!over || !localGroups) return;

      const activeCol = findColumnForId(String(active.id));
      let overCol: string | null = null;

      if (COLUMN_KEYS.includes(String(over.id))) {
        overCol = String(over.id);
      } else {
        overCol = findColumnForId(String(over.id));
      }

      if (!activeCol || !overCol) return;

      // Same-column reorder
      if (activeCol === overCol) {
        const overId = String(over.id);
        if (COLUMN_KEYS.includes(overId)) return;

        setLocalGroups((prev) => {
          if (!prev) return prev;
          const items = [...(prev[activeCol] ?? [])];
          const oldIndex = items.findIndex((i) => i.id === String(active.id));
          const newIndex = items.findIndex((i) => i.id === overId);
          if (oldIndex === -1 || newIndex === -1 || oldIndex === newIndex) return prev;
          return { ...prev, [activeCol]: arrayMove(items, oldIndex, newIndex) };
        });
        return;
      }

      // Cross-column move
      setLocalGroups((prev) => {
        if (!prev) return prev;
        const sourceItems = [...(prev[activeCol] ?? [])];
        const destItems = [...(prev[overCol!] ?? [])];
        const activeIndex = sourceItems.findIndex((i) => i.id === String(active.id));
        if (activeIndex === -1) return prev;

        const [moved] = sourceItems.splice(activeIndex, 1);
        const overIndex = destItems.findIndex((i) => i.id === String(over.id));
        const insertAt = overIndex >= 0 ? overIndex : destItems.length;
        destItems.splice(insertAt, 0, moved);

        return { ...prev, [activeCol]: sourceItems, [overCol!]: destItems };
      });
    },
    [findColumnForId, localGroups],
  );

  const handleDragEnd = useCallback(
    async (event: DragEndEvent) => {
      const { active, over } = event;
      setActiveId(null);

      if (!over || !localGroups) {
        setLocalGroups(null);
        setOriginalColumn(null);
        return;
      }

      const currentCol = findColumnForId(String(active.id));
      let dropCol: string | null = null;
      if (COLUMN_KEYS.includes(String(over.id))) {
        dropCol = String(over.id);
      } else {
        dropCol = findColumnForId(String(over.id));
      }

      const targetCol = dropCol ?? currentCol;

      if (!targetCol) {
        setLocalGroups(null);
        setOriginalColumn(null);
        return;
      }

      const isCrossColumn = originalColumn !== null && originalColumn !== targetCol;

      try {
        if (isCrossColumn) {
          await updateIdeaStatus(String(active.id), targetCol);
          const destItems = localGroups[targetCol] ?? [];
          const sortUpdates = destItems.map((item, idx) => ({
            id: item.id,
            sortOrder: idx * 100,
          }));
          if (sortUpdates.length > 0) {
            await updateSortOrders(sortUpdates);
          }
        } else {
          // localGroups already reflects the reordered state from handleDragOver,
          // just persist the current order directly.
          const items = localGroups[targetCol] ?? [];
          const sortUpdates = items.map((item, idx) => ({
            id: item.id,
            sortOrder: idx * 100,
          }));
          if (sortUpdates.length > 0) {
            await updateSortOrders(sortUpdates);
          }
        }
      } catch {
        // Revert on error
      }

      setLocalGroups(null);
      setOriginalColumn(null);
    },
    [findColumnForId, localGroups, originalColumn, updateIdeaStatus, updateSortOrders],
  );

  const handleDragCancel = useCallback(() => {
    setActiveId(null);
    setOriginalColumn(null);
    setLocalGroups(null);
  }, []);

  const handleToggleDone = useCallback(() => {
    const next = !isDoneSectionExpanded;
    setDoneSectionExpanded(next);
    if (next && doneIdeas.length === 0) {
      loadDoneIdeas();
    }
  }, [isDoneSectionExpanded, setDoneSectionExpanded, doneIdeas.length, loadDoneIdeas]);

  const handleUncomplete = useCallback(
    (id: string) => { uncompleteIdea(id); },
    [uncompleteIdea],
  );

  return (
    <div className="flex flex-col flex-1 min-h-0">
      <DndContext
        sensors={sensors}
        collisionDetection={closestCorners}
        onDragStart={handleDragStart}
        onDragOver={handleDragOver}
        onDragEnd={handleDragEnd}
        onDragCancel={handleDragCancel}
      >
        <div
          className="flex flex-1 min-h-0"
          style={{ gap: 16, padding: "20px 28px" }}
        >
          {COLUMNS.map((col) => (
            <KanbanColumn
              key={col.key}
              column={col}
              ideas={groupedIdeas[col.key] ?? []}
              count={countMap[col.key] ?? 0}
              onAction={onAction}
              onDelete={onDelete}
              onSelect={onSelect}
              onGoToDiscussion={onGoToDiscussion}
              onComplete={onComplete}
              onEdit={onEdit}
            />
          ))}
        </div>

        <DragOverlay>
          {activeIdea ? (
            <div style={{ opacity: 0.9, pointerEvents: "none" }}>
              <IdeaCard
                idea={activeIdea}
                onAction={() => {}}
                onDelete={() => {}}
                onSelect={() => {}}
              />
            </div>
          ) : null}
        </DragOverlay>
      </DndContext>

      <DoneIdeasSection
        ideas={doneIdeas}
        isExpanded={isDoneSectionExpanded}
        onToggle={handleToggleDone}
        onUncomplete={handleUncomplete}
        onDelete={onDelete}
        onSelect={onSelect}
      />
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Column                                                             */
/* ------------------------------------------------------------------ */

function KanbanColumn({
  column,
  ideas,
  count,
  onAction,
  onDelete,
  onSelect,
  onGoToDiscussion,
  onComplete,
  onEdit,
}: {
  readonly column: KanbanColumnConfig;
  readonly ideas: ReadonlyArray<IdeaSummary>;
  readonly count: number;
  readonly onAction: (idea: IdeaSummary) => void;
  readonly onDelete: (id: string) => void;
  readonly onSelect: (id: string) => void;
  readonly onGoToDiscussion?: (id: string) => void;
  readonly onComplete?: (id: string) => void;
  readonly onEdit?: (id: string) => void;
}) {
  const { t } = useTranslation();
  const { setNodeRef } = useDroppable({ id: column.key });
  const ideaIds = useMemo(() => ideas.map((i) => i.id), [ideas]);

  return (
    <div
      className="flex flex-col flex-1 min-w-0"
      style={{ gap: 12 }}
    >
      {/* Column header */}
      <div
        className="flex items-center justify-between shrink-0"
        style={{ padding: "0 4px" }}
      >
        <div className="flex items-center" style={{ gap: 8 }}>
          <span
            style={{
              width: 8,
              height: 8,
              borderRadius: 4,
              backgroundColor: column.dotColor,
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
            {t(column.labelKey)}
          </span>
          <div
            className="flex items-center justify-center"
            style={{
              height: 18,
              padding: "0 8px",
              borderRadius: 9,
              backgroundColor: column.countBg,
            }}
          >
            <span
              style={{
                fontSize: 10,
                fontWeight: 700,
                color: column.countColor,
                fontFamily: "'JetBrains Mono', monospace",
                lineHeight: 1,
              }}
            >
              {count}
            </span>
          </div>
        </div>
        <Ellipsis size={16} style={{ color: "var(--color-border-strong)", cursor: "pointer" }} />
      </div>

      {/* Cards with DnD */}
      <SortableContext items={ideaIds} strategy={verticalListSortingStrategy}>
        <div
          ref={setNodeRef}
          className="flex flex-col flex-1 overflow-y-auto"
          style={{ gap: 8, minHeight: 60 }}
        >
          {ideas.length === 0 && (
            <div
              className="flex items-center justify-center"
              style={{
                padding: "32px 16px",
                color: "var(--color-border-strong)",
                fontSize: 11,
                fontStyle: "italic",
              }}
            >
              {t("ideaHub.noIdeas")}
            </div>
          )}
          {ideas.map((idea) => (
            <SortableIdeaCard
              key={idea.id}
              idea={idea}
              onAction={onAction}
              onDelete={onDelete}
              onSelect={onSelect}
              onGoToDiscussion={onGoToDiscussion}
              onComplete={onComplete}
              onEdit={onEdit}
            />
          ))}
        </div>
      </SortableContext>
    </div>
  );
}
