import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import type { IdeaSummary } from "@/stores";
import { IdeaCard } from "./idea-card";

export function SortableIdeaCard({
  idea,
  onAction,
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
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({
    id: idea.id,
    data: { status: idea.status },
  });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.4 : 1,
    zIndex: isDragging ? 10 : undefined,
  };

  return (
    <div ref={setNodeRef} style={style} {...attributes} {...listeners}>
      <IdeaCard
        idea={idea}
        onAction={onAction}
        onDelete={onDelete}
        onSelect={onSelect}
        onGoToDiscussion={onGoToDiscussion}
        onComplete={onComplete}
        onEdit={onEdit}
      />
    </div>
  );
}
