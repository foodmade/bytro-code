// Thin barrel re-exporting the neutral src/lib/file-open helpers so existing
// chat tool-renderer imports stay stable. New callers should import from
// "@/lib/file-open" directly.
export {
  openToolFile,
  openToolDiffTab,
  openResolvedToolFile,
} from "@/lib/file-open";
