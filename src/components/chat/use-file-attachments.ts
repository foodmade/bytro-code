/**
 * Custom hook for managing file and image attachments in the chat input.
 *
 * Handles:
 * - Pasted images (from clipboard)
 * - Attached files (from file picker)
 * - Drag-and-drop files (Tauri OS handler — macOS WKWebView won't deliver
 *   HTML5 file drops, so we receive paths via `onDragDropEvent` and read
 *   them through Tauri commands)
 * - File input ref management
 */

import { useCallback, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { resizeImageIfNeeded } from "@/lib/image-resize";
import type { PastedImage } from "./image-preview";
import { IMAGE_TYPES } from "./input-parsers";

export interface AttachedFile {
  readonly id: string;
  readonly name: string;
  readonly content?: string;
  readonly path?: string;
  readonly source?: "file" | "pasted-text";
  readonly preview?: string;
}

const IMAGE_EXTS: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  bmp: "image/bmp",
  svg: "image/svg+xml",
};

function getBaseName(path: string): string {
  const idx = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  return idx >= 0 ? path.slice(idx + 1) : path;
}

function getExt(name: string): string {
  const idx = name.lastIndexOf(".");
  return idx >= 0 ? name.slice(idx + 1).toLowerCase() : "";
}

function base64ToFile(base64: string, name: string, mediaType: string): File {
  const bin = atob(base64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new File([bytes], name, { type: mediaType });
}

function getPastedTextPreview(text: string): string {
  return (
    text
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find(Boolean) ?? ""
  );
}

export function useFileAttachments() {
  const [pastedImages, setPastedImages] = useState<ReadonlyArray<PastedImage>>([]);
  const [attachedFiles, setAttachedFiles] = useState<ReadonlyArray<AttachedFile>>([]);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const addPastedImage = useCallback((base64: string, mediaType: string, preview: string) => {
    setPastedImages((prev) => [...prev, { id: crypto.randomUUID(), base64, mediaType, preview }]);
  }, []);

  const addPastedText = useCallback((text: string) => {
    setAttachedFiles((prev) => {
      const pastedCount = prev.filter((file) => file.source === "pasted-text").length + 1;
      return [
        ...prev,
        {
          id: crypto.randomUUID(),
          name: `pasted-text-${pastedCount}.txt`,
          content: text,
          source: "pasted-text",
          preview: getPastedTextPreview(text),
        },
      ];
    });
  }, []);

  const handleRemoveImage = useCallback((id: string) => {
    setPastedImages((prev) => prev.filter((img) => img.id !== id));
  }, []);

  const handleAttachClick = useCallback(() => {
    fileInputRef.current?.click();
  }, []);

  const handleFileInputChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files || files.length === 0) return;
    for (const file of Array.from(files)) {
      if (IMAGE_TYPES.has(file.type)) {
        resizeImageIfNeeded(file)
          .then(({ base64, mediaType, preview }) => {
            setPastedImages((prev) => [
              ...prev,
              { id: crypto.randomUUID(), base64, mediaType, preview },
            ]);
          })
          .catch(() => {
            // Fallback: use original file without resize
            const reader = new FileReader();
            reader.onload = () => {
              const dataUrl = reader.result as string;
              const [header, b64] = dataUrl.split(",");
              const mt = header.match(/data:(.*?);/)?.[1] ?? "image/png";
              setPastedImages((prev) => [
                ...prev,
                { id: crypto.randomUUID(), base64: b64, mediaType: mt, preview: dataUrl },
              ]);
            };
            reader.readAsDataURL(file);
          });
      } else {
        const reader = new FileReader();
        reader.onload = () => {
          const content = reader.result as string;
          setAttachedFiles((prev) => [
            ...prev,
            { id: crypto.randomUUID(), name: file.name, content, source: "file" },
          ]);
        };
        reader.readAsText(file);
      }
    }
    e.target.value = "";
  }, []);

  const handleRemoveAttachedFile = useCallback((id: string) => {
    setAttachedFiles((prev) => prev.filter((f) => f.id !== id));
  }, []);

  /**
   * Load files from Tauri-provided absolute paths (drag-and-drop). Images
   * are read as base64 then re-sized via the same pipeline as the file
   * picker; everything else is attached by path only so large documents do
  * not get expanded into chat messages or Codex goal objectives.
  */
  const addFromTauriPaths = useCallback(async (paths: ReadonlyArray<string>) => {
    await Promise.all(
      paths.map(async (path) => {
        const name = getBaseName(path);
        const ext = getExt(name);
        const mediaType = IMAGE_EXTS[ext];

        if (mediaType) {
          let rawBase64: string;
          try {
            rawBase64 = await invoke<string>("read_file_base64", { path });
          } catch {
            console.warn("[attachments][drop] dropped image could not be read");
            return;
          }
          try {
            const file = base64ToFile(rawBase64, name, mediaType);
            const resized = await resizeImageIfNeeded(file);
            setPastedImages((prev) => [...prev, { id: crypto.randomUUID(), ...resized }]);
          } catch {
            // Resize failed (Canvas issues, decode errors, etc.) — fall back
            // to the raw bytes, matching `handleFileInputChange`'s behavior
            // so the user still sees the image instead of it being silently
            // dropped.
            console.warn("[attachments][drop] image resize failed; using original bytes");
            setPastedImages((prev) => [
              ...prev,
              {
                id: crypto.randomUUID(),
                base64: rawBase64,
                mediaType,
                preview: `data:${mediaType};base64,${rawBase64}`,
              },
            ]);
          }
        } else {
          setAttachedFiles((prev) => [
            ...prev,
            { id: crypto.randomUUID(), name, path, source: "file" },
          ]);
        }
      }),
    );
  }, []);

  /** Clear all attachments (called after message send). */
  const clearAll = useCallback(() => {
    setPastedImages([]);
    setAttachedFiles([]);
  }, []);

  return {
    pastedImages,
    attachedFiles,
    fileInputRef,
    addPastedImage,
    addPastedText,
    handleRemoveImage,
    handleAttachClick,
    handleFileInputChange,
    handleRemoveAttachedFile,
    addFromTauriPaths,
    clearAll,
  } as const;
}
