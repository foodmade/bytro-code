import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Trash2, X, ChevronLeft, ChevronRight, ImageIcon } from "lucide-react";
import { invoke } from "@tauri-apps/api/core";

export function IdeaImageGallery({
  filenames,
  onDelete,
  readonly = false,
}: {
  readonly filenames: ReadonlyArray<string>;
  readonly onDelete?: (filename: string) => void;
  readonly readonly?: boolean;
}) {
  const { t } = useTranslation();
  const [imagePaths, setImagePaths] = useState<Record<string, string>>({});
  const [lightboxIndex, setLightboxIndex] = useState<number | null>(null);

  // Resolve file paths for all images
  useEffect(() => {
    let cancelled = false;
    async function resolve() {
      const paths: Record<string, string> = {};
      for (const filename of filenames) {
        try {
          const dataUrl = await invoke<string>("read_idea_image_base64", { filename });
          paths[filename] = dataUrl;
        } catch {
          // skip failed
        }
      }
      if (!cancelled) setImagePaths(paths);
    }
    resolve();
    return () => { cancelled = true; };
  }, [filenames]);

  const handleOpenLightbox = useCallback((index: number) => {
    setLightboxIndex(index);
  }, []);

  const handleCloseLightbox = useCallback(() => {
    setLightboxIndex(null);
  }, []);

  const handlePrev = useCallback(() => {
    setLightboxIndex((prev) =>
      prev !== null ? (prev - 1 + filenames.length) % filenames.length : null,
    );
  }, [filenames.length]);

  const handleNext = useCallback(() => {
    setLightboxIndex((prev) =>
      prev !== null ? (prev + 1) % filenames.length : null,
    );
  }, [filenames.length]);

  const handleLightboxKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "Escape") handleCloseLightbox();
      else if (e.key === "ArrowLeft") handlePrev();
      else if (e.key === "ArrowRight") handleNext();
    },
    [handleCloseLightbox, handlePrev, handleNext],
  );

  if (filenames.length === 0) return null;

  return (
    <>
      <div className="flex flex-col" style={{ gap: 8 }}>
        <div className="flex items-center" style={{ gap: 6 }}>
          <ImageIcon size={14} style={{ color: "var(--color-accent-purple)" }} />
          <span style={{ fontSize: 12, fontWeight: 600, color: "var(--color-foreground)" }}>
            {t("ideaHub.images.title")}
          </span>
          <span style={{ fontSize: 11, color: "var(--color-muted)" }}>
            ({filenames.length})
          </span>
        </div>

        <div className="flex flex-wrap" style={{ gap: 8 }}>
          {filenames.map((filename, index) => (
            <div
              key={filename}
              className="relative group"
              style={{
                width: 80,
                height: 80,
                borderRadius: 6,
                overflow: "hidden",
                border: "1px solid var(--color-border)",
                cursor: "pointer",
              }}
              onClick={() => handleOpenLightbox(index)}
            >
              {imagePaths[filename] ? (
                <img
                  src={imagePaths[filename]}
                  alt=""
                  style={{
                    width: "100%",
                    height: "100%",
                    objectFit: "cover",
                  }}
                />
              ) : (
                <div
                  className="flex items-center justify-center"
                  style={{
                    width: "100%",
                    height: "100%",
                    backgroundColor: "var(--color-surface)",
                  }}
                >
                  <ImageIcon size={20} style={{ color: "var(--color-border-strong)" }} />
                </div>
              )}

              {/* Delete overlay */}
              {!readonly && onDelete && (
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    onDelete(filename);
                  }}
                  className="absolute opacity-0 group-hover:opacity-100"
                  style={{
                    top: 4,
                    right: 4,
                    width: 22,
                    height: 22,
                    borderRadius: 4,
                    border: "none",
                    backgroundColor: "rgba(0,0,0,0.6)",
                    cursor: "pointer",
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    transition: "opacity 0.1s ease",
                  }}
                >
                  <Trash2 size={12} style={{ color: "#fff" }} />
                </button>
              )}
            </div>
          ))}
        </div>
      </div>

      {/* Lightbox */}
      {lightboxIndex !== null && (
        <div
          className="fixed inset-0 flex items-center justify-center"
          style={{ zIndex: 2000, backgroundColor: "rgba(0,0,0,0.85)" }}
          onClick={handleCloseLightbox}
          onKeyDown={handleLightboxKeyDown}
          tabIndex={0}
        >
          {/* Close */}
          <button
            onClick={handleCloseLightbox}
            style={{
              position: "absolute",
              top: 16,
              right: 16,
              border: "none",
              background: "rgba(255,255,255,0.1)",
              borderRadius: 6,
              width: 36,
              height: 36,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              cursor: "pointer",
            }}
          >
            <X size={20} style={{ color: "#fff" }} />
          </button>

          {/* Prev */}
          {filenames.length > 1 && (
            <button
              onClick={(e) => { e.stopPropagation(); handlePrev(); }}
              style={{
                position: "absolute",
                left: 16,
                top: "50%",
                transform: "translateY(-50%)",
                border: "none",
                background: "rgba(255,255,255,0.1)",
                borderRadius: 6,
                width: 36,
                height: 36,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                cursor: "pointer",
              }}
            >
              <ChevronLeft size={20} style={{ color: "#fff" }} />
            </button>
          )}

          {/* Image */}
          {imagePaths[filenames[lightboxIndex]] && (
            <img
              src={imagePaths[filenames[lightboxIndex]]}
              alt=""
              onClick={(e) => e.stopPropagation()}
              style={{
                maxWidth: "90vw",
                maxHeight: "90vh",
                objectFit: "contain",
                borderRadius: 8,
              }}
            />
          )}

          {/* Next */}
          {filenames.length > 1 && (
            <button
              onClick={(e) => { e.stopPropagation(); handleNext(); }}
              style={{
                position: "absolute",
                right: 16,
                top: "50%",
                transform: "translateY(-50%)",
                border: "none",
                background: "rgba(255,255,255,0.1)",
                borderRadius: 6,
                width: 36,
                height: 36,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                cursor: "pointer",
              }}
            >
              <ChevronRight size={20} style={{ color: "#fff" }} />
            </button>
          )}

          {/* Counter */}
          <span
            style={{
              position: "absolute",
              bottom: 16,
              left: "50%",
              transform: "translateX(-50%)",
              color: "rgba(255,255,255,0.6)",
              fontSize: 12,
            }}
          >
            {lightboxIndex + 1} / {filenames.length}
          </span>
        </div>
      )}
    </>
  );
}
