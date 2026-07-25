import { useState } from "react";
import { X } from "lucide-react";
import { ImageLightbox } from "./image-lightbox";

export interface PastedImage {
  readonly id: string;
  readonly base64: string;
  readonly mediaType: string;
  readonly preview: string;
}

interface ImagePreviewProps {
  readonly images: ReadonlyArray<PastedImage>;
  readonly onRemove: (id: string) => void;
}

export function ImagePreview({ images, onRemove }: ImagePreviewProps) {
  const [lightboxSrc, setLightboxSrc] = useState<string | null>(null);

  if (images.length === 0) return null;

  return (
    <>
      <div className="flex items-center gap-1.5 flex-wrap">
        {images.map((img) => (
          <div key={img.id} className="relative group shrink-0">
            <img
              src={img.preview}
              alt=""
              className="w-12 h-12 rounded object-cover border border-border-light cursor-pointer hover:brightness-110 transition-[filter]"
              onClick={() => setLightboxSrc(img.preview)}
            />
            <button
              onClick={() => onRemove(img.id)}
              className="absolute -top-1.5 -right-1.5 w-4 h-4 rounded-full bg-[#2A2440] border border-[#7C6BAE]/40 flex items-center justify-center opacity-80 group-hover:opacity-100 transition-opacity text-[#C4B5FD] hover:text-white hover:bg-[#3A2F55]"
            >
              <X size={8} />
            </button>
          </div>
        ))}
      </div>
      {lightboxSrc && (
        <ImageLightbox src={lightboxSrc} onClose={() => setLightboxSrc(null)} />
      )}
    </>
  );
}
