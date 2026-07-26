import type { EditorDiffMode } from "@/stores/app-store";

// Neutral file-opening helpers shared by chat tool cards and the markdown
// renderer. Kept in src/lib (not under components/chat) so generic UI such as
// MarkdownRenderer can open files in the editor without creating a ui→chat
// module dependency.

/** Detect absolute path: POSIX `/...` or Windows `C:\...` / `C:/...`. */
function isAbsolutePath(path: string): boolean {
  if (path.startsWith("/")) return true;
  if (/^[A-Za-z]:[\\/]/.test(path)) return true;
  return false;
}

export async function openToolFile(path: string): Promise<void> {
  const { useAppStore } = await import("@/stores/app-store");
  useAppStore.getState().openFile(path);
}

export async function openToolDiffTab(diff: EditorDiffMode): Promise<void> {
  const { useAppStore } = await import("@/stores/app-store");
  useAppStore.getState().openDiffTab(diff);
}

export async function resolveToolFilePath(path: string): Promise<string> {
  if (isAbsolutePath(path)) return path;
  const { useWorkspaceStore } = await import("@/stores/workspace-store");
  const root = useWorkspaceStore.getState().activeWorkspace?.path;
  if (!root) return path;
  const sep = root.includes("\\") ? "\\" : "/";
  const rootTrimmed = root.endsWith(sep) ? root.slice(0, -sep.length) : root;
  return `${rootTrimmed}${sep}${path}`;
}

export async function openResolvedToolFile(path: string): Promise<void> {
  const resolved = await resolveToolFilePath(path);
  await openToolFile(resolved);
}
