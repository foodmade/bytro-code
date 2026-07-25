import { useCallback, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  DndContext,
  closestCenter,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import {
  SortableContext,
  verticalListSortingStrategy,
  useSortable,
  arrayMove,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { CheckSquare, Plus, Trash2, GripVertical, Square } from "lucide-react";
import type { CheckListItem } from "@/stores";

/* ------------------------------------------------------------------ */
/*  Sortable checklist item                                            */
/* ------------------------------------------------------------------ */

function SortableChecklistItem({
  item,
  readonly,
  onToggle,
  onTextChange,
  onDelete,
}: {
  readonly item: CheckListItem;
  readonly readonly: boolean;
  readonly onToggle: (id: string) => void;
  readonly onTextChange: (id: string, text: string) => void;
  readonly onDelete: (id: string) => void;
}) {
  const {
    attributes,
    listeners,
    setNodeRef,
    setActivatorNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: item.id });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.4 : 1,
    zIndex: isDragging ? 10 : undefined,
  };

  return (
    <div ref={setNodeRef} style={style} {...attributes} className="flex items-center group">
      <div
        className="flex items-center native-css-hover"
        style={
          {
            flex: 1,
            gap: 8,
            padding: "6px 8px",
            borderRadius: 6,
            transition: "background-color 0.1s ease",
            "--native-hover-bg-color": "var(--color-surface)",
          } as React.CSSProperties
        }
      >
        {/* Drag handle */}
        {!readonly && (
          <div
            ref={setActivatorNodeRef}
            {...listeners}
            style={{
              cursor: "grab",
              display: "flex",
              alignItems: "center",
              flexShrink: 0,
              opacity: 0,
              transition: "opacity 0.1s ease",
              touchAction: "none",
            }}
            className="group-hover:!opacity-60"
          >
            <GripVertical size={12} style={{ color: "var(--color-border-strong)" }} />
          </div>
        )}

        {/* Checkbox */}
        <button
          onClick={() => onToggle(item.id)}
          style={{
            border: "none",
            background: "transparent",
            cursor: readonly ? "default" : "pointer",
            padding: 0,
            display: "flex",
            flexShrink: 0,
          }}
        >
          {item.checked ? (
            <CheckSquare size={16} style={{ color: "var(--color-accent-green)" }} />
          ) : (
            <Square size={16} style={{ color: "var(--color-border-strong)" }} />
          )}
        </button>

        {/* Text */}
        {readonly ? (
          <span
            style={{
              flex: 1,
              fontSize: 12,
              color: item.checked ? "var(--color-muted)" : "var(--color-foreground)",
              textDecoration: item.checked ? "line-through" : "none",
              lineHeight: 1.4,
            }}
          >
            {item.text}
          </span>
        ) : (
          <input
            value={item.text}
            onChange={(e) => onTextChange(item.id, e.target.value)}
            style={{
              flex: 1,
              fontSize: 12,
              color: item.checked ? "var(--color-muted)" : "var(--color-foreground)",
              textDecoration: item.checked ? "line-through" : "none",
              border: "none",
              outline: "none",
              background: "transparent",
              padding: 0,
              lineHeight: 1.4,
            }}
          />
        )}

        {/* Delete */}
        {!readonly && (
          <button
            onClick={() => onDelete(item.id)}
            style={{
              border: "none",
              background: "transparent",
              cursor: "pointer",
              padding: 2,
              display: "flex",
              opacity: 0,
              transition: "opacity 0.1s ease",
              flexShrink: 0,
            }}
            className="group-hover:!opacity-100"
          >
            <Trash2 size={12} style={{ color: "var(--color-muted)" }} />
          </button>
        )}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Main checklist component                                           */
/* ------------------------------------------------------------------ */

export function IdeaChecklist({
  items,
  onChange,
  readonly = false,
}: {
  readonly items: ReadonlyArray<CheckListItem>;
  readonly onChange: (items: ReadonlyArray<CheckListItem>) => void;
  readonly readonly?: boolean;
}) {
  const { t } = useTranslation();
  const [newItemText, setNewItemText] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }));

  const handleAddItem = useCallback(() => {
    const text = newItemText.trim();
    if (!text) return;
    const newItem: CheckListItem = {
      id: crypto.randomUUID(),
      text,
      checked: false,
    };
    onChange([...items, newItem]);
    setNewItemText("");
    setTimeout(() => inputRef.current?.focus(), 50);
  }, [newItemText, items, onChange]);

  const handleToggle = useCallback(
    (id: string) => {
      onChange(items.map((item) => (item.id === id ? { ...item, checked: !item.checked } : item)));
    },
    [items, onChange],
  );

  const handleDelete = useCallback(
    (id: string) => {
      onChange(items.filter((item) => item.id !== id));
    },
    [items, onChange],
  );

  const handleTextChange = useCallback(
    (id: string, text: string) => {
      onChange(items.map((item) => (item.id === id ? { ...item, text } : item)));
    },
    [items, onChange],
  );

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "Enter") {
        e.preventDefault();
        handleAddItem();
      }
    },
    [handleAddItem],
  );

  const handleDragEnd = useCallback(
    (event: DragEndEvent) => {
      const { active, over } = event;
      if (!over || active.id === over.id) return;

      const oldIndex = items.findIndex((i) => i.id === active.id);
      const newIndex = items.findIndex((i) => i.id === over.id);
      if (oldIndex === -1 || newIndex === -1) return;

      onChange(arrayMove([...items], oldIndex, newIndex));
    },
    [items, onChange],
  );

  const checkedCount = items.filter((i) => i.checked).length;
  const totalCount = items.length;
  const itemIds = items.map((i) => i.id);

  return (
    <div className="flex flex-col" style={{ gap: 8 }}>
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center" style={{ gap: 6 }}>
          <CheckSquare size={14} style={{ color: "var(--color-accent-purple)" }} />
          <span
            style={{
              fontSize: 12,
              fontWeight: 600,
              color: "var(--color-foreground)",
            }}
          >
            {t("ideaHub.checklist.title")}
          </span>
        </div>
        {totalCount > 0 && (
          <span
            style={{
              fontSize: 11,
              color:
                checkedCount === totalCount ? "var(--color-accent-green)" : "var(--color-muted)",
              fontFamily: "'JetBrains Mono', monospace",
            }}
          >
            {t("ideaHub.checklist.progress", { done: checkedCount, total: totalCount })}
          </span>
        )}
      </div>

      {/* Progress bar */}
      {totalCount > 0 && (
        <div
          style={{
            height: 3,
            borderRadius: 2,
            backgroundColor: "var(--color-border)",
            overflow: "hidden",
          }}
        >
          <div
            style={{
              height: "100%",
              width: `${totalCount > 0 ? (checkedCount / totalCount) * 100 : 0}%`,
              backgroundColor:
                checkedCount === totalCount
                  ? "var(--color-accent-green)"
                  : "var(--color-accent-purple)",
              borderRadius: 2,
              transition: "width 0.2s ease, background-color 0.2s ease",
            }}
          />
        </div>
      )}

      {/* Items with drag-and-drop */}
      <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
        <SortableContext items={itemIds} strategy={verticalListSortingStrategy}>
          <div className="flex flex-col" style={{ gap: 2 }}>
            {items.map((item) => (
              <SortableChecklistItem
                key={item.id}
                item={item}
                readonly={readonly}
                onToggle={handleToggle}
                onTextChange={handleTextChange}
                onDelete={handleDelete}
              />
            ))}
          </div>
        </SortableContext>
      </DndContext>

      {/* Add new item */}
      {!readonly && (
        <div
          className="flex items-center"
          style={{
            gap: 8,
            padding: "6px 8px",
            borderRadius: 6,
          }}
        >
          <Plus size={14} style={{ color: "var(--color-muted)", flexShrink: 0 }} />
          <input
            ref={inputRef}
            value={newItemText}
            onChange={(e) => setNewItemText(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder={t("ideaHub.checklist.addItem")}
            style={{
              flex: 1,
              fontSize: 12,
              color: "var(--color-foreground)",
              border: "none",
              outline: "none",
              background: "transparent",
              padding: 0,
            }}
          />

          {newItemText.trim() && (
            <button
              onClick={handleAddItem}
              style={{
                fontSize: 11,
                color: "var(--color-accent-purple)",
                border: "none",
                background: "transparent",
                cursor: "pointer",
                padding: "2px 6px",
                borderRadius: 4,
                fontWeight: 500,
              }}
            >
              {t("ideaHub.checklist.add")}
            </button>
          )}
        </div>
      )}
    </div>
  );
}
