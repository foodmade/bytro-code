import { useEffect, useRef, useState } from "react";
import { Folder, File } from "lucide-react";

/** Inline input row shown inside the tree when creating a new file/folder */
export function InlineCreateInput({
  type,
  depth,
  onConfirm,
  onCancel,
}: {
  readonly type: "file" | "dir";
  readonly depth: number;
  readonly onConfirm: (name: string) => void;
  readonly onCancel: () => void;
}) {
  const [value, setValue] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const handleSubmit = () => {
    const trimmed = value.trim();
    if (trimmed) {
      onConfirm(trimmed);
    } else {
      onCancel();
    }
  };

  return (
    <div
      className="flex items-center gap-2 text-[12px] font-sans"
      style={{ paddingLeft: depth * 16 + 16, paddingTop: 4, paddingBottom: 4 }}
    >
      <span className="w-3 shrink-0" />
      {type === "dir" ? (
        <Folder size={14} className="shrink-0" style={{ color: "#4285F4" }} />
      ) : (
        <File size={14} className="shrink-0" style={{ color: "#777777" }} />
      )}
      <input
        ref={inputRef}
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onBlur={handleSubmit}
        onKeyDown={(e) => {
          if (e.key === "Enter") handleSubmit();
          if (e.key === "Escape") onCancel();
        }}
        className="flex-1 min-w-0 bg-surface-dark border border-border-strong rounded px-1.5 py-0.5 text-[12px] text-foreground font-sans outline-none focus:border-accent-purple"
        placeholder={type === "dir" ? "folder name" : "file name"}
      />
    </div>
  );
}
