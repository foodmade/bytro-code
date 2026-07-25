import { useCallback, useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { X, ZoomIn, ZoomOut, RotateCw } from "lucide-react";

interface ImageLightboxProps {
  readonly src: string;
  readonly onClose: () => void;
}

export function ImageLightbox({ src, onClose }: ImageLightboxProps) {
  const [scale, setScale] = useState(1);
  const [rotation, setRotation] = useState(0);

  const handleZoomIn = useCallback(() => {
    setScale((prev) => Math.min(prev + 0.25, 5));
  }, []);

  const handleZoomOut = useCallback(() => {
    setScale((prev) => Math.max(prev - 0.25, 0.25));
  }, []);

  const handleRotate = useCallback(() => {
    setRotation((prev) => (prev + 90) % 360);
  }, []);

  const handleReset = useCallback(() => {
    setScale(1);
    setRotation(0);
  }, []);

  const handleWheel = useCallback((e: React.WheelEvent) => {
    e.stopPropagation();
    if (e.deltaY < 0) {
      setScale((prev) => Math.min(prev + 0.1, 5));
    } else {
      setScale((prev) => Math.max(prev - 0.1, 0.25));
    }
  }, []);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        onClose();
      } else if (e.key === "+" || e.key === "=") {
        handleZoomIn();
      } else if (e.key === "-") {
        handleZoomOut();
      } else if (e.key === "r") {
        handleRotate();
      } else if (e.key === "0") {
        handleReset();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [onClose, handleZoomIn, handleZoomOut, handleRotate, handleReset]);

  const handleBackdropClick = useCallback(
    (e: React.MouseEvent) => {
      if (e.target === e.currentTarget) {
        onClose();
      }
    },
    [onClose],
  );

  return createPortal(
    <div
      className="fixed inset-0 z-[9999] flex items-center justify-center"
      style={{ backgroundColor: "rgba(0, 0, 0, 0.85)" }}
      onClick={handleBackdropClick}
      onWheel={handleWheel}
    >
      {/* Toolbar */}
      <div
        className="absolute top-4 right-4 flex items-center gap-1 rounded-lg px-2 py-1.5 z-[10000]"
        style={{
          backgroundColor: "rgba(30, 30, 30, 0.9)",
          border: "1px solid rgba(255, 255, 255, 0.1)",
        }}
      >
        <button
          onClick={handleZoomIn}
          className="p-1.5 rounded hover:bg-white/10 transition-colors"
          title="Zoom in (+)"
        >
          <ZoomIn size={16} color="#ccc" />
        </button>
        <button
          onClick={handleZoomOut}
          className="p-1.5 rounded hover:bg-white/10 transition-colors"
          title="Zoom out (-)"
        >
          <ZoomOut size={16} color="#ccc" />
        </button>
        <button
          onClick={handleRotate}
          className="p-1.5 rounded hover:bg-white/10 transition-colors"
          title="Rotate (R)"
        >
          <RotateCw size={16} color="#ccc" />
        </button>
        <span
          className="px-2 text-[12px] font-mono select-none"
          style={{ color: "rgba(255, 255, 255, 0.5)" }}
        >
          {Math.round(scale * 100)}%
        </span>
        <button
          onClick={onClose}
          className="p-1.5 rounded hover:bg-white/10 transition-colors ml-1"
          title="Close (Esc)"
        >
          <X size={16} color="#ccc" />
        </button>
      </div>

      {/* Image */}
      <img
        src={src}
        alt=""
        className="select-none"
        draggable={false}
        style={{
          maxWidth: "90vw",
          maxHeight: "90vh",
          objectFit: "contain",
          transform: `scale(${scale}) rotate(${rotation}deg)`,
          transition: "transform 0.2s ease",
          cursor: scale > 1 ? "grab" : "zoom-in",
        }}
        onClick={(e) => {
          e.stopPropagation();
          if (scale === 1) {
            handleZoomIn();
          } else {
            handleReset();
          }
        }}
      />
    </div>,
    document.body,
  );
}
