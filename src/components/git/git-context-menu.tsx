import { save } from "@tauri-apps/plugin-dialog";
import {
  createNativeContextMenuItem,
  nativeMenuSeparator,
  popupNativeContextMenu,
  type NativeContextMenuItem,
} from "@/lib/native-context-menu";
import { useGitStore } from "@/stores/git-store";
import { useWorkspaceStore } from "@/stores/workspace-store";

type GitMenuTranslate = (key: string, options?: Record<string, unknown>) => string;

interface CommitContextMenuOptions {
  readonly x: number;
  readonly y: number;
  readonly commitId: string;
  readonly shortId: string;
  readonly message: string;
  readonly t: GitMenuTranslate;
  readonly onViewDetail?: (commitId: string) => void;
}

function promptText(label: string, placeholder: string): string | null {
  const value = window.prompt(label, placeholder);
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

function getPatchFileName(shortId: string, message: string): string {
  const firstLine = message.split("\n")[0].replace(/[^a-zA-Z0-9\u4e00-\u9fa5_-]/g, "-").slice(0, 40);
  return `${shortId}-${firstLine}.patch`;
}

function gitCommitMenuItem(
  id: string,
  label: string,
  action: () => void | Promise<void>,
  enabled = true,
): NativeContextMenuItem {
  return createNativeContextMenuItem(id, label, action, { enabled });
}

export function popupCommitContextMenu({
  x,
  y,
  commitId,
  shortId,
  message,
  t,
  onViewDetail,
}: CommitContextMenuOptions): Promise<void> {
  const workspacePath = useWorkspaceStore.getState().activeWorkspace?.path ?? null;
  const {
    createTag,
    createBranchFromCommit,
    checkoutCommit,
    resetToCommit,
    archiveCommit,
    formatPatch,
  } = useGitStore.getState();
  const canRunGitAction = Boolean(workspacePath);

  const createTagFromCommit = () => {
    if (!workspacePath) return;
    const name = promptText(t("git.ctx.tagName"), "v1.0.0");
    if (name) createTag(workspacePath, name, commitId);
  };

  const createBranch = () => {
    if (!workspacePath) return;
    const name = promptText(t("git.ctx.branchName"), "feature/new-branch");
    if (name) createBranchFromCommit(workspacePath, name, commitId);
  };

  const checkout = () => {
    if (!workspacePath) return;
    const confirmed = window.confirm(`${t("git.ctx.checkoutConfirm")}\n\n${t("git.ctx.checkoutDesc", { id: shortId })}`);
    if (confirmed) checkoutCommit(workspacePath, commitId);
  };

  const reset = (mode: "soft" | "mixed" | "hard") => {
    if (!workspacePath) return;
    const confirmed = window.confirm(`${t("git.ctx.resetConfirm", { mode })}\n\n${t("git.ctx.resetDesc", { id: shortId, mode })}`);
    if (confirmed) resetToCommit(workspacePath, commitId, mode);
  };

  const archive = async () => {
    if (!workspacePath) return;
    const outputPath = await save({
      title: t("git.ctx.archiveTitle"),
      defaultPath: `${shortId}.zip`,
      filters: [{ name: "Zip Archive", extensions: ["zip"] }],
    });
    if (outputPath) archiveCommit(workspacePath, commitId, outputPath);
  };

  const patch = async () => {
    if (!workspacePath) return;
    const outputPath = await save({
      title: t("git.ctx.patchTitle"),
      defaultPath: getPatchFileName(shortId, message),
      filters: [{ name: "Patch", extensions: ["patch"] }],
    });
    if (outputPath) formatPatch(workspacePath, commitId, outputPath);
  };

  const items: NativeContextMenuItem[] = [
    gitCommitMenuItem("bytro-git-commit-detail", t("git.ctx.viewDetail"), () => onViewDetail?.(commitId), Boolean(onViewDetail)),
    gitCommitMenuItem("bytro-git-commit-copy-sha", t("git.ctx.copySha"), () => navigator.clipboard.writeText(commitId)),
    nativeMenuSeparator(),
    gitCommitMenuItem("bytro-git-commit-create-tag", t("git.ctx.createTag"), createTagFromCommit, canRunGitAction),
    gitCommitMenuItem("bytro-git-commit-create-branch", t("git.ctx.createBranch"), createBranch, canRunGitAction),
    gitCommitMenuItem("bytro-git-commit-create-patch", t("git.ctx.createPatch"), patch, canRunGitAction),
    nativeMenuSeparator(),
    gitCommitMenuItem("bytro-git-commit-checkout", t("git.ctx.checkout"), checkout, canRunGitAction),
    gitCommitMenuItem("bytro-git-commit-reset-soft", t("git.ctx.resetSoft"), () => reset("soft"), canRunGitAction),
    gitCommitMenuItem("bytro-git-commit-reset-mixed", t("git.ctx.resetMixed"), () => reset("mixed"), canRunGitAction),
    gitCommitMenuItem("bytro-git-commit-reset-hard", t("git.ctx.resetHard"), () => reset("hard"), canRunGitAction),
    gitCommitMenuItem("bytro-git-commit-archive", t("git.ctx.archive"), archive, canRunGitAction),
  ];

  return popupNativeContextMenu("bytro-git-commit-context-menu", items, x, y);
}
