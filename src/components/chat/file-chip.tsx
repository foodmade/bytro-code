import { FileText, FolderOpen, X } from "lucide-react";
import { cn } from "@/lib/utils";

interface FileChipProps {
  readonly name: string;
  readonly isDir?: boolean;
  readonly highlighted?: boolean;
  readonly onRemove: () => void;
}

export function FileChip({ name, isDir, highlighted, onRemove }: FileChipProps) {
  const Icon = isDir ? FolderOpen : FileText;
  const bgColor = isDir ? "#1A2E1A" : "#1E1233";
  const textColor = isDir ? "#86EFAC" : "#C4B5FD";
  const iconColor = isDir ? "#F59E0B" : "#A78BFA";
  const closeColor = isDir ? "#4B7A4B" : "#7C6BAE";
  const closeHoverColor = isDir ? "#86EFAC" : "#C4B5FD";

  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 px-2 py-0.5 rounded text-[11px] font-sans shrink-0 transition-shadow",
        highlighted && "ring-1 ring-accent-purple shadow-[0_0_6px_rgba(var(--theme-accent-rgb),0.3)]",
      )}
      style={{ backgroundColor: bgColor, color: textColor }}
    >
      <Icon size={10} style={{ color: iconColor }} className="shrink-0" />
      <span className="truncate max-w-[120px]">{name}</span>
      <button
        onClick={onRemove}
        className="ml-0.5 native-css-hover"
        style={
          {
            color: closeColor,
            "--native-hover-color": closeHoverColor,
          } as React.CSSProperties
        }
      >
        <X size={10} />
      </button>
    </span>
  );
}
