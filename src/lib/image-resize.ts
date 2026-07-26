/**
 * Client-side image resize utility.
 *
 * Scales images whose longest side exceeds `IMAGE_MAX_DIMENSION` using
 * the Canvas API so that downstream services (Claude API, etc.) receive
 * images within their accepted size limits.
 */

/** Claude API recommended optimal longest-edge size (safely below 2000px hard limit). */
const IMAGE_MAX_DIMENSION = 1568;

export interface ResizedImage {
  /** Base64 string WITHOUT the `data:` prefix. */
  readonly base64: string;
  /** MIME type, e.g. "image/png". */
  readonly mediaType: string;
  /** Full data-URL suitable for `<img src>`. */
  readonly preview: string;
}

/**
 * Read a File as a data-URL (no resize).  Used as the fast-path for
 * images that are already within limits and for SVGs.
 */
function readFileAsDataUrl(file: File): Promise<ResizedImage> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const dataUrl = reader.result as string;
      const [header, base64] = dataUrl.split(",");
      const mediaType = header.match(/data:(.*?);/)?.[1] ?? "image/png";
      resolve({ base64, mediaType, preview: dataUrl });
    };
    reader.onerror = () => reject(new Error("Failed to read image file"));
    reader.readAsDataURL(file);
  });
}

/**
 * Resize an image `File` if either dimension exceeds `maxDimension`.
 *
 * - SVG files are returned as-is (vector format, no rasterisation needed).
 * - Images within limits are returned unchanged (no quality loss).
 * - Oversized images are scaled proportionally via Canvas and re-encoded.
 */
export function resizeImageIfNeeded(
  file: File,
  maxDimension: number = IMAGE_MAX_DIMENSION,
): Promise<ResizedImage> {
  // SVG — skip resize entirely
  if (file.type === "image/svg+xml") {
    return readFileAsDataUrl(file);
  }

  return new Promise((resolve, reject) => {
    const objectUrl = URL.createObjectURL(file);
    const img = new Image();

    img.onload = () => {
      const { naturalWidth: w, naturalHeight: h } = img;

      // Already within limits — fast path (no quality loss)
      if (w <= maxDimension && h <= maxDimension) {
        URL.revokeObjectURL(objectUrl);
        readFileAsDataUrl(file).then(resolve, reject);
        return;
      }

      // Compute scaled dimensions preserving aspect ratio
      const scale = maxDimension / Math.max(w, h);
      const newW = Math.round(w * scale);
      const newH = Math.round(h * scale);

      try {
        const canvas = document.createElement("canvas");
        canvas.width = newW;
        canvas.height = newH;

        const ctx = canvas.getContext("2d");
        if (!ctx) {
          throw new Error("Canvas 2D context unavailable");
        }

        ctx.drawImage(img, 0, 0, newW, newH);

        // Determine output MIME — browsers may fall back to PNG for
        // unsupported formats (GIF, BMP). Parse the actual output header.
        const outputType = file.type === "image/jpeg" || file.type === "image/webp"
          ? file.type
          : "image/png";

        const dataUrl = canvas.toDataURL(outputType, 0.92);
        const [header, base64] = dataUrl.split(",");
        const mediaType = header.match(/data:(.*?);/)?.[1] ?? "image/png";

        URL.revokeObjectURL(objectUrl);
        resolve({ base64, mediaType, preview: dataUrl });
      } catch (err) {
        URL.revokeObjectURL(objectUrl);
        reject(err);
      }
    };

    img.onerror = () => {
      URL.revokeObjectURL(objectUrl);
      reject(new Error("Failed to load image for resize check"));
    };

    img.src = objectUrl;
  });
}
