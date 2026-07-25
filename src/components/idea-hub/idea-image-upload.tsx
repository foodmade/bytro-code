import { useCallback, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { ImagePlus, Loader2 } from "lucide-react";

const ACCEPTED_TYPES = ["image/png", "image/jpeg", "image/webp", "image/gif"];
const MAX_SIZE_MB = 10;

export function IdeaImageUpload({
  onUpload,
  disabled = false,
}: {
  readonly onUpload: (imageData: number[], ext: string) => Promise<void>;
  readonly disabled?: boolean;
}) {
  const { t } = useTranslation();
  const [isUploading, setIsUploading] = useState(false);
  const [isDragOver, setIsDragOver] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const processFile = useCallback(
    async (file: File) => {
      if (!ACCEPTED_TYPES.includes(file.type)) return;
      if (file.size > MAX_SIZE_MB * 1024 * 1024) return;

      setIsUploading(true);
      try {
        const buffer = await file.arrayBuffer();
        const uint8 = new Uint8Array(buffer);
        const ext = file.name.split(".").pop()?.toLowerCase() ?? "png";
        await onUpload(Array.from(uint8), ext);
      } finally {
        setIsUploading(false);
      }
    },
    [onUpload],
  );

  const handleFileChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      if (file) processFile(file);
      e.target.value = "";
    },
    [processFile],
  );

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      e.stopPropagation();
      setIsDragOver(false);

      const file = e.dataTransfer.files[0];
      if (file) processFile(file);
    },
    [processFile],
  );

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragOver(true);
  }, []);

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragOver(false);
  }, []);

  const handlePaste = useCallback(
    (e: React.ClipboardEvent) => {
      const items = e.clipboardData.items;
      for (const item of items) {
        if (item.type.startsWith("image/")) {
          const file = item.getAsFile();
          if (file) {
            processFile(file);
            break;
          }
        }
      }
    },
    [processFile],
  );

  return (
    <div
      className="flex flex-col items-center justify-center"
      style={{
        padding: "16px 12px",
        borderRadius: 8,
        border: `1.5px dashed ${isDragOver ? "var(--color-accent-purple)" : "var(--color-border)"}`,
        backgroundColor: isDragOver ? "var(--color-accent-purple)08" : "transparent",
        cursor: disabled || isUploading ? "default" : "pointer",
        transition: "border-color 0.15s ease, background-color 0.15s ease",
        gap: 8,
      }}
      onClick={() => !disabled && !isUploading && fileInputRef.current?.click()}
      onDrop={handleDrop}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onPaste={handlePaste}
      tabIndex={0}
    >
      <input
        ref={fileInputRef}
        type="file"
        accept={ACCEPTED_TYPES.join(",")}
        onChange={handleFileChange}
        style={{ display: "none" }}
      />

      {isUploading ? (
        <Loader2 size={20} className="animate-spin" style={{ color: "var(--color-accent-purple)" }} />
      ) : (
        <ImagePlus size={20} style={{ color: "var(--color-muted)" }} />
      )}

      <span
        style={{
          fontSize: 11,
          color: "var(--color-muted)",
          textAlign: "center",
          lineHeight: 1.5,
        }}
      >
        {isUploading
          ? t("ideaHub.images.uploading")
          : t("ideaHub.images.dragDrop")}
      </span>

      <span
        style={{
          fontSize: 10,
          color: "var(--color-border-strong)",
        }}
      >
        PNG, JPG, WebP, GIF ({MAX_SIZE_MB}MB max)
      </span>
    </div>
  );
}
